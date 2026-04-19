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

/**
 * 壁高さに応じたフォグ上限距離を返す（Issue #80 Phase 2）。
 *
 * 通常の壁（wallHeight=1）は `baseFogMaxDist` で消えるが、高い塔（wallHeight=1.5, 2 等）は
 * ランドマークとして遠距離から視認できてほしい。そこで wallHeight > 1 の塔に限り、
 * 上限距離を `baseFogMaxDist * wallHeight` まで伸長する。
 *
 * 契約:
 *  - `wallHeight <= 1` → `baseFogMaxDist`（低い壁は通常の壁と同じ距離で消える。遠方視認を広げない）
 *  - `wallHeight > 1`  → `baseFogMaxDist * wallHeight`（高いほど遠くまで見える）
 *  - `NaN / Infinity / 負値`（および `0`）は `baseFogMaxDist`（防御。`Math.max(1, ...)` 相当）
 *
 * `baseFogMaxDist` 自体の非有限／非正値はそのまま返す（呼び出し側の責務）。
 */
export function computeEffectiveFogMaxDist(baseFogMaxDist: number, wallHeight: number): number {
  if (!Number.isFinite(wallHeight) || wallHeight <= 1) {
    return baseFogMaxDist
  }
  return baseFogMaxDist * wallHeight
}

/**
 * 床高さグリッド（[y][x]）から指定タイルの床高さを返す純粋関数（Issue #84）。
 *
 * - `grid` が `undefined`、該当行が未定義、セルが未定義、値が有限数でない場合は `0` を返す（地面扱い）
 * - 負値はそのまま返す（地面より沈み込む表現を許容する）
 *
 * `getWallHeight` の fallback=1 に対し、床高さは fallback=0（地面）。
 * プレイヤーがそのタイルに踏み込んだときのカメラ高さオフセットとして使う。
 */
export function resolveFloorHeight(grid: number[][] | undefined, tx: number, ty: number): number {
  if (!grid) return 0
  const row = grid[ty]
  if (!row) return 0
  const v = row[tx]
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return v
}

/**
 * 段差壁面（floor step wall）情報。Issue #88 Phase 2-7a。
 *
 * 隣接タイル間で `floorHeights` に差があるとき、境界に生じる垂直な段差面を表現する。
 * - `lowerZ` < `upperZ`。`heightDiff = upperZ - lowerZ > 0`
 * - この面は「lowerZ から upperZ まで」の垂直壁として描画される
 * - `upperSide` は「高い方の床がどちら側にあるか」（将来 u 座標計算やテクスチャ選択で使う可能性があるため保持）
 */
export interface FloorStepInfo {
  lowerZ: number
  upperZ: number
  heightDiff: number
  upperSide: 'prev' | 'next'
}

/**
 * 隣接タイルの床高さから段差壁面情報を返す純粋関数（Issue #88 Phase 2-7a）。
 *
 * - `prevFloorZ === nextFloorZ` または差が 1e-6 未満 → `null`（段差なし）
 * - 高い方を `upperZ`、低い方を `lowerZ` として返す
 * - 非有限値は `resolveFloorHeight` 経由で呼ぶ前提なので、ここでは来ないが防御として `NaN` / `Infinity` は `null`
 */
export function detectFloorStep(prevFloorZ: number, nextFloorZ: number): FloorStepInfo | null {
  if (!Number.isFinite(prevFloorZ) || !Number.isFinite(nextFloorZ)) return null
  const diff = Math.abs(prevFloorZ - nextFloorZ)
  if (diff < 1e-6) return null
  if (prevFloorZ > nextFloorZ) {
    return { lowerZ: nextFloorZ, upperZ: prevFloorZ, heightDiff: diff, upperSide: 'prev' }
  }
  return { lowerZ: prevFloorZ, upperZ: nextFloorZ, heightDiff: diff, upperSide: 'next' }
}

/**
 * 段差壁面の Y 範囲（画面座標）を返す純粋関数（Issue #88 Phase 2-7a）。
 *
 * 段差の垂直面は、通常の壁の地面位置から `lowerZ * lineHeight` だけ上にシフトした位置が下端、
 * そこから `heightDiff * lineHeight` 分だけ上に伸ばした位置が上端になる。
 *
 * 地面の基準位置（`baseGroundY`）: `computeWallYRange` と同じく
 *   `baseGroundY = floor(lineHeight/2 + h/2 + pitchOffsetPx)`
 * を前提にする。ただし段差の下端・上端は同じ floor 操作を最後に 1 回だけかけて、
 * 二重 floor による 1px バイアスを避ける（`computeWallYRange` の方針と同じ）。
 *
 * 入力契約:
 *  - `lineHeight` の `NaN/Infinity/負値` は 0 扱い
 *  - `lowerZ / upperZ` の `NaN/Infinity` は 0 扱い
 *  - `upperZ <= lowerZ` のときは上端=下端（描画なし相当）
 *  - `pitchOffsetPx` の `NaN/Infinity` は 0 扱い
 *  - 画面外クランプは [0, screenHeight] で行う
 *
 * 呼び出し側は `drawEndY - drawStartY <= 0` で描画スキップの責務を持つ。
 */
export function computeFloorStepWallYRange(
  lineHeight: number,
  lowerZ: number,
  upperZ: number,
  screenHeight: number,
  pitchOffsetPx: number = 0
): WallYRange {
  const h = screenHeight
  const safeLineHeight = !Number.isFinite(lineHeight) || lineHeight <= 0 ? 0 : lineHeight
  const safeLower = Number.isFinite(lowerZ) ? lowerZ : 0
  const safeUpper = Number.isFinite(upperZ) ? upperZ : 0
  const safePitchOffset = Number.isFinite(pitchOffsetPx) ? pitchOffsetPx : 0
  // 段差の高さ（負以下は描画なし）
  const effectiveDiff = safeUpper - safeLower <= 0 ? 0 : safeUpper - safeLower
  // 地面基準位置に対して「lowerZ 分上」に段差の下端が来る。通常の `computeWallYRange` は
  // `lowerZ=0` を仮定していたのと対照。上端は下端からさらに effectiveDiff 分上。
  const drawEndRaw = Math.floor(
    safeLineHeight / 2 + h / 2 + safePitchOffset - safeLineHeight * safeLower
  )
  const drawStartRaw = Math.floor(
    safeLineHeight / 2 + h / 2 + safePitchOffset - safeLineHeight * (safeLower + effectiveDiff)
  )
  const drawStartY = drawStartRaw < 0 ? 0 : drawStartRaw > h ? h : drawStartRaw
  const drawEndY = drawEndRaw < 0 ? 0 : drawEndRaw > h ? h : drawEndRaw
  return { drawStartY, drawEndY }
}

/**
 * 天井高さグリッド（[y][x]）から指定タイルの天井高さを返す純粋関数（Issue #87）。
 *
 * - `grid` が `undefined`、該当行が未定義、セルが未定義、値が有限数でない場合は `1` を返す（標準天井）
 * - `0` 以下の値も `1` にフォールバックする（天井が床より下の退化ケースで頭ぶつけ判定が破綻するのを防ぐ）
 *
 * `resolveFloorHeight`（fallback=0、負値許容）と対照的に、fallback=1、0 以下非許容。
 * プレイヤーのジャンプ時の頭ぶつけ判定に使う。
 */
export function resolveCeilingHeight(grid: number[][] | undefined, tx: number, ty: number): number {
  if (!grid) return 1
  const row = grid[ty]
  if (!row) return 1
  const v = row[tx]
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1
  if (v <= 0) return 1
  return v
}
