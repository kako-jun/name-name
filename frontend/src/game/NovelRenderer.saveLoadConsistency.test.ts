/**
 * sceneId が null のセーブ/ロード (#768)。
 * シーン索引を使わない線形ストリーム（`loadEvents`。PlayerScreen の通常再生）はジャンプするまで
 * currentSceneId が null のまま。この局面でもセーブは成立する（セーブを無効にすると、ジャンプの無い
 * 単一 MD の作品がセーブできなくなる）。null は「エントリ文書の線形ストリーム上の位置」を意味するので、
 * ロードは eventIndex でその位置へ復元する。エントリ文書が無いときだけ復元失敗。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import { SaveManager } from './SaveManager'
import type { NovelGameState } from './GameState'
import type { Event, EventScene, FlagValue } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function condition(flag: string, events: Event[]): Event {
  return { Condition: { flag, events } }
}
function jump(target: string): Event {
  return { Jump: { target } }
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}
function seedNullSave(over: { eventIndex: number; flags?: Record<string, FlagValue> }): void {
  new SaveManager().quickSave({
    slot: -1,
    sceneId: null,
    eventIndex: over.eventIndex,
    textIndex: 0,
    flags: over.flags ?? {},
    backgroundPath: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    savedAt: new Date().toISOString(),
    sceneName: null,
  })
}
const boolFlag = (b: boolean): FlagValue => ({ Bool: b })

interface Internals {
  initialized: boolean
  eventIndex: number
  resolvedEvents: Event[]
  storyEnded: boolean
  waitingForWait: boolean
  jumpState: 'idle' | 'pending' | 'stalled'
  pendingEntry: unknown
  rawEvents: Event[]
  render(): void
}
function internals(r: NovelRenderer): Internals {
  return r as unknown as Internals
}

function prepare(r: NovelRenderer): NovelRenderer {
  r.getTimeController().setMode('virtual')
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  internals(r).initialized = true
  vi.spyOn(internals(r), 'render').mockImplementation(() => {})
  return r
}

/** PlayerScreen の通常再生と同じ: 線形ストリーム（エントリ文書）を loadEvents で読み込み、先頭から開始。sceneId は null。 */
async function linearRenderer(events: Event[]): Promise<NovelRenderer> {
  const r = prepare(new NovelRenderer())
  r.loadEvents(events)
  await r.startFrom({})
  return r
}

function craftSnapshot(over: Partial<NovelGameState>): NovelGameState {
  return {
    sceneId: null,
    eventIndex: 0,
    textIndex: 0,
    sentenceIndex: 0,
    flags: {},
    backgroundPath: null,
    backgroundColor: null,
    backgroundFade: null,
    backgroundBrightness: null,
    video: null,
    eventImage: null,
    backgroundBoards: [],
    props: [],
    spotlight: null,
    curtain: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    cameraMode: 'Novel',
    cameraOrientation: 'Audience',
    cameraElevation: null,
    paperDollOutline: null,
    storyEnded: false,
    ...over,
  }
}

const LINEAR: Event[] = [
  narration('l0'),
  narration('l1'),
  narration('l2'),
  condition('seen', [narration('c1'), narration('c2')]),
  narration('l3'),
]

beforeEach(() => {
  new SaveManager().deleteQuickSave()
})
afterEach(() => {
  new SaveManager().deleteQuickSave()
  vi.restoreAllMocks()
  defaultTimeController.setMode('live')
  localStorage.clear()
})

