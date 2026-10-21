/**
 * 戦闘の演出（FF 式）の時間計算 (#745)。
 *
 * frontmatter `battle_presentation: dq|ff`（既定 dq＝現行の見た目・挙動）で有効化する。`ff` のとき `BattleScreen` が
 * 行動の記録（`BattleActionEvent`）を 1 件ずつ再生する: 行動する側が前へ出て斬って戻る → 対象がのけぞる →
 * ダメージ数字が跳ねて消える → HP 0 なら倒れる。
 *
 * このモジュールは純粋関数と定数だけを持つ（PixiJS・DOM に触れない）。再生中の状態（`PlaybackState`・
 * 浮いているダメージ数字）は `BattleScreen` が持ち、GameState には持たせない（ADR 0002）。BattleScreen を作り直しても
 * 状態は壊れない（作り直した画面はエンジンの確定状態から始まり、過去の記録は再生しない）。
 *
 * 距離はすべて「その枠の一辺」を 1 とする比（px は画面側が掛ける）。前後の向きも持たない:
 * `forward` は「相手陣営へ向かう」正の量、`recoil` は「相手陣営から離れる」正の量で、
 * 左右への写像（味方=右陣営は forward が -x、敵は +x）は画面側が決める。
 */
import type { BattleActionEvent, BattleHit, BattleHitKind } from './battleEngine'

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

export type BattlePresentation = 'dq' | 'ff'

/** frontmatter `battle_presentation` の値を正規化する。`'ff'` 以外（未指定・空・未知値含む）は `'dq'`（大小無視） */
export function normalizeBattlePresentation(raw: string | null | undefined): BattlePresentation {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'ff' ? 'ff' : 'dq'
}

// ---------------------------------------------------------------------------
// ポーズ（差し替え用スプライトの組）
// ---------------------------------------------------------------------------

// special（必殺技）は必殺技の配線時に足す。今はポーズ名として受け付けない
export const BATTLE_POSES = [
  'idle',
  'ready',
  'step',
  'slash',
  'cast',
  'hurt',
  'down',
  'victory',
] as const
export type BattlePose = (typeof BATTLE_POSES)[number]

/** ポーズ名 → 画像パス（部分指定可） */
export type BattlePoseSprites = Partial<Record<BattlePose, string>>

/**
 * マスタ定義の `poses`（キー=ポーズ名・値=画像パス）を正規化する。既知のポーズ名で値が空でないものだけを残し
 * （キーは小文字化・前後空白除去）、1 件もなければ undefined。
 */
export function normalizePoses(
  raw: Readonly<Record<string, string>> | null | undefined
): BattlePoseSprites | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: BattlePoseSprites = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim().toLowerCase()
    if (!(BATTLE_POSES as readonly string[]).includes(key)) continue
    if (typeof v !== 'string' || v.trim() === '') continue
    out[key as BattlePose] = v.trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** マスタ定義の `poses` を BattleEntity に写すときのスプレッド用。正規化して、無ければ何も足さない */
export function posesField(raw: Readonly<Record<string, string>> | null | undefined): {
  poses?: BattlePoseSprites
} {
  const poses = normalizePoses(raw)
  return poses ? { poses } : {}
}

/** ポーズごとの代替の優先順（指定が無いポーズは、近い絵に落とす） */
const POSE_FALLBACK: Record<BattlePose, readonly BattlePose[]> = {
  idle: ['idle'],
  ready: ['ready', 'idle'],
  step: ['step', 'ready', 'idle'],
  slash: ['slash', 'step', 'ready', 'idle'],
  cast: ['cast', 'ready', 'idle'],
  hurt: ['hurt', 'idle'],
  down: ['down'],
  victory: ['victory', 'idle'],
}

/**
 * 欲しいポーズに対して、持っている絵（available）から使うものを選ぶ。代替の優先順に最初に見つかったもの。
 * 1 つも無ければ null（呼び出し側は従来の 1 枚スプライトのまま）。`down` は代替なし（無ければ沈み込みで表す）。
 */
export function resolvePose<T>(
  pose: BattlePose,
  available: Readonly<Partial<Record<BattlePose, T>>>
): { pose: BattlePose; value: T } | null {
  for (const p of POSE_FALLBACK[pose]) {
    const v = available[p]
    if (v !== undefined) return { pose: p, value: v }
  }
  return null
}

