import { describe, it, expect, vi, afterEach } from 'vitest'
import { BattleEngine, computeRowAttackDamage } from './battleEngine'
import type { BattleEntity, EnemyLayout } from './spellDsl'
import type { EnemyGridSize } from './enemyGrid'

/** 敵の最前列 (#896)。最前列（グリッドの右端の列）にいない敵への通常攻撃は半分。atk 20 vs def 4・rng 0 の通常攻撃は 18（最前列）/ 9（それ以外）。 */
const FULL = 18
const HALF = 9

function hero(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'hero',
    name: 'ゆうしゃ',
    hp: 9999,
    maxHp: 9999,
    mp: 10,
    maxMp: 10,
    atk: 20,
    def: 4,
    agi: 50,
    ...over,
  }
}

function foe(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 1,
    def: 4,
    agi: 1,
    exp: 1,
    gold: 1,
    ...over,
  }
}

const at = (col: number, row = 0): { layout: EnemyLayout } => ({
  layout: { w: 1, h: 1, scale: 1, at: { col, row } },
})

const GRID: EnemyGridSize = { cols: 3, rows: 2 }

/** 勇者が `target` を通常攻撃して減った HP */
function hit(
  enemies: BattleEntity[],
  target: string,
  opts: ConstructorParameters<typeof BattleEngine>[2] = {}
): number {
  const t = enemies.find((e) => e.id === target)!
  const before = t.hp
  const eng = new BattleEngine([hero()], enemies, { rng: () => 0, ...opts })
  eng.selectAttack(target)
  return before - t.hp
}

afterEach(() => vi.restoreAllMocks())

describe('敵の最前列: enemyRow を渡さなければ何も変わらない (#896)', () => {
  it('グリッドの位置があっても全員 18', () => {
    for (const id of ['a', 'b']) {
      expect(hit([foe('a', at(2)), foe('b', at(0))], id)).toBe(FULL)
    }
  })
  it('乱数の消費も同じ（通常攻撃 1 回で rng 1 回）', () => {
    let n = 0
    const es = [foe('a', at(2)), foe('b', at(0))]
    const eng = new BattleEngine([hero()], es, {
      rng: () => {
        n++
        return 0
      },
    })
    eng.selectAttack('b')
    const off = n
    n = 0
    const on = new BattleEngine([hero()], [foe('a', at(2)), foe('b', at(0))], {
      rng: () => {
        n++
        return 0
      },
      enemyRow: { grid: GRID },
    })
    on.selectAttack('b')
    expect(n).toBe(off)
  })
  it('computeRowAttackDamage の第 4 引数を省くと従来どおり defender.row', () => {
    expect(computeRowAttackDamage(hero(), foe('x', { row: 'back' }), () => 0)).toBe(HALF)
    expect(computeRowAttackDamage(hero(), foe('x'), () => 0, 'back')).toBe(HALF)
  })
})

