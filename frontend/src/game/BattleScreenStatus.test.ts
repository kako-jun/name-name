/** 戦闘画面の状態異常の表示 (#870): 味方のステータス欄・敵のラベルの名前に状態名を前置きする */
import { afterEach, describe, expect, it } from 'vitest'
import type { Text } from 'pixi.js'
import { BattleScreen } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import type { StatusDef } from '../types'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 30,
    maxHp: 30,
    mp: 4,
    maxMp: 4,
    atk: 1,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface Internals {
  statusTexts: Text[]
  enemyViews: { label: Text | null }[]
  heroStatsText: Text
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const STATUSES: Record<string, StatusDef> = {
  poison: { id: 'poison', name: 'どく', tickDamage: '1' },
  sleep: { id: 'sleep', name: 'ねむり', action: '不能' },
}

const created: BattleScreen[] = []
function make(
  party: BattleEntity[],
  enemies: BattleEntity[],
  statuses: Record<string, StatusDef> | undefined,
  layout: 'side' | 'front' = 'side'
) {
  const engine = new BattleEngine(party, enemies, {
    rng: () => 0.5,
    ...(statuses ? { statuses } : {}),
  })
  const s = new BattleScreen(engine, 800, 450, { layout })
  created.push(s)
  return s
}
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

describe('BattleScreen: 状態名の表示 (#870)', () => {
  it('味方: 宣言した状態が付いていると名前の前に [状態名] が付く。付いていなければ名前のまま', () => {
    const s = make(
      [entity('hero', { status: { poison: 3 } }), entity('mage')],
      [entity('slime', { hp: 999, maxHp: 999 })],
      STATUSES
    )
    expect(I(s).statusTexts[0].text).toContain('[どく]')
    expect(I(s).statusTexts[0].text).toContain('HERO')
    expect(I(s).statusTexts[1].text).toBe('MAGE')
  })

  it('複数の状態は付いた順に「・」でつなぐ。残りターン 0 や宣言の無い印は出さない', () => {
    const s = make(
      [entity('hero', { status: { poison: 3, bleed: 2, marker: 5, old: 0 } })],
      [entity('slime', { hp: 999, maxHp: 999 })],
      {
        ...STATUSES,
        bleed: { id: 'bleed', name: 'ちぶん' },
        old: { id: 'old', name: 'ふるい' },
      }
    )
    expect(I(s).statusTexts[0].text).toBe('[どく・ちぶん] HERO')
  })

  it('敵のラベルの名前の行にも前置きされ、HP の行は変わらない', () => {
    const s = make(
      [entity('hero')],
      [entity('slime', { hp: 10, maxHp: 10, status: { poison: 2 } })],
      STATUSES
    )
    expect(I(s).enemyViews[0].label?.text).toBe('[どく] SLIME\nHP 10/10')
  })

  it('状態を宣言しない戦闘は、印が付いていても名前はそのまま（従来どおり）', () => {
    const s = make(
      [entity('hero', { status: { poison: 3 } })],
      [entity('slime', { hp: 10, maxHp: 10, status: { poison: 2 } })],
      undefined
    )
    expect(I(s).statusTexts[0].text).toBe('HERO')
    expect(I(s).enemyViews[0].label?.text).toBe('SLIME\nHP 10/10')
  })

  it('front 配置の主役の行にも出る', () => {
    const s = make(
      [entity('hero', { status: { poison: 3 } })],
      [entity('slime', { hp: 999, maxHp: 999 })],
      STATUSES,
      'front'
    )
    expect(I(s).heroStatsText.text).toContain('[どく] HERO')
  })
})
