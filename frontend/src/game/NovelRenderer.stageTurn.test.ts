/**
 * NovelRenderer と回転舞台 `[舞台回転]` (#704 第2弾) の配線。
 *
 * 単体の挙動（純粋関数・各レイヤー・コントローラ）は stageTurn.test.ts / stageTurn.layers.test.ts で縛る。
 * ここでは、実際の再生ループ（processUntilNextTextEvent）が
 *  - 範囲を「進行を止めるイベント」（台詞・ナレーション・選択肢・待機・ジャンプ）で閉じる
 *  - 場面転換で範囲を捨てる
 *  - シアターで回し、ノベル・スキップ・書き出し・復元（applyState）・goBack で即時にする
 *  - 立ち絵・舞台前面・天候・照明・幕には触れない
 * ことを確かめる。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Assets, BufferImageSource, Container, PerspectiveMesh, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { NovelGameState } from './GameState'
import { internals, type RendererInternals } from '../test/rendererInternals'
import { confineForTest } from '../test/confinement'

const mq = { matches: false }
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => mq })
})

const tex = (w: number, h: number): Texture =>
  new Texture({
    source: new BufferImageSource({ resource: new Uint8Array(4), width: w, height: h }),
  })
const TEX = tex(800, 450)

const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
const turn = (ms?: number): Event => ({ StageTurn: ms == null ? {} : { duration_ms: ms } }) as Event
const prop = (path: string, depth = 2): Event => ({ Prop: { path, depth } }) as Event
const board = (path: string, depth = 3): Event => ({ BackgroundBoard: { path, depth } }) as Event
const wall = (path: string): Event => ({ Wall: { path, loop: true, mute: true } }) as Event
const floor = (path: string): Event => ({ Floor: { path, height: 0.25 } }) as Event
const theater = { CameraMode: { mode: 'Theater' } } as Event
const novelCam = { CameraMode: { mode: 'Novel' } } as Event
const scene = (id: string, events: Event[]): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events,
})

interface LocalInternals extends RendererInternals {
  wallLayer: Container & { getState(): unknown }
  backgroundBoardLayer: Container & { getState(): unknown }
  floorLayer: Container & { getState(): unknown }
  propLayer: Container & { getState(): unknown }
  stageFrontLayer: Container & { getState(): unknown }
  weatherLayer: Container & { getState(): unknown }
  lightingLayer: Container
  curtainLayer: Container
  characterLayer: Container
  stageTurn: { run: { ended: boolean; started: boolean; durationMs: number } | null }
  time: { setMode(m: string): void; tick(ms: number): void }
  applyState(s: NovelGameState): void
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const li = (r: NovelRenderer): LocalInternals => internals<LocalInternals>(r)
const hostOf = (layer: Container): Container | undefined =>
  layer.children.find((c) => c instanceof Container && c.sortableChildren) as Container | undefined
const meshes = (layer: Container): number =>
  (hostOf(layer)?.children ?? []).filter((c) => c instanceof PerspectiveMesh).length
const hostCount = (r: NovelRenderer): number =>
  [li(r).wallLayer, li(r).backgroundBoardLayer, li(r).floorLayer, li(r).propLayer].filter((l) =>
    hostOf(l)
  ).length

function make(scenes: EventScene[]): NovelRenderer {
  vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
  const r = new NovelRenderer()
  li(r).time.setMode('virtual')
  r.setAssetBaseUrl('/assets')
  r.setScenes(scenes)
  return r
}
const advance = async (r: NovelRenderer): Promise<void> => {
  await r.playScript([{ type: 'advance' }])
  await flush()
}

afterEach(() => {
  vi.restoreAllMocks()
  mq.matches = false
})

const OLD = [theater, prop('A.png'), board('A.png'), wall('A.png'), floor('A.png')]

describe('NovelRenderer: 範囲を進行を止めるイベントで閉じる', () => {
  it('[舞台回転] の後ろの 4 種は台詞まで裏側。台詞に着いた時点で回転が始まり、保存状態は新しい舞台', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(1000),
        prop('B.png'),
        board('B.png'),
        wall('B.png'),
        floor('B.png'),
        narration('two'),
      ]),
    ])
    await flush()
    expect(hostCount(r)).toBe(0)
    expect(r.getSnapshot().props).toEqual([{ path: 'A.png', depth: 2 }])
    await advance(r)
    expect(hostCount(r)).toBe(4)
    for (const l of [
      li(r).wallLayer,
      li(r).backgroundBoardLayer,
      li(r).floorLayer,
      li(r).propLayer,
    ]) {
      expect(meshes(l)).toBe(2)
    }
    const s = r.getSnapshot()
    expect(s.props).toEqual([{ path: 'B.png', depth: 2 }])
    expect(s.backgroundBoards).toEqual([{ path: 'B.png', depth: 3 }])
    expect(s.wall?.path).toBe('B.png')
    expect(s.floor?.path).toBe('B.png')
    li(r).time.tick(1500)
    expect(hostCount(r)).toBe(0)
    expect(r.getSnapshot().props).toEqual([{ path: 'B.png', depth: 2 }])
  })

  it('台詞より後ろの指定は裏側ではない: 回転に混ざらず、板の再指定が来た時点で回転は最終状態に畳まれる', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(1000),
        prop('B.png'),
        narration('two'),
        prop('C.png', 5),
        narration('three'),
      ]),
    ])
    await flush()
    await advance(r) // one -> two（回転開始）
    expect(meshes(li(r).propLayer)).toBe(2) // 旧 A + 新 B だけ。C は混ざらない
    expect(r.getSnapshot().props).toEqual([{ path: 'B.png', depth: 2 }])
    await advance(r) // two -> three: C を普通に追加
    expect(hostCount(r)).toBe(0) // 回転は畳まれた
    expect(r.getSnapshot().props).toEqual([
      { path: 'B.png', depth: 2 },
      { path: 'C.png', depth: 5 },
    ])
  })

  it('待機 [待機] で範囲が閉じる（待機に着いた時点で回転が始まる）', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(1000),
        prop('B.png'),
        { Wait: { ms: 300 } } as Event,
        narration('two'),
      ]),
    ])
    await flush()
    await advance(r)
    expect(meshes(li(r).propLayer)).toBe(2)
    expect(r.getSnapshot().props).toEqual([{ path: 'B.png', depth: 2 }])
  })

  it('選択肢で範囲が閉じる', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(1000),
        prop('B.png'),
        { Choice: { options: [{ text: 'x', jump: 'a' }] } } as Event,
      ]),
    ])
    await flush()
    await advance(r)
    expect(meshes(li(r).propLayer)).toBe(2)
  })

  it('裏側の指定が 1 つも無いなら何も回さず警告（旧い舞台はそのまま）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = make([scene('a', [...OLD, narration('one'), turn(1000), narration('two')])])
    await flush()
    await advance(r)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[舞台回転]'))).toBe(true)
    expect(hostCount(r)).toBe(0)
    expect(r.getSnapshot().props).toEqual([{ path: 'A.png', depth: 2 }])
    expect(r.getSnapshot().floor?.path).toBe('A.png')
  })

  it('連続する [舞台回転] は後勝ち（時間は最後）', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(300),
        turn(1200),
        prop('B.png'),
        narration('two'),
      ]),
    ])
    await flush()
    await advance(r)
    expect(li(r).stageTurn.run?.durationMs).toBe(1200)
  })

  it('[場面転換] は範囲を捨てる: 回転は起きず、舞台は空', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(1000),
        prop('B.png'),
        'SceneTransition' as Event,
        narration('two'),
      ]),
    ])
    await flush()
    await advance(r)
    expect(hostCount(r)).toBe(0)
    expect(li(r).stageTurn.run).toBeNull()
    expect(r.getSnapshot().props).toEqual([])
    expect(r.getSnapshot().wall).toBeNull()
  })
})

describe('NovelRenderer: 即時になる経路', () => {
  const events = [
    ...OLD,
    narration('one'),
    turn(1000),
    prop('B.png'),
    wall('B.png'),
    narration('two'),
  ]
  const expectFinal = (r: NovelRenderer): void => {
    expect(hostCount(r)).toBe(0)
    expect(r.getSnapshot().props).toEqual([{ path: 'B.png', depth: 2 }])
    expect(r.getSnapshot().wall?.path).toBe('B.png')
    // 裏側に書かなかった背景板・床は旧舞台ごと無くなっている。
    expect(r.getSnapshot().backgroundBoards).toEqual([])
    expect(r.getSnapshot().floor).toBeNull()
  }

  it('ノベルのカメラ', async () => {
    const r = make([scene('a', [novelCam, ...OLD.slice(1), narration('one'), ...events.slice(6)])])
    await flush()
    await advance(r)
    expectFinal(r)
  })

  it('動画書き出し中', async () => {
    const r = make([scene('a', events)])
    await flush()
    r.setExporting(true)
    await advance(r)
    expectFinal(r)
  })

  it('prefers-reduced-motion', async () => {
    mq.matches = true
    const r = make([scene('a', events)])
    await flush()
    await advance(r)
    expectFinal(r)
  })

  it('時間=0', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(0),
        prop('B.png'),
        wall('B.png'),
        narration('two'),
      ]),
    ])
    await flush()
    await advance(r)
    expectFinal(r)
  })

  it('スキップ前進中', async () => {
    const r = make([scene('a', events)])
    await flush()
    ;(r as unknown as { skipMode: boolean }).skipMode = true
    await advance(r)
    expectFinal(r)
  })
})

describe('NovelRenderer: 回さないもの', () => {
  it('舞台前面・天候・照明・幕・立ち絵のレイヤーには回転の host も mesh も作られない', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        { StageFront: { path: 'hall.png' } } as Event,
        { Weather: { kind: 'Rain', intensity: 1 } } as Event,
        narration('one'),
        turn(1000),
        prop('B.png'),
        narration('two'),
      ]),
    ])
    await flush()
    const stageFront = li(r).stageFrontLayer.getState()
    const weather = li(r).weatherLayer.getState()
    const others = [
      li(r).stageFrontLayer,
      li(r).weatherLayer,
      li(r).lightingLayer,
      li(r).curtainLayer,
      li(r).characterLayer,
    ]
    const childrenBefore = others.map((l) => [...l.children])
    await advance(r)
    expect(hostCount(r)).toBe(4)
    others.forEach((l, i) => {
      expect(l.children).toEqual(childrenBefore[i])
      expect(l.children.some((c) => c instanceof PerspectiveMesh)).toBe(false)
      expect(hostOf(l)).toBeUndefined()
    })
    expect(li(r).stageFrontLayer.getState()).toEqual(stageFront)
    expect(li(r).weatherLayer.getState()).toEqual(weather)
    expect(r.getSnapshot().stageFront?.path).toBe('hall.png')
    expect(r.getSnapshot().weather?.kind).toBe('Rain')
  })

  it('立ち絵・背景色など回さない項目は [舞台回転] の前後で不変', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        { BackgroundColor: { color: '#112233' } } as Event,
        narration('one'),
        turn(1000),
        prop('B.png'),
        narration('two'),
      ]),
    ])
    await flush()
    const before = r.getSnapshot()
    await advance(r)
    const after = r.getSnapshot()
    expect(after.backgroundColor).toBe(before.backgroundColor)
    expect(after.characters).toEqual(before.characters)
  })
})

describe('NovelRenderer: 復元・巻き戻し', () => {
  it('回転中に applyState（復元）すると回転は畳まれ、保存状態の舞台がそのまま出る', async () => {
    const r = make([
      scene('a', [...OLD, narration('one'), turn(1000), prop('B.png'), narration('two')]),
    ])
    await flush()
    const first = r.getSnapshot()
    await advance(r)
    expect(hostCount(r)).toBe(4)
    li(r).applyState(first)
    await flush()
    expect(hostCount(r)).toBe(0)
    expect(r.getSnapshot().props).toEqual([{ path: 'A.png', depth: 2 }])
    li(r).applyState(first)
    li(r).time.tick(2000)
    expect(hostCount(r)).toBe(0)
  })

  it('goBack（巻き戻し）は回転せず、戻り先の舞台が最終状態で出る', async () => {
    const r = make([
      scene('a', [...OLD, narration('one'), turn(1000), prop('B.png'), narration('two')]),
    ])
    await flush()
    await advance(r)
    expect(hostCount(r)).toBe(4)
    r.goBack()
    await flush()
    expect(hostCount(r)).toBe(0)
    expect(r.getSnapshot().props).toEqual([{ path: 'A.png', depth: 2 }])
    li(r).time.tick(2000)
    expect(hostCount(r)).toBe(0)
  })

  it('回転後のスナップショットで復元しても回転しない（最終状態へ即時）', async () => {
    const r = make([
      scene('a', [...OLD, narration('one'), turn(1000), prop('B.png'), narration('two')]),
    ])
    await flush()
    await advance(r)
    li(r).time.tick(2000)
    const after = r.getSnapshot()
    li(r).applyState(after)
    await flush()
    expect(hostCount(r)).toBe(0)
    expect(r.getSnapshot().props).toEqual([{ path: 'B.png', depth: 2 }])
  })
})

describe('NovelRenderer: カメラ', () => {
  it('回転中にカメラの向きが変わると打ち切り、ズームだけなら続く', async () => {
    const r = make([
      scene('a', [...OLD, narration('one'), turn(1000), prop('B.png'), narration('two')]),
    ])
    await flush()
    await advance(r)
    expect(hostCount(r)).toBe(4)
    // ズームだけ（mode/向き/仰角は同じ）
    internals(r).processDirective({
      CameraMode: { mode: 'Theater', zoom: 'ミナ', zoom_strength: 2 },
    } as Event)
    expect(hostCount(r)).toBe(4)
    internals(r).processDirective({
      CameraMode: { mode: 'Theater', orientation: 'Stage' },
    } as Event)
    expect(hostCount(r)).toBe(0)
  })
})

describe('NovelRenderer: スキップ中に開いた範囲（待機・選択肢で閉じる）', () => {
  const closers: Array<[string, Event]> = [
    ['[待機]', { Wait: { ms: 300 } } as Event],
    ['[待機: 表示完了]', 'WaitDisplayComplete' as Event],
    ['選択肢', { Choice: { options: [{ text: 'x', jump: 'a' }] } } as Event],
  ]
  it.each(closers)('%s で閉じてもスキップ中なので回らず即時', async (_n, closer) => {
    const r = make([
      scene('a', [...OLD, narration('one'), turn(1000), prop('B.png'), wall('B.png'), closer]),
    ])
    await flush()
    ;(r as unknown as { skipMode: boolean }).skipMode = true
    await advance(r)
    expect(hostCount(r)).toBe(0)
    expect(r.getSnapshot().props).toEqual([{ path: 'B.png', depth: 2 }])
    expect(r.getSnapshot().floor).toBeNull()
  })

  it.each(closers)('%s で閉じても、スキップでなければ回る', async (_n, closer) => {
    const r = make([
      scene('a', [...OLD, narration('one'), turn(1000), prop('B.png'), wall('B.png'), closer]),
    ])
    await flush()
    await advance(r)
    expect(hostCount(r)).toBe(4)
  })
})

describe('NovelRenderer: 範囲が終劇・ジャンプ・表示完了待ちで閉じる', () => {
  it('範囲が開いたまま終劇（全選択肢が圏外）に入ると、ためた壁・床は出ず、保存状態にも載らない', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(1000),
        wall('X.png'),
        floor('Y.png'),
        { Choice: { options: [{ text: 'x', jump: 'out' }] } } as Event,
      ]),
      scene('out', [narration('out')]),
    ])
    confineForTest(r, ['a'])
    await flush()
    await advance(r)
    await flush()
    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(hostCount(r)).toBe(0)
    expect(r.getSnapshot().wall).toBeNull()
    expect(r.getSnapshot().floor).toBeNull()
    li(r).time.tick(3000)
    expect(r.getSnapshot().wall).toBeNull()
    expect(r.getSnapshot().floor).toBeNull()
  })

  it('[ジャンプ:] で範囲が閉じる（予約中でも回転が始まる）', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(1000),
        prop('B.png'),
        { Jump: { target: 'b' } } as Event,
      ]),
      scene('b', [narration('bb')]),
    ])
    await flush()
    r.advance()
    await flush()
    expect(meshes(li(r).propLayer)).toBeGreaterThanOrEqual(1)
    expect(r.getSnapshot().props).toEqual([{ path: 'B.png', depth: 2 }])
  })

  it('[待機: 表示完了] は回転舞台が終わるまで待つ（hasPendingVisualTransition が回転中は true）', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        turn(1000),
        prop('B.png'),
        'WaitDisplayComplete' as Event,
        narration('two'),
      ]),
    ])
    await flush()
    await advance(r)
    expect(hostCount(r)).toBe(4)
    // 待機（[待機: 表示完了]）が見る集約点: 回転中は待ち、終われば待たない。
    const pending = (): boolean =>
      (r as unknown as { hasPendingVisualTransition(): boolean }).hasPendingVisualTransition()
    expect((internals(r) as unknown as { waitingForWait: boolean }).waitingForWait).toBe(true)
    expect(pending()).toBe(true)
    li(r).time.tick(500)
    expect(pending()).toBe(true)
    li(r).time.tick(1500)
    expect(hostCount(r)).toBe(0)
    expect(pending()).toBe(false)
  })

  it('[待機: 表示完了] は第1弾の大道具の面の切り替え（回転:）の回転も待つ', async () => {
    const r = make([
      scene('a', [
        ...OLD,
        narration('one'),
        { Prop: { path: 'B.png', depth: 2, flip_from: 'A.png', flip_ms: 800 } } as Event,
        narration('two'),
      ]),
    ])
    await flush()
    await advance(r)
    const pending = (): boolean =>
      (r as unknown as { hasPendingVisualTransition(): boolean }).hasPendingVisualTransition()
    expect(pending()).toBe(true)
    li(r).time.tick(1500)
    expect(pending()).toBe(false)
  })

  it('intermission タブローでも本文・待機で範囲が閉じて回転が起きる', async () => {
    const r = make([scene('a', [...OLD, narration('one')])])
    await flush()
    ;(r as unknown as { renderIntermissionTableau(e: Event[]): void }).renderIntermissionTableau([
      turn(1000),
      prop('B.png'),
      narration('end'),
    ])
    await flush()
    expect(meshes(li(r).propLayer)).toBeGreaterThanOrEqual(1)
  })
})
