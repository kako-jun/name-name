import { describe, expect, it } from 'vitest'
import {
  FF_BLUE_BAND_COUNT,
  FF_BLUE_BOTTOM_COLOR,
  FF_BLUE_TOP_COLOR,
  computeBands,
  lerpColor,
  normalizeWindowStyle,
} from './windowStyle'

describe('computeBands', () => {
  it('帯は隙間なく高さを覆い、上端色→下端色になる', () => {
    const bands = computeBands(100, 8, 0x4a5ad8, 0x000a50)
    expect(bands).toHaveLength(8)
    expect(bands[0].y).toBe(0)
    expect(bands[0].color).toBe(0x4a5ad8)
    expect(bands[7].color).toBe(0x000a50)
    let y = 0
    for (const b of bands) {
      expect(b.y).toBe(y)
      expect(b.h).toBeGreaterThan(0)
      y += b.h
    }
    expect(y).toBe(100)
  })
  it('高さより帯数が多ければ帯数を減らす・不正入力は空', () => {
    expect(computeBands(3, 9)).toHaveLength(3)
    expect(computeBands(0)).toEqual([])
    expect(computeBands(50, 0)).toEqual([])
  })
})

describe('normalizeWindowStyle', () => {
  it('ff-blue は ff-blue', () => {
    expect(normalizeWindowStyle('ff-blue')).toBe('ff-blue')
  })
  it('dark は dark', () => {
    expect(normalizeWindowStyle('dark')).toBe('dark')
  })
  it('大文字小文字を無視する', () => {
    expect(normalizeWindowStyle('FF-BLUE')).toBe('ff-blue')
    expect(normalizeWindowStyle('Ff-Blue')).toBe('ff-blue')
  })
  it('前後の空白（タブ・改行含む）を無視する', () => {
    expect(normalizeWindowStyle('\t ff-blue \n')).toBe('ff-blue')
  })
  it('null / undefined / 空 / 空白のみは dark', () => {
    expect(normalizeWindowStyle(null)).toBe('dark')
    expect(normalizeWindowStyle(undefined)).toBe('dark')
    expect(normalizeWindowStyle('')).toBe('dark')
    expect(normalizeWindowStyle('   \t\n')).toBe('dark')
  })
  it.each(['xxx', 'ff_blue', 'ffblue', 'ff-blue2', 'ff‐blue', 'ff−blue', 'ff-blu'])(
    '似た綴り %s は dark',
    (v) => {
      expect(normalizeWindowStyle(v)).toBe('dark')
    }
  )
  it('prefix のみ（ff- / ff）は dark', () => {
    expect(normalizeWindowStyle('ff-')).toBe('dark')
    expect(normalizeWindowStyle('ff')).toBe('dark')
  })
  it('非 string が来ても例外を出さず dark', () => {
    for (const v of [1, true, {}, [], ['ff-blue'], NaN]) {
      expect(normalizeWindowStyle(v as unknown as string)).toBe('dark')
    }
  })
})

describe('lerpColor', () => {
  it('t=0 は a、t=1 は b', () => {
    expect(lerpColor(0x123456, 0xabcdef, 0)).toBe(0x123456)
    expect(lerpColor(0x123456, 0xabcdef, 1)).toBe(0xabcdef)
  })
  it('t=0.5 は 127.5 を 128 に丸める', () => {
    expect(lerpColor(0x000000, 0xffffff, 0.5)).toBe(0x808080)
    expect(lerpColor(0x000000, 0xfefefe, 0.5)).toBe(0x7f7f7f)
  })
  it('NaN の t は 0 扱い（a を返す）', () => {
    expect(lerpColor(0x123456, 0xabcdef, NaN)).toBe(0x123456)
  })
  it('チャンネルは独立に補間される', () => {
    expect(lerpColor(0xff0000, 0x00ff00, 1)).toBe(0x00ff00)
    expect(lerpColor(0x0000ff, 0xff0000, 0)).toBe(0x0000ff)
    expect(lerpColor(0x000000, 0xff0000, 0.5)).toBe(0x800000)
    expect(lerpColor(0x000000, 0x00ff00, 0.5)).toBe(0x008000)
    expect(lerpColor(0x000000, 0x0000ff, 0.5)).toBe(0x000080)
  })
  it('降順チャンネル（b < a）でも正しく補間される', () => {
    expect(lerpColor(0xffffff, 0x000000, 0.5)).toBe(0x808080)
    expect(lerpColor(0xff0000, 0x000000, 0.25)).toBe(0xbf0000)
  })
  it('a === b ならどの t でも同色', () => {
    expect(lerpColor(0x4a5ad8, 0x4a5ad8, 0.37)).toBe(0x4a5ad8)
  })
  it('範囲外 t は [0,1] にクランプされ色が化けない', () => {
    expect(lerpColor(0x000000, 0xffffff, -1)).toBe(0x000000)
    expect(lerpColor(0x000000, 0xffffff, 2)).toBe(0xffffff)
    expect(lerpColor(0x102030, 0x405060, 100)).toBe(0x405060)
    expect(lerpColor(0x102030, 0x405060, -100)).toBe(0x102030)
  })
})

