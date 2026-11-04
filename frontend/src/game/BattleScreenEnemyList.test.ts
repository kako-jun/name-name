/** BattleScreen の敵名ウィンドウ (#954): 同名まとめ・倒れで個数減・足元ラベルを出さない */
import { afterEach, describe, expect, it } from 'vitest'
import type { Text } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import { MULTI_HIT_INTERVAL_MS, eventTimeline } from './battleMotion'
import type { BattleEntity } from './spellDsl'
import type { StatusDef } from '../types'
import { ENEMY_LIST_MAX_FONT, ENEMY_LIST_PADDING } from './battleEnemyList'
import { estimateTextWidth } from './battleLayout'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 999,
    maxHp: 999,
    mp: 9,
    maxMp: 9,
    atk: 8,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface Internals {
  enemyViews: { label: Text | null }[]
  enemyListTexts: Text[]
  enemyListPanel: { visible: boolean }
  enemyListRect: { x: number; y: number; w: number; h: number } | null
  statusTexts: Text[]
  refresh(): void
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function setup(opts: BattleScreenOptions = {}, width = 800) {
  const hero = entity('hero', { atk: 500, agi: 99 })
  const enemies = [
    entity('s1', { name: 'スライム', hp: 5, maxHp: 5, atk: 0 }),
    entity('s2', { name: 'スライム', hp: 5, maxHp: 5, atk: 0 }),
    entity('s3', { name: 'スライム', hp: 5, maxHp: 5, atk: 0 }),
    entity('ika', { name: 'イカ', hp: 5, maxHp: 5, atk: 0 }),
  ]
  const engine = new BattleEngine([hero], enemies, { rng: () => 0.5, skills: {} })
  const s = new BattleScreen(engine, width, 450, { layout: 'side', presentation: 'ff', ...opts })
  created.push(s)
  I(s).refresh()
  return { s, engine }
}
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

const shown = (s: BattleScreen): string[] =>
  I(s)
    .enemyListTexts.filter((t) => t.visible)
    .map((t) => t.text)

/** 演出を最後まで進める */
function settle(s: BattleScreen): void {
  I(s).refresh()
  for (let i = 0; i < 20000; i++) s.tick(1)
  I(s).refresh()
}

describe('BattleScreen: 敵名ウィンドウ (#954)', () => {
  it('有効: 窓が出て、同名は「名前 ×N」にまとまり、足元ラベルは出ない', () => {
    const { s } = setup({ enemyList: 'window' })
    expect(I(s).enemyListRect).not.toBeNull()
    expect(I(s).enemyListPanel.visible).toBe(true)
    expect(shown(s)).toEqual(['スライム ×3', 'イカ'])
    for (const v of I(s).enemyViews) expect(v.label?.visible).toBe(false)
  })

  it('無効（未指定・off）: 窓も名前 Text も無く、足元ラベルが出る（従来どおり）', () => {
    for (const opts of [{}, { enemyList: 'off' as const }]) {
      const { s } = setup(opts)
      expect(I(s).enemyListRect).toBeNull()
      expect(I(s).enemyListPanel.visible).toBe(false)
      expect(shown(s)).toEqual([])
      expect(I(s).enemyViews.some((v) => v.label?.visible)).toBe(true)
    }
  })

  it('dq / front では window を指定しても窓を出さない', () => {
    expect(I(setup({ enemyList: 'window', presentation: 'dq' }).s).enemyListRect).toBeNull()
    expect(I(setup({ enemyList: 'window', layout: 'front' }).s).enemyListRect).toBeNull()
  })

  it('画面が狭くて窓を置けないときは足元ラベルに戻る', () => {
    const { s } = setup({ enemyList: 'window' }, 320)
    expect(I(s).enemyListRect).toBeNull()
    expect(shown(s)).toEqual([])
    expect(I(s).enemyViews.some((v) => v.label?.visible)).toBe(true)
  })

  it('倒れると個数が減り、全滅した名前は行ごと消える', () => {
    const { s, engine } = setup({ enemyList: 'window' })
    engine.selectAttack('s1')
    settle(s)
    expect(shown(s)).toEqual(['スライム ×2', 'イカ'])
    engine.selectAttack('ika')
    settle(s)
    expect(shown(s)).toEqual(['スライム ×2'])
    engine.selectAttack('s2')
    settle(s)
    expect(shown(s)).toEqual(['スライム'])
  })

  it('命中の瞬間まで古い HP で数える（確定 HP では数えない）', () => {
    const { s, engine } = setup({ enemyList: 'window' })
    engine.selectAttack('s1')
    I(s).refresh()
    // エンジン上はもう倒れているが、演出が命中するまで窓は ×3 のまま
    expect(engine.getState().enemies[0].hp).toBe(0)
    expect(shown(s)).toEqual(['スライム ×3', 'イカ'])
    const hitAt = eventTimeline(engine.getState().events[0]).hitAt
    for (let t = 0; t < hitAt - 5; t++) s.tick(1)
    expect(shown(s)).toEqual(['スライム ×3', 'イカ'])
    for (let t = 0; t < 40; t++) s.tick(1)
    expect(shown(s)).toEqual(['スライム ×2', 'イカ'])
  })

  it('複数ヒットは、倒すヒットが命中した瞬間に個数が減る', () => {
    const engine = new BattleEngine(
      [entity('hero', { mp: 99, maxMp: 99, agi: 99 })],
      [
        entity('a', { name: 'スライム', hp: 15, maxHp: 15, atk: 0 }),
        entity('b', { name: 'スライム', hp: 999, maxHp: 999, atk: 0 }),
      ],
      { rng: () => 0.5 }
    )
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      enemyList: 'window',
    })
    created.push(s)
    engine.selectSpell({ name: 'れんぞく', mp: 1, target: '敵単体', effect: 'damage 10 回数=2' })
    I(s).refresh()
    const hitAt = eventTimeline(engine.getState().events[0]).hitAt
    expect(shown(s)).toEqual(['スライム ×2'])
    for (let t = 0; t < hitAt + 5; t++) s.tick(1)
    // 1 ヒット目（HP 5 残り）ではまだ ×2
    expect(shown(s)).toEqual(['スライム ×2'])
    for (let t = 0; t < MULTI_HIT_INTERVAL_MS + 10; t++) s.tick(1)
    // 2 ヒット目で倒れて ×1（名前のみ）
    expect(shown(s)).toEqual(['スライム'])
  })
})

