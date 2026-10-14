/**
 * NovelRenderer の getPendingChoice / selectPendingChoice (#780, 動画書き出しの自動選択用)。
 * 選択は ChoiceOverlay のクリックと同じ確定経路を通ることを確かめる。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
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
  const i = r as unknown as Internals
  i.initialized = true
  vi.spyOn(i, 'render').mockImplementation(() => {})
  r.setScenes([hub, scene('near', [narration('n')]), scene('far', [narration('f')])])
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
      key: 'hub:1',
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
    expect((r as unknown as Internals).waitingForChoice).toBe(true)
  })

  it('ロックされていない遷移先を選ぶと、クリックと同じ経路で選択肢が閉じて入場する', async () => {
    const r = makeAtChoice()
    r.advance()
    expect(r.selectPendingChoice('far')).toBe(true)
    expect((r as unknown as Internals).waitingForChoice).toBe(false)
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
    const i = r as unknown as Internals
    i.initialized = true
    vi.spyOn(i, 'render').mockImplementation(() => {})
    r.setScenes([wait])
    r.setEvents(wait.events)
    expect(r.getExportProgress().waitMs).toBe(80000)
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
})
