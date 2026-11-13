/**
 * RPG 状態のセーブ形式 (#1021) の検証・合成・スナップショットのテスト。
 * 任意の RPG 局面（パーティ・所持品・装備・所持金・現在地・戦闘中）を宣言し、解決して、
 * 実行時の状態から作り直したセーブが元の宣言と一致する（ラウンドトリップ）ことを固定する。
 */
import { describe, expect, it } from 'vitest'
import {
  RPG_SAVE_VERSION,
  buildRpgSaveSlot,
  diffEntity,
  parseResumeParam,
  parseRpgSave,
  resolveRpg,
  snapshotRpg,
  type RpgBaseConfig,
  type RpgSaveState,
} from './rpgSave'
import type { BattleEntity } from './spellDsl'

const hero = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id.toUpperCase(),
  hp: 40,
  maxHp: 40,
  mp: 6,
  maxMp: 6,
  atk: 9,
  def: 4,
  agi: 6,
  sprite: 'data:image/png;base64,AAAA'.repeat(20),
  ...over,
})
const slime = (): BattleEntity => ({
  id: 'slime',
  name: 'スライム',
  hp: 24,
  maxHp: 24,
  mp: 0,
  maxMp: 0,
  atk: 5,
  def: 1,
  agi: 3,
  exp: 5,
  gold: 3,
  sprite: 'data:image/png;base64,BBBB'.repeat(20),
})

const base: RpgBaseConfig = {
  party: [hero('party1'), hero('party2', { name: 'まほうつかい', mp: 14, maxMp: 14 })],
  items: [
    { id: 'potion', count: 3 },
    { id: 'ether', count: 0 },
  ],
  flags: { door: false },
  enemy: (id) => (id === 'slime' ? slime() : undefined),
}

const declared = (): RpgSaveState => ({
  version: RPG_SAVE_VERSION,
  party: [
    { id: 'party2', hp: 5, mp: 1, status: { poison: 3 } },
    { id: 'party1', hp: 12 },
  ],
  items: { potion: 1, ether: 2 },
  equipment: { party1: ['wood-sword', 'cloth'] },
  gold: 123,
  field: { sceneId: 'shrine-street', x: 320, y: 480, facing: 'upLeft', flags: { door: true } },
  battle: {
    enemies: [{ id: 'slime', hp: 7, status: { sleep: 1 } }, { id: 'slime' }],
    atb: { partyGauge: [1000, 400], enemyGauge: [250, 0], queue: [0] },
    enemyMemory: [{ acted: 2 }, { acted: 0 }],
    background: 'bg/forest.webp',
  },
})

describe('parseRpgSave', () => {
  it('宣言した局面は検証を通り、複製が返る', () => {
    const r = parseRpgSave(declared())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(declared())
  })

  it.each([
    ['version 違い', (s: Record<string, unknown>) => (s.version = 2)],
    ['gold 負', (s: Record<string, unknown>) => (s.gold = -1)],
    ['items に小数', (s: Record<string, unknown>) => (s.items = { potion: 1.5 })],
    ['party の重複 id', (s: Record<string, unknown>) => (s.party = [{ id: 'a' }, { id: 'a' }])],
    ['hp が数でない', (s: Record<string, unknown>) => (s.party = [{ id: 'a', hp: 'x' }])],
    [
      'facing が未知',
      (s: Record<string, unknown>) => (s.field = { sceneId: 's', x: 1, y: 1, facing: 'north' }),
    ],
    ['battle.enemies が空', (s: Record<string, unknown>) => (s.battle = { enemies: [] })],
    [
      'enemyMemory に null',
      (s: Record<string, unknown>) =>
        (s.battle = { enemies: [{ id: 'slime' }], enemyMemory: [null] }),
    ],
    [
      'enemyMemory.acted が不正',
      (s: Record<string, unknown>) =>
        (s.battle = { enemies: [{ id: 'slime' }], enemyMemory: [{ acted: 'x' }] }),
    ],
    [
      'enemyMemory.used に非数',
      (s: Record<string, unknown>) =>
        (s.battle = { enemies: [{ id: 'slime' }], enemyMemory: [{ acted: 1, used: { a: 'z' } }] }),
    ],
    [
      'party.buffs に非数',
      (s: Record<string, unknown>) => (s.party = [{ id: 'a', buffs: { atk: 'x' } }]),
    ],
    [
      'script.fired に非数',
      (s: Record<string, unknown>) =>
        (s.battle = {
          enemies: [{ id: 'slime' }],
          script: { turn: 1, fired: ['0'], joined: [], fled: [] },
        }),
    ],
    [
      'script.fled に負数',
      (s: Record<string, unknown>) =>
        (s.battle = {
          enemies: [{ id: 'slime' }],
          script: { turn: 1, fired: [], joined: [], fled: [-1] },
        }),
    ],
    [
      'atb.queue が配列でない',
      (s: Record<string, unknown>) =>
        (s.battle = {
          enemies: [{ id: 'slime' }],
          atb: { partyGauge: [], enemyGauge: [], queue: 1 },
        }),
    ],
  ])('不正（%s）は理由つきで失敗する', (_n, mutate) => {
    const s = declared() as unknown as Record<string, unknown>
    mutate(s)
    const r = parseRpgSave(s)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^rpg: /)
  })

  it('オブジェクトでない値は失敗する', () => {
    expect(parseRpgSave(null).ok).toBe(false)
    expect(parseRpgSave([]).ok).toBe(false)
  })
})

