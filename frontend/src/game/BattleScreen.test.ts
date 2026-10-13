/**
 * BattleScreen (#173 / #736) の単体テスト。
 *
 * PixiJS の実描画（見た目）は対象外。`Assets.load` をモックして jsdom で、
 * visible / フォールバック / 背景 sprite の有無 / console.warn / destroy 後 resolve の race を検証する。
 * EventImageLayer.test.ts と同じ流儀（internals キャストで private を観測し、`vi.spyOn(Assets, 'load')`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Assets,
  BlurFilter,
  ColorMatrixFilter,
  type Container,
  Graphics,
  type Sprite,
  Texture,
  TextureSource,
  type Text,
  Text as PixiText,
} from 'pixi.js'
import {
  DOF_DEFAULT_PARAMS,
  DOF_EDGE_EXTEND,
  DOF_LEVEL_COUNT,
  DOF_MAX_BLUR_STRENGTH,
  computeDofLevels,
} from './depthOfField'
import { BattleScreen, applyBattleTextureFilter, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  SIDE_COMMAND_TEXT_PADDING,
  SIDE_LABEL_STROKE_WIDTH,
  SIDE_LOG_MIN_LINES,
  SIDE_STATUS_COMPACT_WIDTH,
  computeContainFitRect,
  computeSideBattleLayout,
  estimateTextWidth,
} from './battleLayout'
import { computeSlitY } from './acrylicBase'
import { computeShadowTransform } from './acrylicShadow'
import { computeAcrylicGeometry, resolveAcrylicParams } from './spriteStyle'
import { FF_BLUE_BAND_COUNT, FF_BLUE_TEXT_SHADOW, computeBands } from './windowStyle'

const DEAD_ALPHA = 0.3

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 10,
    maxHp: 10,
    mp: 4,
    maxMp: 4,
    atk: 3,
    def: 1,
    agi: 2,
    ...over,
  }
}

interface EntityViewLike {
  container: Container
  fallback: Graphics
  sprite: Sprite | null
  acrylicBack: Graphics | null
  acrylicPlate: Sprite | null
  acrylicPlatePad: number
  acrylicBase: Sprite | null
  acrylicShadow: Sprite | null
  label: Text | null
}
interface Internals {
  dim: Graphics
  enemyNameText: Text
  enemyHpText: Text
  heroStatsText: Text
  enemyViews: EntityViewLike[]
  partyViews: EntityViewLike[]
  statusTexts: Text[]
  statusHpTexts: Text[]
  statusMpTexts: Text[]
  statusHpLabels: Text[]
  statusMpLabels: Text[]
  statusHpMaxes: Text[]
  statusMpMaxes: Text[]
  logLines: Text[]
  backgroundSprite: Sprite | null
  foregroundSprite: Sprite | null
  sideStage: Container | null
  labelLayer: Container | null
  statsPanel: Container
  commandPanel: Container
  layoutMode: 'front' | 'side'
  children: Container[]
  destroyed: boolean
}
const internals = (s: BattleScreen): Internals => s as unknown as Internals

function mockTexture(width = 100, height = 50): Texture {
  return { width, height, source: { scaleMode: 'linear' } } as unknown as Texture
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function make(
  party: BattleEntity[],
  enemies: BattleEntity[],
  opts: BattleScreenOptions = {},
  w = 800,
  h = 450
): BattleScreen {
  return new BattleScreen(new BattleEngine(party, enemies), w, h, opts)
}

/** dim が半透明黒を塗っているか（clear 済みなら bounds が空） */
function dimIsPainted(s: BattleScreen): boolean {
  const b = internals(s).dim.getLocalBounds()
  return b.width > 0 && b.height > 0
}

const created: BattleScreen[] = []
function track(s: BattleScreen): BattleScreen {
  created.push(s)
  return s
}

afterEach(() => {
  for (const s of created.splice(0)) {
    if (!internals(s).destroyed) s.destroy({ children: true })
  }
  vi.restoreAllMocks()
})

describe('BattleScreen: front（従来）', () => {
  it('opts なしで従来構成（enemyName/enemyHp/heroStats が visible・stage container なし）', () => {
    const s = track(make([entity('hero')], [entity('slime')]))
    const i = internals(s)
    expect(i.enemyNameText.visible).toBe(true)
    expect(i.enemyHpText.visible).toBe(true)
    expect(i.heroStatsText.visible).toBe(true)
    expect(i.enemyViews).toHaveLength(0)
    expect(i.partyViews).toHaveLength(0)
    expect(i.statusTexts).toHaveLength(0)
  })

  it("layout:'front' 明示でも opts なしと同一構成", () => {
    const a = track(make([entity('hero')], [entity('slime')]))
    const b = track(make([entity('hero')], [entity('slime')], { layout: 'front' }))
    expect(internals(b).children.length).toBe(internals(a).children.length)
    expect(internals(b).enemyViews).toHaveLength(0)
    expect(internals(b).heroStatsText.visible).toBe(true)
  })

  it('front ではログ末尾 4 件を表示する（side の行数ではない）', () => {
    const engine = new BattleEngine(
      [entity('hero', { atk: 1 })],
      [entity('slime', { hp: 999, maxHp: 999 })]
    )
    const s = track(new BattleScreen(engine, 800, 450))
    const log = engine.getState().log
    const shown = internals(s).logLines.map((t) => t.text)
    expect(shown.filter((t) => t !== '')).toEqual(log.slice(-internals(s).logLines.length))
  })
})

describe('BattleScreen: 背景画像', () => {
  it('background 未指定なら Assets.load を呼ばない', () => {
    const load = vi.spyOn(Assets, 'load')
    track(make([entity('hero')], [entity('slime')]))
    expect(load).not.toHaveBeenCalled()
  })

  it('background 成功 → 背景 sprite が先頭（index 0）で、dim は半透明黒を塗らない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(make([entity('hero')], [entity('slime')], { background: 'bg/a.webp' }))
    // ロード前は従来どおり暗くする
    expect(dimIsPainted(s)).toBe(true)
    await flushPromises()
    const i = internals(s)
    expect(i.backgroundSprite).not.toBeNull()
    expect(i.children[0]).toBe(i.backgroundSprite)
    expect(dimIsPainted(s)).toBe(false)
  })

  it('background 失敗 → warn 1 回・dim は半透明黒のまま・背景 sprite なし・例外なし', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = track(make([entity('hero')], [entity('slime')], { background: 'bg/missing.webp' }))
    await flushPromises()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(internals(s).backgroundSprite).toBeNull()
    expect(dimIsPainted(s)).toBe(true)
  })

  it('背景成功後に redraw しても背景 sprite は 1 つのまま', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(make([entity('hero')], [entity('slime')], { background: 'bg/a.webp' }))
    await flushPromises()
    s.redraw(400, 700)
    s.redraw(800, 450)
    const sprites = internals(s).children.filter((c) => c === internals(s).backgroundSprite)
    expect(sprites).toHaveLength(1)
    expect(dimIsPainted(s)).toBe(false)
  })

  it('背景ロードが destroy 後に resolve しても例外なし・sprite を追加しない', async () => {
    let resolve!: (t: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((r) => {
        resolve = r
      }) as never
    )
    const s = make([entity('hero')], [entity('slime')], { background: 'bg/a.webp' })
    s.destroy({ children: true })
    resolve(mockTexture())
    await flushPromises()
    expect(internals(s).backgroundSprite).toBeNull()
  })
})

describe('BattleScreen: 前景レイヤー (#747)', () => {
  const side: BattleScreenOptions = { layout: 'side', foreground: 'fg/a.png' }
  const party = [entity('hero'), entity('mage')]
  const foes = [entity('slime'), entity('bat')]

  it('成功 → foregroundSprite が sideStage の直後（敵ラベル層の手前）・パネルより下', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(make(party, foes, side))
    await flushPromises()
    const i = internals(s)
    expect(i.foregroundSprite).not.toBeNull()
    const idx = i.children.indexOf(i.foregroundSprite as unknown as Container)
    expect(idx).toBe(i.children.indexOf(i.sideStage as Container) + 1)
    expect(idx).toBeLessThan(i.children.indexOf(i.commandPanel))
    expect(idx).toBeLessThan(i.children.indexOf(i.statsPanel))
  })

  it('失敗 → warn 1 回・foregroundSprite なし・例外なし', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = track(make(party, foes, side))
    await flushPromises()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(internals(s).foregroundSprite).toBeNull()
  })

  it('destroy 後に読み込みが完了しても追加せず例外なし', async () => {
    let resolve!: (t: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((r) => {
        resolve = r
      }) as never
    )
    const s = make(party, foes, side)
    s.destroy({ children: true })
    resolve(mockTexture())
    await flushPromises()
    expect(internals(s).foregroundSprite).toBeNull()
  })

  it("layout='front' では Assets.load を呼ばない", () => {
    const load = vi.spyOn(Assets, 'load')
    track(make(party, foes, { layout: 'front', foreground: 'fg/a.png' }))
    expect(load).not.toHaveBeenCalled()
  })

  it('奥行き有効: sideStage.sortableChildren が立ち、各 view の zIndex は floor。無効なら 0', () => {
    const on = track(
      make(party, foes, { layout: 'side', depth: { horizon: 0.3, perspective: 0.8 } })
    )
    const L = computeSideBattleLayout({
      width: 800,
      height: 450,
      partyCount: 2,
      enemyCount: 2,
      depth: { horizon: 0.3, perspective: 0.8 },
    })
    const i = internals(on)
    expect(i.sideStage!.sortableChildren).toBe(true)
    i.enemyViews.forEach((v, k) => expect(v.container.zIndex).toBe(L.enemies[k].floor))
    i.partyViews.forEach((v, k) => expect(v.container.zIndex).toBe(L.party[k].floor))
    const off = internals(track(make(party, foes, { layout: 'side' })))
    expect(off.sideStage!.sortableChildren).toBe(false)
    for (const v of [...off.enemyViews, ...off.partyViews]) expect(v.container.zIndex).toBe(0)
  })

  it('背景の読み込みが前景より後に終わっても 背景 < sideStage < 前景 の順', async () => {
    let resolveBg!: (t: Texture) => void
    vi.spyOn(Assets, 'load').mockImplementation(((path: string) =>
      path === 'bg/a.webp'
        ? new Promise<Texture>((r) => {
            resolveBg = r
          })
        : Promise.resolve(mockTexture())) as never)
    const s = track(make(party, foes, { ...side, background: 'bg/a.webp' }))
    await flushPromises()
    resolveBg(mockTexture())
    await flushPromises()
    const i = internals(s)
    const bg = i.children.indexOf(i.backgroundSprite as unknown as Container)
    const st = i.children.indexOf(i.sideStage as Container)
    const fg = i.children.indexOf(i.foregroundSprite as unknown as Container)
    expect(bg).toBe(0)
    expect(bg).toBeLessThan(st)
    expect(st).toBeLessThan(fg)
  })

  it('敵ラベル層は前景より上（かつパネルより下）。ラベルは sideStage の外にある', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(make(party, foes, side))
    await flushPromises()
    const i = internals(s)
    const fg = i.children.indexOf(i.foregroundSprite as unknown as Container)
    const lab = i.children.indexOf(i.labelLayer as Container)
    expect(lab).toBeGreaterThan(fg)
    expect(lab).toBeLessThan(i.children.indexOf(i.commandPanel))
    for (const v of i.enemyViews) {
      expect(v.label!.parent).toBe(i.labelLayer)
      expect(i.sideStage!.children).not.toContain(v.label)
    }
  })
})

describe('BattleScreen: 被写界深度 (#753)', () => {
  // jsdom は canvas 不可で createDofMaskTexture が常に null → 段が作られないので、成功する形に差し替える
  beforeEach(() => {
    vi.spyOn(BattleScreen.prototype as never, 'createDofMaskTexture').mockImplementation(
      (() => new Texture()) as never
    )
  })

  const dofLevels = (s: BattleScreen) =>
    (
      s as unknown as {
        dofLevels: {
          sprite: { geometry: { positions: Float32Array }; filters: unknown }
          mask: Sprite
        }[]
      }
    ).dofLevels

  it('on: 段数ぶんのぼかしコピー+マスクが背景の直上に弱→強の順で並ぶ（背面に隠れない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(
      make([entity('hero')], [entity('slime')], { background: 'bg/a.webp', backgroundDof: 'on' })
    )
    await flushPromises()
    const i = internals(s)
    const lv = dofLevels(s)
    expect(lv).toHaveLength(DOF_LEVEL_COUNT)
    expect(i.children[0]).toBe(i.backgroundSprite)
    lv.forEach((l, k) => {
      expect(i.children[1 + k * 2]).toBe(l.sprite)
      expect(i.children[2 + k * 2]).toBe(l.mask)
      // 拡張後の幅は背景幅 + 2 * 拡張量（端のぼけ欠け対策）
      const xs = [0, 2, 4, 6].map((n) => l.sprite.geometry.positions[n])
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(
        i.backgroundSprite!.width + 2 * DOF_EDGE_EXTEND
      )
      // マスクは画面幅を覆う
      expect(l.mask.x).toBe(0)
      expect(l.mask.width).toBeGreaterThanOrEqual(800)
    })
    const strengths = lv.map(
      (l) => (l.sprite.filters as unknown as { strength: number }[]).slice(-1)[0].strength
    )
    expect(strengths[strengths.length - 1]).toBeCloseTo(DOF_MAX_BLUR_STRENGTH)
    expect([...strengths].sort((a, b) => a - b)).toEqual(strengths)
    expect(new Set(strengths).size).toBe(DOF_LEVEL_COUNT)
  })

  it('各段のぼかしフィルタは padding を残し viewport クリップを切る（画面端でカーネルが欠けない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(
      make([entity('hero')], [entity('slime')], { background: 'bg/a.webp', backgroundDof: 'on' })
    )
    await flushPromises()
    for (const l of dofLevels(s)) {
      const blur = (
        l.sprite.filters as {
          strength: number
          padding: number
          repeatEdgePixels: boolean
          clipToViewport: boolean
        }[]
      ).slice(-1)[0]
      expect(blur.repeatEdgePixels).toBe(false)
      expect(blur.clipToViewport).toBe(false)
      expect(blur.padding).toBeGreaterThanOrEqual(blur.strength)
      expect(blur.padding).toBeLessThanOrEqual(DOF_EDGE_EXTEND)
    }
  })

  it('redraw を繰り返しても段は積み増さない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(
      make([entity('hero')], [entity('slime')], { background: 'bg/a.webp', backgroundDof: 'on' })
    )
    await flushPromises()
    const before = internals(s).children.length
    s.redraw(300, 200)
    s.redraw(320, 240)
    expect(dofLevels(s)).toHaveLength(DOF_LEVEL_COUNT)
    expect(internals(s).children.length).toBe(before)
  })

  it('canvas が使えず マスクが作れないときは 1 段も作らず、layout のたびに再試行しない', async () => {
    const create = vi
      .spyOn(BattleScreen.prototype as never, 'createDofMaskTexture')
      .mockImplementation((() => null) as never)
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(
      make([entity('hero')], [entity('slime')], { background: 'bg/a.webp', backgroundDof: 'on' })
    )
    await flushPromises()
    expect(dofLevels(s)).toHaveLength(0)
    const calls = create.mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(1)
    s.redraw(300, 200)
    s.redraw(640, 480)
    expect(create.mock.calls.length).toBe(calls)
    expect(internals(s).children[0]).toBe(internals(s).backgroundSprite)
  })

  it('途中の段でマスクが作れなくなったら、作った段も破棄して残さない', async () => {
    let n = 0
    vi.spyOn(BattleScreen.prototype as never, 'createDofMaskTexture').mockImplementation((() =>
      n++ < 2 ? new Texture() : null) as never)
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(
      make([entity('hero')], [entity('slime')], { background: 'bg/a.webp', backgroundDof: 'on' })
    )
    await flushPromises()
    expect(dofLevels(s)).toHaveLength(0)
    expect(internals(s).children[0]).toBe(internals(s).backgroundSprite)
  })

  it('destroy は各段の geometry を 1 回ずつ破棄する（Mesh.destroy は geometry を破棄しない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(
      make([entity('hero')], [entity('slime')], { background: 'bg/a.webp', backgroundDof: 'on' })
    )
    await flushPromises()
    const spies = dofLevels(s).map((l) =>
      vi.spyOn((l.sprite as unknown as { geometry: { destroy: () => void } }).geometry, 'destroy')
    )
    expect(spies).toHaveLength(DOF_LEVEL_COUNT)
    s.destroy({ children: true })
    spies.forEach((sp) => expect(sp).toHaveBeenCalledTimes(1))
  })

  it('各段の filterArea は その段のマスクが見える帯＋左右の拡張を覆い、上の段ほど上から始まる。リサイズに追従', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(
      make([entity('hero')], [entity('slime')], { background: 'bg/a.webp', backgroundDof: 'on' })
    )
    await flushPromises()
    for (const [w, h] of [
      [800, 450],
      [300, 600],
    ]) {
      s.redraw(w, h)
      const bg = internals(s).backgroundSprite!
      let prevY = -Infinity
      for (const l of dofLevels(s)) {
        const fa = (
          l.sprite as unknown as {
            filterArea: { x: number; y: number; width: number; height: number }
          }
        ).filterArea
        // 幅は背景幅＋左右の拡張
        expect(fa.x).toBeCloseTo(-DOF_EDGE_EXTEND)
        expect(fa.width).toBeCloseTo(bg.width + 2 * DOF_EDGE_EXTEND)
        // 上端はマスクの上端（画面座標 mask.y をローカルへ）に一致、下端は広げた矩形の下端
        expect(fa.y).toBeCloseTo(l.mask.y - bg.position.y)
        expect(fa.y + fa.height).toBeCloseTo(bg.height + DOF_EDGE_EXTEND)
        expect(fa.y).toBeGreaterThanOrEqual(prevY)
        prevY = fa.y
      }
    }
  })

  it('実物の createDofMaskTexture は jsdom（canvas 不可）では null を返す', () => {
    vi.restoreAllMocks()
    const s = track(make([entity('hero')], [entity('slime')]))
    const fn = (
      BattleScreen.prototype as unknown as {
        createDofMaskTexture: (this: BattleScreen, r: number) => unknown
      }
    ).createDofMaskTexture
    expect(fn.call(s, 0.5)).toBeNull()
  })

  it('off なら段を作らない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(make([entity('hero')], [entity('slime')], { background: 'bg/a.webp' }))
    await flushPromises()
    expect(dofLevels(s)).toHaveLength(0)
  })
})

