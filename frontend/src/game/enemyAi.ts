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
 * - P2 (#836): `順番=A > B > C`（`候補=` の代わりに書く。その行が選ばれるたびに順番どおり巡回し、終端で先頭に戻る。
 *   選ばれる行が切り替わると位置は新しい行の先頭に戻る。重みは付けられず、抽選の rng は消費しない）/ `予兆=<文言>`（その行が特技を
 *   使うとき特技の `予兆` の代わりに出す）/ `上限=N`（その行を選べる回数。使い切った行は成立しない扱い）/
 *   条件 `回数>=N`（その敵の行動回数）・`周期=N` または `周期=N/R`（`acted % N == R`、R 省略は 0）・`使用<特技>>=N`（その行動の使用回数）・
 *   `状態=毒`（自分の状態異常）・`味方状態=眠り`（生存している味方のいずれかの状態異常）
 * - P3 (#837): `被弾>=N`（その敵が被弾した回数）・`受けた=物理` / `魔法` / `アイテム` / `アイテム:名前` / `呪文:名前` / `系統:fire`
 *   （直前の被弾の種類。系統は効果 DSL の `damage ... type=` の値）・対象 `最後に攻撃した者`。
 *   `反撃:`（`MonsterDef.counters`）と `死亡時:`（`MonsterDef.onDeath`）は同じ書式の別の台本で、`parseReactionRules` / `chooseEnemyReaction` が扱う
 *   （`順番=` `上限=` は使えない＝進行位置を持たない。毎回先頭から評価・抽選する）
 * - #871: `ダメージ=奇数` / `ダメージ=偶数` / `ダメージ=3の倍数` / `ダメージ>=100` / `ダメージ=777`（直前の被弾で受けたダメージ＝画面に出る数字の合計）・
 *   `ダメージ桁数>=3`（その桁数）。ダメージの数字が出なかった被弾（即死・MISS・吸収）と被弾前は不成立。述語の解釈は `numberPredicate.ts`（味方側の対象指定 #876 と共通の語彙）
 *
 * 乱数の消費（注入された rng を使う。同じ state・同じ rng 列なら必ず同じ結果）:
 * - 採用した行の候補が 2 つ以上ならちょうど 1 回（重みの抽選）。1 つなら消費しない。`順番=` の行は消費しない
 * - 採用した行の `対象=ランダム` で候補の相手が 2 人以上いればちょうど 1 回（抽選のあと）。1 人なら消費しない
 * - **`行動:` を書かない敵（`state.enemyMemory` が無い戦闘を含む）は rng を消費せず、通常攻撃を返す**
 */

import type { SkillDef } from '../types'
import type { BattleActorRef, BattleState, SkillExecution } from './battleEngine'
import { STATUS_ALIASES, type BattleEntity } from './spellDsl'
import { hasOwn, safeAssign } from './ownProperty'
import {
  compareNumbers,
  digitCount,
  matchesNumber,
  parseNumberPredicate,
  type CompareOp,
  type NumberPredicate,
} from './numberPredicate'

/**
 * 敵ごとの記憶 (#835)。`BattleState.enemyMemory` は `enemies` と同じ index の配列。
 * ATB ゲージと同じく「ゲーム進行そのもの」の最小の数値カウンターだけを持つ（ADR 0002）。
 * 従来ターン制と ATB で意味が同じになるよう、全体のターン番号ではなく**その敵の行動回数**を使う。
 * 後続の段階（順番・使用回数・被弾回数。#836・#837）で項目を足す。
 */
export interface EnemyMemory {
  /** その敵が行動した回数（通常攻撃・特技のどちらも数える。`初手` は acted === 0） */
  acted: number
  /**
   * 以下は P2 (#836)。`順番=` `上限=` `使用<>` のいずれかを書いた敵だけが、最初の行動のあとから持つ
   * （P1 までの敵の記憶は `{ acted }` のまま）。
   * 直前に選ばれた `行動:` 行の番号（有効な行の通し番号。成立する行が無かったときは -1）。順番の位置のリセット判定に使う
   */
  rule?: number
  /** `rule` の行の `順番=` の次の位置（終端で 0 に戻る） */
  pos?: number
  /** 行動ごとの使用回数（キーは特技 id、通常攻撃は 'こうげき'） */
  used?: Record<string, number>
  /** 行ごとの使用回数（キーは有効な行の通し番号。`上限=` の判定） */
  ruleUses?: Record<string, number>
  /**
   * 以下は P3 (#837)。`反撃:` `死亡時:` を持つ敵、または `行動:` に被弾の語彙（`被弾` `受けた=` `最後に攻撃した者`）を書いた敵だけが、
   * 被弾したときから持つ（それ以外の敵の記憶は変わらない）。
   * 被弾した回数（味方の行動でダメージを受けるたびに 1 増える。1 行動で何ヒットしても 1）
   */
  hits?: number
  /** 直前の被弾の種類（`受けた=` の判定に使う） */
  lastHit?: HitSource
  /** 直前に攻撃してきた者（`対象=最後に攻撃した者` と、反撃・死亡時の既定の狙い） */
  lastAttacker?: BattleActorRef
  /** `死亡時:` を実行し終えた印（倒されたときに 1 度だけ） */
  died?: boolean
  /**
   * 直前の被弾で受けたダメージ（#871。`ダメージ…` 条件の判定に使う）。味方の行動 1 回が与えた、画面に出る数字（`BattleHit.amount`）の合計。
   * 即死・MISS・吸収などダメージの数字が出ない被弾では持たない（消える）。`tracksHits` の敵だけが持つ
   */
  lastDamage?: number
}

/** 被弾の種類 (#837)。`受けた=` の判定に使う。`name` は呪文・アイテムの名前、`type` は効果 DSL の `damage ... type=` の値 */
export interface HitSource {
  category: 'physical' | 'magic' | 'item'
  name?: string
  type?: string
}

/** 行動を終えたあとに記憶へ書く内容 (#836)。`順番=` `上限=` `使用<>` を使う敵の選択にだけ付く */
export interface ActionTrack {
  /** 選ばれた行の番号。成立する行が無ければ -1 */
  rule: number
  /** 次に使う `順番=` の位置 */
  nextPos: number
  /** 使用回数のキー */
  key: string
}

/** `chooseEnemyAction` の結果 */
export type ChosenAction =
  | {
      kind: 'attack'
      /** `対象=ランダム` / `HP最小` で選んだ味方。無ければ従来の狙い方（ターン制は先頭の生存者、ATB は rng） */
      target?: BattleActorRef
      track?: ActionTrack
    }
  | {
      kind: 'skill'
      /** 使う特技の id（`[特技 id]`）。エンジンに無ければ通常攻撃に落ちる */
      skillId: string
      /** `対象=` で上書きした相対表現。無ければ特技の `対象:` のまま */
      targetOverride?: string
      /** `対象=ランダム` / `HP最小` で選んだ相手（`相手単体` のとき） */
      target?: BattleActorRef
      /** 行の `予兆=`（無ければ特技の `予兆`）。使用時に出す文言 */
      omen?: string
      track?: ActionTrack
    }

type Condition =
  | { kind: 'always' }
  | { kind: 'first' }
  | { kind: 'hp'; op: CompareOp; percent: number }
  | { kind: 'allies'; op: CompareOp; n: number }
  | { kind: 'party'; op: CompareOp; n: number }
  | { kind: 'acted'; op: CompareOp; n: number }
  | { kind: 'cycle'; n: number; r: number }
  | { kind: 'used'; key: string; op: CompareOp; n: number }
  | { kind: 'status'; who: 'self' | 'party'; name: string }
  | { kind: 'hits'; op: CompareOp; n: number }
  | { kind: 'received'; category: HitSource['category']; name?: string; type?: string }
  | { kind: 'damage'; digits: boolean; predicate: NumberPredicate }

type TargetSpec = 'random' | 'lowest-hp' | 'all' | 'ally' | 'self' | 'last-attacker'

interface Candidate {
  /** 特技 id。null = 通常攻撃 */
  skillId: string | null
  weight: number
}

export interface ActionRule {
  conditions: Condition[]
  candidates: Candidate[]
  /** `順番=`（P2）。あれば candidates は空で、この順に巡回する */
  sequence?: Candidate[]
  /** `予兆=`（P2） */
  omen?: string
  /** `上限=`（P2） */
  cap?: number
  target?: TargetSpec
}

const PLAIN_ATTACK: ChosenAction = { kind: 'attack' }

const KEY_RE = /(?:^|\s)(条件|候補|対象|予兆|上限|順番)=/g

const TARGETS: Record<string, TargetSpec> = {
  ランダム: 'random',
  HP最小: 'lowest-hp',
  全体: 'all',
  仲間: 'ally',
  自分: 'self',
  最後に攻撃した者: 'last-attacker',
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
  'last-attacker': '相手単体',
}

const OP_RE = '(<=|>=|<|>|==|=)'
const HP_RE = new RegExp(`^HP\\s*${OP_RE}\\s*(\\d+(?:\\.\\d+)?)\\s*%$`, 'i')
const COUNT_RE = (label: string): RegExp => new RegExp(`^${label}\\s*${OP_RE}\\s*(\\d+)$`)
const ALLIES_RE = COUNT_RE('仲間')
const PARTY_RE = COUNT_RE('味方')
const ACTED_RE = COUNT_RE('回数')
const CYCLE_RE = /^周期\s*=\s*(\d+)(?:\s*\/\s*(\d+))?$/
const USED_RE = new RegExp(`^使用\\s*<([^<>]+)>\\s*${OP_RE}\\s*(\\d+)$`)
const HITS_RE = COUNT_RE('被弾')
const RECEIVED_RE = /^受けた\s*=\s*(.+)$/
const DAMAGE_RE = /^ダメージ(桁数)?\s*(.*)$/
const SELF_STATUS_RE = /^状態\s*=\s*(\S+)$/
const PARTY_STATUS_RE = /^味方状態\s*=\s*(\S+)$/
const ATTACK_KEY = 'こうげき'

function toOp(raw: string): CompareOp {
  return raw === '==' ? '=' : (raw as CompareOp)
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
  const acted = ACTED_RE.exec(text)
  if (acted) return { kind: 'acted', op: toOp(acted[1]), n: Number(acted[2]) }
  const cycle = CYCLE_RE.exec(text)
  if (cycle) {
    const n = Number(cycle[1])
    const r = cycle[2] === undefined ? 0 : Number(cycle[2])
    if (n < 1) return `周期 '${text}' の N は 1 以上が必要です`
    if (r >= n) return `周期 '${text}' の余りは N 未満が必要です`
    return { kind: 'cycle', n, r }
  }
  const used = USED_RE.exec(text)
  if (used) {
    const name = used[1].trim()
    return {
      kind: 'used',
      key: name === 'attack' ? ATTACK_KEY : name,
      op: toOp(used[2]),
      n: Number(used[3]),
    }
  }
  const selfStatus = SELF_STATUS_RE.exec(text)
  if (selfStatus) return { kind: 'status', who: 'self', name: selfStatus[1] }
  const partyStatus = PARTY_STATUS_RE.exec(text)
  if (partyStatus) return { kind: 'status', who: 'party', name: partyStatus[1] }
  const hits = HITS_RE.exec(text)
  if (hits) return { kind: 'hits', op: toOp(hits[1]), n: Number(hits[2]) }
  const received = RECEIVED_RE.exec(text)
  if (received) return parseReceived(text, received[1].trim())
  const damage = DAMAGE_RE.exec(text)
  if (damage) return parseDamage(text, damage[1] !== undefined, damage[2])
  return `条件 '${text}' は未対応です`
}

/** `受けた=` の値 (#837): 物理 / 魔法 / アイテム / アイテム:名前 / 呪文:名前 / 系統:x */
function parseReceived(text: string, value: string): Condition | string {
  if (value === '物理') return { kind: 'received', category: 'physical' }
  if (value === '魔法') return { kind: 'received', category: 'magic' }
  if (value === 'アイテム') return { kind: 'received', category: 'item' }
  const m = /^(アイテム|呪文|系統)\s*[:：]\s*(.+)$/.exec(value)
  if (m) {
    const arg = m[2].trim()
    if (m[1] === 'アイテム') return { kind: 'received', category: 'item', name: arg }
    if (m[1] === '呪文') return { kind: 'received', category: 'magic', name: arg }
    return { kind: 'received', category: 'magic', type: arg }
  }
  return `条件 '${text}' の受けた= は 物理 / 魔法 / アイテム / アイテム:名前 / 呪文:名前 / 系統:x のいずれかです`
}

/** `ダメージ…` (#871): 直前の被弾で受けたダメージの値（奇数・偶数・N の倍数・比較・ちょうど）か、その桁数（`ダメージ桁数>=3`） */
function parseDamage(text: string, digits: boolean, rest: string): Condition | string {
  const predicate = parseNumberPredicate(rest, digits)
  if (typeof predicate === 'string') return `条件 '${text}': ${predicate}`
  return { kind: 'damage', digits, predicate }
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
  const isAttack = name === ATTACK_KEY || name === 'attack'
  return { skillId: isAttack ? null : name, weight }
}

/** 1 行を解釈する。解釈できなければ理由の文字列を返す */
export function parseActionRule(
  line: string,
  kind: 'action' | 'reaction' = 'action'
): ActionRule | string {
  const text = line.trim()
  const parts: { key: string; start: number; valueStart: number }[] = []
  KEY_RE.lastIndex = 0
  for (let m = KEY_RE.exec(text); m !== null; m = KEY_RE.exec(text)) {
    const start = m.index + (m[0].length - m[1].length - 1)
    parts.push({ key: m[1], start, valueStart: m.index + m[0].length })
  }
  if (parts.length === 0) return 'キー（条件= / 候補= / 順番= / 対象= など）がありません'
  if (text.slice(0, parts[0].start).trim() !== '') return 'キーの前に余計な文字があります'
  const values = new Map<string, string>()
  for (let i = 0; i < parts.length; i++) {
    const { key, valueStart } = parts[i]
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
  const orderRaw = values.get('順番')
  if (candRaw !== undefined && orderRaw !== undefined) return '候補= と 順番= は同時に書けません'
  const candidates: Candidate[] = []
  let sequence: Candidate[] | undefined
  if (orderRaw !== undefined) {
    if (orderRaw === '') return '順番= が空です'
    sequence = []
    for (const piece of orderRaw.split('>')) {
      const c = parseCandidate(piece)
      if (typeof c === 'string') return c
      if (/[:：]/.test(piece)) return '順番= に重みは付けられません'
      sequence.push(c)
    }
  } else {
    if (candRaw === undefined || candRaw === '') return '候補= がありません'
    for (const piece of candRaw.split('|')) {
      const c = parseCandidate(piece)
      if (typeof c === 'string') return c
      candidates.push(c)
    }
    if (!(candidates.reduce((sum, c) => sum + c.weight, 0) > 0)) return '重みの合計が 0 です'
  }

  const omenRaw = values.get('予兆')
  if (omenRaw !== undefined && omenRaw === '') return '予兆= が空です'
  const capRaw = values.get('上限')
  let cap: number | undefined
  if (capRaw !== undefined) {
    if (!/^\d+$/.test(capRaw) || Number(capRaw) < 1)
      return `上限 '${capRaw}' は 1 以上の整数ではありません`
    cap = Number(capRaw)
  }

  const targetRaw = values.get('対象')
  let target: TargetSpec | undefined
  if (targetRaw !== undefined) {
    if (!hasOwn(TARGETS, targetRaw)) return `対象 '${targetRaw}' は未対応です`
    target = TARGETS[targetRaw]
  }
  if (kind === 'reaction' && (sequence !== undefined || cap !== undefined)) {
    return '反撃・死亡時には 順番= と 上限= は使えません（進行位置を持たず、毎回先頭から評価します）'
  }
  return {
    conditions,
    candidates,
    ...(sequence ? { sequence } : {}),
    ...(omenRaw !== undefined ? { omen: omenRaw } : {}),
    ...(cap !== undefined ? { cap } : {}),
    ...(target ? { target } : {}),
  }
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

/** `死亡時:` を持つ敵か (#837) */
export function hasOnDeath(enemy: BattleEntity): boolean {
  return typeof enemy.onDeath === 'string' && enemy.onDeath.trim() !== ''
}

/** `行動:` `反撃:` `死亡時:` のいずれかを持つ敵がいる戦闘か (#837) */
export function hasEnemyScripts(enemies: readonly BattleEntity[]): boolean {
  return enemies.some(
    (e) => (e.actions?.length ?? 0) > 0 || (e.counters?.length ?? 0) > 0 || hasOnDeath(e)
  )
}

/** `行動:` `反撃:` `死亡時:` を持つ敵がいる戦闘だけ記憶を作る。持たない戦闘は undefined（既存の挙動・BattleState の形が変わらない） */
export function createEnemyMemory(enemies: readonly BattleEntity[]): EnemyMemory[] | undefined {
  return hasEnemyScripts(enemies) ? enemies.map(() => ({ acted: 0 })) : undefined
}

/**
 * 被弾の記憶（`hits` `lastHit` `lastAttacker`）を残す敵か (#837)。`反撃:` `死亡時:` を持つか、`行動:` に被弾の語彙
 * （`被弾` `受けた=` `最後に攻撃した者`）を書いた敵だけ。それ以外の敵の記憶は P2 までのまま変わらない
 */
export function tracksHits(enemy: BattleEntity): boolean {
  if ((enemy.counters?.length ?? 0) > 0 || hasOnDeath(enemy)) return true
  return parseActionRules(enemy.actions ?? []).some(
    (r) =>
      r.target === 'last-attacker' ||
      r.conditions.some((c) => c.kind === 'hits' || c.kind === 'received' || c.kind === 'damage')
  )
}

/**
 * `ダメージ…` 条件を書いた敵か (#871)。`行動:` `反撃:` `死亡時:` のどれかに書いていれば、被弾のたびに受けたダメージ（`lastDamage`）を記憶する。
 * 書いていない敵の記憶の形は変わらない
 */
export function tracksDamage(enemy: BattleEntity): boolean {
  const uses = (rules: readonly ActionRule[]): boolean =>
    rules.some((r) => r.conditions.some((c) => c.kind === 'damage'))
  return (
    uses(parseActionRules(enemy.actions ?? [])) ||
    uses(parseCounterRules(enemy.counters ?? [])) ||
    (hasOnDeath(enemy) && uses(parseDeathRules(enemy.onDeath as string)))
  )
}

function hasStatus(entity: BattleEntity, name: string): boolean {
  const status = entity.status
  if (!status) return false
  const keys = hasOwn(STATUS_ALIASES, name) ? [name, STATUS_ALIASES[name]] : [name]
  return keys.some((k) => hasOwn(status, k) && (status[k] ?? 0) > 0)
}

function readCount(record: Record<string, number> | undefined, key: string): number {
  return record && hasOwn(record, key) ? record[key] : 0
}

function conditionHolds(
  cond: Condition,
  state: Readonly<BattleState>,
  enemyIndex: number,
  memory: Readonly<EnemyMemory>
): boolean {
  const self = state.enemies[enemyIndex]
  const acted = memory.acted
  switch (cond.kind) {
    case 'always':
      return true
    case 'first':
      return acted === 0
    case 'hp':
      // 割合の比較は整数のまま行う（hp/maxHp*100 の丸め誤差で境界がずれないように）
      return compareNumbers(self.hp * 100, cond.op, cond.percent * self.maxHp)
    case 'allies':
      return compareNumbers(
        state.enemies.filter((e, i) => i !== enemyIndex && e.hp > 0).length,
        cond.op,
        cond.n
      )
    case 'party':
      return compareNumbers(state.party.filter((p) => p.hp > 0).length, cond.op, cond.n)
    case 'acted':
      return compareNumbers(acted, cond.op, cond.n)
    case 'cycle':
      return acted % cond.n === cond.r
    case 'used':
      return compareNumbers(readCount(memory.used, cond.key), cond.op, cond.n)
    case 'hits':
      return compareNumbers(memory.hits ?? 0, cond.op, cond.n)
    case 'received': {
      const h = memory.lastHit
      if (!h) return false
      if (cond.type !== undefined) return h.type === cond.type
      return h.category === cond.category && (cond.name === undefined || h.name === cond.name)
    }
    case 'damage': {
      // 数字が出なかった被弾（即死・MISS・吸収）や被弾前は、ダメージ条件はすべて不成立
      const v = memory.lastDamage
      if (v === undefined) return false
      return matchesNumber(cond.digits ? digitCount(v) : v, cond.predicate)
    }
    case 'status':
      return cond.who === 'self'
        ? hasStatus(self, cond.name)
        : state.party.some((p) => p.hp > 0 && hasStatus(p, cond.name))
  }
}

/** P2 の記憶（順番の位置・使用回数）を使う行か */
function needsTracking(rule: ActionRule): boolean {
  return (
    rule.sequence !== undefined ||
    rule.cap !== undefined ||
    rule.conditions.some((c) => c.kind === 'used')
  )
}

/**
 * 行動を終えた敵の記憶を進める (#836)。`acted` は必ず増やし、`choice.track` があれば順番の位置と使用回数も更新する
 * （呼び出し側＝エンジンが、通常攻撃・特技のどちらでも行動後に 1 回呼ぶ）
 */
export function recordEnemyAction(memory: EnemyMemory, choice: ChosenAction): void {
  memory.acted++
  const t = choice.track
  if (!t) return
  memory.used = memory.used ?? {}
  safeAssign(memory.used, t.key, readCount(memory.used, t.key) + 1)
  memory.ruleUses = memory.ruleUses ?? {}
  if (t.rule >= 0) {
    const k = String(t.rule)
    safeAssign(memory.ruleUses, k, readCount(memory.ruleUses, k) + 1)
  }
  memory.rule = t.rule
  memory.pos = t.nextPos
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

/** 直前に攻撃してきた者（生きている味方）。いなければ undefined (#837) */
function aliveAttacker(
  state: Readonly<BattleState>,
  memory: Readonly<EnemyMemory>
): BattleActorRef | undefined {
  const a = memory.lastAttacker
  return a && a.side === 'party' && (state.party[a.index]?.hp ?? 0) > 0 ? a : undefined
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
  const tracking = rules.some(needsTracking)
  const ruleIndex = rules.findIndex(
    (r) =>
      (r.cap === undefined || readCount(memory.ruleUses, String(rules.indexOf(r))) < r.cap) &&
      r.conditions.every((c) => conditionHolds(c, state, enemyIndex, memory))
  )
  if (ruleIndex < 0) {
    return tracking
      ? { kind: 'attack', track: { rule: -1, nextPos: 0, key: ATTACK_KEY } }
      : PLAIN_ATTACK
  }
  const rule = rules[ruleIndex]
  let chosen: Candidate
  let nextPos = 0
  if (rule.sequence) {
    // 選ばれる行が切り替わったら位置は先頭から（FF5 と同じ）
    const pos = memory.rule === ruleIndex ? (memory.pos ?? 0) % rule.sequence.length : 0
    chosen = rule.sequence[pos]
    nextPos = (pos + 1) % rule.sequence.length
  } else {
    chosen = pickCandidate(rule.candidates, rng)
  }
  const track: ActionTrack | undefined = tracking
    ? { rule: ruleIndex, nextPos, key: chosen.skillId ?? ATTACK_KEY }
    : undefined
  const wantsPicked = rule.target === 'random' || rule.target === 'lowest-hp'
  const target =
    rule.target === 'last-attacker'
      ? aliveAttacker(state, memory)
      : wantsPicked && rule.target
        ? pickOpponent(state, rule.target, rng)
        : undefined
  if (chosen.skillId === null) {
    return target || track
      ? { kind: 'attack', ...(target ? { target } : {}), ...(track ? { track } : {}) }
      : PLAIN_ATTACK
  }
  return {
    kind: 'skill',
    skillId: chosen.skillId,
    ...(rule.target ? { targetOverride: TARGET_OVERRIDE[rule.target] } : {}),
    ...(target ? { target } : {}),
    ...(rule.omen !== undefined ? { omen: rule.omen } : {}),
    ...(track ? { track } : {}),
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
      ...(s.telegraph !== undefined ? { telegraph: s.telegraph } : {}),
    }
  }
  return out
}

/** `反撃:` / `死亡時:` の解釈結果。同じ配列・文字列には 1 度だけ warning を出す */
const reactionCache = new WeakMap<readonly string[], ActionRule[]>()
const deathCache = new Map<string, ActionRule[]>()

function parseReactionLines(lines: readonly string[], label: string): ActionRule[] {
  const rules: ActionRule[] = []
  for (const line of lines) {
    const rule = parseActionRule(line, 'reaction')
    if (typeof rule === 'string') {
      console.warn(`[name-name] ${label}: '${line}' を無視します（${rule}）`)
      continue
    }
    rules.push(rule)
  }
  return rules
}

/** `反撃:` の行の解釈（書いた順。不正な行は warning を出して除く） (#837) */
export function parseCounterRules(lines: readonly string[]): ActionRule[] {
  const cached = reactionCache.get(lines)
  if (cached) return cached
  const rules = parseReactionLines(lines, '反撃')
  reactionCache.set(lines, rules)
  return rules
}

/** `死亡時:` の行の解釈（0 件か 1 件。不正なら warning を出して空） (#837) */
export function parseDeathRules(line: string): ActionRule[] {
  const cached = deathCache.get(line)
  if (cached) return cached
  const rules = parseReactionLines([line], '死亡時')
  deathCache.set(line, rules)
  return rules
}

/**
 * 被弾後・死亡時の行動を決める (#837)。**純粋関数**（state を変えず、乱数は注入された `rng` だけ）。
 * `行動:` の `chooseEnemyAction` と違い、成立する行が無ければ `null`（何もしない。通常攻撃に落とさない）。
 * 進行位置・使用回数は持たず、毎回先頭の行から評価し、成立した最初の行の候補を重みで抽選する（候補が 1 つなら rng を消費しない）。
 * 狙いは、`対象=` が無ければ直前の攻撃者（生きていれば）、`対象=ランダム` / `HP最小` は候補の相手から選ぶ
 * （`ランダム` で相手が 2 人以上なら rng を 1 回消費）。`state.enemyMemory` が無ければ `null`。
 */
export function chooseEnemyReaction(
  state: Readonly<BattleState>,
  enemyIndex: number,
  rules: readonly ActionRule[],
  rng: () => number
): ChosenAction | null {
  const memory = state.enemyMemory?.[enemyIndex]
  if (!memory || !state.enemies[enemyIndex]) return null
  const rule = rules.find((r) =>
    r.conditions.every((c) => conditionHolds(c, state, enemyIndex, memory))
  )
  if (!rule) return null
  const chosen = pickCandidate(rule.candidates, rng)
  const attacker = aliveAttacker(state, memory)
  const picked =
    rule.target === 'random' || rule.target === 'lowest-hp'
      ? pickOpponent(state, rule.target, rng)
      : undefined
  const target = picked ?? attacker
  if (chosen.skillId === null) {
    return target ? { kind: 'attack', target } : { kind: 'attack' }
  }
  return {
    kind: 'skill',
    skillId: chosen.skillId,
    ...(rule.target ? { targetOverride: TARGET_OVERRIDE[rule.target] } : {}),
    ...(target ? { target } : {}),
    ...(rule.omen !== undefined ? { omen: rule.omen } : {}),
  }
}
