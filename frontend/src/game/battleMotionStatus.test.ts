/** 状態異常 (#870) の継続ダメージ・満了の演出（`kind: 'status'`）: 本人は動かず、数字だけが出る */
import { describe, it, expect } from 'vitest'
import {
  ACTION_GAP_MS,
  DOWN_MS,
  RECOIL_MS,
  STATUS_HIT_MS,
  STATUS_MS,
  advancePlayback,
  buildActionTimeline,
  emptyPlayback,
  enqueueEvents,
  eventTimeline,
  sampleActor,
} from './battleMotion'
import type { BattleActionEvent } from './battleEngine'

const tick = (amount: number, hpAfter = 90): BattleActionEvent => ({
  seq: 0,
  actor: { side: 'party', index: 0 },
  kind: 'status',
  label: 'どく',
  hits: [{ target: { side: 'party', index: 0 }, kind: 'damage', amount, hpBefore: 100, hpAfter }],
})

describe('status イベントの時間割と動き', () => {
  it('本人は動かない（踏み出しも構えもしない）', () => {
    for (const t of [0, 100, 400, 2000]) {
      expect(sampleActor('status', t)).toEqual({ forward: 0, pose: 'idle' })
    }
  })

  it('命中は STATUS_HIT_MS。のけぞりが終わるまで待つが、最短でも STATUS_MS', () => {
    const tl = eventTimeline(tick(10))
    expect(tl.hitAt).toBe(STATUS_HIT_MS)
    expect(tl.duration).toBe(Math.max(STATUS_MS, STATUS_HIT_MS + RECOIL_MS) + ACTION_GAP_MS)
    // 回復（吸収）だけの継続ダメージも、状態名と数字を読める最短の長さを持つ
    const heal: BattleActionEvent = {
      ...tick(10),
      hits: [
        {
          target: { side: 'party', index: 0 },
          kind: 'heal',
          amount: 10,
          hpBefore: 90,
          hpAfter: 100,
        },
      ],
    }
    expect(eventTimeline(heal).duration).toBe(STATUS_MS + ACTION_GAP_MS)
  })

  it('倒れる場合（満了の戦闘不能・継続ダメージで HP 0）は倒れ切るまで含める', () => {
    const tl = eventTimeline(tick(100, 0))
    expect(tl.duration).toBe(STATUS_HIT_MS + RECOIL_MS + DOWN_MS + ACTION_GAP_MS)
  })

  it('他の kind の時間割は変わらない（attack / spell / notice）', () => {
    expect(buildActionTimeline('spell', { damages: true }).hitAt).toBe(400)
    expect(buildActionTimeline('notice').hitAt).toBe(0)
  })

  it('再生: 命中の瞬間に数字（damage）が 1 件発火し、全部終われば空になる', () => {
    let pb = enqueueEvents(emptyPlayback(), [tick(10)])
    let fired = 0
    for (let t = 0; t < 2000; t += 50) {
      const r = advancePlayback(pb, 50)
      pb = r.state
      fired += r.fires.reduce((n, f) => n + f.hits.length, 0)
    }
    expect(fired).toBe(1)
    expect(pb.active).toBeNull()
    expect(pb.queue).toHaveLength(0)
  })
})
