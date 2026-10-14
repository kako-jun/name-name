/**
 * NovelRenderer のシーン入場 (#734 PR1) のレビュー指摘の回帰テスト。
 * - S1: 入場の適用が throw / reject しても、待っている Promise が必ず解決される
 * - S2: 入場を待つ間に弾かれたオート送り・スキップが、失敗後に再開される
 * - S3: 復元の遅延ロード中に [待機] が明けても、ユーザーのロードが破棄されない
 * - playScript の choice → advance が遷移先で消化される、確定音の抑止
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { NovelGameState } from './GameState'
import type { Event, EventScene } from '../types'
import { internals, type RendererInternals } from '../test/rendererInternals'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function jump(target: string): Event {
  return { Jump: { target } }
}
function wait(ms: number): Event {
  return { Wait: { ms } } as Event
}
function choice(...targets: string[]): Event {
  return { Choice: { options: targets.map((t) => ({ text: `to ${t}`, jump: t })) } } as Event
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface Internals extends RendererInternals {
  choiceOverlay: {
    show: (...args: unknown[]) => void
    setAudioManager: (a: unknown) => void
    confirmChoice: (jump: string) => void
  }
}
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function craftSnapshot(over: Partial<NovelGameState>): NovelGameState {
  return {
    sceneId: 'hub',
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

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeRenderer(
  scenes: EventScene[],
  resolver: ((id: string) => Promise<EventScene[] | null>) | null = null
): NovelRenderer {
  const r = new NovelRenderer()
  r.getTimeController().setMode('virtual')
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  internals<Internals>(r).initialized = true
  vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
  r.setScenes(scenes)
  r.setMissingSceneResolver(resolver)
  return r
}

const HUB = scene('hub', [narration('h1', 'h2'), choice('far')])
const FAR = scene('far', [narration('f1', 'f2')])

describe('S1: 入場の適用の例外でも Promise が解決される (#734)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  it('Jump 発火後の同期適用が throw しても、待っている Promise は failed で解決され、Jump は停止する', async () => {
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('b')]),
      scene('b', [narration('b1')]),
    ])
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    r.advance()
    const waiting = internals<Internals>(r).pendingEntry!.promise
    vi.spyOn(r as unknown as { startScene: () => void }, 'startScene').mockImplementationOnce(
      () => {
        throw new Error('boom')
      }
    )

    r.getTimeController().tick(1)

    await expect(waiting).resolves.toEqual({ status: 'failed', reason: 'apply-error' })
    expect(errSpy).toHaveBeenCalled()
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(internals<Internals>(r).pendingEntry).toBeNull()
  })

  it('遅延ロード後の適用が throw しても、入場の Promise は reject せず failed で解決され、ゲートが下りる', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer([HUB], () => d.promise)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(r as unknown as { startScene: () => void }, 'startScene').mockImplementationOnce(
      () => {
        throw new Error('boom')
      }
    )

    const entering = r.jumpToScene('far')
    d.resolve([HUB, FAR])

    await expect(entering).resolves.toEqual({ status: 'failed', reason: 'apply-error' })
    expect(errSpy).toHaveBeenCalled()
    expect(internals<Internals>(r).pendingEntry).toBeNull()
  })

  it('選択肢の確定で同期の適用が throw しても、未処理の rejection にならない', async () => {
    const r = makeRenderer([HUB, FAR])
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: unknown[][] = []
    vi.spyOn(internals<Internals>(r).choiceOverlay, 'show').mockImplementation(
      (...a: unknown[]) => {
        calls.push(a)
      }
    )
    r.advance()
    r.advance()
    const confirm = calls[calls.length - 1][1] as (jump: string) => boolean
    vi.spyOn(r as unknown as { startScene: () => void }, 'startScene').mockImplementationOnce(
      () => {
        throw new Error('boom')
      }
    )

    expect(() => confirm('far')).not.toThrow()
    await flush()
    expect(errSpy).toHaveBeenCalled()
    // 閉じていた選択肢が再表示され、詰まらない
    expect(calls.length).toBe(2)
    expect(internals<Internals>(r).waitingForChoice).toBe(true)
  })
})

describe('S2: オート送り・スキップの再開 (#734)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  it('オート中に復元が失敗しても、オート送りが再スケジュールされる', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer([HUB], () => d.promise)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    r.setAutoMode(true)
    const restoring = r.restoreSnapshot(craftSnapshot({ sceneId: 'gone' }))
    const autoSpy = vi.spyOn(internals<Internals>(r), 'scheduleAutoAdvance')

    d.resolve(null)
    await restoring

    expect(autoSpy).toHaveBeenCalled()
  })

  it('スキップ中に復元が失敗しても、スキップが再スケジュールされる', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer([HUB], () => d.promise)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    internals<Internals>(r).skipMode = true
    const restoring = r.restoreSnapshot(craftSnapshot({ sceneId: 'gone' }))
    const skipSpy = vi.spyOn(internals<Internals>(r), 'scheduleSkipStep')

    d.resolve(null)
    await restoring

    expect(skipSpy).toHaveBeenCalled()
  })
})

describe('成功側のオート再開 (#734)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  it('オート ON で非同期の復元が成功したあと、オート送りが再スケジュールされる', async () => {
    const d = deferred<EventScene[] | null>()
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')
    vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    internals<Internals>(r).initialized = true
    r.setScenes([HUB])
    r.setMissingSceneResolver(() => d.promise)
    r.setAutoMode(true)
    const dialog = (r as unknown as { dialogBox: Record<string, unknown> }).dialogBox
    const progressive = vi.spyOn(dialog as never, 'setNovelDialogProgressive')
    const plain = vi.spyOn(dialog as never, 'setDialog')

    const restoring = r.restoreSnapshot(craftSnapshot({ sceneId: 'far' }))
    d.resolve([HUB, FAR])
    await expect(restoring).resolves.toEqual({ status: 'entered', sceneId: 'far' })

    // 復元後の描画で、タイプ完了時のオート送りコールバックが張られている（オートが止まらない）
    const calls = [...progressive.mock.calls, ...plain.mock.calls] as unknown[][]
    expect(calls.length).toBeGreaterThan(0)
    const last = calls[calls.length - 1]
    expect(typeof last[last.length - 1]).toBe('function')
  })
})

describe('S3: 復元の遅延ロード中の [待機] (#734)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  const WAITING = scene('hub', [narration('h1'), wait(50), narration('after')])

  it('[待機] が明けても入場の決着まで進めず、復元が成功するとそのまま適用される', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer([WAITING], () => d.promise)
    r.advance() // [待機] に到達
    expect(internals<Internals>(r).waitingForWait).toBe(true)
    const indexAtWait = internals<Internals>(r).eventIndex

    const restoring = r.restoreSnapshot(craftSnapshot({ sceneId: 'far' }))
    r.getTimeController().tick(60) // waitTimer 発火
    expect(internals<Internals>(r).eventIndex).toBe(indexAtWait)

    d.resolve([WAITING, FAR])
    await expect(restoring).resolves.toEqual({ status: 'entered', sceneId: 'far' })
    expect(r.getCurrentSceneId()).toBe('far')
    expect(internals<Internals>(r).waitingForWait).toBe(false)
  })

  it('待っていた復元 A が別の復元 B に置き換えられて決着しても [待機] は明けず、B の決着後に明ける（B 成功時は明けない）', async () => {
    const OTHER = scene('other', [narration('o1')])
    for (const bSucceeds of [true, false]) {
      const dA = deferred<EventScene[] | null>()
      const dB = deferred<EventScene[] | null>()
      const r = makeRenderer([WAITING], (id) => (id === 'far' ? dA.promise : dB.promise))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      r.advance()
      const indexAtWait = internals<Internals>(r).eventIndex

      void r.restoreSnapshot(craftSnapshot({ sceneId: 'far' })) // A
      r.getTimeController().tick(60) // waitTimer 発火 → A の決着待ち
      const restoringB = r.restoreSnapshot(craftSnapshot({ sceneId: 'other' })) // A を置換
      dA.resolve([WAITING, FAR])
      await flush()

      // B の待機中に [待機] が明けてはいけない（明けると世代が進み B が破棄される）
      expect(internals<Internals>(r).waitingForWait).toBe(true)
      expect(internals<Internals>(r).eventIndex).toBe(indexAtWait)

      dB.resolve(bSucceeds ? [WAITING, OTHER] : null)
      await restoringB
      await flush()
      if (bSucceeds) {
        expect(r.getCurrentSceneId()).toBe('other')
        expect(internals<Internals>(r).waitingForWait).toBe(false)
        expect(internals<Internals>(r).eventIndex).toBe(0) // 待機明けで進んでいない
      } else {
        expect(internals<Internals>(r).waitingForWait).toBe(false)
        expect(internals<Internals>(r).eventIndex).toBeGreaterThan(indexAtWait)
      }
    }
  })

  it('復元が失敗したときは、保留していた [待機] 明けが再開される', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer([WAITING], () => d.promise)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    r.advance()
    const indexAtWait = internals<Internals>(r).eventIndex

    const restoring = r.restoreSnapshot(craftSnapshot({ sceneId: 'gone' }))
    r.getTimeController().tick(60)
    d.resolve(null)
    await restoring
    await flush()

    expect(internals<Internals>(r).waitingForWait).toBe(false)
    expect(internals<Internals>(r).eventIndex).toBeGreaterThan(indexAtWait)
  })
})

describe('playScript と確定音 (#734)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  it('choice:<未ロード> の後の advance は、遷移先のシーンで消化される', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer([HUB], () => d.promise)
    vi.spyOn(internals<Internals>(r).choiceOverlay, 'show').mockImplementation(() => {})
    setTimeout(() => d.resolve([HUB, FAR]), 0)

    await r.playScript([
      { type: 'advance' },
      { type: 'advance' },
      { type: 'choice', jump: 'far' },
      { type: 'advance' },
    ])

    expect(r.getCurrentSceneId()).toBe('far')
    expect(r.getSnapshot().textIndex).toBe(1) // 遷移先の2行目に着く
  })

  it('ゲートで弾かれた選択肢の確定では確定音を鳴らさず、通常時は鳴らす', async () => {
    const d = deferred<EventScene[] | null>()
    const r = makeRenderer([HUB], () => d.promise)
    const overlay = internals<Internals>(r).choiceOverlay
    overlay.setAudioManager(r.getAudioManager())
    const toneSpy = vi.spyOn(r.getAudioManager(), 'playSelectTone').mockImplementation(() => {})
    r.advance()
    r.advance() // Choice 表示

    void r.restoreSnapshot(craftSnapshot({ sceneId: 'far' })) // 遅延ロード中 = 入場中ゲート
    overlay.confirmChoice('far')
    expect(toneSpy).not.toHaveBeenCalled()

    d.resolve([HUB, FAR])
    await flush()
    // 入場が済んだ後の通常の確定は鳴る
    const calls: unknown[][] = []
    vi.spyOn(overlay, 'show').mockImplementation((...a: unknown[]) => {
      calls.push(a)
    })
    r.setScenes([HUB, FAR])
    r.advance()
    r.advance()
    overlay.confirmChoice('far')
    expect(toneSpy).toHaveBeenCalledTimes(1)
  })
})
