import { describe, it, expect, vi } from 'vitest'
import {
  ACTION_GAP_MS,
  ATTACK_RETURN_MS,
  ATTACK_SLASH_HIT_MS,
  ATTACK_SLASH_MS,
  ATTACK_STEP_DISTANCE,
  ATTACK_STEP_MS,
  BATTLE_MOTION_PRESETS,
  DEFAULT_MOTION_TIMING,
  POPUP_TOTAL_MS,
  RECOIL_DISTANCE,
  RECOIL_MS,
  SNAPPY_MOTION_TIMING,
  advancePlayback,
  buildActionTimeline,
  enqueueEvents,
  emptyPlayback,
  eventTimeline,
  motionTimingFor,
  normalizeBattleMotion,
  multiHitIntervalFor,
  sampleActor,
  sampleDamagePopup,
  sampleSummonCue,
  sampleTarget,
  type MotionTiming,
} from './battleMotion'
import type { BattleActionEvent } from './battleEngine'
import { planEventEffects, type BattleEffectSheet } from './battleEffects'

const attackEvent = (seq: number, hpAfter = 3): BattleActionEvent => ({
  seq,
  actor: { side: 'party', index: 0 },
  kind: 'attack',
  hits: [{ target: { side: 'enemy', index: 0 }, kind: 'damage', amount: 7, hpBefore: 10, hpAfter }],
})

describe('MotionTiming: default は現行値と一致 (#956)', () => {
  it('個別定数・既定引数と同じ値', () => {
    expect(BATTLE_MOTION_PRESETS.default).toBe(DEFAULT_MOTION_TIMING)
    expect(DEFAULT_MOTION_TIMING.attackStepMs).toBe(220)
    expect(DEFAULT_MOTION_TIMING.attackSlashMs).toBe(180)
    expect(DEFAULT_MOTION_TIMING.attackReturnMs).toBe(220)
    expect(DEFAULT_MOTION_TIMING.attackStepDistance).toBe(0.7)
    expect(DEFAULT_MOTION_TIMING.actionGapMs).toBe(120)
    expect(DEFAULT_MOTION_TIMING.recoilMs).toBe(260)
    expect(DEFAULT_MOTION_TIMING.downMs).toBe(320)
    expect(DEFAULT_MOTION_TIMING.recoilDistance).toBe(0.12)
    expect(DEFAULT_MOTION_TIMING.multiHitIntervalMs).toBe(100)
    expect(ATTACK_STEP_MS).toBe(220)
    expect(ATTACK_SLASH_MS).toBe(180)
    expect(ATTACK_RETURN_MS).toBe(220)
    expect(ATTACK_SLASH_HIT_MS).toBe(70)
    expect(ATTACK_STEP_DISTANCE).toBe(0.7)
    expect(ACTION_GAP_MS).toBe(120)
    expect(POPUP_TOTAL_MS).toBe(260 + 160 + 240 + 200)
  })

  it('timing を明示した default は引数省略と同じ結果', () => {
    const d = DEFAULT_MOTION_TIMING
    for (let t = 0; t <= 700; t += 13) {
      expect(sampleActor('attack', t, d)).toEqual(sampleActor('attack', t))
      expect(sampleTarget('damage', t, true, d)).toEqual(sampleTarget('damage', t, true))
      expect(sampleDamagePopup(t, d)).toEqual(sampleDamagePopup(t))
    }
    const ev = attackEvent(1, 0)
    expect(eventTimeline(ev, d)).toEqual(eventTimeline(ev))
    expect(buildActionTimeline('spell', { damages: true }, d)).toEqual(
      buildActionTimeline('spell', { damages: true })
    )
  })
})

