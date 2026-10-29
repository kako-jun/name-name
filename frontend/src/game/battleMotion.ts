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
 * 敵の通常攻撃だけは、被弾モザイク（hitMosaicMs > 0 かつ hitMosaicMaxSize >= 2）が有効なとき踏み出さず自己モザイクで知らせる（BattleScreen が決める。無効なら従来どおり踏み出す）。
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
// 時間定数（目視で調整する値）と、プリセット (#956)
// ---------------------------------------------------------------------------

/**
 * 戦闘モーションの時間・距離の組 (#956)。frontmatter `battle_motion: default | snappy` で選ぶ。
 * 純粋関数（`sampleActor` / `buildActionTimeline` / `eventTimeline` / `sampleTarget` / `sampleDamagePopup` ほか）は
 * 最後の引数で受け取り、省略すると `DEFAULT_MOTION_TIMING`（現行値）。時間は ms、距離は枠の一辺に対する比。
 */
export interface MotionTiming {
  /** 攻撃: 前へ踏み出す / 斬る / 戻る（ms） */
  attackStepMs: number
  attackSlashMs: number
  attackReturnMs: number
  /** 戻りのイージング（default は easeInOutQuad、snappy は easeOutQuad で出だしを速く） */
  attackReturnEase: 'inOutQuad' | 'outQuad'
  /** 斬りの開始から、命中（対象がのけぞり・数字が出る）までの ms */
  attackSlashHitMs: number
  /** 踏み出しの距離 */
  attackStepDistance: number
  /** 呪文・アイテム: 構え（ready）の長さと、その開始から命中までの ms */
  castMs: number
  castHitMs: number
  /** 召喚獣の登場 (#750): フェードイン / 保持 / フェードアウト（ms）と、開始から命中までの ms */
  summonAppearMs: number
  summonHoldMs: number
  summonLeaveMs: number
  summonHitMs: number
  /** 知らせ（行動が成立しなかった）の窓を出しておく長さ（ms） */
  noticeMs: number
  /** 1 つの行動が終わってから次の行動を始めるまでの間（ms） */
  actionGapMs: number
  /** 状態異常 (#870): 命中までの ms / 行動 1 回の最短の長さ */
  statusHitMs: number
  statusMs: number
  /** 被ダメージ: のけぞって戻る時間 / 倒れ切るまでの時間（のけぞりの終わりから）（ms） */
  recoilMs: number
  downMs: number
  /** のけぞりの最大距離 */
  recoilDistance: number
  /** 複数ヒット (#879): 基本の round 間隔 / 総時間の目安 / 間隔の下限（ms） */
  multiHitIntervalMs: number
  multiHitTotalMs: number
  multiHitMinIntervalMs: number
  /** ダメージ数字の跳ね: 1 回目の跳ね（ms・高さ）/ 2 回目 / 留まる / フェードアウト */
  popupArc1Ms: number
  popupArc1Height: number
  popupArc2Ms: number
  popupArc2Height: number
  popupHoldMs: number
  popupFadeMs: number
  /** ダメージ数字を 1 桁ずつ時間差で跳ねさせるときの、桁ごとの開始遅れ（ms）。0 は数字全体を 1 つで跳ねさせる（従来） (#955) */
  digitStaggerMs: number
  /** 敵→味方の被弾で、被弾した味方がほわっとモザイク状に粗くなって戻る時間（ms）と最大の粗さ（PixelateFilter.size）。0 は出さない（従来） (#953)。敵の通常攻撃では、攻撃した敵自身にも同じ値で自己モザイクを出し（miss でも）、そのとき敵は踏み出さず攻撃ポーズにも替えない (sit-by-me #63/#64)。0 のときは従来どおり敵も踏み出す */
  hitMosaicMs: number
  hitMosaicMaxSize: number
}

