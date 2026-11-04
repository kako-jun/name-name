/** 設定 JSON の `gearShop` (#881) が parseConfig でどう扱われるか */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from './config'
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

  it('不正は警告に出るがパースは失敗しない', () => {
    const r = parseConfig({ ...buildDummyFixture(), gearShop: 'yes' }, BASE)
    if (!r.ok) throw new Error(r.error)
    expect('gearShop' in r.value).toBe(false)
    expect((r.value.warnings ?? []).some((w) => w.includes('gearShop'))).toBe(true)
  })
})
