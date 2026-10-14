/**
 * エントリ文書から別ファイルのシーン（遅延ロード）へ入った後の seek / goBack (#800)。
 *
 * 履歴（history）は入場（`startScene` / `restoreToScene`）のたびに作り直すので、ストリームの持ち主が
 * 替わった後の SeekBar・goBack は、ジャンプ前のスナップショットを指さない。ここではその不変条件
 * （位置が現在のストリームの範囲内・カウンタ総数が展開後の本文数と一致・終劇にならない）を、
 * 選択肢／`[ジャンプ:]`、線形ストリーム（loadEvents）／シーン指定（loadScenes）、フラグ展開の組み合わせで固定する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { Event, EventScene } from '../types'

const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
const flag = (name: string): Event => ({ Flag: { name, value: { Bool: true } } })
const cond = (f: string, ...events: Event[]): Event => ({ Condition: { flag: f, events } })
const choice = (...targets: string[]): Event =>
  ({ Choice: { options: targets.map((t) => ({ text: `to ${t}`, jump: t })) } }) as Event
const jump = (target: string): Event => ({ Jump: { target } }) as Event
const scene = (id: string, events: Event[]): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events,
})
const flatten = (ss: EventScene[]): Event[] =>
  ss.flatMap((s, i) => (i ? (['SceneTransition', ...s.events] as Event[]) : s.events))

interface Internals {
  initialized: boolean
  waitingForChoice: boolean
  storyEnded: boolean
  eventIndex: number
  resolvedEvents: Event[]
  displayEventCount: number
  choiceOverlay: { show: (...args: unknown[]) => void }
  seekToTextEventDisplayIndex(i: number): void
}
const I = (r: NovelRenderer): Internals => r as unknown as Internals
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const HUB_TO_FAR_CHOICE = scene('hub', [
  narration('h1'),
  flag('a'),
  narration('h2'),
  cond('a', narration('h3')),
  narration('h4'),
  choice('far'),
])
const HUB_TO_FAR_JUMP = scene('hub', [narration('h1'), narration('h2'), jump('far')])
const FAR = scene('far', [narration('f1'), flag('b'), cond('b', narration('fb')), narration('f2')])

type Mode = 'events' | 'scenes'

async function enterFar(
  mode: Mode,
  hub: EventScene,
  via: 'choice' | 'jump'
): Promise<NovelRenderer> {
  const r = new NovelRenderer()
  r.getTimeController().setMode('virtual')
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
  I(r).initialized = true
  const confirms: Array<(j: string) => void> = []
  vi.spyOn(I(r).choiceOverlay, 'show').mockImplementation((...a: unknown[]) => {
    confirms.push(a[1] as (j: string) => void)
  })
  const all = [hub, FAR]
  if (mode === 'events') r.loadEvents(flatten([hub]))
  else r.loadScenes([hub])
  r.setJumpSceneIndex([hub])
  r.setMissingSceneResolver(async () => all)
  await r.startFrom({})
  for (let i = 0; i < 20 && r.getCurrentSceneId() !== 'far'; i++) {
    if (I(r).waitingForChoice) confirms[confirms.length - 1]('far')
    else r.advance()
    r.getTimeController().tick(500)
    await flush()
  }
  expect(r.getCurrentSceneId()).toBe('far')
  expect(via).toBeTruthy()
  return r
}

function expectInsideCurrentStream(r: NovelRenderer): void {
  const i = I(r)
  expect(i.storyEnded).toBe(false)
  expect(i.eventIndex).toBeLessThan(i.resolvedEvents.length)
  const texts = i.resolvedEvents.filter((e) => typeof e === 'object' && 'Narration' in e).length
  expect(i.displayEventCount).toBe(texts)
}

describe('別ファイルのシーンへ入った後の seek / goBack (#800)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    defaultTimeController.setMode('live')
    localStorage.clear()
  })

  for (const mode of ['events', 'scenes'] as const) {
    for (const [via, hub] of [
      ['choice', HUB_TO_FAR_CHOICE],
      ['jump', HUB_TO_FAR_JUMP],
    ] as const) {
      it(`${mode} / ${via}: どの表示位置へシークしても goBack しても、現在のストリームの範囲内に留まる`, async () => {
        const r = await enterFar(mode, hub, via)
        expectInsideCurrentStream(r)
        for (let k = 0; k < 8; k++) {
          I(r).seekToTextEventDisplayIndex(k)
          expectInsideCurrentStream(r)
          expect(r.getCurrentSceneId()).toBe('far')
          r.goBack()
          expectInsideCurrentStream(r)
        }
      })
    }
  }

  it('ジャンプ後に進めた先からも、シーク→再度進めるが終劇にならない', async () => {
    const r = await enterFar('events', HUB_TO_FAR_CHOICE, 'choice')
    r.advance()
    r.advance()
    I(r).seekToTextEventDisplayIndex(0)
    expect(I(r).eventIndex).toBe(0)
    r.advance()
    expectInsideCurrentStream(r)
    expect(I(r).eventIndex).toBeGreaterThan(0)
  })
})
