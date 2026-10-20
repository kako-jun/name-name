/**
 * BattleScreen の候補窓（窓のスタック・MP 消費とグレー・対象選択・ATB の wait）(#204) のテスト。
 * 実のエンジンに対して、globalThis へ KeyboardEvent を dispatch して検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
// Container に eventMode / isInteractive を足す（実アプリでは Application がイベントシステムを登録する）
import 'pixi.js/events'
import { EventBoundary, Graphics, Sprite, Texture, TextureSource, type Container } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine, type BattleEngineOptions } from './battleEngine'
import { buildMenuRows, type BattleMenuData, type MenuStack } from './battleMenu'
import { RESULT_SKIP_GUARD_MS } from './battleResult'
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
    menu: structuredClone(MENU),
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
    expect(engine.getState().log[engine.getState().log.length - 1]).toBe('MPが たりない！')
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
      menu: structuredClone(MENU),
    })
    created.push(first)
    first.destroy({ children: true })
    const grid = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      commandLayout: 'grid',
      menu: structuredClone(MENU),
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

describe('蘇生をエンジンまで通す (#204 レビュー)', () => {
  const REVIVE: BattleMenuData = {
    spells: {
      a: [{ id: 'raise', name: 'レイズ', mp: 3, target: '味方単体', effect: 'revive hp=half' }],
    },
    items: [{ id: 'drop', name: 'しずく', effect: 'revive', count: 1 }],
  }

  it('倒れた味方に蘇生の呪文を使うと生き返り、MP を消費する（生きている味方は指せない）', () => {
    const { engine } = build({ menu: structuredClone(REVIVE) }, { rng: () => 0 }, [
      ent('a'),
      ent('b', { hp: 0 }),
    ])
    press('ArrowLeft')
    press('Enter') // 対象は倒れた b のみ
    press('ArrowDown') // 候補が 1 人なので動かない
    press('Enter')
    const st = engine.getState()
    expect(st.party[1].hp).toBeGreaterThan(0)
    expect(st.party[0].mp).toBe(2)
  })

  it('倒れた味方に蘇生のアイテムを使うと生き返る', () => {
    const { engine } = build({ menu: structuredClone(REVIVE) }, { rng: () => 0 }, [
      ent('a'),
      ent('b', { hp: 0 }),
    ])
    press('ArrowRight')
    press('Enter')
    press('Enter')
    expect(engine.getState().party[1].hp).toBeGreaterThan(0)
  })

  it('蘇生の対象窓では、候補の倒れた味方にだけ ▼ が出る（生きている味方・窓を閉じたあとは出ない） (#805)', () => {
    const { s } = build({ menu: structuredClone(REVIVE) }, { rng: () => 0 }, [
      ent('a'),
      ent('b', { hp: 0 }),
    ])
    const marks = () =>
      (s as unknown as { partyViews: Array<{ selectMark: { visible: boolean } }> }).partyViews.map(
        (x) => x.selectMark.visible
      )
    press('ArrowLeft')
    press('Enter')
    expect(marks()).toEqual([false, true])
    press('Escape')
    press('Escape')
    expect(marks()).toEqual([false, false])
  })

  it('蘇生できる相手がいないときは確定できず、窓は残り、MP は減らない', () => {
    const { s, engine } = build({ menu: structuredClone(REVIVE) })
    press('ArrowLeft')
    press('Enter')
    expect(types(s)).toEqual(['list'])
    expect(engine.getState().party[0].mp).toBe(5)
    press('Escape')
    press('ArrowRight')
    press('Enter')
    expect(types(s)).toEqual(['list'])
  })
})

describe('手・スクロール記号の上のタップ (#204 レビュー B1 / S-1)', () => {
  // 本物の PixiJS の当たり判定（EventBoundary）で、座標のタップがどの判定に届くかを見る
  const many: BattleMenuData = {
    spells: {
      a: Array.from({ length: 12 }, (_, i) => ({
        id: `s${i}`,
        name: `じゅもん${i}`,
        mp: 1,
        target: '敵単体',
        effect: 'damage 1..1',
      })),
    },
  }
  interface Geo {
    menuGeometry: import('./battleMenuLayout').MenuGeometry
    menuContext(): import('./battleMenu').MenuContext
  }
  async function listView(s: BattleScreen) {
    const { buildMenuView } = await import('./battleMenuLayout')
    const g = s as unknown as Geo
    const v = buildMenuView(I(s).menuStack, g.menuContext(), g.menuGeometry)[0]
    if (v.type !== 'list') throw new Error('list expected')
    return v
  }
  const topOf = (s: BattleScreen) => I(s).menuStack[0] as { top: number; cursor: number }

  it('▲▼の記号の上のタップは、下のスクロール帯に届く', async () => {
    const { s } = build({ menu: many })
    press('ArrowLeft')
    const v = await listView(s)
    const before = topOf(s).top
    // ▼ は下の帯の中（窓の右端寄り・帯の高さの範囲）に描かれる
    const x = v.rect.x + v.rect.w - 12 - 3
    const y = v.rect.y + v.rect.h - 4 - 3
    const hit = new EventBoundary(I(s).menuLayer!).hitTest(x, y)
    expect(hit).not.toBeNull()
    expect(hit!.hitArea!.contains(x, y)).toBe(true)
    hit!.emit('pointertap', {} as never)
    expect(topOf(s).top).toBe(before + 1)
  })

  it('手と同じ x 座標でも、手の外でも、タップした行（別の行）が決定される', async () => {
    for (const dx of [20 - 16, 100 - 16]) {
      const { s } = build({ menu: many })
      press('ArrowLeft')
      const v = await listView(s)
      const row = v.rows[1]
      const x = v.rect.x + dx
      const y = row.rect.y + row.rect.h / 2
      const hit = new EventBoundary(I(s).menuLayer!).hitTest(x, y)
      expect(hit).not.toBeNull()
      hit!.emit('pointertap', {} as never)
      // 手は選択中の行（0 行目）にあるが、タップした行（1 行目）が決定されて対象選択に進む
      expect(types(s)).toEqual(['list', 'target'])
      expect(topOf(s).cursor).toBe(row.index)
      s.destroy({ children: true })
    }
  })

  it('選択中の行そのものの手の上をタップしても、その行の決定になる', async () => {
    const { s } = build({ menu: many })
    press('ArrowLeft')
    const v = await listView(s)
    const hand = v.hand!
    const hit = new EventBoundary(I(s).menuLayer!).hitTest(hand.x + 4, hand.y + 4)
    expect(hit).not.toBeNull()
    hit!.emit('pointertap', {} as never)
    expect(types(s)).toEqual(['list', 'target'])
    expect(topOf(s).cursor).toBe(v.rows.find((r) => r.selected)!.index)
  })
})

describe('勝敗の待機 (#820) との干渉', () => {
  const ACTIVE = {
    atb: { mode: 'active' as const, initialGauges: { party: [1000, 0], enemies: [0, 0] } },
    rng: () => 0,
  }
  interface Hold {
    resultElapsed: number | null
    resultTapArmed: boolean
    hitArea: unknown
    eventMode: string
  }
  const H = (s: BattleScreen) => s as unknown as Hold

  it('通常時はタップ受け口（全画面 hitArea）を持たず、候補窓のタップを妨げない', () => {
    const { s, engine } = build({}, ACTIVE)
    press('ArrowLeft')
    expect(H(s).resultTapArmed).toBe(false)
    expect(H(s).hitArea).toBeFalsy()
    expect(H(s).eventMode).not.toBe('static')
    // 行のタップがそのまま決定として届く
    const rows: Container[] = []
    const walk = (c: Container) => {
      for (const ch of c.children as Container[]) {
        if (ch.eventMode === 'static' && ch.hitArea && ch.cursor === 'pointer') rows.push(ch)
        walk(ch)
      }
    }
    walk(I(s).menuLayer!)
    rows[0].emit('pointertap', {} as never)
    expect(types(s)).toEqual(['list', 'target'])
    expect(engine.isOver()).toBe(false)
  })

  it('勝敗が確定したら窓が閉じて待機に入り、待機中は候補窓が開かない。猶予を過ぎれば Enter / Z で待機が飛んで閉じる', () => {
    const closed: string[] = []
    const { s, engine } = build({ onClose: (o) => closed.push(o) }, ACTIVE)
    press('ArrowLeft')
    press('Enter') // 対象選択まで進めておく
    expect(types(s)).toEqual(['list', 'target'])
    for (const e of engine.getState().enemies) e.hp = 0
    s.tick(50)
    expect(engine.isOver()).toBe(true)
    expect(types(s)).toEqual([])
    expect(H(s).resultElapsed).not.toBeNull() // 待機に入った
    expect(H(s).resultTapArmed).toBe(true)
    const mp = engine.getState().party[0].mp
    press('ArrowLeft') // 待機中はコマンドを受けず、窓も開かない
    expect(types(s)).toEqual([])
    expect(engine.getState().party[0].mp).toBe(mp)
    expect(I(s).menuLayer!.visible).toBe(false)
    expect(closed).toEqual([]) // まだ待機の途中
    s.tick(RESULT_SKIP_GUARD_MS + 10) // 猶予を過ぎる（待機の長さ RESULT_HOLD_DQ_MS よりは短い）
    expect(closed).toEqual([])
    press('Enter')
    expect(closed).toEqual(['victory']) // 待機が飛んだ
  })

  it('窓の決定(Enter)で最後の敵を倒したとき、その同じ Enter では待機は飛ばない', () => {
    const closed: string[] = []
    const { s, engine } = build(
      { onClose: (o) => closed.push(o) },
      ACTIVE,
      [ent('a'), ent('b')],
      [ent('s1', { hp: 1, maxHp: 1 })]
    )
    press('ArrowLeft')
    press('Enter') // ほのお → 対象選択
    press('Enter') // 敵を倒す（同じ Enter キーの連打で待機に入る）
    expect(engine.isOver()).toBe(true)
    expect(H(s).resultElapsed).toBe(0)
    expect(closed).toEqual([]) // 勝利を読ませる待機が始まっただけで、閉じていない
    press('Enter') // 猶予内の Enter も飛ばさない
    expect(closed).toEqual([])
  })
})

describe('窓の右端と味方ステータス欄の HP 列 (#204 レビュー)', () => {
  it('BattleScreen は HP 列の左を avoidX として渡し、窓の右端がそれを越えない（360x640）', async () => {
    const { computeListWindowRect } = await import('./battleMenuLayout')
    const engine = new BattleEngine([ent('a')], [ent('s1')], { rng: () => 0 })
    const s = new BattleScreen(engine, 360, 640, {
      layout: 'side',
      commandLayout: 'cross',
      menu: structuredClone(MENU),
    })
    created.push(s)
    const geo = (s as unknown as { menuGeometry: import('./battleMenuLayout').MenuGeometry })
      .menuGeometry
    expect(geo.avoidX).toBeGreaterThan(geo.command.x + geo.command.w)
    const r = computeListWindowRect(geo, [
      { label: 'ながいなまえのじゅもん', cost: '123', disabled: false },
    ]).rect
    expect(r.x + r.w).toBeLessThanOrEqual(geo.avoidX! + 0.001)
  })
})

describe('対象選択の「選択中」の印 ▼ (#805)', () => {
  interface MarkViews {
    partyViews: Array<{ selectMark: { visible: boolean } }>
    enemyViews: Array<{ selectMark: { visible: boolean } }>
  }
  const marks = (s: BattleScreen) => {
    const v = s as unknown as MarkViews
    return {
      party: v.partyViews.map((x) => x.selectMark.visible),
      enemy: v.enemyViews.map((x) => x.selectMark.visible),
    }
  }
  const SPELLS: BattleMenuData = {
    spells: {
      a: [
        { id: 'fire', name: 'ほのお', mp: 1, target: '敵単体', effect: 'damage 8..14' },
        { id: 'thunder', name: 'いなずま', mp: 1, target: '敵全体', effect: 'damage 5..5' },
        { id: 'heal', name: 'ヒール', mp: 1, target: '味方単体', effect: 'heal 10..10' },
        { id: 'allheal', name: 'ベホマラー', mp: 1, target: '味方全体', effect: 'heal 10..10' },
        { id: 'self', name: 'セルフ', mp: 1, target: '自分', effect: 'heal 10..10' },
      ],
    },
  }
  /** i 番目の呪文の対象窓を開く */
  const openTarget = (i: number) => {
    press('ArrowLeft')
    for (let k = 0; k < i; k++) press('ArrowDown')
    press('Enter')
  }
  const team = () => [ent('a'), ent('b'), ent('c')]
  const foes = () => [ent('s1'), ent('s2')]

  it('窓を開く前は ATB でなければどこにも出ない', () => {
    const { s } = build({ menu: SPELLS }, { rng: () => 0 }, team(), foes())
    expect(marks(s)).toEqual({ party: [false, false, false], enemy: [false, false] })
    press('ArrowLeft')
    expect(marks(s)).toEqual({ party: [false, false, false], enemy: [false, false] })
  })

  it('敵単体: 手の指す敵だけに出て、↑↓で移り、Escape で消える', () => {
    const { s } = build({ menu: SPELLS }, { rng: () => 0 }, team(), foes())
    openTarget(0)
    expect(marks(s)).toEqual({ party: [false, false, false], enemy: [true, false] })
    press('ArrowDown')
    expect(marks(s).enemy).toEqual([false, true])
    press('ArrowUp')
    expect(marks(s).enemy).toEqual([true, false])
    press('Escape')
    expect(marks(s)).toEqual({ party: [false, false, false], enemy: [false, false] })
  })

  it('敵単体: 倒れた敵は候補から外れ、印も出ない', () => {
    const { s } = build({ menu: SPELLS }, { rng: () => 0 }, team(), [
      ent('s1', { hp: 0 }),
      ent('s2'),
    ])
    openTarget(0)
    expect(marks(s).enemy).toEqual([false, true])
  })

  it('敵全体: 生きている敵の全員に出る（倒れた敵には出ない）', () => {
    const { s } = build({ menu: SPELLS }, { rng: () => 0 }, team(), [
      ent('s1'),
      ent('s2', { hp: 0 }),
      ent('s3'),
    ])
    openTarget(1)
    expect(marks(s)).toEqual({ party: [false, false, false], enemy: [true, false, true] })
  })

  it('味方単体: 指された味方だけに出て、↑↓で移る。倒れた味方は飛ばす', () => {
    const { s } = build(
      { menu: SPELLS },
      { rng: () => 0 },
      [ent('a'), ent('b', { hp: 0 }), ent('c')],
      foes()
    )
    openTarget(2)
    const first = marks(s).party.indexOf(true)
    expect(marks(s).party.filter(Boolean)).toHaveLength(1)
    expect(marks(s).enemy).toEqual([false, false])
    press('ArrowDown')
    const second = marks(s).party.indexOf(true)
    expect(second).not.toBe(first)
    expect(marks(s).party[1]).toBe(false) // 倒れた b
    expect(marks(s).party.filter(Boolean)).toHaveLength(1)
  })

  it('味方全体: 生きている味方の全員に出る', () => {
    const { s } = build(
      { menu: SPELLS },
      { rng: () => 0 },
      [ent('a'), ent('b', { hp: 0 }), ent('c')],
      foes()
    )
    openTarget(3)
    expect(marks(s)).toEqual({ party: [true, false, true], enemy: [false, false] })
  })

  it('自分: 使用者だけに出る', () => {
    const { s } = build({ menu: SPELLS }, { rng: () => 0 }, team(), foes())
    openTarget(4)
    expect(marks(s)).toEqual({ party: [true, false, false], enemy: [false, false] })
  })

  it('確定して窓が閉じると消える', () => {
    const { s } = build({ menu: SPELLS }, { rng: () => 0 }, team(), foes())
    openTarget(0)
    expect(marks(s).enemy).toEqual([true, false])
    press('Enter')
    expect(marks(s)).toEqual({ party: [false, false, false], enemy: [false, false] })
  })

  it('ATB で番の味方がいても、対象選択中は番の味方の ▼ を隠し、手の指す者の ▼ だけ出す', () => {
    const { s } = build(
      { menu: SPELLS },
      { rng: () => 0, atb: { mode: 'wait', initialGauges: { party: [1000, 0, 0] } } },
      team(),
      foes()
    )
    expect(marks(s)).toEqual({ party: [true, false, false], enemy: [false, false] })
    openTarget(0)
    expect(marks(s)).toEqual({ party: [false, false, false], enemy: [true, false] })
    press('Escape')
    press('Escape')
    expect(marks(s)).toEqual({ party: [true, false, false], enemy: [false, false] })
  })
})