describe('MotionTiming: snappy (#956)', () => {
  const S = SNAPPY_MOTION_TIMING
  const D = DEFAULT_MOTION_TIMING

  it('踏み出し・戻りは 120〜150ms、行動間・距離・のけぞりは default より小さい', () => {
    expect(S.attackStepMs).toBeGreaterThanOrEqual(120)
    expect(S.attackStepMs).toBeLessThanOrEqual(150)
    expect(S.attackReturnMs).toBeGreaterThanOrEqual(120)
    expect(S.attackReturnMs).toBeLessThanOrEqual(150)
    expect(S.attackReturnEase).toBe('outQuad')
    expect(S.actionGapMs).toBeLessThan(D.actionGapMs)
    expect(S.attackStepDistance).toBeLessThan(D.attackStepDistance)
    expect(S.recoilDistance).toBeLessThan(D.recoilDistance)
  })

  it('行動 1 回の長さが default より短い（攻撃・呪文・召喚・知らせ・複数ヒット）', () => {
    const kinds = ['attack', 'spell', 'item', 'skill', 'status', 'notice'] as const
    for (const k of kinds) {
      const opts = { damages: true, downs: true }
      expect(buildActionTimeline(k, opts, S).duration).toBeLessThan(
        buildActionTimeline(k, opts, D).duration
      )
    }
    const sum = { summon: true, damages: true }
    expect(buildActionTimeline('skill', sum, S).duration).toBeLessThan(
      buildActionTimeline('skill', sum, D).duration
    )
    expect(buildActionTimeline('skill', sum, S).hitAt).toBe(S.summonHitMs)
    expect(buildActionTimeline('attack', {}, S).hitAt).toBe(S.attackStepMs + S.attackSlashHitMs)
    expect(buildActionTimeline('spell', {}, S).hitAt).toBe(S.castHitMs)
    expect(buildActionTimeline('status', {}, S).hitAt).toBe(S.statusHitMs)
    const multi = { damages: true, lastDamageRound: 5, lastRound: 5 }
    const ts = buildActionTimeline('attack', multi, S)
    const td = buildActionTimeline('attack', multi, D)
    expect(ts.duration).toBeLessThan(td.duration)
    expect(ts.hitInterval).toBeLessThan(td.hitInterval)
  })

  it('攻撃は 0→最大→0 を踏み、踏み出し端・斬り・戻り端の境界で端点に一致する', () => {
    expect(sampleActor('attack', 0, S)).toEqual({ forward: 0, pose: 'step' })
    const peak = sampleActor('attack', S.attackStepMs, S)
    expect(peak).toEqual({ forward: S.attackStepDistance, pose: 'slash' })
    expect(sampleActor('attack', S.attackStepMs + S.attackSlashMs - 1, S).pose).toBe('slash')
    const retStart = S.attackStepMs + S.attackSlashMs
    expect(sampleActor('attack', retStart, S).forward).toBeCloseTo(S.attackStepDistance, 10)
    const end = retStart + S.attackReturnMs
    expect(sampleActor('attack', end, S)).toEqual({ forward: 0, pose: 'idle' })
    // 戻りは単調減少、踏み出しは単調増加
    let prev = -1
    for (let t = 0; t <= S.attackStepMs; t += 5) {
      const f = sampleActor('attack', t, S).forward
      expect(f).toBeGreaterThanOrEqual(prev)
      prev = f
    }
    prev = Infinity
    for (let t = retStart; t <= end; t += 5) {
      const f = sampleActor('attack', t, S).forward
      expect(f).toBeLessThanOrEqual(prev)
      prev = f
    }
  })

  it('戻りは easeOutQuad: 戻りの中間点で default（inOut）より先に戻っている', () => {
    // 比で比べる（距離が違うため）。outQuad は中間で 0.75 戻る＝残り 0.25、inOut は 0.5
    const mid = (T: MotionTiming) =>
      sampleActor('attack', T.attackStepMs + T.attackSlashMs + T.attackReturnMs / 2, T).forward /
      T.attackStepDistance
    expect(mid(S)).toBeCloseTo(0.25, 5)
    expect(mid(D)).toBeCloseTo(0.5, 5)
  })

  it('のけぞり・倒れ・ポップアップが timing の長さで終わる', () => {
    expect(sampleTarget('damage', S.recoilMs / 2, false, S).recoil).toBeCloseTo(S.recoilDistance, 5)
    const after = sampleTarget('damage', S.recoilMs, false, S)
    expect(after.recoil).toBeCloseTo(0, 10)
    expect(after.pose).toBe('idle')
    expect(sampleTarget('damage', S.recoilMs + S.downMs, true, S).downProgress).toBe(1)
    expect(sampleTarget('damage', S.recoilMs + S.downMs / 2, true, S).downProgress).toBeLessThan(1)
    const total = S.popupArc1Ms + S.popupArc2Ms + S.popupHoldMs + S.popupFadeMs
    expect(total).toBeLessThan(POPUP_TOTAL_MS)
    expect(sampleDamagePopup(total - 1, S).done).toBe(false)
    expect(sampleDamagePopup(total, S).done).toBe(true)
    // default のままなら同じ時刻ではまだ終わっていない
    expect(sampleDamagePopup(total, D).done).toBe(false)
    expect(RECOIL_DISTANCE).toBe(D.recoilDistance)
    expect(RECOIL_MS).toBe(D.recoilMs)
  })

  it('advancePlayback に timing を渡すと、同じ dt で default より先に次の行動へ進む', () => {
    const run = (T: MotionTiming) => {
      let pb = enqueueEvents(emptyPlayback(), [attackEvent(1), attackEvent(2)])
      pb = advancePlayback(pb, eventTimeline(attackEvent(1), S).duration + 1, T).state
      return pb.queue.length
    }
    // snappy: 1 つめが終わり 2 つめが active（queue 0）。default: まだ 1 つめ（queue 1）
    expect(run(S)).toBe(0)
    expect(run(D)).toBe(1)
  })
})

