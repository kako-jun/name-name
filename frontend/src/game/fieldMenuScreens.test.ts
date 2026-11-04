/**
 * 全画面メニューの項目画面 (#880 / fieldMenuScreens.ts) のテスト。
 * 観点: 中身の既定とパース、戻りの階層、確認窓、select の受理条件、スクロール、窓の配置。
 */
import { describe, expect, it } from 'vitest'
import { timeLimitRect } from './fieldTimeLimit'
import {
  SAVE_SLOT_COUNT,
  baseFocus,
  clampNav,
  computeScreenLayout,
  defaultScreenKind,
  entryForUse,
  initialNav,
  listCount,
  listEntries,
  optionValue,
  parseContentDef,
  resolveContent,
  scrollStart,
  screenDescription,
  stepScreen,
  tabAction,
  type FieldMenuContentDef,
  type Rect,
  type ScreenCtx,
  type ScreenKind,
  type ScreenLayoutInput,
  type ScreenNav,
} from './fieldMenuScreens'

function ctx(
  kind: ScreenKind,
  def?: FieldMenuContentDef,
  over: Partial<ScreenCtx> = {}
): ScreenCtx {
  return {
    content: resolveContent('X', kind, def),
    partyCount: 2,
    slotFilled: [false, false, false],
    settings: {},
    ...over,
  }
}
const nav = (kind: ScreenKind, over: Partial<ScreenNav> = {}): ScreenNav => ({
  ...initialNav(kind),
  ...over,
})
const E = (label: string, extra: object = {}) => ({ label, ...extra })

describe('resolveContent / 既定', () => {
  it('item は3タブ、appstore は2タブ、config は既定7設定、他は空', () => {
    expect(resolveContent('x', 'item', undefined).tabs.map((t) => t.label)).toEqual([
      'つかう',
      'せいとん',
      'たいせつなもの',
    ])
    expect(resolveContent('x', 'appstore', undefined).tabs).toHaveLength(2)
    expect(resolveContent('x', 'config', undefined).options).toHaveLength(7)
    expect(resolveContent('x', 'status', undefined).tabs).toEqual([])
  })
  it('説明は定義 > 画面種の既定 > ラベル（empty）', () => {
    expect(resolveContent('ラベル', 'empty', undefined).description).toBe('ラベル')
    expect(resolveContent('ラベル', 'empty', { description: 'D' }).description).toBe('D')
    expect(resolveContent('x', 'save', undefined).description).toContain('スロット')
  })
  it('既定の設定は複製（書き換えても定数を汚さない）', () => {
    const a = resolveContent('x', 'config', undefined)
    a.options[0].choices.push('Z')
    expect(resolveContent('x', 'config', undefined).options[0].choices).toHaveLength(2)
  })
  it('定義の空 tabs / options は既定にフォールバック', () => {
    expect(resolveContent('x', 'item', { tabs: [] }).tabs).toHaveLength(3)
    expect(resolveContent('x', 'config', { options: [] }).options).toHaveLength(7)
  })
})