describe('resolveRpg', () => {
  it('設定に差分を重ね、載せた順に並べ、所持品はセーブの値に置き換える', () => {
    const r = resolveRpg(declared(), base)
    expect(r.warnings).toEqual([])
    expect(r.party.map((m) => m.id)).toEqual(['party2', 'party1'])
    const [mage, brave] = r.party
    expect(mage).toMatchObject({
      hp: 5,
      mp: 1,
      maxHp: 40,
      maxMp: 14,
      atk: 9,
      status: { poison: 3 },
    })
    expect(brave).toMatchObject({ hp: 12, maxHp: 40, name: 'PARTY1' })
    expect(r.inventory).toEqual({ potion: 1, ether: 2 })
    expect(r.equipment).toEqual({ party1: ['wood-sword', 'cloth'] })
    expect(r.gold).toBe(123)
    expect(r.field).toEqual(declared().field)
    expect(r.battle!.enemies).toHaveLength(2)
    expect(r.battle!.enemies[0]).toMatchObject({
      id: 'slime',
      hp: 7,
      maxHp: 24,
      status: { sleep: 1 },
    })
    expect(r.battle!.enemies[1]).toMatchObject({ hp: 24 })
    expect(r.battle!.atb).toEqual(declared().battle!.atb)
  })

  it('載せなかったメンバーは離脱・載せなかったアイテムは 0 個', () => {
    const r = resolveRpg(
      { version: 1, party: [{ id: 'party1' }], items: {}, equipment: {}, gold: 0 },
      base
    )
    expect(r.party.map((m) => m.id)).toEqual(['party1'])
    expect(r.inventory).toEqual({ potion: 0, ether: 0 })
  })

  it('hp が maxHp を超える宣言は maxHp を持ち上げる', () => {
    const r = resolveRpg(
      { version: 1, party: [{ id: 'party1', hp: 99 }], items: {}, equipment: {}, gold: 0 },
      base
    )
    expect(r.party[0].maxHp).toBe(99)
  })

  it('設定に無い味方・アイテムは警告して捨てる', () => {
    const r = resolveRpg(
      {
        version: 1,
        party: [{ id: 'ghost' }, { id: 'party1' }],
        items: { potion: 1, bomb: 9 },
        equipment: {},
        gold: 0,
      },
      base
    )
    expect(r.party.map((m) => m.id)).toEqual(['party1'])
    expect(r.warnings.join('\n')).toMatch(/party 'ghost'/)
    expect(r.warnings.join('\n')).toMatch(/items 'bomb'/)
    expect(r.inventory).not.toHaveProperty('bomb')
  })

  it('敵がマスターに無い戦闘中状態は丸ごと捨てて警告する（ATB の添字がずれるため）', () => {
    const s = declared()
    s.battle!.enemies = [{ id: 'slime' }, { id: 'dragon' }]
    const r = resolveRpg(s, base)
    expect(r.battle).toBeUndefined()
    expect(r.warnings.join('\n')).toMatch(/dragon/)
  })
})

