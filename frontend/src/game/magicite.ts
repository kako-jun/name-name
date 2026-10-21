/**
 * 魔石 (#889)。`[魔石 id]` の宣言を、戦闘に出る味方の能力値・属性・召喚の候補にする純関数群。ブラウザ API にも PixiJS にも触れない。
 *
 * - 装備: `[パーティ]` の `魔石:`（初期装備）と `魔石枠:`（枠の数。既定 1）。枠を超える分・定義の無い id・`装備可` に入っていない味方は警告して捨てる。
 *   武器・防具などのアイテムと魔石を同じ装備の宣言で扱う口は `equipment.ts` (#207)。ここは魔石だけを解く部品（枠・`装備可`・属性の層・ボーナス）を持ち、`equipment.ts` が再利用する。
 *   装備の変更（メニュー UI・保存）は #738 / #880 / #881 の領分で、ここは「いま誰が何を装備しているか」を入力に受けるだけ（`roster.equipment` が `魔石:` を上書きする）
 * - 属性の層: 魔石の召喚獣の属性（と、防具など他の出どころの属性）を**合計 2 層まで**積む。**1 層 = 半減、同じ属性が 2 層 = 吸収**
 *   （`BattleEntity.affinity` に写し、敵の属性攻撃への耐性は #872 の既存の経路で働く）。同時に、積んだ属性は通常攻撃の属性（`attackElements`）にもなる
 * - ボーナス: `装備時`（装備している間だけ足す）と `成長`（レベルアップのたびに恒久で足す。魔石を外しても残る）。書式は `atk+3, hp+20`
 *   （キー hp / mp / atk / def / agi と日本語名 攻撃 / 守備 / 素早さ）。不正な項目は警告して無視する
 * - 召喚: `[特技]` と同じ書式の効果。1 人が 1 バトルで 1 回だけ（`BattleEntity.summoned`。エンジンの `selectSummon`）
 *
 * 魔石を 1 つも宣言していない・装備していない味方は、ここを通っても `BattleEntity` が従来と同一（キーも増えない）。
 */
import type { MagiciteDef, PartyMemberDef } from '../types'
import type { BattleAffinity } from './affinity'
import { normalizeAttrId } from './affinity'
import type { SummonExecution } from './battleEngine'
import type { BattleSummonEntry } from './battleMenu'
import { hasOwn } from './ownProperty'
import type { BattleEntity } from './spellDsl'

/** 魔石のボーナスが触れる能力値 */
export type MagiciteStat = 'hp' | 'mp' | 'atk' | 'def' | 'agi'
export type StatBonus = Partial<Record<MagiciteStat, number>>

/** 既定の魔石枠の数（`魔石枠:` を書かない味方）。FF6 と同じ 1 つ */
export const DEFAULT_MAGICITE_SLOTS = 1
/** 魔石枠の上限。誤記（`魔石枠: 99999`）で巨大な配列を作らないための安全弁 */
export const MAX_MAGICITE_SLOTS = 8
/** 属性の層の上限。魔石と防具の属性を合わせて 1 人 2 つまで（sit-by-me の決定）。超えた分は捨てる */
export const MAX_ELEMENT_LAYERS = 2
/** ボーナス 1 項目の絶対値の上限。誤記で能力値が溢れないための安全弁 */
export const MAX_BONUS_VALUE = 9999

const STAT_ALIASES: Readonly<Record<string, MagiciteStat>> = {
  hp: 'hp',
  mp: 'mp',
  atk: 'atk',
  def: 'def',
  agi: 'agi',
  攻撃: 'atk',
  守備: 'def',
  素早さ: 'agi',
}

/**
 * ボーナスの書式 `atk+3, hp+20, def-1` を読む。区切りはカンマ（`,` `，` `、`）と空白。符号（`+` / `-`）と整数が必須。
 * 同じ能力値は足し合わせる。読めない項目は警告して無視（残りは生かす）。値は ±`MAX_BONUS_VALUE` に丸める。空・未指定は空のボーナス
 */
export function parseStatBonus(raw: string | undefined): { bonus: StatBonus; warnings: string[] } {
  const bonus: StatBonus = {}
  const warnings: string[] = []
  if (typeof raw !== 'string') return { bonus, warnings }
  for (const token of raw.split(/[,，、\s]+/)) {
    if (token === '') continue
    const m = /^(.+?)([+\-＋－])(\d+)$/.exec(token)
    const name = m ? m[1].trim().toLowerCase() : ''
    const key = m && hasOwn(STAT_ALIASES, name) ? STAT_ALIASES[name] : undefined
    if (!m || key === undefined) {
      warnings.push(`ボーナス '${token}' は読めないため無視した（例: atk+3）`)
      continue
    }
    const sign = m[2] === '-' || m[2] === '－' ? -1 : 1
    const value = Math.min(MAX_BONUS_VALUE, Number(m[3]))
    bonus[key] = Math.max(
      -MAX_BONUS_VALUE,
      Math.min(MAX_BONUS_VALUE, (bonus[key] ?? 0) + sign * value)
    )
  }
  return { bonus, warnings }
}

