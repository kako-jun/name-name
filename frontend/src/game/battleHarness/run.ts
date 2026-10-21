/**
 * 検証ハーネスの実行 (#877 段階 3)。シナリオ 1 件を決定論的に動かし、検出器で見て、結果（違反と指標）を返す。
 * 検出のみ。エンジンの挙動は変えない。
 */
import type { BattleActionEvent } from '../battleEngine'
import { MAX_DAMAGE } from '../battleLimits'
import { checkState, fingerprint, type DetectOptions, type Violation } from './detect'
import { budgetRng, DEFAULT_RNG_BUDGET_PER_OP, RngBudgetExceeded } from './rng'
import { parseLootSpec } from '../loot'
import {
  applyOp,
  realEngineFactory,
  type EngineFactory,
  type HarnessEngine,
  type Scenario,
} from './scenario'

export interface RunOptions {
  engineFactory?: EngineFactory
  detect?: DetectOptions
  /** 操作列のあとに「攻撃 / ATB を進める」で決着まで押し続ける最大回数（0 = 自動進行しない） */
  driveLimit?: number
  /** 同じ指紋がこの回数続いたら lock（自動進行中のみ） */
  lockRepeat?: number
  /** 1 操作でこの数より多くイベントが増えたら event-flood */
  eventFloodLimit?: number
  /** 1 操作の乱数消費の予算 */
  rngBudgetPerOp?: number
  /** 1 操作の所要 ms の上限 */
  slowOpMs?: number
  /** 同じ種類の違反を 1 シナリオで何件まで残すか */
  maxPerKind?: number
}

/** 「凄い組み合わせ」の候補を選ぶための数値。判定はしない（閾値は未決） */
export interface Metrics {
  opsRun: number
  driveSteps: number
  /** 自動進行を終えたときに決着がついていたか */
  ended: boolean
  finalPhase: string
  /** 1 回の行動（イベント 1 件）の damage ヒットの合計の最大 */
  maxEventDamage: number
  /** 1 ヒットの heal 量の最大 */
  maxHealAmount: number
  /** 1 回の行動に含まれたヒット数の最大 */
  maxHitsPerEvent: number
  /** バフ/デバフの累積値の絶対値の最大 */
  maxAbsBuff: number
  /** 1 つの操作が増やしたイベント数の最大 */
  maxEventsPerOp: number
  /** 1 つの操作での HP の減少（ヒットの hpBefore - hpAfter）の最大。damage_full で上限 9999 を超えうる */
  maxHpDrop: number
}

export interface ScenarioResult {
  id: string
  violations: Violation[]
  metrics: Metrics
}

export const DEFAULT_RUN: Required<Omit<RunOptions, 'engineFactory' | 'detect'>> = {
  driveLimit: 500,
  lockRepeat: 25,
  eventFloodLimit: 5000,
  rngBudgetPerOp: DEFAULT_RNG_BUDGET_PER_OP,
  slowOpMs: 3000,
  maxPerKind: 3,
}

