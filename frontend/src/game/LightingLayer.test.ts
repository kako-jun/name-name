/**
 * LightingLayer（追うスポットライト #693）の単体テスト。
 *
 * `PropLayer.test.ts`/`BackgroundBoardLayer.test.ts` と同じ流儀（internals キャストで
 * private state を読む、`TimeController` を virtual モードで注入し `tick()` で決定論的に
 * ticker を進める）だが、LightingLayer は画像ロードではなく canvas 2D グラデーション生成
 * （`ambientEffects.buildDisplacementNoiseCanvas` と同じ方式）を使う点が異なる。
 *
 * このリポの jsdom 環境は `src/test/setup.ts` が `HTMLCanvasElement.prototype.getContext` を
 * 常に `null` を返すよう固定している（`ambientEffects.test.ts` が明記する既知の制約）ため、
 * `LightingLayer` 内部の `sprite` は本ファイルの全テストを通じて常に `null` になる。そのため
 * ここでは「sprite に反映された値」ではなく、`getState()`（settled state）・
 * `characterLayer.getCurrentPosition` への呼び出し内容・`document.createElement` の呼び出し
 * 回数・ticker(`tickerId`) の生存有無という、sprite が null でも観測できる契約を検証する
 * （CLAUDE.md doctrine: env-limit を盾にせず検証可能な範囲で確実に縛る）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LightingLayer, type SpotlightLayerState } from './LightingLayer'
import { TimeController } from './TimeController'
import type { CharacterLayer } from './CharacterLayer'

const SCREEN_W = 800
const SCREEN_H = 450

/** virtual モードの TimeController を 1 つ作る（実時計に乗らず tick() で進める）。 */
function virtualTime(): TimeController {
  const t = new TimeController()
  t.setMode('virtual')
  return t
}

/** `getCurrentPosition` だけを持つ最小の CharacterLayer モック。 */
function mockCharacterLayer(
  getCurrentPosition: (name: string) => { x: number; y: number } | null = () => null
): CharacterLayer {
  return { getCurrentPosition: vi.fn(getCurrentPosition) } as unknown as CharacterLayer
}

interface LightingLayerInternals {
  sprite: { visible: boolean } | null
  state: SpotlightLayerState | null
  tickerId: number | null
}
function internals(layer: LightingLayer): LightingLayerInternals {
  return layer as unknown as LightingLayerInternals
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LightingLayer 基本 / jsdom 環境防御 (#693)', () => {
  it('jsdom（canvas 2D 未実装）でも例外を投げずに構築でき、sprite は null のまま state 管理は継続する', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    expect(internals(layer).sprite).toBeNull()

    expect(() => layer.set(null, '#ff0000', 0.3)).not.toThrow()
    expect(layer.getState()).toEqual({ target: null, color: '#ff0000', radius: 0.3 })
  })

  it('eventMode は none（誤タップで本文が進むのを防ぐ、他の演出レイヤーと同じ規律）', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    expect(layer.eventMode).toBe('none')
  })

  it('色変更時にテクスチャを再構築しない（constructor で1回だけ canvas 生成、set() のたびに作り直さない）', () => {
    const createElementSpy = vi.spyOn(document, 'createElement')
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    const canvasCallsAfterConstruct = createElementSpy.mock.calls.filter(
      ([tag]) => tag === 'canvas'
    ).length
    expect(canvasCallsAfterConstruct).toBe(1)

    layer.set(null, '#ff0000', 0.2)
    layer.set(null, '#00ff00', 0.3)
    layer.set('alice', '#0000ff', 0.4)

    const canvasCallsAfterSets = createElementSpy.mock.calls.filter(
      ([tag]) => tag === 'canvas'
    ).length
    expect(canvasCallsAfterSets).toBe(canvasCallsAfterConstruct)
  })
})

