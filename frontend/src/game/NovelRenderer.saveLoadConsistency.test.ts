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
import { internals, type SaveInternals } from '../test/rendererInternals'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function condition(flag: string, events: Event[]): Event {
  return { Condition: { flag, events } }
}
function wait(ms: number): Event {
  return { Wait: { ms } } as Event
}
function choice(...targets: string[]): Event {
  return { Choice: { options: targets.map((t) => ({ text: `to ${t}`, jump: t })) } } as Event
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

  it('複数シーンのエントリで startFrom({})（はじめから）した後にセーブ→ロードすると、同じ位置に戻る (M2)', async () => {
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
    void r.startFrom({})
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

describe('シーン入場後の自動セーブは最初の本文の表示時に1回行う (#768)', () => {
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const A = scene('a', [narration('a1'), jump('b')])

  /** 自動セーブを NovelPlayer と同じ配線にした renderer。A の本文から始めて advance で Jump に到達する。 */
  async function wired(others: EventScene[]): Promise<NovelRenderer> {
    const r = prepare(new NovelRenderer())
    r.setJumpSceneIndex([A, ...others])
    r.loadEvents(A.events)
    await r.startFrom({})
    r.setOnSceneChange(() => r.requestAutoSave())
    r.advance() // Jump に到達し予約
    return r
  }

  it('冒頭が [待機] のシーンへ Jump で入った後、待機明けの最初の本文で保存される（位置はその本文）', async () => {
    const B = scene('b', [wait(100), narration('b1'), narration('b2')])
    const r = await wired([B])
    r.getTimeController().tick(1)
    await flush()
    expect(r.getCurrentSceneId()).toBe('b')
    expect(new SaveManager().hasQuickSave()).toBe(false) // 待機中は保存しない

    r.getTimeController().tick(100)
    await flush()

    const saved = new SaveManager().quickLoad()
    expect(saved?.sceneId).toBe('b')
    expect(saved?.eventIndex).toBe(1) // 待機の次の本文

    // ロードすると待機を挟まずその本文から再開できる
    const r2 = prepare(new NovelRenderer())
    r2.setJumpSceneIndex([A, B])
    r2.loadEvents(A.events)
    await r2.startFrom({})
    await expect(r2.quickLoad()).resolves.toEqual({ status: 'entered', sceneId: 'b' })
    expect(internals(r2).eventIndex).toBe(1)
    expect(internals(r2).waitingForWait).toBe(false)
  })

  it('冒頭が Jump だけの中継シーンでは保存されず、遷移先の本文で保存される', async () => {
    const B = scene('b', [jump('c')])
    const C = scene('c', [narration('c1')])
    const r = await wired([B, C])
    const quickSave = vi.spyOn(internals<SaveInternals>(r).saveManager, 'quickSave')
    r.getTimeController().tick(1) // b（中継）→ c と連続して入場
    await flush()
    r.getTimeController().tick(1)
    await flush()

    expect(r.getCurrentSceneId()).toBe('c')
    // 中継の b では保存されず、遷移先 c の本文で1回だけ保存される
    expect(quickSave).toHaveBeenCalledTimes(1)
    expect(quickSave.mock.calls[0][0].sceneId).toBe('c')
  })

  it('冒頭が選択肢のシーンでは入場時に保存せず、選択肢確定後の遷移先の本文で保存される', async () => {
    const B = scene('b', [choice('c')])
    const C = scene('c', [narration('c1')])
    const r = await wired([B, C])
    let confirm!: (jump: string) => void
    vi.spyOn(
      (r as unknown as { choiceOverlay: { show: (...a: unknown[]) => void } }).choiceOverlay,
      'show'
    ).mockImplementation((...a: unknown[]) => {
      confirm = a[1] as (jump: string) => void
    })
    r.getTimeController().tick(1)
    await flush()
    expect(r.getCurrentSceneId()).toBe('b')
    expect(new SaveManager().hasQuickSave()).toBe(false)

    confirm('c')
    await flush()

    expect(new SaveManager().quickLoad()?.sceneId).toBe('c')
  })

  it('待機中に別の位置を復元すると、保留中の自動セーブは破棄される', async () => {
    const B = scene('b', [wait(100), narration('b1')])
    const r = await wired([B])
    r.getTimeController().tick(1)
    await flush()
    expect(r.getCurrentSceneId()).toBe('b')

    await r.restoreSnapshot(craftSnapshot({ sceneId: 'a', eventIndex: 0 }))
    r.getTimeController().tick(200)
    await flush()

    expect(new SaveManager().hasQuickSave()).toBe(false)
  })

  it('冒頭が本文のシーンへ入場後、スキップで複数本文を進めても保存は1回・位置は最初の本文・トーストなし', async () => {
    const B = scene('b', [narration('b1'), narration('b2'), narration('b3'), narration('b4')])
    const r = await wired([B])
    const quickSave = vi.spyOn(internals<SaveInternals>(r).saveManager, 'quickSave')
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    r.getTimeController().tick(1)
    await flush()
    expect(r.getCurrentSceneId()).toBe('b')

    r.setSkipMode(true)
    r.advance()
    r.advance()
    r.advance()
    r.getTimeController().tick(1000)
    await flush()

    expect(internals(r).eventIndex).toBeGreaterThan(0)
    expect(quickSave).toHaveBeenCalledTimes(1)
    expect(quickSave.mock.calls[0][0].eventIndex).toBe(0)
    expect(toast).not.toHaveBeenCalled()
  })
})
