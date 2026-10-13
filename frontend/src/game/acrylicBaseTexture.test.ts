/**
 * 台座テクスチャの共有キャッシュ (#760)。jsdom には canvas / ImageData が無いので、getContext と ImageData だけ差し替える。
 * 形・質感の計算は acrylicBase.test.ts。ここは「パラメータごとに 1 枚作って共有する」「作れない環境では null」を守る。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { getAcrylicBaseTexture } from './acrylicBaseTexture'
import { BASE_TEXTURE_WIDTH } from './acrylicBase'
import { resolveAcrylicParams } from './spriteStyle'

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number
  ) {}
}

let putImageData: ReturnType<typeof vi.fn>
let createCanvas: MockInstance<typeof document.createElement>

beforeEach(() => {
  putImageData = vi.fn()
  vi.stubGlobal('ImageData', FakeImageData)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData } as never)
  createCanvas = vi.spyOn(document, 'createElement')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// キャッシュはモジュールで共有されるので、テストごとに別のパラメータ（slitAlpha）を使って干渉を避ける
let seed = 0.01
const uniqueParams = (over: Parameters<typeof resolveAcrylicParams>[0] = {}) =>
  resolveAcrylicParams({ slitAlpha: (seed += 0.001), ...over })
const canvasCount = (): number =>
  createCanvas.mock.calls.filter((c: unknown[]) => c[0] === 'canvas').length

describe('getAcrylicBaseTexture (#760)', () => {
  it('同じパラメータなら同じインスタンス（全 view で共有・canvas は 1 回だけ作る）', () => {
    const p = uniqueParams()
    const a = getAcrylicBaseTexture(p)
    const before = canvasCount()
    const b = getAcrylicBaseTexture({ ...p })
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(canvasCount()).toBe(before)
  })

  it('パラメータ（台座に効くもの）が違えば別のテクスチャ', () => {
    const a = getAcrylicBaseTexture(uniqueParams())
    const b = getAcrylicBaseTexture(uniqueParams({ baseFillAlpha: 0.5 }))
    const c = getAcrylicBaseTexture(uniqueParams({ lineColor: 0x123456 }))
    expect(b!.texture).not.toBe(a!.texture)
    expect(c!.texture).not.toBe(a!.texture)
    expect(c!.texture).not.toBe(b!.texture)
  })

  it('台座に効かないパラメータ（板・影の項目）が違っても同じテクスチャを共有する', () => {
    const p = uniqueParams()
    const a = getAcrylicBaseTexture(p)
    const b = getAcrylicBaseTexture({ ...p, castAlpha: 0.9, plateFillAlpha: 0.5, marginRatio: 0.1 })
    expect(b).toBe(a)
  })

  it('テクスチャは mipmap 生成 + linear で、幅は BASE_TEXTURE_WIDTH・layout はその寸法', () => {
    const r = getAcrylicBaseTexture(uniqueParams())!
    expect(r.texture.source.autoGenerateMipmaps).toBe(true)
    expect(r.texture.source.scaleMode).toBe('linear')
    expect(r.layout.width).toBe(BASE_TEXTURE_WIDTH)
    expect(r.layout.height).toBeGreaterThan(0)
    expect('rgba' in r.layout).toBe(false)
    expect(putImageData).toHaveBeenCalled()
  })

  it('canvas の 2d コンテキストが取れない環境では null（Graphics にフォールバックする合図）', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(getAcrylicBaseTexture(uniqueParams())).toBeNull()
  })

  it('作れなかった結果はキャッシュしない: 環境が復活すれば次の呼び出しで作れる', () => {
    const p = uniqueParams()
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(getAcrylicBaseTexture(p)).toBeNull()
    spy.mockReturnValue({ putImageData } as never)
    expect(getAcrylicBaseTexture(p)).not.toBeNull()
  })

  it('ImageData が無い・例外が出る環境でも例外を投げず null', () => {
    vi.unstubAllGlobals()
    expect(getAcrylicBaseTexture(uniqueParams())).toBeNull()
  })
})
