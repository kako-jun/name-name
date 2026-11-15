/**
 * FF 風の会話窓 (#840 1本目)。画面の上部に固定し、文字は 1 文字ずつ出す。
 *
 * 純粋関数だけを持つ（this / PixiJS に触れない）。描画は DialogBox が行い、配色は戦闘窓の ff-blue
 * (`windowStyle.ts`, #744) をそのまま使う。見た目は実機でライブ調整するので、調整対象の定数はここに集める。
 */
import { BATTLE_LOG_MS_PER_CHAR } from './battleLogTypewriter'
import { BATTLE_UI_BASE_HEIGHT, MESSAGE_WINDOW_FONT_SIZE } from './battleLogicalSize'
import type { WindowStyle } from './windowStyle'

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

// ---------------------------------------------------------------------------
// 一枚絵フィールドの会話窓の配置 (#1153)。設計の決定: 幅 94%W・高さ 28%H・画面端から 3%H。
// 主人公の足元 y が H/2 より下なら上側、それ以外（ちょうど中央を含む）は下側。アクスタと重なる側は避ける
// ---------------------------------------------------------------------------

export const FIELD_DIALOG_WIDTH_RATIO = 0.94
export const FIELD_DIALOG_HEIGHT_RATIO = 0.28
export const FIELD_DIALOG_EDGE_RATIO = 0.03
/** 窓内の上下左右の余白（画面高さ比）。名前行＋本文3行が 28%H に収まる値 */
export const FIELD_DIALOG_PADDING_RATIO = 0.02
/** 本文・名前の文字サイズ（画面高さ比）。(名前1行+本文3行)×行高1.6＋上下余白が 28%H 以下になる値 */
export const FIELD_DIALOG_FONT_RATIO = 0.034
/** 上下の切り替えスライドの長さ(ms) */
export const FIELD_DIALOG_SLIDE_MS = 150
/** 残り時間表示（左上 0〜14%W）と重ならないよう、上側表示＋時間制限中に名前を始める x（画面幅比） */
export const FIELD_DIALOG_TIMED_NAME_X_RATIO = 0.16

