import { describe, it, expect, vi } from 'vitest'
import { resolveStyle } from './ChoiceOverlay'

describe('resolveStyle', () => {
  it('未指定 (undefined) は default テーマ、警告なし', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle()
    expect(t.fontFamily).toContain('Noto Sans JP')
    expect(t.radius).toBe(8)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('null は default テーマ、警告なし', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle(null)
    expect(t.radius).toBe(8)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('空文字は default テーマ、警告なし', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle('')
    expect(t.radius).toBe(8)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('"default" 明示は default テーマ、警告なし', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle('default')
    expect(t.radius).toBe(8)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('"soft" は soft テーマ', () => {
    const t = resolveStyle('soft')
    expect(t.radius).toBe(24)
    expect(t.borderWidth).toBe(3)
  })

  it('"monochrome" は monochrome テーマ', () => {
    const t = resolveStyle('monochrome')
    expect(t.radius).toBe(0)
    expect(t.fontFamily).toContain('Noto Serif JP')
  })

  it('未知値は default にフォールバックし、警告を出す', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle('foo')
    expect(t.radius).toBe(8)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('foo')
    warnSpy.mockRestore()
  })

  it('typo (sof) も default にフォールバックして警告', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveStyle('sof')
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })
})
