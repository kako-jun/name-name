/**
 * アプリストア・そうび画面 (#881 段階2) の計算部。DOM / PixiJS に触れない純関数だけを持つ。
 * 売り物の定義・状態・購入・持ち替えの本体は `gearShop.ts`、装備列の計算は `equipment.ts` の `equipItem`。ここはそれらを
 * メニューの一覧（`MenuEntry`）と差分の文に組み立て、「買う」「持ち替える」の結果を 1 か所で返す。
 *
 * - アプリストア: タブ「刀／防具」。人物ごとに一覧が分かれる（刀アプリは人物ごと独立）。値段（通貨名つき）・購入済み印、
 *   買えない行は暗く（`enabled: false`）して説明バーの文に理由を入れる。買っただけでは装備しない
 * - そうび: 人物ごとに、2 枠（刀=スマホ／防具=タブレット）の現在の装備（`headerByParty`）と購入済みの一覧。
 *   選んだ品へ持ち替えたときの能力値の変化（変更前後の差分）を説明バーの文に入れる。防具は装備中の品を選ぶと外す
 * - 戦闘への反映（装備中の刀のアビリティを「わざ」に出す）は段階 3。ここでは装備列が正しく更新されるところまで
 */
import type { ItemDef, PartyMemberDef } from '../types'
import type { EquipmentRoster } from './equipment'
import { equipItem, unequipItem } from './equipment'
import {
  buy,
  canBuy,
  equipBlade,
  equippedBlade,
  isOwned,
  ownedIds,
  type GearBlockReason,
  type GearEntry,
  type GearShopConfig,
  type GearState,
} from './gearShop'
import { addBonus, parseStatBonus, type MagiciteStat, type StatBonus } from './magicite'
import type { MenuEntry, MenuTab, StatusRow } from './fieldMenuScreens'
import { hasOwn, safeAssign } from './ownProperty'

/** 通貨名の既定（設定の `battle.currencyName` が無いとき） */
export const DEFAULT_CURRENCY_NAME = '円'

/** アプリストアのタブの名前（定義の `kind` と対応） */
export const APPSTORE_TAB_LABELS = { blade: '刀', armor: '防具' } as const

/** そうびの 2 枠の見出し（刀=スマホ／防具=タブレット） */
export const EQUIP_SLOT_LABELS = { blade: 'スマホ（刀）', armor: 'タブレット（防具）' } as const

/** 枠が空のときの文字 */
export const EMPTY_SLOT_TEXT = 'なし'

/** メニューの一覧を作るための実行時の入力 */
export interface GearMenuContext {
  cfg: GearShopConfig
  state: GearState
  gold: number
  /** 解禁フラグの現在値（無いフラグは false 扱い） */
  flags: Readonly<Record<string, boolean>>
  /** 品 id → 表示名（`[アイテム]` の name。無い id は id のまま出す） */
  names: Readonly<Record<string, string>>
  /** 品 id → 説明（`[アイテム]` の description。省略可） */
  descriptions?: Readonly<Record<string, string>>
  /** 通貨名。省略は `DEFAULT_CURRENCY_NAME` */
  currencyName?: string
  /** 人物 id → 装備している id の列（`RpgSaveState.equipment`） */
  equipment: Readonly<Record<string, readonly string[]>>
  /** 人物の id（表示順） */
  members: readonly string[]
  /** 人物 id → 人物の定義（`equipmentSlots` など装備の枠の計算に要るもの）。無い人物は id だけ（既定の枠: 武器・防具・盾・兜が各 1） */
  defs?: Readonly<Record<string, MemberDefLike>>
  /** 店の外の装備の id → 種別（`武器` / `防具` / `盾` / `兜`）。装備列にある店の外の品を同じ種類の枠に数え、持ち替えで入れ替える（無い id は種類が分からず枠に数えない） */
  otherKinds?: Readonly<Record<string, string>>
}

/** 装備の計算に渡す人物の定義（`PartyMemberDef` の装備まわり） */
export type MemberDefLike = Pick<
  PartyMemberDef,
  'id' | 'magicites' | 'magiciteSlots' | 'equipment' | 'equipmentSlots' | 'jobs'
>

/** 品の表示名: 定義の `name` → `[アイテム]` の名前 → id の順 */
function displayName(
  cfg: GearShopConfig,
  names: Readonly<Record<string, string>>,
  id: string
): string {
  const own = cfg.entries.find((e) => e.id === id)?.name
  if (own !== undefined) return own
  return hasOwn(names, id) ? names[id] : id
}

const nameOf = (ctx: Pick<GearMenuContext, 'cfg' | 'names'>, id: string): string =>
  displayName(ctx.cfg, ctx.names, id)

