/**
 * 検証ハーネスのテスト用の合成エンジン (#877 段階 3)。わざと壊れた状態や進行不能を作って、検出器が拾えることを確かめる。
 * 本番コードからは使わない。
 */
import type { BattleActionEvent, BattleState } from '../battleEngine'
import type { BattleEntity } from '../spellDsl'
import { entity } from './generate'
import type { EngineFactory, HarnessEngine, Scenario } from './scenario'

export function baseState(
  party: BattleEntity[],
  enemies: BattleEntity[],
  phase: BattleState['phase'] = 'party-input'
): BattleState {
  return {
    party,
    enemies,
    phase,
    log: [],
    logTotal: 0,
    events: [],
    eventTotal: 0,
    earnedExp: 0,
    earnedGold: 0,
  }
}

export function scenarioOf(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'test/x',
    seed: 1,
    party: [entity('a')],
    enemies: [entity('s')],
    spells: [],
    items: [],
    ops: [{ t: 'attack' }, { t: 'attack' }, { t: 'attack' }],
    ...over,
  }
}

/** 操作ごとに `onOp(state, 回数, rng)` が状態を書き換える合成エンジン。何も変えなければ「何も起きない」エンジン */
export function fakeFactory(
  onOp: (state: BattleState, n: number, rng: () => number) => void
): EngineFactory {
  return (scenario, rng) => {
    const state = baseState(
      JSON.parse(JSON.stringify(scenario.party)),
      JSON.parse(JSON.stringify(scenario.enemies))
    )
    let n = 0
    const step = (): void => onOp(state, n++, rng)
    const engine: HarnessEngine = {
      getState: () => state,
      isOver: () => ['victory', 'defeat', 'escaped', 'interrupted'].includes(state.phase),
      tick: step,
      selectAttack: step,
      selectSpell: step,
      selectItem: () => {
        step()
        return true
      },
      selectEscape: step,
    }
    return engine
  }
}

export function pushEvent(state: BattleState, hits: BattleActionEvent['hits']): void {
  state.events.push({
    seq: state.eventTotal,
    actor: { side: 'party', index: 0 },
    kind: 'attack',
    hits,
  })
  state.eventTotal++
}
