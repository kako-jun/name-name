/**
 * 一人称レイキャスティングにおける NPC 射影計算（純粋関数）。
 *
 * PixiJS などの描画層に依存しない pure computation として切り出し、
 * 境界条件（同一タイル、背面、退化カメラ、極小深度）を単体テスト可能にする。
 */

export interface Vec2 {
  x: number
  y: number
}

export interface NpcProjection {
  /** スプライト中心のスクリーンX（px、Math.floor 済み） */
  screenX: number
  /** スプライト高さ px（clampedDepth ベース、Math.floor 済み） */
  spriteHeight: number
  /** スプライト幅 px（spriteHeight と同値、billboard は正方形） */
  spriteWidthPx: number
  /** z-buffer 比較用の生 transformY（minDepth クランプ前） */
  depth: number
  /** 画面クランプ後の描画範囲（[0, width], [0, height]） */
  drawStartX: number
  drawEndX: number
  drawStartY: number
  drawEndY: number
}

/**
 * NPC の world 座標を一人称カメラのスクリーン座標に射影する純粋関数。
 *
 * - `null` を返す条件:
 *   - プレイヤーと同一タイル（Math.floor の整数部が一致）
 *   - 背面（transformY ≤ 0.01）
 *   - 退化カメラ（|det| < 1e-9、ゼロ除算ガード）
 *
 * - `depth` は生の transformY（z-buffer 比較で遮蔽整合性を保つ）
 * - `spriteHeight/Width` は `Math.max(transformY, minDepth)` でクランプされた深度から算出
 *   （極小 transformY でサイズが青天井に肥大化するのを防ぐ）
 *
 * 呼び出し側注意: `det`（= plane × dir）はフレーム内で dir/plane が不変なら定数になる。
 * 本関数は NPC ごとに毎回再計算するが、通常の NPC 数（数体〜数十）では実害なし。
 * 数百体規模で毎フレーム呼ぶ用途が出てきたら precompute 版 API を別途検討する。
 *
 * @param npc NPC の world 座標（タイル中心を `x + 0.5` 等で表現）
 * @param player プレイヤーの world 座標
 * @param dir カメラ向き単位ベクトル
 * @param plane カメラ平面ベクトル（長さ = tan(fov/2)）
 * @param screen 描画キャンバスサイズ
 * @param minDepth スプライトサイズ計算時の深度下限。z-buffer 比較や `depth` フィールドには影響しない。
 * @param pitchOffsetPx 画面中央 Y のシフト量（px）。Issue #80 Phase 2 で導入。
 *                       pitch 由来の `Math.tan(pitch) * h/2` だけでなく、ジャンプ等のカメラ高さオフセット
 *                       `playerZ * h/2`（Phase 2-2）を合算した値を渡せる。正で画面中央が下にシフト＝視線が上向き
 *                       またはカメラ位置が上（プレイヤーがジャンプ中）。`NaN/Infinity` は `0` 扱い。
 *                       デフォルト `0`（pitch/ジャンプ未対応の従来呼び出しは挙動不変）。
 */
export function projectNpcToScreen(
  npc: Vec2,
  player: Vec2,
  dir: Vec2,
  plane: Vec2,
  screen: { width: number; height: number },
  minDepth: number,
  pitchOffsetPx: number = 0
): NpcProjection | null {
  // 同一タイル判定
  if (Math.floor(npc.x) === Math.floor(player.x) && Math.floor(npc.y) === Math.floor(player.y)) {
    return null
  }

  // 正規直交カメラでは |det| ≈ tan(fov/2) ≈ 0.577 なので、1e-9 は通常プレイでは発動しない純防御。
  // 入力が完全退化（dir ∥ plane）したときのゼロ除算を避けるのが目的。
  const det = plane.x * dir.y - dir.x * plane.y
  if (Math.abs(det) < 1e-9) return null
  const invDet = 1.0 / det

  const rx = npc.x - player.x
  const ry = npc.y - player.y
  const transformX = invDet * (dir.y * rx - dir.x * ry)
  const transformY = invDet * (-plane.y * rx + plane.x * ry)

  if (transformY <= 0.01) return null

  const w = screen.width
  const h = screen.height
  const screenX = Math.floor((w / 2) * (1 + transformX / transformY))
  const clampedDepth = Math.max(transformY, minDepth)
  const spriteHeight = Math.abs(Math.floor(h / clampedDepth))
  const spriteWidthPx = spriteHeight

  // pitch オフセット: NaN/Infinity は 0 扱い。baseY = h/2 + offset を中央基準にする
  const safePitchOffset = Number.isFinite(pitchOffsetPx) ? pitchOffsetPx : 0
  const baseY = h / 2 + safePitchOffset
  let drawStartY = Math.floor(-spriteHeight / 2 + baseY)
  if (drawStartY < 0) drawStartY = 0
  if (drawStartY > h) drawStartY = h
  let drawEndY = Math.floor(spriteHeight / 2 + baseY)
  if (drawEndY > h) drawEndY = h
  if (drawEndY < 0) drawEndY = 0
  let drawStartX = Math.floor(-spriteWidthPx / 2 + screenX)
  let drawEndX = Math.floor(spriteWidthPx / 2 + screenX)
  if (drawStartX < 0) drawStartX = 0
  if (drawEndX > w) drawEndX = w

  return {
    screenX,
    spriteHeight,
    spriteWidthPx,
    depth: transformY,
    drawStartX,
    drawEndX,
    drawStartY,
    drawEndY,
  }
}

