import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enemyRightEdges,
  formationRowField,
  normalizeBattleEnemyRow,
  resolveEnemyRow,
} from './enemyRow'
import type { BattleEntity } from './spellDsl'

const e = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id,
  hp: 10,
  maxHp: 10,
  mp: 0,
  maxMp: 0,
  atk: 1,
  def: 0,
  agi: 1,
  ...over,
})
const at = (col: number, row = 0) => ({ layout: { w: 1, h: 1, scale: 1, at: { col, row } } })

afterEach(() => vi.restoreAllMocks())

describe('normalizeBattleEnemyRow (#896)', () => {
  it.each([
    ['on', true],
    [' ON ', true],
    ['off', false],
    [null, false],
    [undefined, false],
    ['', false],
  ])('%j → %s（警告なし）', (raw, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeBattleEnemyRow(raw)).toBe(expected)
    expect(warn).not.toHaveBeenCalled()
  })
  it('不正値は警告して false。warn=false なら警告しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeBattleEnemyRow('yes')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(normalizeBattleEnemyRow('yes', false)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('formationRowField (#896)', () => {
  it.each([
    ['前衛', 'front'],
    ['後衛', 'back'],
    ['前列', 'front'],
    ['後列', 'back'],
    ['front', 'front'],
    ['Back', 'back'],
  ])('%s → formationRow %s', (raw, row) => {
    expect(formationRowField(raw)).toEqual({ formationRow: row })
  })
  it('未指定・空は何も付けない（キーも増えない）', () => {
    expect(formationRowField(undefined)).toEqual({})
    expect(formationRowField(null)).toEqual({})
    expect(formationRowField('  ')).toEqual({})
  })
})

describe('enemyRightEdges / resolveEnemyRow (#896)', () => {
  it('グリッドが無ければ空・列は導出できない（undefined）', () => {
    const a = e('a')
    const edges = enemyRightEdges(undefined, [a])
    expect(edges.size).toBe(0)
    expect(resolveEnemyRow(a, [a], edges)).toBeUndefined()
  })
  it('宣言が最優先で、グリッドが無くても使える', () => {
    const a = e('a', { formationRow: 'back' })
    expect(resolveEnemyRow(a, [a], new Map())).toBe('back')
  })
  it('右端の列が前列。倒れると繰り上がる（hp 0 は数えない）', () => {
    const a = e('a', at(2))
    const b = e('b', at(1))
    const all = [a, b]
    const edges = enemyRightEdges({ cols: 3, rows: 1 }, all)
    expect(resolveEnemyRow(a, all, edges)).toBe('front')
    expect(resolveEnemyRow(b, all, edges)).toBe('back')
    a.hp = 0
    expect(resolveEnemyRow(b, all, edges)).toBe('front')
  })
  it('サイズ 2x1 は右端の列（col + w - 1）で数える', () => {
    const w = e('w', { layout: { w: 2, h: 1, scale: 1, at: { col: 0, row: 0 } } })
    const edges = enemyRightEdges({ cols: 3, rows: 2 }, [w])
    expect(edges.get(w)).toBe(1)
  })
})
