/**
 * パーティメンバー + 装備状態から `BattleEntity` を組み立てる純粋関数 (#207)。
 *
 * 装備ボーナス（atk/def）を ATK/DEF に焼き込んだ戦闘エンティティを返す。
 * `BattleEntity` 自体は装備を持たないため、装備が変わるたびに本関数で
 * 作り直す前提（既存の `computeAttackDamage` を変更しない方針）。
 *
 * RaycastRenderer / TopDownRenderer から共通で呼び、テスト可能にするために
 * 純粋関数として切り出している。
 */
import type { ItemDef, PartyMemberDef } from '../types'
import { getEquipmentBonus, type MemberEquipment } from './equipmentState'
import type { BattleEntity } from './spellDsl'

/**
 * パーティメンバー + 装備 + マスターアイテムから `BattleEntity` を組み立てる。
 *
 * - 装備ボーナス（atk/def）を ATK/DEF に加算
 * - master に存在しない装備 ID は 0 扱い（`getEquipmentBonus` の仕様）
 * - HP/MP は maxHp/maxMp と同値（戦闘開始時は満タンとして扱う想定）
 *
 * @param member パーティメンバー定義（master）
 * @param equipment 装備状態（slot → item_id）
 * @param masterItems アイテム master（item_id → ItemDef）
 */
export function buildHeroBattleEntity(
  member: PartyMemberDef,
  equipment: MemberEquipment,
  masterItems: Record<string, ItemDef>
): BattleEntity {
  const bonus = getEquipmentBonus(equipment, masterItems)
  return {
    id: member.id,
    name: member.name,
    hp: member.hp,
    maxHp: member.hp,
    mp: member.mp ?? 0,
    maxMp: member.mp ?? 0,
    atk: member.atk + bonus.atk,
    def: member.def + bonus.def,
    agi: member.agi,
  }
}
