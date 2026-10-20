/**
 * 検証ハーネスの検出器 (#877 段階 3)。戦闘の状態（`BattleState`）を見て「壊れ」を見つける純粋関数だけを置く。
 * 検出のみ: 何も修正せず、上限の有効化もしない。
 *
 * 機械判定できる「壊れ」: NaN/Infinity・負の HP/MP・maxHp/maxMp 超過・ダメージ上限違反・ダメージ表示の向き違反・
 * 勝敗と生存者の食い違い・ATB の不変条件違反・ログの `NaN` / `Infinity` / `undefined`。
 * 時間をまたぐもの（ロック・無限ループ・例外）は `run.ts` が判定する。
 */
import { ATB_GAUGE_MAX, type BattleActionEvent, type BattleState } from '../battleEngine'
import type { BattleEntity } from '../spellDsl'

export type ViolationKind =
  | 'non-finite' // NaN / Infinity が状態・イベントに入った
  | 'unsafe-integer' // HP・量が Number.MAX_SAFE_INTEGER 超
  | 'negative-hp'
  | 'negative-mp'
  | 'hp-over-max'
  | 'mp-over-max'
  | 'damage-over-cap' // 1 ヒットのダメージ量が上限（MAX_DAMAGE）超
  | 'hit-direction' // damage のヒットで HP が増えた / heal のヒットで HP が減った / 量が負
  | 'bad-log-text' // ログに NaN / Infinity / undefined が出た
  | 'phase-mismatch' // 勝敗・フェーズと生存者の食い違い（進行不能を含む）
  | 'atb-invariant' // ATB のゲージ・キューの不変条件違反
  | 'lock' // 何も起きない（HP/状態もイベントも変わらない）まま進行しない（行動不能の永久連鎖）
  | 'stalemate' // 行動は起きているが攻撃だけでは HP が減り切らず決着がつかない（回復と攻撃が釣り合う）。壊れでなく要判断
  | 'event-flood' // 1 操作でイベントが異常に増えた（無限ループの疑い）
  | 'rng-budget' // 1 操作の乱数消費が予算超（無限ループの疑い）
  | 'slow-op' // 1 操作が極端に遅い（無限ループの疑い）
  | 'exception' // エンジンが例外を投げた

/** 壊れと断定しない（人間が見て判断する）種類。これだけのシナリオは「壊れ」に数えない */
export const WARN_KINDS: readonly ViolationKind[] = ['stalemate']

export const isBroken = (v: Violation): boolean => !WARN_KINDS.includes(v.kind)

export interface Violation {
  kind: ViolationKind
  detail: string
  /** 何番目の操作の直後か。-1 = 初期状態、ops.length 以上 = 操作列の後の自動進行 */
  opIndex: number
}

export interface DetectOptions {
  /** 1 ヒットのダメージ上限（既定 9999 = kako-jun 決定。`battleLimits.MAX_DAMAGE`） */
  maxDamage: number
}

const OVER_PHASES = ['victory', 'defeat', 'escaped']
const BAD_TEXT = /NaN|Infinity|undefined/

type Push = (kind: ViolationKind, detail: string) => void

function checkNumber(push: Push, where: string, v: unknown): void {
  if (typeof v !== 'number') return
  if (!Number.isFinite(v)) push('non-finite', `${where} = ${String(v)}`)
}

function checkEntity(push: Push, side: string, i: number, e: BattleEntity): void {
  const w = `${side}[${i}] ${e.name}`
  for (const k of ['hp', 'maxHp', 'mp', 'maxMp', 'atk', 'def', 'agi'] as const) {
    checkNumber(push, `${w}.${k}`, e[k])
  }
  for (const [k, v] of Object.entries(e.buffs ?? {})) checkNumber(push, `${w}.buffs.${k}`, v)
  for (const [k, v] of Object.entries(e.status ?? {})) checkNumber(push, `${w}.status.${k}`, v)
  if (Number.isFinite(e.hp)) {
    if (e.hp < 0) push('negative-hp', `${w}.hp = ${e.hp}`)
    if (e.hp > Number.MAX_SAFE_INTEGER) push('unsafe-integer', `${w}.hp = ${e.hp}`)
    if (Number.isFinite(e.maxHp) && e.hp > e.maxHp) {
      push('hp-over-max', `${w}.hp = ${e.hp} > maxHp = ${e.maxHp}`)
    }
  }
  if (Number.isFinite(e.mp)) {
    if (e.mp < 0) push('negative-mp', `${w}.mp = ${e.mp}`)
    if (Number.isFinite(e.maxMp) && e.mp > e.maxMp) {
      push('mp-over-max', `${w}.mp = ${e.mp} > maxMp = ${e.maxMp}`)
    }
  }
}

