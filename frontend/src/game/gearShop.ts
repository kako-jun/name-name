/**
 * 装備（刀・防具）の所有・入手・購入・売却 (#881) の純関数。DOM / PixiJS に触れない。UI は段階2、戦闘反映は段階3。
 *
 * - 定義 `GearShopConfig`（設定 JSON の `gearShop`）: 売り物の一覧 `entries`（品の `id` は `[アイテム]` の id）と倍率 `multiplier`（既定 2）。
 *   `kind: 'blade'`（刀。人物ごとに別。`owner` 必須。値段は持っている刀の種類数ごとに倍々。入手の手段〈買う・宝箱〉は問わない）／`kind: 'armor'`（防具。固定価格 `price`。倍々にならない）。
 *   刀の値段 = `basePrice` × `multiplier`^(その人物の持っている刀の種類数。入手の手段は問わない)。`basePrice` / `price` が無い品は購入不可（値段を創作しない）。
 * - 状態 `GearState`（`RpgSaveState.gear`）: `owned`（人物 id → 持っている品 id の列。**同じ id を重ねて書いた数が個数**＝多重集合。
 *   旧セーブ（重複なしの配列）はそのまま個数 1 の品として読める＝セーブの形は変えない）と `blade`（人物 id → 装備中の刀 id）。
 *   買う（`buy`）は未所持の種類だけ。宝箱・イベントの入手（`grant`）は個数を増やす。売る（`sell`、段階5）のは余剰（個数 2 以上）だけで、
 *   最後の 1 つは売れない（一度手に入れた品は最低 1 つずつ持つ）。他人の刀（`owner` が別の人物）は買えず・装備できない。購入解禁は定義側のフラグ `unlockFlag`（解禁前は購入不可＋理由）。
 * - 装備列（`RpgSaveState.equipment`）の計算は `equipment.ts` の `equipItem` を再利用する（`equipBlade`）。ここで重複実装しない。
 * - 刀の `abilities`（段階3）: 装備中の刀の特技 id だけが戦闘の「わざ」に出る（`skillsForMember`。仕様上は 1 刀 1 アビリティで、配列は一般化）。
 *
 * 売り物の宣言が無いゲーム・メニューを使わないゲームは、この仕組みを通らず従来どおり（セーブにも `gear` キーを書かない）。
 */
import { equipItem, unequipItem, type EquipmentRoster } from './equipment'
import { parseStatBonus } from './magicite'
import { MAX_GOLD } from './goldEffect'
import { hasOwn, safeAssign } from './ownProperty'
import type { PartyMemberDef } from '../types'

/** 1 つの品の個数の上限（1 回の入手の上限も同じ値。改ざんしたセーブで配列が膨らまないための歯止め） */
export const MAX_OWNED_PER_ITEM = 9999

export type GearKind = 'blade' | 'armor'

/** 刀・防具の倍率の既定（持っている刀の種類が 1 つ増えるごとに倍々） */
export const DEFAULT_PRICE_MULTIPLIER = 2

