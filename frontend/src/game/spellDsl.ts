/**
 * 呪文 / アイテム の効果 DSL パーサー + 評価器 (#174 / #173)。
 *
 * 設計合意（kako-jun と 2026-05-09 セッションで確定、#176）:
 * - 単純な効果は宣言的 DSL（`heal 15..25` 等）で書き、parser/runtime で網羅評価する
 * - 複雑な振る舞い（ザラキ、ルーラ、メダパニ等）は `builtin: <slug>` で TypeScript 実装に委譲する
 * - 専用関数は引数なしで全責任を持つ（DSL は引数を持つ汎用関数）
 *
 * 本モジュールは前者（汎用関数）の DSL を扱う。BUILTIN は `builtin.ts` を参照。
 *
 * 文法（最低セット、段階的に拡張）:
 *   heal {min}..{max}              # 一様乱数で min..max を回復
 *   heal_full                      # 完全回復
 *   damage {min}..{max} [type=...] # 一様乱数で min..max のダメージ。type は耐性計算用
 *   damage_full                    # 即死
 *   buff {stat}=+{n} duration={t}  # ATK+/DEF+/AGI+ 一定ターン強化
 *   debuff {stat}=-{n} duration={t}
 *   revive [hp=full|hp=half]       # 蘇生
 *   status {state} duration={t}    # 毒/麻痺/混乱/眠り
 *   escape_battle                  # 戦闘離脱
 *   escape_dungeon                 # ダンジョン脱出
 *
 * 不正な式は `parseEffect` で `null` を返し、runtime は warning を出して no-op する。
 */

import { hasOwn } from './ownProperty'

export type EffectKind =
  | 'heal'
  | 'heal_full'
  | 'damage'
  | 'damage_full'
  | 'buff'
  | 'debuff'
  | 'revive'
  | 'status'
  | 'escape_battle'
  | 'escape_dungeon'

export type StatKey = 'hp' | 'mp' | 'atk' | 'def' | 'agi'

export interface ParsedEffect {
  kind: EffectKind
  /** heal/damage の範囲下限（min と max が同値なら固定値） */
  min?: number
  /** heal/damage の範囲上限 */
  max?: number
  /** damage の系統（fire / ice / holy / breath 等）。耐性計算用 */
  type?: string
  /** buff/debuff のターゲット ステータス */
  stat?: StatKey
  /** buff/debuff の増減量（`+5` / `-3`） */
  delta?: number
  /** buff/debuff/status の有効ターン */
  duration?: number
  /** revive の hp 指定（full / half、省略時は full） */
  hp?: 'full' | 'half'
  /** status の状態名（poison / paralysis / confusion / sleep 等） */
  state?: string
}

/**
 * 効果 DSL 文字列をパースする。文法エラー時は null。
 *
 * 例:
 *   parseEffect("heal 15..25")             → { kind: 'heal', min: 15, max: 25 }
 *   parseEffect("damage 8..14 type=fire")  → { kind: 'damage', min: 8, max: 14, type: 'fire' }
 *   parseEffect("buff atk=+5 duration=3")  → { kind: 'buff', stat: 'atk', delta: 5, duration: 3 }
 *   parseEffect("revive")                  → { kind: 'revive', hp: 'full' }
 *   parseEffect("escape_battle")           → { kind: 'escape_battle' }
 */
