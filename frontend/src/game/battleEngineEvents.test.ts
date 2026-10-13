/** 戦闘エンジンの行動の記録 (#745) の追加観点: 上限境界・行動種別・結果の組み合わせ・記録されない行動 */
import { describe, it, expect } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'E',
    hp: 9999,
    maxHp: 9999,
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
const rng = () => 0

describe('events の上限 30 件（29 / 30 / 31）', () => {
  // 1 ラウンド = 味方の攻撃 + 敵の反撃の 2 件。最後に敵 HP を 1 にして味方の 1 件だけで終えると奇数件になる
  function playTo(rounds: number, finish: boolean) {
    const e = new BattleEngine([ent({ id: 'hero' })], [ent({ id: 'slime' })], { rng })
    for (let i = 0; i < rounds; i++) e.selectAttack()
    if (finish) {
      e.getState().enemies[0].hp = 1
      e.selectAttack()
    }
    return e.getState()
  }

  it('29 件: 全件残り、先頭は seq 0', () => {
    const s = playTo(14, true)
    expect(s.eventTotal).toBe(29)
    expect(s.events).toHaveLength(29)
    expect(s.events[0].seq).toBe(0)
  })
  it('30 件: 全件残り、先頭は seq 0（まだ捨てない）', () => {
    const s = playTo(15, false)
    expect(s.eventTotal).toBe(30)
    expect(s.events).toHaveLength(30)
    expect(s.events[0].seq).toBe(0)
  })
  it('31 件: 先頭 1 件を捨て、先頭は seq 1、末尾は seq 30', () => {
    const s = playTo(15, true)
    expect(s.eventTotal).toBe(31)
    expect(s.events).toHaveLength(30)
    expect(s.events[0].seq).toBe(1)
    expect(s.events[29].seq).toBe(30)
  })
  it('seq は連番で欠けない（残っている範囲で）', () => {
    const s = playTo(20, false)
    s.events.forEach((ev, i) => expect(ev.seq).toBe(s.eventTotal - s.events.length + i))
  })
})

describe('行動種別 x 結果', () => {
  it('アイテム: kind=item・label=名前・heal を記録する', () => {
    const e = new BattleEngine([ent({ id: 'hero', hp: 10, maxHp: 50 })], [ent()], { rng })
    e.selectItem({ name: 'やくそう', effect: 'heal 7..7' })
    const ev = e.getState().events[0]
    expect(ev.kind).toBe('item')
    expect(ev.label).toBe('やくそう')
    expect(ev.hits).toEqual([
      {
        target: { side: 'party', index: 0 },
        kind: 'heal',
        amount: 7,
        hpBefore: 10,
        hpAfter: 17,
      },
    ])
  })

  it('呪文が敵を倒したとき hpAfter は 0、amount は実際に減った量（オーバーキルを含めない）', () => {
    const e = new BattleEngine([ent({ id: 'hero' })], [ent({ hp: 3, maxHp: 3 })], { rng })
    e.selectSpell({ name: 'ファイア', mp: 1, target: '敵単体', effect: 'damage 50..50' })
    const hit = e.getState().events[0].hits[0]
    expect(hit.kind).toBe('damage')
    expect(hit.hpAfter).toBe(0)
    expect(hit.amount).toBe(hit.hpBefore - hit.hpAfter)
    expect(hit.amount).toBe(3)
  })

  it('全体呪文: 対象ごとに 1 hit、順序は 味方→敵 の index 順', () => {
    const e = new BattleEngine(
      [ent({ id: 'h1' }), ent({ id: 'h2' })],
      [ent({ id: 's1' }), ent({ id: 's2' }), ent({ id: 's3' })],
      { rng }
    )
    e.selectSpell({ name: 'ブリザド', mp: 1, target: '敵全体', effect: 'damage 5..5' })
    const hits = e.getState().events[0].hits
    expect(hits.map((h) => [h.target.side, h.target.index])).toEqual([
      ['enemy', 0],
      ['enemy', 1],
      ['enemy', 2],
    ])
    expect(hits.every((h) => h.kind === 'damage')).toBe(true)
  })

  it('効果定義のない呪文: 対象は空で hits も空（演出は時間だけ消費）', () => {
    const e = new BattleEngine([ent({ id: 'hero' })], [ent()], { rng })
    e.selectSpell({ name: 'なぞ', mp: 1, target: '敵単体' })
    const ev = e.getState().events[0]
    expect(ev.label).toBe('なぞ')
    expect(ev.hits.every((h) => h.kind === 'miss')).toBe(true)
  })

  it('敵が味方を倒す反撃: hpAfter=0 の hit が記録される', () => {
    const e = new BattleEngine([ent({ id: 'hero', hp: 1, maxHp: 1 })], [ent()], { rng })
    e.selectAttack()
    const s = e.getState()
    const enemyHit = s.events.find((x) => x.actor.side === 'enemy')!
    expect(enemyHit.hits[0].target).toEqual({ side: 'party', index: 0 })
    expect(enemyHit.hits[0].hpAfter).toBe(0)
    expect(s.phase).toBe('defeat')
  })
})

describe('記録されない行動・不変条件', () => {
  it('逃走成功は行動を記録しない', () => {
    const e = new BattleEngine([ent({ id: 'hero' })], [ent()], { rng })
    e.selectEscape()
    expect(e.getState().phase).toBe('escaped')
    expect(e.getState().eventTotal).toBe(0)
  })

  it('逃走失敗は敵の反撃だけ記録する', () => {
    const e = new BattleEngine([ent({ id: 'hero' })], [ent()], { rng: () => 0.9 })
    e.selectEscape()
    const s = e.getState()
    expect(s.eventTotal).toBe(1)
    expect(s.events[0].actor.side).toBe('enemy')
  })

  it('決着後の入力では増えない', () => {
    const e = new BattleEngine([ent({ id: 'hero' })], [ent({ hp: 1, maxHp: 1 })], { rng })
    e.selectAttack()
    const total = e.getState().eventTotal
    e.selectAttack()
    expect(e.getState().eventTotal).toBe(total)
  })

  it('全 hit で hpBefore - hpAfter の符号と kind が一致し、amount は差の絶対値', () => {
    const e = new BattleEngine([ent({ id: 'hero', hp: 10, maxHp: 50 })], [ent()], { rng })
    e.selectAttack()
    e.selectSpell({ name: 'ケア', mp: 1, target: '味方単体', effect: 'heal 4..4' })
    for (const ev of e.getState().events)
      for (const h of ev.hits) {
        expect(h.amount).toBe(Math.abs(h.hpAfter - h.hpBefore))
        if (h.kind === 'damage') expect(h.hpAfter).toBeLessThanOrEqual(h.hpBefore)
        if (h.kind === 'heal') expect(h.hpAfter).toBeGreaterThan(h.hpBefore)
        if (h.kind === 'miss') expect(h.hpAfter).toBe(h.hpBefore)
      }
  })

  it('events は state の確定値から導かれ、エンジンの HP と最後の hpAfter が一致する', () => {
    const e = new BattleEngine([ent({ id: 'hero' })], [ent()], { rng })
    e.selectAttack()
    const s = e.getState()
    const last = s.events.filter((x) => x.hits[0].target.side === 'enemy').pop()!
    expect(last.hits[0].hpAfter).toBe(s.enemies[0].hp)
  })
})
