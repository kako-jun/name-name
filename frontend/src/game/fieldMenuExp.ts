/**
 * フィールドメニューの経験値の表示 (#1186) の計算部。DOM / PixiJS に触れない純粋関数だけを持つ。
 *
 * 元データは味方の `経験値表`（`levelUp.ts` の `LevelUpDef.expTable`。Lv1→2 から順の累計 exp）と、実行時の味方の `exp` / `level`。
 * 経験値表を持たない味方（レベルの仕組みを使わないゲーム・敵）は `undefined` を返し、画面側は何も出さない（架空の値を作らない）。
 * 表示の置き場所（左のパーティ枠・ステータス画面の帯）は `FieldMenuScreen.ts`、有効化は frontmatter `field_menu_exp: on`。
 */
import type { BattleEntity } from './spellDsl'
import { currentExp, currentLevel, levelCap, type LevelUpDef } from './levelUp'
import type { StatusRow } from './fieldMenuScreens'

/** 1 人ぶんの経験値の表示値 */
export interface MenuExp {
  /** 累計の経験値 */
  exp: number
  /** 次のレベルまでに足りない経験値。上限 Lv に達していれば null */
  toNext: number | null
}

/** ステータス画面の帯の見出し */
export const EXP_LABEL = 'けいけんち'
export const NEXT_LABEL = '次のレベルまで'
/** 上限 Lv のときの値 */
export const EXP_AT_CAP = 'MAX'

/**
 * 味方 1 人の経験値の表示値。`def.expTable` が無い・空なら undefined。
 * 現在の Lv と累計 exp は戦闘後の加算（`levelUp.ts` の `applyBattleExp`）と同じ読み方（`currentLevel` / `currentExp`）
 */
export function menuExpOf(
  member: Pick<BattleEntity, 'exp' | 'level'>,
  def: LevelUpDef | undefined
): MenuExp | undefined {
  const table = def?.expTable
  if (!def || !table || table.length === 0) return undefined
  const exp = currentExp(member, def)
  const lv = currentLevel(member, def)
  if (lv >= levelCap(def)) return { exp, toNext: null }
  return { exp, toNext: Math.max(0, table[lv - 1] - exp) }
}

/** 「次のレベルまで」の値の文字列（上限 Lv は `MAX`） */
export function nextValue(e: MenuExp): string {
  return e.toNext === null ? EXP_AT_CAP : String(e.toNext)
}

/** ステータス画面の帯に載せる行（経験値・次のレベルまで）。表示値が無ければ空 */
export function expStatusRows(e: MenuExp | undefined): StatusRow[] {
  if (!e) return []
  return [
    { label: EXP_LABEL, value: String(e.exp) },
    { label: NEXT_LABEL, value: nextValue(e) },
  ]
}

/** `FieldMenuPartyView` に展開する欄。表示値が無ければ空オブジェクト（`exp: undefined` を作らない） */
export function menuExpField(
  member: Pick<BattleEntity, 'exp' | 'level'>,
  def: LevelUpDef | undefined
): { exp?: MenuExp } {
  const e = menuExpOf(member, def)
  return e ? { exp: e } : {}
}
