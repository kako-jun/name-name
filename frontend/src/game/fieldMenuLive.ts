/**
 * 全画面メニュー (#880) の「中身」を実行時の RPG 状態から作る計算部（どうぐ・まほう・ステータス）。DOM / PixiJS に触れない純粋関数だけを持つ。
 *
 * 画面側（`fieldMenuScreens.ts` / `FieldMenuScreen.ts`）は「入れ物＋定義側から差し込む content」までで、
 * ここが所持品・魔法・人物の実状態から content を組み立て、「使う」を効果 DSL（`spellDsl.ts` の `parseEffect` / `applyEffect`、
 * builtin は `builtin.ts`）で解決する。戦闘の `BattleEngine` とは別経路だが、効果の評価器は同じものを再利用する（効果の書式・乱数の使い方は戦闘と同じ）。
 *
 * 定義側が `menu.items[].content` を書いている項目には触れない（`applyLiveContent` は content が無い項目にだけ差し込む）。
 */
import type { BattleItemEntry, BattleSkillEntry, BattleSpellEntry } from './battleMenu'
import { isReviveEntry, parseSpellTarget } from './battleMenu'
import { invokeBuiltinItem, invokeBuiltinSpell } from './builtin'
import type { FieldMenuItemDef } from './fieldMenu'
import type { FieldMenuContentDef, MenuEntry, MenuTab, StatusRow } from './fieldMenuScreens'
import { applyEffect, parseEffect, type BattleEntity, type EffectContext } from './spellDsl'
import { buildAppStoreTabs, buildEquipContent, type GearMenuContext } from './gearMenu'
import { hasOwn } from './ownProperty'

/** 実行時の RPG 状態（メニューが読む分） */
export interface LiveRpg {
  party: readonly BattleEntity[]
  /** 設定のアイテム定義（定義順） */
  items: readonly BattleItemEntry[]
  /** id → 所持数 */
  inventory: Readonly<Record<string, number>>
  /** せいとんで並べ替えた順（id）。載っていないアイテムは定義順で後ろ */
  itemOrder: readonly string[]
  spells: readonly BattleSpellEntry[]
  skills: readonly BattleSkillEntry[]
  /** 人物 id → 装備のアイテム id */
  equipment: Readonly<Record<string, string[]>>
  /** 刀・防具の売り物の状態 (#881)。`gearShop` を設定したゲームだけ（アプリストア・そうびの中身の元） */
  gear?: GearMenuContext
}

// ---------------------------------------------------------------------------
// 種類・使えるか
// ---------------------------------------------------------------------------

/** どうぐの種類（せいとんの並び順）。`category` に無い名前を書いた場合は、これらの後ろに現れた順で並ぶ */
export const ITEM_CATEGORIES: readonly { id: string; label: string }[] = [
  { id: 'heal', label: 'かいふく' },
  { id: 'status', label: 'じょうたい' },
  { id: 'battle', label: 'せんとう' },
  { id: 'other', label: 'そのほか' },
]

/** 効果 DSL の kind から種類を推す。builtin・解釈できない効果は `other` */
export function categoryOfEffect(effect: string | undefined): string {
  const k = effect ? parseEffect(effect)?.kind : undefined
  switch (k) {
    case 'heal':
    case 'heal_full':
    case 'revive':
      return 'heal'
    case 'cure':
    case 'status':
    case 'buff':
    case 'debuff':
      return 'status'
    case 'damage':
    case 'damage_full':
    case 'steal':
      return 'battle'
    default:
      return 'other'
  }
}

export function itemCategory(item: Pick<BattleItemEntry, 'category' | 'effect'>): string {
  return item.category && item.category !== '' ? item.category : categoryOfEffect(item.effect)
}

/** 種類 id → 表示名。既知はその名前、未知はそのまま */
export function categoryLabel(id: string): string {
  return ITEM_CATEGORIES.find((c) => c.id === id)?.label ?? id
}

/** フィールドで使える効果か（回復・蘇生・状態解除だけ）。builtin は `fieldUse: true` を書いたものだけ */
export function isFieldUsableEntry(e: {
  effect?: string
  builtin?: string
  fieldUse?: boolean
}): boolean {
  if (typeof e.fieldUse === 'boolean') return e.fieldUse
  if (e.builtin || !e.effect) return false
  const k = parseEffect(e.effect)?.kind
  return k === 'heal' || k === 'heal_full' || k === 'revive' || k === 'cure'
}

