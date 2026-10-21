/**
 * 一枚絵フィールドの条件付き通行 (#862) の純粋関数。DOM / PixiJS には触れない。
 *
 * 通行は 3 通りだけ（歩行マスクの白・黒・橙）。橙のセルは、`requires` のフラグがすべて真の間だけ通れ、
 * 通るときは同行者が主人公の後ろに現れて押す。例外の場所は設けない。
 */
import {
  arrivalPosition,
  isAssistCell,
  isWalkable,
  snapToWalkable,
  type Edge,
  type FieldLink,
  type Facing,
  type Facing8,
  type Vec,
  type WalkMask,
} from './fieldWalk'

export type Flags = Readonly<Record<string, boolean>>

/** 条件付き通行の設定（検証済み） */
export interface AssistConfig {
  /** すべて真のとき、橙のセルを通れる（②を③として扱う） */
  requires: string[]
  /** 真の間は、requires が成り立っていても橙を通れない（脚本が「拒否→説得」に差し替える間に立てる） */
  unless?: string
  /** 真の間は、同行者が半透明（イマジナリー）で、押されずに一人で通る */
  ghostWhen?: string
  /** 押されている間の速さの倍率（0 より大きい）。ghost のときは 1 */
  speedFactor: number
  /** ghost のときの同行者の不透明度 (0..1) */
  ghostAlpha: number
  /** 同行者が主人公の後ろに立つ距離（背景ピクセル） */
  offset: number
  /** 現れる・消えるのにかかる時間(ms) */
  fadeMs: number
}

export const ASSIST_DEFAULTS = {
  speedFactor: 0.7,
  ghostAlpha: 0.5,
  offset: 40,
  fadeMs: 200,
} as const

/**
 * ラッチ中、足元が橙でなくても、この距離(背景ピクセル)以内に橙があればラッチを保つ。橙の間の細い白（足元が
 * たまたまそこに止まる）で解けて、橙にも他の白にも出られず閉じ込められるのを防ぐ。これより離れた白は橙の外
 */
export const ASSIST_LATCH_REACH = 4

/**
 * ラッチ中、最後に橙を踏んでから白の上をこの距離(背景ピクセル)を超えて歩いたら、橙のそばでもラッチを解く。
 * 橙の縁に沿った白を歩き続けて、別の面から橙に入る（通れない状態で渡る）のを防ぐ（2×REACH）。
 * 橙に挟まれた白（isPinched）の上は数えない（橙の間の細い白を行き来しても解けない）
 */
export const ASSIST_LATCH_WALK = 2 * ASSIST_LATCH_REACH

/** 橙に挟まれているとみなす距離(セル)。同じ軸の両側がこの距離以内に橙なら挟まれている（白が 8 セル以下の踊り場・隙間） */
export const ASSIST_PINCH_SPAN = 2 * ASSIST_LATCH_REACH

/** 進行方向のこの距離(背景ピクセル)先が橙なら「橙へ進もうとしている」とみなす */
export const ASSIST_LOOKAHEAD = 12

export interface AssistState {
  /** 橙を通れるか（requires がすべて真で、unless が偽） */
  passable: boolean
  /** unless に止められているか（requires は成り立っている） */
  held: boolean
  /** 同行者を半透明で出す（押さずに一人で通る）か */
  ghost: boolean
}

/** フラグから通行の状態を決める。宣言されていない名前は偽 */
export function evalAssist(cfg: AssistConfig, flags: Flags): AssistState {
  const on = (name: string | undefined): boolean => !!name && flags[name] === true
  const required = cfg.requires.every((n) => flags[n] === true)
  const held = required && on(cfg.unless)
  return { passable: required && !held, held, ghost: on(cfg.ghostWhen) }
}

/** 進行方向 vec の dist 先が橙のセルか。vec が 0 なら false */
export function aheadIsAssist(
  mask: WalkMask,
  pos: Vec,
  vec: Vec,
  dist = ASSIST_LOOKAHEAD
): boolean {
  if (vec.x === 0 && vec.y === 0) return false
  return isAssistCell(mask, pos.x + vec.x * dist, pos.y + vec.y * dist)
}

