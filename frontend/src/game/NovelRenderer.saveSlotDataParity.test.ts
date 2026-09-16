/**
 * openSaveMenu() / quickSave() が構築する SaveSlotData のパリティ回帰テスト (#716)。
 *
 * `NovelRenderer.openSaveMenu()`（private）と `quickSave()`（public）は、同じ
 * `getSnapshot()` から同じ `SaveSlotData` 構成を別々のオブジェクトリテラルとして手書き複製
 * している。この構造のため、過去に2回（#683 の backgroundBoards、#692 の props）
 * 「quickSave には足したが openSaveMenu には足し忘れる」という同種のフィールド追加漏れが
 * 起きた（#716 は openSaveMenu 側の追加漏れの修正）。
 *
 * このファイルでは:
 *   - N1/N2: openSaveMenu の保存コールバックが backgroundBoards/props をそのまま渡すこと
 *   - N3/N4: 実際に保存 → 別状態へ遷移 → ロードで backgroundBoards/props が保存前の状態へ
 *     真に復元されること（#716 が壊していた本丸）
 *   - A1/A2: 空配列でも例外なく保存・復元できること
 *   - S1/P1: quickSave() と openSaveMenu() が構築する SaveSlotData が、slot/savedAt を除く
 *     全フィールド（キー集合＋値）で一致するという構造的パリティ（最重要。個別フィールド名を
 *     列挙しないため、将来また同種のフィールド追加漏れが起きても機械的に検出できる）
 * を検証する。
 *
 * #717（PropLayer のレイヤー順 doc コメント修正）は挙動変更を伴わないため対象外
 * （実際のレイヤー順自体は NovelRenderer.prop.test.ts の init() テストで担保済み）。
 *
 * 駆動方式: openSaveMenu()/openLoadMenu() は private のため、
 * `internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 's' | 'l' }))` で到達する
 * （NovelRenderer.titleScreen.test.ts と同形）。保存/ロードコールバックの捕捉は
 * `saveLoadOverlay.showSave`/`showLoad` を spy し、渡されたコールバック自体を呼び出す
 * （実UIの pointerdown ハンドラが行う `onSave?.(i)` / `onLoad?.(slotData)` を模す）。
 * `saveManager.save`/`quickSave` の spy は NovelRenderer.newGameReset.test.ts の
 * `vi.spyOn(internals(r).saveManager, 'deleteQuickSave')` と同型の internals キャストパターン。
 *
 * localStorage は実際に書き込まれる（SaveManager をモックしないため）ので、他テストファイルの
 * SaveManager.test.ts と同じく beforeEach で毎回クリアする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { SaveSlotData } from './SaveManager'
import type { Event, EventScene } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function backgroundBoard(path: string, depth?: number): Event {
  return { BackgroundBoard: { path, depth } } as Event
}

function prop(path: string, depth?: number): Event {
  return { Prop: { path, depth } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/** 背景板2枚・大道具2つを持つシーン（N1〜N4/S1/P1 共通、非空・複数要素の前提を満たす）。 */
function sceneWithBoardsAndProps(tailEvents: Event[] = []): EventScene {
  return scene('a', [
    backgroundBoard('sky.png', 10),
    backgroundBoard('mountain.png', 7),
    prop('desk.png', 3),
    prop('chair.png', 1),
    narration('one'),
    ...tailEvents,
  ])
}

/** loadFromSaveData() 経由の ensureContext() 呼び出しを jsdom 環境で無害化する
 *  （NovelRenderer.loadFromSaveData.test.ts / NovelRenderer.titleScreen.test.ts と同じ流儀）。*/
function muteAudio(r: NovelRenderer): void {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}