describe('normalizeBattleMotion / motionTimingFor (#956)', () => {
  it.each([
    ['snappy', 'snappy'],
    [' SNAPPY ', 'snappy'],
    ['default', 'default'],
    ['', 'default'],
    [null, 'default'],
    [undefined, 'default'],
  ])('%j → %s（警告なし）', (raw, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(normalizeBattleMotion(raw)).toBe(expected)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('不正値は警告して default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(normalizeBattleMotion('turbo')).toBe('default')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('プリセット名から時間の組を引く（未指定は default）', () => {
    expect(motionTimingFor('snappy')).toBe(SNAPPY_MOTION_TIMING)
    expect(motionTimingFor('default')).toBe(DEFAULT_MOTION_TIMING)
    expect(motionTimingFor(undefined)).toBe(DEFAULT_MOTION_TIMING)
  })
})

describe('MotionTiming: 各関数に timing が通る（配線） (#956)', () => {
  const S = SNAPPY_MOTION_TIMING
  const D = DEFAULT_MOTION_TIMING
  const sheet: BattleEffectSheet = {
    image: 'a.png',
    frames: 2,
    columns: 2,
    frameMs: 100,
    anchor: 'center',
    scale: 1,
  }

  it('planEventEffects: ヒットの時刻は渡した timing の命中時刻（省略は default）', () => {
    const ev = attackEvent(1)
    const effects = { slash: sheet }
    expect(planEventEffects(ev, effects, S)[0].atMs).toBe(S.attackStepMs + S.attackSlashHitMs)
    expect(planEventEffects(ev, effects, D)[0].atMs).toBe(D.attackStepMs + D.attackSlashHitMs)
    expect(planEventEffects(ev, effects)[0].atMs).toBe(D.attackStepMs + D.attackSlashHitMs)
  })

  it('planEventEffects: 召喚の命中は summonHitMs、複数ヒットは snappy の間隔で並ぶ', () => {
    const summon: BattleActionEvent = {
      seq: 1,
      actor: { side: 'party', index: 0 },
      kind: 'skill',
      summon: { id: 'S1', name: 'x' },
      hits: [
        { target: { side: 'enemy', index: 0 }, kind: 'damage', amount: 5, hpBefore: 9, hpAfter: 4 },
      ],
    }
    const plans = planEventEffects(summon, { summon: sheet, magic: sheet }, S)
    expect(plans.find((p) => p.kind === 'magic')?.atMs).toBe(S.summonHitMs)

    const multi: BattleActionEvent = {
      seq: 2,
      actor: { side: 'party', index: 0 },
      kind: 'spell',
      hits: [0, 1, 2].map((round) => ({
        target: { side: 'enemy' as const, index: 0 },
        kind: 'damage' as const,
        amount: 5,
        hpBefore: 99,
        hpAfter: 90,
        round,
      })),
    }
    const at = planEventEffects(multi, { magic: sheet }, S).map((p) => p.atMs)
    expect(at).toEqual([0, 1, 2].map((r) => S.castHitMs + r * S.multiHitIntervalMs))
  })

  it('sampleSummonCue: 登場・保持・退場の長さは渡した timing', () => {
    const total = S.summonAppearMs + S.summonHoldMs + S.summonLeaveMs
    expect(sampleSummonCue(S.summonAppearMs, S)).toEqual({ alpha: 1, veil: 1, rise: 0 })
    expect(sampleSummonCue(S.summonAppearMs + S.summonHoldMs, S).alpha).toBe(1)
    expect(sampleSummonCue(total, S).alpha).toBe(0)
    // default ではまだ登場の途中の時刻
    expect(sampleSummonCue(S.summonAppearMs, D).alpha).toBeLessThan(1)
    expect(sampleSummonCue(total, D).alpha).toBeGreaterThan(0)
  })

  it('multiHitIntervalFor: 総時間・下限は渡した timing（22 ヒット超で縮む）', () => {
    expect(multiHitIntervalFor(5, S)).toBe(S.multiHitIntervalMs)
    expect(multiHitIntervalFor(30, S)).toBe(S.multiHitTotalMs / 30)
    expect(multiHitIntervalFor(30, D)).toBeCloseTo(D.multiHitTotalMs / 30, 10)
    expect(multiHitIntervalFor(30, S)).not.toBe(multiHitIntervalFor(30, D))
    expect(multiHitIntervalFor(5000, S)).toBe(S.multiHitMinIntervalMs)
  })
})