describe('敵の最前列: グリッドの右端の列 (#896)', () => {
  const es = () => [foe('a', at(2)), foe('b', at(1)), foe('c', at(0))]
  it('最も右の列が最前列、他は半分', () => {
    const opt = { enemyRow: { grid: GRID } }
    expect(hit(es(), 'a', opt)).toBe(FULL)
    expect(hit(es(), 'b', opt)).toBe(HALF)
    expect(hit(es(), 'c', opt)).toBe(HALF)
  })
  it('同じ列の上下の敵はどちらも最前列', () => {
    const e = [foe('a', at(2, 0)), foe('b', at(2, 1)), foe('c', at(0))]
    const opt = { enemyRow: { grid: GRID } }
    expect(hit(e, 'a', opt)).toBe(FULL)
    expect(hit(e, 'b', opt)).toBe(FULL)
    expect(hit(e, 'c', opt)).toBe(HALF)
  })
  it('配置指定が無い敵は自動配置（右の列から）で判定する', () => {
    // 3x1: 自動配置は右の列から a=列2, b=列1, c=列0
    const e = [foe('a'), foe('b'), foe('c')]
    const opt = { enemyRow: { grid: { cols: 3, rows: 1 } } }
    expect(hit(e, 'a', opt)).toBe(FULL)
    expect(hit(e, 'b', opt)).toBe(HALF)
    expect(hit(e, 'c', opt)).toBe(HALF)
  })
  it('幅 2 の敵は占有セルの右端の列で判定する', () => {
    const wide = foe('w', { layout: { w: 2, h: 1, scale: 1, at: { col: 0, row: 0 } } })
    const e = [wide, foe('s', at(2, 1))]
    const opt = { enemyRow: { grid: GRID } }
    // w は列 0〜1（右端 1）、s は列 2 → s が最前列・w は半分
    expect(hit(e, 's', opt)).toBe(FULL)
    expect(hit([wide, foe('s', at(2, 1))], 'w', opt)).toBe(HALF)
  })
  it('グリッドに収まらない敵（置けない）・グリッドの無い戦闘は軽減しない', () => {
    const e = [foe('a', at(2)), foe('b', at(9)), foe('c', at(0))]
    expect(hit(e, 'b', { enemyRow: { grid: GRID } })).toBe(FULL)
    expect(hit([foe('a'), foe('b')], 'b', { enemyRow: {} })).toBe(FULL)
  })
  it('置けた敵が 0 体なら最前列が決まらず、軽減は効かない', () => {
    expect(hit([foe('a', at(9)), foe('b', at(8))], 'a', { enemyRow: { grid: GRID } })).toBe(FULL)
  })
})

describe('敵の最前列: 静的（倒れても最前列は変わらない） (#896)', () => {
  it('最前列の敵が倒れても、後ろの敵は半分のまま', () => {
    const a = foe('a', { ...at(2), hp: 18 })
    const b = foe('b', at(1))
    const eng = new BattleEngine([hero()], [a, b], { rng: () => 0, enemyRow: { grid: GRID } })
    eng.selectAttack('a')
    expect(a.hp).toBe(0)
    const before = b.hp
    eng.selectAttack('b')
    expect(before - b.hp).toBe(HALF)
  })
})

describe('敵の最前列: 魔法・特技は影響しない / 味方側は不変 (#896)', () => {
  it('呪文のダメージは最前列でなくても減らない', () => {
    const run = (col: number) => {
      const e = [foe('a', at(2)), foe('b', at(col))]
      const eng = new BattleEngine([hero()], e, { rng: () => 0, enemyRow: { grid: GRID } })
      eng.selectSpell({ name: 'ほのお', mp: 1, target: '敵単体', effect: 'damage 30..30' }, 'b')
      return 100 - e[1].hp
    }
    expect(run(0)).toBe(run(2))
    expect(run(0)).toBe(30)
  })
  it('敵の攻撃（敵 → 味方）は変わらない。後衛の味方は従来どおり半分', () => {
    const lost = (opts: ConstructorParameters<typeof BattleEngine>[2]) => {
      const h = hero({ row: 'back', hp: 1000, maxHp: 1000 })
      const e = [foe('a', { atk: 20, ...at(0) }), foe('b', at(2))]
      new BattleEngine([h], e, { rng: () => 0, ...opts }).selectAttack('a')
      return 1000 - h.hp
    }
    // 敵が最前列でなくても与ダメは変わらない（enemyRow の有無で同じ）
    expect(lost({ enemyRow: { grid: GRID } })).toBe(lost({}))
  })
})

describe('敵の最前列: ATB でも同じ (#896)', () => {
  it('ATB の通常攻撃でも最前列でない敵は半分・倒れても最前列は変わらない', () => {
    const a = foe('a', { ...at(1), hp: 18 })
    const b = foe('b', at(0))
    const eng = new BattleEngine([hero()], [a, b], {
      rng: () => 0,
      atb: {},
      enemyRow: { grid: { cols: 2, rows: 1 } },
    })
    const ready = () => {
      for (let i = 0; i < 400 && eng.getState().phase !== 'party-input'; i++) eng.tick(100)
      expect(eng.getState().phase).toBe('party-input')
    }
    ready()
    eng.selectAttack('b')
    expect(b.hp).toBe(100 - HALF)
    ready()
    eng.selectAttack('a')
    expect(a.hp).toBe(0)
    ready()
    const before = b.hp
    eng.selectAttack('b')
    expect(before - b.hp).toBe(HALF)
  })
})
