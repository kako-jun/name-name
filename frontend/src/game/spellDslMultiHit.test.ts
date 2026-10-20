/** 効果 DSL の複数ヒット `回数=N` (#879) */
import { describe, it, expect, vi } from 'vitest'
import {
  parseEffect,
  applyEffect,
  MAX_HITS_PER_ACTION,
  type BattleEntity,
  type EffectContext,
} from './spellDsl'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 1,
    def: 1,
    agi: 1,
    ...over,
  }
}

/** 呼ばれた回数と値を数える rng（値列を巡回） */
function seqRng(values: number[]) {
  let i = 0
  const calls: number[] = []
  const fn = () => {
    const v = values[i % values.length]
    i++
    calls.push(v)
    return v
  }
  return { fn, calls }
}

describe('parseEffect 回数=', () => {
  it('回数=5 を解釈する', () => {
    expect(parseEffect('damage 4..7 回数=5')).toEqual({ kind: 'damage', min: 4, max: 7, count: 5 })
  })
  it('type と併用できる（順不同）', () => {
    expect(parseEffect('damage 4..7 回数=3 type=fire')).toEqual({
      kind: 'damage',
      min: 4,
      max: 7,
      type: 'fire',
      count: 3,
    })
  })
  it('未指定・回数=1 は count を持たない（従来と同じ）', () => {
    expect(parseEffect('damage 4..7')).toEqual({ kind: 'damage', min: 4, max: 7 })
    expect(parseEffect('damage 4..7 回数=1')).toEqual({ kind: 'damage', min: 4, max: 7 })
  })
  it.each(['0', '-2', '2.5', 'abc', '', '2..4', '１'])('不正値 回数=%s は 1 回にして警告', (v) => {
    const p = parseEffect(`damage 4..7 回数=${v}`)
    expect(p?.count).toBeUndefined()
    expect(p?.warnings).toHaveLength(1)
    expect(p?.warnings?.[0]).toContain('回数=')
  })
  it('巨大な値は上限に切り詰めて警告', () => {
    const p = parseEffect('damage 1..1 回数=99999999999999999999')
    expect(p?.count).toBe(MAX_HITS_PER_ACTION)
    expect(p?.warnings?.[0]).toContain('上限')
    expect(parseEffect(`damage 1..1 回数=${MAX_HITS_PER_ACTION}`)?.warnings).toBeUndefined()
    expect(parseEffect(`damage 1..1 回数=${MAX_HITS_PER_ACTION + 1}`)?.count).toBe(
      MAX_HITS_PER_ACTION
    )
  })
  it.each([
    'heal 5..9 回数=3',
    'damage_full 回数=3',
    'revive 回数=2',
    'buff atk=+1 回数=2',
    'status poison 回数=2',
  ])('damage 以外に付けたら無視して警告: %s', (src) => {
    const p = parseEffect(src)
    expect(p).not.toBeNull()
    expect(p?.count).toBeUndefined()
    expect(p?.warnings).toEqual(['回数= は damage 専用のため無視した'])
  })
  it('damage_full に回数以外の余計な語は従来どおり不正', () => {
    expect(parseEffect('damage_full foo')).toBeNull()
  })
})

