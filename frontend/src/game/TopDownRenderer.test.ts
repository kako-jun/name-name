/**
 * TopDownRenderer のユニットテスト (#198)
 *
 * PixiJS への依存が強いため、PixiJS を必要としない純粋ロジック部分のみをテストする。
 * - triggerDoneKey(): once=true トリガーの localStorage キー生成
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { triggerDoneKey } from './TopDownRenderer'

describe('triggerDoneKey (#198)', () => {
  it('シーン名からlocalStorageキーを生成する（正常系）', () => {
    expect(triggerDoneKey('elder_cutscene')).toBe('name-name-trigger-done-elder_cutscene')
  })

  it('シーン名が異なればキーも異なる（同値分割）', () => {
    const key1 = triggerDoneKey('scene_a')
    const key2 = triggerDoneKey('scene_b')
    expect(key1).not.toBe(key2)
  })

  it('空文字シーン名でもクラッシュせずキーを返す（境界値）', () => {
    expect(triggerDoneKey('')).toBe('name-name-trigger-done-')
  })

  it('記号・数字を含む名前でもキーを生成できる', () => {
    expect(triggerDoneKey('event-123_abc')).toBe('name-name-trigger-done-event-123_abc')
  })
})

describe('once=true トリガーのフラグ管理 (#198)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('未発火の場合 localStorage にキーが存在しない', () => {
    const key = triggerDoneKey('my_event')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('発火後は localStorage に "1" が保存される', () => {
    const key = triggerDoneKey('my_event')
    localStorage.setItem(key, '1')
    expect(localStorage.getItem(key)).toBe('1')
  })

  it('発火済みキーが存在する場合は再発火をスキップできる（once=true ロジック）', () => {
    const sceneName = 'village_intro'
    const key = triggerDoneKey(sceneName)

    // 1回目: 未発火 → 発火可
    expect(localStorage.getItem(key)).toBeNull()
    localStorage.setItem(key, '1')

    // 2回目: 発火済み → スキップ
    expect(localStorage.getItem(key)).toBe('1')
  })

  it('異なるシーンのフラグは互いに独立している', () => {
    const key1 = triggerDoneKey('scene_a')
    const key2 = triggerDoneKey('scene_b')
    localStorage.setItem(key1, '1')

    expect(localStorage.getItem(key1)).toBe('1')
    expect(localStorage.getItem(key2)).toBeNull()
  })

  it('localStorageClear 後は再度発火可能になる（セーブリセット相当）', () => {
    const key = triggerDoneKey('boss_intro')
    localStorage.setItem(key, '1')
    localStorage.clear()
    expect(localStorage.getItem(key)).toBeNull()
  })
})
