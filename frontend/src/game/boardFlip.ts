/**
 * シアターモードの立ち絵ポーズ変更で、板（立ち絵）をくるっと回す演出 (#707) の純粋計算。
 *
 * 旧ポーズの板が 0°→90° まで回って消え（`out`）、そのあと新ポーズの板が -90°→0° まで回って
 * 現れる（`in`）。合計時間 `totalMs` の前半が `out`、後半が `in`。
 *
 * ここは角度と四隅座標だけを返す純粋関数で、`Math.random` も時計も使わない
 * （ADR 0002: TimeController 駆動の経過時間だけが入力。中間値は NovelGameState に持たない）。
 * 描画（`PerspectiveMesh.setCorners`）への配線は `CharacterLayer` 側。
 */

/** 板を回す向き。`out` は旧ポーズ（0→+90°）、`in` は新ポーズ（-90°→0）。 */
export type BoardFlipRole = 'out' | 'in'

/** ある時点の板の見え方。 */
export interface BoardFlipFrame {
  /** その板をこの時点で描くか。`out` は前半だけ、`in` は後半だけ true。 */
  visible: boolean
  /** Y 軸回りの角度（ラジアン）。`out` は 0→π/2、`in` は -π/2→0。 */
  angleRad: number
}

/** 板の四隅（左上・右上・右下・左下の順。`PerspectiveMesh.setCorners` の引数順）。 */
export interface BoardFlipCorners {
  x0: number
  y0: number
  x1: number
  y1: number
  x2: number
  y2: number
  x3: number
  y3: number
}

/** カメラ距離を板の高さに対する比で表す。小さいほど遠近の効きが強い。 */
export const BOARD_FLIP_CAMERA_DISTANCE_RATIO = 2.5

const HALF_PI = Math.PI / 2

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/**
 * 経過時間から板の可視と角度を求める。
 *
 * `out` は加速（ease-in）、`in` は減速（ease-out）にして、回転が切り替わりの一瞬で最も速く
 * 見えるようにする。`totalMs` が 0 以下・非有限のときは半分を超えた扱いにせず、
 * `out` は不可視（0 経過）、`in` は可視で角度 0 に倒す（呼び出し側は totalMs<=0 でこの演出を
 * 使わないが、0 除算で NaN にならないよう守る）。
 */
export function computeBoardFlipFrame(
  role: BoardFlipRole,
  elapsedMs: number,
  totalMs: number
): BoardFlipFrame {
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return role === 'in' ? { visible: true, angleRad: 0 } : { visible: false, angleRad: HALF_PI }
  }
  const half = totalMs / 2
  if (role === 'out') {
    if (elapsedMs >= half) return { visible: false, angleRad: HALF_PI }
    const p = clamp01(elapsedMs / half)
    return { visible: true, angleRad: HALF_PI * p * p }
  }
  if (elapsedMs < half) return { visible: false, angleRad: -HALF_PI }
  const p = clamp01((elapsedMs - half) / half)
  const remaining = 1 - p
  return { visible: true, angleRad: -HALF_PI * remaining * remaining }
}

/**
 * 板（幅 `width`・高さ `height`・足元中心 `(centerX, bottomY)`）を Y 軸回りに `angleRad` 回し、
 * 透視投影した四隅を返す。消失点は板の縦の中央（上下が対称に縮む）。
 *
 * 回転軸は板の中心を通る鉛直線。奥へ行く側の辺ほど小さく・縦の中心寄りに縮む。
 * カメラ距離は `max(height * BOARD_FLIP_CAMERA_DISTANCE_RATIO, width * 2)` として、
 * 横長の板でも分母（d + z）が正に保たれるようにする。
 */
export function computeBoardFlipCorners(
  centerX: number,
  bottomY: number,
  width: number,
  height: number,
  angleRad: number
): BoardFlipCorners {
  const halfW = width / 2
  const halfH = height / 2
  const centerY = bottomY - halfH
  const d = Math.max(height * BOARD_FLIP_CAMERA_DISTANCE_RATIO, width * 2, 1)
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const project = (lx: number, ly: number): [number, number] => {
    const z = lx * sin
    const s = d / (d + z)
    return [centerX + lx * cos * s, centerY + ly * s]
  }
  const [x0, y0] = project(-halfW, -halfH)
  const [x1, y1] = project(halfW, -halfH)
  const [x2, y2] = project(halfW, halfH)
  const [x3, y3] = project(-halfW, halfH)
  return { x0, y0, x1, y1, x2, y2, x3, y3 }
}