describe('snapshotRpg ラウンドトリップ', () => {
  it('宣言 → 解決 → スナップショットで、元の宣言に一致する（セーブは差分だけで太らない）', () => {
    const resolved = resolveRpg(declared(), base)
    const snap = snapshotRpg(resolved, base)
    // JSON を経由しても検証を通る
    const reparsed = parseRpgSave(JSON.parse(JSON.stringify(snap)))
    expect(reparsed.ok).toBe(true)
    const want = declared()
    // 載せた差分は元の宣言と同じ（hp だけの宣言なら hp だけ。絵のデータ URI は出ない）
    expect(snap.party).toEqual([
      { id: 'party2', hp: 5, mp: 1, status: { poison: 3 } },
      { id: 'party1', hp: 12 },
    ])
    expect(snap.battle!.enemies).toEqual(want.battle!.enemies)
    expect(snap).toEqual(want)
    expect(JSON.stringify(snap)).not.toContain('base64')
  })

  it('解決し直しても同じ実行時状態になる（二周目も不変）', () => {
    const a = resolveRpg(declared(), base)
    const b = resolveRpg(snapshotRpg(a, base), base)
    expect(b).toEqual(a)
  })

  it('field・battle が無ければキーも出さない', () => {
    const snap = snapshotRpg(
      { party: base.party, inventory: { potion: 3, ether: 0 }, equipment: {}, gold: 0 },
      base
    )
    expect(snap).not.toHaveProperty('field')
    expect(snap).not.toHaveProperty('battle')
    expect(snap.party).toEqual([{ id: 'party1' }, { id: 'party2' }])
  })
})

describe('diffEntity', () => {
  it('マスターと同じ値のキーは出さず、違うものだけ残す。マスターが無ければ全部', () => {
    const e = hero('party1', { hp: 3 })
    expect(diffEntity(e, hero('party1'))).toEqual({ id: 'party1', hp: 3 })
    expect(Object.keys(diffEntity(e, undefined))).toContain('sprite')
  })
})

describe('buildRpgSaveSlot / parseResumeParam', () => {
  it('SaveSlotData の必須キーを中立の既定値で埋め、rpg を載せる', () => {
    const slot = buildRpgSaveSlot(declared(), { slot: 1, savedAt: '2026-11-04T00:00:00.000Z' })
    expect(slot).toMatchObject({
      slot: 1,
      sceneId: null,
      eventIndex: 0,
      textIndex: 0,
      flags: {},
      isBlackout: false,
      characters: [],
      sceneName: 'shrine-street',
    })
    expect(slot.rpg).toEqual(declared())
  })

  it('?resume= は 0〜2 と quick だけ', () => {
    expect(parseResumeParam(null)).toBeNull()
    expect(parseResumeParam('0')).toBe(0)
    expect(parseResumeParam('2')).toBe(2)
    expect(parseResumeParam('3')).toBeNull()
    expect(parseResumeParam('quick')).toBe('quick')
    expect(parseResumeParam('')).toBeNull()
    expect(parseResumeParam('-1')).toBeNull()
  })
})

// #1020: 味方の形態（時期・車椅子）。エンジンは解釈せず、セーブ形式として検証・往復する
describe('party[].form（#1020）', () => {
  const base = (form: unknown): unknown => ({
    version: RPG_SAVE_VERSION,
    party: [{ id: 'a', form }],
    items: {},
    equipment: {},
    gold: 0,
  })
  it('文字列は通る', () => expect(parseRpgSave(base('elementary-wheelchair')).ok).toBe(true))
  it('文字列でなければ理由つきで失敗', () => {
    const r = parseRpgSave(base(3))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/party\[0\]\.form は文字列/)
  })
  it('設定に無い form はマスターとの差分としてスナップショットに残る（往復）', () => {
    const def = hero('a')
    const resolved = resolveRpg(
      {
        version: RPG_SAVE_VERSION,
        party: [{ id: 'a', form: 'teen' }],
        items: {},
        equipment: {},
        gold: 0,
      },
      { party: [def], items: [], flags: {}, enemy: () => undefined }
    )
    expect(resolved.party[0].form).toBe('teen')
    const snap = snapshotRpg(
      { party: resolved.party, inventory: {}, equipment: {}, gold: 0 },
      { party: [def], enemy: () => undefined }
    )
    expect(snap.party[0]).toEqual({ id: 'a', form: 'teen' })
  })
})

