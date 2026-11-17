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
  menuStack: Array<{ type: string }>
  partyViews: Array<{ container: Container }>
  statusTexts: Text[]
  atbBars: Container[]
  atbMarkers: Text[]
  commands: Array<{ id: string; hit: Container }>
  menuLayer: { backdrop: Container } | null
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

  it('on: 窓の外（backdrop）へのタップが切り替え可能な味方の上なら、キャンセルでなく番の切り替え。それ以外はキャンセル', () => {
    const { s, engine } = build({ atbSwitch: true })
    const open = () => tap(I(s).commands.find((c) => c.id === 'spell')!.hit)
    const backdropTap = (x: number, y: number) =>
      I(s).menuLayer!.backdrop.emit('pointertap', { global: { x, y } } as never)
    // jsdom では Text の実測ができないので、各部品の当たり判定を固定の矩形に差し替える（味方 i は x = 100*i 〜 +50）
    const rect = (i: number) => ({ containsPoint: (x: number) => x >= i * 100 && x < i * 100 + 50 })
    const parts = (i: number) => [
      I(s).partyViews[i].container,
      I(s).statusTexts[i],
      I(s).atbBars[i],
    ]
    for (let i = 0; i < 3; i++)
      for (const o of parts(i))
        (o as unknown as { getBounds: () => unknown }).getBounds = () => rect(i)
    open()
    expect(I(s).menuStack.length).toBeGreaterThan(0)
    // ゲージ未満タンの味方(C)の上: 切り替えず、通常のキャンセル
    backdropTap(210, 0)
    expect(I(s).menuStack.length).toBe(0)
    expect(engine.getCurrentActorIndex()).toBe(0)
    open()
    backdropTap(110, 0)
    expect(I(s).menuStack.length).toBe(0)
    expect(engine.getCurrentActorIndex()).toBe(1)
  })

  it('on: 対象選択の窓が開いている間は、味方のタップで番を切り替えない（窓の外のタップは従来どおりキャンセル）', () => {
    const { s, engine } = build({ atbSwitch: true })
    tap(I(s).commands.find((c) => c.id === 'spell')!.hit)
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(I(s).menuStack[I(s).menuStack.length - 1].type).toBe('target')
    const q = [...engine.getState().atb!.queue]
    tap(I(s).statusTexts[1])
    tap(I(s).partyViews[1].container)
    tap(I(s).atbBars[1])
    expect(engine.getState().atb!.queue).toEqual(q)
    expect(I(s).menuStack[I(s).menuStack.length - 1].type).toBe('target')
    // 窓の外（backdrop）のタップは、切り替え可能な味方の上でもキャンセル（番は変わらない）
    const rect = { containsPoint: () => true }
    for (const o of [I(s).partyViews[1].container, I(s).statusTexts[1], I(s).atbBars[1]])
      (o as unknown as { getBounds: () => unknown }).getBounds = () => rect
    I(s).menuLayer!.backdrop.emit('pointertap', { global: { x: 1, y: 1 } } as never)
    expect(I(s).menuStack.length).toBe(1)
    expect(engine.getCurrentActorIndex()).toBe(0)
  })

  it('on: 満タン3人で続けて切り替えると待ち行列は [0,1,2]→[2,0,1]→[1,2,0]', () => {
    const { s, engine } = build({ atbSwitch: true }, [1000, 1000, 1000])
    expect(engine.getState().atb!.queue).toEqual([0, 1, 2])
    tap(I(s).statusTexts[2])
    expect(engine.getState().atb!.queue).toEqual([2, 0, 1])
    tap(I(s).statusTexts[1])
    expect(engine.getState().atb!.queue).toEqual([1, 2, 0])
    expect(engine.getCurrentActorIndex()).toBe(1)
  })

  it('on: wait で候補窓を開いている間は時間が止まり、切り替えで窓が閉じると時間が再び進む', () => {
    const { s, engine } = build({ atbSwitch: true }, [1000, 1000, 500])
    tap(I(s).commands.find((c) => c.id === 'spell')!.hit)
    const g = engine.getState().atb!.partyGauge[2]
    for (let i = 0; i < 5; i++) s.tick(100)
    expect(engine.getState().atb!.partyGauge[2]).toBe(g) // 窓を開いている間は止まる
    tap(I(s).statusTexts[1])
    expect(I(s).menuStack.length).toBe(0)
    // 候補窓が閉じて hold が解けると、待機中でも「コマンド窓だけ」の間は時間が進む
    for (let i = 0; i < 5; i++) s.tick(100)
    expect(engine.getState().atb!.partyGauge[2]).toBeGreaterThan(g)
  })

  it('front（前列並び）では受け口を作らない', () => {
    const engine = new BattleEngine([ent('a'), ent('b')], [ent('s')], {
      rng: () => 0,
      atb: { initialGauges: { party: [1000, 1000] } },
    })
    const s = skipEntrance(new BattleScreen(engine, 800, 450, { layout: 'front', atbSwitch: true }))
    created.push(s)
    expect(I(s).partyViews.length).toBe(0)
    expect(I(s).statusTexts.length).toBe(0)
    expect(I(s).atbBars.every((b) => b.eventMode !== 'static')).toBe(true)
  })

  it('on: カーソルは切り替えできる味方の上だけ pointer、▷ は薄くせず色で区別する', () => {
    const { s } = build({ atbSwitch: true })
    expect(I(s).statusTexts[1].cursor).toBe('pointer')
    expect(I(s).statusTexts[0].cursor).toBe('auto') // 番の本人
    expect(I(s).statusTexts[2].cursor).toBe('auto') // ゲージ未満タン
    expect(I(s).atbMarkers[1].alpha).toBe(1)
    expect(I(s).atbMarkers[1].style.fill).not.toBe(I(s).atbMarkers[0].style.fill)
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

  it('on: タップできる味方には ▷（色と太さで区別）、番には ▶ が出る', () => {
    const { s, engine } = build({ atbSwitch: true })
    const m = I(s).atbMarkers
    expect([m[0].visible, m[0].text]).toEqual([true, '▶'])
    expect([m[1].visible, m[1].text, m[1].alpha]).toEqual([true, '▷', 1])
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
