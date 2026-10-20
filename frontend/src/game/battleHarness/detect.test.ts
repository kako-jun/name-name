/**
 * 検出器 (#877 段階 3) の単体テスト。わざと壊した状態を渡して検出できること、正常な状態で誤検出しないことを確かめる。
 * 上限の 9999 は定数を参照せずリテラルで固定する（定数を書き換えても通ってしまうテストにしない）。
 */
import { describe, expect, it } from 'vitest'
import { checkState, fingerprint, isBroken, type ViolationKind } from './detect'
import { entity } from './generate'
import type { BattleState } from '../battleEngine'
import { baseState, pushEvent } from './testing'

const OPTS = { maxDamage: 9999 }
const kinds = (s: ReturnType<typeof baseState>, ev = s.events): ViolationKind[] =>
  checkState(s, ev, 3, OPTS).map((v) => v.kind)

describe('checkState: 正常な状態は誤検出しない', () => {
  it('普通の戦闘中の状態・全員満タン・HP 0 の敵が 1 体でも違反なし', () => {
    const s = baseState(
      [entity('a'), entity('b', { hp: 1 })],
      [entity('s'), entity('t', { hp: 0 })]
    )
    pushEvent(s, [
      {
        target: { side: 'enemy', index: 0 },
        kind: 'damage',
        amount: 9999,
        hpBefore: 100,
        hpAfter: 0,
      },
    ])
    expect(kinds(s)).toEqual([])
  })

  it('勝利・敗北・逃走の終端状態は生存者と整合していれば違反なし', () => {
    expect(kinds(baseState([entity('a')], [entity('s', { hp: 0 })], 'victory'))).toEqual([])
    expect(kinds(baseState([entity('a', { hp: 0 })], [entity('s')], 'defeat'))).toEqual([])
    expect(kinds(baseState([entity('a')], [entity('s')], 'escaped'))).toEqual([])
  })
})

