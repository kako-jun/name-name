import { describe, it, expect, vi } from 'vitest'
import {
  advanceEncounter,
  afterBattleState,
  initialEncounterState,
  type EncounterStepConfig,
  type EncounterWalkState,
  type SceneEncounter,
} from './fieldEncounter'
import { rollEncounter } from './encounter'
import type { MonsterDef } from '../types'

const slime: MonsterDef = {
  id: 'slime',
  name: 'スライム',
  hp: 10,
  mp: 2,
  atk: 3,
  def: 1,
  agi: 2,
  exp: 2,
  gold: 1,
  sprite: 'slime.png',
}

const ghost: MonsterDef = {
  id: 'ghost',
  name: 'ゴースト',
  hp: 14,
  mp: 0,
  atk: 5,
  def: 2,
  agi: 6,
  exp: 4,
  gold: 3,
}

const masters = { slime, ghost }
const step: EncounterStepConfig = { stepDistance: 80, minSteps: 3 }
const always: SceneEncounter = { rate: 1, groups: ['slime'] }

/** 呼び出し回数を数える rng（固定値） */
function countingRng(value: number) {
  const fn = vi.fn(() => value)
  return fn
}

/** 値の列を順に返す rng。呼び出し回数は calls で見る */
function seqRng(values: number[]) {
  let i = 0
  const fn = vi.fn(() => values[Math.min(i++, values.length - 1)])
  return fn
}

describe('initialEncounterState / afterBattleState (Issue #809)', () => {
  it('initialEncounterState は distance=0・since=minSteps（抑制なしで始める）', () => {
    expect(initialEncounterState(step)).toEqual({ distance: 0, stepsSinceBattle: 3 })
    expect(initialEncounterState({ stepDistance: 80, minSteps: 0 })).toEqual({
      distance: 0,
      stepsSinceBattle: 0,
    })
  })

  it('afterBattleState は両方 0', () => {
    expect(afterBattleState()).toEqual({ distance: 0, stepsSinceBattle: 0 })
  })
})

