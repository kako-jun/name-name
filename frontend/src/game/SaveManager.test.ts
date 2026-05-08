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
    flags: { visited: true },
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
    // テスト前にクイックセーブを消す
    localStorage.removeItem('name-name-save-quick')
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
    expect(loaded?.flags).toEqual({ visited: true })
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
