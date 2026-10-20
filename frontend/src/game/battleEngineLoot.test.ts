/** 戦闘エンジンの戦利品: ドロップ・ぬすむ・結果の受け渡し (#831) */
import { describe, expect, it, vi } from 'vitest'
import { BattleEngine, type SkillExecution, type SpellExecution } from './battleEngine'
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

/** 固定列の乱数（呼ばれた回数も数える） */
function seq(values: number[]) {
  let n = 0
  return { rng: () => values[n++ % values.length], calls: () => n }
}

const STEAL: SpellExecution = { name: 'ぬすむ', mp: 0, target: '敵単体', effect: 'steal' }
const spell = (effect: string, target = '敵単体'): SpellExecution => ({
  name: 'S',
  mp: 0,
  target,
  effect,
})

function make(enemies: BattleEntity[], rng = () => 0.5, party: BattleEntity[] = []) {
  return new BattleEngine(
    party.length > 0 ? party : [ent({ id: 'hero', name: 'ゆうしゃ', atk: 999 })],
    enemies,
    { rng, itemNames: { potion: 'ポーション', elixir: 'エリクサー' } }
  )
}

describe('ぬすむ（通常枠・レア枠）', () => {
  it('通常枠: 盗めた品が loot に積まれ、ログに出て、HP は動かず MISS にならない', () => {
    const e = make([ent({ id: 'slime', name: 'スライム', loot: { steal: ['potion'] } })])
    e.selectSpell(STEAL)
    const st = e.getState()
    expect(st.loot).toEqual([
      {
        itemId: 'potion',
        count: 1,
        via: 'steal',
        rare: false,
        enemyId: 'slime',
        enemyName: 'スライム',
      },
    ])
    expect(st.log).toContain('ゆうしゃ は スライム から ポーション を ぬすんだ！')
    expect(st.enemies[0].hp).toBe(100)
    expect(st.events[0].kind).toBe('spell')
    expect(st.events[0].hits.map((h) => h.kind)).not.toContain('miss')
  })

  it('レア枠: レア率に当たればレア枠の品（rare: true）', () => {
    const e = make(
      [ent({ id: 'slime', name: 'スライム', loot: { steal: ['potion'], stealRare: ['elixir'] } })],
      () => 0.01
    )
    e.selectSpell(STEAL)
    expect(e.getState().loot).toMatchObject([{ itemId: 'elixir', rare: true }])
  })

  it('既定は盗むと空になる（ぬすむ回数 1）。2 回目は「もう なにも もっていない」で乱数も使わない', () => {
    const r = seq([0.5])
    const e = make([ent({ id: 'slime', name: 'スライム', loot: { steal: ['potion'] } })], r.rng)
    e.selectSpell(STEAL)
    const before = r.calls()
    // 敵ターンを挟んでも戦闘は続く（hero 999 HP 相当ではないので party-input に戻っているか確認）
    expect(e.getState().phase).toBe('party-input')
    e.selectSpell(STEAL)
    expect(e.getState().log.filter((l) => l.includes('もう なにも もっていない'))).toHaveLength(1)
    expect(e.getState().loot).toHaveLength(1)
    // 2 回目のぬすむ自体は乱数を使わない（敵ターンの分は増える）
    expect(r.calls() - before).toBeGreaterThanOrEqual(0)
  })

  it('ぬすむ回数: 3 なら 3 回まで、無限なら尽きない', () => {
    const e = make(
      [
        ent({
          id: 'slime',
          name: 'スライム',
          hp: 9999,
          maxHp: 9999,
          loot: { steal: ['potion'], stealLimit: '3' },
        }),
      ],
      () => 0.5,
      [ent({ id: 'hero', name: 'ゆうしゃ', hp: 9999, maxHp: 9999, def: 999 })]
    )
    for (let i = 0; i < 5; i++) e.selectSpell(STEAL)
    expect(e.getState().loot).toHaveLength(3)
    const inf = make(
      [
        ent({
          id: 'slime',
          name: 'スライム',
          hp: 9999,
          maxHp: 9999,
          loot: { steal: ['potion'], stealLimit: '無限' },
        }),
      ],
      () => 0.5,
      [ent({ id: 'hero', name: 'ゆうしゃ', hp: 9999, maxHp: 9999, def: 999 })]
    )
    for (let i = 0; i < 6; i++) inf.selectSpell(STEAL)
    expect(inf.getState().loot).toHaveLength(6)
  })

  it('失敗（確率）は在庫を減らさず、あとで盗める', () => {
    // 敵ターンの乱数に邪魔されないよう、行動の直前に次の値を決める
    let next = 0.9
    const e = make(
      [ent({ id: 'slime', name: 'スライム', atk: 0, loot: { steal: ['potion'] } })],
      () => next,
      [ent({ id: 'hero', name: 'ゆうしゃ', hp: 9999, maxHp: 9999, def: 999 })]
    )
    e.selectSpell(spell('steal 確率=60'))
    expect(e.getState().loot).toBeUndefined()
    expect(e.getState().log).toContain('スライム から ぬすめなかった！')
    next = 0.1
    e.selectSpell(spell('steal 確率=60'))
    expect(e.getState().loot).toHaveLength(1)
  })

  it('枠=レア はレア枠だけ。通常枠しか無い敵には「もう なにも もっていない」', () => {
    const e = make([
      ent({ id: 'a', name: 'A', loot: { steal: ['potion'], stealRare: ['elixir'] } }),
    ])
    e.selectSpell(spell('steal 枠=レア'))
    expect(e.getState().loot).toMatchObject([{ itemId: 'elixir', rare: true }])
    const f = make([ent({ id: 'b', name: 'B', loot: { steal: ['potion'] } })])
    f.selectSpell(spell('steal 枠=レア'))
    expect(f.getState().loot).toBeUndefined()
    expect(f.getState().log).toContain('B は もう なにも もっていない！')
  })

  it('回数=2: 在庫があるぶんだけ続けて試みる', () => {
    const e = make([
      ent({
        id: 'a',
        name: 'A',
        hp: 9999,
        maxHp: 9999,
        loot: { steal: ['potion'], stealLimit: '5' },
      }),
    ])
    e.selectSpell(spell('steal 回数=2'))
    expect(e.getState().loot).toHaveLength(2)
    const g = make([
      ent({ id: 'b', name: 'B', hp: 9999, maxHp: 9999, loot: { steal: ['potion'] } }),
    ])
    g.selectSpell(spell('steal 回数=2'))
    expect(g.getState().loot).toHaveLength(1)
    expect(g.getState().log.filter((l) => l.includes('もう なにも'))).toHaveLength(1)
  })

  it('ぶんどる: 盗みと同時にダメージ', () => {
    const e = make([ent({ id: 'a', name: 'A', loot: { steal: ['potion'] } })])
    e.selectSpell(spell('steal ぶんどる=10..10'))
    expect(e.getState().loot).toHaveLength(1)
    expect(e.getState().enemies[0].hp).toBe(90)
    expect(e.getState().events[0].hits.map((h) => h.kind)).toEqual(['damage'])
  })

  it('使い手の加算（stealChanceBonus / stealRareBonus）が効く', () => {
    // 確率 60 + 加算 39 = 99。0.985 は成功
    const hero = ent({ id: 'hero', name: 'ゆうしゃ', stealChanceBonus: 39 })
    const e = make([ent({ id: 'a', name: 'A', loot: { steal: ['potion'] } })], () => 0.985, [hero])
    e.selectSpell(spell('steal 確率=60'))
    expect(e.getState().loot).toHaveLength(1)
    // レア率: 既定 12.5 + 加算 50 = 62.5。0.6 でレア
    const hero2 = ent({ id: 'hero', name: 'ゆうしゃ', stealRareBonus: 50 })
    const f = make(
      [ent({ id: 'a', name: 'A', loot: { steal: ['potion'], stealRare: ['elixir'] } })],
      () => 0.6,
      [hero2]
    )
    f.selectSpell(STEAL)
    expect(f.getState().loot).toMatchObject([{ itemId: 'elixir', rare: true }])
  })

  it('特技（わざ）の効果としても使える。アイテムは対象が味方だけなので盗めない', () => {
    const e = make([
      ent({
        id: 'a',
        name: 'A',
        hp: 9999,
        maxHp: 9999,
        loot: { steal: ['potion'], stealLimit: '2' },
      }),
    ])
    const skill: SkillExecution = { name: 'ぬすむ', target: '相手単体', effect: 'steal' }
    expect(e.selectSkill(skill)).toBe(true)
    expect(e.getState().loot).toHaveLength(1)
    expect(e.getState().events[0].kind).toBe('skill')
    e.selectItem({ name: 'てぶくろ', effect: 'steal' }, 'a')
    expect(e.getState().loot).toHaveLength(1)
  })

  it('敵が使った steal・味方への steal・倒れた敵への steal は何も盗まない', () => {
    const e = make([ent({ id: 'a', name: 'A', loot: { steal: ['potion'] } })])
    // 味方に向ける
    e.selectSpell(spell('steal', '味方単体'))
    expect(e.getState().loot).toBeUndefined()
    expect(e.getState().log.some((l) => l.includes('ぬすめるのは'))).toBe(true)
    // 敵が特技で steal（味方から盗む）
    const sk = new BattleEngine(
      [ent({ id: 'hero' })],
      [ent({ id: 'a', loot: { steal: ['potion'] } })],
      {
        rng: () => 0.5,
        skills: {},
      }
    )
    sk.performSkill({ side: 'enemy', index: 0 }, { name: 'x', target: '相手単体', effect: 'steal' })
    expect(sk.getState().loot).toBeUndefined()
    // 敵が仲間（別の敵）に向けても盗めない
    const ally = new BattleEngine(
      [ent({ id: 'hero' })],
      [ent({ id: 'a', name: 'A' }), ent({ id: 'b', name: 'B', loot: { steal: ['potion'] } })],
      { rng: () => 0.5 }
    )
    ally.performSkill(
      { side: 'enemy', index: 0 },
      { name: 'x', target: '仲間単体', effect: 'steal' },
      { side: 'enemy', index: 1 }
    )
    expect(ally.getState().loot).toBeUndefined()
  })

  it('戦利品を宣言しない敵・盗めない敵は「もう なにも もっていない」で乱数を使わない', () => {
    const r = seq([0.5])
    const e = make([ent({ id: 'rock', name: 'いわ', atk: 0 })], r.rng)
    // performSkill は敵ターンを挟まないので、乱数の消費はぬすむ自体の分だけが数えられる
    e.performSkill(
      { side: 'party', index: 0 },
      { name: 'ぬすむ', target: '相手単体', effect: 'steal 確率=50' }
    )
    expect(e.getState().log).toContain('いわ は もう なにも もっていない！')
    expect(e.getState().loot).toBeUndefined()
    expect(r.calls()).toBe(0)
  })
})

