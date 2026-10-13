import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Texture } from 'pixi.js'
import {
  computeSideBattleLayout,
  computeStatusColumns,
  estimateTextWidth,
  fitLabel,
  SIDE_STATUS_COLUMN_GAP,
  SIDE_STATUS_FONT_SIZE,
  SIDE_STATUS_GAUGE_MIN_WIDTH,
  SIDE_STATUS_GAUGE_WIDTH,
  SIDE_STATUS_MIN_NAME_CHARS,
  SIDE_STATUS_TEXT_PADDING,
  type StatusColumnsInput,
} from './battleLayout'
import { getSharedDofMask, quantizeDofRamp, resetSharedDofMasksForTest } from './dofMaskCache'

const F = SIDE_STATUS_FONT_SIZE
const MIN_NAME = SIDE_STATUS_MIN_NAME_CHARS * F
const base: StatusColumnsInput = {
  x: 0,
  width: 600,
  maxHp: 120,
  maxMp: 99,
  compact: false,
  atb: false,
}

/** 名前列がちょうど MIN_NAME になる status 幅（最初の段階 = MP あり・見出しあり）を、関数の出力から逆算する */
function exactMinNameWidth(input: StatusColumnsInput): number {
  const c = computeStatusColumns({ ...input, width: 600 })
  return 600 - (c.name.w - MIN_NAME)
}

describe('computeStatusColumns: 名前列の最低文字数の境界 (#745)', () => {
  it.each([
    [-1, false],
    [0, true],
    [1, true],
  ])('名前列が最低幅 %+d px: MP は残る=%s', (delta, keepsMp) => {
    // 境界-1 は 0.5px 単位で下回らせる
    const w = exactMinNameWidth(base) + (delta === -1 ? -0.5 : delta)
    const c = computeStatusColumns({ ...base, width: w })
    expect(c.mp !== null).toBe(keepsMp)
    if (keepsMp) expect(c.name.w).toBeGreaterThanOrEqual(MIN_NAME - 1e-9)
  })

  it('境界-1 で MP を落とすと、名前列は最低幅より広がる（MP の列ぶん戻る）', () => {
    const w = exactMinNameWidth(base) - 0.5
    const c = computeStatusColumns({ ...base, width: w })
    expect(c.mp).toBeNull()
    expect(c.showLabels).toBe(true)
    expect(c.name.w).toBeGreaterThanOrEqual(MIN_NAME)
  })
})

