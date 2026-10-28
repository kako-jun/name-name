import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aggregateEnemyList,
  ENEMY_LIST_LINE_RATIO,
  ENEMY_LIST_MAX_FONT,
  ENEMY_LIST_MIN_FONT,
  ENEMY_LIST_PADDING,
  enemyListLines,
  enemyListRowText,
  fitEnemyListFont,
  fitEnemyListRowText,
  normalizeBattleEnemyList,
} from './battleEnemyList'
import { estimateTextWidth } from './battleLayout'

const e = (name: string, hp = 10) => ({ name, hp })

describe('aggregateEnemyList (#954)', () => {
  it('同名はまとめて個数にし、最初に現れた順に並べる', () => {
    expect(aggregateEnemyList([e('スライム'), e('イカ'), e('スライム'), e('タコ')])).toEqual([
      { name: 'スライム', count: 2 },
      { name: 'イカ', count: 1 },
      { name: 'タコ', count: 1 },
    ])
  })
  it('倒れた（HP 0）敵は個数から引く', () => {
    expect(aggregateEnemyList([e('スライム'), e('スライム', 0), e('スライム')])).toEqual([
      { name: 'スライム', count: 2 },
    ])
  })
  it('全滅した名前は行ごと消え、残りの順序は変わらない', () => {
    expect(aggregateEnemyList([e('A', 0), e('B'), e('A', 0), e('C')])).toEqual([
      { name: 'B', count: 1 },
      { name: 'C', count: 1 },
    ])
  })
  it('先頭が倒れて後ろの同名が生きていても、元の最初の位置で並ぶ', () => {
    expect(aggregateEnemyList([e('A', 0), e('B'), e('A')])).toEqual([
      { name: 'A', count: 1 },
      { name: 'B', count: 1 },
    ])
  })
  it('空・全滅は空配列', () => {
    expect(aggregateEnemyList([])).toEqual([])
    expect(aggregateEnemyList([e('A', 0)])).toEqual([])
  })
})

describe('enemyListRowText / fitEnemyListRowText', () => {
  it('1 体は名前のみ、2 体以上は「名前 ×N」', () => {
    expect(enemyListRowText({ name: 'イカ', count: 1 })).toBe('イカ')
    expect(enemyListRowText({ name: 'スライム', count: 3 })).toBe('スライム ×3')
  })
  it('幅に収まれば そのまま', () => {
    expect(fitEnemyListRowText({ name: 'スライム', count: 3 }, 200, 14)).toBe('スライム ×3')
  })
  it('狭いときは名前を省略して ×N を残す', () => {
    const w = ENEMY_LIST_PADDING * 2 + 100
    const t = fitEnemyListRowText({ name: 'ABCDEFGHIJKLMNOP', count: 12 }, w, 14)
    expect(t.endsWith('… ×12')).toBe(true)
    expect(estimateTextWidth(t, 14)).toBeLessThanOrEqual(w - ENEMY_LIST_PADDING * 2)
  })
})

describe('fitEnemyListFont', () => {
  it('余裕があれば上限サイズ', () => {
    const f = fitEnemyListFont(2, 200)
    expect(f.fontSize).toBe(ENEMY_LIST_MAX_FONT)
    expect(f.visibleRows).toBe(2)
  })
  it('行が多いと縮小し、全行が窓高に収まる', () => {
    const h = 100
    const f = fitEnemyListFont(5, h)
    expect(f.fontSize).toBeLessThan(ENEMY_LIST_MAX_FONT)
    expect(f.visibleRows).toBe(5)
    expect(f.lineHeight * 5 + ENEMY_LIST_PADDING * 2).toBeLessThanOrEqual(h)
    expect(f.lineHeight).toBeGreaterThanOrEqual(Math.floor(f.fontSize * ENEMY_LIST_LINE_RATIO))
  })
  it('最小サイズでも収まらない分は出さない（はみ出さない）', () => {
    const h = 60
    const f = fitEnemyListFont(20, h)
    expect(f.fontSize).toBe(ENEMY_LIST_MIN_FONT)
    expect(f.visibleRows).toBeLessThan(20)
    expect(f.visibleRows * f.lineHeight + ENEMY_LIST_PADDING * 2).toBeLessThanOrEqual(h)
  })
  it('0 行・負の高さで落ちない', () => {
    expect(fitEnemyListFont(0, 100).visibleRows).toBe(0)
    expect(fitEnemyListFont(3, -5).visibleRows).toBe(0)
  })
})

