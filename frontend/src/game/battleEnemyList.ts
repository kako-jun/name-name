/**
 * 敵名ウィンドウ (#954) の純粋関数。FF 式に、同名の敵を「名前 ×N」にまとめて縦に並べる。
 * - 表示順は敵の並び順（最初に現れた順。先頭が倒れても残りの順は変わらない）
 * - 倒れた（HP 0 以下）敵は個数から引き、全滅した名前は行ごと消す（薄くしない）
 * - 1 体のときは名前のみ
 */
import {
  SIDE_STATUS_ROW_HEIGHT,
  SIDE_STATUS_VERTICAL_PADDING,
  estimateTextWidth,
  fitLabel,
} from './battleLayout'

/** 窓の設定値 (#954)。`window` のときだけ窓を出す。未指定・空・不正値は `off` */
export type BattleEnemyListMode = 'off' | 'window'

/** frontmatter `battle_enemy_list` / sample JSON `enemyList` の正規化。不正値は警告して `off`（`warn=false` は警告だけ止める。効かない組み合わせのとき） */
export function normalizeBattleEnemyList(
  raw: string | null | undefined,
  warn = true
): BattleEnemyListMode {
  if (typeof raw !== 'string' || raw.trim() === '') return 'off'
  const v = raw.trim().toLowerCase()
  if (v === 'window') return 'window'
  if (warn) console.warn(`battle_enemy_list '${raw}' は window ではないため無効にした`)
  return 'off'
}

export interface EnemyListRow {
  name: string
  count: number
  /** 状態異常の表示名（`[どく]` など）。無ければ空・省略 */
  status?: readonly string[]
}

/** 行の頭に付ける状態異常の表示（`[どく・ねむり] `）。無ければ空文字。省略は末尾から削られるので状態名は先頭に置いて見える側に残す */
export function enemyListStatusPrefix(row: EnemyListRow): string {
  return row.status && row.status.length > 0 ? `[${row.status.join('・')}] ` : ''
}

/**
 * 名前（と状態異常）ごとの生存数。最初に現れた順。生存 0 の行は含めない。
 * 同名でも状態異常が違う敵は別の行にする（「[どく] スライム」と「スライム ×2」。状態が付く・治ると行が変わる）
 */
export function aggregateEnemyList(
  enemies: readonly { name: string; hp: number; status?: readonly string[] }[]
): EnemyListRow[] {
  const order: string[] = []
  const rows = new Map<string, EnemyListRow>()
  for (const e of enemies) {
    const status = e.status ?? []
    const key = `${e.name}\u0000${status.join('\u0001')}`
    let row = rows.get(key)
    if (!row) {
      row = { name: e.name, count: 0, ...(status.length > 0 ? { status } : {}) }
      rows.set(key, row)
      order.push(key)
    }
    if (e.hp > 0) row.count += 1
  }
  return order.map((k) => rows.get(k) as EnemyListRow).filter((r) => r.count > 0)
}

/** 1 行の文字列。1 体は名前のみ、2 体以上は「名前 ×N」。状態異常があれば先頭に `[どく] ` */
export function enemyListRowText(row: EnemyListRow): string {
  return `${enemyListStatusPrefix(row)}${row.count > 1 ? `${row.name} ×${row.count}` : row.name}`
}

/** 窓の内側の余白（上下左右） */
export const ENEMY_LIST_PADDING = 8
/** 文字サイズの上限・下限と、行高さ / フォントサイズ */
export const ENEMY_LIST_MAX_FONT = 14
export const ENEMY_LIST_MIN_FONT = 9
export const ENEMY_LIST_LINE_RATIO = 1.3

export interface EnemyListFit {
  fontSize: number
  lineHeight: number
  /** 窓に収まる最大行数（最小サイズでも収まらない分は出さない） */
  visibleRows: number
}

/**
 * 文字サイズを決める。まず行数が窓高に収まる最大サイズ（上限 ENEMY_LIST_MAX_FONT）を求め、
 * `width` を渡したときはそこから `ENEMY_LIST_MIN_FONT` まで、全行が窓の幅に収まる最大サイズまで縮める。
 * 最小サイズでも収まらないものは、高さなら行を出さず（`visibleRows`）、幅なら名前を「…」で省略する。
 * 0 行は上限サイズ
 */
