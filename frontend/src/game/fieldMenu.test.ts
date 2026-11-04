/**
 * 一枚絵フィールドの全画面メニュー (#880) の計算部（fieldMenu.ts）のテスト。
 * 観点: 設定のパース（正常/不正）、項目の有効判定、開閉可否、最上位の状態遷移（1タップ決定・灰色項目・回り込み）、
 * キー割当、情報帯、レイアウト（9項目超・予約領域・不正寸法）、≡ ボタンの最小サイズ。
 */
import { describe, expect, it } from 'vitest'
import {
  CLOSED_MENU,
  DEFAULT_DISABLED_REASON,
  DEFAULT_FIELD_MENU_ITEMS,
  MENU_BACK_LABEL,
  MENU_HINT_SCREEN,
  MENU_HINT_TOP,
  MENU_LAYOUT,
  canOpenMenu,
  computeMenuButtonRect,
  computeMenuLayout,
  formatInfoBand,
  isMenuOpenKey,
  itemRowAt,
  menuHint,
  menuKeyEvent,
  openMenuState,
  parseFieldMenuConfig,
  pointInRect,
  resolveMenuItems,
  screenKindOfItem,
  stepFieldMenu,
  type FieldMenuCtx,
  type FieldMenuItemDef,
  type FieldMenuState,
} from './fieldMenu'
import { defaultScreenKind, resolveContent } from './fieldMenuScreens'
import { TIME_LIMIT_AREA } from './fieldTimeLimit'

function ctxFor(
  defs: readonly FieldMenuItemDef[] = DEFAULT_FIELD_MENU_ITEMS,
  opts: { timeLimited?: boolean; partyCount?: number; slotFilled?: boolean[] } = {}
): FieldMenuCtx {
  const contents: FieldMenuCtx['contents'] = Object.fromEntries(
    defs.map((d) => [d.id, resolveContent(d.label, screenKindOfItem(d), d.content)])
  )
  return {
    items: resolveMenuItems(defs, { timeLimited: opts.timeLimited ?? false }),
    contents,
    partyCount: opts.partyCount ?? 2,
    slotFilled: opts.slotFilled ?? [false, false, false],
  }
}
const open = (cursor = 0): FieldMenuState =>
  ({ ...(openMenuState() as object), cursor }) as FieldMenuState
const itemIndex = (id: string): number => DEFAULT_FIELD_MENU_ITEMS.findIndex((d) => d.id === id)