/** private フィールドへ到達するための内部アクセサ（他 NovelRenderer.*.test.ts と同じ流儀）。 */
interface RendererInternals {
  handleKeyDown: (e: KeyboardEvent) => void
  saveLoadOverlay: {
    showSave: (onSave: (slot: number) => void) => void
    showLoad: (onLoad: (data: SaveSlotData) => void) => void
    hide: () => void
  }
  saveManager: {
    save: (slot: number, data: SaveSlotData) => void
    quickSave: (data: SaveSlotData) => void
    load: (slot: number) => SaveSlotData | null
  }
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/**
 * 's' キーで openSaveMenu() を発火し、`saveLoadOverlay.showSave` に渡された保存コールバックを
 * 捕捉して返す。
 */
function captureSaveCallback(r: NovelRenderer): (slot: number) => void {
  const showSaveSpy = vi.spyOn(internals(r).saveLoadOverlay, 'showSave')
  internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 's' }))
  const onSave = showSaveSpy.mock.calls[0]?.[0]
  if (!onSave) throw new Error('showSave が呼ばれなかった（openSaveMenu が発火しなかった）')
  return onSave
}

/**
 * 'l' キーで openLoadMenu() を発火し、`saveLoadOverlay.showLoad` に渡されたロードコールバックを
 * 捕捉して返す。
 */
function captureLoadCallback(r: NovelRenderer): (data: SaveSlotData) => void {
  const showLoadSpy = vi.spyOn(internals(r).saveLoadOverlay, 'showLoad')
  internals(r).handleKeyDown(new KeyboardEvent('keydown', { key: 'l' }))
  const onLoad = showLoadSpy.mock.calls[0]?.[0]
  if (!onLoad) throw new Error('showLoad が呼ばれなかった（openLoadMenu が発火しなかった）')
  return onLoad
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelRenderer openSaveMenu() の SaveSlotData 構築 (#716 正常系)', () => {
  it('N1: 保存コールバックが構築する SaveSlotData.backgroundBoards に、現在の getSnapshot().backgroundBoards（非空・複数要素）がそのまま渡る', () => {
    const r = new NovelRenderer()
    r.setScenes([sceneWithBoardsAndProps()])
    const expectedBoards = r.getSnapshot().backgroundBoards
    expect(expectedBoards.length).toBeGreaterThan(1) // 前提: 非空・複数要素

    const saveSpy = vi.spyOn(internals(r).saveManager, 'save')
    const onSave = captureSaveCallback(r)
    onSave(0)

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][1].backgroundBoards).toEqual(expectedBoards)
  })

  it('N2: 保存コールバックが構築する SaveSlotData.props に、現在の getSnapshot().props（非空・複数要素）がそのまま渡る', () => {
    const r = new NovelRenderer()
    r.setScenes([sceneWithBoardsAndProps()])
    const expectedProps = r.getSnapshot().props
    expect(expectedProps.length).toBeGreaterThan(1) // 前提: 非空・複数要素

    const saveSpy = vi.spyOn(internals(r).saveManager, 'save')
    const onSave = captureSaveCallback(r)
    onSave(0)

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][1].props).toEqual(expectedProps)
  })
})

describe('NovelRenderer openSaveMenu() → ロードの真のラウンドトリップ (#716 正常系、本丸)', () => {
  it('N3: openSaveMenu で保存したスロットをロードすると、getSnapshot().backgroundBoards が保存前と同一に復元される', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([sceneWithBoardsAndProps(['SceneTransition', narration('two')])])
    const savedBoards = r.getSnapshot().backgroundBoards
    expect(savedBoards.length).toBeGreaterThan(1) // 前提: 非空・複数要素

    const onSave = captureSaveCallback(r)
    onSave(0)
    internals(r).saveLoadOverlay.hide() // 実UIの pointerdown ハンドラ相当の後始末（visible ガード解除）

    // [場面転換] を経由して現在状態を変化させ、ロードが実際に復元したことを区別可能にする。
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().backgroundBoards).toEqual([]) // 保存時とは異なる状態になっている

    const savedData = internals(r).saveManager.load(0)
    if (!savedData) throw new Error('スロット0にセーブデータが無い')
    const onLoad = captureLoadCallback(r)
    onLoad(savedData)

    expect(r.getSnapshot().backgroundBoards).toEqual(savedBoards)
  })

  it('N4: 同様に props もロード後に保存前と同一に復元される', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([sceneWithBoardsAndProps(['SceneTransition', narration('two')])])
    const savedProps = r.getSnapshot().props
    expect(savedProps.length).toBeGreaterThan(1) // 前提: 非空・複数要素

    const onSave = captureSaveCallback(r)
    onSave(0)
    internals(r).saveLoadOverlay.hide()

    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().props).toEqual([]) // 保存時とは異なる状態になっている

    const savedData = internals(r).saveManager.load(0)
    if (!savedData) throw new Error('スロット0にセーブデータが無い')
    const onLoad = captureLoadCallback(r)
    onLoad(savedData)

    expect(r.getSnapshot().props).toEqual(savedProps)
  })
})

