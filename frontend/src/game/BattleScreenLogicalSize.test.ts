/** BattleScreen の uiScale (sit-by-me#52): 1920x1080 論理座標で、設計座標（800x450）と同じ配置になる。未指定は従来 */
import { afterEach, describe, expect, it } from 'vitest'
import { Text, type Container } from 'pixi.js'
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
  refresh(): void
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function make(w: number, h: number, extra: { uiScale?: number; renderResolution?: number } = {}) {
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

  it('redraw は論理座標を受け取り、設計座標へ換算する', () => {
    const big = make(1920, 1080, { uiScale: 2.4 })
    big.redraw(1920, 1080)
    expect(I(big).screenWidth).toBeCloseTo(800, 9)
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
