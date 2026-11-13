/**
 * 戦闘のステータス窓 (side): HP/MP の桁がどう違っても 4 人で縦にそろう・ATB ゲージは残り幅いっぱい (#1173)。
 * 純粋関数（computeStatusColumns）と、BattleScreen の Text 座標の両方で、桁数の組合せを総当たりで確かめる。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Text } from 'pixi.js'
import { BattleScreen } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import {
  computeSideBattleLayout,
  computeStatusColumns,
  estimateTextWidth,
  SIDE_STATUS_COLUMN_GAP,
  SIDE_STATUS_FONT_SIZE,
  SIDE_STATUS_GAUGE_MIN_WIDTH,
  SIDE_STATUS_GAUGE_WIDTH,
  SIDE_STATUS_MIN_NAME_CHARS,
  SIDE_STATUS_TEXT_PADDING,
  type StatusColumnsInput,
} from './battleLayout'
import type { BattleEntity } from './spellDsl'

const F = SIDE_STATUS_FONT_SIZE
/** 桁数の組合せ（1〜4 桁・0・上限 9999）。HP と MP を独立に振る */
const HP_SETS: number[][] = [
  [5, 123, 1000, 9999],
  [9999, 9999, 9999, 9999],
  [1, 1, 1, 1],
  [0, 9, 10, 99],
  [100, 5, 5000, 12],
  [9999, 1, 1, 1],
]
const MP_SETS: number[][] = [
  [0, 8, 99, 999],
  [999, 999, 999, 999],
  [0, 0, 0, 0],
  [1000, 9, 99, 0],
  [7, 70, 700, 7000],
]

function ent(i: number, hp: number, mp: number, name = `ゆうしゃ${i}`): BattleEntity {
  return { id: `p${i}`, name, hp, maxHp: hp, mp, maxMp: mp, atk: 10, def: 0, agi: 5 }
}

describe('computeStatusColumns: 値の列は現在値・最大値とも右寄せの基準を持つ (#1173)', () => {
  const base: StatusColumnsInput = {
    x: 0,
    width: 900,
    maxHp: 9999,
    maxMp: 999,
    compact: false,
    atb: true,
    nameWidth: 100,
  }
  it.each([true, false])('atb=%s: 最大値の右端は列の右端、「/」は現在値の右端から', (atb) => {
    const c = computeStatusColumns({ ...base, atb })
    for (const col of [c.hp, c.mp!]) {
      expect(col.maxRight).toBeCloseTo(col.x + col.w, 6)
      // 現在値の右端 + 「/」+ 最大値の最大桁 = 列の右端
      expect(col.maxRight - col.curRight).toBeGreaterThan(0)
    }
    expect(c.hp.maxRight - c.hp.curRight).toBeCloseTo(estimateTextWidth('/9999', F), 6)
    expect(c.mp!.maxRight - c.mp!.curRight).toBeCloseTo(estimateTextWidth('/999', F), 6)
  })
})

