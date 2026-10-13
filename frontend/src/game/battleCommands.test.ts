import { describe, expect, it } from 'vitest'
import {
  crossKeyToCommandId,
  normalizeCommandLayout,
  parseCommandLabels,
  resolveCommandSpecs,
} from './battleCommands'
import { computeCommandCells, computeSideBattleLayout } from './battleLayout'

describe('battleCommands (#204)', () => {
  it('配置は cross（大小無視）以外 grid', () => {
    expect(normalizeCommandLayout('cross')).toBe('cross')
    expect(normalizeCommandLayout(' CROSS ')).toBe('cross')
    expect(normalizeCommandLayout('x')).toBe('grid')
    expect(normalizeCommandLayout(undefined)).toBe('grid')
  })

  it('表示名の解釈: 部分指定・未知 id/空/= なしは無視', () => {
    expect(parseCommandLabels('attack=斬る, spell=魔石')).toEqual({ attack: '斬る', spell: '魔石' })
    expect(parseCommandLabels('foo=x, item=, escape')).toBeUndefined()
    expect(parseCommandLabels(null)).toBeUndefined()
    const specs = resolveCommandSpecs({ spell: '魔石' })
    expect(specs.map((s) => s.label)).toEqual(['たたかう', '魔石', 'どうぐ', 'にげる'])
    expect(specs.map((s) => s.id)).toEqual(['attack', 'spell', 'item', 'escape'])
  })

  it('十字キー: 上=たたかう・左=じゅもん・右=どうぐ・下=にげる', () => {
    expect(crossKeyToCommandId('ArrowUp')).toBe('attack')
    expect(crossKeyToCommandId('ArrowLeft')).toBe('spell')
    expect(crossKeyToCommandId('ArrowRight')).toBe('item')
    expect(crossKeyToCommandId('ArrowDown')).toBe('escape')
    expect(crossKeyToCommandId('a')).toBeUndefined()
  })

  it('cross のセルは窓内に収まり重ならず、上・左・右・下の位置関係', () => {
    const box = { x: 16, y: 100, w: 144, h: 120 }
    const c = computeCommandCells(box, 4, 'cross')
    expect(c).toHaveLength(4)
    for (const r of c) {
      expect(r.x).toBeGreaterThanOrEqual(box.x)
      expect(r.y).toBeGreaterThanOrEqual(box.y)
      expect(r.x + r.w).toBeLessThanOrEqual(box.x + box.w + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(box.y + box.h + 1e-9)
    }
    const [up, left, right, down] = c
    expect(up.y).toBeLessThan(left.y)
    expect(left.y).toBe(right.y)
    expect(left.x).toBeLessThan(right.x)
    expect(down.y).toBeGreaterThan(left.y)
    expect(up.x).toBe(down.x)
    expect(computeCommandCells(box, 5, 'cross')).toHaveLength(5) // 4 以外は grid
  })

  it.each([
    [360, 640],
    [800, 450],
    [1280, 720],
    [640, 360],
  ])('cross は %ix%i で command 内に収まる', (width, height) => {
    const L = computeSideBattleLayout({
      width,
      height,
      partyCount: 4,
      enemyCount: 4,
      commandLayout: 'cross',
    })
    expect(L.commandCells).toHaveLength(4)
    for (const r of L.commandCells) {
      expect(r.x).toBeGreaterThanOrEqual(L.command.x - 1e-9)
      expect(r.x + r.w).toBeLessThanOrEqual(L.command.x + L.command.w + 1e-9)
      expect(r.y + r.h).toBeLessThanOrEqual(L.command.y + L.command.h + 1e-9)
    }
    expect(L.command.y + L.command.h).toBeLessThanOrEqual(height)
  })
})