describe('BattleScreen: side', () => {
  const side: BattleScreenOptions = { layout: 'side' }

  it('enemyName/enemyHp/heroStats を非表示にする', () => {
    const s = track(make([entity('hero')], [entity('slime')], side))
    const i = internals(s)
    expect(i.enemyNameText.visible).toBe(false)
    expect(i.enemyHpText.visible).toBe(false)
    expect(i.heroStatsText.visible).toBe(false)
  })

  it('敵 3・味方 2 で EntityView が 3 + 2', () => {
    const s = track(
      make([entity('hero'), entity('mage')], [entity('a'), entity('b'), entity('c')], side)
    )
    expect(internals(s).enemyViews).toHaveLength(3)
    expect(internals(s).partyViews).toHaveLength(2)
    expect(internals(s).statusTexts).toHaveLength(2)
  })

  it('sprite 指定 → Assets.load が sprite パスで呼ばれ、ロード後にフォールバックが非表示になる', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(make([entity('hero')], [entity('slime', { sprite: 'm/slime.webp' })], side))
    expect(load).toHaveBeenCalledWith('m/slime.webp')
    expect(internals(s).enemyViews[0].fallback.visible).toBe(true)
    await flushPromises()
    const v = internals(s).enemyViews[0]
    expect(v.sprite).not.toBeNull()
    expect(v.fallback.visible).toBe(false)
  })

  it('sprite 失敗 → フォールバック可視・warn・他の view に影響しない', async () => {
    vi.spyOn(Assets, 'load').mockImplementation(((path: string) =>
      path === 'm/bad.webp'
        ? Promise.reject(new Error('404'))
        : Promise.resolve(mockTexture())) as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = track(
      make(
        [entity('hero', { sprite: 'p/hero.webp' })],
        [entity('bad', { sprite: 'm/bad.webp' }), entity('ok', { sprite: 'm/ok.webp' })],
        side
      )
    )
    await flushPromises()
    const i = internals(s)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(i.enemyViews[0].sprite).toBeNull()
    expect(i.enemyViews[0].fallback.visible).toBe(true)
    expect(i.enemyViews[1].sprite).not.toBeNull()
    expect(i.enemyViews[1].fallback.visible).toBe(false)
    expect(i.partyViews[0].sprite).not.toBeNull()
  })

  it('sprite 未指定の entity は Assets.load を呼ばず色四角のまま', () => {
    const load = vi.spyOn(Assets, 'load')
    const s = track(make([entity('hero')], [entity('slime')], side))
    expect(load).not.toHaveBeenCalled()
    expect(internals(s).enemyViews[0].fallback.visible).toBe(true)
    expect(internals(s).partyViews[0].fallback.visible).toBe(true)
  })

  it.each([
    [-1, DEAD_ALPHA],
    [0, DEAD_ALPHA],
    [1, 1],
  ])('hp=%d の敵・味方 view の alpha は %d', (hp, alpha) => {
    const s = track(make([entity('hero', { hp })], [entity('slime', { hp })], side))
    expect(internals(s).enemyViews[0].container.alpha).toBe(alpha)
    expect(internals(s).enemyViews[0].label!.alpha).toBe(alpha)
    expect(internals(s).partyViews[0].container.alpha).toBe(alpha)
  })

  it('statusText は 320 幅では MP なし・800 幅では MP あり', () => {
    const narrow = track(make([entity('hero')], [entity('slime')], side, 320, 568))
    const wide = track(make([entity('hero')], [entity('slime')], side, 800, 450))
    const row = (s: BattleScreen, k: 'Hp' | 'Mp'): string => {
      const i = internals(s)
      const g = (key: string) => (i as unknown as Record<string, Text[]>)[key][0]
      return [g(`status${k}Labels`), g(`status${k}Texts`), g(`status${k}Maxes`)]
        .map((t) => t.text)
        .join('')
    }
    expect(row(narrow, 'Hp')).toContain('10/10')
    expect(row(narrow, 'Mp')).toBe('')
    expect(internals(narrow).statusMpTexts[0].visible).toBe(false)
    expect(row(wide, 'Hp')).toBe('HP10/10')
    expect(row(wide, 'Mp')).toBe('MP4/4')
  })

  it('味方 hp=0 の statusText は灰色 fill', () => {
    const s = track(make([entity('hero'), entity('mage', { hp: 0 })], [entity('slime')], side))
    const [alive, dead] = internals(s).statusTexts
    expect(alive.style.fill).not.toBe(dead.style.fill)
    expect(dead.style.fill).toBe(0x888888)
  })

  it('敵ラベルは名前と HP を含む', () => {
    const s = track(make([entity('hero')], [entity('slime', { name: 'スライム' })], side))
    expect(internals(s).enemyViews[0].label?.text).toBe('スライム\nHP 10/10')
    expect(internals(s).partyViews[0].label).toBeNull()
  })

  it.each([[SIDE_LOG_MIN_LINES - 1], [SIDE_LOG_MIN_LINES], [SIDE_LOG_MIN_LINES + 1]])(
    'ログは直近 SIDE_LOG_MIN_LINES 行のみ（敵 1 体）（エンジンのログが %d 行のとき）',
    (count) => {
      const engine = new BattleEngine([entity('hero')], [entity('slime')])
      const log = engine.getState().log as string[]
      log.length = 0
      for (let n = 0; n < count; n++) log.push(`line${n}`)
      const s = track(new BattleScreen(engine, 800, 450, side))
      const shown = internals(s)
        .logLines.map((t) => t.text)
        .filter((t) => t !== '')
      expect(shown).toEqual(log.slice(-SIDE_LOG_MIN_LINES))
      expect(shown.length).toBe(Math.min(count, SIDE_LOG_MIN_LINES))
    }
  )

  it('背景失敗かつ sprite 失敗でも例外なし', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = track(
      make([entity('hero', { sprite: 'p/x.webp' })], [entity('slime', { sprite: 'm/x.webp' })], {
        layout: 'side',
        background: 'bg/x.webp',
      })
    )
    await flushPromises()
    expect(internals(s).backgroundSprite).toBeNull()
    expect(internals(s).enemyViews[0].fallback.visible).toBe(true)
  })

  it('destroy 後に sprite ロードが resolve しても例外なし・sprite を追加しない', async () => {
    const resolvers: Array<(t: Texture) => void> = []
    vi.spyOn(Assets, 'load').mockImplementation(
      (() => new Promise<Texture>((r) => resolvers.push(r))) as never
    )
    const s = make(
      [entity('hero', { sprite: 'p/x.webp' })],
      [entity('slime', { sprite: 'm/x.webp' })],
      side
    )
    const views = [...internals(s).enemyViews, ...internals(s).partyViews]
    s.destroy({ children: true })
    for (const r of resolvers) r(mockTexture())
    await flushPromises()
    for (const v of views) expect(v.sprite).toBeNull()
  })

  it('背景も sprite も成功する経路で warn / error が出ない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    track(
      make([entity('hero', { sprite: 'p/x.webp' })], [entity('slime', { sprite: 'm/x.webp' })], {
        layout: 'side',
        background: 'bg/x.webp',
      })
    )
    await flushPromises()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('redraw で幅 800 → 360 にすると compact へ切り替わり statusText が短縮される', () => {
    const s = track(make([entity('hero')], [entity('slime')], side, 800, 450))
    expect(internals(s).statusMpLabels[0].text).toContain('MP')
    s.redraw(360, 640)
    expect(internals(s).statusMpLabels[0].text).not.toContain('MP')
    s.redraw(800, 450)
    expect(internals(s).statusMpLabels[0].text).toContain('MP')
  })

  it('compact 閾値の定数が MP 表記の切替に使われている（幅スイープで MP 有無が一度だけ切り替わる）', () => {
    const s = track(make([entity('hero')], [entity('slime')], side, 800, 450))
    let prev = false
    let flips = 0
    for (let w = 300; w <= 900; w += 10) {
      s.redraw(w, 640)
      const hasMp = internals(s).statusMpLabels[0].text.includes('MP')
      if (hasMp !== prev) flips++
      prev = hasMp
    }
    expect(flips).toBe(1)
    expect(SIDE_STATUS_COMPACT_WIDTH).toBeGreaterThan(0)
  })
})

describe('BattleScreen: side のレビュー指摘対応 (#736)', () => {
  const sideOpts: BattleScreenOptions = { layout: 'side' }
  const enemies = (n: number): BattleEntity[] =>
    Array.from({ length: n }, (_, k) => entity(`e${k}`, { name: `てき${k}` }))

  it.each([
    [1, 2],
    [2, 3],
    [3, 4],
    [6, 4],
  ])('敵 %d 体 → ログ行テキストは %d 本だけ生成される（800x720）', (n, lines) => {
    const s = track(make([entity('hero')], enemies(n), sideOpts, 800, 720))
    expect(internals(s).logLines).toHaveLength(lines)
  })

  it('低い画面ではログ行テキストが減り、リサイズで増減に追従する', () => {
    const party = [entity('p0'), entity('p1'), entity('p2'), entity('p3')]
    const s = track(make(party, enemies(6), sideOpts, 800, 720))
    expect(internals(s).logLines).toHaveLength(4)
    s.redraw(568, 320)
    expect(internals(s).logLines).toHaveLength(SIDE_LOG_MIN_LINES)
    s.redraw(800, 720)
    expect(internals(s).logLines).toHaveLength(4)
  })

  it('敵が複数いてもログの行数ぶんだけ直近ログを表示する', () => {
    const engine = new BattleEngine([entity('hero')], enemies(3))
    const log = engine.getState().log as string[]
    log.length = 0
    for (let n = 0; n < 9; n++) log.push(`line${n}`)
    const s = track(new BattleScreen(engine, 800, 720, sideOpts))
    expect(internals(s).logLines.map((t) => t.text)).toEqual(log.slice(-4))
  })

  it('敵ラベルは縁取り(stroke)付き。背景指定の有無で変わらない', () => {
    for (const opts of [sideOpts, { ...sideOpts, background: 'bg/x.webp' }]) {
      vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
      const s = track(make([entity('hero')], [entity('slime')], opts))
      const stroke = internals(s).enemyViews[0].label!.style.stroke as {
        color: unknown
        width: number
      }
      expect(stroke.width).toBe(SIDE_LABEL_STROKE_WIDTH)
      expect(stroke.width).toBeGreaterThan(0)
    }
  })

  it('敵ラベルは画面絶対（前景より上の層）でスプライト直下（純粋関数のラベル矩形）に置かれる', () => {
    const s = track(make([entity('hero')], enemies(3), sideOpts, 800, 720))
    const L = computeSideBattleLayout({
      width: 800,
      height: 720,
      partyCount: 1,
      enemyCount: 3,
    })
    internals(s).enemyViews.forEach((v, k) => {
      const slot = L.enemies[k]
      expect(v.label!.x).toBeCloseTo(slot.label!.x + slot.label!.w / 2)
      expect(v.label!.y).toBeCloseTo(slot.y + slot.size + 2)
      expect(v.label!.visible).toBe(true)
    })
  })

  it('長い敵名は省略され、ラベル幅(=スプライト一辺)を越えない', () => {
    const s = track(
      make(
        [entity('hero')],
        [
          entity('a', { name: 'とてもとてもながいなまえのモンスターたち' }),
          entity('b'),
          entity('c'),
          entity('d'),
        ],
        sideOpts,
        360,
        640
      )
    )
    const nameLine = internals(s).enemyViews[0].label!.text.split('\n')[0]
    expect(nameLine.endsWith('…')).toBe(true)
    const L = computeSideBattleLayout({ width: 360, height: 640, partyCount: 1, enemyCount: 4 })
    expect(estimateTextWidth(nameLine, 12)).toBeLessThanOrEqual(L.enemies[0].size + 0.001)
  })

  it.each([
    ['ながいなまえのゆうしゃ', 20],
    ['ながいなまえのゆうしゃ', 120],
  ])(
    '320 幅でも status の名前と HP は概算幅でパネル内に収まり、名前が残る（%s, HP %d）',
    (name, hp) => {
      const s = track(
        make([entity('hero', { name, hp, maxHp: hp })], [entity('slime')], sideOpts, 320, 568)
      )
      const L = computeSideBattleLayout({ width: 320, height: 568, partyCount: 1, enemyCount: 1 })
      const nameT = internals(s).statusTexts[0]
      const i = internals(s)
      const [lab, cur, max] = [i.statusHpLabels[0], i.statusHpTexts[0], i.statusHpMaxes[0]]
      expect(`${cur.text}${max.text}`.endsWith(`${hp}/${hp}`)).toBe(true)
      expect(nameT.text.length).toBeGreaterThan(0)
      expect(nameT.text.startsWith(name.slice(0, 1))).toBe(true)
      // 名前の右端 <= HP 列の左端、HP 列の右端 <= パネル内側の右端
      const hpLeft = lab.text ? lab.x : cur.x - estimateTextWidth(cur.text, 14)
      const hpRight = max.text ? max.x : cur.x
      expect(nameT.x + estimateTextWidth(nameT.text, 14)).toBeLessThanOrEqual(hpLeft + 0.001)
      expect(hpRight).toBeLessThanOrEqual(L.status.x + L.status.w - 12 + 0.001)
      expect(nameT.x).toBeGreaterThanOrEqual(L.status.x)
    }
  )
})

