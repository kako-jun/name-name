/**
 * 背景板（#683）・大道具（#692）のスキップ中即時化 (#996) の単体テスト。
 *
 * BackgroundBoardLayer と PropLayer は同じ API（add / replace / restore / clear）なので
 * describe.each で両方に同じ観点を当てる。スライドイン進行は virtual TimeController を
 * tick() で進めて決定論的に検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, type Texture } from 'pixi.js'
import { BackgroundBoardLayer } from './BackgroundBoardLayer'
import { PropLayer } from './PropLayer'
import { TimeController } from './TimeController'
import { BOARD_SLIDE_IN_MS } from './novelLayout'

const SCREEN_W = 800
const SCREEN_H = 450

function virtualTime(): TimeController {
  const t = new TimeController()
  t.setMode('virtual')
  return t
}
function mockAssetsLoadResolved(): void {
  vi.spyOn(Assets, 'load').mockResolvedValue({
    width: SCREEN_W,
    height: SCREEN_H,
    source: { scaleMode: 'linear' },
  } as unknown as Texture as never)
}
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Entry {
  path: string
  depth: number
  sprite: { y: number } | null
  interval: number | null
}
interface LayerLike {
  add(path: string, depth: number, assetBaseUrl: string, opts?: { instant?: boolean }): void
  replace(
    path: string,
    depth: number,
    fromPath: string,
    assetBaseUrl: string,
    opts?: { flipMs?: number | null; skip?: boolean }
  ): void
  restore(items: { path: string; depth: number }[], assetBaseUrl: string): void
  getState(): { path: string; depth: number }[]
  clear(): void
  children: { texture?: unknown }[]
}
const entriesOf = (l: LayerLike): Entry[] => (l as unknown as { entries: Entry[] }).entries

afterEach(() => {
  vi.restoreAllMocks()
})

const cases: [string, (t: TimeController) => LayerLike][] = [
  ['BackgroundBoardLayer', (t) => new BackgroundBoardLayer(SCREEN_W, SCREEN_H, t) as never],
  ['PropLayer', (t) => new PropLayer(SCREEN_W, SCREEN_H, t) as never],
]

describe.each(cases)('%s: スキップ中の追加は即時 (#996)', (_name, make) => {
  const FINAL_Y = SCREEN_H / 2

  it('add(instant:true) は補間タイマーを立てず、最初から最終位置・可視で置く', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = make(time)
    layer.add('a.png', 0, '/assets', { instant: true })
    await flushPromises()
    const e = entriesOf(layer)[0]
    expect(e.sprite?.y).toBe(FINAL_Y)
    expect(e.interval).toBeNull()
    expect(layer.children).toHaveLength(1)
    // 時間が進んでも動かない
    time.tick(BOARD_SLIDE_IN_MS + 32)
    expect(e.sprite?.y).toBe(FINAL_Y)
  })

  it('通常再生（instant 未指定 / false）は従来どおりスライドインする（退行なし）', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = make(time)
    layer.add('a.png', 0, '/assets')
    layer.add('b.png', 1, '/assets', { instant: false })
    await flushPromises()
    for (const e of entriesOf(layer)) {
      expect(e.sprite?.y).toBeCloseTo(FINAL_Y - SCREEN_H)
      expect(e.interval).not.toBeNull()
    }
    time.tick(BOARD_SLIDE_IN_MS + 32)
    for (const e of entriesOf(layer)) {
      expect(e.sprite?.y).toBe(FINAL_Y)
      expect(e.interval).toBeNull()
    }
  })

  it('スキップ→解除後の通常再生は再びスライドインする', async () => {
    mockAssetsLoadResolved()
    const layer = make(virtualTime())
    layer.add('a.png', 0, '/assets', { instant: true })
    layer.add('b.png', 1, '/assets', { instant: false })
    await flushPromises()
    const [a, b] = entriesOf(layer)
    expect(a.interval).toBeNull()
    expect(b.interval).not.toBeNull()
  })

  it('進行中のスライドインは、後からスキップ中の追加が来ても畳まれず最後まで続く', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = make(time)
    layer.add('a.png', 0, '/assets')
    await flushPromises()
    time.tick(BOARD_SLIDE_IN_MS / 2)
    const a = entriesOf(layer)[0]
    const yMid = a.sprite?.y as number
    expect(yMid).toBeLessThan(FINAL_Y)

    layer.add('b.png', 1, '/assets', { instant: true })
    await flushPromises()
    const [, b] = entriesOf(layer)
    expect(b.sprite?.y).toBe(FINAL_Y)
    expect(b.interval).toBeNull()
    expect(a.interval).not.toBeNull()
    expect(a.sprite?.y).toBe(yMid)

    time.tick(BOARD_SLIDE_IN_MS)
    expect(a.sprite?.y).toBe(FINAL_Y)
    expect(a.interval).toBeNull()
  })

  it('replace のフォールバック（旧い面が無い）は skip:true で即時、skip なしならスライドイン', async () => {
    mockAssetsLoadResolved()
    const layer = make(virtualTime())
    layer.replace('a.png', 0, 'none.png', '/assets', { skip: true })
    layer.replace('b.png', 1, 'none.png', '/assets', { skip: false })
    layer.replace('c.png', 2, 'none.png', '/assets')
    await flushPromises()
    const [a, b, c] = entriesOf(layer)
    expect(a.sprite?.y).toBe(FINAL_Y)
    expect(a.interval).toBeNull()
    expect(b.interval).not.toBeNull()
    expect(c.interval).not.toBeNull()
    expect(layer.getState()).toEqual([
      { path: 'a.png', depth: 0 },
      { path: 'b.png', depth: 1 },
      { path: 'c.png', depth: 2 },
    ])
  })

  it('restore（既存の instant 経路）は変わらず即時', async () => {
    mockAssetsLoadResolved()
    const layer = make(virtualTime())
    layer.restore([{ path: 'a.png', depth: 0 }], '/assets')
    await flushPromises()
    expect(entriesOf(layer)[0].interval).toBeNull()
    expect(entriesOf(layer)[0].sprite?.y).toBe(FINAL_Y)
  })

  it('即時追加でも depth 順（奥ほど先）に並び、getState は追加順の宣言を返す', async () => {
    mockAssetsLoadResolved()
    const layer = make(virtualTime())
    layer.add('near.png', 1, '/assets', { instant: true })
    layer.add('far.png', 5, '/assets', { instant: true })
    await flushPromises()
    expect(layer.getState()).toEqual([
      { path: 'near.png', depth: 1 },
      { path: 'far.png', depth: 5 },
    ])
    const order = entriesOf(layer)
      .filter((e) => e.sprite)
      .sort(
        (x, y) =>
          layer.children.indexOf(x.sprite as never) - layer.children.indexOf(y.sprite as never)
      )
      .map((e) => e.path)
    expect(order).toEqual(['far.png', 'near.png'])
  })

  it('即時追加の直後に clear しても読み込み完了後に何も出ず、タイマーも残らない', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = make(time)
    layer.add('a.png', 0, '/assets', { instant: true })
    layer.clear()
    await flushPromises()
    expect(layer.children).toHaveLength(0)
    expect(layer.getState()).toEqual([])
  })
})
