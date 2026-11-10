import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NPC_MOVE_SPEED,
  createNpcMoveQueue,
  pickNpcByName,
  resolveNpcSpeed,
  type MovableNpc,
} from './fieldNpcMove'

const mk = (x = 0, y = 0): MovableNpc => ({ x, y, facing: 'down' })

afterEach(() => vi.restoreAllMocks())

describe('createNpcMoveQueue (#1073)', () => {
  it('着いたら resolve し、目標ちょうどに置いて size は 0', async () => {
    const q = createNpcMoveQueue()
    const npc = mk()
    const done = vi.fn()
    void q.start(npc, { x: 100, y: 0 }, 100).then(done)
    expect(q.size()).toBe(1)
    q.tick(500)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    expect(npc.x).toBeCloseTo(50)
    expect(npc.facing).toBe('right')
    q.tick(500)
    await Promise.resolve()
    expect(done).toHaveBeenCalledTimes(1)
    expect(npc).toMatchObject({ x: 100, y: 0 })
    expect(q.size()).toBe(0)
  })
  it('pxPerSec の換算: 200px/秒 × 250ms = 50px', () => {
    const q = createNpcMoveQueue()
    const npc = mk()
    void q.start(npc, { x: 1000, y: 0 }, 200)
    q.tick(250)
    expect(npc.x).toBeCloseTo(50)
  })
  it('tick を呼ばない間は止まる', async () => {
    const q = createNpcMoveQueue()
    const npc = mk()
    const done = vi.fn()
    void q.start(npc, { x: 10, y: 0 }, 100).then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    expect(npc.x).toBe(0)
  })
  it('dt=0 では進まない', () => {
    const q = createNpcMoveQueue()
    const npc = mk()
    void q.start(npc, { x: 10, y: 0 }, 100)
    q.tick(0)
    expect(npc.x).toBe(0)
    expect(q.size()).toBe(1)
  })
  it('同じ NPC の再要求で前の Promise が resolve され、新しい目標へ向かう', async () => {
    const q = createNpcMoveQueue()
    const npc = mk()
    const first = vi.fn()
    const second = vi.fn()
    void q.start(npc, { x: 100, y: 0 }, 10).then(first)
    void q.start(npc, { x: 0, y: 100 }, 10).then(second)
    await Promise.resolve()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(q.size()).toBe(1)
    q.tick(1000)
    expect(npc.x).toBe(0)
    expect(npc.y).toBeCloseTo(10)
  })
  it('別 NPC 2 体は並行して動く', async () => {
    const q = createNpcMoveQueue()
    const a = mk()
    const b = mk(0, 50)
    const da = vi.fn()
    const db = vi.fn()
    void q.start(a, { x: 10, y: 0 }, 10).then(da)
    void q.start(b, { x: 100, y: 50 }, 10).then(db)
    expect(q.size()).toBe(2)
    q.tick(1000)
    await Promise.resolve()
    expect(da).toHaveBeenCalledTimes(1)
    expect(db).not.toHaveBeenCalled()
    expect(b.x).toBeCloseTo(10)
    expect(q.size()).toBe(1)
  })
  it('同じ tick で複数が同時に着いても取りこぼさない', async () => {
    const q = createNpcMoveQueue()
    const fns = [vi.fn(), vi.fn(), vi.fn()]
    const npcs = [mk(), mk(0, 10), mk(0, 20)]
    npcs.forEach((n, i) => void q.start(n, { x: 5, y: n.y }, 100).then(fns[i]))
    q.tick(1000)
    await Promise.resolve()
    for (const f of fns) expect(f).toHaveBeenCalledTimes(1)
    expect(q.size()).toBe(0)
  })
  it('着いた NPC と着いていない NPC が混ざっても、後者は動き続ける', () => {
    const q = createNpcMoveQueue()
    const a = mk()
    const b = mk()
    const c = mk()
    void q.start(a, { x: 1000, y: 0 }, 10)
    void q.start(b, { x: 1, y: 0 }, 10)
    void q.start(c, { x: 1000, y: 0 }, 10)
    q.tick(1000)
    expect(q.size()).toBe(2)
    q.tick(1000)
    expect(a.x).toBeCloseTo(20)
    expect(c.x).toBeCloseTo(20)
  })
  it('clear() で全部 resolve し size は 0', async () => {
    const q = createNpcMoveQueue()
    const fns = [vi.fn(), vi.fn()]
    void q.start(mk(), { x: 100, y: 0 }, 1).then(fns[0])
    void q.start(mk(), { x: 100, y: 0 }, 1).then(fns[1])
    q.clear()
    await Promise.resolve()
    for (const f of fns) expect(f).toHaveBeenCalledTimes(1)
    expect(q.size()).toBe(0)
  })
  it('clear 後の tick は何も起こさない', () => {
    const q = createNpcMoveQueue()
    const npc = mk()
    void q.start(npc, { x: 100, y: 0 }, 10)
    q.clear()
    q.tick(1000)
    expect(npc.x).toBe(0)
  })
  it('警告を出さない', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const q = createNpcMoveQueue()
    void q.start(mk(), { x: 1, y: 0 }, 10)
    q.tick(1000)
    q.clear()
    expect(w).not.toHaveBeenCalled()
  })
})

describe('pickNpcByName (#1073)', () => {
  const npcs = [
    { id: 'elder', def: { name: '長老' } },
    { id: 'kid', def: { name: '子' } },
    { id: 'kid2', def: { name: '子' } },
    { id: '子', def: { name: 'idが子の人' } },
  ]
  it('name が合うものを返す', () => {
    expect(pickNpcByName(npcs, '長老')?.id).toBe('elder')
  })
  it('name を id より優先する', () => {
    expect(pickNpcByName(npcs, '子')?.id).toBe('kid')
  })
  it('name が無ければ id で探す', () => {
    expect(pickNpcByName(npcs, 'elder')?.id).toBe('elder')
  })
  it('同名は先頭', () => {
    expect(pickNpcByName(npcs, '子')).toBe(npcs[1])
  })
  it('居なければ undefined', () => {
    expect(pickNpcByName(npcs, 'nobody')).toBeUndefined()
    expect(pickNpcByName([], 'x')).toBeUndefined()
  })
})

describe('resolveNpcSpeed (#1073)', () => {
  it('正常値はそのまま・警告なし', () => {
    const warn = vi.fn()
    expect(resolveNpcSpeed(2, warn)).toBe(2)
    expect(resolveNpcSpeed(0.5, warn)).toBe(0.5)
    expect(warn).not.toHaveBeenCalled()
  })
  it.each([0, -1, Number.NaN, Infinity, -Infinity])('%s は警告 1 回で既定 3', (v) => {
    const warn = vi.fn()
    expect(resolveNpcSpeed(v, warn)).toBe(3)
    expect(DEFAULT_NPC_MOVE_SPEED).toBe(3)
    expect(warn).toHaveBeenCalledTimes(1)
  })
  it('warn 省略時は console.warn に 1 回出す', () => {
    const w = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveNpcSpeed(0)).toBe(3)
    expect(w).toHaveBeenCalledTimes(1)
  })
})