/** 1 つの売り物 */
export interface GearEntry {
  /** `[アイテム]` の id */
  id: string
  kind: GearKind
  /** 持ち主の人物 id。刀は必須（他人の刀は買えず装備できない）。防具は省略 = 誰でも（購入・所有は人物ごと） */
  owner?: string
  /** 刀の 1 本目の値段（円）。無ければ購入不可。決定値は 10,000 円（4 人とも同額。`SIT.blade-base-price-10000`。sit-by-me の台帳の決定、2026-11-05 kako-jun） */
  basePrice?: number
  /** 防具の固定価格（円）。無ければ購入不可。決定値は 5,000 円で固定（`SIT.blade-armor-price-same-fixed`。sit-by-me の台帳の決定、2026-11-05 kako-jun） */
  price?: number
  /** 購入解禁のフラグ名。省略 = 常に解禁。そのフラグが true になるまで購入不可（仕様では 2 本目以降は解禁制ではないので、刀には使わない前提。防具・将来用） */
  unlockFlag?: string
  /** 一覧に出す画像のパス（任意の文字列。sit-by-me の刀マスターから切り出した派生画像を指す想定だが、派生画像は未作成）。省略 = 画像なし（文字のみ）。読み込み・表示は段階2の UI */
  image?: string
  /** 装備している間だけ能力値に足す分（`atk+5, def+2` 形式。魔石・アイテムの `装備時` と同じ書式）。そうび画面の変更前後の差分に使う。省略 = 能力値は変わらない（値は仮・未決。刀の値段の決定とは別で、正本が未決） */
  equipBonus?: string
  /** 表示名（アプリストア・そうびの一覧）。省略は `[アイテム]` の name、それも無ければ id。売り物のためだけの品は `[アイテム]` に書かなくてよい（戦闘のアイテム窓に出ない） */
  name?: string
  /** 解禁前（`unlockFlag` が立つまで）に説明バーへ出す文。省略は「まだ買えません」。解禁条件が分かる文を書ける */
  lockedMessage?: string
  /** 刀を装備している間だけ戦闘の「わざ」に出る特技の id（設定 JSON の `skills` の id。段階3 #881）。刀だけが持つ（防具は属性防御だけ）。省略 = 刀のアビリティなし。仕様上は 1 刀 1 アビリティ（配列は一般化） */
  abilities?: string[]
}

export interface GearShopConfig {
  /** 刀の倍率（既定 2）。1 以上の有限の数 */
  multiplier: number
  entries: GearEntry[]
}

