import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aggregateEnemyList,
  ENEMY_LIST_LINE_RATIO,
  ENEMY_LIST_MAX_FONT,
  ENEMY_LIST_MIN_FONT,
  ENEMY_LIST_PADDING,
  enemyListLines,
  enemyListStatusPrefix,
  enemyListTextTop,
  enemyListRowText,
  fitEnemyListFont,
  fitEnemyListRowText,
  normalizeBattleEnemyList,
} from './battleEnemyList'
import {
  SIDE_STATUS_FONT_SIZE,
  SIDE_STATUS_ROW_HEIGHT,
  SIDE_STATUS_VERTICAL_PADDING,
  estimateTextWidth,
} from './battleLayout'

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

describe('fitEnemyListFont: 出ない行は幅の計算に入れない (#954 後続)', () => {
  const row = (name: string, count = 1) => ({ name, count })
  it('高さあふれで出ない（「…」に置き換わる）長い名前の行のために、他の行を縮めない', () => {
    // 3 行で窓高 71: 14px では 2 行しか出ず、最後の行は出ない。出ない行が長くても 14px のまま
    const rows = [row('A0'), row('A1'), row('ながいなまえのてきがいる')]
    const fit = fitEnemyListFont(3, 71, { rows, windowWidth: 96 })
    expect(fit.visibleRows).toBe(2)
    expect(fit.fontSize).toBe(ENEMY_LIST_MAX_FONT)
    expect(enemyListLines(rows, fit, 96)).toEqual(['A0', '…'])
  })
  it('出る行が長ければ従来どおり縮める', () => {
    const rows = [row('ながいなまえのてきがいる'), row('A1'), row('A2')]
    const fit = fitEnemyListFont(3, 71, { rows, windowWidth: 96 })
    expect(fit.fontSize).toBeLessThan(ENEMY_LIST_MAX_FONT)
  })
})

describe('状態異常つきの行 (#954 後続)', () => {
  it('同名でも状態が違えば別の行。状態は先頭に [..] で付く', () => {
    const rows = aggregateEnemyList([
      { name: 'スライム', hp: 5, status: ['どく'] },
      { name: 'スライム', hp: 5 },
      { name: 'スライム', hp: 5 },
      { name: 'スライム', hp: 5, status: ['どく'] },
    ])
    expect(rows.map(enemyListRowText)).toEqual(['[どく] スライム ×2', 'スライム ×2'])
  })
  it('状態つきの敵が倒れたら、その行ごと消える', () => {
    const rows = aggregateEnemyList([
      { name: 'スライム', hp: 0, status: ['どく'] },
      { name: 'スライム', hp: 5 },
    ])
    expect(rows.map(enemyListRowText)).toEqual(['スライム'])
  })
  it('複数の状態は「・」でつなぐ。状態なし・空配列は前置きなし', () => {
    expect(enemyListStatusPrefix({ name: 'a', count: 1, status: ['どく', 'ねむり'] })).toBe(
      '[どく・ねむり] '
    )
    expect(enemyListStatusPrefix({ name: 'a', count: 1, status: [] })).toBe('')
    expect(enemyListStatusPrefix({ name: 'a', count: 1 })).toBe('')
  })
  it('狭いときは名前を省略して、先頭の状態と ×N を残す', () => {
    const row = { name: 'ABCDEFGHIJKLMNOP', count: 2, status: ['どく'] }
    const t = fitEnemyListRowText(row, 120, 14)
    expect(t.startsWith('[どく] ')).toBe(true)
    expect(t.endsWith(' ×2')).toBe(true)
    expect(t).toContain('…')
    expect(estimateTextWidth(t, 14)).toBeLessThanOrEqual(120 - ENEMY_LIST_PADDING * 2)
  })
})

describe('enemyListTextTop: 1 行目を status 窓の 1 行目にそろえる (#954 後続)', () => {
  it('14px・1 行目の文字の y が status 窓の 1 行目の文字と一致する', () => {
    const fit = fitEnemyListFont(2, 120)
    const statusFirstY =
      SIDE_STATUS_VERTICAL_PADDING / 2 + (SIDE_STATUS_ROW_HEIGHT - SIDE_STATUS_FONT_SIZE) / 2
    const listFirstY = enemyListTextTop(120, fit) + (fit.lineHeight - fit.fontSize) / 2
    expect(fit.fontSize).toBe(14)
    expect(listFirstY).toBe(statusFirstY)
  })
  it('行ブロックが窓の下余白を食うときは上へ詰め、上余白は ENEMY_LIST_PADDING を割らない', () => {
    for (const h of [40, 60, 71, 90, 120, 200]) {
      for (const n of [1, 3, 6, 12]) {
        const fit = fitEnemyListFont(n, h)
        const top = enemyListTextTop(h, fit)
        expect(top).toBeGreaterThanOrEqual(ENEMY_LIST_PADDING)
        expect(top + fit.visibleRows * fit.lineHeight).toBeLessThanOrEqual(
          h - ENEMY_LIST_PADDING + 1e-9
        )
      }
    }
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
