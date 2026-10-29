/**
 * 一枚絵フィールド (#807) の純粋関数群。DOM / PixiJS には触れない。
 *
 * 座標はすべて「背景画像のピクセル座標」（歩行マスクも背景と同じ大きさ）。
 * 主人公の位置 = 足元の点。判定は足元の 1 点だけで行う。
 */

export type Edge = 'top' | 'bottom' | 'left' | 'right'
export type Facing = 'up' | 'down' | 'left' | 'right'
/** 斜め 4 方向 (#811)。画面は y が下向きなので、upLeft = 左上 */
export type DiagonalFacing = 'upLeft' | 'upRight' | 'downLeft' | 'downRight'
export type Facing8 = Facing | DiagonalFacing
export interface Vec {
  x: number
  y: number
}

// ---- 歩行マスク ----

/**
 * 歩行マスク。walkable[y * width + x] = 1 なら歩ける（白）。
 * assist[y * width + x] = 1 は「条件付き」のセル（橙 #FF9D00。車椅子だけ通れない＝同行者に押してもらえる間だけ通れる #862）。
 * assist のセルは walkable = 0（既定では黒と同じ）。橙が 1 点も無いマスクでは assist は無い。
 */
export interface WalkMask {
  width: number
  height: number
  walkable: Uint8Array
  assist?: Uint8Array
}

/**
 * 橙（条件付き通行）の色か (#862)。sit-by-me の traversal 3 値の橙 #FF9D00 に合わせ、
 * R≥192・96≤G≤224・B≤96 とする（白・灰・黒・純赤・純黄は橙ではない）。
 */
export function isAssistColor(r: number, g: number, b: number): boolean {
  return r >= 192 && g >= 96 && g <= 224 && b <= 96
}

/**
 * RGBA ピクセル列（ImageData.data 相当）から歩行マスクを作る。3 値 (#862): 橙 = 条件付き（assist）、
 * それ以外は白（輝度が threshold 以上）= 歩ける、黒 = 歩けない。
 * 輝度は R の値ではなく (R+G+B)/3 で見る。橙の判定は輝度より先。
 */
export function maskFromRgba(
  width: number,
  height: number,
  rgba: ArrayLike<number>,
  threshold = 128
): WalkMask {
  const walkable = new Uint8Array(width * height)
  let assist: Uint8Array | undefined
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    if (isAssistColor(r, g, b)) {
      assist ??= new Uint8Array(width * height)
      assist[i] = 1
      continue
    }
    const lum = (r + g + b) / 3
    walkable[i] = lum >= threshold ? 1 : 0
  }
  return assist ? { width, height, walkable, assist } : { width, height, walkable }
}

/** 条件付きのセルも歩ける扱いにしたマスク (#862)。assist が無ければ同じマスクをそのまま返す */
export function maskWithAssist(mask: WalkMask): WalkMask {
  const assist = mask.assist
  if (!assist) return mask
  const walkable = new Uint8Array(mask.walkable.length)
  for (let i = 0; i < walkable.length; i++) walkable[i] = mask.walkable[i] | assist[i]
  return { width: mask.width, height: mask.height, walkable, assist }
}

/** その足元が条件付き（橙）のセルか。範囲外は false */
export function isAssistCell(mask: WalkMask, x: number, y: number): boolean {
  if (!mask.assist) return false
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  if (!(ix >= 0 && iy >= 0 && ix < mask.width && iy < mask.height)) return false
  return mask.assist[iy * mask.width + ix] === 1
}

/** 足元の座標が歩けるか。範囲外は歩けない（黒扱い） */
export function isWalkable(mask: WalkMask, x: number, y: number): boolean {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  if (!(ix >= 0 && iy >= 0 && ix < mask.width && iy < mask.height)) return false
  return mask.walkable[iy * mask.width + ix] === 1
}

/**
 * 指定位置が歩けなければ、近い歩ける点へずらす（正方形の外周を 1px ずつ広げて探す）。
 * radius 内に無ければ null。
 */
export function snapToWalkable(mask: WalkMask, p: Vec, radius: number): Vec | null {
  if (isWalkable(mask, p.x, p.y)) return { x: p.x, y: p.y }
  for (let r = 1; r <= radius; r++) {
    let best: Vec | null = null
    let bestD = Infinity
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        if (!isWalkable(mask, p.x + dx, p.y + dy)) continue
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = { x: p.x + dx, y: p.y + dy }
        }
      }
    }
    if (best) return best
  }
  return null
}