/** 人物ごとの所有と装備中の刀（セーブ対象） */
export interface GearState {
  /** 人物 id → 持っている品 id の列（入手した順。同じ id が n 回あれば個数 n。旧セーブの重複なしの配列は個数 1 として読める） */
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
  | 'owned' // 入手済み（店では買えない）
  | 'unbuyable' // 値段なし（基準額・価格が設定されていない）
  | 'uncomputable' // 値段を計算できない（桁あふれ）
  | 'notBlade' // 刀ではない品（刀の持ち替えのみ）
  | 'locked' // 解禁前
  | 'notEnoughGold' // 所持金不足
  | 'notOwned' // 未購入の品は装備できない（装備のみ）・売れない（売るのみ）
  | 'last' // 最後の 1 つは売れない（売るのみ）
  | 'badCount' // 個数が 1 以上の整数でない（入手のみ）
  | 'tooMany' // 1 つの品の個数が上限を超える（入手のみ）
  | 'badGold' // 所持金が 0 以上の有限の数でない（売るのみ）

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
  owned: '入手済み',
  unbuyable: '値段が決まっていないため買えません',
  uncomputable: '値段を計算できません',
  notBlade: '刀ではありません',
  locked: 'まだ買えません',
  notEnoughGold: '所持金が足りません',
  notOwned: '持っていません',
  last: '最後の1つは売れません',
  badCount: '個数が正しくありません',
  tooMany: `持てる数の上限（${MAX_OWNED_PER_ITEM}個）を超えます`,
  badGold: '所持金が正しくありません',
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

/** 人物の持っている品 id（種類。個数にかかわらず 1 回ずつ。入手した順） */
export function ownedIds(state: GearState, member: string): readonly string[] {
  return hasOwn(state.owned, member) ? [...new Set(state.owned[member])] : []
}

/** 人物の品ごとの個数（1 回の走査で集計する。一覧を作るときに品ごとの `ownedCount` を繰り返さないため） */
export function ownedCounts(state: GearState, member: string): Map<string, number> {
  const m = new Map<string, number>()
  if (hasOwn(state.owned, member))
    for (const id of state.owned[member]) m.set(id, (m.get(id) ?? 0) + 1)
  return m
}

/** 人物が持っている品の個数（持っていなければ 0） */
export function ownedCount(state: GearState, member: string, id: string): number {
  return hasOwn(state.owned, member) ? state.owned[member].filter((x) => x === id).length : 0
}

/** 持っているか（個数 1 以上） */
export function isOwned(state: GearState, member: string, id: string): boolean {
  return ownedCount(state, member, id) > 0
}

/**
 * 人物の持っている刀の**種類数**（定義にある刀だけ。個数 1 以上の刀の id の数。個数ではない：同じ刀を 2 本持っても 1 と数える）。
 * 刀の値段の段階はこれで決まる（売っても減らない＝最後の 1 つは売れないので）
 */
export function ownedBladeCount(cfg: GearShopConfig, state: GearState, member: string): number {
  return ownedIds(state, member).filter((id) => findEntry(cfg, id)?.kind === 'blade').length
}

/** 人物が装備中の刀 id（無ければ undefined） */
export function equippedBlade(state: GearState, member: string): string | undefined {
  return hasOwn(state.blade, member) ? state.blade[member] : undefined
}

/**
 * いま買うときの値段（円）。刀は `basePrice × multiplier^持っている刀の種類数`（整数に切り捨て）、防具は固定の `price`。
 * 基準額・価格が設定されていない・計算結果が有限の 0 以上の整数にならない（桁あふれ）は undefined。
 * 「何本目か」は持っている刀の種類数（刀ごとの有無で数える。同じ刀の個数は関係しない。イベントでもらった刀も含む）で決まる。
 * 決定済み: `SIT.blade-price-by-owned-count`（sit-by-me の台帳の決定、2026-11-05 kako-jun）。
 * 決定値は、基準額 10,000 円・倍々（10,000/20,000/40,000/80,000/160,000 円）・4 人とも同額・買う順は自由・防具は 5,000 円固定
 */
export function priceOf(
  cfg: GearShopConfig,
  state: GearState,
  member: string,
  id: string
): number | undefined {
  const p = computePrice(cfg, state, member, id)
  return typeof p === 'number' ? p : undefined
}

/** 値段の計算。数なら値段、`'unset'` は基準額・価格なし（設定されていない。売り物にない id も）、`'overflow'` は計算結果が使えない（桁あふれ） */
function computePrice(
  cfg: GearShopConfig,
  state: GearState,
  member: string,
  id: string
): number | 'unset' | 'overflow' {
  const e = findEntry(cfg, id)
  if (!e) return 'unset'
  if (e.kind === 'armor') return isValidPrice(e.price) ? e.price : 'unset'
  if (!isValidPrice(e.basePrice)) return 'unset'
  // 倍率は数で 1 以上の有限値だけ（型を破った定義の文字列 '2' なども拒否して、暗黙の型変換に頼らない）
  if (typeof cfg.multiplier !== 'number' || !Number.isFinite(cfg.multiplier) || cfg.multiplier < 1)
    return 'overflow'
  const p = Math.floor(e.basePrice * Math.pow(cfg.multiplier, ownedBladeCount(cfg, state, member)))
  return Number.isSafeInteger(p) && p >= 0 ? p : 'overflow'
}

const isValidPrice = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * 購入できるか。理由の優先順: 売り物にない → 他人の刀 → 入手済み → 値段未決 → 解禁前 → 所持金不足。
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
  // 入手済みには次の値段を付けない（その品はもう買えない）
  if (isOwned(state, member, id)) return block('owned')
  const price = computePrice(cfg, state, member, id)
  if (price === 'unset') return block('unbuyable')
  if (price === 'overflow') return block('uncomputable')
  if (
    e.unlockFlag !== undefined &&
    !(hasOwn(flags, e.unlockFlag) && flags[e.unlockFlag] === true)
  ) {
    const b = block('locked', price)
    return e.lockedMessage !== undefined ? { ...b, message: e.lockedMessage } : b
  }
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

/** 入手の結果 */
export interface GrantResult {
  ok: boolean
  reason?: GearBlockReason
  message?: string
  /** 入手後の状態（失敗時は入力と同じ内容の複製） */
  state: GearState
}

/**
 * 買わない入手（宝箱・イベント。純関数。入力は変えない）。個数を `count`（既定 1）増やす。重複して持てる。
 * 売り物にない id・他人の品（持ち主が別の刀・防具）・個数が 1 以上の整数でないときは拒否。値段・解禁フラグ・所持金は関係しない
 */
export function grant(
  cfg: GearShopConfig,
  state: GearState,
  member: string,
  id: string,
  count = 1
): GrantResult {
  const next = cloneState(state)
  const fail = (reason: GearBlockReason): GrantResult => ({
    ok: false,
    reason,
    message: MESSAGES[reason],
    state: next,
  })
  const e = findEntry(cfg, id)
  if (!e) return fail('unknown')
  if (e.kind === 'blade' && e.owner !== member) return fail('otherOwner')
  if (e.kind === 'armor' && e.owner !== undefined && e.owner !== member) return fail('otherOwner')
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_OWNED_PER_ITEM)
    return fail('badCount')
  if (ownedCount(state, member, id) + count > MAX_OWNED_PER_ITEM) return fail('tooMany')
  const list = hasOwn(next.owned, member) ? next.owned[member] : []
  safeAssign(next.owned, member, [...list, ...Array<string>(count).fill(id)])
  return { ok: true, state: next }
}

