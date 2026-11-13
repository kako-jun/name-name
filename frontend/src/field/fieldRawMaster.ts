/**
 * `buildFieldRaw` のうちマスターデータ(モンスター・味方・呪文・特技・アイテム・状態・売り物)の部分 (#1127 / 親 #1096 S3d)。純関数。
 * 入力の `FieldMasterData` は読み取りのみ(コピーして raw に入れる)。
 *
 * 呪文・特技・どうぐを入れる範囲(設計 §2-B-8。sit の「最初から使える魔法はない」「魔法はパーティ共通」「刀のアビリティは人物ごと」に合わせる):
 * - spells = いずれかの `[パーティ]` の `覚える` のうち、その味方のレベル(既定 1)以下のものの和集合(`[呪文]` の定義順)
 * - skills = いずれかの `[パーティ]` の `わざ` と、売り物の刀の `わざ` の和集合(`[特技]` の定義順)
 * - items  = `売り物:` を持たない全 `[アイテム]`(定義順)
 */
import { hasOwn, safeAssign } from '../game/ownProperty'
import type { ItemDef, MonsterDef, PartyMemberDef } from '../types'
import type { FieldMasterData } from './fieldNotation'

type Raw = Record<string, unknown>

/** 入力への参照共有を避けるためコピーする */
const copy = <T>(v: T): T => (v === undefined ? v : structuredClone(v))

function put(out: Raw, key: string, v: unknown): void {
  if (v !== undefined) out[key] = v
}

export function monstersRaw(monsters: Readonly<Record<string, MonsterDef>>): Raw {
  const out: Record<string, Raw> = {}
  for (const [id, m] of Object.entries(monsters)) {
    const r: Raw = { name: m.name, hp: m.hp }
    put(r, 'mp', m.mp)
    r.atk = m.atk
    r.def = m.def
    r.agi = m.agi
    r.exp = m.exp
    r.gold = m.gold
    put(r, 'sprite', m.sprite)
    put(r, 'poses', m.poses ? { ...m.poses } : undefined)
    if (m.size) r.size = `${m.size.w}x${m.size.h}`
    put(r, 'scale', m.scale)
    put(r, 'level', m.level)
    put(r, 'actions', copy(m.actions))
    put(r, 'counters', copy(m.counters))
    put(r, 'onDeath', m.onDeath)
    if (m.affinity) {
      const a: Raw = {}
      for (const k of ['weak', 'halve', 'nullify', 'absorb'] as const)
        put(a, k, copy(m.affinity[k]))
      r.affinity = a
    }
    if (m.loot) {
      const l: Raw = {}
      put(l, 'drops', copy(m.loot.drops))
      put(l, 'steal', copy(m.loot.steal))
      put(l, 'stealRare', copy(m.loot.stealRare))
      put(l, 'stealLimit', m.loot.stealLimit)
      r.loot = l
    }
    safeAssign(out, id, r)
  }
  return out
}

/** `[パーティ]` のうち一枚絵フィールドの味方(BattleEntity)が読まないキー(記法名) */
const UNUSED_PARTY_KEYS: ReadonlyArray<[string, (m: PartyMemberDef) => boolean]> = [
  ['隊列', (m) => m.row !== undefined],
  ['魔石', (m) => (m.magicites?.length ?? 0) > 0],
  ['装備', (m) => (m.equipment?.length ?? 0) > 0],
  ['ジョブ', (m) => (m.jobs?.length ?? 0) > 0],
]

export function partyRaw(
  party: Readonly<Record<string, PartyMemberDef>>,
  order: readonly string[],
  warnings: string[],
  /** 呪文のマスター（`習得` の呪文の表示名を引く）。省略は id のまま */
  spells: Readonly<Record<string, { name: string }>> = {}
): Raw[] {
  const out: Raw[] = []
  for (const id of order) {
    if (!hasOwn(party, id)) continue
    const m = party[id]
    const r: Raw = { id, name: m.name, hp: m.hp }
    put(r, 'mp', m.mp)
    r.atk = m.atk
    r.def = m.def
    r.agi = m.agi
    put(r, 'sprite', m.sprite)
    put(r, 'poses', m.poses ? { ...m.poses } : undefined)
    put(r, 'character', m.character)
    put(r, 'form', m.form)
    put(r, 'weapon', m.weapon)
    // レベルアップ (#206): 経験値表があるときだけ（成長・初期 Lv・習得は表と一緒に渡す。表が無ければ経験値で何も起きない）
    if (m.expTable !== undefined) {
      const lu: Raw = {}
      put(lu, 'level', m.level)
      put(lu, 'expTable', m.expTable ? [...m.expTable] : undefined)
      put(lu, 'growth', m.growth)
      if (m.learns && m.learns.length > 0)
        lu.learns = m.learns.map((l) => ({
          level: l.level,
          spell: l.spell,
          ...(hasOwn(spells, l.spell) ? { name: spells[l.spell].name } : {}),
        }))
      r.levelUp = lu
    }
    out.push(r)
    for (const [label, has] of UNUSED_PARTY_KEYS) {
      if (has(m))
        warnings.push(`[パーティ ${id}] の ${label} は一枚絵フィールドでは使えません（無視します）`)
    }
  }
  return out
}

