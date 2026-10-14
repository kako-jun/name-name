/**
 * getSnapshot() と クイックセーブ/スロット保存の SaveSlotData の JSON 回帰テスト (#822, ADR 0002)。
 *
 * #735 の分割では `saveQuick` / `openSaveMenu` の写像や `getDebugState` の整形などを純粋関数へ出す。
 * それらが「JSON にしたとき PR の前後で 1 バイトも変わらない」ことを、期待 JSON の固定で保護する
 * （ADR 0002: 完全シリアライズ。キーの欠落・追加・順序変更をすべて検出する）。
 *
 * 期待 JSON(getDebugState を含む)は、リファクタ前の実装（origin/main の `NovelRenderer.ts`）で同じシナリオを実測して得た値。
 * 実測手順: `git show origin/main:frontend/src/game/NovelRenderer.ts > frontend/src/game/NovelRendererOld.ts`
 * を一時的に置き、本テストの import だけを `./NovelRendererOld` に差し替えて実行すると、同じ値で緑になる
 * （確認後に一時ファイルを消す。コミットしない）。
 *
 * シナリオ: Flag 後に Condition が展開され、単色背景・背景画像(明るさ・端フェード)・背景板・大道具・
 * カメラ・立ち絵が乗った状態。jsdom で到達できる（実描画に依存しない）範囲。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { SaveSlotData } from './SaveManager'
import { internals, type RendererInternals } from '../test/rendererInternals'

const narr = (s: string): Event => ({ Narration: { text: [s] } })
const scene = (id: string, title: string, events: Event[]): EventScene => ({
  id,
  title,
  view: 'TopDown',
  events,
})

const SCENES: EventScene[] = [
  scene('a', 'シーンA', [
    narr('n0'),
    { Flag: { name: 'seen', value: { Bool: true } } },
    { Condition: { flag: 'seen', events: [{ Flag: { name: 'inner', value: { Number: 2 } } }] } },
    { BackgroundColor: { color: '#112233' } },
    { Background: { path: 'bg/room.png', brightness: 0.6, fade_top: 10 } } as Event,
    { BackgroundBoard: { path: 'board.png', depth: 3 } },
    { Prop: { path: 'desk.png', depth: 1 } },
    { CameraMode: { mode: 'Theater', orientation: 'Stage' } } as Event,
    { Dialog: { character: 'a', expression: 'a/smile', position: 'Left', text: ['d0'] } },
  ]),
]

interface LocalInternals extends RendererInternals {
  saveManager: {
    save: (slot: number, data: SaveSlotData) => void
    quickSave: (data: SaveSlotData) => void
  }
  saveLoadOverlay: { showSave: (cb: (slot: number) => void) => void; hide: () => void }
  handleKeyDown: (e: KeyboardEvent) => void
}

/** 期待値(origin/main の実装で実測)。 */
const EXPECTED_SNAPSHOT_JSON =
  '{"sceneId":"a","eventIndex":8,"textIndex":0,"sentenceIndex":0,"flags":{"seen":{"Bool":true},"inner":{"Number":2}},"backgroundPath":"bg/room.png","backgroundColor":"#112233","backgroundFade":{"top":10},"backgroundBrightness":0.6,"video":null,"eventImage":null,"backgroundBoards":[{"path":"board.png","depth":3}],"props":[{"path":"desk.png","depth":1}],"spotlight":null,"curtain":null,"isBlackout":false,"characters":[{"name":"a","expression":"a/smile","position":"left","depth":0}],"currentBgmPath":null,"cameraMode":"Theater","cameraOrientation":"Stage","cameraElevation":null,"paperDollOutline":null,"storyEnded":false}'
const EXPECTED_QUICKSAVE_JSON =
  '{"slot":-1,"sceneId":"a","eventIndex":8,"textIndex":0,"sentenceIndex":0,"flags":{"seen":{"Bool":true},"inner":{"Number":2}},"backgroundPath":"bg/room.png","backgroundColor":"#112233","backgroundFade":{"top":10},"backgroundBrightness":0.6,"video":null,"eventImage":null,"backgroundBoards":[{"path":"board.png","depth":3}],"props":[{"path":"desk.png","depth":1}],"spotlight":null,"curtain":null,"isBlackout":false,"characters":[{"name":"a","expression":"a/smile","position":"left","depth":0}],"currentBgmPath":null,"cameraMode":"Theater","cameraOrientation":"Stage","cameraElevation":null,"paperDollOutline":null,"savedAt":"2026-10-15T00:00:00.000Z","sceneName":"シーンA"}'