describe('BattleScreen: side の文字はみ出し対策 2 巡目 (#736)', () => {
  const sideOpts: BattleScreenOptions = { layout: 'side' }
  type CmdInternals = { commands: Array<{ text: Text }> }

  it.each([
    [320, 568],
    [360, 640],
    [320, 240],
  ])('%dx%d: コマンド文字はセル幅に余白つきで収まる', (w, h) => {
    const s = track(make([entity('hero')], [entity('slime')], sideOpts, w, h))
    const L = computeSideBattleLayout({ width: w, height: h, partyCount: 1, enemyCount: 1 })
    const cmds = (s as unknown as CmdInternals).commands
    cmds.forEach((c, k) => {
      const font = Number(c.text.style.fontSize)
      expect(
        estimateTextWidth(c.text.text, font) + SIDE_COMMAND_TEXT_PADDING * 2
      ).toBeLessThanOrEqual(L.commandCells[k].w + 1e-9)
    })
  })

  it('コマンドのフォント縮小は他の BattleScreen（front）に漏れない', () => {
    const a = track(make([entity('hero')], [entity('slime')], sideOpts, 320, 568))
    const b = track(make([entity('hero')], [entity('slime')]))
    expect(Number((a as unknown as CmdInternals).commands[0].text.style.fontSize)).toBeLessThan(18)
    expect(Number((b as unknown as CmdInternals).commands[0].text.style.fontSize)).toBe(18)
  })

  it('敵名の省略は縁取り(両側)ぶんを引いた幅に収まる', () => {
    const s = track(
      make(
        [entity('hero')],
        [
          entity('a', { name: 'とてもとてもながいなまえのモンスターたち' }),
          entity('b'),
          entity('c'),
        ],
        sideOpts,
        360,
        640
      )
    )
    const L = computeSideBattleLayout({ width: 360, height: 640, partyCount: 1, enemyCount: 3 })
    const nameLine = internals(s).enemyViews[0].label!.text.split('\n')[0]
    expect(estimateTextWidth(nameLine, 12)).toBeLessThanOrEqual(
      L.enemies[0].label!.w - SIDE_LABEL_STROKE_WIDTH * 2 + 0.001
    )
  })
})

describe('BattleScreen: 敵ラベルの HP は数値を優先して残す (#736)', () => {
  it('640x360・敵 6 体: HP 行は「HP 」が落ちても 12/12 が見える', () => {
    const foes = Array.from({ length: 6 }, (_, k) =>
      entity(`e${k}`, { name: `てき${k}`, hp: 12, maxHp: 12 })
    )
    const s = track(make([entity('hero')], foes, { layout: 'side' }, 640, 360))
    for (const v of internals(s).enemyViews) {
      expect(v.label!.text.split('\n')[1]).toMatch(/12\/12$/)
    }
  })

  it('800x450・敵 3 体（2 列 83px）は「HP 12/12」がそのまま出る', () => {
    const foes = Array.from({ length: 3 }, (_, k) => entity(`e${k}`, { hp: 12, maxHp: 12 }))
    const s = track(make([entity('hero')], foes, { layout: 'side' }, 800, 450))
    for (const v of internals(s).enemyViews) expect(v.label!.text.split('\n')[1]).toBe('HP 12/12')
  })
})

/** Node の process の最小型（@types/node に依存しない） */
interface NodeEmitter {
  on(ev: string, fn: (...a: unknown[]) => void): void
  off(ev: string, fn: (...a: unknown[]) => void): void
}

