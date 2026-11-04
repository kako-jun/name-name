/**
 * AcrylicPlateCache のキー（画像 x 基本の絵）(#853)
 */
import { describe, expect, it, vi } from 'vitest'
import type { Texture } from 'pixi.js'
import { AcrylicPlateCache } from './acrylicParts'
import type { AcrylicPlate } from './acrylicPlateTexture'

const tex = (id: string): Texture => ({ source: { id } }) as unknown as Texture
const fakePlate = (): AcrylicPlate =>
  ({
    texture: { destroy: vi.fn() },
    shadow: { destroy: vi.fn() },
  }) as unknown as AcrylicPlate

describe('AcrylicPlateCache (#853)', () => {
  it('同じ画像・同じ基本の絵は 1 回だけ作って共有', () => {
    const make = vi.fn((_t: Texture, _b?: Texture) => fakePlate())
    const c = new AcrylicPlateCache(make)
    const pose = tex('pose')
    const base = tex('base')
    expect(c.get(pose, base)).toBe(c.get(pose, base))
    expect(make).toHaveBeenCalledTimes(1)
    expect(make).toHaveBeenCalledWith(pose, base)
  })
  it('同じ画像でも基本の絵が違えば別の板', () => {
    const make = vi.fn((_t: Texture, _b?: Texture) => fakePlate())
    const c = new AcrylicPlateCache(make)
    const pose = tex('pose')
    expect(c.get(pose, tex('baseA'))).not.toBe(c.get(pose, tex('baseB')))
    expect(make).toHaveBeenCalledTimes(2)
  })
  it('基本の絵自身・省略は同じキー（baseTex なしで作る）', () => {
    const make = vi.fn((_t: Texture, _b?: Texture) => fakePlate())
    const c = new AcrylicPlateCache(make)
    const base = tex('base')
    const p = c.get(base)
    expect(c.get(base, base)).toBe(p)
    expect(make).toHaveBeenCalledTimes(1)
    expect(make).toHaveBeenCalledWith(base, undefined)
  })
  it('同じ source を共有するテクスチャは同じ板・作れなかった（null）結果も覚える', () => {
    const make = vi.fn((_t: Texture, _b?: Texture): AcrylicPlate | null => null)
    const c = new AcrylicPlateCache(make)
    const source = { id: 's' }
    expect(c.get({ source } as unknown as Texture)).toBeNull()
    expect(c.get({ source } as unknown as Texture)).toBeNull()
    expect(make).toHaveBeenCalledTimes(1)
  })
  it('destroy は全ての板・影を解放して空にする', () => {
    const plates = [fakePlate(), fakePlate(), fakePlate()]
    let i = 0
    const c = new AcrylicPlateCache(() => plates[i++])
    const pose = tex('pose')
    c.get(pose, tex('a'))
    c.get(pose, tex('b'))
    c.destroy()
    for (const p of plates.slice(0, 2)) {
      expect(p.texture.destroy).toHaveBeenCalledWith(true)
      expect(p.shadow!.destroy).toHaveBeenCalledWith(true)
    }
    c.get(pose, tex('a'))
    expect(i).toBe(3)
  })
})
