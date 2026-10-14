/**
 * 入場（新規開始）が失敗したあと、位置から遷移状態が再導出されることのレンダラ結合テスト (#826)。
 *
 * `SceneEntryController` が `EntryHost.rederiveTransition` を呼び、レンダラが選択肢の再表示・Jump の再予約を
 * 実際に行うところまでをつなぐ。復元側の失敗（選択肢の再表示・Jump の再予約）は sceneEntry / jump の各テストが
 * 固定済みなので、ここは新規開始（`startFrom`）の失敗だけを足す。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { Event, EventScene } from '../types'
import { internals, type RendererInternals } from '../test/rendererInternals'

const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
const jump = (target: string): Event => ({ Jump: { target } })
const choice = (...targets: string[]): Event =>
  ({ Choice: { options: targets.map((t) => ({ text: `to ${t}`, jump: t })) } }) as Event
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

describe('新規開始の失敗後の遷移再導出 (#826)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  /** Choice に到達し、確定コールバックと show の呼び出し回数を返す。 */
  function reachChoice(r: NovelRenderer) {
    const calls: unknown[][] = []
    vi.spyOn(internals<Internals>(r).choiceOverlay, 'show').mockImplementation(
      (...a: unknown[]) => {
        calls.push(a)
      }
    )
    r.advance()
    expect(internals<Internals>(r).waitingForChoice).toBe(true)
    return {
      confirm: calls[calls.length - 1][1] as (jump: string) => boolean | void,
      showCount: () => calls.length,
    }
  }

  const HUB = scene('hub', [narration('h'), choice('far')])
  const FAR = scene('far', [narration('far')])

  it.each([
    ['シーン不在', { sceneId: 'ghost' }, 'not-found'],
    ['位置が範囲外', { sceneId: 'hub', eventIndex: 99 }, 'out-of-range'],
  ] as const)(
    '選択肢の確定で遅延ロード中に startFrom が失敗（%s）しても、閉じていた選択肢が再表示される',
    async (_label, opts, reason) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const r = makeRenderer([HUB])
      let resolveFar!: (v: EventScene[] | null) => void
      r.setMissingSceneResolver((id) =>
        id === 'far'
          ? new Promise<EventScene[] | null>((res) => {
              resolveFar = res
            })
          : Promise.resolve(null)
      )
      const { confirm, showCount } = reachChoice(r)
      confirm('far') // 選択肢が閉じ、遅延ロードを待つ
      expect(showCount()).toBe(1)

      const result = await r.startFrom(opts)

      expect(result).toEqual({ status: 'failed', reason })
      expect(showCount()).toBe(2)
      expect(internals<Internals>(r).waitingForChoice).toBe(true)
      r.advance()
      expect(r.getCurrentSceneId()).toBe('hub')

      resolveFar([HUB, FAR]) // 古い進行は適用されない
      await Promise.resolve()
      expect(r.getCurrentSceneId()).toBe('hub')
    }
  )

  it('Jump 予約中に startFrom が失敗しても、Jump が位置から再予約され、次の tick で遷移する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = makeRenderer([
      scene('a', [narration('a1'), jump('b')]),
      scene('b', [narration('b1')]),
    ])
    r.advance()
    expect(internals<Internals>(r).jumpState).toBe('pending')

    const result = await r.startFrom({ sceneId: 'ghost' })
    expect(result).toEqual({ status: 'failed', reason: 'not-found' })
    expect(internals<Internals>(r).jumpState).toBe('pending')

    r.getTimeController().tick(1)
    await Promise.resolve()
    expect(r.getCurrentSceneId()).toBe('b')
  })
})
