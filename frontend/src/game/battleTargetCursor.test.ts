/** 対象選択・番の印の出し方 (#1189) の純粋関数と、敵の手の向き・敵名ウィンドウの行の強調と当たり判定（buildMenuView）の単体テスト */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enemyForListRow,
  enemyListCursorRows,
  enemyListRowMembers,
  normalizeBattleTargetCursor,
  showsStatusTurnMarker,
  showsTargetSelectMark,
} from './battleTargetCursor'
import { aggregateEnemyList } from './battleEnemyList'
import {
  HAND_WIDTH,
  buildMenuView,
  computeTargetHand,
  type MenuGeometry,
  type MenuTargetView,
} from './battleMenuLayout'
import type { MenuContext, MenuStack, TargetSpec } from './battleMenu'
import type { BattleEntity } from './spellDsl'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeBattleTargetCursor', () => {
  it('ff / off（大文字・空白も可）。未指定・空は off', () => {
    expect(normalizeBattleTargetCursor('ff')).toBe('ff')
    expect(normalizeBattleTargetCursor(' FF ')).toBe('ff')
    expect(normalizeBattleTargetCursor('off')).toBe('off')
    expect(normalizeBattleTargetCursor(undefined)).toBe('off')
    expect(normalizeBattleTargetCursor(null)).toBe('off')
    expect(normalizeBattleTargetCursor('  ')).toBe('off')
  })
  it('不正値は警告して off（warn=false なら警告しない）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeBattleTargetCursor('hand')).toBe('off')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(normalizeBattleTargetCursor('hand', false)).toBe('off')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('印の出し分け', () => {
  it('off（既定）は従来どおり: 対象に ▼・番の ▶ を出す', () => {
    expect(showsTargetSelectMark('off')).toBe(true)
    expect(showsStatusTurnMarker('off')).toBe(true)
  })
  it('ff は対象に ▼ を出さず（手だけ）、番の ▶ も出さない（番は頭上の ▼）', () => {
    expect(showsTargetSelectMark('ff')).toBe(false)
    expect(showsStatusTurnMarker('ff')).toBe(false)
  })
})

describe('enemyListRowMembers', () => {
  const enemies = [
    { name: 'スライム', hp: 5 },
    { name: 'イカ', hp: 5 },
    { name: 'スライム', hp: 0 },
    { name: 'スライム', hp: 5 },
    { name: 'スライム', hp: 5, status: ['どく'] },
    { name: 'コウモリ', hp: 0 },
  ]
  it('行は aggregateEnemyList と同じ順・同じ個数で、倒れた敵は入らない', () => {
    const members = enemyListRowMembers(enemies)
    expect(members).toEqual([[0, 3], [1], [4]])
    const rows = aggregateEnemyList(enemies)
    expect(rows.map((r) => r.count)).toEqual(members.map((m) => m.length))
  })
  it('enemyListCursorRows: 指されている敵が入る行だけ（重複なし・行の順）', () => {
    const members = enemyListRowMembers(enemies)
    expect(enemyListCursorRows(members, [3])).toEqual([0])
    expect(enemyListCursorRows(members, [4, 0, 3])).toEqual([0, 2])
    expect(enemyListCursorRows(members, [2])).toEqual([])
  })
  it('enemyForListRow: いま指している敵がその行にいれば動かさず、いなければ行の先頭。行が無ければ -1', () => {
    const members = enemyListRowMembers(enemies)
    expect(enemyForListRow(members, 0, 3)).toBe(3)
    expect(enemyForListRow(members, 0, 1)).toBe(0)
    expect(enemyForListRow(members, 1, 0)).toBe(1)
    expect(enemyForListRow(members, 9, 0)).toBe(-1)
  })
})

describe('敵を指す手の向き (computeTargetHand)', () => {
  const r = { x: 100, y: 100, w: 60, h: 60 }
  it('既定は敵の右から左向き（従来）', () => {
    const h = computeTargetHand('enemy', r, 800, 450)
    expect(h.facing).toBe('left')
    expect(h.x).toBeGreaterThanOrEqual(r.x + r.w)
  })
  it('ff は敵の左から右向き（FF と同じく手は右を指す）', () => {
    const h = computeTargetHand('enemy', r, 800, 450, true)
    expect(h.facing).toBe('right')
    expect(h.x + HAND_WIDTH).toBeLessThanOrEqual(r.x)
  })
  it('味方はどちらでも左から右向き', () => {
    expect(computeTargetHand('party', r, 800, 450)).toEqual(
      computeTargetHand('party', r, 800, 450, true)
    )
  })
})

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return { id, name: id, hp: 10, maxHp: 10, mp: 99, maxMp: 99, atk: 1, def: 0, agi: 1, ...over }
}