describe('parseFieldMenuConfig', () => {
  it.each([[undefined], [false], [null]])(
    '未指定/false/null（%s）はメニュー無し・警告なし',
    (raw) => {
      expect(parseFieldMenuConfig(raw)).toEqual({ warnings: [] })
    }
  )

  it.each([[true], [{}]])('%j は既定の9項目', (raw) => {
    const r = parseFieldMenuConfig(raw)
    expect(r.warnings).toEqual([])
    expect(r.value?.items.map((i) => i.id)).toEqual(DEFAULT_FIELD_MENU_ITEMS.map((i) => i.id))
    expect(r.value?.items).toHaveLength(9)
    expect(r.value?.transition).toEqual({ textOutMs: 80, slideMs: 140, textInMs: 80 })
  })

  it('既定項目は複製（呼び出し側の書き換えが定数を汚さない）', () => {
    const r = parseFieldMenuConfig(true)
    r.value!.items[0].label = 'X'
    expect(DEFAULT_FIELD_MENU_ITEMS[0].label).toBe('どうぐ')
  })

  it.each([['str'], [5], [[1]]])(
    '真偽でもオブジェクトでもない値（%j）は警告してメニュー無し',
    (raw) => {
      const r = parseFieldMenuConfig(raw)
      expect(r.value).toBeUndefined()
      expect(r.warnings.length).toBeGreaterThan(0)
    }
  )

  it('items を書くと一覧が差し替わり、任意項目を保つ', () => {
    const r = parseFieldMenuConfig({
      items: [
        { id: 'a', label: 'A', enabled: false, disabledReason: '理由' },
        {
          id: 'save',
          label: 'セーブ',
          blockedWhileTimed: true,
          timedReason: '止',
          kind: 'save',
        },
      ],
    })
    expect(r.warnings).toEqual([])
    expect(r.value?.items).toEqual([
      { id: 'a', label: 'A', enabled: false, disabledReason: '理由' },
      { id: 'save', label: 'セーブ', blockedWhileTimed: true, timedReason: '止', kind: 'save' },
    ])
  })

  it('items が配列でないと警告して既定へ', () => {
    const r = parseFieldMenuConfig({ items: 'x' })
    expect(r.warnings).toHaveLength(1)
    expect(r.value?.items).toHaveLength(9)
  })

  it('不正な項目（id/label 欠落・空文字・非オブジェクト）は警告して省く', () => {
    const r = parseFieldMenuConfig({
      items: [
        { id: 'ok', label: 'OK' },
        { id: 'x' },
        { label: 'y' },
        { id: '', label: 'z' },
        3,
        null,
      ],
    })
    expect(r.value?.items.map((i) => i.id)).toEqual(['ok'])
    expect(r.warnings).toHaveLength(5)
  })

  it('重複 id は後のものを省いて警告', () => {
    const r = parseFieldMenuConfig({
      items: [
        { id: 'a', label: 'A1' },
        { id: 'a', label: 'A2' },
      ],
    })
    expect(r.value?.items).toEqual([{ id: 'a', label: 'A1' }])
    expect(r.warnings.some((w) => w.includes('重複'))).toBe(true)
  })

  it('有効な項目が1つもなければ警告して既定へ戻す', () => {
    const r = parseFieldMenuConfig({ items: [{ id: 1 }] })
    expect(r.value?.items).toHaveLength(9)
    expect(r.warnings.some((w) => w.includes('既定'))).toBe(true)
  })

  it('items: []（空配列）も既定へ戻す', () => {
    const r = parseFieldMenuConfig({ items: [] })
    expect(r.value?.items).toHaveLength(9)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('未知の kind は警告して無視（項目は残る）', () => {
    const r = parseFieldMenuConfig({ items: [{ id: 'a', label: 'A', kind: 'bogus' }] })
    expect(r.value?.items).toEqual([{ id: 'a', label: 'A' }])
    expect(r.warnings).toHaveLength(1)
  })

  it('enabled が false 以外（true / 文字列）は無視、空の理由は無視', () => {
    const r = parseFieldMenuConfig({
      items: [{ id: 'a', label: 'A', enabled: true, disabledReason: '', blockedWhileTimed: 'yes' }],
    })
    expect(r.value?.items).toEqual([{ id: 'a', label: 'A' }])
  })

  it('content の不正は警告に出る（項目は残る）', () => {
    const r = parseFieldMenuConfig({ items: [{ id: 'a', label: 'A', content: 5 }] })
    expect(r.value?.items).toEqual([{ id: 'a', label: 'A' }])
    expect(r.warnings.some((w) => w.includes('menu.items[0].content'))).toBe(true)
  })

  it('transition: オブジェクト・none・不正が反映/警告される', () => {
    expect(parseFieldMenuConfig({ transition: { slideMs: 10 } }).value?.transition).toEqual({
      textOutMs: 80,
      slideMs: 10,
      textInMs: 80,
    })
    expect(parseFieldMenuConfig({ transition: 'none' }).value?.transition).toEqual({
      textOutMs: 0,
      slideMs: 0,
      textInMs: 0,
    })
    const bad = parseFieldMenuConfig({ transition: { slideMs: -1 } })
    expect(bad.warnings).toHaveLength(1)
    expect(bad.value?.transition.slideMs).toBe(140)
  })
})

describe('resolveMenuItems', () => {
  it('既定は全項目が有効（時間制限なし）', () => {
    const v = resolveMenuItems(DEFAULT_FIELD_MENU_ITEMS, { timeLimited: false })
    expect(v.every((x) => x.enabled && x.reason === null)).toBe(true)
  })
  it('enabled:false は灰色・理由は指定 or 既定', () => {
    const v = resolveMenuItems(
      [
        { id: 'a', label: 'A', enabled: false },
        { id: 'b', label: 'B', enabled: false, disabledReason: 'わけ' },
      ],
      { timeLimited: false }
    )
    expect(v[0]).toMatchObject({ enabled: false, reason: DEFAULT_DISABLED_REASON })
    expect(v[1]).toMatchObject({ enabled: false, reason: 'わけ' })
  })
  it('時間制限中は blockedWhileTimed の項目だけ灰色（セーブ禁止）', () => {
    const v = resolveMenuItems(DEFAULT_FIELD_MENU_ITEMS, { timeLimited: true })
    const off = v.filter((x) => !x.enabled).map((x) => x.id)
    expect(off).toEqual(['save'])
    expect(v[itemIndex('save')].reason).toBe('時間制限中はセーブできません')
  })
  it('timedReason 未指定は label から作る', () => {
    const v = resolveMenuItems([{ id: 'a', label: 'A', blockedWhileTimed: true }], {
      timeLimited: true,
    })
    expect(v[0].reason).toBe('「A」は時間制限中は使えません')
  })
  it('enabled:false が時間制限より優先（理由は disabledReason）', () => {
    const v = resolveMenuItems(
      [
        {
          id: 'a',
          label: 'A',
          enabled: false,
          disabledReason: 'D',
          blockedWhileTimed: true,
          timedReason: 'T',
        },
      ],
      { timeLimited: true }
    )
    expect(v[0].reason).toBe('D')
  })
})

describe('canOpenMenu', () => {
  const idle = {
    battle: false,
    battleTransition: false,
    talking: false,
    transition: false,
    warp: false,
  }
  it('何も起きていなければ開ける', () => {
    expect(canOpenMenu(idle)).toBe(true)
  })
  it.each(['battle', 'battleTransition', 'talking', 'transition', 'warp'] as const)(
    '%s 中は開けない',
    (k) => {
      expect(canOpenMenu({ ...idle, [k]: true })).toBe(false)
    }
  )
})

describe('stepFieldMenu（最上位）', () => {
  it('閉じているときは何も起きない', () => {
    const r = stepFieldMenu(CLOSED_MENU, { type: 'confirm' }, ctxFor())
    expect(r).toEqual({ state: CLOSED_MENU, effect: 'none' })
  })

  it('openMenuState は最上位・カーソル0・通知なし・設定を引き継ぐ', () => {
    expect(openMenuState({ bgm: 2 })).toEqual({
      open: true,
      screen: 'top',
      cursor: 0,
      notice: null,
      nav: null,
      settings: { bgm: 2 },
    })
  })

  it('上下移動でカーソルが動き、端で回り込む', () => {
    const c = ctxFor()
    const up = stepFieldMenu(open(0), { type: 'move', dx: 0, dy: -1 }, c)
    expect(up.effect).toBe('moved')
    expect((up.state as { cursor: number }).cursor).toBe(8)
    const down = stepFieldMenu(open(8), { type: 'move', dx: 0, dy: 1 }, c)
    expect((down.state as { cursor: number }).cursor).toBe(0)
  })

  it('左右・dy=0 の移動は無視（最上位は上下だけ）', () => {
    const r = stepFieldMenu(open(3), { type: 'move', dx: 1, dy: 0 }, ctxFor())
    expect(r.effect).toBe('none')
    expect((r.state as { cursor: number }).cursor).toBe(3)
  })

  it('移動で通知が消える', () => {
    const s = { ...open(0), notice: 'x' } as FieldMenuState
    const r = stepFieldMenu(s, { type: 'move', dx: 0, dy: 1 }, ctxFor())
    expect((r.state as { notice: string | null }).notice).toBeNull()
  })

  it('1タップで項目画面が開く（カーソルも移る）', () => {
    const i = itemIndex('equip')
    const r = stepFieldMenu(open(0), { type: 'tap', index: i }, ctxFor())
    expect(r.effect).toBe('opened-screen')
    expect(r.state).toMatchObject({ open: true, screen: 'equip', cursor: i })
    expect((r.state as { nav: unknown }).nav).toMatchObject({ focus: 'party' })
  })

  it('決定キーで現カーソルの項目を開く。画面種ごとの初期フォーカス', () => {
    const r = stepFieldMenu(open(itemIndex('item')), { type: 'confirm' }, ctxFor())
    expect(r.state).toMatchObject({ screen: 'item', nav: { focus: 'tab' } })
    const r2 = stepFieldMenu(open(itemIndex('config')), { type: 'confirm' }, ctxFor())
    expect(r2.state).toMatchObject({ screen: 'config', nav: { focus: 'list' } })
  })

  it('灰色項目の決定は拒否され、理由が通知に出る（画面は開かない）', () => {
    const defs: FieldMenuItemDef[] = [
      { id: 'a', label: 'A', enabled: false, disabledReason: 'ナイショ' },
    ]
    const r = stepFieldMenu(open(0), { type: 'tap', index: 0 }, ctxFor(defs))
    expect(r.effect).toBe('refused')
    expect(r.state).toMatchObject({ screen: 'top', notice: 'ナイショ' })
  })

  it('時間制限中のセーブは拒否され理由が出る。時間制限なしなら開ける', () => {
    const i = itemIndex('save')
    const limited = stepFieldMenu(
      open(i),
      { type: 'confirm' },
      ctxFor(undefined, { timeLimited: true })
    )
    expect(limited.effect).toBe('refused')
    expect(limited.state).toMatchObject({ screen: 'top', notice: '時間制限中はセーブできません' })
    const free = stepFieldMenu(open(i), { type: 'confirm' }, ctxFor())
    expect(free.effect).toBe('opened-screen')
  })

  it('拒否後に次の入力で通知が消える', () => {
    const defs: FieldMenuItemDef[] = [
      { id: 'a', label: 'A', enabled: false },
      { id: 'b', label: 'B' },
    ]
    const c = ctxFor(defs)
    const r1 = stepFieldMenu(open(0), { type: 'confirm' }, c)
    expect((r1.state as { notice: string }).notice).toBe(DEFAULT_DISABLED_REASON)
    const r2 = stepFieldMenu(r1.state, { type: 'move', dx: 0, dy: 1 }, c)
    expect((r2.state as { notice: string | null }).notice).toBeNull()
  })

  it.each([[-1], [9], [1.5], [NaN]])('範囲外/非整数のタップ index（%s）は無視', (index) => {
    const r = stepFieldMenu(open(2), { type: 'tap', index }, ctxFor())
    expect(r.effect).toBe('none')
    expect((r.state as { cursor: number }).cursor).toBe(2)
  })

  it('最上位で戻ると閉じる', () => {
    const r = stepFieldMenu(open(4), { type: 'back' }, ctxFor())
    expect(r).toEqual({ state: CLOSED_MENU, effect: 'closed' })
  })

  it('最上位の select は無視', () => {
    const r = stepFieldMenu(open(0), { type: 'select', target: 'list', index: 0 }, ctxFor())
    expect(r.effect).toBe('none')
  })

  it('項目0件では移動も決定も何も起きない', () => {
    const c: FieldMenuCtx = { items: [], contents: {}, partyCount: 0, slotFilled: [] }
    for (const ev of [
      { type: 'move', dx: 0, dy: 1 },
      { type: 'confirm' },
      { type: 'tap', index: 0 },
    ] as const) {
      expect(stepFieldMenu(open(0), ev, c).effect).toBe('none')
    }
  })

  it('content が無い項目（定義側が足した未知 id）は empty として開く', () => {
    const c = ctxFor([{ id: 'zzz', label: 'Z' }])
    const r = stepFieldMenu(open(0), { type: 'confirm' }, c)
    expect(r.state).toMatchObject({ screen: 'zzz', nav: { focus: 'list' } })
  })
})

describe('stepFieldMenu（項目画面の中）', () => {
  it('戻るは1階層ずつ: 確認窓 → 一覧 → 最初の階層 → 最上位 → 閉じる', () => {
    const defs: FieldMenuItemDef[] = [
      {
        id: 'appstore',
        label: 'ストア',
        content: { tabs: [{ label: 'T', entries: [{ label: '刀' }] }] },
      },
    ]
    const c = ctxFor(defs)
    let s = stepFieldMenu(open(0), { type: 'confirm' }, c).state // appstore, focus tab
    s = stepFieldMenu(s, { type: 'confirm' }, c).state // tab -> list
    s = stepFieldMenu(s, { type: 'confirm' }, c).state // list -> confirm 窓
    expect((s as { nav: { focus: string } }).nav.focus).toBe('confirm')
    s = stepFieldMenu(s, { type: 'back' }, c).state
    expect((s as { nav: { focus: string } }).nav.focus).toBe('list')
    s = stepFieldMenu(s, { type: 'back' }, c).state
    expect((s as { nav: { focus: string } }).nav.focus).toBe('tab')
    const toTop = stepFieldMenu(s, { type: 'back' }, c)
    expect(toTop.effect).toBe('back-to-top')
    expect(toTop.state).toMatchObject({ screen: 'top', nav: null, cursor: 0 })
    expect(stepFieldMenu(toTop.state, { type: 'back' }, c).effect).toBe('closed')
  })

  it('項目画面から戻っても最上位のカーソル位置を保つ', () => {
    const i = itemIndex('config')
    const c = ctxFor()
    const opened = stepFieldMenu(open(0), { type: 'tap', index: i }, c).state
    const back = stepFieldMenu(opened, { type: 'back' }, c)
    expect(back.state).toMatchObject({ screen: 'top', cursor: i })
  })

  it('せってい: 決定で値が進み、setting が返り、state.settings に保たれる', () => {
    const c = ctxFor()
    const s0 = stepFieldMenu(open(itemIndex('config')), { type: 'confirm' }, c).state
    const r = stepFieldMenu(s0, { type: 'confirm' }, c)
    expect(r.effect).toBe('setting')
    expect(r.setting).toEqual({ key: 'battleMode', value: 1 })
    expect((r.state as { settings: Record<string, number> }).settings).toEqual({ battleMode: 1 })
  })

  it('せってい: 開き直しても settings を持ち越せる（openMenuState に渡す）', () => {
    const c = ctxFor()
    const s = { ...openMenuState({ battleMode: 1 }), cursor: itemIndex('config') } as FieldMenuState
    const s0 = stepFieldMenu(s, { type: 'confirm' }, c).state
    const r = stepFieldMenu(s0, { type: 'confirm' }, c)
    expect(r.setting).toEqual({ key: 'battleMode', value: 0 })
  })

  it('セーブ: 空スロットは1タップで save、埋まっていれば上書き確認 → はいで save', () => {
    const c = ctxFor(undefined, { slotFilled: [false, true, false] })
    const s0 = stepFieldMenu(open(itemIndex('save')), { type: 'confirm' }, c).state
    const empty = stepFieldMenu(s0, { type: 'tap', index: 0 }, c)
    expect(empty.effect).toBe('save')
    expect(empty.save).toBe(0)
    const filled = stepFieldMenu(s0, { type: 'tap', index: 1 }, c)
    expect(filled.effect).toBe('moved')
    expect(filled.state).toMatchObject({ nav: { focus: 'confirm', confirm: 1 } })
    const no = stepFieldMenu(filled.state, { type: 'confirm' }, c)
    expect(no.effect).toBe('moved')
    expect(no.save).toBeUndefined()
    const yes = stepFieldMenu(filled.state, { type: 'select', target: 'confirm', index: 0 }, c)
    expect(yes.effect).toBe('save')
    expect(yes.save).toBe(1)
  })

  it('中身が無い（未知の画面）状態では戻るだけ受ける', () => {
    const c = ctxFor()
    const weird = { ...open(0), screen: 'ghost', nav: null } as FieldMenuState
    expect(stepFieldMenu(weird, { type: 'confirm' }, c).effect).toBe('none')
    const b = stepFieldMenu(weird, { type: 'back' }, c)
    expect(b.effect).toBe('back-to-top')
    expect(b.state).toMatchObject({ screen: 'top', nav: null })
  })

  it('項目画面内の tap は list の select として扱う', () => {
    const defs: FieldMenuItemDef[] = [
      {
        id: 'magic',
        label: 'まほう',
        content: { entries: [{ label: 'ヒール', description: '回復' }] },
      },
    ]
    const c = ctxFor(defs)
    let s = stepFieldMenu(open(0), { type: 'confirm' }, c).state // party focus
    s = stepFieldMenu(s, { type: 'confirm' }, c).state // party -> list
    const r = stepFieldMenu(s, { type: 'tap', index: 0 }, c)
    expect(r.effect).toBe('notice')
    expect((r.state as { notice: string }).notice).toBe('回復')
  })
})

describe('キー割当', () => {
  it('開くキーは Esc / X / M', () => {
    expect(isMenuOpenKey('Escape')).toBe(true)
    expect(isMenuOpenKey('KeyX')).toBe(true)
    expect(isMenuOpenKey('KeyM')).toBe(true)
    expect(isMenuOpenKey('KeyZ')).toBe(false)
    expect(isMenuOpenKey('Enter')).toBe(false)
  })
  it('メニュー内で M は無効（開く専用）', () => {
    expect(menuKeyEvent('KeyM')).toBeNull()
  })
  it('メニュー内の X / Esc は戻る、Z / Enter / Space は決定', () => {
    expect(menuKeyEvent('KeyX')).toEqual({ type: 'back' })
    expect(menuKeyEvent('Escape')).toEqual({ type: 'back' })
    for (const k of ['KeyZ', 'Enter', 'Space']) expect(menuKeyEvent(k)).toEqual({ type: 'confirm' })
  })
  it('矢印と WASD は移動', () => {
    expect(menuKeyEvent('ArrowUp')).toEqual({ type: 'move', dx: 0, dy: -1 })
    expect(menuKeyEvent('KeyW')).toEqual({ type: 'move', dx: 0, dy: -1 })
    expect(menuKeyEvent('ArrowDown')).toEqual({ type: 'move', dx: 0, dy: 1 })
    expect(menuKeyEvent('KeyS')).toEqual({ type: 'move', dx: 0, dy: 1 })
    expect(menuKeyEvent('ArrowLeft')).toEqual({ type: 'move', dx: -1, dy: 0 })
    expect(menuKeyEvent('KeyA')).toEqual({ type: 'move', dx: -1, dy: 0 })
    expect(menuKeyEvent('ArrowRight')).toEqual({ type: 'move', dx: 1, dy: 0 })
    expect(menuKeyEvent('KeyD')).toEqual({ type: 'move', dx: 1, dy: 0 })
  })
  it('対象外のキーは null', () => {
    expect(menuKeyEvent('KeyQ')).toBeNull()
    expect(menuKeyEvent('')).toBeNull()
  })
})

describe('案内と情報帯', () => {
  it('最上位と項目画面で案内が変わり、どちらにも戻る操作が書かれている', () => {
    expect(menuHint(openMenuState())).toBe(MENU_HINT_TOP)
    expect(menuHint({ ...openMenuState(), screen: 'item' } as FieldMenuState)).toBe(
      MENU_HINT_SCREEN
    )
    expect(menuHint(CLOSED_MENU)).toBe(MENU_HINT_TOP)
    expect(MENU_HINT_TOP).toContain('Esc')
    expect(MENU_HINT_SCREEN).toContain('Esc')
    expect(MENU_BACK_LABEL).toContain('戻る')
  })

  it('formatInfoBand: 現在地・円・プレイ時間・歩数を常に出す', () => {
    expect(formatInfoBand({ place: '寺町', gold: 1200, playMs: 65_000, steps: 1234 })).toBe(
      '現在地 寺町  |  円 1,200  |  時間 01:05  |  歩数 1,234'
    )
  })
  it('formatInfoBand: 時間制限の有無に依らずプレイ時間の欄（残り時間とは入れ替わらない）', () => {
    const s = formatInfoBand({ place: 'A', gold: 0, playMs: 3_725_000, steps: 0 })
    expect(s).toContain('時間 1:02:05')
    expect(s).not.toContain('残り')
  })
  it('formatInfoBand: 負・NaN・Infinity・小数は 0 以上の整数へ', () => {
    const s = formatInfoBand({ place: 'A', gold: -5, playMs: NaN, steps: 12.9 })
    expect(s).toBe('現在地 A  |  円 0  |  時間 00:00  |  歩数 12')
    expect(formatInfoBand({ place: 'A', gold: Infinity, playMs: 0, steps: 0 })).toContain('円 0')
  })
})

describe('computeMenuLayout', () => {
  const within = (r: { x: number; y: number; w: number; h: number }, b: typeof r): boolean =>
    r.x >= b.x - 1e-6 &&
    r.y >= b.y - 1e-6 &&
    r.x + r.w <= b.x + b.w + 1e-6 &&
    r.y + r.h <= b.y + b.h + 1e-6

  it('基準面は 16:9 で画面に収まり、中央に置かれる（横長・縦長）', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1000, 1000],
      [800, 1600],
    ]) {
      const l = computeMenuLayout(w, h, 9, 4)
      expect(l.base.w / l.base.h).toBeCloseTo(16 / 9, 5)
      expect(within(l.base, { x: 0, y: 0, w, h })).toBe(true)
      expect(l.base.x * 2 + l.base.w).toBeCloseTo(w, 5)
      expect(l.base.y * 2 + l.base.h).toBeCloseTo(h, 5)
    }
  })

  it('9項目・4人: 全矩形が基準面に収まり、項目行は窓の中で重ならない', () => {
    const l = computeMenuLayout(1600, 900, 9, 4)
    expect(l.itemRows).toHaveLength(9)
    expect(l.partySlots).toHaveLength(4)
    for (const r of [...l.itemRows, ...l.partySlots, l.itemWindow, l.band, l.backButton])
      expect(within(r, l.base)).toBe(true)
    for (const r of l.itemRows) expect(within(r, l.itemWindow)).toBe(true)
    for (let i = 1; i < l.itemRows.length; i++)
      expect(l.itemRows[i].y).toBeGreaterThanOrEqual(
        l.itemRows[i - 1].y + l.itemRows[i - 1].h - 1e-6
      )
  })

  it('9項目超では行高を縮めて窓に収める。9項目以下は規定の行高', () => {
    const l9 = computeMenuLayout(1600, 900, 9, 4)
    const l20 = computeMenuLayout(1600, 900, 20, 4)
    expect(l9.itemRows[0].h).toBeCloseTo(MENU_LAYOUT.items.rowH * l9.base.h, 5)
    expect(l20.itemRows).toHaveLength(20)
    expect(l20.itemRows[0].h).toBeLessThan(l9.itemRows[0].h)
    for (const r of l20.itemRows) expect(within(r, l20.itemWindow)).toBe(true)
  })

  it('パーティ枠は最大4つ。人数 0 でも落ちない', () => {
    expect(computeMenuLayout(1600, 900, 9, 10).partySlots).toHaveLength(4)
    expect(computeMenuLayout(1600, 900, 9, 1).partySlots).toHaveLength(1)
    expect(() => computeMenuLayout(1600, 900, 9, 0)).not.toThrow()
  })

  it('項目 0 件は行なし（落ちない）', () => {
    expect(computeMenuLayout(1600, 900, 0, 2).itemRows).toEqual([])
  })

  it('reserveTimer: 左のパーティ枠が残り時間の予約領域の下から始まる。項目窓は動かない', () => {
    const a = computeMenuLayout(1600, 900, 9, 4, false)
    const b = computeMenuLayout(1600, 900, 9, 4, true)
    const areaBottom = b.base.y + (TIME_LIMIT_AREA.y + TIME_LIMIT_AREA.h) * b.base.h
    expect(b.partySlots[0].y).toBeGreaterThanOrEqual(areaBottom)
    expect(b.partySlots[0].y).toBeGreaterThan(a.partySlots[0].y)
    expect(b.itemWindow).toEqual(a.itemWindow)
    // 下端は変わらず、4人でも窓の下端を超えない
    const bottom = b.base.y + MENU_LAYOUT.columnBottom * b.base.h
    expect(b.partySlots[3].y + b.partySlots[3].h).toBeLessThanOrEqual(bottom + 1e-6)
  })

  it('不正寸法（0・負・NaN）は NaN を含まないゼロ寸法の基準面になる', () => {
    for (const [w, h] of [
      [0, 0],
      [-10, 100],
      [NaN, 100],
    ]) {
      const l = computeMenuLayout(w, h, 9, 4)
      expect(l.base.w).toBe(0)
      const all = [l.base, l.itemWindow, l.band, l.backButton, ...l.itemRows, ...l.partySlots]
      for (const r of all)
        for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isFinite(v)).toBe(true)
      for (const v of Object.values(l.fonts)) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('文字の大きさは基準面の高さの比率', () => {
    const l = computeMenuLayout(1600, 900, 9, 4)
    expect(l.fonts.row).toBeCloseTo(0.04 * l.base.h, 5)
  })
})

