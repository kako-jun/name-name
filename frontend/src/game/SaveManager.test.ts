/**
 * SaveManager のクイックセーブ/ロードテスト (#142)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SaveManager, SaveSlotData } from './SaveManager'
import { saveSlotToGameState } from './novelLayout'

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

  // 15: 既存テストは makeSaveData()（cameraMode/cameraOrientation 未指定＝既定値相当）しか
  // 通していなかった。Theater/Stage という非既定値の実往復（quickSave → quickLoad）を
  // 明示的に固定する (#681)。
  it('15: quickSave → quickLoad で cameraMode=Theater/cameraOrientation=Stage が往復保持される', () => {
    const data: SaveSlotData = {
      ...makeSaveData(),
      cameraMode: 'Theater',
      cameraOrientation: 'Stage',
    }
    manager.quickSave(data)
    const loaded = manager.quickLoad()
    expect(loaded?.cameraMode).toBe('Theater')
    expect(loaded?.cameraOrientation).toBe('Stage')
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

describe('SaveManager - importJSON バリデータ (#681)', () => {
  let manager: SaveManager

  beforeEach(() => {
    manager = new SaveManager('import-test')
    localStorage.clear()
  })

  // 17: importJSON() の形状バリデータ（eventIndex/textIndex/savedAt/flags/isBlackout/
  // characters の6フィールドのみ検査）は cameraMode/cameraOrientation を一切見ていない
  // （#378 と同型の型ギャップ）。この欠落オブジェクトが弾かれず正常取り込みされることを
  // 明示的にロックする（バリデータが将来 cameraMode を検査し始めたときの回帰にも
  // 気付けるよう、期待挙動を固定しておく）。
  it('17: cameraMode/cameraOrientation 欠落のスロットもバリデータに弾かれず正常取り込みされる', () => {
    const slotWithoutCamera = {
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
      // cameraMode/cameraOrientation は意図的に省略（#378型ギャップの明示ロック対象）
    }
    const json = JSON.stringify([slotWithoutCamera, null, null])

    const ok = manager.importJSON(json)

    expect(ok).toBe(true)
    const loaded = manager.load(0)
    expect(loaded).not.toBeNull()
    expect(loaded?.sceneId).toBe('scene-1')
    expect(loaded?.cameraMode).toBeUndefined()
    expect(loaded?.cameraOrientation).toBeUndefined()
  })
})

describe('SaveManager - カメラ仰角 (#682)', () => {
  let manager: SaveManager

  beforeEach(() => {
    manager = new SaveManager('elevation-test')
    localStorage.clear()
  })

  // 後方互換: #681 時点（cameraElevation フィールド追加前）に作られたクイックセーブ相当。
  // cameraElevation キー自体が存在しない生 JSON オブジェクトを直接 localStorage に書き、
  // quickLoad() がクラッシュしないこと・その結果を saveSlotToGameState() に渡すと
  // cameraElevation が null（水平・既定）にフォールバックすることを確認する
  // （backgroundFade/video の「欠如キーでクラッシュしない」テストと同型 #250/#252）。
  it('cameraElevation キー無しの旧クイックセーブ JSON を quickLoad してもクラッシュせず、saveSlotToGameState で null にフォールバックする', () => {
    const legacy = {
      slot: -1,
      sceneId: 'scene-1',
      eventIndex: 3,
      textIndex: 1,
      flags: { visited: { Bool: true } },
      backgroundPath: '/bg/room.png',
      isBlackout: false,
      characters: [{ name: 'Alice', expression: 'happy', position: 'center' }],
      currentBgmPath: '/bgm/main.mp3',
      cameraMode: 'Theater',
      cameraOrientation: 'Stage',
      // cameraElevation は意図的に省略（キー自体が JSON に存在しない #682 前フォーマット）
      savedAt: new Date().toISOString(),
      sceneName: 'シーン1',
    }
    localStorage.setItem('name-name-save-elevation-test-quick', JSON.stringify(legacy))

    expect(() => manager.quickLoad()).not.toThrow()
    const loaded = manager.quickLoad()
    expect(loaded).not.toBeNull()
    expect(loaded?.cameraElevation).toBeUndefined()

    const state = saveSlotToGameState(loaded as SaveSlotData, null)
    expect(state.cameraElevation).toBeNull()
  })
})

describe('SaveManager - 舞台構造の背景板 (#683)', () => {
  let manager: SaveManager

  beforeEach(() => {
    manager = new SaveManager('board-test')
    localStorage.clear()
  })

  // テスト観点1: backgroundBoards キー自体が存在しない旧形式セーブ（#683 実装前に作られたセーブ
  // 相当）を直接 localStorage に書き込み、load() がクラッシュしないこと・その結果を
  // saveSlotToGameState() に渡すと backgroundBoards が []（板なし）にフォールバックすることを
  // 確認する（backgroundFade/video/cameraElevation の「欠如キーでクラッシュしない」テストと
  // 同型 #250/#252/#682）。
  it('1: backgroundBoards キー無しの旧セーブ JSON を load してもクラッシュせず、saveSlotToGameState で [] にフォールバックする', () => {
    // 旧フォーマットを直接 localStorage に書く（backgroundBoards キー無し）
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
      // backgroundBoards は意図的に省略（キー自体が JSON に存在しない #683 前フォーマット）
      savedAt: new Date().toISOString(),
      sceneName: 'シーン1',
    }
    localStorage.setItem('name-name-save-board-test-0', JSON.stringify(legacy))

    expect(() => manager.load(0)).not.toThrow()
    const loaded = manager.load(0)
    expect(loaded).not.toBeNull()
    expect(loaded?.sceneId).toBe('scene-1')
    expect(loaded?.backgroundBoards).toBeUndefined()

    const state = saveSlotToGameState(loaded as SaveSlotData, null)
    expect(state.backgroundBoards).toEqual([])
  })

  // テスト観点2: backgroundBoards ありの新形式セーブが localStorage 往復（save → load）で
  // 値をそのまま保持し、saveSlotToGameState() を通した後も同じ配列が保持されることを確認する
  // （video 付きで save → load して全フィールドが保持されるテストと同型 #252）。
  it('2: backgroundBoards 付きで save → load → saveSlotToGameState で値が保持される（往復）', () => {
    const data: SaveSlotData = {
      ...makeSaveData(),
      slot: 0,
      backgroundBoards: [
        { path: 'sky.png', depth: 10 },
        { path: 'tree.png', depth: 4 },
      ],
    }
    manager.save(0, data)

    const loaded = manager.load(0)
    expect(loaded?.backgroundBoards).toEqual([
      { path: 'sky.png', depth: 10 },
      { path: 'tree.png', depth: 4 },
    ])

    const state = saveSlotToGameState(loaded as SaveSlotData, null)
    expect(state.backgroundBoards).toEqual([
      { path: 'sky.png', depth: 10 },
      { path: 'tree.png', depth: 4 },
    ])
  })
})
