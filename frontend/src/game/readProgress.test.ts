import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetReadProgressForTest,
  isRead,
  loadReadProgress,
  markRead,
  saveReadProgress,
} from './readProgress'

const KEY = 'test-doc'

beforeEach(() => {
  __resetReadProgressForTest(KEY)
})

afterEach(() => {
  __resetReadProgressForTest(KEY)
})

describe('loadReadProgress', () => {
  it('保存がなければ空セットを返す', () => {
    expect(loadReadProgress(KEY)).toEqual(new Set())
  })

  it('保存済みのインデックスを復元する', () => {
    saveReadProgress(KEY, new Set([1, 2, 5]))
    expect(loadReadProgress(KEY)).toEqual(new Set([1, 2, 5]))
  })

  it('不正な JSON は空セットにフォールバック', () => {
    localStorage.setItem('name-name:read-progress:' + KEY, '{bad json')
    expect(loadReadProgress(KEY)).toEqual(new Set())
  })

  it('配列以外の JSON は空セットにフォールバック', () => {
    localStorage.setItem('name-name:read-progress:' + KEY, '42')
    expect(loadReadProgress(KEY)).toEqual(new Set())
  })

  it('配列内の非数値要素はスキップする', () => {
    localStorage.setItem('name-name:read-progress:' + KEY, '[1, "x", 3, null]')
    expect(loadReadProgress(KEY)).toEqual(new Set([1, 3]))
  })
})

describe('saveReadProgress / loadReadProgress ラウンドトリップ', () => {
  it('save → load で値が保持される', () => {
    const s = new Set([10, 20, 30])
    saveReadProgress(KEY, s)
    expect(loadReadProgress(KEY)).toEqual(s)
  })
})

describe('markRead', () => {
  it('未既読インデックスをマークして保存する', () => {
    const progress = new Set<number>()
    markRead(KEY, progress, 3)
    expect(progress.has(3)).toBe(true)
    expect(loadReadProgress(KEY).has(3)).toBe(true)
  })

  it('既読済みインデックスを重複マークしても問題ない', () => {
    const progress = new Set<number>([3])
    markRead(KEY, progress, 3)
    expect(progress.size).toBe(1)
  })
})

describe('isRead', () => {
  it('既読インデックスは true を返す', () => {
    expect(isRead(new Set([1, 2, 3]), 2)).toBe(true)
  })

  it('未読インデックスは false を返す', () => {
    expect(isRead(new Set([1, 2, 3]), 5)).toBe(false)
  })
})
