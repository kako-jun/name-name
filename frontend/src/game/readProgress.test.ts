import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetReadProgressForTest,
  hasAnyReadProgress,
  isLineRead,
  isRead,
  isReadForLine,
  isSceneRead,
  loadReadLineProgress,
  loadReadProgress,
  loadReadSceneProgress,
  makeReadLineKey,
  migrateLegacyReadProgressForScene,
  markRead,
  markReadLine,
  markReadScene,
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

describe('scene-aware read progress', () => {
  it('sceneId + display index の既読行キーを保存・復元する', () => {
    const key = makeReadLineKey('dekaris-netami', 3)
    const progress = new Set<string>()

    markReadLine(KEY, progress, key)

    expect(isLineRead(progress, key)).toBe(true)
    expect(loadReadLineProgress(KEY)).toEqual(new Set([key]))
  })

  it('既読 sceneId を保存・復元する', () => {
    const progress = new Set<string>()

    markReadScene(KEY, progress, 'dekaris-netami')

    expect(isSceneRead(progress, 'dekaris-netami')).toBe(true)
    expect(loadReadSceneProgress(KEY)).toEqual(new Set(['dekaris-netami']))
  })

  it('hasAnyReadProgress は旧 index / 行 / scene のいずれかがあれば true', () => {
    expect(hasAnyReadProgress(KEY)).toBe(false)

    markReadScene(KEY, new Set(), 'dekaris-netami')

    expect(hasAnyReadProgress(KEY)).toBe(true)
  })

  it('clearReadProgress は行と scene の既読も消す', () => {
    markReadLine(KEY, new Set(), makeReadLineKey('dekaris-netami', 1))
    markReadScene(KEY, new Set(), 'dekaris-netami')

    __resetReadProgressForTest(KEY)

    expect(loadReadLineProgress(KEY)).toEqual(new Set())
    expect(loadReadSceneProgress(KEY)).toEqual(new Set())
  })

  it('isReadForLine は sceneId 付きなら line key だけを見る', () => {
    const lineProgress = new Set([makeReadLineKey('dekaris-netami', 3)])

    expect(isReadForLine(new Set(), lineProgress, 'dekaris-netami', 3)).toBe(true)
    expect(isReadForLine(new Set([4]), new Set(), 'dekaris-netami', 4)).toBe(false)
    expect(isReadForLine(new Set(), new Set(), 'dekaris-netami', 5)).toBe(false)
  })

  it('isReadForLine は sceneId が無ければ旧 display index だけを見る', () => {
    expect(isReadForLine(new Set([2]), new Set(), null, 2)).toBe(true)
    expect(isReadForLine(new Set(), new Set([makeReadLineKey('x', 2)]), null, 2)).toBe(false)
  })

  it('migrateLegacyReadProgressForScene は旧 index を最初の scene の line key へ一括移行する', () => {
    const displayProgress = new Set([1, 2])
    const lineProgress = new Set<string>()

    migrateLegacyReadProgressForScene(KEY, displayProgress, lineProgress, 'dekaris-netami')

    expect(lineProgress).toEqual(
      new Set([makeReadLineKey('dekaris-netami', 1), makeReadLineKey('dekaris-netami', 2)])
    )
    expect(loadReadLineProgress(KEY)).toEqual(lineProgress)
  })

  it('migrateLegacyReadProgressForScene は line key が既にあれば別 scene へ旧 index を誤移行しない', () => {
    const displayProgress = new Set([1])
    const lineProgress = new Set([makeReadLineKey('dekaris-netami', 1)])

    migrateLegacyReadProgressForScene(KEY, displayProgress, lineProgress, 'makiya-netami')

    expect(lineProgress).toEqual(new Set([makeReadLineKey('dekaris-netami', 1)]))
    expect(isReadForLine(displayProgress, lineProgress, 'makiya-netami', 1)).toBe(false)
  })
})
