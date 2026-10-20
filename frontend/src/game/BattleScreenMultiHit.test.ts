/** 複数ヒット (#879 P2) の FF 式再生: 数字の出現時刻・縦ずらし・のけぞり再トリガ・途中終了・従来不変 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Container, Text } from 'pixi.js'
import { BattleScreen } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import {
  MULTI_HIT_INTERVAL_MS,
  POPUP_COLORS,
  POPUP_STACK_STEP,
  fitPopupFontSize,
  popupCenterOffset,
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
  spawnPopup: (hit: unknown, sinceHit: number, stack?: number) => void
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

  it('22 ヒット以上: のけぞりは縮んだ間隔で再トリガされる（各ヒットの直後は戻って 0 付近）', () => {
    const { s, engine } = setup([entity('slime', { atk: 0 })])
    engine.selectSpell({ name: 'れんぞく', mp: 1, target: '敵単体', effect: 'damage 1 回数=30' })
    s.redraw(800, 450)
    const tl = eventTimeline(engine.getState().events[0])
    expect(tl.hitInterval).toBeLessThan(MULTI_HIT_INTERVAL_MS)
    const enemy = I(s).enemyViews[0]
    const dxs = new Map<number, number>()
    let peak = 0
    for (let t = 1; t <= tl.hitAt + 29 * tl.hitInterval + 5; t++) {
      s.tick(1)
      const d = Math.abs(enemy.container.x - enemy.baseX)
      peak = Math.max(peak, d)
      dxs.set(t, d)
    }
    expect(peak).toBeGreaterThan(0)
    // 命中の直後（経過 1ms 未満）はのけぞりが頭から始まり直して 0 付近。間隔を渡し忘れると後半の命中が無視され、この時刻の量が大きいまま
    for (let k = 10; k <= 29; k++) {
      const t = Math.ceil(tl.hitAt + k * tl.hitInterval)
      expect(dxs.get(t)).toBeLessThan(peak * 0.1)
    }
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

  describe('連続ヒットの段の間隔は縮小前の基本フォントで決まる (#877)', () => {
    /** 同一対象に amounts を段 0,1,2… で同時に出し、各数字の y と描いたフォントサイズを返す */
    const spawnStack = (amounts: number[]) => {
      const { s } = setup([entity('slime', { atk: 0 })])
      s.redraw(800, 450)
      amounts.forEach((amount, stack) => {
        const hit = { kind: 'heal', amount, target: { side: 'enemy', index: 0 } }
        I(s).spawnPopup(hit, 0, stack)
      })
      return I(s).popups.map((p) => ({ y: p.text.y, font: Number(p.text.style.fontSize) }))
    }
    it('4 文字以下は従来（#879）どおり、基本フォントの 0.85 倍ずつ', () => {
      for (const amount of [9, 9999]) {
        const [a, , c] = spawnStack([amount, amount, amount])
        expect(c.y).toBeLessThan(a.y)
        expect(a.y - c.y).toBeCloseTo(2 * a.font * POPUP_STACK_STEP, 5)
        expect(a.font).toBe(fitPopupFontSize(String(amount), a.font))
      }
    })
    it('5 桁以上でも段の間隔は 4 桁と同じ（数字は縮むが間隔は基本フォント基準）', () => {
      const base = spawnStack([9999, 9999, 9999])
      const baseGap = base[0].y - base[2].y
      for (const amount of [99999, 999999, 9999999]) {
        const r = spawnStack([amount, amount, amount])
        expect(r[0].font).toBeLessThan(base[0].font)
        expect(r[0].y - r[2].y).toBeCloseTo(baseGap, 5)
      }
    })
    it.each([
      [[9999, 9999, 99999]],
      [[99999, 9999, 9999]],
      [[9999, 99999, 9999]],
      [[999999, 9999, 99999, 9999]],
      [[9999, 9999999, 9999, 999999]],
    ])(
      '桁が混在する連続ヒット %j: 段 k の位置 = 段 0 の基準 − k × 基本フォント × 0.85 − 縮小ぶんの中央寄せ（(基本 − 実際) / 2）',
      (amounts) => {
        const r = spawnStack(amounts)
        const base = spawnStack([9999])[0] // 縮まない基準（段 0・4 桁）
        amounts.forEach((_, k) => {
          const expected =
            base.y - k * base.font * POPUP_STACK_STEP - popupCenterOffset(base.font, r[k].font)
          expect(r[k].y).toBeCloseTo(expected, 5)
        })
      }
    )
    it('縮んだ数字（5 桁以上）は同じ段の 4 桁より (基本 − 実際) / 2 だけ上、4 文字以下は 4 桁と完全に同じ位置', () => {
      for (const stack of [0, 1, 3]) {
        const amounts = Array.from({ length: stack + 1 }, () => 9999)
        const ref = spawnStack(amounts)[stack]
        for (const amount of [9, 99, 999]) {
          const a = Array.from({ length: stack + 1 }, () => amount)
          expect(spawnStack(a)[stack].y).toBe(ref.y)
        }
        for (const amount of [99999, 999999, 9999999]) {
          const a = Array.from({ length: stack + 1 }, () => amount)
          const r = spawnStack(a)[stack]
          expect(r.font).toBeLessThan(ref.font)
          expect(ref.y - r.y).toBeCloseTo((ref.font - r.font) / 2, 5)
        }
      }
    })
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

  it('吸収 5 ヒット: 全ヒットの数字が出て、再生後の HP 表示は最終値（hpOverride 空）', () => {
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
      effect: 'damage 20 type=fire 回数=5',
    })
    s.redraw(800, 450)
    expect(engine.getState().events[0].hits.map((h) => h.kind)).toEqual(Array(5).fill('heal'))
    const appear = stepAndRecord(s, 6000)
    expect(appear.filter((a) => a.text === '20')).toHaveLength(5)
    expect((s as unknown as { hpOverride: Map<string, number> }).hpOverride.size).toBe(0)
  })

  it('無効 5 ヒット: MISS が 5 つ出る', () => {
    const { s, engine } = setup([
      entity('slime', {
        atk: 0,
        affinity: { weak: [], halve: [], nullify: ['fire'], absorb: [] },
      }),
    ])
    engine.selectSpell({
      name: 'ほのお',
      mp: 1,
      target: '敵単体',
      effect: 'damage 20 type=fire 回数=5',
    })
    s.redraw(800, 450)
    const appear = stepAndRecord(s, 6000)
    expect(appear.filter((a) => a.text === 'MISS')).toHaveLength(5)
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