/** 現行の値（挙動不変の基準）。既存テストはこれで全通しする */
export const DEFAULT_MOTION_TIMING: MotionTiming = {
  attackStepMs: 220,
  attackSlashMs: 180,
  attackReturnMs: 220,
  attackReturnEase: 'inOutQuad',
  attackSlashHitMs: 70,
  attackStepDistance: 0.7,
  castMs: 560,
  castHitMs: 400,
  // 召喚は暫定値（目視で調整する・未決）。効果の命中は絵が出そろったあと
  summonAppearMs: 360,
  summonHoldMs: 820,
  summonLeaveMs: 420,
  summonHitMs: 600,
  noticeMs: 700,
  actionGapMs: 120,
  statusHitMs: 200,
  statusMs: 500,
  recoilMs: 260,
  downMs: 320,
  recoilDistance: 0.12,
  // 複数ヒットは暫定値（設計案は 90〜120ms。実機で詰める・未決）。最大 round が total/interval（=20）以下なら基本間隔のまま
  multiHitIntervalMs: 100,
  multiHitTotalMs: 2000,
  multiHitMinIntervalMs: 10,
  popupArc1Ms: 260,
  popupArc1Height: 0.3,
  popupArc2Ms: 160,
  popupArc2Height: 0.09,
  popupHoldMs: 240,
  popupFadeMs: 200,
  digitStaggerMs: 0,
  hitMosaicMs: 0,
  hitMosaicMaxSize: 16,
}

/**
 * キビキビ版（暫定・#956。#803 の実作品の測定後に ff5/ff6 などの名前付きプリセットへ置き換える）。
 * - 踏み出し・戻りを 130ms（default の 220ms から。目標 120〜150ms）、斬り 120ms。戻りは easeOutQuad で出だしから速く戻す
 * - 命中を早め（斬り開始 50ms）、行動間を 120→40ms に詰めてテンポを上げる
 * - 距離は少し下げる（踏み出し 0.7→0.55、のけぞり 0.12→0.10）。動きが短いぶん、大きいと「ひゅっ」と飛んで見えるため
 * - のけぞり・倒れ・ダメージ数字・呪文・複数ヒットは default の約 0.75 倍の長さに揃える（動きだけ速く数字が遅いと間延びするため）
 * - ダメージ・回復の数字は 1 桁ずつ 50ms 差で跳ねさせる (#955)。FF の「ぱらぱらと着地する」リズムを出すため（桁数が多くても合計 150ms まで）
 * - 敵の通常攻撃では、攻撃した敵自身にも同じ 260ms・最大 16 の自己モザイクを出し、敵は踏み出さず攻撃ポーズにも替えない (sit-by-me #63/#64)
 * - 被弾した味方に 260ms のほわっとモザイク (#953)。山の長さは `min(260ms, 行動の残り)`（のけぞり 200ms + 行動間 40ms で行動は命中から約 240ms 後に終わるので、実際は約 240ms 以内に等倍へ戻り切る。行動の長さは変えない）。最大 16 は絵の切り替えモザイク（24）より控えめ（キャラが読めなくならないよう。等倍(1)→最大→等倍の山でスワップなし）。連続ヒットは各ヒットの山の包絡で繋ぐ。default は 0（出さない）
 */
export const SNAPPY_MOTION_TIMING: MotionTiming = {
  attackStepMs: 130,
  attackSlashMs: 120,
  attackReturnMs: 130,
  attackReturnEase: 'outQuad',
  attackSlashHitMs: 50,
  attackStepDistance: 0.55,
  castMs: 420,
  castHitMs: 300,
  summonAppearMs: 270,
  summonHoldMs: 620,
  summonLeaveMs: 320,
  summonHitMs: 450,
  noticeMs: 520,
  actionGapMs: 40,
  statusHitMs: 150,
  statusMs: 380,
  recoilMs: 200,
  downMs: 240,
  recoilDistance: 0.1,
  multiHitIntervalMs: 75,
  multiHitTotalMs: 1500,
  multiHitMinIntervalMs: 10,
  popupArc1Ms: 200,
  popupArc1Height: 0.26,
  popupArc2Ms: 120,
  popupArc2Height: 0.08,
  popupHoldMs: 180,
  popupFadeMs: 150,
  digitStaggerMs: 50,
  hitMosaicMs: 260,
  hitMosaicMaxSize: 16,
}

export type BattleMotionPreset = 'default' | 'snappy'

export const BATTLE_MOTION_PRESETS: Readonly<Record<BattleMotionPreset, MotionTiming>> = {
  default: DEFAULT_MOTION_TIMING,
  snappy: SNAPPY_MOTION_TIMING,
}

