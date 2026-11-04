/**
 * 装備（刀・防具）の所有と購入 (#881 段階1) の純関数。DOM / PixiJS に触れない。UI は段階2、戦闘反映は段階3。
 *
 * - 定義 `GearShopConfig`（設定 JSON の `gearShop`）: 売り物の一覧 `entries`（品の `id` は `[アイテム]` の id）と倍率 `multiplier`（既定 2）。
 *   `kind: 'blade'`（刀。人物ごとに別。`owner` 必須。値段は買うごとに倍々）／`kind: 'armor'`（防具。固定価格 `price`。倍々にならない）。
 *   刀の値段 = `basePrice` × `multiplier`^(その人物の購入済みの刀の本数)。`basePrice` / `price` が無い品は購入不可（値段を創作しない）。
 * - 状態 `GearState`（`RpgSaveState.gear`）: `owned`（人物 id → 購入済みの品 id の集合）と `blade`（人物 id → 装備中の刀 id）。
 *   売却なし（購入済みは戻らない）。他人の刀（`owner` が別の人物）は買えず・装備できない。購入解禁は定義側のフラグ `unlockFlag`（解禁前は購入不可＋理由）。
 * - 装備列（`RpgSaveState.equipment`）の計算は `equipment.ts` の `equipItem` を再利用する（`equipBlade`）。ここで重複実装しない。
 *
 * 売り物の宣言が無いゲーム・メニューを使わないゲームは、この仕組みを通らず従来どおり（セーブにも `gear` キーを書かない）。
 */
import { equipItem, unequipItem, type EquipmentRoster } from './equipment'
import { hasOwn, safeAssign } from './ownProperty'
import type { PartyMemberDef } from '../types'

export type GearKind = 'blade' | 'armor'

/** 刀・防具の倍率の既定（買うごとに倍々） */
export const DEFAULT_PRICE_MULTIPLIER = 2

/** 1 つの売り物 */
export interface GearEntry {
  /** `[アイテム]` の id */
  id: string
  kind: GearKind
  /** 持ち主の人物 id。刀は必須（他人の刀は買えず装備できない）。防具は省略 = 誰でも（購入・所有は人物ごと） */
  owner?: string
  /** 刀の 1 本目の値段（円）。無ければ購入不可（未決） */
  basePrice?: number
  /** 防具の固定価格（円）。無ければ購入不可（未決） */
  price?: number
  /** 購入解禁のフラグ名。省略 = 常に解禁。そのフラグが true になるまで購入不可 */
  unlockFlag?: string
  /** 一覧に出す画像のパス（任意の文字列。sit-by-me の刀マスターから切り出した派生画像を指す想定だが、派生画像は未作成）。省略 = 画像なし（文字のみ）。読み込み・表示は段階2の UI */
  image?: string
}

export interface GearShopConfig {
  /** 刀の倍率（既定 2）。1 以上の有限の数 */
  multiplier: number
  entries: GearEntry[]
}

/** 人物ごとの所有と装備中の刀（セーブ対象） */
export interface GearState {
  /** 人物 id → 購入済みの品 id（買った順・重複なし） */
  owned: Record<string, string[]>
  /** 人物 id → 装備中の刀 id（無ければ刀を装備していない） */
  blade: Record<string, string>
}

export function emptyGearState(): GearState {
  return { owned: {}, blade: {} }
}

export type GearBlockReason =
  | 'unknown' // 売り物にない id
  | 'otherOwner' // 他人の刀
  | 'owned' // 購入済み
  | 'unbuyable' // 値段が未決（基準額・価格なし、または計算できない）
  | 'locked' // 解禁前
  | 'notEnoughGold' // 所持金不足
  | 'notOwned' // 未購入の品は装備できない（装備のみ）

/** 購入可否の判定結果 */
export interface BuyCheck {
  ok: boolean
  /** 値段（円）。分かるときだけ（購入不可の理由が unknown / otherOwner / unbuyable なら無い） */
  price?: number
  reason?: GearBlockReason
  /** 灰色表示の説明に使える日本語の理由 */
  message?: string
}

export interface BuyResult extends BuyCheck {
  /** 購入後の状態（失敗時は入力と同じ内容の複製） */
  state: GearState
  /** 購入後の所持金（失敗時は変わらない） */
  gold: number
}

