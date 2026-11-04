/**
 * BattleEngine の途中再開 (#1021)。戦闘の途中の状態（HP・状態異常・ATB ゲージ・コマンド待ちの順・敵の記憶・脚本の進行）を
 * 宣言して始めると、その局面から同じ状態で再開できることを固定する。
 */
import { describe, expect, it } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'

const ent = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id,
  hp: 100,
  maxHp: 100,
  mp: 4,
  maxMp: 4,
  atk: 10,
  def: 0,
  agi: 5,
  ...over,
})
const foe = (id: string, over: Partial<BattleEntity> = {}) =>
  ent(id, { hp: 1000, maxHp: 1000, exp: 1, gold: 1, ...over })

describe('途中再開: ATB', () => {
  it('ゲージ・HP・状態異常・コマンド待ちの順がそのまま復元される', () => {
    const e = new BattleEngine(
      [ent('a', { hp: 30, status: { poison: 2 } }), ent('b'), ent('c')],
      [foe('s', { hp: 321 }), foe('t')],
      {
        rng: () => 0,
        atb: {
          mode: 'wait',
          initialGauges: { party: [1000, 400, 1000], enemies: [250, 0] },
        },
        restore: { atbQueue: [2, 0] },
      }
    )
    const st = e.getState()
    expect(st.party[0]).toMatchObject({ hp: 30, status: { poison: 2 } })
    expect(st.enemies[0].hp).toBe(321)
    expect(st.atb!.partyGauge).toEqual([1000, 400, 1000])
    expect(st.atb!.enemyGauge).toEqual([250, 0])
    // 保存どおり 2 が先頭（index 順の 0, 2 ではない）
    expect(st.atb!.queue).toEqual([2, 0])
    expect(st.phase).toBe('party-input')
    expect(e.getCurrentActorIndex()).toBe(2)
  })

  it('キューに無い者・重複・範囲外の保存値は無視し、残りの満タンは元の順で後ろに足す', () => {
    const e = new BattleEngine([ent('a'), ent('b'), ent('c')], [foe('s')], {
      rng: () => 0,
      atb: { initialGauges: { party: [1000, 10, 1000] } },
      restore: { atbQueue: [1, 9, 2, 2] },
    })
    expect(e.getState().atb!.queue).toEqual([2, 0])
  })

  it('ゲージ途中（誰も満タンでない）から再開すると atb-running で、tick で続きが進む', () => {
    const e = new BattleEngine([ent('a', { agi: 5 })], [foe('s', { agi: 1 })], {
      rng: () => 0,
      atb: { initialGauges: { party: [900] } },
    })
    expect(e.getState().phase).toBe('atb-running')
    e.tick(1000) // AGI5 → 1ms あたり 0.2 → 200 増えて満タン
    expect(e.getState().atb!.queue).toEqual([0])
    expect(e.getState().phase).toBe('party-input')
  })

  it('復元した局面で続けた結果は、ずっと続けた場合と同じ（決定論）', () => {
    const rng = () => 0.5
    const mk = (opts: ConstructorParameters<typeof BattleEngine>[2]) =>
      new BattleEngine([ent('a')], [foe('s')], { rng, ...opts })
    const live = mk({ atb: { initialGauges: { party: [1000] } } })
    live.selectAttack()
    live.tick(300)
    const s1 = live.getState()
    const resumed = new BattleEngine(
      structuredClone(s1.party as BattleEntity[]),
      structuredClone(s1.enemies as BattleEntity[]),
      {
        rng,
        atb: { initialGauges: { party: s1.atb!.partyGauge, enemies: s1.atb!.enemyGauge } },
        restore: { atbQueue: s1.atb!.queue },
      }
    )
    // 両者に同じ入力を与えて同じ盤面になる
    for (const eng of [live, resumed]) {
      if (eng.getCurrentActorIndex() === 0) eng.selectAttack()
      eng.tick(500)
    }
    expect(resumed.getState().enemies[0].hp).toBe(live.getState().enemies[0].hp)
    expect(resumed.getState().party[0].hp).toBe(live.getState().party[0].hp)
    expect(resumed.getState().atb!.partyGauge).toEqual(live.getState().atb!.partyGauge)
  })
})

describe('途中再開: 敵の記憶・脚本', () => {
  it('敵の記憶（行動回数）を戻す。数が合わなければ無視して初期状態', () => {
    const acting = (id: string) => foe(id, { actions: ['こうげき'] })
    const ok = new BattleEngine([ent('a')], [acting('s'), acting('t')], {
      rng: () => 0,
      restore: { enemyMemory: [{ acted: 3 }, { acted: 1 }] },
    })
    expect(ok.getState().enemyMemory).toEqual([{ acted: 3 }, { acted: 1 }])
    const bad = new BattleEngine([ent('a')], [acting('s'), acting('t')], {
      rng: () => 0,
      restore: { enemyMemory: [{ acted: 3 }] },
    })
    expect(bad.getState().enemyMemory).toEqual([{ acted: 0 }, { acted: 0 }])
  })

  it('脚本制御の戦闘の進行（経過ターン・発動済み）を戻す', () => {
    const e = new BattleEngine([ent('a')], [foe('s')], {
      rng: () => 0,
      script: { id: 'boss', rules: [] },
      restore: { script: { turn: 4, fired: [0, 2], joined: ['x'], fled: [1] } },
    })
    expect(e.getState().script).toEqual({
      id: 'boss',
      turn: 4,
      fired: [0, 2],
      joined: ['x'],
      fled: [1],
    })
  })

  it('restore が無ければ従来どおり（新規戦闘の初期値）', () => {
    const e = new BattleEngine([ent('a')], [foe('s')], {
      rng: () => 0,
      script: { id: 'boss', rules: [] },
    })
    expect(e.getState().script).toEqual({ id: 'boss', turn: 0, fired: [], joined: [], fled: [] })
  })
})
