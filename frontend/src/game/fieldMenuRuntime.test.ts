/** 全画面メニューの実行時の配線 (#880 / fieldMenuRuntime.ts) のテスト */
import { describe, expect, it, vi } from 'vitest'
import type { BattleItemEntry, BattleSpellEntry } from './battleMenu'
import { DEFAULT_FIELD_MENU_ITEMS } from './fieldMenu'
import { FieldMenuRuntime, type FieldMenuRuntimeDeps } from './fieldMenuRuntime'
import { DEFAULT_MENU_TRANSITION } from './fieldMenuTransition'
import { emptyGearState, type GearShopConfig, type GearState } from './gearShop'
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

describe('アプリストア・そうび (#881 段階2)', () => {
  // 値は「仮」
  const cfg: GearShopConfig = {
    multiplier: 2,
    entries: [
      { id: 'sw1', kind: 'blade', owner: 'a', basePrice: 100, equipBonus: 'atk+5' },
      { id: 'sw2', kind: 'blade', owner: 'a', basePrice: 100, equipBonus: 'atk+9' },
      { id: 'vest', kind: 'armor', price: 50, equipBonus: 'def+3' },
    ],
  }
  function gearSetup(gold = 1000, flags: Record<string, boolean> = {}) {
    const g = {
      state: emptyGearState() as GearState,
      gold,
      equipment: {} as Record<string, string[]>,
    }
    const r = setup({
      items: [...items, { id: 'sw1', name: '正宗', effect: '' } as BattleItemEntry],
      getEquipment: () => g.equipment,
      gear: {
        cfg,
        getState: () => g.state,
        setState: (s) => (g.state = s),
        getGold: () => g.gold,
        setGold: (n) => (g.gold = n),
        getFlags: () => flags,
        setEquipment: (m, l) => (g.equipment[m] = l),
      },
    })
    return { ...r, g }
  }
  const by = (rt: FieldMenuRuntime, id: string) => rt.items().find((d) => d.id === id)!

  it('売り物の定義があると appstore・equip に中身が入る。無いゲームは従来どおり枠だけ', () => {
    const { rt } = gearSetup()
    expect(by(rt, 'appstore').content?.tabs?.map((t) => t.label)).toEqual(['刀', '防具'])
    expect(Object.keys(by(rt, 'equip').content?.entriesByParty ?? {})).toEqual(['a', 'b'])
    const none = setup().rt
    expect(by(none, 'appstore').content).toBeUndefined()
    expect(by(none, 'equip').content).toBeUndefined()
  })
  it('買うと所持金が減り、購入済みになり、装備はしない。結果の一覧が返る', () => {
    const { rt, g } = gearSetup()
    const out = rt.use({ screen: 'appstore', entryId: 'sw1', casterId: 'a' })!
    expect(out.ok).toBe(true)
    expect(g.gold).toBe(900)
    expect(g.state.owned.a).toEqual(['sw1'])
    expect(g.equipment).toEqual({})
    const tab = out.items!.find((d) => d.id === 'appstore')!.content!.tabs![0]
    expect(tab.entriesByParty!.a[0].detail).toBe('購入済み')
    expect(tab.entriesByParty!.a[1].detail).toBe('200円')
  })
  it('所持金が足りなければ何も変えず理由を返す。人物が分からない要求は null', () => {
    const { rt, g } = gearSetup(50)
    const out = rt.use({ screen: 'appstore', entryId: 'sw1', casterId: 'a' })!
    expect(out.ok).toBe(false)
    expect(out.notice).toContain('所持金が足りません')
    expect(g.gold).toBe(50)
    expect(g.state.owned).toEqual({})
    expect(rt.use({ screen: 'appstore', entryId: 'sw1' })).toBeNull()
  })
  it('他人の刀・解禁前は買えない（人物 b に a の刀）', () => {
    const { rt, g } = gearSetup()
    expect(rt.use({ screen: 'appstore', entryId: 'sw1', casterId: 'b' })!.ok).toBe(false)
    expect(g.gold).toBe(1000)
  })
  it('持ち替えで装備列と gear.blade が更新され、そうびの見出しに出る。未購入は不可', () => {
    const { rt, g } = gearSetup()
    expect(rt.use({ screen: 'equip', entryId: 'sw1', casterId: 'a' })!.ok).toBe(false)
    rt.use({ screen: 'appstore', entryId: 'sw1', casterId: 'a' })
    rt.use({ screen: 'appstore', entryId: 'sw2', casterId: 'a' })
    const out = rt.use({ screen: 'equip', entryId: 'sw1', casterId: 'a' })!
    expect(out.ok).toBe(true)
    expect(g.equipment.a).toEqual(['sw1'])
    expect(g.state.blade.a).toBe('sw1')
    const swap = rt.use({ screen: 'equip', entryId: 'sw2', casterId: 'a' })!
    expect(swap.ok).toBe(true)
    expect(g.equipment.a).toEqual(['sw2'])
    const head = swap.items!.find((d) => d.id === 'equip')!.content!.headerByParty!.a
    expect(head[0].value).toBe('sw2')
  })
  it('防具は付け外しできる', () => {
    const { rt, g } = gearSetup()
    rt.use({ screen: 'appstore', entryId: 'vest', casterId: 'a' })
    expect(g.gold).toBe(950)
    rt.use({ screen: 'equip', entryId: 'vest', casterId: 'a' })
    expect(g.equipment.a).toEqual(['vest'])
    rt.use({ screen: 'equip', entryId: 'vest', casterId: 'a' })
    expect(g.equipment.a).toEqual([])
  })
  it('定義側が appstore の中身を書いていれば差し込まない（空の tabs・空の equip は差し込む）', () => {
    const g = {
      state: emptyGearState() as GearState,
      gold: 1000,
      equipment: {} as Record<string, string[]>,
    }
    const mk = (extra: object) =>
      setup({
        menu: {
          items: [
            {
              id: 'appstore',
              label: 'ア',
              content: { tabs: [{ label: '刀', entries: [{ label: '固定' }] }] },
            },
            { id: 'equip', label: 'そ', ...extra },
          ],
          transition: { ...DEFAULT_MENU_TRANSITION },
        },
        getEquipment: () => g.equipment,
        gear: {
          cfg,
          getState: () => g.state,
          setState: (s) => (g.state = s),
          getGold: () => g.gold,
          setGold: (n) => (g.gold = n),
          getFlags: () => ({}),
          setEquipment: (m, l) => (g.equipment[m] = l),
        },
      }).rt
    const rt = mk({ content: { entries: [], entriesByParty: {} } })
    expect(by(rt, 'appstore').content?.tabs?.[0].entries[0].label).toBe('固定')
    expect(Object.keys(by(rt, 'equip').content?.entriesByParty ?? {})).toEqual(['a', 'b'])
  })
  it('appstore の tabs が空の entriesByParty だけなら「書いていない」扱いで中身を差し込む', () => {
    const g = {
      state: emptyGearState() as GearState,
      gold: 1000,
      equipment: {} as Record<string, string[]>,
    }
    const { rt } = setup({
      menu: {
        items: [
          {
            id: 'appstore',
            label: 'ア',
            content: { tabs: [{ label: '刀', entries: [], entriesByParty: {} }] },
          },
        ],
        transition: { ...DEFAULT_MENU_TRANSITION },
      },
      getEquipment: () => g.equipment,
      gear: {
        cfg,
        getState: () => g.state,
        setState: (s) => (g.state = s),
        getGold: () => g.gold,
        setGold: (n) => (g.gold = n),
        getFlags: () => ({}),
        setEquipment: (m, l) => (g.equipment[m] = l),
      },
    })
    const tab = rt.items().find((d) => d.id === 'appstore')!.content!.tabs![0]
    expect(Object.keys(tab.entriesByParty ?? {})).toEqual(['a', 'b'])
  })
  it('まほうの content が空の entries・空の entriesByParty だけなら「書いていない」扱いで差し込む', () => {
    const { rt } = setup({
      menu: {
        items: [{ id: 'magic', label: 'ま', content: { entries: [], entriesByParty: {} } }],
        transition: { ...DEFAULT_MENU_TRANSITION },
      },
    })
    const m = rt.items().find((d) => d.id === 'magic')!
    expect(Object.keys(m.content?.entriesByParty ?? {})).toEqual(['a', 'b'])
  })
  it('売り物の定義がないゲームでは appstore・equip の使用要求は null（従来どおり）', () => {
    const { rt } = setup()
    expect(rt.use({ screen: 'appstore', entryId: 'sw1', casterId: 'a' })).toBeNull()
    expect(rt.use({ screen: 'equip', entryId: 'sw1', casterId: 'a' })).toBeNull()
  })
  it('どうぐ・まほうの使用は gear を渡しても従来どおり', () => {
    const { rt, state } = gearSetup()
    expect(rt.use({ screen: 'item', entryId: 'potion', targetId: 'a' })!.ok).toBe(true)
    expect(state.inventory.potion).toBe(1)
  })
})
