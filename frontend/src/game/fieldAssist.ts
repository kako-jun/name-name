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
  type MoveResult,
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
 * 入口からの経路距離の場。assisted マスク（橙も歩ける）の歩けるセルに、入口（端リンク到着なら来た端）から
 * 4 近傍で辿った歩数を入れる。入口から辿れないセルは -1。
 */
export interface DistanceField {
  width: number
  height: number
  dist: Int32Array
}

/**
 * 橙の通行状態のラッチ。足元が橙に入った時点で作り、橙を抜けるまで持つ。
 * entry は橙に入る直前の「橙でない」足元（戻る方向の基準）。端リンクで橙の上に着いたときは、来た端の
 * 外側の点（arrivalRuntime）。ワープや開始位置で最初から橙の上に立っていたときは null
 * （入った場所が無いので、従来どおり抜けるまで自由に歩ける）。
 */
export interface AssistLatch {
  entry: Vec | null
  /** ラッチを作った時点で通れる状態だったか。真の間（途中でフラグが変わっても）同行者が押し、速度倍率を掛ける */
  pushed: boolean
  /** entry からの経路距離の場。通行が止まった最初のフレームに 1 回だけ作る（作る前は undefined） */
  field?: DistanceField
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
  /**
   * ラッチ中に通行が止まった間の、入口からの経路距離の場。非 null のあいだ、動いたあとの場の値が
   * 動く前より大きくなる移動は通さない（limitRetreat）。入口へ向かう側へは動けるが、前へは進めない
   */
  retreatField: DistanceField | null
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
 * - ラッチ中に通れない状態（unless=拒否・requires が偽）になったら、橙の中では「入口へ向かう」動きにだけ
 *   進める（retreatField と limitRetreat）。入口からの経路距離が増える移動は通さない。保証するのは、
 *   渡り切れない（橙が折り返していても向こう側の白へ抜けない）ことと、入口へ向かう経路に沿って必ず動けること。
 *   入口と逆向きの入力は、経路が折り返す場所では動けないことがある（その向きには進めない）
 */
export function stepAssistFrame(input: AssistFrameInput): AssistFrame {
  const { base, assisted, pos, vec, state, runtime } = input
  const onOrange = isAssistCell(base, pos.x, pos.y)
  if (!onOrange) {
    return {
      walkMask: state.passable ? assisted : base,
      retreatField: null,
      onAssist: false,
      wantCompanion: companionWanted(base, pos, vec, state.passable),
      blocked: blockedAttempt(base, pos, vec, state.passable),
      runtime: { latch: null, lastFree: { x: pos.x, y: pos.y } },
    }
  }
  let latch: AssistLatch = runtime.latch ?? { entry: runtime.lastFree, pushed: state.passable }
  if (!state.passable && latch.entry && !latch.field) {
    latch = { ...latch, field: buildDistanceField(assisted, latch.entry) }
  }
  const pushed = state.passable || latch.pushed
  return {
    walkMask: assisted,
    retreatField: !state.passable && latch.entry ? (latch.field ?? null) : null,
    onAssist: pushed,
    wantCompanion: pushed,
    blocked: false,
    runtime: { latch, lastFree: runtime.lastFree },
  }
}

/**
 * 入口 entry からの経路距離の場を作る（マスクのセル数に比例・決定的）。entry がマスクの中ならそのセルを、
 * 外（端リンクで着いたときの来た端の外側）なら、その端の歩けるセルすべてを 0 の種にする。
 */
export function buildDistanceField(mask: WalkMask, entry: Vec): DistanceField {
  const { width, height, walkable, assist } = mask
  const dist = new Int32Array(width * height).fill(-1)
  const ok = (i: number): boolean => walkable[i] === 1 || (assist !== undefined && assist[i] === 1)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0
  const seed = (x: number, y: number): void => {
    const i = y * width + x
    if (dist[i] === -1 && ok(i)) {
      dist[i] = 0
      queue[tail++] = i
    }
  }
  if (entry.y < 0) for (let x = 0; x < width; x++) seed(x, 0)
  else if (entry.y >= height) for (let x = 0; x < width; x++) seed(x, height - 1)
  else if (entry.x < 0) for (let y = 0; y < height; y++) seed(0, y)
  else if (entry.x >= width) for (let y = 0; y < height; y++) seed(width - 1, y)
  else seed(Math.floor(entry.x), Math.floor(entry.y))
  while (head < tail) {
    const i = queue[head++]
    const x = i % width
    const y = (i - x) / width
    const d = dist[i] + 1
    const push = (nx: number, ny: number): void => {
      const j = ny * width + nx
      if (dist[j] === -1 && ok(j)) {
        dist[j] = d
        queue[tail++] = j
      }
    }
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < height - 1) push(x, y + 1)
  }
  return { width, height, dist }
}