/** 金額の文字（3 桁区切り＋通貨名）。不正な値は 0 */
export function formatPrice(amount: number, currencyName = DEFAULT_CURRENCY_NAME): string {
  const n = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0))
  return `${n.toLocaleString('en-US')}${currencyName}`
}

// ---------------------------------------------------------------------------
// 能力値の差分
// ---------------------------------------------------------------------------

const STAT_ORDER: readonly MagiciteStat[] = ['hp', 'mp', 'atk', 'def', 'agi']
/** 能力値の表示名（ステータス画面の呼び方に合わせる） */
export const STAT_LABELS: Readonly<Record<MagiciteStat, string>> = {
  hp: 'HP',
  mp: 'MP',
  atk: 'ちから',
  def: 'まもり',
  agi: 'すばやさ',
}

/** 差分（後 − 前）。0 の項目は含めない */
export function bonusDelta(before: StatBonus, after: StatBonus): StatBonus {
  const out: StatBonus = {}
  for (const k of STAT_ORDER) {
    const d = (after[k] ?? 0) - (before[k] ?? 0)
    if (d !== 0) out[k] = d
  }
  return out
}

/** 差分の文（`ちから +5 まもり -2`）。変化なしは「能力値は かわりません」 */
export function formatDelta(delta: StatBonus): string {
  const parts = STAT_ORDER.filter((k) => (delta[k] ?? 0) !== 0).map(
    (k) => `${STAT_LABELS[k]} ${(delta[k] as number) > 0 ? '+' : ''}${delta[k]}`
  )
  return parts.length > 0 ? parts.join('  ') : '能力値は かわりません'
}

// ---------------------------------------------------------------------------
// 装備の入力（品のマスター・人物の定義）
// ---------------------------------------------------------------------------

/** 装備の計算に渡す品のマスター。刀は 武器・防具は 防具 の枠。刀は持ち主だけ・防具は持ち主指定があればその人だけが装備できる */
export function gearRoster(
  cfg: GearShopConfig,
  names: Readonly<Record<string, string>>,
  otherKinds: Readonly<Record<string, string>> = {}
): EquipmentRoster {
  const items: Record<string, ItemDef> = {}
  // 店の外の装備（種類が分かるものだけ）。店の品が同じ id なら店の宣言を優先する
  for (const id of Object.keys(otherKinds))
    safeAssign(items, id, {
      id,
      name: hasOwn(names, id) ? names[id] : id,
      kind: otherKinds[id],
    } as ItemDef)
  for (const e of cfg.entries) {
    const def: ItemDef = {
      id: e.id,
      name: displayName(cfg, names, e.id),
      kind: e.kind === 'blade' ? '武器' : '防具',
      ...(e.equipBonus !== undefined ? { equipBonus: e.equipBonus } : {}),
      ...(e.owner !== undefined ? { equippableBy: [e.owner] } : {}),
    }
    safeAssign(items, e.id, def)
  }
  return { items }
}

/** 装備の計算に渡す人物の定義。`defs` にあればそれ（枠の数など）、無ければ id だけ（装備の列は呼び出し側が明示的に渡す） */
export function memberDef(
  id: string,
  defs?: Readonly<Record<string, MemberDefLike>>
): MemberDefLike {
  return defs !== undefined && hasOwn(defs, id) ? { ...defs[id], id } : { id }
}

/** 装備列の能力値ボーナスの合計（店の品だけ。`equipBonus` を読む） */
function gearBonusOf(cfg: GearShopConfig, equipment: readonly string[]): StatBonus {
  let total: StatBonus = {}
  for (const id of equipment) {
    const e = cfg.entries.find((x) => x.id === id)
    if (e?.equipBonus !== undefined) total = addBonus(total, parseStatBonus(e.equipBonus).bonus)
  }
  return total
}

/** 装備列が変わったときの能力値の変化（後 − 前）。店の品の `equipBonus` だけを見る */
export function equipmentDelta(
  cfg: GearShopConfig,
  before: readonly string[],
  after: readonly string[]
): StatBonus {
  return bonusDelta(gearBonusOf(cfg, before), gearBonusOf(cfg, after))
}

// ---------------------------------------------------------------------------
// アプリストア（購入）
// ---------------------------------------------------------------------------

const entriesOfKind = (cfg: GearShopConfig, kind: GearEntry['kind'], member: string): GearEntry[] =>
  cfg.entries.filter((e) => e.kind === kind && (e.owner === undefined || e.owner === member))

/** 買えない理由の文。足りない金額が分かるときは添える */
export function blockText(
  reason: GearBlockReason | undefined,
  message: string | undefined,
  price: number | undefined,
  gold: number,
  currencyName: string
): string {
  if (reason === 'notEnoughGold' && price !== undefined)
    return `所持金が足りません（あと ${formatPrice(price - gold, currencyName)}）`
  return message ?? 'いまは買えません'
}

