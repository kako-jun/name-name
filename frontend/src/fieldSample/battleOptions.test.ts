import { describe, expect, it } from 'vitest'
import { buildBattleEngineOptions } from './battleOptions'

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
