/** 候補窓の状態機械 (#204) の単体テスト。純粋関数なので PixiJS 不要 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_STACK,
  buildMenuRows,
  cancel,
  confirm,
  isReviveEntry,
  menuKeyAction,
  refitList,
  scrollList,
  moveCursor,
  openList,
  parseSpellTarget,
  scrollTopFor,
  setListCursor,
  setTargetCursor,
  targetHands,
  type BattleItemEntry,
  type BattleSpellEntry,
  type MenuContext,
  type TargetWindow,
} from './battleMenu'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return { id, name: id, hp: 10, maxHp: 10, mp: 5, maxMp: 5, atk: 1, def: 0, agi: 1, ...over }
}

const spells: BattleSpellEntry[] = [
  { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体' },
  { id: 'meteor', name: 'メテオ', mp: 20, target: '敵全体' },
  { id: 'heal', name: 'ヒール', mp: 2, target: '味方単体' },
  { id: 'heals', name: 'ヒーリング', mp: 4, target: '味方全体' },
  { id: 'self', name: 'いのり', mp: 1, target: '自分' },
  { id: 'map', name: 'ルーラ', mp: 1, target: 'マップ' },
]

function ctxOf(over: Partial<MenuContext> = {}): MenuContext {
  const party = [ent('a'), ent('b'), ent('c', { hp: 0 })]
  const enemies = [ent('s1'), ent('s2', { hp: 0 }), ent('s3')]
  return {
    rows: buildMenuRows('spell', spells, party[0]),
    maxRows: 4,
    entries: spells,
    party,
    enemies,
    actorIndex: 0,
    ...over,
  }
}

describe('parseSpellTarget', () => {
  it.each([
    ['敵単体', 'enemy', 'single'],
    ['敵全体', 'enemy', 'all'],
    ['味方単体', 'party', 'single'],
    ['味方全体', 'party', 'all'],
    ['自分', 'party', 'self'],
    ['マップ', 'enemy', 'none'],
    ['  敵全体 ', 'enemy', 'all'],
    ['わからない', 'enemy', 'single'],
    [undefined, 'enemy', 'single'],
  ] as const)('%s', (raw, side, scope) => {
    expect(parseSpellTarget(raw)).toEqual({ side, scope })
  })
})

describe('buildMenuRows', () => {
  it('MP が足りない呪文だけ disabled・消費を数字だけで出す', () => {
    const rows = buildMenuRows('spell', spells, ent('a', { mp: 3 }))
    expect(rows.map((r) => r.disabled)).toEqual([false, true, false, true, false, true])
    expect(rows[0]).toEqual({ label: 'ほのお', cost: '3', disabled: false })
  })

  it('MP がちょうど足りれば選べる', () => {
    expect(buildMenuRows('spell', [spells[0]], ent('a', { mp: 3 }))[0].disabled).toBe(false)
  })

  it('アイテムは所持数を ×n で出し、0 ならグレー・未指定なら表示なし', () => {
    const items: BattleItemEntry[] = [
      { id: 'p', name: 'ポーション', count: 2 },
      { id: 'e', name: 'エーテル', count: 0 },
      { id: 'x', name: 'なぞ' },
    ]
    const rows = buildMenuRows('item', items, ent('a'))
    expect(rows.map((r) => r.cost)).toEqual(['×2', '×0', ''])
    expect(rows.map((r) => r.disabled)).toEqual([false, true, false])
  })
})

describe('scrollTopFor', () => {
  it('カーソルが窓から出たときだけずらす', () => {
    expect(scrollTopFor(2, 0, 10, 4)).toBe(0)
    expect(scrollTopFor(4, 0, 10, 4)).toBe(1)
    expect(scrollTopFor(0, 3, 10, 4)).toBe(0)
    expect(scrollTopFor(9, 0, 10, 4)).toBe(6)
  })
  it('行数が窓に収まるなら 0・窓が 0 以下でも壊れない', () => {
    expect(scrollTopFor(2, 5, 3, 4)).toBe(0)
    expect(scrollTopFor(2, 0, 3, 0)).toBe(2)
  })
})

describe('窓のスタックとキャンセル', () => {
  it('一覧 → 対象 の順に重なり、キャンセルで一つ前に戻る', () => {
    const ctx = ctxOf()
    let st = openList(EMPTY_STACK, 'spell', ctx)
    expect(st).toHaveLength(1)
    st = confirm(st, ctx).stack
    expect(st.map((w) => w.type)).toEqual(['list', 'target'])
    st = cancel(st)
    expect(st.map((w) => w.type)).toEqual(['list'])
    st = cancel(st)
    expect(st).toEqual([])
    expect(cancel(st)).toEqual([])
  })

  it('候補がなければ開かない・すでに開いていれば今のまま', () => {
    expect(openList(EMPTY_STACK, 'spell', ctxOf({ rows: [], entries: [] }))).toEqual([])
    const st = openList(EMPTY_STACK, 'spell', ctxOf())
    expect(openList(st, 'item', ctxOf())).toBe(st)
  })

  it('開いたときのカーソルは最初に選べる行', () => {
    const party = [ent('a', { mp: 1 })]
    const rows = buildMenuRows('spell', spells, party[0])
    const st = openList(EMPTY_STACK, 'spell', ctxOf({ party, rows }))
    expect(st[0]).toMatchObject({ type: 'list', cursor: 4 })
  })

  it('一覧のカーソルは上下で循環し、行が多いときはスクロールする', () => {
    const ctx = ctxOf({ maxRows: 2 })
    let st = openList(EMPTY_STACK, 'spell', ctx)
    st = moveCursor(st, 'up', ctx)
    expect(st[0]).toMatchObject({ cursor: 5, top: 4 })
    st = moveCursor(st, 'down', ctx)
    expect(st[0]).toMatchObject({ cursor: 0, top: 0 })
    expect(moveCursor(st, 'left', ctx)).toBe(st)
  })

  it('setListCursor は範囲外を無視する', () => {
    const ctx = ctxOf()
    const st = openList(EMPTY_STACK, 'spell', ctx)
    expect(setListCursor(st, 99, ctx)).toBe(st)
    expect(setListCursor(st, 3, ctx)[0]).toMatchObject({ cursor: 3 })
  })
})

describe('MP 不足（グレー）', () => {
  it('グレーの行は確定できず、窓は閉じない', () => {
    const ctx = ctxOf()
    let st = openList(EMPTY_STACK, 'spell', ctx)
    st = setListCursor(st, 1, ctx) // メテオ MP20
    const r = confirm(st, ctx)
    expect(r.blocked).toBe('disabled')
    expect(r.action).toBeUndefined()
    expect(r.stack).toBe(st)
  })

  it('MP が足りる行は進む', () => {
    const ctx = ctxOf()
    const st = openList(EMPTY_STACK, 'spell', ctx)
    expect(confirm(st, ctx).blocked).toBeUndefined()
  })
})

describe('対象選択', () => {
  function toTarget(index: number, ctx = ctxOf()) {
    const st = setListCursor(openList(EMPTY_STACK, 'spell', ctx), index, ctx)
    return { st: confirm(st, ctx).stack, ctx }
  }

  it('敵単体: 手は最初の生きている敵。上下で生きている敵だけ巡り、確定で targetId が出る', () => {
    const { st, ctx } = toTarget(0)
    const w = st[1] as TargetWindow
    expect(w).toMatchObject({ side: 'enemy', cursor: 0 })
    const down = moveCursor(st, 'down', ctx)
    expect((down[1] as TargetWindow).cursor).toBe(2) // s2 は倒れている
    expect((moveCursor(down, 'down', ctx)[1] as TargetWindow).cursor).toBe(0)
    const r = confirm(down, ctx)
    expect(r.action).toEqual({ kind: 'spell', entryIndex: 0, targetId: 's3' })
    expect(r.stack).toEqual([])
  })

  it('単体は左右キーで側を切り替えられない（target が示す側に固定）', () => {
    const { st, ctx } = toTarget(0)
    expect(moveCursor(st, 'right', ctx)).toBe(st)
    expect(moveCursor(st, 'left', ctx)).toBe(st)
    expect(setTargetCursor(st, 'party', 0, ctx)).toBe(st)
    const heal = toTarget(2).st
    expect(moveCursor(heal, 'left', ctx)).toBe(heal)
    expect(setTargetCursor(heal, 'enemy', 0, ctx)).toBe(heal)
  })

  it('味方単体: 手は使用者から始まり、生存者だけを巡る（倒れた味方は指せない）', () => {
    const ctx = ctxOf({ actorIndex: 1 })
    const { st } = toTarget(2, ctx)
    expect(st[1]).toMatchObject({ side: 'party', cursor: 1 })
    const down = moveCursor(st, 'down', ctx) // c は倒れているので飛ばして a
    expect((down[1] as TargetWindow).cursor).toBe(0)
    expect(confirm(down, ctx).action?.targetId).toBe('a')
    expect(setTargetCursor(st, 'party', 2, ctx)).toBe(st)
  })

  it('蘇生の呪文は倒れた味方だけを指せる（効果 revive / builtin zaorik）', () => {
    const rev: BattleSpellEntry[] = [
      { id: 'r', name: 'レイズ', mp: 1, target: '味方単体', effect: 'revive hp=half' },
      { id: 'z', name: 'ザオリク', mp: 1, target: '味方単体', builtin: 'zaorik' },
    ]
    for (const idx of [0, 1]) {
      const ctx = ctxOf({ rows: buildMenuRows('spell', rev, ent('a')), entries: rev })
      const st = confirm(setListCursor(openList(EMPTY_STACK, 'spell', ctx), idx, ctx), ctx).stack
      expect(st[1]).toMatchObject({ side: 'party', cursor: 2 })
      expect(moveCursor(st, 'down', ctx)).toMatchObject([{}, { cursor: 2 }])
      expect(setTargetCursor(st, 'party', 0, ctx)).toBe(st)
      expect(confirm(st, ctx).action?.targetId).toBe('c')
    }
    // 倒れた味方がいなければ選べない
    const alive = ctxOf({
      rows: buildMenuRows('spell', rev, ent('a')),
      entries: rev,
      party: [ent('a'), ent('b')],
    })
    expect(confirm(openList(EMPTY_STACK, 'spell', alive), alive).blocked).toBe('empty')
  })

  it('isReviveEntry: 呪文は zaorik、アイテムは world_tree_drop（取り違えない）', () => {
    expect(isReviveEntry('spell', { effect: 'heal 10..10' })).toBe(false)
    expect(isReviveEntry('spell', { effect: 'revive' })).toBe(true)
    expect(isReviveEntry('item', { effect: 'revive hp=half' })).toBe(true)
    expect(isReviveEntry('spell', { builtin: 'zaorik' })).toBe(true)
    expect(isReviveEntry('item', { builtin: 'zaorik' })).toBe(false)
    expect(isReviveEntry('item', { builtin: 'world_tree_drop' })).toBe(true)
    expect(isReviveEntry('spell', { builtin: 'world_tree_drop' })).toBe(false)
    expect(isReviveEntry('spell', {})).toBe(false)
  })

  it('手が指している対象が確定前に倒れていたら確定しない（空撃ち防止）', () => {
    const ctx = ctxOf()
    const st = confirm(openList(EMPTY_STACK, 'spell', ctx), ctx).stack
    const dead = ctxOf({ enemies: [ent('s1', { hp: 0 }), ent('s2', { hp: 0 }), ent('s3')] })
    expect(confirm(st, dead).blocked).toBe('empty')
  })

  it('全体: 手は対象側の生存者全員に同時に立ち、カーソルは動かず targetId は出ない', () => {
    const ctx = ctxOf({ rows: buildMenuRows('spell', spells, ent('a', { mp: 99 })) })
    const { st } = toTarget(1, ctx) // 敵全体
    const w = st[1] as TargetWindow
    expect(targetHands(w, ctx.party, ctx.enemies, 0)).toEqual([
      { side: 'enemy', index: 0 },
      { side: 'enemy', index: 2 },
    ])
    expect(moveCursor(st, 'down', ctx)).toBe(st)
    expect(moveCursor(st, 'right', ctx)).toBe(st)
    expect(confirm(st, ctx).action).toEqual({ kind: 'spell', entryIndex: 1 })

    const heals = toTarget(3, ctx).st[1] as TargetWindow
    expect(targetHands(heals, ctx.party, ctx.enemies, 0).map((h) => h.index)).toEqual([0, 1])
  })

  it('自分: 手は使用者だけ・targetId なし', () => {
    const ctx = ctxOf({ actorIndex: 1 })
    const { st } = toTarget(4, ctx)
    expect(targetHands(st[1] as TargetWindow, ctx.party, ctx.enemies, 1)).toEqual([
      { side: 'party', index: 1 },
    ])
    expect(confirm(st, ctx).action).toEqual({ kind: 'spell', entryIndex: 4 })
  })

  it('対象なし（マップ）の呪文は戦闘ではグレーで、MP が足りていても確定できない', () => {
    const ctx = ctxOf()
    expect(ctx.rows[5].disabled).toBe(true)
    const st = setListCursor(openList(EMPTY_STACK, 'spell', ctx), 5, ctx)
    const r = confirm(st, ctx)
    expect(r.blocked).toBe('disabled')
    expect(r.action).toBeUndefined()
  })

  it('敵が全滅していて単体の敵を指せないときは blocked=empty', () => {
    const ctx = ctxOf({ enemies: [ent('s1', { hp: 0 })] })
    const st = openList(EMPTY_STACK, 'spell', ctx)
    expect(confirm(st, ctx).blocked).toBe('empty')
  })

  it('アイテムは常に味方単体', () => {
    const items: BattleItemEntry[] = [{ id: 'p', name: 'ポーション' }]
    const ctx = ctxOf({ rows: buildMenuRows('item', items, ent('a')), entries: items })
    const st = confirm(openList(EMPTY_STACK, 'item', ctx), ctx).stack
    expect(st[1]).toMatchObject({ kind: 'item', side: 'party', cursor: 0 })
    expect(confirm(st, ctx).action).toEqual({ kind: 'item', entryIndex: 0, targetId: 'a' })
  })

  it('setTargetCursor は指せない対象（倒れた敵）を無視する', () => {
    const { st, ctx } = toTarget(0)
    expect(setTargetCursor(st, 'enemy', 1, ctx)).toBe(st)
    expect((setTargetCursor(st, 'enemy', 2, ctx)[1] as TargetWindow).cursor).toBe(2)
  })
})

describe('menuKeyAction', () => {
  it('矢印・決定・キャンセル。Space は使わない', () => {
    expect(menuKeyAction('ArrowUp')).toEqual({ type: 'move', dir: 'up' })
    expect(menuKeyAction('Enter')).toEqual({ type: 'confirm' })
    expect(menuKeyAction('z')).toEqual({ type: 'confirm' })
    expect(menuKeyAction('Escape')).toEqual({ type: 'cancel' })
    expect(menuKeyAction('Backspace')).toEqual({ type: 'cancel' })
    expect(menuKeyAction('x')).toEqual({ type: 'cancel' })
    expect(menuKeyAction(' ')).toBeUndefined()
    expect(menuKeyAction('a')).toBeUndefined()
  })
})

describe('一覧のスクロール（タップの▲▼）', () => {
  it('scrollList は先頭行を動かし、カーソルを見える範囲に収める。端で止まる', () => {
    const ctx = ctxOf({ maxRows: 2 })
    let st = openList(EMPTY_STACK, 'spell', ctx)
    for (let i = 0; i < 10; i++) st = scrollList(st, 1, ctx)
    expect(st[0]).toMatchObject({ top: 4, cursor: 4 })
    st = scrollList(st, -1, ctx)
    expect(st[0]).toMatchObject({ top: 3, cursor: 4 })
    for (let i = 0; i < 10; i++) st = scrollList(st, -1, ctx)
    expect(st[0]).toMatchObject({ top: 0, cursor: 1 })
  })

  it('スクロールだけで全行に届く', () => {
    const ctx = ctxOf({ maxRows: 1 })
    let st = openList(EMPTY_STACK, 'spell', ctx)
    const seen = new Set<number>()
    for (let i = 0; i < 6; i++) {
      seen.add((st[0] as { top: number }).top)
      st = scrollList(st, 1, ctx)
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('refitList: 見える行数が減ったらカーソルが見える位置へ先頭行を直す', () => {
    const wide = ctxOf({ maxRows: 6 })
    let st = setListCursor(openList(EMPTY_STACK, 'spell', wide), 5, wide)
    expect(st[0]).toMatchObject({ top: 0, cursor: 5 })
    st = refitList(st, ctxOf({ maxRows: 2 }))
    expect(st[0]).toMatchObject({ top: 4, cursor: 5 })
    expect(refitList(st, ctxOf({ maxRows: 2 }))).toBe(st)
  })
})