/** 売却可否の判定結果 */
export interface SellCheck {
  ok: boolean
  /** 売値（円）。売れるときだけ */
  price?: number
  reason?: GearBlockReason
  message?: string
}

export interface SellResult extends SellCheck {
  /** 売却後の状態（失敗時は入力と同じ内容の複製） */
  state: GearState
  /** 売却後の所持金（失敗時は変わらない） */
  gold: number
}

/**
 * 売値（円）。刀は「いま買うとしたらの値段」の半額（= 持っている種類数 k 本目の値段）、防具は固定価格の半額（切り捨て）。
 * 入手手段（買った・宝箱）は関係しない。値段が決まっていない・計算できないは undefined。
 * 売っても種類数は減らない（最後の 1 つは売れない）ので、売値も次に買う値段も変わらない
 */
export function sellPriceOf(
  cfg: GearShopConfig,
  state: GearState,
  member: string,
  id: string
): number | undefined {
  const p = computePrice(cfg, state, member, id)
  return typeof p === 'number' ? Math.floor(p / 2) : undefined
}

/** 売れるか。理由の優先順: 売り物にない → 他人の品 → 未所持 → 最後の 1 つ → 値段未決 → 計算不能 */
export function canSell(
  cfg: GearShopConfig,
  state: GearState,
  member: string,
  id: string,
  /** 個数（集計済みなら渡す。省略は数える） */
  count?: number
): SellCheck {
  const e = findEntry(cfg, id)
  if (!e) return block('unknown')
  if (e.kind === 'blade' && e.owner !== member) return block('otherOwner')
  if (e.kind === 'armor' && e.owner !== undefined && e.owner !== member) return block('otherOwner')
  const n = count ?? ownedCount(state, member, id)
  if (n === 0) return block('notOwned')
  if (n === 1) return block('last')
  const price = computePrice(cfg, state, member, id)
  if (price === 'unset')
    return { ...block('unbuyable'), message: '値段が決まっていないため売れません' }
  if (price === 'overflow') return { ...block('uncomputable'), message: '売値を計算できません' }
  return { ok: true, price: Math.floor(price / 2) }
}

/** 売る（純関数。入力は変えない）。余剰（個数 2 以上）を 1 つ減らし、売値を所持金に足す。最後の 1 つは売れない */
export function sell(
  cfg: GearShopConfig,
  state: GearState,
  member: string,
  id: string,
  gold: number
): SellResult {
  const next = cloneState(state)
  if (!(Number.isFinite(gold) && gold >= 0))
    return { ok: false, reason: 'badGold', message: MESSAGES.badGold, state: next, gold }
  const check = canSell(cfg, state, member, id)
  if (!check.ok) return { ...check, state: next, gold }
  const list = next.owned[member]
  list.splice(list.lastIndexOf(id), 1)
  // 所持金は `MAX_GOLD`（所持金の効果 DSL と同じ上限）で頭打ち
  return { ...check, state: next, gold: Math.min(MAX_GOLD, gold + (check.price as number)) }
}