// ---------------------------------------------------------------------------
// 効果の解決
// ---------------------------------------------------------------------------

type Scope = 'single' | 'all' | 'self'

interface UseTarget {
  scope: Scope
  revive: boolean
}

function itemTarget(e: BattleItemEntry): UseTarget {
  return { scope: 'single', revive: isReviveEntry('item', e) }
}

/** 魔法の対象。フィールドで使えるのは味方側（単体・全体・自分）だけ。それ以外は undefined */
function spellTarget(e: BattleSpellEntry): UseTarget | undefined {
  const spec = parseSpellTarget(e.target)
  if (spec.side !== 'party' || spec.scope === 'none') return undefined
  return { scope: spec.scope as Scope, revive: isReviveEntry('spell', e) }
}

const alive = (e: BattleEntity): boolean => e.hp > 0

/** 効果が対象に効くか（HP・MP・状態・強化のどれかが動くか）を見るための指紋 */
function fingerprint(list: readonly BattleEntity[]): string {
  return JSON.stringify(list.map((t) => [t.hp, t.maxHp, t.mp, t.status ?? null, t.buffs ?? null]))
}

interface EffectRun {
  changed: boolean
  log: string[]
}

/** 効果を 1 回評価する（`targets` を直接書き換える）。変化があったかも返す */
function runEffect(
  e: { effect?: string; builtin?: string },
  kind: 'item' | 'spell',
  caster: BattleEntity,
  targets: BattleEntity[],
  rng: () => number
): EffectRun {
  const before = fingerprint(targets)
  const ctx: EffectContext = { caster, targets, rng }
  let log: string[]
  if (e.builtin) {
    log = kind === 'item' ? invokeBuiltinItem(e.builtin, ctx) : invokeBuiltinSpell(e.builtin, ctx)
  } else if (e.effect) {
    const parsed = parseEffect(e.effect)
    log = parsed ? applyEffect(parsed, ctx) : [`(効果 DSL が解釈できない: '${e.effect}')`]
  } else {
    log = ['(効果定義なし)']
  }
  return { changed: fingerprint(targets) !== before, log }
}

/** 対象に使うと効果があるか（複製で試す。乱数は最大側に固定）。蘇生以外は倒れた者に使えない */
function wouldWork(
  e: { effect?: string; builtin?: string },
  kind: 'item' | 'spell',
  revive: boolean,
  caster: BattleEntity,
  target: BattleEntity
): boolean {
  if (revive ? alive(target) : !alive(target)) return false
  const c = structuredClone(caster)
  const t = c.id === target.id ? c : structuredClone(target)
  return runEffect(e, kind, c, [t], () => 0.999).changed
}

/** 使い手本人の複製を targets と同じ配列から取る形で試すため、パーティ全体を複製して判定する */
function anyTargetWorks(
  e: { effect?: string; builtin?: string },
  kind: 'item' | 'spell',
  revive: boolean,
  caster: BattleEntity,
  party: readonly BattleEntity[]
): boolean {
  return party.some((t) => wouldWork(e, kind, revive, caster, t))
}

export interface FieldUseResult {
  ok: boolean
  /** 説明バーに出す文 */
  notice: string
  /** 使ったあとのパーティ（ok でなければ元のまま） */
  party: BattleEntity[]
  /** 使ったあとの所持数（ok でなければ元のまま） */
  inventory: Record<string, number>
}

function cloneInv(inv: Readonly<Record<string, number>>): Record<string, number> {
  return { ...inv }
}

function pickTargets(
  t: UseTarget,
  party: BattleEntity[],
  caster: BattleEntity | undefined,
  targetId: string | undefined
): BattleEntity[] | string {
  if (t.scope === 'self') return caster ? [caster] : 'つかう人がいません'
  const ok = (e: BattleEntity): boolean => (t.revive ? !alive(e) : alive(e))
  if (t.scope === 'all') {
    const list = party.filter(ok)
    return list.length > 0 ? list : '対象がいません'
  }
  const one = party.find((e) => e.id === targetId)
  if (!one) return '対象がいません'
  if (!ok(one))
    return t.revive ? `${one.name} は まだ たおれていない` : `${one.name} は たおれている`
  return [one]
}

