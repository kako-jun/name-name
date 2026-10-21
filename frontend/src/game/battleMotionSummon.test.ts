/** 召喚獣の登場 (#750) の時間割と見え方: 召喚の行動は長くなり命中が遅れる。登場の演出なしの時間割は従来と同じ */
import { describe, expect, it } from 'vitest'
import type { BattleActionEvent } from './battleEngine'
import {
  ACTION_GAP_MS,
  CAST_HIT_MS,
  CAST_MS,
  SUMMON_APPEAR_MS,
  SUMMON_HIT_MS,
  SUMMON_HOLD_MS,
  SUMMON_LEAVE_MS,
  SUMMON_MS,
  RECOIL_MS,
  buildActionTimeline,
  eventTimeline,
  sampleSummonCue,
} from './battleMotion'

const ev = (over: Partial<BattleActionEvent> = {}): BattleActionEvent => ({
  seq: 0,
  actor: { side: 'party', index: 0 },
  kind: 'skill',
  label: 'x',
  hits: [
    {
      target: { side: 'enemy', index: 0 },
      kind: 'damage',
      amount: 5,
      hpBefore: 10,
      hpAfter: 5,
    },
  ],
  ...over,
})

describe('時間割', () => {
  it('登場の長さの定数は 3 つの段の合計', () => {
    expect(SUMMON_MS).toBe(SUMMON_APPEAR_MS + SUMMON_HOLD_MS + SUMMON_LEAVE_MS)
    // 命中は絵が出そろってから、登場の終わりまでの間
    expect(SUMMON_HIT_MS).toBeGreaterThanOrEqual(SUMMON_APPEAR_MS)
    expect(SUMMON_HIT_MS).toBeLessThan(SUMMON_MS)
  })
  it('summon つきの skill は登場の長さ・命中の瞬間が召喚用になる', () => {
    const t = eventTimeline(ev({ summon: { id: 'a', name: 'b' } }))
    expect(t.hitAt).toBe(SUMMON_HIT_MS)
    // のけぞりが登場の終わりより遅く終わるならそちらまで待つ（ここでは命中 + のけぞり < 登場の終わり）
    expect(t.duration).toBe(Math.max(SUMMON_MS, SUMMON_HIT_MS + RECOIL_MS) + ACTION_GAP_MS)
  })
  it('summon の無い skill は従来どおり（構えの長さ・命中）', () => {
    const t = eventTimeline(ev())
    expect(t.hitAt).toBe(CAST_HIT_MS)
    expect(t.duration).toBe(Math.max(CAST_MS, CAST_HIT_MS + RECOIL_MS) + ACTION_GAP_MS)
  })
  it('summon は skill 以外には効かない（buildActionTimeline の summon を無視）', () => {
    for (const kind of ['attack', 'spell', 'item', 'notice', 'status'] as const) {
      expect(buildActionTimeline(kind, { summon: true })).toEqual(buildActionTimeline(kind))
    }
  })
  it('効果の無い召喚（hits なし）でも登場の長さぶん続く', () => {
    expect(eventTimeline(ev({ hits: [], summon: { id: 'a', name: 'b' } })).duration).toBe(
      SUMMON_MS + ACTION_GAP_MS
    )
  })
})

describe('sampleSummonCue', () => {
  it('開始は透明、出そろうまでに 1、そのあと保って、退場で 0 へ戻る', () => {
    expect(sampleSummonCue(0)).toMatchObject({ alpha: 0, veil: 0 })
    expect(sampleSummonCue(SUMMON_APPEAR_MS)).toEqual({ alpha: 1, veil: 1, rise: 0 })
    expect(sampleSummonCue(SUMMON_APPEAR_MS + SUMMON_HOLD_MS / 2)).toEqual({
      alpha: 1,
      veil: 1,
      rise: 0,
    })
    const mid = sampleSummonCue(SUMMON_MS - SUMMON_LEAVE_MS / 2)
    expect(mid.alpha).toBeCloseTo(0.5, 5)
    expect(sampleSummonCue(SUMMON_MS)).toEqual({ alpha: 0, veil: 0, rise: 0 })
  })
  it('登場の間は単調にフェードイン（rise は 0 へ落ち着く）', () => {
    let prev = -1
    for (let t = 0; t <= SUMMON_APPEAR_MS; t += 20) {
      const s = sampleSummonCue(t)
      expect(s.alpha).toBeGreaterThanOrEqual(prev)
      expect(s.rise).toBeGreaterThanOrEqual(0)
      prev = s.alpha
    }
  })
  it('範囲外・非有限は端に丸める', () => {
    expect(sampleSummonCue(-100)).toMatchObject({ alpha: 0 })
    expect(sampleSummonCue(1e9)).toMatchObject({ alpha: 0 })
    expect(sampleSummonCue(Number.NaN)).toMatchObject({ alpha: 0 })
    expect(sampleSummonCue(Number.POSITIVE_INFINITY)).toMatchObject({ alpha: 0 })
  })
})
