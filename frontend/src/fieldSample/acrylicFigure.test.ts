import { describe, expect, it } from 'vitest'
import { Texture, TextureSource } from 'pixi.js'
import { FieldAcrylicFigure, fitAcrylicGeometry } from './acrylicFigure'
import { resolveAcrylicParams } from '../game/spriteStyle'

const sized = (w: number, h: number): Texture =>
  new Texture({ source: new TextureSource({ width: w, height: h }) })

const PAD = 6
/** jsdom には canvas が無いので板・台座の生成だけ差し替える（形・質感の計算は acrylicPlate.test.ts ほか） */
const fakePlate = (tex: Texture) => ({
  texture: sized(tex.width + PAD * 2, tex.height + PAD * 2),
  pad: PAD,
  shadow: sized(tex.width + PAD * 2, tex.height + PAD * 2),
  foot: { x: PAD + tex.width / 2, y: PAD + tex.height },
})
const fakeBase = () => ({
  texture: sized(200, 80),
  layout: { width: 200, height: 80, cx: 100, cyTop: 30, shadowRx: 90, shadowRy: 30 },
})
const make = () =>
  new FieldAcrylicFigure(undefined, {
    makePlate: fakePlate,
    makeBase: fakeBase as never,
  })

describe('fitAcrylicGeometry', () => {
  const params = resolveAcrylicParams()
  it('絵の高さが目標の高さにほぼ一致する（幅の違う絵でも）', () => {
    for (const [w, h] of [
      [32, 48],
      [64, 64],
      [100, 48],
    ]) {
      for (const target of [40, 64, 150]) {
        const fit = fitAcrylicGeometry(w, h, target, params)!
        expect(fit.geometry.sprite.height).toBeGreaterThan(target * 0.97)
        expect(fit.geometry.sprite.height).toBeLessThan(target * 1.03)
        expect(fit.geometry.base).not.toBeNull()
      }
    }
  })
  it('寸法・高さが不正なら null', () => {
    expect(fitAcrylicGeometry(0, 48, 64, params)).toBeNull()
    expect(fitAcrylicGeometry(32, 48, 0, params)).toBeNull()
    expect(fitAcrylicGeometry(32, 48, Number.NaN, params)).toBeNull()
  })
})

describe('FieldAcrylicFigure', () => {
  it('足元 (x, y) に、板・台座・影を置く（絵の下端中央が足元）', () => {
    const f = make()
    f.update(sized(32, 48), 64, false, 300, 200)
    const L = f.layers
    expect(f.display.visible).toBe(true)
    expect(L.acrylicBase).not.toBeNull()
    expect(L.acrylicPlate).not.toBeNull()
    expect(L.acrylicShadow).not.toBeNull()
    // 足元: pivot が絵の下端中央・position が足元。倍率は ≒1（表示高さを揃えるだけ）
    expect(f.display.position.x).toBe(300)
    expect(f.display.position.y).toBe(200)
    expect(Math.abs(f.display.scale.x - 1)).toBeLessThan(0.03)
    expect(f.display.scale.x).toBeCloseTo(f.display.scale.y, 10)
    // 台座は足元より下（手前）に出て、板はスリットの高さで切られる
    const base = L.acrylicBase!
    expect(base.y + base.height).toBeGreaterThan(f.display.pivot.y)
    expect(L.acrylicPlate!.mask).toBeTruthy()
    expect(L.acrylicPlate!.visible).toBe(true)
  })

  it('左右反転では全体が足元で反転し、影は光の向き（右）に倒れたまま', () => {
    const f = make()
    f.update(sized(32, 48), 64, false, 100, 100)
    const skew = f.layers.acrylicShadow!.skew.x
    f.update(sized(32, 48), 64, true, 100, 100)
    expect(f.display.scale.x).toBeLessThan(0)
    expect(f.display.position.x).toBe(100)
    expect(f.layers.acrylicShadow!.skew.x).toBeCloseTo(-skew, 10)
  })

  it('コマ（絵）が変わると板・影のテクスチャが差し変わる', () => {
    const f = make()
    const a = sized(32, 48)
    const b = sized(32, 48)
    f.update(a, 64, false, 10, 10)
    const first = f.layers.acrylicPlate!.texture
    f.update(a, 64, false, 12, 10)
    expect(f.layers.acrylicPlate!.texture).toBe(first)
    f.update(b, 64, false, 14, 10)
    expect(f.layers.acrylicPlate!.texture).not.toBe(first)
  })

  it('板・台座を作れない環境でも例外なく Graphics で台座を描く', () => {
    const f = new FieldAcrylicFigure(undefined, { makePlate: () => null, makeBase: () => null })
    f.update(sized(32, 48), 64, false, 50, 50)
    expect(f.layers.acrylicPlate).toBeNull()
    expect(f.layers.acrylicBase).toBeNull()
    expect(f.display.visible).toBe(true)
  })

  it('表示高さが不正なら隠す', () => {
    const f = make()
    f.update(sized(32, 48), 64, false, 50, 50)
    f.update(sized(32, 48), 0, false, 50, 50)
    expect(f.display.visible).toBe(false)
  })
})
