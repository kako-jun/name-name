/**
 * NovelRenderer の getPendingChoice / selectPendingChoice (#780, 動画書き出しの自動選択用)。
 * 選択は ChoiceOverlay のクリックと同じ確定経路を通ることを確かめる。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import { internalsOf } from '../test/rendererInternals'
import type { Event, EventScene } from '../types'

const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface Internals {
  initialized: boolean
  waitingForChoice: boolean
  render(): void
}

function makeAtChoice(): NovelRenderer {
  const hub = scene('hub', [
    narration('hub-line'),
    {
      Choice: {
        options: [
          { text: 'locked', jump: 'near', condition: 'key' },
          { text: 'far', jump: 'far' },
        ],
      },
    } as Event,
  ])
  const r = new NovelRenderer()
  r.getTimeController().setMode('virtual')
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  const i = internalsOf<Internals>(r)
  i.initialized = true
  vi.spyOn(i, 'render').mockImplementation(() => {})
  r.setScenes([
    hub,
    scene('near', [narration('n')]),
    scene('far', [narration('f')]),
    scene('other', [
      narration('o'),
      { Choice: { options: [{ text: 'far', jump: 'far' }] } } as Event,
    ]),
  ])
  return r
}

afterEach(() => {
  vi.restoreAllMocks()
  defaultTimeController.setMode('live')
  localStorage.clear()
})

describe('NovelRenderer.getPendingChoice / selectPendingChoice (#780)', () => {
  it('選択肢待ちでなければ null・選べない', async () => {
    const r = makeAtChoice()
    expect(r.getPendingChoice()).toBeNull()
    expect(r.selectPendingChoice('far')).toBe(false)
  })

  it('選択肢待ちでは遷移先とロック状態を返す', () => {
    const r = makeAtChoice()
    r.advance()
    expect(r.getPendingChoice()).toEqual({
      key: expect.stringMatching(/^choice#\d+$/),
      sceneId: 'hub',
      options: [
        { jump: 'near', locked: true },
        { jump: 'far', locked: false },
      ],
    })
  })

  it('ロック中・存在しない遷移先は選べず、選択肢待ちのまま', () => {
    const r = makeAtChoice()
    r.advance()
    expect(r.selectPendingChoice('near')).toBe(false)
    expect(r.selectPendingChoice('nowhere')).toBe(false)
    expect(internalsOf<Internals>(r).waitingForChoice).toBe(true)
  })

  it('ロックされていない遷移先を選ぶと、クリックと同じ経路で選択肢が閉じて入場する', async () => {
    const r = makeAtChoice()
    r.advance()
    expect(r.selectPendingChoice('far')).toBe(true)
    expect(internalsOf<Internals>(r).waitingForChoice).toBe(false)
    expect(r.getPendingChoice()).toBeNull()
    await new Promise((res) => setTimeout(res, 0))
    expect(r.getCurrentSceneId()).toBe('far')
  })

  it('自動選択もクリックと同じ確定音を鳴らし、受け付けられなかったときは鳴らさない', async () => {
    const r = makeAtChoice()
    const tone = vi.spyOn(r.getAudioManager(), 'playSelectTone').mockImplementation(() => {})
    r.advance()
    expect(r.selectPendingChoice('near')).toBe(false) // ロック中
    expect(tone).not.toHaveBeenCalled()
    expect(r.selectPendingChoice('far')).toBe(true)
    expect(tone).toHaveBeenCalledTimes(1)
  })
})

describe('NovelRenderer.getExportProgress (#780)', () => {
  it('位置を返し、待機中でなければ waitMs は null・動画も再生していない', () => {
    const r = makeAtChoice()
    const p = r.getExportProgress()
    expect(p).toMatchObject({ eventIndex: 0, textIndex: 0, sentenceIndex: 0 })
    expect(p.waitMs).toBeNull()
    expect(p.videoPlaying).toBe(false)
  })

  it('[待機: N] の最中は waitMs に N を返す', () => {
    const wait = scene('w', [{ Wait: { ms: 80000 } } as Event, narration('after')])
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')
    vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    const i = internalsOf<Internals>(r)
    i.initialized = true
    vi.spyOn(i, 'render').mockImplementation(() => {})
    r.setScenes([wait])
    r.setEvents(wait.events)
    expect(r.getExportProgress().waitMs).toBe(80000)
  })
  it('選択肢のキーは、入場経路が変わっても同じ選択肢なら同じ', async () => {
    const r = makeAtChoice()
    r.advance()
    const k1 = r.getPendingChoice()?.key
    expect(k1).toBeDefined()
    // 別のシーンへ進んでからジャンプで戻り、同じ選択肢に再到達する
    expect(r.selectPendingChoice('far')).toBe(true)
    await new Promise((res) => setTimeout(res, 0))
    await r.jumpToScene('hub')
    r.advance()
    expect(r.getPendingChoice()?.key).toBe(k1)
    // startFrom（新規開始）で同じシーンに入っても同じ
    await r.startFrom({ sceneId: 'hub' })
    r.advance()
    expect(r.getPendingChoice()?.key).toBe(k1)
  })

  it('別の選択肢には別のキー', async () => {
    const r = makeAtChoice()
    r.advance()
    const k1 = r.getPendingChoice()?.key
    expect(r.selectPendingChoice('far')).toBe(true)
    await new Promise((res) => setTimeout(res, 0))
    await r.jumpToScene('other')
    r.advance()
    const k2 = r.getPendingChoice()?.key
    expect(k2).toBeDefined()
    expect(k2).not.toBe(k1)
  })
})

describe('NovelRenderer.cancelPendingEntry / isReady (#780)', () => {
  it('入場中でなければ何もしない・初期化済みなら isReady', () => {
    const r = makeAtChoice()
    expect(r.isReady()).toBe(true)
    r.cancelPendingEntry()
    expect(r.isReady()).toBe(true)
  })

  it('遅延ロード中の入場を取り消すと、解決しても適用されず superseded になる', async () => {
    let release!: (v: EventScene[]) => void
    const r = makeAtChoice()
    r.setMissingSceneResolver(
      () =>
        new Promise<EventScene[]>((res) => {
          release = res
        })
    )
    const entry = r.startFrom({ sceneId: 'lazy' })
    r.cancelPendingEntry()
    release([scene('lazy', [narration('x')])])
    expect((await entry).status).toBe('superseded')
    expect(r.getCurrentSceneId()).not.toBe('lazy')
  })

  it('遅延ロード待ちの [ジャンプ:] 予約は、取り消し後も導き直されて詰まらない', async () => {
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')
    vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    const i = internalsOf<Internals & { jumpState: string; pendingEntry: unknown }>(r)
    i.initialized = true
    vi.spyOn(i, 'render').mockImplementation(() => {})
    r.setScenes([scene('a', [narration('a1'), { Jump: { target: 'far' } } as Event])])
    let release!: (v: EventScene[]) => void
    r.setMissingSceneResolver(
      () =>
        new Promise<EventScene[]>((res) => {
          release = res
        })
    )
    r.advance() // Jump に到達し予約
    r.getTimeController().tick(1) // 発火 → 遅延ロード待ち
    expect(i.pendingEntry).not.toBeNull()
    const before = i.pendingEntry
    r.cancelPendingEntry()
    expect(i.pendingEntry).not.toBe(before) // 古い入場は取り消され、予約が導き直されている
    expect(i.jumpState).toBe('pending')
    r.getTimeController().tick(1) // 導き直した予約が発火し、同じ遅延ロードを待つ
    release([scene('far', [narration('f')])])
    await new Promise((res) => setTimeout(res, 0))
    expect(r.getCurrentSceneId()).toBe('far') // 詰まらずジャンプが完了する
  })
})