describe('どうぐ・まほうの使う流れ (#880)', () => {
  const itemDef: FieldMenuContentDef = {
    tabs: [
      { label: 'つかう', entries: [E('ポ', { id: 'potion', target: 'single' })], action: 'use' },
      { label: 'せいとん', entries: [E('ポ', { id: 'potion' })], action: 'sort' },
      {
        label: 'たいせつ',
        entries: [E('鍵', { id: 'key', description: 'ドアを開ける' })],
        action: 'info',
      },
    ],
  }
  it('せいとんタブを決定すると sort の要求を出して一覧へ入る', () => {
    const r = stepScreen(nav('item', { tab: 1 }), { type: 'confirm' }, ctx('item', itemDef))
    expect(r.effect).toBe('sort')
    expect(r.nav.focus).toBe('list')
  })
  it('たいせつなもの（info）の行は使えず説明バーに説明だけ', () => {
    const r = stepScreen(
      nav('item', { tab: 2, focus: 'list' }),
      { type: 'confirm' },
      ctx('item', itemDef)
    )
    expect(r.effect).toBe('notice')
    expect(r.notice).toBe('ドアを開ける')
    expect(r.nav.focus).toBe('list')
  })
  it('せいとんタブの行は使う相手選びに進まない', () => {
    const r = stepScreen(
      nav('item', { tab: 1, focus: 'list' }),
      { type: 'confirm' },
      ctx('item', itemDef)
    )
    expect(r.effect).toBe('notice')
  })
  it('action 未指定のタブは先頭だけ use（従来どおり）', () => {
    const def = {
      tabs: [
        { label: 'a', entries: [E('x')] },
        { label: 'b', entries: [E('y')] },
      ],
    }
    expect(tabAction(resolveContent('x', 'item', def), 0)).toBe('use')
    expect(tabAction(resolveContent('x', 'item', def), 1)).toBeUndefined()
    expect(tabAction(resolveContent('x', 'party-list', undefined), 0)).toBeUndefined()
  })
  it('target を移動（上下で回り込む）・戻ると一覧へ', () => {
    const c = ctx('item', itemDef)
    const down = stepScreen(nav('item', { focus: 'target' }), { type: 'move', dx: 0, dy: 1 }, c)
    expect(down.nav.target).toBe(1)
    const wrap = stepScreen(
      nav('item', { focus: 'target', target: 1 }),
      { type: 'move', dx: 0, dy: 1 },
      c
    )
    expect(wrap.nav.target).toBe(0)
    const none = stepScreen(nav('item', { focus: 'target' }), { type: 'move', dx: 1, dy: 0 }, c)
    expect(none.effect).toBe('none')
    const back = stepScreen(nav('item', { focus: 'target' }), { type: 'back' }, c)
    expect(back.nav.focus).toBe('list')
    expect(back.effect).toBe('moved')
  })
  it('target の最中に一覧・タブのタップは無視', () => {
    const c = ctx('item', itemDef)
    expect(
      stepScreen(nav('item', { focus: 'target' }), { type: 'select', target: 'list', index: 0 }, c)
        .effect
    ).toBe('none')
  })

  const magicDef: FieldMenuContentDef = {
    entriesByParty: {
      a: [
        E('ヒール', { id: 'heal', target: 'single' }),
        E('ケアル', { id: 'all', target: 'all' }),
        E('じこ', { id: 'self', target: 'self' }),
        E('ほのお', { id: 'fire', enabled: false, description: 'ここでは使えません' }),
        E('むせんたく', { id: 'legacy' }),
      ],
    },
  }
  const mctx = (): ScreenCtx => ctx('party-list', magicDef, { partyIds: ['a', 'b'] })
  it('まほう: 単体は対象選びへ（初期は使い手）、全体・本人は即「使う」', () => {
    const single = stepScreen(
      nav('party-list', { focus: 'list', party: 1, list: 0 }),
      { type: 'confirm' },
      ctx(
        'party-list',
        { entriesByParty: { b: magicDef.entriesByParty!.a } },
        { partyIds: ['a', 'b'] }
      )
    )
    expect(single.nav.focus).toBe('target')
    expect(single.nav.target).toBe(1)
    const all = stepScreen(
      nav('party-list', { focus: 'list', list: 1 }),
      { type: 'confirm' },
      mctx()
    )
    expect(all.effect).toBe('use')
    expect(all.use).toEqual({ tab: 0, list: 1, caster: 0 })
    expect(all.nav.focus).toBe('list')
    const self = stepScreen(
      nav('party-list', { focus: 'list', list: 2 }),
      { type: 'confirm' },
      mctx()
    )
    expect(self.use?.list).toBe(2)
    expect(self.use?.target).toBeUndefined()
  })
  it('まほう: 使えない行は理由の通知。target 未指定の行は従来の通知', () => {
    const off = stepScreen(
      nav('party-list', { focus: 'list', list: 3 }),
      { type: 'confirm' },
      mctx()
    )
    expect(off.effect).toBe('notice')
    expect(off.notice).toBe('ここでは使えません')
    const legacy = stepScreen(
      nav('party-list', { focus: 'list', list: 4 }),
      { type: 'confirm' },
      mctx()
    )
    expect(legacy.effect).toBe('notice')
    expect(legacy.notice).toContain('まだありません')
  })
  it('まほう: 対象選びの決定は使い手つきの要求', () => {
    const r = stepScreen(
      nav('party-list', { focus: 'target', party: 1, list: 0, target: 0 }),
      { type: 'confirm' },
      ctx(
        'party-list',
        { entriesByParty: { b: magicDef.entriesByParty!.a } },
        { partyIds: ['a', 'b'] }
      )
    )
    expect(r.use).toEqual({ tab: 0, list: 0, caster: 1, target: 0 })
  })
  it('entryForUse: どうぐはタブの行、まほうは使い手の一覧の行', () => {
    expect(
      entryForUse(resolveContent('x', 'item', itemDef), undefined, { tab: 2, list: 0, caster: -1 })
        ?.id
    ).toBe('key')
    expect(
      entryForUse(resolveContent('x', 'party-list', magicDef), ['a', 'b'], {
        tab: 0,
        list: 1,
        caster: 0,
      })?.id
    ).toBe('all')
    expect(
      entryForUse(resolveContent('x', 'party-list', magicDef), ['a', 'b'], {
        tab: 0,
        list: 9,
        caster: 0,
      })
    ).toBeUndefined()
  })
  it('clampNav: 一覧が縮んだら選択位置を収める（空は 0）', () => {
    const c = ctx('item', itemDef)
    expect(clampNav(nav('item', { tab: 0, list: 5 }), c).list).toBe(0)
    const empty = ctx('item', { tabs: [{ label: 'a', entries: [] }] })
    expect(clampNav(nav('item', { list: 3 }), empty).list).toBe(0)
    const same = nav('item', { list: 0 })
    expect(clampNav(same, c)).toBe(same)
  })
})

describe('せってい・ステータスの content (#880)', () => {
  it('行にカーソルがあるとき説明バーに option の description を出す', () => {
    const c = ctx('config', {
      options: [{ key: 'a', label: 'A', choices: ['0', '1'], description: '効く範囲の説明' }],
    })
    expect(screenDescription(nav('config', { focus: 'list' }), c, null)).toBe('効く範囲の説明')
    expect(screenDescription(nav('config', { focus: 'list' }), ctx('config'), null)).toBe(
      '設定を変えます'
    )
  })
  it('parseContentDef: id・target・action・option.description・statusByParty', () => {
    const w: string[] = []
    const d = parseContentDef(
      {
        tabs: [{ label: 'a', action: 'sort', entries: [{ label: 'x', id: 'i', target: 'all' }] }],
        options: [{ key: 'k', label: 'K', choices: ['a'], description: '説' }],
        statusByParty: { p: [{ label: '固有素質', value: 'V' }, { label: 'x' }] },
      },
      'c',
      w
    )
    expect(d?.tabs?.[0].action).toBe('sort')
    expect(d?.tabs?.[0].entries[0]).toMatchObject({ id: 'i', target: 'all' })
    expect(d?.options?.[0].description).toBe('説')
    expect(d?.statusByParty).toEqual({ p: [{ label: '固有素質', value: 'V' }] })
    expect(w).toHaveLength(1)
    // 不正な action・target は無視
    const d2 = parseContentDef(
      { tabs: [{ label: 'a', action: 'zzz', entries: [{ label: 'x', target: 'q' }] }] },
      'c',
      []
    )
    expect(d2?.tabs?.[0].action).toBeUndefined()
    expect(d2?.tabs?.[0].entries[0].target).toBeUndefined()
    const bad = parseContentDef({ statusByParty: [] }, 'c', w)
    expect(bad?.statusByParty).toBeUndefined()
  })
  it('既定のキー割当は2択', () => {
    expect(
      resolveContent('x', 'config', undefined).options.find((o) => o.key === 'keys')?.choices
    ).toHaveLength(2)
  })
})

