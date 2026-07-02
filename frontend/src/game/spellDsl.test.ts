import { describe, it, expect } from 'vitest'
import { parseEffect, applyEffect, type BattleEntity, type EffectContext } from './spellDsl'

function makeEntity(overrides: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'hero',
    name: 'ゆうしゃ',
    hp: 20,
    maxHp: 20,
    mp: 0,
    maxMp: 0,
    atk: 5,
    def: 3,
    agi: 4,
    ...overrides,
  }
}

function makeCtx(targets: BattleEntity[], rng: () => number = () => 0.5): EffectContext {
  return {
    caster: targets[0],
    targets,
    rng,
  }
}

describe('parseEffect', () => {
  it('heal の範囲を解釈する', () => {
    expect(parseEffect('heal 15..25')).toEqual({ kind: 'heal', min: 15, max: 25 })
  })

  it('heal の単一値も範囲として扱う', () => {
    expect(parseEffect('heal 30')).toEqual({ kind: 'heal', min: 30, max: 30 })
  })

  it('heal_full は範囲なし', () => {
    expect(parseEffect('heal_full')).toEqual({ kind: 'heal_full' })
  })

  it('damage に type 系統を含められる', () => {
    expect(parseEffect('damage 8..14 type=fire')).toEqual({
      kind: 'damage',
      min: 8,
      max: 14,
      type: 'fire',
    })
  })

  it('buff atk=+5 duration=3 をパースする', () => {
    expect(parseEffect('buff atk=+5 duration=3')).toEqual({
      kind: 'buff',
      stat: 'atk',
      delta: 5,
      duration: 3,
    })
  })

  it('debuff は delta を負に正規化する', () => {
    // debuff atk=5 → delta -5
    expect(parseEffect('debuff atk=5 duration=2')).toEqual({
      kind: 'debuff',
      stat: 'atk',
      delta: -5,
      duration: 2,
    })
  })

  it('revive は hp 指定が無ければ full', () => {
    expect(parseEffect('revive')).toEqual({ kind: 'revive', hp: 'full' })
    expect(parseEffect('revive hp=half')).toEqual({ kind: 'revive', hp: 'half' })
  })

  it('status は state 名と duration', () => {
    expect(parseEffect('status poison duration=3')).toEqual({
      kind: 'status',
      state: 'poison',
      duration: 3,
    })
  })

  it('escape_battle / escape_dungeon は単独動詞', () => {
    expect(parseEffect('escape_battle')).toEqual({ kind: 'escape_battle' })
    expect(parseEffect('escape_dungeon')).toEqual({ kind: 'escape_dungeon' })
  })

  it('範囲が逆順なら自動で min/max を入れ替える', () => {
    expect(parseEffect('heal 25..15')).toEqual({ kind: 'heal', min: 15, max: 25 })
  })

  it('不正な式は null', () => {
    expect(parseEffect('')).toBeNull()
    expect(parseEffect('foo bar')).toBeNull()
    expect(parseEffect('heal abc')).toBeNull()
    expect(parseEffect('buff')).toBeNull()
  })
})

