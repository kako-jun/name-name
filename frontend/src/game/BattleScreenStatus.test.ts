/** 戦闘画面の状態異常の表示 (#870): 味方のステータス欄・敵のラベルの名前に状態名を前置きする */
import { afterEach, describe, expect, it } from 'vitest'
import type { Text } from 'pixi.js'
import { BattleScreen } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import { isPlaybackBusy } from './battleMotion'
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
  it('敵: 状態が複数なら先頭 1 つ + 「…」に略し、長い名前でも状態名が名前を押し出さない', () => {
    const s = make(
      [entity('hero')],
      [entity('slime', { hp: 10, maxHp: 10, status: { poison: 2, sleep: 2 } })],
      STATUSES
    )
    expect(I(s).enemyViews[0].label?.text).toBe('SLIME [どく…]\nHP 10/10')
    const long = make(
      [entity('hero')],
      [entity('veryLongBossName', { hp: 10, maxHp: 10, status: { poison: 2, sleep: 2 } })],
      STATUSES
    )
    const first = (I(long).enemyViews[0].label?.text ?? '').split('\n')[0]
    expect(first.startsWith('VERYLONG')).toBe(true) // 名前の頭が読める
  })

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
    expect(I(s).enemyViews[0].label?.text).toBe('SLIME [どく]\nHP 10/10') // 名前を先に、状態名は後ろ
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

describe('BattleScreen: FF 式は状態名も演出の再生位置で切り替える (#870)', () => {
  const run = (s: BattleScreen, ms: number) => {
    for (let left = ms; left > 0; left -= 16) s.tick(Math.min(16, left))
  }
  const refresh = (s: BattleScreen) => (s as unknown as { refresh(): void }).refresh()
  const makeFf = (enemy: BattleEntity) => {
    const engine = new BattleEngine([entity('hero')], [enemy], {
      rng: () => 0.5,
      statuses: STATUSES,
    })
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff' })
    created.push(s)
    return { s, engine }
  }

  it('状態を付ける行動: エンジンはすぐ付くが、画面の状態名は命中の瞬間まで出ない', () => {
    const { s, engine } = makeFf(entity('slime', { hp: 999, maxHp: 999 }))
    const label = () => I(s).enemyViews[0].label?.text ?? ''
    engine.selectSpell({ name: 'どく', mp: 1, target: '敵単体', effect: 'status poison' })
    expect(engine.getState().enemies[0].status?.poison).toBeGreaterThan(0)
    refresh(s)
    expect(label()).not.toContain('どく')
    run(s, 5000)
    expect(label()).toContain('[どく]')
  })

  it('状態を解く行動: 命中の瞬間までは古い状態名を出し続け、そのあと消える', () => {
    const { s, engine } = makeFf(entity('slime', { hp: 999, maxHp: 999, status: { poison: 5 } }))
    const label = () => I(s).enemyViews[0].label?.text ?? ''
    refresh(s)
    expect(label()).toContain('[どく]')
    engine.selectSpell({ name: 'なおし', mp: 1, target: '敵単体', effect: 'cure poison' })
    expect(engine.getState().enemies[0].status?.poison).toBeUndefined()
    refresh(s)
    expect(label()).toContain('[どく]')
    run(s, 5000)
    expect(label()).not.toContain('どく')
  })

  it('状態が解ける行動: 命中の瞬間（最後の round）に切り替わり、途中の round ではまだ古い状態名で、再生が終わる前に出し切る', () => {
    const NAP: Record<string, StatusDef> = {
      nap: { id: 'nap', name: 'うたたね', action: '不能', cure: '被ダメージ' },
    }
    const engine = new BattleEngine(
      [entity('hero')],
      [entity('slime', { hp: 999, maxHp: 999, status: { nap: 5 } })],
      { rng: () => 0.5, statuses: NAP }
    )
    const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff' })
    created.push(s)
    const label = () => I(s).enemyViews[0].label?.text ?? ''
    const busy = () => isPlaybackBusy((s as unknown as { playback: never }).playback)
    refresh(s)
    const before = label()
    expect(before).toContain('[うたたね]')
    engine.selectSpell({
      name: 'れんぞく',
      mp: 1,
      target: '敵単体',
      effect: 'damage 3 回数=3',
    })
    const ev = engine.getState().events.find((e) => e.kind === 'spell')
    expect(new Set(ev?.hits.map((h) => h.round)).size).toBe(3)
    expect(engine.getState().enemies[0].status?.nap).toBeUndefined()
    refresh(s)
    expect(label()).toContain('[うたたね]')
    // 1 行ごとに進め、HP が減り始めた（最初の round が命中した）瞬間と、状態名が消えた瞬間を記録する
    let firstHit = -1
    let flipped = -1
    let busyAtFlip: boolean | null = null
    const hpLine = (t: string) => t.split('\n')[1]
    for (let step = 0; step < 400 && flipped < 0; step++) {
      s.tick(5)
      const t = label()
      if (firstHit < 0 && hpLine(t) !== hpLine(before)) firstHit = step
      if (!t.includes('うたたね')) {
        flipped = step
        busyAtFlip = busy()
      }
    }
    expect(firstHit).toBeGreaterThanOrEqual(0)
    expect(flipped).toBeGreaterThan(firstHit) // 最初の round では切り替わらず、あとの round で切り替わる
    expect(busyAtFlip).toBe(true) // 再生が終わるのを待たずに、命中の瞬間に切り替わる
    // 切り替わった時点で、全 round ぶんの HP が出ている
    expect(label()).toContain('HP 990/999')
  })
})