// ---- 前面レイヤー (#866) ----

/**
 * 前面レイヤーの不透明領域。opaque[y * width + x] = 1 なら、その点は前面の絵が手前に描かれる（主人公を隠す）。
 * 描画には前面の画像をそのまま重ねる。これは「どれだけ隠れているか」をデバッグ表示・テストで測るためだけに使い、
 * 歩行・リンク・エンカウントの判定には使わない（見た目だけ）。
 */
export interface ForegroundMask {
  width: number
  height: number
  opaque: Uint8Array
}

/** RGBA ピクセル列から前面の不透明領域を作る。alpha が threshold 以上の点を前面とする */
export function foregroundFromRgba(
  width: number,
  height: number,
  rgba: ArrayLike<number>,
  threshold = 128
): ForegroundMask {
  const opaque = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) opaque[i] = rgba[i * 4 + 3] >= threshold ? 1 : 0
  return { width, height, opaque }
}

/**
 * 主人公のスプライト矩形のうち、前面に覆われている割合 (0..1)。矩形は足元（下端中心）と表示の幅・高さから作る。
 * 画面外の部分は数えない（矩形のうち画面内の点だけが分母）。画面内に点が無ければ 0。
 */
export function foregroundCoverage(
  fg: ForegroundMask,
  feet: Vec,
  spriteWidth: number,
  spriteHeight: number
): number {
  const x0 = Math.max(0, Math.floor(feet.x - spriteWidth / 2))
  const x1 = Math.min(fg.width, Math.ceil(feet.x + spriteWidth / 2))
  const y0 = Math.max(0, Math.floor(feet.y - spriteHeight))
  const y1 = Math.min(fg.height, Math.ceil(feet.y))
  let total = 0
  let covered = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++
      if (fg.opaque[y * fg.width + x] === 1) covered++
    }
  }
  return total === 0 ? 0 : covered / total
}

// ---- 入力 → 移動ベクトル ----

export interface DirectionKeys {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

/** キー 8 方向 → 長さ 1 の移動ベクトル（斜めも速さが変わらない）。入力なしは (0,0) */
export function keysToVector(keys: DirectionKeys): Vec {
  const x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0)
  const y = (keys.down ? 1 : 0) - (keys.up ? 1 : 0)
  const len = Math.hypot(x, y)
  return len === 0 ? { x: 0, y: 0 } : { x: x / len, y: y / len }
}

/** タップ・ドラッグ: 足元から指の位置へ向かう連続した向き。deadzone 内は入力なし */
export function pointerToVector(feet: Vec, target: Vec, deadzone: number): Vec {
  const dx = target.x - feet.x
  const dy = target.y - feet.y
  const len = Math.hypot(dx, dy)
  if (len <= deadzone || len === 0) return { x: 0, y: 0 }
  return { x: dx / len, y: dy / len }
}

// ---- 移動 ----

export interface MoveResult {
  pos: Vec
  /** 実際に位置が変わった距離（歩数カウント用。壁に押しつけるだけなら 0） */
  distance: number
}

/**
 * 移動ベクトル × 速さ(px/秒) × 経過ms だけ進む。壁にぶつかったら通れる軸だけ滑らせる。
 * すり抜けを防ぐため、1 回の判定は最大 maxStep px ずつ刻む。
 */
export function stepMove(
  mask: WalkMask,
  pos: Vec,
  vec: Vec,
  speed: number,
  dtMs: number,
  maxStep = 1
): MoveResult {
  const total = (speed * dtMs) / 1000
  if (total <= 0 || (vec.x === 0 && vec.y === 0)) return { pos, distance: 0 }
  const n = Math.max(1, Math.ceil(total / maxStep))
  const dx = (vec.x * total) / n
  const dy = (vec.y * total) / n
  let x = pos.x
  let y = pos.y
  let moved = 0
  for (let i = 0; i < n; i++) {
    // 斜めの 1 歩が歩けても、x のみ・y のみの単独の歩みがどちらも歩けない（角）なら通さない
    const cornerBlocked =
      dx !== 0 && dy !== 0 && !isWalkable(mask, x + dx, y) && !isWalkable(mask, x, y + dy)
    if (!cornerBlocked && isWalkable(mask, x + dx, y + dy)) {
      x += dx
      y += dy
      moved += Math.hypot(dx, dy)
    } else if (dx !== 0 && isWalkable(mask, x + dx, y)) {
      x += dx
      moved += Math.abs(dx)
    } else if (dy !== 0 && isWalkable(mask, x, y + dy)) {
      y += dy
      moved += Math.abs(dy)
    } else {
      break
    }
  }
  return { pos: { x, y }, distance: moved }
}