/** 優先順の並び(`order`)のうち `wanted` に入るものだけを、`order` の順で返す */
const inOrder = (order: readonly string[], wanted: ReadonlySet<string>): string[] =>
  order.filter((id) => wanted.has(id))

export function spellsRaw(
  master: FieldMasterData,
  party: readonly PartyMemberDef[],
  warnings: string[]
): Raw[] {
  const wanted = new Set<string>()
  for (const m of party) {
    const level = m.level ?? 1
    for (const l of m.learns ?? []) {
      if (l.level > level) continue
      if (!hasOwn(master.spells, l.spell)) {
        warnings.push(
          `[パーティ ${m.id}] の 覚える '${l.spell}' が [呪文] にありません（省きます）`
        )
        continue
      }
      wanted.add(l.spell)
    }
  }
  return inOrder(Object.keys(master.spells), wanted).map((id) => {
    const s = master.spells[id]
    const r: Raw = { id, name: s.name, mp: s.mp, target: s.target }
    put(r, 'effect', s.effect)
    put(r, 'builtin', s.builtin)
    put(r, 'description', s.description)
    put(r, 'multiTarget', s.multiTarget)
    put(r, 'tags', copy(s.tags))
    put(r, 'fieldUse', s.fieldUse)
    return r
  })
}

export function skillsRaw(
  master: FieldMasterData,
  party: readonly PartyMemberDef[],
  bladeAbilities: readonly string[],
  warnings: string[]
): Raw[] {
  const wanted = new Set<string>(bladeAbilities)
  for (const m of party) {
    for (const a of m.abilities ?? []) {
      if (!hasOwn(master.skills, a)) {
        warnings.push(`[パーティ ${m.id}] の わざ '${a}' が [特技] にありません（省きます）`)
        continue
      }
      wanted.add(a)
    }
  }
  return inOrder(Object.keys(master.skills), wanted).map((id) => {
    const s = master.skills[id]
    const r: Raw = { id, name: s.name, target: s.target }
    put(r, 'effect', s.effect)
    put(r, 'builtin', s.builtin)
    return r
  })
}

export function itemsRaw(items: Readonly<Record<string, ItemDef>>): Raw[] {
  const out: Raw[] = []
  for (const [id, it] of Object.entries(items)) {
    if (it.shopKind !== undefined) continue
    const r: Raw = { id, name: it.name }
    put(r, 'effect', it.effect)
    put(r, 'builtin', it.builtin)
    put(r, 'count', it.count)
    put(r, 'description', it.description)
    put(r, 'category', it.category)
    put(r, 'fieldUse', it.fieldUse)
    if (it.key === true) r.key = true
    out.push(r)
  }
  return out
}

export function statusesRaw(statuses: FieldMasterData['statuses']): Raw[] {
  return Object.entries(statuses).map(([id, s]) => {
    const r: Raw = { id, name: s.name }
    for (const k of ['duration', 'tickDamage', 'action', 'reverse', 'cure', 'expire'] as const)
      put(r, k, s[k])
    return r
  })
}

/** 売り物(`売り物:` を持つ `[アイテム]`)。持ち主を味方の解決済み ID にそろえ、いない品は落とす */
export function gearEntriesRaw(
  items: Readonly<Record<string, ItemDef>>,
  party: readonly PartyMemberDef[],
  warnings: string[]
): { entries: Raw[]; unlockFlags: string[] } {
  const entries: Raw[] = []
  const unlockFlags: string[] = []
  for (const [id, it] of Object.entries(items)) {
    if (it.shopKind === undefined) continue
    const label = it.shopKind === 'blade' ? '刀' : '防具'
    const r: Raw = { id, kind: it.shopKind, name: it.name }
    if (it.owner !== undefined) {
      const owner = (
        party.find((m) => m.id === it.owner) ?? party.find((m) => m.character === it.owner)
      )?.id
      if (owner === undefined) {
        warnings.push(
          `${label} '${id}' の持ち主 '${it.owner}' が [パーティ] にいません（この売り物は省きます）`
        )
        continue
      }
      r.owner = owner
    }
    put(r, 'basePrice', it.basePrice)
    put(r, 'price', it.price)
    put(r, 'unlockFlag', it.unlockFlag)
    put(r, 'image', it.image)
    put(r, 'lockedMessage', it.lockedMessage)
    put(r, 'equipBonus', it.equipBonus)
    if (it.abilities && it.abilities.length > 0) r.abilities = [...it.abilities]
    if (it.unlockFlag !== undefined) unlockFlags.push(it.unlockFlag)
    entries.push(r)
  }
  return { entries, unlockFlags }
}