/** ボーナスを足し合わせる（入力は変えない） */
export function addBonus(a: StatBonus, b: StatBonus): StatBonus {
  const out: StatBonus = { ...a }
  for (const k of Object.keys(b) as MagiciteStat[]) {
    out[k] = Math.max(-MAX_BONUS_VALUE, Math.min(MAX_BONUS_VALUE, (out[k] ?? 0) + (b[k] ?? 0)))
  }
  return out
}

/** ボーナスが空か（どの能力値も 0・未指定） */
export function isEmptyBonus(b: StatBonus | undefined): boolean {
  return !b || Object.values(b).every((v) => !v)
}

/** 魔石の装備時ボーナス（解釈できた分だけ）。アイテムの装備時ボーナス (#207) も同じ書式・同じ解釈器（`parseStatBonus`） */
export function equipBonusOf(stone: MagiciteDef): StatBonus {
  return parseStatBonus(stone.equipBonus).bonus
}

/** 魔石を装備している間のボーナスの合計 */
export function totalEquipBonus(stones: readonly MagiciteDef[]): StatBonus {
  return stones.reduce<StatBonus>((acc, s) => addBonus(acc, equipBonusOf(s)), {})
}

/** 味方ごとの、レベルアップで恒久に得たボーナスの累計（味方 id → ボーナス）。魔石を外しても残る。保存は #738 の領分 */
export type MagiciteGrowth = Record<string, StatBonus>

/** 装備中の魔石が `levels` レベル分の成長で足すボーナス（魔石ごとの `成長` × levels の合計）。`levels` が 1 未満・非整数は切り捨てて 0 以上 */
export function levelUpBonus(stones: readonly MagiciteDef[], levels = 1): StatBonus {
  const n = Number.isFinite(levels) ? Math.max(0, Math.floor(levels)) : 0
  let total: StatBonus = {}
  for (const s of stones) {
    const g = parseStatBonus(s.growth).bonus
    for (let i = 0; i < n; i++) total = addBonus(total, g)
  }
  return total
}

/**
 * レベルアップ (#889): 装備中の魔石に対応する成長ボーナスを `memberId` の累計へ足した新しい累計を返す（入力は変えない）。
 * 魔石を変えても、これまでに上がった分は累計に残る。レベルアップを起こす流れ（経験値 → レベル、#738）はここには無い
 */
export function applyLevelUp(
  growth: MagiciteGrowth,
  memberId: string,
  stones: readonly MagiciteDef[],
  levels = 1
): MagiciteGrowth {
  const add = levelUpBonus(stones, levels)
  if (isEmptyBonus(add)) return { ...growth }
  const prev = hasOwn(growth, memberId) ? growth[memberId] : {}
  return { ...growth, [memberId]: addBonus(prev, add) }
}

/** 魔石枠の数。省略は `DEFAULT_MAGICITE_SLOTS`。負・非整数は 0 以上の整数に丸め、`MAX_MAGICITE_SLOTS` で頭打ち */
export function slotCount(def: Pick<PartyMemberDef, 'magiciteSlots'>): number {
  const raw = def.magiciteSlots
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAGICITE_SLOTS
  return Math.min(MAX_MAGICITE_SLOTS, Math.max(0, Math.floor(raw)))
}

/**
 * 味方が装備している魔石を決める。`ids` は装備の指定（`roster.equipment` の上書き、無ければ `def.magicites`）。
 * 定義の無い id・同じ石の重複・`装備可` に入っていない・枠を超える分は、警告して捨てる（書いた順に枠が埋まる）
 */
export function resolveEquipped(
  def: Pick<PartyMemberDef, 'id' | 'magicites' | 'magiciteSlots'>,
  master: Readonly<Record<string, MagiciteDef>> | undefined,
  ids?: readonly string[]
): { stones: MagiciteDef[]; warnings: string[] } {
  const stones: MagiciteDef[] = []
  const warnings: string[] = []
  const want = ids ?? def.magicites ?? []
  const slots = slotCount(def)
  for (const id of want) {
    if (!master || !hasOwn(master, id)) {
      warnings.push(`${def.id}: 魔石 '${id}' は宣言が無いため装備できない`)
      continue
    }
    const stone = master[id]
    if (stones.some((s) => s.id === id)) {
      warnings.push(`${def.id}: 魔石 '${id}' は重複しているため 2 つ目を無視した`)
      continue
    }
    if (
      stone.equippableBy &&
      stone.equippableBy.length > 0 &&
      !stone.equippableBy.includes(def.id)
    ) {
      warnings.push(`${def.id}: 魔石 '${id}' は装備可に含まれないため装備できない`)
      continue
    }
    if (stones.length >= slots) {
      warnings.push(`${def.id}: 魔石枠 ${slots} を超えるため '${id}' は装備できない`)
      continue
    }
    stones.push(stone)
  }
  return { stones, warnings }
}

