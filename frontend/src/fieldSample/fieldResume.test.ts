/**
 * 一枚絵フィールドのセーブ再開 (#1021) のテスト。localStorage に作ったセーブ（SaveManager 経由）を
 * `?resume=` で読み、設定に重ねた状態になること・不正なときに理由を返すことを固定する。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SaveManager } from '../game/SaveManager'
import { buildRpgSaveSlot, type RpgSaveState } from '../game/rpgSave'
import type { BattleEntity } from '../game/spellDsl'
import {
  FIELD_SAMPLE_DOC_KEY,
  baseConfigOf,
  loadResume,
  mergeFlags,
  resumeBackground,
  resumeBattleEngineOptions,
  composeNotice,
  carryOverBattleResult,
  itemsWithCounts,
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
    expect(loadResume('?fixture=dummy', config)).toEqual({ kind: 'none' })
  })

  it('スロットのセーブを設定に重ねて返す（ラウンドトリップ）', () => {
    const saves = new SaveManager(FIELD_SAMPLE_DOC_KEY)
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
    new SaveManager(FIELD_SAMPLE_DOC_KEY).quickSave(buildRpgSaveSlot(rpg(), { slot: -1 }))
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
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(0, slot)
    const r = loadResume('?resume=0', config)
    expect(r.kind === 'error' && r.message).toMatch(/rpg 状態がありません/)
  })

  it('検証に落ちるセーブは理由つき error', () => {
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(0, buildRpgSaveSlot(rpg({ gold: -5 })))
    const r = loadResume('?resume=0', config)
    expect(r.kind === 'error' && r.message).toMatch(/gold/)
  })

  it('パーティが設定に 1 人もいなければ error', () => {
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(
      0,
      buildRpgSaveSlot(rpg({ party: [{ id: 'ghost' }] }))
    )
    expect(loadResume('?resume=0', config).kind).toBe('error')
  })

  it('設定に無いシーンの現在地は警告して捨てる（開始位置から）', () => {
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(
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
    new SaveManager(FIELD_SAMPLE_DOC_KEY).save(
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