/**
 * frontmatter `battle_motion` の値を正規化する。未指定・空は `default`（黙って）。`default` / `snappy`（大小・前後空白は無視）以外は
 * 警告して `default` にフォールバックする。
 */
export function normalizeBattleMotion(raw: string | null | undefined): BattleMotionPreset {
  if (typeof raw !== 'string' || raw.trim() === '') return 'default'
  const v = raw.trim().toLowerCase()
  if (v === 'default' || v === 'snappy') return v
  console.warn(`battle_motion '${raw}' は default / snappy のどちらでもないため default にした`)
  return 'default'
}

/** プリセット名から時間の組を引く */
export function motionTimingFor(preset: BattleMotionPreset | undefined): MotionTiming {
  return preset ? BATTLE_MOTION_PRESETS[preset] : DEFAULT_MOTION_TIMING
}

// 以下は default（現行値）の個別定数。既存の呼び出し・テスト用に残す（値は DEFAULT_MOTION_TIMING が正本）
export const ATTACK_STEP_MS = DEFAULT_MOTION_TIMING.attackStepMs
export const ATTACK_SLASH_MS = DEFAULT_MOTION_TIMING.attackSlashMs
export const ATTACK_RETURN_MS = DEFAULT_MOTION_TIMING.attackReturnMs
export const ATTACK_SLASH_HIT_MS = DEFAULT_MOTION_TIMING.attackSlashHitMs
export const CAST_MS = DEFAULT_MOTION_TIMING.castMs
export const CAST_HIT_MS = DEFAULT_MOTION_TIMING.castHitMs
export const SUMMON_APPEAR_MS = DEFAULT_MOTION_TIMING.summonAppearMs
export const SUMMON_HOLD_MS = DEFAULT_MOTION_TIMING.summonHoldMs
export const SUMMON_LEAVE_MS = DEFAULT_MOTION_TIMING.summonLeaveMs
/** 召喚獣の登場の長さ（開始から退場の終わりまで）。命中・のけぞりがこれより遅ければそちらまで待つ */
export const SUMMON_MS = SUMMON_APPEAR_MS + SUMMON_HOLD_MS + SUMMON_LEAVE_MS
export const SUMMON_HIT_MS = DEFAULT_MOTION_TIMING.summonHitMs
export const NOTICE_MS = DEFAULT_MOTION_TIMING.noticeMs
export const ACTION_GAP_MS = DEFAULT_MOTION_TIMING.actionGapMs
export const STATUS_HIT_MS = DEFAULT_MOTION_TIMING.statusHitMs
export const STATUS_MS = DEFAULT_MOTION_TIMING.statusMs
export const RECOIL_MS = DEFAULT_MOTION_TIMING.recoilMs
export const DOWN_MS = DEFAULT_MOTION_TIMING.downMs
export const ATTACK_STEP_DISTANCE = DEFAULT_MOTION_TIMING.attackStepDistance
export const RECOIL_DISTANCE = DEFAULT_MOTION_TIMING.recoilDistance

/** 台詞・知らせ (#741) を見せる時間: 基本 + 1 文字あたり。長い台詞でも上限で止める（ATB でも進行を止めない）。プリセットでは変えない */
export const LINE_BASE_MS = 600
export const LINE_PER_CHAR_MS = 55
export const LINE_MAX_MS = 3500
export function lineDurationMs(label: string | undefined): number {
  const n = typeof label === 'string' ? [...label].length : 0
  return Math.min(LINE_MAX_MS, LINE_BASE_MS + n * LINE_PER_CHAR_MS)
}

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
export const MULTI_HIT_INTERVAL_MS = DEFAULT_MOTION_TIMING.multiHitIntervalMs

/**
 * 複数ヒットの 1 行動の総時間（最初の命中から最後の round の命中まで）の目安 ms。暫定・未決（おすすめ案の採用）。
 * 最大 round が TOTAL / MULTI_HIT_INTERVAL_MS（= 20）以下なら基本間隔のまま（従来と完全に同じ）。
 */
