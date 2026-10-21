/**
 * 装備 (#207)。武器・防具・盾・兜と魔石 (#889) を**同じ装備の宣言**で扱い、戦闘に出る味方の能力値・属性・わざにする純関数群。
 * ブラウザ API にも PixiJS にも触れない。
 *
 * - 宣言: `[アイテム id]` の `種別`（武器 / 防具 / 盾 / 兜）・`装備時`（能力値に足す。魔石と同じ書式 `atk+5, def+2`）・`装備可`・`属性`（属性防御）・`わざ`（装備すると「わざ」に出る特技 id）。
 *   `[パーティ]` の `装備:`（初期装備。`[アイテム]` と `[魔石]` の id を混在で書ける。`魔石:` の後ろに続く）と `装備枠:`（枠の種類の列。同じ種類を並べれば複数枠。省略は 武器・防具・盾・兜 が各 1）
 * - 枠: 種類ごと。魔石の枠は従来どおり `魔石枠:`（無ければ `装備枠:` の `魔石` の数、それも無ければ 1）。枠を超える分・宣言の無い id・装備できない種別・`装備可` に入っていない味方・同じ品の重複は警告して捨てる
 * - 属性の層: 魔石 → アイテムの順に積み、**合計 2 層まで**（`magicite.ts` の `elementLayers`）。アイテムの属性は耐性にだけ効き、通常攻撃の属性にはならない
 * - 武器の `属性`: 現在は無視する（警告）。将来の「武器自体の属性（攻撃の属性）」のために予約。防具・盾・兜の `属性` だけが耐性になる
 * - ジョブ (#740): 就いているジョブの `装備時`（能力値）と `属性`（耐性の層。魔石 → 装備品 → ジョブの順で合計 2 層まで）を、同じ結果に足す（`job.ts`）。ジョブは装備の枠や id の入口とは別（`roster.currentJobs`）
 * - わざ: 装備中の**どの装備品の** `わざ`（武器でも防具でも）も、装備した順に並べる（`fieldBattle.ts` が、メンバー自身の `わざ:` の後ろへ重複なく足して候補窓を作る）
 * - 装備の変更の計算（`equipItem` / `unequipItem`）: 新しい装備列を返す純関数。所持品の有無・メニュー UI・保存は #738 / #880 / #881 の領分で、
 *   エンジンは「いま誰が何を装備しているか」（`roster.equipment`）を入力に受けるだけ
 *
 * 何も宣言していない・何も装備していない味方は、ここを通っても `BattleEntity` が従来と同一（キーも増えない）。
 */
import type { ItemDef, JobDef, MagiciteDef, PartyMemberDef } from '../types'
import {
  addBonus,
  DEFAULT_MAGICITE_SLOTS,
  elementLayers,
  layersToAffinity,
  MAX_MAGICITE_SLOTS,
  parseStatBonus,
  resolveEquipped,
  slotCount,
  totalEquipBonus,
  type MagiciteRoster,
  type MemberMagicite,
  type StatBonus,
} from './magicite'
import { resolveMemberJob, type JobRoster } from './job'
import { hasOwn } from './ownProperty'

/** アイテムの装備枠の種類 */
export type EquipSlotKind = '武器' | '防具' | '盾' | '兜'

/** 装備枠の種類（並びは既定の枠の並び） */
export const ITEM_SLOT_KINDS: readonly EquipSlotKind[] = ['武器', '防具', '盾', '兜']

/** 魔石の枠の種類名（`装備枠:` に書くと魔石の枠の数になる） */
export const STONE_SLOT_KIND = '魔石'

/** 1 つの種類の枠の上限。誤記（`装備枠:` に同じ種類を大量に書く）で巨大な配列を作らないための安全弁 */
export const MAX_SLOTS_PER_KIND = 8

const KIND_ALIASES: Readonly<Record<string, EquipSlotKind>> = {
  武器: '武器',
  weapon: '武器',
  防具: '防具',
  鎧: '防具',
  armor: '防具',
  armour: '防具',
  盾: '盾',
  shield: '盾',
  兜: '兜',
  かぶと: '兜',
  helm: '兜',
  helmet: '兜',
}

/** `種別` / `装備枠` の語 → 装備枠の種類。装備できない種別（回復・鍵など）は undefined */
export function slotKindOf(raw: string | undefined): EquipSlotKind | undefined {
  if (typeof raw !== 'string') return undefined
  const key = raw.trim().toLowerCase()
  return hasOwn(KIND_ALIASES, key) ? KIND_ALIASES[key] : undefined
}

