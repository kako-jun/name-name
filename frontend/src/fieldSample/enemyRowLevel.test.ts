/**
 * 一枚絵フィールドの設定 JSON から、敵の前列・後列とレベル即死が戦闘エンジンまで通る結合テスト (#1043)。
 * 設定 → parseConfig → buildEnemyEntities → BattleEngine / applyEffect。
 */
import { describe, it, expect } from 'vitest'
import { parseConfig } from './config'
import { buildBattleEngineOptions } from './battleOptions'
import { buildEnemyEntities } from '../game/encounter'
import { BattleEngine } from '../game/battleEngine'
import { applyEffect, parseEffect, type BattleEntity } from '../game/spellDsl'

const BASE = 'https://example.com/field/config.json'

function config(battle: Record<string, unknown> | undefined) {
  const frames = (d: string) => [`${d}1.png`, `${d}2.png`, `${d}3.png`]
  const raw = {
    startScene: 'a',
    start: { x: 1, y: 1 },
    player: {
      sprites: {
        up: frames('u'),
        down: frames('d'),
        left: frames('l'),
        right: frames('r'),
      },
    },
    scenes: { a: { background: 'a.png', mask: 'm.png' } },
    monsters: {
      front: { name: 'まえ', hp: 100, atk: 1, def: 4, formationRow: '前衛', level: 10 },
      back: { name: 'うしろ', hp: 100, atk: 1, def: 4, formationRow: 'back', level: 11 },
      plain: { name: 'ふつう', hp: 100, atk: 1, def: 4 },
    },
    ...(battle ? { battle } : {}),
  }
  const r = parseConfig(raw, BASE)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

const hero = (): BattleEntity => ({
  id: 'hero',
  name: 'ゆうしゃ',
  hp: 9999,
  maxHp: 9999,
  mp: 10,
  maxMp: 10,
  atk: 20,
  def: 4,
  agi: 50,
})

/** 勇者が id の敵を通常攻撃して減った HP（rng 0 で atk20 vs def4 = 18、後列は半減 9） */
function hit(c: ReturnType<typeof config>, id: string): number {
  const enemies = buildEnemyEntities(
    ['front', 'back', 'plain'].map((i) => ({ id: i })),
    c.monsters
  )
  const t = enemies.find((e) => e.id === id)!
  const before = t.hp
  const eng = new BattleEngine([hero()], enemies, {
    rng: () => 0,
    ...buildBattleEngineOptions(c.battle),
  })
  eng.selectAttack(id)
  return before - t.hp
}

describe('設定 → BattleEntity (#1043)', () => {
  it('formationRow / level が BattleEntity に付く。未指定の敵には付かない', () => {
    const c = config(undefined)
    const es = buildEnemyEntities(
      ['front', 'back', 'plain'].map((id) => ({ id })),
      c.monsters
    )
    const by = (id: string) => es.find((e) => e.id === id)!
    expect([by('front').formationRow, by('front').level]).toEqual(['front', 10])
    expect([by('back').formationRow, by('back').level]).toEqual(['back', 11])
    expect('formationRow' in by('plain')).toBe(false)
    expect('level' in by('plain')).toBe(false)
  })
})

describe('enemyRow による後列の軽減 (#1043)', () => {
  it('on: 後列は前列の半分のダメージ', () => {
    const c = config({ layout: 'side', enemyRow: 'on' })
    expect(hit(c, 'front')).toBe(18)
    expect(hit(c, 'back')).toBe(9)
  })
  it('off・未指定: 隊列を書いても差が出ない', () => {
    for (const c of [config({ layout: 'side', enemyRow: 'off' }), config(undefined)]) {
      expect(hit(c, 'front')).toBe(18)
      expect(hit(c, 'back')).toBe(18)
    }
  })
  it('front レイアウトでは on でも差が出ない', () => {
    const c = config({ layout: 'front', enemyRow: 'on' })
    expect(hit(c, 'back')).toBe(18)
  })
})

describe('レベル条件の即死 (#898 / #1043)', () => {
  it('level を持つ敵には効き、level 未指定の敵には効かない', () => {
    const c = config(undefined)
    const es = buildEnemyEntities(
      ['front', 'back', 'plain'].map((id) => ({ id })),
      c.monsters
    )
    const e = parseEffect('damage_full レベル倍数=5')!
    const run = (id: string) => {
      const t = es.find((x) => x.id === id)!
      applyEffect(e, { caster: hero(), targets: [t], rng: () => 0.5 })
      return t.hp
    }
    expect(run('front')).toBe(0) // Lv10 は 5 の倍数
    expect(run('back')).toBe(100) // Lv11 は倍数でない
    expect(run('plain')).toBe(100) // level なしは効かない
  })
})