describe('computeStatusColumns: ATB ゲージは名前・HP/MP の列を除いた残り幅いっぱい (#1173)', () => {
  const base: StatusColumnsInput = {
    x: 100,
    width: 800,
    maxHp: 9999,
    maxMp: 999,
    compact: false,
    atb: true,
    nameWidth: 120,
  }
  it('右端はパネルの内側の右端、左端は MP 列の右 + 列間', () => {
    const c = computeStatusColumns(base)
    expect(c.gauge!.x + c.gauge!.w).toBeCloseTo(base.x + base.width - SIDE_STATUS_TEXT_PADDING, 6)
    expect(c.gauge!.x).toBeCloseTo(c.mp!.x + c.mp!.w + SIDE_STATUS_COLUMN_GAP, 6)
    expect(c.gauge!.w).toBeGreaterThan(SIDE_STATUS_GAUGE_WIDTH * 5)
  })

  it('名前 → HP → MP → ゲージの順で左から隙間なく（列間だけ空けて）並ぶ', () => {
    const c = computeStatusColumns(base)
    expect(c.hp.x).toBeCloseTo(c.name.x + c.name.w + SIDE_STATUS_COLUMN_GAP, 6)
    expect(c.mp!.x).toBeCloseTo(c.hp.x + c.hp.w + SIDE_STATUS_COLUMN_GAP, 6)
  })

  it('幅を広げるとゲージだけが伸びる（名前・HP・MP の幅は変わらない）', () => {
    const a = computeStatusColumns({ ...base, width: 700 })
    const b = computeStatusColumns({ ...base, width: 1100 })
    expect(b.name.w).toBeCloseTo(a.name.w, 6)
    expect(b.hp.w).toBeCloseTo(a.hp.w, 6)
    expect(b.gauge!.w - a.gauge!.w).toBeCloseTo(400, 6)
  })

  it('名前が長いと名前列が広がり、そのぶんゲージが縮む（ゲージの右端は動かない）', () => {
    const a = computeStatusColumns({ ...base, nameWidth: 100 })
    const b = computeStatusColumns({ ...base, nameWidth: 200 })
    expect(b.name.w - a.name.w).toBeCloseTo(100, 6)
    expect(a.gauge!.w - b.gauge!.w).toBeCloseTo(100, 6)
    expect(b.gauge!.x + b.gauge!.w).toBeCloseTo(a.gauge!.x + a.gauge!.w, 6)
  })

  it('狭いときは、ゲージが下限（半角 4 文字）を割る前に名前列が最小文字数まで縮む', () => {
    const minName = SIDE_STATUS_MIN_NAME_CHARS * F
    for (let w = 900; w >= 330; w -= 10) {
      const c = computeStatusColumns({ ...base, nameWidth: 400, width: w })
      if (!c.mp) break
      expect(c.name.w).toBeGreaterThanOrEqual(minName - 1e-6)
      expect(c.gauge!.w).toBeGreaterThanOrEqual(SIDE_STATUS_GAUGE_WIDTH - 1e-6)
    }
  })

  it('極端に狭いときだけ最小幅まで縮む', () => {
    const c = computeStatusColumns({ ...base, width: 60 })
    expect(c.gauge!.w).toBe(SIDE_STATUS_GAUGE_MIN_WIDTH)
  })

  it('nameWidth 省略は最低文字数ぶん（後方互換）で、ゲージは残りを取る', () => {
    const { nameWidth: _omit, ...rest } = base
    void _omit
    const c = computeStatusColumns(rest)
    expect(c.name.w).toBeCloseTo(SIDE_STATUS_MIN_NAME_CHARS * F, 6)
    expect(c.gauge!.x + c.gauge!.w).toBeCloseTo(base.x + base.width - SIDE_STATUS_TEXT_PADDING, 6)
  })

  it('ATB でなければゲージ列はなく、名前列が残り幅を取る（従来どおり）', () => {
    const c = computeStatusColumns({ ...base, atb: false })
    expect(c.gauge).toBeNull()
    expect(c.mp!.x + c.mp!.w).toBeCloseTo(base.x + base.width - SIDE_STATUS_TEXT_PADDING, 6)
  })
})

const created: BattleScreen[] = []
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