const EXPECTED_DEBUG_JSON =
  '{"eventIndex":8,"eventCount":9,"eventKind":"Dialog","eventText":"\\"d0\\"","autoMode":false,"waitingForChoice":false,"waitingForWait":false,"jumpState":"idle","currentResolvedFontFamily":null,"sceneId":"a","audioWarning":null,"characters":[{"name":"a","expression":"a/smile","position":"left","depth":0,"x":150,"y":450,"scale":1}]}'
const EXPECTED_SLOT_JSON =
  '{"slot":3,"sceneId":"a","eventIndex":8,"textIndex":0,"sentenceIndex":0,"flags":{"seen":{"Bool":true},"inner":{"Number":2}},"backgroundPath":"bg/room.png","backgroundColor":"#112233","backgroundFade":{"top":10},"backgroundBrightness":0.6,"video":null,"eventImage":null,"backgroundBoards":[{"path":"board.png","depth":3}],"props":[{"path":"desk.png","depth":1}],"spotlight":null,"curtain":null,"isBlackout":false,"characters":[{"name":"a","expression":"a/smile","position":"left","depth":0}],"currentBgmPath":null,"cameraMode":"Theater","cameraOrientation":"Stage","cameraElevation":null,"paperDollOutline":null,"savedAt":"2026-10-15T00:00:00.000Z","sceneName":"シーンA"}'

async function playToEnd(): Promise<NovelRenderer> {
  const r = new NovelRenderer()
  r.setScenes(SCENES)
  await r.playScript([{ type: 'advance' }])
  return r
}

describe('getSnapshot() / SaveSlotData の JSON 回帰 (#822, ADR 0002)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('前提: シナリオが期待どおり進んでいる(Flag 後の Condition 展開・演出状態が乗っている)', async () => {
    const r = await playToEnd()
    const s = r.getSnapshot()
    expect(s.flags).toEqual({ seen: { Bool: true }, inner: { Number: 2 } })
    expect(s.eventIndex).toBe(8)
    expect(s.characters.length).toBe(1)
    expect(s.cameraMode).toBe('Theater')
  })

  it('getSnapshot() の JSON(キー順・値)が固定された期待と一致する', async () => {
    const r = await playToEnd()
    expect(JSON.stringify(r.getSnapshot())).toBe(EXPECTED_SNAPSHOT_JSON)
  })

  it('quickSave() が保存する SaveSlotData の JSON が固定された期待と一致する(storyEnded を含まない)', async () => {
    const r = await playToEnd()
    const spy = vi.spyOn(internals<LocalInternals>(r).saveManager, 'quickSave')
    expect(r.quickSave()).toBe(true)
    expect(JSON.stringify(spy.mock.calls[0][0])).toBe(EXPECTED_QUICKSAVE_JSON)
  })

  it('スロット保存(openSaveMenu)の SaveSlotData の JSON も固定された期待と一致する', async () => {
    const r = await playToEnd()
    const li = internals<LocalInternals>(r)
    const show = vi.spyOn(li.saveLoadOverlay, 'showSave')
    li.handleKeyDown(new KeyboardEvent('keydown', { key: 's' }))
    const onSave = show.mock.calls[0]?.[0]
    if (!onSave) throw new Error('showSave が呼ばれなかった')
    const save = vi.spyOn(li.saveManager, 'save')
    onSave(3)
    expect(JSON.stringify(save.mock.calls[0][1])).toBe(EXPECTED_SLOT_JSON)
  })

  it('getDebugState() の JSON も固定された期待と一致する(整形の切り出し保護。x/y/scale は立ち絵 sprite の実測)', async () => {
    const r = await playToEnd()
    expect(JSON.stringify(r.getDebugState())).toBe(EXPECTED_DEBUG_JSON)
  })
})
