/**
 * BattleScreen の battle_target_cursor (#1189): `ff` は対象を手だけで指し（▼ を出さない）、敵名ウィンドウの対象の行を強調し、
 * 番の味方は頭上の ▼ だけで示す（対象選択の間も出したまま。名前の左に ▼ と同時に ▶ を出し、▷ は出さない）。未指定は従来どおり
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Container, Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { skipEntrance } from './battleScreenTestUtil'
import { BattleEngine } from './battleEngine'
import type { BattleMenuData } from './battleMenu'
import type { MenuGeometry } from './battleMenuLayout'
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
      { id: 'fire', name: 'ほのお', mp: 1, target: '敵単体', effect: 'damage 8..14' },
      { id: 'heal', name: 'ヒール', mp: 1, target: '味方単体', effect: 'heal 10..10' },
    ],
  },
}

interface Internals {
  partyViews: Array<{ selectMark: { visible: boolean } }>
  atbMarkers: Text[]
  menuGeometry: MenuGeometry | null
  enemyViews: Array<{
    selectMark: { visible: boolean }
    container: Container
    sprite: Container | null
  }>
  targetGeometry(g: MenuGeometry): MenuGeometry
  enemyListTexts: Text[]
  refresh(): void
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

function build(opts: BattleScreenOptions = {}, atb = false) {
  const party = [ent('a'), ent('b')]
  const enemies = [
    ent('s1', { name: 'スライム' }),
    ent('ika', { name: 'イカ' }),
    ent('s2', { name: 'スライム' }),
  ]
  const engine = new BattleEngine(party, enemies, {
    rng: () => 0,
    ...(atb ? { atb: { initialGauges: { party: [1000, 1000] } } } : {}),
  })
  const s = skipEntrance(
    new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      commandLayout: 'cross',
      enemyList: 'window',
      menu: structuredClone(MENU),
      ...opts,
    })
  )
  created.push(s)
  I(s).refresh()
  return { s, engine }
}

function press(key: string): void {
  globalThis.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}
/** i 番目の呪文の対象窓を開く */
function openTarget(i: number): void {
  press('ArrowLeft')
  for (let k = 0; k < i; k++) press('ArrowDown')
  press('Enter')
}
const marks = (s: BattleScreen) => ({
  party: I(s).partyViews.map((v) => v.selectMark.visible),
  enemy: I(s).enemyViews.map((v) => v.selectMark.visible),
})

describe('battle_target_cursor: 対象選択の ▼ (#1189)', () => {
  it('未指定（off）は従来どおり: 敵単体の対象に ▼ が出る', () => {
    const { s } = build()
    openTarget(0)
    expect(marks(s).enemy).toEqual([true, false, false])
  })
  it('ff: 対象に ▼ を出さない（手だけで指す）', () => {
    const { s } = build({ targetCursor: 'ff' })
    openTarget(0)
    expect(marks(s).enemy).toEqual([false, false, false])
    press('ArrowDown')
    expect(marks(s).enemy).toEqual([false, false, false])
  })
  it('ff: ATB では対象選択の間も番の味方の ▼ を出したまま（対象の味方には出さない）', () => {
    const { s } = build({ targetCursor: 'ff' }, true)
    openTarget(1)
    press('ArrowDown')
    expect(marks(s)).toEqual({ party: [true, false], enemy: [false, false, false] })
  })
  it('off（従来）: ATB で対象選択の間は番の味方の ▼ を隠し、対象に出す', () => {
    const { s } = build({}, true)
    openTarget(0)
    expect(marks(s)).toEqual({ party: [false, false], enemy: [true, false, false] })
  })
})

describe('battle_target_cursor: 番の印 (#1189)', () => {
  it('未指定（off）は従来どおり: 番の味方に頭上の ▼ と名前の左の ▶ が出る', () => {
    const { s } = build({}, true)
    expect(marks(s).party).toEqual([true, false])
    expect(I(s).atbMarkers[0].visible).toBe(true)
  })
  it('ff: 番の味方に ▶ が ▼ と同時に出る・対象選択中も出たまま・▷ は出ない', () => {
    const { s } = build({ targetCursor: 'ff', atbSwitch: true }, true)
    const vis = () => I(s).atbMarkers.map((m) => m.visible)
    expect(marks(s).party).toEqual([true, false])
    expect(vis()).toEqual(marks(s).party)
    expect(I(s).atbMarkers[0].text).toBe('▶')
    openTarget(1)
    press('ArrowDown')
    expect(marks(s).party).toEqual([true, false])
    expect(vis()).toEqual(marks(s).party)
    expect(I(s).atbMarkers.every((m) => !m.visible || m.text === '▶')).toBe(true)
  })
  it('ff: タップで番を移せる味方の ▷ は出さない（切り替えのタップ自体は効く）', () => {
    const { s } = build({ targetCursor: 'ff', atbSwitch: true }, true)
    expect(I(s).atbMarkers.some((m) => m.visible && m.text === '▷')).toBe(false)
  })
})

