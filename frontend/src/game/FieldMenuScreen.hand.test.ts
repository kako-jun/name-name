/**
 * フィールドメニューの手（指）。
 * - 縦位置 (#1188): 指の先が行の文字の縦中心に来る（枠の中心合わせに戻ると落ちる）。
 * - 階層 (#1223): いまの階層は常時表示、確定済みの上の階層は選んだ位置に点滅で残る。戻ると常時に戻る。
 * - 間隔 (#1223): 全階層で 指の右端 = 文字（または画像・絵）の左端 − 共通の間隔。
 */
import {
  CanvasTextMetrics,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
  TextureSource,
} from 'pixi.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HAND_FINGER_Y_RATIO } from './battleMenuLayout'
import { FieldMenuScreen, type FieldMenuPartyView } from './FieldMenuScreen'
import { computeMenuLayout, type FieldMenuItemDef } from './fieldMenu'
import { computeScreenLayout } from './fieldMenuScreens'
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

  it.each([
    [1280, 720],
    [390, 844],
  ])(
    '長いラベルのタブでも、指と文字はタブの矩形に収まり指と文字の間隔を守る (%i x %i)',
    (width, height) => {
      const longLabel = 'たいせつなもの・ながいラベルのタブ'
      const items: FieldMenuItemDef[] = [
        {
          id: 'item',
          label: 'どうぐ',
          content: {
            tabs: [
              { label: 'つかう', action: 'use', entries: [{ label: 'ポーション', id: 'p' }] },
              { label: longLabel, action: 'info', entries: [{ label: 'かぎ', id: 'k' }] },
              { label: 'すてる', action: 'info', entries: [{ label: 'ごみ', id: 'g' }] },
            ],
          },
        },
      ]
      const s = new FieldMenuScreen({ width, height, acrylic: false, onClose: () => {} })
      s.open({
        items,
        party: PARTY,
        info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
        slots: [null, null, null],
        images: {},
      })
      s.tick(10_000)
      s.dispatch({ type: 'tap', index: 0 })
      settle(s)
      s.dispatch({ type: 'move', dx: 1, dy: 0 }) // 長いラベルのタブへ
      settle(s)
      const top = computeMenuLayout(width, height, items.length, PARTY.length)
      const sl = computeScreenLayout({
        kind: 'item',
        base: top.base,
        partyCount: PARTY.length,
        tabCount: 3,
        listCount: 1,
        cursor: 0,
        reserveTimer: false,
        confirmOpen: false,
      })
      const rect = sl.tabs[1]
      const hs = hands(s)
      expect(hs).toHaveLength(1)
      const h = hs[0]
      const t = textsOf(s).find((x) => x.text === longLabel)!
      expect(t).toBeDefined()
      expect(h.right + h.height * FIELD_HAND_GAP_RATIO).toBeLessThanOrEqual(leftOf(t) + 1e-6)
      expect(h.left).toBeGreaterThanOrEqual(rect.x - 1e-6)
      expect(leftOf(t) + t.width).toBeLessThanOrEqual(rect.x + rect.w + 1e-6)
    }
  )

  it('項目画面のパーティ枠の名前の文字は、トップと同じ枠内位置のまま（絵だけが小さくなり文字は動かない）', () => {
    const s = open()
    const topName = textsOf(s).find((t) => t.text === 'アスカ')!
    const topLay = computeMenuLayout(1280, 720, ITEMS.length, PARTY.length)
    const topOffset = (topName.x - topLay.partySlots[0].x) / topLay.partySlots[0].h
    s.dispatch({ type: 'tap', index: IDX.item })
    settle(s)
    s.dispatch({ type: 'confirm' })
    s.dispatch({ type: 'confirm' })
    settle(s)
    const sl = computeScreenLayout({
      kind: 'item',
      base: topLay.base,
      partyCount: PARTY.length,
      tabCount: 2,
      listCount: 1,
      cursor: 0,
      reserveTimer: false,
      confirmOpen: false,
    })
    const name = textsOf(s).find((t) => t.text === 'アスカ')!
    const slot = sl.party[0]
    expect((name.x - slot.x) / slot.h).toBeCloseTo(topOffset, 5)
  })
})