/** 同行者を出したいか: 通れる状態で、足元が橙の上か、橙へ進もうとしている */
export function companionWanted(mask: WalkMask, pos: Vec, vec: Vec, passable: boolean): boolean {
  if (!passable) return false
  return isAssistCell(mask, pos.x, pos.y) || aheadIsAssist(mask, pos, vec)
}

/** 通れない状態で橙へ進もうとしているか（脚本へ知らせる合図の条件） */
export function blockedAttempt(mask: WalkMask, pos: Vec, vec: Vec, passable: boolean): boolean {
  return !passable && aheadIsAssist(mask, pos, vec)
}

/** 押されている間の移動速度。橙の上で、ghost でないときだけ factor を掛ける */
export function assistSpeed(
  base: number,
  onAssist: boolean,
  ghost: boolean,
  factor: number
): number {
  return onAssist && !ghost ? base * factor : base
}

/** 向き 8 方向 → 同行者の絵の 4 方向。斜めは左右を優先する（歩行絵の 4 方向だけで足りる） */
export function facing4(f: Facing8): Facing {
  switch (f) {
    case 'upLeft':
    case 'downLeft':
      return 'left'
    case 'upRight':
    case 'downRight':
      return 'right'
    default:
      return f
  }
}

const FACING_VEC: Record<Facing, Vec> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

/** 同行者の足元: 主人公の向きの反対側（後ろ）に offset だけ離れた点 */
export function companionPosition(feet: Vec, facing: Facing8, offset: number): Vec {
  const v = FACING_VEC[facing4(facing)]
  return { x: feet.x - v.x * offset, y: feet.y - v.y * offset }
}

/** 同行者の現れる・消える不透明度 (0..1) を 1 フレーム進める。fadeMs が 0 以下なら即座に切り替える */
export function stepCompanionAlpha(
  alpha: number,
  wanted: boolean,
  dtMs: number,
  fadeMs: number
): number {
  const target = wanted ? 1 : 0
  if (!(fadeMs > 0)) return target
  const step = Math.max(0, dtMs) / fadeMs
  return wanted ? Math.min(1, alpha + step) : Math.max(0, alpha - step)
}

/** 画面に出す不透明度: ghost のときは ghostAlpha を掛ける */
export function companionDisplayAlpha(alpha: number, ghost: boolean, ghostAlpha: number): number {
  return ghost ? alpha * ghostAlpha : alpha
}

/**
 * 条件付き通行の実行時状態。橙に入った時点で「押されて渡る」状態をラッチし、橙を抜けるまで保つ。
 * 橙へは通れる状態でしか入れない（通れない間は橙を壁として扱う）ので、橙の上にいる＝押されて渡っている。
 * 途中でフラグ（requires / unless）が変わっても同行者・速度倍率・通行は変わらない（脚本は「橙に入る前に
 * フラグを決める」）
 */
export interface AssistRuntime {
  latched: boolean
  /** 最後に橙を踏んでから、橙に挟まれていない白の上を歩いた距離（背景ピクセル）。橙を踏むと 0 に戻る */
  walked: number
  /** 前のフレームの足元（歩いた距離の計算用）。無ければ null */
  last: Vec | null
}

export const INITIAL_ASSIST_RUNTIME: AssistRuntime = { latched: false, walked: 0, last: null }

export interface AssistFrameInput {
  /** 橙を含まない元のマスク */
  base: WalkMask
  /** 橙も歩ける扱いのマスク */
  assisted: WalkMask
  pos: Vec
  /** 入力の移動ベクトル */
  vec: Vec
  /** 現在のフラグから評価した状態 */
  state: AssistState
  runtime: AssistRuntime
  /** 橙からしか入れない白のセル（findLatchHoldWhite）。ラッチ中はその上でラッチを保つ。無ければ保持なし */
  hold?: Uint8Array
}

