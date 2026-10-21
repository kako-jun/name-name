/**
 * 検証ハーネスのシナリオ (#877 段階 3)。**JSON にそのまま書き出せる**ことが条件（失敗の再現入力になる）。
 * 数値は有限値だけを使う（NaN / Infinity は JSON で壊れる。「極大」は 1e9 などで表す）。
 */
import {
  BattleEngine,
  type BattleState,
  type ItemExecution,
  type SkillExecution,
  type SpellExecution,
  type SummonExecution,
} from '../battleEngine'
import type { BattleEntity } from '../spellDsl'
import type { StatusDef } from '../../types'

/** 操作列の 1 要素。`s` / `i` は `Scenario.spells` / `Scenario.items` の添字 */
export type Op =
  | { t: 'attack'; target?: string }
  | { t: 'spell'; s: number; target?: string }
  | { t: 'item'; i: number; target?: string }
  | { t: 'summon'; m: number; target?: string }
  | { t: 'escape' }
  | { t: 'tick'; ms: number }

export interface Scenario {
  /** 一覧・再現の指定に使う一意な名前（`<族>/<連番または内容>`） */
  id: string
  /** 乱数の種。同じ scenario は同じ結果になる */
  seed: number
  party: BattleEntity[]
  enemies: BattleEntity[]
  /** 未指定は従来ターン制 */
  atb?: { mode: 'wait' | 'active' }
  /** 敵の特技（`actions` / `counters` / `onDeath` の候補 id → 実行内容） */
  skills?: Record<string, SkillExecution>
  /** 状態の宣言 (#870)。`[状態]` の内容（id → `StatusDef`）。無いシナリオは従来どおり */
  statuses?: Record<string, StatusDef>
  spells: SpellExecution[]
  items: ItemExecution[]
  /** 召喚 (#889)。`Op` の `summon` の `m` が添字。無いシナリオは従来どおり */
  summons?: SummonExecution[]
  ops: Op[]
  /** 脚本制御の戦闘 (#741 / #863)。`[戦闘]` の宣言（`rules`）と、途中参戦できる味方。無いシナリオは従来どおり */
  script?: { id: string; rules: string[]; joiners?: Record<string, BattleEntity> }
  /**
   * 脚本のシナリオの期待。`ends` = 決着したときの phase として許すもの（これ以外で終わる・終わらない＝壊れ）、
   * `maxTurn` = 経過ターンの上限（`固定` の上限ターン。これを超えたら壊れ）。決着しなければ（`ends` を持つシナリオは）必ず壊れ
   */
  scriptExpect?: { ends: string[]; maxTurn?: number }
}

/** ハーネスがエンジンに要求する最小の口。`BattleEngine` はこれを満たす（検出器のテストでは合成エンジンを差し込む） */
export interface HarnessEngine {
  getState(): Readonly<BattleState>
  isOver(): boolean
  tick(ms: number): void
  selectAttack(targetId?: string): void
  selectSpell(spell: SpellExecution, targetId?: string): void
  selectItem(item: ItemExecution, targetId?: string): boolean
  /** 召喚 (#889)。召喚を使わない合成エンジンは持たなくてよい */
  selectSummon?(summon: SummonExecution, targetId?: string): boolean
  selectEscape(): void
}

export type EngineFactory = (scenario: Scenario, rng: () => number) => HarnessEngine

/** 本物の `BattleEngine` を作る。シナリオ自体は書き換えない（エンティティは複製して渡す） */
export const realEngineFactory: EngineFactory = (scenario, rng) =>
  new BattleEngine(clone(scenario.party), clone(scenario.enemies), {
    rng,
    atb: scenario.atb ? { mode: scenario.atb.mode } : undefined,
    skills: scenario.skills ? clone(scenario.skills) : undefined,
    statuses: scenario.statuses ? clone(scenario.statuses) : undefined,
    script: scenario.script ? clone(scenario.script) : undefined,
  })

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 1 操作をエンジンに適用する。範囲外の添字は何もしない */
export function applyOp(engine: HarnessEngine, scenario: Scenario, op: Op): void {
  switch (op.t) {
    case 'attack':
      engine.selectAttack(op.target)
      return
    case 'spell': {
      const spell = scenario.spells[op.s]
      if (spell) engine.selectSpell(clone(spell), op.target)
      return
    }
    case 'item': {
      const item = scenario.items[op.i]
      if (item) engine.selectItem(clone(item), op.target)
      return
    }
    case 'summon': {
      const summon = scenario.summons?.[op.m]
      if (summon) engine.selectSummon?.(clone(summon), op.target)
      return
    }
    case 'escape':
      engine.selectEscape()
      return
    case 'tick':
      engine.tick(op.ms)
      return
  }
}
