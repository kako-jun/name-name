/** 複数ヒット (#879 P2) の FF 式再生: 数字の出現時刻・縦ずらし・のけぞり再トリガ・途中終了・従来不変 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Container, Text } from 'pixi.js'
import { BattleScreen } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  MULTI_HIT_INTERVAL_MS,
  POPUP_COLORS,
  buildActionTimeline,
  eventTimeline,
} from './battleMotion'

function entity(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 999,
    maxHp: 999,
    mp: 99,
    maxMp: 99,
    atk: 8,
    def: 1,
    agi: 2,
    exp: 1,
    gold: 1,
    ...over,
  }
}

interface Internals {
  enemyViews: { container: Container; baseX: number }[]
  popups: { text: Text; stack: number }[]
  playback: { queue: unknown[]; active: unknown }
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function setup(enemies: BattleEntity[], hero: Partial<BattleEntity> = {}) {
  const engine = new BattleEngine([entity('hero', hero)], enemies, { rng: () => 0.5 })
  const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff' })
  created.push(s)
  return { s, engine }
}
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
  vi.restoreAllMocks()
})

/** 1ms 刻みで進め、数字が現れた時刻（ms）を記録する */
function stepAndRecord(s: BattleScreen, ms: number) {
  const seen = new Set<Text>()
  const appear: { at: number; text: string; y: number }[] = []
  for (let t = 1; t <= ms; t++) {
    s.tick(1)
    for (const p of I(s).popups) {
      if (!seen.has(p.text)) {
        seen.add(p.text)
        appear.push({ at: t, text: p.text.text, y: p.text.y })
      }
    }
  }
  return appear
}

