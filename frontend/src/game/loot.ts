/**
 * 敵の戦利品（ドロップ・ぬすむの通常枠とレア枠）の解釈と抽選 (#831)。
 *
 * 純粋関数だけを持つ（PixiJS・DOM・エンジンに触れない）。乱数は呼び出し側が注入する `rng`（ADR 0002。
 * セーブ・リプレイで再現できる）。「戦利品を宣言しない敵・使わない戦闘」は乱数を 1 回も使わない（旧挙動不変）。
 *
 * 敵の宣言（`[モンスター]` の `ドロップ:` `ぬすむ:` `ぬすむレア:` `ぬすむ回数:`）は parser が生文字列で透過し、ここで解釈する
 * （効果 DSL・`行動:` と同じ流儀）。1 行 = `<アイテムid> [確率=P] [個数=N]`。
 * - アイテム id は呼び出し側（ゲーム）が決める不透明な文字列。アイテムマスターに無くてもよい
 * - `確率=P` は 0〜100 の数（小数可。省略は 100）。`個数=N` は 1〜`MAX_LOOT_COUNT` の整数（省略は 1）
 * - 不正な行は無視して警告を返す（エンジンが 1 度だけ `console.warn` する）。不正な `確率=` の行は**捨てる**
 *   （誤記で必ず手に入る行にならない安全側）。不正な `個数=` は 1 個に落とす
 *
 * 抽選の規則:
 * - ドロップ: 行ごとに独立に判定する（勝利時）。確率 100 以上・0 以下は乱数を使わない
 * - ぬすむ: 成功判定（`確率=`）→ 枠の決定（レア率）→ 枠の中の行を先頭から順に判定し、最初に当たった 1 行。
 *   盗めた回数が `ぬすむ回数`（既定 1）に達した敵・枠を持たない敵は空（乱数を使わない）。失敗しても盗めた回数は減らない
 */
import { rollDeath } from './affinity'
import { MAX_STEAL_CHANCE } from './battleLimits'
import type { MonsterLoot } from '../types'

/** 1 行で指定できる個数の上限 */
export const MAX_LOOT_COUNT = 99
/**
 * `MonsterDef.loot` を戦闘への組み立て用の `{ loot }` にする。無い・全欄が空なら `{}`（書かない敵の `BattleEntity` は従来と同一）。
 * 配列は複製して渡す（マスターを戦闘が共有しない）
 */
export function lootField(
  loot: MonsterLoot | undefined
): { loot: MonsterLoot } | Record<string, never> {
  if (!loot) return {}
  const out: MonsterLoot = {}
  if (loot.drops && loot.drops.length > 0) out.drops = [...loot.drops]
  if (loot.steal && loot.steal.length > 0) out.steal = [...loot.steal]
  if (loot.stealRare && loot.stealRare.length > 0) out.stealRare = [...loot.stealRare]
  if (typeof loot.stealLimit === 'string' && loot.stealLimit.trim() !== '') {
    out.stealLimit = loot.stealLimit
  }
  return Object.keys(out).length > 0 ? { loot: out } : {}
}

