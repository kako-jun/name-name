/**
 * 制限時間（残り時間）の表示の計算部 (#880)。DOM / PixiJS に触れない純粋関数だけ。
 *
 * 残り時間は FF 同様、フィールド・メニュー・戦闘のどこでも同じ画面位置（左上隅）に出す、全 UI より手前の独立レイヤー
 * （`TimeLimitLayer.ts`）。位置はここの `TIME_LIMIT_AREA` の1か所だけで定義し、メニュー側のレイアウトはこの領域を避ける
 * （wireframe §2-A-1: 0〜14%W、上端 2%H〜8%H。文字は 16px 以上）。
 * メニュー中は残り時間を進めない（停止中の見た目はレイヤー側が `paused` で出す）。
 */
import type { Rect } from './fieldMenuScreens'

/** ms → 'mm:ss'（1時間以上は 'h:mm:ss'）。負・非有限は 0 */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}

/** 予約領域（面の W / H に対する比率）。メニュー・フィールド・戦闘が共有する唯一の定義 */
export const TIME_LIMIT_AREA = { x: 0, y: 0.02, w: 0.14, h: 0.06 } as const

/** 文字の最小サイズ (px) */
export const TIME_LIMIT_MIN_FONT_PX = 16

export function timeLimitRect(faceW: number, faceH: number): Rect {
  const A = TIME_LIMIT_AREA
  return { x: A.x * faceW, y: A.y * faceH, w: A.w * faceW, h: A.h * faceH }
}

export interface TimeLimitState {
  /** 残り(ms)。null = 時間制限なし（何も出さない） */
  remainingMs: number | null
  /** 止まっている（メニュー中など） */
  paused: boolean
}

/** 時間の文字（`残り mm:ss`）。時間制限なしは null。停止中の見た目は色と停止マーク（レイヤー側）で示す */
export function timeLimitText(s: TimeLimitState): string | null {
  return s.remainingMs === null ? null : `残り ${formatClock(s.remainingMs)}`
}

/** 読み上げ・検証用の文字。停止中は「停止中」を添える。時間制限なしは null */
export function formatTimeLimit(s: TimeLimitState): string | null {
  const t = timeLimitText(s)
  return t === null ? null : s.paused ? `${t} 停止中` : t
}

/** 残りを dt だけ進める。停止中・null・非有限の dt は変えない。0 で止まる */
export function advanceTimeLimit(
  remainingMs: number | null,
  dtMs: number,
  paused: boolean
): number | null {
  if (remainingMs === null || paused || !Number.isFinite(dtMs) || dtMs <= 0) return remainingMs
  return Math.max(0, remainingMs - dtMs)
}

/**
 * 文字の大きさ (px)。面の高さの 4% を上限に、予約領域の幅（`残り mm:ss` ≒ 5.2 字ぶん。停止マークの分は右に空ける）と
 * 高さ（1行）へ収める。16px を下回るほど狭い面では 16px（領域からはみ出す側を取る）
 */
export function timeLimitFontPx(faceW: number, faceH: number): number {
  const r = timeLimitRect(faceW, faceH)
  const fit = Math.min(0.04 * faceH, (r.w * 0.62) / 5.2, r.h / 1.25)
  return Math.max(TIME_LIMIT_MIN_FONT_PX, Math.round(fit))
}
