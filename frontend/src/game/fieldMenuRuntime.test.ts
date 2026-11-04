/** 全画面メニューの実行時の配線 (#880 / fieldMenuRuntime.ts) のテスト */
import { describe, expect, it, vi } from 'vitest'
import type { BattleItemEntry, BattleSpellEntry } from './battleMenu'
import { DEFAULT_FIELD_MENU_ITEMS } from './fieldMenu'
import { FieldMenuRuntime, type FieldMenuRuntimeDeps } from './fieldMenuRuntime'
import { DEFAULT_MENU_TRANSITION } from './fieldMenuTransition'
import type { BattleEntity } from './spellDsl'

const ent = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id,
  hp: 10,
  maxHp: 40,
  mp: 6,
  maxMp: 6,
  atk: 1,
  def: 1,
  agi: 1,
  ...over,
})
const items: BattleItemEntry[] = [
  { id: 'bomb', name: 'ばくだん', effect: 'damage 5..9', count: 1 },
  { id: 'potion', name: 'ポーション', effect: 'heal 20..20', count: 2 },
]
const spells: BattleSpellEntry[] = [
  { id: 'cure', name: 'ケアル', mp: 2, target: '味方単体', effect: 'heal 15..15' },
]

function setup(
  over: Partial<FieldMenuRuntimeDeps> = {},
  saved?: ConstructorParameters<typeof FieldMenuRuntime>[1]
) {
  const state = {
    party: [ent('a'), ent('b', { hp: 40 })],
    inventory: { bomb: 1, potion: 2 } as Record<string, number>,
  }
  const changed = vi.fn()
  const rt = new FieldMenuRuntime(
    {
      menu: { items: [...DEFAULT_FIELD_MENU_ITEMS], transition: { ...DEFAULT_MENU_TRANSITION } },
      items,
      spells,
      skills: [],
      audio: false,
      getParty: () => state.party,
      setParty: (p) => (state.party = p),
      getInventory: () => state.inventory,
      setInventory: (i) => (state.inventory = i),
      getEquipment: () => ({}),
      onSettingsChanged: changed,
      rng: () => 0,
      ...over,
    },
    saved
  )
  return { rt, state, changed }
}

describe('items()', () => {
  it('既定9項目のうち どうぐ・まほう・ステータス・せってい に中身が入り、他は定義のまま', () => {
    const { rt } = setup()
    const out = rt.items()
    const by = Object.fromEntries(out.map((d) => [d.id, d]))
    expect(by.item.content?.tabs).toHaveLength(3)
    expect(Object.keys(by.magic.content?.entriesByParty ?? {})).toEqual(['a', 'b'])
    expect(by.status.content?.statusByParty).toBeDefined()
    expect(by.config.content?.options?.length).toBe(7)
    for (const id of ['equip', 'appstore', 'magicite', 'job', 'save'])
      expect(by[id].content).toBeUndefined()
  })
  it('使うたびに最新の所持数・HP が反映される', () => {
    const { rt } = setup()
    rt.use({ screen: 'item', entryId: 'potion', targetId: 'a' })
    const tab = rt.items().find((d) => d.id === 'item')!.content!.tabs![0]
    expect(tab.entries.find((e) => e.id === 'potion')?.detail).toBe('×1')
  })
  it('ターン制・音なしでは せってい の説明に「効きません」', () => {
    const o = setup()
      .rt.items()
      .find((d) => d.id === 'config')!.content!.options!
    expect(o.find((x) => x.key === 'battleMode')?.description).toContain('ターン制')
    expect(o.find((x) => x.key === 'bgm')?.description).toContain('効きません')
  })
  it('ATB なら バトルモードの初期位置がゲーム設定のモード', () => {
    const o = setup({ atb: { mode: 'active' } })
      .rt.items()
      .find((d) => d.id === 'config')!.content!.options!
    expect(o.find((x) => x.key === 'battleMode')?.initial).toBe(1)
  })
})

