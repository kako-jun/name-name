/** 効果 DSL `steal` (#831) の解釈 */
import { describe, expect, it, vi } from 'vitest'
import { applyEffect, parseEffect, type BattleEntity, type EffectContext } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return { id, name: id, hp: 50, maxHp: 50, mp: 0, maxMp: 0, atk: 5, def: 0, agi: 1, ...over }
}

describe('parseEffect steal', () => {
  it('引数なしは steal だけ（既定: 必中・両方の枠）', () => {
    expect(parseEffect('steal')).toEqual({ kind: 'steal' })
  })

  it('確率・レア率・枠・回数・ぶんどる・type', () => {
    expect(parseEffect('steal 確率=60 レア率=30 枠=レア 回数=2 ぶんどる=8..14 type=fire')).toEqual({
      kind: 'steal',
      chance: 60,
      rareRate: 30,
      slot: 'rare',
      count: 2,
      plunder: { min: 8, max: 14 },
      type: 'fire',
    })
    expect(parseEffect('steal 枠=通常')?.slot).toBe('normal')
    expect(parseEffect('steal 枠=両方')?.slot).toBe('both')
    expect(parseEffect('steal 確率=60.5')?.chance).toBe(60.5)
  })

  it('確率は 0〜100（status と違い 100 を書ける）。範囲外・不正は警告', () => {
    expect(parseEffect('steal 確率=100')?.chance).toBe(100)
    const over = parseEffect('steal 確率=150')
    expect(over?.chance).toBe(100)
    expect(over?.warnings?.[0]).toContain('100')
    const neg = parseEffect('steal 確率=-5')
    expect(neg?.chance).toBe(0)
    const bad = parseEffect('steal 確率=abc')
    expect(bad?.chance).toBeUndefined()
    expect(bad?.warnings?.[0]).toContain('確率')
  })

  it('不正な枠・ぶんどる・回数・未知の引数は警告して既定に落ちる', () => {
    expect(parseEffect('steal 枠=ふしぎ')?.warnings?.[0]).toContain('枠')
    expect(parseEffect('steal 枠=ふしぎ')?.slot).toBeUndefined()
    expect(parseEffect('steal ぶんどる=abc')?.plunder).toBeUndefined()
    expect(parseEffect('steal ぶんどる=abc')?.warnings?.[0]).toContain('ぶんどる')
    expect(parseEffect('steal 回数=0')?.count).toBeUndefined()
    expect(parseEffect('steal 回数=0')?.warnings?.[0]).toContain('回数')
    expect(parseEffect('steal こんな=1')?.warnings?.[0]).toContain('こんな=1')
  })

  it('ぶんどる 無しの type= と、確率= / レア率= の重複は console.warn を 1 度だけ出す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const a = parseEffect('steal type=fire')
      expect(a?.kind).toBe('steal')
      parseEffect('steal type=fire')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('type=fire')
      // ぶんどる があれば警告しない
      parseEffect('steal ぶんどる=3..5 type=ice')
      expect(warn).toHaveBeenCalledTimes(1)
      // 確率= の重複: 後の値が勝つ。警告は 1 度だけ
      expect(parseEffect('steal 確率=30 確率=70')?.chance).toBe(70)
      parseEffect('steal 確率=30 確率=70')
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn.mock.calls[1][0]).toContain('確率')
      expect(parseEffect('steal レア率=10 レア率=20')?.rareRate).toBe(20)
      expect(warn).toHaveBeenCalledTimes(3)
      // 重複のない普通の書き方は警告しない
      parseEffect('steal 確率=30 レア率=20')
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      warn.mockRestore()
    }
  })

  it('回数=・確率= は steal でも「他の動詞専用」の警告を出さない。heal には従来どおり出る', () => {
    expect(parseEffect('steal 回数=2 確率=50')?.warnings).toBeUndefined()
    expect(parseEffect('heal 5 確率=50')?.warnings?.[0]).toContain('status 専用')
  })
})

describe('applyEffect steal', () => {
  const effect = (s: string) => {
    const e = parseEffect(s)
    if (!e) throw new Error('parse')
    return e
  }

  it('ctx.steal が無い場面では警告だけで何も起きない', () => {
    const t = ent('t')
    const log = applyEffect(effect('steal'), { caster: ent('c'), targets: [t], rng: () => 0.5 })
    expect(log[0]).toContain('警告')
    expect(t.hp).toBe(50)
  })

  it('対象ごとに回数ぶん試み、empty が返ったらその対象は打ち切る', () => {
    const seen: string[] = []
    let n = 0
    const ctx: EffectContext = {
      caster: ent('c'),
      targets: [ent('a'), ent('b')],
      rng: () => 0.5,
      steal: (t, p) => {
        seen.push(`${t.id}:${JSON.stringify(p)}`)
        n++
        return { log: [`log${n}`], outcome: t.id === 'a' && n === 2 ? 'empty' : 'got' }
      },
    }
    const log = applyEffect(effect('steal 回数=3 確率=50 枠=レア レア率=20'), ctx)
    expect(seen).toEqual([
      'a:{"chance":50,"rareRate":20,"slot":"rare"}',
      'a:{"chance":50,"rareRate":20,"slot":"rare"}',
      'b:{"chance":50,"rareRate":20,"slot":"rare"}',
      'b:{"chance":50,"rareRate":20,"slot":"rare"}',
      'b:{"chance":50,"rareRate":20,"slot":"rare"}',
    ])
    expect(log).toHaveLength(5)
  })

  it('ぶんどる: 盗みのあとに damage と同じ評価器でダメージ（type つき）', () => {
    const t = ent('t', { resist: { fire: 2 } })
    const order: string[] = []
    const ctx: EffectContext = {
      caster: ent('c'),
      targets: [t],
      rng: () => 0,
      steal: () => {
        order.push('steal')
        return { log: ['盗んだ'], outcome: 'got' }
      },
      onAmount: () => order.push('damage'),
    }
    const log = applyEffect(effect('steal ぶんどる=10..10 type=fire'), ctx)
    expect(order).toEqual(['steal', 'damage'])
    expect(t.hp).toBe(30) // 10 × 弱点 2
    expect(log[0]).toBe('盗んだ')
    expect(log[1]).toContain('20 のダメージ')
  })
})