describe('computeMenuButtonRect', () => {
  it('一辺は 8%H（表示が十分大きいとき）。右上隅・余白 2%H', () => {
    const r = computeMenuButtonRect(1600, 900, 1)
    expect(r.w).toBeCloseTo(72, 5)
    expect(r.h).toBe(r.w)
    expect(r.y).toBeCloseTo(18, 5)
    expect(r.x + r.w + 18).toBeCloseTo(1600, 5)
  })
  it('表示上 24 css px 未満になるときは 24 css px まで広げる', () => {
    const r = computeMenuButtonRect(320, 200, 0.5) // 8%H=16px, css 8px
    expect(r.w * 0.5).toBeGreaterThanOrEqual(24 - 1e-9)
    expect(r.w).toBeCloseTo(48, 5)
  })
  it('境界: ちょうど 24 css px', () => {
    const r = computeMenuButtonRect(1000, 300, 1) // 8%H = 24
    expect(r.w).toBeCloseTo(24, 5)
  })
  it.each([[0], [-1], [NaN], [Infinity]])('不正な cssScale（%s）は 1 とみなす', (s) => {
    const a = computeMenuButtonRect(1600, 900, s as number)
    const b = computeMenuButtonRect(1600, 900, 1)
    // Infinity は有限でないので 1 扱い
    expect(a).toEqual(b)
  })
})

