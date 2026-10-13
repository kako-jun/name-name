import { describe, it, expect } from 'vitest'
import {
  ACTION_GAP_MS,
  ATTACK_RETURN_MS,
  ATTACK_SLASH_HIT_MS,
  ATTACK_SLASH_MS,
  ATTACK_STEP_DISTANCE,
  ATTACK_STEP_MS,
  CAST_HIT_MS,
  CAST_MS,
  DOWN_MS,
  FALLEN,
  POPUP_TOTAL_MS,
  RECOIL_DISTANCE,
  RECOIL_MS,
  STANDING,
  advancePlayback,
  buildActionTimeline,
  emptyPlayback,
  enqueueEvents,
  isPlaybackBusy,
  messageWindowText,
  normalizeBattlePresentation,
  normalizePoses,
  popupFontSize,
  popupText,
  resolvePose,
  restingSample,
  sampleActor,
  sampleDamagePopup,
  sampleTarget,
} from './battleMotion'
import type { BattleActionEvent } from './battleEngine'

const attackEvent = (seq: number): BattleActionEvent => ({
  seq,
  actor: { side: 'party', index: 0 },
  kind: 'attack',
  hits: [
    {
      target: { side: 'enemy', index: 0 },
      kind: 'damage',
      amount: 7,
      hpBefore: 10,
      hpAfter: 3,
    },
  ],
})

describe('normalizeBattlePresentation', () => {
  it.each([
    ['ff', 'ff'],
    [' FF ', 'ff'],
    ['dq', 'dq'],
    ['', 'dq'],
    [null, 'dq'],
    [undefined, 'dq'],
    ['xx', 'dq'],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeBattlePresentation(raw)).toBe(expected)
  })
})

describe('normalizePoses / resolvePose', () => {
  it('既知のポーズ名で値が空でないものだけ残し、無ければ undefined', () => {
    expect(normalizePoses({ idle: 'a.png', Step: ' b.png ', bogus: 'x.png', hurt: ' ' })).toEqual({
      idle: 'a.png',
      step: 'b.png',
    })
    expect(normalizePoses({ bogus: 'x' })).toBeUndefined()
    expect(normalizePoses(undefined)).toBeUndefined()
  })

  it('指定の無いポーズは近い絵に落とす。down は代替しない', () => {
    expect(resolvePose('slash', { idle: 1, step: 2 })).toEqual({ pose: 'step', value: 2 })
    expect(resolvePose('hurt', { idle: 1 })).toEqual({ pose: 'idle', value: 1 })
    expect(resolvePose('down', { idle: 1 })).toBeNull()
    expect(resolvePose('idle', {})).toBeNull()
  })
})

describe('sampleActor（攻撃は踏み出し→斬り→戻り）', () => {
  it('踏み出しで前へ出て、斬りで最大、戻りで 0 に戻る', () => {
    expect(sampleActor('attack', 0)).toEqual({ forward: 0, pose: 'step' })
    const mid = sampleActor('attack', ATTACK_STEP_MS / 2)
    expect(mid.pose).toBe('step')
    expect(mid.forward).toBeGreaterThan(0)
    expect(mid.forward).toBeLessThan(ATTACK_STEP_DISTANCE)
    expect(sampleActor('attack', ATTACK_STEP_MS + 1)).toEqual({
      forward: ATTACK_STEP_DISTANCE,
      pose: 'slash',
    })
    const back = ATTACK_STEP_MS + ATTACK_SLASH_MS + ATTACK_RETURN_MS / 2
    expect(sampleActor('attack', back).forward).toBeCloseTo(ATTACK_STEP_DISTANCE / 2, 5)
    expect(sampleActor('attack', ATTACK_STEP_MS + ATTACK_SLASH_MS + ATTACK_RETURN_MS)).toEqual({
      forward: 0,
      pose: 'idle',
    })
  })

  it('呪文・アイテムは動かず構え（ready）', () => {
    expect(sampleActor('spell', 100)).toEqual({ forward: 0, pose: 'ready' })
    expect(sampleActor('item', CAST_MS + 1)).toEqual({ forward: 0, pose: 'idle' })
  })
})

describe('sampleTarget', () => {
  it('命中前は立っている。damage でなければ動かない', () => {
    expect(sampleTarget('damage', -1, true)).toEqual(STANDING)
    expect(sampleTarget('heal', 50, false)).toEqual(STANDING)
    expect(sampleTarget('miss', 50, false)).toEqual(STANDING)
  })

  it('のけぞりは山なりで元の位置へ戻る（点滅はしない＝姿勢だけ）', () => {
    const peak = sampleTarget('damage', RECOIL_MS / 2, false)
    expect(peak.recoil).toBeCloseTo(RECOIL_DISTANCE, 5)
    expect(peak.pose).toBe('hurt')
    const end = sampleTarget('damage', RECOIL_MS, false)
    expect(end.recoil).toBeCloseTo(0, 5)
    expect(end.pose).toBe('idle')
  })

  it('HP 0 はのけぞりのあと倒れ切る', () => {
    expect(sampleTarget('damage', RECOIL_MS - 1, true).downProgress).toBe(0)
    expect(sampleTarget('damage', RECOIL_MS + DOWN_MS / 2, true).downProgress).toBeGreaterThan(0)
    expect(sampleTarget('damage', RECOIL_MS + DOWN_MS, true)).toEqual({
      recoil: 0,
      pose: 'down',
      downProgress: 1,
    })
  })

  it('restingSample: 倒れていれば down、勝って生きていれば victory', () => {
    expect(restingSample({ down: true, victory: true })).toEqual(FALLEN)
    expect(restingSample({ down: false, victory: true }).pose).toBe('victory')
    expect(restingSample({ down: false, victory: false })).toEqual(STANDING)
  })
})