/** 刀の持ち替えの結果 */
export interface EquipBladeResult {
  ok: boolean
  state: GearState
  /** 変更後の装備列（`RpgSaveState.equipment` の当該人物の値）。失敗時は入力のまま */
  equipment: string[]
  /** 枠が埋まっていて `equipItem` が入れ替えた品の id（店の外の武器など。直前の刀は列から先に外すのでここには出ない） */
  replaced?: string
  reason?: GearBlockReason | 'equipFailed'
  message?: string
}

/**
 * 刀を持ち替える（純関数）。持っている自分の刀だけ。装備列は `equipItem`（種別・枠・`装備可`の検査と入れ替え）で計算し、
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
  if (!e) return fail('unknown', MESSAGES.unknown)
  if (e.kind !== 'blade') return fail('notBlade', MESSAGES.notBlade)
  if (e.owner !== member) return fail('otherOwner', MESSAGES.otherOwner)
  if (!isOwned(state, member, id)) return fail('notOwned', MESSAGES.notOwned)
  // 直前の刀を外してから付ける（武器枠が複数あっても「持ち替え」は 1 本だけが装備中）
  const prev = equippedBlade(state, member)
  const base = prev !== undefined && prev !== id ? unequipItem(before, prev) : before
  const r = equipItem(def, roster, base, id)
  if (!r.ok) return fail('equipFailed', r.reason ?? `'${id}' は装備できません`)
  const next = cloneState(state)
  safeAssign(next.blade, member, id)
  return {
    ok: true,
    state: next,
    equipment: r.equipment,
    ...(r.replaced !== undefined ? { replaced: r.replaced } : {}),
  }
}

/** 解決の結果（セーブから読んだ状態を定義と突き合わせたもの） */
export interface ResolvedGear {
  state: GearState
  /** 掃除済みの装備列（人物 id → 装備の id の列）。`equipment` を渡したときだけ。外した刀の id を除いてある */
  equipment?: Record<string, string[]>
  warnings: string[]
}

/**
 * セーブから読んだ状態を定義と突き合わせる。定義にない品・他人の刀は警告して捨て（重複は個数として残す）、
 * 未購入の刀を「装備中」にしているものは装備中を外す（警告）。
 * 装備列 `equipment`（`RpgSaveState.equipment`）を渡すと、外した刀（定義から消えた・持ち主が変わった・未購入）の id を
 * その人物の列からも除いた `equipment` を返す（入力は変えない）。刀以外の id は触らない
 */
