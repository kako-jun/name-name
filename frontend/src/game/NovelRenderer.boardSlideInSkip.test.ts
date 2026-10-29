/**
 * NovelRenderer: スキップ中は背景板・大道具のスライドインを即時にする配線 (#996)。
 * 幕の NovelRenderer.curtain.test.ts (#991) と同形。レイヤー自体の挙動は
 * boardSlideInSkip.test.ts でカバー済み。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

function scene(): EventScene {
  return { id: 'a', title: 'a', view: 'TopDown', events: [{ Narration: { text: ['one'] } }] }
}
const board = (path: string, depth?: number, flipFrom?: string): Event =>
  ({ BackgroundBoard: { path, depth, flip_from: flipFrom } }) as unknown as Event
const prop = (path: string, depth?: number, flipFrom?: string): Event =>
  ({ Prop: { path, depth, flip_from: flipFrom } }) as unknown as Event

type AddFn = (p: string, d: number, base: string, o?: { instant?: boolean }) => void
type ReplaceFn = (p: string, d: number, from: string, base: string, o?: { skip?: boolean }) => void
interface Layers {
  backgroundBoardLayer: { add: AddFn; replace: ReplaceFn }
  propLayer: { add: AddFn; replace: ReplaceFn }
}

function setup() {
  const r = new NovelRenderer()
  r.setScenes([scene()])
  const l = r as unknown as Layers
  return {
    r,
    boardAdd: vi.spyOn(l.backgroundBoardLayer, 'add'),
    propAdd: vi.spyOn(l.propLayer, 'add'),
    boardReplace: vi.spyOn(l.backgroundBoardLayer, 'replace'),
    propReplace: vi.spyOn(l.propLayer, 'replace'),
  }
}
const proc = (r: NovelRenderer, e: Event) =>
  (r as unknown as { processDirective: (e: Event) => void }).processDirective(e)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelRenderer 背景板・大道具: スキップ中は即時 (#996)', () => {
  it('通常再生は instant:false、スキップ中は instant:true、解除後は再び false', () => {
    const { r, boardAdd, propAdd } = setup()
    proc(r, board('a.png', 2))
    proc(r, prop('p.png', 3))
    expect(boardAdd).toHaveBeenLastCalledWith('a.png', 2, expect.any(String), { instant: false })
    expect(propAdd).toHaveBeenLastCalledWith('p.png', 3, expect.any(String), { instant: false })

    r.setSkipMode(true)
    proc(r, board('b.png'))
    proc(r, prop('q.png'))
    expect(boardAdd).toHaveBeenLastCalledWith('b.png', 0, expect.any(String), { instant: true })
    expect(propAdd).toHaveBeenLastCalledWith('q.png', 0, expect.any(String), { instant: true })

    r.setSkipMode(false)
    proc(r, board('c.png'))
    proc(r, prop('r.png'))
    expect(boardAdd).toHaveBeenLastCalledWith('c.png', 0, expect.any(String), { instant: false })
    expect(propAdd).toHaveBeenLastCalledWith('r.png', 0, expect.any(String), { instant: false })
  })

  it('回転: 付きは replace に skip が渡り、旧面が無いフォールバックの add も instant になる', () => {
    const { r, boardAdd, propAdd, boardReplace, propReplace } = setup()
    r.setSkipMode(true)
    proc(r, board('b.png', 1, 'a.png'))
    proc(r, prop('q.png', 1, 'p.png'))
    expect(boardReplace).toHaveBeenLastCalledWith(
      'b.png',
      1,
      'a.png',
      expect.any(String),
      expect.objectContaining({ skip: true })
    )
    expect(propReplace).toHaveBeenLastCalledWith(
      'q.png',
      1,
      'p.png',
      expect.any(String),
      expect.objectContaining({ skip: true })
    )
    // 旧い面が無いので replace は通常追加へフォールバックし、そこでも instant が伝わる。
    expect(boardAdd).toHaveBeenCalledWith('b.png', 1, expect.any(String), { instant: true })
    expect(propAdd).toHaveBeenCalledWith('q.png', 1, expect.any(String), { instant: true })
  })

  it('スキップ中でも保存状態（settled state）は変わらない', () => {
    const { r } = setup()
    r.setSkipMode(true)
    proc(r, board('b.png', 2))
    proc(r, prop('q.png', 3))
    const snap = r.getSnapshot()
    expect(snap.backgroundBoards).toEqual([{ path: 'b.png', depth: 2 }])
    expect(snap.props).toEqual([{ path: 'q.png', depth: 3 }])
  })
})
