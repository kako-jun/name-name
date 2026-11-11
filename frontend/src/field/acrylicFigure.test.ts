import { describe, expect, it } from 'vitest'
import { Texture, TextureSource } from 'pixi.js'
import {
  FieldAcrylicFigure,
  createFieldStands,
  createNpcStand,
  fitAcrylicGeometry,
} from './acrylicFigure'
import { resolveAcrylicParams } from '../game/spriteStyle'
import { playerScale } from '../game/fieldWalk'
import startFieldGameSource from './startFieldGame.ts?raw'

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
  it('台座・影の大きさは表示高さだけで決まる（横長のコマでも縦長と同一）', () => {
    for (const target of [48, 96]) {
      const ref = fitAcrylicGeometry(32, 48, target, params)!
      for (const [w, h] of [
        [48, 48],
        [400, 300],
        [500, 300],
        [900, 300],
      ]) {
        const fit = fitAcrylicGeometry(w, h, target, params)!
        expect(fit.size).toBeCloseTo(ref.size, 10)
        expect(fit.geometry.base).toEqual(ref.geometry.base)
        expect(fit.geometry.shadow).toEqual(ref.geometry.shadow)
        // 絵の高さ・足元（下端）も同じで、幅だけ縦横比どおり
        expect(fit.geometry.sprite.height).toBeCloseTo(ref.geometry.sprite.height, 10)
        expect(fit.geometry.sprite.y).toBeCloseTo(ref.geometry.sprite.y, 10)
        expect(fit.geometry.sprite.width).toBeCloseTo((w / h) * fit.geometry.sprite.height, 10)
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

  it('足元の位置合わせ: pivot は絵の下端中央、影は足元に置く', () => {
    const f = make()
    const tex = sized(32, 48)
    f.update(tex, 64, false, 300, 200)
    const fit = fitAcrylicGeometry(32, 48, 64, resolveAcrylicParams())!
    const g = fit.geometry
    expect(f.display.pivot.x).toBeCloseTo(fit.size / 2, 10)
    expect(f.display.pivot.y).toBeCloseTo(g.sprite.y + g.sprite.height, 10)
    const sh = f.layers.acrylicShadow!
    expect(sh.position.x).toBeCloseTo(g.sprite.x + g.sprite.width / 2, 10)
    expect(sh.position.y).toBeCloseTo(g.sprite.y + g.sprite.height + g.liftPx, 10)
    // 台座は絵の下端（足元）より下に出る
    expect(g.base!.cy).toBeGreaterThan(g.sprite.y + g.sprite.height)
  })

  it('横長のコマに変わっても台座の大きさ・位置は変わらない', () => {
    const f = make()
    f.update(sized(32, 48), 96, false, 0, 0)
    const w0 = f.layers.acrylicBase!.width
    const x0 = f.layers.acrylicBase!.x
    f.update(sized(500, 300), 96, false, 0, 0)
    expect(f.layers.acrylicBase!.width).toBeCloseTo(w0, 10)
    expect(f.layers.acrylicBase!.x).toBeCloseTo(x0, 10)
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

  it('新しい絵の板が作れなければ、前の絵の板・影を残さず隠す。後のコマで作れたら出す', () => {
    const bad = sized(10, 20)
    const f = new FieldAcrylicFigure(undefined, {
      makePlate: (t) => (t === bad ? null : fakePlate(t)),
      makeBase: fakeBase as never,
    })
    f.update(sized(32, 48), 64, false, 0, 0)
    expect(f.layers.acrylicPlate!.visible).toBe(true)
    expect(f.layers.acrylicShadow!.visible).toBe(true)
    f.update(bad, 64, false, 0, 0)
    expect(f.layers.acrylicPlate!.visible).toBe(false)
    expect(f.layers.acrylicShadow!.visible).toBe(false)
    f.update(sized(32, 48), 64, false, 0, 0)
    expect(f.layers.acrylicPlate!.visible).toBe(true)
    expect(f.layers.acrylicShadow!.visible).toBe(true)
  })

  it('最初の絵で板が作れなくても、後のコマで板・影が作られる', () => {
    const bad = sized(10, 20)
    const f = new FieldAcrylicFigure(undefined, {
      makePlate: (t) => (t === bad ? null : fakePlate(t)),
      makeBase: fakeBase as never,
    })
    f.update(bad, 64, false, 0, 0)
    expect(f.layers.acrylicPlate).toBeNull()
    f.update(sized(32, 48), 64, false, 0, 0)
    expect(f.layers.acrylicPlate!.visible).toBe(true)
    expect(f.layers.acrylicShadow!.visible).toBe(true)
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

describe('createFieldStands（startFieldGame.ts の配線）', () => {
  it('未指定は何も作らない（従来描画）', () => {
    expect(createFieldStands(undefined, true)).toEqual({ player: null, companion: null })
  })
  it('acrylic は主人公を作り、同行者は設定があるときだけ作る', () => {
    const a = createFieldStands('acrylic', false)
    expect(a.player).toBeInstanceOf(FieldAcrylicFigure)
    expect(a.companion).toBeNull()
    expect(createFieldStands('acrylic', true).companion).toBeInstanceOf(FieldAcrylicFigure)
  })
})

describe('createNpcStand（NPC のアクスタ配線, #861）', () => {
  it('acrylic だけ FieldAcrylicFigure を作る', () => {
    expect(createNpcStand('acrylic')).toBeInstanceOf(FieldAcrylicFigure)
  })
  it('未指定・acrylic 以外の値は null＝従来描画', () => {
    expect(createNpcStand(undefined)).toBeNull()
    expect(createNpcStand('none' as never)).toBeNull()
    expect(createNpcStand('' as never)).toBeNull()
    expect(createNpcStand('Acrylic' as never)).toBeNull()
  })
  it('NPC ごとに別の部品を作る（共有しない）', () => {
    expect(createNpcStand('acrylic')).not.toBe(createNpcStand('acrylic'))
  })
})

describe('FieldAcrylicFigure の NPC 用の使い方（高さ・位置・向き）', () => {
  it('NPC の表示高さ（絵の高さ×playerScale）を渡すと、足元 (x, y) に同じ高さで立つ', () => {
    for (const [texH, npcHeight] of [
      [48, 64],
      [192, 96],
      [300, 150],
    ]) {
      const tex = sized(Math.round(texH * 0.6), texH)
      const ns = playerScale(npcHeight, tex.height)
      const h = tex.height * ns
      // 渡す高さは NPC 定義の高さそのもの
      expect(h).toBeCloseTo(npcHeight, 10)
      const f = make()
      f.update(tex, h, false, 123, 456)
      const g = fitAcrylicGeometry(tex.width, tex.height, h, resolveAcrylicParams())!.geometry
      expect(f.display.position.x).toBe(123)
      expect(f.display.position.y).toBe(456)
      // 板の絵の表示高さ = 倍率 × 配置された絵の高さ ≒ NPC の高さ
      expect(f.display.scale.y * g.sprite.height).toBeCloseTo(h, 8)
      expect(f.display.visible).toBe(true)
    }
  })
  it('NPC は反転しない（flipped=false）。影は表示され、台座は絵の下端より下', () => {
    const f = make()
    f.update(sized(32, 48), 64, false, 10, 20)
    expect(f.display.scale.x).toBeGreaterThan(0)
    expect(f.layers.acrylicShadow!.visible).toBe(true)
    const base = f.layers.acrylicBase!
    expect(base.y + base.height).toBeGreaterThan(f.display.pivot.y)
  })
  it('向きで立ち絵が変わると板が差し変わり、NPC が動いても足元に追従する', () => {
    const f = make()
    f.update(sized(32, 48), 64, false, 100, 100)
    const plate = f.layers.acrylicPlate!.texture
    f.update(sized(28, 48), 64, false, 140, 90)
    expect(f.display.position.x).toBe(140)
    expect(f.display.position.y).toBe(90)
    expect(f.layers.acrylicPlate!.texture).not.toBe(plate)
  })
  it('複数 NPC のアクスタは互いに独立している', () => {
    const a = make()
    const b = make()
    a.update(sized(32, 48), 64, false, 10, 10)
    b.update(sized(32, 48), 128, false, 200, 220)
    expect(a.display.position.x).toBe(10)
    expect(b.display.position.x).toBe(200)
    expect(a.display.scale.y).not.toBe(b.display.scale.y)
  })
  it('更新前は非表示（別場面の NPC の stand が最初から見えない）', () => {
    expect(make().display.visible).toBe(false)
    expect(createNpcStand('acrylic')!.display.visible).toBe(false)
  })
})

/**
 * startFieldGame.ts は PixiJS の Application に依存し単体で呼べないため、NPC のアクスタ配線は
 * ソースの静的検査（?raw）で固定する。空白・改行の差には耐えるが、変数名・式の変更では落ちる＝配線が動いたことに
 * 気づくための検査（脆い）。見た目・実描画の確認は dev サーバーで行う。
 */
describe('startFieldGame.ts の NPC アクスタ配線（?raw の静的検査）', () => {
  const src = startFieldGameSource.replace(/\s+/g, ' ')
  it('NPC 生成時に spriteStyle から stand を作る', () => {
    expect(src).toContain('stand: createNpcStand(config.spriteStyle)')
  })
  it('stand は絵の直前（奥）に world へ足す', () => {
    expect(src).toMatch(
      /if \(n\.stand\) world\.addChild\(n\.stand\.display\)[^;]*? world\.addChild\(n\.sprite\)/
    )
  })
  it('毎フレーム、絵と同じ zIndex・表示高さ（ntex.height*ns）・足元 (n.x, n.y)・非反転で update する', () => {
    expect(src).toContain(
      'if (n.stand) { n.stand.display.zIndex = n.sprite.zIndex n.stand.update(ntex, ntex.height * ns, false, n.x, n.y) }'
    )
    // 絵の scale も同じ ns・位置も同じ (n.x, n.y)
    const upd = src.indexOf('n.stand.update(ntex, ntex.height * ns, false, n.x, n.y)')
    const sc = src.indexOf('n.sprite.scale.set(ns, ns)')
    const ps = src.indexOf('n.sprite.position.set(n.x, n.y)')
    expect(upd).toBeGreaterThan(-1)
    expect(sc).toBeGreaterThan(-1)
    expect(ps).toBeGreaterThan(-1)
    // 同じ更新ブロック内（近接）にある
    expect(Math.abs(upd - sc)).toBeLessThan(600)
    expect(Math.abs(upd - ps)).toBeLessThan(600)
  })
  it('applyScene で、別場面の NPC の stand を隠す', () => {
    expect(src).toContain('n.sprite.visible = sid === s.id')
    expect(src).toContain('if (n.stand && sid !== s.id) n.stand.display.visible = false')
  })
  it('stand の操作は必ず if (n.stand) の条件の中（spriteStyle 未指定＝stand なしで従来描画）', () => {
    const uses = [...src.matchAll(/n\.stand\.\w+/g)]
    expect(uses.length).toBeGreaterThan(0)
    for (const m of uses) {
      const before = src.slice(Math.max(0, m.index! - 120), m.index!)
      expect(before).toMatch(/if \(n\.stand[^)]*\)/)
    }
    expect(src.match(/n\.stand\.update/g)).toHaveLength(1)
  })
  it('隠す行は applyScene の本体の中にある', () => {
    const start = src.indexOf('const applyScene = (s: LoadedScene): void => {')
    expect(start).toBeGreaterThan(-1)
    const hide = src.indexOf('if (n.stand && sid !== s.id) n.stand.display.visible = false')
    expect(hide).toBeGreaterThan(start)
    expect(hide).toBeLessThan(src.indexOf('applyScene(scene)', start))
  })
  it('dispose で全シーンの全 NPC の stand を破棄する', () => {
    const d = src.indexOf('const dispose = (): void => {')
    expect(d).toBeGreaterThan(-1)
    const body = src.slice(d, d + 600)
    expect(body).toContain('playerStand?.destroy()')
    expect(body).toContain(
      'for (const list of sceneNpcs.values()) for (const n of list) n.stand?.destroy()'
    )
  })
})