export function parseEffect(input: string): ParsedEffect | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  // 単独動詞のキーワード
  if (trimmed === 'heal_full') return { kind: 'heal_full' }
  if (trimmed === 'damage_full') return { kind: 'damage_full' }
  if (trimmed === 'escape_battle') return { kind: 'escape_battle' }
  if (trimmed === 'escape_dungeon') return { kind: 'escape_dungeon' }

  const tokens = trimmed.split(/\s+/)
  const verb = tokens[0]
  const rest = tokens.slice(1)

  if (verb === 'heal') {
    const range = parseRange(rest[0])
    if (!range) return null
    return { kind: 'heal', min: range.min, max: range.max }
  }
  if (verb === 'damage') {
    const range = parseRange(rest[0])
    if (!range) return null
    const out: ParsedEffect = { kind: 'damage', min: range.min, max: range.max }
    for (const t of rest.slice(1)) {
      const [k, v] = splitKv(t)
      if (k === 'type' && v) out.type = v
    }
    return out
  }
  if (verb === 'buff' || verb === 'debuff') {
    // 例: "buff atk=+5 duration=3"
    let stat: StatKey | undefined
    let delta: number | undefined
    let duration: number | undefined
    for (const t of rest) {
      const [k, v] = splitKv(t)
      if (!v) continue
      if (k === 'duration') {
        duration = parseInt(v, 10)
      } else if (isStatKey(k)) {
        stat = k
        delta = parseSignedInt(v)
      }
    }
    if (stat === undefined || delta === undefined || !Number.isFinite(delta)) return null
    if (verb === 'debuff' && delta > 0) delta = -delta
    return { kind: verb, stat, delta, duration }
  }
  if (verb === 'revive') {
    let hp: 'full' | 'half' = 'full'
    for (const t of rest) {
      const [k, v] = splitKv(t)
      if (k === 'hp' && (v === 'full' || v === 'half')) hp = v
    }
    return { kind: 'revive', hp }
  }
  if (verb === 'status') {
    if (rest.length === 0) return null
    const state = rest[0]
    let duration: number | undefined
    for (const t of rest.slice(1)) {
      const [k, v] = splitKv(t)
      if (k === 'duration' && v) duration = parseInt(v, 10)
    }
    return { kind: 'status', state, duration }
  }
  return null
}

function parseRange(raw: string | undefined): { min: number; max: number } | null {
  if (!raw) return null
  // "15..25" or "30"
  const m = raw.match(/^(-?\d+)\.\.(-?\d+)$/)
  if (m) {
    const min = parseInt(m[1], 10)
    const max = parseInt(m[2], 10)
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    return min <= max ? { min, max } : { min: max, max: min }
  }
  const single = parseInt(raw, 10)
  if (!Number.isNaN(single) && /^-?\d+$/.test(raw)) {
    return { min: single, max: single }
  }
  return null
}

function splitKv(token: string): [string, string | undefined] {
  const eq = token.indexOf('=')
  if (eq < 0) return [token, undefined]
  return [token.slice(0, eq), token.slice(eq + 1)]
}

function parseSignedInt(value: string): number {
  // "+5" / "-3" / "5" を許容
  const cleaned = value.startsWith('+') ? value.slice(1) : value
  const n = parseInt(cleaned, 10)
  return Number.isFinite(n) ? n : NaN
}

function isStatKey(k: string): k is StatKey {
  return k === 'hp' || k === 'mp' || k === 'atk' || k === 'def' || k === 'agi'
}

/**
 * 効果評価のための実行コンテキスト。
 * - caster: 効果を発動した側（味方/敵）
 * - targets: 効果を受ける対象配列。target スコープに応じて呼び出し側で 1 体 or 全体を渡す
 * - rng: 0..1 の一様乱数を返す関数（テスト時に固定値で差し替え可能）
 */
export interface EffectContext {
  caster: BattleEntity
  targets: BattleEntity[]
  rng: () => number
}

/** 戦闘エンティティ（味方/敵共通の最小スキーマ） */
export interface BattleEntity {
  id: string
  name: string
  hp: number
  maxHp: number
  mp: number
  maxMp: number
  atk: number
  def: number
  agi: number
  /** type 別耐性（'fire' → 0.5 = 半減 / 1.0 = 等倍 / 0 = 無効 / 2.0 = 弱点）。未指定は 1.0 */
  resist?: Partial<Record<string, number>>
  /** 状態異常（毒/麻痺/混乱/眠り など）。値は残ターン */
  status?: Partial<Record<string, number>>
  /** buff / debuff の累積値（atk+5 等）。残ターン管理は将来 Issue */
  buffs?: Partial<Record<StatKey, number>>
  /** 倒したときに得られる経験値（敵側のみ、味方は undefined） */
  exp?: number
  /** 倒したときに落とすゴールド（敵側のみ） */
  gold?: number
}