describe('FF 式 複数ヒットの順次再生', () => {
  it('回数=5: 数字が MULTI_HIT_INTERVAL_MS ごとに 1 つずつ時間差で出る', () => {
    const warn = vi.spyOn(console, 'warn')
    const err = vi.spyOn(console, 'error')
    const { s, engine } = setup([entity('slime', { atk: 0 })])
    engine.selectSpell({ name: 'れんぞく', mp: 1, target: '敵単体', effect: 'damage 10 回数=5' })
    s.redraw(800, 450)
    const ev = engine.getState().events[0]
    const tl = eventTimeline(ev)
    const appear = stepAndRecord(s, tl.hitAt + 4 * MULTI_HIT_INTERVAL_MS + 20)
    const mine = appear.filter((a) => a.text === '10')
    expect(mine).toHaveLength(5)
    mine.forEach((a, i) => {
      // tick 1ms 刻み: i 番目は hitAt + i*間隔 の tick で現れる
      expect(a.at).toBe(tl.hitAt + i * MULTI_HIT_INTERVAL_MS)
    })
    expect(warn).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
  })

  it('同じ対象への連続数字は縦に重ならない（段が 0..4・y が段ごとに上へ）', () => {
    const { s, engine } = setup([entity('slime', { atk: 0 })])
    engine.selectSpell({ name: 'れんぞく', mp: 1, target: '敵単体', effect: 'damage 10 回数=5' })
    s.redraw(800, 450)
    const tl = eventTimeline(engine.getState().events[0])
    // 5 発目の直後: 5 つとも生きている
    for (let t = 0; t < tl.hitAt + 4 * MULTI_HIT_INTERVAL_MS + 1; t++) s.tick(1)
    const ps = I(s).popups
    expect(ps.map((p) => p.stack)).toEqual([0, 1, 2, 3, 4])
    // ずれは出現直後(同じ弧の高さ)で比べる: 出現時刻 y を使い、段が上がるほど y は小さい
    const s2 = setup([entity('slime', { atk: 0 })])
    s2.engine.selectSpell({ name: 'れんぞく', mp: 1, target: '敵単体', effect: 'damage 10 回数=5' })
    s2.s.redraw(800, 450)
    const ys = stepAndRecord(s2.s, tl.hitAt + 4 * MULTI_HIT_INTERVAL_MS + 5)
      .filter((a) => a.text === '10')
      .map((a) => a.y)
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1])
  })

  it('のけぞりがヒットごとに再トリガされる（次のヒットで戻りかけた敵が再び後ろへ）', () => {
    const { s, engine } = setup([entity('slime', { atk: 0 })])
    engine.selectSpell({ name: 'れんぞく', mp: 1, target: '敵単体', effect: 'damage 10 回数=3' })
    s.redraw(800, 450)
    const tl = eventTimeline(engine.getState().events[0])
    const enemy = I(s).enemyViews[0]
    const dxs: number[] = []
    for (let t = 1; t <= tl.hitAt + 3 * MULTI_HIT_INTERVAL_MS; t++) {
      s.tick(1)
      if (t >= tl.hitAt) dxs.push(Math.abs(enemy.container.x - enemy.baseX))
    }
    // のけぞりの量（絶対値）。各 round の命中直後に量が増え、間隔内で一度減る（山が 3 つ）
    let peaks = 0
    for (let i = 1; i < dxs.length - 1; i++)
      if (dxs[i] > dxs[i - 1] && dxs[i] >= dxs[i + 1]) peaks++
    expect(dxs.some((d) => d > 0)).toBe(true)
    expect(peaks + (dxs[dxs.length - 1] > dxs[dxs.length - 2] ? 1 : 0)).toBeGreaterThanOrEqual(3)
  })

  it('途中で倒れて別の敵へ移る: 発火順は配列順で、全員の HP 表示が最後に確定値になる', () => {
    const { s, engine } = setup([
      entity('a', { hp: 15, maxHp: 15, atk: 0 }),
      entity('b', { atk: 0 }),
    ])
    engine.selectSpell({ name: 'れんぞく', mp: 1, target: '敵単体', effect: 'damage 10 回数=4' })
    s.redraw(800, 450)
    const appear = stepAndRecord(s, 6000)
    expect(appear.filter((a) => a.text === '10')).toHaveLength(4)
    expect(I(s).playback.active).toBeNull()
    expect(engine.getState().enemies[0].hp).toBe(0)
    expect(engine.getState().enemies[1].hp).toBe(979)
  })

  it('戦闘が終わる複数ヒット: 全ヒットの数字を見せ切ってから閉じる', () => {
    const closed: string[] = []
    const engine = new BattleEngine([entity('hero')], [entity('slime', { hp: 25, maxHp: 25 })], {
      rng: () => 0.5,
    })
    const s = new BattleScreen(engine, 800, 450, {
      layout: 'side',
      presentation: 'ff',
      onClose: (o) => closed.push(o),
    })
    created.push(s)
    engine.selectSpell({ name: 'れんぞく', mp: 1, target: '敵単体', effect: 'damage 10 回数=5' })
    s.redraw(800, 450)
    const ev = engine.getState().events[0]
    expect(ev.hits.length).toBe(3) // 25 を 10,10,10 で倒して打ち切り
    const tl = eventTimeline(ev)
    for (let t = 0; t < tl.hitAt + 2 * MULTI_HIT_INTERVAL_MS; t++) s.tick(1)
    expect(closed).toEqual([])
    for (let t = 0; t < 6000; t++) s.tick(1)
    expect(closed).toEqual(['victory'])
  })

  it('ダメージ数字は 1 ヒット 9999 で頭打ち（#877）', () => {
    const { s, engine } = setup([entity('slime', { atk: 0, hp: 30000, maxHp: 30000 })])
    engine.selectSpell({ name: 'ごく', mp: 1, target: '敵単体', effect: 'damage 99999 回数=2' })
    s.redraw(800, 450)
    const appear = stepAndRecord(s, 3000)
    expect(appear.map((a) => a.text).slice(0, 2)).toEqual(['9999', '9999'])
  })

  it('吸収: そのヒットだけ緑の回復数字になり、ダメージ数字と同じ段で積まれる', () => {
    const { s, engine } = setup([
      entity('slime', {
        atk: 0,
        hp: 500,
        maxHp: 1000,
        affinity: { weak: [], halve: [], nullify: [], absorb: ['fire'] },
      }),
    ])
    engine.selectSpell({
      name: 'ほのお',
      mp: 1,
      target: '敵単体',
      effect: 'damage 20 type=fire 回数=3',
    })
    s.redraw(800, 450)
    const ev = engine.getState().events[0]
    expect(ev.hits.map((h) => h.kind)).toEqual(['heal', 'heal', 'heal'])
    const tl = eventTimeline(ev)
    for (let t = 0; t < tl.hitAt + 2 * MULTI_HIT_INTERVAL_MS + 1; t++) s.tick(1)
    const ps = I(s).popups
    expect(ps.map((p) => p.stack)).toEqual([0, 1, 2])
    for (const p of ps) expect(p.text.style.fill).toBe(POPUP_COLORS.heal)
  })

  it('従来の単発（round なし）は発火 1 回・数字 1 つ・段 0・時刻も従来どおり', () => {
    const { s, engine } = setup([entity('slime', { atk: 0 })])
    engine.selectSpell({ name: 'ひとつ', mp: 1, target: '敵単体', effect: 'damage 20' })
    s.redraw(800, 450)
    const ev = engine.getState().events[0]
    expect(ev.hits.every((h) => h.round === undefined)).toBe(true)
    const tl = eventTimeline(ev)
    expect(tl).toEqual(buildActionTimeline('spell', { damages: true }))
    const appear = stepAndRecord(s, tl.hitAt + 50)
    expect(appear).toHaveLength(1)
    expect(appear[0].at).toBe(tl.hitAt)
    expect(I(s).popups[0].stack).toBe(0)
  })
})