describe('computeStatusColumns: maxHp の桁数 (#745)', () => {
  it.each([
    [99, 100],
    [100, 999],
    [999, 1000],
  ])('maxHp %d -> %d で HP 列は広がり、名前列は狭まり、HP の右端は動かない', (a, b) => {
    const ca = computeStatusColumns({ ...base, maxHp: a })
    const cb = computeStatusColumns({ ...base, maxHp: b })
    const digitsDiffer = String(a).length !== String(b).length
    if (digitsDiffer) {
      expect(cb.hp.w).toBeGreaterThan(ca.hp.w)
      expect(cb.name.w).toBeLessThan(ca.name.w)
    } else {
      expect(cb.hp.w).toBe(ca.hp.w)
    }
    expect(cb.hp.x + cb.hp.w).toBeCloseTo(ca.hp.x + ca.hp.w, 6)
  })

  it('HP 列の幅は「HP 最大/最大」の概算幅そのもの（定数の直書きなし）', () => {
    for (const m of [99, 100, 999, 1000]) {
      const c = computeStatusColumns({ ...base, maxHp: m })
      expect(c.hp.w).toBeCloseTo(estimateTextWidth(`HP ${m}/${m}`, F), 6)
    }
  })

  it('MP 列の幅は maxMp の桁数に追従し、maxMp 0 でも列は消えない', () => {
    const c0 = computeStatusColumns({ ...base, maxMp: 0 })
    const c1000 = computeStatusColumns({ ...base, maxMp: 1000 })
    expect(c0.mp).not.toBeNull()
    expect(c0.mp!.w).toBeCloseTo(estimateTextWidth('MP 0/0', F), 6)
    expect(c1000.mp!.w).toBeGreaterThan(c0.mp!.w)
  })

  it('味方 0 人（maxHp=0, maxMp=0）でも NaN / 負の幅を出さない', () => {
    const c = computeStatusColumns({ ...base, maxHp: 0, maxMp: 0, atb: true })
    for (const col of [c.name, c.hp, c.mp!, c.gauge!]) {
      expect(Number.isFinite(col.x)).toBe(true)
      expect(col.w).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('computeStatusColumns: 省略段階のデシジョンテーブル (#745)', () => {
  // 幅を狭めていくと 段階1(MP+見出し) -> 段階2(MP 省略) -> 段階3(見出し省略) -> 段階4(現在値のみ) -> 最終(ゲージ縮小)
  const stage = (c: ReturnType<typeof computeStatusColumns>) =>
    c.mp
      ? 1
      : c.showLabels
        ? 2
        : c.showMaxHp
          ? 3
          : c.gauge && c.gauge.w < SIDE_STATUS_GAUGE_WIDTH
            ? 5
            : 4

  it.each([false, true])('atb=%s: 幅が狭いほど段階は単調に進み、巻き戻らない', (atb) => {
    let prev = 0
    for (let w = 600; w >= 40; w -= 5) {
      const s = stage(computeStatusColumns({ ...base, maxHp: 9999, maxMp: 999, atb, width: w }))
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })

  it('広い幅では段階1、狭い幅では最終段階（現在値のみ）まで到達する', () => {
    expect(stage(computeStatusColumns({ ...base, width: 600 }))).toBe(1)
    const last = computeStatusColumns({ ...base, maxHp: 9999, atb: false, width: 60 })
    expect(last.mp).toBeNull()
    expect(last.showLabels).toBe(false)
    expect(last.showMaxHp).toBe(false)
  })

  it('compact は段階1を飛ばし、広くても MP を出さず見出しは残す', () => {
    const c = computeStatusColumns({ ...base, compact: true, width: 600 })
    expect(c.mp).toBeNull()
    expect(c.showLabels).toBe(true)
    expect(c.showMaxHp).toBe(true)
  })

  it('ゲージは極端に狭いときだけ最小幅まで縮み、それ以外は固定幅', () => {
    const wide = computeStatusColumns({ ...base, atb: true, width: 600 })
    expect(wide.gauge!.w).toBe(SIDE_STATUS_GAUGE_WIDTH)
    const tiny = computeStatusColumns({ ...base, maxHp: 9999, atb: true, width: 60 })
    expect(tiny.gauge!.w).toBe(SIDE_STATUS_GAUGE_MIN_WIDTH)
    expect(SIDE_STATUS_GAUGE_MIN_WIDTH).toBeLessThan(SIDE_STATUS_GAUGE_WIDTH)
  })

  it('ATB on では MP 省略のしきい値幅が ATB off より広い側（ゲージぶん先に削る）にある', () => {
    const w = exactMinNameWidth(base)
    const wOn = exactMinNameWidth({ ...base, atb: true })
    expect(wOn - w).toBeCloseTo(SIDE_STATUS_GAUGE_WIDTH + SIDE_STATUS_COLUMN_GAP, 6)
  })
})

describe('computeStatusColumns: 画面幅 × ATB × パーティ数 (#745)', () => {
  const cases: Array<[number, number, number]> = []
  for (const [w, h] of [
    [320, 568],
    [360, 640],
    [640, 360],
    [800, 450],
    [1280, 720],
  ] as const) {
    for (const n of [1, 2, 3, 4]) cases.push([w, h, n])
  }

  it.each(cases)(
    '%dx%d・味方 %d 人: 列は昇順・重ならず・パネル内側に収まる（ATB on/off）',
    (w, h, n) => {
      const L = computeSideBattleLayout({ width: w, height: h, partyCount: n, enemyCount: 1 })
      for (const atb of [false, true]) {
        const c = computeStatusColumns({
          x: L.status.x,
          width: L.status.w,
          maxHp: 999,
          maxMp: 999,
          compact: L.statusCompact,
          atb,
        })
        const cols = [c.name, c.hp, c.mp, c.gauge].filter((x) => x !== null)
        expect(c.gauge !== null).toBe(atb)
        expect(c.name.x).toBe(L.status.x + SIDE_STATUS_TEXT_PADDING)
        for (let i = 1; i < cols.length; i++) {
          expect(cols[i]!.x).toBeGreaterThanOrEqual(cols[i - 1]!.x + cols[i - 1]!.w - 1e-9)
        }
        const last = cols[cols.length - 1]!
        expect(last.x + last.w).toBeLessThanOrEqual(
          L.status.x + L.status.w - SIDE_STATUS_TEXT_PADDING + 1e-9
        )
        expect(c.name.w).toBeGreaterThanOrEqual(MIN_NAME - 1e-9)
      }
    }
  )

  it('x（パネル左端）が違っても列の相対位置は同じ（x 平行移動で不変）', () => {
    const a = computeStatusColumns({ ...base, x: 0, atb: true })
    const b = computeStatusColumns({ ...base, x: 77, atb: true })
    expect(b.hp.x - a.hp.x).toBeCloseTo(77, 6)
    expect(b.name.w).toBeCloseTo(a.name.w, 6)
  })
})

describe('名前の省略: 全角・半角・絵文字の混在でも名前列に収まる (#745)', () => {
  const c = computeStatusColumns({ ...base, maxHp: 999, maxMp: 99, atb: true, width: 260 })
  it.each([
    'ゆうしゃ',
    'Hero',
    'ゆうしゃHero',
    'ｱｲｳｴｵｶｷｸ',
    '🙂🙂🙂🙂🙂🙂',
    '',
    'ながいなまえのゆうしゃたち',
  ])('%j は名前列の幅を超えない', (name) => {
    expect(estimateTextWidth(fitLabel(name, c.name.w, F), F)).toBeLessThanOrEqual(c.name.w + 1e-9)
  })
})

describe('dofMaskCache: 追加観点 (#745)', () => {
  beforeEach(() => resetSharedDofMasksForTest())

  it('量子化は冪等で、浮動小数の誤差があっても同じキー（同じテクスチャ）になる', () => {
    expect(quantizeDofRamp(quantizeDofRamp(0.37))).toBeCloseTo(quantizeDofRamp(0.37), 12)
    const build = vi.fn(() => new Texture())
    const a = getSharedDofMask(0.07, build)
    const b = getSharedDofMask(0.07 + 1e-9, build)
    const c = getSharedDofMask(0.1 - 0.03, build)
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('端（0 と 1）でも量子化後の割合で作り、別々のテクスチャになる', () => {
    const seen: number[] = []
    const build = (r: number) => (seen.push(r), new Texture())
    const t0 = getSharedDofMask(0, build)
    const t1 = getSharedDofMask(1, build)
    expect(t0).not.toBe(t1)
    expect(seen).toEqual([quantizeDofRamp(0), quantizeDofRamp(1)])
  })

  it('キャッシュ経由の取得・リセットはテクスチャを destroy しない（再作成で共有物を壊さない）', () => {
    const t = new Texture()
    const spy = vi.spyOn(t, 'destroy')
    expect(getSharedDofMask(0.4, () => t)).toBe(t)
    expect(getSharedDofMask(0.4, () => new Texture())).toBe(t)
    resetSharedDofMasksForTest()
    expect(spy).not.toHaveBeenCalled()
  })
})