describe('playMs / steps（#880）', () => {
  const withStats = (extra: Record<string, unknown>): Record<string, unknown> => ({
    ...declared(),
    ...extra,
  })

  it('旧セーブ（playMs / steps なし）はそのまま通り、解決後も省略（0 扱い）', () => {
    const r = parseRpgSave(declared())
    expect(r.ok).toBe(true)
    const resolved = resolveRpg(declared(), base)
    expect('playMs' in resolved).toBe(false)
    expect('steps' in resolved).toBe(false)
  })

  it('正常値（0 を含む）は通り、解決でそのまま運ばれる', () => {
    for (const [playMs, steps] of [
      [0, 0],
      [123456.5, 98],
    ]) {
      const r = parseRpgSave(withStats({ playMs, steps }))
      expect(r.ok).toBe(true)
      const resolved = resolveRpg(withStats({ playMs, steps }) as unknown as RpgSaveState, base)
      expect(resolved.playMs).toBe(playMs)
      expect(resolved.steps).toBe(steps)
    }
  })

  it.each([
    ['playMs 負', { playMs: -1 }, /playMs/],
    ['playMs が文字列', { playMs: '5' }, /playMs/],
    ['playMs が NaN', { playMs: NaN }, /playMs/],
    ['steps 負', { steps: -1 }, /steps/],
    ['steps が小数', { steps: 1.5 }, /steps/],
    ['steps が文字列', { steps: '5' }, /steps/],
  ])('不正（%s）は理由つきで失敗', (_n, extra, re) => {
    const r = parseRpgSave(withStats(extra))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(re)
  })

  it('スナップショットのラウンドトリップ: playMs は整数に切り捨て、steps はそのまま', () => {
    const resolved = resolveRpg(
      withStats({ playMs: 5000, steps: 42 }) as unknown as RpgSaveState,
      base
    )
    const snap = snapshotRpg(
      {
        party: resolved.party,
        inventory: resolved.inventory,
        equipment: resolved.equipment,
        gold: resolved.gold,
        playMs: resolved.playMs,
        steps: resolved.steps,
      },
      base
    )
    expect(snap.playMs).toBe(5000)
    expect(snap.steps).toBe(42)
    expect(parseRpgSave(snap).ok).toBe(true)
    const frac = snapshotRpg(
      { party: resolved.party, inventory: {}, equipment: {}, gold: 0, playMs: 1234.9, steps: 3 },
      base
    )
    expect(frac.playMs).toBe(1234)
  })

  it('スナップショットに統計を渡さなければキーを出さない（旧形式と同じ）', () => {
    const snap = snapshotRpg({ party: base.party, inventory: {}, equipment: {}, gold: 0 }, base)
    expect('playMs' in snap).toBe(false)
    expect('steps' in snap).toBe(false)
  })

  it('0 は省略でなく 0 として残る', () => {
    const snap = snapshotRpg(
      { party: base.party, inventory: {}, equipment: {}, gold: 0, playMs: 0, steps: 0 },
      base
    )
    expect(snap.playMs).toBe(0)
    expect(snap.steps).toBe(0)
  })
})

describe('menu（#880 せってい・せいとんの持ち越し）', () => {
  const withMenu = (menu: unknown): Record<string, unknown> => ({ ...declared(), menu })

  it('旧セーブ（menu なし）は通り、解決後も menu キーが出ない', () => {
    expect(parseRpgSave(declared()).ok).toBe(true)
    expect('menu' in resolveRpg(declared(), base)).toBe(false)
  })

  it('正常な menu は通り、解決・スナップショットで運ばれる', () => {
    const menu = { settings: { battleMode: 1, cursor: 0 }, itemOrder: ['ether', 'potion'] }
    expect(parseRpgSave(withMenu(menu)).ok).toBe(true)
    const resolved = resolveRpg(withMenu(menu) as unknown as RpgSaveState, base)
    expect(resolved.menu).toEqual(menu)
    const snap = snapshotRpg(
      {
        party: resolved.party,
        inventory: resolved.inventory,
        equipment: resolved.equipment,
        gold: resolved.gold,
        menu: resolved.menu,
      },
      base
    )
    expect(snap.menu).toEqual(menu)
  })

  it('menu を渡さないスナップショットにはキーが出ない', () => {
    const snap = snapshotRpg(
      { party: base.party as BattleEntity[], inventory: {}, equipment: {}, gold: 0 },
      base
    )
    expect('menu' in snap).toBe(false)
  })

  it.each([
    ['menu が配列', [], /menu/],
    ['settings が配列', { settings: [] }, /menu.settings/],
    ['settings の値が負', { settings: { a: -1 } }, /menu.settings.a/],
    ['settings の値が小数', { settings: { a: 1.5 } }, /menu.settings.a/],
    ['itemOrder が文字列', { itemOrder: 'x' }, /menu.itemOrder/],
    ['itemOrder に数値', { itemOrder: ['a', 1] }, /menu.itemOrder/],
  ])('不正（%s）は理由つきで失敗', (_n, menu, re) => {
    const r = parseRpgSave(withMenu(menu))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(re)
  })
})

