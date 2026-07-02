import { describe, it, expect, vi } from 'vitest'
import { invokeBuiltinSpell, invokeBuiltinItem } from './builtin'
import type { BattleEntity, EffectContext } from './spellDsl'

function makeEntity(overrides: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'a',
    name: 'スライム',
    hp: 10,
    maxHp: 10,
    mp: 0,
    maxMp: 0,
    atk: 3,
    def: 1,
    agi: 2,
    ...overrides,
  }
}

function makeCtx(targets: BattleEntity[], rngValue = 0): EffectContext {
  return {
    caster: targets[0],
    targets,
    rng: () => rngValue,
  }
}

describe('BUILTIN_SPELLS.zaraki', () => {
  it('rng < 0.5 で対象が即死する', () => {
    const a = makeEntity()
    invokeBuiltinSpell('zaraki', makeCtx([a], 0.0))
    expect(a.hp).toBe(0)
  })

  it('rng >= 0.5 だと無効', () => {
    const a = makeEntity({ hp: 10 })
    invokeBuiltinSpell('zaraki', makeCtx([a], 0.99))
    expect(a.hp).toBe(10)
  })

  it('death 耐性 0 の対象には効かない', () => {
    const a = makeEntity({ hp: 10, resist: { death: 0 } })
    invokeBuiltinSpell('zaraki', makeCtx([a], 0.0))
    expect(a.hp).toBe(10)
  })

  it('複数対象に独立判定する', () => {
    const a = makeEntity({ id: 'a', hp: 10 })
    const b = makeEntity({ id: 'b', hp: 10 })
    let i = 0
    const rngs = [0.0, 0.99]
    invokeBuiltinSpell('zaraki', {
      caster: a,
      targets: [a, b],
      rng: () => rngs[i++ % rngs.length],
    })
    expect(a.hp).toBe(0) // first roll 0.0 → death
    expect(b.hp).toBe(10) // second roll 0.99 → safe
  })
})

describe('BUILTIN_SPELLS.zaorik', () => {
  it('hp 0 の対象を 1 体だけ蘇生する', () => {
    const a = makeEntity({ id: 'a', hp: 0, maxHp: 30, status: { poison: 3 } })
    const b = makeEntity({ id: 'b', hp: 0, maxHp: 30 })
    invokeBuiltinSpell('zaorik', makeCtx([a, b]))
    expect(a.hp).toBe(30)
    expect(a.status).toEqual({}) // 状態異常クリア
    expect(b.hp).toBe(0) // 1 体だけ
  })

  it('生きている対象しかいないときはログだけ', () => {
    const a = makeEntity({ hp: 10 })
    const log = invokeBuiltinSpell('zaorik', makeCtx([a]))
    expect(a.hp).toBe(10)
    expect(log).toContain('しかし 何も おこらなかった。')
  })
})

describe('BUILTIN_SPELLS.ruula (戦闘内呼び出し)', () => {
  it('戦闘中に詠唱されたら no-op で「ここでは つかえない！」', () => {
    const a = makeEntity()
    const log = invokeBuiltinSpell('ruula', makeCtx([a]))
    expect(log[0]).toBe('ここでは つかえない！')
    expect(a.hp).toBe(10)
  })
})

describe('BUILTIN_ITEMS.world_tree_drop', () => {
  it('全員を完全回復し、死亡者は蘇生する', () => {
    const a = makeEntity({ id: 'a', name: 'ゆうしゃ', hp: 0, maxHp: 30 })
    const b = makeEntity({ id: 'b', name: 'せんし', hp: 5, maxHp: 30 })
    const log = invokeBuiltinItem('world_tree_drop', makeCtx([a, b]))
    expect(a.hp).toBe(30)
    expect(b.hp).toBe(30)
    expect(log).toContain('ゆうしゃ は 生き返った！')
    expect(log).toContain('せんし の HP が 全回復した！')
  })
})

describe('未登録の builtin', () => {
  it('warning を出して識別ログを返す', () => {
    const a = makeEntity()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = invokeBuiltinSpell('foobar', makeCtx([a]))
    expect(warn).toHaveBeenCalled()
    expect(log[0]).toContain('foobar')
    warn.mockRestore()
  })

  // own-property ルックアップ修正の確認（#368）。builtinId が Object.prototype のプロパティ名
  // と一致しても未登録扱いになる（関数オブジェクトを呼び出さない）。
  it('修正確認: builtinId が "constructor" でも未登録扱いになる（呪文）', () => {
    const a = makeEntity()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = invokeBuiltinSpell('constructor', makeCtx([a]))
    expect(warn).toHaveBeenCalled()
    expect(log[0]).toContain('constructor')
    warn.mockRestore()
  })

  it('修正確認: builtinId が "constructor" でも未登録扱いになる（アイテム）', () => {
    const a = makeEntity()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = invokeBuiltinItem('constructor', makeCtx([a]))
    expect(warn).toHaveBeenCalled()
    expect(log[0]).toContain('constructor')
    warn.mockRestore()
  })
})
