/** ダメージ数字の桁ごとの跳ね (#955) */
import { afterEach, describe, expect, it } from 'vitest'
import type { Container, Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import {
  popupCenterOffset,
  popupFontSize,
  fitPopupFontSize,
  POPUP_STACK_STEP,
  SNAPPY_MOTION_TIMING,
  sampleDigitPopup,
} from './battleMotion'
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
  popups: { text: Text | Container; digits?: Text[]; unit: number; fontSize: number; y: number }[]
  spawnPopup: (hit: unknown, sinceHit: number, stack?: number) => void
  enemyViews: { unit: number }[]
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

  const hit = (kind: 'damage' | 'heal' | 'miss', amount: number) => ({
    kind,
    amount,
    target: { side: 'enemy', index: 0 },
  })

  it('snappy: MISS と 1 桁は従来の Text 1 個', () => {
    const s = setup({ motion: 'snappy' })
    I(s).spawnPopup(hit('miss', 0), 0)
    I(s).spawnPopup(hit('damage', 7), 0)
    expect(I(s).popups).toHaveLength(2)
    for (const p of I(s).popups) expect(p.digits).toBeUndefined()
    expect(I(s).popups.map((p) => (p.text as Text).text)).toEqual(['MISS', '7'])
  })

  it('snappy: stack 1 の箱は stack 0 より popupFontSize*0.85 上', () => {
    const s = setup({ motion: 'snappy' })
    I(s).spawnPopup(hit('damage', 123), 0, 0)
    I(s).spawnPopup(hit('damage', 123), 0, 1)
    const [a, b] = I(s).popups
    expect(a.digits && b.digits).toBeTruthy()
    const unit = a.unit
    expect(a.text.y - b.text.y).toBeCloseTo(popupFontSize(unit) * POPUP_STACK_STEP, 5)
  })

  it('snappy: 5 桁以上の回復は縮小ぶん (centerDy) 箱が上がる', () => {
    const s = setup({ motion: 'snappy' })
    I(s).spawnPopup(hit('damage', 123), 0)
    I(s).spawnPopup(hit('heal', 12345), 0)
    const [a, b] = I(s).popups
    expect(b.digits).toHaveLength(5)
    const base = popupFontSize(a.unit)
    expect(b.fontSize).toBe(fitPopupFontSize('12345', base))
    expect(a.text.y - b.text.y).toBeCloseTo(popupCenterOffset(base, b.fontSize), 5)
    expect(b.fontSize).toBeLessThan(base)
  })

  it('snappy: 先頭桁の終了後も末尾桁が残り、フェード中は全桁の alpha が同じ', () => {
    const s = setup({ motion: 'snappy' })
    I(s).spawnPopup(hit('damage', 1234), 0)
    const p = I(s).popups[0]
    // 跳ね 320ms + 保持 180 の後 = フェード開始は末尾桁の遅れ(150ms)込みで 650ms
    run(s, 600)
    expect(p.digits!.map((d) => d.alpha)).toEqual([1, 1, 1, 1])
    run(s, 60)
    const al = p.digits!.map((d) => d.alpha)
    expect(al[0]).toBeLessThan(1)
    expect(al[0]).toBeGreaterThan(0)
    for (const a of al) expect(a).toBe(al[0])
    // 先頭桁単独の寿命(650ms)を過ぎても全体はまだ残る
    run(s, 80)
    expect(I(s).popups).toHaveLength(1)
    expect(p.digits![3].alpha).toBeGreaterThan(0)
    run(s, 200)
    expect(I(s).popups).toHaveLength(0)
  })

  it('snappy: 桁の y は dy*unit、redraw で枠が動いたら箱が追従する', () => {
    const s = setup({ motion: 'snappy' })
    I(s).spawnPopup(hit('damage', 123), 0)
    const p = I(s).popups[0]
    run(s, 40)
    const ds = sampleDigitPopup(40, 0, 3, SNAPPY_MOTION_TIMING)
    expect(ds.dy).toBeLessThan(0)
    expect(p.digits![0].y).toBeCloseTo(ds.dy * p.unit, 5)
    const x0 = p.text.x
    s.redraw(1200, 450)
    s.tick(1)
    expect(p.text.x).not.toBeCloseTo(x0, 1)
  })
})