describe('applyEffect', () => {
  it('heal は HP を増やすが maxHp を超えない', () => {
    const target = makeEntity({ hp: 5, maxHp: 20 })
    const ctx = makeCtx([target], () => 0.5) // mid → (15+25)/2 around 20
    applyEffect({ kind: 'heal', min: 10, max: 10 }, ctx)
    expect(target.hp).toBe(15)
  })

  it('heal_full は完全回復', () => {
    const target = makeEntity({ hp: 1, maxHp: 30 })
    applyEffect({ kind: 'heal_full' }, makeCtx([target]))
    expect(target.hp).toBe(30)
  })

  it('damage は HP を減らすが 0 未満にならない', () => {
    const target = makeEntity({ hp: 5 })
    applyEffect({ kind: 'damage', min: 100, max: 100 }, makeCtx([target]))
    expect(target.hp).toBe(0)
  })

  it('damage の type 耐性を反映する（半減）', () => {
    const target = makeEntity({ hp: 50, resist: { fire: 0.5 } })
    applyEffect({ kind: 'damage', min: 20, max: 20, type: 'fire' }, makeCtx([target]))
    expect(target.hp).toBe(50 - 10) // 20 * 0.5 = 10
  })

  it('damage の type 弱点（2.0）でダメージ倍', () => {
    const target = makeEntity({ hp: 50, resist: { ice: 2.0 } })
    applyEffect({ kind: 'damage', min: 10, max: 10, type: 'ice' }, makeCtx([target]))
    expect(target.hp).toBe(50 - 20)
  })

  // own-property ルックアップ修正の確認（#368）。effect.type が Object.prototype のプロパティ名
  // と一致しても resist に未登録扱いになり等倍 (1.0) になる（関数オブジェクトを乗数として
  // 使わない）。
  it('修正確認: type が "constructor" でも resist 未登録として等倍 (1.0) になる', () => {
    const target = makeEntity({ hp: 50, resist: { fire: 0.5 } })
    applyEffect({ kind: 'damage', min: 20, max: 20, type: 'constructor' }, makeCtx([target]))
    expect(target.hp).toBe(50 - 20) // 20 * 1.0 = 20（登録なし=等倍）
  })

  it.each(['toString', 'valueOf', '__proto__'])(
    '修正確認: type "%s" でも resist 未登録として等倍 (1.0) になる',
    (name) => {
      const target = makeEntity({ hp: 50, resist: { fire: 0.5 } })
      applyEffect({ kind: 'damage', min: 20, max: 20, type: name }, makeCtx([target]))
      expect(target.hp).toBe(50 - 20) // 20 * 1.0 = 20（登録なし=等倍）
    }
  )

  it('t.resist が undefined でも type 指定時に例外を投げず等倍 (1.0) になる', () => {
    const target = makeEntity({ hp: 50 }) // resist フィールド自体を持たない
    expect(() =>
      applyEffect({ kind: 'damage', min: 20, max: 20, type: 'fire' }, makeCtx([target]))
    ).not.toThrow()
    expect(target.hp).toBe(50 - 20) // 20 * 1.0 = 20（resist 未指定=等倍）
  })

  it('resist はあるが type キー自体が未登録なら等倍 (1.0)', () => {
    const target = makeEntity({ hp: 50, resist: { ice: 2.0 } })
    applyEffect({ kind: 'damage', min: 20, max: 20, type: 'fire' }, makeCtx([target]))
    expect(target.hp).toBe(50 - 20) // 20 * 1.0 = 20（fire は未登録=等倍）
  })

  it('own-key regression: resist に own の "constructor" キーが明示設定されていれば正しく乗算される', () => {
    const target = makeEntity({ hp: 50, resist: { constructor: 0.3 } })
    applyEffect({ kind: 'damage', min: 20, max: 20, type: 'constructor' }, makeCtx([target]))
    expect(target.hp).toBe(50 - 6) // 20 * 0.3 = 6
  })

  it('damage_full は即死', () => {
    const target = makeEntity({ hp: 999, maxHp: 999 })
    applyEffect({ kind: 'damage_full' }, makeCtx([target]))
    expect(target.hp).toBe(0)
  })

  it('buff は entity.buffs[stat] に累積する', () => {
    const target = makeEntity()
    applyEffect({ kind: 'buff', stat: 'atk', delta: 5, duration: 3 }, makeCtx([target]))
    expect(target.buffs?.atk).toBe(5)
    applyEffect({ kind: 'buff', stat: 'atk', delta: 3, duration: 1 }, makeCtx([target]))
    expect(target.buffs?.atk).toBe(8)
  })

  it('revive は hp 0 のみ蘇生し、生きている対象は無視', () => {
    const dead = makeEntity({ id: 'a', name: 'a', hp: 0, maxHp: 30 })
    const alive = makeEntity({ id: 'b', name: 'b', hp: 10, maxHp: 30 })
    applyEffect({ kind: 'revive', hp: 'half' }, makeCtx([dead, alive]))
    expect(dead.hp).toBe(15)
    expect(alive.hp).toBe(10)
  })

  it('status は entity.status[state] に duration をセット', () => {
    const target = makeEntity()
    applyEffect({ kind: 'status', state: 'poison', duration: 4 }, makeCtx([target]))
    expect(target.status?.poison).toBe(4)
  })

  // #370: state が "__proto__" だと、素朴な `t.status[state] = ...` は t.status 自身の
  // [[Prototype]] を書き換えてしまう（prototype pollution）。own-property として
  // 登録され、[[Prototype]] が汚染されないことを確認する。
  it('修正確認: state が "__proto__" でも t.status の [[Prototype]] を汚染せず own-property として登録される', () => {
    const target = makeEntity()
    applyEffect({ kind: 'status', state: '__proto__', duration: 4 }, makeCtx([target]))
    expect(target.status).toBeDefined()
    expect(Object.getPrototypeOf(target.status!)).toBe(Object.prototype)
    expect(target.status?.['__proto__']).toBe(4)
  })

  it('escape_battle はログだけ返してエンティティを変更しない', () => {
    const target = makeEntity({ hp: 10 })
    const log = applyEffect({ kind: 'escape_battle' }, makeCtx([target]))
    expect(target.hp).toBe(10)
    expect(log).toContain('にげだした！')
  })
})

describe('parse + apply 統合', () => {
  it('"heal 15..25" を rng=0 で min, rng=1-ε で max', () => {
    const target = makeEntity({ hp: 5 })
    const effect = parseEffect('heal 15..25')!
    applyEffect(
      effect,
      makeCtx([target], () => 0)
    ) // → 15
    expect(target.hp).toBe(20)
    target.hp = 5
    applyEffect(
      effect,
      makeCtx([target], () => 0.999)
    ) // → 25 ceiling
    expect(target.hp).toBe(20) // 25 healed but capped at maxHp 20
  })

  it('"damage 10..30 type=fire" を fire 耐性 0 でダメージなし', () => {
    const target = makeEntity({ hp: 50, resist: { fire: 0 } })
    const effect = parseEffect('damage 10..30 type=fire')!
    applyEffect(
      effect,
      makeCtx([target], () => 0.5)
    )
    expect(target.hp).toBe(50)
  })
})
