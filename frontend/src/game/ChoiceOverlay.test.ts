import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveStyle } from './ChoiceOverlay'

describe('resolveStyle', () => {
  const calls: unknown[][] = []
  const originalWarn = console.warn

  beforeEach(() => {
    calls.length = 0
    console.warn = (...args: unknown[]) => {
      calls.push(args)
    }
  })
  afterEach(() => {
    console.warn = originalWarn
    vi.restoreAllMocks()
  })

  it('未指定 (undefined) は default テーマ、警告なし', () => {
    const t = resolveStyle()
    expect(t.fontFamily).toContain('Noto Sans JP')
    expect(t.radius).toBe(8)
    expect(calls.length).toBe(0)
  })

  it('null は default テーマ、警告なし', () => {
    const t = resolveStyle(null)
    expect(t.radius).toBe(8)
    expect(calls.length).toBe(0)
  })

  it('空文字は default テーマ、警告なし', () => {
    const t = resolveStyle('')
    expect(t.radius).toBe(8)
    expect(calls.length).toBe(0)
  })

  it('"default" 明示は default テーマ、警告なし', () => {
    const t = resolveStyle('default')
    expect(t.radius).toBe(8)
    expect(calls.length).toBe(0)
  })

  it('"soft" は soft テーマ', () => {
    const t = resolveStyle('soft')
    expect(t.radius).toBe(24)
    expect(t.borderWidth).toBe(3)
    expect(calls.length).toBe(0)
  })

  it('"monochrome" は monochrome テーマ', () => {
    const t = resolveStyle('monochrome')
    expect(t.radius).toBe(0)
    expect(t.fontFamily).toContain('Noto Serif JP')
    expect(calls.length).toBe(0)
  })

  it('未知値は default にフォールバックし、警告を出す', () => {
    const t = resolveStyle('foo')
    expect(t.radius).toBe(8)
    expect(calls.length).toBe(1)
    expect(String(calls[0]?.[0])).toContain('foo')
  })

  it('typo (sof) も default にフォールバックして警告', () => {
    resolveStyle('sof')
    expect(calls.length).toBe(1)
  })
})