/** 場の値。マスクの外・入口から辿れないセルは Infinity */
function fieldAt(field: DistanceField, p: Vec): number {
  const x = Math.floor(p.x)
  const y = Math.floor(p.y)
  if (x < 0 || y < 0 || x >= field.width || y >= field.height) return Infinity
  const d = field.dist[y * field.width + x]
  return d < 0 ? Infinity : d
}

/**
 * 戻る動きだけを通す。stepMove の結果 moved の場の値（入口からの経路距離）が動く前より大きくなるなら、
 * その移動は無かったことにする（壁に沿った滑りで前向きの成分だけが通るのも、ここで止まる）。
 * 場の値は一度も増えないので、橙が折り返していても入口側の連結な経路の外へは出られない
 */
export function limitRetreat(field: DistanceField, prev: Vec, moved: MoveResult): MoveResult {
  return fieldAt(field, moved.pos) > fieldAt(field, prev) ? { pos: prev, distance: 0 } : moved
}

/**
 * 端リンクで着いた直後の実行時状態。着地点が橙の上なら、来た端の外側（画像の外の 1 つ手前）を「入ってきた場所」に
 * する。拒否されると戻る先＝来た端になり、渡り切れない（シーンをまたいでも橙の契約を保つ）。
 * 橙でない場所に着いたなら、ラッチは空で良い（次に橙へ入るときに作られる）
 */
export function arrivalRuntime(base: WalkMask, landing: Vec, edge: Edge): AssistRuntime {
  if (!isAssistCell(base, landing.x, landing.y)) return INITIAL_ASSIST_RUNTIME
  const outside: Vec =
    edge === 'top'
      ? { x: landing.x, y: -1 }
      : edge === 'bottom'
        ? { x: landing.x, y: base.height }
        : edge === 'left'
          ? { x: -1, y: landing.y }
          : { x: base.width, y: landing.y }
  return { latch: null, lastFree: outside }
}

const OPPOSITE: Record<Edge, Edge> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/** 端リンクの到着位置とそのときの実行時状態 */
export interface EdgeArrival {
  pos: Vec
  runtime: AssistRuntime
}

/**
 * 端リンクで着く場所と実行時状態を決める。着地点は通行状態に関係なく常に assisted マスク（橙も歩ける）で探す
 * （通れない状態でも橙の階段の上に着き、橙を飛び越えて向こうの白に置かれない）。戻りリンク back が無い
 * 片道リンクでは、来た端（link.edge の反対側）を入ってきた端として扱う。歩ける点が無ければ null
 */
export function resolveEdgeArrival(args: {
  link: FieldLink
  back: FieldLink | null
  srcPos: Vec
  base: WalkMask
  assisted: WalkMask
  inset: number
}): EdgeArrival | null {
  const { link, back, srcPos, base, assisted, inset } = args
  const arrived = back ? arrivalPosition(link, srcPos, back, assisted, inset) : null
  const pos =
    arrived ??
    snapToWalkable(
      assisted,
      { x: assisted.width / 2, y: assisted.height / 2 },
      Math.max(assisted.width, assisted.height)
    )
  if (!pos) return null
  return { pos, runtime: arrivalRuntime(base, pos, back ? back.edge : OPPOSITE[link.edge]) }
}

/** 到着位置（ワープの at・開始位置）の計算に使うマスク。通れる状態なら橙も歩ける扱い */
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
