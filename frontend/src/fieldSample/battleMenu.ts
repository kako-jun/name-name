/**
 * フィールドサンプルの戦闘に渡す候補窓データの組み立て (#890)。DOM / PixiJS に依存しない純関数。
 */
import type { BattleMenuData } from '../game/battleMenu'
import type { FieldSampleConfig } from './config'

/**
 * 呪文は味方全員共通なので味方 id ごとに別インスタンスで複製し、アイテムは戦闘ごとに複製する
 * （BattleScreen が使用時に count を書き換えるため。設定そのものは書き換えさせない＝次の戦闘は設定の所持数から始まる）。
 * 呪文もアイテムも空なら menu 無し（undefined）を返す＝じゅもん・どうぐの窓は開かない
 */
export function buildBattleMenu(
  config: Pick<FieldSampleConfig, 'party' | 'spells' | 'items'>
): BattleMenuData | undefined {
  if (config.spells.length === 0 && config.items.length === 0) return undefined
  return {
    spells: Object.fromEntries(
      config.party.map((p) => [p.id, config.spells.map((x) => ({ ...x }))])
    ),
    items: config.items.map((x) => ({ ...x })),
  }
}