describe('BattleScreen: acrylic (#737)', () => {
  const sideNone: BattleScreenOptions = { layout: 'side' }
  const acrylic: BattleScreenOptions = { layout: 'side', spriteStyle: 'acrylic' }
  const withSprite = (id: string): BattleEntity => entity(id, { sprite: `img/${id}.webp` })
  /** Graphics に積まれた fill 命令の色と不透明度（描画順） */
  const fillsOf = (g: Graphics): Array<{ color: number; alpha: number }> =>
    (
      g.context.instructions as unknown as Array<{
        action: string
        data: { style: { color: number; alpha: number } }
      }>
    )
      .filter((ins) => ins.action === 'fill')
      .map((ins) => ({ color: ins.data.style.color, alpha: ins.data.style.alpha }))
  const TEX_W = 100
  const TEX_H = 50
  /** 実寸を持つ本物の Texture（モックだと Sprite が EMPTY に差し替えて配置の数値を検証できない） */
  const sizedTexture = (width: number, height: number): Texture =>
    new Texture({ source: new TextureSource({ width, height }) })
  const okLoad = (): void => {
    vi.spyOn(Assets, 'load').mockResolvedValue(sizedTexture(TEX_W, TEX_H) as never)
  }
  /** 敵の slot（#760: 敵は立ち絵の縦横比 TEX_W/TEX_H の枠になる） */
  const enemySlot = (w = 800, h = 450, party = 1, enemies = 1) =>
    computeSideBattleLayout({
      width: w,
      height: h,
      partyCount: party,
      enemyCount: enemies,
      enemyAspects: Array(enemies).fill(TEX_W / TEX_H),
    }).enemies[0]
  /** acrylic の正方形の一辺 = 敵の枠の長辺（横長の敵は幅。下端は枠の下端に揃う） */
  const slotSize = (w = 800, h = 450, party = 1, enemies = 1): number => {
    const e = enemySlot(w, h, party, enemies)
    return Math.max(e.size, e.width)
  }
  const defaultGeometry = (size: number) =>
    computeAcrylicGeometry(TEX_W, TEX_H, size, resolveAcrylicParams())
  const PLATE_PAD = 8
  const plateMask = (v: { acrylicPlate: Sprite | null }): Graphics =>
    v.acrylicPlate!.mask as Graphics
  /** jsdom には canvas が無いので、板テクスチャの生成だけ差し替える（形・質感の計算は acrylicPlate.test.ts） */
  beforeEach(() => {
    vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate').mockImplementation((() => ({
      texture: sizedTexture(TEX_W + PLATE_PAD * 2, TEX_H + PLATE_PAD * 2),
      pad: PLATE_PAD,
    })) as never)
  })

  describe('none（回帰）', () => {
    it('spriteStyle 未指定: acrylicBack / acrylicPlate は null・sprite.filters は空・子は fallback→sprite→label の 3 つ', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], sideNone))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack).toBeNull()
      expect(v.acrylicPlate).toBeNull()
      expect(v.sprite!.filters ?? []).toHaveLength(0)
      // ラベルは container の外（labelLayer・#747）
      expect(v.container.children).toHaveLength(2)
      expect(v.container.children[0]).toBe(v.fallback)
      expect(v.container.children[1]).toBe(v.sprite)
      expect(v.label!.parent).toBe(internals(s).labelLayer)
    })

    it('spriteStyle 未指定のスプライト配置は #736 の contain と同一', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], sideNone))
      await flushPromises()
      const sp = internals(s).enemyViews[0].sprite!
      const e = enemySlot()
      const fit = computeContainFitRect(TEX_W, TEX_H, e.width, e.size)
      expect(sp.x).toBeCloseTo(fit.x, 9)
      expect(sp.y).toBeCloseTo(fit.y, 9)
      expect(sp.width).toBeCloseTo(fit.width, 9)
      expect(sp.height).toBeCloseTo(fit.height, 9)
    })

    it("spriteStyle:'none' 明示でも画像成功後の構成は未指定と同一", async () => {
      okLoad()
      const a = track(make([entity('hero')], [withSprite('slime')], sideNone))
      const b = track(
        make([entity('hero')], [withSprite('slime')], { ...sideNone, spriteStyle: 'none' })
      )
      await flushPromises()
      const va = internals(a).enemyViews[0]
      const vb = internals(b).enemyViews[0]
      expect(vb.acrylicBack).toBeNull()
      expect(vb.acrylicPlate).toBeNull()
      expect(vb.container.children).toHaveLength(va.container.children.length)
      expect([vb.sprite!.x, vb.sprite!.y, vb.sprite!.width, vb.sprite!.height]).toEqual([
        va.sprite!.x,
        va.sprite!.y,
        va.sprite!.width,
        va.sprite!.height,
      ])
    })

    it("不正値 'ACRYLIC' は none 扱い（BattleScreen は === 'acrylic' の厳密比較。正規化は rpgProjectFromDoc の責務）", async () => {
      okLoad()
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          layout: 'side',
          spriteStyle: 'ACRYLIC' as never,
        })
      )
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack).toBeNull()
      expect(v.acrylicPlate).toBeNull()
      expect(v.container.children).toHaveLength(2)
    })
  })

  describe('acrylic: 読み込み状態', () => {
    it('sprite 未指定の entity は Assets.load を呼ばず色四角のまま・acrylicBack なし', () => {
      const load = vi.spyOn(Assets, 'load')
      const s = track(make([entity('hero')], [entity('slime')], acrylic))
      expect(load).not.toHaveBeenCalled()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack).toBeNull()
      expect(v.fallback.visible).toBe(true)
      expect(internals(s).partyViews[0].acrylicBack).toBeNull()
    })

    it('保留中: acrylicBack はあるが非表示・fallback 表示・filter なし', () => {
      vi.spyOn(Assets, 'load').mockReturnValue(new Promise<Texture>(() => {}) as never)
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack).not.toBeNull()
      expect(v.acrylicBack!.visible).toBe(false)
      expect(v.fallback.visible).toBe(true)
      expect(v.acrylicPlate).toBeNull()
      expect(v.sprite).toBeNull()
    })

    it('成功: acrylicBack 表示・板ちょうど 1 つ・fallback 非表示・sprite.filters は空 (#760)', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack!.visible).toBe(true)
      expect(v.acrylicPlate).not.toBeNull()
      expect(v.fallback.visible).toBe(false)
      expect(v.sprite!.filters ?? []).toHaveLength(0)
    })

    it('成功: 子の順序は fallback → acrylicBack → 板 → 板の mask → sprite（label は container の外）(#760)', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.container.children).toHaveLength(5)
      expect(v.container.children[0]).toBe(v.fallback)
      expect(v.container.children[1]).toBe(v.acrylicBack)
      expect(v.container.children[2]).toBe(v.acrylicPlate)
      expect(v.container.children[3]).toBe(plateMask(v))
      expect(v.container.children[4]).toBe(v.sprite)
      expect(v.label!.parent).toBe(internals(s).labelLayer)
    })

    it('板を作れない環境（canvas 無し）: 板なしで台座・sprite だけ描く (#760)', async () => {
      okLoad()
      vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate').mockImplementation(
        (() => null) as never
      )
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicPlate).toBeNull()
      expect(v.acrylicBack!.visible).toBe(true)
      expect(v.container.children).toHaveLength(3)
      expect(v.container.children[2]).toBe(v.sprite)
    })

    it('台座: canvas が無い環境では Graphics の台座（acrylicBase なし）(#760)', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBase).toBeNull()
      expect(fillsOf(v.acrylicBack!).length).toBeGreaterThan(0)
    })

    it('台座: 共有テクスチャがあれば Sprite で敷き、Graphics は描かない・影の幅が幾何と一致 (#760)', async () => {
      okLoad()
      const layout = {
        width: 512,
        height: 160,
        cx: 256,
        cyTop: 70,
        rx: 211,
        ry: 59,
        shadowRx: 254,
        thickness: 10,
      }
      const baseTex = sizedTexture(512, 160)
      vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicBase').mockImplementation((() => ({
        texture: baseTex,
        layout,
      })) as never)
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBase).not.toBeNull()
      expect(v.container.children[2]).toBe(v.acrylicBase)
      expect(v.container.children[3]).toBe(v.acrylicPlate)
      expect(v.container.children[4]).toBe(plateMask(v))
      expect(fillsOf(v.acrylicBack!)).toHaveLength(0)
      const g = defaultGeometry(slotSize())
      const k = g.shadow!.rx / layout.shadowRx
      expect(v.acrylicBase!.scale.x).toBeCloseTo(k, 9)
      expect(v.acrylicBase!.x).toBeCloseTo(g.base!.cx - layout.cx * k, 9)
      expect(v.acrylicBase!.y).toBeCloseTo(g.base!.cy - layout.cyTop * k, 9)
      // 共有テクスチャは view の破棄で壊さない
      s.destroy({ children: true })
      expect(baseTex.destroyed).toBe(false)
    })

    it('影: 板テクスチャに影があれば shadowLayer（全キャラの下）に Sprite で敷き、足元基点で変形する (#760)', async () => {
      okLoad()
      vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate').mockImplementation((() => ({
        texture: sizedTexture(TEX_W + 16, TEX_H + 16),
        pad: 8,
        shadow: sizedTexture(TEX_W + 16, TEX_H + 16),
        foot: { x: 8 + TEX_W / 2, y: 8 + TEX_H },
      })) as never)
      const s = track(make([withSprite('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const i = internals(s) as unknown as {
        shadowLayer: Container
        sideStage: Container
        children: Container[]
      }
      expect(i.shadowLayer.children).toHaveLength(2) // 敵 1 + 味方 1
      // 影の層は sideStage（全スプライトの親）より下
      expect(i.children.indexOf(i.shadowLayer)).toBeLessThan(i.children.indexOf(i.sideStage))
      const v = internals(s).enemyViews[0]
      const sh = v.acrylicShadow!
      expect(sh.parent).toBe(i.shadowLayer)
      expect(sh.pivot.x).toBe(8 + TEX_W / 2)
      expect(sh.pivot.y).toBe(8 + TEX_H)
      const k = v.sprite!.width / TEX_W
      const t = computeShadowTransform(resolveAcrylicParams(), k)
      expect(sh.scale.x).toBeCloseTo(t.scaleX, 9)
      expect(sh.scale.y).toBeCloseTo(t.scaleY, 9)
      expect(sh.skew.x).toBeCloseTo(t.skewX, 9)
      // 基点 = スプライト下端の中央（画面座標）
      expect(sh.x).toBeCloseTo(v.container.x + v.sprite!.x + v.sprite!.width / 2, 6)
      expect(sh.y).toBeCloseTo(v.container.y + v.sprite!.y + v.sprite!.height, 6)
      // 破棄で影のテクスチャも破棄され、参照は null
      s.destroy({ children: true })
      expect(v.acrylicShadow).toBeNull()
    })

    it('影: none では shadowLayer を作らない・板のテクスチャに影が無ければ影なし (#760)', async () => {
      okLoad()
      const n = track(make([entity('hero')], [withSprite('slime')], sideNone))
      await flushPromises()
      expect((internals(n) as unknown as { shadowLayer: unknown }).shadowLayer ?? null).toBeNull()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      expect(internals(s).enemyViews[0].acrylicShadow).toBeNull()
    })

    it('板はスリットの高さで水平に切られる（スリットと同じ computeSlitY の値）・スプライトの足元は切らない (#760)', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const plate = v.acrylicPlate!
      const mask = plate.mask as Graphics
      expect(mask).toBeInstanceOf(Graphics)
      const g = defaultGeometry(slotSize())
      const slitY = computeSlitY(g.base!.cy, g.base!.ry)
      const b = mask.getLocalBounds()
      // mask は板の兄弟（container 座標）。下端 = スリットの y・上端 = 板の上端
      expect(b.maxY).toBeCloseTo(slitY, 6)
      expect(b.minY).toBeCloseTo(plate.y, 6)
      // v8 では Sprite に子を足せない（mask を板の子にしない）
      expect(plate.children).toHaveLength(0)
      expect(mask.parent).toBe(v.container)
      // スプライトには mask をかけない（足は台座の上に立って見える）
      expect(v.sprite!.mask ?? null).toBeNull()
      // 切る位置は台座の上面の中心より奥側（足元 g.base.cy より上）
      expect(slitY).toBeLessThan(g.base!.cy)
    })

    it('hasBase=false の板は切られない（mask は板全体）(#760)', async () => {
      okLoad()
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { hasBase: false },
        })
      )
      await flushPromises()
      const plate = internals(s).enemyViews[0].acrylicPlate!
      const b = (plate.mask as Graphics).getLocalBounds()
      expect(b.maxY - b.minY).toBeCloseTo(plate.texture.height * plate.scale.y, 6)
    })

    it('成功: 板は sprite と同じ倍率で、pad ぶん左上へ広がって敷かれる (#760)', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const k = v.sprite!.width / TEX_W
      expect(v.acrylicPlate!.scale.x).toBeCloseTo(k, 9)
      expect(v.acrylicPlate!.x).toBeCloseTo(v.sprite!.x - PLATE_PAD * k, 9)
      expect(v.acrylicPlate!.y).toBeCloseTo(v.sprite!.y - PLATE_PAD * k, 9)
      expect(v.acrylicPlate!.visible).toBe(true)
    })

    it('成功: sprite は slot 枠に収まり、足元が台座の中心に乗る（computeAcrylicGeometry と一致）', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const sp = internals(s).enemyViews[0].sprite!
      const size = slotSize()
      const g = defaultGeometry(size)
      expect(sp.x).toBeCloseTo(g.sprite.x, 9)
      expect(sp.y).toBeCloseTo(g.sprite.y, 9)
      expect(sp.width).toBeCloseTo(g.sprite.width, 9)
      expect(sp.height).toBeCloseTo(g.sprite.height, 9)
      expect(sp.x).toBeGreaterThanOrEqual(0)
      expect(sp.y).toBeGreaterThanOrEqual(0)
      expect(sp.x + sp.width).toBeLessThanOrEqual(size + 1e-9)
      expect(sp.y + sp.height).toBeCloseTo(g.base!.cy, 9)
    })

    it('成功: 台座・影が描かれる（acrylicBack の bounds が台座の幅に一致）', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const b = internals(s).enemyViews[0].acrylicBack!.getLocalBounds()
      const g = defaultGeometry(slotSize())
      // 最も広い影の楕円がバウンディングを決める
      expect(b.width).toBeCloseTo(g.shadow!.rx * 2, 6)
    })

    it('仕様値: 影は黒 0.4・台座は 0x111111・ハイライトは白 0.3 の順に塗られる（リテラル固定）', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      expect(fillsOf(internals(s).enemyViews[0].acrylicBack!)).toEqual([
        { color: 0x000000, alpha: 0.4 },
        { color: 0x111111, alpha: 1 },
        { color: 0xffffff, alpha: 0.3 },
      ])
    })

    it('spriteStyleParams の shadowAlpha / highlightAlpha が影・ハイライトの塗りに別々に反映される', async () => {
      okLoad()
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { shadowAlpha: 0.7, highlightAlpha: 0.6 },
        })
      )
      await flushPromises()
      const fills = fillsOf(internals(s).enemyViews[0].acrylicBack!)
      expect(fills[0].alpha).toBe(0.7)
      expect(fills[2].alpha).toBe(0.6)
    })

    it('失敗: 色四角のまま・acrylicBack 非表示・filter なし・warn 1 回', async () => {
      vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      expect(warn).toHaveBeenCalledTimes(1)
      expect(v.sprite).toBeNull()
      expect(v.fallback.visible).toBe(true)
      expect(v.acrylicBack!.visible).toBe(false)
      expect(v.acrylicPlate).toBeNull()
    })

    it('味方側のスプライトにも適用される', async () => {
      okLoad()
      const s = track(make([withSprite('hero')], [entity('slime')], acrylic))
      await flushPromises()
      const v = internals(s).partyViews[0]
      expect(v.acrylicPlate).not.toBeNull()
      expect(v.acrylicBack!.visible).toBe(true)
      expect(v.container.children).toHaveLength(5) // 味方にラベルはない: fallback → back → 板 → mask → sprite
      expect(v.container.children[4]).toBe(v.sprite)
    })

    it('複数体（敵 3・味方 2）: 各 view が独立の板を持つ（共有しない）', async () => {
      okLoad()
      const s = track(
        make(
          [withSprite('p0'), withSprite('p1')],
          [withSprite('e0'), withSprite('e1'), withSprite('e2')],
          acrylic
        )
      )
      await flushPromises()
      const views = [...internals(s).enemyViews, ...internals(s).partyViews]
      expect(views).toHaveLength(5)
      const plates = views.map((v) => v.acrylicPlate)
      for (const f of plates) expect(f).not.toBeNull()
      expect(new Set(plates).size).toBe(5)
    })

    it('成功経路で console.error / warn が呼ばれない', async () => {
      okLoad()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      track(make([withSprite('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    })
  })

  describe('acrylic: front は影響しない', () => {
    it('front + acrylic + sprite 指定は none の front と同一（子数・position・alpha）で Assets.load も呼ばれない', async () => {
      const load = vi.spyOn(Assets, 'load')
      const a = track(
        make([withSprite('hero')], [withSprite('slime')], { layout: 'front', spriteStyle: 'none' })
      )
      const b = track(
        make([withSprite('hero')], [withSprite('slime')], {
          layout: 'front',
          spriteStyle: 'acrylic',
        })
      )
      await flushPromises()
      expect(load).not.toHaveBeenCalled()
      const ca = internals(a).children
      const cb = internals(b).children
      expect(cb).toHaveLength(ca.length)
      cb.forEach((c, k) => {
        expect(c.position.x).toBe(ca[k].position.x)
        expect(c.position.y).toBe(ca[k].position.y)
        expect(c.alpha).toBe(ca[k].alpha)
      })
      expect(internals(b).enemyViews).toHaveLength(0)
    })
  })

  describe('acrylic: redraw / パラメータ', () => {
    it('redraw を複数回呼んでも板インスタンスは同一で、sprite に追従して再配置される (#760)', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const plate = v.acrylicPlate!
      for (const [w, h] of [
        [400, 700],
        [800, 450],
        [400, 700],
      ]) {
        s.redraw(w, h)
        expect(v.acrylicPlate).toBe(plate)
        const k = v.sprite!.width / TEX_W
        expect(plate.scale.x).toBeCloseTo(k, 9)
        expect(plate.x).toBeCloseTo(v.sprite!.x - PLATE_PAD * k, 9)
      }
    })

    it('redraw で size が 0 になると板は非表示・通常に戻すと再表示される', async () => {
      okLoad()
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const plate = v.acrylicPlate!
      s.redraw(0, 0)
      expect(slotSize(0, 0)).toBeLessThanOrEqual(0)
      expect(plate.visible).toBe(false)
      s.redraw(800, 450)
      expect(plate.visible).toBe(true)
    })

    it('spriteStyleParams.lineAlpha=0 → 板は非表示・0.01 → 表示', async () => {
      okLoad()
      const off = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { lineAlpha: 0 },
        })
      )
      const on = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { lineAlpha: 0.01 },
        })
      )
      await flushPromises()
      expect(internals(off).enemyViews[0].acrylicPlate!.visible).toBe(false)
      expect(internals(on).enemyViews[0].acrylicPlate!.visible).toBe(true)
    })

    it('hasBase=false → 台座・影は描かれず、足元は枠の下端から余白+線ぶん上', async () => {
      okLoad()
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { hasBase: false },
        })
      )
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const b = v.acrylicBack!.getLocalBounds()
      expect(b.width).toBe(0)
      expect(b.height).toBe(0)
      const size = slotSize()
      const g = computeAcrylicGeometry(TEX_W, TEX_H, size, resolveAcrylicParams({ hasBase: false }))
      expect(v.sprite!.y + v.sprite!.height).toBeCloseTo(size - g.marginPx - g.linePx, 9)
    })

    it('spriteStyleParams の clamp がコンストラクタで効く（marginRatio:9 は 0.15 として配置される）', async () => {
      okLoad()
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { marginRatio: 9 },
        })
      )
      await flushPromises()
      const sp = internals(s).enemyViews[0].sprite!
      const g = computeAcrylicGeometry(
        TEX_W,
        TEX_H,
        slotSize(),
        resolveAcrylicParams({ marginRatio: 0.15 })
      )
      expect(sp.x).toBeCloseTo(g.sprite.x, 9)
      expect(sp.width).toBeCloseTo(g.sprite.width, 9)
      expect(sp.width).toBeGreaterThan(0)
    })
  })

  describe('acrylic: destroy', () => {
    it('保留中の destroy は例外なし', () => {
      vi.spyOn(Assets, 'load').mockReturnValue(new Promise<Texture>(() => {}) as never)
      const s = make([entity('hero')], [withSprite('slime')], acrylic)
      expect(() => s.destroy({ children: true })).not.toThrow()
    })

    it('destroy 後に resolve しても例外なし・filter も sprite も作られず unhandled rejection も出ない', async () => {
      const resolvers: Array<(t: Texture) => void> = []
      vi.spyOn(Assets, 'load').mockImplementation(
        (() => new Promise<Texture>((r) => resolvers.push(r))) as never
      )
      const onRejection = vi.fn()
      const proc = (globalThis as unknown as { process: NodeEmitter }).process
      proc.on('unhandledRejection', onRejection)
      try {
        const s = make([withSprite('hero')], [withSprite('slime')], acrylic)
        const views = [...internals(s).enemyViews, ...internals(s).partyViews]
        s.destroy({ children: true })
        for (const r of resolvers) r(sizedTexture(TEX_W, TEX_H))
        await flushPromises()
        for (const v of views) {
          expect(v.sprite).toBeNull()
          expect(v.acrylicPlate).toBeNull()
        }
        expect(onRejection).not.toHaveBeenCalled()
      } finally {
        proc.off('unhandledRejection', onRejection)
      }
    })

    it('成功後の destroy で板・影のテクスチャが TextureSource ごと破棄され、view の参照は null になる (#760)', async () => {
      okLoad()
      const plateTex = sizedTexture(TEX_W + 16, TEX_H + 16)
      const shadowTex = sizedTexture(TEX_W + 16, TEX_H + 16)
      vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate').mockImplementation((() => ({
        texture: plateTex,
        pad: 8,
        shadow: shadowTex,
        foot: { x: 8, y: 8 },
      })) as never)
      const s = make([entity('hero')], [withSprite('slime')], acrylic)
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const plateSrc = plateTex.source
      const shadowSrc = shadowTex.source
      expect(plateSrc.destroyed).toBe(false)
      expect(shadowSrc.destroyed).toBe(false)
      s.destroy({ children: true })
      // TextureSource（GPU・canvas）ごと解放される
      expect(plateSrc.destroyed).toBe(true)
      expect(shadowSrc.destroyed).toBe(true)
      expect(v.acrylicPlate).toBeNull()
      expect(v.acrylicShadow).toBeNull()
    })

    it('同じ画像の敵が複数いても板・影は 1 組だけ作って共有し、destroy で 1 回だけ解放する (#760)', async () => {
      okLoad()
      const make1 = vi
        .spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate')
        .mockImplementation((() => ({
          texture: sizedTexture(TEX_W + 16, TEX_H + 16),
          pad: 8,
        })) as never)
      const s = make(
        [entity('hero')],
        [withSprite('slime'), withSprite('slime'), withSprite('slime')],
        acrylic
      )
      await flushPromises()
      expect(make1).toHaveBeenCalledTimes(1)
      const views = internals(s).enemyViews
      expect(new Set(views.map((v) => v.acrylicPlate!.texture)).size).toBe(1)
      expect(new Set(views.map((v) => v.acrylicPlate)).size).toBe(3)
      const src = views[0].acrylicPlate!.texture.source
      s.destroy({ children: true })
      expect(src.destroyed).toBe(true)
    })

    it('destroy は Assets のスプライトのテクスチャを壊さない (#760)', async () => {
      const t = sizedTexture(TEX_W, TEX_H)
      const src = t.source
      vi.spyOn(Assets, 'load').mockResolvedValue(t as never)
      const s = make([entity('hero')], [withSprite('slime')], acrylic)
      await flushPromises()
      s.destroy({ children: true })
      expect(src.destroyed).toBe(false)
    })
  })
})