/** 装備中のアイテム 1 つ（どの種類の枠に入ったか） */
export interface EquippedItem {
  kind: EquipSlotKind
  item: ItemDef
}

/** 戦闘への組み立て用: 味方 1 人の装備まわりの結果（魔石まわりの結果に、アイテムとわざを足したもの） */
export interface MemberEquipment extends MemberMagicite {
  /** 就いているジョブ (#740)。ジョブを持たない味方は undefined */
  job?: JobDef
  /** 装備中のアイテム（装備した順） */
  items: EquippedItem[]
  /** 装備中のアイテムの `わざ`（特技 id。装備した順・重複なし） */
  abilities: string[]
}

/** 装備まわりの入力（`FieldBattleRoster` の一部。すべて省略可）。魔石の入力（`MagiciteRoster`）に、アイテムのマスターを足したもの */
export interface EquipmentRoster extends MagiciteRoster, JobRoster {
  /** アイテムのマスター（`[アイテム]`）。装備品はここから id で引く */
  items?: Record<string, ItemDef>
}

type MemberDef = Pick<
  PartyMemberDef,
  'id' | 'magicites' | 'magiciteSlots' | 'equipment' | 'equipmentSlots' | 'jobs'
>

/** 枠の種類ごとの枠の数と、魔石の枠の数 */
export interface SlotPlan {
  counts: Record<EquipSlotKind, number>
  stones: number
  warnings: string[]
}

/**
 * 味方の枠の割り当て。`装備枠:` が無ければ 武器・防具・盾・兜 が各 1。あれば書いた種類だけ（同じ種類の数だけ枠）。
 * 魔石の枠は `魔石枠:` が最優先、無ければ `装備枠:` に書いた `魔石` の数、どちらも無ければ `DEFAULT_MAGICITE_SLOTS`
 */
export function slotPlan(
  def: Pick<PartyMemberDef, 'id' | 'magiciteSlots' | 'equipmentSlots'>
): SlotPlan {
  const warnings: string[] = []
  const counts: Record<EquipSlotKind, number> = { 武器: 0, 防具: 0, 盾: 0, 兜: 0 }
  let stoneTokens = 0
  if (def.equipmentSlots === undefined) {
    for (const k of ITEM_SLOT_KINDS) counts[k] = 1
  } else {
    for (const raw of def.equipmentSlots) {
      if (typeof raw === 'string' && raw.trim() === STONE_SLOT_KIND) {
        stoneTokens++
        continue
      }
      const kind = slotKindOf(raw)
      if (!kind) {
        warnings.push(`${def.id}: 装備枠 '${String(raw)}' は種類が分からないため無視した`)
        continue
      }
      counts[kind] = Math.min(MAX_SLOTS_PER_KIND, counts[kind] + 1)
    }
  }
  const stones =
    typeof def.magiciteSlots === 'number'
      ? slotCount(def)
      : stoneTokens > 0
        ? Math.min(MAX_MAGICITE_SLOTS, stoneTokens)
        : DEFAULT_MAGICITE_SLOTS
  return { counts, stones, warnings }
}

/**
 * いま装備している id の列。`roster.equipment`（上書き。空配列は「何も装備しない」）があればそれ、無ければ `魔石:` の後ろに `装備:` を続けたもの。
 * 魔石とアイテムの id が混在する（どちらの宣言かは `resolveMemberEquipment` が引き当てる）
 */
export function equipmentIds(def: MemberDef, roster: EquipmentRoster | undefined): string[] {
  if (roster?.equipment && hasOwn(roster.equipment, def.id)) return [...roster.equipment[def.id]]
  return [...(def.magicites ?? []), ...(def.equipment ?? [])]
}

interface ResolvedIds {
  stones: MagiciteDef[]
  items: EquippedItem[]
  warnings: string[]
}

