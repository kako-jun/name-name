import { describe, expect, it } from 'vitest'
import {
  ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO,
  GAME_HEIGHT,
  GAME_WIDTH,
  parseAspectRatio,
} from './constants'

describe('ASPECT_RATIOS', () => {
  it('16:9 は 800×450', () => {
    expect(ASPECT_RATIOS['16:9']).toEqual({ width: 800, height: 450 })
  })

  it('4:3 は 800×600', () => {
    expect(ASPECT_RATIOS['4:3']).toEqual({ width: 800, height: 600 })
  })

  it('9:16 は 450×800', () => {
    expect(ASPECT_RATIOS['9:16']).toEqual({ width: 450, height: 800 })
  })
})

describe('DEFAULT_ASPECT_RATIO', () => {
  it('デフォルトは 16:9', () => {
    expect(DEFAULT_ASPECT_RATIO).toBe('16:9')
  })
})

describe('GAME_WIDTH / GAME_HEIGHT (後方互換エイリアス)', () => {
  it('GAME_WIDTH はデフォルト比率の width と一致する', () => {
    expect(GAME_WIDTH).toBe(ASPECT_RATIOS[DEFAULT_ASPECT_RATIO].width)
  })

  it('GAME_HEIGHT はデフォルト比率の height と一致する', () => {
    expect(GAME_HEIGHT).toBe(ASPECT_RATIOS[DEFAULT_ASPECT_RATIO].height)
  })
})

describe('parseAspectRatio', () => {
  it('有効な比率文字列をそのまま返す', () => {
    expect(parseAspectRatio('16:9')).toBe('16:9')
    expect(parseAspectRatio('4:3')).toBe('4:3')
    expect(parseAspectRatio('9:16')).toBe('9:16')
  })

  it('undefined はデフォルトにフォールバックする', () => {
    expect(parseAspectRatio(undefined)).toBe(DEFAULT_ASPECT_RATIO)
  })

  it('null はデフォルトにフォールバックする', () => {
    expect(parseAspectRatio(null)).toBe(DEFAULT_ASPECT_RATIO)
  })

  it('空文字はデフォルトにフォールバックする', () => {
    expect(parseAspectRatio('')).toBe(DEFAULT_ASPECT_RATIO)
  })

  it('未知の文字列はデフォルトにフォールバックする', () => {
    expect(parseAspectRatio('21:9')).toBe(DEFAULT_ASPECT_RATIO)
    expect(parseAspectRatio('1:1')).toBe(DEFAULT_ASPECT_RATIO)
    expect(parseAspectRatio('bad')).toBe(DEFAULT_ASPECT_RATIO)
  })
})