describe('BattleScreen: windowStyle (#744)', () => {
  /** 実体は dark = Graphics、ff-blue = 子 [帯, mask, 枠] を持つ Container。dark の描画命令を読む側は instanceof で Graphics に絞る */
  interface PanelInternals {
    statsPanel: Graphics | Container
    commandPanel: Graphics | Container
    logPanel: Graphics | Container
    commands: Array<{ text: Text }>
  }
  interface PanelOp {
    action: string
    color: number
    alpha: number
    width: number | undefined
    shape: { type: string; x: number; y: number; width: number; height: number }
  }
  const pi = (s: BattleScreen): PanelInternals => s as unknown as PanelInternals

  /** Graphics に積まれた fill / stroke 命令を、形状つきで描画順に取り出す */
  const opsOf = (g: Graphics): PanelOp[] =>
    (
      g.context.instructions as unknown as Array<{
        action: string
        data: {
          style: { color: number; alpha: number; width?: number }
          path: { shapePath: { shapePrimitives: Array<{ shape: PanelOp['shape'] }> } }
        }
      }>
    ).map((ins) => ({
      action: ins.action,
      color: ins.data.style.color,
      alpha: ins.data.style.alpha,
      width: ins.data.style.width,
      shape: ins.data.path.shapePath.shapePrimitives[0].shape,
    }))
  const fillOps = (g: Graphics): PanelOp[] => opsOf(g).filter((o) => o.action === 'fill')
  const strokeOps = (g: Graphics): PanelOp[] => opsOf(g).filter((o) => o.action === 'stroke')
  /** ff-blue パネルの子（帯 / mask / 枠）。drawPanel が g の子として [帯, mask, 枠] の順に持つ */
  const bandsOf = (g: Container): Graphics => g.children[0] as Graphics
  const maskOf = (g: Container): Graphics => g.children[1] as Graphics
  const frameOf = (g: Container): Graphics => g.children[2] as Graphics
  const rawPanelsOf = (s: BattleScreen): Array<Graphics | Container> => [
    pi(s).statsPanel,
    pi(s).commandPanel,
    pi(s).logPanel,
  ]
  /** dark 用: 全パネルが Graphics であることを実行時に確かめて絞り込む */
  const panelsOf = (s: BattleScreen): Graphics[] =>
    rawPanelsOf(s).map((g) => {
      if (!(g instanceof Graphics)) throw new Error('panel is not a Graphics')
      return g
    })

  /** 子孫を含む全 PixiText */
  function allTexts(root: Container): PixiText[] {
    const out: PixiText[] = []
    const walk = (c: Container): void => {
      if (c instanceof PixiText) out.push(c)
      for (const ch of c.children) walk(ch as Container)
    }
    walk(root)
    return out
  }
  const hasShadow = (t: PixiText): boolean => t.style.dropShadow != null
  const fillColorOf = (t: PixiText): number => {
    const f = t.style.fill as unknown
    return typeof f === 'number' ? f : (f as { color: number }).color
  }

  const FRONT: BattleScreenOptions = {}
  const SIDE: BattleScreenOptions = { layout: 'side' }
  const build = (opts: BattleScreenOptions, w = 800, h = 450): BattleScreen =>
    track(make([entity('hero')], [entity('slime')], opts, w, h))

  describe('dark（既定・回帰）', () => {
    const cases: Array<[string, BattleScreenOptions]> = [
      ['windowStyle 未指定', {}],
      ["'dark'", { windowStyle: 'dark' }],
      ['未知値 xxx', { windowStyle: 'xxx' as never }],
      [
        '大文字 FF-BLUE（厳密比較。正規化は rpgProjectFromDoc の責務）',
        { windowStyle: 'FF-BLUE' as never },
      ],
    ]
    it.each(cases)('%s: 各パネルは roundRect 1 つ・黒 alpha 0.85・白枠 2px', (_name, extra) => {
      const s = build({ ...SIDE, ...extra })
      for (const g of panelsOf(s)) {
        const fills = fillOps(g)
        expect(fills).toHaveLength(1)
        expect(fills[0].shape.type).toBe('roundedRectangle')
        expect(fills[0].color).toBe(0x000000)
        expect(fills[0].alpha).toBe(0.85)
        const strokes = strokeOps(g)
        expect(strokes).toHaveLength(1)
        expect(strokes[0].color).toBe(0xffffff)
        expect(strokes[0].width).toBe(2)
      }
    })

    it('dark の front で敵 HP は緑・主人公ステータスは白になり、共有 TextStyle が汚染されない', () => {
      const HP_COLOR = 0x88ee88
      const TEXT_COLOR = 0xffffff
      const a = build({ windowStyle: 'dark' })
      const ia = internals(a)
      expect(ia.enemyHpText.style.fill).toBe(HP_COLOR)
      expect(ia.heroStatsText.style.fill).toBe(TEXT_COLOR)
      // 2 画面目を作っても、1 画面目の更新が持ち越されない
      const b = build({ windowStyle: 'dark' })
      const ib = internals(b)
      expect(ib.enemyHpText.style.fill).toBe(HP_COLOR)
      expect(ib.heroStatsText.style.fill).toBe(TEXT_COLOR)
      // 敵 HP とステータスは別インスタンス（共有していない）
      expect(ia.enemyHpText.style).not.toBe(ia.heroStatsText.style)
      // 3 画面目でも敵 HP は緑のまま（モジュール定数 TEXT_STYLE_HP が白に書き換わっていない）
      const c = build({ windowStyle: 'dark' })
      expect(internals(c).enemyHpText.style.fill).toBe(HP_COLOR)
    })

    it('front でも roundRect 1 つ（未指定）', () => {
      const s = build(FRONT)
      for (const g of panelsOf(s)) {
        expect(fillOps(g)).toHaveLength(1)
        expect(fillOps(g)[0].shape.type).toBe('roundedRectangle')
      }
    })

    it('windowStyle 未指定と dark 明示は同一の描画命令になる', () => {
      const a = build(SIDE)
      const b = build({ ...SIDE, windowStyle: 'dark' })
      panelsOf(a).forEach((g, i) => {
        expect(opsOf(panelsOf(b)[i])).toEqual(opsOf(g))
      })
    })

    it('全 PixiText に影がない（front）', () => {
      const s = build(FRONT)
      const texts = allTexts(s)
      expect(texts.length).toBeGreaterThan(0)
      expect(texts.some(hasShadow)).toBe(false)
    })

    it('全 PixiText に影がない（side・敵ラベル含む）', () => {
      const s = build(SIDE)
      const texts = allTexts(s)
      expect(texts.length).toBeGreaterThan(0)
      expect(texts.some(hasShadow)).toBe(false)
    })
  })

  describe('ff-blue: パネル', () => {
    const modes: Array<[string, BattleScreenOptions]> = [
      ['front', { windowStyle: 'ff-blue' }],
      ['side', { layout: 'side', windowStyle: 'ff-blue' }],
    ]
    describe.each(modes)('%s', (_mode, opts) => {
      const darkOpts: BattleScreenOptions = { ...opts, windowStyle: 'dark' }

      it('パネルは Graphics ではなく Container（Pixi の Graphics 子持ち非推奨警告の回帰防止）', () => {
        const s = build(opts)
        for (const g of rawPanelsOf(s)) expect(g).not.toBeInstanceOf(Graphics)
      })

      it('帯は rect で、帯数が computeBands と一致する（帯は g の子 Graphics に描く）', () => {
        const dark = build(darkOpts)
        const s = build(opts)
        rawPanelsOf(s).forEach((g, i) => {
          const h = fillOps(panelsOf(dark)[i])[0].shape.height
          const fills = fillOps(bandsOf(g))
          expect(fills.every((f) => f.shape.type === 'rectangle')).toBe(true)
          expect(fills).toHaveLength(computeBands(h).length)
          expect(fills.length).toBeGreaterThan(0)
          expect(fills.length).toBeLessThanOrEqual(FF_BLUE_BAND_COUNT)
        })
      })

      it('帯はパネルを隙間・重なりなく覆い、x と幅が dark のパネルと一致する', () => {
        const dark = build(darkOpts)
        const s = build(opts)
        rawPanelsOf(s).forEach((g, i) => {
          const rect = fillOps(panelsOf(dark)[i])[0].shape
          let y = rect.y
          for (const f of fillOps(bandsOf(g))) {
            expect(f.shape.x).toBe(rect.x)
            expect(f.shape.width).toBe(rect.width)
            expect(f.shape.y).toBe(y)
            expect(f.shape.height).toBeGreaterThanOrEqual(1)
            y += f.shape.height
          }
          expect(y).toBe(rect.y + rect.height)
        })
      })

      it('上の帯ほど明るい（輝度が単調に下がる）', () => {
        const s = build(opts)
        const lum = (c: number): number =>
          0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff)
        for (const g of rawPanelsOf(s)) {
          const fills = fillOps(bandsOf(g))
          expect(lum(fills[0].color)).toBeGreaterThan(lum(fills[fills.length - 1].color))
          for (let i = 1; i < fills.length; i++) {
            expect(lum(fills[i].color)).toBeLessThanOrEqual(lum(fills[i - 1].color))
          }
        }
      })

      it('白枠は dark と同じ roundRect（半径 6・色・太さ・位置・寸法）で 1 つだけ', () => {
        const dark = build(darkOpts)
        const s = build(opts)
        rawPanelsOf(s).forEach((g, i) => {
          const strokes = strokeOps(frameOf(g))
          expect(strokes).toHaveLength(1)
          const ds = strokeOps(panelsOf(dark)[i])[0]
          expect(strokes[0].shape.type).toBe('roundedRectangle')
          expect((strokes[0].shape as unknown as { radius: number }).radius).toBe(6)
          expect(strokes[0].width).toBe(2)
          expect(strokes[0].color).toBe(0xffffff)
          expect(strokes[0].color).toBe(ds.color)
          expect(strokes[0].width).toBe(ds.width)
          expect(strokes[0].shape.x).toBe(ds.shape.x)
          expect(strokes[0].shape.y).toBe(ds.shape.y)
          expect(strokes[0].shape.width).toBe(ds.shape.width)
          expect(strokes[0].shape.height).toBe(ds.shape.height)
        })
      })

      it('画面寸法・テキスト座標・子の数が dark と同一', () => {
        const dark = build(darkOpts)
        const s = build(opts)
        expect(s.children.length).toBe(dark.children.length)
        const a = allTexts(dark)
        const b = allTexts(s)
        expect(b).toHaveLength(a.length)
        b.forEach((t, i) => {
          expect(t.x).toBe(a[i].x)
          expect(t.y).toBe(a[i].y)
          expect(t.text).toBe(a[i].text)
        })
        rawPanelsOf(s).forEach((g, i) => {
          const gb = frameOf(g).getLocalBounds()
          const db = panelsOf(dark)[i].getLocalBounds()
          expect(gb.x).toBe(db.x)
          expect(gb.y).toBe(db.y)
          expect(gb.width).toBe(db.width)
          expect(gb.height).toBe(db.height)
        })
      })

      it('帯は mask 付きで、mask はパネル矩形と同じ roundRect（半径 6）。mask は帯を隙間なく覆う', () => {
        const dark = build(darkOpts)
        const s = build(opts)
        rawPanelsOf(s).forEach((g, i) => {
          const rect = fillOps(panelsOf(dark)[i])[0].shape
          const masks = fillOps(maskOf(g))
          expect(masks).toHaveLength(1)
          expect(masks[0].shape.type).toBe('roundedRectangle')
          expect((masks[0].shape as unknown as { radius: number }).radius).toBe(6)
          expect(masks[0].shape.x).toBe(rect.x)
          expect(masks[0].shape.y).toBe(rect.y)
          expect(masks[0].shape.width).toBe(rect.width)
          expect(masks[0].shape.height).toBe(rect.height)
          expect(bandsOf(g).mask).toBe(maskOf(g))
          // 帯（上端〜下端）が mask の矩形全体を覆っている
          const fills = fillOps(bandsOf(g))
          expect(fills[0].shape.y).toBe(rect.y)
          const last = fills[fills.length - 1]
          expect(last.shape.y + last.shape.height).toBe(rect.y + rect.height)
        })
      })

      it('redraw を繰り返しても帯・mask・枠・子の数が積み増されない', () => {
        const s = build(opts)
        const snap = (): number[][] =>
          rawPanelsOf(s).map((g) => [
            g.children.length,
            opsOf(bandsOf(g)).length,
            opsOf(maskOf(g)).length,
            opsOf(frameOf(g)).length,
          ])
        const before = snap()
        const bandsRefs = rawPanelsOf(s).map((g) => bandsOf(g))
        s.redraw(800, 450)
        s.redraw(800, 450)
        s.redraw(800, 450)
        expect(snap()).toEqual(before)
        expect(before.every((r) => r[0] === 3)).toBe(true)
        // 子 Graphics は使い回される
        expect(rawPanelsOf(s).map((g) => bandsOf(g))).toEqual(bandsRefs)
      })

      it('redraw で画面サイズが変わっても帯は新しい高さで描き直される', () => {
        const s = build(opts)
        s.redraw(1000, 600)
        const dark = build(darkOpts, 1000, 600)
        rawPanelsOf(s).forEach((g, i) => {
          const rect = fillOps(panelsOf(dark)[i])[0].shape
          const fills = fillOps(bandsOf(g))
          expect(fills).toHaveLength(computeBands(rect.height).length)
          const last = fills[fills.length - 1]
          expect(last.shape.y + last.shape.height).toBe(rect.y + rect.height)
          expect(fills[0].shape.y).toBe(rect.y)
        })
      })
    })
  })

  describe('テキスト影', () => {
    it('ff-blue（front）: 敵名・HP・ヒーロー・コマンド・ログに影がある', () => {
      const s = build({ windowStyle: 'ff-blue' })
      const i = internals(s)
      expect(hasShadow(i.enemyNameText as unknown as PixiText)).toBe(true)
      expect(hasShadow(i.enemyHpText as unknown as PixiText)).toBe(true)
      expect(hasShadow(i.heroStatsText as unknown as PixiText)).toBe(true)
      expect(pi(s).commands.length).toBeGreaterThan(0)
      for (const c of pi(s).commands) expect(hasShadow(c.text as unknown as PixiText)).toBe(true)
      expect(i.logLines.length).toBeGreaterThan(0)
      for (const t of i.logLines) expect(hasShadow(t as unknown as PixiText)).toBe(true)
    })

    it('ff-blue（side）: サイドステータス・敵ラベル・コマンド・ログに影がある', () => {
      const s = build({ layout: 'side', windowStyle: 'ff-blue' })
      const i = internals(s)
      expect(i.statusTexts.length).toBeGreaterThan(0)
      for (const t of i.statusTexts) expect(hasShadow(t as unknown as PixiText)).toBe(true)
      expect(i.enemyViews[0].label).not.toBeNull()
      expect(hasShadow(i.enemyViews[0].label as unknown as PixiText)).toBe(true)
      for (const c of pi(s).commands) expect(hasShadow(c.text as unknown as PixiText)).toBe(true)
      for (const t of i.logLines) expect(hasShadow(t as unknown as PixiText)).toBe(true)
      expect(allTexts(s).every(hasShadow)).toBe(true)
    })

    it('影の内容は FF_BLUE_TEXT_SHADOW に従う', () => {
      const s = build({ windowStyle: 'ff-blue' })
      const sh = internals(s).enemyNameText.style.dropShadow as unknown as Record<string, number>
      expect(sh).toMatchObject({
        color: FF_BLUE_TEXT_SHADOW.color,
        alpha: FF_BLUE_TEXT_SHADOW.alpha,
        distance: FF_BLUE_TEXT_SHADOW.distance,
      })
    })

    it('文字色は ff-blue でも dark と同一で、名前・コマンド・ログは白のまま', () => {
      for (const layout of ['front', 'side'] as const) {
        const dark = allTexts(build({ layout }))
        const blue = build({ layout, windowStyle: 'ff-blue' })
        expect(allTexts(blue).map(fillColorOf)).toEqual(dark.map(fillColorOf))
        for (const c of pi(blue).commands)
          expect(fillColorOf(c.text as unknown as PixiText)).toBe(0xffffff)
        for (const t of internals(blue).logLines)
          expect(fillColorOf(t as unknown as PixiText)).toBe(0xffffff)
      }
    })

    it('ff-blue → dark の順に 2 画面を作っても共有スタイルが汚染されない', () => {
      build({ windowStyle: 'ff-blue' })
      build({ layout: 'side', windowStyle: 'ff-blue' })
      const dark = build({ windowStyle: 'dark' })
      const darkSide = build({ layout: 'side' })
      expect(allTexts(dark).some(hasShadow)).toBe(false)
      expect(allTexts(darkSide).some(hasShadow)).toBe(false)
    })

    it('dark → ff-blue の順でも dark 側に影が付かない', () => {
      const dark = build({})
      const blue = build({ windowStyle: 'ff-blue' })
      expect(allTexts(blue).every(hasShadow)).toBe(true)
      expect(allTexts(dark).some(hasShadow)).toBe(false)
    })

    it('影オブジェクトは Text 間・定数と共有されない', () => {
      const s = build({ layout: 'side', windowStyle: 'ff-blue' })
      const shadows = allTexts(s).map((t) => t.style.dropShadow)
      expect(shadows.length).toBeGreaterThan(1)
      expect(new Set(shadows).size).toBe(shadows.length)
      for (const sh of shadows) expect(sh).not.toBe(FF_BLUE_TEXT_SHADOW)
    })

    it('ff-blue 画面の destroy 後も別の ff-blue 画面の影が残る', () => {
      const a = build({ windowStyle: 'ff-blue' })
      const b = build({ windowStyle: 'ff-blue' })
      a.destroy({ children: true })
      expect(allTexts(b).every(hasShadow)).toBe(true)
    })
  })

  describe('acrylic との組み合わせ', () => {
    const withSprite = (id: string): BattleEntity => entity(id, { sprite: `img/${id}.webp` })
    const combos: Array<['none' | 'acrylic', 'dark' | 'ff-blue']> = [
      ['none', 'dark'],
      ['none', 'ff-blue'],
      ['acrylic', 'dark'],
      ['acrylic', 'ff-blue'],
    ]
    it.each(combos)('spriteStyle=%s × windowStyle=%s は独立に効く', (sprite, win) => {
      vi.spyOn(Assets, 'load').mockReturnValue(new Promise(() => {}) as never)
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          layout: 'side',
          spriteStyle: sprite,
          windowStyle: win,
        })
      )
      const v = internals(s).enemyViews[0]
      expect(v.acrylicBack !== null).toBe(sprite === 'acrylic')
      const fills = fillOps(
        win === 'ff-blue' ? bandsOf(pi(s).logPanel as Container) : (pi(s).logPanel as Graphics)
      )
      if (win === 'ff-blue') {
        expect(fills.every((f) => f.shape.type === 'rectangle')).toBe(true)
        expect(allTexts(s).every(hasShadow)).toBe(true)
      } else {
        expect(fills).toHaveLength(1)
        expect(fills[0].shape.type).toBe('roundedRectangle')
        expect(allTexts(s).some(hasShadow)).toBe(false)
      }
    })
  })
})

