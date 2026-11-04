/**
 * フィールドサンプルの戦闘に渡す候補窓データの組み立て (#890)。DOM / PixiJS に依存しない純関数。
 */
import type { BattleMenuData, BattleSkillEntry } from '../game/battleMenu'
import type { FieldSampleConfig } from './config'

/**
 * 呪文・わざ (#873) は味方全員共通なので味方 id ごとに別インスタンスで複製し、アイテムは戦闘ごとに複製する
 * （BattleScreen が使用時に count を書き換えるため。設定そのものは書き換えさせない。`items` の count は呼び出し側が持ち越した所持数を入れて渡す＝#1021 以降は戦闘後の残数が次の戦闘へ続く）。
 * 呪文・わざ・アイテムのどれも空なら menu 無し（undefined）を返す＝候補窓は開かない。
 * わざが空のときは `skills` キーを出さない（従来の形のまま）
 */
export function buildBattleMenu(
  config: Pick<FieldSampleConfig, 'party' | 'spells' | 'items'> & {
    skills?: readonly BattleSkillEntry[]
  }
): BattleMenuData | undefined {
  const skills = config.skills ?? []
  // たいせつなもの (#880 `key: true`) は戦闘の候補窓に出さない
  const items = config.items.filter((x) => !x.key)
  if (config.spells.length === 0 && items.length === 0 && skills.length === 0) return undefined
  return {
    spells: Object.fromEntries(
      config.party.map((p) => [p.id, config.spells.map((x) => ({ ...x }))])
    ),
    ...(skills.length > 0
      ? {
          skills: Object.fromEntries(
            config.party.map((p) => [p.id, skills.map((x) => ({ ...x }))])
          ),
        }
      : {}),
    items: items.map((x) => ({ ...x })),
  }
}
