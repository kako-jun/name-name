/** BattleScreen の `motion` (#956) の配線: ff の再生・サンプリングが選んだ時間の組 (default / snappy) で動く */
import { afterEach, describe, expect, it } from 'vitest'
import type { Container } from 'pixi.js'
import { BattleScreen, type BattleScreenOptions } from './BattleScreen'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'
import { DEFAULT_MOTION_TIMING, SNAPPY_MOTION_TIMING } from './battleMotion'

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
  partyViews: { container: Container }[]
  playback: { active: { event: { seq: number }; elapsed: number } | null }
}
const I = (s: BattleScreen): Internals => s as unknown as Internals

const created: BattleScreen[] = []
function setup(opts: BattleScreenOptions = {}) {
  const engine = new BattleEngine([entity('hero')], [entity('boss', { atk: 0 })], {
    rng: () => 0.5,
    skills: {},
  })
  const s = new BattleScreen(engine, 800, 450, { layout: 'side', presentation: 'ff', ...opts })
  created.push(s)
  engine.selectAttack()
  ;(s as unknown as { refresh(): void }).refresh()
  return { s, engine, restX: I(s).partyViews[0].container.x }
}
afterEach(() => {
  for (const s of created.splice(0)) s.destroy({ children: true })
})

const S = SNAPPY_MOTION_TIMING
const D = DEFAULT_MOTION_TIMING
const SNAPPY_END = S.attackStepMs + S.attackSlashMs + S.attackReturnMs

/** 1ms 刻みで ms まで進め、味方の前進量（絶対値）を返す */
function advanceTo(h: ReturnType<typeof setup>, ms: number): number {
  for (let t = 0; t < ms; t++) h.s.tick(1)
  return Math.abs(I(h.s).partyViews[0].container.x - h.restX)
}

describe('BattleScreen: motion の配線 (#956)', () => {
  it('snappy: 味方の攻撃のずれは snappy の踏み出し端で最大になり、戻り端で 0 に戻る', () => {
    const h = setup({ motion: 'snappy' })
    const peak = advanceTo(h, S.attackStepMs)
    expect(peak).toBeGreaterThan(0)
    const end = advanceTo(h, SNAPPY_END - S.attackStepMs)
    expect(end).toBeCloseTo(0, 6)
  })

  it('default（未指定も同じ）: 同じ時刻ではまだ戻りきっていない', () => {
    for (const opts of [{ motion: 'default' as const }, {}]) {
      const h = setup(opts)
      expect(advanceTo(h, SNAPPY_END)).toBeGreaterThan(1)
    }
  })

  it('snappy の踏み出しは default より距離が短い（同じ踏み出し端でなく各端の最大で比べる）', () => {
    const sn = advanceTo(setup({ motion: 'snappy' }), S.attackStepMs)
    const df = advanceTo(setup({ motion: 'default' }), D.attackStepMs)
    expect(sn).toBeLessThan(df)
  })

  it('再生の進行も snappy の長さ: 行動の終わり（+行動間）で次の行動へ移る。default はまだ同じ行動', () => {
    const firstSeq = (h: ReturnType<typeof setup>) => h.engine.getState().events[0].seq
    const sn = setup({ motion: 'snappy' })
    const seq = firstSeq(sn)
    sn.s.tick(1)
    expect(I(sn.s).playback.active?.event.seq).toBe(seq)
    const dur = SNAPPY_END + S.actionGapMs
    advanceTo(sn, dur + 20)
    const a = I(sn.s).playback.active
    expect(a === null || a.event.seq !== seq).toBe(true)

    const df = setup({ motion: 'default' })
    advanceTo(df, dur + 20)
    expect(I(df.s).playback.active?.event.seq).toBe(firstSeq(df))
  })
})