export interface AssistFrame {
  /** 移動に使うマスク */
  walkMask: WalkMask
  /** 橙の上で押されている（速度倍率を掛ける）か */
  onAssist: boolean
  /** 同行者を出したいか */
  wantCompanion: boolean
  /** 通れない状態で橙へ進もうとしたか（脚本へ知らせる合図。橙の上では出さない） */
  blocked: boolean
  runtime: AssistRuntime
}

/**
 * 条件付き通行の 1 フレーム分の判定（DOM 非依存）。
 *
 * - 足元が橙でない: 通れる状態なら橙も歩ける。通れない状態は橙を壁として扱う（橙へは入れない）。
 *   橙へ進もうとして通れなければ blocked（脚本への合図）
 * - 足元が橙: 入った時点の「押されて渡る」状態を「ラッチ」して、橙を抜けるまで保つ。ラッチ中は橙を歩けるマスクで動き、
 *   途中でフラグ（requires / unless）が変わっても同行者・速度倍率・通行は変わらない。blocked は出ない
 * - ラッチは、足元が橙でなく、かつ ASSIST_LATCH_REACH 以内に橙も無くなったフレームで解ける。さらに、最後に橙を
 *   踏んでから、橙に挟まれていない白を ASSIST_LATCH_WALK を超えて歩いたら、橙のそばでも解ける（縁沿いの白を
 *   歩いて別の面から入れない）。橙に挟まれた白（isPinched。橙の間の白が 8 セル以下）の上では保つので、細い白を
 *   跨いで別の橙片に移っても維持される（1 フレームの移動は同じマスクで行う）。ラッチが解けたあとの通れない状態
 *   では橙へ戻れない
 */
export function stepAssistFrame(input: AssistFrameInput): AssistFrame {
  const { base, assisted, pos, vec, state, runtime, hold } = input
  const onOrange = isAssistCell(base, pos.x, pos.y)
  // 橙の上: 橙を踏んだので歩いた距離は 0 に戻る。ラッチが無いのに橙の上にいるのは、ワープや開始位置で置かれた
  // とき。通れない状態でも歩いて抜けられるようにする（閉じ込めない）
  let rt: AssistRuntime | null = onOrange ? { latched: true, walked: 0, last: pos } : null
  // 保持の白（橙からしか入れない白）にいるなら、ラッチ中として扱う。薄い橙を 1 フレームで飛び越えて足元が橙に
  // 一度も乗らず入った場合も、そこで閉じ込められない（保持の白は start・ワープの at・リンクの帯に通じない）
  if (!rt && (runtime.latched || isHeldWhite(base, hold, pos))) {
    // 橙に挟まれた白（隙間・踊り場）の上はラッチを保つ（歩いた距離も数えない）。それ以外の橙のそばの白は、橙を
    // 踏まずに歩きすぎたら解く（縁沿いに歩いて別の面から入るのを防ぐ）
    const pinched = isHeldWhite(base, hold, pos) || isPinched(base, pos)
    const walked = runtime.walked + (!pinched && runtime.last ? dist(pos, runtime.last) : 0)
    if (pinched || (walked <= ASSIST_LATCH_WALK && orangeNear(base, pos, ASSIST_LATCH_REACH)))
      rt = { latched: true, walked, last: pos }
  }
  if (!rt) {
    return {
      walkMask: state.passable ? assisted : base,
      onAssist: false,
      wantCompanion: companionWanted(base, pos, vec, state.passable),
      blocked: blockedAttempt(base, pos, vec, state.passable),
      runtime: INITIAL_ASSIST_RUNTIME,
    }
  }
  return { walkMask: assisted, onAssist: true, wantCompanion: true, blocked: false, runtime: rt }
}

