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

describe('normalizeAtbMode / normalizeBattleAtb の追加観点 (#205 QA)', () => {
  it("normalizeAtbMode: 'active' は大小・前後空白を無視して active、それ以外は wait", () => {
    for (const v of ['active', 'ACTIVE', ' Active ', '\tactive\n']) {
      expect(normalizeAtbMode(v)).toBe('active')
    }
    for (const v of [
      undefined,
      null,
      '',
      ' ',
      'wait',
      'WAIT',
      'activ',
      'actives',
      'inactive',
      'on',
      '1',
    ]) {
      expect(normalizeAtbMode(v)).toBe('wait')
    }
  })

  it('normalizeBattleAtb: on の完全一致のみ有効（部分一致・別語は無効）', () => {
    for (const v of ['o', 'onn', 'true', '1', 'yes', 'enabled', 'off', 'of']) {
      expect(normalizeBattleAtb(v, 'active')).toBeUndefined()
    }
  })

  it('normalizeBattleAtb: 戻り値は mode だけのオブジェクトで、呼ぶたび別のオブジェクト', () => {
    const a = normalizeBattleAtb('on', 'active')
    const b = normalizeBattleAtb('on', 'active')
    expect(a).toEqual({ mode: 'active' })
    expect(a).not.toBe(b)
  })
})
