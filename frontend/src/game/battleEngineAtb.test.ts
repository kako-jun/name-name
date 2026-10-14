/**
 * BattleEngine の ATB (#205) の単体テスト（独立テスト担当）。
 *
 * 仕様で固定された値（ゲージ満タン 1000 / AGI あたり 0.04 / tick 上限 10000ms / AGI5 で 5 秒）は
 * 定数を参照せず、リテラルで固定する（定数を書き換えても通ってしまうテストにしない）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BattleEngine, type AtbMode, type BattleState } from './battleEngine'
import type { BattleEntity } from './spellDsl'

function hero(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 4,
    maxMp: 4,
    atk: 10,
    def: 0,
    agi: 5,
    ...over,
  }
}

function foe(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 1000,
    maxHp: 1000,
    mp: 0,
    maxMp: 0,
    atk: 10,
    def: 0,
    agi: 1,
    exp: 7,
    gold: 3,
    ...over,
  }
}

type AtbOpt = NonNullable<ConstructorParameters<typeof BattleEngine>[2]>['atb']

function mk(
  party: BattleEntity[],
  enemies: BattleEntity[],
  atb: AtbOpt = {},
  rng: () => number = () => 0
): BattleEngine {
  return new BattleEngine(party, enemies, { atb, rng })
}

/** 先頭から順に値を返し、尽きたら 0 を返す rng */
function seq(...vals: number[]): () => number {
  let i = 0
  return () => (i < vals.length ? vals[i++] : 0)
}

/** 決定論的な擬似乱数（LCG）。エンジンごとに作り直す */
function lcg(seed = 12345): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

const atbOf = (e: BattleEngine) => e.getState().atb!

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ATB: 初期化と従来ターン制の不変', () => {
  it('atb 未指定 → state.atb は無く、phase は party-input、tick は何もしない（従来ターン制）', () => {
    const eng = new BattleEngine([hero('a')], [foe('s')], { rng: () => 0 })
    expect(eng.getState().atb).toBeUndefined()
    expect(eng.getState().phase).toBe('party-input')
    const before = JSON.stringify(eng.getState())
    eng.tick(99999)
    expect(JSON.stringify(eng.getState())).toBe(before)
  })

  it('従来ターン制: 先頭の生存者だけが行動し、敵ターンを挟んで party-input に戻る（挙動不変）', () => {
    const eng = new BattleEngine([hero('a'), hero('b')], [foe('s', { atk: 10 })], { rng: () => 0 })
    eng.selectAttack()
    const log = eng.getState().log
    expect(log).toContain('A の こうげき！')
    expect(log).not.toContain('B の こうげき！')
    expect(eng.getState().phase).toBe('party-input')
    expect(eng.getState().party[0].hp).toBe(90)
  })

  it('ATB 指定: 開始時は atb-running・ゲージ 0・キュー空', () => {
    const eng = mk([hero('a'), hero('b')], [foe('s')])
    const s = eng.getState()
    expect(s.phase).toBe('atb-running')
    expect(s.atb).toEqual({ mode: 'wait', partyGauge: [0, 0], enemyGauge: [0], queue: [] })
  })

  it('mode 省略・未知値は wait、active は active', () => {
    expect(atbOf(mk([hero('a')], [foe('s')], {})).mode).toBe('wait')
    expect(atbOf(mk([hero('a')], [foe('s')], { mode: 'bogus' as unknown as AtbMode })).mode).toBe(
      'wait'
    )
    expect(atbOf(mk([hero('a')], [foe('s')], { mode: 'active' })).mode).toBe('active')
  })
})

describe('ATB: ゲージの溜まる速さ（仕様値はリテラル）', () => {
  it.each([
    // [agi, 満タンまでの ms]
    [5, 5000],
    [10, 2500],
    [20, 1250],
  ])('AGI %d は %dms で満タン: -1ms では溜まりきらず、ちょうどでキューに入る', (agi, ms) => {
    const eng = mk([hero('a', { agi })], [foe('s')])
    eng.tick(ms - 1)
    expect(atbOf(eng).queue).toEqual([])
    expect(atbOf(eng).partyGauge[0]).toBeGreaterThan(990)
    expect(atbOf(eng).partyGauge[0]).toBeLessThan(1000)
    expect(eng.getState().phase).toBe('atb-running')
    eng.tick(1)
    expect(atbOf(eng).queue).toEqual([0])
    expect(atbOf(eng).partyGauge[0]).toBe(1000)
    expect(eng.getState().phase).toBe('party-input')
  })

  it('AGI5: 2500ms でゲージは 500（比例）、4999ms で約 999.8', () => {
    const eng = mk([hero('a', { agi: 5 })], [foe('s')])
    eng.tick(2500)
    expect(atbOf(eng).partyGauge[0]).toBeCloseTo(500, 6)
    eng.tick(2499)
    expect(atbOf(eng).partyGauge[0]).toBeCloseTo(999.8, 6)
  })

  it('AGI が 0 以下・NaN でも最低 1 で進む（AGI1 相当: 10000ms でゲージ 400）', () => {
    for (const agi of [0, -3, Number.NaN]) {
      const eng = mk([hero('a', { agi })], [foe('s')])
      eng.tick(10000)
      expect(atbOf(eng).partyGauge[0]).toBeCloseTo(400, 6)
    }
  })

  it('AGI が 0 以下でも進み続けて、いずれ満タンになる（戦闘が止まらない）', () => {
    const eng = mk([hero('a', { agi: 0 })], [foe('s')])
    for (let i = 0; i < 3; i++) eng.tick(10000)
    expect(atbOf(eng).queue).toEqual([0]) // 25000ms で満タン
  })

  it('敵ゲージも AGI に比例（AGI 10 の敵は 2500ms で行動する）', () => {
    const eng = mk([hero('a', { agi: 1 })], [foe('s', { agi: 10 })])
    eng.tick(2499)
    expect(eng.getState().party[0].hp).toBe(100)
    eng.tick(1)
    expect(eng.getState().party[0].hp).toBe(90)
  })
})