export function fitEnemyListFont(
  rowCount: number,
  windowHeight: number,
  width?: { rows: readonly EnemyListRow[]; windowWidth: number }
): EnemyListFit {
  const inner = Math.max(0, windowHeight - ENEMY_LIST_PADDING * 2)
  const rows = Math.max(0, Math.floor(rowCount))
  let font = ENEMY_LIST_MAX_FONT
  if (rows > 0) {
    font = Math.min(ENEMY_LIST_MAX_FONT, Math.floor(inner / rows / ENEMY_LIST_LINE_RATIO))
    font = Math.max(ENEMY_LIST_MIN_FONT, font)
  }
  const lineHeightOf = (f: number): number => Math.ceil(f * ENEMY_LIST_LINE_RATIO)
  const visibleOf = (f: number): number =>
    Math.min(rows, Math.max(0, Math.floor(inner / lineHeightOf(f))))
  if (width && width.rows.length > 0) {
    const innerW = Math.max(0, width.windowWidth - ENEMY_LIST_PADDING * 2)
    const texts = width.rows.map(enemyListRowText)
    // 幅の判定に使うのは、そのサイズで実際に窓へ出る行だけ（高さあふれで出ない行・「…」に置き換わる最後の行は含めない）
    const mustFit = (f: number): string[] => {
      const v = visibleOf(f)
      return texts.slice(0, texts.length > v ? Math.max(0, v - 1) : v)
    }
    while (
      font > ENEMY_LIST_MIN_FONT &&
      mustFit(font).some((t) => estimateTextWidth(t, font) > innerW)
    ) {
      font--
    }
  }
  return { fontSize: font, lineHeight: lineHeightOf(font), visibleRows: visibleOf(font) }
}

/**
 * 行ブロック（行高 × 出す行数）の上端の、窓の上端からの距離 (px)。status 窓の 1 行目（行高 `SIDE_STATUS_ROW_HEIGHT` の中央に置く）と
 * 1 行目の文字の高さがそろうよう、1 行目を status の行の中央に置く。ブロックが窓の下余白を食うときは上へ詰める
 */
export function enemyListTextTop(windowHeight: number, fit: EnemyListFit): number {
  const aligned = SIDE_STATUS_VERTICAL_PADDING / 2 + (SIDE_STATUS_ROW_HEIGHT - fit.lineHeight) / 2
  const limit = windowHeight - ENEMY_LIST_PADDING - fit.visibleRows * fit.lineHeight
  return Math.min(aligned, Math.max(ENEMY_LIST_PADDING, limit))
}

/**
 * 窓に出す行の文字列。収まらない行が消えるときは、最後に出せる行を「…」にして溢れが分かるようにする
 * （その行の名前は出ない）。全行が収まるときは各行を幅に合わせて返す
 */
export function enemyListLines(
  rows: readonly EnemyListRow[],
  fit: EnemyListFit,
  windowWidth: number
): string[] {
  const lines = rows
    .slice(0, fit.visibleRows)
    .map((r) => fitEnemyListRowText(r, windowWidth, fit.fontSize))
  if (rows.length > fit.visibleRows && lines.length > 0) lines[lines.length - 1] = '…'
  return lines
}

/** 窓の幅に収まるよう末尾を省略した行文字列（先頭の状態表示と「×N」は残し、名前側を削る） */
export function fitEnemyListRowText(
  row: EnemyListRow,
  windowWidth: number,
  fontPx: number
): string {
  const inner = Math.max(0, windowWidth - ENEMY_LIST_PADDING * 2)
  const prefix = enemyListStatusPrefix(row)
  const suffix = row.count > 1 ? ` ×${row.count}` : ''
  const fixedW = estimateTextWidth(prefix + suffix, fontPx)
  if (prefix + suffix === '' || estimateTextWidth(row.name, fontPx) + fixedW <= inner) {
    return prefix + suffix === '' ? fitLabel(row.name, inner, fontPx) : prefix + row.name + suffix
  }
  const name = fitLabel(row.name, Math.max(0, inner - fixedW), fontPx)
  return name === '' ? fitLabel(enemyListRowText(row), inner, fontPx) : prefix + name + suffix
}