describe('enemyListLines', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ name: `E${i}`, count: 1 }))
  it('収まらないときは最後に出せた行を「…」にする', () => {
    const fit = fitEnemyListFont(rows.length, 60)
    const lines = enemyListLines(rows, fit, 160)
    expect(lines).toHaveLength(fit.visibleRows)
    expect(lines[lines.length - 1]).toBe('…')
    expect(lines[0]).toBe('E0')
  })
  it('全行が収まるなら「…」は出さない', () => {
    const few = rows.slice(0, 2)
    expect(enemyListLines(few, fitEnemyListFont(2, 200), 160)).toEqual(['E0', 'E1'])
  })
})

describe('fitEnemyListFont: 幅で縮める', () => {
  const row = (name: string, count = 1) => ({ name, count })
  it('幅 96 で「スライム ×3」は省略されずに出る（13px まで縮む）', () => {
    const rows = [row('スライム', 3), row('イカ')]
    const fit = fitEnemyListFont(rows.length, 120, { rows, windowWidth: 96 })
    expect(fit.fontSize).toBeLessThan(ENEMY_LIST_MAX_FONT)
    expect(fit.fontSize).toBeGreaterThanOrEqual(ENEMY_LIST_MIN_FONT)
    expect(enemyListLines(rows, fit, 96)).toEqual(['スライム ×3', 'イカ'])
  })
  it('幅 96 で「メタルスライム」も縮んで収まる', () => {
    const rows = [row('メタルスライム')]
    const fit = fitEnemyListFont(1, 120, { rows, windowWidth: 96 })
    expect(enemyListLines(rows, fit, 96)).toEqual(['メタルスライム'])
  })
  it('幅が十分なら上限サイズのまま', () => {
    const rows = [row('スライム', 3)]
    expect(fitEnemyListFont(1, 120, { rows, windowWidth: 200 }).fontSize).toBe(ENEMY_LIST_MAX_FONT)
  })
  it('最小サイズでも入らない名前は省略（フォントは最小）', () => {
    const rows = [row('ABCDEFGHIJKLMNOPQRSTUVWXYZ')]
    const fit = fitEnemyListFont(1, 120, { rows, windowWidth: 96 })
    expect(fit.fontSize).toBe(ENEMY_LIST_MIN_FONT)
    expect(enemyListLines(rows, fit, 96)[0].endsWith('…')).toBe(true)
  })
  it('高さ起因の縮小を超えて大きくはしない・行あふれの「…」は従来どおり', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`E${i}`))
    const fit = fitEnemyListFont(20, 60, { rows, windowWidth: 160 })
    expect(fit.fontSize).toBe(ENEMY_LIST_MIN_FONT)
    const lines = enemyListLines(rows, fit, 160)
    expect(lines[lines.length - 1]).toBe('…')
  })
})

describe('normalizeBattleEnemyList', () => {
  afterEach(() => vi.restoreAllMocks())
  it('window / 前後空白・大文字 → window', () => {
    expect(normalizeBattleEnemyList('window')).toBe('window')
    expect(normalizeBattleEnemyList(' WINDOW ')).toBe('window')
  })
  it('未指定・空は警告なしで off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeBattleEnemyList(undefined)).toBe('off')
    expect(normalizeBattleEnemyList(null)).toBe('off')
    expect(normalizeBattleEnemyList('')).toBe('off')
    expect(warn).not.toHaveBeenCalled()
  })
  it('不正値は警告して off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeBattleEnemyList('list')).toBe('off')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