// ---------------------------------------------------------------------------
// 時間定数（目視で調整する値）
// ---------------------------------------------------------------------------

/** 攻撃: 前へ踏み出す / 斬る / 戻る（ms） */
export const ATTACK_STEP_MS = 220
export const ATTACK_SLASH_MS = 180
export const ATTACK_RETURN_MS = 220
/** 斬りの開始から、命中（対象がのけぞり・数字が出る）までの ms */
export const ATTACK_SLASH_HIT_MS = 70
/** 呪文・アイテム: 構え（ready）の長さと、その開始から命中までの ms */
export const CAST_MS = 560
export const CAST_HIT_MS = 400
/**
 * 召喚獣の登場 (#750, `BattleActionEvent.summon` のある `skill`): 絵がフェードインする時間 / そのまま見せる時間 / フェードアウトする時間（ms）。
 * 暫定値（目視で調整する・未決）。効果の命中（ダメージ数字・のけぞり）は `SUMMON_HIT_MS` で、絵が出そろったあと。
 */
export const SUMMON_APPEAR_MS = 360
export const SUMMON_HOLD_MS = 820
export const SUMMON_LEAVE_MS = 420
/** 召喚獣の登場の長さ（開始から退場の終わりまで）。命中・のけぞりがこれより遅ければそちらまで待つ */
export const SUMMON_MS = SUMMON_APPEAR_MS + SUMMON_HOLD_MS + SUMMON_LEAVE_MS
/** 召喚の開始から、効果が命中する（数字が出る）までの ms */
export const SUMMON_HIT_MS = 600
/** 知らせ（行動が成立しなかった）の窓を出しておく長さ（ms）。絵は動かない */
export const NOTICE_MS = 700
/** 1 つの行動が終わってから次の行動を始めるまでの間（ms） */
export const ACTION_GAP_MS = 120
/** 台詞・知らせ (#741) を見せる時間: 基本 + 1 文字あたり。長い台詞でも上限で止める（ATB でも進行を止めない） */
export const LINE_BASE_MS = 600
export const LINE_PER_CHAR_MS = 55
export const LINE_MAX_MS = 3500
export function lineDurationMs(label: string | undefined): number {
  const n = typeof label === 'string' ? [...label].length : 0
  return Math.min(LINE_MAX_MS, LINE_BASE_MS + n * LINE_PER_CHAR_MS)
}

/** 状態異常の継続ダメージ・満了 (#870, `kind: 'status'`) の、命中までの ms。本人は動かず、窓に状態名が出てから数字が出る */
export const STATUS_HIT_MS = 200
/** 同上、行動 1 回の最短の長さ（命中・のけぞりが短くても、状態名と数字を読める時間） */
export const STATUS_MS = 500
/** 被ダメージ: のけぞって戻る時間 / 倒れ切るまでの時間（のけぞりの終わりから）（ms） */
export const RECOIL_MS = 260
export const DOWN_MS = 320

/** 踏み出しの距離（枠の一辺に対する比） */
export const ATTACK_STEP_DISTANCE = 0.7
/** のけぞりの最大距離（枠の一辺に対する比） */
export const RECOIL_DISTANCE = 0.12
/** 倒れる絵（down ポーズ）が無いときの沈み込み量（枠の一辺に対する比）。下向きが正 */
export const SINK_DISTANCE = 0.14

// ---------------------------------------------------------------------------
// イージング
// ---------------------------------------------------------------------------

export function clamp01(v: number): number {
  return !Number.isFinite(v) ? 0 : Math.min(1, Math.max(0, v))
}

export function easeOutQuad(u: number): number {
  const x = clamp01(u)
  return 1 - (1 - x) * (1 - x)
}

export function easeInOutQuad(u: number): number {
  const x = clamp01(u)
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
}

// ---------------------------------------------------------------------------
// 行動のタイムライン
// ---------------------------------------------------------------------------

export type ActionKind = BattleActionEvent['kind']

export interface ActionTimeline {
  /** 行動 1 回の長さ（次の行動までの間を含む） */
  duration: number
  /** 開始から命中までの ms */
  hitAt: number
  /** 複数ヒット (#879): round と次の round の間の ms（最大 round に応じた自動調整後。単発・少ヒットは MULTI_HIT_INTERVAL_MS） */
  hitInterval: number
}

/**
 * 複数ヒット (#879) の、ヒット（round）と次のヒットの間の基本 ms。暫定値（設計案は 90〜120ms。実機で詰める・未決）。
 * round 無し（単発）のイベントには掛からない。ヒットが多いときは下の自動調整で縮む。
 */