/** pos が hold（橙からしか入れない白）のセルか */
function isHeldWhite(mask: WalkMask, hold: Uint8Array | undefined, pos: Vec): boolean {
  if (!hold) return false
  const x = Math.floor(pos.x)
  const y = Math.floor(pos.y)
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false
  return hold[y * mask.width + x] === 1
}

const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * pos が橙に挟まれた白か: x 軸または y 軸のどちらかで、両側とも ASSIST_PINCH_SPAN セル以内に（白だけを通って）
 * 橙がある。2 本の橙の間の白が 8 セル以下なら、その白は全部挟まれている
 */
export function isPinched(mask: WalkMask, pos: Vec): boolean {
  if (!mask.assist) return false
  const side = (dx: number, dy: number): boolean => {
    for (let k = 1; k <= ASSIST_PINCH_SPAN; k++) {
      const x = pos.x + dx * k
      const y = pos.y + dy * k
      if (isAssistCell(mask, x, y)) return true
      if (!isWalkable(mask, x, y)) return false
    }
    return false
  }
  return (side(1, 0) && side(-1, 0)) || (side(0, 1) && side(0, -1))
}

/** pos から reach 以内（円）に橙のセルがあるか */
export function orangeNear(mask: WalkMask, pos: Vec, reach: number): boolean {
  if (!mask.assist) return false
  const r = Math.ceil(reach)
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= reach * reach && isAssistCell(mask, pos.x + dx, pos.y + dy))
        return true
  return false
}

/**
 * 端リンクの着地を「通れる状態」として扱うか。通れる状態か、橙の途中でラッチ中（橙の途中で通れない状態に
 * 切り替わって、渡り切るまで固定されている）のとき。シーンをまたぐ階段でも渡り切れる。
 * ラッチ中でも、足元が橙でも橙に挟まれた白でも橙からしか入れない白（hold）でもなければ、橙は渡り切っている
 * （縁沿いの白でラッチが残っているだけ）ので引き継がない（橙の向こうへ置かれない）
 */
export function edgeArrivalPassable(
  state: AssistState | null,
  runtime: AssistRuntime,
  base: WalkMask,
  pos: Vec,
  hold?: Uint8Array
): boolean {
  if (state?.passable) return true
  if (!runtime.latched) return false
  return isAssistCell(base, pos.x, pos.y) || isHeldWhite(base, hold, pos) || isPinched(base, pos)
}

/** 端リンクの到着位置とそのときの実行時状態 */
export interface EdgeArrivalOk {
  kind: 'ok'
  pos: Vec
  runtime: AssistRuntime
}

/** 端リンクを渡れなかった: locked = 通れない状態で橙の向こうへ置くことになる（元のシーンに残す）／none = 歩ける点が無い */
export interface EdgeArrivalRefused {
  kind: 'locked' | 'none'
}

export type EdgeArrivalResult = EdgeArrivalOk | EdgeArrivalRefused

/**
 * 来た端（edge）から橙を通らずにたどれる白のセルを 1 にした配列を返す。種は、端から band 幅の帯の歩ける白のうち、
 * 端からそのセルまでの一直線（端から垂直に）に橙が無いもの（黒い縁は越えてよい。端から数 px 手前で橙が止まり
 * 黒い縁があっても、帯の白が種になる。一方、薄い橙の向こうの白は、帯の中にあっても、橙を越えた先なので種にしない）。
 * そこから橙・黒を通らずに（4 近傍で）たどれる白が対象。マスクは橙を除いた元のマスク（橙は walkable=0 で壁になる）。
 */
