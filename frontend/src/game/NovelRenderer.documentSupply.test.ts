/**
 * 文書の(再)供給 `setEvents` / `setScenes` が「読み込み＋`startFrom({})`」であることのテスト
 * (#734 PR5, ADR 0003 §4・不整合10・11)。
 *
 * エディタのライブ再パースは `setEvents` / `setScenes` を呼ぶ。以前は読み込みと冒頭の実行だけで、
 * 旧 flags・終劇状態・`consecutiveJumps`・旧 `currentSceneId` が残っていた。
 * `NovelRenderer.confinement.test.ts` などと同じ最小構成（init なし）で行う。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { confineForTest } from '../test/confinement'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene, FlagValue } from '../types'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface Internals {
  gameState: { setFlag: (name: string, value: FlagValue) => void }
  consecutiveJumps: number
  currentSceneId: string | null
}
function internals(r: NovelRenderer): Internals {
  return r as unknown as Internals
}

const SCENES: EventScene[] = [
  scene('entry', [narration('e1'), narration('e2')]),
  scene('out', [narration('圏外')]),
]

describe('setEvents / setScenes は読み込み＋新規開始 (#734 PR5)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('1: 終劇後に setEvents すると終劇が解除され、入力できる状態に戻る（不整合10）', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    confineForTest(r, ['entry'])
    r.jumpToScene('out') // 圏外への進行は終劇
    expect(r.getSnapshot().storyEnded).toBe(true)
    const ended = vi.fn()
    r.setOnStoryEndedChange(ended)

    void r.setEvents([narration('a'), narration('b')])

    expect(r.getSnapshot().storyEnded).toBe(false)
    expect(ended).toHaveBeenCalledWith(false)
    r.advance()
    expect(r.getSnapshot().eventIndex).toBe(1)
  })

  it('2: 終劇後に setScenes しても終劇が解除され、入力できる状態に戻る', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    confineForTest(r, ['entry'])
    r.jumpToScene('out')
    expect(r.getSnapshot().storyEnded).toBe(true)

    void r.setScenes(SCENES)

    expect(r.getSnapshot().storyEnded).toBe(false)
    r.advance()
    expect(r.getSnapshot().eventIndex).toBe(1)
  })

  it('3: ライブ再パース（setEvents）で旧 flags が空になる（不整合10）', () => {
    const r = new NovelRenderer()
    void r.setEvents([narration('a')])
    internals(r).gameState.setFlag('visited', { Bool: true })
    expect(r.getSnapshot().flags).toEqual({ visited: { Bool: true } })

    void r.setEvents([narration('a2')])

    expect(r.getSnapshot().flags).toEqual({})
  })

  it('4: setEvents の flags クリアは、新しい文書の [条件:] の解決にも効く', () => {
    const r = new NovelRenderer()
    const doc: Event[] = [
      { Condition: { flag: 'visited', events: [narration('visited-content')] } } as Event,
      narration('base'),
    ]
    void r.setEvents(doc)
    internals(r).gameState.setFlag('visited', { Bool: true })

    void r.setEvents(doc)

    const texts = (r as unknown as { resolvedEvents: Event[] }).resolvedEvents
      .filter((e): e is { Narration: { text: string[] } } => 'Narration' in (e as object))
      .map((e) => e.Narration.text[0])
    expect(texts).toEqual(['base'])
  })

  it('5: setEvents は旧 currentSceneId を残さず、線形ストリームの識別（null）に揃える（不整合10）', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    r.jumpToScene('out')
    expect(r.getCurrentSceneId()).toBe('out')

    void r.setEvents([narration('x')])

    expect(r.getCurrentSceneId()).toBeNull()
  })

  it('6: consecutiveJumps は新規開始（setEvents / setScenes / startFrom）でリセットされる（不整合11）', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const starts: Array<[string, () => unknown]> = [
      ['setEvents', () => r.setEvents([narration('x')])],
      ['setScenes', () => r.setScenes(SCENES)],
      ['startFrom({})', () => r.startFrom({})],
      ['startFrom({ sceneId })', () => r.startFrom({ sceneId: 'out' })],
    ]
    for (const [name, start] of starts) {
      internals(r).consecutiveJumps = 7
      void start()
      expect(internals(r).consecutiveJumps, name).toBe(0)
    }
  })

  it('7: target "entry" の currentSceneId は経路によらず揃う（loadScenes→scenes[0].id / loadEvents→null）', () => {
    const viaSetScenes = new NovelRenderer()
    void viaSetScenes.setScenes(SCENES)
    expect(viaSetScenes.getCurrentSceneId()).toBe('entry')

    const viaLoadScenes = new NovelRenderer()
    viaLoadScenes.loadScenes(SCENES)
    void viaLoadScenes.startFrom({})
    expect(viaLoadScenes.getCurrentSceneId()).toBe('entry')

    const viaLoadEvents = new NovelRenderer()
    viaLoadEvents.loadEvents([narration('x')])
    void viaLoadEvents.startFrom({})
    expect(viaLoadEvents.getCurrentSceneId()).toBeNull()

    const viaSetEvents = new NovelRenderer()
    void viaSetEvents.setEvents([narration('x')])
    expect(viaSetEvents.getCurrentSceneId()).toBeNull()
  })

  it('8: 開始しない読み込み（loadEvents / loadScenes）は flags も終劇も触らない', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    internals(r).gameState.setFlag('kept', { Bool: true })

    r.loadEvents([narration('x')])
    r.loadScenes(SCENES)

    expect(r.getSnapshot().flags).toEqual({ kept: { Bool: true } })
  })

  it('9: setEvents / setScenes は新規開始の結果（entered）を返す', async () => {
    const r = new NovelRenderer()
    await expect(r.setEvents([narration('x')])).resolves.toEqual({
      status: 'entered',
      sceneId: null,
    })
    await expect(r.setScenes(SCENES)).resolves.toEqual({ status: 'entered', sceneId: 'entry' })
  })
})
