/**
 * 一枚絵フィールドのセーブ再開 (#1021) のテスト。localStorage に作ったセーブ（SaveManager 経由）を
 * `?resume=` で読み、設定に重ねた状態になること・不正なときに理由を返すことを固定する。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SaveManager } from '../game/SaveManager'
import { buildRpgSaveSlot, snapshotRpg, type RpgSaveState } from '../game/rpgSave'
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
  itemNamesFromConfig,
  itemsWithCounts,
  mergePartyById,
  snapshotParty,
  resumeFromSlotData,
} from './fieldResume'
import { autoTriggers, triggerKey } from './triggerRuntime'
import type { FieldTrigger } from './config'
import startFieldGameSrc from './startFieldGame.ts?raw'

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

  describe('戦利品 loot (#1126)', () => {
    const base = { earnedGold: 0, partyAfter: after, before }

    it('既存 id には加算する（候補窓に無い所持品も）', () => {
      const r = carryOverBattleResult({
        ...base,
        outcome: 'victory',
        menuItems: [],
        loot: [{ itemId: 'ether', count: 2 }],
      })
      expect(r.inventory).toEqual({ potion: 3, ether: 3 })
    })

    it('未定義 id は新規エントリになる', () => {
      const r = carryOverBattleResult({
        ...base,
        outcome: 'victory',
        menuItems: [],
        loot: [{ itemId: 'rare-gem', count: 1 }],
      })
      expect(r.inventory['rare-gem']).toBe(1)
    })

    it('同じ id が複数行あれば合算する', () => {
      const r = carryOverBattleResult({
        ...base,
        outcome: 'victory',
        menuItems: [],
        loot: [
          { itemId: 'potion', count: 1 },
          { itemId: 'potion', count: 2 },
          { itemId: 'gem', count: 1 },
          { itemId: 'gem', count: 1 },
        ],
      })
      expect(r.inventory).toEqual({ potion: 6, ether: 1, gem: 2 })
    })

    it('候補窓で消費した後の残数に戦利品を足す', () => {
      const r = carryOverBattleResult({
        ...base,
        outcome: 'victory',
        menuItems: [{ id: 'potion', count: 1 }],
        loot: [{ itemId: 'potion', count: 2 }],
      })
      expect(r.inventory.potion).toBe(3)
    })

    it.each(['defeat', 'escaped'])('%s でも戦利品は入る', (outcome) => {
      const r = carryOverBattleResult({
        ...base,
        outcome,
        menuItems: [{ id: 'potion', count: 0 }],
        loot: [{ itemId: 'potion', count: 1 }],
      })
      expect(r.inventory.potion).toBe(1)
    })

    it('loot 省略・空配列は従来と同じ', () => {
      const args = { ...base, outcome: 'victory', menuItems: [{ id: 'potion', count: 1 }] }
      const omitted = carryOverBattleResult(args)
      expect(omitted.inventory).toEqual({ potion: 1, ether: 1 })
      expect(carryOverBattleResult({ ...args, loot: [] })).toEqual(omitted)
    })

    it('count 0 は所持数を変えない（未定義 id もエントリを作らない）', () => {
      const r = carryOverBattleResult({
        ...base,
        outcome: 'victory',
        menuItems: [],
        loot: [
          { itemId: 'potion', count: 0 },
          { itemId: 'none', count: 0 },
        ],
      })
      expect(r.inventory.potion).toBe(3)
      expect(r.inventory.none).toBeUndefined()
    })

    it('渡した before.inventory・loot は書き換えない', () => {
      const loot = [{ itemId: 'potion', count: 5 }]
      carryOverBattleResult({ ...base, outcome: 'victory', menuItems: [], loot })
      expect(before.inventory.potion).toBe(3)
      expect(loot).toEqual([{ itemId: 'potion', count: 5 }])
    })

    it('count が負数・NaN・Infinity・0 の戦利品は加算しない（正の有限数のみ）', () => {
      const r = carryOverBattleResult({
        ...base,
        outcome: 'victory',
        menuItems: [],
        loot: [
          { itemId: 'potion', count: -2 },
          { itemId: 'potion', count: Number.NaN },
          { itemId: 'potion', count: Number.POSITIVE_INFINITY },
          { itemId: 'potion', count: 0 },
          { itemId: 'elixir', count: -1 },
          { itemId: 'potion', count: 2 },
        ],
      })
      expect(r.inventory.potion).toBe(5)
      expect(r.inventory.elixir).toBeUndefined()
    })

    it('配線: startFieldGame は itemNamesFromConfig を呼ぶ（静的検査）', () => {
      expect(startFieldGameSrc).toContain('itemNamesFromConfig(')
    })
  })

  describe('itemNamesFromConfig (#1126)', () => {
    it('id → 名前の表にする', () => {
      expect(
        itemNamesFromConfig([
          { id: 'potion', name: 'ポーション' },
          { id: 'ether', name: 'エーテル' },
        ])
      ).toEqual({ potion: 'ポーション', ether: 'エーテル' })
    })

    it('空名は除外する（表示側で id のまま出る）', () => {
      expect(itemNamesFromConfig([{ id: 'potion', name: '' }])).toEqual({})
    })

    it('items が空なら空の表', () => {
      expect(itemNamesFromConfig([])).toEqual({})
    })
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

describe('snapshotParty (#1073)', () => {
  const m = (id: string, hp: number) => ({ id, hp })
  it('戦闘中でなければ持ち越し中の味方そのまま（エンジンの値は見ない）', () => {
    expect(snapshotParty([m('a', 10), m('b', 10)], [m('a', 1)], false)).toEqual([
      m('a', 10),
      m('b', 10),
    ])
  })
  it('戦闘中は戦闘前の味方に戦闘中の値を重ねる（出なかった味方が残る・出た味方は戦闘中の値）', () => {
    expect(snapshotParty([m('a', 10), m('b', 10), m('c', 10)], [m('b', 3)], true)).toEqual([
      m('a', 10),
      m('b', 3),
      m('c', 10),
    ])
  })
  it('順序は戦闘前のまま。途中参戦の並びが違っても崩れない・重複は先勝ち', () => {
    expect(
      snapshotParty([m('a', 10), m('b', 10)], [m('b', 2), m('a', 1), m('a', 9)], true)
    ).toEqual([m('a', 1), m('b', 2)])
  })
  it('渡した配列を書き換えない', () => {
    const before = [m('a', 10)]
    const out = snapshotParty(before, [], false)
    expect(out).not.toBe(before)
    expect(before).toEqual([m('a', 10)])
  })
  it('保存して読み直すと、戦闘に出なかった味方も全員復元される', () => {
    const saved = snapshotParty([m('party1', 40), m('party2', 40)], [m('party1', 7)], true)
    new SaveManager(FIELD_DOC_KEY).save(0, buildRpgSaveSlot(rpg({ party: saved }), { slot: 0 }))
    const r = loadResume('?resume=0', config)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.resolved.party.map((p) => [p.id, p.hp])).toEqual([
      ['party1', 7],
      ['party2', 40],
    ])
  })
})

describe('field.fireAuto と resumedStart（#1155）', () => {
  // startFieldGame の `resumedStart = !!resumed && !resumed.field?.fireAuto` を、resumeFromSlotData の結果に当てた判定
  const resumedStartOf = (r: ReturnType<typeof resumeFromSlotData>): boolean => {
    const resumed = r.kind === 'ok' ? r.resolved : null
    return !!resumed && !resumed.field?.fireAuto
  }
  const slotOf = (field: NonNullable<RpgSaveState['field']>) =>
    buildRpgSaveSlot(rpg({ field }), { slot: 0 })
  const base = { sceneId: 'temple', x: 1, y: 2, facing: 'left' as const }

  it('fireAuto なしの再開は resumedStart=true（従来どおり auto を起こさない）', () => {
    expect(resumedStartOf(resumeFromSlotData(slotOf(base), 0, config))).toBe(true)
  })
  it('fireAuto=false の再開も resumedStart=true', () => {
    expect(
      resumedStartOf(resumeFromSlotData(slotOf({ ...base, fireAuto: false }), 0, config))
    ).toBe(true)
  })
  it('fireAuto=true の再開は resumedStart=false（auto を起こす）', () => {
    const r = resumeFromSlotData(slotOf({ ...base, fireAuto: true }), 0, config)
    expect(r.kind === 'ok' && r.resolved.field?.fireAuto).toBe(true)
    expect(resumedStartOf(r)).toBe(false)
  })
  it('通常起動（再開なし・読めないセーブ）は resumedStart=false', () => {
    expect(resumedStartOf(resumeFromSlotData(null, 0, config))).toBe(false)
  })
  it('fireAuto=true でも場面が設定に無く field が捨てられたら resumedStart=true（従来どおり）', () => {
    const r = resumeFromSlotData(slotOf({ ...base, sceneId: 'nowhere', fireAuto: true }), 0, config)
    expect(r.kind === 'ok' && r.resolved.field).toBeUndefined()
    expect(resumedStartOf(r)).toBe(true)
  })
  it('fireAuto=true は auto を起こし、once は onceFired に記録され、場面を戻っても再発火しない', () => {
    const triggers = [
      { auto: true, event: 'opening', once: true },
      { auto: true, event: 'every', once: false },
    ] as unknown as readonly FieldTrigger[]
    const r = resumeFromSlotData(slotOf({ ...base, fireAuto: true }), 0, config)
    const onceFired = new Set<string>()
    const first = autoTriggers({
      sceneId: 'temple',
      triggers,
      onceFired,
      resumedStart: resumedStartOf(r),
    })
    expect(first.map((f) => f.event)).toEqual(['opening', 'every'])
    for (const t of first) if (t.once) onceFired.add(t.key) // startFieldGame の記録と同じ
    expect([...onceFired]).toEqual([triggerKey('temple', 0)])
    // 別場面へ行って戻ると（resumedStart は初回で false に戻っている）once だけ除外される
    const again = autoTriggers({ sceneId: 'temple', triggers, onceFired, resumedStart: false })
    expect(again.map((f) => f.event)).toEqual(['every'])
  })
  it('メニューのセーブ→ロードでは fireAuto が消え、次の再開は auto を起こさない', () => {
    // ゲーム内セーブ（startFieldGame の snapshotRpgNow）は field を fireAuto なしで組み立てる
    const saved = snapshotRpg(
      {
        party: [hero('party1')],
        inventory: { potion: 1 },
        equipment: {},
        gold: 0,
        field: { sceneId: 'temple', x: 1, y: 2, facing: 'left', flags: {} },
      },
      baseConfigOf(config)
    )
    const slot = buildRpgSaveSlot(saved, { slot: 0 })
    const r = resumeFromSlotData(slot, 0, config)
    expect(r.kind === 'ok' && r.resolved.field).not.toHaveProperty('fireAuto')
    expect(resumedStartOf(r)).toBe(true)
  })
  it('配線の固定: startFieldGame の判定式とセーブ組み立てが fireAuto を扱う（静的検査）', () => {
    // startFieldGame は PixiJS 依存で結合できないため、判定式の原文だけを固定する（式を変えたらここも直す）
    expect(startFieldGameSrc).toContain('let resumedStart = !!resumed && !resumed.field?.fireAuto')
    // メニューセーブの field オブジェクト（flags の `}` を越えて閉じ `}` まで）に fireAuto が入らない
    const m = startFieldGameSrc.match(
      /field: \{ sceneId, x: pos\.x, y: pos\.y, facing, flags: \{[^}]*\} \}/
    )
    expect(m).not.toBeNull()
    expect(m![0]).not.toContain('fireAuto')
  })
})
