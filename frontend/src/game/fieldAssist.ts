/**
 * 一枚絵フィールドの条件付き通行 (#862) の純粋関数。DOM / PixiJS には触れない。
 *
 * 通行は 3 通りだけ（歩行マスクの白・黒・橙）。橙のセルは、`requires` のフラグがすべて真の間だけ通れ、
 * 通るときは同行者が主人公の後ろに現れて押す。例外の場所は設けない。
 */
import { isAssistCell, type Facing, type Facing8, type Vec, type WalkMask } from './fieldWalk'

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
 * 橙の通行状態のラッチ。足元が橙に入った時点で作り、橙を抜けるまで持つ。
 * entry は橙に入る直前の「橙でない」足元（戻る方向の基準）。ワープや開始位置で最初から橙の上に
 * 立っていたときは null（入った場所が無いので、従来どおり抜けるまで自由に歩ける）。
 */
export interface AssistLatch {
  entry: Vec | null
}

/** 条件付き通行の 1 フレーム分の実行時状態 */
export interface AssistRuntime {
  latch: AssistLatch | null
  /** 直近の「橙でない」足元。次に橙へ入ったとき entry になる */
  lastFree: Vec | null
}

export const INITIAL_ASSIST_RUNTIME: AssistRuntime = { latch: null, lastFree: null }

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
  /** 実際に使う移動ベクトル（ラッチ中に通行が止まったら戻る方向だけに絞る） */
  moveVec: Vec
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
 * - 橙の外: 通れる状態なら橙も歩ける。橙へ進もうとして通れなければ blocked（脚本への合図）
 * - 橙に入ったら、抜けるまで「押されている」状態をラッチする。同行者と速度倍率はラッチの間ずっと維持し、
 *   途中でフラグが変わっても blocked は出さない（合図は入口の 1 回だけ）
 * - ラッチ中に通れない状態（unless=拒否・requires が偽）になったら、橙の中では「入ってきた側へ戻る」
 *   向きにだけ動ける（前へは進めない。橙の中で詰まらず、渡り切ることもできない）
 */
export function stepAssistFrame(input: AssistFrameInput): AssistFrame {
  const { base, assisted, pos, vec, state, runtime } = input
  const onOrange = isAssistCell(base, pos.x, pos.y)
  if (!onOrange) {
    return {
      walkMask: state.passable ? assisted : base,
      moveVec: vec,
      onAssist: false,
      wantCompanion: companionWanted(base, pos, vec, state.passable),
      blocked: blockedAttempt(base, pos, vec, state.passable),
      runtime: { latch: null, lastFree: { x: pos.x, y: pos.y } },
    }
  }
  const latch: AssistLatch = runtime.latch ?? { entry: runtime.lastFree }
  const next: AssistRuntime = { latch, lastFree: runtime.lastFree }
  const pushed = state.passable || latch.entry !== null
  let moveVec = vec
  if (!state.passable && latch.entry !== null) {
    const back = { x: latch.entry.x - pos.x, y: latch.entry.y - pos.y }
    if (vec.x * back.x + vec.y * back.y <= 0) moveVec = { x: 0, y: 0 }
  }
  return {
    walkMask: assisted,
    moveVec,
    onAssist: pushed,
    wantCompanion: pushed,
    blocked: false,
    runtime: next,
  }
}

/** 到着位置（ワープの at・端リンク・開始位置）の計算に使うマスク。通れる状態なら橙も歩ける扱い */
export function arrivalMask(base: WalkMask, assisted: WalkMask, passable: boolean): WalkMask {
  return passable ? assisted : base
}

/**
 * 「通れない状態で橙へ進もうとした」合図を 1 回だけ出すための武装管理。
 * blocked が続く間は最初の 1 回だけ emit し、blocked が途切れたら（入力が止まる・離れる）再武装する。
 */
export function stepBlockedEvent(
  armed: boolean,
  blocked: boolean
): { armed: boolean; emit: boolean } {
  if (!blocked) return { armed: true, emit: false }
  return { armed: false, emit: armed }
}