/** id の列を、魔石とアイテムに振り分けて枠・種別・`装備可`・重複を検査する（捨てた理由は警告に積む） */
function resolveIds(
  def: MemberDef,
  roster: EquipmentRoster | undefined,
  ids: readonly string[]
): ResolvedIds {
  const plan = slotPlan(def)
  const warnings = [...plan.warnings]
  const stoneMaster = roster?.magicites
  const itemMaster = roster?.items
  const stoneIds: string[] = []
  const items: EquippedItem[] = []
  for (const id of ids) {
    const isStone = !!stoneMaster && hasOwn(stoneMaster, id)
    const isItem = !!itemMaster && hasOwn(itemMaster, id)
    if (isStone) {
      // 互換のため魔石を先に引く。両方に同じ id があれば、魔石として扱ったと知らせる
      if (isItem) {
        warnings.push(`${def.id}: '${id}' は [魔石] と [アイテム] の両方にあるため魔石として扱った`)
      }
      stoneIds.push(id)
      continue
    }
    if (!isItem) {
      warnings.push(`${def.id}: '${id}' は [魔石] にも [アイテム] にも宣言が無いため装備できない`)
      continue
    }
    const item = (itemMaster as Record<string, ItemDef>)[id]
    const kind = slotKindOf(item.kind)
    if (!kind) {
      warnings.push(`${def.id}: アイテム '${id}' は種別 '${item.kind}' のため装備できない`)
      continue
    }
    if (items.some((e) => e.item.id === id)) {
      warnings.push(`${def.id}: アイテム '${id}' は重複しているため 2 つ目を無視した`)
      continue
    }
    if (item.equippableBy && item.equippableBy.length > 0 && !item.equippableBy.includes(def.id)) {
      warnings.push(`${def.id}: アイテム '${id}' は装備可に含まれないため装備できない`)
      continue
    }
    const cap = plan.counts[kind]
    if (items.filter((e) => e.kind === kind).length >= cap) {
      warnings.push(
        cap === 0
          ? `${def.id}: 装備枠に ${kind} が無いため '${id}' は装備できない`
          : `${def.id}: 装備枠 ${kind} ${cap} を超えるため '${id}' は装備できない`
      )
      continue
    }
    items.push({ kind, item })
  }
  const equipped = resolveEquipped(
    { id: def.id, magicites: stoneIds, magiciteSlots: plan.stones },
    stoneMaster,
    stoneIds
  )
  return { stones: equipped.stones, items, warnings: [...warnings, ...equipped.warnings] }
}

/**
 * 味方 1 人の装備を解決する。`ids` を渡さなければ `equipmentIds` の列。
 * 能力値のボーナスは魔石の `装備時`・アイテムの `装備時`・`roster.growth`（レベルアップで恒久に得た分）の合計。
 * 何も装備せず成長も層も無ければ、`bonus` / `layers` は空・`affinity` は undefined・`items` / `abilities` は空
 */
export function resolveMemberEquipment(
  def: MemberDef,
  roster: EquipmentRoster | undefined,
  ids?: readonly string[]
): MemberEquipment {
  const r = resolveIds(def, roster, ids ?? equipmentIds(def, roster))
  const warnings = [...r.warnings]
  let bonus: StatBonus = totalEquipBonus(r.stones)
  const itemElements: string[] = []
  const abilities: string[] = []
  for (const { kind, item } of r.items) {
    const parsed = parseStatBonus(item.equipBonus)
    for (const w of parsed.warnings) warnings.push(`${def.id}: アイテム '${item.id}': ${w}`)
    bonus = addBonus(bonus, parsed.bonus)
    if (item.elements && item.elements.length > 0) {
      if (kind === '武器') {
        // 武器の属性は将来の「攻撃の属性」のために予約している。耐性にはしない（炎の剣で炎耐性が付くと誰も思わない）
        warnings.push(
          `${def.id}: 武器 '${item.id}' の属性は現在は無視される（予約。耐性にはならない）`
        )
        warnWeaponElementOnce(item.id)
      } else {
        itemElements.push(...item.elements)
      }
    }
    for (const a of item.abilities ?? []) if (!abilities.includes(a)) abilities.push(a)
  }
  const extra =
    roster?.extraElements && hasOwn(roster.extraElements, def.id)
      ? roster.extraElements[def.id]
      : []
  // ジョブ (#740): 能力値のボーナスと属性の層（最後に積むので、上限を超えたらジョブの層が先に捨てられる）
  const job = resolveMemberJob(def, roster)
  warnings.push(...job.warnings)
  bonus = addBonus(bonus, job.bonus)
  const el = elementLayers(r.stones, [...itemElements, ...extra, ...job.elements])
  const grown = roster?.growth && hasOwn(roster.growth, def.id) ? roster.growth[def.id] : {}
  return {
    stones: r.stones,
    items: r.items,
    abilities,
    ...(job.job ? { job: job.job } : {}),
    bonus: addBonus(bonus, grown),
    layers: el.layers,
    attackElements: el.layers.slice(0, el.stoneLayerCount),
    affinity: layersToAffinity(el.layers),
    warnings: [...warnings, ...el.warnings],
  }
}