interface Internals {
  statusTexts: Text[]
  statusHpLabels: Text[]
  statusHpTexts: Text[]
  statusHpSlashes: Text[]
  statusHpMaxes: Text[]
  statusMpLabels: Text[]
  statusMpTexts: Text[]
  statusMpSlashes: Text[]
  statusMpMaxes: Text[]
  atbBarRects: Array<{ x: number; y: number; w: number; h: number }>
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

function build(
  hps: number[],
  mps: number[],
  presentation: 'ff' | 'dq',
  atb: boolean,
  w = 1280,
  h = 720
): BattleScreen {
  const party = hps.map((hp, i) => ent(i, hp, mps[i]))
  const engine = new BattleEngine(
    party,
    [ent(9, 50, 0, 'スライム')],
    atb ? { atb: { mode: 'wait' }, rng: () => 0 } : { rng: () => 0 }
  )
  const s = new BattleScreen(engine, w, h, { layout: 'side', presentation })
  created.push(s)
  // 登場スライドを済ませて位置を反映する
  const x = s as unknown as { entranceActive: boolean; refresh(): void }
  x.entranceActive = false
  x.refresh()
  return s
}

describe('BattleScreen: HP/MP の桁が 4 人でどう違っても縦にそろう (#1173)', () => {
  const cases = HP_SETS.flatMap((hp) => MP_SETS.map((mp) => [hp, mp] as const))
  it.each(
    cases.flatMap(([hp, mp]) =>
      (['ff', 'dq'] as const).flatMap((pres) =>
        [true, false].map((atb) => [hp.join(','), mp.join(','), pres, atb, hp, mp] as const)
      )
    )
  )('HP %s / MP %s / %s / atb=%s', (_h, _m, pres, atb, hp, mp) => {
    const i = I(build(hp, mp, pres, atb))
    const same = (xs: number[]): void => xs.forEach((x) => expect(x).toBeCloseTo(xs[0], 6))
    // 見出し・現在値の右端・「/」・最大値の右端が全員同じ x（Text の anchor は数値が右、見出しと「/」が左）
    for (const list of [
      i.statusHpLabels,
      i.statusHpTexts,
      i.statusHpSlashes,
      i.statusHpMaxes,
      i.statusMpLabels,
      i.statusMpTexts,
      i.statusMpSlashes,
      i.statusMpMaxes,
    ]) {
      same(list.map((t) => t.x))
    }
    // 現在値・最大値が右寄せ、見出し・「/」が左寄せ
    for (const t of [
      ...i.statusHpTexts,
      ...i.statusHpMaxes,
      ...i.statusMpTexts,
      ...i.statusMpMaxes,
    ])
      expect(t.anchor.x).toBe(1)
    for (const t of [...i.statusHpLabels, ...i.statusHpSlashes, ...i.statusMpSlashes])
      expect(t.anchor.x).toBe(0)
    // 内容: 現在値と最大値は数字だけ、「/」は別 Text
    expect(i.statusHpTexts.map((t) => t.text)).toEqual(hp.map(String))
    expect(i.statusHpMaxes.map((t) => t.text)).toEqual(hp.map(String))
    expect(i.statusMpMaxes.map((t) => t.text)).toEqual(mp.map(String))
    expect(i.statusHpSlashes.map((t) => t.text)).toEqual(hp.map(() => '/'))
    // 数字の概算幅は、その列の幅に収まる（右寄せの数字が左隣の見出しや前の列へ食い込まない）
    const maxHp = Math.max(...hp)
    const digitsW = estimateTextWidth(String(maxHp), F)
    const slashX = i.statusHpSlashes[0].x
    expect(slashX - digitsW).toBeGreaterThanOrEqual(i.statusHpLabels[0].x - 1e-6)
    // 最大値は「/」の右、現在値は「/」の左
    expect(i.statusHpMaxes[0].x - estimateTextWidth(String(maxHp), F)).toBeGreaterThanOrEqual(
      slashX - 1e-6
    )
  })

  it.each([1, 2, 3, 4])('メンバー %d 人でも同様にそろう', (n) => {
    const hp = [9999, 5, 123, 1000].slice(0, n)
    const mp = [0, 999, 8, 99].slice(0, n)
    const i = I(build(hp, mp, 'ff', true))
    expect(i.statusHpTexts).toHaveLength(n)
    const xs = i.statusHpTexts.map((t) => t.x)
    xs.forEach((x) => expect(x).toBeCloseTo(xs[0], 6))
    const mx = i.statusMpMaxes.map((t) => t.x)
    mx.forEach((x) => expect(x).toBeCloseTo(mx[0], 6))
  })
})

describe('BattleScreen: ATB ゲージは名前・HP/MP の列を除いた行の残り幅いっぱい (#1173)', () => {
  it.each([
    [1280, 720],
    [800, 450],
    [640, 360],
  ])('%dx%d: 4 人でゲージの左端・右端が同じで、MP 列の右からパネル内側の右端まで', (w, h) => {
    const s = build([5, 123, 1000, 9999], [0, 8, 99, 999], 'ff', true, w, h)
    const i = I(s)
    const L = computeSideBattleLayout({ width: w, height: h, partyCount: 4, enemyCount: 1 })
    const rects = i.atbBarRects
    expect(rects).toHaveLength(4)
    for (const r of rects) {
      expect(r.x).toBeCloseTo(rects[0].x, 6)
      expect(r.w).toBeCloseTo(rects[0].w, 6)
    }
    expect(rects[0].x + rects[0].w).toBeCloseTo(
      L.status.x + L.status.w - SIDE_STATUS_TEXT_PADDING,
      6
    )
    // MP の最大値（右端）の右にゲージが始まる。重ならない
    expect(rects[0].x).toBeGreaterThanOrEqual(i.statusMpMaxes[0].x)
    // 以前の固定幅（半角 4 文字）より、広い画面では十分に長い
    if (w >= 800) expect(rects[0].w).toBeGreaterThan(SIDE_STATUS_GAUGE_WIDTH * 3)
  })

  it('名前が行に収まる（名前の右端 <= HP 見出しの左端）', () => {
    const s = build([5, 123, 1000, 9999], [0, 8, 99, 999], 'ff', true)
    const i = I(s)
    i.statusTexts.forEach((t) => {
      expect(t.x + estimateTextWidth(t.text, F)).toBeLessThanOrEqual(i.statusHpLabels[0].x + 1e-6)
    })
  })
})