describe('ATB: tick の上限と不正値', () => {
  it('1 回の tick は 10000ms までに丸める（巨大値も 10001 も 10000 と同じ）', () => {
    const results = [10000, 10001, 1e9].map((ms) => {
      const eng = mk([hero('a', { agi: 1 })], [foe('s')])
      eng.tick(ms)
      return atbOf(eng).partyGauge[0]
    })
    expect(results[0]).toBeCloseTo(400, 6)
    expect(results[1]).toBeCloseTo(400, 6)
    expect(results[2]).toBeCloseTo(400, 6)
  })

  it.each([0, -1, -1000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '不正な ms (%s) は何もしない',
    (ms) => {
      const eng = mk([hero('a')], [foe('s')])
      const before = JSON.stringify(eng.getState())
      eng.tick(ms)
      expect(JSON.stringify(eng.getState())).toBe(before)
    }
  )

  it('終了後（victory / defeat / escaped）の tick は何もしない', () => {
    const win = mk([hero('a')], [foe('s', { hp: 1 })], {
      initialGauges: { party: [1000] },
    })
    win.selectAttack()
    expect(win.getState().phase).toBe('victory')
    const before = JSON.stringify(win.getState())
    win.tick(5000)
    expect(JSON.stringify(win.getState())).toBe(before)

    const esc = mk([hero('a')], [foe('s')], {}, () => 0)
    esc.selectEscape()
    expect(esc.getState().phase).toBe('escaped')
    const before2 = JSON.stringify(esc.getState())
    esc.tick(5000)
    expect(JSON.stringify(esc.getState())).toBe(before2)
  })
})

describe('ATB: 細かく刻んでも 1 回でも同じ結果（決定論）', () => {
  function run(chunk: number, total: number, mode: AtbMode): BattleState {
    const eng = new BattleEngine(
      [hero('a', { agi: 5 }), hero('b', { agi: 4 })],
      [foe('s', { agi: 10, atk: 7 })],
      { atb: { mode }, rng: lcg(777) }
    )
    for (let t = 0; t < total; t += chunk) eng.tick(chunk)
    return JSON.parse(JSON.stringify(eng.getState())) as BattleState
  }

  it.each(['wait', 'active'] as const)(
    '%s: 10000ms を 10000 / 1000 / 100 刻みで進めても同じ',
    (mode) => {
      const base = run(10000, 10000, mode)
      for (const chunk of [1000, 100]) {
        const s = run(chunk, 10000, mode)
        expect(s.log).toEqual(base.log)
        expect(s.phase).toBe(base.phase)
        expect(s.party.map((p) => p.hp)).toEqual(base.party.map((p) => p.hp))
        expect(s.atb!.queue).toEqual(base.atb!.queue)
        s.atb!.partyGauge.forEach((g, i) => expect(g).toBeCloseTo(base.atb!.partyGauge[i], 3))
        s.atb!.enemyGauge.forEach((g, i) => expect(g).toBeCloseTo(base.atb!.enemyGauge[i], 3))
      }
    }
  )

  it('active: 敵が複数回行動する区間でも、刻み方でログ（行動の並び）が変わらない', () => {
    const base = run(10000, 10000, 'active')
    expect(base.log.filter((l) => l === 'S の こうげき！').length).toBeGreaterThanOrEqual(3)
    expect(run(13, 10010 - 10, 'active').log).toEqual(base.log)
  })
})

describe('ATB: 同時満タンの順序は rng で決まる', () => {
  it('2 人が同時に満タン: rng=0 なら [1,0]、rng=0.99 なら [0,1]', () => {
    const a = mk([hero('a'), hero('b')], [foe('s')], {}, () => 0)
    a.tick(5000)
    expect(atbOf(a).queue).toEqual([1, 0])
    const b = mk([hero('a'), hero('b')], [foe('s')], {}, () => 0.99)
    b.tick(5000)
    expect(atbOf(b).queue).toEqual([0, 1])
  })

  it('3 人同時: rng 列で順序が変わる（Fisher-Yates）', () => {
    const a = mk([hero('a'), hero('b'), hero('c')], [foe('s')], {}, seq(0.99, 0.99))
    a.tick(5000)
    expect(atbOf(a).queue).toEqual([0, 1, 2])
    const b = mk([hero('a'), hero('b'), hero('c')], [foe('s')], {}, seq(0, 0))
    b.tick(5000)
    expect(atbOf(b).queue).toEqual([1, 2, 0])
  })

  it('満タンが 1 人だけなら rng を消費しない', () => {
    const rng = vi.fn(() => 0)
    const eng = new BattleEngine([hero('a')], [foe('s')], { atb: {}, rng })
    eng.tick(5000)
    expect(rng).not.toHaveBeenCalled()
  })

  it('味方と敵が同時に満タンでも壊れない（どちらも 1 回ずつ行動 / キュー）', () => {
    const eng = mk([hero('a', { agi: 5 })], [foe('s', { agi: 5 })], { mode: 'active' }, seq(0.99))
    eng.tick(5000)
    expect(atbOf(eng).queue).toEqual([0])
    expect(eng.getState().party[0].hp).toBe(90)
    expect(atbOf(eng).enemyGauge[0]).toBe(0)
  })
})

describe('ATB: wait / active と キューの有無（デシジョンテーブル）', () => {
  // 味方 A(AGI5) はすぐ満タン、味方 B(AGI1) と敵(AGI3) は途中。A が並んだ後の 5000ms での B / 敵の進み。
  // 行: [mode, A をキューに残す?, B のゲージが進む?, 敵のゲージが進む?]
  it.each([
    ['wait', true, false, false],
    ['wait', false, true, true],
    ['active', true, true, true],
    ['active', false, true, true],
  ] as const)(
    'mode=%s キューに A が残る=%s → B 進む=%s / 敵進む=%s',
    (mode, queued, bMoves, eMoves) => {
      const eng = mk(
        [hero('a', { agi: 5 }), hero('b', { agi: 1 })],
        [foe('s', { agi: 3, atk: 1 })],
        { mode }
      )
      eng.tick(5000) // A が満タン（B は 200, 敵は 600）
      expect(atbOf(eng).queue).toEqual([0])
      const b0 = atbOf(eng).partyGauge[1]
      const e0 = atbOf(eng).enemyGauge[0]
      expect(b0).toBeCloseTo(200, 6)
      expect(e0).toBeCloseTo(600, 6)
      if (!queued) eng.selectAttack() // A が行動してキューが空になる
      const b1 = atbOf(eng).partyGauge[1]
      const e1 = atbOf(eng).enemyGauge[0]
      eng.tick(1000)
      expect(atbOf(eng).partyGauge[1] > b1).toBe(bMoves)
      // 敵は 600 → 720（まだ満タンでない）
      expect(atbOf(eng).enemyGauge[0] > e1).toBe(eMoves)
    }
  )

  it('wait: コマンド待ち中は、巨大な tick を何度与えても誰のゲージも動かず敵も行動しない', () => {
    const eng = mk([hero('a'), hero('b', { agi: 1 })], [foe('s', { agi: 3 })])
    eng.tick(5000)
    const snap = JSON.stringify(eng.getState())
    for (let i = 0; i < 5; i++) eng.tick(10000)
    expect(JSON.stringify(eng.getState())).toBe(snap)
  })

  it('wait: 時間停止中に捨てられた ms は、解除後にまとめて加算されない', () => {
    const eng = mk([hero('a'), hero('b', { agi: 1 })], [foe('s', { agi: 3 })])
    eng.tick(5000) // A 並ぶ。B=200
    eng.tick(10000) // 停止中
    eng.selectAttack() // A 行動 → キュー空
    eng.tick(1000)
    expect(atbOf(eng).partyGauge[1]).toBeCloseTo(240, 6) // 200 + 1000*0.04
  })

  it('active: コマンド待ちの味方がいても敵は行動し、待っている味方のゲージは 1000 のまま', () => {
    const eng = mk([hero('a', { agi: 5 })], [foe('s', { agi: 3, atk: 10 })], { mode: 'active' })
    eng.tick(5000)
    expect(eng.getState().party[0].hp).toBe(100) // 敵はまだ 600
    eng.tick(4000) // 敵が 8333ms で満タン
    expect(eng.getState().party[0].hp).toBe(90)
    expect(atbOf(eng).partyGauge[0]).toBe(1000)
    expect(atbOf(eng).queue).toEqual([0])
    expect(eng.getState().phase).toBe('party-input')
  })

  it('1 回の tick の途中で A が満タン → wait はそこで止まり、残り時間は B / 敵に配られない', () => {
    const eng = mk([hero('a'), hero('b', { agi: 1 })], [foe('s', { agi: 3 })])
    eng.tick(10000) // A は 5000ms で並ぶ。その後の 5000ms は捨てる
    expect(atbOf(eng).partyGauge[1]).toBeCloseTo(200, 6)
    expect(atbOf(eng).enemyGauge[0]).toBeCloseTo(600, 6)
  })
})

describe('ATB: 状態遷移', () => {
  it('atb-running → party-input（満タン）→ atb-running（行動後）→ victory', () => {
    const eng = mk([hero('a', { atk: 50 })], [foe('s', { hp: 20, atk: 1 })])
    expect(eng.getState().phase).toBe('atb-running')
    eng.tick(5000)
    expect(eng.getState().phase).toBe('party-input')
    eng.selectAttack()
    expect(eng.getState().phase).toBe('victory')
    expect(eng.getState().earnedExp).toBe(7)
    expect(eng.getState().earnedGold).toBe(3)
  })

  it('行動後は atb-running に戻り、ゲージ 0・キュー空・敵ターン(enemy-turn)は挟まない', () => {
    const eng = mk([hero('a')], [foe('s', { hp: 1000 })])
    eng.tick(5000)
    eng.selectAttack()
    expect(eng.getState().phase).toBe('atb-running')
    expect(atbOf(eng).partyGauge[0]).toBe(0)
    expect(atbOf(eng).queue).toEqual([])
    expect(eng.getState().log.some((l) => l.includes('S の こうげき！'))).toBe(false)
  })

  it('敵に倒されて全滅 → defeat（以後 tick・コマンドは無効）', () => {
    const eng = mk([hero('a', { hp: 5 })], [foe('s', { agi: 10, atk: 50 })], {
      mode: 'active',
    })
    eng.tick(2500)
    expect(eng.getState().phase).toBe('defeat')
    expect(eng.getState().log[eng.getState().log.length - 1]).toBe('ぜんめつ してしまった……')
    const snap = JSON.stringify(eng.getState())
    eng.tick(5000)
    eng.selectAttack()
    eng.selectEscape()
    expect(JSON.stringify(eng.getState())).toBe(snap)
  })
})

describe('ATB: 全員行動（キュー先頭だけが行動）', () => {
  it('満タンの 2 人が順に行動し、各自のゲージが 0 に戻る', () => {
    const eng = mk([hero('a'), hero('b')], [foe('s')], {
      initialGauges: { party: [1000, 1000] },
    })
    expect(atbOf(eng).queue).toEqual([0, 1])
    expect(eng.getState().phase).toBe('party-input')
    eng.selectAttack()
    expect(eng.getState().log).toContain('A の こうげき！')
    expect(atbOf(eng).queue).toEqual([1])
    expect(atbOf(eng).partyGauge).toEqual([0, 1000])
    expect(eng.getState().phase).toBe('party-input')
    eng.selectAttack()
    expect(eng.getState().log).toContain('B の こうげき！')
    expect(atbOf(eng).queue).toEqual([])
    expect(eng.getState().phase).toBe('atb-running')
  })

  it('キュー先頭が先頭の生存者でなくても、キュー先頭の味方が行動する', () => {
    const eng = mk([hero('a'), hero('b')], [foe('s')], {
      initialGauges: { party: [0, 1000] },
    })
    expect(atbOf(eng).queue).toEqual([1])
    eng.selectAttack()
    expect(eng.getState().log).toContain('B の こうげき！')
    expect(eng.getState().log).not.toContain('A の こうげき！')
    expect(atbOf(eng).partyGauge).toEqual([0, 0])
  })

  it('atb-running 中（誰もコマンド待ちでない）の attack / spell / item は無視される', () => {
    const eng = mk([hero('a')], [foe('s')])
    const snap = JSON.stringify(eng.getState())
    eng.selectAttack()
    eng.selectSpell({ name: 'ホイミ', mp: 0, target: '味方単体', effect: 'heal 5..5' })
    eng.selectItem({ name: 'やくそう', effect: 'heal 5..5' })
    expect(JSON.stringify(eng.getState())).toBe(snap)
  })

  it('selectSpell / selectItem もキュー先頭の味方が使い、使った人のゲージだけ 0 になる', () => {
    const eng = mk([hero('a', { hp: 5 }), hero('b', { hp: 5 })], [foe('s')], {
      initialGauges: { party: [1000, 1000] },
    })
    eng.selectSpell({ name: 'ホイミ', mp: 0, target: '自分', effect: 'heal 10..10' })
    expect(eng.getState().party.map((p) => p.hp)).toEqual([15, 5])
    expect(atbOf(eng).partyGauge).toEqual([0, 1000])
    expect(atbOf(eng).queue).toEqual([1])
    eng.selectItem({ name: 'やくそう', effect: 'heal 3..3', builtin: undefined })
    expect(eng.getState().phase).toBe('atb-running')
    expect(atbOf(eng).queue).toEqual([])
    expect(atbOf(eng).partyGauge).toEqual([0, 0])
  })

  it('MP 不足の呪文は行動を消費しない（ゲージ・キューそのまま）', () => {
    const eng = mk([hero('a', { mp: 0 })], [foe('s')], { initialGauges: { party: [1000] } })
    eng.selectSpell({ name: 'メラ', mp: 3, target: '敵単体', effect: 'damage 5..5' })
    expect(atbOf(eng).queue).toEqual([0])
    expect(atbOf(eng).partyGauge).toEqual([1000])
  })
})

describe('ATB: 敵の自動行動と狙い', () => {
  it('敵はゲージ満タンで自動攻撃し、ログが出てゲージは 0 に戻る', () => {
    const eng = mk([hero('a', { agi: 1 })], [foe('s', { agi: 5, atk: 10 })])
    eng.tick(5000)
    expect(eng.getState().log).toContain('S の こうげき！')
    expect(eng.getState().log).toContain('A は 10 の ダメージを うけた！')
    expect(eng.getState().party[0].hp).toBe(90)
    expect(atbOf(eng).enemyGauge[0]).toBe(0)
  })

  it('敵 2 体は別々のゲージで、AGI の高い方が先に・多く行動する', () => {
    const eng = mk(
      [hero('a', { agi: 1, hp: 1000, maxHp: 1000 })],
      [foe('fast', { agi: 10 }), foe('slow', { agi: 5 })]
    )
    eng.tick(5000)
    const log = eng.getState().log
    expect(log.filter((l) => l === 'FAST の こうげき！')).toHaveLength(2)
    expect(log.filter((l) => l === 'SLOW の こうげき！')).toHaveLength(1)
  })

  it.each([
    // [rng の最初の値, 狙われる index]
    [0, 0],
    [0.34, 1],
    [0.5, 1],
    [0.67, 2],
    [0.999, 2],
    [1, 2], // 範囲外の 1.0 でも末尾に丸める
  ])('3 人生存: 狙いは rng=%s → 味方 index %d', (r, idx) => {
    const eng = mk(
      [hero('a', { agi: 1 }), hero('b', { agi: 1 }), hero('c', { agi: 1 })],
      [foe('s', { agi: 5, atk: 10 })],
      {},
      seq(r)
    )
    eng.tick(5000)
    expect(eng.getState().party.map((p) => p.hp)).toEqual(
      [0, 1, 2].map((i) => (i === idx ? 90 : 100))
    )
  })

  it('倒れた味方は狙われない（生存者の中から選ぶ）', () => {
    const eng = mk(
      [hero('a', { agi: 1, hp: 0 }), hero('b', { agi: 1 }), hero('c', { agi: 1 })],
      [foe('s', { agi: 5 })],
      {},
      seq(0)
    )
    eng.tick(5000)
    expect(eng.getState().party.map((p) => p.hp)).toEqual([0, 90, 100])
  })

  it('後衛への攻撃は半分（切り捨て・最低 1）、前衛・未指定はそのまま', () => {
    const back = mk([hero('a', { agi: 1, row: 'back' })], [foe('s', { agi: 5, atk: 10 })])
    back.tick(5000)
    expect(back.getState().party[0].hp).toBe(95)
    const front = mk([hero('a', { agi: 1, row: 'front' })], [foe('s', { agi: 5, atk: 10 })])
    front.tick(5000)
    expect(front.getState().party[0].hp).toBe(90)
    const none = mk([hero('a', { agi: 1 })], [foe('s', { agi: 5, atk: 10 })])
    none.tick(5000)
    expect(none.getState().party[0].hp).toBe(90)
  })

  it('後衛の敵（row: back）の攻撃も半分になる', () => {
    const eng = mk([hero('a', { agi: 1 })], [foe('s', { agi: 5, atk: 10, row: 'back' })])
    eng.tick(5000)
    expect(eng.getState().party[0].hp).toBe(95)
  })

  it('最低 1 ダメージ（後衛 + 高 def でも 0 にならない）', () => {
    const eng = mk([hero('a', { agi: 1, row: 'back', def: 100 })], [foe('s', { agi: 5, atk: 1 })])
    eng.tick(5000)
    expect(eng.getState().party[0].hp).toBe(99)
  })

  it('敵ゲージの初期値が 1000 なら、最初の tick(1) で行動する', () => {
    const eng = mk([hero('a', { agi: 1 })], [foe('s')], {
      initialGauges: { enemies: [1000] },
    })
    eng.tick(1)
    expect(eng.getState().party[0].hp).toBe(90)
  })
})

describe('ATB: 死亡者の扱い', () => {
  it('コマンド待ちの味方が敵に倒されたらキューから外れ、ゲージ 0。次の人に番が移る', () => {
    const eng = mk(
      [hero('a', { hp: 5 }), hero('b')],
      [foe('s', { agi: 5, atk: 50 })],
      { mode: 'active', initialGauges: { party: [1000, 1000], enemies: [999.9] } },
      seq(0) // 狙い = 生存者の先頭 = a
    )
    expect(atbOf(eng).queue).toEqual([0, 1])
    eng.tick(1)
    expect(eng.getState().party[0].hp).toBe(0)
    expect(atbOf(eng).queue).toEqual([1])
    expect(atbOf(eng).partyGauge[0]).toBe(0)
    expect(eng.getState().phase).toBe('party-input')
    eng.selectAttack()
    expect(eng.getState().log).toContain('B の こうげき！')
  })

  it('開始時点で hp 0 の者はゲージ 0・キューに入らない（初期ゲージ満タン指定でも）', () => {
    const eng = mk([hero('a', { hp: 0 }), hero('b')], [foe('s', { hp: 0 }), foe('t')], {
      initialGauges: { party: [1000, 0], enemies: [1000, 0] },
    })
    expect(atbOf(eng).partyGauge).toEqual([0, 0])
    expect(atbOf(eng).enemyGauge).toEqual([0, 0])
    expect(atbOf(eng).queue).toEqual([])
    eng.tick(10000)
    expect(atbOf(eng).partyGauge[0]).toBe(0)
  })

  it('倒れた敵のゲージは溜まらない（残った敵だけが行動）', () => {
    const eng = mk([hero('a', { agi: 1 })], [foe('dead', { hp: 0, agi: 10 }), foe('s', { agi: 5 })])
    eng.tick(5000)
    expect(eng.getState().log).not.toContain('DEAD の こうげき！')
    expect(eng.getState().log).toContain('S の こうげき！')
    expect(atbOf(eng).enemyGauge[0]).toBe(0)
  })

  it('最後の敵を倒した直後の tick で何も起きない（victory 済み）', () => {
    const eng = mk([hero('a', { atk: 999 })], [foe('s', { hp: 1 })], {
      initialGauges: { party: [1000] },
    })
    eng.selectAttack()
    const logLen = eng.getState().log.length
    eng.tick(10000)
    expect(eng.getState().log).toHaveLength(logLen)
  })
})

describe('ATB: initialGauges（任意局面）', () => {
  it.each([
    [-5, 0, false],
    [0, 0, false],
    [999, 999, false],
    [1000, 1000, true],
    [1001, 1000, true],
    [99999, 1000, true],
    [Number.NaN, 0, false],
    [Number.POSITIVE_INFINITY, 0, false],
    [Number.NEGATIVE_INFINITY, 0, false],
  ])('味方の初期ゲージ %s → %s（満タンでキュー入り=%s）', (given, stored, queued) => {
    const eng = mk([hero('a')], [foe('s')], { initialGauges: { party: [given] } })
    expect(atbOf(eng).partyGauge[0]).toBe(stored)
    expect(atbOf(eng).queue).toEqual(queued ? [0] : [])
    expect(eng.getState().phase).toBe(queued ? 'party-input' : 'atb-running')
  })

  it('敵の初期ゲージも丸める。一部だけ指定・短い配列は残りを 0 とする', () => {
    const eng = mk([hero('a'), hero('b')], [foe('s'), foe('t'), foe('u')], {
      initialGauges: { party: [300], enemies: [-1, 2000] },
    })
    expect(atbOf(eng).partyGauge).toEqual([300, 0])
    expect(atbOf(eng).enemyGauge).toEqual([0, 1000, 0])
  })

  it('初期ゲージは途中から正しく進む（500 → あと 2500ms で満タン）', () => {
    const eng = mk([hero('a')], [foe('s')], { initialGauges: { party: [500] } })
    eng.tick(2499)
    expect(atbOf(eng).queue).toEqual([])
    eng.tick(1)
    expect(atbOf(eng).queue).toEqual([0])
  })
})

describe('ATB: getCurrentActorIndex', () => {
  it('currentActor と一致し、倒れた人がキューに残っていても生存者を指す', () => {
    const eng = mk([hero('a'), hero('b')], [foe('s')], { initialGauges: { party: [1000, 1000] } })
    expect(eng.getCurrentActorIndex()).toBe(0)
    // 先頭を倒れた状態にしてもキューには残る状況を作る
    eng.getState().party[0].hp = 0
    expect(atbOf(eng).queue[0]).toBe(0)
    expect(eng.getCurrentActorIndex()).toBe(1)
    eng.getState().party[1].hp = 0
    expect(eng.getCurrentActorIndex()).toBe(-1)
  })
})

describe('ATB: にげる', () => {
  it('行動者の導出は一本化: たたかう / にげる失敗とも、キュー先頭の人だけがゲージ 0 になり次の人が番になる', () => {
    const init = { initialGauges: { party: [1000, 1000] } }
    const atk = mk([hero('a'), hero('b')], [foe('s')], init, () => 0)
    atk.selectAttack()
    expect(atbOf(atk).partyGauge).toEqual([0, 1000])
    expect(atbOf(atk).queue).toEqual([1])

    const esc = mk([hero('a'), hero('b')], [foe('s')], init, () => 0.9)
    esc.selectEscape()
    expect(atbOf(esc).partyGauge).toEqual([0, 1000])
    expect(atbOf(esc).queue).toEqual([1])
  })

  it('atb-running 中でも選べる。rng<0.5 で成功（0.49 成功 / 0.5 失敗）', () => {
    const ok = mk([hero('a')], [foe('s')], {}, () => 0.49)
    expect(ok.getState().phase).toBe('atb-running')
    ok.selectEscape()
    expect(ok.getState().phase).toBe('escaped')
    expect(ok.getState().log[ok.getState().log.length - 1]).toBe('にげだした！')

    const ng = mk([hero('a')], [foe('s')], {}, () => 0.5)
    ng.selectEscape()
    expect(ng.getState().phase).toBe('atb-running')
    expect(ng.getState().log[ng.getState().log.length - 1]).toBe('しかし まわりこまれてしまった！')
  })

  it('コマンド待ち（party-input）でも成功できる', () => {
    const eng = mk([hero('a')], [foe('s')], { initialGauges: { party: [1000] } }, () => 0)
    eng.selectEscape()
    expect(eng.getState().phase).toBe('escaped')
  })

  it('失敗: コマンド待ちの先頭の味方のゲージが 0 になり、キューから外れる。敵ターンは挟まない', () => {
    const eng = mk(
      [hero('a'), hero('b')],
      [foe('s')],
      { initialGauges: { party: [1000, 1000], enemies: [400] } },
      () => 0.9
    )
    eng.selectEscape()
    expect(atbOf(eng).partyGauge).toEqual([0, 1000])
    expect(atbOf(eng).queue).toEqual([1])
    expect(atbOf(eng).enemyGauge).toEqual([400])
    expect(eng.getState().party.map((p) => p.hp)).toEqual([100, 100])
    expect(eng.getState().phase).toBe('party-input')
  })

  it('失敗: 誰もコマンド待ちでなければ、ゲージが最大の生存味方のゲージが 0 になる', () => {
    const eng = mk(
      [hero('a'), hero('b'), hero('c')],
      [foe('s')],
      { initialGauges: { party: [300, 700, 500] } },
      () => 0.9
    )
    eng.selectEscape()
    expect(atbOf(eng).partyGauge).toEqual([300, 0, 500])
    eng.selectEscape()
    expect(atbOf(eng).partyGauge).toEqual([300, 0, 0])
  })

  it('失敗: 最大ゲージの味方が倒れていれば、生存者の中の最大を選ぶ', () => {
    const eng = mk(
      [hero('a', { hp: 0 }), hero('b'), hero('c')],
      [foe('s')],
      { initialGauges: { party: [900, 100, 200] } },
      () => 0.9
    )
    eng.selectEscape()
    expect(atbOf(eng).partyGauge).toEqual([0, 100, 0])
  })

  it('終了後の escape は何もしない（victory / defeat / escaped）', () => {
    const eng = mk([hero('a')], [foe('s')], {}, () => 0)
    eng.selectEscape()
    const snap = JSON.stringify(eng.getState())
    eng.selectEscape()
    expect(JSON.stringify(eng.getState())).toBe(snap)
  })

  it('従来ターン制の escape 失敗は従来どおり敵ターンを挟む（不変）', () => {
    const eng = new BattleEngine([hero('a')], [foe('s', { atk: 10 })], { rng: seq(0.9, 0) })
    eng.selectEscape()
    expect(eng.getState().party[0].hp).toBe(90)
    expect(eng.getState().phase).toBe('party-input')
  })
})

describe('ATB: コマンド種別 × フェーズ（デシジョンテーブル）', () => {
  // 行: [コマンド, atb-running で受理される?, party-input で受理される?]
  const run: Array<[string, (e: BattleEngine) => void]> = [
    ['attack', (e) => e.selectAttack()],
    ['spell', (e) => e.selectSpell({ name: 'ホイミ', mp: 0, target: '自分', effect: 'heal 5..5' })],
    ['item', (e) => e.selectItem({ name: 'やくそう', effect: 'heal 5..5' })],
    ['escape', (e) => e.selectEscape()],
  ]
  it.each([
    ['attack', false, true],
    ['spell', false, true],
    ['item', false, true],
    ['escape', true, true],
  ])('%s: atb-running で受理=%s / party-input で受理=%s', (name, running, input) => {
    const fn = run.find((r) => r[0] === name)![1]
    const e1 = mk([hero('a', { hp: 50 })], [foe('s')], {}, () => 0.9)
    const logLen1 = e1.getState().log.length
    fn(e1)
    expect(e1.getState().log.length > logLen1).toBe(running)
    const e2 = mk(
      [hero('a', { hp: 50 })],
      [foe('s')],
      { initialGauges: { party: [1000] } },
      () => 0.9
    )
    const logLen2 = e2.getState().log.length
    fn(e2)
    expect(e2.getState().log.length > logLen2).toBe(input)
  })
})

describe('ATB: 不変条件（擬似乱数でランダムに 300 回 tick / コマンド）', () => {
  it.each(['wait', 'active'] as const)(
    '%s: ゲージは 0..1000・キューは生存者のみで重複なし',
    (mode) => {
      const rng = lcg(99)
      const eng = new BattleEngine(
        [
          hero('a', { hp: 30, agi: 7 }),
          hero('b', { hp: 30, agi: 3 }),
          hero('c', { hp: 30, agi: 5 }),
        ],
        [foe('s', { hp: 80, agi: 6, atk: 12 }), foe('t', { hp: 80, agi: 2, atk: 12 })],
        { atb: { mode }, rng }
      )
      for (let n = 0; n < 300 && !eng.isOver(); n++) {
        const r = rng()
        if (r < 0.5) eng.tick(Math.floor(rng() * 3000) + 1)
        else if (r < 0.9) eng.selectAttack()
        else eng.selectEscape()
        const s = eng.getState()
        const atb = s.atb!
        for (const g of [...atb.partyGauge, ...atb.enemyGauge]) {
          expect(g).toBeGreaterThanOrEqual(0)
          expect(g).toBeLessThanOrEqual(1000)
        }
        expect(new Set(atb.queue).size).toBe(atb.queue.length)
        for (const i of atb.queue) {
          expect(s.party[i].hp).toBeGreaterThan(0)
          expect(atb.partyGauge[i]).toBe(1000)
        }
        s.party.forEach((p, i) => {
          if (p.hp <= 0) expect(atb.partyGauge[i]).toBe(0)
        })
        if (!eng.isOver()) {
          expect(s.phase).toBe(atb.queue.length > 0 ? 'party-input' : 'atb-running')
        }
        expect(s.phase).not.toBe('enemy-turn')
      }
    }
  )
})

describe('ATB: console 汚染', () => {
  it('通常の戦闘進行で console.warn / error / log / info を呼ばない', () => {
    const spies = (['warn', 'error', 'log', 'info'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {})
    )
    const eng = mk(
      [hero('a', { atk: 100 }), hero('b')],
      [foe('s', { hp: 60, agi: 8 })],
      {
        mode: 'active',
      },
      lcg(5)
    )
    for (let n = 0; n < 50 && !eng.isOver(); n++) {
      eng.tick(1500)
      eng.selectAttack()
    }
    eng.selectEscape()
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })
})

describe('ATB wait の停止範囲 waitScope (#204)', () => {
  const make = (scope?: 'command' | 'menu') =>
    new BattleEngine([hero('a')], [foe('s')], {
      rng: () => 0,
      atb: { mode: 'wait', waitScope: scope, initialGauges: { party: [1000], enemies: [0] } },
    })

  it('command（既定）: コマンド待ちの間は setAtbHold に関係なくずっと止まる', () => {
    const e = make()
    e.tick(1000)
    expect(e.getState().atb!.enemyGauge[0]).toBe(0)
    e.setAtbHold(true)
    e.tick(1000)
    expect(e.getState().atb!.enemyGauge[0]).toBe(0)
  })

  it('menu: hold の間だけ止まり、外すと進む', () => {
    const e = make('menu')
    e.tick(1000)
    const g = e.getState().atb!.enemyGauge[0]
    expect(g).toBeGreaterThan(0)
    e.setAtbHold(true)
    e.tick(1000)
    expect(e.getState().atb!.enemyGauge[0]).toBe(g)
    e.setAtbHold(false)
    e.tick(1000)
    expect(e.getState().atb!.enemyGauge[0]).toBeGreaterThan(g)
  })

  it('setAtbWaitScope で後から切り替えられ、command に戻すと hold も解く', () => {
    const e = make()
    e.setAtbWaitScope('menu')
    e.tick(500)
    expect(e.getState().atb!.enemyGauge[0]).toBeGreaterThan(0)
    e.setAtbHold(true)
    e.setAtbWaitScope('command')
    const g = e.getState().atb!.enemyGauge[0]
    e.tick(500)
    expect(e.getState().atb!.enemyGauge[0]).toBe(g)
  })

  it('active には影響しない・従来ターン制では何もしない', () => {
    const a = new BattleEngine([hero('a')], [foe('s')], {
      rng: () => 0,
      atb: { mode: 'active', waitScope: 'menu', initialGauges: { party: [1000], enemies: [0] } },
    })
    a.setAtbHold(true)
    a.tick(500)
    expect(a.getState().atb!.enemyGauge[0]).toBeGreaterThan(0)
    const plain = new BattleEngine([hero('a')], [foe('s')], { rng: () => 0 })
    plain.setAtbWaitScope('menu')
    plain.setAtbHold(true)
    expect(() => plain.tick(500)).not.toThrow()
  })
})
