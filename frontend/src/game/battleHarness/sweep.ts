/**
 * 検証ハーネスの総当たり実行 (#877 段階 3)。生成 → 全件実行 → 集計。
 */
import {
  effectMatrix,
  enemySkillMatrix,
  randomScenarios,
  reactionChains,
  stackOrders,
} from './generate'
import { runScenario, type RunOptions, type ScenarioResult } from './run'
import type { Scenario } from './scenario'

export interface SweepConfig {
  /** ランダム合成の seed とシナリオ数 */
  randomSeed: number
  randomCount: number
  /** 総当たりの族を省く（短く回したいとき） */
  skip?: Array<'effect-matrix' | 'enemy-skill' | 'stack-order' | 'reaction-chain' | 'random'>
}

export const DEFAULT_SWEEP: SweepConfig = { randomSeed: 1, randomCount: 3000 }

export function buildSweep(cfg: SweepConfig = DEFAULT_SWEEP): Scenario[] {
  const skip = new Set(cfg.skip ?? [])
  return [
    ...(skip.has('effect-matrix') ? [] : effectMatrix()),
    ...(skip.has('enemy-skill') ? [] : enemySkillMatrix()),
    ...(skip.has('stack-order') ? [] : stackOrders()),
    ...(skip.has('reaction-chain') ? [] : reactionChains()),
    ...(skip.has('random') ? [] : randomScenarios(cfg.randomSeed, cfg.randomCount)),
  ]
}

export function runAll(scenarios: readonly Scenario[], options?: RunOptions): ScenarioResult[] {
  return scenarios.map((s) => runScenario(s, options))
}
