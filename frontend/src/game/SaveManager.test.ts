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
    manager = new SaveManager('test-game')
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

  it('quickSave() 後に deleteQuickSave() を呼ぶと hasQuickSave() が false になる (#637)', () => {
    manager.quickSave(makeSaveData())
    expect(manager.hasQuickSave()).toBe(true)

    manager.deleteQuickSave()

    expect(manager.hasQuickSave()).toBe(false)
    expect(manager.quickLoad()).toBeNull()
  })
})

describe('SaveManager - 背景端フェード (#250)', () => {
  let manager: SaveManager

  beforeEach(() => {
    manager = new SaveManager('test-game')
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
    localStorage.setItem('name-name-save-test-game-0', JSON.stringify(legacy))
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

describe('SaveManager - 動画入力レイヤ (#252)', () => {
  let manager: SaveManager

  beforeEach(() => {
    manager = new SaveManager('test-game')
    localStorage.clear()
  })

  it('video 付きで save → load して全フィールドが保持される', () => {
    const data: SaveSlotData = {
      ...makeSaveData(),
      slot: 0,
      video: {
        path: '/videos/capture.webm',
        position: 'center',
        scale: 1.5,
        loop: true,
        mute: false,
        fade: { top: 40, bottom: 60 },
        playhead: 12.5,
      },
    }
    manager.save(0, data)
    const loaded = manager.load(0)
    expect(loaded?.video).toEqual({
      path: '/videos/capture.webm',
      position: 'center',
      scale: 1.5,
      loop: true,
      mute: false,
      fade: { top: 40, bottom: 60 },
      playhead: 12.5,
    })
  })

  it('後方互換: video 欠如の旧セーブ JSON を読んでもクラッシュしない', () => {
    // 旧フォーマットを直接 localStorage に書く（video キー無し）
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
    localStorage.setItem('name-name-save-test-game-0', JSON.stringify(legacy))
    const loaded = manager.load(0)
    expect(loaded).not.toBeNull()
    expect(loaded?.sceneId).toBe('scene-1')
    expect(loaded?.video).toBeUndefined()
  })

  it('video=null で save → load で null が保持される（動画なし状態）', () => {
    const data: SaveSlotData = {
      ...makeSaveData(),
      slot: 0,
      video: null,
    }
    manager.save(0, data)
    const loaded = manager.load(0)
    expect(loaded?.video).toBeNull()
  })
})

describe('SaveManager - docKey 名前空間化 (#578)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('1: docKey 未指定でコンストラクトすると既定の "" 名前空間で動作する（save/load が機能する）', () => {
    const manager = new SaveManager()
    manager.save(0, { ...makeSaveData(), slot: 0, sceneId: 'scene-default' })
    // 既定 docKey は空文字なので、PREFIX + '' + '-0' というキーに書かれる。
    expect(localStorage.getItem('name-name-save--0')).not.toBeNull()
    expect(manager.load(0)?.sceneId).toBe('scene-default')
  })

  it('2: 同一インスタンスで docKey を a→b→a と切り替えても a 時点のデータがそのまま読める（mutable docKey 切替）', () => {
    const manager = new SaveManager()
    manager.setDocKey('a')
    manager.save(0, { ...makeSaveData(), slot: 0, sceneId: 'scene-a' })
    manager.setDocKey('b')
    manager.save(0, { ...makeSaveData(), slot: 0, sceneId: 'scene-b' })
    manager.setDocKey('a')
    expect(manager.load(0)?.sceneId).toBe('scene-a')
  })

  it('3: docKey="project-a" と docKey="project-b" はスロット・quickSave とも互いを上書きしない', () => {
    const a = new SaveManager('project-a')
    const b = new SaveManager('project-b')
    for (let slot = 0; slot < 3; slot++) {
      a.save(slot, { ...makeSaveData(), slot, sceneId: `a-${slot}` })
      b.save(slot, { ...makeSaveData(), slot, sceneId: `b-${slot}` })
    }
    a.quickSave({ ...makeSaveData(), sceneId: 'a-quick' })
    b.quickSave({ ...makeSaveData(), sceneId: 'b-quick' })

    for (let slot = 0; slot < 3; slot++) {
      expect(a.load(slot)?.sceneId).toBe(`a-${slot}`)
      expect(b.load(slot)?.sceneId).toBe(`b-${slot}`)
    }
    expect(a.quickLoad()?.sceneId).toBe('a-quick')
    expect(b.quickLoad()?.sceneId).toBe('b-quick')
  })

  it('4: docKey=""（明示的空文字）と docKey 省略は同一の名前空間キーに解決される', () => {
    const omitted = new SaveManager()
    omitted.save(0, { ...makeSaveData(), slot: 0, sceneId: 'from-omitted' })
    const explicit = new SaveManager('')
    expect(explicit.load(0)?.sceneId).toBe('from-omitted')
  })

  it('5: ハイフンを含む docKey（例: "theo-hayami"）でも接頭辞が被る別 docKey とキー衝突しない', () => {
    const theo = new SaveManager('theo')
    const theoHayami = new SaveManager('theo-hayami')
    theo.save(0, { ...makeSaveData(), slot: 0, sceneId: 'theo-scene' })
    theoHayami.save(0, { ...makeSaveData(), slot: 0, sceneId: 'theo-hayami-scene' })
    expect(theo.load(0)?.sceneId).toBe('theo-scene')
    expect(theoHayami.load(0)?.sceneId).toBe('theo-hayami-scene')
  })

  it('6: 名前空間下のキーに壊れた JSON が入っていても load()/quickLoad() は例外を投げず null を返す', () => {
    const manager = new SaveManager('broken-ns')
    localStorage.setItem('name-name-save-broken-ns-0', '{not valid json')
    localStorage.setItem('name-name-save-broken-ns-quick', '{not valid json')
    expect(() => manager.load(0)).not.toThrow()
    expect(manager.load(0)).toBeNull()
    expect(() => manager.quickLoad()).not.toThrow()
    expect(manager.quickLoad()).toBeNull()
  })

  it('7: slot が範囲外（-1・3）のとき save()/load()/deleteSlot() は no-op（例外を投げず何も書き込まない）', () => {
    const manager = new SaveManager('range-test')
    expect(() => manager.save(-1, { ...makeSaveData(), slot: -1 })).not.toThrow()
    expect(() => manager.save(3, { ...makeSaveData(), slot: 3 })).not.toThrow()
    expect(manager.load(-1)).toBeNull()
    expect(manager.load(3)).toBeNull()
    expect(() => manager.deleteSlot(-1)).not.toThrow()
    expect(() => manager.deleteSlot(3)).not.toThrow()
    expect(manager.listSlots()).toEqual([null, null, null])
  })

  // #637 回帰テスト（NovelRenderer.newGameReset.test.ts と通し番号）観点8。b→a 方向の非干渉も
  // 同一テスト内で検証しているため、別観点としての9は独立させていない
  // （NovelRenderer.newGameReset.test.ts のファイル冒頭コメント参照）。
  it('8: docKey が異なる別インスタンスの deleteQuickSave() は他 docKey の quickSave に影響しない (#637)', () => {
    const a = new SaveManager('project-a')
    const b = new SaveManager('project-b')
    a.quickSave({ ...makeSaveData(), sceneId: 'a-quick' })
    b.quickSave({ ...makeSaveData(), sceneId: 'b-quick' })

    a.deleteQuickSave()

    expect(a.hasQuickSave()).toBe(false)
    expect(b.hasQuickSave()).toBe(true)
    expect(b.quickLoad()?.sceneId).toBe('b-quick')
  })
})
