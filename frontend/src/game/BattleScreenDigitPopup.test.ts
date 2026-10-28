/** ダメージ数字の桁ごとの跳ね (#955) */
import { afterEach, describe, expect, it } from 'vitest'
import type { Container, Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 30,
    maxHp: 30,
    mp: 4,
    maxMp: 4,
    atk: 8,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}
interface Internals {
  commands: { id: string; hit: Container }[]
  popups: { text: Text | Container; digits?: Text[] }[]
}
const I = (s: BattleScreen): Internals => s as unknown as Internals
const created: BattleScreen[] = []
function setup(opts: BattleScreenOptions = {}) {
  // atk 600 → 3 桁のダメージ
  const engine = new BattleEngine(
    [entity('hero', { atk: 600 })],
    [entity('slime', { hp: 99999, maxHp: 99999, atk: 1 })],
    { rng: () => 0.5 }
  )
  const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', ...opts })
  created.push(s)
  return s
}
const tap = (s: BattleScreen, id: string) =>
  I(s)
    .commands.find((c) => c.id === id)!
    .hit.emit('pointertap', {} as never)
const run = (s: BattleScreen, ms: number) => {
  for (let left = ms; left > 0; left -= 8) s.tick(Math.min(8, left))
}
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

describe('BattleScreen 桁ごとのダメージ数字 (#955)', () => {
  it('default: 数字全体の Text 1 個のまま', () => {
    const s = setup()
    tap(s, 'attack')
    run(s, 300)
    const p = I(s).popups[0]
    expect(p.digits).toBeUndefined()
    expect((p.text as Text).text).toMatch(/^\d{3,}$/)
  })

  it('snappy: 桁ごとに Text が生成され固定ピッチで並び、時間差で動く', () => {
    const s = setup({ motion: 'snappy' })
    tap(s, 'attack')
    run(s, 232)
    const p = I(s).popups.find((x) => x.digits)!
    expect(p).toBeDefined()
    const d = p.digits!
    expect(d.length).toBeGreaterThanOrEqual(3)
    expect(d.map((t) => t.text).join('')).toMatch(/^\d+$/)
    const pitches = d.slice(1).map((t, i) => t.x - d[i].x)
    expect(pitches[0]).toBeGreaterThan(0)
    for (const x of pitches) expect(x).toBeCloseTo(pitches[0], 5)
    // 中央揃え
    expect(d[0].x + d[d.length - 1].x).toBeCloseTo(0, 5)
    // 時間差: 先頭の方が高く（y が小さく）、末尾はまだ低い
    expect(d[0].y).toBeLessThan(d[d.length - 1].y)
    expect(p.text.children).toHaveLength(d.length)
  })

  it('snappy: 終わったら Container ごと破棄され popups が空になる', () => {
    const s = setup({ motion: 'snappy' })
    tap(s, 'attack')
    run(s, 300)
    const p = I(s).popups.find((x) => x.digits)!
    run(s, 3000)
    expect(I(s).popups).toHaveLength(0)
    expect(p.text.destroyed).toBe(true)
    for (const t of p.digits!) expect(t.destroyed).toBe(true)
  })
})