describe('buildMenuView: 敵名ウィンドウの行 (#1189)', () => {
  const party = [ent('hero')]
  const enemies = [
    ent('s1', { name: 'スライム' }),
    ent('ika', { name: 'イカ' }),
    ent('s2', { name: 'スライム' }),
  ]
  const ctx: MenuContext = {
    rows: [],
    maxRows: 4,
    entries: [],
    party,
    enemies,
    actorIndex: 0,
  }
  const listRows = [
    { rect: { x: 300, y: 370, w: 150, h: 20 }, members: [0, 2] },
    { rect: { x: 300, y: 390, w: 150, h: 20 }, members: [1] },
  ]
  const base: MenuGeometry = {
    width: 800,
    height: 450,
    command: { x: 10, y: 360, w: 280, h: 80 },
    top: 60,
    enemySlots: [
      { x: 40, y: 100, w: 60, h: 60 },
      { x: 40, y: 200, w: 60, h: 60 },
      { x: 120, y: 150, w: 60, h: 60 },
    ],
    partySlots: [{ x: 700, y: 150, w: 40, h: 60 }],
  }
  const spec = (over: Partial<TargetSpec>): TargetSpec => ({
    side: 'enemy',
    scope: 'single',
    ...over,
  })
  const target = (cursor: number, over: Partial<TargetSpec> = {}): MenuStack => [
    { type: 'list', kind: 'spell', cursor: 0, top: 0 },
    {
      type: 'target',
      kind: 'spell',
      entryIndex: 0,
      spec: spec(over),
      side: spec(over).side,
      cursor,
    },
  ]
  const view = (stack: MenuStack, g: MenuGeometry): MenuTargetView =>
    buildMenuView(stack, ctx, g).find((v) => v.type === 'target') as MenuTargetView

  it('未指定（off）は従来どおり: 手は絵の 1 本だけで、行の強調も行の当たり判定も無い', () => {
    const v = view(target(2), base)
    expect(v.hands).toHaveLength(1)
    expect(v.highlights).toBeUndefined()
    expect(v.hits.every((h) => h.rect.x !== 300)).toBe(true)
  })
  it('敵単体: 手は絵の 1 本だけで、指す敵が入る行を強調する（同じ敵を指す）', () => {
    const v = view(target(2), { ...base, enemyListRows: listRows })
    expect(v.hands).toHaveLength(1)
    expect(v.highlights).toEqual([listRows[0].rect])
    expect(view(target(1), { ...base, enemyListRows: listRows }).highlights).toEqual([
      listRows[1].rect,
    ])
  })
  it('行のタップ: いま指している敵の行なら同じ敵、別の行ならその行の先頭の敵', () => {
    const v = view(target(2), { ...base, enemyListRows: listRows })
    const rowHits = v.hits.filter((h) => h.rect.x === 300)
    expect(rowHits).toEqual([
      { side: 'enemy', index: 2, rect: listRows[0].rect },
      { side: 'enemy', index: 1, rect: listRows[1].rect },
    ])
  })
  it('敵全体: 生きている敵が入る全部の行を強調する', () => {
    const v = view(target(0, { scope: 'all' }), { ...base, enemyListRows: listRows })
    expect(v.highlights).toEqual([listRows[0].rect, listRows[1].rect])
  })
  it('味方を指す対象選択では、行の強調も行の当たり判定も出さない', () => {
    const v = view(target(0, { side: 'party' }), { ...base, enemyListRows: listRows })
    expect(v.highlights).toBeUndefined()
    expect(v.hits.some((h) => h.rect.x === 300)).toBe(false)
  })
  it('ff の手の向き: geometry の targetCursor で敵の手が左から右向きになる', () => {
    const [h] = view(target(2), { ...base, targetCursor: 'ff' }).hands
    expect(h).toEqual(computeTargetHand('enemy', base.enemySlots[2], 800, 450, true))
  })
})