/** アイテムマスターから戦利品のログ用の表示名（id → 名前）を作る。マスターが無ければ undefined */
export function itemNamesOf(
  items: Record<string, { name: string }> | undefined
): Record<string, string> | undefined {
  if (!items) return undefined
  const out: Record<string, string> = {}
  for (const [id, def] of Object.entries(items)) {
    if (def && typeof def.name === 'string' && def.name !== '') out[id] = def.name
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 盗める回数の上限（数値で書いたとき）。`無限` は Infinity */
export const MAX_STEAL_LIMIT = 99
/** `枠=両方` のときにレア枠へ回る割合の既定（%）。FF の 1/8 */
export const DEFAULT_RARE_RATE = 12.5

/** 戦利品の 1 行（解釈済み） */
export interface LootLine {
  itemId: string
  /** 0〜100（%） */
  chance: number
  count: number
}

/** 敵 1 体ぶんの戦利品の宣言（解釈済み） */
export interface LootSpec {
  drops: LootLine[]
  steal: LootLine[]
  stealRare: LootLine[]
  /** 盗める回数（1 以上。無限は Infinity） */
  stealLimit: number
  /** 解釈時の警告（不正な行・値） */
  warnings: string[]
}

/** 獲得した戦利品 1 件（戦闘中の事実の記録。ホストへ渡す） */
export interface LootEntry {
  itemId: string
  count: number
  /** `drop` = 倒したあとのドロップ / `steal` = ぬすんだ品 */
  via: 'drop' | 'steal'
  /** ぬすむのレア枠から取った品か（ドロップは常に false） */
  rare: boolean
  /** 取った元の敵（`BattleEntity.id` と表示名） */
  enemyId: string
  enemyName: string
}

/**
 * 戦闘の終わり方。`interrupted` = 脚本が勝敗がつく前に中断した (#741)。経験値・ゴールド・ドロップは victory のときだけで、
 * ホストは勝敗のどちらでもない扱い（暗転して次の場面へ、など）にする
 */
export type BattleOutcome = 'victory' | 'defeat' | 'escaped' | 'interrupted'

/**
 * 脚本制御の戦闘 (#741) の結果。`[戦闘 id]` で始めた戦闘にだけ付く（普通のエンカウントの結果には付かない）。
 * `flags` は `勝利時` `敗北時` `中断時` `逃走時` の `フラグ=` で宣言したもの（値は `[フラグ:]` と同じく真偽・数値・文字列）で、
 * ホストが自分のフラグに反映する。`next` は `次=` のイベント名。**エンジンは `flags` を保存しない**（反映と保存はホストの責務）
 */
export interface BattleScriptResult {
  id: string
  flags: Record<string, boolean | number | string>
  next?: string
}

/** ホストへ渡す戦闘の結果 */
export interface BattleResult {
  outcome: BattleOutcome
  /** 入手経験値・ゴールド（victory のときだけ入る。それ以外は 0） */
  exp: number
  gold: number
  /** 獲得した戦利品（獲得順）。ぬすんだ品は逃走・敗北でも入る、ドロップは victory のときだけ */
  loot: LootEntry[]
  /** `loot` をアイテム id ごとに個数で集計したもの（初めて出た順） */
  items: { itemId: string; count: number }[]
  /** 脚本制御の戦闘 (#741) のとき、その結果（結果フラグ・次のイベント）。普通の戦闘には付かない */
  script?: BattleScriptResult
}

/** `loot` をアイテム id ごとの個数に集計する（初めて出た順） */
export function summarizeLoot(loot: readonly LootEntry[]): { itemId: string; count: number }[] {
  const order: string[] = []
  const totals = new Map<string, number>()
  for (const e of loot) {
    if (!totals.has(e.itemId)) order.push(e.itemId)
    totals.set(e.itemId, (totals.get(e.itemId) ?? 0) + e.count)
  }
  return order.map((itemId) => ({ itemId, count: totals.get(itemId) ?? 0 }))
}

const CHANCE_KEYS = ['確率', 'chance']
const COUNT_KEYS = ['個数', '数', 'count']

/** 非負の素直な十進数（符号・指数表記・空白なし）。小数可 */
function parseDecimal(raw: string): number | null {
  return /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : null
}

/** 戦利品の 1 行を解釈する。取れない行は `line` が無く `warning` が付く */
export function parseLootLine(raw: string): { line?: LootLine; warning?: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { warning: '空の行は無視した' }
  const itemId = tokens[0]
  if (itemId.includes('=')) {
    return { warning: `'${raw.trim()}': 先頭にアイテム id が無いため無視した` }
  }
  let chance = 100
  let count = 1
  const notes: string[] = []
  for (const t of tokens.slice(1)) {
    const eq = t.indexOf('=')
    const key = eq < 0 ? t : t.slice(0, eq)
    const value = eq < 0 ? '' : t.slice(eq + 1)
    if (CHANCE_KEYS.includes(key)) {
      const n = parseDecimal(value)
      if (n === null) {
        return { warning: `'${raw.trim()}': 確率=${value} は 0〜100 の数でないため行ごと無視した` }
      }
      if (n > 100) {
        notes.push(`確率=${value} は 100 を超えたため 100 にした`)
        chance = 100
      } else {
        chance = n
      }
    } else if (COUNT_KEYS.includes(key)) {
      const n = /^\d+$/.test(value) ? Number(value) : NaN
      if (!Number.isFinite(n) || n < 1) {
        notes.push(`個数=${value} は 1 以上の整数でないため 1 個にした`)
        count = 1
      } else if (n > MAX_LOOT_COUNT) {
        notes.push(`個数=${value} は上限 ${MAX_LOOT_COUNT} を超えたため ${MAX_LOOT_COUNT} 個にした`)
        count = MAX_LOOT_COUNT
      } else {
        count = n
      }
    } else {
      notes.push(`'${t}' は未知の指定のため無視した`)
    }
  }
  return {
    line: { itemId, chance, count },
    ...(notes.length > 0 ? { warning: `'${raw.trim()}': ${notes.join(' / ')}` } : {}),
  }
}

/** 盗める回数の宣言を解釈する。数（1 以上の整数）か `無限`。空・不正は 1（警告つき） */
export function parseStealLimit(raw: string | undefined): { limit: number; warning?: string } {
  if (raw === undefined) return { limit: 1 }
  const v = raw.trim()
  if (v === '無限' || v.toLowerCase() === 'infinite' || v.toLowerCase() === 'inf') {
    return { limit: Infinity }
  }
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    if (n >= 1 && n <= MAX_STEAL_LIMIT) return { limit: n }
    if (n > MAX_STEAL_LIMIT) {
      return {
        limit: MAX_STEAL_LIMIT,
        warning: `ぬすむ回数 '${v}' は上限 ${MAX_STEAL_LIMIT} を超えたため ${MAX_STEAL_LIMIT} にした`,
      }
    }
  }
  return { limit: 1, warning: `ぬすむ回数 '${v}' は 1 以上の整数か「無限」でないため 1 回にした` }
}

/**
 * 敵の戦利品の宣言を解釈する。取れる行が 1 つも無く警告も無ければ null（＝戦利品なし）。
 * 取れる行が無くても警告があれば仕様を返す（警告を出すため。抽選は空になる）。
 */
export function parseLootSpec(loot: MonsterLoot | undefined): LootSpec | null {
  if (!loot) return null
  const warnings: string[] = []
  const lines = (label: string, raws: string[] | undefined): LootLine[] => {
    const out: LootLine[] = []
    for (const raw of raws ?? []) {
      const r = parseLootLine(raw)
      if (r.warning) warnings.push(`${label}: ${r.warning}`)
      if (r.line) out.push(r.line)
    }
    return out
  }
  const drops = lines('ドロップ', loot.drops)
  const steal = lines('ぬすむ', loot.steal)
  const stealRare = lines('ぬすむレア', loot.stealRare)
  const lim = parseStealLimit(loot.stealLimit)
  if (lim.warning) warnings.push(lim.warning)
  if (
    drops.length === 0 &&
    steal.length === 0 &&
    stealRare.length === 0 &&
    warnings.length === 0 &&
    loot.stealLimit === undefined
  ) {
    return null
  }
  return { drops, steal, stealRare, stealLimit: lim.limit, warnings }
}

/** ドロップの抽選。行ごとに独立（確率 100 以上・0 以下は乱数を使わない）。取れた行を宣言順に返す */
export function rollDrops(spec: LootSpec, rng: () => number): LootLine[] {
  return spec.drops.filter((l) => rollDeath(l.chance / 100, rng))
}

/** どの枠を狙うか。`both` = レア枠を先に判定して外れたら通常枠 / `rare` = レア枠だけ / `normal` = 通常枠だけ */
export type StealSlot = 'both' | 'normal' | 'rare'

/** ぬすむ 1 回の指定（効果 DSL `steal` の値と、使い手の加算） */
export interface StealParams {
  /** 成功率（%、0〜100）。省略 = 必中（乱数を使わない） */
  chance?: number
  /** レア枠に回る割合（%）。省略は `both` で `DEFAULT_RARE_RATE`、`rare` で 100 */
  rareRate?: number
  /** 狙う枠（省略は both） */
  slot?: StealSlot
  /** 使い手の成功率への加算（点）。`chance` を書いたときだけ効く。加算で `MAX_STEAL_CHANCE` を超えては上がらない（元から超える値は下げない） */
  chanceBonus?: number
  /** 使い手のレア率への加算（点）。加算で `MAX_STEAL_CHANCE` を超えては上がらない（元から超える値は下げない） */
  rareBonus?: number
}

/**
 * ぬすむの結果。
 * - `empty`: 盗めるものがない（盗める回数に達した・その枠を持たない）。乱数は使わない
 * - `miss`: 盗めなかった（成功判定の失敗・枠の抽選や行の判定が外れた）。盗める回数は減らない
 * - `got`: 盗めた
 */
export type StealOutcome =
  | { kind: 'empty' }
  | { kind: 'miss' }
  | { kind: 'got'; line: LootLine; rare: boolean }

/** 成功率・レア率に加算を載せる。加算で `MAX_STEAL_CHANCE` を超えては上がらない（元から超える値は下げない）、下限 0。NaN の加算は 0 */
function withBonus(base: number, bonus: number | undefined): number {
  const b = typeof bonus === 'number' && !Number.isNaN(bonus) ? bonus : 0
  if (b === 0) return Math.max(0, Math.min(100, base))
  return Math.max(0, Math.min(Math.max(base, MAX_STEAL_CHANCE), base + b))
}

/**
 * 敵 1 体にぬすむを 1 回試みる。`stolenSoFar` はその敵から既に盗めた回数（エンジンが数える）。
 * 乱数の消費順は「成功判定 → レア枠の判定 → 枠の中の行（確率が 0〜100 の間の行だけ）」。
 */
export function attemptSteal(
  spec: LootSpec,
  stolenSoFar: number,
  params: StealParams,
  rng: () => number
): StealOutcome {
  const slot: StealSlot = params.slot ?? 'both'
  const hasNormal = spec.steal.length > 0
  const hasRare = spec.stealRare.length > 0
  const available = slot === 'normal' ? hasNormal : slot === 'rare' ? hasRare : hasNormal || hasRare
  if (stolenSoFar >= spec.stealLimit || !available) return { kind: 'empty' }

  // 成功判定。`確率=` が無ければ必中（乱数を使わない）。加算は `確率=` を書いたときだけ効く
  if (params.chance !== undefined) {
    if (!rollDeath(withBonus(params.chance, params.chanceBonus) / 100, rng)) return { kind: 'miss' }
  }

  // 枠の決定
  let rare: boolean
  if (slot === 'normal') {
    rare = false
  } else if (slot === 'rare') {
    const rate = withBonus(params.rareRate ?? 100, params.rareBonus)
    if (!rollDeath(rate / 100, rng)) return { kind: 'miss' }
    rare = true
  } else if (!hasRare) {
    rare = false
  } else {
    const rate = withBonus(params.rareRate ?? DEFAULT_RARE_RATE, params.rareBonus)
    rare = rollDeath(rate / 100, rng)
  }

  const lines = rare ? spec.stealRare : spec.steal
  for (const line of lines) {
    if (rollDeath(line.chance / 100, rng)) return { kind: 'got', line, rare }
  }
  return { kind: 'miss' }
}