export const MULTI_HIT_INTERVAL_MS = 100

/**
 * 複数ヒットの 1 行動の総時間（最初の命中から最後の round の命中まで）の目安 ms。暫定・未決（おすすめ案の採用）。
 * 最大 round が TOTAL / MULTI_HIT_INTERVAL_MS（= 20）以下なら基本間隔のまま（従来と完全に同じ）。
 */
export const MULTI_HIT_TOTAL_MS = 2000

/**
 * 自動調整後の間隔の下限 ms。暫定・未決。MAX_HITS_PER_ACTION=99（最大 round 98）でも 2000/98 ≒ 20.4ms なので、
 * 現行の上限では効かない安全弁（上限を引き上げたとき、命中を 1 フレーム未満に詰めない）。
 */
export const MULTI_HIT_MIN_INTERVAL_MS = 10

/** 最大 round から、round 間の ms を決める: min(基本, 総時間 / 最大 round)。下限あり。最大 round 0 は基本値 */
export function multiHitIntervalFor(lastRound: number): number {
  if (!(lastRound > 0)) return MULTI_HIT_INTERVAL_MS
  return Math.max(
    MULTI_HIT_MIN_INTERVAL_MS,
    Math.min(MULTI_HIT_INTERVAL_MS, MULTI_HIT_TOTAL_MS / lastRound)
  )
}

/** ヒットの round（無ければ 0）。負・非有限・小数は 0 以上の整数に丸める */
export function hitRound(hit: BattleHit): number {
  const r = hit.round
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.floor(r) : 0
}

/** round の命中の瞬間（行動の開始からの ms）。round 0 は従来の hitAt そのまま */
export function hitTimeOf(
  baseHitAt: number,
  round: number,
  interval: number = MULTI_HIT_INTERVAL_MS
): number {
  return baseHitAt + round * interval
}

export function buildActionTimeline(
  kind: ActionKind,
  opts: {
    damages?: boolean
    downs?: boolean
    lastDamageRound?: number
    lastDownRound?: number
    /** 種別を問わない最大 round。この round の命中まで行動を終わらせない */
    lastRound?: number
    /** 召喚獣の登場 (#750)。`skill` のときだけ効き、登場の長さ・命中の瞬間が召喚用になる。無ければ従来と同じ */
    summon?: boolean
  } = {}
): ActionTimeline {
  if (kind === 'notice')
    return { duration: NOTICE_MS + ACTION_GAP_MS, hitAt: 0, hitInterval: MULTI_HIT_INTERVAL_MS }
  const summon = opts.summon === true && kind === 'skill'
  const motionEnd = summon
    ? SUMMON_MS
    : kind === 'attack'
      ? ATTACK_STEP_MS + ATTACK_SLASH_MS + ATTACK_RETURN_MS
      : kind === 'status'
        ? STATUS_MS
        : CAST_MS
  const hitAt = summon
    ? SUMMON_HIT_MS
    : kind === 'attack'
      ? ATTACK_STEP_MS + ATTACK_SLASH_HIT_MS
      : kind === 'status'
        ? STATUS_HIT_MS
        : CAST_HIT_MS
  // のけぞり・倒れが途中で切れないよう、受ける側の動きが終わるまで次の行動を待つ
  let end = motionEnd
  // 複数ヒットの間隔は最大 round で自動調整する（総時間が約 2 秒に収まる）
  const hitInterval = multiHitIntervalFor(
    Math.max(opts.lastRound ?? 0, opts.lastDamageRound ?? 0, opts.lastDownRound ?? 0)
  )
  // 複数ヒット (#879): のけぞり・倒れ切りは、最後のダメージ・倒れるヒットの round ぶん後ろにずれる（round 無しは 0 で従来と同じ）
  if (opts.damages)
    end = Math.max(end, hitTimeOf(hitAt, opts.lastDamageRound ?? 0, hitInterval) + RECOIL_MS)
  if (opts.downs)
    end = Math.max(
      end,
      hitTimeOf(hitAt, opts.lastDownRound ?? 0, hitInterval) + RECOIL_MS + DOWN_MS
    )
  // heal・miss だけの round も取りこぼさない（最大 round が 0 なら何もしない = 従来と同じ）
  if ((opts.lastRound ?? 0) > 0)
    end = Math.max(end, hitTimeOf(hitAt, opts.lastRound ?? 0, hitInterval))
  return { duration: end + ACTION_GAP_MS, hitAt, hitInterval }
}