export const MULTI_HIT_TOTAL_MS = DEFAULT_MOTION_TIMING.multiHitTotalMs

/**
 * 自動調整後の間隔の下限 ms。暫定・未決。MAX_HITS_PER_ACTION=99（最大 round 98）でも 2000/98 ≒ 20.4ms なので、
 * 現行の上限では効かない安全弁（上限を引き上げたとき、命中を 1 フレーム未満に詰めない）。
 */
export const MULTI_HIT_MIN_INTERVAL_MS = DEFAULT_MOTION_TIMING.multiHitMinIntervalMs

/** 最大 round から、round 間の ms を決める: min(基本, 総時間 / 最大 round)。下限あり。最大 round 0 は基本値 */
export function multiHitIntervalFor(
  lastRound: number,
  timing: MotionTiming = DEFAULT_MOTION_TIMING
): number {
  if (!(lastRound > 0)) return timing.multiHitIntervalMs
  return Math.max(
    timing.multiHitMinIntervalMs,
    Math.min(timing.multiHitIntervalMs, timing.multiHitTotalMs / lastRound)
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
  interval: number = DEFAULT_MOTION_TIMING.multiHitIntervalMs
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
  } = {},
  timing: MotionTiming = DEFAULT_MOTION_TIMING
): ActionTimeline {
  const T = timing
  if (kind === 'notice')
    return {
      duration: T.noticeMs + T.actionGapMs,
      hitAt: 0,
      hitInterval: T.multiHitIntervalMs,
    }
  const summon = opts.summon === true && kind === 'skill'
  const motionEnd = summon
    ? T.summonAppearMs + T.summonHoldMs + T.summonLeaveMs
    : kind === 'attack'
      ? T.attackStepMs + T.attackSlashMs + T.attackReturnMs
      : kind === 'status'
        ? T.statusMs
        : T.castMs
  const hitAt = summon
    ? T.summonHitMs
    : kind === 'attack'
      ? T.attackStepMs + T.attackSlashHitMs
      : kind === 'status'
        ? T.statusHitMs
        : T.castHitMs
  // のけぞり・倒れが途中で切れないよう、受ける側の動きが終わるまで次の行動を待つ
  let end = motionEnd
  // 複数ヒットの間隔は最大 round で自動調整する（総時間が約 2 秒に収まる）
  const hitInterval = multiHitIntervalFor(
    Math.max(opts.lastRound ?? 0, opts.lastDamageRound ?? 0, opts.lastDownRound ?? 0),
    T
  )
  // 複数ヒット (#879): のけぞり・倒れ切りは、最後のダメージ・倒れるヒットの round ぶん後ろにずれる（round 無しは 0 で従来と同じ）
  if (opts.damages)
    end = Math.max(end, hitTimeOf(hitAt, opts.lastDamageRound ?? 0, hitInterval) + T.recoilMs)
  if (opts.downs)
    end = Math.max(
      end,
      hitTimeOf(hitAt, opts.lastDownRound ?? 0, hitInterval) + T.recoilMs + T.downMs
    )
  // heal・miss だけの round も取りこぼさない（最大 round が 0 なら何もしない = 従来と同じ）
  if ((opts.lastRound ?? 0) > 0)
    end = Math.max(end, hitTimeOf(hitAt, opts.lastRound ?? 0, hitInterval))
  return { duration: end + T.actionGapMs, hitAt, hitInterval }
}