/**
 * 属性の層を積む。魔石の召喚獣の属性（装備順）→ 防具など他の出どころ（`extra`）の順に積み、`MAX_ELEMENT_LAYERS` を超えた分は捨てる。
 * 属性 id は正規化する（小文字・半角）。空文字は無視。同じ属性が 2 層になるのは有効（吸収）。
 * `stoneLayerCount` は上限を適用した後の魔石由来の層の数（通常攻撃の属性にするのは魔石由来の層だけ。防具の属性は耐性にだけ効く）
 */
export function elementLayers(
  stones: readonly MagiciteDef[],
  extra: readonly string[] = []
): { layers: string[]; stoneLayerCount: number; warnings: string[] } {
  const layers: string[] = []
  const warnings: string[] = []
  const push = (raw: string): void => {
    const id = normalizeAttrId(String(raw).trim())
    if (id === '') return
    if (layers.length >= MAX_ELEMENT_LAYERS) {
      warnings.push(
        `属性は魔石と防具を合わせて ${MAX_ELEMENT_LAYERS} つまでのため '${id}' は無視した`
      )
      return
    }
    layers.push(id)
  }
  for (const s of stones) for (const e of s.elements ?? []) push(e)
  // 魔石由来の層の数（上限を適用した後）。魔石が先に積まれるので、`layers` の先頭からこの数だけが魔石由来
  const stoneLayerCount = layers.length
  for (const e of extra) push(e)
  return { layers, stoneLayerCount, warnings }
}

/**
 * 属性の層 → 耐性。1 層 = 半減、同じ属性が 2 層以上 = 吸収（#872 の既存の 2 欄だけで表す。新しい倍率は足さない）。
 * 層が無ければ undefined（`BattleEntity.affinity` を付けない）
 */
export function layersToAffinity(layers: readonly string[]): BattleAffinity | undefined {
  const count = new Map<string, number>()
  for (const l of layers) count.set(l, (count.get(l) ?? 0) + 1)
  const halve: string[] = []
  const absorb: string[] = []
  for (const [id, n] of count) (n >= 2 ? absorb : halve).push(id)
  if (halve.length === 0 && absorb.length === 0) return undefined
  return {
    ...(halve.length > 0 ? { halve } : {}),
    ...(absorb.length > 0 ? { absorb } : {}),
  }
}

/** 戦闘への組み立て用: 味方 1 人の魔石まわりの結果 */
export interface MemberMagicite {
  /** 装備している魔石（枠の順） */
  stones: MagiciteDef[]
  /** 能力値に足すボーナス（装備時 + 恒久の成長分） */
  bonus: StatBonus
  /** 属性の層（魔石由来 → 防具など他の出どころの順、合計 2 層まで）。耐性の元になる */
  layers: string[]
  /** 通常攻撃の属性。`layers` のうち魔石由来の層だけ（防具など他の出どころの属性は攻撃に乗らない） */
  attackElements: string[]
  /** 耐性（`layers` から作る＝魔石＋防具）。層が無ければ undefined */
  affinity: BattleAffinity | undefined
  warnings: string[]
}

/** 魔石まわりの入力（`FieldBattleRoster` の一部。すべて省略可） */
export interface MagiciteRoster {
  /** 魔石のマスター（`[魔石]`） */
  magicites?: Record<string, MagiciteDef>
  /** 装備の指定（味方 id → 装備の id の列）。あれば `[パーティ]` の `魔石:` / `装備:` を上書きする。`resolveMemberEquipment` (#207) は魔石とアイテムの id を混在で受ける（`resolveMemberMagicite` は魔石だけ）。装備の変更 UI・保存は #738 / #880 / #881 */
  equipment?: Record<string, string[]>
  /** レベルアップで恒久に得たボーナスの累計（味方 id → ボーナス）。装備時ボーナスとは別に足す */
  growth?: MagiciteGrowth
  /** 魔石以外の出どころの属性の層（味方 id → 属性 id の列。防具など、#207）。魔石の属性の後ろに積み、合計 2 層まで */
  extraElements?: Record<string, string[]>
}

