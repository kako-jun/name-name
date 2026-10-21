/**
 * 戦闘画面サンプル (#749) の設定 JSON の装備 (#207) と魔石 (#889) の味方への反映。純粋関数のみ（ブラウザ API に触れない）。
 *
 * - `gear`: `[アイテム id]` の装備品と同じキーの配列（id / name / kind / equipBonus / equippableBy / elements / abilities）。`kind` は 武器 / 防具 / 盾 / 兜
 * - `jobs`（#740）: `[ジョブ id]` と同じキーの配列（id / name / description / equipBonus / elements）。`party[].jobs`（就けるジョブの id の配列。先頭が最初のジョブ）と
 *   `party[].job`（いま就いているジョブの id。省略は `jobs` の先頭、`''` はジョブ無し）で味方に就かせ、`job.ts` で能力値・耐性に反映する
 * - `party[].equipment`（装備する id の配列。`gear` と `magicites` の id を混在で書ける）・`party[].equipmentSlots`（枠の種類の列。省略は 武器・防具・盾・兜 が各 1）・
 *   `party[].magicites` / `party[].magiciteSlots`（#889）・`party[].abilities`（固定の「わざ」の特技 id。`skills` から引く）を読み、
 *   本編と同じ `equipment.ts` で能力値・耐性・通常攻撃の属性を味方に反映し、候補窓の「しょうかん」と「わざ」の行を作る
 */
import type { ItemDef, JobDef, MagiciteDef } from '../types'
import type { BattleSkillEntry, BattleSummonEntry } from '../game/battleMenu'
import type { SkillExecution } from '../game/battleEngine'
import { normalizeAttrId } from '../game/affinity'
import { resolveMemberEquipment } from '../game/equipment'
import { applyMemberMagicite, summonEntries } from '../game/magicite'
import type { BattleEntity } from '../game/spellDsl'

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((a) => typeof a !== 'string')) return null
  return (v as string[]).map((a) => a.trim()).filter((a) => a !== '')
}

/** 設定 JSON の gear を検証する。`id` と `name` は必須、`kind` の既定は 武器。parser と同じく属性は正規化・重複排除して最大 2 つ */
export function parseGear(raw: unknown): ParseResult<Record<string, ItemDef>> {
  if (raw === undefined) return { ok: true, value: {} }
  if (!Array.isArray(raw)) return { ok: false, error: 'gear は配列である必要があります' }
  const out: Record<string, ItemDef> = {}
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i]
    const path = `gear[${i}]`
    if (!isRecord(r)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
    for (const f of ['id', 'name'] as const) {
      if (typeof r[f] !== 'string' || r[f].trim() === '') {
        return { ok: false, error: `${path}.${f} は空でない文字列である必要があります` }
      }
    }
    for (const f of ['kind', 'equipBonus'] as const) {
      if (r[f] !== undefined && typeof r[f] !== 'string') {
        return { ok: false, error: `${path}.${f} は文字列である必要があります` }
      }
    }
    const elements: string[] = []
    if (r.elements !== undefined) {
      const list = stringList(r.elements)
      if (!list) return { ok: false, error: `${path}.elements は文字列の配列である必要があります` }
      for (const e of list) {
        const id = normalizeAttrId(e)
        if (id !== '' && id !== '無属性' && id !== 'none' && !elements.includes(id)) {
          elements.push(id)
        }
      }
      if (elements.length > 2) {
        return { ok: false, error: `${path}.elements は最大 2 つまでです` }
      }
    }
    const lists: Partial<Record<'equippableBy' | 'abilities', string[]>> = {}
    for (const f of ['equippableBy', 'abilities'] as const) {
      if (r[f] === undefined) continue
      const list = stringList(r[f])
      if (!list) return { ok: false, error: `${path}.${f} は文字列の配列である必要があります` }
      if (list.length > 0) lists[f] = list
    }
    const text = (f: string): string | undefined => {
      const v = r[f]
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
    }
    const id = (r.id as string).trim()
    out[id] = {
      id,
      name: (r.name as string).trim(),
      kind: text('kind') ?? '武器',
      ...(text('equipBonus') !== undefined ? { equipBonus: text('equipBonus') } : {}),
      ...(lists.equippableBy ? { equippableBy: lists.equippableBy } : {}),
      ...(elements.length > 0 ? { elements } : {}),
      ...(lists.abilities ? { abilities: lists.abilities } : {}),
    }
  }
  return { ok: true, value: out }
}