export function whiteReachableFromEdge(base: WalkMask, edge: Edge, band = 1): Uint8Array {
  const { width, height, walkable, assist } = base
  const seen = new Uint8Array(width * height)
  const queue: number[] = []
  const vertical = edge === 'top' || edge === 'bottom'
  const lines = vertical ? width : height
  const len = vertical ? height : width
  const depth = Math.max(1, Math.min(len, Math.ceil(band)))
  for (let k = 0; k < lines; k++) {
    for (let d = 0; d < depth; d++) {
      const x = vertical ? k : edge === 'left' ? d : width - 1 - d
      const y = vertical ? (edge === 'top' ? d : height - 1 - d) : k
      const i = y * width + x
      if (assist && assist[i] === 1) break // 橙に当たったら、その先は種にしない
      if (walkable[i] === 1 && !seen[i]) {
        seen[i] = 1
        queue.push(i)
      }
    }
  }
  const visit = (j: number): void => {
    if (walkable[j] === 1 && !seen[j]) {
      seen[j] = 1
      queue.push(j)
    }
  }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h]
    const x = i % width
    if (x > 0) visit(i - 1)
    if (x < width - 1) visit(i + 1)
    if (i >= width) visit(i - width)
    if (i < width * (height - 1)) visit(i + width)
  }
  return seen
}

/**
 * 端リンクで着く場所と実行時状態を決める。
 *
 * - 通れる状態: 橙込みのマスクで着地点を探す。橙の上に着いたら、押されて渡る状態でラッチして続ける
 * - 通れない状態（橙を含むマスクのとき）: 橙を除いたマスクで着地点を探す。ただし着地点が「来た端の帯から橙を
 *   通らずにたどれる白」に入らなければ、移動自体を断る（kind: 'locked'）。橙で隔てられた向こう側の白へは置かない。
 *   来た端の帯に歩ける白が無いときも断る。片道リンク（戻りリンクが無い）は来た端が決まらないので、この判定は
 *   かけず、画面中心の近くの白に置く
 * - 橙を含まないマスクは従来どおり（判定なし）
 */
export function resolveEdgeArrival(args: {
  link: FieldLink
  back: FieldLink | null
  srcPos: Vec
  base: WalkMask
  assisted: WalkMask
  inset: number
  /** 橙を通れる状態か */
  passable: boolean
  /** 来た端の帯の幅（背景ピクセル。edgeThreshold を渡す）。既定 1 */
  edgeBand?: number
}): EdgeArrivalResult {
  const { link, back, srcPos, base, assisted, inset, passable, edgeBand } = args
  const center = (m: WalkMask): Vec | null =>
    snapToWalkable(m, { x: m.width / 2, y: m.height / 2 }, Math.max(m.width, m.height))
  const mask = arrivalMask(base, assisted, passable)
  const pos = back
    ? (arrivalPosition(link, srcPos, back, mask, inset) ?? center(mask))
    : center(mask)
  const hasOrange = base.assist !== undefined
  const refuseFlood = hasOrange && !passable && back !== null
  if (!pos) return { kind: refuseFlood ? 'locked' : 'none' }
  let landing = pos
  if (refuseFlood) {
    const reach = whiteReachableFromEdge(base, back.edge, edgeBand)
    const x = Math.min(base.width - 1, Math.max(0, Math.floor(pos.x)))
    const y = Math.min(base.height - 1, Math.max(0, Math.floor(pos.y)))
    if (reach[y * base.width + x] !== 1) {
      // 予定点が橙の向こうでも、帯から辿れる白があればそこへ置く（断るのは辿れる白が無いときだけ）
      const near = nearestMarked(reach, base.width, pos)
      if (!near) return { kind: 'locked' }
      landing = near
    }
  }
  const onOrange = isAssistCell(base, landing.x, landing.y)
  return {
    kind: 'ok',
    pos: landing,
    // 橙の上に着いたら新しくラッチする（歩いた距離は 0）
    runtime: onOrange ? { latched: true, walked: 0, last: landing } : INITIAL_ASSIST_RUNTIME,
  }
}

/** marked が 1 のセルのうち、p に最も近いセルの中心。無ければ null */
function nearestMarked(marked: Uint8Array, width: number, p: Vec): Vec | null {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < marked.length; i++) {
    if (marked[i] !== 1) continue
    const dx = (i % width) + 0.5 - p.x
    const dy = Math.floor(i / width) + 0.5 - p.y
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best < 0 ? null : { x: (best % width) + 0.5, y: Math.floor(best / width) + 0.5 }
}