describe('sceneId が null のセーブとロード (#768)', () => {
  it('線形ストリーム（sceneId null）でもセーブでき、sceneId null で保存される', async () => {
    const r = await linearRenderer(LINEAR)
    expect(r.getCurrentSceneId()).toBeNull()
    r.advance()
    expect(r.quickSave()).toBe(true)
    const saved = new SaveManager().quickLoad()
    expect(saved?.sceneId).toBeNull()
    expect(saved?.eventIndex).toBe(1)
  })

  it('null セーブのロード: eventIndex の位置と flags を復元し、成功トーストを出す', async () => {
    const r = await linearRenderer(LINEAR)
    r.advance()
    r.advance()
    expect(r.quickSave()).toBe(true)
    r.advance()
    expect(internals(r).eventIndex).toBe(3)
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})

    await expect(r.quickLoad()).resolves.toEqual({ status: 'entered', sceneId: null })

    expect(internals(r).eventIndex).toBe(2)
    expect(r.getCurrentSceneId()).toBeNull()
    expect(toast).toHaveBeenCalledWith('クイックロードしました')
  })

  it('null セーブのロードは flags に合わせて展開を引き直す（flags と位置が一致する）', async () => {
    const saver = await linearRenderer(LINEAR)
    saver.advance()
    saver.advance()
    saver.advance()
    // flags seen=true の展開済みストリーム上の位置として保存したものを手で作る
    new SaveManager().quickSave({
      slot: -1,
      sceneId: null,
      eventIndex: 4,
      textIndex: 0,
      flags: { seen: boolFlag(true) },
      backgroundPath: null,
      isBlackout: false,
      characters: [],
      currentBgmPath: null,
      savedAt: new Date().toISOString(),
      sceneName: null,
    })

    const r = await linearRenderer(LINEAR)
    expect(internals(r).resolvedEvents.length).toBe(LINEAR.length - 1) // seen 無し: Condition は展開されない
    await r.quickLoad()

    expect(r.getSnapshot().flags).toEqual({ seen: boolFlag(true) })
    expect(internals(r).eventIndex).toBe(4)
    expect(internals(r).resolvedEvents.length).toBe(LINEAR.length + 1) // seen=true: 2 件展開
  })

  it('エントリ文書が読み込まれていない renderer では null セーブのロードは失敗: flags も位置も変えず、失敗トースト', async () => {
    new SaveManager().quickSave({
      slot: -1,
      sceneId: null,
      eventIndex: 2,
      textIndex: 0,
      flags: { fromSave: boolFlag(true) },
      backgroundPath: null,
      isBlackout: false,
      characters: [],
      currentBgmPath: null,
      savedAt: new Date().toISOString(),
      sceneName: null,
    })
    const r = prepare(new NovelRenderer())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})

    await expect(r.quickLoad()).resolves.toMatchObject({ status: 'failed', reason: 'not-found' })

    expect(r.getSnapshot().flags).toEqual({})
    expect(toast).toHaveBeenCalledWith('ロードに失敗しました')
    expect(toast).not.toHaveBeenCalledWith('クイックロードしました')
  })

  it('restoreSnapshot も sceneId null のスナップショットで位置を復元する（flags だけにしない）', async () => {
    const r = await linearRenderer(LINEAR)
    await expect(
      r.restoreSnapshot(craftSnapshot({ eventIndex: 2, flags: { fresh: boolFlag(true) } }))
    ).resolves.toEqual({ status: 'entered', sceneId: null })
    expect(internals(r).eventIndex).toBe(2)
    expect(r.getSnapshot().flags).toEqual({ fresh: boolFlag(true) })
  })

  it('別シーンへジャンプした後に null セーブをロードすると、イベント列はエントリ文書に戻り currentSceneId は null', async () => {
    const OTHER = scene('other', [narration('o0'), narration('o1')])
    const r = prepare(new NovelRenderer())
    r.setJumpSceneIndex([OTHER])
    r.loadEvents(LINEAR)
    await r.startFrom({})
    seedNullSave({ eventIndex: 1 })
    await r.jumpToScene('other')
    expect(r.getCurrentSceneId()).toBe('other')
    expect(internals(r).rawEvents).toEqual(OTHER.events)

    await expect(r.quickLoad()).resolves.toEqual({ status: 'entered', sceneId: null })

    expect(r.getCurrentSceneId()).toBeNull()
    expect(internals(r).rawEvents).toEqual(LINEAR)
    expect(internals(r).eventIndex).toBe(1)
    expect(internals(r).resolvedEvents[1]).toEqual(LINEAR[1])
  })

  it('null セーブの eventIndex が Jump を指す: 復元後に Jump が再アームされる', async () => {
    const FAR = scene('far', [narration('far-1')])
    const r = prepare(new NovelRenderer())
    r.setJumpSceneIndex([FAR])
    r.loadEvents([narration('l0'), jump('far')])
    await r.startFrom({})
    seedNullSave({ eventIndex: 1 })

    await r.quickLoad()

    expect(internals(r).eventIndex).toBe(1)
    expect(internals(r).jumpState).toBe('pending')
  })

  it('複数シーンのエントリで restart（はじめから）した後にセーブ→ロードすると、同じ位置に戻る (M2)', async () => {
    const S1 = scene('s1', [narration('a0'), narration('a1')])
    const S2 = scene('s2', [narration('b0'), narration('b1'), narration('b2')])
    const flat = [...S1.events, ...S2.events]
    const r = prepare(new NovelRenderer())
    r.setJumpSceneIndex([S1, S2])
    r.loadEvents(flat)
    await r.startFrom({})
    r.advance()
    r.advance()
    r.advance()
    r.restart()
    expect(r.getCurrentSceneId()).toBeNull()
    r.advance()
    r.advance()
    r.advance()
    r.advance() // S1 の events 長（2）を超えた位置
    const pos = internals(r).eventIndex
    expect(pos).toBeGreaterThanOrEqual(S1.events.length)
    expect(r.quickSave()).toBe(true)
    r.advance()

    await expect(r.quickLoad()).resolves.toMatchObject({ status: 'entered' })

    expect(internals(r).eventIndex).toBe(pos)
    expect(internals(r).rawEvents).toEqual(flat)
  })
})
