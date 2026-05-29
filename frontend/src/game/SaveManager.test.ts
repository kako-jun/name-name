/**
 * SaveManager のクイックセーブ/ロードテスト (#142)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SaveManager, SaveSlotData } from './SaveManager'

function makeSaveData(): SaveSlotData {
  return {
    slot: -1,
    sceneId: 'scene-1',
    eventIndex: 3,
    textIndex: 1,
    flags: { visited: { Bool: true } },
    backgroundPath: '/bg/room.png',
    isBlackout: false,
    characters: [{ name: 'Alice', expression: 'happy', position: 'center' }],
    currentBgmPath: '/bgm/main.mp3',
    savedAt: new Date().toISOString(),
    sceneName: 'シーン1',
  }
}

describe('SaveManager - クイックセーブ', () => {
  let manager: SaveManager

  beforeEach(() => {
    manager = new SaveManager()
    manager.deleteQuickSave()
  })

  it('hasQuickSave: データなしで false を返す', () => {
    expect(manager.hasQuickSave()).toBe(false)
  })

  it('quickSave で保存し、hasQuickSave が true になる', () => {
    manager.quickSave(makeSaveData())
    expect(manager.hasQuickSave()).toBe(true)
  })

  it('quickLoad でデータが復元される', () => {
    const data = makeSaveData()
    manager.quickSave(data)
    const loaded = manager.quickLoad()
    expect(loaded).not.toBeNull()
    expect(loaded?.sceneId).toBe('scene-1')
    expect(loaded?.eventIndex).toBe(3)
    expect(loaded?.textIndex).toBe(1)
    expect(loaded?.flags).toEqual({ visited: { Bool: true } })
  })

  it('quickLoad: データなしで null を返す', () => {
    expect(manager.quickLoad()).toBeNull()
  })

  it('quickSave は通常スロット（0〜2）に影響しない', () => {
    manager.quickSave(makeSaveData())
    expect(manager.listSlots()).toEqual([null, null, null])
  })

  it('通常 save は quickLoad に影響しない', () => {
    const data = { ...makeSaveData(), slot: 0 }
    manager.save(0, data)
    expect(manager.quickLoad()).toBeNull()
  })
})

describe('SaveManager - 背景端フェード (#250)', () => {
  let manager: SaveManager

  beforeEach(() => {
    manager = new SaveManager()
    localStorage.clear()
  })

  it('backgroundFade 付きで save → load してデータが保持される', () => {
    const data: SaveSlotData = {
      ...makeSaveData(),
      slot: 0,
      backgroundFade: { top: 40, bottom: 60, left: 10, right: 20 },
    }
    manager.save(0, data)
    const loaded = manager.load(0)
    expect(loaded?.backgroundFade).toEqual({ top: 40, bottom: 60, left: 10, right: 20 })
  })

  it('後方互換: backgroundFade 欠如の旧セーブ JSON を読んでもクラッシュしない', () => {
    // 旧フォーマットを直接 localStorage に書く（backgroundFade キー無し）
    const legacy = {
      slot: 0,
      sceneId: 'scene-1',
      eventIndex: 3,
      textIndex: 1,
      flags: { visited: { Bool: true } },
      backgroundPath: '/bg/room.png',
      isBlackout: false,
      characters: [{ name: 'Alice', expression: 'happy', position: 'center' }],
      currentBgmPath: '/bgm/main.mp3',
      savedAt: new Date().toISOString(),
      sceneName: 'シーン1',
    }
    localStorage.setItem('name-name-save-0', JSON.stringify(legacy))
    const loaded = manager.load(0)
    expect(loaded).not.toBeNull()
    expect(loaded?.sceneId).toBe('scene-1')
    expect(loaded?.backgroundFade).toBeUndefined()
  })

  it('backgroundFade=null で save → load で null が保持される', () => {
    const data: SaveSlotData = {
      ...makeSaveData(),
      slot: 0,
      backgroundFade: null,
    }
    manager.save(0, data)
    const loaded = manager.load(0)
    expect(loaded?.backgroundFade).toBeNull()
  })
})
