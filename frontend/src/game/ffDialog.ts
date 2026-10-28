/**
 * FF 風の会話窓 (#840 1本目)。画面の上部に固定し、文字は 1 文字ずつ出す。
 *
 * 純粋関数だけを持つ（this / PixiJS に触れない）。描画は DialogBox が行い、配色は戦闘窓の ff-blue
 * (`windowStyle.ts`, #744) をそのまま使う。見た目は実機でライブ調整するので、調整対象の定数はここに集める。
 */
import { BATTLE_LOG_MS_PER_CHAR } from './battleLogTypewriter'

/** 会話窓のスタイル。`ff` = 画面上部固定・ff-blue・1 文字ずつ。未指定（undefined）は従来の下部の窓 */
export type DialogStyle = 'ff'

/**
 * 設定の値を正規化する。`'ff'` だけを受け付け、それ以外（未指定・空・未知値）は undefined（従来の窓）。
 * 設定 JSON 側は未知値を警告するので、ここは判定だけ。
 */
export function normalizeDialogStyle(raw: unknown): DialogStyle | undefined {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'ff' ? 'ff' : undefined
}

/** ff の既定の 1 文字あたり ms。戦闘ログの 1 文字表示 (#755) と同じ（目視調整値は向こうが正本） */
export const FF_DIALOG_MS_PER_CHAR = BATTLE_LOG_MS_PER_CHAR

/** 窓の上端（画面高さに対する比率） */
export const FF_DIALOG_TOP_RATIO = 0.04
/** 窓の高さ（画面高さに対する比率）。上端と合わせて画面の上半分（0.5）に収める */
export const FF_DIALOG_HEIGHT_RATIO = 0.34
/** 窓の左右の余白（画面幅に対する比率） */
export const FF_DIALOG_MARGIN_X_RATIO = 0.03
/** 窓内のパディング（画面高さに対する比率） */
export const FF_DIALOG_PADDING_RATIO = 0.03

export interface FfDialogRect {
  x: number
  y: number
  width: number
  height: number
  /** 窓内の余白(px) */
  padding: number
}

/**
 * 画面（シーン）の大きさ → ff 会話窓の矩形。話者・キャラの位置には依存しない（常に画面上部）。
 * 不変条件: 画面内に収まり、下端は画面高さの半分以下。非有限・負の入力は 0 扱いで、幅・高さは 0 になる。
 */
export function computeFfDialogRect(screenWidth: number, screenHeight: number): FfDialogRect {
  const sw = Number.isFinite(screenWidth) && screenWidth > 0 ? screenWidth : 0
  const sh = Number.isFinite(screenHeight) && screenHeight > 0 ? screenHeight : 0
  const x = Math.round(sw * FF_DIALOG_MARGIN_X_RATIO)
  const y = Math.round(sh * FF_DIALOG_TOP_RATIO)
  return {
    x,
    y,
    width: Math.max(0, sw - x * 2),
    height: Math.round(sh * FF_DIALOG_HEIGHT_RATIO),
    padding: Math.max(6, Math.round(sh * FF_DIALOG_PADDING_RATIO)),
  }
}

/** `dialogMsPerChar` の上限(ms)。これを超える値は誤記とみなす（1 文字に 1 秒以上かかる窓は使えない） */
export const FF_DIALOG_MS_PER_CHAR_MAX = 1000

/**
 * `msPerChar` の設定値を正規化する。0 以上 `FF_DIALOG_MS_PER_CHAR_MAX` 以下の有限数はそのまま（0 = 即時表示）、
 * それ以外（負・上限超え・非数）は undefined（既定を使う）。
 */
export function normalizeMsPerChar(raw: unknown): number | undefined {
  return typeof raw === 'number' &&
    Number.isFinite(raw) &&
    raw >= 0 &&
    raw <= FF_DIALOG_MS_PER_CHAR_MAX
    ? raw
    : undefined
}

/**
 * 設定（`dialogStyle` / `dialogMsPerChar`）から DialogBox に渡す追加オプションを作る。
 * 未指定なら空（キーが無い＝従来の窓・既定の速さ）。ff なら ffWindow と既定速度。
 * `dialogMsPerChar` は指定があれば ff の既定より優先し、0 は即時表示。
 */
export function fieldDialogOptions(c: { dialogStyle?: DialogStyle; dialogMsPerChar?: number }): {
  ffWindow?: true
  msPerChar?: number
} {
  return {
    ...(c.dialogStyle === 'ff' ? { ffWindow: true as const } : {}),
    ...(c.dialogMsPerChar !== undefined
      ? { msPerChar: c.dialogMsPerChar }
      : c.dialogStyle === 'ff'
        ? { msPerChar: FF_DIALOG_MS_PER_CHAR }
        : {}),
  }
}