describe('checkState: 壊れた状態を検出する', () => {
  const one = (over: Parameters<typeof entity>[1]) => baseState([entity('a', over)], [entity('s')])

  it('NaN / Infinity', () => {
    expect(kinds(one({ hp: NaN }))).toContain('non-finite')
    expect(kinds(one({ atk: Infinity }))).toContain('non-finite')
    expect(kinds(one({ buffs: { atk: NaN } }))).toContain('non-finite')
    expect(kinds(one({ status: { poison: NaN } }))).toContain('non-finite')
  })

  it('負の HP・負の MP', () => {
    expect(kinds(one({ hp: -1 }))).toContain('negative-hp')
    expect(kinds(one({ mp: -3 }))).toContain('negative-mp')
  })

  it('maxHp / maxMp 超過', () => {
    expect(kinds(one({ hp: 101, maxHp: 100 }))).toContain('hp-over-max')
    expect(kinds(one({ mp: 1000, maxMp: 999 }))).toContain('mp-over-max')
    expect(kinds(one({ hp: 100, maxHp: 100 }))).not.toContain('hp-over-max')
  })

  it('MAX_SAFE_INTEGER 超の HP', () => {
    const big = Number.MAX_SAFE_INTEGER * 2
    expect(kinds(one({ hp: big, maxHp: big }))).toContain('unsafe-integer')
  })

  it('ダメージ上限違反は 10000 から（9999 は正常）', () => {
    const hit = (amount: number) => {
      const s = baseState([entity('a')], [entity('s')])
      pushEvent(s, [
        {
          target: { side: 'enemy', index: 0 },
          kind: 'damage',
          amount,
          hpBefore: 100000,
          hpAfter: 0,
        },
      ])
      return kinds(s)
    }
    expect(hit(9999)).not.toContain('damage-over-cap')
    expect(hit(10000)).toContain('damage-over-cap')
  })

  it('heal の量は上限違反にしない（吸収の回復表示は別問題として候補に回す）', () => {
    const s = baseState([entity('a')], [entity('s')])
    pushEvent(s, [
      {
        target: { side: 'enemy', index: 0 },
        kind: 'heal',
        amount: 99999,
        hpBefore: 1,
        hpAfter: 100,
      },
    ])
    expect(kinds(s)).toEqual([])
  })

  it('ヒットの向き違反: 負の量・damage で HP が増える・heal で HP が減る', () => {
    const t = { side: 'enemy', index: 0 } as const
    const neg = baseState([entity('a')], [entity('s')])
    pushEvent(neg, [{ target: t, kind: 'damage', amount: -7, hpBefore: 50, hpAfter: 57 }])
    expect(kinds(neg)).toContain('hit-direction')
    // 量だけ負で HP は変わらない（量の分岐だけで赤になる例）
    const onlyAmount = baseState([entity('a')], [entity('s')])
    pushEvent(onlyAmount, [{ target: t, kind: 'damage', amount: -7, hpBefore: 50, hpAfter: 50 }])
    expect(kinds(onlyAmount)).toContain('hit-direction')
    const up = baseState([entity('a')], [entity('s')])
    pushEvent(up, [{ target: t, kind: 'damage', amount: 5, hpBefore: 50, hpAfter: 60 }])
    expect(kinds(up)).toContain('hit-direction')
    const down = baseState([entity('a')], [entity('s')])
    pushEvent(down, [{ target: t, kind: 'heal', amount: 5, hpBefore: 50, hpAfter: 40 }])
    expect(kinds(down)).toContain('hit-direction')
  })

  it('ヒット量の unsafe-integer', () => {
    const s = baseState([entity('a')], [entity('s')])
    pushEvent(s, [
      {
        target: { side: 'enemy', index: 0 },
        kind: 'heal',
        amount: 2 ** 60,
        hpBefore: 1,
        hpAfter: 100,
      },
    ])
    expect(kinds(s)).toContain('unsafe-integer')
  })

  it('ATB なのに phase = enemy-turn', () => {
    const s = baseState([entity('a')], [entity('s')], 'enemy-turn')
    s.atb = { mode: 'active', partyGauge: [0], enemyGauge: [0], queue: [] }
    expect(checkState(s, [], 0, OPTS).some((v) => v.detail.includes('ATB なのに'))).toBe(true)
  })

  it('イベントの NaN', () => {
    const s = baseState([entity('a')], [entity('s')])
    pushEvent(s, [
      { target: { side: 'enemy', index: 0 }, kind: 'damage', amount: NaN, hpBefore: 1, hpAfter: 0 },
    ])
    expect(kinds(s)).toContain('non-finite')
  })

  it('ログの NaN / Infinity / undefined', () => {
    for (const bad of ['S に NaN の ダメージ！', 'Infinity 回復した！', 'undefined は たおれた']) {
      const s = baseState([entity('a')], [entity('s')])
      s.log.push(bad)
      expect(kinds(s)).toContain('bad-log-text')
    }
  })

  it('勝敗と生存者の食い違い（進行不能を含む）', () => {
    expect(kinds(baseState([entity('a', { hp: 0 })], [entity('s')]))).toContain('phase-mismatch')
    expect(kinds(baseState([entity('a')], [entity('s', { hp: 0 })]))).toContain('phase-mismatch')
    expect(kinds(baseState([entity('a')], [entity('s')], 'victory'))).toContain('phase-mismatch')
    expect(kinds(baseState([entity('a')], [entity('s')], 'defeat'))).toContain('phase-mismatch')
  })

  describe('ATB の不変条件', () => {
    const atbState = (
      atb: { partyGauge: number[]; enemyGauge: number[]; queue: number[] },
      phase: BattleState['phase'] = 'atb-running'
    ) => {
      const s = baseState([entity('a'), entity('b', { hp: 0 })], [entity('s')], phase)
      s.atb = { mode: 'active', ...atb }
      return s
    }
    it('正常', () => {
      expect(kinds(atbState({ partyGauge: [10, 0], enemyGauge: [5], queue: [] }))).toEqual([])
      expect(
        kinds(atbState({ partyGauge: [1000, 0], enemyGauge: [5], queue: [0] }, 'party-input'))
      ).toEqual([])
    })
    it('ゲージ範囲外・NaN', () => {
      expect(kinds(atbState({ partyGauge: [1001, 0], enemyGauge: [5], queue: [] }))).toContain(
        'atb-invariant'
      )
      expect(kinds(atbState({ partyGauge: [-1, 0], enemyGauge: [5], queue: [] }))).toContain(
        'atb-invariant'
      )
      expect(kinds(atbState({ partyGauge: [NaN, 0], enemyGauge: [5], queue: [] }))).toContain(
        'non-finite'
      )
    })
    it('キューの重複・倒れた者・ゲージ未満タン・倒れた者のゲージ残り', () => {
      expect(
        kinds(atbState({ partyGauge: [1000, 0], enemyGauge: [5], queue: [0, 0] }, 'party-input'))
      ).toContain('atb-invariant')
      expect(
        kinds(atbState({ partyGauge: [1000, 1000], enemyGauge: [5], queue: [1] }, 'party-input'))
      ).toContain('atb-invariant')
      expect(
        kinds(atbState({ partyGauge: [999, 0], enemyGauge: [5], queue: [0] }, 'party-input'))
      ).toContain('atb-invariant')
      expect(kinds(atbState({ partyGauge: [0, 5], enemyGauge: [5], queue: [] }))).toContain(
        'atb-invariant'
      )
    })
    it('キューとフェーズの不整合', () => {
      expect(kinds(atbState({ partyGauge: [1000, 0], enemyGauge: [5], queue: [0] }))).toContain(
        'atb-invariant'
      )
      expect(
        kinds(atbState({ partyGauge: [0, 0], enemyGauge: [5], queue: [] }, 'party-input'))
      ).toContain('atb-invariant')
    })
  })

  it('違反の opIndex は渡した値が付く', () => {
    expect(checkState(one({ hp: -1 }), [], 7, OPTS)[0].opIndex).toBe(7)
  })
})

describe('fingerprint / isBroken', () => {
  it('HP・状態・ゲージが同じなら同じ指紋、変われば変わる', () => {
    const a = baseState([entity('a')], [entity('s')])
    const b = baseState([entity('a')], [entity('s')])
    expect(fingerprint(a)).toBe(fingerprint(b))
    b.enemies[0].hp = 99
    expect(fingerprint(a)).not.toBe(fingerprint(b))
    // ログだけ違う 2 状態の指紋は一致する（ログは指紋に入れない）
    const x = baseState([entity('a')], [entity('s')])
    const y = baseState([entity('a')], [entity('s')])
    y.log.push('違うログ')
    expect(fingerprint(x)).toBe(fingerprint(y))
  })

  it('stalemate だけは壊れに数えない', () => {
    expect(isBroken({ kind: 'stalemate', detail: '', opIndex: 0 })).toBe(false)
    expect(isBroken({ kind: 'lock', detail: '', opIndex: 0 })).toBe(true)
  })
})
