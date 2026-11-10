/**
 * 一枚絵フィールドのセーブ再開 (#1021) のテスト。localStorage に作ったセーブ（SaveManager 経由）を
 * `?resume=` で読み、設定に重ねた状態になること・不正なときに理由を返すことを固定する。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SaveManager } from '../game/SaveManager'
import { buildRpgSaveSlot, type RpgSaveState } from '../game/rpgSave'
import type { BattleEntity } from '../game/spellDsl'
import {
  FIELD_DOC_KEY,
  withResumeSlot,
  isLoadableSlot,
  baseConfigOf,
  loadResume,
  savedFormsFromResume,
  mergeFlags,
  resumeBackground,
  resumeBattleEngineOptions,
  composeNotice,
  carryOverBattleResult,
  itemsWithCounts,
  mergePartyById,
} from './fieldResume'

const hero = (id: string): BattleEntity => ({
  id,
  name: id,
  hp: 40,
  maxHp: 40,
  mp: 6,
  maxMp: 6,
  atk: 9,
  def: 4,
  agi: 6,
})

const config = {
  party: [hero('party1'), hero('party2')],
  items: [{ id: 'potion', name: 'ポーション', count: 3 }],
  flags: { door: false },
  monsters: {
    slime: { id: 'slime', name: 'スライム', hp: 24, atk: 5, def: 1, agi: 3, exp: 5, gold: 3 },
  },
  scenes: { 'shrine-street': {}, temple: {} },
} as unknown as Parameters<typeof loadResume>[1]

const rpg = (over: Partial<RpgSaveState> = {}): RpgSaveState => ({
  version: 1,
  party: [{ id: 'party1', hp: 10 }],
  items: { potion: 2 },
  equipment: {},
  gold: 50,
  field: { sceneId: 'temple', x: 100, y: 200, facing: 'left' },
  ...over,
})

beforeEach(() => localStorage.clear())

describe('loadResume', () => {
  it('?resume= が無ければ none（従来どおり）', () => {
    expect(loadResume('', config)).toEqual({ kind: 'none' })
    expect(loadResume('?foo=bar', config)).toEqual({ kind: 'none' })
  })

  it('スロットのセーブを設定に重ねて返す（ラウンドトリップ）', () => {
    const saves = new SaveManager(FIELD_DOC_KEY)
    saves.save(1, buildRpgSaveSlot(rpg(), { slot: 1 }))
    const r = loadResume('?resume=1', config)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.resolved.party).toHaveLength(1)
    expect(r.resolved.party[0]).toMatchObject({ id: 'party1', hp: 10, maxHp: 40 })
    expect(r.resolved.inventory).toEqual({ potion: 2 })
    expect(r.resolved.gold).toBe(50)
    expect(r.resolved.field).toEqual({ sceneId: 'temple', x: 100, y: 200, facing: 'left' })
  })

  it('quick も読める', () => {
    new SaveManager(FIELD_DOC_KEY).quickSave(buildRpgSaveSlot(rpg(), { slot: -1 }))
    expect(loadResume('?resume=quick', config).kind).toBe('ok')
  })

  it('他のゲーム（別 docKey）のセーブは読まない', () => {
    new SaveManager('other').save(0, buildRpgSaveSlot(rpg()))
    const r = loadResume('?resume=0', config)
    expect(r.kind).toBe('error')
  })

  it.each([
    ['不正な値', '?resume=9', /不正/],
    ['空スロット', '?resume=0', /ありません/],
  ])('%s は error', (_n, search, re) => {
    const r = loadResume(search, config)
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toMatch(re)
  })

  it('rpg の無いセーブ（ノベルのセーブ）は error', () => {
    const slot = buildRpgSaveSlot(rpg())
    delete slot.rpg
    new SaveManager(FIELD_DOC_KEY).save(0, slot)
    const r = loadResume('?resume=0', config)
    expect(r.kind === 'error' && r.message).toMatch(/rpg 状態がありません/)
  })

  it('検証に落ちるセーブは理由つき error', () => {
    new SaveManager(FIELD_DOC_KEY).save(0, buildRpgSaveSlot(rpg({ gold: -5 })))
    const r = loadResume('?resume=0', config)
    expect(r.kind === 'error' && r.message).toMatch(/gold/)
  })

  it('パーティが設定に 1 人もいなければ error', () => {
    new SaveManager(FIELD_DOC_KEY).save(0, buildRpgSaveSlot(rpg({ party: [{ id: 'ghost' }] })))
    expect(loadResume('?resume=0', config).kind).toBe('error')
  })

  it('設定に無いシーンの現在地は警告して捨てる（開始位置から）', () => {
    new SaveManager(FIELD_DOC_KEY).save(
      0,
      buildRpgSaveSlot(rpg({ field: { sceneId: 'nowhere', x: 1, y: 1, facing: 'up' } }))
    )
    const r = loadResume('?resume=0', config)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.resolved.field).toBeUndefined()
      expect(r.resolved.warnings.join()).toMatch(/nowhere/)
    }
  })

  it('戦闘中状態の敵はモンスターのマスターから組み立てる', () => {
    new SaveManager(FIELD_DOC_KEY).save(
      0,
      buildRpgSaveSlot(rpg({ battle: { enemies: [{ id: 'slime', hp: 4 }] } }))
    )
    const r = loadResume('?resume=0', config)
    expect(r.kind === 'ok' && r.resolved.battle?.enemies[0]).toMatchObject({
      id: 'slime',
      name: 'スライム',
      hp: 4,
      maxHp: 24,
    })
  })
})

describe('補助関数', () => {
  it('mergeFlags は宣言済みの名前だけ重ねる', () => {
    expect(mergeFlags({ door: false }, { door: true, unknown: true })).toEqual({ door: true })
    expect(mergeFlags({ door: false }, undefined)).toEqual({ door: false })
  })

  it('baseConfigOf.enemy は未知の id で undefined（Object.prototype の名前でも）', () => {
    const b = baseConfigOf(config)
    expect(b.enemy('slime')?.hp).toBe(24)
    expect(b.enemy('constructor')).toBeUndefined()
    expect(b.enemy('nope')).toBeUndefined()
  })

  it('resumeBattleEngineOptions は ATB ゲージとキューを渡す。保存が無ければそのまま', () => {
    const base = { atb: { mode: 'wait' as const } }
    expect(resumeBattleEngineOptions(base, null)).toBe(base)
    const o = resumeBattleEngineOptions(base, {
      enemies: [],
      atb: { partyGauge: [1000], enemyGauge: [5], queue: [0] },
    })
    expect(o.atb).toEqual({
      mode: 'wait',
      initialGauges: { party: [1000], enemies: [5] },
    })
    expect(o.restore).toEqual({ atbQueue: [0] })
  })

  it('resumeBackground は保存された背景を優先', () => {
    expect(resumeBackground({ enemies: [], background: 'a' }, 'b')).toBe('a')
    expect(resumeBackground({ enemies: [] }, 'b')).toBe('b')
    expect(resumeBackground(null, undefined)).toBeUndefined()
  })
})

describe('composeNotice', () => {
  it('通常のエラーと再開の通知を両方残す。片方だけ・両方なしも扱う', () => {
    expect(composeNotice('設定が不正', '再開できません')).toBe('設定が不正\n再開できません')
    expect(composeNotice(null, '再開できません')).toBe('再開できません')
    expect(composeNotice('設定が不正', null)).toBe('設定が不正')
    expect(composeNotice(null, null)).toBe('')
    expect(composeNotice('', '')).toBe('')
  })
})

describe('戦闘後の持ち越し（呼び出し側の規則）', () => {
  const before = {
    inventory: { potion: 3, ether: 1 },
    gold: 10,
    party: [{ id: 'a', hp: 20 }],
  }
  const after = [{ id: 'a', hp: 5 }]

  it('itemsWithCounts は持ち越した所持数を count に入れ、設定は書き換えない。無い id は 0', () => {
    const items = [{ id: 'potion', count: 3 }, { id: 'bomb' }]
    const out = itemsWithCounts(items, { potion: 1 })
    expect(out).toEqual([
      { id: 'potion', count: 1 },
      { id: 'bomb', count: 0 },
    ])
    expect(items[0].count).toBe(3)
  })

  it('勝利: 残数・獲得金・戦闘後の味方を持ち越す。渡した値は変えない', () => {
    const r = carryOverBattleResult({
      outcome: 'victory',
      earnedGold: 30,
      menuItems: [{ id: 'potion', count: 1 }],
      partyAfter: after,
      before,
    })
    expect(r).toEqual({ inventory: { potion: 1, ether: 1 }, gold: 40, party: [{ id: 'a', hp: 5 }] })
    expect(before.inventory.potion).toBe(3)
    expect(r.party[0]).not.toBe(after[0])
  })

  it('逃走も戦闘後の味方を持ち越す', () => {
    expect(
      carryOverBattleResult({
        outcome: 'escaped',
        earnedGold: 0,
        menuItems: [],
        partyAfter: after,
        before,
      }).party
    ).toEqual([{ id: 'a', hp: 5 }])
  })

  it('敗北: 味方は戦闘前に戻し、所持品の消費は戻さない', () => {
    const r = carryOverBattleResult({
      outcome: 'defeat',
      earnedGold: 0,
      menuItems: [{ id: 'potion', count: 0 }],
      partyAfter: after,
      before,
    })
    expect(r.party).toEqual([{ id: 'a', hp: 20 }])
    expect(r.inventory.potion).toBe(0)
  })
})

// #1020: 設定を読む前に、セーブの form（時期・車椅子）だけを先に読む
describe('savedFormsFromResume', () => {
  it('?resume= が無い・空スロットは空', () => {
    expect(savedFormsFromResume('')).toEqual({})
    expect(savedFormsFromResume('?resume=0')).toEqual({})
    expect(savedFormsFromResume('?resume=9')).toEqual({})
  })
  it('スロットの party[].form を id → form で返す。形態の無い者は出さない', () => {
    const state = rpg({
      party: [{ id: 'party1', hp: 10, form: 'teen-wheelchair' }, { id: 'party2' }],
    })
    new SaveManager(FIELD_DOC_KEY).save(1, buildRpgSaveSlot(state, { slot: 1 }))
    expect(savedFormsFromResume('?resume=1')).toEqual({ party1: 'teen-wheelchair' })
  })
  it('form を持つセーブは loadResume でも解決され、form が味方に残る（snapshot で書き戻せる）', () => {
    const state = rpg({ party: [{ id: 'party1', form: 'uniform' }] })
    new SaveManager(FIELD_DOC_KEY).save(0, buildRpgSaveSlot(state))
    const r = loadResume('?resume=0', config)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.resolved.party[0].form).toBe('uniform')
  })
})

describe('敵レベルの再開 (#1043)', () => {
  const cfg = {
    ...config,
    monsters: {
      boss: {
        id: 'boss',
        name: 'ボス',
        hp: 50,
        atk: 5,
        def: 1,
        agi: 3,
        exp: 5,
        gold: 3,
        level: 50,
      },
    },
  } as unknown as Parameters<typeof loadResume>[1]

  it('戦闘中セーブから再開した敵がマスターの level を保つ', () => {
    new SaveManager(FIELD_DOC_KEY).save(
      0,
      buildRpgSaveSlot(rpg({ battle: { enemies: [{ id: 'boss', hp: 7 }] } }))
    )
    const r = loadResume('?resume=0', cfg)
    expect(r.kind === 'ok' && r.resolved.battle?.enemies[0]).toMatchObject({
      id: 'boss',
      hp: 7,
      level: 50,
    })
  })
})

describe('状態異常の再開 (#1051)', () => {
  it('戦闘中セーブの敵の status（残ターン）が resolved.battle.enemies に解決される', () => {
    new SaveManager(FIELD_DOC_KEY).save(
      0,
      buildRpgSaveSlot(rpg({ battle: { enemies: [{ id: 'slime', hp: 4, status: { x: 2 } }] } }))
    )
    const r = loadResume('?resume=0', config)
    expect(r.kind === 'ok' && r.resolved.battle?.enemies[0].status).toEqual({ x: 2 })
  })

  it('味方の status も解決される', () => {
    new SaveManager(FIELD_DOC_KEY).save(
      0,
      buildRpgSaveSlot(rpg({ party: [{ id: 'party1', hp: 10, status: { x: 3 } }] }))
    )
    const r = loadResume('?resume=0', config)
    expect(r.kind === 'ok' && r.resolved.party[0].status).toEqual({ x: 3 })
  })
})

describe('withResumeSlot（メニューの「ロード」が付ける ?resume=）', () => {
  it('?config= を残して resume を付ける', () => {
    expect(withResumeSlot('?config=a.json', 0)).toBe('?config=a.json&resume=0')
  })
  it('既存の ?resume= は差し替える（重複しない）', () => {
    expect(withResumeSlot('?config=a.json&resume=2', 1)).toBe('?config=a.json&resume=1')
  })
  it('search が空でも組み立てる', () => {
    expect(withResumeSlot('', 2)).toBe('?resume=2')
  })
})

describe('isLoadableSlot（メニュー「ロード」の可否。loadResume と同じ条件）', () => {
  const saves = () => new SaveManager(FIELD_DOC_KEY)
  it('正常なセーブは true（loadResume も ok）', () => {
    saves().save(0, buildRpgSaveSlot(rpg(), { slot: 0 }))
    expect(isLoadableSlot(saves().load(0), 0, config)).toBe(true)
    expect(loadResume('?resume=0', config).kind).toBe('ok')
  })
  it('空スロットは false', () => {
    expect(isLoadableSlot(saves().load(0), 0, config)).toBe(false)
  })
  it('rpg の無いセーブ（ノベルのセーブ）は false', () => {
    const slot = buildRpgSaveSlot(rpg())
    delete slot.rpg
    saves().save(0, slot)
    expect(isLoadableSlot(saves().load(0), 0, config)).toBe(false)
    expect(loadResume('?resume=0', config).kind).toBe('error')
  })
  it('検証に落ちる rpg・パーティが設定に居ない rpg は false', () => {
    saves().save(0, buildRpgSaveSlot(rpg({ gold: -5 })))
    saves().save(1, buildRpgSaveSlot(rpg({ party: [{ id: 'ghost' }] })))
    expect(isLoadableSlot(saves().load(0), 0, config)).toBe(false)
    expect(isLoadableSlot(saves().load(1), 1, config)).toBe(false)
  })
  it('壊れた JSON は load が null を返すので false', () => {
    localStorage.setItem('name-name-save-field-0', '{broken')
    expect(isLoadableSlot(saves().load(0), 0, config)).toBe(false)
  })
})

describe('mergePartyById (#1073)', () => {
  const m = (id: string, hp: number) => ({ id, hp })
  it('全員 after にいれば全員 after の値', () => {
    expect(mergePartyById([m('a', 10), m('b', 10)], [m('a', 3), m('b', 4)])).toEqual([
      m('a', 3),
      m('b', 4),
    ])
  })
  it('一部だけ after にいれば、いる者は after・いない者は before', () => {
    expect(mergePartyById([m('a', 10), m('b', 10)], [m('b', 4)])).toEqual([m('a', 10), m('b', 4)])
  })
  it('after が空なら before のまま', () => {
    expect(mergePartyById([m('a', 10)], [])).toEqual([m('a', 10)])
  })
  it('before が空なら []', () => {
    expect(mergePartyById([], [m('a', 1)])).toEqual([])
  })
  it('after にだけ居る id は入らない', () => {
    expect(mergePartyById([m('a', 10)], [m('a', 5), m('z', 1)])).toEqual([m('a', 5)])
  })
  it('順序は before のまま', () => {
    expect(mergePartyById([m('a', 1), m('b', 1), m('c', 1)], [m('c', 2), m('a', 2)])).toEqual([
      m('a', 2),
      m('b', 1),
      m('c', 2),
    ])
  })
  it('戻り値は複製で、元を書き換えない', () => {
    const before = [m('a', 10), m('b', 10)]
    const after = [m('a', 3)]
    const out = mergePartyById(before, after)
    expect(out[0]).not.toBe(after[0])
    expect(out[1]).not.toBe(before[1])
    out[0].hp = 99
    out[1].hp = 99
    expect(after[0].hp).toBe(3)
    expect(before[1].hp).toBe(10)
  })
  it('after に重複 id があれば最初の一致', () => {
    expect(mergePartyById([m('a', 10)], [m('a', 1), m('a', 2)])).toEqual([m('a', 1)])
  })
})