describe('BattleScreen: 背景トーン調整 (#753)', () => {
  // jsdom は canvas 不可で createDofMaskTexture が常に null → 段が作られないので、成功する形に差し替える
  beforeEach(() => {
    vi.spyOn(BattleScreen.prototype as never, 'createDofMaskTexture').mockImplementation(
      (() => new Texture()) as never
    )
  })

  interface ToneLevel {
    sprite: Container
    mask: Sprite
    blur: BlurFilter
    maskTexture: { destroy: (...a: unknown[]) => void } | null
    maskRamp: number
  }
  interface ToneInternals {
    backgroundToneFilter: ColorMatrixFilter | null
    dofLevels: ToneLevel[]
  }
  const ti = (s: BattleScreen): ToneInternals => s as unknown as ToneInternals
  const filtersOf = (o: { filters?: unknown } | null | undefined): unknown[] =>
    ((o?.filters as unknown[] | null | undefined) ?? []) as unknown[]
  const bgOf = (s: BattleScreen): Sprite => internals(s).backgroundSprite!

  async function loaded(opts: BattleScreenOptions, w = 800, h = 450): Promise<BattleScreen> {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const s = track(
      make([entity('hero')], [entity('slime')], { background: 'bg/a.webp', ...opts }, w, h)
    )
    await flushPromises()
    return s
  }

  /** 木全体を辿る */
  function descendants(c: Container): Container[] {
    const out: Container[] = []
    for (const ch of c.children as Container[]) {
      out.push(ch, ...descendants(ch))
    }
    return out
  }

  it('背景あり・tone 既定で背景 sprite の filters はちょうど 1 個の ColorMatrixFilter', async () => {
    const s = await loaded({})
    const f = filtersOf(bgOf(s))
    expect(f).toHaveLength(1)
    expect(f[0]).toBeInstanceOf(ColorMatrixFilter)
    expect(f[0]).toBe(ti(s).backgroundToneFilter)
  })

  it("backgroundTone:'off' なら背景 sprite の filters は空で toneFilter も作らない", async () => {
    const s = await loaded({ backgroundTone: 'off' })
    expect(filtersOf(bgOf(s))).toHaveLength(0)
    expect(ti(s).backgroundToneFilter).toBeNull()
  })

  it('背景なしなら tone on でもフィルタは作らない・例外なし', async () => {
    const load = vi.spyOn(Assets, 'load')
    const s = track(make([entity('hero')], [entity('slime')], { backgroundTone: 'on' }))
    await flushPromises()
    expect(load).not.toHaveBeenCalled()
    expect(internals(s).backgroundSprite).toBeNull()
    expect(ti(s).backgroundToneFilter).toBeNull()
    expect(() => s.destroy({ children: true })).not.toThrow()
  })

  it('背景ロード失敗ではフィルタも段も作らず、warn で握り、destroy も落ちない', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = track(
      make([entity('hero')], [entity('slime')], {
        background: 'bg/missing.webp',
        backgroundTone: 'on',
        backgroundDof: 'on',
      })
    )
    await flushPromises()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(ti(s).backgroundToneFilter).toBeNull()
    expect(ti(s).dofLevels).toHaveLength(0)
    expect(() => s.destroy({ children: true })).not.toThrow()
  })

  it.each(['front', 'side'] as const)(
    'tone は背景 sprite とぼかしコピー以外のどの子孫にも掛からない（%s）',
    async (layout) => {
      const s = await loaded({ layout, backgroundDof: 'on' })
      const tf = ti(s).backgroundToneFilter
      const dofSprites = ti(s).dofLevels.map((l) => l.sprite)
      const blurs = ti(s).dofLevels.map((l) => l.blur)
      const others = descendants(s).filter((c) => c !== bgOf(s) && !dofSprites.includes(c))
      expect(others.length).toBeGreaterThan(0)
      for (const c of others) {
        const f = filtersOf(c)
        expect(f).not.toContain(tf)
        for (const b of blurs) expect(f).not.toContain(b)
        expect(f.some((x) => x instanceof ColorMatrixFilter)).toBe(false)
      }
    }
  )

  it.each([
    { tone: 'on', dof: 'on' },
    { tone: 'on', dof: 'off' },
    { tone: 'off', dof: 'on' },
    { tone: 'off', dof: 'off' },
  ] as const)('tone=$tone × dof=$dof のフィルタ構成', async ({ tone, dof }) => {
    const s = await loaded({ backgroundTone: tone, backgroundDof: dof })
    const lv = ti(s).dofLevels
    expect(internals(s).children[0]).toBe(bgOf(s))
    expect(filtersOf(bgOf(s))).toHaveLength(tone === 'on' ? 1 : 0)
    expect(lv).toHaveLength(dof === 'on' ? DOF_LEVEL_COUNT : 0)
    const tf = ti(s).backgroundToneFilter
    for (const l of lv) {
      expect(filtersOf(l.sprite)).toEqual(tone === 'on' ? [tf, l.blur] : [l.blur])
    }
  })

  it('tone on かつ dof on では各コピーが背景と同じ tone フィルタ インスタンスを共有し、tone は 1 個だけ', async () => {
    const s = await loaded({ backgroundDof: 'on' })
    const tf = filtersOf(bgOf(s))[0]
    expect(tf).toBeInstanceOf(ColorMatrixFilter)
    const all = [bgOf(s), ...ti(s).dofLevels.map((l) => l.sprite)]
    const toneInstances = new Set<unknown>()
    for (const c of all) {
      const f = filtersOf(c)
      expect(f[0]).toBe(tf)
      f.filter((x) => x instanceof ColorMatrixFilter).forEach((x) => toneInstances.add(x))
    }
    expect(toneInstances.size).toBe(1)
  })

  it('blur は背景 sprite・キャラ・パネル・Text のいずれの filters にも入らない', async () => {
    const s = await loaded({ layout: 'side', backgroundDof: 'on' })
    const copies = ti(s).dofLevels.map((l) => l.sprite)
    expect(filtersOf(bgOf(s)).some((x) => x instanceof BlurFilter)).toBe(false)
    for (const c of descendants(s)) {
      if (copies.includes(c)) continue
      expect(filtersOf(c).some((x) => x instanceof BlurFilter)).toBe(false)
    }
  })

  it('tone on + dof on の destroy は例外なく、tone/blur を破棄し、共有のマスクテクスチャは壊さない (#745)', async () => {
    vi.spyOn(BattleScreen.prototype as never, 'createDofMaskTexture').mockImplementation((() => {
      const t = new Texture()
      vi.spyOn(t, 'destroy').mockImplementation(() => {})
      return t
    }) as never)
    const s = await loaded({ backgroundDof: 'on' })
    const tfSpy = vi.spyOn(ti(s).backgroundToneFilter!, 'destroy')
    const lv = [...ti(s).dofLevels]
    const blurSpies = lv.map((l) => vi.spyOn(l.blur, 'destroy'))
    const texs = lv.map((l) => l.maskTexture!)
    expect(texs.every((t) => t !== null)).toBe(true)
    const texSpies = texs.map((t) => vi.spyOn(t, 'destroy'))
    expect(() => s.destroy({ children: true })).not.toThrow()
    expect(tfSpy).toHaveBeenCalledTimes(1)
    blurSpies.forEach((sp) => expect(sp).toHaveBeenCalledTimes(1))
    // マスクの source を壊すと、Pixi のプールにあるマスクフィルタの束縛が壊れて次の画面の描画が落ちる
    texSpies.forEach((sp) => expect(sp).not.toHaveBeenCalled())
    expect(ti(s).dofLevels).toHaveLength(0)
    expect(ti(s).backgroundToneFilter).toBeNull()
  })

  it('destroy を 2 回呼んでも落ちない（tone + dof）', async () => {
    const s = await loaded({ backgroundDof: 'on' })
    s.destroy({ children: true })
    expect(() => s.destroy({ children: true })).not.toThrow()
  })

  it('dof off + tone on の destroy は tone を 1 回だけ破棄して落ちない', async () => {
    const s = await loaded({})
    const sp = vi.spyOn(ti(s).backgroundToneFilter!, 'destroy')
    expect(() => s.destroy({ children: true })).not.toThrow()
    expect(sp).toHaveBeenCalledTimes(1)
  })

  it('dof on + tone off の destroy は toneFilter が null でも落ちず、blur を破棄する', async () => {
    const s = await loaded({ backgroundTone: 'off', backgroundDof: 'on' })
    const lv = [...ti(s).dofLevels]
    lv.forEach((l) => expect(filtersOf(l.sprite)).toEqual([l.blur]))
    const spies = lv.map((l) => vi.spyOn(l.blur, 'destroy'))
    expect(() => s.destroy({ children: true })).not.toThrow()
    spies.forEach((sp) => expect(sp).toHaveBeenCalledTimes(1))
  })

  it('redraw（サイズ変更含む）を繰り返しても toneFilter は同一インスタンスで filters は増えない', async () => {
    const s = await loaded({ backgroundDof: 'on' })
    const tf = ti(s).backgroundToneFilter
    for (const [w, h] of [
      [300, 200],
      [400, 700],
      [800, 450],
      [320, 240],
    ]) {
      s.redraw(w, h)
      expect(ti(s).backgroundToneFilter).toBe(tf)
      expect(filtersOf(bgOf(s))).toEqual([tf])
      ti(s).dofLevels.forEach((l) => expect(filtersOf(l.sprite)).toEqual([tf, l.blur]))
    }
  })

  it('マスクテクスチャは rampFraction が変わるときだけ再生成する', async () => {
    const create = vi
      .spyOn(BattleScreen.prototype as never, 'createDofMaskTexture')
      .mockImplementation((() => new Texture()) as never)
    const s = await loaded({ backgroundDof: 'on' })
    const initial = create.mock.calls.length
    expect(initial).toBe(DOF_LEVEL_COUNT)
    const before = ti(s).dofLevels.map((l) => l.maskTexture)
    s.redraw(300, 200)
    s.redraw(640, 960)
    expect(create.mock.calls.length).toBe(initial)
    expect(ti(s).dofLevels.map((l) => l.maskTexture)).toEqual(before)
    // 記録済みの rampFraction とずれた段だけ、次の layout で作り直す
    ti(s).dofLevels[0].maskRamp = -1
    s.redraw(640, 960)
    expect(create.mock.calls.length).toBe(initial + 1)
  })

  it('リサイズでぼかしコピーの position は背景と一致し、geometry は新しい背景サイズに追従する', async () => {
    const s = await loaded({ backgroundDof: 'on' })
    for (const [w, h] of [
      [300, 600],
      [900, 300],
    ]) {
      s.redraw(w, h)
      const bg = bgOf(s)
      for (const l of ti(s).dofLevels) {
        expect(l.sprite.position.x).toBe(bg.position.x)
        expect(l.sprite.position.y).toBe(bg.position.y)
        const p = (l.sprite as unknown as { geometry: { positions: Float32Array } }).geometry
          .positions
        const xs = [0, 2, 4, 6].map((n) => p[n])
        const ys = [1, 3, 5, 7].map((n) => p[n])
        expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(bg.width + 2 * DOF_EDGE_EXTEND, 3)
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(bg.height + 2 * DOF_EDGE_EXTEND, 3)
      }
    }
  })

  it('各段の mask.y は computeDofLevels の startY と一致し、段が進むほど増える', async () => {
    const s = await loaded({ backgroundDof: 'on' }, 800, 450)
    const lv = ti(s).dofLevels
    const gs = computeDofLevels(450, DOF_DEFAULT_PARAMS, lv.length)
    lv.forEach((l, i) => expect(l.mask.y).toBeCloseTo(gs[i].startY))
    for (let i = 1; i < lv.length; i++) expect(lv[i].mask.y).toBeGreaterThan(lv[i - 1].mask.y)
  })

  it("ctor の正規化: backgroundTone は 'off' 厳密一致だけ off、backgroundDof は 'on' 厳密一致だけ on", async () => {
    for (const t of ['OFF', 'foo', undefined, 'on']) {
      const s = await loaded({ backgroundTone: t as never })
      expect(filtersOf(bgOf(s))).toHaveLength(1)
    }
    for (const d of ['ON', 'foo', undefined, 'off']) {
      const s = await loaded({ backgroundDof: d as never })
      expect(ti(s).dofLevels).toHaveLength(0)
    }
  })

  it('背景ロード完了前に destroy したら、後からフィルタ・コピー・マスクは作られない', async () => {
    let resolve!: (t: Texture) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise<Texture>((r) => {
        resolve = r
      }) as never
    )
    const s = make([entity('hero')], [entity('slime')], {
      background: 'bg/a.webp',
      backgroundTone: 'on',
      backgroundDof: 'on',
    })
    s.destroy({ children: true })
    resolve(mockTexture())
    await flushPromises()
    expect(ti(s).backgroundToneFilter).toBeNull()
    expect(ti(s).dofLevels).toHaveLength(0)
    expect(internals(s).backgroundSprite).toBeNull()
  })

  it('front/side の両レイアウトで tone × dof のフィルタ構成は同じ', async () => {
    const summarize = async (layout: 'front' | 'side') => {
      const s = await loaded({ layout, backgroundDof: 'on' })
      const names = (o: Container) => filtersOf(o).map((f) => (f as object).constructor.name)
      return {
        bg: names(bgOf(s)),
        levels: ti(s).dofLevels.length,
        copies: ti(s).dofLevels.map((l) => names(l.sprite)),
        first: internals(s).children[0] === bgOf(s),
      }
    }
    expect(await summarize('side')).toEqual(await summarize('front'))
  })
})

describe('BattleScreen: テクスチャフィルタ (#760)', () => {
  type MipSource = { scaleMode: string; autoGenerateMipmaps?: boolean }
  const mipTexture = (): Texture =>
    ({ width: 400, height: 800, source: { scaleMode: 'nearest' } }) as unknown as Texture

  it('既定: 背景・前景・味方・敵のテクスチャに mipmap 生成 + linear が設定される', async () => {
    const texs: Texture[] = []
    vi.spyOn(Assets, 'load').mockImplementation((async () => {
      const t = mipTexture()
      texs.push(t)
      return t
    }) as never)
    track(
      make([entity('hero', { sprite: 'h.png' })], [entity('slime', { sprite: 's.png' })], {
        layout: 'side',
        background: 'bg.png',
        foreground: 'fg.png',
      })
    )
    await flushPromises()
    expect(texs).toHaveLength(4)
    for (const t of texs) {
      const src = t.source as unknown as MipSource
      expect(src.autoGenerateMipmaps).toBe(true)
      expect(src.scaleMode).toBe('linear')
    }
  })

  it('pixelArt: true なら nearest のまま・mipmap は作らない', async () => {
    const texs: Texture[] = []
    vi.spyOn(Assets, 'load').mockImplementation((async () => {
      const t = mipTexture()
      texs.push(t)
      return t
    }) as never)
    track(
      make([entity('hero', { sprite: 'h.png' })], [entity('slime', { sprite: 's.png' })], {
        layout: 'side',
        background: 'bg.png',
        foreground: 'fg.png',
        pixelArt: true,
      })
    )
    await flushPromises()
    expect(texs).toHaveLength(4)
    for (const t of texs) {
      const src = t.source as unknown as MipSource
      expect(src.autoGenerateMipmaps).not.toBe(true)
      expect(src.scaleMode).toBe('nearest')
    }
  })
})

