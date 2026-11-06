/** 設定 JSON の `menu` (#880) が parseConfig / ダミー fixture でどう扱われるか */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig } from './config'
import { buildDummyFixture } from './__fixtures__/dummyFixture'

const BASE = 'https://example.com/field/config.json'

// jsdom の canvas は未実装。dummyFixture の描画は検証対象外なので最小限の stub を置く（__fixtures__/dummyFixture.test.ts と同じ）
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

function fixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...buildDummyFixture(), ...extra }
}

describe('parseConfig の menu (#880)', () => {
  it('menu 未指定はキー自体が出ない（既存挙動不変）・警告にメニューの文言が出ない', () => {
    const r = parseConfig(fixture(), BASE)
    if (!r.ok) throw new Error(r.error)
    expect('menu' in r.value).toBe(false)
    expect((r.value.warnings ?? []).filter((w) => w.includes('menu'))).toEqual([])
  })

  it('menu: false もキーが出ない', () => {
    const r = parseConfig(fixture({ menu: false }), BASE)
    if (!r.ok) throw new Error(r.error)
    expect('menu' in r.value).toBe(false)
  })

  it('menu: true は既定の10項目', () => {
    const r = parseConfig(fixture({ menu: true }), BASE)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.menu?.items).toHaveLength(10)
  })

  it('dummy fixture の menu オプションで menu:true が入り、未指定はキーなし', () => {
    expect('menu' in buildDummyFixture()).toBe(false)
    expect(buildDummyFixture({ menu: true }).menu).toBe(true)
    const r = parseConfig(buildDummyFixture({ menu: true }), BASE)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.menu?.items[0].id).toBe('item')
  })

  it('menu.items を書くと差し替わる', () => {
    const r = parseConfig(fixture({ menu: { items: [{ id: 'a', label: 'A' }] } }), BASE)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.menu?.items).toEqual([{ id: 'a', label: 'A' }])
  })

  it('menu の不正は警告に出るがパース自体は失敗しない', () => {
    const r = parseConfig(fixture({ menu: 'yes' }), BASE)
    if (!r.ok) throw new Error(r.error)
    expect('menu' in r.value).toBe(false)
    expect((r.value.warnings ?? []).some((w) => w.includes('menu'))).toBe(true)
  })

  it('menu.transition の不正は警告し、既定の速さで続行', () => {
    const r = parseConfig(fixture({ menu: { transition: { slideMs: -5 } } }), BASE)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.menu?.transition.slideMs).toBe(140)
    expect((r.value.warnings ?? []).some((w) => w.includes('menu.transition'))).toBe(true)
  })
})

describe('9 項目の menu 宣言 (#880)', () => {
  const nineItems = () => [
    {
      id: 'item',
      label: 'どうぐ',
      content: {
        tabs: [
          { label: 'つかう', entries: [{ label: 'きずぐすり', detail: 'x 3' }] },
          { label: 'せいとん', entries: [] },
          { label: 'たいせつなもの', entries: [{ label: 'おまもり' }] },
        ],
      },
    },
    { id: 'magic', label: 'まほう' },
    { id: 'equip', label: 'そうび' },
    { id: 'appstore', label: 'アプリストア' },
    { id: 'magicite', label: 'ませき', enabled: false, disabledReason: 'まだ解放されていません' },
    { id: 'job', label: 'ジョブ', enabled: false, disabledReason: 'まだ解放されていません' },
    { id: 'status', label: 'ステータス' },
    {
      id: 'save',
      label: 'セーブ',
      blockedWhileTimed: true,
      timedReason: '時間制限中はセーブできません',
    },
    { id: 'config', label: 'せってい' },
  ]

  it('menu の警告なしでパースでき、9項目を持つ', () => {
    const r = parseConfig(fixture({ menu: { items: nineItems() } }), BASE)
    if (!r.ok) throw new Error(r.error)
    expect((r.value.warnings ?? []).filter((w) => w.includes('menu'))).toEqual([])
    expect(r.value.menu?.items.map((i) => i.id)).toEqual([
      'item',
      'magic',
      'equip',
      'appstore',
      'magicite',
      'job',
      'status',
      'save',
      'config',
    ])
  })

  it('灰色項目・時間制限中セーブ禁止の宣言が取り込まれている', () => {
    const r = parseConfig(fixture({ menu: { items: nineItems() } }), BASE)
    if (!r.ok) throw new Error(r.error)
    const by = Object.fromEntries((r.value.menu?.items ?? []).map((i) => [i.id, i]))
    expect(by.magicite.enabled).toBe(false)
    expect(by.job.disabledReason).toBe('まだ解放されていません')
    expect(by.save.blockedWhileTimed).toBe(true)
    expect(by.item.content?.tabs).toHaveLength(3)
  })
})
