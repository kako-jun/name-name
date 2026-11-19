/**
 * フィールドメニューの手のカーソル（指）の階層表示と置き方 (#1223)。純粋関数。
 *
 * - 階層をまたぐカーソルは全部指。いまの階層の指は常時表示、確定済みの上の階層の指は選んだ位置に点滅で残す。
 *   戻ると上の階層の指が常時表示に戻る（いまのフォーカスから列を作り直すだけで成り立つ）。
 * - 指と文字（または画像）の間隔は全メニュー・全階層で `FIELD_HAND_GAP_RATIO` の一つだけ。
 *   指の右端 = 文字の左端 − 間隔。寸法はテーマに持たせない（ここが一箇所の正本）。
 */
import { HAND_HEIGHT, HAND_WIDTH } from './battleMenuLayout'
import { baseFocus, type NavFocus, type ScreenKind, type ScreenNav } from './fieldMenuScreens'

/** 指の右端と文字・画像の左端の間隔（手の高さに対する割合）。全メニュー・全階層で共通 */
export const FIELD_HAND_GAP_RATIO = 0.3
/** 点滅の周期 (ms)。前半は見え、後半は薄くなる */
export const FIELD_HAND_BLINK_PERIOD_MS = 800
/** 点滅で薄いときの不透明度 */
export const FIELD_HAND_BLINK_DIM_ALPHA = 0.15

/** 指を出す 1 か所。`solid` = 常時表示（いまの階層）、false = 点滅（確定済みの上の階層） */
export interface FieldHandMark {
  level: NavFocus
  index: number
  solid: boolean
}

/** 指を置く基準。`left` = 指が指す文字（または画像）の左端、`cy` = 文字の縦中心、`height` = 手の高さ */
export interface FieldHandAnchor {
  left: number
  cy: number
  height: number
}

/** 階層の選択位置 */
function indexOf(level: NavFocus, nav: ScreenNav): number {
  switch (level) {
    case 'tab':
      return nav.tab
    case 'party':
      return nav.party
    case 'list':
      return nav.list
    case 'target':
      return nav.target
    case 'confirm':
      return nav.confirm
  }
}

/** 画面上の置き場の鍵。使う相手（target）は左のパーティ枠と同じ場所 */
export function fieldHandSlotKey(level: NavFocus, index: number): string {
  return `${level === 'target' ? 'party' : level}:${index}`
}

/**
 * 項目画面の指の列。最初の階層 → 一覧 → （使う相手 | 確認窓）のうち、いまのフォーカスまでの階層を並べ、
 * いまのフォーカスだけ常時表示、上の階層は点滅。同じ場所に常時と点滅が重なるときは常時だけ。
 */
export function fieldMenuHandMarks(kind: ScreenKind, nav: ScreenNav): FieldHandMark[] {
  const base = baseFocus(kind)
  const levels: NavFocus[] = [base]
  if (nav.focus !== base) {
    if (base !== 'list') levels.push('list')
    if (nav.focus !== 'list') levels.push(nav.focus)
  }
  const marks = levels.map((level) => ({
    level,
    index: indexOf(level, nav),
    solid: level === nav.focus,
  }))
  const solidKeys = new Set(
    marks.filter((m) => m.solid).map((m) => fieldHandSlotKey(m.level, m.index))
  )
  return marks.filter((m) => m.solid || !solidKeys.has(fieldHandSlotKey(m.level, m.index)))
}

/** 手の幅（高さから。`HAND_WIDTH:HAND_HEIGHT` の比） */
export function fieldHandWidth(height: number): number {
  return (height * HAND_WIDTH) / HAND_HEIGHT
}

/** 指と文字の間隔 (px) */
export function fieldHandGap(height: number): number {
  return height * FIELD_HAND_GAP_RATIO
}

/** 指の置き場の幅（手の幅 + 間隔）。行頭・枠の左にこれだけ空ければ指が文字に重ならない */
export function fieldHandLane(height: number): number {
  return fieldHandWidth(height) + fieldHandGap(height)
}

/** 手の枠の左端 x（指の右端 = `contentLeft` − 間隔） */
export function fieldHandLeft(contentLeft: number, height: number): number {
  return contentLeft - fieldHandLane(height)
}

/** 点滅の不透明度（経過時間から。周期の前半 1、後半 `FIELD_HAND_BLINK_DIM_ALPHA`） */
export function fieldHandBlinkAlpha(elapsedMs: number): number {
  const p = FIELD_HAND_BLINK_PERIOD_MS
  const t = ((elapsedMs % p) + p) % p
  return t < p / 2 ? 1 : FIELD_HAND_BLINK_DIM_ALPHA
}
