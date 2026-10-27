import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from './config'
import { buildDummyFixture } from './dummyFixture'
import { buildMenuRows } from '../game/battleMenu'

// jsdom の canvas は未実装（getContext が null・console.error）。描画は検証対象外なので最小限の stub を置く
function stubCanvas(ctx: unknown) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => ctx) as unknown as HTMLCanvasElement['getContext']
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
    () => 'data:image/png;base64,AAAA'
  )
}
const fakeCtx = () =>
  new Proxy(
    {},
    { get: () => () => undefined, set: () => true }
  ) as unknown as CanvasRenderingContext2D

beforeEach(() => {
  stubCanvas(fakeCtx())
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildDummyFixture (#890)', () => {
  const parsed = () => {
    const r = parseConfig(buildDummyFixture(), 'http://localhost/field-sample.html')
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  it('ワープ（野原⇄電車内）と、電車内の揺れ・景色・エンカウント (#864)', () => {
    const c = parsed()
    expect(Object.keys(c.warps).sort()).toEqual(['toMeadow', 'toRuin', 'toTrain'])
    expect(c.warps.toTrain.to).toBe('train')
    expect(c.warps.toMeadow.to).toBe('meadow')
    expect(c.scenes.train.shake).toBeDefined()
    expect(c.scenes.train.scroll).toBeDefined()
    expect(c.scenes.train.encounter?.groups.length).toBeGreaterThan(0)
  })

  it('感情吹き出し (#937): ! ? ... を素材なしで持つ（… は 3 コマ）', () => {
    const c = parsed()
    expect(Object.keys(c.emotions ?? {})).toEqual(['!', '?', '...'])
    expect(c.emotions!['...'].frames).toBe(3)
    expect(c.emotions!['!'].motion).toBe('pop')
  })

  it('条件付き通行 (#862): assist・companion・フラグを持つ（?fixture=dummy で橙の階段を試せる）', () => {
    const c = parsed()
    expect(c.assist).not.toBeNull()
    expect(c.companion).not.toBeNull()
    expect(Object.keys(c.flags)).toContain(c.assist!.requires[0])
  })

  it('斜め 4 方向を 8 方向で持つ: 右側は自前の絵、左側は mirrorOf（左右反転）(#811)', () => {
    const c = parsed()
    for (const f of ['up', 'down', 'left', 'right', 'upRight', 'downRight'] as const)
      expect(c.player.sprites[f]).toHaveLength(3)
    expect(c.player.mirrorOf).toEqual({ upLeft: 'upRight', downLeft: 'downRight' })
    expect(c.player.sprites.upLeft).toBeUndefined()
    expect(c.player.sprites.downLeft).toBeUndefined()
  })

  it('parseConfig を通り、console.error / warn を出さない', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    parsed()
    expect(err).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('呪文 4・アイテム 2・cross の戦闘', () => {
    const c = parsed()
    expect(c.spells).toHaveLength(4)
    expect(c.items).toHaveLength(2)
    expect(c.battle.commandLayout).toBe('cross')
  })

  it('sit-by-me と同じ構成: たたかうを外した わざ・じゅもん・どうぐ・にげる、わざは MP なしの 2 件 (#873)', () => {
    const c = parsed()
    expect(c.battle.commands).toEqual(['skill', 'spell', 'item', 'escape'])
    expect(c.skills.map((s) => s.name)).toEqual(['きる', 'なぎはらい'])
  })

  it('全モンスターが idle / hurt / down のポーズを持つ', () => {
    for (const m of Object.values(parsed().monsters)) {
      expect(m.poses).toMatchObject({
        idle: expect.any(String),
        hurt: expect.any(String),
        down: expect.any(String),
      })
    }
  })

  it('エンカウント群が monsters と整合し、groupErrors が無い', () => {
    const c = parsed()
    expect(c.groupErrors ?? []).toEqual([])
    const ids = new Set(Object.keys(c.monsters))
    const groups = c.scenes[c.startScene].encounter!.groups
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) for (const id of String(g).split('+')) expect(ids.has(id)).toBe(true)
  })

  it('メテオは全員 MP 不足でグレー、エーテルは所持数 0 でグレー', () => {
    const c = parsed()
    const meteor = c.spells.find((s) => s.id === 'meteor')!
    for (const p of c.party) expect(p.mp).toBeLessThan(meteor.mp)
    const rows = buildMenuRows('item', c.items, { mp: 0 })
    expect(c.items.find((i) => i.id === 'ether')!.count).toBe(0)
    expect(rows.find((r) => r.label === 'エーテル')!.disabled).toBe(true)
    expect(rows.find((r) => r.label === 'ポーション')!.disabled).toBe(false)
  })

  it('canvas の 2D コンテキストを取れなければ Error', () => {
    vi.restoreAllMocks()
    stubCanvas(null)
    expect(() => buildDummyFixture()).toThrow(/canvas/)
  })
})
