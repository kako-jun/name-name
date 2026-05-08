import { describe, it, expect } from 'vitest'
import { normalizePosition } from './CharacterLayer'

describe('normalizePosition', () => {
  it('日本語の position を英語 key に正規化する', () => {
    expect(normalizePosition('左')).toBe('left')
    expect(normalizePosition('中央')).toBe('center')
    expect(normalizePosition('右')).toBe('right')
  })

  it('「真ん中」「中」も中央扱いにする', () => {
    expect(normalizePosition('真ん中')).toBe('center')
    expect(normalizePosition('中')).toBe('center')
  })

  it('英語表記はそのまま通す', () => {
    expect(normalizePosition('left')).toBe('left')
    expect(normalizePosition('center')).toBe('center')
    expect(normalizePosition('right')).toBe('right')
  })

  it('英語の大文字違いを正規化する', () => {
    expect(normalizePosition('Left')).toBe('left')
    expect(normalizePosition('Center')).toBe('center')
    expect(normalizePosition('Centre')).toBe('center')
    expect(normalizePosition('Right')).toBe('right')
  })

  it('未知の値はそのまま返す (CharacterLayer 側で center にフォールバック)', () => {
    expect(normalizePosition('foo')).toBe('foo')
  })

  it('空文字は center に倒す', () => {
    expect(normalizePosition('')).toBe('center')
  })

  it('日本語の揺れ (左寄り / 左端 / 真中 / まんなか / 右寄り / 右端) を吸収する', () => {
    expect(normalizePosition('左寄り')).toBe('left')
    expect(normalizePosition('左端')).toBe('left')
    expect(normalizePosition('真中')).toBe('center')
    expect(normalizePosition('まんなか')).toBe('center')
    expect(normalizePosition('右寄り')).toBe('right')
    expect(normalizePosition('右端')).toBe('right')
  })
})