describe('use()', () => {
  it('どうぐ: 対象を回復して所持数を減らし、正本（getParty / getInventory）へ書き戻す', () => {
    const { rt, state } = setup()
    const out = rt.use({ screen: 'item', entryId: 'potion', targetId: 'a' })
    expect(out?.ok).toBe(true)
    expect(state.party[0].hp).toBe(30)
    expect(state.inventory.potion).toBe(1)
    expect(out?.party?.find((p) => p.id === 'a')).toMatchObject({ hp: 30, maxHp: 40 })
    expect(out?.items).toBeDefined()
  })
  it('まほう: MP を消費して回復。表示更新には MP も載る', () => {
    const { rt, state } = setup()
    const out = rt.use({ screen: 'magic', entryId: 'cure', casterId: 'b', targetId: 'a' })
    expect(out?.ok).toBe(true)
    expect(state.party[0].hp).toBe(25)
    expect(state.party[1].mp).toBe(4)
    expect(out?.party?.find((p) => p.id === 'b')?.mp).toBe(4)
  })
  it('使えなかったときは正本を変えず、理由を返す', () => {
    const { rt, state } = setup()
    const before = JSON.stringify(state)
    const out = rt.use({ screen: 'item', entryId: 'bomb', targetId: 'a' })
    expect(out?.ok).toBe(false)
    expect(out?.notice).toContain('ここでは')
    expect(JSON.stringify(state)).toBe(before)
  })
  it('未対応の画面・entryId なし・使い手なしのまほうは null（画面側が「まだありません」）', () => {
    const { rt } = setup()
    expect(rt.use({ screen: 'equip', entryId: 'x' })).toBeNull()
    expect(rt.use({ screen: 'item' })).toBeNull()
    expect(rt.use({ screen: 'magic', entryId: 'cure' })).toBeNull()
    expect(rt.use({ screen: 'nope', entryId: 'x' })).toBeNull()
  })
})

describe('sort() とセーブ状態', () => {
  it('並べ替えると種類順になり、saveState に itemOrder が載る', () => {
    const { rt } = setup()
    expect(rt.saveState()).toBeUndefined()
    const r = rt.sort()
    const ids = r.items!.find((d) => d.id === 'item')!.content!.tabs![1].entries.map((e) => e.id)
    expect(ids).toEqual(['potion', 'bomb'])
    expect(rt.saveState()).toEqual({ itemOrder: ['potion', 'bomb'] })
  })
  it('保存値から復元（settings は正規化・itemOrder は保持）。不正値は捨てる', () => {
    const { rt } = setup(
      {},
      {
        settings: { battleMode: 1, battleSpeed: 99 },
        itemOrder: ['potion', 'bomb'],
      }
    )
    expect(rt.currentSettings).toEqual({ battleMode: 1 })
    const ids = rt
      .items()
      .find((d) => d.id === 'item')!
      .content!.tabs![1].entries.map((e) => e.id)
    expect(ids).toEqual(['potion', 'bomb'])
    const bad = setup({}, { itemOrder: 'x' as unknown as string[] }).rt
    expect(bad.saveState()).toBeUndefined()
  })
  it('settings も saveState に載る', () => {
    const { rt } = setup()
    rt.setSetting('cursor', 1)
    expect(rt.saveState()).toEqual({ settings: { cursor: 1 } })
  })
})

describe('setSetting', () => {
  it('反映して変更を通知。範囲外・未知のキーは無視（値は変わらない）', () => {
    const { rt, changed } = setup()
    rt.setSetting('messageSpeed', 4)
    expect(rt.currentSettings).toEqual({ messageSpeed: 4 })
    expect(changed).toHaveBeenLastCalledWith({ messageSpeed: 4 })
    rt.setSetting('messageSpeed', 9)
    expect(rt.currentSettings).toEqual({})
    rt.setSetting('zzz', 1)
    expect(rt.currentSettings).toEqual({})
  })
  it('currentSettings はコピー（外から書き換えても内部は変わらない）', () => {
    const { rt } = setup()
    rt.setSetting('cursor', 1)
    rt.currentSettings.cursor = 0
    expect(rt.currentSettings.cursor).toBe(1)
  })
})

describe('定義側の独自 options の値（再オープン・セーブ/ロードを跨ぐ）', () => {
  const custom = {
    menu: {
      items: [
        ...DEFAULT_FIELD_MENU_ITEMS.filter((d) => d.id !== 'config'),
        {
          id: 'config',
          label: 'せってい',
          content: { options: [{ key: 'myOpt', label: '独自', choices: ['a', 'b', 'c'] }] },
        },
      ],
      transition: { ...DEFAULT_MENU_TRANSITION },
    },
  }
  it('独自キーの値は保持され、saveState に載り、復元でも残る', () => {
    const { rt } = setup(custom)
    rt.setSetting('myOpt', 2)
    expect(rt.currentSettings).toEqual({ myOpt: 2 })
    expect(rt.saveState()).toEqual({ settings: { myOpt: 2 } })
    const { rt: loaded } = setup(custom, rt.saveState())
    expect(loaded.currentSettings).toEqual({ myOpt: 2 })
  })
  it('独自 options の選択肢数の範囲外・既定項目のキー（その定義に無い）は捨てる', () => {
    const { rt } = setup(custom)
    rt.setSetting('myOpt', 3)
    rt.setSetting('battleMode', 1)
    expect(rt.currentSettings).toEqual({})
  })
})
