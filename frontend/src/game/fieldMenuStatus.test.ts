/**
 * ステータス画面の領域配置 (#1191)。領域が基準面に収まり、重ならず、項目を足しても崩れないことを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { Rect } from './fieldMenu'
import {
  STATUS_MIN_FONT_RATIO,
  computeStatusLayout,
  fitPortrait,
  fitSize,
  statusArea,
  type StatusLayoutInput,
  type StatusRegion,
} from './fieldMenuStatus'

const PRIMARY: Rect = { x: 25.6, y: 86.4, w: 1228.8, h: 561.6 }
const PERSON = {
  name: 'アスカ',
  level: 12,
  hp: 148,
  maxHp: 230,
  mp: 31,
  maxMp: 56,
  atk: 24,
  def: 18,
  agi: 15,
}

function input(over: Partial<StatusLayoutInput> = {}, base = 720): StatusLayoutInput {
  return {
    area: statusArea(PRIMARY, base),
    font: 0.04 * base,
    person: PERSON,
    ...over,
  }
}

const within = (r: Rect, A: Rect): boolean =>
  r.x >= A.x - 1e-6 &&
  r.y >= A.y - 1e-6 &&
  r.x + r.w <= A.x + A.w + 1e-6 &&
  r.y + r.h <= A.y + A.h + 1e-6
const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w - 1e-6 &&
  b.x < a.x + a.w - 1e-6 &&
  a.y < b.y + b.h - 1e-6 &&
  b.y < a.y + a.h - 1e-6
const ids = (rs: StatusRegion[]): string[] => rs.map((r) => r.id)

function checkSane(rs: StatusRegion[], A: Rect): void {
  for (const r of rs) {
    expect(within(r.rect, A), `${r.id} が領域の外`).toBe(true)
    for (const c of r.cells) expect(within(c.rect, r.rect), `${r.id} の項目が領域の外`).toBe(true)
  }
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++)
      expect(overlap(rs[i].rect, rs[j].rect), `${rs[i].id} と ${rs[j].id} が重なる`).toBe(false)
}

describe('computeStatusLayout', () => {
  it('追加行・帯が無いときは portrait / identity / vitals / stats だけ（空の枠を出さない）', () => {
    const rs = computeStatusLayout(input())
    expect(ids(rs)).toEqual(['portrait', 'identity', 'vitals', 'stats'])
    checkSane(rs, input().area)
    // 絵の枠は左の縦長（幅は領域の半分未満）、残りの領域はその右に縦に積む
    const at = (id: string) => rs.find((r) => r.id === id)!.rect
    expect(at('portrait').w).toBeLessThan(input().area.w / 2)
    expect(at('portrait').h).toBeGreaterThan(at('portrait').w)
    for (const id of ['identity', 'vitals', 'stats'])
      expect(at(id).x).toBeGreaterThanOrEqual(at('portrait').x + at('portrait').w)
    expect(at('identity').y).toBeLessThan(at('vitals').y)
    expect(at('vitals').y).toBeLessThan(at('stats').y)
  })

  it('値の中身: 名前と Lv、HP・MP の現在/最大、能力値（未定義は --）', () => {
    const rs = computeStatusLayout(input())
    const cell = (id: string, k = 0) => rs.find((r) => r.id === id)!.cells[k]
    expect(cell('identity')).toMatchObject({ label: 'アスカ', value: 'Lv 12' })
    expect(cell('vitals', 0)).toMatchObject({ label: 'HP', value: '148 / 230' })
    expect(cell('vitals', 1)).toMatchObject({ label: 'MP', value: '31 / 56' })
    expect(rs.find((r) => r.id === 'stats')!.cells.map((c) => [c.label, c.value])).toEqual([
      ['ちから', '24'],
      ['まもり', '18'],
      ['すばやさ', '15'],
    ])
    const bare = computeStatusLayout(input({ person: { name: 'B', hp: 1, maxHp: 2 } }))
    expect(bare.find((r) => r.id === 'vitals')!.cells).toHaveLength(1)
    expect(bare.find((r) => r.id === 'identity')!.cells[0].value).toBe('Lv --')
    expect(bare.find((r) => r.id === 'stats')!.cells.map((c) => c.value)).toEqual([
      '--',
      '--',
      '--',
    ])
  })

  it('追加行を足すと extras 領域ができ、帯の行を足すと band 領域ができる（領域の追加が 1 か所で済む）', () => {
    const rows = [
      { label: '固有素質', value: 'つよいきもち' },
      { label: 'そうび', value: 'かたな' },
    ]
    const withExtras = computeStatusLayout(input({ extraRows: rows }))
    expect(ids(withExtras)).toContain('extras')
    expect(withExtras.find((r) => r.id === 'extras')!.cells).toHaveLength(2)
    checkSane(withExtras, input().area)
    const full = computeStatusLayout(
      input({
        extraRows: rows,
        bandRows: [
          { label: '経験値', value: '1200' },
          { label: '次のレベルまで', value: '80' },
        ],
      })
    )
    expect(ids(full)).toEqual(['band', 'portrait', 'identity', 'vitals', 'stats', 'extras'])
    checkSane(full, input().area)
    // 帯は最下段・全幅。絵の枠は帯の上で止まる
    const band = full.find((r) => r.id === 'band')!.rect
    const A = input().area
    expect(band.w).toBeCloseTo(A.w)
    expect(band.y + band.h).toBeCloseTo(A.y + A.h)
    expect(
      full.find((r) => r.id === 'portrait')!.rect.y + full.find((r) => r.id === 'portrait')!.rect.h
    ).toBeLessThan(band.y)
  })

  it('行が多くても全領域が基準面に収まる（行の高さを詰める）', () => {
    const many = Array.from({ length: 9 }, (_, k) => ({ label: `項目${k}`, value: String(k) }))
    const rs = computeStatusLayout(input({ extraRows: many, bandRows: many.slice(0, 3) }))
    checkSane(rs, input().area)
  })

  it('1280x720 と 390x219（スマホの縮小表示）の比率で同じ構成になる', () => {
    const small: Rect = { x: 7.8, y: 26.28, w: 374.4, h: 170.82 }
    const a = computeStatusLayout({
      area: statusArea(small, 219),
      font: 0.04 * 219,
      person: PERSON,
      extraRows: [{ label: 'そうび', value: 'かたな' }],
    })
    const b = computeStatusLayout(input({ extraRows: [{ label: 'そうび', value: 'かたな' }] }))
    expect(ids(a)).toEqual(ids(b))
    checkSane(a, statusArea(small, 219))
  })
})

describe('fitSize', () => {
  it('収まるならそのまま、長いと縮める', () => {
    expect(fitSize(20, 400, 'そうび', 'かたな')).toBe(20)
    expect(fitSize(20, 100, '固有素質', 'つよいきもちのこころ')).toBeLessThan(20)
  })
})

const MANY = Array.from({ length: 6 }, (_, k) => ({ label: `固有素質${k}`, value: `つよい${k}` }))
const BAND = [
  { label: '経験値', value: '123456' },
  { label: '次のレベルまで', value: '789' },
]

describe('#1186 で想定される量（追加行 6 行 + 帯 2 行）', () => {
  for (const base of [720, 219]) {
    it(`基準面の高さ ${base}: 全領域が収まり、表・帯の文字が下限を下回らない`, () => {
      const small: Rect = { x: 0, y: 0, w: base * (16 / 9) * 0.96, h: base * 0.78 }
      const area = statusArea(small, base)
      const font = 0.04 * base
      const rs = computeStatusLayout({
        area,
        font,
        person: PERSON,
        extraRows: MANY,
        bandRows: BAND,
      })
      checkSane(rs, area)
      expect(ids(rs)).toEqual(['band', 'portrait', 'identity', 'vitals', 'stats', 'extras'])
      for (const r of rs)
        for (const c of r.cells) {
          expect(c.labelSize, `${r.id}/${c.label}`).toBeGreaterThanOrEqual(
            font * STATUS_MIN_FONT_RATIO - 1e-6
          )
          expect(c.valueSize, `${r.id}/${c.label}`).toBeGreaterThanOrEqual(
            font * STATUS_MIN_FONT_RATIO - 1e-6
          )
        }
    })
  }

  it('もっと多く（追加行 12 + 帯 4）でも収まり、文字は下限のまま（3 列に増やす）', () => {
    const rows = Array.from({ length: 12 }, (_, k) => ({ label: `項目${k}`, value: `${k}` }))
    const rs = computeStatusLayout(input({ extraRows: rows, bandRows: [...BAND, ...BAND] }))
    checkSane(rs, input().area)
    const font = 0.04 * 720
    for (const c of rs.find((r) => r.id === 'extras')!.cells)
      expect(c.labelSize).toBeGreaterThanOrEqual(font * STATUS_MIN_FONT_RATIO - 1e-6)
  })

  it('経験値と次のレベルまでは帯の 1 行に並ぶ（2 列）', () => {
    const band = computeStatusLayout(input({ bandRows: BAND })).find((r) => r.id === 'band')!
    expect(band.cells[0].rect.y).toBeCloseTo(band.cells[1].rect.y)
    expect(band.cells[0].rect.x).toBeLessThan(band.cells[1].rect.x)
  })
})

describe('HP・MP と能力値の揃え', () => {
  it('現在値・/ ・最大値の位置が HP と MP で同じ（桁がそろう）', () => {
    const v = computeStatusLayout(input()).find((r) => r.id === 'vitals')!
    const [hp, mp] = v.cells.map((c) => c.pair!)
    expect(hp).toMatchObject({ cur: '148', max: '230' })
    expect(mp).toMatchObject({ cur: '31', max: '56' })
    expect(mp.curRight).toBe(hp.curRight)
    expect(mp.slashX).toBe(hp.slashX)
    expect(mp.maxRight).toBe(hp.maxRight)
    expect(hp.curRight).toBeLessThan(hp.slashX)
    expect(hp.slashX).toBeLessThan(hp.maxRight)
  })

  it('能力値の数字はラベルの近く（セルの右端まで離れない）で、1 列目の数字は 2 列目のラベルから離れている', () => {
    const cells = computeStatusLayout(input()).find((r) => r.id === 'stats')!.cells
    const [c0, c1] = cells
    const right0 = c0.valueRight!
    expect(right0).toBeLessThan(c0.rect.x + c0.rect.w)
    expect(c1.rect.x - right0).toBeGreaterThan(c0.labelSize * 2)
  })
})

describe('名前と Lv は独立', () => {
  it('長い名前を縮めても Lv の大きさは変わらない', () => {
    const f = 0.04 * 720
    const short = computeStatusLayout(input()).find((r) => r.id === 'identity')!.cells[0]
    const long = computeStatusLayout(
      input({ person: { ...PERSON, name: 'とてもとてもなまえのながいぼうけんしゃのだいひょう' } })
    ).find((r) => r.id === 'identity')!.cells[0]
    expect(long.labelSize).toBeLessThan(short.labelSize)
    expect(long.valueSize).toBe(short.valueSize)
    expect(long.labelSize).toBeGreaterThanOrEqual(f * STATUS_MIN_FONT_RATIO - 1e-6)
  })
})

describe('fitPortrait（人物の絵が枠に収まる）', () => {
  const rects: Rect[] = [
    { x: 36, y: 158, w: 364, h: 480 },
    { x: 10, y: 49, w: 112, h: 142 },
  ]
  const texes: [number, number][] = [
    [200, 400],
    [128, 128],
    [64, 256],
  ]
  it('アクスタ表示: 板・台座を含む外枠が枠の内側に収まり、絵の足元は外枠の中', () => {
    for (const R of rects)
      for (const [tw, th] of texes) {
        const f = fitPortrait(R, tw, th, true)
        expect(f.frame).not.toBeNull()
        expect(within(f.frame!, R), `${tw}x${th}`).toBe(true)
        expect(f.y).toBeLessThanOrEqual(f.frame!.y + f.frame!.h)
        expect(f.y - f.height).toBeGreaterThanOrEqual(f.frame!.y - 1e-6)
        expect(f.height).toBeGreaterThan(0)
      }
  })
  it('アクスタなし: 従来どおり枠の 88% の高さ・90% の幅以内', () => {
    for (const R of rects)
      for (const [tw, th] of texes) {
        const f = fitPortrait(R, tw, th, false)
        expect(f.frame).toBeNull()
        expect(f.height).toBeLessThanOrEqual(R.h * 0.88 + 1e-6)
        expect((f.height / th) * tw).toBeLessThanOrEqual(R.w * 0.9 + 1e-6)
        expect(f.y).toBeLessThanOrEqual(R.y + R.h)
      }
  })
})