/** 橙のセルを 4 近傍の連結成分ごとに 0.. の番号で塗る（橙でないセルは -1） */
function labelOrange(base: WalkMask): Int32Array {
  const { width, height, assist } = base
  const label = new Int32Array(width * height).fill(-1)
  if (!assist) return label
  let next = 0
  const stack: number[] = []
  for (let s0 = 0; s0 < label.length; s0++) {
    if (assist[s0] !== 1 || label[s0] >= 0) continue
    label[s0] = next
    stack.push(s0)
    while (stack.length) {
      const i = stack.pop() as number
      const x = i % width
      const grow = (j: number): void => {
        if (assist[j] === 1 && label[j] < 0) {
          label[j] = next
          stack.push(j)
        }
      }
      if (x > 0) grow(i - 1)
      if (x < width - 1) grow(i + 1)
      if (i >= width) grow(i - width)
      if (i < width * (height - 1)) grow(i + width)
    }
    next++
  }
  return label
}

/**
 * 橙からしか入れない白のセルを 1 にした配列を返す（無ければ undefined）。白（橙を壁にした 4 近傍）の連結成分のうち、
 * safe（start・ワープの at・片道リンクの到着点）にも edges（リンクのある端の帯）にも通じていないもので、
 * (a) 橙の向こうで通じている別の白の成分が 2 つ以上ある（橙と橙の間の踊り場。手すりで割れた 1 本の階段や、同じ
 * 広場へ下りる 2 本の階段は向こうの白が 1 つなので数えない）か、(b) 橙にしか接しない（黒・画像の端に接しない。
 * 橙に囲まれた島）もの。そこへは橙を通ってしか入れないので、ラッチ中はその上でラッチを保つ（通れない状態に
 * 切り替わっても、橙の続きとして渡り切れる）。橙の向こうの白が 1 つだけで黒にも接する白（橙の先の行き止まりの広場）は
 * 対象外: 渡り切った先なので、通れない状態では橙へ戻れない。base は橙を除いた元のマスク
 */
export function findLatchHoldWhite(
  base: WalkMask,
  safe: readonly Vec[],
  edges: readonly { edge: Edge; band: number }[]
): Uint8Array | undefined {
  const { width, height, walkable, assist } = base
  if (!assist) return undefined
  const orange = labelOrange(base)
  const label = new Int32Array(width * height).fill(-1)
  const regions: { touches: Set<number>; walled: boolean; ok: boolean }[] = []
  // 橙の成分ごとに、接している白の成分の番号
  const orangeWhites = new Map<number, Set<number>>()
  const stack: number[] = []
  for (let s0 = 0; s0 < label.length; s0++) {
    if (walkable[s0] !== 1 || label[s0] >= 0) continue
    const id = regions.length
    const r = { touches: new Set<number>(), walled: false, ok: false }
    regions.push(r)
    label[s0] = id
    stack.push(s0)
    const look = (j: number): void => {
      if (assist[j] === 1) {
        const o = orange[j]
        r.touches.add(o)
        let ws = orangeWhites.get(o)
        if (!ws) orangeWhites.set(o, (ws = new Set<number>()))
        ws.add(id)
      } else if (walkable[j] !== 1) {
        r.walled = true // 黒
      } else if (label[j] < 0) {
        label[j] = id
        stack.push(j)
      }
    }
    while (stack.length) {
      const i = stack.pop() as number
      const x = i % width
      if (x > 0) look(i - 1)
      else r.walled = true // 画像の端
      if (x < width - 1) look(i + 1)
      else r.walled = true
      if (i >= width) look(i - width)
      else r.walled = true
      if (i < width * (height - 1)) look(i + width)
      else r.walled = true
    }
  }
  const mark = (x: number, y: number): void => {
    const px = Math.min(width - 1, Math.max(0, Math.floor(x)))
    const py = Math.min(height - 1, Math.max(0, Math.floor(y)))
    const l = label[py * width + px]
    if (l >= 0) regions[l].ok = true
  }
  for (const p of safe) {
    const near = snapToWalkable(base, p, 80)
    if (near) mark(near.x, near.y)
  }
  for (const { edge, band } of edges) {
    const vertical = edge === 'top' || edge === 'bottom'
    const lines = vertical ? width : height
    const len = vertical ? height : width
    const depth = Math.max(1, Math.min(len, Math.ceil(band)))
    for (let k = 0; k < lines; k++)
      for (let d = 0; d < depth; d++) {
        const x = vertical ? k : edge === 'left' ? d : width - 1 - d
        const y = vertical ? (edge === 'top' ? d : height - 1 - d) : k
        if (assist[y * width + x] === 1) break // whiteReachableFromEdge と同じく、橙の先は種にしない
        mark(x, y)
      }
  }
  const isHeld = (id: number): boolean => {
    const r = regions[id]
    if (r.touches.size === 0) return false
    if (!r.walled) return true // 橙にしか接しない島
    // 橙の向こうで通じている別の白の成分
    const others = new Set<number>()
    for (const o of r.touches) for (const w of orangeWhites.get(o) as Set<number>) others.add(w)
    others.delete(id)
    return others.size >= 2
  }
  const heldOf = regions.map((r, id) => !r.ok && isHeld(id))
  const hold = new Uint8Array(width * height)
  let any = false
  for (let i = 0; i < label.length; i++) {
    const l = label[i]
    if (l >= 0 && heldOf[l]) {
      hold[i] = 1
      any = true
    }
  }
  return any ? hold : undefined
}