// ---------------------------------------------------------------------------
// #760 追加観点（独立テスト担当）。旧 AcrylicEdgeFilter のテストが守っていた性質
// （redraw で追従・destroy で解放・複数体で独立/共有・色/不透明度の反映）を、新方式（板・台座・影）で守る。
// ---------------------------------------------------------------------------
interface Rect {
  x: number
  y: number
  w: number
  h: number
}
const EPS = 1e-9
const inside = (a: Rect, o: Rect): boolean =>
  a.x >= o.x - EPS &&
  a.y >= o.y - EPS &&
  a.x + a.w <= o.x + o.w + EPS &&
  a.y + a.h <= o.y + o.h + EPS
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS

describe('applyBattleTextureFilter (#760)', () => {
  const fakeTex = (scaleMode = 'nearest'): Texture =>
    ({ width: 10, height: 10, source: { scaleMode } }) as unknown as Texture
  type Src = { scaleMode: string; autoGenerateMipmaps?: boolean }
  const srcOf = (t: Texture): Src => t.source as unknown as Src

  it('既定（pixelArt=false）: mipmap 生成 + linear', () => {
    const t = fakeTex()
    applyBattleTextureFilter(t, false)
    expect(srcOf(t).autoGenerateMipmaps).toBe(true)
    expect(srcOf(t).scaleMode).toBe('linear')
  })
  it('pixelArt=true: nearest・mipmap は作らない（linear だったものも nearest へ）', () => {
    const t = fakeTex('linear')
    applyBattleTextureFilter(t, true)
    expect(srcOf(t).scaleMode).toBe('nearest')
    expect(srcOf(t).autoGenerateMipmaps).not.toBe(true)
  })
  it('冪等: 2 回呼んでも同じ', () => {
    const t = fakeTex()
    applyBattleTextureFilter(t, false)
    applyBattleTextureFilter(t, false)
    expect(srcOf(t).autoGenerateMipmaps).toBe(true)
    expect(srcOf(t).scaleMode).toBe('linear')
  })
  it('source が無いテクスチャでも例外を投げない', () => {
    const t = {} as unknown as Texture
    expect(() => applyBattleTextureFilter(t, false)).not.toThrow()
    expect(() => applyBattleTextureFilter(t, true)).not.toThrow()
  })
})

describe('BattleScreen: pixelArt × acrylic のテクスチャフィルタ (#760)', () => {
  type Src = { scaleMode: string; autoGenerateMipmaps?: boolean }
  const mk = (): Texture =>
    ({ width: 100, height: 50, source: { scaleMode: 'linear' } }) as unknown as Texture
  it('pixelArt + acrylic でも、立ち絵・背景のテクスチャは nearest・mipmap なし', async () => {
    const texs: Texture[] = []
    vi.spyOn(Assets, 'load').mockImplementation((async () => {
      const t = mk()
      texs.push(t)
      return t
    }) as never)
    vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate').mockImplementation(
      (() => null) as never
    )
    track(
      make([entity('h', { sprite: 'h.png' })], [entity('s', { sprite: 's.png' })], {
        layout: 'side',
        spriteStyle: 'acrylic',
        background: 'bg.png',
        pixelArt: true,
      })
    )
    await flushPromises()
    expect(texs).toHaveLength(3)
    for (const t of texs) {
      const src = t.source as unknown as Src
      expect(src.scaleMode).toBe('nearest')
      expect(src.autoGenerateMipmaps).not.toBe(true)
    }
  })
  it('pixelArt: false 明示・未指定は同じ（mipmap + linear）', async () => {
    for (const opt of [false, undefined]) {
      const texs: Texture[] = []
      vi.spyOn(Assets, 'load').mockImplementation((async () => {
        const t = { width: 100, height: 50, source: { scaleMode: 'nearest' } } as unknown as Texture
        texs.push(t)
        return t
      }) as never)
      track(
        make([entity('h', { sprite: 'h.png' })], [entity('s', { sprite: 's.png' })], {
          layout: 'side',
          pixelArt: opt,
        })
      )
      await flushPromises()
      expect(texs).toHaveLength(2)
      for (const t of texs) {
        const src = t.source as unknown as Src
        expect(src.scaleMode).toBe('linear')
        expect(src.autoGenerateMipmaps).toBe(true)
      }
      vi.restoreAllMocks()
    }
  })
  it('front レイアウトでは立ち絵を読まない（Assets.load なし）ので pixelArt でも何もしない', () => {
    const load = vi.spyOn(Assets, 'load')
    track(
      make([entity('h', { sprite: 'h.png' })], [entity('s', { sprite: 's.png' })], {
        pixelArt: true,
      })
    )
    expect(load).not.toHaveBeenCalled()
  })
  it('読み込み失敗のテクスチャ（Assets.load が reject）でフィルタ設定は走らず例外も出ない', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('404'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      track(
        make([entity('h', { sprite: 'h.png' })], [entity('s')], { layout: 'side', pixelArt: true })
      )
    ).not.toThrow()
    await flushPromises()
    expect(warn).toHaveBeenCalled()
  })
})

