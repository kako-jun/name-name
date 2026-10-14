/**
 * 敵の行動パターン P1 (#835、親 #832、設計書 docs/design/enemy-ai.md §3.2〜§3.5)。
 *
 * `[モンスター]` の `行動:` 行（`MonsterDef.actions`、parser は生文字列で透過）をここで解釈する。
 * 効果 DSL（`spellDsl.ts`）と同じ流儀で、不正な行は warning を出して無視する（その敵はほかの行か通常攻撃になる）。
 *
 * 書式（1 行 = 1 ルール。スペース区切りの `キー=値`。値の中にスペースがあってよい）:
 *   `行動: 条件=<式>[, <式>...] 候補=<行動>[:<重み>] | <行動>[:<重み>] ... [対象=<指定>]`
 * - 評価は上の行から。**条件が最初に成立した行**の候補から重み付きで 1 つ選ぶ。成立する行が無ければ通常攻撃（FF5 型）
 * - `条件` は `,` 区切りの AND。省略か `常に` は常に成立。式: `初手` / `HP<50%`（`<` `<=` `>` `>=` `=`）/
 *   `仲間<=1`（自分以外の生存している敵の数）/ `味方<=1`（生存している味方の数）
 * - `候補` は `こうげき`（通常攻撃。`attack` でも可）か `[特技 id]` の id。重みを省くと 1（0 以上の数。合計が 0 の行は不正）
 * - `対象` は `ランダム` / `HP最小` / `全体` / `仲間` / `自分`。省略時は特技の `対象:`（通常攻撃は従来の狙い方）に従う。
 *   `最後に攻撃した者` は被弾の記憶（P3 #837）が要るので未対応（その行は不正として無視）
 * - P2 以降の語彙（`順番=` `予兆=` `上限=` と回数・周期・状態・被弾の条件）も未対応で、使った行は不正として無視する
 *
 * 乱数の消費（注入された rng を使う。同じ state・同じ rng 列なら必ず同じ結果）:
 * - 採用した行の候補が 2 つ以上ならちょうど 1 回（重みの抽選）。1 つなら消費しない
 * - 採用した行の `対象=ランダム` で候補の相手が 2 人以上いればちょうど 1 回（抽選のあと）。1 人なら消費しない
 * - **`行動:` を書かない敵（`state.enemyMemory` が無い戦闘を含む）は rng を消費せず、通常攻撃を返す**
 */

import type { SkillDef } from '../types'
import type { BattleActorRef, BattleState, SkillExecution } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { hasOwn } from './ownProperty'

/**
 * 敵ごとの記憶 (#835)。`BattleState.enemyMemory` は `enemies` と同じ index の配列。
 * ATB ゲージと同じく「ゲーム進行そのもの」の最小の数値カウンターだけを持つ（ADR 0002）。
 * 従来ターン制と ATB で意味が同じになるよう、全体のターン番号ではなく**その敵の行動回数**を使う。
 * 後続の段階（順番・使用回数・被弾回数。#836・#837）で項目を足す。
 */
export interface EnemyMemory {
  /** その敵が行動した回数（通常攻撃・特技のどちらも数える。`初手` は acted === 0） */
  acted: number
}

/** `chooseEnemyAction` の結果 */
export type ChosenAction =
  | {
      kind: 'attack'
      /** `対象=ランダム` / `HP最小` で選んだ味方。無ければ従来の狙い方（ターン制は先頭の生存者、ATB は rng） */
      target?: BattleActorRef
    }
  | {
      kind: 'skill'
      /** 使う特技の id（`[特技 id]`）。エンジンに無ければ通常攻撃に落ちる */
      skillId: string
      /** `対象=` で上書きした相対表現。無ければ特技の `対象:` のまま */
      targetOverride?: string
      /** `対象=ランダム` / `HP最小` で選んだ相手（`相手単体` のとき） */
      target?: BattleActorRef
    }

type CompareOp = '<' | '<=' | '>' | '>=' | '='

