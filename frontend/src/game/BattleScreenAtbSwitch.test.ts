/**
 * BattleScreen の battle_atb_switch (#1195): ATB で満タンの味方が複数いるとき、タップで入力キャラを切り替える。
 * 既定(off)は従来と完全に同じ（タップ受け口を作らない）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import 'pixi.js/events'
import type { Container, Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { skipEntrance } from './battleScreenTestUtil'
import { BattleEngine } from './battleEngine'
import type { BattleMenuData } from './battleMenu'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    atk: 0,
    def: 0,
    agi: 5,
    ...over,
  }
}
const MENU: BattleMenuData = {
  spells: {
    a: [{ id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' }],
    b: [{ id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' }],
  },
  items: [],
}

interface Internals {
  destroyed: boolean
  menuStack: unknown[]
  partyViews: Array<{ container: Container }>
  statusTexts: Text[]
  atbBars: Container[]
  atbMarkers: Text[]
  commands: Array<{ id: string; hit: Container }>
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function build(
  opts: BattleScreenOptions = {},
  gauges = [1000, 1000, 500],
  mode: 'wait' | 'active' = 'wait'
) {
  const party = [ent('a'), ent('b'), ent('c')]
  const engine = new BattleEngine(party, [ent('s')], {
    rng: () => 0,
    atb: { mode, initialGauges: { party: gauges } },
  })
  const s = skipEntrance(
    new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      commandLayout: 'cross',
      menu: structuredClone(MENU),
      ...opts,
    })
  )
  created.push(s)
  return { s, engine }
}
afterEach(() => {
  for (const s of created.splice(0)) if (!I(s).destroyed) s.destroy({ children: true })
})

const tap = (o: Container): void => {
  o.emit('pointertap', {} as never)
}

describe('atbSwitch: タップで入力キャラを切り替える', () => {
  it('off（既定）: 味方・名前・ゲージはタップを受けない（従来）', () => {
    const { s } = build()
    expect(I(s).partyViews[1].container.eventMode).not.toBe('static')
    expect(I(s).statusTexts[1].eventMode).not.toBe('static')
    expect(I(s).atbMarkers[1].visible).toBe(false)
  })

  it('on: 名前・ゲージ・アクスタのどれをタップしても、満タン待機の味方へ番が移る', () => {
    for (const pick of [
      (x: Internals) => x.statusTexts[1],
      (x: Internals) => x.atbBars[1],
      (x: Internals) => x.partyViews[1].container,
    ]) {
      const { s, engine } = build({ atbSwitch: true })
      expect(engine.getCurrentActorIndex()).toBe(0)
      tap(pick(I(s)))
      expect(engine.getCurrentActorIndex()).toBe(1)
      expect(engine.getState().atb!.queue).toEqual([1, 0])
    }
  })

  it('on: 開いている候補窓は閉じ、選択途中のコマンドは捨てられる。コマンドは新しい番の人に効く', () => {
    const { s, engine } = build({ atbSwitch: true })
    const spell = I(s).commands.find((c) => c.id === 'spell')!
    tap(spell.hit)
    expect(I(s).menuStack.length).toBeGreaterThan(0)
    tap(I(s).statusTexts[1])
    expect(I(s).menuStack.length).toBe(0)
    expect(engine.getCurrentActorIndex()).toBe(1)
    tap(I(s).commands.find((c) => c.id === 'attack')!.hit)
    // 行動したのは B。A は満タンのまま次の番
    expect(engine.getState().atb!.partyGauge[1]).toBe(0)
    expect(engine.getCurrentActorIndex()).toBe(0)
  })

  it('on: 番の本人・ゲージ未満タンの味方・倒れた味方のタップは何も起こさない', () => {
    const { s, engine } = build({ atbSwitch: true })
    const q = [...engine.getState().atb!.queue]
    tap(I(s).statusTexts[0])
    tap(I(s).statusTexts[2])
    expect(engine.getState().atb!.queue).toEqual(q)
    expect(engine.getCurrentActorIndex()).toBe(0)
    const dead = new BattleEngine([ent('a'), ent('b', { hp: 0 })], [ent('s')], {
      rng: () => 0,
      atb: { initialGauges: { party: [1000, 1000] } },
    })
    const s2 = skipEntrance(new BattleScreen(dead, 800, 450, { layout: 'side', atbSwitch: true }))
    created.push(s2)
    tap(I(s2).statusTexts[1])
    expect(dead.getCurrentActorIndex()).toBe(0)
  })

  it('on: タップできる味方には ▷（薄い）、番には ▶ が出る', () => {
    const { s, engine } = build({ atbSwitch: true })
    const m = I(s).atbMarkers
    expect([m[0].visible, m[0].text]).toEqual([true, '▶'])
    expect([m[1].visible, m[1].text, m[1].alpha]).toEqual([true, '▷', 0.7])
    expect(m[2].visible).toBe(false) // ゲージ未満タン
    tap(I(s).statusTexts[1])
    expect([m[0].text, m[1].text]).toEqual(['▷', '▶'])
    expect(engine.getCurrentActorIndex()).toBe(1)
  })

  it('on: 切り替え後も ATB は進み続ける（active: 敵のゲージが溜まる）', () => {
    const { s, engine } = build({ atbSwitch: true }, [1000, 1000, 0], 'active')
    tap(I(s).statusTexts[1])
    const g = engine.getState().atb!.enemyGauge[0]
    for (let i = 0; i < 10; i++) s.tick(100)
    expect(engine.getState().atb!.enemyGauge[0]).toBeGreaterThan(g)
  })

  it('ATB でない戦闘では on でも受け口を作らない', () => {
    const engine = new BattleEngine([ent('a'), ent('b')], [ent('s')], { rng: () => 0 })
    const s = skipEntrance(new BattleScreen(engine, 800, 450, { layout: 'side', atbSwitch: true }))
    created.push(s)
    expect(I(s).statusTexts[1].eventMode).not.toBe('static')
  })
})
