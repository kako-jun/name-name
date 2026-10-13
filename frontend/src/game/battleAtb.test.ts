import { describe, expect, it } from 'vitest'
import { normalizeAtbMode, normalizeBattleAtb } from './battleAtb'

describe('normalizeBattleAtb (#205)', () => {
  it('on 以外は undefined（従来ターン制）', () => {
    for (const v of [undefined, null, '', 'off', 'FOO', ' ']) {
      expect(normalizeBattleAtb(v, 'active')).toBeUndefined()
    }
  })
  it('on（大小・空白無視）で mode を返す。mode 未指定・未知値は wait', () => {
    expect(normalizeBattleAtb(' ON ', undefined)).toEqual({ mode: 'wait' })
    expect(normalizeBattleAtb('on', 'foo')).toEqual({ mode: 'wait' })
    expect(normalizeBattleAtb('on', 'Active')).toEqual({ mode: 'active' })
  })
  it('normalizeAtbMode', () => {
    expect(normalizeAtbMode(null)).toBe('wait')
    expect(normalizeAtbMode('active')).toBe('active')
  })
})
