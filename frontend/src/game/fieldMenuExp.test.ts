/**
 * フィールドメニューの経験値の表示 (#1186) の計算部。経験値表（Lv1→2 から順の累計 exp）から「次のレベルまで」を求める。
 */
import { describe, expect, it } from 'vitest'
import { expStatusRows, menuExpField, menuExpOf, nextValue } from './fieldMenuExp'
import type { LevelUpDef } from './levelUp'

const DEF: LevelUpDef = { expTable: [8, 20, 40, 80] }

describe('menuExpOf', () => {
  it('経験値表が無い・空の人物は undefined（何も出さない）', () => {
    expect(menuExpOf({}, undefined)).toBeUndefined()
    expect(menuExpOf({}, {} as LevelUpDef)).toBeUndefined()
    expect(menuExpOf({}, { expTable: [] })).toBeUndefined()
  })

  it('Lv も exp も未保存（経験値を一度も足していない）は Lv1・exp 0。次は表の先頭まで', () => {
    expect(menuExpOf({}, DEF)).toEqual({ exp: 0, toNext: 8 })
  })

  it('保存した Lv と exp から、表の次の値との差を出す', () => {
    expect(menuExpOf({ level: 1, exp: 5 }, DEF)).toEqual({ exp: 5, toNext: 3 })
    expect(menuExpOf({ level: 2, exp: 8 }, DEF)).toEqual({ exp: 8, toNext: 12 })
    expect(menuExpOf({ level: 4, exp: 79 }, DEF)).toEqual({ exp: 79, toNext: 1 })
  })

  it('初期 Lv だけ書いた人物は、その Lv に必要な累計 exp から数える', () => {
    expect(menuExpOf({}, { ...DEF, level: 3 })).toEqual({ exp: 20, toNext: 20 })
  })

  it('上限 Lv（表の長さ + 1）では toNext が null', () => {
    expect(menuExpOf({ level: 5, exp: 120 }, DEF)).toEqual({ exp: 120, toNext: null })
  })

  it('exp が表より進んでいても負にしない', () => {
    expect(menuExpOf({ level: 1, exp: 30 }, DEF)).toEqual({ exp: 30, toNext: 0 })
  })
})

describe('表示用の整形', () => {
  it('nextValue: 上限は MAX、それ以外は数字', () => {
    expect(nextValue({ exp: 0, toNext: 8 })).toBe('8')
    expect(nextValue({ exp: 9, toNext: null })).toBe('MAX')
  })

  it('expStatusRows: 値があれば 2 行（けいけんち・次のレベルまで）、無ければ空', () => {
    expect(expStatusRows(undefined)).toEqual([])
    expect(expStatusRows({ exp: 5, toNext: 3 })).toEqual([
      { label: 'けいけんち', value: '5' },
      { label: '次のレベルまで', value: '3' },
    ])
  })

  it('menuExpField: 無ければ空オブジェクト（exp: undefined を作らない）', () => {
    expect('exp' in menuExpField({}, undefined)).toBe(false)
    expect(menuExpField({ level: 1, exp: 5 }, DEF)).toEqual({ exp: { exp: 5, toNext: 3 } })
  })
})