/** 行動の記録から時間割を作る。HP が減る対象がいればのけぞり、HP 0 になる対象がいれば倒れ切るまで含める */
export function eventTimeline(event: BattleActionEvent): ActionTimeline {
  // 脚本制御の戦闘 (#741) の台詞・知らせは、字数に応じて読める長さだけ見せる（短い知らせの固定時間では読み切れない）。復活の回復数字は最初に出る
  if (event.kind === 'notice' && event.line) {
    return {
      duration: lineDurationMs(event.label) + ACTION_GAP_MS,
      hitAt: 0,
      hitInterval: MULTI_HIT_INTERVAL_MS,
    }
  }
  const damages = event.hits.some((h) => h.kind === 'damage')
  const downs = event.hits.some((h) => h.kind === 'damage' && h.hpAfter <= 0)
  let lastDamageRound = 0
  let lastDownRound = 0
  let lastRound = 0
  for (const h of event.hits) {
    lastRound = Math.max(lastRound, hitRound(h))
    if (h.kind !== 'damage') continue
    lastDamageRound = Math.max(lastDamageRound, hitRound(h))
    if (h.hpAfter <= 0) lastDownRound = Math.max(lastDownRound, hitRound(h))
  }
  return buildActionTimeline(event.kind, {
    damages,
    downs,
    lastDamageRound,
    lastDownRound,
    lastRound,
    ...(event.summon ? { summon: true } : {}),
  })
}

export interface SummonCueSample {
  /** 召喚獣の絵・名前の札の不透明度（0〜1） */
  alpha: number
  /** 想像の層のかぶせの強さ（0〜1）。想像でない召喚獣は画面がこれを使わない */
  veil: number
  /** 絵の上方向のずれ（枠の高さに対する比）。登場の間に 0 へ落ち着く */
  rise: number
}

/** 召喚獣の登場の、開始から t ms 時点の見え方 (#750)。フェードイン → そのまま → フェードアウト。範囲外・非有限は端の値に丸める */
export function sampleSummonCue(t: number): SummonCueSample {
  const time = Number.isFinite(t) ? Math.min(Math.max(0, t), SUMMON_MS) : 0
  if (time < SUMMON_APPEAR_MS) {
    const p = easeOutQuad(time / SUMMON_APPEAR_MS)
    return { alpha: p, veil: p, rise: 0.05 * (1 - p) }
  }
  const afterHold = time - SUMMON_APPEAR_MS - SUMMON_HOLD_MS
  if (afterHold <= 0) return { alpha: 1, veil: 1, rise: 0 }
  const p = 1 - Math.min(1, afterHold / SUMMON_LEAVE_MS)
  return { alpha: p, veil: p, rise: 0 }
}

export interface ActorSample {
  /** 相手陣営へ向かって出ている量（枠の一辺に対する比。0 以上） */
  forward: number
  pose: BattlePose
}

/** 行動する側の、開始から t ms 時点の位置とポーズ */
export function sampleActor(kind: ActionKind, t: number): ActorSample {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0
  if (kind === 'notice' || kind === 'status') return { forward: 0, pose: 'idle' }
  if (kind !== 'attack') {
    // 呪文の構えは cast、アイテムは ready（cast が無ければ ready、さらに idle に落ちる）
    return {
      forward: 0,
      pose: time < CAST_MS ? (kind === 'spell' || kind === 'skill' ? 'cast' : 'ready') : 'idle',
    }
  }
  if (time < ATTACK_STEP_MS) {
    return { forward: ATTACK_STEP_DISTANCE * easeOutQuad(time / ATTACK_STEP_MS), pose: 'step' }
  }
  const afterStep = time - ATTACK_STEP_MS
  if (afterStep < ATTACK_SLASH_MS) {
    return { forward: ATTACK_STEP_DISTANCE, pose: 'slash' }
  }
  const afterSlash = afterStep - ATTACK_SLASH_MS
  if (afterSlash < ATTACK_RETURN_MS) {
    return {
      forward: ATTACK_STEP_DISTANCE * (1 - easeInOutQuad(afterSlash / ATTACK_RETURN_MS)),
      pose: 'step',
    }
  }
  return { forward: 0, pose: 'idle' }
}