describe('advanceEncounter (Issue #809)', () => {
  const ready: EncounterWalkState = { distance: 0, stepsSinceBattle: 3 }

  it('① scene が null ならすべて不変・enemies は null', () => {
    const r = advanceEncounter(ready, 500, step, null, masters, () => 0)
    expect(r.state).toBe(ready)
    expect(r.enemies).toBeNull()
  })

  it('② rate=0 なら不変', () => {
    const r = advanceEncounter(ready, 500, step, { rate: 0, groups: ['slime'] }, masters, () => 0)
    expect(r.state).toBe(ready)
    expect(r.enemies).toBeNull()
  })

  it('③ walked=0 なら不変（同一参照）', () => {
    const r = advanceEncounter(ready, 0, step, always, masters, () => 0)
    expect(r.state).toBe(ready)
    expect(r.enemies).toBeNull()
  })

  it('④ walked が負なら不変', () => {
    const r = advanceEncounter(ready, -50, step, always, masters, () => 0)
    expect(r.state).toBe(ready)
    expect(r.enemies).toBeNull()
  })

  it('⑤ walked=79・since=3 では抽選せず距離だけ加算', () => {
    const rng = countingRng(0)
    const r = advanceEncounter(ready, 79, step, always, masters, rng)
    expect(r.state).toEqual({ distance: 79, stepsSinceBattle: 3 })
    expect(r.enemies).toBeNull()
    expect(rng).not.toHaveBeenCalled()
  })

  it('⑥ walked=80・since=3・rate=1・rng=0 で当選し afterBattleState になる', () => {
    const r = advanceEncounter(ready, 80, step, always, masters, () => 0)
    expect(r.enemies).not.toBeNull()
    expect(r.enemies).toHaveLength(1)
    expect(r.state).toEqual(afterBattleState())
  })

  it('⑦ walked=81 でも当選する（余りは捨てる）', () => {
    const r = advanceEncounter(ready, 81, step, always, masters, () => 0)
    expect(r.enemies).not.toBeNull()
    expect(r.state).toEqual({ distance: 0, stepsSinceBattle: 0 })
  })

  it('⑧ since=0 の抑制中は抽選せず since が 1 進む', () => {
    const rng = countingRng(0)
    const r = advanceEncounter({ distance: 0, stepsSinceBattle: 0 }, 80, step, always, masters, rng)
    expect(r.enemies).toBeNull()
    expect(r.state).toEqual({ distance: 0, stepsSinceBattle: 1 })
    expect(rng).not.toHaveBeenCalled()
  })

  it('⑨ walked=240・since=0・minSteps=3 では抽選せず since=3・distance=0', () => {
    const rng = countingRng(0)
    const r = advanceEncounter(
      { distance: 0, stepsSinceBattle: 0 },
      240,
      step,
      always,
      masters,
      rng
    )
    expect(r.enemies).toBeNull()
    expect(r.state).toEqual({ distance: 0, stepsSinceBattle: 3 })
    expect(rng).not.toHaveBeenCalled()
  })

  it('⑩ walked=320・since=0 なら 4 回目の刻みで当選する', () => {
    const r = advanceEncounter(
      { distance: 0, stepsSinceBattle: 0 },
      320,
      step,
      always,
      masters,
      () => 0
    )
    expect(r.enemies).not.toBeNull()
    expect(r.state).toEqual(afterBattleState())
  })

  it('⑪ rate=5・walked=80・rng=0.2 は外れ（since=4・distance=0）', () => {
    const r = advanceEncounter(ready, 80, step, { rate: 5, groups: ['slime'] }, masters, () => 0.2)
    expect(r.enemies).toBeNull()
    expect(r.state).toEqual({ distance: 0, stepsSinceBattle: 4 })
  })

  it('⑫ rate=5・walked=800 は途中の当選で打ち切り、残りの距離を捨てる', () => {
    // 1 回目の抽選: 0.5 (外れ)、2 回目: 0.1 (当選) → グループ選び 0
    const rng = seqRng([0.5, 0.1, 0])
    const r = advanceEncounter(ready, 800, step, { rate: 5, groups: ['slime'] }, masters, rng)
    expect(r.enemies).not.toBeNull()
    expect(r.state).toEqual({ distance: 0, stepsSinceBattle: 0 })
    expect(rng).toHaveBeenCalledTimes(3)
  })

  it('⑬ minSteps=0 なら since=0 でも即抽選する', () => {
    const r = advanceEncounter(
      { distance: 0, stepsSinceBattle: 0 },
      80,
      { stepDistance: 80, minSteps: 0 },
      always,
      masters,
      () => 0
    )
    expect(r.enemies).not.toBeNull()
  })

  it('⑭ stepDistance=0 なら不変（無限ループしない）', () => {
    const r = advanceEncounter(
      ready,
      100,
      { stepDistance: 0, minSteps: 3 },
      always,
      masters,
      () => 0
    )
    expect(r.state).toBe(ready)
    expect(r.enemies).toBeNull()
  })

  it('⑮ groups が空なら外れ扱いで since が進む', () => {
    const r = advanceEncounter(ready, 80, step, { rate: 1, groups: [] }, masters, () => 0)
    expect(r.enemies).toBeNull()
    expect(r.state).toEqual({ distance: 0, stepsSinceBattle: 4 })
  })

  it('79 と 1 に分けて歩いて合計 80 になった時点で 1 回だけ抽選する', () => {
    const rng = seqRng([0.9, 0.9])
    const a = advanceEncounter(ready, 79, step, { rate: 5, groups: ['slime'] }, masters, rng)
    expect(rng).not.toHaveBeenCalled()
    const b = advanceEncounter(a.state, 1, step, { rate: 5, groups: ['slime'] }, masters, rng)
    expect(rng).toHaveBeenCalledTimes(1)
    expect(b.enemies).toBeNull()
    expect(b.state).toEqual({ distance: 0, stepsSinceBattle: 4 })
  })

  it('距離は剰余で持ち越される（100 歩 → 抽選 1 回・残り 20）', () => {
    const r = advanceEncounter(ready, 100, step, { rate: 5, groups: ['slime'] }, masters, () => 0.9)
    expect(r.state).toEqual({ distance: 20, stepsSinceBattle: 4 })
  })

  it('入力の state を書き換えない', () => {
    const state = Object.freeze({ distance: 10, stepsSinceBattle: 0 })
    const r = advanceEncounter(state, 200, step, always, masters, () => 0)
    expect(state).toEqual({ distance: 10, stepsSinceBattle: 0 })
    expect(r.state).not.toBe(state)
  })

  it('当選時の敵は hp=maxHp で、`+` 連結の順に並ぶ', () => {
    const r = advanceEncounter(
      ready,
      80,
      step,
      { rate: 1, groups: ['slime+ghost'] },
      masters,
      () => 0
    )
    expect(r.enemies).toHaveLength(2)
    expect(r.enemies![0]).toMatchObject({
      id: 'slime',
      name: 'スライム',
      hp: 10,
      maxHp: 10,
      mp: 2,
      maxMp: 2,
      atk: 3,
      def: 1,
      agi: 2,
      exp: 2,
      gold: 1,
      sprite: 'slime.png',
    })
    expect(r.enemies![1]).toMatchObject({ id: 'ghost', hp: 14, maxHp: 14 })
  })

  it('rng の消費順序が既存の rollEncounter と同じ', () => {
    const groups = ['slime', 'ghost']
    const seq = [0.0, 0.99]
    const expectedRng = seqRng(seq)
    const expected = rollEncounter({ rate: 1, groups, masters, rng: expectedRng })
    const actualRng = seqRng(seq)
    const r = advanceEncounter(ready, 80, step, { rate: 1, groups }, masters, actualRng)
    expect(actualRng).toHaveBeenCalledTimes(expectedRng.mock.calls.length)
    expect(r.enemies).toEqual(expected)
    expect(r.enemies![0].id).toBe('ghost')
  })

  it('未知のモンスター id だけのグループは外れ扱いで since が進む', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = advanceEncounter(ready, 80, step, { rate: 1, groups: ['nobody'] }, masters, () => 0)
      expect(r.enemies).toBeNull()
      expect(r.state).toEqual({ distance: 0, stepsSinceBattle: 4 })
    } finally {
      warn.mockRestore()
    }
  })

  it('walked が NaN なら進めない（不変）', () => {
    const r = advanceEncounter(ready, NaN, step, always, masters, () => 0)
    expect(r.state).toBe(ready)
    expect(r.enemies).toBeNull()
  })

  it('walked が Infinity なら進めない（無限ループしない）', () => {
    const r = advanceEncounter(ready, Infinity, step, always, masters, () => 0)
    expect(r.state).toBe(ready)
    expect(r.enemies).toBeNull()
  })
})