describe('parseContentDef', () => {
  const run = (raw: unknown) => {
    const w: string[] = []
    return { value: parseContentDef(raw, 'c', w), w }
  }
  it('undefined は undefined・警告なし', () => {
    expect(run(undefined)).toEqual({ value: undefined, w: [] })
  })
  it.each([[5], ['s'], [null], [[1]]])('オブジェクトでない値（%j）は警告して無視', (raw) => {
    const r = run(raw)
    expect(r.value).toBeUndefined()
    expect(r.w).toHaveLength(1)
  })
  it('正常な entries / tabs / options を取り込む', () => {
    const r = run({
      description: 'D',
      entries: [{ label: 'a', detail: 'x1', enabled: false, description: 'dd' }],
      tabs: [{ label: 'T', entries: [{ label: 'b' }] }, { label: 'U' }],
      options: [{ key: 'k', label: 'K', choices: ['a', 'b'], initial: 1 }],
    })
    expect(r.w).toEqual([])
    expect(r.value).toEqual({
      description: 'D',
      entries: [{ label: 'a', detail: 'x1', enabled: false, description: 'dd' }],
      tabs: [
        { label: 'T', entries: [{ label: 'b' }] },
        { label: 'U', entries: [] },
      ],
      options: [{ key: 'k', label: 'K', choices: ['a', 'b'], initial: 1 }],
    })
  })
  it('不正な entry / tab / option は警告して省く', () => {
    const r = run({
      entries: [{ label: 'ok' }, { x: 1 }, null],
      tabs: [{ x: 1 }, null, 'a'],
      options: [
        { key: 'k', label: 'K', choices: [] },
        { key: 'k', label: 'K', choices: [1] },
        { label: 'K', choices: ['a'] },
        null,
      ],
    })
    expect(r.value?.entries).toEqual([{ label: 'ok' }])
    expect(r.value?.tabs).toEqual([])
    expect(r.value?.options).toEqual([])
    expect(r.w).toHaveLength(2 + 3 + 4)
  })
  it('配列でない entries/tabs/options は警告', () => {
    const r = run({ entries: 1, tabs: 1, options: 1 })
    expect(r.w).toHaveLength(3)
  })
  it.each([[-1], [2], [0.5], ['1']])('範囲外/非整数の initial（%j）は捨てる', (initial) => {
    const r = run({ options: [{ key: 'k', label: 'K', choices: ['a', 'b'], initial }] })
    expect(r.value?.options?.[0].initial).toBeUndefined()
  })
  it('entry の enabled:true は保存しない（false のみ）', () => {
    expect(run({ entries: [{ label: 'a', enabled: true }] }).value?.entries).toEqual([
      { label: 'a' },
    ])
  })
})

describe('baseFocus / initialNav', () => {
  it.each([
    ['item', 'tab'],
    ['appstore', 'tab'],
    ['party-list', 'party'],
    ['status', 'party'],
    ['save', 'list'],
    ['config', 'list'],
    ['empty', 'list'],
  ] as const)('%s の最初のフォーカスは %s', (k, f) => {
    expect(baseFocus(k)).toBe(f)
    expect(initialNav(k)).toMatchObject({ focus: f, tab: 0, party: 0, list: 0, confirm: 0 })
  })
})

describe('stepScreen: 戻る', () => {
  it('最初の階層で戻ると最上位へ（kind ごと）', () => {
    for (const k of ['item', 'party-list', 'status', 'save', 'config', 'empty'] as const) {
      const r = stepScreen(initialNav(k), { type: 'back' }, ctx(k))
      expect(r.effect).toBe('back-to-top')
    }
  })
  it('party-list: list → party → 最上位', () => {
    const c = ctx('party-list', { entries: [E('a')] })
    const r1 = stepScreen(nav('party-list', { focus: 'list' }), { type: 'back' }, c)
    expect(r1.nav.focus).toBe('party')
    expect(stepScreen(r1.nav, { type: 'back' }, c).effect).toBe('back-to-top')
  })
  it('item: party（使う相手）→ list → tab → 最上位', () => {
    const c = ctx('item')
    const r1 = stepScreen(nav('item', { focus: 'party' }), { type: 'back' }, c)
    expect(r1.nav.focus).toBe('list')
    const r2 = stepScreen(r1.nav, { type: 'back' }, c)
    expect(r2.nav.focus).toBe('tab')
    expect(stepScreen(r2.nav, { type: 'back' }, c).effect).toBe('back-to-top')
  })
  it('確認窓で戻ると一覧へ（最上位へは戻らない）', () => {
    const r = stepScreen(nav('save', { focus: 'confirm' }), { type: 'back' }, ctx('save'))
    expect(r.nav.focus).toBe('list')
    expect(r.effect).toBe('moved')
  })
})