describe('追従対象の解決 (#693)', () => {
  it('target 省略時は画面中央固定になり、characterLayer.getCurrentPosition は一度も呼ばれない', () => {
    const getCurrentPosition = vi.fn(() => null)
    const characterLayer = mockCharacterLayer(getCurrentPosition)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, characterLayer, time)

    layer.set(null, '#ffffff', 0.2)
    time.tick(64) // ticker を複数回まわす

    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('target 指定・表示中は毎フレーム getCurrentPosition(target) に現在座標を問い合わせる', () => {
    const getCurrentPosition = vi.fn(() => ({ x: 123, y: 45 }))
    const characterLayer = mockCharacterLayer(getCurrentPosition)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, characterLayer, time)

    layer.set('alice', '#ffffff', 0.2)
    time.tick(48) // 16ms ticker を3回分進める

    expect(getCurrentPosition).toHaveBeenCalledWith('alice')
    expect(getCurrentPosition.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('target 指定だが現在未表示（getCurrentPosition が null を返す）でも例外を投げず稼働を継続する', () => {
    const characterLayer = mockCharacterLayer(() => null)
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, characterLayer, time)

    layer.set('ghost', '#ffffff', 0.2)
    expect(() => time.tick(64)).not.toThrow()
    // state 自体は消えず点灯し続ける（フォールバックは座標だけの話、消灯はしない）。
    expect(layer.getState()).toEqual({ target: 'ghost', color: '#ffffff', radius: 0.2 })
  })

  it('表示中だったキャラが途中で退場（null 返却に切り替わる）しても例外を投げず稼働を継続する', () => {
    let visible = true
    const characterLayer = mockCharacterLayer(() => (visible ? { x: 10, y: 20 } : null))
    const time = virtualTime()
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, characterLayer, time)

    layer.set('alice', '#ffffff', 0.2)
    time.tick(16)
    visible = false // 退場完了で CharacterLayer の Map から削除された状態を模す
    expect(() => time.tick(32)).not.toThrow()
    expect(layer.getState()?.target).toBe('alice')
  })
})

describe('radius / color の境界値 (#693)', () => {
  it('radius の負値境界（-0.1→0 / 0 / 0.1）は Math.max(0, r) でクランプされる', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.set(null, '#ffffff', -0.1)
    expect(layer.getState()?.radius).toBe(0)
    layer.set(null, '#ffffff', 0)
    expect(layer.getState()?.radius).toBe(0)
    layer.set(null, '#ffffff', 0.1)
    expect(layer.getState()?.radius).toBe(0.1)
  })

  it('radius の非有限値（NaN/Infinity）は 0 ではなく既定 0.2 にフォールバックする（0クランプと非対称）', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.set(null, '#ffffff', NaN)
    expect(layer.getState()?.radius).toBe(0.2)
    layer.set(null, '#ffffff', Infinity)
    expect(layer.getState()?.radius).toBe(0.2)
  })

  it('color の空文字は白 (#ffffff) にフォールバックする', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.set(null, '', 0.2)
    expect(layer.getState()?.color).toBe('#ffffff')
  })
})

describe('状態遷移・復元 / ticker 管理 (#693)', () => {
  it('clear() で getState() が null になり、ticker(tickerId) も停止する', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.set(null, '#ffffff', 0.2)
    expect(internals(layer).tickerId).not.toBeNull()

    layer.clear()
    expect(layer.getState()).toBeNull()
    expect(internals(layer).tickerId).toBeNull()
  })

  it('restore(null) は消灯として、restore(state) は点灯として振る舞う（宣言的復元）', () => {
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), virtualTime())
    layer.restore({ target: 'bob', color: '#123456', radius: 0.4 })
    expect(layer.getState()).toEqual({ target: 'bob', color: '#123456', radius: 0.4 })

    layer.restore(null)
    expect(layer.getState()).toBeNull()
    expect(internals(layer).tickerId).toBeNull()
  })

  it('点灯中に複数回 set() を呼んでも ticker は多重起動しない（同じ id のまま）', () => {
    const time = virtualTime()
    const setIntervalSpy = vi.spyOn(time, 'setInterval')
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), time)

    layer.set(null, '#ff0000', 0.2)
    const tickerIdAfterFirst = internals(layer).tickerId
    layer.set(null, '#00ff00', 0.3) // 既に点灯中 → ensureTicker は早期 return するはず
    layer.set('someone', '#0000ff', 0.4)

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(internals(layer).tickerId).toBe(tickerIdAfterFirst)
  })

  it('clear() 後に再び set() すると新しい ticker が起動する（消灯→再点灯で id が発行し直される）', () => {
    const time = virtualTime()
    const setIntervalSpy = vi.spyOn(time, 'setInterval')
    const layer = new LightingLayer(SCREEN_W, SCREEN_H, mockCharacterLayer(), time)

    layer.set(null, '#ffffff', 0.2)
    layer.clear()
    layer.set(null, '#ffffff', 0.2)

    expect(setIntervalSpy).toHaveBeenCalledTimes(2)
    expect(internals(layer).tickerId).not.toBeNull()
  })
})
