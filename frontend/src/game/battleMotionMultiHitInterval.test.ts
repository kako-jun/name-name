/** 多ヒットの表示間隔の自動調整 (#879): 総時間が約 2 秒に収まる・従来値は不変 */
import { describe, it, expect } from 'vitest'
import {
  MULTI_HIT_INTERVAL_MS,
  MULTI_HIT_MIN_INTERVAL_MS,
  MULTI_HIT_TOTAL_MS,
  advancePlayback,
  buildActionTimeline,
  emptyPlayback,
  enqueueEvents,
  eventTimeline,
  isPlaybackBusy,
  multiHitIntervalFor,
  popupStackIndex,
  RECOIL_MS,
  DOWN_MS,
} from './battleMotion'
import { MAX_HITS_PER_ACTION } from './battleLimits'
import type { BattleActionEvent, BattleHit } from './battleEngine'

const hit = (over: Partial<BattleHit> = {}): BattleHit => ({
  target: { side: 'enemy', index: 0 },
  kind: 'damage',
  amount: 10,
  hpBefore: 100000,
  hpAfter: 99990,
  ...over,
})
const ev = (hits: BattleHit[], kind: BattleActionEvent['kind'] = 'spell'): BattleActionEvent => ({
  seq: 0,
  actor: { side: 'party', index: 0 },
  kind,
  hits,
})
const chain = (n: number, extra: Partial<BattleHit> = {}): BattleHit[] =>
  Array.from({ length: n }, (_, i) => hit({ round: i, ...extra }))

function fireLog(event: BattleActionEvent, step: number) {
  let pb = enqueueEvents(emptyPlayback(), [event])
  const log: { round: number; at: number }[] = []
  let t = 0
  while (isPlaybackBusy(pb) && t < 60000) {
    const r = advancePlayback(pb, step)
    t += step
    pb = r.state
    for (const f of r.fires) log.push({ round: f.round, at: t - f.sinceHit })
  }
  return log
}

describe('multiHitIntervalFor: min(基本, 総時間 / 最大 round)', () => {
  it('定数（暫定）', () => {
    expect(MULTI_HIT_INTERVAL_MS).toBe(100)
    expect(MULTI_HIT_TOTAL_MS).toBe(2000)
    expect(MULTI_HIT_MIN_INTERVAL_MS).toBe(10)
  })
  it('最大 round 0（単発）・少ヒットは基本値 100 のまま', () => {
    expect(multiHitIntervalFor(0)).toBe(100)
    expect(multiHitIntervalFor(NaN)).toBe(100)
    expect(multiHitIntervalFor(-3)).toBe(100)
    expect(multiHitIntervalFor(1)).toBe(100)
    expect(multiHitIntervalFor(4)).toBe(100)
    expect(multiHitIntervalFor(19)).toBe(100)
  })
  it('境界: 最大 round 20（21 ヒット）でちょうど 2000ms。±1', () => {
    expect(multiHitIntervalFor(20)).toBe(100)
    expect(20 * multiHitIntervalFor(20)).toBe(2000)
    expect(multiHitIntervalFor(21)).toBeCloseTo(2000 / 21, 10)
    expect(multiHitIntervalFor(21)).toBeLessThan(100)
  })
  it('最大 round 98（99 ヒット）は約 20.4ms で総時間 2000ms。下限は効かない', () => {
    expect(MAX_HITS_PER_ACTION).toBe(99)
    const i = multiHitIntervalFor(MAX_HITS_PER_ACTION - 1)
    expect(i).toBeCloseTo(2000 / 98, 10)
    expect(i).toBeGreaterThan(MULTI_HIT_MIN_INTERVAL_MS)
    expect((MAX_HITS_PER_ACTION - 1) * i).toBeCloseTo(2000, 6)
  })
  it('下限: 上限を超える最大 round でも間隔は 10ms を割らない', () => {
    expect(multiHitIntervalFor(1000)).toBe(10)
    expect(multiHitIntervalFor(100000)).toBe(10)
  })
})

