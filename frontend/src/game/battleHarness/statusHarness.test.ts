/**
 * 状態異常 (#870) のハーネス対象化のテスト: 宣言した状態の不変条件を検出器が拾うこと、
 * 状態を宣言した実エンジンの戦闘で誤検出しないこと、永久ロックを（壊れでなく）要判断として拾うこと。
 */
import { describe, expect, it } from 'vitest'
import { checkState, isBroken } from './detect'
import { entity, randomStatusScenarios, STATUS_SET, statusMatrix } from './generate'
import { runScenario } from './run'
import { runAll } from './sweep'
import { summarize } from './report'
import { baseState } from './testing'
import { scenarioOf } from './testing'

const OPTS = { maxDamage: 9999, statusIds: ['poison', 'sleep'] }
const kinds = (s: ReturnType<typeof baseState>, ev = s.events) =>
  checkState(s, ev, 0, OPTS).map((v) => v.kind)

describe('宣言した状態の不変条件', () => {
  const one = (over: Parameters<typeof entity>[1]) => baseState([entity('a', over)], [entity('s')])

  it('正常: 1〜99 の整数・0（切れた）・宣言の無い印はいくつでも', () => {
    expect(kinds(one({ status: { poison: 1, sleep: 99 } }))).toEqual([])
    expect(kinds(one({ status: { poison: 0 } }))).toEqual([])
    expect(kinds(one({ status: { marker: 12345 } }))).toEqual([])
  })

  it('上限超・小数・負は検出する（99 は正常・100 は違反）', () => {
    expect(kinds(one({ status: { poison: 100 } }))).toContain('status-invariant')
    expect(kinds(one({ status: { poison: 1.5 } }))).toContain('status-invariant')
    expect(kinds(one({ status: { poison: -1 } }))).toContain('status-invariant')
    expect(kinds(one({ status: { poison: 99 } }))).not.toContain('status-invariant')
  })

  it('倒れているのに状態が残っていれば検出する（0 は残りではない）', () => {
    expect(kinds(one({ hp: 0, status: { poison: 2 } }))).toContain('status-invariant')
    expect(kinds(one({ hp: 0, status: { poison: 0 } }))).not.toContain('status-invariant')
    expect(kinds(one({ hp: 0, status: { marker: 3 } }))).not.toContain('status-invariant')
  })

  it('statusIds を渡さなければ（宣言の無いシナリオ）何も検査しない', () => {
    const s = one({ status: { poison: 1000 } })
    expect(checkState(s, [], 0, { maxDamage: 9999 }).map((v) => v.kind)).toEqual([])
  })

  it('status イベントは本人だけを対象にしたヒットが 1 件以上あること', () => {
    const s = baseState([entity('a'), entity('b')], [entity('s')])
    const ev = (target: { side: 'party' | 'enemy'; index: number }) => ({
      seq: 0,
      actor: { side: 'party' as const, index: 0 },
      kind: 'status' as const,
      label: 'どく',
      hits: [{ target, kind: 'damage' as const, amount: 5, hpBefore: 100, hpAfter: 95 }],
    })
    expect(kinds(s, [ev({ side: 'party', index: 0 })])).toEqual([])
    expect(kinds(s, [ev({ side: 'party', index: 1 })])).toContain('status-invariant')
    expect(kinds(s, [{ ...ev({ side: 'party', index: 0 }), hits: [] }])).toContain(
      'status-invariant'
    )
    expect(isBroken({ kind: 'status-invariant', detail: '', opIndex: 0 })).toBe(true)
  })
})

describe('生成', () => {
  it('総当たりの件数が直積どおり。id は一意で、JSON にそのまま書き出せる', () => {
    const m = statusMatrix()
    expect(m).toHaveLength(3 * Object.keys(STATUS_SET).length * 4 * 3 * 5)
    const r = randomStatusScenarios(1, 100)
    expect(new Set([...m, ...r].map((s) => s.id)).size).toBe(m.length + r.length)
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
    expect(randomStatusScenarios(1, 100)).toEqual(r)
    expect(randomStatusScenarios(2, 100)).not.toEqual(r)
    for (const s of [...m.slice(0, 5), ...r.slice(0, 5)]) {
      expect(Object.keys(s.statuses ?? {})).toEqual(Object.keys(STATUS_SET))
    }
  })

  it(
    '不正な値だらけの宣言（weird）も、警告して既定に落ちるだけで壊れない',
    { timeout: 30_000 },
    () => {
      const weird = statusMatrix().filter((s) => s.id.includes('/weird'))
      expect(weird.length).toBeGreaterThan(0)
      const results = runAll(weird.slice(0, 30))
      expect(results.filter((r) => r.violations.some(isBroken))).toEqual([])
    }
  )
})

describe('実エンジンで走らせる（通常実行を重くしない件数）', () => {
  it('状態を宣言したランダム合成・総当たりの一部は壊れない', { timeout: 30_000 }, () => {
    const sample = [
      ...randomStatusScenarios(1, 60),
      ...statusMatrix().filter((_, i) => i % 80 === 0),
    ]
    const results = runAll(sample)
    const sum = summarize(results)
    expect(sum.total).toBe(sample.length)
    expect(sum.broken).toBe(0)
  })

  it('同じ入力なら同じ結果になる', () => {
    const s = randomStatusScenarios(3, 20)
    expect(runAll(s)).toEqual(runAll(s))
  })

  it('永久の行動不能（毎ターン睡眠を付け直す敵）は、壊れではなく膠着（要判断）として拾う', () => {
    const lock = scenarioOf({
      id: 'status/perma-sleep',
      party: [entity('a', { hp: 1_000_000, maxHp: 1_000_000, status: { coma: 99 } })],
      enemies: [
        entity('s', { hp: 400, maxHp: 400, atk: 0, actions: ['候補=sk'], mp: 0, maxMp: 0 }),
      ],
      statuses: { coma: STATUS_SET.coma },
      skills: { sk: { name: 'ララバイ', target: '相手全体', effect: 'status coma duration=99' } },
      ops: [],
    })
    const r = runScenario(lock)
    expect(r.violations.map((v) => v.kind)).toContain('stalemate')
    expect(r.violations.some(isBroken)).toBe(false)
  })
})