function summarize(
  name: string,
  userName: string,
  targets: BattleEntity[],
  run: EffectRun
): string {
  if (targets.length === 1) return run.log.join(' ')
  return `${userName} は ${name} を つかった！ ${targets.length}人に こうかがあった`
}

/**
 * どうぐを使う。対象 `targetId` に効果があったときだけ所持数を 1 減らす。
 * 効果の使用者（`caster`）は「先頭の生存者」とみなす（どうぐに使用者の選択は無い。回復・蘇生・解除は使用者を読まない）
 */
export function useFieldItem(
  rpg: Pick<LiveRpg, 'party' | 'items' | 'inventory'>,
  itemId: string,
  targetId: string | undefined,
  rng: () => number = Math.random
): FieldUseResult {
  const party = structuredClone(rpg.party) as BattleEntity[]
  const inventory = cloneInv(rpg.inventory)
  const fail = (notice: string): FieldUseResult => ({
    ok: false,
    notice,
    party: rpg.party as BattleEntity[],
    inventory: cloneInv(rpg.inventory),
  })
  const item = rpg.items.find((i) => i.id === itemId)
  if (!item) return fail('そのどうぐは ありません')
  if ((inventory[itemId] ?? 0) <= 0) return fail(`${item.name} は もっていません`)
  if (item.key) return fail('たいせつなものは つかえません')
  if (!isFieldUsableEntry(item)) return fail(`${item.name} は ここでは つかえません`)
  const targets = pickTargets(itemTarget(item), party, undefined, targetId)
  if (typeof targets === 'string') return fail(targets)
  const user = party.find(alive) ?? party[0]
  if (!user) return fail('対象がいません')
  const run = runEffect(item, 'item', user, targets, rng)
  if (!run.changed) return fail(`${item.name} を つかっても こうかが ない`)
  inventory[itemId] -= 1
  return {
    ok: true,
    notice: summarize(item.name, user.name, targets, run),
    party,
    inventory,
  }
}

/** 魔法を使う。MP は効果があったときだけ減らす（効果が無ければ減らさず通知だけ） */
export function useFieldSpell(
  rpg: Pick<LiveRpg, 'party' | 'spells' | 'inventory'>,
  spellId: string,
  casterId: string,
  targetId: string | undefined,
  rng: () => number = Math.random
): FieldUseResult {
  const party = structuredClone(rpg.party) as BattleEntity[]
  const fail = (notice: string): FieldUseResult => ({
    ok: false,
    notice,
    party: rpg.party as BattleEntity[],
    inventory: cloneInv(rpg.inventory),
  })
  const spell = rpg.spells.find((s) => s.id === spellId)
  if (!spell) return fail('その魔法は ありません')
  const caster = party.find((p) => p.id === casterId)
  if (!caster) return fail('つかう人がいません')
  if (!alive(caster)) return fail(`${caster.name} は たおれている`)
  const spec = spellTarget(spell)
  if (!spec || !isFieldUsableEntry(spell)) return fail(`${spell.name} は ここでは つかえません`)
  if (caster.mp < spell.mp) return fail('MPが たりない！')
  const targets = pickTargets(spec, party, caster, targetId)
  if (typeof targets === 'string') return fail(targets)
  const run = runEffect(spell, 'spell', caster, targets, rng)
  if (!run.changed) return fail(`${spell.name} を となえても こうかが ない`)
  caster.mp -= spell.mp
  const head = `${caster.name} は ${spell.name} を となえた！`
  return {
    ok: true,
    notice: `${head} ${targets.length === 1 ? run.log.join(' ') : `${targets.length}人に こうかがあった`}`,
    party,
    inventory: cloneInv(rpg.inventory),
  }
}

// ---------------------------------------------------------------------------
// せいとん
// ---------------------------------------------------------------------------

/** 現在の並び（`itemOrder` を優先し、載っていないものは定義順で後ろ）。たいせつなものは含まない */
export function orderedItems(
  items: readonly BattleItemEntry[],
  order: readonly string[]
): BattleItemEntry[] {
  const normal = items.filter((i) => !i.key)
  const rank = new Map<string, number>()
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i)
  })
  const pos = new Map(normal.map((it, i) => [it.id, i]))
  return [...normal].sort((a, b) => {
    const ra = rank.has(a.id) ? (rank.get(a.id) as number) : order.length + (pos.get(a.id) ?? 0)
    const rb = rank.has(b.id) ? (rank.get(b.id) as number) : order.length + (pos.get(b.id) ?? 0)
    return ra - rb
  })
}