const MESSAGES: Record<GearBlockReason, string> = {
  unknown: '売っていない品です',
  otherOwner: '他の人の刀は使えません',
  owned: '購入済み',
  unbuyable: '値段が決まっていないため買えません',
  locked: 'まだ買えません',
  notEnoughGold: '所持金が足りません',
  notOwned: 'まだ買っていません',
}

const block = (reason: GearBlockReason, price?: number): BuyCheck => ({
  ok: false,
  reason,
  message: MESSAGES[reason],
  ...(price !== undefined ? { price } : {}),
})

function cloneState(s: GearState): GearState {
  const owned: Record<string, string[]> = {}
  for (const k of Object.keys(s.owned)) safeAssign(owned, k, [...s.owned[k]])
  const blade: Record<string, string> = {}
  for (const k of Object.keys(s.blade)) safeAssign(blade, k, s.blade[k])
  return { owned, blade }
}

/** 売り物の宣言を id で引く */
export function findEntry(cfg: GearShopConfig, id: string): GearEntry | undefined {
  return cfg.entries.find((e) => e.id === id)
}

/** 人物の購入済みの品 id */
export function ownedIds(state: GearState, member: string): readonly string[] {
  return hasOwn(state.owned, member) ? state.owned[member] : []
}

/** 購入済みか */
export function isOwned(state: GearState, member: string, id: string): boolean {
  return ownedIds(state, member).includes(id)
}

/** 人物の購入済みの刀の本数（定義にある刀だけ数える） */
export function ownedBladeCount(cfg: GearShopConfig, state: GearState, member: string): number {
  return ownedIds(state, member).filter((id) => findEntry(cfg, id)?.kind === 'blade').length
}

/** 人物が装備中の刀 id（無ければ undefined） */
export function equippedBlade(state: GearState, member: string): string | undefined {
  return hasOwn(state.blade, member) ? state.blade[member] : undefined
}

/**
 * いま買うときの値段（円）。刀は `basePrice × multiplier^購入済みの刀の本数`（整数に切り捨て）、防具は固定の `price`。
 * 値段が未決（基準額・価格なし）・計算結果が有限の 0 以上の整数にならない（桁あふれ）は undefined
 */
export function priceOf(
  cfg: GearShopConfig,
  state: GearState,
  member: string,
  id: string
): number | undefined {
  const e = findEntry(cfg, id)
  if (!e) return undefined
  if (e.kind === 'armor') return isValidPrice(e.price) ? e.price : undefined
  if (!isValidPrice(e.basePrice)) return undefined
  const p = Math.floor(e.basePrice * Math.pow(cfg.multiplier, ownedBladeCount(cfg, state, member)))
  return Number.isSafeInteger(p) && p >= 0 ? p : undefined
}

const isValidPrice = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * 購入できるか。理由の優先順: 売り物にない → 他人の刀 → 購入済み → 値段未決 → 解禁前 → 所持金不足。
 * `flags` は解禁フラグの現在値（無いフラグは false 扱い）
 */
export function canBuy(
  cfg: GearShopConfig,
  state: GearState,
  member: string,
  id: string,
  gold: number,
  flags: Readonly<Record<string, boolean>> = {}
): BuyCheck {
  const e = findEntry(cfg, id)
  if (!e) return block('unknown')
  if (e.kind === 'blade' && e.owner !== member) return block('otherOwner')
  if (e.kind === 'armor' && e.owner !== undefined && e.owner !== member) return block('otherOwner')
  const price = priceOf(cfg, state, member, id)
  if (isOwned(state, member, id)) return block('owned', price)
  if (price === undefined) return block('unbuyable')
  if (e.unlockFlag !== undefined && !(hasOwn(flags, e.unlockFlag) && flags[e.unlockFlag] === true))
    return block('locked', price)
  if (!(Number.isFinite(gold) && gold >= price)) return block('notEnoughGold', price)
  return { ok: true, price }
}

/** 購入する（純関数。入力は変えない）。成功すれば所有に足し、所持金を値段ぶん引く。買っただけでは装備しない */
export function buy(
  cfg: GearShopConfig,
  state: GearState,
  member: string,
  id: string,
  gold: number,
  flags: Readonly<Record<string, boolean>> = {}
): BuyResult {
  const check = canBuy(cfg, state, member, id, gold, flags)
  const next = cloneState(state)
  if (!check.ok) return { ...check, state: next, gold }
  const list = hasOwn(next.owned, member) ? next.owned[member] : []
  safeAssign(next.owned, member, [...list, id])
  return { ...check, state: next, gold: gold - (check.price as number) }
}

