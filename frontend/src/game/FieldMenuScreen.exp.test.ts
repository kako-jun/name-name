/**
 * フィールドメニューの経験値の表示 (#1186)。`exp: true` のときだけ、左のパーティ枠の各人に「次のレベルまで」、
 * ステータス画面に「けいけんち」「次のレベルまで」が出る。未指定は従来の描画と完全に同じ。ステータスの配置（line / ff）とは独立。
 */
import { Container, Text } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { FieldMenuScreen, type FieldMenuPartyView } from './FieldMenuScreen'
import type { StatusLayoutKind } from './fieldMenuStatus'
import type { FieldMenuItemDef } from './fieldMenu'

const ITEMS: FieldMenuItemDef[] = [
  { id: 'status', label: 'ステータス' },
  {
    id: 'item',
    label: 'どうぐ',
    content: {
      tabs: [{ label: 'つかう', action: 'use', entries: [{ label: 'ポーション', id: 'p' }] }],
    },
  },
]
const PARTY: FieldMenuPartyView[] = [
  {
    id: 'a',
    name: 'アスカ',
    level: 2,
    hp: 148,
    maxHp: 230,
    mp: 31,
    maxMp: 56,
    atk: 24,
    def: 18,
    agi: 15,
    texture: null,
    exp: { exp: 8, toNext: 12 },
  },
  {
    id: 'b',
    name: 'ボブ',
    level: 5,
    hp: 80,
    maxHp: 120,
    atk: 20,
    def: 12,
    agi: 9,
    texture: null,
    exp: { exp: 120, toNext: null },
  },
  // 経験値表を持たない人物（exp なし）
  { id: 'c', name: 'カズ', level: 3, hp: 50, maxHp: 60, texture: null },
]

function texts(c: Container): string[] {
  const out: string[] = []
  const walk = (n: Container): void => {
    if (n instanceof Text) out.push(n.text)
    for (const ch of n.children) walk(ch as Container)
  }
  walk(c)
  return out
}

function open(
  o: { exp?: boolean; layout?: StatusLayoutKind },
  tap: number | null,
  party: FieldMenuPartyView[] = PARTY
): FieldMenuScreen {
  const s = new FieldMenuScreen({
    width: 1280,
    height: 720,
    acrylic: false,
    onClose: () => {},
    ...(o.exp !== undefined ? { exp: o.exp } : {}),
    ...(o.layout !== undefined ? { statusLayout: o.layout } : {}),
  })
  s.open({
    items: ITEMS,
    party,
    info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
    slots: [null, null, null],
  })
  if (tap !== null) s.dispatch({ type: 'tap', index: tap })
  s.tick(10_000)
  return s
}

const count = (t: string[], s: string): number => t.filter((x) => x === s).length

