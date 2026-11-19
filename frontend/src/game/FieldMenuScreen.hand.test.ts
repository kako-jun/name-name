/**
 * フィールドメニューの手（指）。
 * - 縦位置 (#1188): 指の先が行の文字の縦中心に来る（枠の中心合わせに戻ると落ちる）。
 * - 階層 (#1223): いまの階層は常時表示、確定済みの上の階層は選んだ位置に点滅で残る。戻ると常時に戻る。
 * - 間隔 (#1223): 全階層で 指の右端 = 文字（または画像・絵）の左端 − 共通の間隔。
 */
import { CanvasTextMetrics, Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HAND_FINGER_Y_RATIO } from './battleMenuLayout'
import { FieldMenuScreen, type FieldMenuPartyView } from './FieldMenuScreen'
import { computeMenuLayout, type FieldMenuItemDef } from './fieldMenu'
import {
  FIELD_HAND_BLINK_DIM_ALPHA,
  FIELD_HAND_BLINK_PERIOD_MS,
  FIELD_HAND_GAP_RATIO,
} from './fieldMenuHand'
import { emWidth } from './fieldMenuStatus'

function walk(n: Container, f: (c: Container) => void): void {
  for (const c of n.children) {
    f(c as Container)
    walk(c as Container, f)
  }
}

interface HandInfo {
  g: Graphics
  /** 手の枠（黒い縁 1px を除く） */
  left: number
  right: number
  top: number
  height: number
  /** 指の先の縦位置 */
  fingerY: number
  /** 点滅の入れ物に入っているか */
  blink: boolean
}

function hands(s: FieldMenuScreen): HandInfo[] {
  const out: HandInfo[] = []
  walk(s, (c) => {
    if (!(c instanceof Graphics) || c.eventMode !== 'none') return
    const b = c.getLocalBounds() // 黒い縁(1px)を含む
    const top = b.y + 1
    const height = b.height - 2
    out.push({
      g: c,
      left: b.x + 1,
      right: b.x + b.width - 1,
      top,
      height,
      fingerY: top + height * HAND_FINGER_Y_RATIO,
      blink: c.parent !== null && !(c.parent instanceof Graphics) && c.parent.eventMode === 'none',
    })
  })
  return out
}

function textsOf(s: FieldMenuScreen): Text[] {
  const out: Text[] = []
  walk(s, (c) => {
    if (c instanceof Text) out.push(c)
  })
  return out
}

const leftOf = (t: Text): number => t.x - t.width * t.anchor.x

const ITEMS: FieldMenuItemDef[] = [
  { id: 'status', label: 'ステータス' },
  {
    id: 'item',
    label: 'どうぐ',
    content: {
      tabs: [
        { label: 'つかう', action: 'use', entries: [{ label: 'ポーション', id: 'p' }] },
        { label: 'だいじなもの', action: 'info', entries: [{ label: 'かぎ', id: 'k' }] },
      ],
    },
  },
  {
    id: 'magic',
    label: 'まほう',
    content: {
      entriesByParty: {
        a: [{ label: 'ケアル', id: 'cure', target: 'single' }],
        b: [{ label: 'ケアル', id: 'cure', target: 'single' }],
      },
    },
  },
  {
    id: 'appstore',
    label: 'アプリストア',
    content: {
      tabs: [{ label: 'かう', entries: [{ label: 'かたな', detail: '100円', image: 'u.png' }] }],
    },
  },
  { id: 'save', label: 'セーブ' },
]
const PARTY: FieldMenuPartyView[] = [
  { id: 'a', name: 'アスカ', level: 2, hp: 148, maxHp: 230, texture: null },
  { id: 'b', name: 'ボブ', level: 5, hp: 80, maxHp: 120, texture: null },
]
const IDX = { item: 1, magic: 2, appstore: 3, save: 4 }

function open(width = 1280, height = 720): FieldMenuScreen {
  const s = new FieldMenuScreen({ width, height, acrylic: false, onClose: () => {} })
  s.open({
    items: ITEMS,
    party: PARTY,
    info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
    slots: ['埋まっている', null, null],
    images: { 'u.png': Texture.WHITE },
  })
  s.tick(10_000)
  return s
}

/** 遷移を終わらせて描き直す */
function settle(s: FieldMenuScreen): void {
  s.tick(FIELD_HAND_BLINK_PERIOD_MS * 20)
}

