/**
 * NovelRenderer と TransitionState の結線テスト (#825, #735 4/8)。
 *
 * 状態機械そのものは `TransitionState.test.ts` で網羅する。Jump 予約・復元・ゲート・後勝ちの結合は
 * `NovelRenderer.jump` / `sceneEntryGate` / `sceneEntryReview` / `pendingChoice` / `restoreSnapshot` の各テストが
 * 固定している。ここには、それらでまだ固定されていない結線（レンダラが `onStall` と
 * `markChoiceJustSelected` を TransitionState へ渡していること）だけを置く。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { Event, EventScene } from '../types'
import { internals, type RendererInternals } from '../test/rendererInternals'

const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
const jump = (target: string): Event => ({ Jump: { target } })
const scene = (id: string, events: Event[]): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events,
})

interface Internals extends RendererInternals {
  choiceOverlay: { show: (...args: unknown[]) => void; hide: () => void }
}

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.getTimeController().setMode('virtual')
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  internals<Internals>(r).initialized = true
  vi.spyOn(internals<Internals>(r), 'render').mockImplementation(() => {})
  r.setScenes(scenes)
  return r
}

afterEach(() => {
  vi.restoreAllMocks()
  defaultTimeController.setMode('live')
  localStorage.clear()
})

describe('TransitionState との結線 (#825)', () => {
  it('Jump の連鎖が上限で停止すると、レンダラはスキップを解除する（onStall の結線）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([scene('a', [jump('b')]), scene('b', [jump('a')])])
    r.setSkipMode(true)
    r.getTimeController().tick(10)
    expect(internals<Internals>(r).jumpState).toBe('stalled')
    expect(internals<Internals>(r).skipMode).toBe(false)
  })

  it('選択肢の確定でその場の抑制が立ち、次の macrotask で自動的に下りる（markChoiceJustSelected の結線）', () => {
    const hub = scene('hub', [
      narration('h'),
      { Choice: { options: [{ text: 't', jump: 'far' }] } } as Event,
    ])
    const far = scene('far', [narration('f')])
    const r = makeRenderer([hub, far])
    const calls: unknown[][] = []
    vi.spyOn(internals<Internals>(r).choiceOverlay, 'show').mockImplementation(
      (...args: unknown[]) => {
        calls.push(args)
      }
    )
    r.advance()
    expect(internals<Internals>(r).waitingForChoice).toBe(true)
    ;(calls[0][1] as (j: string) => void)('far')
    expect(r.getCurrentSceneId()).toBe('far')
    expect(internals<Internals>(r).justSelectedChoice).toBe(true)
    r.getTimeController().tick(1)
    expect(internals<Internals>(r).justSelectedChoice).toBe(false)
  })
})
