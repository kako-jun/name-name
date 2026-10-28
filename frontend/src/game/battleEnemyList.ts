/**
 * 敵名ウィンドウ (#954) の純粋関数。FF 式に、同名の敵を「名前 ×N」にまとめて縦に並べる。
 * - 表示順は敵の並び順（最初に現れた順。先頭が倒れても残りの順は変わらない）
 * - 倒れた（HP 0 以下）敵は個数から引き、全滅した名前は行ごと消す（薄くしない）
 * - 1 体のときは名前のみ
 */
import { estimateTextWidth, fitLabel } from './battleLayout'

/** 窓の設定値 (#954)。`window` のときだけ窓を出す。未指定・空・不正値は `off` */
export type BattleEnemyListMode = 'off' | 'window'

/** frontmatter `battle_enemy_list` / sample JSON `enemyList` の正規化。不正値は警告して `off` */
export function normalizeBattleEnemyList(raw: string | null | undefined): BattleEnemyListMode {
  if (typeof raw !== 'string' || raw.trim() === '') return 'off'
  const v = raw.trim().toLowerCase()
  if (v === 'window') return 'window'
  console.warn(`battle_enemy_list '${raw}' は window ではないため無効にした`)
  return 'off'
}

export interface EnemyListRow {
  name: string
  count: number
}

/** 名前ごとの生存数。最初に現れた順。生存 0 の名前は含めない */
export function aggregateEnemyList(
  enemies: readonly { name: string; hp: number }[]
): EnemyListRow[] {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const e of enemies) {
    if (!counts.has(e.name)) {
      order.push(e.name)
      counts.set(e.name, 0)
    }
    if (e.hp > 0) counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
  }
  return order
    .filter((n) => (counts.get(n) ?? 0) > 0)
    .map((n) => ({ name: n, count: counts.get(n) as number }))
}

/** 1 行の文字列。1 体は名前のみ、2 体以上は「名前 ×N」 */
export function enemyListRowText(row: EnemyListRow): string {
  return row.count > 1 ? `${row.name} ×${row.count}` : row.name
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
  if (width && width.rows.length > 0) {
    const innerW = Math.max(0, width.windowWidth - ENEMY_LIST_PADDING * 2)
    const texts = width.rows.map(enemyListRowText)
    while (font > ENEMY_LIST_MIN_FONT && texts.some((t) => estimateTextWidth(t, font) > innerW)) {
      font--
    }
  }
  const lineHeight = Math.ceil(font * ENEMY_LIST_LINE_RATIO)
  const visibleRows = Math.min(rows, Math.max(0, Math.floor(inner / lineHeight)))
  return { fontSize: font, lineHeight, visibleRows }
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

/** 窓の幅に収まるよう末尾を省略した行文字列（「×N」は残し、名前側を削る） */
export function fitEnemyListRowText(
  row: EnemyListRow,
  windowWidth: number,
  fontPx: number
): string {
  const inner = Math.max(0, windowWidth - ENEMY_LIST_PADDING * 2)
  const suffix = row.count > 1 ? ` ×${row.count}` : ''
  const suffixW = estimateTextWidth(suffix, fontPx)
  if (suffix === '' || estimateTextWidth(row.name, fontPx) + suffixW <= inner) {
    return suffix === '' ? fitLabel(row.name, inner, fontPx) : row.name + suffix
  }
  const name = fitLabel(row.name, Math.max(0, inner - suffixW), fontPx)
  return name === '' ? fitLabel(enemyListRowText(row), inner, fontPx) : name + suffix
}