describe('当たり判定', () => {
  const r = { x: 10, y: 10, w: 20, h: 10 }
  it('pointInRect は左上を含み右下を含まない', () => {
    expect(pointInRect(r, 10, 10)).toBe(true)
    expect(pointInRect(r, 29.99, 19.99)).toBe(true)
    expect(pointInRect(r, 30, 15)).toBe(false)
    expect(pointInRect(r, 15, 20)).toBe(false)
    expect(pointInRect(r, 9, 15)).toBe(false)
  })
  it('itemRowAt は窓の幅いっぱいで行を引き、無ければ -1', () => {
    const l = computeMenuLayout(1600, 900, 9, 2)
    const row = l.itemRows[3]
    expect(itemRowAt(l.itemRows, row.x + row.w - 1, row.y + 1)).toBe(3)
    expect(itemRowAt(l.itemRows, 0, 0)).toBe(-1)
  })
})

describe('画面種の既定', () => {
  it('既定の9項目の画面種', () => {
    expect(DEFAULT_FIELD_MENU_ITEMS.map((d) => screenKindOfItem(d))).toEqual([
      'item',
      'party-list',
      'party-list',
      'appstore',
      'party-list',
      'party-list',
      'status',
      'save',
      'config',
    ])
  })
  it('kind 指定が id 既定に優先し、未知 id は empty', () => {
    expect(screenKindOfItem({ id: 'item', label: 'x', kind: 'status' })).toBe('status')
    expect(screenKindOfItem({ id: 'zzz', label: 'x' })).toBe('empty')
    expect(defaultScreenKind('zzz')).toBe('empty')
  })
})