describe('FieldMenuScreen: 指と実際の絵の間隔・各画面・空 (#1223)', () => {
  function openWith(
    items: FieldMenuItemDef[],
    party: FieldMenuPartyView[],
    images: Record<string, Texture | null> = {}
  ): FieldMenuScreen {
    const s = new FieldMenuScreen({ width: 1280, height: 720, acrylic: false, onClose: () => {} })
    s.open({
      items,
      party,
      info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
      slots: ['埋まっている', null, null],
      images,
    })
    s.tick(10_000)
    return s
  }

  /** 縦長・横長の絵（縦横比 1:4 / 4:1）。1 辺 1px のテクスチャでは縦横比の差が出ない */
  const tall = new Texture({ source: new TextureSource({ width: 20, height: 80 }) })
  const wide = new Texture({ source: new TextureSource({ width: 80, height: 20 }) })

  function spriteOf(s: FieldMenuScreen, tex: Texture): Sprite {
    let found: Sprite | undefined
    walk(s, (c) => {
      if (c instanceof Sprite && !(c instanceof Text) && c.texture === tex) found = c
    })
    expect(found, '絵のスプライト').toBeDefined()
    return found!
  }

  it.each([
    ['縦長', tall],
    ['横長', wide],
  ])(
    'パーティ枠の指と実際に置かれた絵（%s）の左端の間隔は FIELD_HAND_GAP_RATIO で一定',
    (_n, tex) => {
      const party = PARTY.map((p) => ({ ...p, texture: tex }))
      const s = openWith(ITEMS, party)
      s.dispatch({ type: 'tap', index: IDX.item })
      settle(s)
      s.dispatch({ type: 'confirm' })
      s.dispatch({ type: 'confirm' }) // 使う相手 = アスカ
      settle(s)
      const solid = hands(s).find((h) => !h.blink)!
      const sp = spriteOf(s, tex)
      const artLeft = sp.x - sp.width * sp.anchor.x
      expect(solid.right + solid.height * FIELD_HAND_GAP_RATIO).toBeCloseTo(artLeft, 5)
    }
  )

  it('縦長の絵でも、指の左端は枠の中（絵が箱の中央に寄っても指が枠の外へ出ない）', () => {
    const s = openWith(
      ITEMS,
      PARTY.map((p) => ({ ...p, texture: tall }))
    )
    s.dispatch({ type: 'tap', index: IDX.item })
    settle(s)
    s.dispatch({ type: 'confirm' })
    s.dispatch({ type: 'confirm' })
    settle(s)
    const lay = computeMenuLayout(1280, 720, ITEMS.length, PARTY.length)
    const sl = computeScreenLayout({
      kind: 'item',
      base: lay.base,
      partyCount: PARTY.length,
      tabCount: 2,
      listCount: 1,
      cursor: 0,
      reserveTimer: false,
      confirmOpen: false,
    })
    const solid = hands(s).find((h) => !h.blink)!
    expect(solid.left).toBeGreaterThanOrEqual(sl.party[0].x - 1e-6)
  })

  const SCREENS: FieldMenuItemDef[] = [
    {
      id: 'equip',
      label: 'そうび',
      content: {
        entriesByParty: {
          a: [{ label: 'かたな', id: 'k' }],
          b: [{ label: 'かたな', id: 'k' }],
        },
      },
    },
    { id: 'load', label: 'ロード' },
    {
      id: 'config',
      label: 'せってい',
      content: { options: [{ key: 'bgm', label: 'BGM', choices: ['あり', 'なし'] }] },
    },
    { id: 'empty', label: 'からっぽ' },
  ]

  it.each([
    ['equip', 0, 'アスカ'],
    ['load', 1, 'スロット1'],
    ['config', 2, 'BGM'],
    ['empty', 3, ''],
  ])('%s: 画面を開くと最初の階層の常時の指が 1 つ出る', (_id, idx, label) => {
    const s = openWith(SCREENS, PARTY)
    s.dispatch({ type: 'tap', index: idx })
    settle(s)
    const hs = hands(s)
    if (label === '') {
      // 何も無い画面は指を出さない（落ちない）
      expect(hs.map((h) => h.blink)).toEqual([])
    } else {
      expect(hs.map((h) => h.blink)).toEqual([false])
      if (label !== 'アスカ') expectPointsAtText(hs[0], textsOf(s), label)
    }
  })

  it('そうび: 人物 → 一覧に進むと、人物の指は点滅で残り一覧に常時の指が出る', () => {
    const s = openWith(SCREENS, PARTY)
    s.dispatch({ type: 'tap', index: 0 })
    settle(s)
    s.dispatch({ type: 'confirm' })
    settle(s)
    const hs = hands(s)
    expect(hs.map((h) => h.blink).sort()).toEqual([false, true])
    expectPointsAtText(hs.find((h) => !h.blink)!, textsOf(s), 'かたな')
  })

  it('パーティ 0 人でもどうぐ・まほう・そうびの画面は落ちず、人物の指は出ない', () => {
    const s = openWith([...ITEMS, ...SCREENS.slice(0, 1)], [])
    // どうぐは最初の階層がタブなのでタブの指だけ。まほう・そうびは最初の階層が人物なので指は 0
    for (const [idx, count] of [
      [IDX.item, 1],
      [IDX.magic, 0],
      [ITEMS.length, 0],
    ]) {
      s.dispatch({ type: 'tap', index: idx })
      settle(s)
      expect(hands(s)).toHaveLength(count)
      s.dispatch({ type: 'back' })
      settle(s)
    }
  })

  it('タブが空の定義は既定のタブになり（タブ 0 個の画面は作られない）、指は既定の最初のタブを指す', () => {
    const items: FieldMenuItemDef[] = [
      { id: 'item', label: 'どうぐ', content: { tabs: [] } },
      { id: 'appstore', label: 'アプリストア', content: { tabs: [] } },
    ]
    const s = openWith(items, PARTY)
    for (const [idx, label] of [
      [0, 'つかう'],
      [1, '刀'],
    ] as const) {
      s.dispatch({ type: 'tap', index: idx })
      settle(s)
      const hs = hands(s)
      expect(hs).toHaveLength(1)
      expectPointsAtText(hs[0], textsOf(s), label)
      s.dispatch({ type: 'back' })
      settle(s)
    }
  })

  it('指の列（階層）が変わったら点滅の位相を 0 に戻す（確定した指が薄い位相で始まらない）', () => {
    const s = openWith(ITEMS, PARTY)
    s.dispatch({ type: 'tap', index: IDX.item })
    settle(s)
    s.dispatch({ type: 'confirm' }) // タブ → 一覧
    settle(s)
    s.tick(FIELD_HAND_BLINK_PERIOD_MS * 0.75) // 薄い位相
    s.dispatch({ type: 'confirm' }) // 一覧 → 使う相手
    s.tick(1)
    const box = hands(s).find((h) => h.blink)!.g.parent!
    expect(box.alpha).toBe(1)
  })
})
