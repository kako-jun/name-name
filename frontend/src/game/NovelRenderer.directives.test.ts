/**
 * NovelRenderer と directives/ の配線 (#829, #735 8/8)。
 *
 * ハンドラの中身は directives/*.test.ts と directives.equivalence.test.ts に任せ、ここでは
 * 「レンダラの processDirective が表のディスパッチを先に通し、フロー制御系だけを自前で処理するか」と
 * 「DirectiveContext が実レンダラの現在値・実レイヤーに繋がっているか」だけを見る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import { internals, internalsOf } from '../test/rendererInternals'
import { directiveTable, signalDirectiveTable, type DirectiveContext } from './directives'

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}
const SCENES = [scene('entry', [{ Narration: { text: ['本文'] } } as Event])]

interface H {
  directiveContext: DirectiveContext
  stage: DirectiveContext['stage']
  audioManager: DirectiveContext['audio']
  characterLayer: DirectiveContext['characters'] & { show(...a: unknown[]): void }
  videoLayer: DirectiveContext['layers']['video']
  skipMode: boolean
  assetBaseUrl: string
  initialized: boolean
  currentBgmPath: string | null
  telopClearEpoch: number
  waitingForWait: boolean
  processDirective(e: Event): void
  clearTelopLayer(): void
}

function make(): { r: NovelRenderer; h: H } {
  const r = new NovelRenderer()
  r.setAssetBaseUrl('/assets')
  r.setScenes(SCENES)
  return { r, h: internalsOf<H>(r) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelRenderer × directives 配線 (#829)', () => {
  it('演出系の種は表のハンドラを通って実レイヤー/実 Stage に届く', () => {
    const { h } = make()
    const bg = vi.spyOn(h.stage.background, 'setBackground').mockImplementation(() => {})
    const shake = vi.spyOn(h.stage.effects, 'startShake').mockImplementation(() => {})
    const bgm = vi.spyOn(h.audioManager, 'playBgm').mockImplementation(() => Promise.resolve())
    const show = vi.spyOn(h.characterLayer, 'show').mockImplementation(() => {})
    h.processDirective({ Background: { path: 'a.png' } } as Event)
    h.processDirective({ Shake: { intensity_px: 3, duration_ms: 100 } } as Event)
    h.processDirective({ Bgm: { path: 'a.mp3', action: 'Play', fade_ms: 10 } } as Event)
    h.processDirective({
      Enter: { character: 'A', expression: 'e', position: 'Left' },
    } as Event)
    expect(bg).toHaveBeenCalledTimes(1)
    expect(shake).toHaveBeenCalledWith(3, 100)
    expect(bgm).toHaveBeenCalledWith('/assets/sounds/a.mp3', 10)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('Bgm の再生/停止はレンダラの currentBgmPath を更新する（フック経由）', () => {
    const { h } = make()
    vi.spyOn(h.audioManager, 'playBgm').mockImplementation(() => Promise.resolve())
    vi.spyOn(h.audioManager, 'stopBgm').mockImplementation(() => {})
    h.processDirective({ Bgm: { path: 'a.mp3', action: 'Play' } } as Event)
    expect(h.currentBgmPath).toBe('a.mp3')
    h.processDirective({ Bgm: { path: null, action: 'Stop' } } as Event)
    expect(h.currentBgmPath).toBeNull()
  })

  it('フロー制御系は表に無く、レンダラが処理する（Flag は状態を変え、Wait は待機に入る）', () => {
    const { r, h } = make()
    for (const k of ['Flag', 'Choice', 'Jump', 'Wait', 'WaitDisplayComplete']) {
      expect(directiveTable.has(k) || signalDirectiveTable.has(k), k).toBe(false)
    }
    h.processDirective({ Flag: { name: 'x', value: 1 } } as unknown as Event)
    expect(r.getSnapshot().flags).toMatchObject({ x: 1 })
    h.processDirective({ Wait: { ms: 10_000 } } as Event)
    expect(h.waitingForWait).toBe(true)
  })

  it('未知のイベントは何もしない（例外も状態変化もない）', () => {
    const { r, h } = make()
    const before = JSON.stringify(r.getSnapshot())
    h.processDirective('NoSuchEvent' as unknown as Event)
    h.processDirective({ NoSuchEvent: {} } as unknown as Event)
    h.processDirective('PageBreak' as Event)
    expect(JSON.stringify(r.getSnapshot())).toBe(before)
  })

  it('DirectiveContext は実レンダラの現在値を毎回読む（生成時の値を固定しない）', () => {
    const { r, h } = make()
    const ctx = h.directiveContext
    expect(ctx.env.skipMode).toBe(false)
    h.skipMode = true
    expect(ctx.env.skipMode).toBe(true)
    r.setAssetBaseUrl('/other')
    expect(ctx.env.assetBaseUrl).toBe('/other')
    expect(ctx.env.initialized).toBe(h.initialized)
    h.clearTelopLayer()
    expect(ctx.env.telopClearEpoch).toBe(h.telopClearEpoch)
    expect(ctx.stage).toBe(h.stage)
    expect(ctx.audio).toBe(h.audioManager)
    expect(ctx.characters).toBe(h.characterLayer)
    expect(ctx.layers.video).toBe(h.videoLayer)
  })

  it('スキップ中の Enter は instant で立ち絵を出す（env.skipMode が実値に繋がっている）', () => {
    const { h } = make()
    const show = vi.spyOn(h.characterLayer, 'show').mockImplementation(() => {})
    h.skipMode = true
    h.processDirective({ Enter: { character: 'A', expression: 'e', position: 'Left' } } as Event)
    expect(show.mock.calls[0][4]).toMatchObject({ instant: true })
  })

  it('SceneTransition は旧実装と同じ対象をクリアする（動画の remove は2回）', () => {
    const { r, h } = make()
    const layers = internals(r) as unknown as {
      videoLayer: { remove(): void }
      backgroundBoardLayer: { clear(): void }
      propLayer: { clear(): void }
      curtainLayer: { clear(): void }
      lightingLayer: { clear(): void }
      eventImageLayer: { remove(): void }
    }
    const spies = [
      vi.spyOn(layers.videoLayer, 'remove'),
      vi.spyOn(layers.backgroundBoardLayer, 'clear'),
      vi.spyOn(layers.propLayer, 'clear'),
      vi.spyOn(layers.curtainLayer, 'clear'),
      vi.spyOn(layers.lightingLayer, 'clear'),
      vi.spyOn(layers.eventImageLayer, 'remove'),
    ]
    const epoch = h.telopClearEpoch
    h.processDirective('SceneTransition' as Event)
    expect(spies.map((s) => s.mock.calls.length)).toEqual([2, 1, 1, 1, 1, 1])
    expect(h.telopClearEpoch).toBe(epoch + 1)
  })
})
