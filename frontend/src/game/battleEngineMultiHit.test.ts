/** 戦闘エンジン経由の複数ヒット `回数=N` (#879) */
import { describe, it, expect } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 100,
    maxHp: 100,
    mp: 9,
    maxMp: 9,
    atk: 5,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

function setup(enemies: BattleEntity[]) {
  let n = 0
  const rng = () => [0.1, 0.9, 0.5, 0.3, 0.7, 0.2][n++ % 6]
  const e = new BattleEngine([ent({ id: 'hero', name: 'ゆうしゃ' })], enemies, { rng })
  return { e, calls: () => n }
}

describe('エンジン経由の複数ヒット', () => {
  it('単体: hits は再生順で、同じ target が複数回・hpBefore/hpAfter が連鎖する', () => {
    const { e } = setup([ent({ id: 's1', name: 'スライム' })])
    e.selectSpell({ name: 'みだれうち', mp: 1, target: '敵単体', effect: 'damage 10 回数=3' })
    const ev = e.getState().events[0]
    expect(ev.kind).toBe('spell')
    expect(ev.hits.map((h) => [h.kind, h.amount, h.hpBefore, h.hpAfter, h.round])).toEqual([
      ['damage', 10, 100, 90, 0],
      ['damage', 10, 90, 80, 1],
      ['damage', 10, 80, 70, 2],
    ])
    expect(e.getState().enemies[0].hp).toBe(70)
    const log = e.getState().log.filter((l) => l.includes('のダメージ'))
    expect(log).toHaveLength(3)
  })

  it('オーバーキルの数字は計算量、hpAfter は 0 で止まり、倒れたら別の敵へ', () => {
    const { e } = setup([
      ent({ id: 's1', name: 'A', hp: 15, maxHp: 15 }),
      ent({ id: 's2', name: 'B' }),
    ])
    e.selectSpell({ name: 'みだれうち', mp: 1, target: '敵単体', effect: 'damage 10 回数=4' })
    const hits = e.getState().events[0].hits
    expect(hits.map((h) => [h.target.index, h.amount, h.hpBefore, h.hpAfter])).toEqual([
      [0, 10, 15, 5],
      [0, 10, 5, 0],
      [1, 10, 100, 90],
      [1, 10, 90, 80],
    ])
    expect(e.getState().log.filter((l) => l.includes('A は たおれた')).length).toBe(1)
  })

  it('全体: N 巡して毎巡全員（巡ごとに round）', () => {
    const { e } = setup([ent({ id: 's1', name: 'A' }), ent({ id: 's2', name: 'B' })])
    e.selectSpell({ name: 'ぜんたい', mp: 1, target: '敵全体', effect: 'damage 7 回数=2' })
    const hits = e.getState().events[0].hits
    expect(hits.map((h) => [h.target.index, h.round, h.hpBefore, h.hpAfter])).toEqual([
      [0, 0, 100, 93],
      [1, 0, 100, 93],
      [0, 1, 93, 86],
      [1, 1, 93, 86],
    ])
  })

  it('全滅で打ち切り、戦闘は勝利になる', () => {
    const { e } = setup([ent({ id: 's1', hp: 5, maxHp: 5 })])
    e.selectSpell({ name: 'みだれうち', mp: 1, target: '敵単体', effect: 'damage 10 回数=9' })
    expect(e.getState().events[0].hits).toHaveLength(1)
    expect(e.getState().phase).toBe('victory')
  })

  it('属性: 弱点・吸収・無効がヒットごと', () => {
    const { e } = setup([
      ent({
        id: 's1',
        name: 'A',
        hp: 50,
        affinity: { weak: [], halve: [], nullify: [], absorb: ['fire'] },
      }),
    ])
    e.selectSpell({
      name: 'ファイア',
      mp: 1,
      target: '敵単体',
      effect: 'damage 10 type=fire 回数=2',
    })
    const hits = e.getState().events[0].hits
    expect(hits.map((h) => [h.kind, h.hpBefore, h.hpAfter])).toEqual([
      ['heal', 50, 60],
      ['heal', 60, 70],
    ])
  })

  it('回数未指定: 従来の経路（hits 1 件・round なし）', () => {
    const { e } = setup([ent({ id: 's1' })])
    e.selectSpell({ name: 'ファイア', mp: 1, target: '敵単体', effect: 'damage 4..7' })
    const hits = e.getState().events[0].hits
    expect(hits).toHaveLength(1)
    expect('round' in hits[0]).toBe(false)
  })

  it('回数=1 は未指定と完全に同じ（ログ・イベント・rng 消費）', () => {
    const a = setup([ent({ id: 's1' })])
    const b = setup([ent({ id: 's1' })])
    a.e.selectSpell({ name: 'X', mp: 1, target: '敵単体', effect: 'damage 4..7' })
    b.e.selectSpell({ name: 'X', mp: 1, target: '敵単体', effect: 'damage 4..7 回数=1' })
    expect(b.e.getState().log).toEqual(a.e.getState().log)
    expect(b.e.getState().events).toEqual(a.e.getState().events)
    expect(b.calls()).toBe(a.calls())
  })

  it('同じ rng 列で同じ結果（決定論）', () => {
    const run = () => {
      const { e } = setup([ent({ id: 's1' }), ent({ id: 's2' })])
      e.selectSpell({ name: 'X', mp: 1, target: '敵全体', effect: 'damage 1..30 回数=5' })
      return JSON.stringify(e.getState().events)
    }
    expect(run()).toBe(run())
  })

  it('特技（performSkill）でも複数ヒット。敵が相手単体を撃つと相手陣営（味方）の中で乗り換える', () => {
    const rng = () => 0
    const e = new BattleEngine(
      [ent({ id: 'h1', hp: 50, maxHp: 50 }), ent({ id: 'h2', hp: 100, maxHp: 100 })],
      [ent({ id: 's1' })],
      { rng }
    )
    e.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'ひっかき', target: '相手単体', effect: 'damage 30 回数=4' }
    )
    const hits = e.getState().events[e.getState().events.length - 1].hits
    expect(hits.map((h) => [h.target.index, h.hpAfter])).toEqual([
      [0, 20],
      [0, 0],
      [1, 70],
      [1, 40],
    ])
  })

  describe('自分・仲間を狙う複数ヒットは、標的が倒れたら打ち切り（仲間に流さない）', () => {
    const mk = () => {
      const rng = () => 0
      return new BattleEngine(
        [ent({ id: 'h1' })],
        [ent({ id: 's1', hp: 50, maxHp: 50 }), ent({ id: 's2', hp: 90, maxHp: 90 })],
        { rng }
      )
    }
    it.each(['自分', '仲間単体'])('敵の特技 %s', (target) => {
      const e = mk()
      e.performSkill(
        { side: 'enemy', index: 0 },
        { name: 'じばく', target, effect: 'damage 30 回数=5' }
      )
      const st = e.getState()
      const hits = st.events[st.events.length - 1].hits
      expect(hits.map((h) => [h.target.index, h.hpAfter])).toEqual([
        [0, 20],
        [0, 0],
      ])
      expect(st.enemies[1].hp).toBe(90)
    })
    it('死亡時の行動（倒れた使い手が仲間単体へ）。生存している第三の仲間に漏れない', () => {
      const e = new BattleEngine(
        [ent({ id: 'h1' })],
        [
          ent({ id: 's1', hp: 0, maxHp: 50 }),
          ent({ id: 's2', hp: 50, maxHp: 50 }),
          ent({ id: 's3', hp: 90, maxHp: 90 }),
        ],
        { rng: () => 0 }
      )
      e.performSkill(
        { side: 'enemy', index: 0 },
        { name: 'みちづれ', target: '仲間単体', effect: 'damage 30 回数=5' },
        undefined,
        { allowDowned: true }
      )
      const st = e.getState()
      const hits = st.events[st.events.length - 1].hits
      expect(hits.every((h) => h.target.index === 1)).toBe(true)
      expect(hits.map((h) => h.hpAfter)).toEqual([20, 0])
      expect(st.enemies[2].hp).toBe(90)
    })
    it('味方の 味方単体 呪文でも倒れたら打ち切り（敵・他の味方は不変）', () => {
      const e = new BattleEngine(
        [ent({ id: 'h1', hp: 40, maxHp: 40 }), ent({ id: 'h2' })],
        [ent({ id: 's1' })],
        { rng: () => 0 }
      )
      e.selectSpell({ name: 'じゅうし', mp: 1, target: '味方単体', effect: 'damage 30 回数=4' })
      const st = e.getState()
      expect(st.events[0].hits.every((h) => h.target.index === 0)).toBe(true)
      expect(st.events[0].hits.map((h) => h.hpAfter)).toEqual([10, 0])
    })
  })

  it('アイテムの damage 回数=N は味方単体（自陣営）に当たり、倒れても他の味方に流れない', () => {
    // アイテムの対象は味方単体のみ（resolveItemTargets）。敵単体へ撃つ経路は無いので、自陣営狙いの打ち切りで確認する
    const e = new BattleEngine(
      [ent({ id: 'h1', hp: 40, maxHp: 40 }), ent({ id: 'h2' })],
      [ent({ id: 's1' })],
      { rng: () => 0 }
    )
    e.selectItem({ name: 'ばくだん', effect: 'damage 30 回数=4' } as never)
    const hits = e.getState().events[0].hits
    expect(hits.map((h) => [h.target.index, h.hpAfter])).toEqual([
      [0, 10],
      [0, 0],
    ])
  })

  it('アイテムに回数を付けても無視（警告ログ）', () => {
    const { e } = setup([ent({ id: 's1' })])
    e.getState().party[0].hp = 50
    e.selectItem({ name: 'やくそう', effect: 'heal 10 回数=3' } as never)
    expect(e.getState().events[0].hits).toHaveLength(1)
    expect(e.getState().log.some((l) => l.includes('警告: 回数= は damage 専用'))).toBe(true)
  })
})
