/**
 * 戦闘画面サンプル (#749) の設定 JSON の魔石 (#889)。純粋関数のみ（ブラウザ API に触れない）。
 *
 * - `magicites`: `[魔石 id]` と同じキーの配列（id / name / summon / summonId / elements / target / effect / builtin / message / mp / equipBonus / growth / equippableBy）
 * - `beasts`: `[召喚獣 id]` と同じキーの配列（id / name / elements / image / facing / se / imaginary / target / effect / builtin / message）(#750)。魔石・味方の「わざ」（特技）の `summonId` が引く
 * - `party[].magicites`（装備する魔石の id の配列）と `party[].magiciteSlots`（枠の数。既定 1）の味方への反映は、装備 (#207) と一緒に `configEquipment.ts` が行う
 */
import type { MagiciteDef, SummonDef } from '../types'
import { normalizeAttrId } from '../game/affinity'

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((a) => typeof a !== 'string')) return null
  return (v as string[]).map((a) => a.trim()).filter((a) => a !== '')
}

/** 設定 JSON の magicites を検証する。`id` と `name` は必須。parser と同じく属性は正規化・重複排除して最大 2 つ */
export function parseMagicites(raw: unknown): ParseResult<Record<string, MagiciteDef>> {
  if (raw === undefined) return { ok: true, value: {} }
  if (!Array.isArray(raw)) return { ok: false, error: 'magicites は配列である必要があります' }
  const out: Record<string, MagiciteDef> = {}
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i]
    const path = `magicites[${i}]`
    if (!isRecord(r)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
    for (const f of ['id', 'name'] as const) {
      if (typeof r[f] !== 'string' || r[f].trim() === '') {
        return { ok: false, error: `${path}.${f} は空でない文字列である必要があります` }
      }
    }
    for (const f of [
      'summon',
      'summonId',
      'target',
      'effect',
      'builtin',
      'message',
      'equipBonus',
      'growth',
    ] as const) {
      if (r[f] !== undefined && typeof r[f] !== 'string') {
        return { ok: false, error: `${path}.${f} は文字列である必要があります` }
      }
    }
    if (r.mp !== undefined && (typeof r.mp !== 'number' || !Number.isFinite(r.mp) || r.mp < 0)) {
      return { ok: false, error: `${path}.mp は 0 以上の数値である必要があります` }
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
    let equippableBy: string[] | undefined
    if (r.equippableBy !== undefined) {
      const list = stringList(r.equippableBy)
      if (!list)
        return { ok: false, error: `${path}.equippableBy は文字列の配列である必要があります` }
      if (list.length > 0) equippableBy = list
    }
    const text = (f: string): string | undefined => {
      const v = r[f]
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
    }
    const id = (r.id as string).trim()
    out[id] = {
      id,
      name: (r.name as string).trim(),
      ...(text('summon') !== undefined ? { summon: text('summon') } : {}),
      ...(text('summonId') !== undefined ? { summonId: text('summonId') } : {}),
      ...(elements.length > 0 ? { elements } : {}),
      target: text('target') ?? '相手単体',
      ...(text('effect') !== undefined ? { effect: text('effect') } : {}),
      ...(text('builtin') !== undefined ? { builtin: text('builtin') } : {}),
      ...(text('message') !== undefined ? { message: text('message') } : {}),
      ...(typeof r.mp === 'number' && r.mp > 0 ? { mp: Math.floor(r.mp) } : {}),
      ...(text('equipBonus') !== undefined ? { equipBonus: text('equipBonus') } : {}),
      ...(text('growth') !== undefined ? { growth: text('growth') } : {}),
      ...(equippableBy ? { equippableBy } : {}),
    }
  }
  return { ok: true, value: out }
}

/**
 * 設定 JSON の beasts (#750) を検証する。`[召喚獣 id]` と同じキー。`id` と `name` は必須。parser と同じく属性は正規化・重複排除して最大 2 つ、
 * `imaginary` は真偽値（既定 false）。`image` / `se` は素材のパス（空は未指定）。`resolve` があれば設定 JSON の位置からの絶対 URL にする（解決できなければエラー）
 */
export function parseBeasts(
  raw: unknown,
  resolve?: (url: string) => string | null
): ParseResult<Record<string, SummonDef>> {
  if (raw === undefined) return { ok: true, value: {} }
  if (!Array.isArray(raw)) return { ok: false, error: 'beasts は配列である必要があります' }
  const out: Record<string, SummonDef> = {}
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i]
    const path = `beasts[${i}]`
    if (!isRecord(r)) return { ok: false, error: `${path} はオブジェクトである必要があります` }
    for (const f of ['id', 'name'] as const) {
      if (typeof r[f] !== 'string' || r[f].trim() === '') {
        return { ok: false, error: `${path}.${f} は空でない文字列である必要があります` }
      }
    }
    for (const f of ['image', 'facing', 'se', 'target', 'effect', 'builtin', 'message'] as const) {
      if (r[f] !== undefined && typeof r[f] !== 'string') {
        return { ok: false, error: `${path}.${f} は文字列である必要があります` }
      }
    }
    if (r.imaginary !== undefined && typeof r.imaginary !== 'boolean') {
      return { ok: false, error: `${path}.imaginary は真偽値である必要があります` }
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
    const rawFacing = text('facing')?.toLowerCase()
    if (rawFacing !== undefined && !['right', 'left', '右', '左'].includes(rawFacing)) {
      return { ok: false, error: `${path}.facing は right / left（右 / 左）である必要があります` }
    }
    const facing =
      rawFacing === undefined
        ? undefined
        : rawFacing === 'left' || rawFacing === '左'
          ? 'left'
          : 'right'
    const asset = (f: 'image' | 'se'): string | undefined | null => {
      const v = text(f)
      if (v === undefined || !resolve) return v
      return resolve(v)
    }
    const image = asset('image')
    const se = asset('se')
    if (image === null || se === null) {
      return {
        ok: false,
        error: `${path}.${image === null ? 'image' : 'se'} の URL を解決できません`,
      }
    }
    out[id] = {
      id,
      name: (r.name as string).trim(),
      ...(elements.length > 0 ? { elements } : {}),
      ...(image !== undefined ? { image } : {}),
      ...(facing !== undefined ? { facing } : {}),
      ...(se !== undefined ? { se } : {}),
      ...(r.imaginary === true ? { imaginary: true } : {}),
      ...(text('target') !== undefined ? { target: text('target') } : {}),
      ...(text('effect') !== undefined ? { effect: text('effect') } : {}),
      ...(text('builtin') !== undefined ? { builtin: text('builtin') } : {}),
      ...(text('message') !== undefined ? { message: text('message') } : {}),
    }
  }
  return { ok: true, value: out }
}
