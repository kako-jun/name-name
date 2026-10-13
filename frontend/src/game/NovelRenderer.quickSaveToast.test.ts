/**
 * クイックセーブ（F5）の結果トースト (#769)。
 * 結果（成功・弾かれた理由）のトーストは renderer の quickSave が出す（ロードの #765 と対称）。
 * 手動（起点 quick）のみ通知し、自動セーブ（起点 auto）は無言。文言はロード側（gateReason の振り分け）と揃える。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import { SaveManager } from './SaveManager'
import type { Event, EventScene } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function jump(target: string): Event {
  return { Jump: { target } }
}
function choice(...targets: string[]): Event {
  return { Choice: { options: targets.map((t) => ({ text: `to ${t}`, jump: t })) } } as Event
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface Internals {
  initialized: boolean
  eventIndex: number
  resolvedEvents: Event[]
  storyEnded: boolean
  waitingForWait: boolean
  jumpState: 'idle' | 'pending' | 'stalled'
  pendingEntry: unknown
  choiceOverlay: { show: (...args: unknown[]) => void }
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

beforeEach(() => {
  new SaveManager().deleteQuickSave()
})
afterEach(() => {
  new SaveManager().deleteQuickSave()
  vi.restoreAllMocks()
  defaultTimeController.setMode('live')
  localStorage.clear()
})

describe('クイックセーブの結果トースト (#769)', () => {
  const HUB = scene('hub', [narration('hub-line'), choice('far')])
  const JA = scene('a', [narration('a1'), jump('far')])
  const FAR = scene('far', [narration('far-1')])

  function scenesRenderer(scenes: EventScene[], resolver?: () => Promise<EventScene[] | null>) {
    const r = prepare(new NovelRenderer())
    r.setScenes(scenes)
    if (resolver) r.setMissingSceneResolver(resolver)
    return r
  }

  it('成功: 手動で「クイックセーブしました」、自動は無言', () => {
    const r = scenesRenderer([HUB])
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave('auto')).toBe(true)
    expect(toast).not.toHaveBeenCalled()
    expect(r.quickSave()).toBe(true)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('クイックセーブしました')
  })

  it('選択肢表示中: 「この場面ではセーブできません」（自動は無言・保存しない）', () => {
    const r = scenesRenderer([HUB])
    vi.spyOn(internals(r).choiceOverlay, 'show').mockImplementation(() => {})
    r.advance()
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave('auto')).toBe(false)
    expect(toast).not.toHaveBeenCalled()
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('この場面ではセーブできません')
    expect(new SaveManager().hasQuickSave()).toBe(false)
  })

  it('[待機] 中: 「この場面ではセーブできません」', () => {
    const r = scenesRenderer([HUB])
    internals(r).waitingForWait = true
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('この場面ではセーブできません')
  })

  it('終劇後: 「この場面ではセーブできません」', () => {
    const r = scenesRenderer([HUB])
    internals(r).storyEnded = true
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('この場面ではセーブできません')
  })

  it('Jump 予約中: 「場面転換中のためセーブできません」（自動は無言）', () => {
    const r = scenesRenderer([JA, FAR])
    r.advance() // Jump に到達し予約
    expect(internals(r).jumpState).toBe('pending')
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave('auto')).toBe(false)
    expect(toast).not.toHaveBeenCalled()
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('場面転換中のためセーブできません')
  })

  it('入場中（遅延ロード待ち）: 「場面転換中のためセーブできません」', async () => {
    let resolve!: (v: EventScene[] | null) => void
    const p = new Promise<EventScene[] | null>((res) => {
      resolve = res
    })
    const r = scenesRenderer([HUB], () => p)
    const entering = r.jumpToScene('far')
    expect(internals(r).pendingEntry).not.toBeNull()
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('場面転換中のためセーブできません')
    resolve([HUB, FAR])
    await entering
  })

  it('停止中（stalled）の Jump: 転換中ではないので「この場面ではセーブできません」', () => {
    const r = scenesRenderer([JA, FAR])
    internals(r).jumpState = 'stalled'
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('この場面ではセーブできません')
  })
})

describe('遷移中に弾かれた自動セーブの再試行 (#768)', () => {
  const JA = scene('a', [narration('a1'), jump('far')])
  const FAR = scene('far', [narration('far-1')])
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('Jump 予約中に弾かれた自動セーブは、遷移の確定後に新しい場面の位置で保存される', async () => {
    const r = prepare(new NovelRenderer())
    r.setScenes([JA, FAR])
    r.advance() // Jump に到達し予約
    expect(internals(r).jumpState).toBe('pending')
    expect(r.quickSave('auto')).toBe(false)
    expect(new SaveManager().hasQuickSave()).toBe(false)

    r.getTimeController().tick(1) // Jump 発火 → far へ入場
    await flush()
    r.getTimeController().tick(1) // 再試行
    await flush()

    expect(r.getCurrentSceneId()).toBe('far')
    expect(new SaveManager().quickLoad()?.sceneId).toBe('far')
  })

  it('入場中（遅延ロード待ち）に弾かれた自動セーブは、入場の完了後に保存される', async () => {
    const HUB = scene('hub', [narration('h1')])
    let resolve!: (v: EventScene[] | null) => void
    const p = new Promise<EventScene[] | null>((res) => {
      resolve = res
    })
    const r = prepare(new NovelRenderer())
    r.setScenes([HUB])
    r.setMissingSceneResolver(() => p)
    const entering = r.jumpToScene('far')
    expect(r.quickSave('auto')).toBe(false)

    resolve([HUB, FAR])
    await entering
    await flush()

    expect(new SaveManager().quickLoad()?.sceneId).toBe('far')
  })

  it('手動セーブ（quick）は再試行を予約しない', async () => {
    const r = prepare(new NovelRenderer())
    r.setScenes([JA, FAR])
    r.advance()
    vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave()).toBe(false)
    r.getTimeController().tick(1)
    await flush()
    r.getTimeController().tick(1)
    await flush()
    // Jump 完了後に自動で保存されることはない（手動操作の結果は呼んだ時点で確定）
    expect(new SaveManager().hasQuickSave()).toBe(false)
  })
})
