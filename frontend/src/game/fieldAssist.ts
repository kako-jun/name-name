/**
 * 一枚絵フィールドの条件付き通行 (#862) の純粋関数。DOM / PixiJS には触れない。
 *
 * 通行は 3 通りだけ（歩行マスクの白・黒・橙）。橙のセルは、`requires` のフラグがすべて真の間だけ通れ、
 * 通るときは同行者が主人公の後ろに現れて押す。例外の場所は設けない。
 */
import {
  arrivalPosition,
  isAssistCell,
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
}

export const INITIAL_ASSIST_RUNTIME: AssistRuntime = { latched: false }

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
 * - ラッチは、足元が橙でなく、かつ ASSIST_LATCH_REACH 以内に橙も無くなったフレームで解ける。細い白を跨いで
 *   別の橙片に移っても維持される（1 フレームの移動は同じマスクで行う）。ラッチが解けたあとの通れない状態では
 *   橙へ戻れない
 */
export function stepAssistFrame(input: AssistFrameInput): AssistFrame {
  const { base, assisted, pos, vec, state, runtime } = input
  const onOrange = isAssistCell(base, pos.x, pos.y)
  if (!onOrange && !(runtime.latched && orangeNear(base, pos, ASSIST_LATCH_REACH))) {
    return {
      walkMask: state.passable ? assisted : base,
      onAssist: false,
      wantCompanion: companionWanted(base, pos, vec, state.passable),
      blocked: blockedAttempt(base, pos, vec, state.passable),
      runtime: INITIAL_ASSIST_RUNTIME,
    }
  }
  // 橙の上（または橙のすぐそば）: 入った時点の状態を保つ。ラッチが無いのに橙の上にいるのは、ワープや開始位置で
  // 置かれたとき。通れない状態でも歩いて抜けられるようにする（閉じ込めない）
  return {
    walkMask: assisted,
    onAssist: true,
    wantCompanion: true,
    blocked: false,
    runtime: { latched: true },
  }
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
  if (refuseFlood) {
    const reach = whiteReachableFromEdge(base, back.edge, edgeBand)
    const x = Math.min(base.width - 1, Math.max(0, Math.floor(pos.x)))
    const y = Math.min(base.height - 1, Math.max(0, Math.floor(pos.y)))
    if (reach[y * base.width + x] !== 1) return { kind: 'locked' }
  }
  const onOrange = isAssistCell(base, pos.x, pos.y)
  return {
    kind: 'ok',
    pos,
    runtime: onOrange ? { latched: true } : INITIAL_ASSIST_RUNTIME,
  }
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