describe('computeBands', () => {
  it('高さ 1..60 総当たりで 連続・各 h>=1・合計=高さ・y 昇順', () => {
    for (let height = 1; height <= 60; height++) {
      const bands = computeBands(height)
      expect(bands.length).toBeGreaterThan(0)
      let y = 0
      for (const b of bands) {
        expect(b.y).toBe(y)
        expect(b.h).toBeGreaterThanOrEqual(1)
        y += b.h
      }
      expect(y).toBe(height)
    }
  })
  it('高さ 1,2,3 では帯数が高さまで減る', () => {
    expect(computeBands(1, 9)).toHaveLength(1)
    expect(computeBands(2, 9)).toHaveLength(2)
    expect(computeBands(3, 9)).toHaveLength(3)
  })
  it('高さ == 帯数 / 帯数+1 の境界', () => {
    const eq = computeBands(FF_BLUE_BAND_COUNT)
    expect(eq).toHaveLength(FF_BLUE_BAND_COUNT)
    expect(eq.every((b) => b.h === 1)).toBe(true)
    const plus = computeBands(FF_BLUE_BAND_COUNT + 1)
    expect(plus).toHaveLength(FF_BLUE_BAND_COUNT)
    expect(plus.reduce((s, b) => s + b.h, 0)).toBe(FF_BLUE_BAND_COUNT + 1)
  })
  it('帯数 > 高さなら帯数が減る（全帯 h=1）', () => {
    const bands = computeBands(4, 20)
    expect(bands).toHaveLength(4)
    expect(bands.every((b) => b.h === 1)).toBe(true)
  })
  it('非整数の高さは切り捨てて整数 px で覆う', () => {
    const bands = computeBands(10.7, 4)
    const last = bands[bands.length - 1]
    expect(last.y + last.h).toBe(10)
    for (const b of bands) {
      expect(Number.isInteger(b.y)).toBe(true)
      expect(Number.isInteger(b.h)).toBe(true)
    }
  })
  it('非整数の帯数は切り捨てる', () => {
    expect(computeBands(100, 4.9)).toHaveLength(4)
  })
  it('高さ 0・負は空', () => {
    expect(computeBands(0)).toEqual([])
    expect(computeBands(-5)).toEqual([])
  })
  it('帯数 0・負は空', () => {
    expect(computeBands(50, 0)).toEqual([])
    expect(computeBands(50, -3)).toEqual([])
  })
  it('1 未満の高さは空', () => {
    expect(computeBands(0.9)).toEqual([])
  })
  it('NaN / Infinity は空', () => {
    expect(computeBands(NaN)).toEqual([])
    expect(computeBands(Infinity)).toEqual([])
    expect(computeBands(-Infinity)).toEqual([])
    expect(computeBands(50, NaN)).toEqual([])
    expect(computeBands(50, Infinity)).toEqual([])
    expect(computeBands(50, -Infinity)).toEqual([])
  })
  it('帯数 1 は top 色・高さ全体', () => {
    const bands = computeBands(40, 1, 0x112233, 0x998877)
    expect(bands).toEqual([{ y: 0, h: 40, color: 0x112233 }])
  })
  it('帯数 2 は top と bottom', () => {
    const bands = computeBands(40, 2, 0x112233, 0x998877)
    expect(bands).toHaveLength(2)
    expect(bands[0].color).toBe(0x112233)
    expect(bands[1].color).toBe(0x998877)
    expect(bands[0].h + bands[1].h).toBe(40)
  })
  it('既定引数で上の帯が下の帯より明るい（各チャンネル単調）', () => {
    const bands = computeBands(90)
    expect(bands[0].color).toBe(FF_BLUE_TOP_COLOR)
    expect(bands[bands.length - 1].color).toBe(FF_BLUE_BOTTOM_COLOR)
    const ch = (c: number, s: number) => (c >> s) & 0xff
    for (let i = 1; i < bands.length; i++) {
      for (const s of [16, 8, 0]) {
        const prev = ch(bands[i - 1].color, s)
        const cur = ch(bands[i].color, s)
        const dir = Math.sign(ch(FF_BLUE_BOTTOM_COLOR, s) - ch(FF_BLUE_TOP_COLOR, s))
        expect(Math.sign(cur - prev) * dir).toBeGreaterThanOrEqual(0)
      }
    }
  })
  it('top === bottom なら全帯が同色', () => {
    const bands = computeBands(50, 5, 0x336699, 0x336699)
    expect(bands.every((b) => b.color === 0x336699)).toBe(true)
  })
  it('最終帯の下端が高さに一致する', () => {
    for (const height of [7, 31, 100, 233]) {
      const bands = computeBands(height)
      const last = bands[bands.length - 1]
      expect(last.y + last.h).toBe(height)
    }
  })
  it('二重実行で同値（純粋）', () => {
    expect(computeBands(77)).toEqual(computeBands(77))
  })
})