describe('menu と gear の併存（#880 / #881）', () => {
  const menu = { settings: { battleMode: 1 }, itemOrder: ['ether', 'potion'] }
  const gear = { owned: { party1: ['blade-a'] }, blade: { party1: 'blade-a' } }
  const roundTrip = (extra: Record<string, unknown>) => {
    const raw = { ...declared(), ...extra }
    const parsed = parseRpgSave(raw)
    if (!parsed.ok) throw new Error(parsed.error)
    const resolved = resolveRpg(parsed.value, base)
    return snapshotRpg(
      {
        party: resolved.party,
        inventory: resolved.inventory,
        equipment: resolved.equipment,
        gold: resolved.gold,
        menu: resolved.menu,
        gear: resolved.gear,
      },
      base
    )
  }

  it('両方を持つセーブは parse → resolve → snapshot で両方保たれる', () => {
    const snap = roundTrip({ menu, gear })
    expect(snap.menu).toEqual(menu)
    expect(snap.gear).toEqual(gear)
  })
  it('片方だけなら、もう片方のキーは書かない', () => {
    const onlyMenu = roundTrip({ menu })
    expect(onlyMenu.menu).toEqual(menu)
    expect('gear' in onlyMenu).toBe(false)
    const onlyGear = roundTrip({ gear })
    expect(onlyGear.gear).toEqual(gear)
    expect('menu' in onlyGear).toBe(false)
  })
  it('どちらも無い旧セーブは、どちらのキーも書かない', () => {
    const snap = roundTrip({})
    expect('menu' in snap).toBe(false)
    expect('gear' in snap).toBe(false)
  })
})

describe('field.fireAuto（#1155 再開直後に場面開始トリガーを起こす）', () => {
  const withField = (fireAuto?: unknown): Record<string, unknown> => ({
    ...declared(),
    field: {
      sceneId: 'shrine-street',
      x: 1,
      y: 2,
      facing: 'down',
      ...(fireAuto === undefined ? {} : { fireAuto }),
    },
  })

  it.each([true, false])('fireAuto=%s は受理され、値が保たれる', (v) => {
    const r = parseRpgSave(withField(v))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.field?.fireAuto).toBe(v)
  })

  it('省略は受理され、キーも増えない', () => {
    const r = parseRpgSave(withField())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.field).not.toHaveProperty('fireAuto')
  })

  it.each([['yes'], [1], [0], [null], [{}]])('fireAuto=%j は真偽値でないので拒否する', (v) => {
    const r = parseRpgSave(withField(v))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('rpg: field.fireAuto は真偽値が必要です')
  })

  it('戦闘中セーブ（battle）と併用しても検証を通り、両方保たれる', () => {
    const raw = { ...declared(), field: { ...declared().field!, fireAuto: true } }
    const r = parseRpgSave(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.battle?.enemies).toHaveLength(2)
    expect(r.value.field?.fireAuto).toBe(true)
    expect(resolveRpg(r.value, base).battle).toBeDefined()
  })

  it('resolveRpg は fireAuto を保って返す（省略・false はそのまま）', () => {
    const mk = (fireAuto?: boolean): RpgSaveState => ({
      ...declared(),
      field: { ...declared().field!, ...(fireAuto === undefined ? {} : { fireAuto }) },
    })
    expect(resolveRpg(mk(true), base).field?.fireAuto).toBe(true)
    expect(resolveRpg(mk(false), base).field?.fireAuto).toBe(false)
    expect(resolveRpg(mk(), base).field).not.toHaveProperty('fireAuto')
  })

  it('ゲーム内のセーブ（snapshotRpg に fireAuto なしの field）では fireAuto が出ない', () => {
    const snap = snapshotRpg(
      {
        party: base.party,
        inventory: { potion: 3, ether: 0 },
        equipment: {},
        gold: 0,
        field: { sceneId: 's', x: 1, y: 2, facing: 'down', flags: { door: true } },
      },
      base
    )
    expect(snap.field).not.toHaveProperty('fireAuto')
  })
})

