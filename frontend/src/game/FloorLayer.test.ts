/**
 * FloorLayer（画面下部の床の帯 #706 第2弾）の単体テスト。
 * `Assets.load` をモックして jsdom で画像の非同期ロード経路まで検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, TilingSprite, type Texture } from 'pixi.js'
import { FloorLayer } from './FloorLayer'

const SCREEN_W = 800
const SCREEN_H = 400

function mockTexture(width = 64, height = 32): Texture {
  return { width, height, source: { scaleMode: 'linear' } } as unknown as Texture
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function make(w = SCREEN_W, h = SCREEN_H) {
  return new FloorLayer(w, h)
}
const tiles = (layer: FloorLayer) => layer.children.filter((c) => c instanceof TilingSprite)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FloorLayer 読み込み', () => {
  it('Assets.load(images/…) で読み、TilingSprite を1枚載せる', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('wood.png', 0.25, '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledWith('/assets/images/wood.png')
    expect(tiles(layer)).toHaveLength(1)
    expect(layer.hasImage()).toBe(true)
  })

  it('assetBaseUrl が空なら読み込まないが、getState() には載る', () => {
    const load = vi.spyOn(Assets, 'load')
    const layer = make()
    layer.show('wood.png', 0.4, '')
    expect(load).not.toHaveBeenCalled()
    expect(layer.getState()).toEqual({ path: 'wood.png', height: 0.4 })
    expect(layer.hasImage()).toBe(false)
  })

  it('FloorLayer 自身はクリックを受けない', () => {
    expect(make().eventMode).toBe('none')
  })

  it('画像の読み込み失敗は警告だけで落ちず、宣言（getState）は残る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const layer = make()
    layer.show('missing.png', 0.25, '/assets')
    await flushPromises()
    expect(warn).toHaveBeenCalled()
    expect(layer.hasImage()).toBe(false)
    expect(layer.getState()).toEqual({ path: 'missing.png', height: 0.25 })
  })

  it('寸法 0 のテクスチャは置かない（NaN 配置を作らない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture(0, 0) as never)
    const layer = make()
    layer.show('zero.png', 0.25, '/assets')
    await flushPromises()
    expect(layer.hasImage()).toBe(false)
  })
})

describe('FloorLayer 配置（下端揃え・横幅フィット・タイル）', () => {
  it('帯は 画面高さ×高さ比、下端揃え、横幅いっぱい。tileScale で画像の高さを帯の高さに合わせる', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture(64, 32) as never)
    const layer = make(800, 400)
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    const t = tiles(layer)[0] as TilingSprite
    expect(t.x).toBe(0)
    expect(t.width).toBe(800)
    expect(t.height).toBe(100)
    expect(t.y).toBe(300)
    expect(t.y + t.height).toBe(400)
    // 画像 32px 高 → 帯 100px 高。縦横比を保つので横も同じ倍率
    expect(t.tileScale.x).toBe(100 / 32)
    expect(t.tileScale.y).toBe(100 / 32)
  })

  it('高さ=0.5 だと帯が厚くなる（高さが倍・タイルも倍の大きさ）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture(64, 32) as never)
    const layer = make(800, 400)
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    const thin = tiles(layer)[0] as TilingSprite
    const thinH = thin.height
    const thinScale = thin.tileScale.x
    layer.show('a.png', 0.5, '/assets')
    await flushPromises()
    const thick = tiles(layer)[0] as TilingSprite
    expect(thick.height).toBe(200)
    expect(thick.height).toBe(thinH * 2)
    expect(thick.y).toBe(200)
    expect(thick.tileScale.x).toBe(thinScale * 2)
  })

  it('範囲外・不正な高さは寄せられる（99→全画面、0.001→0.05、NaN→既定）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const heights: Array<[number, number]> = [
      [99, 400],
      [0.001, 20],
      [NaN, 100],
      [-1, 100],
    ]
    for (const [input, expected] of heights) {
      const layer = make(800, 400)
      layer.show('a.png', input, '/assets')
      await flushPromises()
      expect((tiles(layer)[0] as TilingSprite).height).toBeCloseTo(expected, 10)
    }
  })

  it('高さ省略（undefined）は既定 0.25', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make(800, 400)
    layer.show('a.png', undefined, '/assets')
    await flushPromises()
    expect(layer.getState()).toEqual({ path: 'a.png', height: 0.25 })
    expect((tiles(layer)[0] as TilingSprite).height).toBe(100)
  })

  it.each([
    ['横長 1280x720', 1280, 720],
    ['縦長 360x640', 360, 640],
  ])('%s: 下端は画面の最下部・横幅は画面幅', async (_n, sw, sh) => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture(128, 64) as never)
    const layer = make(sw, sh)
    layer.show('a.png', 0.3, '/assets')
    await flushPromises()
    const t = tiles(layer)[0] as TilingSprite
    expect(t.width).toBe(sw)
    expect(t.height).toBeCloseTo(sh * 0.3, 10)
    expect(t.y + t.height).toBeCloseTo(sh, 10)
  })
})

describe('FloorLayer 単一スロット', () => {
  it('新しい床が前の床を置換する', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    const first = tiles(layer)[0]
    layer.show('b.png', 0.5, '/assets')
    await flushPromises()
    expect(tiles(layer)).toHaveLength(1)
    expect(tiles(layer)[0]).not.toBe(first)
    expect(first.destroyed).toBe(true)
    expect(layer.getState()).toEqual({ path: 'b.png', height: 0.5 })
  })

  it('ロード中に次の床が来たら古い応答を捨てる（遅れて届いた画像が上書きしない）', async () => {
    let resolveA!: (t: Texture) => void
    const pendingA = new Promise<Texture>((r) => (resolveA = r))
    vi.spyOn(Assets, 'load').mockImplementation(((url: string) =>
      url.endsWith('a.png') ? pendingA : Promise.resolve(mockTexture())) as never)
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    layer.show('b.png', 0.25, '/assets')
    await flushPromises()
    resolveA(mockTexture())
    await flushPromises()
    expect(tiles(layer)).toHaveLength(1)
    expect(layer.getState()?.path).toBe('b.png')
  })

  it('ロード中に clear() されたら画像は出ない', async () => {
    let resolveA!: (t: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(new Promise<Texture>((r) => (resolveA = r)) as never)
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    layer.clear()
    resolveA(mockTexture())
    await flushPromises()
    expect(layer.hasImage()).toBe(false)
    expect(layer.getState()).toBeNull()
  })

  it('clear() は TilingSprite を destroy（texture は壊さない）し、何度呼んでも安全', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    expect(() => layer.clear()).not.toThrow()
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    const t = tiles(layer)[0] as TilingSprite
    const destroy = vi.spyOn(t, 'destroy')
    layer.clear()
    layer.clear()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(destroy.mock.calls[0]).toEqual([])
    expect(tiles(layer)).toHaveLength(0)
    expect(layer.getState()).toBeNull()
  })
})

describe('FloorLayer 状態・復元', () => {
  it('getState は「パス＋高さ」だけで、返り値の書き換えが内部に影響しない', () => {
    const layer = make()
    layer.show('a.png', 0.4, '')
    const st = layer.getState()!
    expect(Object.keys(st).sort()).toEqual(['height', 'path'])
    st.path = 'tampered'
    st.height = 1
    expect(layer.getState()).toEqual({ path: 'a.png', height: 0.4 })
  })

  it('床なしの getState は null', () => {
    expect(make().getState()).toBeNull()
  })

  it('restore(null) は床を消す。restore(state) は最終状態を show する', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    layer.restore(null, '/assets')
    expect(layer.getState()).toBeNull()
    expect(layer.hasImage()).toBe(false)
    layer.restore({ path: 'b.png', height: 0.4 }, '/assets')
    await flushPromises()
    expect(layer.getState()).toEqual({ path: 'b.png', height: 0.4 })
    expect(layer.hasImage()).toBe(true)
  })

  it('同一の床の restore は帯を作り直さず再読み込みもしない', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', 0.4, '/assets')
    await flushPromises()
    const t = tiles(layer)[0]
    layer.restore({ path: 'a.png', height: 0.4 }, '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(1)
    expect(tiles(layer)[0]).toBe(t)
    expect(t.destroyed).toBe(false)
  })

  it('path が異なる restore は差し替える', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    layer.restore({ path: 'b.png', height: 0.25 }, '/assets')
    await flushPromises()
    expect(layer.getState()).toEqual({ path: 'b.png', height: 0.25 })
    expect(tiles(layer)).toHaveLength(1)
  })

  it('高さだけが異なる restore も差し替える（帯の厚みが変わる）', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make(800, 400)
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    layer.restore({ path: 'a.png', height: 0.5 }, '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(2)
    expect(layer.getState()).toEqual({ path: 'a.png', height: 0.5 })
    expect((tiles(layer)[0] as TilingSprite).height).toBe(200)
  })

  it('画像のロード失敗後の同一 restore は読み込み直す', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const load = vi.spyOn(Assets, 'load').mockRejectedValueOnce(new Error('404'))
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    load.mockResolvedValue(mockTexture() as never)
    layer.restore({ path: 'a.png', height: 0.25 }, '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(2)
    expect(layer.hasImage()).toBe(true)
  })

  it('assetBaseUrl が空で show した後の同一 restore は（baseUrl が入れば）読み込む', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', 0.25, '')
    layer.restore({ path: 'a.png', height: 0.25 }, '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(1)
    expect(layer.hasImage()).toBe(true)
  })

  it('assetBaseUrl が差し替わったら同一の床でも読み直す', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    layer.restore({ path: 'a.png', height: 0.25 }, '/other')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenLastCalledWith('/other/images/a.png')
  })

  it('画像のロードが進行中なら同一 restore は二重にロードしない', () => {
    const load = vi.spyOn(Assets, 'load').mockReturnValue(new Promise(() => {}) as never)
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    layer.restore({ path: 'a.png', height: 0.25 }, '/assets')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('旧ロードの失敗が新ロード進行中に届いても loading を下ろさず、同一 restore で二重ロードしない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejectA!: (e: Error) => void
    const load = vi
      .spyOn(Assets, 'load')
      .mockImplementation(((url: string) =>
        url.endsWith('a.png')
          ? new Promise((_r, rej) => (rejectA = rej))
          : new Promise(() => {})) as never)
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    layer.show('b.png', 0.25, '/assets')
    rejectA(new Error('late'))
    await flushPromises()
    layer.restore({ path: 'b.png', height: 0.25 }, '/assets')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('getState → restore の往復で同じ状態に戻る', () => {
    const a = make()
    a.show('x.png', 0.4, '/assets')
    const st = a.getState()
    const b = make()
    b.restore(st, '/assets')
    expect(b.getState()).toEqual(st)
  })
})

describe('FloorLayer 後始末（リーク）', () => {
  it('disposeTextures は読み込んだ画像 URL だけを Assets.unload し、二重解放しない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    layer.show('b.png', 0.25, '/assets')
    await flushPromises()
    layer.disposeTextures()
    expect(unload.mock.calls.map((c) => c[0]).sort()).toEqual([
      '/assets/images/a.png',
      '/assets/images/b.png',
    ])
    layer.disposeTextures()
    expect(unload).toHaveBeenCalledTimes(2)
  })

  it('何も読んでいなければ disposeTextures は Assets.unload を呼ばない', () => {
    const unload = vi.spyOn(Assets, 'unload')
    make().disposeTextures()
    expect(unload).not.toHaveBeenCalled()
  })

  it('テクスチャ解放の失敗は警告だけで落ちない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    vi.spyOn(Assets, 'unload').mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = make()
    layer.show('a.png', 0.25, '/assets')
    await flushPromises()
    layer.disposeTextures()
    await flushPromises()
    expect(warn).toHaveBeenCalled()
  })
})