describe('敵グリッドの被ダメ数字の高さ・対象選択の矩形 (#839 段4)', () => {
  interface GridInternals {
    menuGeometry: { enemySlots: Array<{ x: number; y: number; w: number; h: number }> }
    enemyViews: Array<{
      anchorY: number
      sprite: Sprite | null
      slotRef: { box: { x: number; y: number; w: number; h: number } } | null
    }>
    layoutSide(): void
  }
  const G = (s: BattleScreen) => s as unknown as GridInternals
  const gridScreen = () =>
    build(
      { enemyGrid: { cols: 6, rows: 2 } },
      { rng: () => 0 },
      [ent('a')],
      [ent('s1', { layout: { w: 1, h: 1, scale: 0.5 } }), ent('s2')]
    ).s

  it('対象選択の矩形（手の位置・タップの当たり判定）は、倍率で縮めた箱 slot.box と一致する', () => {
    const s = gridScreen()
    const g = G(s)
    const box = g.enemyViews[0].slotRef!.box
    expect(g.menuGeometry.enemySlots[0]).toEqual({ x: box.x, y: box.y, w: box.w, h: box.h })
    // 倍率 1 の敵は箱＝占有矩形
    const box1 = g.enemyViews[1].slotRef!.box
    expect(g.menuGeometry.enemySlots[1]).toEqual({ x: box1.x, y: box1.y, w: box1.w, h: box1.h })
    // 倍率 0.5 の箱は倍率 1 の箱の半分
    expect(box.h).toBeCloseTo(box1.h / 2, 6)
  })

  it('絵が読めないとき（色四角）の被ダメ数字の高さは、箱の上端から 35%', () => {
    const g = G(gridScreen())
    const box = g.enemyViews[0].slotRef!.box
    expect(g.enemyViews[0].anchorY).toBeCloseTo(box.y + box.h * 0.35, 6)
  })

  it('絵があるときの被ダメ数字の高さは、描いた絵の矩形の上端から 35%（箱の中で contain した矩形基準）', () => {
    const s = gridScreen()
    const g = G(s)
    // 横長の絵（200x100）。正方形の箱へ contain すると高さは箱の半分・縦は中央
    const tex = new Texture({ source: new TextureSource({ width: 200, height: 100 }) })
    g.enemyViews[0].sprite = new Sprite(tex)
    g.layoutSide()
    const box = g.enemyViews[0].slotRef!.box
    expect(g.enemyViews[0].anchorY).toBeCloseTo(box.y + box.h / 4 + (box.h / 2) * 0.35, 6)
  })

  it('アクスタのとき、被ダメ数字の高さは描いた絵（スプライト）の矩形の上端から 35%', () => {
    const { s } = build(
      { enemyGrid: { cols: 6, rows: 2 }, spriteStyle: 'acrylic' },
      { rng: () => 0 },
      [ent('a')],
      [ent('s1', { layout: { w: 1, h: 1, scale: 0.5 } }), ent('s2')]
    )
    const g = G(s)
    const v = g.enemyViews[0] as unknown as {
      anchorY: number
      baseY: number
      sprite: Sprite | null
      acrylicBack: Graphics | null
    }
    // 画像の読み込みは行わないので、読み込み後の状態（台座・影の Graphics と絵）を直接作る
    v.acrylicBack = new Graphics()
    v.sprite = new Sprite(new Texture({ source: new TextureSource({ width: 200, height: 100 }) }))
    g.layoutSide()
    const box = g.enemyViews[0].slotRef!.box
    expect(v.anchorY).toBeCloseTo(v.baseY + v.sprite.y + v.sprite.height * 0.35, 6)
    // 箱の上端から 35%（既定値）とは別物（絵は箱の余白の内側に収まる）
    expect(Math.abs(v.anchorY - (box.y + box.h * 0.35))).toBeGreaterThan(0.5)
  })
})