export function runScenario(scenario: Scenario, options: RunOptions = {}): ScenarioResult {
  const o = { ...DEFAULT_RUN, ...options }
  const detect = {
    ...(options.detect ?? { maxDamage: MAX_DAMAGE }),
    // 宣言した状態の不変条件 (#870)。宣言の無いシナリオは検査しない
    ...(scenario.statuses ? { statusIds: Object.keys(scenario.statuses) } : {}),
    // 戦利品の宣言 (#831)。宣言のある敵がいるシナリオだけ、`state.loot` の不変条件を検査する
    ...lootDeclarations(scenario),
  }
  const factory = options.engineFactory ?? realEngineFactory
  const rng = budgetRng(scenario.seed, o.rngBudgetPerOp)

  const violations: Violation[] = []
  const perKind = new Map<string, number>()
  const add = (vs: Violation[]): void => {
    for (const v of vs) {
      const n = perKind.get(v.kind) ?? 0
      perKind.set(v.kind, n + 1)
      if (n < o.maxPerKind) violations.push(v)
    }
  }
  const metrics: Metrics = {
    opsRun: 0,
    driveSteps: 0,
    ended: false,
    finalPhase: '',
    maxEventDamage: 0,
    maxHealAmount: 0,
    maxHitsPerEvent: 0,
    maxAbsBuff: 0,
    maxEventsPerOp: 0,
    maxHpDrop: 0,
  }

  let engine: HarnessEngine
  try {
    engine = factory(scenario, rng)
  } catch (e) {
    add([{ kind: 'exception', detail: `生成で例外: ${describe(e)}`, opIndex: -1 }])
    return { id: scenario.id, violations, metrics }
  }

  let seenEvents = engine.getState().eventTotal
  add(checkState(engine.getState(), [], -1, detect))

  /** 1 操作を実行して検査する。続行不能（例外・予算超過）なら false */
  const step = (opIndex: number, run: () => void): boolean => {
    rng.reset()
    const t0 = performance.now()
    try {
      run()
    } catch (e) {
      const kind = e instanceof RngBudgetExceeded ? 'rng-budget' : 'exception'
      add([{ kind, detail: describe(e), opIndex }])
      return false
    }
    const ms = performance.now() - t0
    if (ms > o.slowOpMs) add([{ kind: 'slow-op', detail: `${Math.round(ms)}ms`, opIndex }])
    const s = engine.getState()
    const delta = s.eventTotal - seenEvents
    seenEvents = s.eventTotal
    if (delta > o.eventFloodLimit) {
      add([{ kind: 'event-flood', detail: `1 操作でイベント ${delta} 件`, opIndex }])
    }
    metrics.maxEventsPerOp = Math.max(metrics.maxEventsPerOp, delta)
    // events は直近 30 件だけ残る。増えた分のうち残っている分を検査する
    const fresh = delta > 0 ? s.events.slice(-Math.min(delta, s.events.length)) : []
    collectMetrics(metrics, fresh)
    for (const e of [...s.party, ...s.enemies]) {
      for (const v of Object.values(e.buffs ?? {})) {
        if (Number.isFinite(v))
          metrics.maxAbsBuff = Math.max(metrics.maxAbsBuff, Math.abs(v as number))
      }
    }
    add(checkState(s, fresh, opIndex, detect))
    return true
  }

  let alive = true
  for (let i = 0; i < scenario.ops.length && alive; i++) {
    alive = step(i, () => applyOp(engine, scenario, scenario.ops[i]))
    metrics.opsRun = i + 1
  }

  // 操作列のあとの自動進行: 攻撃 / ATB を進めて決着までの間に、同じ状態が続く（ロック）かを見る
  if (alive && o.driveLimit > 0) {
    let lastFp = ''
    let lastEvents = -1
    let repeat = 0
    for (let n = 0; n < o.driveLimit && !engine.isOver(); n++) {
      const phase = engine.getState().phase
      const idx = scenario.ops.length + n
      const ok = step(idx, () => {
        if (phase === 'atb-running') engine.tick(10_000)
        else if (phase === 'party-input') engine.selectAttack()
        else engine.tick(10_000)
      })
      metrics.driveSteps = n + 1
      if (!ok) {
        alive = false
        break
      }
      const fp = fingerprint(engine.getState())
      const events = engine.getState().eventTotal
      repeat = fp === lastFp ? repeat + 1 : 0
      lastFp = fp
      if (repeat >= o.lockRepeat && !engine.isOver()) {
        // 指紋が同じでもイベントが増えていれば行動は起きている（回復と攻撃が釣り合う膠着）。増えなければ本当に何も起きていない
        const acted = events !== lastEvents
        add([
          {
            kind: acted ? 'stalemate' : 'lock',
            detail:
              `phase = ${engine.getState().phase} のまま ${o.lockRepeat} 回進めても HP・状態が変わらない` +
              (acted ? '（行動は起きている）' : '（イベントも増えない）'),
            opIndex: idx,
          },
        ])
        break
      }
      lastEvents = events
    }
  }
  metrics.ended = engine.isOver()
  metrics.finalPhase = engine.getState().phase
  return { id: scenario.id, violations, metrics }
}

function collectMetrics(m: Metrics, events: readonly BattleActionEvent[]): void {
  for (const ev of events) {
    let dmg = 0
    m.maxHitsPerEvent = Math.max(m.maxHitsPerEvent, ev.hits.length)
    for (const h of ev.hits) {
      if (!Number.isFinite(h.amount)) continue
      if (h.kind === 'damage') dmg += h.amount
      if (h.kind === 'heal') m.maxHealAmount = Math.max(m.maxHealAmount, h.amount)
      if (Number.isFinite(h.hpBefore) && Number.isFinite(h.hpAfter)) {
        m.maxHpDrop = Math.max(m.maxHpDrop, h.hpBefore - h.hpAfter)
      }
    }
    m.maxEventDamage = Math.max(m.maxEventDamage, dmg)
  }
}

/** シナリオの敵の `loot` 宣言を、検出器が使う「敵 id → 宣言した品」に直す (#831)。宣言のある敵がいなければ空 */
function lootDeclarations(scenario: Scenario): Pick<DetectOptions, 'loot'> {
  const loot: Record<string, { normal: string[]; rare: string[]; drops: string[]; limit: number }> =
    {}
  for (const e of scenario.enemies) {
    const spec = parseLootSpec(e.loot)
    if (!spec) continue
    loot[e.id] = {
      normal: spec.steal.map((l) => l.itemId),
      rare: spec.stealRare.map((l) => l.itemId),
      drops: spec.drops.map((l) => l.itemId),
      limit: spec.stealLimit,
    }
  }
  return Object.keys(loot).length > 0 ? { loot } : {}
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
