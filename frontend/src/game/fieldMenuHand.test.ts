/**
 * フィールドメニューの指の階層表示と間隔 (#1223) の純粋関数。
 */
import { describe, expect, it } from 'vitest'
import { HAND_HEIGHT, HAND_WIDTH } from './battleMenuLayout'
import {
  FIELD_HAND_BLINK_DIM_ALPHA,
  FIELD_HAND_BLINK_PERIOD_MS,
  FIELD_HAND_GAP_RATIO,
  fieldHandBlinkAlpha,
  fieldHandGap,
  fieldHandLane,
  fieldHandLeft,
  fieldHandSlotKey,
  fieldHandWidth,
  fieldMenuHandMarks,
} from './fieldMenuHand'
import { initialNav, type ScreenKind, type ScreenNav } from './fieldMenuScreens'

const nav = (kind: ScreenKind, over: Partial<ScreenNav> = {}): ScreenNav => ({
  ...initialNav(kind),
  ...over,
})

describe('fieldMenuHandMarks: 階層の指の列', () => {
  it.each<[ScreenKind, ScreenNav['focus']]>([
    ['item', 'tab'],
    ['appstore', 'tab'],
    ['party-list', 'party'],
    ['equip', 'party'],
    ['status', 'party'],
    ['save', 'list'],
    ['load', 'list'],
    ['config', 'list'],
    ['empty', 'list'],
  ])('%s の最初の階層（%s）は常時表示の指 1 つだけ', (kind, focus) => {
    expect(fieldMenuHandMarks(kind, nav(kind))).toEqual([{ level: focus, index: 0, solid: true }])
  })

  it('どうぐ: タブ → 一覧 → 使う相手。上の階層は選んだ位置に点滅で残る', () => {
    expect(fieldMenuHandMarks('item', nav('item', { tab: 1, focus: 'list', list: 2 }))).toEqual([
      { level: 'tab', index: 1, solid: false },
      { level: 'list', index: 2, solid: true },
    ])
    expect(
      fieldMenuHandMarks('item', nav('item', { tab: 1, list: 2, focus: 'target', target: 3 }))
    ).toEqual([
      { level: 'tab', index: 1, solid: false },
      { level: 'list', index: 2, solid: false },
      { level: 'target', index: 3, solid: true },
    ])
  })

  it('まほう: 使い手 → 一覧 → 対象。対象が使い手と同じ枠なら常時の指だけ（点滅を重ねない）', () => {
    expect(
      fieldMenuHandMarks('party-list', nav('party-list', { party: 1, focus: 'list' }))
    ).toEqual([
      { level: 'party', index: 1, solid: false },
      { level: 'list', index: 0, solid: true },
    ])
    expect(
      fieldMenuHandMarks('party-list', nav('party-list', { party: 1, focus: 'target', target: 0 }))
    ).toEqual([
      { level: 'party', index: 1, solid: false },
      { level: 'list', index: 0, solid: false },
      { level: 'target', index: 0, solid: true },
    ])
    expect(
      fieldMenuHandMarks('party-list', nav('party-list', { party: 1, focus: 'target', target: 1 }))
    ).toEqual([
      { level: 'list', index: 0, solid: false },
      { level: 'target', index: 1, solid: true },
    ])
  })

  it('アプリストア: タブ → 一覧 → 確認窓', () => {
    expect(
      fieldMenuHandMarks('appstore', nav('appstore', { focus: 'confirm', list: 4, confirm: 1 }))
    ).toEqual([
      { level: 'tab', index: 0, solid: false },
      { level: 'list', index: 4, solid: false },
      { level: 'confirm', index: 1, solid: true },
    ])
  })

  it('セーブ: 一覧（最初の階層）→ 確認窓。一覧を重複させない', () => {
    expect(fieldMenuHandMarks('save', nav('save', { focus: 'confirm', list: 2 }))).toEqual([
      { level: 'list', index: 2, solid: false },
      { level: 'confirm', index: 0, solid: true },
    ])
  })

  it('戻ると上の階層の指が常時表示に戻る（いまのフォーカスから作り直すだけ）', () => {
    const deep = nav('item', { tab: 2, focus: 'list' })
    expect(fieldMenuHandMarks('item', { ...deep, focus: 'tab' })).toEqual([
      { level: 'tab', index: 2, solid: true },
    ])
  })

  it('使う相手はパーティ枠と同じ置き場の鍵', () => {
    expect(fieldHandSlotKey('target', 2)).toBe(fieldHandSlotKey('party', 2))
    expect(fieldHandSlotKey('list', 2)).not.toBe(fieldHandSlotKey('party', 2))
  })
})

describe('指の寸法: 間隔は一つの定数', () => {
  it('手の幅は HAND_WIDTH:HAND_HEIGHT の比、間隔は高さ × FIELD_HAND_GAP_RATIO', () => {
    expect(fieldHandWidth(16)).toBeCloseTo((16 * HAND_WIDTH) / HAND_HEIGHT)
    expect(fieldHandGap(20)).toBeCloseTo(20 * FIELD_HAND_GAP_RATIO)
    expect(fieldHandLane(20)).toBeCloseTo(fieldHandWidth(20) + fieldHandGap(20))
  })

  it('指の右端 = 文字の左端 − 間隔', () => {
    const h = 24
    const left = fieldHandLeft(300, h)
    expect(left + fieldHandWidth(h)).toBeCloseTo(300 - fieldHandGap(h))
  })
})

describe('fieldHandBlinkAlpha: 点滅', () => {
  it('周期の前半は 1、後半は薄い。周期で繰り返す', () => {
    const p = FIELD_HAND_BLINK_PERIOD_MS
    expect(fieldHandBlinkAlpha(0)).toBe(1)
    expect(fieldHandBlinkAlpha(p / 2 - 1)).toBe(1)
    expect(fieldHandBlinkAlpha(p / 2)).toBe(FIELD_HAND_BLINK_DIM_ALPHA)
    expect(fieldHandBlinkAlpha(p - 1)).toBe(FIELD_HAND_BLINK_DIM_ALPHA)
    expect(fieldHandBlinkAlpha(p)).toBe(1)
    expect(fieldHandBlinkAlpha(p * 3 + p / 2)).toBe(FIELD_HAND_BLINK_DIM_ALPHA)
  })
})
