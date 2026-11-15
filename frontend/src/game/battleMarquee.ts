/**
 * 戦闘の窓で入り切らない文字を、省略（…）せず横にゆっくり自動スクロールして見せる (#1183)。純粋関数と表示専用の時計のみ
 * （this / PixiJS に触れない）。描画（マスク・位置）は BattleScreen / BattleMenuLayer が行う。
 *
 * - 設定 `battle_text_overflow: ellipsis|scroll`（既定 ellipsis＝従来の省略）。窓の大きさ・文字サイズ・グリッド・味方の並びなど
 *   他のキーとは直交（このキーは「入り切らない文字をどう見せるか」だけを決め、窓の寸法は変えない）
 * - 動き: 先頭で待つ → 左へ流れる → 末尾で止まる → 先頭へ切り替え → 繰り返し（片道ループ。戻り方は MARQUEE_RETURN）。速度は px/秒、停止は ms
 * - 時計はゲームのティックと独立した表示専用。呼び出し側が `advance(deltaMS)` で積む（時刻の注入。ヘッドレスで再現できる）
 */

import type { MotionTiming } from './battleMotion'

export type BattleTextOverflow = 'ellipsis' | 'scroll'

/** frontmatter `battle_text_overflow` / sample JSON の正規化。未指定・空は ellipsis。不正値は警告して ellipsis（`warn=false` は警告だけ止める） */
export function normalizeBattleTextOverflow(
  raw: string | null | undefined,
  warn = true
): BattleTextOverflow {
  if (typeof raw !== 'string' || raw.trim() === '') return 'ellipsis'
  const v = raw.trim().toLowerCase()
  if (v === 'scroll') return 'scroll'
  if (v === 'ellipsis') return 'ellipsis'
  if (warn)
    console.warn(`battle_text_overflow '${raw}' は ellipsis / scroll ではないため ellipsis にした`)
  return 'ellipsis'
}

/**
 * 実際にスクロールさせるか。`scroll` 指定でも、動きを減らす設定（prefers-reduced-motion: reduce）のときは
 * 動かさず従来の省略（ellipsis）に倒す
 */
export function effectiveTextOverflow(
  setting: BattleTextOverflow,
  reducedMotion: boolean
): BattleTextOverflow {
  return setting === 'scroll' && !reducedMotion ? 'scroll' : 'ellipsis'
}

export interface MarqueeTiming {
  /** 流れる速さ (px/秒)。0 以下・非有限なら動かさない（先頭のまま） */
  speed: number
  /** 表示直後（と先頭へ戻ったあと）、先頭が見える状態で待つ時間 (ms) */
  startHoldMs: number
  /** 最後の文字が見えたところで止まる時間 (ms) */
  endHoldMs: number
}

/**
 * 末尾まで流れたあとの戻り方。`jump` = 先頭へ切り替える（片道ループ。既定）、`reverse` = 同じ速さで逆スクロールして戻る。
 * kako-jun の判断待ちのため、この定数 1 つで差し替えられる (#1183)
 */
export const MARQUEE_RETURN: 'jump' | 'reverse' = 'jump'

/** motion preset の表（`MotionTiming.marqueeSpeed` / `marqueeStartHoldMs` / `marqueeEndHoldMs`）から取り出す */
export function marqueeTimingOf(
  t: Pick<MotionTiming, 'marqueeSpeed' | 'marqueeStartHoldMs' | 'marqueeEndHoldMs'>
): MarqueeTiming {
  return { speed: t.marqueeSpeed, startHoldMs: t.marqueeStartHoldMs, endHoldMs: t.marqueeEndHoldMs }
}

/**
 * スクロールの対象（どの窓の文字を流すか）。ここ 1 箇所で管理する (#1183)。ステータス窓の味方名（`status`）を足すときは、
 * この配列に加え BattleScreen の呼び出し側を戻すだけ
 */
export const MARQUEE_TARGETS = ['menu', 'enemyList'] as const
export type MarqueeTarget = (typeof MARQUEE_TARGETS)[number]

/** この対象をスクロールさせるか（設定が scroll で、対象の一覧に載っているとき） */
export function marqueeAppliesTo(setting: BattleTextOverflow, target: string): boolean {
  return setting === 'scroll' && (MARQUEE_TARGETS as readonly string[]).includes(target)
}

/** 末尾を窓の縁にぴったり付けず、最後の文字が読めるように足す余白 (px) */
export const MARQUEE_END_PAD = 4

/** 文字の幅 `contentW` が窓の幅 `clipW` を越える量 (px)。越えなければ 0（スクロールしない） */
export function marqueeOverflowPx(contentW: number, clipW: number): number {
  if (!Number.isFinite(contentW) || !Number.isFinite(clipW)) return 0
  return contentW > clipW + 0.01 ? contentW - clipW + MARQUEE_END_PAD : 0
}

function holdOf(v: number): number {
  return Math.max(0, Number.isFinite(v) ? v : 0)
}

/** 1 周の長さ (ms)。動かない（overflow が 0・速度が 0 以下）なら 0 */
export function marqueeCycleMs(overflow: number, timing: MarqueeTiming): number {
  if (!(overflow > 0) || !(timing.speed > 0) || !Number.isFinite(timing.speed)) return 0
  const travel = (overflow / timing.speed) * 1000
  const start = holdOf(timing.startHoldMs)
  const end = holdOf(timing.endHoldMs)
  return MARQUEE_RETURN === 'reverse' ? start + travel + end + travel : start + travel + end
}

/**
 * 経過 `elapsedMs` のときの左方向のずれ (px。0 = 先頭、`overflow` = 末尾)。
 * 先頭で待つ → 左へ流れる → 末尾で止まる → 先頭へ戻る（`MARQUEE_RETURN`）→ 繰り返し。
 * 動かさない条件・負や非有限の経過は 0
 */
export function sampleMarquee(elapsedMs: number, overflow: number, timing: MarqueeTiming): number {
  const cycle = marqueeCycleMs(overflow, timing)
  if (cycle <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  const start = holdOf(timing.startHoldMs)
  const end = holdOf(timing.endHoldMs)
  const travel = (overflow / timing.speed) * 1000
  const t = elapsedMs % cycle
  if (t < start) return 0
  if (t < start + travel) return ((t - start) / travel) * overflow
  if (t < start + travel + end) return overflow
  // 以降は reverse のときだけ（jump は周期が終わって先頭へ切り替わる）
  return overflow - ((t - start - travel - end) / travel) * overflow
}

/**
 * 表示専用の時計。`advance` で経過を積み、キー（その文字列の持ち主）ごとに『最初に見えた時刻』を覚える。
 * 同じキーは再描画しても先頭から始め直さない（カーソルを動かしても流れが途切れない）。キーが消えたら `retain` で忘れる
 */
export class MarqueeClock {
  private nowMs = 0
  private starts = new Map<string, number>()

  advance(deltaMS: number): void {
    if (Number.isFinite(deltaMS) && deltaMS > 0) this.nowMs += deltaMS
  }

  get now(): number {
    return this.nowMs
  }

  /** キーが見え始めてからの経過 (ms)。初めて見るキーは 0 */
  elapsedOf(key: string): number {
    let s = this.starts.get(key)
    if (s === undefined) {
      s = this.nowMs
      this.starts.set(key, s)
    }
    return this.nowMs - s
  }

  /** `keys` に無いキーを忘れる（消えた文字列は、次に出たとき先頭から） */
  retain(keys: ReadonlySet<string>): void {
    for (const k of [...this.starts.keys()]) if (!keys.has(k)) this.starts.delete(k)
  }
}