describe('従来の再生は完全に不変（リテラル固定）', () => {
  it.each([1, 2, 5, 20, 21])('%i ヒットの発火時刻は 400 + 100 * round', (n) => {
    const log = fireLog(ev(chain(n)), 1)
    expect(log.map((l) => l.at)).toEqual(Array.from({ length: n }, (_, i) => 400 + i * 100))
    expect(eventTimeline(ev(chain(n))).hitInterval).toBe(100)
  })
  it('5 ヒットの duration は従来値（400 + 4*100 + 260 のけぞり, 仕上げは CAST 560 + 120）', () => {
    // のけぞり終了 400+400+260=1060 > CAST_MS 560 なので 1060 + 120
    expect(eventTimeline(ev(chain(5))).duration).toBe(1180)
  })
  it('21 ヒット（境界）の duration は従来値: 400 + 2000 + 260 + 120', () => {
    expect(eventTimeline(ev(chain(21))).duration).toBe(2780)
  })
  it('round なし・全 0 は従来の時間割', () => {
    const base = buildActionTimeline('spell', { damages: true })
    expect(eventTimeline(ev([hit()]))).toEqual(base)
    expect(eventTimeline(ev([hit({ round: 0 }), hit({ round: 0 })]))).toEqual(base)
    expect(base.duration).toBe(780) // CAST_HIT 400 + RECOIL 260 + GAP 120
    expect(base.hitInterval).toBe(100)
  })
})

describe('多ヒットは最後の命中まで約 2 秒に収まる', () => {
  it.each([22, 40, 99])('%i ヒット: 最後の round の発火は hitAt + 2000ms', (n) => {
    const e = ev(chain(n))
    const tl = eventTimeline(e)
    expect(tl.hitInterval).toBeCloseTo(2000 / (n - 1), 10)
    const log = fireLog(e, 1)
    expect(log).toHaveLength(n)
    expect(log.map((l) => l.round)).toEqual(Array.from({ length: n }, (_, i) => i))
    const span = log[n - 1].at - log[0].at
    // 1ms 刻みの再生なので ±1ms
    expect(Math.abs(span - 2000)).toBeLessThanOrEqual(1)
    // 隣り合う発火は単調増加
    for (let i = 1; i < n; i++) expect(log[i].at).toBeGreaterThanOrEqual(log[i - 1].at)
  })

  it('99 ヒットの行動全体は最後の命中 + のけぞり + 間（約 2.8 秒）で、9.9 秒にならない', () => {
    const tl = eventTimeline(ev(chain(99)))
    expect(tl.duration).toBe(400 + 2000 + 260 + 120)
  })

  it('全 round が発火する: 吸収(heal)・無効(miss)・damage の混在でも 99 ヒット', () => {
    const kinds: BattleHit['kind'][] = ['damage', 'heal', 'miss']
    const hits = Array.from({ length: 99 }, (_, i) =>
      hit({
        round: i,
        kind: kinds[i % 3],
        hpBefore: 50,
        hpAfter: kinds[i % 3] === 'heal' ? 60 : 50,
      })
    )
    const log = fireLog(ev(hits), 7) // 粗い刻みでも取りこぼさない
    expect(log.map((l) => l.round)).toEqual(Array.from({ length: 99 }, (_, i) => i))
  })

  it('heal だけ・miss だけの 30 ヒットも最後の round の命中まで行動が終わらない', () => {
    for (const kind of ['heal', 'miss'] as const) {
      const e = ev(chain(30, { kind }))
      const tl = eventTimeline(e)
      expect(tl.duration).toBeGreaterThanOrEqual(400 + 2000 + 120)
      expect(fireLog(e, 1)).toHaveLength(30)
    }
  })

  it('倒れる最後のヒットでも倒れ切りまで確保（99 ヒット目で HP 0）', () => {
    const hits = chain(99)
    hits[98] = hit({ round: 98, hpBefore: 10, hpAfter: 0 })
    const tl = eventTimeline(ev(hits, 'attack'))
    expect(tl.duration).toBeGreaterThanOrEqual(tl.hitAt + 2000 + RECOIL_MS + DOWN_MS)
  })
})

describe('連打時の次の行動の開始・数字の段', () => {
  it('99 ヒットの次の行動は、前の行動の duration の直後に始まる', () => {
    const a = ev(chain(99))
    const b = { ...ev([hit()]), seq: 1 }
    const tlA = eventTimeline(a)
    let pb = enqueueEvents(emptyPlayback(), [a, b])
    pb = advancePlayback(pb, tlA.duration - 1).state
    expect(pb.active?.event.seq).toBe(0)
    pb = advancePlayback(pb, 6).state // 1ms で前の行動が終わり、残り 5ms は次の行動へ繰り越す
    expect(pb.active?.event.seq).toBe(1)
    expect(pb.active?.elapsed).toBe(5)
  })

  it('同じ対象への数字の段（popupStackIndex）は間隔の自動調整に影響されない', () => {
    const hits = chain(99)
    expect(hits.map((h) => popupStackIndex(hits, h))).toEqual(
      Array.from({ length: 99 }, (_, i) => i % 5)
    )
  })
})
