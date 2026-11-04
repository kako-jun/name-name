import { describe, it, expect, vi, afterEach } from 'vitest'
import { BattleEngine, computeRowAttackDamage } from './battleEngine'
import type { BattleEntity, EnemyLayout } from './spellDsl'
import type { EnemyGridSize } from './enemyGrid'

/** 敵の前列・後列 (#896)。atk 20 vs def 4・rng 0 の通常攻撃は 18（前列）/ 9（後列）。 */
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

describe('敵の前列・後列: off では何も変わらない (#896)', () => {
  it('enemyRow を渡さなければ、隊列の宣言・グリッドの位置があっても全員 18', () => {
    for (const id of ['a', 'b']) {
      const es = [
        foe('a', { ...at(2), formationRow: 'front' }),
        foe('b', { ...at(0), formationRow: 'back' }),
      ]
      expect(hit(es, id)).toBe(FULL)
    }
  })
  it('off では乱数の消費も同じ（通常攻撃 1 回で rng 1 回）', () => {
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

describe('敵の前列・後列: 隊列の宣言 (#896)', () => {
  it('formationRow: back の敵は半分、front・未指定は等倍', () => {
    const es = () => [
      foe('a', { formationRow: 'back' }),
      foe('b', { formationRow: 'front' }),
      foe('c'),
    ]
    expect(hit(es(), 'a', { enemyRow: {} })).toBe(HALF)
    expect(hit(es(), 'b', { enemyRow: {} })).toBe(FULL)
    expect(hit(es(), 'c', { enemyRow: {} })).toBe(FULL)
  })
  it('グリッドなし・宣言なしの敵は全員前列（軽減なし）', () => {
    const es = () => [foe('a'), foe('b')]
    expect(hit(es(), 'a', { enemyRow: {} })).toBe(FULL)
    expect(hit(es(), 'b', { enemyRow: {} })).toBe(FULL)
  })
  it('宣言はグリッドの位置より優先する（右端でも後衛、左端でも前衛）', () => {
    const es = () => [
      foe('a', { ...at(2), formationRow: 'back' }),
      foe('b', { ...at(0), formationRow: 'front' }),
    ]
    expect(hit(es(), 'a', { enemyRow: { grid: GRID } })).toBe(HALF)
    expect(hit(es(), 'b', { enemyRow: { grid: GRID } })).toBe(FULL)
  })
  it('最低ダメージは 1（端数は切り捨て・最低 1）', () => {
    const e = foe('a', { formationRow: 'back', def: 100 })
    expect(hit([e], 'a', { enemyRow: {} })).toBe(1)
  })
})

describe('敵の前列・後列: グリッドから導出 (#896)', () => {
  const es = () => [foe('a', at(2)), foe('b', at(1)), foe('c', at(0))]
  it('最も手前（右）の列が前列、他は後列', () => {
    const opt = { enemyRow: { grid: GRID } }
    expect(hit(es(), 'a', opt)).toBe(FULL)
    expect(hit(es(), 'b', opt)).toBe(HALF)
    expect(hit(es(), 'c', opt)).toBe(HALF)
  })
  it('同じ列の上下の敵はどちらも前列', () => {
    const e = [foe('a', at(2, 0)), foe('b', at(2, 1)), foe('c', at(0))]
    const opt = { enemyRow: { grid: GRID } }
    expect(hit(e, 'a', opt)).toBe(FULL)
    expect(hit(e, 'b', opt)).toBe(FULL)
    expect(hit(e, 'c', opt)).toBe(HALF)
  })
  it('配置指定が無い敵は自動配置（手前の列から）で導出する', () => {
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
    // w は列 0〜1（右端 1）、s は列 2 → s が前列・w は後列
    expect(hit(e, 's', opt)).toBe(FULL)
    expect(hit([wide, foe('s', at(2, 1))], 'w', opt)).toBe(HALF)
  })
  it('隊列を宣言した敵は「最も手前の列」の判定に加えない', () => {
    // a は右端だが後衛と宣言。b（列 1）が生存者の中の最前列
    const e = [foe('a', { ...at(2), formationRow: 'back' }), foe('b', at(1)), foe('c', at(0))]
    const opt = { enemyRow: { grid: GRID } }
    expect(hit(e, 'b', opt)).toBe(FULL)
    expect(hit(e, 'c', opt)).toBe(HALF)
  })
  it('グリッドに収まらない敵（置けない）は導出できず前列のまま', () => {
    const e = [foe('a', at(2)), foe('b', at(9)), foe('c', at(0))]
    expect(hit(e, 'b', { enemyRow: { grid: GRID } })).toBe(FULL)
  })
})

describe('敵の前列・後列: 倒れたら繰り上がる (#896)', () => {
  it('最前列を倒すと次の列が前列になり、等倍で通る', () => {
    const a = foe('a', { ...at(2), hp: 18 })
    const b = foe('b', at(1))
    const c = foe('c', at(0))
    const eng = new BattleEngine([hero()], [a, b, c], { rng: () => 0, enemyRow: { grid: GRID } })
    // 前: b は後列（9）
    eng.selectAttack('b')
    expect(b.hp).toBe(100 - HALF)
    // a を倒す（18 ちょうど）
    eng.selectAttack('a')
    expect(a.hp).toBe(0)
    // 繰り上がり: b が前列（18）、c はまだ後列（9）
    const bBefore = b.hp
    eng.selectAttack('b')
    expect(bBefore - b.hp).toBe(FULL)
    const cBefore = c.hp
    eng.selectAttack('c')
    expect(cBefore - c.hp).toBe(HALF)
  })
  it('1 列に複数体いるとき、1 体倒れても同じ列の生存者がいる間は繰り上がらない', () => {
    const a1 = foe('a1', { ...at(2, 0), hp: 18 })
    const a2 = foe('a2', at(2, 1))
    const b = foe('b', at(1))
    const eng = new BattleEngine([hero()], [a1, a2, b], {
      rng: () => 0,
      enemyRow: { grid: GRID },
    })
    eng.selectAttack('a1')
    expect(a1.hp).toBe(0)
    const before = b.hp
    eng.selectAttack('b')
    expect(before - b.hp).toBe(HALF)
  })
})

describe('敵の前列・後列: 魔法・特技は影響しない / 味方側は不変 (#896)', () => {
  it('呪文のダメージは後列でも減らない', () => {
    const run = (row: 'front' | 'back') => {
      const e = foe('a', { formationRow: row })
      const eng = new BattleEngine([hero()], [e], { rng: () => 0, enemyRow: {} })
      eng.selectSpell({ name: 'ほのお', mp: 1, target: '敵単体', effect: 'damage 30..30' }, 'a')
      return 100 - e.hp
    }
    expect(run('back')).toBe(run('front'))
    expect(run('back')).toBe(30)
  })
  it('敵の攻撃（敵 → 味方）は有効でも変わらない。後衛の味方は従来どおり半分', () => {
    const h = hero({ row: 'back', hp: 1000, maxHp: 1000 })
    const e = foe('a', { atk: 20, formationRow: 'back' })
    const eng = new BattleEngine([h], [e], { rng: () => 0, enemyRow: {} })
    eng.selectAttack('a')
    // 敵 atk 20 vs 味方 def 4 → 18、味方が後衛で半分 = 9。敵自身が後衛でも与ダメは変わらない
    expect(1000 - h.hp).toBe(HALF)
  })
})

describe('敵の前列・後列: ATB でも同じ (#896)', () => {
  it('ATB の通常攻撃でも後列は半分・繰り上がりも効く', () => {
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
    expect(before - b.hp).toBe(FULL)
  })
})