describe('stepScreen: 移動', () => {
  it('タブは左右で回り込み、リストを先頭に戻す', () => {
    const c = ctx('item')
    const left = stepScreen(nav('item'), { type: 'move', dx: -1, dy: 0 }, c)
    expect(left.nav.tab).toBe(2)
    const right = stepScreen(nav('item', { tab: 2, list: 4 }), { type: 'move', dx: 1, dy: 0 }, c)
    expect(right.nav).toMatchObject({ tab: 0, list: 0 })
  })
  it('タブの上下は無視', () => {
    expect(stepScreen(nav('item'), { type: 'move', dx: 0, dy: 1 }, ctx('item')).effect).toBe('none')
  })
  it('party-list の人物は上下で回り込む。status は左右も効く', () => {
    const r = stepScreen(nav('party-list'), { type: 'move', dx: 0, dy: -1 }, ctx('party-list'))
    expect(r.nav.party).toBe(1)
    expect(
      stepScreen(nav('party-list'), { type: 'move', dx: 1, dy: 0 }, ctx('party-list')).effect
    ).toBe('none')
    const s = stepScreen(nav('status'), { type: 'move', dx: 1, dy: 0 }, ctx('status'))
    expect(s.nav.party).toBe(1)
  })
  it('人物 0 人では人物の移動は無視', () => {
    const c = ctx('party-list', undefined, { partyCount: 0 })
    expect(stepScreen(nav('party-list'), { type: 'move', dx: 0, dy: 1 }, c).effect).toBe('none')
  })
  it('一覧は上下で回り込み、空の一覧では動かない', () => {
    const c = ctx('empty', { entries: [E('a'), E('b'), E('c')] })
    expect(stepScreen(nav('empty'), { type: 'move', dx: 0, dy: -1 }, c).nav.list).toBe(2)
    expect(stepScreen(nav('empty', { list: 2 }), { type: 'move', dx: 0, dy: 1 }, c).nav.list).toBe(
      0
    )
    expect(stepScreen(nav('empty'), { type: 'move', dx: 0, dy: 1 }, ctx('empty')).effect).toBe(
      'none'
    )
  })
  it('せってい: 左右で値を増減（回り込み）し setting を返す', () => {
    const c = ctx('config')
    const r = stepScreen(nav('config'), { type: 'move', dx: -1, dy: 0 }, c)
    expect(r.effect).toBe('setting')
    expect(r.setting).toEqual({ key: 'battleMode', value: 1 }) // 0 から -1 → 回り込み
    const c2 = ctx('config', undefined, { settings: { battleMode: 1 } })
    expect(stepScreen(nav('config'), { type: 'move', dx: 1, dy: 0 }, c2).setting?.value).toBe(0)
  })
  it('せってい: 上下で設定項目を移る', () => {
    const r = stepScreen(nav('config'), { type: 'move', dx: 0, dy: 1 }, ctx('config'))
    expect(r.nav.list).toBe(1)
  })
  it('確認窓は左右/上下どちらでも はい/いいえ を切り替える。移動なしは none', () => {
    const c = ctx('save')
    const n = nav('save', { focus: 'confirm', confirm: 0 })
    expect(stepScreen(n, { type: 'move', dx: 0, dy: 1 }, c).nav.confirm).toBe(1)
    expect(stepScreen(n, { type: 'move', dx: -1, dy: 0 }, c).nav.confirm).toBe(1)
    expect(stepScreen(n, { type: 'move', dx: 0, dy: 0 }, c).effect).toBe('none')
  })
})

describe('stepScreen: 決定', () => {
  it('タブで決定すると一覧へ（タブ0件は none）', () => {
    expect(stepScreen(nav('item'), { type: 'confirm' }, ctx('item')).nav.focus).toBe('list')
    const c = { ...ctx('item'), content: { ...ctx('item').content, tabs: [] } }
    expect(stepScreen(nav('item'), { type: 'confirm' }, c).effect).toBe('none')
  })
  it('status の決定は何も起きない。人物0人も none', () => {
    expect(stepScreen(nav('status'), { type: 'confirm' }, ctx('status')).effect).toBe('none')
    expect(
      stepScreen(
        nav('party-list'),
        { type: 'confirm' },
        ctx('party-list', undefined, { partyCount: 0 })
      ).effect
    ).toBe('none')
  })
  it('party-list: 人物で決定 → 一覧', () => {
    expect(stepScreen(nav('party-list'), { type: 'confirm' }, ctx('party-list')).nav.focus).toBe(
      'list'
    )
  })
  it('item の使う相手の決定は「使う」の要求（対象 index つき）で、一覧へ戻る', () => {
    const r = stepScreen(
      nav('item', { focus: 'target', target: 1, list: 2 }),
      { type: 'confirm' },
      ctx('item')
    )
    expect(r.effect).toBe('use')
    expect(r.use).toEqual({ tab: 0, list: 2, caster: -1, target: 1 })
    expect(r.nav.focus).toBe('list')
  })
  it('人物0人の使う相手の決定は何も起きない', () => {
    const r = stepScreen(
      nav('item', { focus: 'target' }),
      { type: 'confirm' },
      ctx('item', undefined, { partyCount: 0 })
    )
    expect(r.effect).toBe('none')
  })
  it('一覧の行: 空は「なにもありません」、無効は理由、有効は説明', () => {
    const empty = stepScreen(nav('empty'), { type: 'confirm' }, ctx('empty'))
    expect(empty.notice).toBe('なにもありません')
    const c = ctx('empty', {
      entries: [
        E('a', { enabled: false, description: '不可' }),
        E('b', { enabled: false }),
        E('c', { description: '説' }),
        E('d'),
      ],
    })
    expect(stepScreen(nav('empty', { list: 0 }), { type: 'confirm' }, c).notice).toBe('不可')
    expect(stepScreen(nav('empty', { list: 1 }), { type: 'confirm' }, c).notice).toBe(
      'いまは選べません'
    )
    expect(stepScreen(nav('empty', { list: 2 }), { type: 'confirm' }, c).notice).toBe('説')
    expect(stepScreen(nav('empty', { list: 3 }), { type: 'confirm' }, c).notice).toContain('「d」')
  })
  it('item「つかう」タブの有効行は使う相手選びへ。他タブ/人物0人は通知', () => {
    const def = {
      tabs: [
        { label: 'つかう', entries: [E('き')] },
        { label: 'b', entries: [E('z')] },
      ],
    }
    const c = ctx('item', def)
    const r = stepScreen(nav('item', { focus: 'list' }), { type: 'confirm' }, c)
    expect(r.nav.focus).toBe('target')
    expect(r.notice).toBe('使う相手を選んでください')
    const other = stepScreen(nav('item', { focus: 'list', tab: 1 }), { type: 'confirm' }, c)
    expect(other.effect).toBe('notice')
    const noParty = stepScreen(
      nav('item', { focus: 'list' }),
      { type: 'confirm' },
      ctx('item', def, { partyCount: 0 })
    )
    expect(noParty.effect).toBe('notice')
  })
  it('appstore の有効行は確認窓（既定は「やめる」）→ 買うで購入要求、やめるで一覧', () => {
    const c = ctx('appstore', { tabs: [{ label: 'a', entries: [E('刀')] }] })
    const r = stepScreen(nav('appstore', { focus: 'list', party: 1 }), { type: 'confirm' }, c)
    expect(r.nav).toMatchObject({ focus: 'confirm', confirm: 1 })
    // 既定のまま決定 = やめる（購入しない）
    const no = stepScreen(r.nav, { type: 'confirm' }, c)
    expect(no.effect).toBe('moved')
    expect(no.nav.focus).toBe('list')
    // 「買う」を選んで決定: 買う人物（caster = 選んだ人物の index）つきの要求
    const yes = stepScreen({ ...r.nav, confirm: 0 }, { type: 'confirm' }, c)
    expect(yes.nav.focus).toBe('list')
    expect(yes.effect).toBe('use')
    expect(yes.use).toEqual({ tab: 0, list: 0, caster: 1 })
  })
  it('appstore の無効行は確認窓を開かない', () => {
    const c = ctx('appstore', { tabs: [{ label: 'a', entries: [E('刀', { enabled: false })] }] })
    const r = stepScreen(nav('appstore', { focus: 'list' }), { type: 'confirm' }, c)
    expect(r.nav.focus).toBe('list')
    expect(r.effect).toBe('notice')
  })
  it('save: 一覧は常に SAVE_SLOT_COUNT 件。空きスロットは即 save', () => {
    expect(listCount(ctx('save'), nav('save'))).toBe(SAVE_SLOT_COUNT)
    const r = stepScreen(nav('save', { list: 2 }), { type: 'confirm' }, ctx('save'))
    expect(r).toMatchObject({ effect: 'save', save: 2, notice: 'スロット3にセーブしました' })
  })
  it('save: 上書きは既定が「いいえ」。はいで上書き通知', () => {
    const c = ctx('save', undefined, { slotFilled: [true, false, false] })
    const r = stepScreen(nav('save'), { type: 'confirm' }, c)
    expect(r.nav).toMatchObject({ focus: 'confirm', confirm: 1 })
    const yes = stepScreen({ ...r.nav, confirm: 0 }, { type: 'confirm' }, c)
    expect(yes).toMatchObject({ effect: 'save', save: 0, notice: 'スロット1に上書きしました' })
    expect(yes.nav.focus).toBe('list')
  })
  it('config: 決定で次の選択肢（末尾で先頭へ）', () => {
    const c = ctx('config', undefined, { settings: { battleMode: 1 } })
    expect(stepScreen(nav('config'), { type: 'confirm' }, c).setting).toEqual({
      key: 'battleMode',
      value: 0,
    })
    expect(stepScreen(nav('config', { list: 99 }), { type: 'confirm' }, c).effect).toBe('none')
  })
})

