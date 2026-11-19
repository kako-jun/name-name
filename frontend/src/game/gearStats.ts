/**
 * 一枚絵フィールドの装備の能力値 (#1234)。売り物の装備（`gearShop` の刀・防具の `equipBonus`）を、戦闘に出す味方と
 * メニューのステータスの値に足す純関数。DOM / PixiJS に触れない。
 *
 * - 経路: TopDown / Raycast と同じく `resolveMemberEquipment`（装備の検査とボーナスの合計）→ `applyMemberMagicite`（能力値への反映）を通す。
 *   品のマスターは、そうび画面の装備の計算と同じ `gearRoster`（刀 = 武器・防具 = 防具の枠、`owner` が `装備可`）。特例の計算は持たない
 * - 素の値: 一枚絵フィールドの持ち越し中の味方（`partyState`）は**装備を含まない素の値**のまま持つ（セーブもこの値）。
 *   装備込みの値は、戦闘を始めるとき・ステータスを出すときにその都度ここで作る。戦闘後の書き戻しは `removeGearStats` で、
 *   開始時に実際に足した分（`GearStatDelta`）を引いて素の値へ戻す。戦闘ごとに加算が積み上がらず、戦闘中の HP の減り・レベルアップの成長・状態は残る
 * - HP / MP: 最大値が変わった分だけ現在値も動かす（`applyMemberMagicite` と同じ規則。戻すときは逆向き）。装備しただけで回復しない・戦闘のたびに回復しない
 *
 * 売り物の定義が無いゲーム・何も装備していない味方は、ここを通っても値が変わらない（キーも増えない）。
 */
import { resolveMemberEquipment } from './equipment'
import { gearRoster } from './gearMenu'
import type { GearShopConfig } from './gearShop'
import { applyMemberMagicite } from './magicite'
import { hasOwn, safeAssign } from './ownProperty'
import type { BattleEntity } from './spellDsl'

/** 装備の入力。`equipment` は人物 id → 装備している id の列（`RpgSaveState.equipment`。アプリストア・そうびで変わる） */
export interface GearStatsInput {
  /** 売り物の定義（設定の `gearShop`）。無いゲームは undefined（何も足さない） */
  shop: GearShopConfig | undefined
  equipment: Readonly<Record<string, readonly string[]>>
}

/** 開始時に実際に足した分（装備込み − 素の値）。0 に丸めた分などを含めて、戻すときに引く量 */
export interface GearStatDelta {
  maxHp: number
  maxMp: number
  atk: number
  def: number
  agi: number
  /** 装備で通常攻撃の属性・耐性が変わったときの素の値（戻すときに書き戻す）。変わらなければ無い */
  restore?: Pick<BattleEntity, 'attackElements' | 'affinity'>
}

/** 味方 1 人に装備を足した複製と、足した分。渡した味方は書き換えない */
function applyOne(
  base: BattleEntity,
  roster: ReturnType<typeof gearRoster>,
  equipment: GearStatsInput['equipment']
): { entity: BattleEntity; delta: GearStatDelta } {
  const entity = structuredClone(base)
  const ids = hasOwn(equipment, base.id) ? equipment[base.id] : []
  // 人物の定義は id だけ（既定の枠: 武器・防具・盾・兜が各 1）。そうび画面の持ち替え（`memberDef`）と同じ枠で検査する
  applyMemberMagicite(entity, resolveMemberEquipment({ id: base.id }, roster, ids))
  const changedElements =
    entity.attackElements !== base.attackElements || entity.affinity !== base.affinity
  return {
    entity,
    delta: {
      maxHp: entity.maxHp - base.maxHp,
      maxMp: entity.maxMp - base.maxMp,
      atk: entity.atk - base.atk,
      def: entity.def - base.def,
      agi: entity.agi - base.agi,
      ...(changedElements
        ? {
            restore: {
              attackElements: structuredClone(base.attackElements),
              affinity: structuredClone(base.affinity),
            },
          }
        : {}),
    },
  }
}

/**
 * 素の値の味方に装備を足す。戦闘に渡す味方とステータスの表示値はこの結果（両方が同じ値になる）。
 * `deltas` は人物 id → 足した分（`removeGearStats` に渡す）。渡した味方は書き換えない
 */
export function applyGearStats(
  party: readonly BattleEntity[],
  input: GearStatsInput
): { party: BattleEntity[]; deltas: Record<string, GearStatDelta> } {
  const deltas: Record<string, GearStatDelta> = {}
  if (!input.shop) return { party: party.map((p) => structuredClone(p)), deltas }
  const roster = gearRoster(input.shop, {})
  const out = party.map((p) => {
    const r = applyOne(p, roster, input.equipment)
    safeAssign(deltas, p.id, r.delta)
    return r.entity
  })
  return { party: out, deltas }
}

/**
 * 戦闘後の味方（装備込みの値）から、開始時に足した分を引いて素の値へ戻す。`deltas` に無い人物はそのまま。
 * 最大 HP / 最大 MP が戻った分だけ現在値も動かす（倒れている者は 0 のまま。生きている者は HP 1 以上）。
 * 能力値以外（状態・Lv・経験値など）は戦闘後の値のまま。渡した味方は書き換えない
 */
export function removeGearStats(
  party: readonly BattleEntity[],
  deltas: Readonly<Record<string, GearStatDelta>>
): BattleEntity[] {
  return party.map((after) => {
    const m = structuredClone(after)
    if (!hasOwn(deltas, m.id)) return m
    const d = deltas[m.id]
    if (d.maxHp) {
      const maxHp = Math.max(1, m.maxHp - d.maxHp)
      if (m.hp > 0) m.hp = Math.min(maxHp, Math.max(1, m.hp + (maxHp - m.maxHp)))
      m.maxHp = maxHp
    }
    if (d.maxMp) {
      const maxMp = Math.max(0, m.maxMp - d.maxMp)
      m.mp = Math.min(maxMp, Math.max(0, m.mp + (maxMp - m.maxMp)))
      m.maxMp = maxMp
    }
    if (d.atk) m.atk = Math.max(0, m.atk - d.atk)
    if (d.def) m.def = Math.max(0, m.def - d.def)
    if (d.agi) m.agi = Math.max(0, m.agi - d.agi)
    if (d.restore) {
      const { attackElements, affinity } = d.restore
      if (attackElements === undefined) delete m.attackElements
      else m.attackElements = [...attackElements]
      if (affinity === undefined) delete m.affinity
      else m.affinity = structuredClone(affinity)
    }
    return m
  })
}