/** 刀の持ち替えの結果 */
export interface EquipBladeResult {
  ok: boolean
  state: GearState
  /** 変更後の装備列（`RpgSaveState.equipment` の当該人物の値）。失敗時は入力のまま */
  equipment: string[]
  reason?: GearBlockReason | 'equipFailed'
  message?: string
}

/**
 * 刀を持ち替える（純関数）。購入済みの自分の刀だけ。装備列は `equipItem`（種別・枠・`装備可`の検査と入れ替え）で計算し、
 * 直前に装備していた刀は列から外れる。`equipItem` が拒否したら状態も変えない
 */
export function equipBlade(
  cfg: GearShopConfig,
  state: GearState,
  def: Pick<
    PartyMemberDef,
    'id' | 'magicites' | 'magiciteSlots' | 'equipment' | 'equipmentSlots' | 'jobs'
  >,
  roster: EquipmentRoster | undefined,
  currentEquipment: readonly string[],
  id: string
): EquipBladeResult {
  const member = def.id
  const before = [...currentEquipment]
  const fail = (reason: EquipBladeResult['reason'], message: string): EquipBladeResult => ({
    ok: false,
    state: cloneState(state),
    equipment: before,
    reason,
    message,
  })
  const e = findEntry(cfg, id)
  if (!e || e.kind !== 'blade') return fail('unknown', MESSAGES.unknown)
  if (e.owner !== member) return fail('otherOwner', MESSAGES.otherOwner)
  if (!isOwned(state, member, id)) return fail('notOwned', MESSAGES.notOwned)
  // 直前の刀を外してから付ける（武器枠が複数あっても「持ち替え」は 1 本だけが装備中）
  const prev = equippedBlade(state, member)
  const base = prev !== undefined && prev !== id ? unequipItem(before, prev) : before
  const r = equipItem(def, roster, base, id)
  if (!r.ok) return fail('equipFailed', r.reason ?? `'${id}' は装備できません`)
  const next = cloneState(state)
  safeAssign(next.blade, member, id)
  return { ok: true, state: next, equipment: r.equipment }
}

/** 解決の結果（セーブから読んだ状態を定義と突き合わせたもの） */
export interface ResolvedGear {
  state: GearState
  warnings: string[]
}

/**
 * セーブから読んだ状態を定義と突き合わせる。定義にない品・他人の刀・重複は警告して捨て、
 * 未購入の刀を「装備中」にしているものは装備中を外す（警告）
 */
export function resolveGear(saved: GearState | undefined, cfg: GearShopConfig): ResolvedGear {
  const warnings: string[] = []
  const state = emptyGearState()
  if (!saved) return { state, warnings }
  for (const member of Object.keys(saved.owned)) {
    const kept: string[] = []
    for (const id of saved.owned[member]) {
      const e = findEntry(cfg, id)
      if (!e) warnings.push(`gear.owned.${member} '${id}' は売り物の定義にありません（無視）`)
      else if (e.owner !== undefined && e.owner !== member)
        warnings.push(`gear.owned.${member} '${id}' は他の人の品です（無視）`)
      else if (e.kind === 'blade' && e.owner === undefined)
        warnings.push(`gear.owned.${member} '${id}' は持ち主のない刀です（無視）`)
      else if (kept.includes(id)) warnings.push(`gear.owned.${member} '${id}' が重複しています`)
      else kept.push(id)
    }
    safeAssign(state.owned, member, kept)
  }
  for (const member of Object.keys(saved.blade)) {
    const id = saved.blade[member]
    if (findEntry(cfg, id)?.kind !== 'blade' || !isOwned(state, member, id))
      warnings.push(`gear.blade.${member} '${id}' は購入済みの刀ではありません（装備中を外す）`)
    else safeAssign(state.blade, member, id)
  }
  return { state, warnings }
}

// ---- 設定 JSON ----