beforeEach(() => {
  // jsdom は canvas で字を測れない。幅を文字数の見積もりで返す（中央寄せの文字の左端を確かめるため）
  vi.spyOn(CanvasTextMetrics, 'measureText').mockImplementation(
    (text: string, style: { fontSize: number }) =>
      ({
        width: emWidth(text) * style.fontSize,
        height: style.fontSize,
      }) as unknown as CanvasTextMetrics
  )
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** 指の右端から間隔ぶん右に、同じ行の文字（指の先と縦中心がそろう）の左端がある */
function expectPointsAtText(h: HandInfo, texts: Text[], label: string): void {
  const t = texts.find((x) => x.text === label && Math.abs(x.y - h.fingerY) < 1e-6)
  expect(t, `${label} の行の文字`).toBeDefined()
  expect(h.right + h.height * FIELD_HAND_GAP_RATIO).toBeCloseTo(leftOf(t!), 5)
}

/** 指が同じ行のどの文字にも重ならない（指の右端 + 間隔 ≤ 指より右にある文字の左端） */
function expectNoOverlap(h: HandInfo, texts: Text[]): void {
  for (const t of texts) {
    const half = t.height / 2
    if (t.y + half < h.top || t.y - half > h.top + h.height) continue
    const l = leftOf(t)
    if (l + t.width <= h.left) continue
    expect(l).toBeGreaterThanOrEqual(h.right + h.height * FIELD_HAND_GAP_RATIO - 1e-6)
  }
}

describe('FieldMenuScreen: 手の縦位置 (#1188)', () => {
  it.each([
    [1280, 720],
    [390, 844],
  ])('トップの手は、指の先が選択行の文字の縦中心に来る (%i x %i)', (width, height) => {
    const s = open(width, height)
    const hs = hands(s)
    expect(hs).toHaveLength(1)
    const label = textsOf(s).find((t) => t.text === 'ステータス')
    expect(label).toBeDefined()
    expect(hs[0].fingerY).toBeCloseTo(label!.y, 5)
  })
})

describe('FieldMenuScreen: 指の階層と間隔 (#1223)', () => {
  it.each([
    [1280, 720],
    [390, 844],
  ])('トップ: 選んだ項目に常時の指 1 つ。間隔は共通 (%i x %i)', (width, height) => {
    const s = open(width, height)
    const [h] = hands(s)
    expect(h.blink).toBe(false)
    expectPointsAtText(h, textsOf(s), 'ステータス')
  })

  it('トップのパーティ枠は指の置き場を空けない（名前の位置は従来どおり）', () => {
    const s = open()
    const lay = computeMenuLayout(1280, 720, ITEMS.length, PARTY.length)
    const r = lay.partySlots[0]
    const name = textsOf(s).find((t) => t.text === 'アスカ')
    expect(name!.x).toBeCloseTo(r.x + r.h * 1.4, 5)
  })

  it('どうぐ: タブ（常時）→ 一覧（タブは点滅で残る）→ 使う相手（タブ・一覧が点滅）→ 戻ると常時に戻る', () => {
    const s = open()
    s.dispatch({ type: 'tap', index: IDX.item })
    settle(s)
    let hs = hands(s)
    expect(hs.map((h) => h.blink)).toEqual([false])
    expectPointsAtText(hs[0], textsOf(s), 'つかう')

    s.dispatch({ type: 'confirm' })
    settle(s)
    hs = hands(s)
    expect(hs.filter((h) => h.blink)).toHaveLength(1)
    expect(hs.filter((h) => !h.blink)).toHaveLength(1)
    const texts = textsOf(s)
    expectPointsAtText(hs.find((h) => h.blink)!, texts, 'つかう')
    expectPointsAtText(hs.find((h) => !h.blink)!, texts, 'ポーション')

    s.dispatch({ type: 'confirm' })
    settle(s)
    hs = hands(s)
    expect(hs.filter((h) => h.blink)).toHaveLength(2)
    const solid = hs.filter((h) => !h.blink)
    expect(solid).toHaveLength(1)
    // 使う相手の指はパーティ枠の左の置き場にあり、名前の行の縦中心を指し、枠の文字に重ならない
    const lay = computeMenuLayout(1280, 720, ITEMS.length, PARTY.length)
    const name = textsOf(s).find((t) => t.text === 'アスカ')!
    expect(solid[0].fingerY).toBeCloseTo(name.y, 5)
    expect(solid[0].left).toBeGreaterThanOrEqual(lay.base.x)
    for (const h of hs) expectNoOverlap(h, textsOf(s))

    s.dispatch({ type: 'back' })
    settle(s)
    hs = hands(s)
    expect(hs.map((h) => h.blink).sort()).toEqual([false, true])
    s.dispatch({ type: 'back' })
    settle(s)
    hs = hands(s)
    expect(hs.map((h) => h.blink)).toEqual([false])
    expectPointsAtText(hs[0], textsOf(s), 'つかう')
  })

  it('まほう: 使い手（常時）→ 一覧（使い手が点滅）→ 対象が使い手と同じ枠なら常時の指だけ', () => {
    const s = open()
    s.dispatch({ type: 'tap', index: IDX.magic })
    settle(s)
    let hs = hands(s)
    expect(hs.map((h) => h.blink)).toEqual([false])
    s.dispatch({ type: 'confirm' })
    settle(s)
    hs = hands(s)
    expect(hs.map((h) => h.blink).sort()).toEqual([false, true])
    expectPointsAtText(hs.find((h) => !h.blink)!, textsOf(s), 'ケアル')
    s.dispatch({ type: 'confirm' }) // 対象 = 使い手（0）
    settle(s)
    hs = hands(s)
    // 使い手の点滅は対象の常時と同じ場所なので出さない。一覧の点滅 + 対象の常時
    expect(hs.map((h) => h.blink).sort()).toEqual([false, true])
    s.dispatch({ type: 'move', dx: 0, dy: 1 }) // 対象 = 1
    settle(s)
    hs = hands(s)
    expect(hs.map((h) => h.blink).sort()).toEqual([false, true, true])
    for (const h of hs) expectNoOverlap(h, textsOf(s))
  })

  it('アプリストア: 画像付きの行は指が画像の左端を間隔ぶん空けて指す。確認窓は一覧・タブが点滅で残る', () => {
    const s = open()
    s.dispatch({ type: 'tap', index: IDX.appstore })
    settle(s)
    s.dispatch({ type: 'confirm' })
    settle(s)
    const thumb = (() => {
      let found: Sprite | undefined
      walk(s, (c) => {
        if (c instanceof Sprite && !(c instanceof Text) && c.texture === Texture.WHITE) found = c
      })
      return found!
    })()
    expect(thumb).toBeDefined()
    let hs = hands(s)
    const listHand = hs.find((h) => !h.blink)!
    const thumbLeft = thumb.x - thumb.width * thumb.anchor.x
    expect(listHand.right + listHand.height * FIELD_HAND_GAP_RATIO).toBeCloseTo(thumbLeft, 5)
    expectNoOverlap(listHand, textsOf(s))

    s.dispatch({ type: 'confirm' }) // 確認窓（既定「やめる」）
    settle(s)
    hs = hands(s)
    expect(hs.filter((h) => h.blink)).toHaveLength(2)
    const solid = hs.filter((h) => !h.blink)
    expect(solid).toHaveLength(1)
    expectPointsAtText(solid[0], textsOf(s), 'やめる')
  })

  it.each([
    [1280, 720],
    [390, 844],
  ])(
    'セーブ: 一覧の指（常時）→ 上書き確認で一覧が点滅、確認窓に常時 (%i x %i)',
    (width, height) => {
      const s = open(width, height)
      s.dispatch({ type: 'tap', index: IDX.save })
      settle(s)
      let hs = hands(s)
      expect(hs.map((h) => h.blink)).toEqual([false])
      expectPointsAtText(hs[0], textsOf(s), 'スロット1')
      s.dispatch({ type: 'confirm' })
      settle(s)
      hs = hands(s)
      expectPointsAtText(hs.find((h) => h.blink)!, textsOf(s), 'スロット1')
      expectPointsAtText(hs.find((h) => !h.blink)!, textsOf(s), 'いいえ')
    }
  )

  it('点滅は tick で不透明度だけ振る（常時の指は変わらない）', () => {
    const s = open()
    s.dispatch({ type: 'tap', index: IDX.item })
    settle(s)
    s.dispatch({ type: 'confirm' })
    settle(s)
    const [blinkHand] = hands(s).filter((h) => h.blink)
    const solidHand = hands(s).find((h) => !h.blink)!
    const box = blinkHand.g.parent!
    const a0 = box.alpha
    expect([1, FIELD_HAND_BLINK_DIM_ALPHA]).toContain(a0)
    s.tick(FIELD_HAND_BLINK_PERIOD_MS / 2)
    expect(box.alpha).toBe(a0 === 1 ? FIELD_HAND_BLINK_DIM_ALPHA : 1)
    // 再描画されていない（同じ入れ物のまま）
    expect(hands(s).find((h) => h.blink)!.g.parent).toBe(box)
    expect(solidHand.g.parent!.alpha).toBe(1)
    s.tick(FIELD_HAND_BLINK_PERIOD_MS / 2)
    expect(box.alpha).toBe(a0)
  })

  it('狭い画面（390x844）でも、指の置き場を空けたパーティ枠の文字は枠からはみ出さない', () => {
    const s = open(390, 844)
    s.dispatch({ type: 'tap', index: IDX.item })
    settle(s)
    s.dispatch({ type: 'confirm' })
    s.dispatch({ type: 'confirm' })
    settle(s)
    const lay = computeMenuLayout(390, 844, ITEMS.length, PARTY.length)
    // 項目画面のパーティ枠は基準面の幅の 0.3（computeScreenLayout）
    const slotRight = lay.base.x + 0.02 * lay.base.w + 0.3 * lay.base.w
    for (const label of ['アスカ', 'HP  148 / 230', 'ボブ', 'HP  80 / 120']) {
      const t = textsOf(s).find((x) => x.text === label)!
      expect(leftOf(t) + t.width).toBeLessThanOrEqual(slotRight + 1e-6)
    }
    for (const h of hands(s)) expectNoOverlap(h, textsOf(s))
  })
})
