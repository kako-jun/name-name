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

  it('行動を確定すると停止が解ける（次の味方がコマンド待ちでも時間は進む）', () => {
    const two = {
      atb: { mode: 'wait' as const, initialGauges: { party: [1000, 1000], enemies: [0, 0] } },
      rng: () => 0,
    }
    const { s, engine } = build({}, two, [ent('a'), ent('b')])
    press('ArrowLeft')
    press('Enter')
    press('Enter')
    expect(types(s)).toEqual([])
    expect(engine.getState().atb!.queue).toEqual([1]) // b がコマンド待ち
    const before = engine.getState().atb!.enemyGauge[0]
    s.tick(200)
    expect(engine.getState().atb!.enemyGauge[0]).toBeGreaterThan(before)
  })

  it('destroy で停止範囲を従来（コマンド待ちの間ずっと停止）に戻す', () => {
    const { s, engine } = build({}, ATB)
    press('ArrowLeft')
    s.destroy({ children: true })
    engine.tick(500)
    expect(engine.getState().atb!.enemyGauge[0]).toBe(0)
  })

  it('候補窓を使わない画面を同じエンジンに作り直しても、前の画面の menu 設定を持ち越さない', () => {
    const engine = new BattleEngine([ent('a')], [ent('s1'), ent('s2')], ATB)
    const first = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      commandLayout: 'cross',
      menu: MENU,
    })
    created.push(first)
    first.destroy({ children: true })
    const grid = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      commandLayout: 'grid',
      menu: MENU,
    })
    created.push(grid)
    grid.tick(500)
    expect(engine.getState().atb!.enemyGauge[0]).toBe(0)
  })
})

describe('active: 窓を開いている間に前提が崩れたとき', () => {
  const ACTIVE = {
    atb: { mode: 'active' as const, initialGauges: { party: [1000, 0], enemies: [0, 0] } },
    rng: () => 0,
  }
  const holding = (e: BattleEngine) => (e as unknown as { atbHold: boolean }).atbHold

  it('敵の攻撃で使用者が倒れたら窓が閉じ、停止も解ける', () => {
    const { s, engine } = build(
      {},
      ACTIVE,
      [ent('a', { hp: 1 }), ent('b')],
      [ent('s1', { atk: 50 }), ent('s2')]
    )
    press('ArrowLeft')
    expect(types(s)).toEqual(['list'])
    expect(holding(engine)).toBe(true)
    engine.getState().atb!.enemyGauge[0] = 999
    s.tick(1000) // active は窓を開いていても時間が進み、敵が a を倒す
    expect(engine.getState().party[0].hp).toBe(0)
    expect(types(s)).toEqual([])
    expect(holding(engine)).toBe(false)
  })

  it.each(['dq', 'ff'] as const)(
    '戦闘が終わったら窓が閉じ、停止も解ける（演出 %s。ff は演出を待って画面を畳む間も）',
    (presentation) => {
      const { s, engine } = build({ presentation }, ACTIVE)
      press('ArrowLeft')
      expect(types(s)).toEqual(['list'])
      for (const e of engine.getState().enemies) e.hp = 0
      s.tick(50)
      expect(engine.isOver()).toBe(true)
      expect(types(s)).toEqual([])
      expect(holding(engine)).toBe(false)
    }
  )
})

describe('対象の側の固定とエンジンを通した結果 (#204 レビュー)', () => {
  it('敵単体の呪文は左右キーで味方を指せず、確定で必ず敵に当たって MP とターンを正しく消費する', () => {
    const { s, engine } = build()
    press('ArrowLeft')
    press('Enter') // ほのお（敵単体）
    press('ArrowRight')
    press('ArrowLeft')
    expect(I(s).menuStack[1]).toMatchObject({ side: 'enemy', cursor: 0 })
    press('Enter')
    const st = engine.getState()
    expect(st.party[0].mp).toBe(2)
    expect(st.enemies[0].hp).toBeLessThan(100) // 空撃ちにならない
  })

  it('味方単体の呪文は味方に効く（倒れた味方は指せない）', () => {
    const { engine } = build({}, { rng: () => 0 }, [ent('a', { hp: 30 }), ent('b', { hp: 0 })])
    // a の覚える ヒール(味方単体)は 3 行目。開いたカーソルは最初に選べる行 = 0 なので 2 回下へ
    press('ArrowLeft')
    press('ArrowDown')
    press('ArrowDown')
    press('Enter')
    press('ArrowDown') // 生存者は a だけ = 動かない
    press('Enter')
    expect(engine.getState().party[1].hp).toBe(0)
    expect(engine.getState().party[0].mp).toBe(3)
  })

  it('対象なし（マップ）の呪文は MP が足りていてもグレーで、決定しても唱えない', () => {
    const menu: BattleMenuData = {
      spells: { a: [{ id: 'ruula', name: 'ルーラ', mp: 1, target: 'マップ', builtin: 'ruula' }] },
    }
    const { s, engine } = build({ menu })
    press('ArrowLeft')
    press('Enter')
    expect(types(s)).toEqual(['list'])
    expect(engine.getState().party[0].mp).toBe(5)
    expect(engine.getState().log).toHaveLength(1)
  })

  it('前後に空白のある target でもエンジンと窓の解釈が一致する（全体）', () => {
    const menu: BattleMenuData = {
      spells: {
        a: [{ id: 't', name: 'いなずま', mp: 1, target: ' 敵全体 ', effect: 'damage 5..5' }],
      },
    }
    const { engine } = build({ menu })
    press('ArrowLeft')
    press('Enter')
    press('Enter')
    expect(engine.getState().enemies.every((e) => e.hp === 95)).toBe(true)
  })
})

describe('タップによる一覧のスクロール', () => {
  it('▼の帯のタップで先頭行が進み、見えなかった呪文に届く', () => {
    const many: BattleMenuData = {
      spells: {
        a: Array.from({ length: 30 }, (_, i) => ({
          id: `s${i}`,
          name: `じゅもん${i}`,
          mp: 1,
          target: '敵単体',
          effect: 'damage 1..1',
        })),
      },
    }
    const engine = new BattleEngine([ent('a')], [ent('s1')], { rng: () => 0 })
    const s = new BattleScreen(engine, 320, 240, {
      layout: 'side',
      commandLayout: 'cross',
      menu: many,
    })
    created.push(s)
    press('ArrowLeft')
    const strips = () => {
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
    const top0 = (I(s).menuStack[0] as { top: number }).top
    // 末尾の hit が下スクロール帯
    for (let i = 0; i < 40; i++) {
      const hits = strips()
      hits[hits.length - 1].emit('pointertap', {} as never)
    }
    const w = I(s).menuStack[0] as { top: number; cursor: number }
    expect(w.top).toBeGreaterThan(top0)
    expect(w.cursor).toBeGreaterThanOrEqual(w.top)
    expect(w.top + 1).toBeLessThanOrEqual(30)
  })
})