/** 武器の `属性` を無視した警告を、同じ id につき 1 度だけ `console.warn` する（戦闘のたびに出さない） */
const warnedWeaponElement = new Set<string>()
function warnWeaponElementOnce(id: string): void {
  if (warnedWeaponElement.has(id)) return
  warnedWeaponElement.add(id)
  console.warn(
    `[name-name] 武器 '${id}' の 属性 は現在は無視される（予約。防具・盾・兜の 属性 は耐性になる）`
  )
}

/** 装備の変更の結果 */
export interface EquipChange {
  /** 変更後の装備の列（失敗したときは変更前のまま） */
  equipment: string[]
  /** 変更できたか。すでに装備している id を足す指示は「変更なし」で ok */
  ok: boolean
  /** 枠が埋まっていて入れ替えた品の id（同じ種類の末尾） */
  replaced?: string
  /** 失敗した理由（`ok: false` のとき） */
  reason?: string
}

/** id の枠の種類（魔石は `魔石`）。宣言が無い・装備できない種別は undefined */
function kindOfId(id: string, roster: EquipmentRoster | undefined): string | undefined {
  if (roster?.magicites && hasOwn(roster.magicites, id)) return STONE_SLOT_KIND
  if (roster?.items && hasOwn(roster.items, id)) return slotKindOf(roster.items[id].kind)
  return undefined
}

/**
 * 装備を付ける（純関数。入力は変えない）。種別・枠・`装備可` を満たすときだけ変更後の列を返す。
 * 同じ種類の枠が全部埋まっていれば、その種類の末尾の品を外して入れ替える（`replaced`）。
 * 所持品にあるか・メニュー UI・保存は呼び出し側（#738 / #880 / #881）の仕事
 */
export function equipItem(
  def: MemberDef,
  roster: EquipmentRoster | undefined,
  current: readonly string[],
  id: string
): EquipChange {
  const before = [...current]
  const fail = (reason: string): EquipChange => ({ equipment: before, ok: false, reason })
  if (before.includes(id)) {
    // 列にあるだけでは「装備済み」にならない。実際に枠に入っている（検査を通っている）ときだけ変更なしで ok
    const now = resolveIds(def, roster, before)
    if (now.stones.some((s) => s.id === id) || now.items.some((i) => i.item.id === id)) {
      return { equipment: before, ok: true }
    }
    return fail(now.warnings.find((w) => w.includes(`'${id}'`)) ?? `'${id}' は装備されていない`)
  }
  const kind = kindOfId(id, roster)
  if (kind === undefined) {
    const known =
      !!roster &&
      ((roster.magicites && hasOwn(roster.magicites, id)) ||
        (roster.items && hasOwn(roster.items, id)))
    return fail(
      known
        ? `'${id}' は種別が装備できないため付けられない`
        : `'${id}' は宣言が無いため付けられない`
    )
  }
  // いま実際に枠に入っている同じ種類の品（枠から溢れて捨てられているものは数えない）
  const now = resolveIds(def, roster, before)
  const sameKind = before.filter(
    (e) =>
      kindOfId(e, roster) === kind &&
      (now.stones.some((s) => s.id === e) || now.items.some((i) => i.item.id === e))
  )
  const plan = slotPlan(def)
  const cap = kind === STONE_SLOT_KIND ? plan.stones : plan.counts[kind as EquipSlotKind]
  if (cap <= 0) return fail(`装備枠に ${kind} が無いため '${id}' は付けられない`)
  let next = before
  let replaced: string | undefined
  if (sameKind.length >= cap) {
    replaced = sameKind[sameKind.length - 1]
    next = before.filter((e) => e !== replaced)
  }
  next = [...next, id]
  const after = resolveIds(def, roster, next)
  const accepted =
    after.stones.some((s) => s.id === id) || after.items.some((i) => i.item.id === id)
  if (!accepted) {
    const reason = after.warnings.find((w) => w.includes(`'${id}'`)) ?? `'${id}' は付けられない`
    return fail(reason)
  }
  return { equipment: next, ok: true, ...(replaced !== undefined ? { replaced } : {}) }
}

/** 装備を外す（純関数。入力は変えない）。装備していない id は変更なし */
export function unequipItem(current: readonly string[], id: string): string[] {
  return current.filter((e) => e !== id)
}