/** アプリストアの 1 行 */
function appStoreEntry(ctx: GearMenuContext, member: string, e: GearEntry): MenuEntry {
  const currency = ctx.currencyName ?? DEFAULT_CURRENCY_NAME
  const name = nameOf(ctx, e.id)
  const check = canBuy(ctx.cfg, ctx.state, member, e.id, ctx.gold, ctx.flags)
  const bonus = e.equipBonus !== undefined ? parseStatBonus(e.equipBonus).bonus : {}
  const base = [
    hasOwn(ctx.descriptions ?? {}, e.id) ? (ctx.descriptions as Record<string, string>)[e.id] : '',
    Object.keys(bonus).length > 0 ? `装備時 ${formatDelta(bonus)}` : '',
  ]
    .filter(Boolean)
    .join('  ')
  const entry: MenuEntry = {
    id: e.id,
    label: name,
    ...(e.image !== undefined ? { image: e.image } : {}),
  }
  if (check.ok) {
    return {
      ...entry,
      detail: formatPrice(check.price as number, currency),
      enabled: true,
      description: base || name,
    }
  }
  const reason = blockText(check.reason, check.message, check.price, ctx.gold, currency)
  const detail =
    check.reason === 'owned'
      ? '購入済み'
      : check.price !== undefined
        ? formatPrice(check.price, currency)
        : check.reason === 'unbuyable'
          ? '値段未定'
          : '---'
  return {
    ...entry,
    detail,
    enabled: false,
    description:
      check.reason === 'owned'
        ? base
          ? `${base}（購入済み）`
          : `${name}（購入済み）`
        : `${name}  ${reason}`,
  }
}

/** アプリストアのタブ「刀／防具」。人物ごとの一覧（`entriesByParty`）。刀は選んだ人物の刀だけ・防具は誰でも買える品 */
export function buildAppStoreTabs(ctx: GearMenuContext): MenuTab[] {
  return (['blade', 'armor'] as const).map((kind) => {
    const by: Record<string, MenuEntry[]> = {}
    for (const m of ctx.members)
      safeAssign(
        by,
        m,
        entriesOfKind(ctx.cfg, kind, m).map((e) => appStoreEntry(ctx, m, e))
      )
    return { label: APPSTORE_TAB_LABELS[kind], entries: [], entriesByParty: by }
  })
}

/** 購入の結果（メニューの通知と新しい状態） */
export interface PurchaseOutcome {
  ok: boolean
  /** 説明バーに出す文 */
  notice: string
  state: GearState
  gold: number
}

/** 購入する。成功したら新しい状態と所持金。買っただけでは装備しない（持ち替えは「そうび」） */
export function purchase(ctx: GearMenuContext, member: string, id: string): PurchaseOutcome {
  const currency = ctx.currencyName ?? DEFAULT_CURRENCY_NAME
  const r = buy(ctx.cfg, ctx.state, member, id, ctx.gold, ctx.flags)
  if (!r.ok)
    return {
      ok: false,
      notice: blockText(r.reason, r.message, r.price, ctx.gold, currency),
      state: r.state,
      gold: r.gold,
    }
  return {
    ok: true,
    notice: `${nameOf(ctx, id)} を ${formatPrice(r.price as number, currency)}で 購入しました（装備は「そうび」で）`,
    state: r.state,
    gold: r.gold,
  }
}

// ---------------------------------------------------------------------------
// そうび（持ち替え）
// ---------------------------------------------------------------------------

/** 装備変更の結果 */
export interface GearChange {
  ok: boolean
  /** 説明バーに出す文（失敗は理由・成功は結果） */
  notice: string
  state: GearState
  /** 変更後の装備列（失敗は入力のまま） */
  equipment: string[]
  /** 能力値の変化（後 − 前）。成功のときだけ */
  delta?: StatBonus
}

/**
 * 品へ持ち替える（純関数）。刀は `equipBlade`（購入済みの自分の刀だけ。すでに装備中なら変更なし）。
 * 防具は購入済みの品を `equipItem` で付け、すでに装備中の品を選ぶと外す。他人の品・未購入は不可
 */