export interface ParsedGearShop {
  /** undefined = 設定に `gearShop` が無い・不正で使えない */
  value?: GearShopConfig
  warnings: string[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 設定 JSON の `gearShop`。`{ multiplier?, entries: [{ id, kind, owner?, basePrice?, price?, unlockFlag?, image? }] }`。
 * 不正な項目は警告して捨てる。`gearShop` が無い（undefined / false / null）はキーなし＝従来どおり。
 * 値段の数値は kako-jun が決めるまで未決（基準額なし = 購入不可）。サンプルに書く値は「仮」
 */
export function parseGearShopConfig(raw: unknown): ParsedGearShop {
  const warnings: string[] = []
  if (raw === undefined || raw === null || raw === false) return { warnings }
  if (!isObj(raw)) {
    warnings.push(`gearShop はオブジェクトにしてください: ${JSON.stringify(raw)}（無視します）`)
    return { warnings }
  }
  let multiplier = DEFAULT_PRICE_MULTIPLIER
  if (raw.multiplier !== undefined) {
    if (
      typeof raw.multiplier === 'number' &&
      Number.isFinite(raw.multiplier) &&
      raw.multiplier >= 1
    )
      multiplier = raw.multiplier
    else
      warnings.push(
        `gearShop.multiplier は 1 以上の数にしてください: ${JSON.stringify(raw.multiplier)}（既定の ${DEFAULT_PRICE_MULTIPLIER} を使います）`
      )
  }
  if (!Array.isArray(raw.entries)) {
    warnings.push('gearShop.entries は配列にしてください（無視します）')
    return { warnings }
  }
  const entries: GearEntry[] = []
  const seen = new Set<string>()
  raw.entries.forEach((it, i) => {
    const where = `gearShop.entries[${i}]`
    if (!isObj(it) || typeof it.id !== 'string' || !it.id) {
      warnings.push(`${where} は id（文字列）が必要です（この項目は省きます）`)
      return
    }
    if (it.kind !== 'blade' && it.kind !== 'armor') {
      warnings.push(`${where} の kind は "blade" か "armor" にしてください（この項目は省きます）`)
      return
    }
    if (seen.has(it.id)) {
      warnings.push(`${where} の id "${it.id}" が重複しています（この項目は省きます）`)
      return
    }
    if (it.owner !== undefined && (typeof it.owner !== 'string' || !it.owner)) {
      warnings.push(`${where}.owner は人物 id（文字列）にしてください（この項目は省きます）`)
      return
    }
    if (it.kind === 'blade' && it.owner === undefined) {
      warnings.push(`${where} の刀には owner（持ち主の人物 id）が必要です（この項目は省きます）`)
      return
    }
    const entry: GearEntry = { id: it.id, kind: it.kind }
    if (it.owner !== undefined) entry.owner = it.owner
    // 値段はキーごとに検査する。刀は basePrice、防具は price だけが意味を持つ（逆は無視して警告）
    const own = it.kind === 'blade' ? 'basePrice' : 'price'
    const other = it.kind === 'blade' ? 'price' : 'basePrice'
    if (it[other] !== undefined)
      warnings.push(
        `${where}.${other} は ${it.kind === 'blade' ? '刀' : '防具'}では使いません（無視）`
      )
    if (it[own] !== undefined) {
      const v = it[own]
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) entry[own] = v
      else
        warnings.push(
          `${where}.${own} は 0 以上の整数にしてください: ${JSON.stringify(v)}（値段なし = 購入不可にします）`
        )
    }
    if (it.unlockFlag !== undefined) {
      if (typeof it.unlockFlag === 'string' && it.unlockFlag) entry.unlockFlag = it.unlockFlag
      else warnings.push(`${where}.unlockFlag は文字列にしてください（常に解禁として扱います）`)
    }
    // 画像: `image`（`画像` でも可）。空・文字列以外は警告して画像なし
    const imageRaw = it.image !== undefined ? it.image : it['画像']
    if (imageRaw !== undefined) {
      if (typeof imageRaw === 'string' && imageRaw.trim()) entry.image = imageRaw.trim()
      else warnings.push(`${where}.image は文字列のパスにしてください（画像なしにします）`)
    }
    seen.add(it.id)
    entries.push(entry)
  })
  return { value: { multiplier, entries }, warnings }
}

/** セーブの `gear` の形の検査（定義との突き合わせは `resolveGear`）。不正なら理由、正常なら null */
export function checkGearState(raw: unknown): string | null {
  if (!isObj(raw)) return 'gear はオブジェクトが必要です'
  if (!isObj(raw.owned)) return 'gear.owned はオブジェクト（人物 id → 品 id の配列）が必要です'
  for (const [k, v] of Object.entries(raw.owned))
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
      return `gear.owned.${k} は文字列の配列が必要です`
  if (!isObj(raw.blade)) return 'gear.blade はオブジェクト（人物 id → 刀 id）が必要です'
  for (const [k, v] of Object.entries(raw.blade))
    if (typeof v !== 'string' || v === '') return `gear.blade.${k} は空でない文字列が必要です`
  return null
}
