/**
 * 状態異常システム (#870)。`[状態 id]`（`StatusDef`）の解釈と、状態に関する純粋な判定関数。
 *
 * - 宣言（マスター）は書いたままの文字列。ここで解釈し、不正な値は警告（`warnings`）を付けて既定に落とす
 *   （効果 DSL・敵の行動ルールと同じ流儀。parser は検証しない）
 * - 定義のある id だけが「働く状態」になる。定義の無い id（従来の `status poison duration=3` だけの印）は何もしない
 *   ＝状態を宣言しないゲームの挙動は完全に従来のまま
 * - 状態の時間は**その者の手番の終わり**に進む（エンジン `battleEngine.ts` が呼ぶ）。持続は常に有限（`MAX_STATUS_TURNS`）
 * - 耐性は属性相性の欄（`[モンスター]` の `弱点/半減/無効/吸収`）に**状態 id をそのまま書く**（`death` と同じ流儀）
 */

import type { StatusDef } from '../types'
import { hasOwn } from './ownProperty'
import { MAX_STATUS_CHANCE, MAX_STATUS_TURNS } from './battleLimits'
import { deathSuccessRate, type AffinityKind } from './affinity'

/** 状態異常の日本語名 → 効果 DSL の `status` が書く英語名（`BattleEntity.status` のキー）。敵 AI の `状態=` 条件がどちらの名前でも一致させるのに使う */
export const STATUS_ALIASES: Readonly<Record<string, string>> = {
  毒: 'poison',
  麻痺: 'paralysis',
  混乱: 'confusion',
  眠り: 'sleep',
}

/** `持続:` も `duration=` も無いときの持続ターン数 */
export const DEFAULT_STATUS_TURNS = 3

/** 手番の終わりの継続ダメージ。`fraction` = 最大 HP の num/den（最低 1）、`range` = 固定幅（min と max が同じなら固定値） */
export type StatusTick =
  | { kind: 'fraction'; num: number; den: number }
  | { kind: 'range'; min: number; max: number }

/** 行動の乱れ。`stun` = 手番を飛ばす（行動不能）、`confuse` = 通常攻撃が自陣営の生存者へランダムに向く */
export type StatusAction = 'normal' | 'stun' | 'confuse'

/** 解釈済みの状態の規則 */
export interface StatusRule {
  id: string
  name: string
  /** 既定の持続ターン数（1〜`MAX_STATUS_TURNS`） */
  duration: number
  tick?: StatusTick
  action: StatusAction
  /** 回復（`heal` / `heal_full`）がダメージになる */
  reverseHeal: boolean
  /** ダメージ（`damage` / `damage_full`）が回復になる（即死は全回復） */
  reverseDamage: boolean
  /** HP が減ったら解ける */
  cureOnDamage: boolean
  /** 持続が尽きたら戦闘不能になる */
  expireDeath: boolean
  /** 解釈で出た警告（不正な値を既定に落とした旨） */
  warnings: string[]
}

/** 区切り（`,` `，` `、` 空白）で値を割る */
function splitList(raw: string): string[] {
  return raw.split(/[,，、\s]+/).filter((t) => t !== '')
}

/** 全角数字・`.`・`/` などを半角にして前後の空白を落とす（`1／16` `５..８` を許す） */
function halfwidth(raw: string): string {
  return raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/／/g, '/')
    .replace(/．/g, '.')
}

function parseTick(raw: string, warnings: string[]): StatusTick | undefined {
  const v = halfwidth(raw)
  const frac = v.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (frac) {
    const num = Number(frac[1])
    const den = Number(frac[2])
    if (den >= 1 && num >= 1) return { kind: 'fraction', num, den }
    warnings.push(`継続ダメージ '${raw}' は分子・分母が 1 以上でないため無視した`)
    return undefined
  }
  const range = v.match(/^(\d+)\.\.(\d+)$/)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    return { kind: 'range', min: Math.min(a, b), max: Math.max(a, b) }
  }
  if (/^\d+$/.test(v)) return { kind: 'range', min: Number(v), max: Number(v) }
  warnings.push(`継続ダメージ '${raw}' は 1/16・5..8・5 のどれでもないため無視した`)
  return undefined
}

/** `[状態]` 1 つを規則にする。不正な値は警告を積んで既定に落とす（例外は投げない） */
export function parseStatusDef(def: StatusDef): StatusRule {
  const warnings: string[] = []
  let duration = DEFAULT_STATUS_TURNS
  if (def.duration !== undefined) {
    const v = halfwidth(def.duration)
    if (/^\d+$/.test(v) && Number(v) >= 1) {
      duration = Math.min(Number(v), MAX_STATUS_TURNS)
      if (Number(v) > MAX_STATUS_TURNS) {
        warnings.push(
          `持続 ${v} は上限 ${MAX_STATUS_TURNS} を超えたため ${MAX_STATUS_TURNS} にした`
        )
      }
    } else {
      warnings.push(
        `持続 '${def.duration}' は 1 以上の整数でないため ${DEFAULT_STATUS_TURNS} にした`
      )
    }
  }
  const tick = def.tickDamage !== undefined ? parseTick(def.tickDamage, warnings) : undefined

  let action: StatusAction = 'normal'
  if (def.action !== undefined) {
    const v = def.action.trim()
    if (v === '不能' || v === '行動不能') action = 'stun'
    else if (v === '混乱') action = 'confuse'
    else if (v !== '通常')
      warnings.push(`行動 '${def.action}' は 不能 / 混乱 / 通常 のどれでもないため通常にした`)
  }

  let reverseHeal = false
  let reverseDamage = false
  if (def.reverse !== undefined) {
    for (const t of splitList(def.reverse)) {
      if (t === '回復') reverseHeal = true
      else if (t === 'ダメージ') reverseDamage = true
      else warnings.push(`反転 '${t}' は 回復 / ダメージ のどちらでもないため無視した`)
    }
  }

  let cureOnDamage = false
  if (def.cure !== undefined) {
    for (const t of splitList(def.cure)) {
      if (t === '被ダメージ') cureOnDamage = true
      else warnings.push(`解除 '${t}' は 被ダメージ ではないため無視した`)
    }
  }

  let expireDeath = false
  if (def.expire !== undefined) {
    const v = def.expire.trim()
    if (v === '戦闘不能') expireDeath = true
    else warnings.push(`満了 '${v}' は 戦闘不能 ではないため無視した`)
  }

  return {
    id: def.id,
    name: def.name,
    duration,
    ...(tick ? { tick } : {}),
    action,
    reverseHeal,
    reverseDamage,
    cureOnDamage,
    expireDeath,
    warnings,
  }
}

