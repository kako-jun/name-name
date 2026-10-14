/**
 * BattleScreen の候補窓（窓のスタック・MP 消費とグレー・対象選択・ATB の wait）(#204) のテスト。
 * 実のエンジンに対して、globalThis へ KeyboardEvent を dispatch して検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Container } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine, type BattleEngineOptions } from './battleEngine'
import type { BattleMenuData, MenuStack } from './battleMenu'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 5,
    maxMp: 5,
    atk: 10,
    def: 0,
    agi: 5,
    ...over,
  }
}

const MENU: BattleMenuData = {
  spells: {
    a: [
      { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' },
      { id: 'thunder', name: 'いなずま', mp: 4, target: '敵全体', effect: 'damage 5..5' },
      { id: 'heal', name: 'ヒール', mp: 2, target: '味方単体', effect: 'heal 10..10' },
    ],
  },
  items: [{ id: 'potion', name: 'ポーション', effect: 'heal 20..20', count: 2 }],
}

interface Internals {
  destroyed: boolean
  menuStack: MenuStack
  menuLayer: Container | null
  refresh(): void
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function build(
  opts: BattleScreenOptions = {},
  engineOpts: BattleEngineOptions = { rng: () => 0 },
  party: BattleEntity[] = [ent('a')],
  enemies: BattleEntity[] = [ent('s1'), ent('s2')]
): { s: BattleScreen; engine: BattleEngine } {
  const engine = new BattleEngine(party, enemies, engineOpts)
  const s = new BattleScreen(engine, 800, 450, {
    layout: 'side',
    commandLayout: 'cross',
    menu: MENU,
    ...opts,
  })
  created.push(s)
  return { s, engine }
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  globalThis.dispatchEvent(e)
  return e
}

afterEach(() => {
  for (const s of created.splice(0)) if (!I(s).destroyed) s.destroy({ children: true })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const types = (s: BattleScreen) => I(s).menuStack.map((w) => w.type)

describe('窓のスタックとキャンセル', () => {
  it('←(じゅもん)で一覧が開き、Escape でコマンド窓に戻る。キーの既定動作は止める', () => {
    const { s, engine } = build()
    const e = press('ArrowLeft')
    expect(e.defaultPrevented).toBe(true)
    expect(types(s)).toEqual(['list'])
    expect(engine.getState().log).toHaveLength(1) // 呪文はまだ使っていない
    const esc = press('Escape')
    expect(esc.defaultPrevented).toBe(true)
    expect(types(s)).toEqual([])
  })

  it('一覧 → 対象 と重なり、Escape / Backspace / x で一つずつ戻る', () => {
    const { s } = build()
    press('ArrowLeft')
    press('Enter')
    expect(types(s)).toEqual(['list', 'target'])
    press('Escape')
    expect(types(s)).toEqual(['list'])
    press('Enter')
    press('Backspace')
    expect(types(s)).toEqual(['list'])
    press('Enter')
    press('x')
    expect(types(s)).toEqual(['list'])
    press('Escape')
    expect(types(s)).toEqual([])
  })

  it('窓が開いている間、矢印キーはコマンドの決定には使われない（←でもう一度じゅもんを開き直さない）', () => {
    const { s, engine } = build()
    press('ArrowLeft')
    press('ArrowUp') // 一覧では上 = カーソル移動。たたかうは決定されない
    expect(types(s)).toEqual(['list'])
    expect(engine.getState().log).toHaveLength(1)
  })

  it('窓が開いていないときの Enter / Escape は奪わない', () => {
    build()
    expect(press('Enter').defaultPrevented).toBe(false)
    expect(press('Escape').defaultPrevented).toBe(false)
  })

  it('どうぐ(→)でアイテムの一覧が開き、味方を指して使える', () => {
    const { s, engine } = build(
      {},
      { rng: () => 0 },
      [ent('a', { hp: 50 })],
      [ent('s1', { atk: 0 })]
    )
    press('ArrowRight')
    expect(types(s)).toEqual(['list'])
    press('Enter')
    expect(types(s)).toEqual(['list', 'target'])
    press('Enter')
    expect(types(s)).toEqual([])
    expect(engine.getState().party[0].hp).toBeGreaterThan(50)
  })

  it('表示用のレイヤーが窓の枚数に合わせて出る・消える', () => {
    const { s } = build()
    const layer = I(s).menuLayer!
    expect(layer.visible).toBe(false)
    press('ArrowLeft')
    expect(layer.visible).toBe(true)
    press('Escape')
    expect(layer.visible).toBe(false)
  })
})

describe('MP の消費とグレーアウト', () => {
  it('呪文を確定すると MP を消費して効果が出る（敵単体: 手の位置の敵に当たる）', () => {
    const { s, engine } = build()
    press('ArrowLeft')
    press('Enter') // ほのお
    press('ArrowDown') // s1 → s2
    press('Enter')
    const st = engine.getState()
    expect(st.party[0].mp).toBe(2)
    expect(st.enemies[0].hp).toBe(100)
    expect(st.enemies[1].hp).toBeLessThan(100)
    expect(types(s)).toEqual([])
  })

  it('全体の呪文は対象の全員に当たる', () => {
    const { engine } = build()
    press('ArrowLeft')
    press('ArrowDown') // いなずま
    press('Enter')
    press('Enter')
    const st = engine.getState()
    expect(st.party[0].mp).toBe(1)
    expect(st.enemies.every((e) => e.hp === 95)).toBe(true)
  })

  it('MP が足りない呪文は確定できない。窓は閉じず、MP は減らず、短い言葉がログに出る', () => {
    const { s, engine } = build({}, { rng: () => 0 }, [ent('a', { mp: 2 })])
    press('ArrowLeft')
    // 開いたときのカーソルは最初に選べる行 = ヒール
    expect(I(s).menuStack[0]).toMatchObject({ cursor: 2 })
    press('ArrowDown') // → ほのお（循環）
    press('Enter')
    expect(types(s)).toEqual(['list'])
    expect(engine.getState().party[0].mp).toBe(2)
    expect(engine.getState().log[engine.getState().log.length - 1]).toBe('MP が たりない！')
  })

  it('呪文を使うとターンが進む（従来ターン制では敵が反撃する）', () => {
    const { engine } = build()
    press('ArrowLeft')
    press('Enter')
    press('Enter')
    expect(engine.getState().party[0].hp).toBeLessThan(100)
  })
})

describe('設定で有効化するまで従来どおり', () => {
  it('grid では候補窓は開かない（矢印キーも効かない）', () => {
    const { s } = build({ commandLayout: 'grid' })
    press('ArrowLeft')
    expect(types(s)).toEqual([])
    expect(I(s).menuLayer).toBeNull()
  })

  it('front では候補窓は開かない', () => {
    const { s } = build({ layout: 'front' })
    press('ArrowLeft')
    expect(types(s)).toEqual([])
  })

  it('menu 未指定の cross は従来どおり（じゅもんは何も起きない）', () => {
    const { s, engine } = build({ menu: undefined })
    press('ArrowLeft')
    expect(types(s)).toEqual([])
    expect(engine.getState().party[0].mp).toBe(5)
  })

  it('呪文を覚えていない味方では じゅもん は何も起きない', () => {
    const { s } = build({}, { rng: () => 0 }, [ent('z')])
    press('ArrowLeft')
    expect(types(s)).toEqual([])
  })

  it('destroy 後はキーに反応しない', () => {
    const { s } = build()
    s.destroy({ children: true })
    press('ArrowLeft')
    expect(types(s)).toEqual([])
  })
})

describe('タップ操作', () => {
  function taps(s: BattleScreen): Container[] {
    const out: Container[] = []
    const walk = (c: Container) => {
      for (const ch of c.children as Container[]) {
        if (ch.eventMode === 'static' && ch.hitArea) out.push(ch)
        walk(ch)
      }
    }
    walk(I(s).menuLayer!)
    return out
  }

  it('窓の外(背景)のタップはキャンセル', () => {
    const { s } = build()
    press('ArrowLeft')
    const backdrop = taps(s)[0]
    backdrop.emit('pointertap', {} as never)
    expect(types(s)).toEqual([])
  })

  it('行のタップで決定、対象のタップで確定', () => {
    const { s, engine } = build()
    press('ArrowLeft')
    const rows = taps(s).filter((c) => c.cursor === 'pointer')
    expect(rows).toHaveLength(3)
    rows[0].emit('pointertap', {} as never)
    expect(types(s)).toEqual(['list', 'target'])
    const targets = taps(s).filter((c) => c.cursor === 'pointer')
    expect(targets.length).toBeGreaterThanOrEqual(2)
    targets[1].emit('pointertap', {} as never)
    expect(types(s)).toEqual([])
    expect(engine.getState().party[0].mp).toBe(2)
  })
})

describe('窓を開いたままにできない局面', () => {
  it('番が変わる・行動が済むなどで窓の前提が崩れたら閉じる', () => {
    const { s, engine } = build(
      {},
      { atb: { mode: 'wait', initialGauges: { party: [1000], enemies: [0, 0] } }, rng: () => 0 }
    )
    press('ArrowLeft')
    expect(types(s)).toEqual(['list'])
    engine.selectAttack() // 外から行動が進み、この味方の番が終わった
    I(s).refresh()
    expect(types(s)).toEqual([])
  })
})

describe('ATB の wait: 候補窓を開いている間だけ停止', () => {
  const ATB = {
    atb: { mode: 'wait' as const, initialGauges: { party: [1000], enemies: [0, 0] } },
    rng: () => 0,
  }

  it('コマンド窓だけの間は時間が進み、窓を開いている間は止まり、閉じるとまた進む', () => {
    const { s, engine } = build({}, ATB)
    const gauge = () => engine.getState().atb!.enemyGauge[0]
    s.tick(500)
    const g1 = gauge()
    expect(g1).toBeGreaterThan(0)
    press('ArrowLeft')
    s.tick(500)
    expect(gauge()).toBe(g1)
    press('Enter') // 対象窓でも止まったまま
    s.tick(500)
    expect(gauge()).toBe(g1)
    press('Escape')
    press('Escape')
    s.tick(100)
    expect(gauge()).toBeGreaterThan(g1)
  })

  it('候補窓を使わない構成（grid）の wait は従来どおりコマンド待ちの間ずっと止まる', () => {
    const { engine, s } = build({ commandLayout: 'grid' }, ATB)
    s.tick(500)
    expect(engine.getState().atb!.enemyGauge[0]).toBe(0)
  })

  it('行動を確定すると停止が解ける（窓を閉じたまま残さない）', () => {
    const { s, engine } = build({}, ATB, [ent('a'), ent('b')])
    press('ArrowLeft')
    press('Enter')
    press('Enter')
    expect(types(s)).toEqual([])
    const before = engine.getState().atb!.enemyGauge[0]
    s.tick(200)
    // 次の味方 b はまだゲージが溜まり中で、コマンド待ちがいない = 時間が進む
    expect(engine.getState().atb!.enemyGauge[0]).toBeGreaterThanOrEqual(before)
  })

  it('destroy で停止を解く', () => {
    const { s, engine } = build({}, ATB)
    press('ArrowLeft')
    s.destroy({ children: true })
    engine.tick(500)
    expect(engine.getState().atb!.enemyGauge[0]).toBeGreaterThan(0)
  })
})
