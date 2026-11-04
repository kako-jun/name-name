/**
 * 全画面メニューの画面遷移 (#847 の FF4 風 / #880 で一枚絵メニューへ適用)。DOM / PixiJS に触れない純粋関数だけ。
 *
 *   1. 現ウィンドウの文字が消える（textOutMs）
 *   2. 枠が右上 → 必要な位置・大きさへスライドして変形する（slideMs。枠は作り直さず再利用）
 *   3. 新しい位置で文字が現れる（textInMs）
 * 戻るときは同じ時間軸を逆再生する（`sampleMenuTransition` の `reverse`）。
 *
 * 速さ（各段階の長さ）は設定 `menu.transition` で変えられる。0 = その段階を飛ばす（全部 0 で即切替）。
 * 既定値は短めの目視用の値で、FF4 実機の枠の速さ・文字の出入りの順序の一次資料は未確認（出典なし。実機でライブ調整する想定）。
 */
import type { Rect } from './fieldMenuScreens'

export interface MenuTransitionTiming {
  /** 現ウィンドウの文字が消えるまで (ms) */
  textOutMs: number
  /** 枠のスライド変形 (ms) */
  slideMs: number
  /** 新しい文字が現れるまで (ms) */
  textInMs: number
}

/** 既定。出典未確認の目視用の値（FF4 の実測ではない） */
export const DEFAULT_MENU_TRANSITION: MenuTransitionTiming = {
  textOutMs: 80,
  slideMs: 140,
  textInMs: 80,
}

/** 各段階の長さの上限(ms)。これを超える値は誤記とみなす */
export const MENU_TRANSITION_MAX_MS = 2000

export interface ParsedTransition {
  timing: MenuTransitionTiming
  warnings: string[]
}

/**
 * 設定の `menu.transition` を正規化する。未指定は既定。`false` / `"none"` は即切替（全段階 0）。
 * オブジェクトは `textOutMs` / `slideMs` / `textInMs`（0〜上限の有限数）。不正なキーは警告して既定のまま
 */
export function normalizeTransitionTiming(raw: unknown): ParsedTransition {
  const warnings: string[] = []
  if (raw === undefined || raw === true) return { timing: { ...DEFAULT_MENU_TRANSITION }, warnings }
  if (raw === false || raw === 'none')
    return { timing: { textOutMs: 0, slideMs: 0, textInMs: 0 }, warnings }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(
      `menu.transition は false / "none" / オブジェクトにしてください: ${JSON.stringify(raw)}（既定を使います）`
    )
    return { timing: { ...DEFAULT_MENU_TRANSITION }, warnings }
  }
  const o = raw as Record<string, unknown>
  const timing = { ...DEFAULT_MENU_TRANSITION }
  for (const k of ['textOutMs', 'slideMs', 'textInMs'] as const) {
    if (o[k] === undefined) continue
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MENU_TRANSITION_MAX_MS)
      timing[k] = v
    else
      warnings.push(
        `menu.transition.${k} は 0〜${MENU_TRANSITION_MAX_MS} の数にしてください: ${JSON.stringify(v)}（既定を使います）`
      )
  }
  return { timing, warnings }
}

export function transitionDurationMs(t: MenuTransitionTiming): number {
  return t.textOutMs + t.slideMs + t.textInMs
}

export interface TransitionSample {
  /** 再利用する枠の、この時点の矩形 */
  frame: Rect
  /** 手前の画面（from）の文字・他の窓の表示度 0..1 */
  fromAlpha: number
  /** 先の画面（to）の文字・他の窓の表示度 0..1 */
  toAlpha: number
  /** 時間軸の終わりに達した */
  done: boolean
}

/** なめらかな加減速（0..1 → 0..1） */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, Number.isNaN(t) ? 0 : t))
  return x * x * (3 - 2 * x)
}

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  }
}

const ratio = (num: number, den: number): number =>
  den > 0 ? Math.min(1, Math.max(0, num / den)) : 1

/**
 * 経過時間 → 枠の矩形と文字の表示度。`from` / `to` は順再生の始点・終点（from = 浅い画面、to = 深い画面）の枠。
 * `reverse` = 戻る遷移。同じ時間軸を逆に再生する（to の文字が消え → 枠が to から from へ戻り → from の文字が現れる）。
 * 経過時間は 0..全長にクランプする。
 */
export function sampleMenuTransition(
  elapsedMs: number,
  timing: MenuTransitionTiming,
  from: Rect,
  to: Rect,
  reverse = false
): TransitionSample {
  const total = transitionDurationMs(timing)
  const e0 = Number.isFinite(elapsedMs) ? Math.min(total, Math.max(0, elapsedMs)) : 0
  const done = e0 >= total
  const e = reverse ? total - e0 : e0
  const { textOutMs: o, slideMs: s, textInMs: i } = timing
  if (e < o) return { frame: from, fromAlpha: 1 - ratio(e, o), toAlpha: 0, done }
  if (e < o + s)
    return { frame: lerpRect(from, to, easeInOut(ratio(e - o, s))), fromAlpha: 0, toAlpha: 0, done }
  return { frame: to, fromAlpha: 0, toAlpha: ratio(e - o - s, i), done }
}
