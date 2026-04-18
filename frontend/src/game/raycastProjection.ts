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
 */
export function projectNpcToScreen(
  npc: Vec2,
  player: Vec2,
  dir: Vec2,
  plane: Vec2,
  screen: { width: number; height: number },
  minDepth: number
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

  let drawStartY = Math.floor(-spriteHeight / 2 + h / 2)
  if (drawStartY < 0) drawStartY = 0
  let drawEndY = Math.floor(spriteHeight / 2 + h / 2)
  if (drawEndY > h) drawEndY = h
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
