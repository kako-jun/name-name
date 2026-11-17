/**
 * フィールドメニューのステータス画面の配置 (#1191)。`statusLayout: 'ff'` のときだけ領域配置になり、
 * 未指定・'line' は従来の 1 列のまま。他の画面（どうぐ等）・人物の切り替えは配置に依らず同じ。
 */
import { Container, Sprite, Text, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { FieldMenuScreen } from './FieldMenuScreen'
import type { StatusLayoutKind } from './fieldMenuStatus'
import type { FieldMenuItemDef } from './fieldMenu'

const ITEMS: FieldMenuItemDef[] = [
  {
    id: 'status',
    label: 'ステータス',
    content: { statusByParty: { a: [{ label: '固有素質', value: 'つよいきもち' }] } },
  },
  {
    id: 'item',
    label: 'どうぐ',
    content: {
      tabs: [{ label: 'つかう', action: 'use', entries: [{ label: 'ポーション', id: 'p' }] }],
    },
  },
]
const PARTY = [
  {
    id: 'a',
    name: 'アスカ',
    level: 12,
    hp: 148,
    maxHp: 230,
    mp: 31,
    maxMp: 56,
    atk: 24,
    def: 18,
    agi: 15,
    texture: null,
  },
  { id: 'b', name: 'ボブ', level: 9, hp: 80, maxHp: 120, atk: 20, def: 12, agi: 9, texture: null },
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

function open(layout: StatusLayoutKind | undefined, index: number): FieldMenuScreen {
  const s = new FieldMenuScreen({
    width: 1280,
    height: 720,
    acrylic: false,
    onClose: () => {},
    ...(layout !== undefined ? { statusLayout: layout } : {}),
  })
  s.open({
    items: ITEMS,
    party: PARTY,
    info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
    slots: [null, null, null],
  })
  s.dispatch({ type: 'tap', index })
  s.tick(10_000)
  return s
}

describe('FieldMenuScreen: ステータスの配置 (#1191)', () => {
  it('未指定と line は従来の 1 列（能力値 3 つが 1 行）で、同じ描画になる', () => {
    const none = texts(open(undefined, 0))
    const line = texts(open('line', 0))
    expect(line).toEqual(none)
    expect(line).toContain('ちから 24 まもり 18 すばやさ 15')
    expect(line).toContain('HP  148 / 230')
  })

  it('ff は能力値を行にまとめず、項目名と数字を別に出す（領域配置）。追加行も出る', () => {
    const t = texts(open('ff', 0))
    expect(t).not.toContain('ちから 24 まもり 18 すばやさ 15')
    for (const s of [
      'アスカ',
      'Lv 12',
      'HP',
      '148',
      '230',
      'MP',
      '31',
      '56',
      'ちから',
      '24',
      'まもり',
      'すばやさ',
      '固有素質',
      'つよいきもち',
    ])
      expect(t).toContain(s)
    // 前・次ボタンは従来どおり
    expect(t).toContain('◀ 前')
    expect(t).toContain('次 ▶')
  })

  it('ff でも左右の矢印（次・前）で人物が切り替わる', () => {
    const s = open('ff', 0)
    s.dispatch({ type: 'select', target: 'next', index: 0 })
    s.tick(10_000)
    const t = texts(s)
    expect(t).toContain('ボブ')
    expect(t).toContain('Lv 9')
    expect(t).not.toContain('アスカ')
    s.dispatch({ type: 'move', dx: -1, dy: 0 })
    s.tick(10_000)
    expect(texts(s)).toContain('アスカ')
  })

  it('ff はステータス以外の画面（どうぐ）の描画を変えない', () => {
    expect(texts(open('ff', 1))).toEqual(texts(open('line', 1)))
  })

  it('絵（アクスタ表示でも）は人物の枠の矩形で切り抜かれ、台座・影が枠の外へ出ない', () => {
    for (const acrylic of [false, true]) {
      const s = new FieldMenuScreen({
        width: 1280,
        height: 720,
        acrylic,
        statusLayout: 'ff',
        onClose: () => {},
      })
      s.open({
        items: ITEMS,
        party: [{ ...PARTY[0], texture: Texture.WHITE }],
        info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
        slots: [null, null, null],
      })
      s.dispatch({ type: 'tap', index: 0 })
      s.tick(10_000)
      const clip = (s as unknown as { portraitClip: Container }).portraitClip
      const deep = (s as unknown as { artDeep: Container }).artDeep
      expect(deep.children).toContain(clip)
      expect(clip.mask).toBeTruthy()
      // 切り抜きの矩形 = 左の人物の枠（右の領域・下の「戻る」にかからない幅と高さ）
      const b = (clip.mask as Container).getLocalBounds()
      expect(b.width).toBeLessThan(1280 * 0.3)
      expect(b.x).toBeGreaterThan(0)
      expect(b.y + b.height).toBeLessThan(720 * 0.9)
      expect(clip.children.length).toBeGreaterThan(1)
    }
  })

  it('アクスタ表示では絵がアクスタなしより小さく、板・台座まで含めて人物の枠に収まる', () => {
    const heights: Record<string, number> = {}
    for (const acrylic of [false, true]) {
      const s = new FieldMenuScreen({
        width: 1280,
        height: 720,
        acrylic,
        statusLayout: 'ff',
        onClose: () => {},
      })
      s.open({
        items: ITEMS,
        party: [{ ...PARTY[0], texture: Texture.WHITE }],
        info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
        slots: [null, null, null],
      })
      s.dispatch({ type: 'tap', index: 0 })
      s.tick(10_000)
      const clip = (s as unknown as { portraitClip: Container }).portraitClip
      const sp = clip.children.find((c) => c instanceof Sprite) as Sprite
      const box = (clip.mask as Container).getLocalBounds()
      // 絵の上端〜足元は枠の中
      expect(sp.y).toBeLessThanOrEqual(box.y + box.height)
      expect(sp.y - sp.height).toBeGreaterThanOrEqual(box.y - 1e-6)
      heights[String(acrylic)] = sp.height
      if (acrylic) {
        // 板・台座を含む外枠（正方形）が収まる高さ以下
        const fig = clip.children.find((c) => c !== sp && c !== clip.mask) as Container
        expect(fig.visible).toBe(true)
        const fb = fig.getLocalBounds()
        expect(fb.width * fig.scale.x).toBeLessThanOrEqual(box.width + 1e-6)
      }
    }
    expect(heights.true).toBeLessThan(heights.false)
  })
})