export interface WallYRange {
  /** 壁の上端 Y（画面座標、小さい方が上）。0 未満は 0 にクランプ済み */
  drawStartY: number
  /** 壁の下端 Y（画面座標、地面相当で `Math.floor(h/2 + lineHeight/2)`）。h 超過は h にクランプ済み */
  drawEndY: number
}

/**
 * 壁の高さ（wallHeight, 1.0 = 従来の画面中央 ±lineHeight/2）を考慮した Y 範囲を返す。
 *
 * 地面の位置は wallHeight に依らず常に `h/2 + lineHeight/2`（プレイヤー視線が地面から 0.5 タイル上と仮定）。
 * 上端は「地面から wallHeight 分上」= drawEnd - lineHeight * wallHeight。
 *
 * 浮動小数の floor を `lineHeight / 2 + h / 2` の段階で 1 回だけ取らず、
 * `drawEnd - lineHeight * effectiveHeight` 全体を 1 回 floor することで、
 * 二重 floor による最大 1px の上方バイアスを回避する。
 *
 * 入力契約:
 *  - `wallHeight` の `NaN/Infinity/負値` は 0 扱い（描画なし相当）
 *  - `lineHeight` の `NaN/Infinity/負値` は 0 扱い
 *  - `screenHeight` は非負を前提（負値はクランプで吸収するが想定外）
 * 呼び出し側で `drawEndY - drawStartY <= 0` を見て描画スキップする責務がある。
 *
 * 画面外クランプは [0, screenHeight] で行う。
 *
 * @param lineHeight 高さ 1.0 の壁が占める縦px（Lodev 方式の h/perpDist）
 * @param wallHeight 壁の高さ倍率（0 以下・非有限は 0 扱い、上限なし）
 * @param screenHeight 画面高 px
 * @param pitchOffsetPx 画面中央 Y のシフト量（px）。Issue #80 Phase 2 で導入。
 *                       pitch 由来の `Math.tan(pitch) * h/2` だけでなく、ジャンプ等のカメラ高さオフセット
 *                       `playerZ * h/2`（Phase 2-2）を合算した値を渡せる。正で画面中央が下にシフト＝視線が上向き
 *                       またはカメラ位置が上（プレイヤーがジャンプ中）。`NaN/Infinity` は `0` 扱い。
 *                       デフォルト `0`（pitch/ジャンプ未対応の従来呼び出しは挙動不変）。
 */
export function computeWallYRange(
  lineHeight: number,
  wallHeight: number,
  screenHeight: number,
  pitchOffsetPx: number = 0
): WallYRange {
  const h = screenHeight
  const effectiveHeight = !Number.isFinite(wallHeight) || wallHeight <= 0 ? 0 : wallHeight
  const safeLineHeight = !Number.isFinite(lineHeight) || lineHeight <= 0 ? 0 : lineHeight
  const safePitchOffset = Number.isFinite(pitchOffsetPx) ? pitchOffsetPx : 0
  // drawEnd は常に floor 済みの整数として確定させ、上端は drawEnd 基準で 1 回だけ floor する
  // （drawEnd を二度参照するため別変数。drawEndRaw の floor 漏れによる 1px ズレを避ける狙い）
  // pitchOffsetPx は地平線（baseY = h/2 + offset）を上下にずらす効果を持ち、上端・下端の両方に同じ量だけ加わる
  const drawEndRaw = Math.floor(safeLineHeight / 2 + h / 2 + safePitchOffset)
  const drawStartRaw = Math.floor(
    safeLineHeight / 2 + h / 2 + safePitchOffset - safeLineHeight * effectiveHeight
  )
  const drawStartY = drawStartRaw < 0 ? 0 : drawStartRaw > h ? h : drawStartRaw
  const drawEndY = drawEndRaw < 0 ? 0 : drawEndRaw > h ? h : drawEndRaw
  return { drawStartY, drawEndY }
}
