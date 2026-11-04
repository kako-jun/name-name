/**
 * BattleScreen の魔法の全体化 (#895) のテスト。対象窓に たんたい / ぜんたい の窓が常に出て、
 * 左右キー・タップで切り替わり、全体化して確定すると生存している敵全員に（割ったダメージで）当たる。
 * dq 式・ff 式の両表示で動く。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import 'pixi.js/events'
import { Text as PixiText, type Container } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleMenuData, MenuStack, TargetWindow } from './battleMenu'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 9,
    maxMp: 9,
    atk: 10,
    def: 0,
    agi: 5,
    ...over,
  }
}

const MENU: BattleMenuData = {
  spells: {
    a: [
      {
        id: 'fire',
        name: 'ほのお',
        mp: 3,
        target: '敵単体',
        multiTarget: true,
        effect: 'damage 30..30',
      },
      { id: 'ice', name: 'こおり', mp: 3, target: '敵単体', effect: 'damage 30..30' },
    ],
  },
}

interface Internals {
  destroyed: boolean
  menuStack: MenuStack
  menuLayer: Container | null
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function build(opts: BattleScreenOptions = {}) {
  const engine = new BattleEngine([ent('a')], [ent('s1'), ent('s2'), ent('s3')], { rng: () => 0 })
  const s = new BattleScreen(engine, 800, 450, {
    layout: 'side',
    commandLayout: 'cross',
    menu: structuredClone(MENU),
    ...opts,
  })
  created.push(s)
  return { s, engine }
}

function press(key: string): void {
  globalThis.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

afterEach(() => {
  for (const s of created.splice(0)) if (!I(s).destroyed) s.destroy({ children: true })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const top = (s: BattleScreen) => I(s).menuStack[I(s).menuStack.length - 1] as TargetWindow

function texts(s: BattleScreen): string[] {
  const out: string[] = []
  const walk = (c: Container) => {
    for (const ch of c.children as Container[]) {
      if (ch instanceof PixiText) out.push(ch.text)
      walk(ch)
    }
  }
  walk(I(s).menuLayer!)
  return out
}

function pointerRows(s: BattleScreen): Container[] {
  const out: Container[] = []
  const walk = (c: Container) => {
    for (const ch of c.children as Container[]) {
      if (ch.eventMode === 'static' && ch.hitArea && ch.cursor === 'pointer') out.push(ch)
      walk(ch)
    }
  }
  walk(I(s).menuLayer!)
  return out
}

describe.each(['dq', 'ff'] as const)('全体化の対象窓 (%s)', (presentation) => {
  const opts: BattleScreenOptions = { presentation }

  it('全体化できる呪文の対象窓には たんたい / ぜんたい が常に出る。案内の文にも切り替えが出る', () => {
    const { s } = build(opts)
    press('ArrowLeft')
    press('Enter') // ほのお（全体化: 可）
    expect(top(s).type).toBe('target')
    const t = texts(s)
    expect(t).toContain('たんたい')
    expect(t).toContain('ぜんたい')
    expect(t.some((x) => x.includes('ぜんたい') && x.includes('←→'))).toBe(true)
  })

  it('全体化できない呪文の対象窓には出ない', () => {
    const { s } = build(opts)
    press('ArrowLeft')
    press('ArrowDown') // こおり
    press('Enter')
    expect(top(s).type).toBe('target')
    expect(texts(s)).not.toContain('ぜんたい')
  })

  it('→ で全体化して確定: 全員に当たり、30 を 3 で割った 10 ずつ。MP は 3 だけ減る', () => {
    const { s, engine } = build(opts)
    press('ArrowLeft')
    press('Enter')
    press('ArrowRight')
    expect(top(s).all).toBe(true)
    expect(texts(s).some((x) => x.includes('たんたい') && x.includes('←→'))).toBe(true)
    press('Enter')
    const st = engine.getState()
    expect(st.enemies.map((e) => e.hp)).toEqual([90, 90, 90])
    expect(st.party[0].mp).toBe(6)
    expect(I(s).menuStack).toHaveLength(0)
  })

  it('← で往復して単体に戻せる。単体で確定すると 1 体に 30', () => {
    const { s, engine } = build(opts)
    press('ArrowLeft')
    press('Enter')
    press('ArrowRight')
    press('ArrowLeft')
    expect(top(s).all).toBeFalsy()
    press('Enter')
    expect(engine.getState().enemies.map((e) => e.hp)).toEqual([70, 100, 100])
  })

  it('タップ: ぜんたい の行をタップして切り替え、敵をタップして確定', () => {
    const { s, engine } = build(opts)
    press('ArrowLeft')
    press('Enter')
    const rows = pointerRows(s)
    // 先頭 3 つが敵の当たり判定、続く 2 つが たんたい / ぜんたい の行
    expect(rows.length).toBe(5)
    rows[4].emit('pointertap', {} as never)
    expect(top(s).all).toBe(true)
    expect(I(s).menuStack).toHaveLength(2) // 切り替えただけでは確定しない
    pointerRows(s)[0].emit('pointertap', {} as never) // どの敵をタップしても全体で確定
    expect(engine.getState().enemies.map((e) => e.hp)).toEqual([90, 90, 90])
  })

  it('Esc は一覧へ戻り、開き直すと単体に戻っている', () => {
    const { s } = build(opts)
    press('ArrowLeft')
    press('Enter')
    press('ArrowRight')
    press('Escape')
    expect(I(s).menuStack.map((w) => w.type)).toEqual(['list'])
    press('Enter')
    expect(top(s).all).toBeFalsy()
  })
})