describe('どうぐの所持数と知らせ (#890)', () => {
  const POTION = { id: 'potion', name: 'ポーション', effect: 'heal 20..20' }
  const menuOf = (count?: number): BattleMenuData => ({
    spells: MENU.spells,
    items: [{ ...POTION, ...(count !== undefined ? { count } : {}) }],
  })
  const foes = () => [ent('s1', { atk: 0 }), ent('s2', { atk: 0 })]
  const lastLog = (e: BattleEngine) => e.getState().log[e.getState().log.length - 1]
  const useItem = () => {
    press('ArrowRight')
    press('Enter')
    press('Enter')
  }
  const rowsOf = (m: BattleMenuData, mp = 5) => buildMenuRows('item', m.items ?? [], { mp })

  it('使うたびに count が 2→1→0 と減り、0 でグレーになる', () => {
    const m = menuOf(2)
    const { engine } = build({ menu: m }, { rng: () => 0 }, [ent('a')], foes())
    useItem()
    expect(m.items![0].count).toBe(1)
    expect(rowsOf(m)[0]).toMatchObject({ cost: '×1', disabled: false })
    useItem()
    expect(m.items![0].count).toBe(0)
    expect(rowsOf(m)[0]).toMatchObject({ cost: '×0', disabled: true })
    expect(engine.getState().log.filter((l) => l.includes('ポーション を つかった')).length).toBe(2)
  })

  it('count 0 で確定すると「もっていない！」。窓は残り、count は負にならず、ターンも進まない', () => {
    const m = menuOf(0)
    const { s, engine } = build({ menu: m }, { rng: () => 0 }, [ent('a', { hp: 50 })], foes())
    press('ArrowRight')
    expect(types(s)).toEqual(['list'])
    const logLen = engine.getState().log.length
    press('Enter')
    expect(types(s)).toEqual(['list'])
    expect(m.items![0].count).toBe(0)
    expect(engine.getState().log).toHaveLength(logLen + 1)
    expect(lastLog(engine)).toBe('もっていない！')
    expect(engine.getState().events[engine.getState().events.length - 1]).toMatchObject({
      kind: 'notice',
      label: 'もっていない！',
    })
    expect(engine.getState().phase).toBe('party-input')
    expect(engine.getState().party[0].hp).toBe(50) // 回復せず、敵の反撃もない
    press('Enter')
    expect(m.items![0].count).toBe(0)
  })

  it('count 未指定のアイテムは何度使っても減らず、「×」表示も出ない', () => {
    const m = menuOf()
    const { engine } = build({ menu: m }, { rng: () => 0 }, [ent('a')], foes())
    useItem()
    useItem()
    useItem()
    expect(m.items![0]).not.toHaveProperty('count')
    expect(rowsOf(m)[0]).toMatchObject({ cost: '', disabled: false })
    expect(engine.getState().log.filter((l) => l.includes('つかった')).length).toBe(3)
  })

  it('最後の 1 個で戦闘が終わっても count は 0 になり、窓は残らない', () => {
    const m = menuOf(1)
    const { s, engine } = build(
      { menu: m },
      { rng: () => 0 },
      [ent('a', { hp: 1 })],
      [ent('s1', { atk: 50 })]
    )
    useItem()
    expect(engine.isOver()).toBe(true)
    expect(m.items![0].count).toBe(0)
    expect(types(s)).toEqual([])
  })

  it('同じ戦闘で 2 人が同じアイテムを使うと、所持数は共有で減る（ATB で 2 人が順に番になる）', () => {
    const m = menuOf(2)
    const atb = {
      atb: { mode: 'wait' as const, initialGauges: { party: [1000, 1000], enemies: [0, 0] } },
      rng: () => 0,
    }
    const { engine } = build({ menu: m }, atb, [ent('a'), ent('b')], foes())
    expect(engine.getCurrentActorIndex()).toBe(0)
    useItem() // a の番
    expect(m.items![0].count).toBe(1)
    expect(engine.getCurrentActorIndex()).toBe(1)
    useItem() // b の番
    expect(m.items![0].count).toBe(0)
    expect(engine.getState().log.filter((l) => l.includes('ポーション を つかった')).length).toBe(2)
  })

  it('呪文の対象がいない（全敵撃破済み）と「たいしょうがいない！」。窓は閉じず、MP も減らない', () => {
    const { s, engine } = build({ menu: menuOf(1) }, { rng: () => 0 }, [ent('a')], foes())
    press('ArrowLeft')
    press('ArrowDown') // いなずま（敵全体）ではなくほのお（敵単体）に合わせる
    press('ArrowDown')
    press('ArrowDown')
    const w = I(s).menuStack[0] as { cursor: number }
    expect(w.cursor).toBe(0)
    for (const e of engine.getState().enemies) e.hp = 0
    press('Enter')
    expect(types(s)).toEqual(['list'])
    expect(engine.getState().party[0].mp).toBe(5)
    expect(lastLog(engine)).toBe('たいしょうがいない！')
    expect(engine.getState().events[engine.getState().events.length - 1]).toMatchObject({
      kind: 'notice',
      label: 'たいしょうがいない！',
    })
  })

  it('対象窓で手の指す敵が倒れていたら「たいしょうがいない！」。窓は残り、MP は減らない', () => {
    const { s, engine } = build({ menu: menuOf(1) }, { rng: () => 0 }, [ent('a')], foes())
    press('ArrowLeft')
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown')
    press('Enter') // ほのお → 対象窓
    expect(types(s)).toEqual(['list', 'target'])
    engine.getState().enemies[0].hp = 0 // 手の指す s1 が倒れた
    press('Enter')
    expect(types(s)).toEqual(['list', 'target'])
    expect(engine.getState().party[0].mp).toBe(5)
    expect(lastLog(engine)).toBe('たいしょうがいない！')
  })

  it('アイテムの対象窓で手の指す味方が倒れていたら、知らせだけで count は減らない', () => {
    const m = menuOf(2)
    const { s, engine } = build({ menu: m }, { rng: () => 0 }, [ent('a'), ent('b')], foes())
    press('ArrowRight')
    press('Enter')
    expect(types(s)).toEqual(['list', 'target'])
    press('ArrowDown') // b を指す
    engine.getState().party[1].hp = 0
    press('Enter')
    expect(types(s)).toEqual(['list', 'target'])
    expect(m.items![0].count).toBe(2)
    expect(lastLog(engine)).toBe('たいしょうがいない！')
  })

  it('行動が成立しなかった（phase が party-input でない）ときは count を減らさない', () => {
    const m = menuOf(2)
    const { engine } = build({ menu: m }, { rng: () => 0 }, [ent('a')], foes())
    press('ArrowRight')
    press('Enter')
    // phase を手で書き換える擬似状態（実運用では窓が閉じるため通常は起きない）。count 減算のガード専用の検証
    ;(engine.getState() as { phase: string }).phase = 'enemy-turn'
    const logLen = engine.getState().log.length
    press('Enter')
    expect(engine.getState().log).toHaveLength(logLen) // selectItem は何もしなかった
    expect(m.items![0].count).toBe(2)
  })

  it('これらの操作で console.error / console.warn を出さない', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = menuOf(1)
    build({ menu: m }, { rng: () => 0 }, [ent('a')], foes())
    useItem()
    press('ArrowRight')
    press('Enter') // もっていない
    press('Escape')
    press('ArrowLeft')
    press('Enter')
    expect(err).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('コマンド構成 battle_commands と「わざ」(#873)', () => {
  const WITH_SKILLS: BattleMenuData = {
    ...MENU,
    skills: {
      a: [
        { id: 'slash', name: 'きる', target: '相手単体', effect: 'damage 10..10' },
        { id: 'sweep', name: 'なぎはらい', target: '相手全体', effect: 'damage 4..4' },
      ],
    },
  }
  const COMMANDS = ['skill', 'spell', 'item', 'escape'] as const
  const buildSkill = (over: BattleScreenOptions = {}, enemies?: BattleEntity[]) =>
    build(
      { commands: COMMANDS, menu: structuredClone(WITH_SKILLS), ...over },
      { rng: () => 0 },
      [ent('a')],
      enemies ?? [ent('s1', { atk: 0 }), ent('s2', { atk: 0 })]
    )
  const labels = (s: BattleScreen) =>
    (s as unknown as { commands: Array<{ id: string; text: { text: string } }> }).commands.map(
      (c) => `${c.id}:${c.text.text}`
    )

  it('並びと表示名が設定どおり（わざ の既定名は「わざ」、たたかうは出ない）', () => {
    const { s } = buildSkill()
    expect(labels(s)).toEqual(['skill:わざ', 'spell:じゅもん', 'item:どうぐ', 'escape:にげる'])
  })

  it('未指定は従来の attack/spell/item/escape（不変）', () => {
    const { s } = build()
    expect(labels(s)).toEqual(['attack:たたかう', 'spell:じゅもん', 'item:どうぐ', 'escape:にげる'])
  })

  it('↑(1 番目=わざ)で一覧が開く。←は 2 番目のじゅもん', () => {
    const { s } = buildSkill()
    press('ArrowUp')
    expect(types(s)).toEqual(['list'])
    expect(I(s).menuStack[0]).toMatchObject({ kind: 'skill' })
    press('Escape')
    press('ArrowLeft')
    expect(I(s).menuStack[0]).toMatchObject({ kind: 'spell' })
  })

  it('わざ: 一覧 → 対象 → 確定でダメージ。MP は減らず、敵ターンへ進む', () => {
    const { s, engine } = buildSkill()
    press('ArrowUp')
    press('Enter')
    expect(types(s)).toEqual(['list', 'target'])
    press('ArrowDown') // 2 体目の敵へ
    press('Enter')
    expect(types(s)).toEqual([])
    const st = engine.getState()
    expect(st.enemies.map((e) => e.hp)).toEqual([100, 90])
    expect(st.party[0].mp).toBe(5)
    expect(st.log.some((l) => l.includes('A は きる を つかった！'))).toBe(true)
  })

  it('わざ（全体）は対象選択のあと全員に当たり、Escape で戻れる', () => {
    const { s, engine } = buildSkill()
    press('ArrowUp')
    press('ArrowDown') // なぎはらい
    press('Enter')
    expect(types(s)).toEqual(['list', 'target'])
    press('Escape')
    expect(types(s)).toEqual(['list'])
    press('Enter')
    press('Enter')
    expect(engine.getState().enemies.map((e) => e.hp)).toEqual([96, 96])
  })

  it('たたかう抜きでも魔法だけで戦える（基本の攻撃は魔法メニュー）', () => {
    const { s, engine } = buildSkill()
    press('ArrowLeft')
    press('Enter')
    press('Enter')
    expect(types(s)).toEqual([])
    expect(engine.getState().enemies[0].hp).toBeLessThan(100)
    expect(engine.getState().party[0].mp).toBe(2) // ほのお 3
  })

  it('わざの候補が無い味方は、わざを選んでも何も起きない（従来のじゅもん・どうぐと同じ）', () => {
    const { s, engine } = buildSkill({ menu: structuredClone(MENU) })
    press('ArrowUp')
    expect(types(s)).toEqual([])
    expect(engine.getState().log).toHaveLength(1)
  })

  it('3 コマンド（にげる無し）でも落ちず、4 番目のキー(↓)は何も起きない', () => {
    const { s, engine } = buildSkill({ commands: ['skill', 'spell', 'item'] })
    expect(labels(s)).toHaveLength(3)
    press('ArrowDown')
    expect(engine.isOver()).toBe(false)
    expect(types(s)).toEqual([])
  })

  it('わざのタップ（ボタン）でも一覧が開く', () => {
    const { s } = buildSkill()
    const first = (s as unknown as { commands: Array<{ hit: Container }> }).commands[0].hit
    first.emit('pointertap', {} as never)
    expect(types(s)).toEqual(['list'])
    expect(I(s).menuStack[0]).toMatchObject({ kind: 'skill' })
  })
})