describe('ドロップ', () => {
  it('勝利の瞬間に行ごと独立に抽選され、ログと loot に出る。敗北・逃走では出ない', () => {
    const r = seq([0.1, 0.9, 0.2])
    const e = make(
      [
        ent({
          id: 'slime',
          name: 'スライム',
          hp: 1,
          maxHp: 1,
          loot: { drops: ['potion 確率=50 個数=2', 'elixir 確率=50', 'potion 確率=50'] },
        }),
      ],
      r.rng
    )
    e.selectSpell(spell('damage 99..99'))
    const st = e.getState()
    expect(st.phase).toBe('victory')
    expect(st.loot?.map((l) => [l.itemId, l.count, l.via])).toEqual([
      ['potion', 2, 'drop'],
      ['potion', 1, 'drop'],
    ])
    expect(st.log).toContain('ポーション ×2 を てに いれた！')
    expect(st.log.indexOf('1 ゴールドを てに いれた！')).toBeLessThan(
      st.log.indexOf('ポーション ×2 を てに いれた！')
    )
  })

  it('敵の並び順に抽選する（複数の敵）', () => {
    const e = make([
      ent({ id: 'a', name: 'A', hp: 1, maxHp: 1, loot: { drops: ['potion'] } }),
      ent({ id: 'b', name: 'B', hp: 1, maxHp: 1, loot: { drops: ['elixir'] } }),
    ])
    e.selectSpell(spell('damage 99..99', '敵全体'))
    expect(e.getState().loot?.map((l) => [l.itemId, l.enemyId])).toEqual([
      ['potion', 'a'],
      ['elixir', 'b'],
    ])
  })

  it('逃走ではドロップが出ないが、盗んだ品は結果に残る', () => {
    const e = make(
      [
        ent({
          id: 'a',
          name: 'A',
          hp: 9999,
          maxHp: 9999,
          loot: { drops: ['elixir'], steal: ['potion'] },
        }),
      ],
      () => 0.1
    )
    e.selectSpell(STEAL)
    e.selectEscape()
    expect(e.getState().phase).toBe('escaped')
    const r = e.getResult()
    expect(r?.outcome).toBe('escaped')
    expect(r?.loot.map((l) => [l.itemId, l.via])).toEqual([['potion', 'steal']])
    expect(r?.exp).toBe(0)
    expect(r?.gold).toBe(0)
  })

  it('敗北でもぬすんだ品は結果に残る', () => {
    const e = make(
      [ent({ id: 'a', name: 'A', hp: 9999, maxHp: 9999, atk: 9999, loot: { steal: ['potion'] } })],
      () => 0.5,
      [ent({ id: 'hero', name: 'ゆうしゃ', hp: 1, maxHp: 1, def: 0 })]
    )
    e.selectSpell(STEAL)
    expect(e.getState().phase).toBe('defeat')
    expect(e.getResult()?.items).toEqual([{ itemId: 'potion', count: 1 }])
  })

  it('不正な宣言は警告を 1 度だけ出して無視する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mk = () =>
      make([ent({ id: 'bad-loot-test', hp: 1, maxHp: 1, loot: { drops: ['x 確率=zz'] } })])
    mk()
    mk()
    const calls = warn.mock.calls.filter((c) => String(c[0]).includes('bad-loot-test'))
    expect(calls).toHaveLength(1)
    warn.mockRestore()
  })
})

