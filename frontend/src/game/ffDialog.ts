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

// ---------------------------------------------------------------------------
// 改ページ (#840 2本目)
// ---------------------------------------------------------------------------

/** 台詞の行の高さ（フォントサイズ比）。DialogBox の本文の lineHeight と同じ値を使う（窓を実際に描くサイズと一致させる） */
export const FF_DIALOG_LINE_HEIGHT_RATIO = 1.6

/** ▼（続きがある印）の点滅周期の半分(ms)。この間隔で ON / OFF を切り替える（ON から始まる） */
export const FF_CURSOR_BLINK_MS = 500

/** ▼の大きさ（本文フォントサイズ比） */
export const FF_CURSOR_SIZE_RATIO = 0.6

/**
 * ▼を出す右下の場所を本文が食わないよう、折り返し幅から引く幅(px)。非有限・非正の fontSize は 0。
 */
export function ffCursorReserve(fontSize: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) return 0
  return Math.round(fontSize * 0.8)
}

/**
 * 窓の高さ・パディング・行の高さから、1 ページに入る行数を求める。使える高さ = 窓の高さ − 上下のパディング。
 * 極端に小さい窓（1 行も入らない）や非有限値でも最低 1 行（0 行だとページが進まず台詞が出せなくなる）。
 */
export function ffLinesPerPage(boxHeight: number, padding: number, lineHeight: number): number {
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return 1
  const h = Number.isFinite(boxHeight) && boxHeight > 0 ? boxHeight : 0
  const p = Number.isFinite(padding) && padding > 0 ? padding : 0
  const n = Math.floor((h - p * 2) / lineHeight)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/**
 * 台詞を `\n` で段落に分け、各段落を別々に折り返して行を並べる。`wrap` は 1 段落（改行なし）を行配列にする関数。
 * 改行をまたいで行幅を累積する不具合（改行後の行が直前の残り幅で折り返される）を避けるための入口。
 * 空の段落（連続改行）は空行として残し、末尾の空行は落とす。結果は最低 1 行（空文字なら ['']）。
 */
export function wrapParagraphs(text: string, wrap: (paragraph: string) => string[]): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') lines.push('')
    else lines.push(...wrap(paragraph))
  }
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.length > 0 ? lines : ['']
}

/** 行を 1 ページ `linesPerPage` 行ずつに分ける（1 行未満・非有限は 1 行）。入力が空でも最低 1 ページ（空ページ） */
export function paginateLines(lines: readonly string[], linesPerPage: number): string[][] {
  const per = Number.isFinite(linesPerPage) && linesPerPage >= 1 ? Math.floor(linesPerPage) : 1
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per))
  return pages.length > 0 ? pages : [[]]
}

/** ページ内の改行を除いた文字数の合計（再折り返し時に「いま読んでいる位置」を引き継ぐための物差し） */
export function pageStartOffset(pages: readonly (readonly string[])[], pageIndex: number): number {
  let n = 0
  for (let i = 0; i < pageIndex && i < pages.length; i++) {
    for (const line of pages[i]) n += line.length
  }
  return n
}

/** `pageStartOffset` の逆: 先頭から `offset` 文字目を含む（その位置以下で始まる最後の）ページの番号 */
export function pageIndexAtOffset(pages: readonly (readonly string[])[], offset: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0
  let idx = 0
  for (let i = 0; i < pages.length; i++) {
    if (pageStartOffset(pages, i) <= offset) idx = i
    else break
  }
  return idx
}

/**
 * ▼の点滅。`elapsedMs` = 「次のページ待ち」に入ってからの経過時間。ON から始まり `FF_CURSOR_BLINK_MS` ごとに反転する。
 * 負・非有限は ON（見えないまま待たせない）。
 */
export function ffCursorVisible(elapsedMs: number): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return true
  return Math.floor(elapsedMs / FF_CURSOR_BLINK_MS) % 2 === 0
}