export function changeGear(
  ctx: GearMenuContext,
  member: string,
  id: string,
  roster: EquipmentRoster = gearRoster(ctx.cfg, ctx.names, ctx.otherKinds)
): GearChange {
  const before = [...(hasOwn(ctx.equipment, member) ? ctx.equipment[member] : [])]
  const fail = (notice: string): GearChange => ({
    ok: false,
    notice,
    state: ctx.state,
    equipment: before,
  })
  const e = ctx.cfg.entries.find((x) => x.id === id)
  const name = nameOf(ctx, id)
  if (!e) return fail('売っていない品です')
  if (e.owner !== undefined && e.owner !== member) return fail('他の人の品は使えません')
  if (!isOwned(ctx.state, member, id)) return fail('まだ買っていません')
  const def = memberDef(member, ctx.defs)
  if (e.kind === 'blade') {
    if (equippedBlade(ctx.state, member) === id && before.includes(id))
      return fail(`${name} は すでに装備しています`)
    const r = equipBlade(ctx.cfg, ctx.state, def, roster, before, id)
    if (!r.ok) return fail(r.message ?? `${name} は装備できません`)
    return {
      ok: true,
      notice: `${name} を スマホに入れました`,
      state: r.state,
      equipment: r.equipment,
      delta: equipmentDelta(ctx.cfg, before, r.equipment),
    }
  }
  // 防具: 装備中なら外す
  if (before.includes(id)) {
    const after = unequipItem(before, id)
    return {
      ok: true,
      notice: `${name} を タブレットから はずしました`,
      state: ctx.state,
      equipment: after,
      delta: equipmentDelta(ctx.cfg, before, after),
    }
  }
  const r = equipItem(def, roster, before, id)
  if (!r.ok) return fail(r.reason ?? `${name} は装備できません`)
  return {
    ok: true,
    notice: `${name} を タブレットに入れました`,
    state: ctx.state,
    equipment: r.equipment,
    delta: equipmentDelta(ctx.cfg, before, r.equipment),
  }
}

/** 装備中の店の品の id（その種類で、装備列にあり、その人が購入済みで使える品。枠が複数なら複数）。無ければ空 */
function equippedOfKind(ctx: GearMenuContext, member: string, kind: GearEntry['kind']): string[] {
  const eq = hasOwn(ctx.equipment, member) ? ctx.equipment[member] : []
  if (kind === 'blade') {
    const b = equippedBlade(ctx.state, member)
    return b !== undefined && eq.includes(b) ? [b] : []
  }
  return eq.filter((id) =>
    ctx.cfg.entries.some(
      (e) =>
        e.id === id &&
        e.kind === 'armor' &&
        (e.owner === undefined || e.owner === member) &&
        isOwned(ctx.state, member, id)
    )
  )
}

/**
 * そうび画面の中身。人物ごとに、購入済みの品（定義の順。刀 → 防具）の一覧と、2 枠の現在の装備（見出し行）を返す。
 * 各行の説明は「その品へ持ち替えたとき」の能力値の変化（変更前後の差分）。装備中の刀は「すでに装備」、装備中の防具は「はずす」
 */
export function buildEquipContent(ctx: GearMenuContext): {
  entriesByParty: Record<string, MenuEntry[]>
  headerByParty: Record<string, StatusRow[]>
} {
  const entriesByParty: Record<string, MenuEntry[]> = {}
  const headerByParty: Record<string, StatusRow[]> = {}
  const roster = gearRoster(ctx.cfg, ctx.names, ctx.otherKinds)
  for (const m of ctx.members) {
    const owned = ownedIds(ctx.state, m)
    const rows: MenuEntry[] = []
    for (const kind of ['blade', 'armor'] as const)
      for (const e of entriesOfKind(ctx.cfg, kind, m)) {
        if (!owned.includes(e.id)) continue
        const name = nameOf(ctx, e.id)
        const equipped = equippedOfKind(ctx, m, kind).includes(e.id)
        const change = changeGear(ctx, m, e.id, roster)
        const delta = change.ok ? formatDelta(change.delta ?? {}) : change.notice
        rows.push({
          id: e.id,
          label: name,
          detail: equipped ? '装備中' : APPSTORE_TAB_LABELS[kind],
          enabled: true,
          description: equipped
            ? kind === 'armor'
              ? `${name}  はずすと ${formatDelta(change.delta ?? {})}`
              : `${name}  すでに装備しています`
            : `${name}  もちかえると ${delta}`,
        })
      }
    safeAssign(entriesByParty, m, rows)
    const slot = (kind: GearEntry['kind']): string => {
      const ids = equippedOfKind(ctx, m, kind)
      return ids.length === 0 ? EMPTY_SLOT_TEXT : ids.map((id) => nameOf(ctx, id)).join('、')
    }
    safeAssign<StatusRow[]>(headerByParty, m, [
      { label: EQUIP_SLOT_LABELS.blade, value: slot('blade') },
      { label: EQUIP_SLOT_LABELS.armor, value: slot('armor') },
    ])
  }
  return { entriesByParty, headerByParty }
}