describe('stepScreen: select（1タップ決定）の受理条件', () => {
  it('確認窓中は confirm 以外・範囲外 index を無視', () => {
    const c = ctx('save')
    const n = nav('save', { focus: 'confirm' })
    for (const ev of [
      { type: 'select', target: 'list', index: 0 },
      { type: 'select', target: 'confirm', index: 2 },
      { type: 'select', target: 'confirm', index: -1 },
    ] as const)
      expect(stepScreen(n, ev, c).effect).toBe('none')
    expect(
      stepScreen(
        { ...n, list: 1 },
        { type: 'select', target: 'confirm', index: 0 },
        ctx('save', undefined, { slotFilled: [false, true, false] })
      ).effect
    ).toBe('save')
  })
  it('prev/next は status だけ、回り込む', () => {
    const c = ctx('status')
    expect(
      stepScreen(nav('status'), { type: 'select', target: 'prev', index: 0 }, c).nav.party
    ).toBe(1)
    expect(
      stepScreen(nav('status', { party: 1 }), { type: 'select', target: 'next', index: 0 }, c).nav
        .party
    ).toBe(0)
    expect(
      stepScreen(nav('party-list'), { type: 'select', target: 'next', index: 0 }, ctx('party-list'))
        .effect
    ).toBe('none')
  })
  it('tab: 範囲内なら選んで一覧へ。範囲外は無視', () => {
    const c = ctx('item')
    const r = stepScreen(nav('item'), { type: 'select', target: 'tab', index: 1 }, c)
    expect(r.nav).toMatchObject({ tab: 1, focus: 'list' })
    expect(stepScreen(nav('item'), { type: 'select', target: 'tab', index: 3 }, c).effect).toBe(
      'none'
    )
    expect(stepScreen(nav('item'), { type: 'select', target: 'tab', index: -1 }, c).effect).toBe(
      'none'
    )
  })
  it('party: status は選ぶだけ、party-list は一覧へ、save/config では無効', () => {
    expect(
      stepScreen(nav('status'), { type: 'select', target: 'party', index: 1 }, ctx('status')).nav
        .party
    ).toBe(1)
    const pl = stepScreen(
      nav('party-list'),
      { type: 'select', target: 'party', index: 1 },
      ctx('party-list')
    )
    expect(pl.nav).toMatchObject({ focus: 'list', party: 1 })
    expect(
      stepScreen(nav('save'), { type: 'select', target: 'party', index: 0 }, ctx('save')).effect
    ).toBe('none')
    expect(
      stepScreen(
        nav('party-list'),
        { type: 'select', target: 'party', index: 2 },
        ctx('party-list')
      ).effect
    ).toBe('none')
  })
  it('item の party は使う相手選びの最中だけ受ける', () => {
    const c = ctx('item')
    expect(
      stepScreen(nav('item', { focus: 'tab' }), { type: 'select', target: 'party', index: 0 }, c)
        .effect
    ).toBe('none')
    const r = stepScreen(
      nav('item', { focus: 'target' }),
      { type: 'select', target: 'party', index: 1 },
      c
    )
    expect(r.effect).toBe('use')
    expect(r.use?.target).toBe(1)
    // 範囲外は無視
    expect(
      stepScreen(nav('item', { focus: 'target' }), { type: 'select', target: 'party', index: 2 }, c)
        .effect
    ).toBe('none')
  })
  it('list: party 選択中は無視。範囲外は無視。save はスロットを1タップで決定', () => {
    const c = ctx('save')
    expect(stepScreen(nav('save'), { type: 'select', target: 'list', index: 3 }, c).effect).toBe(
      'none'
    )
    expect(stepScreen(nav('save'), { type: 'select', target: 'list', index: 1 }, c)).toMatchObject({
      effect: 'save',
      save: 1,
    })
    expect(
      stepScreen(
        nav('party-list', { focus: 'party' }),
        { type: 'select', target: 'list', index: 0 },
        ctx('party-list', { entries: [E('a')] })
      ).effect
    ).toBe('none')
  })
  it('config の list タップは値を進める', () => {
    const r = stepScreen(nav('config'), { type: 'select', target: 'list', index: 2 }, ctx('config'))
    expect(r.setting).toEqual({ key: 'messageSpeed', value: 3 })
  })
})