/** 到着位置（ワープの at・開始位置）の計算に使うマスク。通れる状態なら橙も歩ける扱い */
export function arrivalMask(base: WalkMask, assisted: WalkMask, passable: boolean): WalkMask {
  return passable ? assisted : base
}

/** 合図の武装管理の状態。at は直近に合図を出した足元 */
export interface BlockedGate {
  armed: boolean
  at: Vec | null
}

export const INITIAL_BLOCKED_GATE: BlockedGate = { armed: true, at: null }

/**
 * 「通れない状態で橙へ進もうとした」合図を 1 回だけ出すための武装管理。
 * 出したあとは、入力が止まる（vec が 0）か、合図を出した場所から ASSIST_LOOKAHEAD 以上離れるまで再武装しない
 * （橙の縁に沿って斜めに滑ると blocked が点いたり消えたりするが、押しっぱなしの間は連発しない）
 */
export function stepBlockedEvent(
  gate: BlockedGate,
  blocked: boolean,
  pos: Vec,
  vec: Vec
): { gate: BlockedGate; emit: boolean } {
  const idle = vec.x === 0 && vec.y === 0
  const away =
    gate.at === null || Math.hypot(pos.x - gate.at.x, pos.y - gate.at.y) >= ASSIST_LOOKAHEAD
  const g = !gate.armed && (idle || away) ? INITIAL_BLOCKED_GATE : gate
  if (blocked && g.armed) return { gate: { armed: false, at: { x: pos.x, y: pos.y } }, emit: true }
  return { gate: g, emit: false }
}

/**
 * 端リンクを渡れなかったときの後始末。同じリンクを無効化して（入力が途切れるまで再発火させない）元のシーンに
 * 残り、locked（橙の向こうへ置くことになる移動を断った）なら脚本へ知らせる合図の reason を返す。
 * none（歩ける点が無い）は合図を出さない（エラー表示のみ）
 */
export function refuseEdgeLink(
  link: FieldLink,
  kind: EdgeArrivalRefused['kind'],
  held: boolean
): { disarmed: FieldLink; reason: 'held' | 'locked' | null } {
  return { disarmed: link, reason: kind === 'locked' ? (held ? 'held' : 'locked') : null }
}
