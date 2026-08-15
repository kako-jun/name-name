/**
 * CharacterLayer.showImage() の Pixelate 遷移 (#628 フェーズ2a) 単体テスト + NovelRenderer 配線。
 *
 * EventImageLayer 側の Pixelate 遷移そのもの（コルセン→スワップ→リファインの位相進行、
 * PixelateFilter の size 計算）は EventImageLayer.test.ts の「EventImageLayer ピクセレート遷移
 * (#583)」describe が担保済みで、CharacterLayer.startImagePixelateTransition は同じ
 * pixelateTransition.ts の純粋関数を共有する実装（コメント「EventImageLayer.performPixelateSwap
 * と同じ割り切り」参照）。ここでは CharacterLayer.showImage() 固有の分岐——新規表示限定・
 * instant/fadeMs<=0 のフォールバック・onLoaded/onError コールバックの契約——だけを縛る。
 *
 * NovelRenderer 側の `[画像: 遷移=pixelate, フェード=800]` ディレクティブ配線
 * （processDirective → characterLayer.showImage）も同じ #628 フェーズ2a のスコープのため、
 * このファイルの末尾に別 describe として同居させる（テスト観点整理担当の優先度4グルーピングに従う）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets } from 'pixi.js'
import { CharacterLayer } from './CharacterLayer'
import { NovelRenderer } from './NovelRenderer'
import type { Event } from '../types'

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface PixelateStateLike {
  phase: 'coarsen' | 'holding' | 'refine'
  durationMs: number
}
interface CharacterStateLike {
  sprite: { alpha: number }
  pixelateState?: PixelateStateLike
  fadeAnimation: { fromAlpha: number; toAlpha: number } | null
}
interface CharacterLayerInternals {
  characters: Map<string, CharacterStateLike>
}
function internals(layer: CharacterLayer): CharacterLayerInternals {
  return layer as unknown as CharacterLayerInternals
}

function mockAssetsLoadResolved(): void {
  vi.spyOn(Assets, 'load').mockResolvedValue({
    width: 10,
    height: 10,
    source: { scaleMode: 'linear' },
  } as never)
}

describe('CharacterLayer.showImage() Pixelate 遷移 (#628 フェーズ2a)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC4: showImage({transition:"Pixelate", fadeMs:800}) で pixelateState.phase が "coarsen" から始まる', () => {
    mockAssetsLoadResolved()
    const layer = new CharacterLayer(800, 450)

    layer.showImage({
      id: 'img',
      path: 'a.png',
      assetBaseUrl: '/assets',
      transition: 'Pixelate',
      fadeMs: 800,
    })

    const st = internals(layer).characters.get('img')
    expect(st?.pixelateState).toBeDefined()
    expect(st?.pixelateState?.phase).toBe('coarsen')
  })

  it('TC6: fadeMs:0（境界値）は resolveImagePixelateDurationMs が0を返し Pixelate 経路に入らない（pixelateState 未設定のまま）', () => {
    mockAssetsLoadResolved()
    const layer = new CharacterLayer(800, 450)

    layer.showImage({
      id: 'img',
      path: 'a.png',
      assetBaseUrl: '/assets',
      transition: 'Pixelate',
      fadeMs: 0,
    })

    const st = internals(layer).characters.get('img')
    expect(st?.pixelateState).toBeUndefined()
  })

  it('TC7: transition:undefined は常に Fade 経路（pixelateState は作られない。frontmatter event_image_transition 値に非連動）', () => {
    mockAssetsLoadResolved()
    const layer = new CharacterLayer(800, 450)

    layer.showImage({ id: 'img', path: 'a.png', assetBaseUrl: '/assets', fadeMs: 800 })

    const st = internals(layer).characters.get('img')
    expect(st?.pixelateState).toBeUndefined()
  })

  it('TC8: instant:true かつ transition:"Pixelate" は Pixelate が無効化され即時表示（alpha=1・pixelateState未設定）', () => {
    mockAssetsLoadResolved()
    const layer = new CharacterLayer(800, 450)

    layer.showImage({
      id: 'img',
      path: 'a.png',
      assetBaseUrl: '/assets',
      transition: 'Pixelate',
      fadeMs: 800,
      instant: true,
    })

    const st = internals(layer).characters.get('img')
    expect(st?.pixelateState).toBeUndefined()
    expect(st?.sprite.alpha).toBe(1)
  })

  it('TC9: 同一idへの再表示（existing分岐）に transition:"Pixelate" を渡しても新規遷移は開始されない', async () => {
    mockAssetsLoadResolved()
    const layer = new CharacterLayer(800, 450)

    // 1回目: 通常の Fade 経路で新規表示（existing に載せるための下準備）。
    layer.showImage({ id: 'img', path: 'a.png', assetBaseUrl: '/assets' })
    await flushPromises()
    const stAfterFirst = internals(layer).characters.get('img')
    expect(stAfterFirst?.pixelateState).toBeUndefined()

    // 2回目: 同一 id への再表示。transition:'Pixelate' を渡しても existing 分岐で即 return するため
    // pixelateState は作られない（新規遷移が始まらないことの回帰テスト）。
    layer.showImage({
      id: 'img',
      path: 'a.png',
      assetBaseUrl: '/assets',
      transition: 'Pixelate',
      fadeMs: 800,
    })

    const stAfterSecond = internals(layer).characters.get('img')
    expect(stAfterSecond?.pixelateState).toBeUndefined()
    // 同一 state オブジェクトのまま（existing 分岐は新規 state を作らない）。
    expect(stAfterSecond).toBe(stAfterFirst)
  })

  it('TC10: onLoaded コールバックが Fade 経路の成功時に1回だけ呼ばれる', async () => {
    mockAssetsLoadResolved()
    const layer = new CharacterLayer(800, 450)
    const onLoaded = vi.fn()
    const onError = vi.fn()

    layer.showImage({ id: 'img', path: 'a.png', assetBaseUrl: '/assets', onLoaded, onError })
    await flushPromises()

    expect(onLoaded).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('TC11: onError コールバックがロード失敗時に1回だけ呼ばれる', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    const onLoaded = vi.fn()
    const onError = vi.fn()

    layer.showImage({ id: 'img', path: 'a.png', assetBaseUrl: '/assets', onLoaded, onError })
    await flushPromises()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onLoaded).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('TC12: onLoaded/onError は existing 分岐（同id再表示）では呼ばれない', async () => {
    mockAssetsLoadResolved()
    const layer = new CharacterLayer(800, 450)

    // 1回目: 新規表示（コールバック無し）。
    layer.showImage({ id: 'img', path: 'a.png', assetBaseUrl: '/assets' })
    await flushPromises()

    // 2回目: 同一 id への再表示。existing 分岐は Assets.load を呼ばないため、
    // ここで渡したコールバックは同期でも await 後も一切呼ばれない。
    const onLoaded = vi.fn()
    const onError = vi.fn()
    layer.showImage({ id: 'img', path: 'a.png', assetBaseUrl: '/assets', onLoaded, onError })
    await flushPromises()

    expect(onLoaded).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})

// --- NovelRenderer 配線: `[画像: 遷移=pixelate, フェード=800]` → characterLayer.showImage ---
describe('NovelRenderer `[画像:]` ディレクティブの Pixelate 遷移配線 (#628 フェーズ2a, TC13)', () => {
  interface RendererInternals {
    characterLayer: { showImage: (...args: unknown[]) => void }
    processDirective(event: Event): void
  }
  function rendererInternals(r: NovelRenderer): RendererInternals {
    return r as unknown as RendererInternals
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC13: `[画像: 遷移=pixelate, フェード=800]` を処理すると characterLayer.showImage が transition:"Pixelate", fadeMs:800 で呼ばれる', () => {
    mockAssetsLoadResolved()
    const r = new NovelRenderer()
    r.setAssetBaseUrl('/assets')
    const showImageSpy = vi.spyOn(rendererInternals(r).characterLayer, 'showImage')

    rendererInternals(r).processDirective({
      Image: { path: 'a.png', transition: 'Pixelate', fade_ms: 800 },
    } as Event)

    expect(showImageSpy).toHaveBeenCalledTimes(1)
    const call = showImageSpy.mock.calls[0][0] as Record<string, unknown>
    expect(call.transition).toBe('Pixelate')
    expect(call.fadeMs).toBe(800)
    expect(call.path).toBe('a.png')
  })
})