/** 種類別に並べ替えた順（id の配列）。種類は `ITEM_CATEGORIES` の順、未知の種類は現れた順でその後ろ。同じ種類の中は今の並びを保つ */
export function sortItemsByCategory(
  items: readonly BattleItemEntry[],
  order: readonly string[]
): string[] {
  const cur = orderedItems(items, order)
  const known = ITEM_CATEGORIES.map((c) => c.id)
  const extra: string[] = []
  for (const it of cur) {
    const c = itemCategory(it)
    if (!known.includes(c) && !extra.includes(c)) extra.push(c)
  }
  const rank = [...known, ...extra]
  return cur
    .map((it, i) => ({ it, i, r: rank.indexOf(itemCategory(it)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.it.id)
}

// ---------------------------------------------------------------------------
// content の組み立て
// ---------------------------------------------------------------------------

const withReason = (desc: string | undefined, reason: string): string =>
  desc ? `${desc}（${reason}）` : reason

/** どうぐの3タブ（つかう・せいとん・たいせつなもの） */
export function buildItemTabs(rpg: LiveRpg): MenuTab[] {
  const count = (id: string): number => rpg.inventory[id] ?? 0
  const owned = orderedItems(rpg.items, rpg.itemOrder).filter((i) => count(i.id) > 0)
  const probe = rpg.party.find(alive) ?? rpg.party[0]
  const use: MenuEntry[] = owned.map((it) => {
    const usable = isFieldUsableEntry(it)
    const effective =
      usable &&
      probe !== undefined &&
      anyTargetWorks(it, 'item', itemTarget(it).revive, probe, rpg.party)
    const reason = !usable ? 'フィールドでは つかえません' : '対象がいません'
    return {
      id: it.id,
      label: it.name,
      detail: `×${count(it.id)}`,
      enabled: effective,
      description: effective ? (it.description ?? '') : withReason(it.description, reason),
      target: 'single' as const,
    }
  })
  const sort: MenuEntry[] = owned.map((it) => ({
    id: it.id,
    label: it.name,
    detail: `${categoryLabel(itemCategory(it))}  ×${count(it.id)}`,
    description: it.description ?? `${it.name}（${categoryLabel(itemCategory(it))}）`,
  }))
  const key: MenuEntry[] = rpg.items
    .filter((i) => i.key && count(i.id) > 0)
    .map((it) => ({
      id: it.id,
      label: it.name,
      ...(count(it.id) > 1 ? { detail: `×${count(it.id)}` } : {}),
      description: it.description ?? it.name,
    }))
  return [
    { label: 'つかう', entries: use, action: 'use' },
    { label: 'せいとん', entries: sort, action: 'sort' },
    { label: 'たいせつなもの', entries: key, action: 'info' },
  ]
}

/** 人物ごとの魔法の一覧（魔法は共有。MP・生死・対象の有無は使い手ごとに見る） */
export function buildMagicByParty(rpg: LiveRpg): Record<string, MenuEntry[]> {
  const out: Record<string, MenuEntry[]> = {}
  for (const caster of rpg.party) {
    out[caster.id] = rpg.spells.map((sp) => {
      const spec = spellTarget(sp)
      const usable = !!spec && isFieldUsableEntry(sp)
      let reason = ''
      if (!usable) reason = 'フィールドでは つかえません'
      else if (!alive(caster)) reason = 'たおれています'
      else if (caster.mp < sp.mp) reason = 'MPが たりません'
      else if (
        spec &&
        !(spec.scope === 'self'
          ? wouldWork(sp, 'spell', spec.revive, caster, caster)
          : anyTargetWorks(sp, 'spell', spec.revive, caster, rpg.party))
      )
        reason = '対象がいません'
      return {
        id: sp.id,
        label: sp.name,
        detail: usable ? `MP ${sp.mp}` : '',
        enabled: reason === '',
        description: reason === '' ? (sp.description ?? '') : withReason(sp.description, reason),
        target: spec?.scope ?? 'single',
      }
    })
  }
  return out
}

/** ステータス画面に足す行。データのある項目だけ（そうび・わざ）。固有素質・想像の刃は人物ごとなので、定義側の `statusByParty` に書かれたものを足す */
export function buildStatusRows(rpg: LiveRpg): Record<string, StatusRow[]> {
  const out: Record<string, StatusRow[]> = {}
  const nameOf = (id: string): string => rpg.items.find((i) => i.id === id)?.name ?? id
  for (const m of rpg.party) {
    const rows: StatusRow[] = []
    const eq = hasOwn(rpg.equipment, m.id) ? rpg.equipment[m.id] : []
    if (eq.length > 0) rows.push({ label: 'そうび', value: eq.map(nameOf).join('、') })
    // 設定の `skills`（わざ）は全員共通の一覧。人物ごとの「そうぞうのやいば」などは定義側が `statusByParty` で差し込む
    if (rpg.skills.length > 0)
      rows.push({ label: 'わざ', value: rpg.skills.map((s) => s.name).join('、') })
    out[m.id] = rows
  }
  return out
}

/** 定義側の行（固有素質など）を先に、実状態から作った行を後ろに足す */
function mergeStatus(
  live: Record<string, StatusRow[]>,
  def: Record<string, StatusRow[]> | undefined
): Record<string, StatusRow[]> {
  const out: Record<string, StatusRow[]> = {}
  for (const [k, rows] of Object.entries(live)) out[k] = [...(def?.[k] ?? []), ...rows]
  for (const [k, rows] of Object.entries(def ?? {})) if (!hasOwn(out, k)) out[k] = [...rows]
  return out
}

export interface LiveContentInput {
  rpg: LiveRpg
  /** 「せってい」の項目（既定を実状態・接続先に合わせたもの） */
  configOptions: FieldMenuContentDef['options']
}

/**
 * 設定のメニュー項目に、実状態から作った content を差し込む。定義側が content（に該当するキー）を書いている項目はそのまま。
 * - どうぐ（kind: item）: tabs が無いとき 3 タブを差し込む
 * - まほう（id: magic）: entries・entriesByParty が無いとき人物ごとの一覧を差し込む
 * - アプリストア（kind: appstore）: tabs が無く売り物の定義（`rpg.gear`）があるとき、刀／防具のタブを人物ごとの一覧で差し込む
 * - そうび（kind: equip）: entries・entriesByParty が無く売り物の定義があるとき、購入済みの一覧と 2 枠の見出しを差し込む
 * - ステータス（kind: status）: 実状態の行を足す（定義側の行が先）
 * - せってい（kind: config）: options が無いとき `configOptions` を差し込む
 */
export function applyLiveContent(
  items: readonly FieldMenuItemDef[],
  kindOf: (d: FieldMenuItemDef) => string,
  input: LiveContentInput
): FieldMenuItemDef[] {
  return items.map((d) => {
    const kind = kindOf(d)
    const c = d.content
    if (kind === 'item' && !(c?.tabs && c.tabs.length > 0))
      return { ...d, content: { ...c, tabs: buildItemTabs(input.rpg) } }
    if (d.id === 'magic' && kind === 'party-list' && !c?.entries && !c?.entriesByParty)
      return { ...d, content: { ...c, entriesByParty: buildMagicByParty(input.rpg) } }
    // 定義側が中身を書いていれば差し込まない（空配列・空オブジェクトは「書いていない」）
    const authoredTabs = !!c?.tabs?.some(
      (t) => t.entries.length > 0 || t.entriesByParty !== undefined
    )
    const authoredEquip =
      (c?.entries?.length ?? 0) > 0 || Object.keys(c?.entriesByParty ?? {}).length > 0
    if (kind === 'appstore' && input.rpg.gear && !authoredTabs)
      return { ...d, content: { ...c, tabs: buildAppStoreTabs(input.rpg.gear) } }
    if (kind === 'equip' && input.rpg.gear && !authoredEquip)
      return { ...d, content: { ...c, ...buildEquipContent(input.rpg.gear) } }
    if (kind === 'status')
      return {
        ...d,
        content: { ...c, statusByParty: mergeStatus(buildStatusRows(input.rpg), c?.statusByParty) },
      }
    if (kind === 'config' && !(c?.options && c.options.length > 0) && input.configOptions)
      return { ...d, content: { ...c, options: input.configOptions } }
    return d
  })
}