/** 味方 1 人の魔石まわりを解決する。何も装備せず成長も層も無ければ、`bonus` / `layers` は空・`affinity` は undefined */
export function resolveMemberMagicite(
  def: Pick<PartyMemberDef, 'id' | 'magicites' | 'magiciteSlots'>,
  roster: MagiciteRoster | undefined
): MemberMagicite {
  const ids =
    roster?.equipment && hasOwn(roster.equipment, def.id) ? roster.equipment[def.id] : undefined
  const equipped = resolveEquipped(def, roster?.magicites, ids)
  const extra =
    roster?.extraElements && hasOwn(roster.extraElements, def.id)
      ? roster.extraElements[def.id]
      : []
  const el = elementLayers(equipped.stones, extra)
  const grown = roster?.growth && hasOwn(roster.growth, def.id) ? roster.growth[def.id] : {}
  return {
    stones: equipped.stones,
    bonus: addBonus(totalEquipBonus(equipped.stones), grown),
    layers: el.layers,
    attackElements: el.layers.slice(0, el.stoneLayerCount),
    affinity: layersToAffinity(el.layers),
    warnings: [...equipped.warnings, ...el.warnings],
  }
}

/**
 * 魔石の結果を戦闘の味方に反映する: 能力値のボーナス（最大 HP / 最大 MP が変わった分だけ現在値も動かす。現在値は 0〜最大値に収め、生きている者は 1 以上に保つ）、
 * 通常攻撃の属性（`attackElements`。魔石由来の層だけ）、耐性（`affinity`。魔石＋防具の全層）。能力値は 0 未満にせず、最大 HP は 1 以上に保つ。何も無ければ `entity` を変えない（キーも増やさない）。警告は 1 度だけ出す
 */
export function applyMemberMagicite(entity: BattleEntity, m: MemberMagicite): void {
  warnMagiciteOnce(m.warnings)
  const b = m.bonus
  if (b.hp) {
    const before = entity.maxHp
    entity.maxHp = Math.max(1, before + b.hp)
    // 実際に増減した分だけ現在値も動かす（hp < maxHp の味方が装備しただけで全回復しない）。倒れている者（0）は起こさない
    if (entity.hp > 0) {
      entity.hp = Math.min(entity.maxHp, Math.max(1, entity.hp + (entity.maxHp - before)))
    }
  }
  if (b.mp) {
    const before = entity.maxMp
    entity.maxMp = Math.max(0, before + b.mp)
    entity.mp = Math.min(entity.maxMp, Math.max(0, entity.mp + (entity.maxMp - before)))
  }
  if (b.atk) entity.atk = Math.max(0, entity.atk + b.atk)
  if (b.def) entity.def = Math.max(0, entity.def + b.def)
  if (b.agi) entity.agi = Math.max(0, entity.agi + b.agi)
  if (m.attackElements.length > 0) entity.attackElements = [...m.attackElements]
  if (m.affinity) entity.affinity = m.affinity
}

/** 既定の召喚の演出文 */
export function defaultSummonMessage(summonName: string): string {
  return `{user} は ${summonName} を よびだした！`
}

/** 魔石 → 召喚の実行内容。`効果` も `builtin` も無い魔石は、演出文だけの召喚（属性とボーナスのためだけの石）になる */
export function toSummonExecution(stone: MagiciteDef): SummonExecution {
  const summonName = stone.summon && stone.summon !== '' ? stone.summon : stone.name
  return {
    name: summonName,
    target: stone.target,
    mp: typeof stone.mp === 'number' && stone.mp > 0 ? Math.floor(stone.mp) : 0,
    ...(stone.effect !== undefined ? { effect: stone.effect } : {}),
    ...(stone.builtin !== undefined ? { builtin: stone.builtin } : {}),
    message:
      stone.message !== undefined && stone.message !== ''
        ? stone.message
        : defaultSummonMessage(summonName),
    ...(stone.cue !== undefined ? { cue: stone.cue } : {}),
  }
}

/** 装備中の魔石 → 候補窓の「しょうかん」の行（枠の順） */
export function summonEntries(stones: readonly MagiciteDef[]): BattleSummonEntry[] {
  return stones.map((s) => ({ id: s.id, ...toSummonExecution(s) }))
}

const warnedMagicite = new Set<string>()

/** 警告を 1 度だけ出す（同じ文面を戦闘のたびに繰り返さない） */
export function warnMagiciteOnce(warnings: readonly string[]): void {
  for (const w of warnings) {
    if (warnedMagicite.has(w)) continue
    warnedMagicite.add(w)
    console.warn(`[name-name] 装備: ${w}`)
  }
}
