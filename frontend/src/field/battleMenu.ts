/**
 * 一枚絵フィールドの戦闘に渡す候補窓データの組み立て (#890)。DOM / PixiJS に依存しない純関数。
 */
import type { BattleMenuData, BattleSkillEntry } from '../game/battleMenu'
import type { FieldConfig } from './config'
import { skillsForMember, type GearShopConfig, type GearState } from '../game/gearShop'

/**
 * 呪文・わざ (#873) は味方全員共通なので味方 id ごとに別インスタンスで複製し、アイテムは戦闘ごとに複製する
 * （BattleScreen が使用時に count を書き換えるため。設定そのものは書き換えさせない。`items` の count は呼び出し側が持ち越した所持数を入れて渡す＝#1021 以降は戦闘後の残数が次の戦闘へ続く）。
 * 呪文・わざ・アイテムのどれも空なら menu 無し（undefined）を返す＝候補窓は開かない。
 * わざが空のときは `skills` キーを出さない（従来の形のまま）
 */
export function buildBattleMenu(
  config: Pick<FieldConfig, 'party' | 'spells' | 'items'> & {
    skills?: readonly BattleSkillEntry[]
    /** 刀の売り物の定義と、持ち越した持っている品（買った分も宝箱などで手に入れた分も含む）・装備中の刀 (#881 段階3)。あれば「わざ」は味方ごとに装備中の刀のアビリティで絞る。省略は従来どおり全員同じ */
    gear?: { shop: GearShopConfig; state: GearState }
  }
): BattleMenuData | undefined {
  const skills = config.skills ?? []
  const skillsOf = (id: string): BattleSkillEntry[] =>
    config.gear ? skillsForMember(skills, config.gear.shop, config.gear.state, id) : [...skills]
  const skillRows = config.party
    .map((p) => [p.id, skillsOf(p.id).map((x) => ({ ...x }))] as const)
    .filter(([, rows]) => rows.length > 0)
  // たいせつなもの (#880 `key: true`) は戦闘の候補窓に出さない
  const items = config.items.filter((x) => !x.key)
  if (config.spells.length === 0 && items.length === 0 && skillRows.length === 0) return undefined
  return {
    spells: Object.fromEntries(
      config.party.map((p) => [p.id, config.spells.map((x) => ({ ...x }))])
    ),
    ...(skillRows.length > 0 ? { skills: Object.fromEntries(skillRows) } : {}),
    items: items.map((x) => ({ ...x })),
  }
}