type Condition =
  | { kind: 'always' }
  | { kind: 'first' }
  | { kind: 'hp'; op: CompareOp; percent: number }
  | { kind: 'allies'; op: CompareOp; n: number }
  | { kind: 'party'; op: CompareOp; n: number }

type TargetSpec = 'random' | 'lowest-hp' | 'all' | 'ally' | 'self'

interface Candidate {
  /** 特技 id。null = 通常攻撃 */
  skillId: string | null
  weight: number
}

interface ActionRule {
  conditions: Condition[]
  candidates: Candidate[]
  target?: TargetSpec
}

const PLAIN_ATTACK: ChosenAction = { kind: 'attack' }

const KEY_RE = /(?:^|\s)(条件|候補|対象|予兆|上限|順番)=/g
const LATER_KEYS = new Set(['予兆', '上限', '順番'])

const TARGETS: Record<string, TargetSpec> = {
  ランダム: 'random',
  HP最小: 'lowest-hp',
  全体: 'all',
  仲間: 'ally',
  自分: 'self',
}

/**
 * `対象=` が特技の相対対象を上書きする先。`ランダム` / `HP最小` は `相手単体` で、相手は chooseEnemyAction が選ぶ。
 * 上書きするのは特技の対象が単体（`相手単体` / `仲間単体`）のときだけで、その判定はエンジン側（`相手全体` / `仲間全体` / `自分` の特技は上書きしない）
 */
const TARGET_OVERRIDE: Record<TargetSpec, string> = {
  random: '相手単体',
  'lowest-hp': '相手単体',
  all: '相手全体',
  ally: '仲間単体',
  self: '自分',
}

const OP_RE = '(<=|>=|<|>|==|=)'
const HP_RE = new RegExp(`^HP\\s*${OP_RE}\\s*(\\d+(?:\\.\\d+)?)\\s*%$`, 'i')
const COUNT_RE = (label: string): RegExp => new RegExp(`^${label}\\s*${OP_RE}\\s*(\\d+)$`)
const ALLIES_RE = COUNT_RE('仲間')
const PARTY_RE = COUNT_RE('味方')

function toOp(raw: string): CompareOp {
  return raw === '==' ? '=' : (raw as CompareOp)
}

function compare(left: number, op: CompareOp, right: number): boolean {
  switch (op) {
    case '<':
      return left < right
    case '<=':
      return left <= right
    case '>':
      return left > right
    case '>=':
      return left >= right
    case '=':
      return left === right
  }
}

function parseCondition(raw: string): Condition | string {
  const text = raw.trim()
  if (text === '' || text === '常に') return { kind: 'always' }
  if (text === '初手') return { kind: 'first' }
  const hp = HP_RE.exec(text)
  if (hp) return { kind: 'hp', op: toOp(hp[1]), percent: Number(hp[2]) }
  const allies = ALLIES_RE.exec(text)
  if (allies) return { kind: 'allies', op: toOp(allies[1]), n: Number(allies[2]) }
  const party = PARTY_RE.exec(text)
  if (party) return { kind: 'party', op: toOp(party[1]), n: Number(party[2]) }
  return `条件 '${text}' は未対応です`
}

function parseCandidate(raw: string): Candidate | string {
  const text = raw.trim()
  if (text === '') return '候補に空の要素があります'
  let name = text
  let weight = 1
  const m = /^(.*?)\s*[:：]\s*(.*)$/.exec(text)
  if (m) {
    name = m[1].trim()
    const w = m[2].trim()
    if (!/^\d+(?:\.\d+)?$/.test(w)) return `重み '${w}' は 0 以上の数ではありません`
    weight = Number(w)
  }
  if (name === '') return '候補の名前が空です'
  // 名前にスペースがあるのは、未知のキー（例: `墨 ほげ=1`）が候補に連結されたとき。特技 id にスペースは使えない
  if (/\s/.test(name)) return `候補 '${name}' にスペースが含まれています（未知のキーの可能性）`
  const isAttack = name === 'こうげき' || name === 'attack'
  return { skillId: isAttack ? null : name, weight }
}