describe('optionValue / screenDescription', () => {
  const o = { key: 'k', label: 'K', choices: ['a', 'b', 'c'], initial: 2 }
  it('設定値が無い/範囲外/非数は initial、有効なら設定値', () => {
    const base = ctx('config')
    expect(optionValue(base, o)).toBe(2)
    expect(optionValue({ ...base, settings: { k: 0 } }, o)).toBe(0)
    expect(optionValue({ ...base, settings: { k: 3 } }, o)).toBe(2)
    expect(optionValue({ ...base, settings: { k: -1 } }, o)).toBe(2)
    expect(optionValue(base, { ...o, initial: undefined })).toBe(0)
  })
  it('通知 > 行の説明 > 画面の説明', () => {
    const c = ctx('empty', { description: '画面', entries: [E('a', { description: '行' })] })
    expect(screenDescription(nav('empty'), c, '通知')).toBe('通知')
    expect(screenDescription(nav('empty'), c, null)).toBe('行')
    expect(screenDescription(nav('empty', { focus: 'party' }), c, null)).toBe('画面')
    expect(screenDescription(nav('save'), ctx('save'), null)).toContain('スロット')
  })
})

describe('scrollStart', () => {
  it('全部見えるなら 0', () => {
    expect(scrollStart(5, 4, 5)).toBe(0)
    expect(scrollStart(3, 2, 10)).toBe(0)
  })
  it('見える数が 0 以下なら 0', () => {
    expect(scrollStart(10, 5, 0)).toBe(0)
    expect(scrollStart(10, 5, -1)).toBe(0)
  })
  it('カーソルが範囲外に出たぶんだけ必要最小限に送る', () => {
    expect(scrollStart(10, 5, 4, 0)).toBe(2) // 5 が最下行
    expect(scrollStart(10, 1, 4, 3)).toBe(1) // 1 が最上行
    expect(scrollStart(10, 4, 4, 3)).toBe(3) // 範囲内なら動かない
  })
  it('端: 先頭・末尾。prev が大きすぎても収まる', () => {
    expect(scrollStart(10, 0, 4, 6)).toBe(0)
    expect(scrollStart(10, 9, 4, 0)).toBe(6)
    expect(scrollStart(10, 9, 4, 99)).toBe(6)
    expect(scrollStart(10, 5, 4, -5)).toBe(2)
  })
})

describe('computeScreenLayout', () => {
  const base = { x: 100, y: 50, w: 1600, h: 900 }
  const input = (over: Partial<ScreenLayoutInput> = {}): ScreenLayoutInput => ({
    kind: 'item',
    base,
    partyCount: 3,
    tabCount: 3,
    listCount: 4,
    cursor: 0,
    reserveTimer: false,
    confirmOpen: false,
    ...over,
  })
  it('item: タブ3つが一覧窓の幅を等分し、人物枠3つが左に並ぶ', () => {
    const l = computeScreenLayout(input())
    expect(l.tabs).toHaveLength(3)
    expect(l.tabs[0].w * 3).toBeCloseTo(l.primary.w, 5)
    expect(l.party).toHaveLength(3)
    expect(l.primary.x).toBeGreaterThan(l.party[0].x + l.party[0].w)
    expect(l.confirm).toBeNull()
    expect(l.statusNav).toBeNull()
  })
  it('人物・タブを持たない画面（save/config/empty）は party/tabs が空で一覧が左から', () => {
    for (const kind of ['save', 'config', 'empty'] as const) {
      const l = computeScreenLayout(input({ kind }))
      expect(l.party).toEqual([])
      expect(l.tabs).toEqual([])
      expect(l.primary.x).toBeCloseTo(base.x + 0.02 * base.w, 5)
    }
  })
  it('status は前/次ボタンを持つ', () => {
    const l = computeScreenLayout(input({ kind: 'status' }))
    expect(l.statusNav?.prev.x).toBeLessThan(l.statusNav!.next.x)
  })
  it('reserveTimer: 説明バーが予約領域の右へずれる。人物枠は説明バーの下端以下で、有無とも同じ', () => {
    const a = computeScreenLayout(input())
    const b = computeScreenLayout(input({ reserveTimer: true }))
    expect(b.desc.x).toBeGreaterThan(a.desc.x)
    expect(b.desc.x).toBeGreaterThanOrEqual(base.x + 0.14 * base.w)
    expect(b.party[0].y).toBe(a.party[0].y)
  })
  const overlap = (p: Rect, q: Rect): boolean =>
    p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h
  it.each([true, false])(
    '人物選択のある画面で、説明バー・人物枠・タブ・一覧・予約領域が重ならない（reserveTimer=%s）',
    (reserveTimer) => {
      for (const kind of ['item', 'party-list'] as const) {
        for (const partyCount of [1, 4]) {
          const l = computeScreenLayout(input({ kind, partyCount, reserveTimer }))
          const timer = timeLimitRect(base.w, base.h)
          const timerRect = { x: base.x + timer.x, y: base.y + timer.y, w: timer.w, h: timer.h }
          const others = [...l.party, ...l.tabs, l.primary]
          for (const r of others) {
            expect(overlap(l.desc, r)).toBe(false)
            if (reserveTimer) expect(overlap(timerRect, r)).toBe(false)
          }
          if (reserveTimer) expect(overlap(timerRect, l.desc)).toBe(false)
          l.party.forEach((p, i) =>
            l.party.slice(i + 1).forEach((q) => expect(overlap(p, q)).toBe(false))
          )
          for (const p of l.party) expect(overlap(p, l.primary)).toBe(false)
        }
      }
    }
  )
  it('確認窓は confirmOpen のときだけ。中央にあり選択肢が2つ', () => {
    const l = computeScreenLayout(input({ confirmOpen: true }))
    expect(l.confirm?.options).toHaveLength(2)
    const f = l.confirm!.frame
    expect(f.x + f.w / 2).toBeCloseTo(base.x + base.w / 2, 5)
    expect(f.y + f.h / 2).toBeCloseTo(base.y + base.h / 2, 5)
  })
  it('一覧が長いと行はスクロールし、カーソルが見える範囲に入る', () => {
    const l0 = computeScreenLayout(input({ kind: 'empty', listCount: 50, cursor: 0 }))
    expect(l0.rowStart).toBe(0)
    expect(l0.rows.length).toBeLessThan(50)
    const l1 = computeScreenLayout(input({ kind: 'empty', listCount: 50, cursor: 49 }))
    expect(l1.rowStart + l1.rows.length).toBe(50)
    for (const r of l1.rows)
      expect(r.y + r.h).toBeLessThanOrEqual(l1.primary.y + l1.primary.h + 1e-6)
  })
  it('一覧0件は行なし。人物は最大4枠', () => {
    expect(computeScreenLayout(input({ listCount: 0 })).rows).toEqual([])
    expect(computeScreenLayout(input({ partyCount: 9 })).party).toHaveLength(4)
    expect(computeScreenLayout(input({ partyCount: 0 })).party).toEqual([])
  })
  it('tabCount 0 のとき item でもタブ矩形は出さない', () => {
    expect(computeScreenLayout(input({ tabCount: 0 })).tabs).toEqual([])
  })
})