export function resolveGear(
  saved: GearState | undefined,
  cfg: GearShopConfig,
  equipment?: Readonly<Record<string, string[]>>
): ResolvedGear {
  const warnings: string[] = []
  const state = emptyGearState()
  // 外す刀: 人物 id → 装備列から除く id（定義にもう無い id は、`blade` に記録された装備中の刀だけが手掛かり）
  const dropped: Record<string, string[]> = {}
  const drop = (member: string, id: string) => {
    const list = hasOwn(dropped, member) ? dropped[member] : []
    if (!list.includes(id)) safeAssign(dropped, member, [...list, id])
  }
  let overflow = 0 // 上限を超えて切り詰めた個数の合計（警告は 1 件にまとめる）
  const warned = new Set<string>() // 同じ警告を重ねない（改ざんで同じ id を大量に重ねても警告が増えない）
  const warnOnce = (m: string) => {
    if (!warned.has(m)) {
      warned.add(m)
      warnings.push(m)
    }
  }
  const entryCache = new Map<string, GearEntry | undefined>()
  const savedOwned = saved?.owned ?? {}
  const savedBlade = saved?.blade ?? {}
  for (const member of Object.keys(savedOwned)) {
    const kept: string[] = []
    const counts = new Map<string, number>()
    for (const id of savedOwned[member]) {
      if (!entryCache.has(id)) entryCache.set(id, findEntry(cfg, id))
      const e = entryCache.get(id)
      if (!e) warnOnce(`gear.owned.${member} '${id}' は売り物の定義にありません（無視）`)
      else if (e.owner !== undefined && e.owner !== member)
        warnOnce(`gear.owned.${member} '${id}' は他の人の品です（無視）`)
      // 防御: パースは owner なしの刀を捨てるので通常は届かない（手で組んだ定義のため残す）
      else if (e.kind === 'blade' && e.owner === undefined)
        warnOnce(`gear.owned.${member} '${id}' は持ち主のない刀です（無視）`)
      else {
        // 重複は個数として数える（旧仕様は警告して捨てていた）。品ごとの上限を超えた分は切り詰める
        const n = (counts.get(id) ?? 0) + 1
        counts.set(id, n)
        if (n > MAX_OWNED_PER_ITEM) overflow += 1
        else kept.push(id)
      }
    }
    safeAssign(state.owned, member, kept)
  }
  if (overflow > 0)
    warnings.push(
      `gear.owned: 1 つの品の個数の上限（${MAX_OWNED_PER_ITEM}個）を超えた ${overflow} 個を切り詰めました`
    )
  for (const member of Object.keys(savedBlade)) {
    const id = savedBlade[member]
    if (findEntry(cfg, id)?.kind !== 'blade' || !isOwned(state, member, id)) {
      warnings.push(`gear.blade.${member} '${id}' は持っている刀ではありません（装備中を外す）`)
      drop(member, id)
    } else safeAssign(state.blade, member, id)
  }
  if (!equipment) return { state, warnings }
  const cleaned: Record<string, string[]> = {}
  for (const member of Object.keys(equipment)) {
    const out = equipment[member].filter((id) => {
      const e = findEntry(cfg, id)
      const bad =
        (hasOwn(dropped, member) && dropped[member].includes(id)) ||
        (e?.kind === 'blade' && (e.owner !== member || !isOwned(state, member, id)))
      if (bad) warnings.push(`equipment.${member} '${id}' は使えない刀のため装備列から外した`)
      return !bad
    })
    safeAssign(cleaned, member, out)
  }
  return { state, equipment: cleaned, warnings }
}

// ---- 戦闘への反映 (#881 段階3) ----

/**
 * 戦闘の「わざ」のうち、その人物に出すもの。`skills`（わざの候補の一覧。順を保つ）から、
 * 「どれかの刀のアビリティに挙がっている特技」は**その人物が装備中の刀（`state.blade`。持っている自分の刀）が持つものだけ**を残し、
 * どの刀にも挙がっていない特技（刀と無関係の固定のわざ）はそのまま残す。刀を持ち替えれば結果が変わる（純関数。戦闘中の持ち替えは無い）。
 * 他人の刀・未購入の刀・防具のアビリティは出ない。刀にアビリティを宣言していない定義では `skills` と同じ（従来どおり）
 */