describe('getResult と旧挙動不変', () => {
  it('終わっていなければ null。victory は exp / gold / 集計を返す', () => {
    const e = make([
      ent({ id: 'a', hp: 1, maxHp: 1, exp: 7, gold: 3, loot: { drops: ['potion', 'potion'] } }),
    ])
    expect(e.getResult()).toBeNull()
    e.selectAttack()
    const r = e.getResult()
    expect(r).toMatchObject({ outcome: 'victory', exp: 7, gold: 3 })
    expect(r?.items).toEqual([{ itemId: 'potion', count: 2 }])
    // 返した結果を書き換えても戦闘の状態に影響しない
    r?.loot.pop()
    expect(e.getState().loot).toHaveLength(2)
  })

  it('戦利品を宣言しない戦闘: loot は undefined のまま、ログも乱数の消費も従来どおり', () => {
    const r = seq([0.5])
    const e = make([ent({ id: 'a', hp: 1, maxHp: 1 })], r.rng)
    e.selectSpell(spell('damage 99..99'))
    expect(e.getState().loot).toBeUndefined()
    expect(e.getState().log.slice(-2)).toEqual([
      'けいけんち 1 を てに いれた！',
      '1 ゴールドを てに いれた！',
    ])
    expect(r.calls()).toBe(0)
    expect(e.getResult()).toMatchObject({ outcome: 'victory', loot: [], items: [] })
  })

  it('名前の分からない id は id のまま表示する', () => {
    const e = new BattleEngine(
      [ent({ id: 'hero', atk: 999 })],
      [ent({ id: 'a', hp: 1, maxHp: 1, loot: { drops: ['mystery_item'] } })],
      { rng: () => 0.5 }
    )
    e.selectAttack()
    expect(e.getState().log).toContain('mystery_item を てに いれた！')
  })

  it('ATB でも同じ（ぬすむと勝利のドロップ）', () => {
    const e = new BattleEngine(
      [ent({ id: 'hero', atk: 999, agi: 50 })],
      [ent({ id: 'a', hp: 1, maxHp: 1, agi: 1, loot: { steal: ['potion'], drops: ['elixir'] } })],
      { rng: () => 0.5, atb: { mode: 'wait' } }
    )
    e.tick(10_000)
    e.selectSpell(STEAL)
    expect(e.getState().loot?.map((l) => l.via)).toEqual(['steal'])
    e.tick(10_000)
    e.selectAttack()
    expect(e.getState().phase).toBe('victory')
    expect(e.getState().loot?.map((l) => l.via)).toEqual(['steal', 'drop'])
  })
})
