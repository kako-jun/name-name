/** 複数ヒット (#879 P2) の時間割・順次発火・数字の段の純粋関数テスト */
import { describe, it, expect } from 'vitest'
import {
  MULTI_HIT_INTERVAL_MS,
  POPUP_STACK_LEVELS,
  advancePlayback,
  buildActionTimeline,
  emptyPlayback,
  enqueueEvents,
  eventTimeline,
  groupHitsByRound,
  hitRound,
  isPlaybackBusy,
  popupStackIndex,
  RECOIL_MS,
  DOWN_MS,
} from './battleMotion'
import type { BattleActionEvent, BattleHit } from './battleEngine'

const hit = (over: Partial<BattleHit> = {}): BattleHit => ({
  target: { side: 'enemy', index: 0 },
  kind: 'damage',
  amount: 10,
  hpBefore: 100,
  hpAfter: 90,
  ...over,
})
const ev = (hits: BattleHit[], kind: BattleActionEvent['kind'] = 'spell'): BattleActionEvent => ({
  seq: 0,
  actor: { side: 'party', index: 0 },
  kind,
  hits,
})
/** 同じ対象への n 連続ヒット（round 0..n-1、HP が連鎖） */
const chain = (n: number, extra: Partial<BattleHit> = {}): BattleHit[] =>
  Array.from({ length: n }, (_, i) =>
    hit({ round: i, hpBefore: 100 - i * 10, hpAfter: 90 - i * 10, ...extra })
  )

function playAll(event: BattleActionEvent, step: number) {
  let pb = enqueueEvents(emptyPlayback(), [event])
  const log: { round: number; at: number; n: number }[] = []
  let t = 0
  while (isPlaybackBusy(pb) && t < 20000) {
    const r = advancePlayback(pb, step)
    t += step
    pb = r.state
    for (const f of r.fires) log.push({ round: f.round, at: t - f.sinceHit, n: f.hits.length })
  }
  return log
}

describe('eventTimeline: round による延長', () => {
  it('round 無し / 全て 0 は従来と同じ時間割', () => {
    const base = buildActionTimeline('spell', { damages: true })
    expect(eventTimeline(ev([hit()]))).toEqual(base)
    expect(eventTimeline(ev([hit({ round: 0 }), hit({ round: 0 })]))).toEqual(base)
  })

  it('5 ヒットは最後の round ぶん duration が延びる（hitAt は不変）', () => {
    const base = buildActionTimeline('spell', { damages: true })
    const tl = eventTimeline(ev(chain(5)))
    expect(tl.hitAt).toBe(base.hitAt)
    expect(tl.duration).toBe(
      base.hitAt +
        4 * MULTI_HIT_INTERVAL_MS +
        RECOIL_MS +
        (base.duration - (base.hitAt + RECOIL_MS))
    )
  })

  it('倒れる最後のヒットの round から倒れ切りまで確保する', () => {
    const hits = chain(3)
    hits[2] = hit({ round: 2, hpBefore: 10, hpAfter: 0 })
    const tl = eventTimeline(ev(hits, 'attack'))
    const base = buildActionTimeline('attack', { damages: true, downs: true })
    expect(tl.duration).toBeGreaterThanOrEqual(
      tl.hitAt + 2 * MULTI_HIT_INTERVAL_MS + RECOIL_MS + DOWN_MS
    )
    expect(tl.duration).toBeGreaterThanOrEqual(base.duration)
  })
})

describe('hitRound / groupHitsByRound', () => {
  it('負・小数・非有限・未設定は 0 以上の整数', () => {
    expect(hitRound(hit())).toBe(0)
    expect(hitRound(hit({ round: -2 }))).toBe(0)
    expect(hitRound(hit({ round: NaN }))).toBe(0)
    expect(hitRound(hit({ round: 2.9 }))).toBe(2)
  })
  it('round ごとにまとめ、小さい順・同 round は配列順。空は空の組 1 つ', () => {
    const a = hit({ round: 1 })
    const b = hit({ round: 0, target: { side: 'enemy', index: 1 } })
    const c = hit({ round: 0 })
    expect(groupHitsByRound(ev([a, b, c])).map((g) => [g.round, g.hits])).toEqual([
      [0, [b, c]],
      [1, [a]],
    ])
    expect(groupHitsByRound(ev([]))).toEqual([{ round: 0, hits: [] }])
  })
})