export function skillsForMember<T extends { id: string }>(
  skills: readonly T[],
  cfg: GearShopConfig,
  state: GearState,
  member: string
): T[] {
  const gated = new Set<string>()
  for (const e of cfg.entries)
    if (e.kind === 'blade') for (const a of e.abilities ?? []) gated.add(a)
  if (gated.size === 0) return [...skills]
  const id = equippedBlade(state, member)
  const e = id === undefined ? undefined : findEntry(cfg, id)
  const granted =
    e && e.kind === 'blade' && e.owner === member && isOwned(state, member, e.id)
      ? new Set(e.abilities ?? [])
      : new Set<string>()
  return skills.filter((s) => !gated.has(s.id) || granted.has(s.id))
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
 * 設定 JSON の `gearShop`。`{ multiplier?, entries: [{ id, kind, owner?, basePrice?, price?, unlockFlag?, image?, equipBonus?, name?, lockedMessage?, abilities? }] }`。
 * 不正な項目は警告して捨てる。`gearShop` が無い（undefined / false / null）はキーなし＝従来どおり。
 * 基準額は人物ごとに揃えるのが前提（食い違いは警告）。基準額なし = 購入不可。値段の決定値は基準額 10,000 円・防具 5,000 円（sit-by-me の台帳の決定、2026-11-05 kako-jun）。テスト・サンプルに書く値は動作確認用で、決定値とは別
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
    // 画像: 空・文字列以外は警告して画像なし
    const imageRaw = it.image
    if (imageRaw !== undefined) {
      if (typeof imageRaw === 'string' && imageRaw.trim()) entry.image = imageRaw.trim()
      else warnings.push(`${where}.image は文字列のパスにしてください（画像なしにします）`)
    }
    for (const key of ['name', 'lockedMessage'] as const) {
      const v = it[key]
      if (v === undefined) continue
      if (typeof v === 'string' && v.trim()) entry[key] = v.trim()
      else warnings.push(`${where}.${key} は空でない文字列にしてください（無視します）`)
    }
    if (it.equipBonus !== undefined) {
      if (typeof it.equipBonus === 'string' && it.equipBonus.trim()) {
        entry.equipBonus = it.equipBonus.trim()
        for (const w of parseStatBonus(entry.equipBonus).warnings)
          warnings.push(`${where}.equipBonus: ${w}`)
      } else
        warnings.push(
          `${where}.equipBonus は文字列（例: atk+5）にしてください（能力値なしにします）`
        )
    }
    // 刀のアビリティ（戦闘の「わざ」に出る特技 id）。刀以外・不正は警告して捨てる
    if (it.abilities !== undefined) {
      if (it.kind !== 'blade')
        warnings.push(`${where}.abilities は刀だけが持てます（防具では無視します）`)
      else if (
        Array.isArray(it.abilities) &&
        it.abilities.every((a) => typeof a === 'string' && a !== '')
      ) {
        if (it.abilities.length > 0) entry.abilities = [...new Set(it.abilities as string[])]
      } else
        warnings.push(
          `${where}.abilities は特技 id（文字列）の配列にしてください（アビリティなしにします）`
        )
    }
    seen.add(it.id)
    entries.push(entry)
  })
  // 仕様の「人物ごとの 1 本目の基準額」は人物内で揃える前提。食い違いは意図かもしれないので警告だけ
  const basePrices: Record<string, Set<number>> = {}
  for (const e of entries) {
    if (e.kind !== 'blade' || e.owner === undefined || e.basePrice === undefined) continue
    if (!hasOwn(basePrices, e.owner)) safeAssign(basePrices, e.owner, new Set<number>())
    basePrices[e.owner].add(e.basePrice)
  }
  for (const owner of Object.keys(basePrices))
    if (basePrices[owner].size > 1)
      warnings.push(
        `gearShop: ${owner} の刀の basePrice が食い違っています（仕様では人物ごとの 1 本目の基準額に揃える前提です）`
      )
  return { value: { multiplier, entries }, warnings }
}

/** セーブの `gear` の形の検査（定義との突き合わせは `resolveGear`）。不正なら理由、正常なら null */
export function checkGearState(raw: unknown): string | null {
  if (!isObj(raw)) return 'gear はオブジェクトが必要です'
  if (!isObj(raw.owned))
    return 'gear.owned はオブジェクト（人物 id → 品 id の配列。同じ id の数が個数）が必要です'
  for (const [k, v] of Object.entries(raw.owned))
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
      return `gear.owned.${k} は文字列の配列が必要です`
  if (!isObj(raw.blade)) return 'gear.blade はオブジェクト（人物 id → 刀 id）が必要です'
  for (const [k, v] of Object.entries(raw.blade))
    if (typeof v !== 'string' || v === '') return `gear.blade.${k} は空でない文字列が必要です`
  return null
}