/**
 * 解釈済み効果を実行する。コンテキストの targets を直接ミューテートする
 * （pure ではない）。戻り値は人間可読のログ行群（戦闘ログ表示用）。
 *
 * 不正パラメータや未対応 kind は `[]` を返して silent skip するのではなく、
 * ログに `(警告: ...)` を入れて呼び出し側が表示できるようにする。
 */
export function applyEffect(effect: ParsedEffect, ctx: EffectContext): string[] {
  const log: string[] = []
  switch (effect.kind) {
    case 'heal':
    case 'heal_full': {
      // heal_full は Math.min(maxHp, hp + Infinity) で完全回復になる前提。
      // entity.maxHp は有限値である必要があり（Infinity 渡すと NaN ログになる）、
      // BattleEntity 生成時にこれを保証する責務は呼び出し側にある。
      const amount =
        effect.kind === 'heal_full'
          ? Infinity
          : rollRange(effect.min ?? 0, effect.max ?? 0, ctx.rng)
      for (const t of ctx.targets) {
        const before = t.hp
        t.hp = Math.min(t.maxHp, t.hp + amount)
        const healed = t.hp - before
        log.push(`${t.name} は ${healed} 回復した！`)
      }
      return log
    }
    case 'damage':
    case 'damage_full': {
      const base =
        effect.kind === 'damage_full'
          ? Infinity
          : rollRange(effect.min ?? 0, effect.max ?? 0, ctx.rng)
      for (const t of ctx.targets) {
        // own-property のみ見る (#368)。素朴な `t.resist?.[effect.type]` は Object.prototype も
        // 辿ってしまい、DSL の `type=...` が自由記述の effect.type が `constructor` 等と一致すると
        // （truthy な関数オブジェクトを返すため）`??` のフォールバックが発火せず耐性倍率が
        // 数値でなくなってしまう。
        const resist =
          effect.type && t.resist && hasOwn(t.resist, effect.type)
            ? (t.resist[effect.type] ?? 1.0)
            : 1.0
        const dealt = effect.kind === 'damage_full' ? t.hp : Math.floor(base * resist)
        t.hp = Math.max(0, t.hp - dealt)
        log.push(`${t.name} に ${dealt} のダメージ！`)
        if (t.hp === 0) log.push(`${t.name} は たおれた！`)
      }
      return log
    }
    case 'buff':
    case 'debuff': {
      if (effect.stat === undefined || effect.delta === undefined) {
        return ['(警告: buff/debuff のパラメータ不正)']
      }
      for (const t of ctx.targets) {
        if (!t.buffs) t.buffs = {}
        const cur = t.buffs[effect.stat] ?? 0
        t.buffs[effect.stat] = cur + effect.delta
        const sign = effect.delta >= 0 ? '上' : '下'
        log.push(`${t.name} の ${effect.stat.toUpperCase()} が ${sign}がった！`)
      }
      return log
    }
    case 'revive': {
      for (const t of ctx.targets) {
        if (t.hp > 0) continue
        t.hp = effect.hp === 'half' ? Math.floor(t.maxHp / 2) : t.maxHp
        log.push(`${t.name} は生き返った！`)
      }
      return log
    }
    case 'status': {
      if (!effect.state) return ['(警告: status の state 名なし)']
      for (const t of ctx.targets) {
        if (!t.status) t.status = {}
        t.status[effect.state] = effect.duration ?? 1
        log.push(`${t.name} は ${effect.state} になった！`)
      }
      return log
    }
    case 'escape_battle':
      log.push('にげだした！')
      return log
    case 'escape_dungeon':
      log.push('ダンジョンから脱出した。')
      return log
  }
}

function rollRange(min: number, max: number, rng: () => number): number {
  if (min === max) return min
  const r = rng()
  // Math.random() は [0, 1) なので通常 max+1 にはならないが、
  // テストや差し替え rng で 1.0 を渡された場合に備えて Math.min(max, ...) で堅牢化。
  return Math.min(max, Math.floor(min + r * (max - min + 1)))
}