describe('advancePlayback: round ごとの順次発火', () => {
  it.each([2, 5, 12])('%i ヒットは hitAt から間隔ごとに 1 回ずつ、順番に発火する', (n) => {
    const tl = eventTimeline(ev(chain(n)))
    const log = playAll(ev(chain(n)), 1)
    expect(log.map((l) => l.round)).toEqual(Array.from({ length: n }, (_, i) => i))
    expect(log.map((l) => l.at)).toEqual(
      Array.from({ length: n }, (_, i) => tl.hitAt + i * MULTI_HIT_INTERVAL_MS)
    )
    expect(log.every((l) => l.n === 1)).toBe(true)
  })

  it('刻みが粗くても取りこぼさず、sinceHit は各 round の命中からの経過', () => {
    const e = ev(chain(5))
    const tl = eventTimeline(e)
    const r = advancePlayback(enqueueEvents(emptyPlayback(), [e]), tl.hitAt + 250)
    expect(r.fires.map((f) => [f.round, f.sinceHit])).toEqual([
      [0, 250],
      [1, 150],
      [2, 50],
    ])
    expect(r.state.active?.firedRounds).toBe(3)
  })

  it('全体対象の N 巡: 同じ round の全員がまとめて発火し、巡の順で並ぶ', () => {
    const hits = [0, 1].flatMap((round) =>
      [0, 1, 2].map((index) => hit({ round, target: { side: 'enemy', index } }))
    )
    const log = playAll(ev(hits), 1)
    expect(log.map((l) => [l.round, l.n])).toEqual([
      [0, 3],
      [1, 3],
    ])
  })

  it('round 無しの従来イベントは 1 回・全 hits・hitAt ちょうどで発火（不変）', () => {
    const e = ev([hit(), hit({ target: { side: 'enemy', index: 1 } })])
    const tl = eventTimeline(e)
    expect(tl).toEqual(buildActionTimeline('spell', { damages: true }))
    const log = playAll(e, 1)
    expect(log).toEqual([{ round: 0, at: tl.hitAt, n: 2 }])
  })

  it('hits が空でも 1 回発火して終わる', () => {
    const log = playAll(ev([]), 1)
    expect(log).toHaveLength(1)
  })

  it('連打: 2 件目は 1 件目の全ヒット・のけぞり完了後（duration 後）に始まる', () => {
    const a = ev(chain(5))
    const b = { ...ev(chain(2)), seq: 1 }
    const tl = eventTimeline(a)
    let pb = enqueueEvents(emptyPlayback(), [a, b])
    const r1 = advancePlayback(pb, tl.duration - 1)
    expect(r1.fires.map((f) => f.event.seq)).toEqual([0, 0, 0, 0, 0])
    expect(r1.state.active?.event.seq).toBe(0)
    pb = r1.state
    const r2 = advancePlayback(pb, 1 + eventTimeline(b).hitAt)
    expect(r2.fires.map((f) => [f.event.seq, f.round])).toEqual([[1, 0]])
  })
})

describe('popupStackIndex: 同じ対象への連続ヒットの段', () => {
  it('単発・別対象は 0、同じ対象は 0,1,2…、上限で最下段へ戻る', () => {
    const hits = chain(POPUP_STACK_LEVELS + 2)
    expect(hits.map((h) => popupStackIndex(hits, h))).toEqual([0, 1, 2, 3, 4, 0, 1])
    const e0 = hit()
    expect(popupStackIndex([e0], e0)).toBe(0)
    const other = hit({ target: { side: 'enemy', index: 1 } })
    expect(popupStackIndex([e0, other], other)).toBe(0)
  })
})

describe('全 round が発火する（heal・miss・混在・大きい round）', () => {
  const roundsOf = (hits: BattleHit[]) => playAll(ev(hits), 1).map((l) => l.round)
  const kindChain = (n: number, kind: BattleHit['kind']) =>
    chain(n).map((h) => ({ ...h, kind, hpBefore: 100, hpAfter: kind === 'heal' ? 100 : 100 }))

  it('吸収 5 ヒット（heal だけ）', () => {
    expect(roundsOf(kindChain(5, 'heal'))).toEqual([0, 1, 2, 3, 4])
  })
  it('無効 5 ヒット（miss だけ）', () => {
    expect(roundsOf(kindChain(5, 'miss'))).toEqual([0, 1, 2, 3, 4])
  })
  it('damage と heal の混在', () => {
    const hits = chain(6).map((h, i) => (i % 2 ? { ...h, kind: 'heal' as const } : h))
    expect(roundsOf(hits)).toEqual([0, 1, 2, 3, 4, 5])
  })
  it('最大 round が大きい', () => {
    const hits = [hit({ round: 0, kind: 'heal' }), hit({ round: 40, kind: 'miss' })]
    expect(roundsOf(hits)).toEqual([0, 40])
    const tl = eventTimeline(ev(hits))
    expect(tl.duration).toBeGreaterThan(tl.hitAt + 40 * MULTI_HIT_INTERVAL_MS)
  })
  it('round なし・全 0 の heal/miss の duration は従来値のまま', () => {
    const base = buildActionTimeline('spell', {})
    expect(eventTimeline(ev([hit({ kind: 'heal' })])).duration).toBe(base.duration)
    expect(eventTimeline(ev([hit({ kind: 'miss', round: 0 })])).duration).toBe(base.duration)
    expect(base.duration).toBe(buildActionTimeline('spell', { lastRound: 0 }).duration)
  })
})

describe('popupStackIndex: 陣営をまたぐ', () => {
  it('同じ index でも party と enemy は別の対象として数える', () => {
    const a = hit({ target: { side: 'party', index: 0 } })
    const b = hit({ target: { side: 'enemy', index: 0 } })
    expect(popupStackIndex([a, b], b)).toBe(0)
  })
})