describe('FieldMenuScreen: 経験値の表示 (#1186)', () => {
  it('未指定・false は経験値の文字を一切出さない（トップ・ステータス・どうぐ。従来と同じ）', () => {
    const base = [open({}, null), open({}, 0), open({}, 1)].map(texts)
    const off = [open({ exp: false }, null), open({ exp: false }, 0), open({ exp: false }, 1)].map(
      texts
    )
    expect(off).toEqual(base)
    for (const t of base) {
      expect(t).not.toContain('次のレベルまで')
      expect(t).not.toContain('けいけんち')
    }
  })

  it('トップ画面: 経験値表を持つ人物の枠に「次のレベルまで」と値が出る（上限は MAX）。持たない人物は出さない', () => {
    const t = texts(open({ exp: true }, null))
    expect(count(t, '次のレベルまで')).toBe(2)
    expect(t).toContain('12')
    expect(t).toContain('MAX')
    // 名前・Lv・HP は従来どおり残る
    for (const s of ['アスカ', 'Lv 2', 'HP  148 / 230', 'ボブ', 'カズ', 'HP  50 / 60'])
      expect(t).toContain(s)
  })

  it('人物の枠があるどうぐ画面（狭い枠）でも常に出る', () => {
    const t = texts(open({ exp: true }, 1))
    expect(count(t, '次のレベルまで')).toBe(2)
    expect(t).toContain('12')
    expect(t).toContain('MAX')
  })

  it('対象を選ぶ間の印（「対象」）は経験値の行を足しても残る', () => {
    const s = open({ exp: true }, 1)
    s.dispatch({ type: 'select', target: 'list', index: 0 })
    s.tick(10_000)
    const t = texts(s)
    expect(t).toContain('対象')
    expect(count(t, '次のレベルまで')).toBe(2)
  })

  it('line のステータス画面: 能力値の下に 1 行「けいけんち N  次のレベルまで M」', () => {
    const t = texts(open({ exp: true }, 0))
    expect(t).toContain('けいけんち 8  次のレベルまで 12')
    expect(t).toContain('ちから 24 まもり 18 すばやさ 15')
  })

  it('line のステータス画面: 上限 Lv は MAX。経験値表の無い人物は行を出さない', () => {
    const s = open({ exp: true }, 0)
    s.dispatch({ type: 'select', target: 'next', index: 0 })
    s.tick(10_000)
    expect(texts(s)).toContain('けいけんち 120  次のレベルまで MAX')
    s.dispatch({ type: 'select', target: 'next', index: 0 })
    s.tick(10_000)
    const t = texts(s)
    expect(t.some((x) => x.startsWith('カズ'))).toBe(true)
    expect(t.some((x) => x.includes('けいけんち'))).toBe(false)
  })

  it('ff のステータス画面: 最下段の帯に「けいけんち」「次のレベルまで」が項目名と値で出る', () => {
    const t = texts(open({ exp: true, layout: 'ff' }, 0))
    for (const s of ['けいけんち', '8', '次のレベルまで', '12', 'ちから', '24'])
      expect(t).toContain(s)
  })

  it('ff でも exp 未指定なら従来と同じ（帯なし）', () => {
    const off = texts(open({ layout: 'ff' }, 0))
    expect(off).not.toContain('けいけんち')
    expect(off).toEqual(texts(open({ exp: false, layout: 'ff' }, 0)))
  })

  it('配置（line / ff）を変えてもトップ画面の経験値の表示は同じ', () => {
    expect(texts(open({ exp: true, layout: 'ff' }, null))).toEqual(
      texts(open({ exp: true, layout: 'line' }, null))
    )
  })
})

describe('FieldMenuScreen: line の追加行があふれない (#1186)', () => {
  const rows = (n: number): { label: string; value: string }[] =>
    Array.from({ length: n }, (_, i) => ({ label: `行${i}`, value: 'v' }))
  const maxY = (c: Container): number => {
    let m = 0
    const walk = (n: Container): void => {
      if (n instanceof Text && n.text.startsWith('行')) m = Math.max(m, n.y)
      for (const ch of n.children) walk(ch as Container)
    }
    walk(c)
    return m
  }
  function openWith(exp: boolean, n: number): FieldMenuScreen {
    const s = new FieldMenuScreen({
      width: 1280,
      height: 720,
      acrylic: false,
      onClose: () => {},
      ...(exp ? { exp: true } : {}),
    })
    s.open({
      items: [{ id: 'status', label: 'ステータス', content: { statusByParty: { a: rows(n) } } }],
      party: [PARTY[0]],
      info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
      slots: [null, null, null],
    })
    s.dispatch({ type: 'tap', index: 0 })
    s.tick(10_000)
    return s
  }
  it('経験値の行 + 追加 4 行（計 9 行以上）でも最後の行が枠の下端（戻る帯の上）に収まる', () => {
    expect(maxY(openWith(true, 4))).toBeLessThan(720 * 0.88)
    expect(maxY(openWith(true, 6))).toBeLessThan(720 * 0.88)
  })
  it('8 行までは従来と同じ行間（経験値なしの追加 4 行は 0.1 刻みのまま）', () => {
    const ys: number[] = []
    const s = openWith(false, 4)
    const walk = (n: Container): void => {
      if (n instanceof Text && n.text.startsWith('行')) ys.push(n.y)
      for (const ch of n.children) walk(ch as Container)
    }
    walk(s as unknown as Container)
    ys.sort((a, b) => a - b)
    expect(ys[1] - ys[0]).toBeCloseTo(ys[2] - ys[1], 5)
  })
})