/** 行動の記録から時間割を作る。HP が減る対象がいればのけぞり、HP 0 になる対象がいれば倒れ切るまで含める */
export function eventTimeline(
  event: BattleActionEvent,
  timing: MotionTiming = DEFAULT_MOTION_TIMING
): ActionTimeline {
  // 脚本制御の戦闘 (#741) の台詞・知らせは、字数に応じて読める長さだけ見せる（短い知らせの固定時間では読み切れない）。復活の回復数字は最初に出る
  if (event.kind === 'notice' && event.line) {
    return {
      duration: lineDurationMs(event.label) + timing.actionGapMs,
      hitAt: 0,
      hitInterval: timing.multiHitIntervalMs,
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
  return buildActionTimeline(
    event.kind,
    {
      damages,
      downs,
      lastDamageRound,
      lastDownRound,
      lastRound,
      ...(event.summon ? { summon: true } : {}),
    },
    timing
  )
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
export function sampleSummonCue(
  t: number,
  timing: MotionTiming = DEFAULT_MOTION_TIMING
): SummonCueSample {
  const total = timing.summonAppearMs + timing.summonHoldMs + timing.summonLeaveMs
  const time = Number.isFinite(t) ? Math.min(Math.max(0, t), total) : 0
  if (time < timing.summonAppearMs) {
    const p = easeOutQuad(time / timing.summonAppearMs)
    return { alpha: p, veil: p, rise: 0.05 * (1 - p) }
  }
  const afterHold = time - timing.summonAppearMs - timing.summonHoldMs
  if (afterHold <= 0) return { alpha: 1, veil: 1, rise: 0 }
  const p = 1 - Math.min(1, afterHold / timing.summonLeaveMs)
  return { alpha: p, veil: p, rise: 0 }
}

export interface ActorSample {
  /** 相手陣営へ向かって出ている量（枠の一辺に対する比。0 以上） */
  forward: number
  pose: BattlePose
}

/** 行動する側の、開始から t ms 時点の位置とポーズ */
export function sampleActor(
  kind: ActionKind,
  t: number,
  timing: MotionTiming = DEFAULT_MOTION_TIMING
): ActorSample {
  const T = timing
  const time = Number.isFinite(t) ? Math.max(0, t) : 0
  if (kind === 'notice' || kind === 'status') return { forward: 0, pose: 'idle' }
  if (kind !== 'attack') {
    // 呪文の構えは cast、アイテムは ready（cast が無ければ ready、さらに idle に落ちる）
    return {
      forward: 0,
      pose: time < T.castMs ? (kind === 'spell' || kind === 'skill' ? 'cast' : 'ready') : 'idle',
    }
  }
  if (time < T.attackStepMs) {
    return { forward: T.attackStepDistance * easeOutQuad(time / T.attackStepMs), pose: 'step' }
  }
  const afterStep = time - T.attackStepMs
  if (afterStep < T.attackSlashMs) {
    return { forward: T.attackStepDistance, pose: 'slash' }
  }
  const afterSlash = afterStep - T.attackSlashMs
  if (afterSlash < T.attackReturnMs) {
    const ease = T.attackReturnEase === 'outQuad' ? easeOutQuad : easeInOutQuad
    return {
      forward: T.attackStepDistance * (1 - ease(afterSlash / T.attackReturnMs)),
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
export function sampleTarget(
  kind: BattleHitKind,
  sinceHit: number,
  downs: boolean,
  timing: MotionTiming = DEFAULT_MOTION_TIMING
): TargetSample {
  if (kind !== 'damage' || !Number.isFinite(sinceHit) || sinceHit < 0) return STANDING
  const recoilU = clamp01(sinceHit / timing.recoilMs)
  const recoil = timing.recoilDistance * Math.sin(Math.PI * recoilU)
  if (!downs) {
    return { recoil, pose: sinceHit < timing.recoilMs ? 'hurt' : 'idle', downProgress: 0 }
  }
  if (sinceHit < timing.recoilMs) return { recoil, pose: 'hurt', downProgress: 0 }
  return {
    recoil: 0,
    pose: 'down',
    downProgress: easeOutQuad((sinceHit - timing.recoilMs) / timing.downMs),
  }
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
  dt: number,
  timing: MotionTiming = DEFAULT_MOTION_TIMING
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
    const tl = eventTimeline(active.event, timing)
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
export const POPUP_ARC1_MS = DEFAULT_MOTION_TIMING.popupArc1Ms
export const POPUP_ARC1_HEIGHT = DEFAULT_MOTION_TIMING.popupArc1Height
export const POPUP_ARC2_MS = DEFAULT_MOTION_TIMING.popupArc2Ms
export const POPUP_ARC2_HEIGHT = DEFAULT_MOTION_TIMING.popupArc2Height
export const POPUP_HOLD_MS = DEFAULT_MOTION_TIMING.popupHoldMs
export const POPUP_FADE_MS = DEFAULT_MOTION_TIMING.popupFadeMs
export const POPUP_TOTAL_MS = POPUP_ARC1_MS + POPUP_ARC2_MS + POPUP_HOLD_MS + POPUP_FADE_MS

export interface PopupSample {
  /** 置き位置からの縦のずれ（枠の一辺に対する比。上が負） */
  dy: number
  alpha: number
  done: boolean
}

export function sampleDamagePopup(
  elapsed: number,
  timing: MotionTiming = DEFAULT_MOTION_TIMING
): PopupSample {
  const T = timing
  const t = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  if (t >= T.popupArc1Ms + T.popupArc2Ms + T.popupHoldMs + T.popupFadeMs)
    return { dy: 0, alpha: 0, done: true }
  // `+ 0` で -0 を 0 に揃える
  const arc = (u: number, h: number) => -4 * h * u * (1 - u) + 0
  if (t < T.popupArc1Ms)
    return { dy: arc(t / T.popupArc1Ms, T.popupArc1Height), alpha: 1, done: false }
  const t2 = t - T.popupArc1Ms
  if (t2 < T.popupArc2Ms)
    return { dy: arc(t2 / T.popupArc2Ms, T.popupArc2Height), alpha: 1, done: false }
  const t3 = t2 - T.popupArc2Ms
  if (t3 < T.popupHoldMs) return { dy: 0, alpha: 1, done: false }
  return { dy: 0, alpha: 1 - clamp01((t3 - T.popupHoldMs) / T.popupFadeMs), done: false }
}

/** 桁ごとの開始遅れの合計（最後の桁の遅れ）の上限（ms）。桁数が多い数字で寿命が延びすぎないようにする (#955) */
export const POPUP_DIGIT_STAGGER_TOTAL_MAX_MS = 150

/** 実際に使う桁ごとの遅れ（ms）: `min(digitStaggerMs, 上限 / (桁数 - 1))`。1 桁・非有限・負は 0 */
export function effectiveDigitStagger(
  count: number,
  timing: MotionTiming = DEFAULT_MOTION_TIMING
): number {
  const n = Number.isFinite(count) ? Math.floor(count) : 1
  const base = Number.isFinite(timing.digitStaggerMs) ? Math.max(0, timing.digitStaggerMs) : 0
  if (n <= 1) return 0
  return Math.min(base, POPUP_DIGIT_STAGGER_TOTAL_MAX_MS / (n - 1))
}

/**
 * 数字を 1 桁ずつ跳ねさせる (#955)。跳ね（dy）だけ桁ごとに `index * 実効遅れ` ずつ遅れ、自分の時間軸で
 * `sampleDamagePopup` と同じ 2 回跳ねを行う。保持・フェード（alpha）と done は数字全体で共通で、最後の桁の時間軸
 * （最後の桁の跳ねが終わってから保持・フェード）から取る。全桁が同時に消え、最後の桁の done が全体の done。
 * 実効遅れは `effectiveDigitStagger`（桁数が多くても合計 150ms まで）。`digitStaggerMs` が 0 のときは全桁が
 * `sampleDamagePopup` と完全に一致する。
 * 遅れる前（まだ始まっていない桁）は置き位置で待つ。範囲外の index・非有限値は安全側（index 0 / 遅れなし）に倒す。
 */
export function sampleDigitPopup(
  elapsed: number,
  index: number,
  count: number,
  timing: MotionTiming = DEFAULT_MOTION_TIMING
): PopupSample {
  const t = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  const n = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1
  const i = Number.isFinite(index) ? Math.min(n - 1, Math.max(0, Math.floor(index))) : 0
  const stagger = effectiveDigitStagger(n, timing)
  const own = sampleDamagePopup(t - i * stagger, timing)
  const last = sampleDamagePopup(t - (n - 1) * stagger, timing)
  return { dy: own.dy, alpha: last.alpha, done: last.done }
}

/**
 * 1 桁ぶんの幅（固定ピッチ・px）。Noto Sans JP Bold の数字の送り幅（約 0.557em。数字は等幅）に合わせ、
 * 1 個の Text で出したときと同じ幅で並べる。
 */
export function popupDigitPitch(fontSize: number): number {
  return Math.max(1, fontSize) * 0.557
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
