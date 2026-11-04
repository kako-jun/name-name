/**
 * 検証ハーネスの総当たり実行 (#877 段階 3)。生成 → 全件実行 → 集計。
 */
import {
  damageConditions,
  equipmentScenarios,
  summonScenarios,
  multiTargetScenarios,
  jobScenarios,
  lootMatrix,
  effectMatrix,
  magiciteScenarios,
  enemySkillMatrix,
  randomScenarios,
  randomStatusScenarios,
  reactionChains,
  stackOrders,
  statusMatrix,
} from './generate'
import {
  forceMatrix,
  randomForceScenarios,
  randomScriptScenarios,
  scriptMatrix,
} from './scriptFamily'
import { runScenario, type RunOptions, type ScenarioResult } from './run'
import type { Scenario } from './scenario'

export interface SweepConfig {
  /** ランダム合成の seed とシナリオ数 */
  randomSeed: number
  randomCount: number
  /** 状態を宣言したランダム合成 (#870) のシナリオ数（seed は `randomSeed` と共通） */
  randomStatusCount?: number
  /** 脚本制御の戦闘のランダム合成 (#741) のシナリオ数（seed は `randomSeed` と共通） */
  randomScriptCount?: number
  /** 総当たりの族を省く（短く回したいとき） */
  skip?: SweepFamily[]
}

export type SweepFamily =
  | 'effect-matrix'
  | 'enemy-skill'
  | 'stack-order'
  | 'reaction-chain'
  | 'random'
  | 'status-matrix'
  | 'random-status'
  | 'damage-condition'
  | 'magicite'
  | 'loot'
  | 'script'
  | 'random-script'
  | 'equipment'
  | 'summon'
  | 'job'
  | 'script-force'
  | 'multi-target'

/** 族 `script-force` のランダム合成の件数（固定。決定論） */
export const FORCE_RANDOM_COUNT = 400

export const DEFAULT_SWEEP: SweepConfig = {
  randomSeed: 1,
  randomCount: 3000,
  randomStatusCount: 2000,
  randomScriptCount: 1000,
}

export function buildSweep(cfg: SweepConfig = DEFAULT_SWEEP): Scenario[] {
  const skip = new Set(cfg.skip ?? [])
  return [
    ...(skip.has('effect-matrix') ? [] : effectMatrix()),
    ...(skip.has('enemy-skill') ? [] : enemySkillMatrix()),
    ...(skip.has('stack-order') ? [] : stackOrders()),
    ...(skip.has('reaction-chain') ? [] : reactionChains()),
    ...(skip.has('random') ? [] : randomScenarios(cfg.randomSeed, cfg.randomCount)),
    ...(skip.has('status-matrix') ? [] : statusMatrix()),
    ...(skip.has('random-status')
      ? []
      : randomStatusScenarios(
          cfg.randomSeed,
          cfg.randomStatusCount ?? DEFAULT_SWEEP.randomStatusCount ?? 0
        )),
    ...(skip.has('damage-condition') ? [] : damageConditions()),
    ...(skip.has('magicite') ? [] : magiciteScenarios()),
    ...(skip.has('loot') ? [] : lootMatrix()),
    ...(skip.has('script') ? [] : scriptMatrix()),
    ...(skip.has('random-script')
      ? []
      : randomScriptScenarios(
          cfg.randomSeed,
          cfg.randomScriptCount ?? DEFAULT_SWEEP.randomScriptCount ?? 0
        )),
    ...(skip.has('equipment') ? [] : equipmentScenarios()),
    ...(skip.has('job') ? [] : jobScenarios()),
    ...(skip.has('summon') ? [] : summonScenarios()),
    // 強制 (#741 段階 2)。末尾に足すので、これより前の族の並び・出力は変わらない
    ...(skip.has('script-force')
      ? []
      : [...forceMatrix(), ...randomForceScenarios(cfg.randomSeed, FORCE_RANDOM_COUNT)]),
    // 魔法の全体化 (#895)。さらに末尾に足すので、これより前の族の並び・出力は変わらない
    ...(skip.has('multi-target') ? [] : multiTargetScenarios()),
  ]
}

export function runAll(scenarios: readonly Scenario[], options?: RunOptions): ScenarioResult[] {
  return scenarios.map((s) => runScenario(s, options))
}
