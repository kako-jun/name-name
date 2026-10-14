/**
 * #800 の調査で確認した、別ファイルのシーンへ入った後の seek / goBack の不変条件の回帰ガード
 * （#800 自体の原因は終劇状態でシークとは無関係だった）。
 *
 * 履歴（history）は入場（`startScene` / `restoreToScene`）のたびに作り直すので、ストリームの持ち主が
 * 替わった後の SeekBar・goBack・seekTo は、ジャンプ前のスナップショットを指さず、遷移先（far）の
 * 本文の間だけを実際に行き来する。選択肢／`[ジャンプ:]`、線形ストリーム（loadEvents）／シーン指定
 * （loadScenes）、フラグ展開の組み合わせで固定する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import type { Event, EventScene } from '../types'
import { internalsOf } from '../test/rendererInternals'

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
  textIndex: number
  sentenceIndex: number
  history: Array<{ sceneId: string | null }>
  resolvedEvents: Event[]
  displayEventCount: number
  choiceOverlay: { show: (...args: unknown[]) => void }
  seekToTextEventDisplayIndex(i: number): void
}
const I = (r: NovelRenderer): Internals => internalsOf<Internals>(r)
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

interface Entered {
  r: NovelRenderer
  resolver: ReturnType<typeof vi.fn>
  confirms: Array<(j: string) => void>
}

async function enterFar(mode: Mode, hub: EventScene, via: 'choice' | 'jump'): Promise<Entered> {
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
  const resolver = vi.fn(async (_id: string) => all)
  r.setMissingSceneResolver(resolver)
  await r.startFrom({})
  for (let i = 0; i < 20 && r.getCurrentSceneId() !== 'far'; i++) {
    if (I(r).waitingForChoice) confirms[confirms.length - 1]('far')
    else r.advance()
    r.getTimeController().tick(500)
    await flush()
  }
  expect(r.getCurrentSceneId()).toBe('far')
  // 遅延ロードを通って入ったこと、入り方が想定どおりであること
  expect(resolver).toHaveBeenCalledWith('far')
  expect(confirms.length).toBe(via === 'choice' ? 1 : 0)
  return { r, resolver, confirms }
}

const text = (r: NovelRenderer): string => {
  const e = I(r).resolvedEvents[I(r).eventIndex]
  return typeof e === 'object' && 'Narration' in e ? e.Narration.text[0] : '(not text)'
}

/** far の最後の本文 f2 まで進める。history は f1・fb・f2 の3件になる。 */
function advanceToLastOfFar(r: NovelRenderer): void {
  for (let i = 0; i < 2; i++) r.advance()
  expect(text(r)).toBe('f2')
  expect(I(r).history.length).toBe(3)
}

function expectStillInFar(r: NovelRenderer): void {
  const i = I(r)
  expect(i.storyEnded).toBe(false)
  expect(r.getSnapshot().sceneId).toBe('far')
  expect(r.getCurrentSceneId()).toBe('far')
  expect(i.eventIndex).toBeLessThan(i.resolvedEvents.length)
  expect(['f1', 'fb', 'f2']).toContain(text(r))
  const texts = i.resolvedEvents.filter((e) => typeof e === 'object' && 'Narration' in e).length
  expect(i.displayEventCount).toBe(texts)
  // 履歴はすべて far のスナップショット（ジャンプ前のエントリのものを含まない）
  for (const h of i.history) expect(h.sceneId).toBe('far')
}

describe('別ファイルのシーンへ入った後の seek / goBack（不変条件の回帰ガード）', () => {
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
      describe(`${mode} / ${via}`, () => {
        it('goBack は far の1つ前の本文へ実際に戻り、先頭で止まる（ジャンプ前へは戻らない）', async () => {
          const { r } = await enterFar(mode, hub, via)
          advanceToLastOfFar(r)
          r.goBack()
          expect(text(r)).toBe('fb')
          expectStillInFar(r)
          r.goBack()
          expect(text(r)).toBe('f1')
          expect(I(r).eventIndex).toBe(0)
          expectStillInFar(r)
          r.goBack() // これ以上は戻れない
          expect(text(r)).toBe('f1')
          expectStillInFar(r)
        })

        it('seekTo(historyIndex) は履歴の位置へ実際に動き、範囲外は何もしない', async () => {
          const { r } = await enterFar(mode, hub, via)
          advanceToLastOfFar(r)
          r.seekTo(1)
          expect(text(r)).toBe('fb')
          expectStillInFar(r)
          r.seekTo(0)
          expect(text(r)).toBe('f1')
          expectStillInFar(r)
          r.seekTo(5)
          r.seekTo(-1)
          expect(text(r)).toBe('f1')
          expectStillInFar(r)
        })

        it('seekToTextEventDisplayIndex は訪問済みの本文へ動き、未訪問・範囲外では動かない', async () => {
          const { r } = await enterFar(mode, hub, via)
          advanceToLastOfFar(r)
          I(r).seekToTextEventDisplayIndex(1)
          expect(text(r)).toBe('fb')
          expectStillInFar(r)
          I(r).seekToTextEventDisplayIndex(0)
          expect(text(r)).toBe('f1')
          expectStillInFar(r)
          // 戻った後の未訪問（前方）・範囲外は no-op
          for (const k of [2, 3, 7, -1]) {
            I(r).seekToTextEventDisplayIndex(k)
            expect(text(r)).toBe('f1')
            expectStillInFar(r)
          }
        })
      })
    }
  }

  it('seekTo は非整数・範囲外の index では履歴・位置・スナップショットを変えない', async () => {
    const { r } = await enterFar('events', HUB_TO_FAR_CHOICE, 'choice')
    advanceToLastOfFar(r)
    const snapshotBefore = JSON.stringify(r.getSnapshot())
    const historyBefore = JSON.stringify(I(r).history)
    const positionBefore = [I(r).eventIndex, I(r).textIndex, I(r).sentenceIndex]
    // 1.5 は範囲内に見えるが整数でない（truncateHistory が弾く）。NaN / 範囲外は seekTo の入口で弾く。
    for (const bad of [1.5, NaN, 3, 5, -1]) {
      r.seekTo(bad)
      expect(I(r).history.length, `index=${bad}`).toBe(3)
      expect(JSON.stringify(I(r).history), `index=${bad}`).toBe(historyBefore)
      expect([I(r).eventIndex, I(r).textIndex, I(r).sentenceIndex], `index=${bad}`).toEqual(
        positionBefore
      )
      expect(JSON.stringify(r.getSnapshot()), `index=${bad}`).toBe(snapshotBefore)
    }
    expect(text(r)).toBe('f2')
    expectStillInFar(r)
  })

  it('シーク後に再び進めても far の続きを読め、終劇にならない', async () => {
    const { r } = await enterFar('events', HUB_TO_FAR_CHOICE, 'choice')
    advanceToLastOfFar(r)
    I(r).seekToTextEventDisplayIndex(0)
    expect(I(r).eventIndex).toBe(0)
    expect(text(r)).toBe('f1')
    r.advance() // フラグ b を立て直して fb が展開される
    expect(text(r)).toBe('fb')
    r.advance()
    expect(text(r)).toBe('f2')
    expectStillInFar(r)
  })
})
