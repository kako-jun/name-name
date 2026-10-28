/**
 * シアターモードの立ち絵ポーズ変更で、板（立ち絵）をくるっと回す演出 (#707) の純粋計算。
 *
 * 旧ポーズの板が 0°→90° まで回って消え（`out`）、そのあと新ポーズの板が -90°→0° まで回って
 * 現れる（`in`）。合計時間 `totalMs` の前半が `out`、後半が `in`。
 *
 * ここは角度と四隅座標だけを返す純粋関数で、`Math.random` も時計も使わない
 * （ADR 0002: 入力は経過時間だけ。時計は `CharacterLayer` の `elapsedMs`＝pixi Ticker の `deltaMS` 累計で、
 * TimeController とは別の時計。中間値は NovelGameState に持たない）。
 * 描画（`PerspectiveMesh.setCorners`）への配線は `CharacterLayer` 側。
 */

/** 板を回す向き。`out` は旧ポーズ（0→+90°）、`in` は新ポーズ（-90°→0）。 */
export type BoardFlipRole = 'out' | 'in'

/** ある時点の板の見え方。 */
export interface BoardFlipFrame {
  /** その板をこの時点で描くか。`out` は前半だけ、`in` は後半だけ true。 */
  visible: boolean
  /** Y 軸回りの角度（ラジアン）。`out` は 0→約π/2、`in` は約-π/2→0（±BOARD_FLIP_MAX_ANGLE_RAD で丸め）。 */
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

/**
 * 板が取りうる角度の絶対値の上限。ちょうど π/2 だと四隅がほぼ 1 本の線になり、
 * `PerspectivePlaneGeometry.setCorners` の射影行列が退化して頂点が非有限値になる
 * （固定ステップ時間で half ちょうどに乗ると実際に起きる）。縁がほぼ見えない 0.01rad 手前で丸める。
 */
export const BOARD_FLIP_MAX_ANGLE_RAD = HALF_PI - 0.01

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/**
 * 経過時間から板の可視と角度を求める。
 *
 * `out` は加速（ease-in）、`in` は減速（ease-out）にして、回転が切り替わりの一瞬で最も速く
 * 見えるようにする。角度は `±BOARD_FLIP_MAX_ANGLE_RAD` で丸め、退化角（ちょうど 90°）を返さない。
 * `in` は half ちょうどでは不可視（edge-on の瞬間を描かない）、half を超えてから可視。
 * `fromAngleRad` は `out` の開始角（既定 0）。`in` の途中（例 -60°）でさらにポーズが変わったとき、
 * 現在角度から回し続けて自然につなぐために使う。開始角が負のときは `in` の角速度を引き継ぐ
 * 初速を持たせ、一瞬止まって再加速して見えないようにする。
 *
 * `totalMs` が 0 以下・非有限のときは `out` は不可視、`in` は可視で角度 0 に倒す
 * （呼び出し側は totalMs<=0 でこの演出を使わないが、0 除算で NaN にならないよう守る）。
 */
export function computeBoardFlipFrame(
  role: BoardFlipRole,
  elapsedMs: number,
  totalMs: number,
  fromAngleRad = 0
): BoardFlipFrame {
  const max = BOARD_FLIP_MAX_ANGLE_RAD
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return role === 'in' ? { visible: true, angleRad: 0 } : { visible: false, angleRad: max }
  }
  const half = totalMs / 2
  if (role === 'out') {
    if (elapsedMs >= half) return { visible: false, angleRad: max }
    const from = Math.min(max, Math.max(-max, Number.isFinite(fromAngleRad) ? fromAngleRad : 0))
    const p = clamp01(elapsedMs / half)
    // 開始角が負（`in` の途中から移る）なら、`in` の終端速度に初速を合わせて角速度を連続にする。
    // `in` は angle=-max(1-q)²（q: in の進行度）なので、開始角 a0 での角速度は 2√(max|a0|)/half。
    // out を from+(max-from)*(s*p+(1-s)p²) とすると初速は (max-from)*s/half なので、
    // s=2√(max|a0|)/(max-a0)（AM-GM より常に 0..1。開始角 0 なら s=0＝従来の p²）。
    const s = from < 0 ? (2 * Math.sqrt(max * -from)) / (max - from) : 0
    return { visible: true, angleRad: from + (max - from) * (s * p + (1 - s) * p * p) }
  }
  if (elapsedMs <= half) return { visible: false, angleRad: -max }
  const p = clamp01((elapsedMs - half) / half)
  const remaining = 1 - p
  return { visible: true, angleRad: -max * remaining * remaining }
}

/**
 * 板（幅 `width`・高さ `height`・足元中心 `(centerX, bottomY)`）を Y 軸回りに `angleRad` 回し、
 * 透視投影した四隅を返す。消失点は板の縦の中央（上下が対称に縮む）。
 *
 * 角度は `±BOARD_FLIP_MAX_ANGLE_RAD` に丸める（退化角で射影行列が壊れるのを防ぐ）。
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
  const angle = Math.min(
    BOARD_FLIP_MAX_ANGLE_RAD,
    Math.max(-BOARD_FLIP_MAX_ANGLE_RAD, Number.isFinite(angleRad) ? angleRad : 0)
  )
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
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
