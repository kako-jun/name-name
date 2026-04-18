import { describe, it, expect } from 'vitest'
import { clampFrames, directionToRow } from './npcSpriteSheet'

describe('clampFrames', () => {
  it('未指定は 2 を返す（レンダラーのデフォルト）', () => {
    expect(clampFrames(undefined)).toBe(2)
  })

  it('0 以下は 2 を返す', () => {
    expect(clampFrames(0)).toBe(2)
    expect(clampFrames(-3)).toBe(2)
  })

  it('1..4 はそのまま返す', () => {
    expect(clampFrames(1)).toBe(1)
    expect(clampFrames(2)).toBe(2)
    expect(clampFrames(3)).toBe(3)
    expect(clampFrames(4)).toBe(4)
  })

  it('5 以上は 4 に clamp する', () => {
    expect(clampFrames(5)).toBe(4)
    expect(clampFrames(100)).toBe(4)
  })

  it('小数は floor する', () => {
    expect(clampFrames(2.7)).toBe(2)
    expect(clampFrames(3.9)).toBe(3)
  })
})

describe('directionToRow', () => {
  it('方向から行 index を返す', () => {
    expect(directionToRow('down')).toBe(0)
    expect(directionToRow('left')).toBe(1)
    expect(directionToRow('right')).toBe(2)
    expect(directionToRow('up')).toBe(3)
  })

  it('undefined は down（= 0）にフォールバック', () => {
    expect(directionToRow(undefined)).toBe(0)
  })
})
