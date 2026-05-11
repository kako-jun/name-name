/**
 * npcDialog ヘルパーのユニットテスト (#101 Phase 2)。
 */
import { describe, it, expect } from 'vitest'
import { resolveNpcPortrait, stripExpressionDirectives } from './npcDialog'
import type { UiNpcData } from '../types/rpg'

function makeNpc(overrides: Partial<UiNpcData> = {}): UiNpcData {
  return {
    id: 'elder',
    name: '長老',
    x: 5,
    y: 3,
    message: 'こんにちは',
    color: 0xff0000,
    ...overrides,
  }
}

describe('resolveNpcPortrait', () => {
  it('expressions も portrait も未指定なら undefined', () => {
    expect(resolveNpcPortrait(makeNpc())).toBeUndefined()
  })

  it('portrait のみ指定 → portrait を返す', () => {
    const npc = makeNpc({ portrait: 'elder.png' })
    expect(resolveNpcPortrait(npc)).toBe('elder.png')
  })

  it('expressions あり + message に [expression=sad] → 対応パスを返す', () => {
    const npc = makeNpc({
      portrait: 'elder_normal.png',
      expressions: { normal: 'elder_normal.png', sad: 'elder_sad.png' },
      message: '[expression=sad]\nかなしい',
    })
    expect(resolveNpcPortrait(npc)).toBe('elder_sad.png')
  })

  it('[expression=xxx] が expressions マップにないキーなら portrait にフォールバック', () => {
    const npc = makeNpc({
      portrait: 'elder.png',
      expressions: { normal: 'elder_normal.png' },
      message: '[expression=angry]\nおこった',
    })
    expect(resolveNpcPortrait(npc)).toBe('elder.png')
  })

  it('expressions が空 {} なら portrait にフォールバック', () => {
    const npc = makeNpc({
      portrait: 'elder.png',
      expressions: {},
      message: '[expression=sad]\n',
    })
    expect(resolveNpcPortrait(npc)).toBe('elder.png')
  })

  it('[expression=...] が message にない場合も portrait を返す', () => {
    const npc = makeNpc({
      portrait: 'elder.png',
      expressions: { sad: 'elder_sad.png' },
      message: 'こんにちは',
    })
    expect(resolveNpcPortrait(npc)).toBe('elder.png')
  })

  it('expressions も portrait も指定されている が message に [expression=...] なし → portrait', () => {
    const npc = makeNpc({
      portrait: 'normal.png',
      expressions: { sad: 'sad.png' },
      message: 'やあ',
    })
    expect(resolveNpcPortrait(npc)).toBe('normal.png')
  })
})

describe('stripExpressionDirectives', () => {
  it('[expression=sad] 行を除去する', () => {
    expect(stripExpressionDirectives('[expression=sad]\nかなしい')).toBe('かなしい')
  })

  it('複数の [expression=...] を全て除去する', () => {
    expect(
      stripExpressionDirectives('[expression=sad]\nかなしい\n[expression=angry]\nおこった')
    ).toBe('かなしい\nおこった')
  })

  it('[expression=...] がない場合はそのまま返す', () => {
    expect(stripExpressionDirectives('こんにちは')).toBe('こんにちは')
  })

  it('空文字列はそのまま返す', () => {
    expect(stripExpressionDirectives('')).toBe('')
  })

  it('前後の意図的な空白は trim しない', () => {
    expect(stripExpressionDirectives('  本文  ')).toBe('  本文  ')
  })
})