export interface TargetSample {
  /** 相手陣営から離れる向きののけぞり量（枠の一辺に対する比。0 以上） */
  recoil: number
  pose: BattlePose
  /** 倒れた進み具合（0=立っている〜1=倒れ切り）。1 のとき画面は down ポーズ、無ければ沈み込みで表す */
  downProgress: number
}

/** 立っている状態（何も起きていない） */
export const STANDING: TargetSample = { recoil: 0, pose: 'idle', downProgress: 0 }
/** 倒れ切った状態 */
export const FALLEN: TargetSample = { recoil: 0, pose: 'down', downProgress: 1 }

/**
 * 行動を受ける側の、命中から sinceHit ms 時点の姿。命中前（sinceHit < 0）は立っている。
 * damage のときだけ、短く後ろへ揺れて戻る（点滅はしない）。HP 0 になる（downs）なら、のけぞりのあと倒れる。
 * heal / miss は動かない。
 */
export function sampleTarget(kind: BattleHitKind, sinceHit: number, downs: boolean): TargetSample {
  if (kind !== 'damage' || !Number.isFinite(sinceHit) || sinceHit < 0) return STANDING
  const recoilU = clamp01(sinceHit / RECOIL_MS)
  const recoil = RECOIL_DISTANCE * Math.sin(Math.PI * recoilU)
  if (!downs) {
    return { recoil, pose: sinceHit < RECOIL_MS ? 'hurt' : 'idle', downProgress: 0 }
  }
  if (sinceHit < RECOIL_MS) return { recoil, pose: 'hurt', downProgress: 0 }
  return { recoil: 0, pose: 'down', downProgress: easeOutQuad((sinceHit - RECOIL_MS) / DOWN_MS) }
}

/** 何も再生していないときの姿: 戦闘に勝って生きている味方は victory、倒れていれば down、それ以外は idle */
export function restingSample(opts: { down: boolean; victory: boolean }): TargetSample {
  if (opts.down) return FALLEN
  return opts.victory ? { recoil: 0, pose: 'victory', downProgress: 0 } : STANDING
}

// ---------------------------------------------------------------------------
// 行動キューの再生（純粋な状態遷移）
// ---------------------------------------------------------------------------

export interface ActivePlayback {
  event: BattleActionEvent
  /** この行動の開始からの経過 ms */
  elapsed: number
  /** 命中の瞬間を処理済みの round の数（round の小さい順に数える。round 無しの行動は 0 か 1） (#879) */
  firedRounds: number
}

export interface PlaybackState {
  queue: readonly BattleActionEvent[]
  active: ActivePlayback | null
}

export function emptyPlayback(): PlaybackState {
  return { queue: [], active: null }
}

export function enqueueEvents(
  pb: PlaybackState,
  events: readonly BattleActionEvent[]
): PlaybackState {
  return events.length === 0 ? pb : { queue: [...pb.queue, ...events], active: pb.active }
}

/** 再生すべきものが残っているか（演出が終わるまで次の行動・入力を待たせる判定に使う） */
export function isPlaybackBusy(pb: PlaybackState): boolean {
  return pb.active !== null || pb.queue.length > 0
}

/** 命中の瞬間に起きた出来事。画面はこれを受けて HP 表示・ダメージ数字を出す */
export interface HitFire {
  event: BattleActionEvent
  /** この瞬間に命中する hits（その round のぶんだけ。round 無しの行動は全 hits） (#879) */
  hits: readonly BattleHit[]
  /** 何発目か（round。round 無しは 0） */
  round: number
  /** 命中の瞬間から、今回の進行の終わりまでの ms（数字の出始めを時間ぶんだけ進める） */
  sinceHit: number
}

/** イベントの hits を round ごとにまとめる（round の小さい順。同じ round 内は配列順）。hits が空なら round 0 の空の組 1 つ */
export function groupHitsByRound(event: BattleActionEvent): { round: number; hits: BattleHit[] }[] {
  if (event.hits.length === 0) return [{ round: 0, hits: [] }]
  const map = new Map<number, BattleHit[]>()
  for (const h of event.hits) {
    const r = hitRound(h)
    const list = map.get(r)
    if (list) list.push(h)
    else map.set(r, [h])
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([round, hits]) => ({ round, hits }))
}

/** 暴走防止: 1 回の進行で処理する行動の上限 */
const MAX_ADVANCE_STEPS = 200