describe('advancePlayback', () => {
  it('命中の瞬間に 1 度だけ fires に出て、行動の終わりで active が空く', () => {
    const tl = buildActionTimeline('attack', { damages: true })
    expect(tl.hitAt).toBe(ATTACK_STEP_MS + ATTACK_SLASH_HIT_MS)
    expect(tl.duration).toBe(ATTACK_STEP_MS + ATTACK_SLASH_MS + ATTACK_RETURN_MS + ACTION_GAP_MS)
    // 倒れる行動は倒れ切るまで次を待つ
    const down = buildActionTimeline('attack', { damages: true, downs: true })
    expect(down.duration).toBe(tl.hitAt + RECOIL_MS + DOWN_MS + ACTION_GAP_MS)
    let pb = enqueueEvents(emptyPlayback(), [attackEvent(0)])
    expect(isPlaybackBusy(pb)).toBe(true)
    let r = advancePlayback(pb, tl.hitAt - 1)
    expect(r.fires).toHaveLength(0)
    pb = r.state
    r = advancePlayback(pb, 11)
    expect(r.fires).toHaveLength(1)
    expect(r.fires[0].sinceHit).toBe(10)
    pb = r.state
    r = advancePlayback(pb, 5)
    expect(r.fires).toHaveLength(0)
    r = advancePlayback(r.state, tl.duration)
    expect(isPlaybackBusy(r.state)).toBe(false)
  })

  it('大きな dt は行動をまたいで繰り越し、全部の命中を順に出す', () => {
    const pb = enqueueEvents(emptyPlayback(), [attackEvent(0), attackEvent(1), attackEvent(2)])
    const r = advancePlayback(pb, 100000)
    expect(r.fires.map((f) => f.event.seq)).toEqual([0, 1, 2])
    expect(isPlaybackBusy(r.state)).toBe(false)
  })

  it('負・非有限の dt は何もしない。入力の状態は書き換えない', () => {
    const pb = enqueueEvents(emptyPlayback(), [attackEvent(0)])
    expect(advancePlayback(pb, -5).state).toBe(pb)
    expect(advancePlayback(pb, NaN).state).toBe(pb)
    advancePlayback(pb, 50)
    expect(pb.active).toBeNull()
    expect(pb.queue).toHaveLength(1)
  })

  it('呪文は構えの途中で命中する', () => {
    expect(buildActionTimeline('spell').hitAt).toBe(CAST_HIT_MS)
  })
})

describe('sampleDamagePopup / popupText', () => {
  it('上へ跳ねて落ち、小さくはねて止まり、フェードアウトして終わる', () => {
    expect(sampleDamagePopup(0).dy).toBe(0)
    const up = sampleDamagePopup(130)
    expect(up.dy).toBeLessThan(0)
    expect(up.alpha).toBe(1)
    expect(sampleDamagePopup(260).dy).toBeCloseTo(0, 5)
    const small = sampleDamagePopup(260 + 80)
    expect(small.dy).toBeLessThan(0)
    expect(small.dy).toBeGreaterThan(up.dy)
    const hold = sampleDamagePopup(260 + 160 + 10)
    expect(hold).toEqual({ dy: 0, alpha: 1, done: false })
    const fade = sampleDamagePopup(POPUP_TOTAL_MS - 100)
    expect(fade.alpha).toBeGreaterThan(0)
    expect(fade.alpha).toBeLessThan(1)
    expect(sampleDamagePopup(POPUP_TOTAL_MS).done).toBe(true)
  })

  it('文字: damage/heal は数値、miss は MISS', () => {
    expect(popupText({ kind: 'damage', amount: 12 })).toBe('12')
    expect(popupText({ kind: 'heal', amount: 30 })).toBe('30')
    expect(popupText({ kind: 'miss', amount: 0 })).toBe('MISS')
  })

  it('フォントサイズは上下限に収まる', () => {
    expect(popupFontSize(10)).toBe(16)
    expect(popupFontSize(1000)).toBe(30)
    expect(popupFontSize(NaN)).toBe(16)
  })
})

describe('messageWindowText', () => {
  it('名前はそのまま、空・未指定は null（窓を出さない）', () => {
    expect(messageWindowText('ファイア')).toBe('ファイア')
    expect(messageWindowText('  ')).toBeNull()
    expect(messageWindowText(undefined)).toBeNull()
  })
})
