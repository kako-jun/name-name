/**
 * 検証ハーネスの実行 (#877 段階 3)。シナリオ 1 件を決定論的に動かし、検出器で見て、結果（違反と指標）を返す。
 * 検出のみ。エンジンの挙動は変えない。
 */
import type { BattleActionEvent } from '../battleEngine'
import { MAX_DAMAGE } from '../battleLimits'
import { checkState, fingerprint, type DetectOptions, type Violation } from './detect'
import { budgetRng, DEFAULT_RNG_BUDGET_PER_OP, RngBudgetExceeded } from './rng'
import { parseLootSpec } from '../loot'
import { parseBattleScript } from '../battleScript'
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
    // 召喚獣の演出 (#750)。宣言したシナリオだけ、宣言した id の演出だけを許す（宣言の無いシナリオは `summon` が付いたら違反）
    ...summonCueDeclarations(scenario),
    // 脚本制御の戦闘 (#741)。脚本のあるシナリオだけ、`state.script` の整合を検査し、脚本が決めた勝敗を許す
    ...(scenario.script
      ? { script: { ruleCount: parseBattleScript(scenario.script.rules).rules.length } }
      : {}),
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
  // 召喚 (#889): 同じ味方が 2 回召喚してはならず、召喚した味方には印が立っている。
  // 数えるのは「召喚の操作（`summon`）を実行した 1 操作の間に増えた、味方の演出イベントのうちラベルがその召喚獣の名前のもの」だけ。
  // 召喚の演出イベントは特技と同じ `kind: 'skill'` で区別できないため、操作の種類で絞って、同じ名前の特技・呪文が別の場面で
  // 使われても数えないようにしている（限界: 召喚の操作の最中に同じ名前の味方の特技が同時に起きるシナリオは想定しない）
  const summonCount = new Map<number, number>()
  add(checkState(engine.getState(), [], -1, detect))

  /** 1 操作を実行して検査する。続行不能（例外・予算超過）なら false */
  const step = (
    opIndex: number,
    run: () => void,
    summonName?: string,
    summonCue?: { id: string }
  ): boolean => {
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
    if (summonName !== undefined) {
      for (const ev of fresh) {
        if (ev.kind !== 'skill' || ev.actor.side !== 'party' || ev.label !== summonName) continue
        // 召喚獣の演出 (#750): 魔石が演出の元（cue）を持つなら、その召喚の記録に同じ id の演出が付く
        const wantCue = summonCue
        if (wantCue !== undefined && ev.summon?.id !== wantCue.id) {
          add([
            {
              kind: 'summon-invariant',
              detail: `召喚の記録 event#${ev.seq} に演出 ${wantCue.id} が付いていない（${String(ev.summon?.id)}）`,
              opIndex,
            },
          ])
        }
        const n = (summonCount.get(ev.actor.index) ?? 0) + 1
        summonCount.set(ev.actor.index, n)
        if (n > 1) {
          add([
            {
              kind: 'magicite-invariant',
              detail: `party[${ev.actor.index}] が 1 バトルで ${n} 回召喚した（event#${ev.seq}）`,
              opIndex,
            },
          ])
        } else if (s.party[ev.actor.index]?.summoned !== true) {
          add([
            {
              kind: 'magicite-invariant',
              detail: `party[${ev.actor.index}] が召喚したのに summoned が立っていない（event#${ev.seq}）`,
              opIndex,
            },
          ])
        }
      }
    }
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
    const op = scenario.ops[i]
    alive = step(
      i,
      () => applyOp(engine, scenario, op),
      op.t === 'summon' ? scenario.summons?.[op.m]?.name : undefined,
      op.t === 'summon' ? scenario.summons?.[op.m]?.cue : undefined
    )
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
  if (alive) checkScriptExpect(scenario, engine, o.driveLimit, add)
  return { id: scenario.id, violations, metrics }
}

/**
 * 脚本のシナリオが「終わるはず」なら、自動進行の上限までに決着し、許した終わり方で、ターン上限内かを見る (#741)。
 * 勝敗固定の戦闘が、条件が満たされないまま膠着しない（ロック・無限ループ・進行不能を作らない）ことの検査。
 * `driveLimit` が 0 のシナリオ（自動進行しない設定）では決着を要求しない
 */
function checkScriptExpect(
  scenario: Scenario,
  engine: HarnessEngine,
  driveLimit: number,
  add: (vs: Violation[]) => void
): void {
  const ex = scenario.scriptExpect
  if (!ex || driveLimit <= 0) return
  const s = engine.getState()
  const opIndex = scenario.ops.length
  if (!engine.isOver()) {
    add([
      {
        kind: 'script-no-end',
        detail: `自動進行 ${driveLimit} 回までに決着しなかった（phase = ${s.phase}, turn = ${s.script?.turn ?? '-'}）`,
        opIndex,
      },
    ])
    return
  }
  if (!ex.ends.includes(s.phase)) {
    add([
      {
        kind: 'script-outcome',
        detail: `phase = ${s.phase} で終わった（期待: ${ex.ends.join(' / ')}）`,
        opIndex,
      },
    ])
  }
  if (ex.maxTurn !== undefined && (s.script?.turn ?? 0) > ex.maxTurn) {
    add([
      {
        kind: 'script-outcome',
        detail: `turn = ${s.script?.turn} が上限 ${ex.maxTurn} を超えた`,
        opIndex,
      },
    ])
  }
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

/** シナリオが宣言した召喚獣の演出（特技・召喚・わざの `cue`）の id (#750)。1 つも無ければ空（検出器は `summon` が付いたら違反にする） */
function summonCueDeclarations(scenario: Scenario): Pick<DetectOptions, 'summonCueIds'> {
  const ids = new Set<string>()
  const lists = [
    ...Object.values(scenario.skills ?? {}),
    ...(scenario.summons ?? []),
    ...(scenario.abilities ?? []),
  ]
  for (const e of lists) if (e.cue) ids.add(e.cue.id)
  return ids.size > 0 ? { summonCueIds: [...ids] } : {}
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
