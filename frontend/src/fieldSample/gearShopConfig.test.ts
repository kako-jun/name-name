/** 設定 JSON の `gearShop` (#881) が parseConfig でどう扱われるか */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from './config'
import { buildBattleEngineOptions } from './battleOptions'
import { buildDummyFixture } from './__fixtures__/dummyFixture'

const BASE = 'https://example.com/field/config.json'

// jsdom の canvas は未実装（menuConfig.test.ts と同じ stub）
beforeEach(() => {
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => ctx) as unknown as HTMLCanvasElement['getContext']
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
    () => 'data:image/png;base64,AAAA'
  )
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseConfig の gearShop (#881)', () => {
  it('未指定はキー自体が出ない・警告なし（既存挙動不変）', () => {
    const r = parseConfig(buildDummyFixture(), BASE)
    if (!r.ok) throw new Error(r.error)
    expect('gearShop' in r.value).toBe(false)
    expect((r.value.warnings ?? []).filter((w) => w.includes('gearShop'))).toEqual([])
  })

  it('書くと読まれる（値は仮）', () => {
    const raw = {
      ...buildDummyFixture(),
      gearShop: { entries: [{ id: 'blade1', kind: 'blade', owner: 'party1', basePrice: 100 }] },
    }
    const r = parseConfig(raw, BASE)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.gearShop?.multiplier).toBe(2)
    expect(r.value.gearShop?.entries).toHaveLength(1)
  })

  it('image は他の画像と同じ規則で URL になる（アプリストアの一覧の画像）', () => {
    const raw = {
      ...buildDummyFixture(),
      gearShop: {
        entries: [
          { id: 'blade1', kind: 'blade', owner: 'party1', basePrice: 100, image: 'gear/a.png' },
          { id: 'blade2', kind: 'blade', owner: 'party1', basePrice: 100 },
        ],
      },
    }
    const r = parseConfig(raw, BASE)
    if (!r.ok) throw new Error(r.error)
    const [a, b] = r.value.gearShop!.entries
    expect(a.image).toMatch(/^https:\/\/example\.com\/.*gear\/a\.png$/)
    expect('image' in b).toBe(false)
  })

  it('不正は警告に出るがパースは失敗しない', () => {
    const r = parseConfig({ ...buildDummyFixture(), gearShop: 'yes' }, BASE)
    if (!r.ok) throw new Error(r.error)
    expect('gearShop' in r.value).toBe(false)
    expect((r.value.warnings ?? []).some((w) => w.includes('gearShop'))).toBe(true)
  })
})

describe('parseConfig の battle.currencyName (#881)', () => {
  const withBattle = (currencyName: unknown) => {
    const base = buildDummyFixture() as Record<string, unknown>
    const battle = (base.battle ?? {}) as Record<string, unknown>
    return { ...base, battle: { ...battle, currencyName } }
  }
  it('未指定はキーなし・警告なし、指定すると読まれてエンジンのオプションへ渡る', () => {
    const none = parseConfig(buildDummyFixture(), BASE)
    if (!none.ok) throw new Error(none.error)
    expect('currencyName' in none.value.battle).toBe(false)
    expect(buildBattleEngineOptions(none.value.battle)).not.toHaveProperty('currencyName')
    const r = parseConfig(withBattle(' 円 '), BASE)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.battle.currencyName).toBe('円')
    expect(buildBattleEngineOptions(r.value.battle).currencyName).toBe('円')
  })
  it.each(['', '  ', 5, null, {}])('不正値 %j は警告して無視', (v) => {
    const r = parseConfig(withBattle(v), BASE)
    if (!r.ok) throw new Error(r.error)
    expect('currencyName' in r.value.battle).toBe(false)
    expect((r.value.warnings ?? []).some((w) => w.includes('battle.currencyName'))).toBe(true)
  })
})