describe('BattleScreen: 敵名ウィンドウの後続 (#954)', () => {
  const STATUSES: Record<string, StatusDef> = {
    poison: { id: 'poison', name: 'どく', tickDamage: '1' },
  }
  function withEnemies(enemies: BattleEntity[], width = 800) {
    const engine = new BattleEngine([entity('hero', { agi: 99 })], enemies, {
      rng: () => 0.5,
      skills: {},
      statuses: STATUSES,
    })
    const s = new BattleScreen(engine, width, 450, {
      layout: 'side',
      presentation: 'ff',
      enemyList: 'window',
    })
    created.push(s)
    I(s).refresh()
    return s
  }

  it('状態異常の敵は窓の行に [状態] が付き、同名でも状態が違えば別の行になる', () => {
    const s = withEnemies([
      entity('a', { name: 'スライム', hp: 5, maxHp: 5, status: { poison: 3 } }),
      entity('b', { name: 'スライム', hp: 5, maxHp: 5 }),
      entity('c', { name: 'スライム', hp: 5, maxHp: 5 }),
    ])
    expect(shown(s)).toEqual(['[どく] スライム', 'スライム ×2'])
  })

  it('窓の 1 行目の文字は status 窓の 1 行目と同じ高さ（y が約 2px ずれない）', () => {
    const s = withEnemies([entity('a', { name: 'スライム', hp: 5, maxHp: 5 })])
    const first = I(s).enemyListTexts.find((t) => t.visible)!
    expect(first.style.fontSize).toBe(ENEMY_LIST_MAX_FONT)
    expect(first.y).toBeCloseTo(I(s).statusTexts[0].y, 5)
  })

  it('窓の幅が BattleScreen から渡る: 狭い窓では長い名前のために文字が縮み、行は窓の幅に収まる', () => {
    const name = 'メタルスライムのなかま'
    const s = withEnemies([entity('a', { name, hp: 5, maxHp: 5 })], 640)
    const rect = I(s).enemyListRect!
    const t = I(s).enemyListTexts.find((x) => x.visible)!
    expect(t.style.fontSize).toBeLessThan(ENEMY_LIST_MAX_FONT)
    expect(estimateTextWidth(t.text, Number(t.style.fontSize))).toBeLessThanOrEqual(
      rect.w - ENEMY_LIST_PADDING * 2
    )
  })
})
