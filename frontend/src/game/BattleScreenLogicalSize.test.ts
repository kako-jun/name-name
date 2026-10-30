/** BattleScreen の uiScale (sit-by-me#52): 1920x1080 論理座標で、設計座標（800x450）と同じ配置になる。未指定は従来 */
import { afterEach, describe, expect, it } from 'vitest'
import { Container, Text } from 'pixi.js'
import { BattleScreen } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 99,
    maxHp: 99,
    mp: 9,
    maxMp: 9,
    atk: 8,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}
interface Internals {
  screenWidth: number
  screenHeight: number
  commands: { hit: Container; text: Text }[]
  statsPanel: Container
  commandPanel: Container
  logPanel: Container
  enemyListPanel: Container
  refresh(): void
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function make(
  w: number,
  h: number,
  extra: { uiScale?: number; renderResolution?: number; enemyList?: 'window' } = {}
) {
  const engine = new BattleEngine([entity('hero')], [entity('s1'), entity('s2')], {
    rng: () => 0.5,
    skills: {},
  })
  const s = new BattleScreen(engine, w, h, {
    layout: 'side',
    presentation: 'ff',
    commandLayout: 'cross',
    ...extra,
  })
  created.push(s)
  I(s).refresh()
  return s
}
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

/** PixelateFilter.size は [x, y] の配列で返る */
const sizeOf = (f: { size: unknown } | null): number =>
  Number(
    Array.isArray(f?.size) || f?.size instanceof Float32Array
      ? (f.size as ArrayLike<number>)[0]
      : f?.size
  )

describe('BattleScreen uiScale (sit-by-me#52)', () => {
  it('未指定は従来: scale 1・screenWidth/Height はそのまま', () => {
    const s = make(800, 450)
    expect(s.scale.x).toBe(1)
    expect(I(s).screenWidth).toBe(800)
    expect(I(s).screenHeight).toBe(450)
  })

  it('1920x1080 + uiScale 2.4: 根を 2.4 倍し、設計座標は 800x450 と同じ', () => {
    const base = make(800, 450)
    const big = make(1920, 1080, { uiScale: 2.4 })
    expect(big.scale.x).toBe(2.4)
    expect(big.scale.y).toBe(2.4)
    expect(I(big).screenWidth).toBeCloseTo(800, 9)
    expect(I(big).screenHeight).toBeCloseTo(450, 9)
    const pos = (s: BattleScreen) => I(s).commands.map((c) => [c.hit.x, c.hit.y])
    expect(pos(big)).toEqual(pos(base))
  })

  it('redraw は論理座標を受け取り、設計座標へ換算する（幅も高さも）', () => {
    const big = make(1920, 1080, { uiScale: 2.4 })
    big.redraw(1920, 1080)
    expect(I(big).screenWidth).toBeCloseTo(800, 9)
    expect(I(big).screenHeight).toBeCloseTo(450, 9)
  })

  it('被ヒットのモザイク size は uiScale 倍（画面の見た目の粗さを設計値どおりに保つ）', () => {
    const view = { container: new Container(), hitMosaic: null as { size: number } | null }
    const big = make(1920, 1080, { uiScale: 2.4 })
    ;(big as unknown as { applyHitMosaic(v: unknown, s: number | null): void }).applyHitMosaic(
      view,
      5
    )
    expect(sizeOf(view.hitMosaic)).toBeCloseTo(12, 5)
    const base = make(800, 450)
    const view2 = { container: new Container(), hitMosaic: null as { size: number } | null }
    ;(base as unknown as { applyHitMosaic(v: unknown, s: number | null): void }).applyHitMosaic(
      view2,
      5
    )
    expect(sizeOf(view2.hitMosaic)).toBeCloseTo(5, 5)
  })

  it('1920×1080 の実描画寸法（根の scale 適用後）で、窓どうしが重ならず画面内に収まる', () => {
    const s = make(1920, 1080, { uiScale: 2.4, enemyList: 'window' })
    const p = I(s)
    const panels = [p.statsPanel, p.commandPanel, p.logPanel, p.enemyListPanel]
    const rects = panels
      .filter((x) => x.visible)
      .map((x) => {
        const b = x.getBounds()
        return { x: b.x, y: b.y, w: b.width, h: b.height }
      })
      .filter((r) => r.w > 0 && r.h > 0)
    expect(rects.length).toBeGreaterThanOrEqual(3)
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6)
      expect(r.y).toBeGreaterThanOrEqual(-1e-6)
      expect(r.x + r.w).toBeLessThanOrEqual(1920 + 1e-6)
      expect(r.y + r.h).toBeLessThanOrEqual(1080 + 1e-6)
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const ov =
          a.x < b.x + b.w - 1e-6 &&
          b.x < a.x + a.w - 1e-6 &&
          a.y < b.y + b.h - 1e-6 &&
          b.y < a.y + a.h - 1e-6
        expect(ov).toBe(false)
      }
    // 設計座標 800×450 の窓を 2.4 倍した大きさになっている
    const base = make(800, 450, { enemyList: 'window' })
    const bc = I(base).commandPanel.getBounds()
    const cc = p.commandPanel.getBounds()
    expect(cc.width).toBeCloseTo(bc.width * 2.4, 3)
    expect(cc.height).toBeCloseTo(bc.height * 2.4, 3)
  })

  it('不正な uiScale は 1 扱い', () => {
    for (const bad of [0, -2, NaN]) expect(make(800, 450, { uiScale: bad }).scale.x).toBe(1)
  })

  it('tick で文字の resolution が renderResolution × uiScale に揃う（拡大でぼやけない）', () => {
    const big = make(1920, 1080, { uiScale: 2.4, renderResolution: 2 })
    big.tick(16)
    const texts = I(big).commands.map((c) => c.text)
    expect(texts.length).toBeGreaterThan(0)
    for (const t of texts) expect(t.resolution).toBeCloseTo(4.8, 9)
  })

  it('未指定の tick は文字の resolution に触れない', () => {
    const s = make(800, 450)
    s.tick(16)
    for (const c of I(s).commands) expect(c.text.resolution).toBeNull()
  })
})