/** 1 行を解釈する。解釈できなければ理由の文字列を返す */
export function parseActionRule(line: string): ActionRule | string {
  const text = line.trim()
  const parts: { key: string; start: number; valueStart: number }[] = []
  KEY_RE.lastIndex = 0
  for (let m = KEY_RE.exec(text); m !== null; m = KEY_RE.exec(text)) {
    const start = m.index + (m[0].length - m[1].length - 1)
    parts.push({ key: m[1], start, valueStart: m.index + m[0].length })
  }
  if (parts.length === 0) return 'キー（条件= / 候補= / 対象=）がありません'
  if (text.slice(0, parts[0].start).trim() !== '') return 'キーの前に余計な文字があります'
  const values = new Map<string, string>()
  for (let i = 0; i < parts.length; i++) {
    const { key, valueStart } = parts[i]
    if (LATER_KEYS.has(key)) return `${key}= は未対応です（P2 #836 以降）`
    if (values.has(key)) return `${key}= が重複しています`
    const end = i + 1 < parts.length ? parts[i + 1].start : text.length
    values.set(key, text.slice(valueStart, end).trim())
  }

  const conditions: Condition[] = []
  const condRaw = values.get('条件')
  if (condRaw !== undefined) {
    for (const piece of condRaw.split(/[,、，]/)) {
      const c = parseCondition(piece)
      if (typeof c === 'string') return c
      conditions.push(c)
    }
  }

  const candRaw = values.get('候補')
  if (candRaw === undefined || candRaw === '') return '候補= がありません'
  const candidates: Candidate[] = []
  for (const piece of candRaw.split('|')) {
    const c = parseCandidate(piece)
    if (typeof c === 'string') return c
    candidates.push(c)
  }
  if (!(candidates.reduce((sum, c) => sum + c.weight, 0) > 0)) return '重みの合計が 0 です'

  const targetRaw = values.get('対象')
  let target: TargetSpec | undefined
  if (targetRaw !== undefined) {
    if (!hasOwn(TARGETS, targetRaw)) return `対象 '${targetRaw}' は未対応です`
    target = TARGETS[targetRaw]
  }
  return { conditions, candidates, ...(target ? { target } : {}) }
}

/** `行動:` の行ごとの解釈結果（書いた順。不正な行は warning を出して除く）。同じ配列には 1 度だけ warning を出す */
const parsedCache = new WeakMap<readonly string[], ActionRule[]>()

export function parseActionRules(lines: readonly string[]): ActionRule[] {
  const cached = parsedCache.get(lines)
  if (cached) return cached
  const rules: ActionRule[] = []
  for (const line of lines) {
    const rule = parseActionRule(line)
    if (typeof rule === 'string') {
      console.warn(`[name-name] 行動: '${line}' を無視します（${rule}）`)
      continue
    }
    rules.push(rule)
  }
  parsedCache.set(lines, rules)
  return rules
}

/** `行動:` を持つ敵が 1 体でもいる戦闘か（空配列は持たない扱い） */
export function hasEnemyActions(enemies: readonly BattleEntity[]): boolean {
  return enemies.some((e) => (e.actions?.length ?? 0) > 0)
}

/** `行動:` を持つ敵がいる戦闘だけ記憶を作る。持たない戦闘は undefined（既存の挙動・BattleState の形が変わらない） */
export function createEnemyMemory(enemies: readonly BattleEntity[]): EnemyMemory[] | undefined {
  return hasEnemyActions(enemies) ? enemies.map(() => ({ acted: 0 })) : undefined
}

function conditionHolds(
  cond: Condition,
  state: Readonly<BattleState>,
  enemyIndex: number,
  acted: number
): boolean {
  const self = state.enemies[enemyIndex]
  switch (cond.kind) {
    case 'always':
      return true
    case 'first':
      return acted === 0
    case 'hp':
      // 割合の比較は整数のまま行う（hp/maxHp*100 の丸め誤差で境界がずれないように）
      return compare(self.hp * 100, cond.op, cond.percent * self.maxHp)
    case 'allies':
      return compare(
        state.enemies.filter((e, i) => i !== enemyIndex && e.hp > 0).length,
        cond.op,
        cond.n
      )
    case 'party':
      return compare(state.party.filter((p) => p.hp > 0).length, cond.op, cond.n)
  }
}

