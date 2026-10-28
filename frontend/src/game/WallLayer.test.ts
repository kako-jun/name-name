/**
 * WallLayer（背景板より奥の壁 #703）の単体テスト。
 *
 * - `Assets.load` をモックして jsdom で画像の非同期ロード経路まで検証する。
 * - 動画の再生・解放は既存 `VideoLayer` の責務なので、`VideoLayer` を記録用の偽物に差し替え、
 *   「いつ・何を渡して show/remove したか」だけを検証する（動画のライフサイクルは書き起こさない）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Assets, Sprite, type Texture } from 'pixi.js'
import { THEATER_ELEVATION_OFFSET_PER_DEPTH, computeCameraProjection } from './cameraProjection'
import { WALL_DEPTH, WallLayer, computeWallFrame } from './WallLayer'

const videoMock = vi.hoisted(() => {
  const instances: Array<{
    shown: Array<{ path: string; opts: Record<string, unknown> }>
    removed: number
    baseUrls: string[]
    active: boolean
    export: number
    playingToEnd: boolean
  }> = []
  return { instances }
})

vi.mock('./VideoLayer', async () => {
  const { Container } = await import('pixi.js')
  class FakeVideoLayer extends Container {
    rec = {
      shown: [] as Array<{ path: string; opts: Record<string, unknown> }>,
      removed: 0,
      baseUrls: [] as string[],
      active: false,
      export: 0,
      playingToEnd: false,
    }
    constructor() {
      super()
      videoMock.instances.push(this.rec)
    }
    setAssetBaseUrl(url: string) {
      this.rec.baseUrls.push(url)
    }
    show(path: string, opts: Record<string, unknown> = {}) {
      this.rec.shown.push({ path, opts })
      this.rec.active = true
    }
    remove() {
      this.rec.removed++
      this.rec.active = false
    }
    hasVideo() {
      return this.rec.active
    }
    async prepareForExport() {
      this.rec.export++
    }
    isPlayingToEnd() {
      return this.rec.playingToEnd
    }
  }
  return { VideoLayer: FakeVideoLayer }
})

const SCREEN_W = 800
const SCREEN_H = 450

function mockTexture(width = SCREEN_W, height = SCREEN_H): Texture {
  return { width, height, source: { scaleMode: 'linear' } } as unknown as Texture
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function make() {
  const layer = new WallLayer(SCREEN_W, SCREEN_H)
  const video = videoMock.instances[videoMock.instances.length - 1]
  const frame = layer.children[0] as import('pixi.js').Container
  return { layer, video, frame }
}

beforeEach(() => {
  videoMock.instances.length = 0
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('WallLayer 画像と動画の判別', () => {
  it('画像の壁は Assets.load(images/…) で読み、VideoLayer は触らない', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const { layer, video } = make()
    layer.show('glow.webp', {}, '/assets')
    await flushPromises()
    expect(load).toHaveBeenCalledWith('/assets/images/glow.webp')
    expect(video.shown).toEqual([])
    expect(layer.hasImage()).toBe(true)
    expect(layer.hasVideo()).toBe(false)
  })

  it('動画の壁は VideoLayer.show（videos/ の URL 化は VideoLayer 側）に委譲し、Assets.load は呼ばない', () => {
    const load = vi.spyOn(Assets, 'load')
    const { layer, video } = make()
    layer.show('stars.webm', {}, '/assets')
    expect(load).not.toHaveBeenCalled()
    expect(video.baseUrls).toEqual(['/assets'])
    expect(video.shown).toEqual([
      { path: 'stars.webm', opts: { position: 'center', loop: true, mute: true } },
    ])
    expect(layer.hasVideo()).toBe(true)
    expect(layer.hasImage()).toBe(false)
  })

  it.each(['a.mp4', 'a.WEBM', 'dir/a.Ogv', 'a.mov', 'a.m4v', 'a.webm?v=2'])(
    '%s は動画として扱う',
    (path) => {
      const { layer, video } = make()
      layer.show(path, {}, '/assets')
      expect(video.shown).toHaveLength(1)
    }
  )

  it.each(['a.webp', 'a.png', 'a.gif', 'a', 'webm', 'a.webm.png', 'dir.webm/a.png'])(
    '%s は画像として扱う',
    async (path) => {
      const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
      const { layer, video } = make()
      layer.show(path, {}, '/assets')
      await flushPromises()
      expect(video.shown).toEqual([])
      expect(load).toHaveBeenCalledTimes(1)
    }
  )

  it('ループ・ミュートの既定は true。false を明示したときだけ false で VideoLayer へ渡る', () => {
    const { layer, video } = make()
    layer.show('a.webm', { loop: false }, '/assets')
    layer.show('b.webm', { mute: false }, '/assets')
    layer.show('c.webm', { loop: false, mute: false }, '/assets')
    expect(video.shown.map((s) => [s.opts.loop, s.opts.mute])).toEqual([
      [false, true],
      [true, false],
      [false, false],
    ])
  })

  it('assetBaseUrl が空なら読み込まないが、getState() には載る', () => {
    const load = vi.spyOn(Assets, 'load')
    const { layer, video } = make()
    layer.show('a.webp', {}, '')
    layer.show('b.webm', {}, '')
    expect(load).not.toHaveBeenCalled()
    expect(video.shown).toEqual([])
    expect(layer.getState()).toEqual({ path: 'b.webm', loop: true, mute: true })
  })
})

describe('WallLayer 単一スロット', () => {
  it('新しい壁が前の壁を置換する（画像→画像）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const { layer, frame } = make()
    layer.show('a.webp', {}, '/assets')
    await flushPromises()
    const first = frame.children.find((c) => c instanceof Sprite)
    layer.show('b.webp', {}, '/assets')
    await flushPromises()
    const sprites = frame.children.filter((c) => c instanceof Sprite)
    expect(sprites).toHaveLength(1)
    expect(sprites[0]).not.toBe(first)
    expect(first?.destroyed).toBe(true)
    expect(layer.getState()?.path).toBe('b.webp')
  })

  it('画像→動画で画像 Sprite が消え、動画→画像で VideoLayer.remove される', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const { layer, video, frame } = make()
    layer.show('a.webp', {}, '/assets')
    await flushPromises()
    layer.show('b.webm', {}, '/assets')
    expect(frame.children.some((c) => c instanceof Sprite)).toBe(false)
    expect(layer.hasVideo()).toBe(true)
    const removedBefore = video.removed
    layer.show('c.webp', {}, '/assets')
    expect(video.removed).toBeGreaterThan(removedBefore)
    expect(layer.hasVideo()).toBe(false)
    await flushPromises()
    expect(layer.hasImage()).toBe(true)
  })

  it('動画→動画は show のたびに先に remove が走る（前の video 要素を解放してから）', () => {
    const { layer, video } = make()
    layer.show('a.webm', {}, '/assets')
    const r1 = video.removed
    layer.show('b.webm', {}, '/assets')
    expect(video.removed).toBeGreaterThan(r1)
    expect(video.shown.map((s) => s.path)).toEqual(['a.webm', 'b.webm'])
  })

  it('ロード中に次の壁が来たら古い応答を捨てる（遅れて届いた画像が上書きしない）', async () => {
    let resolveA!: (t: Texture) => void
    const pendingA = new Promise<Texture>((r) => (resolveA = r))
    vi.spyOn(Assets, 'load').mockImplementation(((url: string) =>
      url.endsWith('a.webp') ? pendingA : Promise.resolve(mockTexture())) as never)
    const { layer, frame } = make()
    layer.show('a.webp', {}, '/assets')
    layer.show('b.webp', {}, '/assets')
    await flushPromises()
    resolveA(mockTexture())
    await flushPromises()
    expect(frame.children.filter((c) => c instanceof Sprite)).toHaveLength(1)
    expect(layer.getState()?.path).toBe('b.webp')
  })

  it('ロード中に clear() されたら画像は出ない', async () => {
    let resolveA!: (t: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(new Promise<Texture>((r) => (resolveA = r)) as never)
    const { layer } = make()
    layer.show('a.webp', {}, '/assets')
    layer.clear()
    resolveA(mockTexture())
    await flushPromises()
    expect(layer.hasImage()).toBe(false)
    expect(layer.getState()).toBeNull()
  })

  it('画像の読み込み失敗は警告だけで落ちず、宣言（getState）は残る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const { layer } = make()
    layer.show('missing.webp', {}, '/assets')
    await flushPromises()
    expect(warn).toHaveBeenCalled()
    expect(layer.hasImage()).toBe(false)
    expect(layer.getState()).toEqual({ path: 'missing.webp', loop: true, mute: true })
  })
})

describe('WallLayer 配置（最奥の画面いっぱい）', () => {
  it('画像は cover-fit で画面中央に敷く（アスペクト違いは長辺側で覆う）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture(400, 400) as never)
    const { layer, frame } = make()
    layer.show('sq.webp', {}, '/assets')
    await flushPromises()
    const sprite = frame.children.find((c) => c instanceof Sprite) as Sprite
    expect(sprite.x).toBe(SCREEN_W / 2)
    expect(sprite.y).toBe(SCREEN_H / 2)
    expect(sprite.width).toBe(SCREEN_W)
    expect(sprite.height).toBe(SCREEN_W)
    expect(sprite.anchor.x).toBe(0.5)
    expect(sprite.anchor.y).toBe(0.5)
  })

  it('WallLayer 自身はクリックを受けない', () => {
    const { layer } = make()
    expect(layer.eventMode).toBe('none')
  })
})

describe('WallLayer カメラ', () => {
  it('ノベルは原寸（identity）', () => {
    const { layer, frame } = make()
    layer.setCamera('Novel', 'Audience', null)
    expect(frame.scale.x).toBe(1)
    expect(frame.position.x).toBe(SCREEN_W / 2)
    expect(frame.position.y).toBe(SCREEN_H / 2)
    expect(frame.pivot.x).toBe(SCREEN_W / 2)
    expect(frame.pivot.y).toBe(SCREEN_H / 2)
  })

  it('シアター×仰角は computeCameraProjection(WALL_DEPTH) の scale/verticalOffset をそのまま frame に掛ける', () => {
    const { layer, frame } = make()
    for (const elevation of ['LookUp', 'LookDown', null] as const) {
      layer.setCamera('Theater', 'Audience', elevation)
      const p = computeCameraProjection('Theater', 'Audience', elevation, WALL_DEPTH)
      expect(frame.scale.x).toBe(p.scale)
      expect(frame.scale.y).toBe(p.scale)
      expect(frame.position.y).toBe(SCREEN_H / 2 + p.verticalOffset)
    }
  })

  it('壁は画面全体を覆い続ける（シアターでも縮小して縁が見えない）', () => {
    const { layer, frame } = make()
    layer.setCamera('Theater', 'Audience', null)
    expect(frame.scale.x).toBeGreaterThanOrEqual(1)
  })

  it('computeWallFrame は純粋関数: 画面サイズから中心を求め、ノベルは仰角を無視する', () => {
    expect(computeWallFrame('Novel', 'Audience', 'LookUp', 800, 450)).toEqual({
      x: 400,
      y: 225,
      scale: 1,
    })
    const f = computeWallFrame('Theater', 'Stage', 'LookDown', 1000, 600)
    const p = computeCameraProjection('Theater', 'Stage', 'LookDown', WALL_DEPTH)
    expect(f).toEqual({ x: 500, y: 300 + p.verticalOffset, scale: p.scale })
    expect(THEATER_ELEVATION_OFFSET_PER_DEPTH).toBeGreaterThan(0)
  })

  it('カメラを後から切り替えても以前の状態を引きずらない（シアター→ノベルで戻る）', () => {
    const { layer, frame } = make()
    layer.setCamera('Theater', 'Audience', 'LookUp')
    layer.setCamera('Novel', 'Audience', null)
    expect(frame.scale.x).toBe(1)
    expect(frame.position.y).toBe(SCREEN_H / 2)
  })

  it('画像ロード完了後にカメラが変わっても frame が射影を持つ（sprite 側は常に cover-fit のまま）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const { layer, frame } = make()
    layer.setCamera('Theater', 'Audience', 'LookUp')
    layer.show('a.webp', {}, '/assets')
    await flushPromises()
    const sprite = frame.children.find((c) => c instanceof Sprite) as Sprite
    expect(sprite.width).toBe(SCREEN_W)
    expect(sprite.y).toBe(SCREEN_H / 2)
  })
})

describe('WallLayer 状態・復元', () => {
  it('getState は「パス＋設定」だけ（再生位置などを持たない）で、返り値の書き換えが内部に影響しない', () => {
    const { layer } = make()
    layer.show('a.webm', { loop: false, mute: false }, '/assets')
    const st = layer.getState()
    expect(st).toEqual({ path: 'a.webm', loop: false, mute: false })
    expect(Object.keys(st ?? {}).sort()).toEqual(['loop', 'mute', 'path'])
    if (st) st.path = 'x'
    expect(layer.getState()?.path).toBe('a.webm')
  })

  it('壁なしの getState は null', () => {
    const { layer } = make()
    expect(layer.getState()).toBeNull()
  })

  it('restore(null) は壁を消す。restore(state) は最終状態を show し直す（動画は頭から）', () => {
    const { layer, video } = make()
    layer.show('a.webm', {}, '/assets')
    layer.restore(null, '/assets')
    expect(layer.getState()).toBeNull()
    expect(video.active).toBe(false)
    layer.restore({ path: 'b.webm', loop: false, mute: false }, '/assets')
    expect(video.shown[video.shown.length - 1]).toEqual({
      path: 'b.webm',
      opts: { position: 'center', loop: false, mute: false },
    })
    expect(video.shown[video.shown.length - 1].opts).not.toHaveProperty('playhead')
  })

  it('getState → restore の往復で同じ状態に戻る', () => {
    const a = make()
    a.layer.show('x.webm', { loop: false }, '/assets')
    const st = a.layer.getState()
    const b = make()
    b.layer.restore(st, '/assets')
    expect(b.layer.getState()).toEqual(st)
  })

  it('壁が無いときの clear() は何度呼んでも安全', () => {
    const { layer } = make()
    expect(() => {
      layer.clear()
      layer.clear()
    }).not.toThrow()
  })
})

describe('WallLayer 後始末（リーク）', () => {
  it('clear() は VideoLayer.remove（video 要素・テクスチャの解放）と画像 Sprite の destroy を行う', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const { layer, video, frame } = make()
    layer.show('a.webp', {}, '/assets')
    await flushPromises()
    const sprite = frame.children.find((c) => c instanceof Sprite) as Sprite
    const destroy = vi.spyOn(sprite, 'destroy')
    const removedBefore = video.removed
    layer.clear()
    expect(destroy).toHaveBeenCalledTimes(1)
    // texture は Assets キャッシュの持ち物なので Sprite の destroy で壊さない（引数なし）。
    expect(destroy.mock.calls[0]).toEqual([])
    expect(video.removed).toBe(removedBefore + 1)
    expect(frame.children.some((c) => c instanceof Sprite)).toBe(false)
  })

  it('disposeTextures は読み込んだ画像 URL だけを Assets.unload し、二重解放しない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const { layer } = make()
    layer.show('a.webp', {}, '/assets')
    await flushPromises()
    layer.show('b.webp', {}, '/assets')
    await flushPromises()
    layer.show('c.webm', {}, '/assets')
    layer.disposeTextures()
    expect(unload.mock.calls.map((c) => c[0]).sort()).toEqual([
      '/assets/images/a.webp',
      '/assets/images/b.webp',
    ])
    layer.disposeTextures()
    expect(unload).toHaveBeenCalledTimes(2)
  })

  it('何も読んでいなければ disposeTextures は Assets.unload を呼ばない', () => {
    const unload = vi.spyOn(Assets, 'unload')
    const { layer } = make()
    layer.disposeTextures()
    expect(unload).not.toHaveBeenCalled()
  })
})

describe('WallLayer 書き出し', () => {
  it('prepareForExport / isPlayingToEnd は VideoLayer に委譲する', async () => {
    const { layer, video } = make()
    await layer.prepareForExport()
    expect(video.export).toBe(1)
    expect(layer.isPlayingToEnd()).toBe(false)
    video.playingToEnd = true
    expect(layer.isPlayingToEnd()).toBe(true)
  })
})