describe('entriesByParty（人物ごとの一覧）', () => {
  const def: FieldMenuContentDef = {
    entries: [E('共通')],
    entriesByParty: { p2: [E('二人目の技')] },
  }
  it('選択人物のものを出し、無い人物は entries', () => {
    const c = ctx('party-list', def, { partyIds: ['p1', 'p2'] })
    expect(listCount(c, nav('party-list', { party: 1 }))).toBe(1)
    expect(listEntries(c, nav('party-list', { party: 1 }))[0].label).toBe('二人目の技')
    expect(listEntries(c, nav('party-list', { party: 0 }))[0].label).toBe('共通')
  })
  it('partyIds が無ければ entries（後方互換）。party-list 以外では効かない', () => {
    expect(listEntries(ctx('party-list', def), nav('party-list', { party: 1 }))[0].label).toBe(
      '共通'
    )
    expect(
      listEntries(ctx('empty', def, { partyIds: ['p1', 'p2'] }), nav('empty', { party: 1 }))[0]
        .label
    ).toBe('共通')
  })
  it('prototype のキーで引かない（toString 等の人物 id）', () => {
    const c = ctx('party-list', def, { partyIds: ['toString'] })
    expect(listEntries(c, nav('party-list'))[0].label).toBe('共通')
  })
  it('パース: 正常・不正（配列/非オブジェクト）・中の不正項目', () => {
    const w: string[] = []
    expect(
      parseContentDef({ entriesByParty: { a: [{ label: 'x' }, { nolabel: 1 }] } }, 'c', w)
        ?.entriesByParty
    ).toEqual({ a: [{ label: 'x' }] })
    expect(w.some((m) => m.includes('entriesByParty.a[1]'))).toBe(true)
    const w2: string[] = []
    expect(parseContentDef({ entriesByParty: [] }, 'c', w2)?.entriesByParty).toBeUndefined()
    expect(w2.some((m) => m.includes('entriesByParty'))).toBe(true)
  })
  it('resolveContent は既定で空オブジェクト', () => {
    expect(resolveContent('x', 'party-list', undefined).entriesByParty).toEqual({})
  })
})

describe('一覧のスクロール位置の保持（prevRowStart）', () => {
  const lay = (over: Partial<ScreenLayoutInput>) =>
    computeScreenLayout({
      kind: 'party-list',
      base: { x: 0, y: 0, w: 1920, h: 1080 },
      partyCount: 2,
      tabCount: 0,
      listCount: 30,
      cursor: 0,
      reserveTimer: false,
      confirmOpen: false,
      ...over,
    })
  it('カーソルが範囲内なら前回位置のまま。範囲外へ出たら最小限だけ送る', () => {
    const vis = lay({}).rows.length
    expect(lay({ cursor: 5, prevRowStart: 3 }).rowStart).toBe(3)
    expect(lay({ cursor: 3 + vis, prevRowStart: 3 }).rowStart).toBe(4)
  })
})

