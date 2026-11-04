import { describe, expect, it } from 'vitest'
import { buildBattleEngineOptions } from './battleOptions'
import { BattleEngine } from '../game/battleEngine'
import type { BattleEntity } from '../game/spellDsl'

const b = { layout: 'side' as const }

describe('buildBattleEngineOptions statuses (#1051 段階3)', () => {
  it('空・未指定なら statuses を渡さない', () => {
    expect(buildBattleEngineOptions(b)).not.toHaveProperty('statuses')
    expect(buildBattleEngineOptions(b, {})).not.toHaveProperty('statuses')
  })

  it('宣言があればそのまま渡す', () => {
    const statuses = { poison: { id: 'poison', name: 'どく', tickDamage: '1/16' } }
    expect(buildBattleEngineOptions(b, statuses).statuses).toBe(statuses)
  })
})

describe('statuses が BattleEngine に渡り、付与の効果で状態が付く (#1051)', () => {
  const ent = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
    id,
    name: id,
    hp: 100,
    maxHp: 100,
    mp: 9,
    maxMp: 9,
    atk: 1,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  })

  it('宣言した状態を「status <id>」の効果で敵に付けられる', () => {
    const statuses = { poison: { id: 'poison', name: 'poison', duration: '3', tickDamage: '1' } }
    const engine = new BattleEngine([ent('p1')], [ent('e1')], buildBattleEngineOptions(b, statuses))
    engine.selectSpell(
      { name: 's', mp: 1, target: '敵単体', effect: 'status poison' },
      engine.getState().enemies[0].id
    )
    expect(engine.getState().enemies[0].status).toHaveProperty('poison')
  })
})