describe('battle_target_cursor: 敵名ウィンドウの行 (#1189)', () => {
  it('未指定（off）は窓の行を候補窓へ渡さない（従来どおり）', () => {
    const { s } = build()
    expect(I(s).menuGeometry?.enemyListRows).toBeUndefined()
  })
  it('ff: 窓の見えている行（文字と同じ帯・窓の枠の内側）と、その行の敵を候補窓へ渡す', () => {
    const { s } = build({ targetCursor: 'ff' })
    const rows = I(s).menuGeometry?.enemyListRows
    expect(rows?.map((r) => r.members)).toEqual([[0, 2], [1]])
    const t = I(s).enemyListTexts
    rows?.forEach((r, i) => {
      // 文字は行の帯の中
      expect(t[i].y).toBeGreaterThanOrEqual(r.rect.y - 0.001)
      expect(t[i].y).toBeLessThanOrEqual(r.rect.y + r.rect.h)
      expect(t[i].x).toBeGreaterThanOrEqual(r.rect.x)
    })
  })
  it('ff でも敵名ウィンドウが無い設定では行を渡さない（直交: 窓の有無は battle_enemy_list が決める）', () => {
    const { s } = build({ targetCursor: 'ff', enemyList: 'off' })
    expect(I(s).menuGeometry?.enemyListRows).toBeUndefined()
  })
  it('ff: 倒れて行が消えると、渡す行も減る', () => {
    const { s, engine } = build({ targetCursor: 'ff' })
    engine.getState().enemies[1].hp = 0
    I(s).refresh()
    expect(I(s).menuGeometry?.enemyListRows?.map((r) => r.members)).toEqual([[0, 2]])
  })
})

describe('battle_target_cursor: 敵の手の基準の矩形 (#1189)', () => {
  it('off は従来どおり敵のマス（menuGeometry のまま）', () => {
    const { s } = build()
    const g = I(s).menuGeometry as MenuGeometry
    expect(I(s).targetGeometry(g)).toBe(g)
  })
  it('ff は見えている絵の矩形を使う（絵がまだ無い敵は container。手が絵の左に来る）', () => {
    const { s } = build({ targetCursor: 'ff' })
    const g = I(s).menuGeometry as MenuGeometry
    const slots = I(s).targetGeometry(g).enemySlots
    I(s).enemyViews.forEach((v, i) => {
      const b = (v.sprite && v.sprite.visible ? v.sprite : v.container).getBounds()
      expect(slots[i].x).toBeCloseTo(b.x)
      expect(slots[i].y).toBeCloseTo(b.y)
      expect(slots[i].w).toBeCloseTo(b.width)
      expect(slots[i].h).toBeCloseTo(b.height)
    })
  })
})

describe('battle_target_cursor: 敵名ウィンドウが溢れたとき (#1189)', () => {
  it('行が窓に入り切らず最後に見える行が「…」のときは、その行を除いた行だけ渡す（名前の出ない行は強調しない）', () => {
    const party = [ent('a')]
    const enemies = Array.from({ length: 12 }, (_, i) => ent(`e${i}`, { name: `てき${i}` }))
    const engine = new BattleEngine(party, enemies, { rng: () => 0 })
    const s = skipEntrance(
      new BattleScreen(engine, 800, 450, {
        layout: 'side',
        presentation: 'ff',
        commandLayout: 'cross',
        enemyList: 'window',
        menu: structuredClone(MENU),
        targetCursor: 'ff',
      })
    )
    created.push(s)
    I(s).refresh()
    const shown = I(s).enemyListTexts.filter((t) => t.visible)
    // 前提: 溢れていて、最後に見える行が「…」
    expect(shown.length).toBeLessThan(enemies.length)
    expect(shown[shown.length - 1].text).toBe('…')
    const rows = I(s).menuGeometry?.enemyListRows ?? []
    expect(rows).toHaveLength(shown.length - 1)
    expect(rows.map((r) => r.members)).toEqual(
      Array.from({ length: shown.length - 1 }, (_, i) => [i])
    )
  })
})
