/**
 * アクリル板テクスチャの canvas ↔ Texture の橋渡し (#760)。jsdom には canvas / ImageData が無いので差し替える。
 * 形の計算は acrylicPlate.test.ts / acrylicShadow.test.ts。ここは作業解像度・位置情報・null になる条件を守る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Texture } from 'pixi.js'
import { computePlateExtend } from './acrylicPlate'
import { PLATE_WORK_MAX_SIDE, createAcrylicPlateTexture } from './acrylicPlateTexture'
import { resolveAcrylicParams } from './spriteStyle'

class FakeImageData {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number
  ) {}
}

const P = resolveAcrylicParams()

/** 元画像 w x h（resource は描画できるダミー）を持つテクスチャ */
function srcTexture(w: number, h: number, resource: unknown = {}): Texture {
  return { source: { resource, pixelWidth: w, pixelHeight: h } } as unknown as Texture
}

let drawImage: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.stubGlobal('ImageData', FakeImageData)
  drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((): unknown => ({
    drawImage,
    // 不透明な 1 色（alpha 255）
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    }),
    putImageData: vi.fn(),
  })) as never)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createAcrylicPlateTexture (#760)', () => {
  it('作業解像度は長辺 PLATE_WORK_MAX_SIDE(192) に縮小: scale = 元の長辺 / 192・pad は板のラスタの余白', () => {
    expect(PLATE_WORK_MAX_SIDE).toBe(192)
    const plate = createAcrylicPlateTexture(srcTexture(400, 800), P)!
    expect(plate).not.toBeNull()
    expect(plate.scale).toBeCloseTo(800 / 192, 9)
    // 192 に縮小した高さ 192・幅 96 + 両側 pad。高さには差し込み線まで伸ばす extend が加わる (#802)
    expect(plate.texture.width).toBe(96 + plate.pad * 2)
    expect(plate.texture.height).toBe(
      192 + computePlateExtend(192, P.spriteLiftRatio) + plate.pad * 2
    )
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 96, 192)
  })

  it('元画像が作業解像度以下ならそのまま（scale 1・拡大しない）', () => {
    const plate = createAcrylicPlateTexture(srcTexture(100, 50), P)!
    expect(plate.scale).toBe(1)
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 50)
  })

  it('境界: 長辺 191 / 192 / 193 の scale は 1 / 1 / 193/192', () => {
    expect(createAcrylicPlateTexture(srcTexture(191, 10), P)!.scale).toBe(1)
    expect(createAcrylicPlateTexture(srcTexture(192, 10), P)!.scale).toBe(1)
    expect(createAcrylicPlateTexture(srcTexture(193, 10), P)!.scale).toBeCloseTo(193 / 192, 3)
  })

  it('テクスチャは mipmap 生成 + linear（影も同じ）', () => {
    const plate = createAcrylicPlateTexture(srcTexture(100, 50), P)!
    for (const t of [plate.texture, plate.shadow!]) {
      expect(t.source.autoGenerateMipmaps).toBe(true)
      expect(t.source.scaleMode).toBe('linear')
    }
  })

  it('影は板と同じ寸法・足元は元画像の下端の中央（pad ぶん内側）', () => {
    const plate = createAcrylicPlateTexture(srcTexture(100, 50), P)!
    expect(plate.shadow!.width).toBe(plate.texture.width)
    expect(plate.shadow!.height).toBe(plate.texture.height)
    const extend = computePlateExtend(50, P.spriteLiftRatio)
    expect(plate.foot).toEqual({ x: plate.pad + 50, y: plate.pad + 50 + extend })
  })

  it('足元 foot.y = pad + 作業高さ + extend・foot.x は中央 (#802)', () => {
    const plate = createAcrylicPlateTexture(srcTexture(100, 200), P)!
    const extend = computePlateExtend(192, P.spriteLiftRatio)
    expect(extend).toBeGreaterThan(0)
    expect(plate.foot!.y).toBe(plate.pad + 192 + extend)
    expect(plate.foot!.x).toBe(plate.pad + 48)
  })

  it('lift=0 は foot.y が従来と同じ（pad + 作業高さ）(#802)', () => {
    const plate = createAcrylicPlateTexture(
      srcTexture(100, 50),
      resolveAcrylicParams({ spriteLiftRatio: 0 })
    )!
    expect(plate.foot).toEqual({ x: plate.pad + 50, y: plate.pad + 50 })
    expect(plate.texture.height).toBe(50 + plate.pad * 2)
  })

  it('hasBase=false は lift が既定でも板を伸ばさず foot.y が従来と同じ（台座が無いと浮き量は効かない・#802）', () => {
    const plate = createAcrylicPlateTexture(
      srcTexture(100, 50),
      resolveAcrylicParams({ hasBase: false, spriteLiftRatio: 0.15 })
    )!
    expect(plate.foot).toEqual({ x: plate.pad + 50, y: plate.pad + 50 })
    expect(plate.texture.height).toBe(50 + plate.pad * 2)
    expect(plate.shadow!.height).toBe(plate.texture.height)
  })

  it('板と影は別のテクスチャ（破棄を別々にできる）', () => {
    const plate = createAcrylicPlateTexture(srcTexture(100, 50), P)!
    expect(plate.shadow).not.toBe(plate.texture)
  })

  it('同じ入力から呼ぶたびに新しいテクスチャ（view ごとに独立・共有しない）', () => {
    const tex = srcTexture(100, 50)
    const a = createAcrylicPlateTexture(tex, P)!
    const b = createAcrylicPlateTexture(tex, P)!
    expect(a.texture).not.toBe(b.texture)
    expect(a.shadow).not.toBe(b.shadow)
  })

  it.each([
    ['resource が無い', srcTexture(100, 50, null)],
    ['幅 0', srcTexture(0, 50)],
    ['高さ 0', srcTexture(100, 0)],
    ['幅が負', srcTexture(-5, 50)],
    ['source が無い', {} as unknown as Texture],
  ])('読み出せないテクスチャ（%s）は null（板なしで描く）', (_name, tex) => {
    expect(createAcrylicPlateTexture(tex, P)).toBeNull()
  })

  it('canvas の 2d コンテキストが取れなければ null', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(createAcrylicPlateTexture(srcTexture(100, 50), P)).toBeNull()
  })

  it('汚染された canvas（getImageData が SecurityError）でも例外を投げず null', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      drawImage: vi.fn(),
      getImageData: () => {
        throw new DOMException('tainted', 'SecurityError')
      },
    })) as never)
    expect(createAcrylicPlateTexture(srcTexture(100, 50), P)).toBeNull()
  })

  it('影用の 2d コンテキストが取れなくても板は返る（影だけ省略）', () => {
    let calls = 0
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
      calls++
      // 1: 読み出し用 / 2: 板の書き込み / 3: 影の書き込み → 影だけ失敗
      if (calls === 3) return null
      return {
        drawImage: vi.fn(),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4).fill(255),
        }),
        putImageData: vi.fn(),
      }
    }) as never)
    const plate = createAcrylicPlateTexture(srcTexture(100, 50), P)!
    expect(plate).not.toBeNull()
    expect(plate.shadow).toBeUndefined()
  })
})
