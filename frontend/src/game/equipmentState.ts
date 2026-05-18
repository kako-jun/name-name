/**
 * 装備状態の純粋関数モジュール (#207)。
 *
 * 装備の付け外しは「不変更新（新しいインスタンスを返す）」で行い、
 * runtime 側（RaycastRenderer / TopDownRenderer）は状態オブジェクト
 * （`Map<memberId, MemberEquipment>`）を保持するだけにする。
 *
 * 装備の効果は `getEquipmentBonus` で 4 スロットの bonus 合計を返し、
 * 戦闘エンティティ構築時に atk/def に焼き込む。BattleEntity 自体は
 * 装備を知らない（既存挙動を変えないため）。
 */
import type { ItemDef, PartyMemberDef } from '../types'

/** 装備スロット名（英語正規化済み） */
export type EquipmentSlot = 'weapon' | 'armor' | 'shield' | 'helmet'

/** 装備可能な全スロット（4 つ） */
export const ALL_EQUIPMENT_SLOTS: ReadonlyArray<EquipmentSlot> = [
  'weapon',
  'armor',
  'shield',
  'helmet',
]

/**
 * 1 メンバーの装備状態。slot キーに対応する item_id を入れる。
 * スロットが空のときはキー自体を持たない（undefined）。
 */
export type MemberEquipment = Partial<Record<EquipmentSlot, string>>

/** 装備ボーナスの合計（4 スロット分） */
export interface EquipmentBonus {
  atk: number
  def: number
}

// `string` で受けて narrowing するため Set の要素型は `string` で宣言する (review N7)。
// `isEquipmentSlot(slot: string)` の引数を型エラーなしで通すための意図的な型注釈。
const SLOT_SET: ReadonlySet<string> = new Set<EquipmentSlot>(ALL_EQUIPMENT_SLOTS)

function isEquipmentSlot(slot: string): slot is EquipmentSlot {
  return SLOT_SET.has(slot)
}

/**
 * パーティメンバー定義の `equip` フィールドから初期装備を構築する。
 * 未知スロット名（タイポや誤データ）は警告ログのみ出して捨てる。
 */
export function initialEquipmentFromMember(member: PartyMemberDef): MemberEquipment {
  const out: MemberEquipment = {}
  const equip = member.equip
  if (!equip) return out
  for (const [slot, itemId] of Object.entries(equip)) {
    if (!isEquipmentSlot(slot)) {
      // 未知スロットは無視（parser 側で正規化済みなので通常は来ない）
      console.warn(
        `[equipmentState] unknown slot '${slot}' in initial equip for member '${member.id}', skipping`
      )
      continue
    }
    if (typeof itemId === 'string' && itemId.length > 0) {
      out[slot] = itemId
    }
  }
  return out
}

/**
 * 指定スロットにアイテムを装備した新しい equipment を返す。
 * 既存装備は上書き（DQ4 仕様: 同スロット強制入れ替え、後で「外す」も可能）。
 */
export function equipItem(
  equipment: MemberEquipment,
  slot: EquipmentSlot,
  itemId: string
): MemberEquipment {
  return { ...equipment, [slot]: itemId }
}

/**
 * 指定スロットの装備を外した新しい equipment を返す。
 * 既に空のスロットは元参照をそのまま返す（参照等価で「変更無し」を判定可能） (review N1)。
 */
export function unequipItem(equipment: MemberEquipment, slot: EquipmentSlot): MemberEquipment {
  if (equipment[slot] === undefined) return equipment
  const next: MemberEquipment = { ...equipment }
  delete next[slot]
  return next
}

/**
 * 指定スロットに装備中のアイテム定義を取り出す。
 * masterItems に存在しない / 未装備のときは null。
 */
export function getEquippedItem(
  equipment: MemberEquipment,
  slot: EquipmentSlot,
  masterItems: Record<string, ItemDef>
): ItemDef | null {
  const itemId = equipment[slot]
  if (!itemId) return null
  const item = masterItems[itemId]
  return item ?? null
}

/**
 * 4 スロットの装備ボーナス（atk/def）を合計する。
 * 未装備スロット、master に存在しないアイテム ID は 0 扱い。
 * atk_bonus / def_bonus は負値も許容（呪いの装備の余地）。
 */
export function getEquipmentBonus(
  equipment: MemberEquipment,
  masterItems: Record<string, ItemDef>
): EquipmentBonus {
  let atk = 0
  let def = 0
  for (const slot of ALL_EQUIPMENT_SLOTS) {
    const item = getEquippedItem(equipment, slot, masterItems)
    if (!item) continue
    if (typeof item.atk_bonus === 'number') atk += item.atk_bonus
    if (typeof item.def_bonus === 'number') def += item.def_bonus
  }
  return { atk, def }
}

/**
 * 指定メンバーが指定スロットに装備可能なアイテム一覧を返す。
 * フィルタ条件:
 *   - `equip_slot === slot`
 *   - `equippable_by` が未指定 / 空配列 → 誰でも装備可
 *   - そうでなければ memberId を含む場合のみ
 * 戻り値は安定順（masterItems の Object.values 順）で、UI が再ソートする想定。
 */
export function getEquippableItems(
  memberId: string,
  slot: EquipmentSlot,
  masterItems: Record<string, ItemDef>
): ItemDef[] {
  const out: ItemDef[] = []
  for (const item of Object.values(masterItems)) {
    if (item.equip_slot !== slot) continue
    const restricted = item.equippable_by
    if (restricted && restricted.length > 0 && !restricted.includes(memberId)) continue
    out.push(item)
  }
  return out
}