/** `[状態]` のマスターを規則の表にする（id をキーにしたまま。警告は各規則の `warnings`） */
export function buildStatusRules(
  defs: Readonly<Record<string, StatusDef>> | undefined
): Record<string, StatusRule> {
  const out: Record<string, StatusRule> = {}
  if (!defs) return out
  for (const [id, def] of Object.entries(defs)) {
    Object.defineProperty(out, id, {
      value: parseStatusDef({ ...def, id }),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/**
 * 効果 DSL の状態名から、規則の表のキーを引く。同名があればそれ、無ければ日本語名の別名（毒 → poison）。
 * 規則が無ければ null（従来の「印だけ」の状態）
 */
export function resolveRuleId(
  rules: Readonly<Record<string, StatusRule>> | undefined,
  state: string
): string | null {
  if (!rules) return null
  if (hasOwn(rules, state)) return state
  const alias = hasOwn(STATUS_ALIASES, state) ? STATUS_ALIASES[state] : undefined
  return alias !== undefined && hasOwn(rules, alias) ? alias : null
}

/** 者に付いている（残りターンが 1 以上の）働く状態の規則を、付いた順に返す */
export function activeStatusRules(
  entity: { status?: Partial<Record<string, number>> },
  rules: Readonly<Record<string, StatusRule>> | undefined
): StatusRule[] {
  const st = entity.status
  if (!st || !rules) return []
  const out: StatusRule[] = []
  for (const key of Object.keys(st)) {
    const turns = st[key]
    if (typeof turns === 'number' && turns > 0 && hasOwn(rules, key)) out.push(rules[key])
  }
  return out
}

/** 行動の乱れ。行動不能が混乱に優先する。無ければ null。{ action, rule } は表示・ログ用に原因の規則を添える */
export function blockingAction(
  entity: { status?: Partial<Record<string, number>> },
  rules: Readonly<Record<string, StatusRule>> | undefined
): { action: 'stun' | 'confuse'; rule: StatusRule } | null {
  let confuse: StatusRule | null = null
  for (const r of activeStatusRules(entity, rules)) {
    if (r.action === 'stun') return { action: 'stun', rule: r }
    if (r.action === 'confuse' && !confuse) confuse = r
  }
  return confuse ? { action: 'confuse', rule: confuse } : null
}

/** 回復・ダメージの反転。複数の状態のどれかが持っていれば有効 */
export function reversalOf(
  entity: { status?: Partial<Record<string, number>> },
  rules: Readonly<Record<string, StatusRule>> | undefined
): { heal: boolean; damage: boolean; rule?: StatusRule } {
  let heal = false
  let damage = false
  let rule: StatusRule | undefined
  for (const r of activeStatusRules(entity, rules)) {
    if (r.reverseHeal || r.reverseDamage) rule ??= r
    heal ||= r.reverseHeal
    damage ||= r.reverseDamage
  }
  return rule ? { heal, damage, rule } : { heal, damage }
}

/** 戦闘画面に出す状態名（付いた順）。定義のある状態だけ */
export function statusLabels(
  entity: { status?: Partial<Record<string, number>> },
  rules: Readonly<Record<string, StatusRule>> | undefined
): string[] {
  return activeStatusRules(entity, rules).map((r) => r.name)
}

/**
 * 付与の成功率（0〜1）。`chance` は効果 DSL の `確率=`（%。省略 = undefined は必中 = 1）。
 * 使い手の成長ぶん `bonus`（点）を足し、`MAX_STATUS_CHANCE` で頭打ちにしてから、相手の耐性（属性相性の欄に書いた状態 id）で変える:
 * 無効・吸収 = 0 / 半減 = ×0.5 / 弱点 = ×2（上限 99%。元より下がらない）。即死耐性 (#872) と同じ式。
 * `確率=` を書かない付与は耐性が無ければ必中（従来どおり乱数を使わない）
 */
export function statusSuccessRate(
  kind: AffinityKind,
  chance: number | undefined,
  bonus: number | undefined
): number {
  let base = 1
  if (chance !== undefined) {
    // 成長ぶんが NaN・未指定なら 0。+Infinity は上限（99）、-Infinity は 0 に収まる
    const b = typeof bonus === 'number' && !Number.isNaN(bonus) ? bonus : 0
    base = Math.min(MAX_STATUS_CHANCE, Math.max(0, chance + b)) / 100
  }
  return deathSuccessRate(kind, base)
}
