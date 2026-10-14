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
import { internals, type RendererInternals } from '../test/rendererInternals'

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

interface Internals extends RendererInternals {
  choiceOverlay: { show: (...args: unknown[]) => void }
}
function prepare(r: NovelRenderer): NovelRenderer {
  r.getTimeController().setMode('virtual')
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  internals<Internals>(r).initialized = true
  vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
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
    expect((r as unknown as { saveQuick(o: 'auto'): boolean }).saveQuick('auto')).toBe(true)
    expect(toast).not.toHaveBeenCalled()
    expect(r.quickSave()).toBe(true)
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith('クイックセーブしました')
  })

  it('選択肢表示中: 「この場面ではセーブできません」（自動は無言・保存しない）', () => {
    const r = scenesRenderer([HUB])
    vi.spyOn(internals<Internals>(r).choiceOverlay, 'show').mockImplementation(() => {})
    r.advance()
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect((r as unknown as { saveQuick(o: 'auto'): boolean }).saveQuick('auto')).toBe(false)
    expect(toast).not.toHaveBeenCalled()
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('この場面ではセーブできません')
    expect(new SaveManager().hasQuickSave()).toBe(false)
  })

  it('[待機] 中: 「この場面ではセーブできません」', () => {
    const r = scenesRenderer([HUB])
    internals<Internals>(r).waitingForWait = true
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('この場面ではセーブできません')
  })

  it('終劇後: 「この場面ではセーブできません」', () => {
    const r = scenesRenderer([HUB])
    internals<Internals>(r).storyEnded = true
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('この場面ではセーブできません')
  })

  it('Jump 予約中: 「場面転換中のためセーブできません」（自動は無言）', () => {
    const r = scenesRenderer([JA, FAR])
    r.advance() // Jump に到達し予約
    expect(internals<Internals>(r).jumpState).toBe('pending')
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect((r as unknown as { saveQuick(o: 'auto'): boolean }).saveQuick('auto')).toBe(false)
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
    expect(internals<Internals>(r).pendingEntry).not.toBeNull()
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('場面転換中のためセーブできません')
    resolve([HUB, FAR])
    await entering
  })

  it('停止中（stalled）の Jump: 転換中ではないので「この場面ではセーブできません」', () => {
    const r = scenesRenderer([JA, FAR])
    internals<Internals>(r).jumpState = 'stalled'
    const toast = vi.spyOn(r, 'showToast').mockImplementation(() => {})
    expect(r.quickSave()).toBe(false)
    expect(toast).toHaveBeenCalledWith('この場面ではセーブできません')
  })
})