// ---- 向き・歩行アニメ ----

/** 8 方向それぞれの中心角（度）。y が下向きなので、右=0・下=90・左=180・上=-90 */
const FACING8_ANGLE: Record<Facing8, number> = {
  right: 0,
  downRight: 45,
  down: 90,
  downLeft: 135,
  left: 180,
  upLeft: -135,
  up: -90,
  upRight: -45,
}
const FACING8_LIST = Object.keys(FACING8_ANGLE) as Facing8[]

/** 8 分割の 1 区画の半幅（度）。45 度刻みなので 22.5 */
export const SECTOR_HALF_DEG = 22.5
/** ヒステリシス: 直前の向きの区画を、境界からさらにこの角度（度）だけ広く扱う */
export const FACING_HYSTERESIS_DEG = 8

/** 2 つの角度（度）の差の絶対値 (0..180) */
function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * 向き。
 * diagonal = false（既定）: 移動ベクトルの支配軸で 4 方向から選ぶ（横の成分が大きければ左右、縦なら上下）。
 * 入力なし・成分が同じ（きっちり斜め）のときは直前の向き prev をそのまま返す（4 方向へ寄せ直さない）。
 * diagonal = true (#811): 移動ベクトルの角度を 8 分割して選ぶ。直前の向きの区画は
 * FACING_HYSTERESIS_DEG だけ広く扱い、境界付近で向きが細かく切り替わらないようにする。
 * 入力なし（長さ 0）は直前の向きを保つ。
 */
export function facingFromVector(vec: Vec, prev: Facing8, diagonal = false): Facing8 {
  const ax = Math.abs(vec.x)
  const ay = Math.abs(vec.y)
  if (ax === 0 && ay === 0) return prev
  if (!diagonal) {
    if (ax > ay) return vec.x > 0 ? 'right' : 'left'
    if (ay > ax) return vec.y > 0 ? 'down' : 'up'
    return prev
  }
  const angle = (Math.atan2(vec.y, vec.x) * 180) / Math.PI
  if (angleDiff(angle, FACING8_ANGLE[prev]) <= SECTOR_HALF_DEG + FACING_HYSTERESIS_DEG) return prev
  let best = FACING8_LIST[0]
  let bestD = Infinity
  for (const f of FACING8_LIST) {
    const d = angleDiff(angle, FACING8_ANGLE[f])
    if (d < bestD) {
      bestD = d
      best = f
    }
  }
  return best
}

export const WALK_FRAMES = 3

/** 歩行周期の既定。コマを 0→1→2 と順に送る（車椅子など、コマが「ハンドリムをこぐ 3 コマ」の素材向け） */
export const DEFAULT_WALK_CYCLE: readonly number[] = [0, 1, 2]

/**
 * 歩行アニメのコマ番号 (0..2)。moving の間、frameMs ごとに cycle の要素を順に繰り返す。
 * 止まっているとき・入力が不正なとき・cycle の要素が 0..2 の整数でないときは idleFrame。cycle / idleFrame の既定は [0, 1, 2] / 0（従来どおり）。
 * 立位の歩行素材（コマ 0・2 が接地、コマ 1 が通過）は cycle = [0, 1, 2, 1]・idleFrame = 1 で、左右交互に歩き通過コマで止まる。
 */
export function walkFrame(
  moving: boolean,
  movingElapsedMs: number,
  frameMs: number,
  cycle: readonly number[] = DEFAULT_WALK_CYCLE,
  idleFrame = 0
): number {
  if (!moving || !(frameMs > 0) || !(movingElapsedMs >= 0) || !Number.isFinite(movingElapsedMs))
    return idleFrame
  if (cycle.length === 0) return idleFrame
  const f = cycle[Math.floor(movingElapsedMs / frameMs) % cycle.length]
  // コマ番号は 0..2 のみ有効。範囲外・非整数は idleFrame に倒す
  return Number.isInteger(f) && f >= 0 && f < WALK_FRAMES ? f : idleFrame
}

/** 歩行周期の指定（`player` / `companion` の cycle・idleFrame）。未指定は従来の [0, 1, 2]・停止 0 */
export interface Gait {
  cycle?: number[]
  idleFrame?: number
}

/**
 * 主人公と同行者の表示コマ。同行者は主人公の周期を引き継がず、自分の指定だけを使う
 * （同行者は車椅子の主人公を押す立位の人で、主人公と歩き方が違うため）
 */
export function fieldFrames(
  moving: boolean,
  movingElapsedMs: number,
  frameMs: number,
  player: Gait,
  companion?: Gait | null
): { player: number; companion: number } {
  return {
    player: walkFrame(moving, movingElapsedMs, frameMs, player.cycle, player.idleFrame),
    companion: walkFrame(moving, movingElapsedMs, frameMs, companion?.cycle, companion?.idleFrame),
  }
}

// ---- 端のリンク ----

/** 端のリンク。edge 上の range（辺に沿った範囲。left/right なら y、top/bottom なら x）に入ると to へ遷移 */
export interface FieldLink {
  edge: Edge
  range: [number, number]
  to: string
}

/** その端に向かって進んでいるか（edge への外向き成分が正） */
export function isOutward(edge: Edge, vec: Vec): boolean {
  switch (edge) {
    case 'left':
      return vec.x < 0
    case 'right':
      return vec.x > 0
    case 'top':
      return vec.y < 0
    case 'bottom':
      return vec.y > 0
  }
}

function alongEdge(edge: Edge, p: Vec): number {
  return edge === 'left' || edge === 'right' ? p.y : p.x
}

/**
 * 足元が端のしきい値内で、リンクのある区間に入り、かつその端へ向かって進んでいれば、そのリンクを返す。
 * disarmed: 到着直後に折り返さないよう、いま無効にしているリンク（呼び出し側が、その端へ向かう入力が
 * 途切れたら解除する）。
 */
export function detectEdgeLink(
  pos: Vec,
  size: { width: number; height: number },
  links: readonly FieldLink[],
  threshold: number,
  vec: Vec,
  disarmed: FieldLink | null = null
): FieldLink | null {
  for (const link of links) {
    if (link === disarmed) continue
    if (!isOutward(link.edge, vec)) continue
    const dist =
      link.edge === 'left'
        ? pos.x
        : link.edge === 'right'
          ? size.width - 1 - pos.x
          : link.edge === 'top'
            ? pos.y
            : size.height - 1 - pos.y
    if (dist > threshold) continue
    const c = alongEdge(link.edge, pos)
    if (c >= link.range[0] && c <= link.range[1]) return link
  }
  return null
}

/**
 * 遷移先の出現位置。出た位置が出口の range のどこにあたるか（0..1）を、遷移先の対応するリンクの range に写し、
 * 遷移先の端から inset だけ内側に置く。歩けない点ならマスク上の近い点にずらす（見つからなければ null）。
 */
export function arrivalPosition(
  srcLink: FieldLink,
  srcPos: Vec,
  dstLink: FieldLink,
  dstMask: WalkMask,
  inset: number,
  snapRadius = 80
): Vec | null {
  const [a, b] = srcLink.range
  const t =
    b === a ? 0.5 : Math.min(1, Math.max(0, (alongEdge(srcLink.edge, srcPos) - a) / (b - a)))
  const c = dstLink.range[0] + t * (dstLink.range[1] - dstLink.range[0])
  let p: Vec
  switch (dstLink.edge) {
    case 'left':
      p = { x: inset, y: c }
      break
    case 'right':
      p = { x: dstMask.width - 1 - inset, y: c }
      break
    case 'top':
      p = { x: c, y: inset }
      break
    case 'bottom':
      p = { x: c, y: dstMask.height - 1 - inset }
      break
  }
  return snapToWalkable(dstMask, p, snapRadius)
}

/**
 * 主人公の表示高さ（背景ピクセル）を決める (#810)。シーンの `playerHeight` があればそれ、無ければ全体の値。
 * 表示の大きさだけを決める。足元（スプライト下端中心）・歩行マスク判定・端リンク判定・移動速度は大きさに依存しない
 */
export function resolvePlayerHeight(sceneHeight: number | undefined, globalHeight: number): number {
  return sceneHeight !== undefined && Number.isFinite(sceneHeight) && sceneHeight > 0
    ? sceneHeight
    : globalHeight
}

/** 表示高さ `height` にするためのスプライト倍率（元画像の高さ `textureHeight` が基準）。画像の高さが 0 以下なら 1 */
export function playerScale(height: number, textureHeight: number): number {
  return textureHeight > 0 ? height / textureHeight : 1
}
