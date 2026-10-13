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
/** 知らせ（行動が成立しなかった）の窓を出しておく長さ（ms）。絵は動かない */
export const NOTICE_MS = 700
/** 1 つの行動が終わってから次の行動を始めるまでの間（ms） */
export const ACTION_GAP_MS = 120
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
}

export function buildActionTimeline(
  kind: ActionKind,
  opts: { damages?: boolean; downs?: boolean } = {}
): ActionTimeline {
  if (kind === 'notice') return { duration: NOTICE_MS + ACTION_GAP_MS, hitAt: 0 }
  const motionEnd =
    kind === 'attack' ? ATTACK_STEP_MS + ATTACK_SLASH_MS + ATTACK_RETURN_MS : CAST_MS
  const hitAt = kind === 'attack' ? ATTACK_STEP_MS + ATTACK_SLASH_HIT_MS : CAST_HIT_MS
  // のけぞり・倒れが途中で切れないよう、受ける側の動きが終わるまで次の行動を待つ
  let end = motionEnd
  if (opts.damages) end = Math.max(end, hitAt + RECOIL_MS)
  if (opts.downs) end = Math.max(end, hitAt + RECOIL_MS + DOWN_MS)
  return { duration: end + ACTION_GAP_MS, hitAt }
}

/** 行動の記録から時間割を作る。HP が減る対象がいればのけぞり、HP 0 になる対象がいれば倒れ切るまで含める */
export function eventTimeline(event: BattleActionEvent): ActionTimeline {
  const damages = event.hits.some((h) => h.kind === 'damage')
  const downs = event.hits.some((h) => h.kind === 'damage' && h.hpAfter <= 0)
  return buildActionTimeline(event.kind, { damages, downs })
}

export interface ActorSample {
  /** 相手陣営へ向かって出ている量（枠の一辺に対する比。0 以上） */
  forward: number
  pose: BattlePose
}

/** 行動する側の、開始から t ms 時点の位置とポーズ */
export function sampleActor(kind: ActionKind, t: number): ActorSample {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0
  if (kind === 'notice') return { forward: 0, pose: 'idle' }
  if (kind !== 'attack') {
    // 呪文の構えは cast、アイテムは ready（cast が無ければ ready、さらに idle に落ちる）
    return { forward: 0, pose: time < CAST_MS ? (kind === 'spell' ? 'cast' : 'ready') : 'idle' }
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
  /** 命中の瞬間を処理済みか */
  hitFired: boolean
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
  /** 命中の瞬間から、今回の進行の終わりまでの ms（数字の出始めを時間ぶんだけ進める） */
  sinceHit: number
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
      active = { event: next, elapsed: 0, hitFired: false }
    }
    const tl = eventTimeline(active.event)
    const step = Math.min(rest, tl.duration - active.elapsed)
    active.elapsed += step
    rest -= step
    if (!active.hitFired && active.elapsed >= tl.hitAt) {
      active.hitFired = true
      fires.push({ event: active.event, sinceHit: active.elapsed - tl.hitAt })
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

/** 数字のフォントサイズ（px）。枠の一辺に比例させ、小さすぎ・大きすぎを抑える */
export function popupFontSize(unit: number): number {
  const v = Number.isFinite(unit) ? Math.round(unit * 0.24) : 0
  return Math.min(30, Math.max(16, v))
}

// ---------------------------------------------------------------------------
// FF 式メッセージ窓
// ---------------------------------------------------------------------------

/** 窓に出す言葉。技・呪文・アイテムの名前だけを、そのまま（1 文字ずつにせず）出す。空なら null（窓は出さない） */
export function messageWindowText(label: string | undefined): string | null {
  const t = typeof label === 'string' ? label.trim() : ''
  return t === '' ? null : t
}