describe('BattleScreen: acrylic 追加観点 (#760)', () => {
  const acrylic: BattleScreenOptions = { layout: 'side', spriteStyle: 'acrylic' }
  const withSprite = (id: string, over: Partial<BattleEntity> = {}): BattleEntity =>
    entity(id, { sprite: `img/${id}.webp`, ...over })
  const sized = (width: number, height: number): Texture =>
    new Texture({ source: new TextureSource({ width, height }) })
  const TEX_W = 100
  const TEX_H = 50
  const PAD = 8
  const BASE_LAYOUT = {
    width: 512,
    height: 160,
    cx: 256,
    cyTop: 70,
    rx: 211,
    ry: 59,
    shadowRx: 254,
    thickness: 10,
  }
  const plateWithShadow = (): unknown => ({
    texture: sized(TEX_W + PAD * 2, TEX_H + PAD * 2),
    pad: PAD,
    shadow: sized(TEX_W + PAD * 2, TEX_H + PAD * 2),
    foot: { x: PAD + TEX_W / 2, y: PAD + TEX_H },
  })
  let baseTex: Texture
  beforeEach(() => {
    vi.spyOn(Assets, 'load').mockImplementation((async () => sized(TEX_W, TEX_H)) as never)
    vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate').mockImplementation(
      plateWithShadow as never
    )
    baseTex = sized(512, 160)
    vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicBase').mockImplementation((() => ({
      texture: baseTex,
      layout: BASE_LAYOUT,
    })) as never)
  })
  const geom = (size: number, over: Parameters<typeof resolveAcrylicParams>[0] = {}) =>
    computeAcrylicGeometry(TEX_W, TEX_H, size, resolveAcrylicParams(over))
  const boxOf = (w: number, h: number, party = 1, enemies = 1): number => {
    const e = computeSideBattleLayout({
      width: w,
      height: h,
      partyCount: party,
      enemyCount: enemies,
      enemyAspects: Array(enemies).fill(TEX_W / TEX_H),
    }).enemies[0]
    return Math.max(e.size, e.width)
  }

  /** ツリー内の全ノード */
  function walk(root: Container, out: Container[] = []): Container[] {
    out.push(root)
    for (const c of root.children) walk(c as Container, out)
    return out
  }

  describe('Pixi v8: Sprite に子を足さない・非推奨警告を出さない', () => {
    it('全ての Sprite は子を持たない（mask・台座・影を子にしない）', async () => {
      const s = track(
        make([withSprite('p0'), withSprite('p1')], [withSprite('e0'), withSprite('e1')], acrylic)
      )
      await flushPromises()
      const nodes = walk(s as unknown as Container)
      const sprites = nodes.filter((n) => n.constructor.name === 'Sprite')
      // 敵 2 + 味方 2 の立ち絵 + 板 + 台座 + 影
      expect(sprites.length).toBeGreaterThanOrEqual(4 * 4)
      for (const sp of sprites) expect(sp.children).toHaveLength(0)
    })

    it('板の mask は板の兄弟（同じ container の子）で、mask の親は Sprite ではない', async () => {
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const mask = v.acrylicPlate!.mask as Graphics
      expect(mask.parent).toBe(v.container)
      expect(mask.parent).not.toBe(v.acrylicPlate)
      expect(v.acrylicPlate!.children).toHaveLength(0)
    })

    it('ライフサイクル全体（読み込み → redraw 複数サイズ → HP 変化 → 破棄）で console.warn / error が出ない', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const s = make([withSprite('p0'), withSprite('p1')], [withSprite('e0')], acrylic)
      await flushPromises()
      for (const [w, h] of [
        [360, 640],
        [320, 568],
        [800, 450],
        [0, 0],
        [800, 450],
      ])
        s.redraw(w, h)
      const st = (s as unknown as { engine: BattleEngine }).engine.getState()
      st.enemies[0].hp = 0
      st.party[0].hp = 0
      ;(s as unknown as { refresh(): void }).refresh()
      s.destroy({ children: true })
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    })
  })

  describe('redraw への追従（板・台座・影・mask）', () => {
    it('redraw で台座の Sprite（共有テクスチャ）の縮尺・位置が新しい枠に追従する', async () => {
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      for (const [w, h] of [
        [400, 700],
        [1280, 720],
        [800, 450],
      ]) {
        s.redraw(w, h)
        const g = geom(boxOf(w, h))
        const k = g.shadow!.rx / BASE_LAYOUT.shadowRx
        expect(v.acrylicBase!.scale.x).toBeCloseTo(k, 9)
        expect(v.acrylicBase!.x).toBeCloseTo(g.base!.cx - BASE_LAYOUT.cx * k, 9)
        expect(v.acrylicBase!.y).toBeCloseTo(g.base!.cy - BASE_LAYOUT.cyTop * k, 9)
      }
    })

    it('redraw で板の mask の下端がスリットの高さに追従する（板の位置・縮尺が変わっても computeSlitY）', async () => {
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      for (const [w, h] of [
        [400, 700],
        [1280, 720],
        [800, 450],
      ]) {
        s.redraw(w, h)
        const g = geom(boxOf(w, h))
        const b = (v.acrylicPlate!.mask as Graphics).getLocalBounds()
        expect(b.maxY).toBeCloseTo(computeSlitY(g.base!.cy, g.base!.ry), 6)
        expect(b.minY).toBeCloseTo(v.acrylicPlate!.y, 6)
        expect(b.minX).toBeCloseTo(v.acrylicPlate!.x, 6)
        expect(b.width).toBeCloseTo(v.acrylicPlate!.texture.width * v.acrylicPlate!.scale.x, 6)
      }
    })

    it('redraw で影の位置・変形が新しい枠に追従し、インスタンスは同一のまま', async () => {
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const shadow = v.acrylicShadow!
      const before = { x: shadow.x, y: shadow.y, sy: shadow.scale.y }
      s.redraw(400, 700)
      expect(v.acrylicShadow).toBe(shadow)
      const k = v.sprite!.width / TEX_W
      const t = computeShadowTransform(resolveAcrylicParams(), k)
      expect(shadow.scale.x).toBeCloseTo(t.scaleX, 9)
      expect(shadow.scale.y).toBeCloseTo(t.scaleY, 9)
      expect(shadow.x).toBeCloseTo(v.container.x + v.sprite!.x + v.sprite!.width / 2, 6)
      expect(shadow.y).toBeCloseTo(v.container.y + v.sprite!.y + v.sprite!.height, 6)
      expect(shadow.x !== before.x || shadow.y !== before.y || shadow.scale.y !== before.sy).toBe(
        true
      )
    })

    it('redraw で size が 0 になると影も非表示・戻すと再表示される', async () => {
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      await flushPromises()
      const shadow = internals(s).enemyViews[0].acrylicShadow!
      s.redraw(0, 0)
      expect(shadow.visible).toBe(false)
      s.redraw(800, 450)
      expect(shadow.visible).toBe(true)
    })
  })

  describe('影の見た目パラメータ・生死の連動', () => {
    it('castAlpha=0 のとき影は非表示（0.01 なら表示）', async () => {
      const off = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { castAlpha: 0 },
        })
      )
      const on = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { castAlpha: 0.01 },
        })
      )
      await flushPromises()
      expect(internals(off).enemyViews[0].acrylicShadow!.visible).toBe(false)
      expect(internals(on).enemyViews[0].acrylicShadow!.visible).toBe(true)
    })

    it('castSquash / castShear の上書きが影の変形に反映される', async () => {
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { castSquash: 0.5, castShear: 0 },
        })
      )
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const k = v.sprite!.width / TEX_W
      expect(v.acrylicShadow!.skew.x).toBeCloseTo(0, 9)
      expect(v.acrylicShadow!.scale.y).toBeCloseTo(k * 0.5, 9)
    })

    it('倒れた敵・味方の影はキャラと同じ半透明（DEAD_ALPHA 0.3）になり、生きていれば 1', async () => {
      const s = track(
        make([withSprite('hero'), withSprite('mage')], [withSprite('slime')], acrylic)
      )
      await flushPromises()
      const i = internals(s)
      expect(i.enemyViews[0].acrylicShadow!.alpha).toBe(1)
      const st = (s as unknown as { engine: BattleEngine }).engine.getState()
      st.enemies[0].hp = 0
      st.party[1].hp = 0
      ;(s as unknown as { refresh(): void }).refresh()
      expect(i.enemyViews[0].container.alpha).toBe(DEAD_ALPHA)
      expect(i.enemyViews[0].acrylicShadow!.alpha).toBe(DEAD_ALPHA)
      expect(i.partyViews[1].acrylicShadow!.alpha).toBe(DEAD_ALPHA)
      expect(i.partyViews[0].acrylicShadow!.alpha).toBe(1)
    })

    it('影の層は全キャラ・板・台座より下: shadowLayer は sideStage より前に並ぶ', async () => {
      const s = track(make([withSprite('p0')], [withSprite('e0')], acrylic))
      await flushPromises()
      const i = internals(s) as unknown as {
        shadowLayer: Container
        sideStage: Container
        dim: Container
      }
      const idx = (c: Container): number => (s as unknown as Container).children.indexOf(c)
      expect(idx(i.shadowLayer)).toBeGreaterThan(idx(i.dim))
      expect(idx(i.shadowLayer)).toBeLessThan(idx(i.sideStage))
      // 影は sideStage の中には入らない
      for (const v of [...internals(s).enemyViews, ...internals(s).partyViews])
        expect(i.sideStage.children).not.toContain(v.acrylicShadow)
    })
  })

  describe('共有する台座・独立する板と影（複数体）', () => {
    it('台座テクスチャは全 view で同一（共有）、Sprite は view ごとに別、板と影は view ごとに別テクスチャ', async () => {
      const s = track(
        make(
          [withSprite('p0'), withSprite('p1')],
          [withSprite('e0'), withSprite('e1'), withSprite('e2')],
          acrylic
        )
      )
      await flushPromises()
      const views = [...internals(s).enemyViews, ...internals(s).partyViews]
      expect(views).toHaveLength(5)
      expect(new Set(views.map((v) => v.acrylicBase)).size).toBe(5)
      for (const v of views) expect(v.acrylicBase!.texture).toBe(baseTex)
      // 画像（パス）が別なら板・影のテクスチャも別（同じ画像の共有は別テストで確認）
      expect(new Set(views.map((v) => v.acrylicPlate!.texture)).size).toBe(5)
      expect(new Set(views.map((v) => v.acrylicShadow!.texture)).size).toBe(5)
      expect(new Set(views.map((v) => v.acrylicShadow)).size).toBe(5)
    })

    it('1 つの画面を破棄しても共有の台座テクスチャは生きており、次の画面でもそのまま使える', async () => {
      const a = make([withSprite('p0')], [withSprite('e0')], acrylic)
      await flushPromises()
      a.destroy({ children: true })
      expect(baseTex.destroyed).toBe(false)
      const b = track(make([withSprite('p0')], [withSprite('e0')], acrylic))
      await flushPromises()
      expect(internals(b).enemyViews[0].acrylicBase!.texture).toBe(baseTex)
      b.destroy({ children: true })
      expect(baseTex.destroyed).toBe(false)
    })

    it('板・影のテクスチャは破棄され、台座のテクスチャだけが残る', async () => {
      const s = make([entity('hero')], [withSprite('slime')], acrylic)
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const plateTex = v.acrylicPlate!.texture
      const shadowTex = v.acrylicShadow!.texture
      const shadowSrc = shadowTex.source
      const plateSrc = plateTex.source
      s.destroy({ children: true })
      expect(plateSrc.destroyed).toBe(true)
      expect(shadowSrc.destroyed).toBe(true)
      expect(plateTex.destroyed).toBe(true)
      expect(shadowTex.destroyed).toBe(true)
      expect(baseTex.destroyed).toBe(false)
    })

    it('destroy を 2 回呼んでも例外なし', async () => {
      const s = make([entity('hero')], [withSprite('slime')], acrylic)
      await flushPromises()
      s.destroy({ children: true })
      expect(() => s.destroy({ children: true })).not.toThrow()
    })
  })

  describe('race: destroy 後の読み込み完了', () => {
    it('destroy 後に resolve しても、板・台座・影は作られない（makeAcrylic* を呼ばない）・影の層に残らない', async () => {
      const resolvers: Array<(t: Texture) => void> = []
      vi.spyOn(Assets, 'load').mockImplementation(
        (() => new Promise<Texture>((r) => resolvers.push(r))) as never
      )
      const plate = vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate')
      const base = vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicBase')
      plate.mockClear()
      base.mockClear()
      const s = make([withSprite('p0')], [withSprite('e0')], acrylic)
      const views = [...internals(s).enemyViews, ...internals(s).partyViews]
      s.destroy({ children: true })
      for (const r of resolvers) r(sized(TEX_W, TEX_H))
      await flushPromises()
      expect(plate).not.toHaveBeenCalled()
      expect(base).not.toHaveBeenCalled()
      for (const v of views) {
        expect(v.acrylicShadow).toBeNull()
        expect(v.acrylicBase).toBeNull()
        expect(v.acrylicPlate).toBeNull()
      }
    })

    it('読み込み前の redraw → 読み込み完了で板・台座・影が現在の画面サイズで揃う', async () => {
      let resolve!: (t: Texture) => void
      vi.spyOn(Assets, 'load').mockImplementation(
        (() => new Promise<Texture>((r) => (resolve = r))) as never
      )
      const s = track(make([entity('hero')], [withSprite('slime')], acrylic))
      s.redraw(360, 640)
      resolve(sized(TEX_W, TEX_H))
      await flushPromises()
      const v = internals(s).enemyViews[0]
      const g = geom(boxOf(360, 640))
      expect(v.sprite!.width).toBeCloseTo(g.sprite.width, 9)
      expect(v.acrylicPlate).not.toBeNull()
      expect(v.acrylicShadow!.visible).toBe(true)
      expect(v.acrylicBase!.visible).toBe(true)
    })
  })

  describe('立ち絵の縦横比の配線 (#760)', () => {
    /** パスごとに別の寸法のテクスチャを返す */
    function loadBy(dims: Record<string, [number, number]>): void {
      vi.spyOn(Assets, 'load').mockImplementation((async (p: string) =>
        sized(...(dims[p] ?? [TEX_W, TEX_H]))) as never)
    }
    it('読み込み前の味方の枠は縦横比 0.5・敵は 1（正方形）', () => {
      loadBy({})
      vi.spyOn(Assets, 'load').mockReturnValue(new Promise<Texture>(() => {}) as never)
      const s = track(make([withSprite('p0')], [withSprite('e0')], { layout: 'side' }))
      const L = computeSideBattleLayout({ width: 800, height: 450, partyCount: 1, enemyCount: 1 })
      expect(L.party[0].width / L.party[0].size).toBeCloseTo(0.5, 9)
      expect(L.enemies[0].width / L.enemies[0].size).toBeCloseTo(1, 9)
      // 画面の色四角（fallback）は枠の幅に合わせた縦長
      const fb = internals(s).partyViews[0].fallback.getLocalBounds()
      expect(fb.width).toBeCloseTo(L.party[0].width * 0.7, 6)
    })
    it('味方の立ち絵（40x100）を読み込むと枠が縦横比 0.4 になり、スプライトは枠いっぱい', async () => {
      loadBy({ 'img/p0.webp': [40, 100] })
      const s = track(make([withSprite('p0')], [entity('e0')], { layout: 'side' }))
      await flushPromises()
      const L = computeSideBattleLayout({
        width: 800,
        height: 450,
        partyCount: 1,
        enemyCount: 1,
        partyAspects: [0.4],
      })
      const sp = internals(s).partyViews[0].sprite!
      expect(sp.height).toBeCloseTo(L.party[0].size, 6)
      expect(sp.width).toBeCloseTo(L.party[0].size * 0.4, 6)
    })
    it('味方の立ち絵が極端に横長（300x100）でも枠は縦横比 1.5 に丸められ、スプライトは枠に収まる', async () => {
      loadBy({ 'img/p0.webp': [300, 100] })
      const s = track(make([withSprite('p0')], [entity('e0')], { layout: 'side' }))
      await flushPromises()
      const L = computeSideBattleLayout({
        width: 800,
        height: 450,
        partyCount: 1,
        enemyCount: 1,
        partyAspects: [3],
      })
      expect(L.party[0].width / L.party[0].size).toBeCloseTo(1.5, 9)
      const sp = internals(s).partyViews[0].sprite!
      expect(sp.width).toBeLessThanOrEqual(L.party[0].width + 1e-6)
      expect(sp.height).toBeLessThanOrEqual(L.party[0].size + 1e-6)
    })
    it('敵の立ち絵（160x100）を読み込むと敵の枠の幅が高さの 1.6 倍になる', async () => {
      loadBy({ 'img/e0.webp': [160, 100] })
      const s = track(make([entity('p0')], [withSprite('e0')], { layout: 'side' }))
      await flushPromises()
      const L = computeSideBattleLayout({
        width: 800,
        height: 450,
        partyCount: 1,
        enemyCount: 1,
        enemyAspects: [1.6],
      })
      const sp = internals(s).enemyViews[0].sprite!
      expect(L.enemies[0].width / L.enemies[0].size).toBeCloseTo(1.6, 9)
      expect(sp.width).toBeCloseTo(L.enemies[0].width, 6)
      expect(sp.height).toBeCloseTo(L.enemies[0].size, 6)
    })
    it('画像のない味方・敵は色四角のまま、画像のある味方だけ縦横比が変わる', async () => {
      loadBy({ 'img/p1.webp': [40, 100] })
      const s = track(make([entity('p0'), withSprite('p1')], [entity('e0')], { layout: 'side' }))
      await flushPromises()
      const i = internals(s)
      expect(i.partyViews[0].sprite).toBeNull()
      expect(i.partyViews[1].sprite).not.toBeNull()
    })
  })

  describe('描画順（下の人ほど手前）', () => {
    it('奥行きオフ: 味方の container は sideStage の中で index 順に並ぶ（後の人ほど手前）', async () => {
      const s = track(
        make(
          [withSprite('p0'), withSprite('p1'), withSprite('p2'), withSprite('p3')],
          [withSprite('e0')],
          acrylic
        )
      )
      await flushPromises()
      const i = internals(s)
      const idx = i.partyViews.map((v) => i.sideStage!.children.indexOf(v.container))
      for (const k of idx) expect(k).toBeGreaterThanOrEqual(0)
      for (let k = 0; k + 1 < idx.length; k++) expect(idx[k + 1]).toBeGreaterThan(idx[k])
    })
    it('奥行きオン: 味方の zIndex は下の人ほど大きい（floor 昇順）', () => {
      const s = track(
        make([entity('p0'), entity('p1'), entity('p2'), entity('p3')], [entity('e0')], {
          layout: 'side',
          depth: { horizon: 0.3, perspective: 0.8 },
        })
      )
      const z = internals(s).partyViews.map((v) => v.container.zIndex)
      for (let k = 0; k + 1 < z.length; k++) expect(z[k + 1]).toBeGreaterThan(z[k])
    })
  })

  describe('モバイル縦長画面での立ち絵の位置（実描画の座標）', () => {
    it.each([
      [360, 640],
      [320, 568],
    ])(
      '%dx%d・味方 4・敵 4: 全スプライト・板・台座が画面内、味方と敵のスプライトが重ならない',
      async (w, h) => {
        const s = track(
          make(
            [withSprite('p0'), withSprite('p1'), withSprite('p2'), withSprite('p3')],
            [withSprite('e0'), withSprite('e1'), withSprite('e2'), withSprite('e3')],
            acrylic,
            w,
            h
          )
        )
        await flushPromises()
        const i = internals(s)
        const rectOf = (v: EntityViewLike): Rect => ({
          x: v.container.x + v.sprite!.x,
          y: v.container.y + v.sprite!.y,
          w: v.sprite!.width,
          h: v.sprite!.height,
        })
        const screen: Rect = { x: 0, y: 0, w, h }
        const enemyRects = i.enemyViews.map(rectOf)
        const partyRects = i.partyViews.map(rectOf)
        for (const r of [...enemyRects, ...partyRects]) {
          expect(r.w).toBeGreaterThan(0)
          expect(r.x).toBeGreaterThanOrEqual(-EPS)
          expect(r.y).toBeGreaterThanOrEqual(-EPS)
          expect(inside(r, screen)).toBe(true)
        }
        for (const pr of partyRects)
          for (const er of enemyRects) expect(overlaps(pr, er)).toBe(false)
        // 影は画面上の足元（スプライト下端の中央）を基点にする
        for (const v of [...i.enemyViews, ...i.partyViews]) {
          expect(v.acrylicShadow!.x).toBeCloseTo(
            v.container.x + v.sprite!.x + v.sprite!.width / 2,
            6
          )
          expect(v.acrylicShadow!.y).toBeCloseTo(v.container.y + v.sprite!.y + v.sprite!.height, 6)
        }
      }
    )
  })

  describe('spriteStyleParams の反映', () => {
    it('lineColor / lineAlpha の上書きは acrylicParams に clamp されて入る（板・台座の元になる）', () => {
      const s = track(
        make([entity('hero')], [withSprite('slime')], {
          ...acrylic,
          spriteStyleParams: { lineColor: 0x123456, lineAlpha: 7, castAlpha: -1 },
        })
      )
      const p = (s as unknown as { acrylicParams: ReturnType<typeof resolveAcrylicParams> })
        .acrylicParams
      expect(p.lineColor).toBe(0x123456)
      expect(p.lineAlpha).toBe(1)
      expect(p.castAlpha).toBe(0)
    })
    it("spriteStyle:'none' では acrylicParams を持たず、台座・板・影の生成を一度も呼ばない", async () => {
      const plate = vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicPlate')
      const base = vi.spyOn(BattleScreen.prototype as never, 'makeAcrylicBase')
      plate.mockClear()
      base.mockClear()
      const s = track(make([withSprite('p0')], [withSprite('e0')], { layout: 'side' }))
      await flushPromises()
      expect(plate).not.toHaveBeenCalled()
      expect(base).not.toHaveBeenCalled()
      for (const v of [...internals(s).enemyViews, ...internals(s).partyViews]) {
        expect(v.acrylicShadow).toBeNull()
        expect(v.acrylicBase).toBeNull()
      }
    })
  })
})

describe('BattleScreen: side のステータス欄は HP がばらばらでも見出しと「/」がそろう (#745)', () => {
  it.each([
    [800, 450],
    [1280, 720],
  ])('%dx%d: 現在 HP が 5 / 50 / 120 / 0 でも HP・MP の見出しと / の x が全員同じ', (w, h) => {
    const party = [
      entity('a', { hp: 5, maxHp: 120, mp: 1, maxMp: 99 }),
      entity('b', { hp: 50, maxHp: 120, mp: 12, maxMp: 99 }),
      entity('c', { hp: 120, maxHp: 120, mp: 99, maxMp: 99 }),
      entity('d', { hp: 0, maxHp: 120, mp: 0, maxMp: 99 }),
    ]
    const s = track(make(party, [entity('slime')], { layout: 'side' }, w, h))
    const i = internals(s)
    const same = (xs: number[]): void => xs.forEach((x) => expect(x).toBeCloseTo(xs[0], 6))
    same(i.statusHpLabels.map((t) => t.x))
    same(i.statusHpMaxes.map((t) => t.x))
    same(i.statusHpTexts.map((t) => t.x))
    same(i.statusMpLabels.map((t) => t.x))
    same(i.statusMpMaxes.map((t) => t.x))
    expect(i.statusHpLabels[0].text).toBe('HP')
    expect(i.statusHpTexts.map((t) => t.text)).toEqual(['5', '50', '120', '0'])
    // 「/最大値」は現在値の右端に接して続く（「/」の x = 現在値の右寄せ基準）
    expect(i.statusHpMaxes[0].x).toBeCloseTo(i.statusHpTexts[0].x, 6)
  })

  it('MP 列がない狭い画面では MP の 3 つの Text が非表示で空', () => {
    const s = track(make([entity('a')], [entity('slime')], { layout: 'side' }, 360, 640))
    const i = internals(s)
    for (const t of [i.statusMpLabels[0], i.statusMpTexts[0], i.statusMpMaxes[0]]) {
      expect(t.visible).toBe(false)
      expect(t.text).toBe('')
    }
  })
})

describe('BattleScreen: side の名前は実測幅でも列幅に収める (#745)', () => {
  it('概算より実幅が広い名前（英字など）は、実測が列幅以下になるまで末尾を詰める', () => {
    // jsdom は文字を実測できないので、Text.width を「1 文字 20px」に差し替える
    Object.defineProperty(PixiText.prototype, 'width', {
      configurable: true,
      get(this: PixiText) {
        return this.text.length * 20
      },
    })
    try {
      const s = track(
        make(
          [entity('a', { name: 'Abcdefghijklmnop' })],
          [entity('slime')],
          { layout: 'side' },
          800,
          450
        )
      )
      const colW = (s as unknown as { sideStatusColumns: { name: { w: number } } })
        .sideStatusColumns.name.w
      const t = internals(s).statusTexts[0]
      expect(t.text.length * 20).toBeLessThanOrEqual(colW + 0.5)
      expect(t.text.length).toBeGreaterThan(0)
    } finally {
      delete (PixiText.prototype as unknown as Record<string, unknown>).width
    }
  })
})

describe('BattleScreen: side の名前は ff-blue の文字影ぶんも列に食い込ませない (#745)', () => {
  it('実測幅 + 影の距離が列幅以下になるまで詰める', () => {
    Object.defineProperty(PixiText.prototype, 'width', {
      configurable: true,
      get(this: PixiText) {
        return this.text.length * 20
      },
    })
    try {
      const s = track(
        make(
          [entity('a', { name: 'Abcdefghijklmnop' })],
          [entity('slime')],
          { layout: 'side', windowStyle: 'ff-blue' },
          800,
          450
        )
      )
      const colW = (s as unknown as { sideStatusColumns: { name: { w: number } } })
        .sideStatusColumns.name.w
      const t = internals(s).statusTexts[0]
      expect(t.text.length * 20 + FF_BLUE_TEXT_SHADOW.distance).toBeLessThanOrEqual(colW + 0.5)
    } finally {
      delete (PixiText.prototype as unknown as Record<string, unknown>).width
    }
  })
})
