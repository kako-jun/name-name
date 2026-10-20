/** 戦闘画面サンプルの設定 JSON の `statuses` (#870) */
import { describe, it, expect } from 'vitest'
import statusSample from '../../public/battle-sample/status-effects.json?raw'
import {
  buildBattleSetup,
  defaultConfig,
  initialView,
  parseConfig,
  parseConfigText,
} from './config'
import { BattleEngine } from '../game/battleEngine'

const BASE = 'https://example.com/dir/x.json'

describe('statuses の読み込み', () => {
  it('省略は空。既定の設定にも空で入る', () => {
    const r = parseConfig({}, BASE)
    expect(r.ok && r.value.statuses).toEqual({})
    expect(defaultConfig().statuses).toEqual({})
  })

  it('id をキーにした StatusDef になる。name 省略は id、duration は数値でも書ける、空文字は未指定', () => {
    const r = parseConfig(
      {
        statuses: [
          { id: ' poison ', name: 'どく', duration: 5, tickDamage: '1/16' },
          { id: 'sleep', action: '不能', cure: '被ダメージ', reverse: '' },
        ],
      },
      BASE
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.statuses).toEqual({
      poison: { id: 'poison', name: 'どく', duration: '5', tickDamage: '1/16' },
      sleep: { id: 'sleep', name: 'sleep', action: '不能', cure: '被ダメージ' },
    })
  })

  it.each([
    [{ statuses: {} }, 'statuses は配列'],
    [{ statuses: [1] }, 'statuses[0] はオブジェクト'],
    [{ statuses: [{}] }, 'statuses[0].id'],
    [{ statuses: [{ id: '  ' }] }, 'statuses[0].id'],
    [{ statuses: [{ id: 'a', tickDamage: 5 }] }, 'statuses[0].tickDamage は文字列'],
    [{ statuses: [{ id: 'a', action: true }] }, 'statuses[0].action は文字列'],
    [{ statuses: [{ id: 'a', duration: [] }] }, 'statuses[0].duration は文字列'],
  ])('不正な形はエラー %j', (raw, msg) => {
    const r = parseConfig(raw, BASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })

  it('buildBattleSetup が statuses をそのまま渡し、エンジンで働く', () => {
    const r = parseConfig(
      {
        statuses: [{ id: 'poison', name: 'どく', duration: '3', tickDamage: '7' }],
        party: [{ hp: 100, atk: 0 }],
        enemies: [{ hp: 999, atk: 0 }],
      },
      BASE
    )
    if (!r.ok) throw new Error(r.error)
    const setup = buildBattleSetup(r.value, initialView(r.value))
    expect(Object.keys(setup.statuses)).toEqual(['poison'])
    setup.party[0].status = { poison: 2 }
    const engine = new BattleEngine(setup.party, setup.enemies, {
      rng: () => 0,
      statuses: setup.statuses,
    })
    engine.selectAttack()
    expect(engine.getState().events.some((e) => e.kind === 'status')).toBe(true)
  })
})

describe('同梱の例 public/battle-sample/status-effects.json (#870)', () => {
  it('parseConfigText で読め、状態 5 種・状態を付ける呪文と特技・メテオが入っている', () => {
    const r = parseConfigText(statusSample, 'https://example.com/battle-sample/status-effects.json')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.value.statuses)).toEqual([
      'poison',
      'sleep',
      'confusion',
      'zombie',
      'doom',
    ])
    expect(r.value.spells.map((s) => s.id)).toContain('undead')
    expect(Object.keys(r.value.skills)).toContain('meteor')
  })

  it('例のゾンビ + メテオ: ゾンビになった味方は全滅級の攻撃で回復し、ならなかった味方は倒れる', () => {
    const r = parseConfigText(statusSample, 'https://example.com/battle-sample/status-effects.json')
    if (!r.ok) throw new Error(r.error)
    const setup = buildBattleSetup(r.value, initialView(r.value))
    const [hero, mage] = setup.party
    hero.status = { zombie: 6 }
    hero.hp = 100
    // ボスは meteor だけを使う
    setup.enemies[0].actions = ['候補=meteor']
    const engine = new BattleEngine(setup.party, setup.enemies, {
      rng: () => 0,
      skills: setup.skills,
      statuses: setup.statuses,
    })
    engine.selectAttack()
    // メテオで 9999 回復して最大 HP で止まり、そのあとこあくまの通常攻撃を受けた分だけ減る
    expect(hero.hp).toBeGreaterThan(300)
    expect(hero.hp).toBeLessThanOrEqual(hero.maxHp)
    expect(mage.hp).toBe(0)
  })
})