export type DialogSide = 'top' | 'bottom'
export interface DialogRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 戦闘のメッセージ窓と同じ文字サイズ（画面高さ比）(#1184)。戦闘側は設計高さ `BATTLE_UI_BASE_HEIGHT` に対して `MESSAGE_WINDOW_FONT_SIZE` px
 * （BattleScreen.ts。フィールド作品は 1920x1080 固定なので uiScale = 1080/450 倍され、実画面では高さの 22/450）。
 * 戦闘側の定数と一致することは ffDialog.test.ts で固定する
 */
export const FIELD_DIALOG_BATTLE_FONT_RATIO = MESSAGE_WINDOW_FONT_SIZE / BATTLE_UI_BASE_HEIGHT

/** 会話窓の文字サイズ (#1184)。`normal` = 従来（既定）/ `battle` = 戦闘のメッセージ窓と同じ */
export type DialogFontSize = 'normal' | 'battle'
/** 会話窓の話者名の見せ方 (#1184)。`inline` = 従来（既定）/ `large` = 大きめ・太字・金色 / `plate` = 金の名札 */
export type DialogNameStyle = 'inline' | 'large' | 'plate'
export const DIALOG_FONT_SIZES: readonly DialogFontSize[] = ['normal', 'battle']
export const DIALOG_NAME_STYLES: readonly DialogNameStyle[] = ['inline', 'large', 'plate']
/** `dialog_window_height` の範囲（画面高さ比）と既定 */
export const FIELD_DIALOG_HEIGHT_MAX = 0.6

/** 設定値の正規化（前後の空白・大小を無視）。未指定・未知値は undefined（呼び出し側が警告する） */
export function normalizeDialogFontSize(raw: unknown): DialogFontSize | undefined {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (DIALOG_FONT_SIZES as readonly string[]).includes(v) ? (v as DialogFontSize) : undefined
}
export function normalizeDialogNameStyle(raw: unknown): DialogNameStyle | undefined {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (DIALOG_NAME_STYLES as readonly string[]).includes(v) ? (v as DialogNameStyle) : undefined
}
/** 窓の高さ（画面高さ比）。有限で下限（fieldDialogMinHeightRatio）〜0.6 の数値だけ通す。範囲外・非数は undefined */
export function normalizeDialogWindowHeight(
  raw: unknown,
  size: DialogFontSize = 'normal'
): number | undefined {
  return typeof raw === 'number' &&
    Number.isFinite(raw) &&
    raw >= fieldDialogMinHeightRatio(size) &&
    raw <= FIELD_DIALOG_HEIGHT_MAX
    ? raw
    : undefined
}

/**
 * `dialog_window_height` の下限（画面高さ比）。話者名 1 行 + 本文 1 行（行の高さ = 文字サイズ × 1.6）と上下の余白（2%H ずつ）が必ず入る高さ。
 * 文字サイズに依存するので `dialog_font_size` ごとに違う（normal ≒ 0.154・battle ≒ 0.201）。px の丸めの余裕に 0.005 足して小数 3 桁へ切り上げる。
 * これ未満だと本文が窓の外へはみ出す（1 ページの行数は最低 1 に保たれるため）
 */
export function fieldDialogMinHeightRatio(size: DialogFontSize = 'normal'): number {
  const font = size === 'battle' ? FIELD_DIALOG_BATTLE_FONT_RATIO : FIELD_DIALOG_FONT_RATIO
  const raw = FIELD_DIALOG_PADDING_RATIO * 2 + FF_DIALOG_LINE_HEIGHT_RATIO * font * 2 + 0.005
  return Math.ceil(raw * 1000) / 1000
}

export function fieldDialogFontSize(screenHeight: number, size: DialogFontSize = 'normal'): number {
  const sh = Number.isFinite(screenHeight) && screenHeight > 0 ? screenHeight : 0
  const ratio = size === 'battle' ? FIELD_DIALOG_BATTLE_FONT_RATIO : FIELD_DIALOG_FONT_RATIO
  return Math.max(14, Math.round(sh * ratio))
}

/** 指定の側の窓の矩形。不変条件: 画面内に収まる。非有限・負の入力は 0 扱い */
export function computeFieldDialogRect(
  screenWidth: number,
  screenHeight: number,
  side: DialogSide,
  heightRatio: number = FIELD_DIALOG_HEIGHT_RATIO
): FfDialogRect {
  const sw = Number.isFinite(screenWidth) && screenWidth > 0 ? screenWidth : 0
  const sh = Number.isFinite(screenHeight) && screenHeight > 0 ? screenHeight : 0
  const width = Math.round(sw * FIELD_DIALOG_WIDTH_RATIO)
  const height = Math.round(sh * heightRatio)
  const edge = Math.round(sh * FIELD_DIALOG_EDGE_RATIO)
  return {
    x: Math.round((sw - width) / 2),
    y: side === 'top' ? edge : sh - edge - height,
    width,
    height,
    padding: Math.max(4, Math.round(sh * FIELD_DIALOG_PADDING_RATIO)),
  }
}

function rectsOverlap(a: DialogRect, b: DialogRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * 足元 y（接地点）と画面の大きさから窓を出す側を決める。足元が H/2 より下なら上側、それ以外（ちょうど中央も）は下側。
 * 選んだ側の窓が `avatar`（主人公の表示矩形）と重なり、反対側が重ならないなら反対側。両方重なるなら上下判定のまま。
 */
export function pickDialogSide(
  footY: number,
  screenWidth: number,
  screenHeight: number,
  avatar: DialogRect | null,
  heightRatio: number = FIELD_DIALOG_HEIGHT_RATIO
): DialogSide {
  const preferred: DialogSide = footY > screenHeight / 2 ? 'top' : 'bottom'
  if (!avatar) return preferred
  const other: DialogSide = preferred === 'top' ? 'bottom' : 'top'
  const hit = (side: DialogSide) =>
    rectsOverlap(computeFieldDialogRect(screenWidth, screenHeight, side, heightRatio), avatar)
  return hit(preferred) && !hit(other) ? other : preferred
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
 * 未指定なら空（キーが無い＝従来の窓・既定の速さ）。ff なら ffWindow と既定速度。`windowStyle` が渡されたら（設計どおりの窓の指定）ff の窓にして ffWindowStyle も渡す。
 * `dialogMsPerChar` は指定があれば ff の既定より優先し、0 は即時表示。
 */
export function fieldDialogOptions(c: {
  dialogStyle?: DialogStyle
  dialogMsPerChar?: number
  /**
   * 窓の配色 (#1147・#1153)。一枚絵フィールドが `window_style` を渡したとき（= 設計どおりの窓にする指定）だけ入れる。
   * 入っていれば ff の窓（ffWindow・1 文字ずつ）にして配色を渡す。配置（上下・名前）は呼び出し側が ffPlacement を足して有効にする。
   * 未指定は従来どおり（ff の指定がなければ従来の窓・ff なら上部固定の ff-blue）
   */
  windowStyle?: WindowStyle
}): {
  ffWindow?: true
  ffWindowStyle?: WindowStyle
  msPerChar?: number
} {
  return {
    ...(c.dialogStyle === 'ff' || c.windowStyle ? { ffWindow: true as const } : {}),
    ...(c.windowStyle ? { ffWindowStyle: c.windowStyle } : {}),
    ...(c.dialogMsPerChar !== undefined
      ? { msPerChar: c.dialogMsPerChar }
      : c.dialogStyle === 'ff' || c.windowStyle
        ? { msPerChar: FF_DIALOG_MS_PER_CHAR }
        : {}),
  }
}

/**
 * 設計どおりの窓（`window_style` を書いた作品）だけに効く #1184 の三つの設定を、DialogBox のオプションにする。
 * `windowStyle` が無い（従来の窓）ときは三つとも無視して空（従来の見た目のまま）。未指定のキーも出さない
 */
export function fieldDialogStyleOptions(c: {
  windowStyle?: WindowStyle
  dialogFontSize?: DialogFontSize
  dialogWindowHeight?: number
  dialogNameStyle?: DialogNameStyle
}): { ffWindowHeightRatio?: number; ffNameStyle?: DialogNameStyle } {
  if (!c.windowStyle) return {}
  return {
    ...(c.dialogWindowHeight !== undefined ? { ffWindowHeightRatio: c.dialogWindowHeight } : {}),
    ...(c.dialogNameStyle ? { ffNameStyle: c.dialogNameStyle } : {}),
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
