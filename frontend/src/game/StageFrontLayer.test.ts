/**
 * StageFrontLayer（画面最下部の舞台前面 #705）の単体テスト。
 * `Assets.load` をモックして jsdom で画像の非同期ロード経路まで検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Sprite, type Texture } from 'pixi.js'
import { StageFrontLayer } from './StageFrontLayer'

const SCREEN_W = 800
const SCREEN_H = 450

function mockTexture(width = SCREEN_W, height = 100): Texture {
  return { width, height, source: { scaleMode: 'linear' } } as unknown as Texture
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function make(w = SCREEN_W, h = SCREEN_H) {
  return new StageFrontLayer(w, h)
}
const sprites = (layer: StageFrontLayer) => layer.children.filter((c) => c instanceof Sprite)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('StageFrontLayer 読み込み', () => {
  it('Assets.load(images/…) で読み、Sprite を1枚載せる', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('apron.png', '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledWith('/assets/images/apron.png')
    expect(sprites(layer)).toHaveLength(1)
    expect(layer.hasImage()).toBe(true)
  })

  it('assetBaseUrl が空なら読み込まないが、getState() には載る', () => {
    const load = vi.spyOn(Assets, 'load')
    const layer = make()
    layer.show('apron.png', '')
    expect(load).not.toHaveBeenCalled()
    expect(layer.getState()).toEqual({ path: 'apron.png' })
    expect(layer.hasImage()).toBe(false)
  })

  it('StageFrontLayer 自身はクリックを受けない', () => {
    expect(make().eventMode).toBe('none')
  })

  it('画像の読み込み失敗は警告だけで落ちず、宣言（getState）は残る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const layer = make()
    layer.show('missing.png', '/assets')
    await flushPromises()
    expect(warn).toHaveBeenCalled()
    expect(layer.hasImage()).toBe(false)
    expect(layer.getState()).toEqual({ path: 'missing.png' })
  })

  it('寸法 0 のテクスチャは置かない（NaN 配置を作らない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture(0, 0) as never)
    const layer = make()
    layer.show('zero.png', '/assets')
    await flushPromises()
    expect(layer.hasImage()).toBe(false)
  })
})

describe('StageFrontLayer 配置（下端揃え・横幅フィット）', () => {
  it.each([
    ['横長画面 800x450・画像 800x100', 800, 450, 800, 100, 350, 100],
    ['画像が画面幅と違う（400x50 → 幅 800 に拡大）', 800, 450, 400, 50, 350, 100],
    ['縦長画面 360x640・画像 720x100', 360, 640, 720, 100, 590, 50],
    ['画像が画面より幅広（1600x200 → 縮小）', 800, 450, 1600, 200, 350, 100],
  ])('%s', async (_n, sw, sh, tw, th, expectY, expectH) => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture(tw, th) as never)
    const layer = make(sw, sh)
    layer.show('a.png', '/assets')
    await flushPromises()
    const s = sprites(layer)[0] as Sprite
    expect(s.x).toBe(0)
    expect(s.width).toBe(sw)
    expect(s.height).toBe(expectH)
    expect(s.y).toBe(expectY)
    // 下端は常に画面の最下部。
    expect(s.y + s.height).toBe(sh)
  })

  it('画像が画面より高くなっても下端は画面の最下部に揃う（上へはみ出す）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture(100, 100) as never)
    const layer = make(400, 300)
    layer.show('tall.png', '/assets')
    await flushPromises()
    const s = sprites(layer)[0] as Sprite
    expect(s.y + s.height).toBe(300)
    expect(s.y).toBeLessThan(0)
  })
})

describe('StageFrontLayer 単一スロット', () => {
  it('新しい前面が前の前面を置換する', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', '/assets')
    await flushPromises()
    const first = sprites(layer)[0]
    layer.show('b.png', '/assets')
    await flushPromises()
    expect(sprites(layer)).toHaveLength(1)
    expect(sprites(layer)[0]).not.toBe(first)
    expect(first.destroyed).toBe(true)
    expect(layer.getState()).toEqual({ path: 'b.png' })
  })

  it('ロード中に次の前面が来たら古い応答を捨てる（遅れて届いた画像が上書きしない）', async () => {
    let resolveA!: (t: Texture) => void
    const pendingA = new Promise<Texture>((r) => (resolveA = r))
    vi.spyOn(Assets, 'load').mockImplementation(((url: string) =>
      url.endsWith('a.png') ? pendingA : Promise.resolve(mockTexture())) as never)
    const layer = make()
    layer.show('a.png', '/assets')
    layer.show('b.png', '/assets')
    await flushPromises()
    resolveA(mockTexture())
    await flushPromises()
    expect(sprites(layer)).toHaveLength(1)
    expect(layer.getState()?.path).toBe('b.png')
  })

  it('ロード中に clear() されたら画像は出ない', async () => {
    let resolveA!: (t: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(new Promise<Texture>((r) => (resolveA = r)) as never)
    const layer = make()
    layer.show('a.png', '/assets')
    layer.clear()
    resolveA(mockTexture())
    await flushPromises()
    expect(layer.hasImage()).toBe(false)
    expect(layer.getState()).toBeNull()
  })

  it('clear() は Sprite を destroy（texture は壊さない）し、何度呼んでも安全', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    expect(() => layer.clear()).not.toThrow()
    layer.show('a.png', '/assets')
    await flushPromises()
    const s = sprites(layer)[0] as Sprite
    const destroy = vi.spyOn(s, 'destroy')
    layer.clear()
    layer.clear()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(destroy.mock.calls[0]).toEqual([])
    expect(sprites(layer)).toHaveLength(0)
    expect(layer.getState()).toBeNull()
  })
})

describe('StageFrontLayer 状態・復元', () => {
  it('getState は「パス」だけで、返り値の書き換えが内部に影響しない', () => {
    const layer = make()
    layer.show('a.png', '')
    const st = layer.getState()!
    expect(Object.keys(st)).toEqual(['path'])
    st.path = 'tampered'
    expect(layer.getState()).toEqual({ path: 'a.png' })
  })

  it('前面なしの getState は null', () => {
    expect(make().getState()).toBeNull()
  })

  it('restore(null) は前面を消す。restore(state) は最終状態を show する', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', '/assets')
    await flushPromises()
    layer.restore(null, '/assets')
    expect(layer.getState()).toBeNull()
    expect(layer.hasImage()).toBe(false)
    layer.restore({ path: 'b.png' }, '/assets')
    await flushPromises()
    expect(layer.getState()).toEqual({ path: 'b.png' })
    expect(layer.hasImage()).toBe(true)
  })

  it('同一の前面の restore は Sprite を作り直さず再読み込みもしない', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', '/assets')
    await flushPromises()
    const s = sprites(layer)[0]
    layer.restore({ path: 'a.png' }, '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(1)
    expect(sprites(layer)[0]).toBe(s)
    expect(s.destroyed).toBe(false)
  })

  it('path が異なる restore は差し替える', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', '/assets')
    await flushPromises()
    layer.restore({ path: 'b.png' }, '/assets')
    await flushPromises()
    expect(layer.getState()).toEqual({ path: 'b.png' })
    expect(sprites(layer)).toHaveLength(1)
  })

  it('画像のロード失敗後の同一 restore は読み込み直す', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const load = vi.spyOn(Assets, 'load').mockRejectedValueOnce(new Error('404'))
    const layer = make()
    layer.show('a.png', '/assets')
    await flushPromises()
    load.mockResolvedValue(mockTexture() as never)
    layer.restore({ path: 'a.png' }, '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(2)
    expect(layer.hasImage()).toBe(true)
  })

  it('assetBaseUrl が空で show した後の同一 restore は（baseUrl が入れば）読み込む', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', '')
    layer.restore({ path: 'a.png' }, '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(1)
    expect(layer.hasImage()).toBe(true)
  })

  it('assetBaseUrl が差し替わったら同一の前面でも読み直す', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const layer = make()
    layer.show('a.png', '/assets')
    await flushPromises()
    layer.restore({ path: 'a.png' }, '/other')
    await flushPromises()
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenLastCalledWith('/other/images/a.png')
  })

  it('画像のロードが進行中なら同一 restore は二重にロードしない', () => {
    const load = vi.spyOn(Assets, 'load').mockReturnValue(new Promise(() => {}) as never)
    const layer = make()
    layer.show('a.png', '/assets')
    layer.restore({ path: 'a.png' }, '/assets')
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
    layer.show('a.png', '/assets')
    layer.show('b.png', '/assets')
    rejectA(new Error('late'))
    await flushPromises()
    layer.restore({ path: 'b.png' }, '/assets')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('getState → restore の往復で同じ状態に戻る', () => {
    const a = make()
    a.show('x.png', '/assets')
    const st = a.getState()
    const b = make()
    b.restore(st, '/assets')
    expect(b.getState()).toEqual(st)
  })
})

describe('StageFrontLayer 後始末（リーク）', () => {
  it('disposeTextures は読み込んだ画像 URL だけを Assets.unload し、二重解放しない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = make()
    layer.show('a.png', '/assets')
    await flushPromises()
    layer.show('b.png', '/assets')
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
    layer.show('a.png', '/assets')
    await flushPromises()
    layer.disposeTextures()
    await flushPromises()
    expect(warn).toHaveBeenCalled()
  })
})
