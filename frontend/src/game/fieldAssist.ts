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
  /** 端リンクで着いたときの場の種にする、来た端からの帯の幅（背景ピクセル。edgeThreshold を渡す。既定 1） */
  edgeBand?: number
}

export interface AssistFrame {
  /** 移動に使うマスク */
  walkMask: WalkMask
  /**
   * ラッチ中に通行が止まった間の、入口からの経路距離の場。非 null のあいだ、動いたあとの場の値が
   * 動く前より小さくならないセルまたぎの移動は通さない（limitRetreat）。入口へ向かう側へは動けるが、前へは進めない
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
 *   進める（retreatField と limitRetreat）。セルをまたぐ移動は経路距離が真に減るときだけ通す。保証するのは、
 *   渡り切れない（橙が折り返していても向こう側の白へ抜けない）ことと、入口へ向かう経路に沿って必ず動けること。
 *   入口と逆向きの入力は、経路が折り返す場所では動けないことがある（その向きには進めない）
 */
export function stepAssistFrame(input: AssistFrameInput): AssistFrame {
  const { base, assisted, pos, vec, state, runtime, edgeBand } = input
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
    latch = { ...latch, field: buildDistanceField(assisted, latch.entry, edgeBand) }
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
 * 外（端リンクで着いたときの来た端の外側）なら、その端から band 幅の帯の歩けるセルすべてを種にする
 * （端からの深さ＝初期値。橙が端から数 px 手前で止まり黒い縁があっても、橙が種を持てる）。
 *
 * 辿るのは橙と、入口側の白（種の白から橙を通らずにたどれる白）だけ。橙の向こうにだけつながる白は
 * 場に入れない（Infinity。橙の外の白を近道にして、拒否中に向こう側へ出られないようにする）
 */
export function buildDistanceField(mask: WalkMask, entry: Vec, band = 1): DistanceField {
  const { width, height, walkable, assist } = mask
  const dist = new Int32Array(width * height).fill(-1)
  const isOrange = (i: number): boolean => assist !== undefined && assist[i] === 1
  const ok = (i: number): boolean => walkable[i] === 1 || isOrange(i)
  const seeds: { i: number; d: number }[] = []
  const addSeed = (x: number, y: number, d: number): void => {
    const i = y * width + x
    if (ok(i)) seeds.push({ i, d })
  }
  const depthMax = (n: number): number => Math.max(1, Math.min(n, Math.ceil(band)))
  if (entry.y < 0) {
    for (let d = 0; d < depthMax(height); d++) for (let x = 0; x < width; x++) addSeed(x, d, d)
  } else if (entry.y >= height) {
    for (let d = 0; d < depthMax(height); d++)
      for (let x = 0; x < width; x++) addSeed(x, height - 1 - d, d)
  } else if (entry.x < 0) {
    for (let d = 0; d < depthMax(width); d++) for (let y = 0; y < height; y++) addSeed(d, y, d)
  } else if (entry.x >= width) {
    for (let d = 0; d < depthMax(width); d++)
      for (let y = 0; y < height; y++) addSeed(width - 1 - d, y, d)
  } else {
    addSeed(Math.floor(entry.x), Math.floor(entry.y), 0)
  }
  const neighbors = (i: number, visit: (j: number) => void): void => {
    const x = i % width
    const y = (i - x) / width
    if (x > 0) visit(i - 1)
    if (x < width - 1) visit(i + 1)
    if (y > 0) visit(i - width)
    if (y < height - 1) visit(i + width)
  }
  // 入口側の白: 種の白から、白だけを辿ってたどれるセル
  const entryWhite = new Uint8Array(width * height)
  const wq: number[] = []
  const isWhite = (i: number): boolean => walkable[i] === 1 && !isOrange(i)
  for (const s of seeds)
    if (isWhite(s.i) && !entryWhite[s.i]) {
      entryWhite[s.i] = 1
      wq.push(s.i)
    }
  for (let h = 0; h < wq.length; h++)
    neighbors(wq[h], (j) => {
      if (isWhite(j) && !entryWhite[j]) {
        entryWhite[j] = 1
        wq.push(j)
      }
    })
  const allowed = (i: number): boolean => isOrange(i) || entryWhite[i] === 1
  // 種（深さ順）と幅優先の待ち行列は、どちらも距離の昇順。小さい方から取り出して展開する
  for (const s of seeds) dist[s.i] = s.d // 先に全部の種へ値を入れる（幅優先の展開が、種のセルをより大きい値で塗らないように）
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0
  let sp = 0
  const expand = (i: number): void => {
    const d = dist[i] + 1
    neighbors(i, (j) => {
      if (dist[j] === -1 && allowed(j)) {
        dist[j] = d
        queue[tail++] = j
      }
    })
  }
  while (head < tail || sp < seeds.length) {
    if (sp < seeds.length && (head >= tail || seeds[sp].d <= dist[queue[head]])) {
      expand(seeds[sp++].i)
    } else {
      expand(queue[head++])
    }
  }
  return { width, height, dist }
}

/** 場の値。マスクの外・入口から辿れないセルは Infinity */
export function fieldAt(field: DistanceField, p: Vec): number {
  const x = Math.floor(p.x)
  const y = Math.floor(p.y)
  if (x < 0 || y < 0 || x >= field.width || y >= field.height) return Infinity
  const d = field.dist[y * field.width + x]
  return d < 0 ? Infinity : d
}

/**
 * 戻る動きだけを通す。同じセルの中の動きは通し、セルをまたぐ移動は、場の値（入口からの経路距離）が
 * 動く前より**真に減る**ときだけ通す。値が等しい移動（入口の列へ寄る 1px ＋前へ 1px の斜め移動など）を
 * 通すと、横にずれた分だけ前へ登れてしまうため。斜めの移動が通らなければ、x だけ・y だけの動きに
 * 分けて通れる方を通す（壁に沿った滑りで前向きの成分だけが通るのも、ここで止まる）。
 * 場の値は（セルをまたぐたびに）減るだけなので、橙が折り返していても入口側の連結な経路の外へは出られない。
 * 動く前の場所が場の外（入口から辿れない）なら判定できないので、そのまま通す
 */
export function limitRetreat(field: DistanceField, prev: Vec, moved: MoveResult): MoveResult {
  const before = fieldAt(field, prev)
  if (!Number.isFinite(before)) return moved
  const sameCell = (p: Vec): boolean =>
    Math.floor(p.x) === Math.floor(prev.x) && Math.floor(p.y) === Math.floor(prev.y)
  const allowed = (p: Vec): boolean => sameCell(p) || fieldAt(field, p) < before
  if (allowed(moved.pos)) return moved
  const xOnly: Vec = { x: moved.pos.x, y: prev.y }
  if (xOnly.x !== prev.x && allowed(xOnly))
    return { pos: xOnly, distance: Math.abs(xOnly.x - prev.x) }
  const yOnly: Vec = { x: prev.x, y: moved.pos.y }
  if (yOnly.y !== prev.y && allowed(yOnly))
    return { pos: yOnly, distance: Math.abs(yOnly.y - prev.y) }
  return { pos: prev, distance: 0 }
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

/** 端リンクの到着位置とそのときの実行時状態 */
export interface EdgeArrival {
  pos: Vec
  runtime: AssistRuntime
}

/**
 * 端リンクで着く場所と実行時状態を決める。戻りリンク back があれば、その range に写した点を assisted マスク
 * （橙も歩ける）で探す（通れない状態でも橙の階段の上に着き、橙を飛び越えて向こうの白に置かれない）。
 * 橙の上に着いたら、来た端を「入ってきた場所」にする。ただし通れない状態で、着地点が来た端から辿れない
 * （場の値が Infinity。橙が端から離れて黒い縁がある・端につながっていない）ときは、来た端に意味が無いので、
 * 橙を除いたマスクで探し直す。
 * 戻りリンクの無い片道リンクは「来た端」の位置が決まらないので、画面中心の近くを arrivalMask（通れる状態なら橙込み）
 * で探し、橙に着いたら入ってきた場所は無し（ワープの at と同じ扱い）にする。歩ける点が無ければ null
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
  /** 場の種にする来た端からの帯の幅（edgeThreshold）。既定 1 */
  edgeBand?: number
}): EdgeArrival | null {
  const { link, back, srcPos, base, assisted, inset, passable, edgeBand } = args
  const center = (m: WalkMask): Vec | null =>
    snapToWalkable(m, { x: m.width / 2, y: m.height / 2 }, Math.max(m.width, m.height))
  if (!back) {
    const pos = center(arrivalMask(base, assisted, passable))
    if (!pos) return null
    const onOrange = isAssistCell(base, pos.x, pos.y)
    return { pos, runtime: onOrange ? { latch: null, lastFree: null } : INITIAL_ASSIST_RUNTIME }
  }
  const pos = arrivalPosition(link, srcPos, back, assisted, inset)
  if (pos) {
    const runtime = arrivalRuntime(base, pos, back.edge)
    const entry = runtime.lastFree
    const unreachable =
      !passable &&
      entry !== null &&
      !Number.isFinite(fieldAt(buildDistanceField(assisted, entry, edgeBand), pos))
    if (!unreachable) return { pos, runtime }
  }
  // 通れない状態で来た端から辿れない橙に着いた（または橙込みでは歩ける点が無い）: 橙を除いて探し直す
  const plain = arrivalPosition(link, srcPos, back, base, inset) ?? center(base)
  return plain ? { pos: plain, runtime: INITIAL_ASSIST_RUNTIME } : null
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
