/** 所持金の効果（効果 DSL `gold` / `gold_all`、#881 段階4）の解釈と純関数 */
import { describe, expect, it } from 'vitest'
import { applyGoldChange, MAX_GOLD, type GoldChange } from './goldEffect'
import { applyEffect, parseEffect, type BattleEntity, type EffectContext } from './spellDsl'

function ent(id: string): BattleEntity {
  return { id, name: id, hp: 50, maxHp: 50, mp: 0, maxMp: 0, atk: 5, def: 0, agi: 1 }
}

describe('applyGoldChange', () => {
  it('増やす', () => {
    expect(applyGoldChange(100, { mode: 'add', amount: 50 })).toEqual({ gold: 150, delta: 50 })
  })
  it('減らす: ちょうど・不足・0', () => {
    expect(applyGoldChange(100, { mode: 'add', amount: -100 })).toEqual({ gold: 0, delta: -100 })
    expect(applyGoldChange(100, { mode: 'add', amount: -150 })).toEqual({ gold: 0, delta: -100 })
    expect(applyGoldChange(0, { mode: 'add', amount: -10 })).toEqual({ gold: 0, delta: 0 })
    expect(applyGoldChange(0, { mode: 'add', amount: 0 })).toEqual({ gold: 0, delta: 0 })
  })
  it('全額消費', () => {
    expect(applyGoldChange(1234, { mode: 'all' })).toEqual({ gold: 0, delta: -1234 })
    expect(applyGoldChange(0, { mode: 'all' })).toEqual({ gold: 0, delta: 0 })
  })
  it('巨大値は MAX_GOLD で頭打ち（精度を失わない）', () => {
    expect(applyGoldChange(MAX_GOLD - 1, { mode: 'add', amount: 10 })).toEqual({
      gold: MAX_GOLD,
      delta: 1,
    })
    expect(applyGoldChange(MAX_GOLD, { mode: 'add', amount: MAX_GOLD })).toEqual({
      gold: MAX_GOLD,
      delta: 0,
    })
    expect(applyGoldChange(5, { mode: 'add', amount: Infinity })).toEqual({ gold: 5, delta: 0 })
  })
  it('壊れた入力（負・NaN・Infinity・小数）は安全に扱う', () => {
    expect(applyGoldChange(-5, { mode: 'add', amount: 3 })).toEqual({ gold: 3, delta: 3 })
    expect(applyGoldChange(NaN, { mode: 'add', amount: 3 })).toEqual({ gold: 3, delta: 3 })
    expect(applyGoldChange(Infinity, { mode: 'all' })).toEqual({ gold: 0, delta: 0 })
    expect(applyGoldChange(10, { mode: 'add', amount: NaN })).toEqual({ gold: 10, delta: 0 })
    expect(applyGoldChange(10.9, { mode: 'add', amount: 2.7 })).toEqual({ gold: 12, delta: 2 })
  })
  it('入力の変更オブジェクトを変えない', () => {
    const c: GoldChange = { mode: 'add', amount: -5 }
    const snap = JSON.stringify(c)
    applyGoldChange(100, c)
    expect(JSON.stringify(c)).toBe(snap)
  })
})

describe('parseEffect gold', () => {
  it('+N / -N / gold_all', () => {
    expect(parseEffect('gold +100')).toEqual({
      kind: 'gold',
      goldChange: { mode: 'add', amount: 100 },
    })
    expect(parseEffect('gold -50')).toEqual({
      kind: 'gold',
      goldChange: { mode: 'add', amount: -50 },
    })
    expect(parseEffect('gold_all')).toEqual({ kind: 'gold', goldChange: { mode: 'all' } })
  })
  it('不正な式は null', () => {
    for (const s of [
      'gold',
      'gold 100',
      'gold +',
      'gold +1.5',
      'gold +abc',
      'gold +NaN',
      'gold +Infinity',
      'gold =0',
      'gold +1 +2',
      'gold +9007199254740993',
      'gold_all 5',
    ]) {
      expect(parseEffect(s), s).toBeNull()
    }
  })
  it('既存の式は変わらない', () => {
    expect(parseEffect('heal 15..25')).toEqual({ kind: 'heal', min: 15, max: 25 })
    expect(parseEffect('level +1')?.kind).toBe('level')
  })
})

describe('applyEffect gold', () => {
  function run(effectStr: string, start: number | null) {
    let gold = start ?? 0
    const calls: GoldChange[] = []
    const ctx: EffectContext = {
      caster: ent('a'),
      targets: [ent('t1'), ent('t2')],
      rng: () => 0,
      ...(start === null
        ? {}
        : {
            gold: (c: GoldChange) => {
              calls.push(c)
              const r = applyGoldChange(gold, c)
              gold = r.gold
              return { delta: r.delta }
            },
          }),
    }
    const log = applyEffect(parseEffect(effectStr)!, ctx)
    return { log, gold, calls, ctx }
  }
  it('増やす: 対象が複数でも 1 回だけ適用', () => {
    const r = run('gold +100', 20)
    expect(r.gold).toBe(120)
    expect(r.calls).toHaveLength(1)
    expect(r.log).toEqual(['100 円を てにいれた！'])
  })
  it('減らす: 不足時は実際に減った額を出し、0 で止まる', () => {
    expect(run('gold -30', 100)).toMatchObject({ gold: 70, log: ['30 円を うしなった！'] })
    expect(run('gold -30', 10)).toMatchObject({ gold: 0, log: ['10 円を うしなった！'] })
    expect(run('gold -30', 0)).toMatchObject({ gold: 0, log: ['しかし おかねが なかった！'] })
  })
  it('全額消費', () => {
    expect(run('gold_all', 500)).toMatchObject({ gold: 0, log: ['おかねを ぜんぶ つかった！'] })
    expect(run('gold_all', 0)).toMatchObject({ gold: 0, log: ['しかし おかねが なかった！'] })
  })
  it('頭打ちで増えないとき', () => {
    expect(run(`gold +5`, MAX_GOLD).log).toEqual(['しかし おかねは ふえなかった！'])
  })
  it('所持金の口が無い場面では警告だけで何も起きない', () => {
    const r = run('gold -30', null)
    expect(r.log).toEqual(['(警告: 所持金はこの場面では使えない)'])
  })
  it('戦闘の対象・使い手を変えない', () => {
    const r = run('gold -30', 100)
    expect(r.ctx.targets.every((t) => t.hp === 50 && t.mp === 0)).toBe(true)
    expect(r.ctx.caster.hp).toBe(50)
  })
})