/** 重みで 1 つ選ぶ。候補が 1 つなら rng を消費しない */
function pickCandidate(candidates: readonly Candidate[], rng: () => number): Candidate {
  if (candidates.length === 1) return candidates[0]
  const total = candidates.reduce((sum, c) => sum + c.weight, 0)
  const r = rng() * total
  let acc = 0
  for (const c of candidates) {
    acc += c.weight
    if (c.weight > 0 && r < acc) return c
  }
  // 浮動小数の端（r が total に極めて近い）では最後の正の重みに落とす
  return [...candidates].reverse().find((c) => c.weight > 0) ?? candidates[candidates.length - 1]
}

function pickOpponent(
  state: Readonly<BattleState>,
  spec: TargetSpec,
  rng: () => number
): BattleActorRef | undefined {
  const alive: number[] = []
  state.party.forEach((p, i) => {
    if (p.hp > 0) alive.push(i)
  })
  if (alive.length === 0) return undefined
  if (spec === 'lowest-hp') {
    let best = alive[0]
    for (const i of alive) if (state.party[i].hp < state.party[best].hp) best = i
    return { side: 'party', index: best }
  }
  const pick = alive.length === 1 ? 0 : Math.min(alive.length - 1, Math.floor(rng() * alive.length))
  return { side: 'party', index: alive[pick] }
}

/**
 * 敵 `enemyIndex` の次の行動を決める (#835)。**純粋関数**: state を変えず、乱数は注入された `rng` だけを使う。
 * `acted` の加算は呼び出し側（エンジン）が行動後に行う。従来ターン制・ATB のどちらでも、この関数の結果を使う。
 *
 * `行動:` を持たない敵、または `state.enemyMemory` が無い戦闘では、rng を消費せず `{ kind: 'attack' }` を返す。
 * 条件が成立する行が無いときも通常攻撃（rng は消費しない）。
 */
export function chooseEnemyAction(
  state: Readonly<BattleState>,
  enemyIndex: number,
  rng: () => number
): ChosenAction {
  const enemy = state.enemies[enemyIndex]
  const memory = state.enemyMemory?.[enemyIndex]
  if (!enemy || !memory || !enemy.actions || enemy.actions.length === 0) return PLAIN_ATTACK
  const rules = parseActionRules(enemy.actions)
  const rule = rules.find((r) =>
    r.conditions.every((c) => conditionHolds(c, state, enemyIndex, memory.acted))
  )
  if (!rule) return PLAIN_ATTACK
  const chosen = pickCandidate(rule.candidates, rng)
  const wantsPicked = rule.target === 'random' || rule.target === 'lowest-hp'
  const target = wantsPicked && rule.target ? pickOpponent(state, rule.target, rng) : undefined
  if (chosen.skillId === null) {
    return target ? { kind: 'attack', target } : PLAIN_ATTACK
  }
  return {
    kind: 'skill',
    skillId: chosen.skillId,
    ...(rule.target ? { targetOverride: TARGET_OVERRIDE[rule.target] } : {}),
    ...(target ? { target } : {}),
  }
}

/** マスターの `[特技]`（`SkillDef`）を、エンジンが受け取る形（`SkillExecution`）にする。id をキーにしたまま写す */
export function toSkillExecutions(
  skills: Readonly<Record<string, SkillDef>>
): Record<string, SkillExecution> {
  const out: Record<string, SkillExecution> = {}
  for (const [id, s] of Object.entries(skills)) {
    out[id] = {
      name: s.name,
      target: s.target,
      ...(s.effect !== undefined ? { effect: s.effect } : {}),
      ...(s.builtin !== undefined ? { builtin: s.builtin } : {}),
      ...(s.message !== undefined ? { message: s.message } : {}),
    }
  }
  return out
}