describe('NovelRenderer openSaveMenu() の SaveSlotData 構築/復元 (#716 異常系)', () => {
  it('A1: backgroundBoards/props が空配列の状態で保存しても例外なく、SaveSlotData.backgroundBoards/props が空配列のまま渡る', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])]) // ディレクティブなし → 空配列のまま
    expect(r.getSnapshot().backgroundBoards).toEqual([])
    expect(r.getSnapshot().props).toEqual([])

    const saveSpy = vi.spyOn(internals(r).saveManager, 'save')

    expect(() => {
      const onSave = captureSaveCallback(r)
      onSave(0)
    }).not.toThrow()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy.mock.calls[0][1].backgroundBoards).toEqual([])
    expect(saveSpy.mock.calls[0][1].props).toEqual([])
  })

  it('A2: その空配列セーブをロードしても getSnapshot().backgroundBoards/props が空配列のまま復元される', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    // 'one' で自動開始が停止する（冒頭にディレクティブが無い）ため、保存時点では空配列。
    r.setScenes([
      scene('a', [
        narration('one'),
        backgroundBoard('sky.png', 10),
        prop('desk.png', 3),
        narration('two'),
      ]),
    ])
    expect(r.getSnapshot().backgroundBoards).toEqual([])
    expect(r.getSnapshot().props).toEqual([])

    const onSave = captureSaveCallback(r)
    onSave(0)
    internals(r).saveLoadOverlay.hide()

    // ディレクティブを実行させ、現在状態を非空に変化させる（ロードが実際に復元したことの区別用）。
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 3 }])

    const savedData = internals(r).saveManager.load(0)
    if (!savedData) throw new Error('スロット0にセーブデータが無い')
    const onLoad = captureLoadCallback(r)
    onLoad(savedData)

    expect(r.getSnapshot().backgroundBoards).toEqual([])
    expect(r.getSnapshot().props).toEqual([])
  })
})

describe('NovelRenderer quickSave()/openSaveMenu() の SaveSlotData 構造的パリティ (#716 最重要)', () => {
  it('S1/P1: 同一スナップショット状態から quickSave() と openSaveMenu() が構築する SaveSlotData は、slot/savedAt を除く全フィールド（キー集合＋値）が一致する', () => {
    const r = new NovelRenderer()
    r.setScenes([sceneWithBoardsAndProps()])

    // quickSave() 側（public API、そのまま呼べる）。
    const quickSaveSpy = vi.spyOn(internals(r).saveManager, 'quickSave')
    expect(r.quickSave()).toBe(true)
    expect(quickSaveSpy).toHaveBeenCalledTimes(1)
    const quickSaveData = quickSaveSpy.mock.calls[0][0]

    // openSaveMenu() 側（同一スナップショット状態、slot は quickSave と意味的に異なる値を選ぶ）。
    const saveSpy = vi.spyOn(internals(r).saveManager, 'save')
    const onSave = captureSaveCallback(r)
    onSave(1)
    expect(saveSpy).toHaveBeenCalledTimes(1)
    const openSaveMenuData = saveSpy.mock.calls[0][1]

    // slot（quickSave=-1固定・openSaveMenu=選択スロットで意味的に異なる）と
    // savedAt（呼び出し時刻依存）は比較対象から除外する。
    const EXCLUDED_KEYS = new Set(['slot', 'savedAt'])

    // キー集合は完全一致するはず（将来どちらかにだけフィールドが増えたら即座に失敗する）。
    expect(Object.keys(openSaveMenuData).sort()).toEqual(Object.keys(quickSaveData).sort())

    // slot/savedAt 以外は値も deep equal のはず。
    for (const key of Object.keys(quickSaveData)) {
      if (EXCLUDED_KEYS.has(key)) continue
      const k = key as keyof SaveSlotData
      expect(openSaveMenuData[k]).toEqual(quickSaveData[k])
    }
  })
})
