/**
 * normalizeBackgroundFade の純粋関数テスト (#250)。
 *
 * 背景の端フェードマスク値（parser / セーブデータ由来の生値）を
 * 正規化する純粋関数のみを対象とする。PixiJS の描画パスや
 * buildEdgeFadeMask 等の private メソッドは jsdom では検証できないため
 * 実機 golden path に委ねる（CLAUDE.md ルール7）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeBackgroundFade } from './NovelRenderer'

describe('normalizeBackgroundFade', () => {
  it('4 端正常値はそのまま保持される', () => {
    expect(normalizeBackgroundFade({ top: 40, bottom: 60, left: 10, right: 20 })).toEqual({
      top: 40,
      bottom: 60,
      left: 10,
      right: 20,
    })
  })

  it('raw=null は null を返す', () => {
    expect(normalizeBackgroundFade(null)).toBeNull()
  })

  it('raw=undefined は null を返す', () => {
    expect(normalizeBackgroundFade(undefined)).toBeNull()
  })

  it('空オブジェクト {} は null を返す（端の指定なし）', () => {
    expect(normalizeBackgroundFade({})).toBeNull()
  })

  it('全端が 0 は null を返す（0 は無効）', () => {
    expect(normalizeBackgroundFade({ top: 0 })).toBeNull()
  })

  it('負値は落ちて null になる', () => {
    expect(normalizeBackgroundFade({ top: -5 })).toBeNull()
  })

  it('NaN は落ちて null になる', () => {
    expect(normalizeBackgroundFade({ top: NaN })).toBeNull()
  })

  it('Infinity は落ちて null になる', () => {
    expect(normalizeBackgroundFade({ top: Infinity })).toBeNull()
  })

  it('小数は Math.round される', () => {
    expect(normalizeBackgroundFade({ top: 40.6 })).toEqual({ top: 41 })
  })

  it('片端のみ有効なら無効端はキーごと落ちる', () => {
    const result = normalizeBackgroundFade({ top: 40, bottom: 0 })
    expect(result).toEqual({ top: 40 })
    expect(result).not.toHaveProperty('bottom')
  })

  it('number 以外の型（文字列）は落ちて null になる', () => {
    expect(normalizeBackgroundFade({ top: '40' as unknown as number })).toBeNull()
  })

  describe('console を汚染しない', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('異常入力でも console.warn / console.error を呼ばない', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      normalizeBackgroundFade({
        top: -5,
        bottom: NaN,
        left: '10' as unknown as number,
        right: Infinity,
      })
      normalizeBackgroundFade(null)
      normalizeBackgroundFade({})
      expect(warnSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    })
  })
})