/** 設定 JSON の jobs を検証する (#740)。`id` と `name` は必須。parser と同じく属性は正規化・重複排除して最大 2 つ */
export function parseJobs(raw: unknown): ParseResult<Record<string, JobDef>> {
  if (raw === undefined) return { ok: true, value: {} }
  if (!Array.isArray(raw)) return { ok: false, error: 'jobs は配列である必要があります' }
  const out: Record<string, JobDef> = {}
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i]
    const path = `jobs[${i}]`
    if (!isRecord(r)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
    for (const f of ['id', 'name'] as const) {
      if (typeof r[f] !== 'string' || r[f].trim() === '') {
        return { ok: false, error: `${path}.${f} は空でない文字列である必要があります` }
      }
    }
    for (const f of ['description', 'equipBonus'] as const) {
      if (r[f] !== undefined && typeof r[f] !== 'string') {
        return { ok: false, error: `${path}.${f} は文字列である必要があります` }
      }
    }
    const elements: string[] = []
    if (r.elements !== undefined) {
      const list = stringList(r.elements)
      if (!list) return { ok: false, error: `${path}.elements は文字列の配列である必要があります` }
      for (const e of list) {
        const id = normalizeAttrId(e)
        if (id !== '' && id !== '無属性' && id !== 'none' && !elements.includes(id)) {
          elements.push(id)
        }
      }
      if (elements.length > 2) {
        return { ok: false, error: `${path}.elements は最大 2 つまでです` }
      }
    }
    const text = (f: string): string | undefined => {
      const v = r[f]
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
    }
    const id = (r.id as string).trim()
    out[id] = {
      id,
      name: (r.name as string).trim(),
      ...(text('description') !== undefined ? { description: text('description') } : {}),
      ...(text('equipBonus') !== undefined ? { equipBonus: text('equipBonus') } : {}),
      ...(elements.length > 0 ? { elements } : {}),
    }
  }
  return { ok: true, value: out }
}

/** 味方ごとの候補窓の行（装備から導いたもの）。装備も魔石も無い味方は含まない */
export interface PartyEquipmentMenus {
  /** 味方 id → 「しょうかん」の行 (#889) */
  summons: Record<string, BattleSummonEntry[]>
  /** 味方 id → 「わざ」の行 (#207。`party[].abilities` の固定のわざ＋装備中のアイテムの `わざ`） */
  skills: Record<string, BattleSkillEntry[]>
}

/**
 * 設定 JSON の `party[]` の装備の項目を、parse 済みの味方 `party`（同じ index）に反映する。
 * `skills` はわざの実行内容（`id` → `SkillExecution`。設定 JSON の `skills`）で、定義の無い id のわざは出ない。
 * `rawParty` が配列でない（既定の味方）なら何もしない
 */
export function applyPartyEquipment(
  rawParty: unknown,
  party: BattleEntity[],
  masters: {
    magicites: Record<string, MagiciteDef>
    gear: Record<string, ItemDef>
    skills: Record<string, SkillExecution>
    /** ジョブの宣言 (#740)。省略は宣言なし */
    jobs?: Record<string, JobDef>
  }
): ParseResult<PartyEquipmentMenus> {
  const menus: PartyEquipmentMenus = { summons: {}, skills: {} }
  if (!Array.isArray(rawParty)) return { ok: true, value: menus }
  for (let i = 0; i < Math.min(rawParty.length, party.length); i++) {
    const r: unknown = rawParty[i]
    if (
      !isRecord(r) ||
      (r.magicites === undefined &&
        r.magiciteSlots === undefined &&
        r.equipment === undefined &&
        r.equipmentSlots === undefined &&
        r.abilities === undefined &&
        r.jobs === undefined &&
        r.job === undefined)
    ) {
      continue
    }
    const path = `party[${i}]`
    const lists: Partial<
      Record<'magicites' | 'equipment' | 'equipmentSlots' | 'abilities' | 'jobs', string[]>
    > = {}
    for (const f of ['magicites', 'equipment', 'equipmentSlots', 'abilities', 'jobs'] as const) {
      if (r[f] === undefined) continue
      const list = stringList(r[f])
      if (!list) return { ok: false, error: `${path}.${f} は文字列の配列である必要があります` }
      lists[f] = list
    }
    if (r.job !== undefined && typeof r.job !== 'string') {
      return { ok: false, error: `${path}.job は文字列である必要があります` }
    }
    let slots: number | undefined
    if (r.magiciteSlots !== undefined) {
      if (
        typeof r.magiciteSlots !== 'number' ||
        !Number.isInteger(r.magiciteSlots) ||
        r.magiciteSlots < 0
      ) {
        return { ok: false, error: `${path}.magiciteSlots は 0 以上の整数である必要があります` }
      }
      slots = r.magiciteSlots
    }
    const entity = party[i]
    const resolved = resolveMemberEquipment(
      {
        id: entity.id,
        ...(lists.magicites ? { magicites: lists.magicites } : {}),
        ...(slots !== undefined ? { magiciteSlots: slots } : {}),
        ...(lists.equipment ? { equipment: lists.equipment } : {}),
        ...(lists.equipmentSlots ? { equipmentSlots: lists.equipmentSlots } : {}),
        ...(lists.jobs ? { jobs: lists.jobs } : {}),
      },
      {
        magicites: masters.magicites,
        items: masters.gear,
        ...(masters.jobs ? { jobs: masters.jobs } : {}),
        ...(typeof r.job === 'string' ? { currentJobs: { [entity.id]: r.job.trim() } } : {}),
      }
    )
    applyMemberMagicite(entity, resolved)
    if (resolved.stones.length > 0) menus.summons[entity.id] = summonEntries(resolved.stones)
    const ids = [...(lists.abilities ?? []), ...resolved.abilities]
    const rows: BattleSkillEntry[] = []
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(masters.skills, id)) continue
      if (rows.some((e) => e.id === id)) continue
      rows.push({ id, ...masters.skills[id] })
    }
    if (rows.length > 0) menus.skills[entity.id] = rows
  }
  return { ok: true, value: menus }
}
