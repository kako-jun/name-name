/** BattleScreen のコマンド窓の題名 (#1226): 指示を出す味方の名前。番が替わると替わり、指示待ちでない間・窓が重なる間は出さない */
import { afterEach, describe, expect, it } from 'vitest'
import 'pixi.js/events'
import type { Container, Text } from 'pixi.js'
import { BattleScreen } from './BattleScreen'
import { skipEntrance } from './battleScreenTestUtil'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'

const ent = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
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
})
const MENU = {
  spells: { a: [{ id: 'f', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' }] },
  items: [],
}

interface Internals {
  destroyed: boolean
  commandTitle: Text
  commands: Array<{ id: string; hit: Container }>
  refresh(): void
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function build(gauges: number[], layout: 'side' | 'front' = 'side') {
  const engine = new BattleEngine([ent('a'), ent('b')], [ent('s')], {
    rng: () => 0,
    atb: { mode: 'wait', initialGauges: { party: gauges } },
  })
  const s = skipEntrance(
    new BattleScreen(engine, 800, 450, {
      layout,
      presentation: 'ff',
      commandLayout: 'cross',
      menu: structuredClone(MENU),
    } as never)
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

describe('コマンド窓の題名 (#1226)', () => {
  it('番の味方の名前が出て、番が替わると名前も替わる', () => {
    const { s, engine } = build([1000, 1000])
    expect(I(s).commandTitle.visible).toBe(true)
    expect(I(s).commandTitle.text).toBe('A')
    engine.switchAtbActor(1)
    I(s).refresh()
    expect(I(s).commandTitle.text).toBe('B')
    expect(I(s).commandTitle.visible).toBe(true)
  })

  it('front 配置ではコマンド窓の題名を出さない（上のステータス窓との隙間が狭く重なるため）', () => {
    const { s } = build([1000, 1000], 'front')
    expect(I(s).commandTitle.visible).toBe(false)
  })

  it('指示待ちの味方がいない（ATB の溜め中）間は出ない', () => {
    const { s } = build([0, 0])
    expect(I(s).commandTitle.visible).toBe(false)
  })

  it('一覧窓が重なっている間は隠れ、閉じると戻る', () => {
    const { s } = build([1000, 1000])
    expect(I(s).commandTitle.visible).toBe(true)
    tap(I(s).commands.find((c) => c.id === 'spell')!.hit)
    expect(I(s).commandTitle.visible).toBe(false)
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(I(s).commandTitle.visible).toBe(true)
  })
})
