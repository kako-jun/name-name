/**
 * 回転舞台 `[舞台回転]` (#704 第2弾) の流し込みと、板・大道具のスキップ中即時化 (#996) の統合。
 *
 * 範囲内でためた `[背景板:]` / `[大道具:]` は範囲を閉じるときに流し込まれる。そのとき
 *  - 範囲を開いた時点のスキップ（閉じる時点では解除済みのことがある）
 *  - 回転せず即時で最終状態にする経路（ノベル・書き出し・reduced-motion・時間0・スキップ）
 * ではスライドインせず最終位置へ置く。回転する経路は新面が回転後に現れるので instant の値は効かない。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Assets, BufferImageSource, Container, PerspectiveMesh, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import { internals, type RendererInternals } from '../test/rendererInternals'

const mq = { matches: false }
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => mq })
})

const TEX = new Texture({
  source: new BufferImageSource({ resource: new Uint8Array(4), width: 800, height: 450 }),
})
const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
const turn = (ms?: number): Event => ({ StageTurn: ms == null ? {} : { duration_ms: ms } }) as Event
const prop = (path: string, depth = 2): Event => ({ Prop: { path, depth } }) as Event
const board = (path: string, depth = 3): Event => ({ BackgroundBoard: { path, depth } }) as Event
const boardFlip = (path: string, from: string, depth = 3): Event =>
  ({ BackgroundBoard: { path, depth, flip_from: from } }) as Event
const propFlip = (path: string, from: string, depth = 2): Event =>
  ({ Prop: { path, depth, flip_from: from } }) as Event
const wait = (ms: number): Event => ({ Wait: { ms } }) as Event
const theater = { CameraMode: { mode: 'Theater' } } as Event
const novelCam = { CameraMode: { mode: 'Novel' } } as Event
const scene = (events: Event[]): EventScene => ({ id: 'a', title: 'a', view: 'TopDown', events })

interface Entry {
  path: string
  sprite: { y: number } | null
  interval: number | null
}
type SlideLayer = Container & { entries: Entry[] }
interface LocalInternals extends RendererInternals {
  backgroundBoardLayer: SlideLayer
  propLayer: SlideLayer
  stageTurn: { flush(): void }
  time: { setMode(m: string): void; tick(ms: number): void }
  processDirective(e: Event): void
}
const li = (r: NovelRenderer): LocalInternals => internals<LocalInternals>(r)
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const sliding = (l: SlideLayer, path: string): boolean =>
  l.entries.find((e) => e.path === path)?.interval != null
const settled = (l: SlideLayer, path: string): boolean => {
  const e = l.entries.find((x) => x.path === path)
  return !!e && e.interval == null && e.sprite !== null && e.sprite.y === 225
}
const hosts = (l: Container): number =>
  l.children.filter((c) => c instanceof Container && c.sortableChildren).length
const meshes = (l: Container): number =>
  l.children
    .filter((c) => c instanceof Container && c.sortableChildren)
    .flatMap((h) => (h as Container).children)
    .filter((c) => c instanceof PerspectiveMesh).length

function make(events: Event[]): NovelRenderer {
  vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
  const r = new NovelRenderer()
  li(r).time.setMode('virtual')
  r.setAssetBaseUrl('/assets')
  r.setScenes([scene(events)])
  return r
}
const setSkip = (r: NovelRenderer, on: boolean): void => {
  ;(r as unknown as { skipMode: boolean }).skipMode = on
}
const advance = async (r: NovelRenderer): Promise<void> => {
  await r.playScript([{ type: 'advance' }])
  await flush()
}

afterEach(() => {
  vi.restoreAllMocks()
  mq.matches = false
})

const OLD = [theater, prop('A.png'), board('A.png')]
const BACK = [prop('B.png'), board('B.png')]

describe('回転舞台の流し込み: スキップ中に開いた範囲が、解除後に閉じても板・大道具は即時 (#996)', () => {
  it('(a) スキップ中に [舞台回転][背景板][大道具] を開き、スキップ解除後に閉じる', async () => {
    const r = make([...OLD, narration('one')])
    await flush()
    await advance(r)
    setSkip(r, true)
    li(r).processDirective(turn(1000))
    li(r).processDirective(board('X.png', 4))
    li(r).processDirective(prop('Y.png', 5))
    setSkip(r, false) // 待機で解除された状況
    li(r).stageTurn.flush()
    await flush()
    expect(hosts(li(r).propLayer)).toBe(0) // 回していない
    expect(settled(li(r).backgroundBoardLayer, 'X.png')).toBe(true)
    expect(settled(li(r).propLayer, 'Y.png')).toBe(true)
  })

  it('(a) 実経路: スキップ中に [舞台回転][背景板][大道具][待機] を進める（待機がスキップを解除してから範囲が閉じる）', async () => {
    const r = make([
      ...OLD,
      narration('one'),
      turn(1000),
      board('X.png', 4),
      prop('Y.png', 5),
      wait(10),
      narration('two'),
    ])
    await flush()
    setSkip(r, true)
    await advance(r)
    expect((r as unknown as { skipMode: boolean }).skipMode).toBe(false) // 待機で解除済み
    expect(hosts(li(r).propLayer)).toBe(0)
    expect(settled(li(r).backgroundBoardLayer, 'X.png')).toBe(true)
    expect(settled(li(r).propLayer, 'Y.png')).toBe(true)
  })

  it('(a) 流し込まれる 回転: 付きの板・大道具も、スキップ中に開いて解除後に閉じれば即時（旧面は clear 済みのフォールバック）', async () => {
    const r = make([...OLD, narration('one')])
    await flush()
    await advance(r)
    setSkip(r, true)
    li(r).processDirective(turn(1000))
    li(r).processDirective(boardFlip('X.png', 'A.png'))
    li(r).processDirective(propFlip('Y.png', 'A.png'))
    setSkip(r, false)
    li(r).stageTurn.flush()
    await flush()
    expect(hosts(li(r).propLayer)).toBe(0)
    expect(settled(li(r).backgroundBoardLayer, 'X.png')).toBe(true)
    expect(settled(li(r).propLayer, 'Y.png')).toBe(true)
  })

  it('(a) 範囲を開いた時点でスキップでなければ（シアター通常）回転し、板は回転後に最終位置', async () => {
    const r = make([...OLD, narration('one')])
    await flush()
    await advance(r)
    li(r).processDirective(turn(1000))
    li(r).processDirective(board('X.png', 4))
    li(r).processDirective(prop('Y.png', 5))
    li(r).stageTurn.flush()
    await flush()
    expect(meshes(li(r).propLayer)).toBe(2)
    expect(meshes(li(r).backgroundBoardLayer)).toBe(2)
    li(r).time.tick(1500)
    expect(hosts(li(r).propLayer)).toBe(0)
    expect(sliding(li(r).propLayer, 'Y.png')).toBe(false)
    // 回す経路の新面は回転後に現れるので、add の instant の値（fn(false)）は結果に効かない（fn(true) でも同じ最終状態）。
    expect(settled(li(r).propLayer, 'Y.png')).toBe(true)
    expect(settled(li(r).backgroundBoardLayer, 'X.png')).toBe(true)
  })
})

describe('回転舞台の流し込み: 回転せず即時の経路ではためた板・大道具が即時 (#996)', () => {
  const events = [...OLD, narration('one'), turn(1000), ...BACK, narration('two')]
  const expectInstant = (r: NovelRenderer): void => {
    expect(hosts(li(r).propLayer)).toBe(0)
    expect(settled(li(r).propLayer, 'B.png')).toBe(true)
    expect(settled(li(r).backgroundBoardLayer, 'B.png')).toBe(true)
  }

  it('ノベルのカメラ', async () => {
    const r = make([novelCam, ...OLD.slice(1), narration('one'), ...events.slice(4)])
    await flush()
    await advance(r)
    expectInstant(r)
  })
  it('動画書き出し中', async () => {
    const r = make(events)
    await flush()
    r.setExporting(true)
    await advance(r)
    expectInstant(r)
  })
  it('prefers-reduced-motion', async () => {
    mq.matches = true
    const r = make(events)
    await flush()
    await advance(r)
    expectInstant(r)
  })
  it('ノベルのカメラ: 回転: 付きの流し込みも即時', async () => {
    const r = make([
      novelCam,
      ...OLD.slice(1),
      narration('one'),
      turn(1000),
      boardFlip('X.png', 'A.png'),
      propFlip('Y.png', 'A.png'),
      narration('two'),
    ])
    await flush()
    await advance(r)
    expect(settled(li(r).backgroundBoardLayer, 'X.png')).toBe(true)
    expect(settled(li(r).propLayer, 'Y.png')).toBe(true)
  })
  it('時間=0', async () => {
    const r = make([...OLD, narration('one'), turn(0), ...BACK, narration('two')])
    await flush()
    await advance(r)
    expectInstant(r)
  })
})

describe('回転舞台の外の add は従来どおり (#996 退行なし)', () => {
  it('通常再生（スキップなし・シアター）の defer なしの [背景板:] [大道具:] はスライドインする', async () => {
    const r = make([theater, narration('one'), board('N.png'), prop('M.png'), narration('two')])
    await flush()
    await advance(r)
    expect(sliding(li(r).backgroundBoardLayer, 'N.png')).toBe(true)
    expect(sliding(li(r).propLayer, 'M.png')).toBe(true)
    li(r).time.tick(1000)
    expect(settled(li(r).backgroundBoardLayer, 'N.png')).toBe(true)
  })

  it('スキップ中の defer なしの add は即時', async () => {
    const r = make([theater, narration('one'), board('N.png'), prop('M.png'), narration('two')])
    await flush()
    setSkip(r, true)
    await advance(r)
    expect(settled(li(r).backgroundBoardLayer, 'N.png')).toBe(true)
    expect(settled(li(r).propLayer, 'M.png')).toBe(true)
  })
})