function checkEvents(push: Push, events: readonly BattleActionEvent[], opts: DetectOptions): void {
  for (const ev of events) {
    ev.hits.forEach((h, k) => {
      const w = `event#${ev.seq}.hits[${k}] (${h.kind})`
      checkNumber(push, `${w}.amount`, h.amount)
      checkNumber(push, `${w}.hpBefore`, h.hpBefore)
      checkNumber(push, `${w}.hpAfter`, h.hpAfter)
      if (h.amount > Number.MAX_SAFE_INTEGER) push('unsafe-integer', `${w}.amount = ${h.amount}`)
      // 即死 (instantDeath) は上限の対象外（HP を直接 0 にする。数字は出さない）
      if (h.kind === 'damage' && !h.instantDeath && h.amount > opts.maxDamage) {
        push('damage-over-cap', `${w}.amount = ${h.amount} > ${opts.maxDamage}`)
      }
      if (h.amount < 0) push('hit-direction', `${w}.amount = ${h.amount}（負の量）`)
      if (h.kind === 'damage' && h.hpAfter > h.hpBefore) {
        push('hit-direction', `${w}: damage なのに HP が ${h.hpBefore} → ${h.hpAfter} に増えた`)
      }
      if (h.kind === 'heal' && h.hpAfter < h.hpBefore) {
        push('hit-direction', `${w}: heal なのに HP が ${h.hpBefore} → ${h.hpAfter} に減った`)
      }
    })
  }
}

function checkPhase(push: Push, s: BattleState): void {
  const over = OVER_PHASES.includes(s.phase)
  const partyAlive = s.party.some((p) => p.hp > 0)
  const enemiesAlive = s.enemies.some((e) => e.hp > 0)
  if (!over && !partyAlive) push('phase-mismatch', `味方が全員倒れているのに phase = ${s.phase}`)
  if (!over && !enemiesAlive) push('phase-mismatch', `敵が全員倒れているのに phase = ${s.phase}`)
  if (s.phase === 'victory' && enemiesAlive) push('phase-mismatch', 'victory なのに敵が生きている')
  if (s.phase === 'defeat' && partyAlive) push('phase-mismatch', 'defeat なのに味方が生きている')
}

/** `battleEngineAtb.test.ts` の不変条件（ゲージ 0..1000・キューは生存者のみで重複なし・フェーズ整合）を移した */
function checkAtb(push: Push, s: BattleState): void {
  const atb = s.atb
  if (!atb) return
  for (const g of [...atb.partyGauge, ...atb.enemyGauge]) {
    if (!Number.isFinite(g)) push('non-finite', `ATB ゲージ = ${String(g)}`)
    else if (g < 0 || g > ATB_GAUGE_MAX)
      push('atb-invariant', `ゲージ ${g} が 0..${ATB_GAUGE_MAX} の外`)
  }
  if (new Set(atb.queue).size !== atb.queue.length) {
    push('atb-invariant', `キューに重複 [${atb.queue.join(',')}]`)
  }
  for (const i of atb.queue) {
    if (!(s.party[i]?.hp > 0)) push('atb-invariant', `キューに倒れた/不在の味方 ${i}`)
    else if (atb.partyGauge[i] !== ATB_GAUGE_MAX) {
      push('atb-invariant', `キューの味方 ${i} のゲージが満タンでない (${atb.partyGauge[i]})`)
    }
  }
  s.party.forEach((p, i) => {
    if (p.hp <= 0 && atb.partyGauge[i] !== 0) {
      push('atb-invariant', `倒れた味方 ${i} のゲージが 0 でない (${atb.partyGauge[i]})`)
    }
  })
  if (!OVER_PHASES.includes(s.phase)) {
    const want = atb.queue.length > 0 ? 'party-input' : 'atb-running'
    if (s.phase !== want)
      push('atb-invariant', `phase = ${s.phase}（キュー ${atb.queue.length} 件なら ${want}）`)
  }
  if (s.phase === 'enemy-turn') push('atb-invariant', 'ATB なのに phase = enemy-turn')
}

/**
 * 状態 1 つを検査して違反を返す。`newEvents` は直前の操作で増えたイベントだけを渡す（過去分を再報告しない）。
 * `opIndex` は違反にそのまま付ける。
 */
export function checkState(
  state: Readonly<BattleState>,
  newEvents: readonly BattleActionEvent[],
  opIndex: number,
  opts: DetectOptions
): Violation[] {
  const out: Violation[] = []
  const push: Push = (kind, detail) => out.push({ kind, detail, opIndex })
  state.party.forEach((e, i) => checkEntity(push, 'party', i, e))
  state.enemies.forEach((e, i) => checkEntity(push, 'enemies', i, e))
  checkNumber(push, 'earnedExp', state.earnedExp)
  checkNumber(push, 'earnedGold', state.earnedGold)
  checkEvents(push, newEvents, opts)
  for (const line of state.log) {
    if (BAD_TEXT.test(line)) push('bad-log-text', `ログ「${line}」`)
  }
  checkPhase(push, state)
  checkAtb(push, state)
  return out
}

/** ロック判定用の指紋。HP/MP/状態/バフ/フェーズ/ATB ゲージ。同じ指紋が続けば「何も進んでいない」 */
export function fingerprint(s: Readonly<BattleState>): string {
  return JSON.stringify([
    s.phase,
    s.party.map((e) => [e.hp, e.mp, e.status, e.buffs]),
    s.enemies.map((e) => [e.hp, e.mp, e.status, e.buffs]),
    s.atb && [s.atb.partyGauge, s.atb.enemyGauge, s.atb.queue],
  ])
}