describe('アプリストア（#881 段階2）: 人物ごとの一覧・人物の切り替え', () => {
  const tabs = [
    {
      label: '刀',
      entries: [],
      entriesByParty: {
        a: [E('正宗', { id: 'm' })],
        b: [E('村正', { id: 'v' }), E('菊一', { id: 'k' })],
      },
    },
    { label: '防具', entries: [E('赤糸威', { id: 'r' })] },
  ]
  const c = () => ctx('appstore', { tabs }, { partyIds: ['a', 'b'] })

  it('一覧は選んだ人物の分（人物別が無いタブは共通の entries）', () => {
    expect(listEntries(c(), nav('appstore', { party: 0 })).map((e) => e.label)).toEqual(['正宗'])
    expect(listEntries(c(), nav('appstore', { party: 1 })).map((e) => e.label)).toEqual([
      '村正',
      '菊一',
    ])
    expect(listEntries(c(), nav('appstore', { tab: 1, party: 1 })).map((e) => e.label)).toEqual([
      '赤糸威',
    ])
    expect(listCount(c(), nav('appstore', { party: 1 }))).toBe(2)
  })
  it('タブにいるとき上下で人物が回り、一覧は先頭に戻る', () => {
    const r = stepScreen(
      nav('appstore', { focus: 'tab', list: 1 }),
      { type: 'move', dx: 0, dy: 1 },
      c()
    )
    expect(r.nav).toMatchObject({ party: 1, list: 0, focus: 'tab' })
    const back = stepScreen(r.nav, { type: 'move', dx: 0, dy: 1 }, c())
    expect(back.nav.party).toBe(0)
    const up = stepScreen(nav('appstore', { focus: 'tab' }), { type: 'move', dx: 0, dy: -1 }, c())
    expect(up.nav.party).toBe(1)
  })
  it('左右はタブの切り替えのまま（人物は変えない）', () => {
    const r = stepScreen(
      nav('appstore', { focus: 'tab', party: 1 }),
      { type: 'move', dx: 1, dy: 0 },
      c()
    )
    expect(r.nav).toMatchObject({ tab: 1, party: 1 })
  })
  it('前・次ボタンで人物が変わり、一覧は先頭へ。人物が 0 人なら何も起きない', () => {
    const r = stepScreen(
      nav('appstore', { focus: 'list', list: 1 }),
      { type: 'select', target: 'next', index: 0 },
      c()
    )
    expect(r.nav).toMatchObject({ party: 1, list: 0 })
    const none = stepScreen(
      nav('appstore'),
      { type: 'select', target: 'next', index: 0 },
      { ...c(), partyCount: 0 }
    )
    expect(none.effect).toBe('none')
  })
  it('人物を切り替えると別の人物の刀に買う要求が向く（entryForUse）', () => {
    const cc = c()
    expect(entryForUse(cc.content, ['a', 'b'], { tab: 0, list: 1, caster: 1 })?.label).toBe('菊一')
    expect(entryForUse(cc.content, ['a', 'b'], { tab: 0, list: 0, caster: 0 })?.label).toBe('正宗')
    expect(entryForUse(cc.content, ['a', 'b'], { tab: 0, list: 1, caster: 0 })).toBeUndefined()
  })
  it('前・次の人物の切り替えと人物名の枠を含むレイアウト。一覧は人物の行の下から始まる', () => {
    const l = computeScreenLayout({
      kind: 'appstore',
      base: { x: 0, y: 0, w: 1920, h: 1080 },
      partyCount: 2,
      tabCount: 2,
      listCount: 3,
      cursor: 0,
      reserveTimer: false,
      confirmOpen: false,
    })
    expect(l.statusNav).not.toBeNull()
    expect(l.rows[0].y).toBeGreaterThanOrEqual(l.statusNav!.prev.y + l.statusNav!.prev.h)
    expect(l.statusNav!.label.w).toBeGreaterThan(0)
    expect(l.party).toEqual([])
  })
})

describe('そうび（#881 段階2）', () => {
  const content = {
    entriesByParty: { a: [E('正宗', { id: 'm' })], b: [] },
    headerByParty: { a: [{ label: 'スマホ（刀）', value: '正宗' }] },
  }
  const c = () => ctx('equip', content, { partyIds: ['a', 'b'] })
  it('画面種は equip・既定は人物選択から', () => {
    expect(defaultScreenKind('equip')).toBe('equip')
    expect(baseFocus('equip')).toBe('party')
    expect(resolveContent('x', 'equip', content).headerByParty.a).toHaveLength(1)
    expect(resolveContent('x', 'equip', undefined).headerByParty).toEqual({})
  })
  it('人物を選ぶと人物の一覧になり、一覧で決定すると選んだ人物への持ち替え要求', () => {
    const toList = stepScreen(nav('equip', { party: 0 }), { type: 'confirm' }, c())
    expect(toList.nav.focus).toBe('list')
    expect(listEntries(c(), toList.nav).map((e) => e.label)).toEqual(['正宗'])
    const use = stepScreen(toList.nav, { type: 'confirm' }, c())
    expect(use.effect).toBe('use')
    expect(use.use).toEqual({ tab: 0, list: 0, caster: 0 })
  })
  it('一覧が空の人物では決定しても「なにもありません」', () => {
    const r = stepScreen(nav('equip', { party: 1, focus: 'list' }), { type: 'confirm' }, c())
    expect(r.effect).toBe('notice')
  })
  it('人物の枠の 1 タップで人物を選んで一覧へ', () => {
    const r = stepScreen(nav('equip'), { type: 'select', target: 'party', index: 1 }, c())
    expect(r.nav).toMatchObject({ focus: 'list', party: 1 })
  })
  it('レイアウトは人物の枠＋見出し行。一覧は見出し行の下から始まる', () => {
    const l = computeScreenLayout({
      kind: 'equip',
      base: { x: 0, y: 0, w: 1920, h: 1080 },
      partyCount: 2,
      tabCount: 0,
      listCount: 2,
      cursor: 0,
      reserveTimer: false,
      confirmOpen: false,
      headerCount: 2,
    })
    expect(l.party).toHaveLength(2)
    expect(l.header).toHaveLength(2)
    expect(l.rows[0].y).toBeGreaterThanOrEqual(l.header[1].y + l.header[1].h)
    const none = computeScreenLayout({
      kind: 'equip',
      base: { x: 0, y: 0, w: 1920, h: 1080 },
      partyCount: 2,
      tabCount: 0,
      listCount: 2,
      cursor: 0,
      reserveTimer: false,
      confirmOpen: false,
    })
    expect(none.header).toEqual([])
  })
  it('画像のパスは entries の parse で通る（文字列だけ）', () => {
    const w: string[] = []
    const out = parseContentDef(
      {
        entries: [
          { label: 'x', image: 'a.png' },
          { label: 'y', image: 3 },
        ],
      },
      'c',
      w
    )
    expect(out?.entries?.[0].image).toBe('a.png')
    expect(out?.entries?.[1].image).toBeUndefined()
  })
})