/**
 * 再生を dt ms 進める。行動の終わりをまたぐ分は次の行動へ繰り越す。命中の瞬間をまたいだ行動は fires に入れる。
 * dt が負・非有限なら何もしない。
 */
export function advancePlayback(
  pb: PlaybackState,
  dt: number
): { state: PlaybackState; fires: HitFire[] } {
  if (!Number.isFinite(dt) || dt <= 0) return { state: pb, fires: [] }
  let queue = pb.queue
  let active: ActivePlayback | null = pb.active ? { ...pb.active } : null
  const fires: HitFire[] = []
  let rest = dt
  for (let guard = 0; guard < MAX_ADVANCE_STEPS && rest > 0; guard++) {
    if (!active) {
      const next = queue[0]
      if (!next) break
      queue = queue.slice(1)
      active = { event: next, elapsed: 0, firedRounds: 0 }
    }
    const tl = eventTimeline(active.event)
    const step = Math.min(rest, tl.duration - active.elapsed)
    active.elapsed += step
    rest -= step
    const groups = groupHitsByRound(active.event)
    while (active.firedRounds < groups.length) {
      const g = groups[active.firedRounds]
      const at = hitTimeOf(tl.hitAt, g.round, tl.hitInterval)
      if (active.elapsed < at) break
      active.firedRounds += 1
      fires.push({
        event: active.event,
        hits: g.hits,
        round: g.round,
        sinceHit: active.elapsed - at,
      })
    }
    if (active.elapsed >= tl.duration) active = null
  }
  return { state: { queue, active }, fires }
}

// ---------------------------------------------------------------------------
// ダメージ数字のポップアップ
// ---------------------------------------------------------------------------

/** 数字の跳ね（FF5 風）: 上へ跳ねて落ち、小さく 1 回はねて止まり、少し留まってフェードアウトする */
export const POPUP_ARC1_MS = 260
export const POPUP_ARC1_HEIGHT = 0.3
export const POPUP_ARC2_MS = 160
export const POPUP_ARC2_HEIGHT = 0.09
export const POPUP_HOLD_MS = 240
export const POPUP_FADE_MS = 200
export const POPUP_TOTAL_MS = POPUP_ARC1_MS + POPUP_ARC2_MS + POPUP_HOLD_MS + POPUP_FADE_MS

export interface PopupSample {
  /** 置き位置からの縦のずれ（枠の一辺に対する比。上が負） */
  dy: number
  alpha: number
  done: boolean
}

export function sampleDamagePopup(elapsed: number): PopupSample {
  const t = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  if (t >= POPUP_TOTAL_MS) return { dy: 0, alpha: 0, done: true }
  // `+ 0` で -0 を 0 に揃える
  const arc = (u: number, h: number) => -4 * h * u * (1 - u) + 0
  if (t < POPUP_ARC1_MS)
    return { dy: arc(t / POPUP_ARC1_MS, POPUP_ARC1_HEIGHT), alpha: 1, done: false }
  const t2 = t - POPUP_ARC1_MS
  if (t2 < POPUP_ARC2_MS)
    return { dy: arc(t2 / POPUP_ARC2_MS, POPUP_ARC2_HEIGHT), alpha: 1, done: false }
  const t3 = t2 - POPUP_ARC2_MS
  if (t3 < POPUP_HOLD_MS) return { dy: 0, alpha: 1, done: false }
  return { dy: 0, alpha: 1 - clamp01((t3 - POPUP_HOLD_MS) / POPUP_FADE_MS), done: false }
}

/** ダメージ白・回復緑・ミスは薄い灰（FF5 の色分けに倣う） */
export const POPUP_COLORS: Record<BattleHitKind, number> = {
  damage: 0xffffff,
  heal: 0x66ff66,
  miss: 0xcccccc,
}

export function popupText(hit: Pick<BattleHit, 'kind' | 'amount'>): string {
  return hit.kind === 'miss' ? 'MISS' : String(Math.max(0, Math.round(hit.amount)))
}

/** 同じ対象への連続ヒット (#879) の数字を縦にずらす段数の上限（超えたら最下段へ戻る）と、1 段のずれ（数字の高さに対する比） */
export const POPUP_STACK_LEVELS = 5
export const POPUP_STACK_STEP = 0.85
/** 同じイベント内で、同じ対象への何番目のヒットか（0 始まり）。段にして縦にずらす。単発（同じ対象に 1 回）は常に 0 */
export function popupStackIndex(hits: readonly BattleHit[], hit: BattleHit): number {
  let n = 0
  for (const h of hits) {
    if (h === hit) break
    if (h.target.side === hit.target.side && h.target.index === hit.target.index) n += 1
  }
  return n % POPUP_STACK_LEVELS
}

