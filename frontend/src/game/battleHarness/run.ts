/**
 * 検証ハーネスの実行 (#877 段階 3)。シナリオ 1 件を決定論的に動かし、検出器で見て、結果（違反と指標）を返す。
 * 検出のみ。エンジンの挙動は変えない。
 */
import type { BattleActionEvent, BattleState, SpellExecution } from '../battleEngine'
import { isSpreadableSpell, parseEffect } from '../spellDsl'
import { MAX_DAMAGE } from '../battleLimits'
import {
  checkRevival,
  checkState,
  downedKeys,
  fingerprint,
  type DetectOptions,
  type Violation,
} from './detect'
import { budgetRng, DEFAULT_RNG_BUDGET_PER_OP, RngBudgetExceeded } from './rng'
import { parseLootSpec } from '../loot'
import { placeEnemies } from '../enemyGrid'
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
      ? {
          script: {
            ruleCount: parseBattleScript(scenario.script.rules).rules.length,
            // 復活: を宣言した脚本は、倒れた味方が戻ってよい（強制では戻らない、の検査を外す）
            allowRevive: scenario.script.rules.some((r) => /^\s*復活\s*[:：]/.test(r)),
          },
        }
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
  let prevDown = downedKeys(engine.getState())

  /** 1 操作を実行して検査する。続行不能（例外・予算超過）なら false */
  const step = (
    opIndex: number,
    run: () => void,
    summonName?: string,
    summonCue?: { id: string },
    after?: (fresh: BattleActionEvent[]) => Violation[]
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
    if (after) add(after(fresh))
    for (const e of [...s.party, ...s.enemies]) {
      for (const v of Object.values(e.buffs ?? {})) {
        if (Number.isFinite(v))
          metrics.maxAbsBuff = Math.max(metrics.maxAbsBuff, Math.abs(v as number))
      }
    }
    add(checkState(s, fresh, opIndex, detect))
    add(checkRevival(prevDown, s, opIndex, detect))
    prevDown = downedKeys(s)
    return true
  }

  let alive = true
  for (let i = 0; i < scenario.ops.length && alive; i++) {
    const op = scenario.ops[i]
    // 魔法の全体化 (#895): 呪文の操作の前に、生きている敵を控えて、記録（ヒット）と割り算の規則を突き合わせる
    const spell = op.t === 'spell' ? scenario.spells[op.s] : undefined
    const aliveBefore = engine.getState().enemies.map((e) => e.hp > 0)
    // 敵のレベル (#898): 操作前の HP とレベルを控える
    const before = engine.getState().enemies.map((e) => ({ hp: e.hp, level: e.level }))
    const logBefore = engine.getState().logTotal
    alive = step(
      i,
      () => applyOp(engine, scenario, op),
      op.t === 'summon' ? scenario.summons?.[op.m]?.name : undefined,
      op.t === 'summon' ? scenario.summons?.[op.m]?.cue : undefined,
      spell && op.t === 'spell' && scenario.checkSpread
        ? (fresh) => checkMultiTarget(spell, op.scope, aliveBefore, fresh, i)
        : op.t === 'attack' && scenario.checkEnemyRow
          ? (fresh) => checkEnemyRow(scenario, aliveBefore, fresh, i)
          : spell && op.t === 'spell' && scenario.checkEnemyLevel
            ? (fresh) => checkEnemyLevel(spell, op.target, before, engine.getState(), fresh, i)
            : op.t === 'ability' && scenario.checkJobConversion
              ? (fresh) =>
                  checkJobConversion(
                    scenario.abilities?.[op.k],
                    logBefore,
                    engine.getState(),
                    fresh,
                    i
                  )
              : undefined
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

/** シナリオが宣言した召喚獣の演出（召喚・わざの `cue`。敵は召喚獣を呼ばないので敵の特技は数えない）の id (#750)。1 つも無ければ空（検出器は `summon` が付いたら違反にする） */
function summonCueDeclarations(scenario: Scenario): Pick<DetectOptions, 'summonCueIds'> {
  const ids = new Set<string>()
  const lists = [...(scenario.summons ?? []), ...(scenario.abilities ?? [])]
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

/**
 * ジョブの変換 (#876) の不変条件。わざの 1 回の行動（味方の `skill` イベントのうちラベルがわざの名前のもの）が出た操作だけ見る。
 * その行動のログに「(〇〇ジョブの 効果)」が、変換した特技（`convertedBy` あり）なら名前つきでちょうど 1 回、変換していない特技なら 0 回出る
 */
function checkJobConversion(
  ability: { name: string; convertedBy?: string } | undefined,
  logBefore: number,
  after: Readonly<BattleState>,
  fresh: readonly BattleActionEvent[],
  opIndex: number
): Violation[] {
  if (!ability) return []
  if (
    !fresh.some(
      (ev) => ev.kind === 'skill' && ev.actor.side === 'party' && ev.label === ability.name
    )
  ) {
    return []
  }
  const added = after.logTotal - logBefore
  const lines = after.log
    .slice(-Math.min(added, after.log.length))
    .filter((l) => l.includes('ジョブの 効果'))
  const want = ability.convertedBy ? [`(${ability.convertedBy}ジョブの 効果)`] : []
  if (JSON.stringify(lines) !== JSON.stringify(want)) {
    return [
      {
        kind: 'job-conversion-invariant',
        detail: `${ability.name}（変換${ability.convertedBy ? 'あり' : 'なし'}）のログの「ジョブの 効果」が ${JSON.stringify(lines)}（期待 ${JSON.stringify(want)}）`,
        opIndex,
      },
    ]
  }
  return []
}

/**
 * 敵のレベル (#898) の不変条件。呪文 1 回の記録（味方の `spell` イベントのうち `label` が呪文名のもの）が出た操作だけ見る
 * （ATB で行動できず呪文が出なかった操作は見ない）。対象は `target`（敵の id）の敵 1 体で、敵は死の耐性・状態・HP の下限を持たない前提:
 * - `damage_full レベル倍数=N`: 操作前に生きていてレベルが N の倍数なら倒れ、倍数でない・レベル無しなら HP もレベルも動かない
 * - `level +N|-N|=N`: 操作前に生きていてレベルを持つなら、結果は式どおり 1〜99 に収めた値。レベル無し・倒れていた敵は動かない
 * - どの呪文でも、全員のレベルは「無し」か 1〜99 の整数で、レベル無しの敵にレベルは付かない
 */
function checkEnemyLevel(
  spell: SpellExecution,
  targetId: string | undefined,
  before: readonly { hp: number; level: number | undefined }[],
  after: Readonly<BattleState>,
  fresh: readonly BattleActionEvent[],
  opIndex: number
): Violation[] {
  const out: Violation[] = []
  const bad = (detail: string): void => {
    out.push({ kind: 'enemy-level-invariant', detail, opIndex })
  }
  after.enemies.forEach((e, i) => {
    if (e.level !== undefined && (!Number.isInteger(e.level) || e.level < 1 || e.level > 99)) {
      bad(`敵 #${i} のレベル ${String(e.level)} が 1〜99 の整数でない`)
    }
    if (before[i].level === undefined && e.level !== undefined) {
      bad(`レベルを持たない敵 #${i} にレベル ${e.level} が付いた`)
    }
  })
  const acted = fresh.some(
    (ev) => ev.kind === 'spell' && ev.actor.side === 'party' && ev.label === spell.name
  )
  const parsed = spell.effect ? parseEffect(spell.effect) : null
  const idx = after.enemies.findIndex((e) => e.id === targetId)
  if (!acted || !parsed || idx < 0) return out
  const b = before[idx]
  const a = after.enemies[idx]
  const tag = `${spell.name}(${spell.effect}) → 敵 #${idx}（HP ${b.hp}・レベル ${String(b.level)}）`
  if (parsed.kind === 'damage_full' && parsed.levelMultiple !== undefined && b.hp > 0) {
    const hit = b.level !== undefined && b.level % parsed.levelMultiple === 0
    if (hit && a.hp > 0) bad(`${tag}: レベルが ${parsed.levelMultiple} の倍数なのに倒れなかった`)
    if (!hit && (a.hp !== b.hp || a.level !== b.level)) {
      bad(`${tag}: レベルが ${parsed.levelMultiple} の倍数でないのに効いた（HP ${a.hp}）`)
    }
  }
  if (parsed.kind === 'level' && parsed.levelAdjust) {
    let want = b.level
    if (b.level !== undefined && b.hp > 0) {
      const adj = parsed.levelAdjust
      want = Math.min(99, Math.max(1, adj.mode === 'set' ? adj.value : b.level + adj.value))
    }
    if (a.level !== want)
      bad(`${tag}: 調整後のレベル ${String(a.level)} が式どおりの ${String(want)} でない`)
  }
  return out
}

/**
 * 敵の前列・後列 (#896) の不変条件。味方の通常攻撃（`attack` イベント）が敵に与えた量が、その敵の「操作前の列」に応じた範囲に収まる。
 * 範囲は DQ 式の通常攻撃（`base = max(1, atk - floor(def/2))`、`base` 〜 `base + floor(atk/4)`）で、後列なら 1 回半分（切り捨て・最低 1）。
 * 敵の列はエンジンと別に求める: 宣言（`formationRow`）→ `enemyRow` の無いシナリオなら全員前列 → グリッドの右端の列（占有セルの右端。
 * 隊列を宣言していない生存者の中で最も手前なら前列）。味方は 1 人・敵は耐性・相性・状態を持たない前提
 */
function checkEnemyRow(
  scenario: Scenario,
  aliveBefore: readonly boolean[],
  fresh: readonly BattleActionEvent[],
  opIndex: number
): Violation[] {
  const out: Violation[] = []
  const grid = scenario.enemyRow?.grid
  const edges = new Map<number, number>()
  if (scenario.enemyRow && grid) {
    const placed = placeEnemies(
      grid,
      scenario.enemies.map((e) => ({
        w: e.layout?.w ?? 1,
        h: e.layout?.h ?? 1,
        ...(e.layout?.at ? { at: e.layout.at } : {}),
      }))
    )
    placed.cells.forEach((c, i) => {
      if (c) edges.set(i, c.col + (scenario.enemies[i].layout?.w ?? 1) - 1)
    })
  }
  let front = -1
  scenario.enemies.forEach((e, i) => {
    const edge = edges.get(i)
    if (aliveBefore[i] && !e.formationRow && edge !== undefined) front = Math.max(front, edge)
  })
  const hero = scenario.party[0]
  for (const ev of fresh) {
    if (ev.kind !== 'attack' || ev.actor.side !== 'party') continue
    for (const h of ev.hits) {
      if (h.target.side !== 'enemy' || h.kind !== 'damage') continue
      const i = h.target.index
      const def = scenario.enemies[i]
      let back: boolean
      if (!scenario.enemyRow) back = def.row === 'back'
      else if (def.formationRow) back = def.formationRow === 'back'
      else {
        const edge = edges.get(i)
        back = edge !== undefined ? edge < front : def.row === 'back'
      }
      let lo = Math.max(1, hero.atk - Math.floor(def.def / 2))
      let hi = lo + Math.floor(hero.atk / 4)
      if (back) {
        lo = Math.max(1, Math.floor(lo / 2))
        hi = Math.max(1, Math.floor(hi / 2))
      }
      if (h.amount < lo || h.amount > hi) {
        out.push({
          kind: 'enemy-row-invariant',
          detail: `敵 #${i}（${back ? '後列' : '前列'}）への通常攻撃のダメージ ${h.amount} が範囲 ${lo}〜${hi} の外`,
          opIndex,
        })
      }
    }
  }
  return out
}

/**
 * 魔法の全体化 (#895) の不変条件。呪文 1 回の記録（味方の `spell` イベントのうち `label` が呪文名のもの）の、敵へのヒットを見る。
 * - 全体化できる呪文（`全体化: 可` の敵単体）を `scope: 'all'` で撃った: 当たるのは操作前に生きていた敵だけ。単純なダメージ（`damage a..b`・属性なし・回数なし）なら
 *   生きていた敵の全員に当たり、量は割った範囲（生存数 n >= 2 なら `max(1, floor(a / n))`〜`max(1, floor(b / n))`、n = 1 なら a〜b）に収まる
 * - それ以外（可でない・範囲が単体・敵全体・味方単体）: 敵単体の呪文は当たる敵が 1 体以下、単純なダメージの量は割らない範囲 a〜b
 * このハーネスのシナリオは敵に耐性・相性を持たせない前提（持たせると量の範囲が広がる）
 */
function checkMultiTarget(
  spell: SpellExecution,
  scope: 'all' | undefined,
  aliveBefore: readonly boolean[],
  fresh: readonly BattleActionEvent[],
  opIndex: number
): Violation[] {
  const out: Violation[] = []
  const bad = (detail: string): void => {
    out.push({ kind: 'multi-target-invariant', detail, opIndex })
  }
  const parsed = spell.effect ? parseEffect(spell.effect) : null
  const simple =
    parsed !== null &&
    parsed.kind === 'damage' &&
    parsed.type === undefined &&
    parsed.count === undefined &&
    parsed.min !== undefined &&
    parsed.max !== undefined
  const lo = simple ? Math.min(parsed.min ?? 0, parsed.max ?? 0) : 0
  const hi = simple ? Math.max(parsed.min ?? 0, parsed.max ?? 0) : 0
  const aliveIdx = aliveBefore.flatMap((a, i) => (a ? [i] : []))
  const spread = scope === 'all' && isSpreadableSpell(spell)
  const n = aliveIdx.length
  const target = spell.target.trim()
  for (const ev of fresh) {
    if (ev.kind !== 'spell' || ev.actor.side !== 'party' || ev.label !== spell.name) continue
    const enemyHits = ev.hits.filter((h) => h.target.side === 'enemy')
    const hit = new Set(enemyHits.map((h) => h.target.index))
    const damaged = enemyHits.filter((h) => h.kind === 'damage')
    const tag = `${spell.name}(${spell.target}${spell.multiTarget ? '・全体化可' : ''}, scope=${scope ?? 'single'}, 生存${n})`
    if (spread) {
      for (const i of hit) if (!aliveBefore[i]) bad(`${tag}: 倒れていた敵 #${i} に当たった`)
      if (simple) {
        const damagedIdx = new Set(damaged.map((h) => h.target.index))
        for (const i of aliveIdx) {
          if (!damagedIdx.has(i)) bad(`${tag}: 生きていた敵 #${i} にダメージが出ていない`)
        }
        const dmin = n >= 2 ? Math.max(1, Math.floor(lo / n)) : lo
        const dmax = n >= 2 ? Math.max(1, Math.floor(hi / n)) : hi
        for (const h of damaged) {
          if (h.amount < dmin || h.amount > dmax) {
            bad(
              `${tag}: 敵 #${h.target.index} へのダメージ ${h.amount} が割った範囲 ${dmin}〜${dmax} の外`
            )
          }
        }
      }
      continue
    }
    if ((target === '敵単体' || target === '') && hit.size > 1) {
      bad(`${tag}: 全体化していないのに敵 ${hit.size} 体に当たった`)
    }
    if (simple && (target === '敵単体' || target === '敵全体')) {
      for (const h of damaged) {
        if (h.amount < lo || h.amount > hi) {
          bad(
            `${tag}: 敵 #${h.target.index} へのダメージ ${h.amount} が割らない範囲 ${lo}〜${hi} の外`
          )
        }
      }
    }
  }
  return out
}