describe('applyEffect 複数ヒット', () => {
  function run(
    effect: string,
    ctxOver: Partial<EffectContext> & { targets: BattleEntity[] },
    rngVals = [0]
  ) {
    const r = seqRng(rngVals)
    const hits: Array<[string, string, number, number]> = []
    const ctx: EffectContext = {
      caster: ent({ id: 'c' }),
      rng: r.fn,
      onHit: (t, k, a, round) => hits.push([t.id, k, a, round]),
      ...ctxOver,
    }
    const log = applyEffect(parseEffect(effect)!, ctx)
    return { log, hits, rng: r.calls }
  }

  it('単体: 回数ぶんダメージを振り直す（rng はヒットごとに 1 回）', () => {
    const t = ent({ id: 'a' })
    const { log, hits, rng } = run('damage 1..10 回数=3', { targets: [t] }, [0, 0.5, 0.99])
    expect(rng).toHaveLength(3)
    expect(hits).toEqual([
      ['a', 'damage', 1, 0],
      ['a', 'damage', 6, 1],
      ['a', 'damage', 10, 2],
    ])
    expect(t.hp).toBe(100 - 17)
    expect(log).toEqual(['E に 1 のダメージ！', 'E に 6 のダメージ！', 'E に 10 のダメージ！'])
  })

  it('回数=2 / 5 の合計と HP', () => {
    const t = ent({ id: 'a' })
    run('damage 4..4 回数=2', { targets: [t] })
    expect(t.hp).toBe(92)
    const u = ent({ id: 'b' })
    const { hits } = run('damage 4..4 回数=5', { targets: [u] })
    expect(hits).toHaveLength(5)
    expect(u.hp).toBe(80)
  })

  it('固定値（min==max）は rng を使わない', () => {
    const { rng } = run('damage 3 回数=4', { targets: [ent()] })
    expect(rng).toHaveLength(0)
  })

  it('途中で標的が倒れたら pool の次の生存者へ（rng は使わない）', () => {
    const a = ent({ id: 'a', hp: 10, maxHp: 10 })
    const b = ent({ id: 'b' })
    const c = ent({ id: 'c2' })
    const { hits, log } = run('damage 6 回数=4', { targets: [a], pool: [a, b, c] })
    expect(hits.map((h) => [h[0], h[3]])).toEqual([
      ['a', 0],
      ['a', 1],
      ['b', 2],
      ['b', 3],
    ])
    expect(a.hp).toBe(0)
    expect(b.hp).toBe(88)
    expect(c.hp).toBe(100)
    expect(log.filter((l) => l.includes('たおれた'))).toHaveLength(1)
  })

  it('pool が無ければ乗り換えず、倒れたら打ち切り', () => {
    const a = ent({ id: 'a', hp: 5, maxHp: 5 })
    const { hits } = run('damage 6 回数=4', { targets: [a] })
    expect(hits).toHaveLength(1)
  })

  it('全滅で打ち切り（以降の rng は消費しない）', () => {
    const a = ent({ id: 'a', hp: 5, maxHp: 5 })
    const b = ent({ id: 'b', hp: 5, maxHp: 5 })
    const { hits, rng } = run('damage 5..9 回数=10', { targets: [a], pool: [a, b] }, [0])
    expect(hits).toHaveLength(2)
    expect(rng).toHaveLength(2)
  })

  it('全体: N 巡して毎巡その時点の生存者全員（倒れた者は除外、巡ごとに 1 回抽選）', () => {
    const a = ent({ id: 'a', hp: 10, maxHp: 10 })
    const b = ent({ id: 'b' })
    const { hits, rng } = run('damage 6..6 回数=3', { targets: [a, b], pool: [a, b] })
    expect(hits).toEqual([
      ['a', 'damage', 6, 0],
      ['b', 'damage', 6, 0],
      ['a', 'damage', 6, 1],
      ['b', 'damage', 6, 1],
      ['b', 'damage', 6, 2],
    ])
    expect(a.hp).toBe(0)
    expect(b.hp).toBe(82)
    expect(rng).toHaveLength(0)
    const r2 = run('damage 1..9 回数=3', { targets: [ent({ id: 'a' }), ent({ id: 'b' })] }, [0.5])
    expect(r2.rng).toHaveLength(3)
  })

  it('全体が全滅したら巡を打ち切る', () => {
    const a = ent({ id: 'a', hp: 3, maxHp: 3 })
    const b = ent({ id: 'b', hp: 3, maxHp: 3 })
    const { hits } = run('damage 5 回数=9', { targets: [a, b] })
    expect(hits).toHaveLength(2)
  })

  it('弱点・半減はヒットごと対象ごとに掛かる', () => {
    const a = ent({ id: 'a', affinity: { weak: ['fire'], halve: [], nullify: [], absorb: [] } })
    const b = ent({ id: 'b', affinity: { weak: [], halve: ['fire'], nullify: [], absorb: [] } })
    const { hits } = run('damage 10 type=fire 回数=2', { targets: [a, b] })
    expect(hits).toEqual([
      ['a', 'damage', 20, 0],
      ['b', 'damage', 5, 0],
      ['a', 'damage', 20, 1],
      ['b', 'damage', 5, 1],
    ])
  })

  it('吸収はそのヒットだけ heal、無効は miss', () => {
    const a = ent({
      id: 'a',
      hp: 50,
      affinity: { weak: [], halve: [], nullify: [], absorb: ['fire'] },
    })
    const n = ent({ id: 'n', affinity: { weak: [], halve: [], nullify: ['fire'], absorb: [] } })
    const w = ent({ id: 'w' })
    const { hits } = run('damage 10 type=fire 回数=2', { targets: [a, n, w] })
    expect(hits.filter((h) => h[0] === 'a').map((h) => h[1])).toEqual(['heal', 'heal'])
    expect(a.hp).toBe(70)
    expect(hits.filter((h) => h[0] === 'n').map((h) => h[1])).toEqual(['miss', 'miss'])
    expect(n.hp).toBe(100)
    expect(w.hp).toBe(80)
  })

  it('耐性 0（resist）は miss', () => {
    const t = ent({ id: 'a', resist: { fire: 0 } })
    const { hits } = run('damage 10 type=fire 回数=2', { targets: [t] })
    expect(hits.map((h) => h[1])).toEqual(['miss', 'miss'])
  })

  it('同じ rng 列で再現する', () => {
    const go = () => {
      const t = ent({ id: 'a' })
      return run('damage 1..20 回数=6', { targets: [t] }, [0.1, 0.7, 0.3, 0.9, 0.5, 0.2]).hits
    }
    expect(go()).toEqual(go())
  })

  it('警告はログ先頭に (警告: …) で出る。console は汚さない', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = applyEffect(parseEffect('damage 3 回数=0')!, {
      caster: ent(),
      targets: [ent()],
      rng: () => 0,
    })
    expect(log[0]).toMatch(/^\(警告: 回数=0/)
    expect(log).toHaveLength(2)
    applyEffect(parseEffect('damage 3 回数=999')!, {
      caster: ent(),
      targets: [ent()],
      rng: () => 0,
    })
    expect(spy).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
    spy.mockRestore()
    err.mockRestore()
  })

  it('回数未指定・1 は onHit を呼ばず rng 消費もログも従来どおり', () => {
    for (const src of ['damage 4..7', 'damage 4..7 回数=1']) {
      const a = ent({ id: 'a' })
      const b = ent({ id: 'b' })
      const r = seqRng([0.5])
      const onHit = vi.fn()
      const log = applyEffect(parseEffect(src)!, {
        caster: ent(),
        targets: [a, b],
        rng: r.fn,
        onHit,
      })
      expect(onHit).not.toHaveBeenCalled()
      expect(r.calls).toHaveLength(1)
      expect(log).toEqual(['E に 6 のダメージ！', 'E に 6 のダメージ！'])
    }
  })
})
