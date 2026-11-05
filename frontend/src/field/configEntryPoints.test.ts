import { describe, it, expect } from 'vitest'
import { parseConfig, type FieldConfig } from './config'
import { clearWindowField } from './windowField'
import { pickScriptEvents, shouldCheckNpcScripts } from './scriptSource'

const BASE = 'https://example.com/field/config.json'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>

function minimal(): Raw {
  const frames = (d: string) => [`${d}1.png`, `${d}2.png`, `${d}3.png`]
  return {
    startScene: 'a',
    start: { x: 10, y: 20 },
    player: {
      sprites: {
        up: frames('up'),
        down: frames('down'),
        left: frames('left'),
        right: frames('right'),
      },
    },
    scenes: { a: { background: 'a.png', mask: 'a-mask.png' } },
  }
}

function ok(raw: unknown, opts?: { scriptProvided?: boolean }): FieldConfig {
  const r = parseConfig(raw, BASE, opts)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('party[].id', () => {
  const party = (extra: Raw[]): Raw => ({
    ...minimal(),
    party: extra.map((e, i) => ({ name: `m${i}`, hp: 10, ...e })),
  })
  it('id が無ければ従来の party{i+1}', () => {
    expect(ok(party([{}, {}])).party.map((p) => p.id)).toEqual(['party1', 'party2'])
  })
  it('非空文字列の id を使う', () => {
    expect(ok(party([{ id: 'alpha' }, {}, { id: 'gamma' }])).party.map((p) => p.id)).toEqual([
      'alpha',
      'party2',
      'gamma',
    ])
  })
  it('id の重複は読み込みエラー（明示同士・既定 party{N} との衝突）', () => {
    const r1 = parseConfig(party([{ id: 'a' }, { id: 'a' }]), BASE)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toContain('重複')
    const r2 = parseConfig(party([{}, { id: 'party1' }]), BASE)
    expect(r2.ok).toBe(false)
  })
  it('空文字・非文字列は無視して party{i+1}', () => {
    expect(ok(party([{ id: '' }, { id: 5 }])).party.map((p) => p.id)).toEqual(['party1', 'party2'])
  })
})

describe('monsters の透過キー', () => {
  const withMonster = (m: Raw): Raw => ({
    ...minimal(),
    monsters: { foe: { name: 'てき', hp: 5, ...m } },
  })
  it('キーが無ければ出ない（従来と同一）', () => {
    const m = ok(withMonster({})).monsters.foe
    for (const k of ['actions', 'counters', 'onDeath', 'affinity', 'loot'])
      expect(k in m).toBe(false)
  })
  it('actions/counters/onDeath/affinity/loot をそのまま通す', () => {
    const extra = {
      actions: ['A 50%', 'B'],
      counters: ['C'],
      onDeath: 'D',
      affinity: { weak: ['fire'] },
      loot: { drops: ['item1 確率=50'], stealLimit: '2' },
    }
    const m = ok(withMonster(extra)).monsters.foe
    expect(m.actions).toEqual(extra.actions)
    expect(m.counters).toEqual(extra.counters)
    expect(m.onDeath).toBe('D')
    expect(m.affinity).toEqual(extra.affinity)
    expect(m.loot).toEqual(extra.loot)
  })
  it('型が合わないキーは出さない', () => {
    const m = ok(withMonster({ actions: 'x', counters: [1], onDeath: 3, affinity: [], loot: 'x' }))
      .monsters.foe
    for (const k of ['actions', 'counters', 'onDeath', 'affinity', 'loot'])
      expect(k in m).toBe(false)
  })
})

describe('scriptProvided', () => {
  const withNpc = (): Raw => {
    const c = minimal()
    c.scenes.a.npcs = [{ id: 'n', name: 'N', x: 1, y: 1, sprite: 'n.png', line: 'x', scene: 's' }]
    return c
  }
  it('既定は警告を出す', () => {
    expect(ok(withNpc()).warnings?.[0]).toContain('scriptUrl がありません')
  })
  it('scriptProvided:false も同じ', () => {
    expect(ok(withNpc(), { scriptProvided: false }).warnings?.[0]).toContain(
      'scriptUrl がありません'
    )
  })
  it('scriptProvided:true は警告なし', () => {
    expect(ok(withNpc(), { scriptProvided: true }).warnings).toBeUndefined()
  })
})

describe('startFacing', () => {
  it('未指定はキーが出ない・警告なし', () => {
    const c = ok(minimal())
    expect('startFacing' in c).toBe(false)
    expect(c.warnings).toBeUndefined()
  })
  it('4 方向を読む', () => {
    for (const f of ['up', 'down', 'left', 'right'])
      expect(ok({ ...minimal(), startFacing: f }).startFacing).toBe(f)
  })
  it('不正は警告して無視', () => {
    for (const bad of ['upLeft', 'x', 3, null]) {
      const c = ok({ ...minimal(), startFacing: bad })
      expect('startFacing' in c).toBe(false)
      expect(c.warnings).toHaveLength(1)
      expect(c.warnings?.[0]).toContain('startFacing')
    }
  })
})

describe('clearWindowField', () => {
  const w = window as unknown as { field?: unknown }
  it('自分が置いたものは消す', () => {
    const api = {}
    w.field = api
    clearWindowField(api)
    expect(w.field).toBeUndefined()
    expect('field' in w).toBe(false)
  })
  it('別のフィールドが置き直したものは消さない', () => {
    const mine = {}
    const other = {}
    w.field = other
    clearWindowField(mine)
    expect(w.field).toBe(other)
    delete w.field
  })
})

describe('scriptSource', () => {
  const provided = new Map([['e', []]]) as never
  it('渡された脚本を優先し、取得は呼ばない', async () => {
    let called = false
    const r = await pickScriptEvents(provided, async () => {
      called = true
      return undefined
    })
    expect(r).toBe(provided)
    expect(called).toBe(false)
  })
  it('渡されなければ従来どおり取得する', async () => {
    const loaded = new Map() as never
    expect(await pickScriptEvents(undefined, async () => loaded)).toBe(loaded)
    expect(await pickScriptEvents(undefined, async () => undefined)).toBeUndefined()
  })
  it('scene 照合の警告は、供給元（渡された・scriptUrl）があるときだけ', () => {
    expect(shouldCheckNpcScripts(provided, undefined)).toBe(true)
    expect(shouldCheckNpcScripts(undefined, 'https://e/x.md')).toBe(true)
    expect(shouldCheckNpcScripts(undefined, undefined)).toBe(false)
    expect(shouldCheckNpcScripts(undefined, '')).toBe(false)
  })
  it('both 指定でも scriptEvents 優先（取得せず、照合は有効）', async () => {
    let called = false
    expect(await pickScriptEvents(provided, async () => ((called = true), undefined))).toBe(
      provided
    )
    expect(called).toBe(false)
    expect(shouldCheckNpcScripts(provided, 'https://e/x.md')).toBe(true)
  })
})