describe('party[].level / exp（#206 レベルアップの持ち越し）', () => {
  const withParty = (patch: Record<string, unknown>) => ({
    version: 1,
    party: [{ id: 'party1', ...patch }],
    items: {},
    equipment: {},
    gold: 0,
  })

  it('旧セーブ（level / exp のキー無し）は通り、解決後も level / exp が付かない', () => {
    const r = parseRpgSave(withParty({ hp: 3 }))
    expect(r.ok).toBe(true)
    const resolved = resolveRpg(withParty({ hp: 3 }) as RpgSaveState, base)
    expect(resolved.party[0].level).toBeUndefined()
    expect(resolved.party[0].exp).toBeUndefined()
  })

  it('正常な level / exp は通る（exp は 0・小数も可）', () => {
    expect(parseRpgSave(withParty({ level: 1, exp: 0 })).ok).toBe(true)
    expect(parseRpgSave(withParty({ level: 99, exp: 123456 })).ok).toBe(true)
    expect(parseRpgSave(withParty({ exp: 3.5 })).ok).toBe(true)
  })

  it.each([
    ['level 0', { level: 0 }],
    ['level 負数', { level: -1 }],
    ['level 小数', { level: 2.5 }],
    ['level 文字列', { level: '3' }],
    ['level null', { level: null }],
    ['level NaN', { level: NaN }],
    ['level Infinity', { level: Infinity }],
    ['exp 負数', { exp: -1 }],
    ['exp 文字列', { exp: '10' }],
    ['exp NaN', { exp: NaN }],
    ['exp null', { exp: null }],
  ])('不正値は拒否する: %s', (_n, patch) => {
    const r = parseRpgSave(withParty(patch))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/party\[0\]\.(level|exp)/)
  })

  it('保存 → 再開: レベルアップした味方の level / exp が差分に残り、解決で戻る', () => {
    const grown = { ...hero('party1'), level: 4, exp: 99, maxHp: 55, hp: 55, atk: 12 }
    const snap = snapshotRpg(
      { party: [grown, base.party[1]], inventory: {}, equipment: {}, gold: 0 },
      base
    )
    expect(snap.party[0]).toMatchObject({ id: 'party1', level: 4, exp: 99, maxHp: 55, atk: 12 })
    // 変わっていない味方には level / exp が出ない
    expect(snap.party[1]).toEqual({ id: 'party2' })
    const reparsed = parseRpgSave(JSON.parse(JSON.stringify(snap)))
    expect(reparsed.ok).toBe(true)
    const back = resolveRpg(snap, base)
    expect(back.party[0]).toMatchObject({ level: 4, exp: 99, maxHp: 55, atk: 12 })
    expect(back.party[1].level).toBeUndefined()
    // 二周目も不変
    expect(snapshotRpg(back, base).party).toEqual(snap.party)
  })

  it('設定の初期値が exp:0 の味方が exp を得ても差分として残る。0 のままなら出ない', () => {
    const b: RpgBaseConfig = { ...base, party: [hero('party1', { exp: 0 })] }
    const still = snapshotRpg(
      { party: [hero('party1', { exp: 0 })], inventory: {}, equipment: {}, gold: 0 },
      b
    )
    expect(still.party).toEqual([{ id: 'party1' }])
    const gained = snapshotRpg(
      { party: [hero('party1', { exp: 7, level: 1 })], inventory: {}, equipment: {}, gold: 0 },
      b
    )
    expect(gained.party).toEqual([{ id: 'party1', exp: 7, level: 1 }])
  })
})