/** 数字のフォントサイズ（px）。枠の一辺の 0.35 倍（FF らしく読みやすい大きさ）。小さすぎ・大きすぎは抑える */
export const POPUP_FONT_RATIO = 0.35
export const POPUP_FONT_MIN = 20
export const POPUP_FONT_MAX = 56
export function popupFontSize(unit: number): number {
  const v = Number.isFinite(unit) ? Math.round(unit * POPUP_FONT_RATIO) : 0
  return Math.min(POPUP_FONT_MAX, Math.max(POPUP_FONT_MIN, v))
}

/** ダメージ数字が基準のフォントのまま収まる文字数。ダメージ上限 9999 (#877) の 4 桁ぶん */
export const POPUP_FULL_SIZE_CHARS = 4
/**
 * 数字のフォントサイズを文字数に応じて縮める (#877)。4 文字以下（ダメージ上限 9999 まで・MISS）は `baseFont` のまま、
 * 5 文字以上（回復・吸収の 5 桁以上）は 4 文字の幅に収まるよう比例で縮め、枠の外・画面の外へはみ出さないようにする。
 * 下限 1px は 0 や負を防ぐだけで、読める保証ではない（縁取りが 4px 固定なので小さい文字ほど縁取りの割合が増える。
 * 基準 20px で 7 桁なら 11px、8 桁なら 10px）。
 */
export function fitPopupFontSize(text: string, baseFont: number): number {
  const len = [...text].length
  if (len <= POPUP_FULL_SIZE_CHARS) return baseFont
  return Math.max(1, Math.floor((baseFont * POPUP_FULL_SIZE_CHARS) / len))
}

/**
 * 縮小した数字 (#877) を、基本サイズの 1 段の中で上下中央に置くための持ち上げ量（px）。数字は文字の箱の下端に揃えるが、
 * 箱の下端と字の下端の距離はフォントに比例するので、小さい字をそのまま置くと字の下端が基本サイズより下へ寄り、
 * 上の段（小さい字）が下の段へ深く食い込む。(基本 − 実際) の半分だけ上げれば縮んだ字は段の中央に収まる。
 * 縮んでいない（4 文字以下）ときは 0 で、位置は従来（#879）と完全に同じ。
 */
export function popupCenterOffset(baseFont: number, fontSize: number): number {
  return Math.max(0, baseFont - fontSize) * 0.5
}

// ---------------------------------------------------------------------------
// FF 式メッセージ窓
// ---------------------------------------------------------------------------

/** 窓に出す言葉。技・呪文・アイテムの名前だけを、そのまま（1 文字ずつにせず）出す。空なら null（窓は出さない） */
export function messageWindowText(label: string | undefined): string | null {
  const t = typeof label === 'string' ? label.trim() : ''
  return t === '' ? null : t
}

// ---------------------------------------------------------------------------
// 画面端での頭打ち
// ---------------------------------------------------------------------------

/** 動いても枠（板・台座を含む）を画面の端からこれ以上離す余白（px） */
export const MOTION_SCREEN_MARGIN = 8
/** 枠の左右に足す、板・台座のはみ出し分（枠の一辺に対する比） */
export const MOTION_EXTENT_PAD = 0.1

/**
 * 横のずれ dx を、動いた後の枠が [minX, maxX]（画面端から余白を引いた範囲）に収まるように止める。
 * left / right は動く前の枠の左右端（板・台座を含めた値）。動かさない状態（dx=0）は常に許す: 最初から範囲の外にある枠を
 * 引き戻しはしない（それ以上外へ動くのだけを止める）。範囲より広い枠は動かさない。
 * のけぞり・踏み出しの両方に使う（右端の味方が右へ、敵が左端を越えて見切れないように）。
 */
export function clampMotionDx(
  dx: number,
  left: number,
  right: number,
  minX: number,
  maxX: number
): number {
  if (![dx, left, right, minX, maxX].every(Number.isFinite)) return 0
  const lo = Math.min(0, minX - left)
  const hi = Math.max(0, maxX - right)
  return Math.min(hi, Math.max(lo, dx))
}
