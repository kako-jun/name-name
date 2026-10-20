import { describe, expect, it } from 'vitest'
import {
  ASSIST_DEFAULTS,
  ASSIST_LOOKAHEAD,
  aheadIsAssist,
  assistSpeed,
  blockedAttempt,
  companionDisplayAlpha,
  companionPosition,
  companionWanted,
  evalAssist,
  facing4,
  stepCompanionAlpha,
  stepAssistFrame,
  stepBlockedEvent,
  arrivalMask,
  arrivalRuntime,
  limitRetreat,
  INITIAL_ASSIST_RUNTIME,
  type AssistRuntime,
  type AssistState,
  type AssistConfig,
} from './fieldAssist'
import {
  maskWithAssist,
  snapToWalkable,
  stepMove,
  type Facing8,
  type Vec,
  type WalkMask,
} from './fieldWalk'

/** ASCII マスク: '.' 白 / '#' 黒 / 'o' 橙。1 行 = 1 y */
function maskOf(rows: string[]): WalkMask {
  const height = rows.length
  const width = rows[0].length
  const walkable = new Uint8Array(width * height)
  const assist = new Uint8Array(width * height)
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      if (row[x] === '.') walkable[y * width + x] = 1
      if (row[x] === 'o') assist[y * width + x] = 1
    }
  })
  return { width, height, walkable, assist }
}

const cfg = (over: Partial<AssistConfig> = {}): AssistConfig => ({
  requires: ['after'],
  ...ASSIST_DEFAULTS,
  ...over,
})

describe('evalAssist (#862)', () => {
  it('requires が全部真のときだけ通れる（配列は AND）', () => {
    const c = cfg({ requires: ['a', 'b'] })
    expect(evalAssist(c, { a: true, b: true }).passable).toBe(true)
    expect(evalAssist(c, { a: true, b: false }).passable).toBe(false)
    expect(evalAssist(c, { a: true }).passable).toBe(false) // 宣言なし = 偽
    expect(evalAssist(c, {}).passable).toBe(false)
  })
  it('unless が真の間は requires が成り立っていても通れず held になる', () => {
    const c = cfg({ unless: 'refuse' })
    expect(evalAssist(c, { after: true, refuse: true })).toMatchObject({
      passable: false,
      held: true,
    })
    expect(evalAssist(c, { after: true, refuse: false })).toMatchObject({
      passable: true,
      held: false,
    })
  })
  it('requires が成り立たないときは held でなく locked（held=false）', () => {
    const c = cfg({ unless: 'refuse' })
    expect(evalAssist(c, { after: false, refuse: true })).toMatchObject({
      passable: false,
      held: false,
    })
  })
  it('ghostWhen が真なら ghost。passable には影響しない（相方の死後も通れる）', () => {
    const c = cfg({ ghostWhen: 'dead' })
    expect(evalAssist(c, { after: true, dead: true })).toMatchObject({
      passable: true,
      ghost: true,
    })
    expect(evalAssist(c, { after: true, dead: false }).ghost).toBe(false)
    expect(evalAssist(cfg(), { after: true, dead: true }).ghost).toBe(false) // ghostWhen 未設定
  })
})

/** 左 8px が白、その右が橙（先読み 12px が届く幅） */
const wide = maskOf(['........' + 'o'.repeat(24)])

describe('先読み・同行者を出す条件 (#862)', () => {
  //      x: 0123456789
  const m = maskOf(['..........', '....oo....', '..........'])
  it('aheadIsAssist: 進行方向の dist 先が橙か。入力なしは false', () => {
    expect(aheadIsAssist(m, { x: 3.5, y: 1.5 }, { x: 1, y: 0 }, 1)).toBe(true)
    expect(aheadIsAssist(m, { x: 3.5, y: 1.5 }, { x: -1, y: 0 }, 1)).toBe(false)
    expect(aheadIsAssist(m, { x: 3.5, y: 1.5 }, { x: 0, y: 0 }, 1)).toBe(false)
    expect(ASSIST_LOOKAHEAD).toBeGreaterThan(0)
  })
  it('companionWanted: 通れる状態で、橙の上か橙へ進もうとしているときだけ', () => {
    expect(companionWanted(m, { x: 4.5, y: 1.5 }, { x: 0, y: 0 }, true)).toBe(true) // 橙の上
    expect(companionWanted(m, { x: 3.5, y: 1.5 }, { x: 1, y: 0 }, true)).toBe(false) // 先読み 12px は届かない
    expect(companionWanted(wide, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }, true)).toBe(true) // 12px 先が橙
    expect(companionWanted(m, { x: 4.5, y: 1.5 }, { x: 0, y: 0 }, false)).toBe(false) // 通れない
    expect(companionWanted(m, { x: 0.5, y: 0.5 }, { x: 0, y: 0 }, true)).toBe(false) // 橙から遠い
  })
  it('blockedAttempt: 通れない状態で橙へ進もうとしたときだけ（通れる・入力なしは false）', () => {
    const near = wide
    expect(blockedAttempt(near, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }, false)).toBe(true)
    expect(blockedAttempt(near, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }, true)).toBe(false)
    expect(blockedAttempt(near, { x: 0.5, y: 0.5 }, { x: 0, y: 0 }, false)).toBe(false)
    expect(blockedAttempt(near, { x: 0.5, y: 0.5 }, { x: -1, y: 0 }, false)).toBe(false)
  })
})

describe('同行者の位置・向き・速さ・不透明度 (#862)', () => {
  it('companionPosition: 向きの反対側に offset だけ離れる（4 方向）', () => {
    const f = { x: 100, y: 100 }
    expect(companionPosition(f, 'up', 40)).toEqual({ x: 100, y: 140 })
    expect(companionPosition(f, 'down', 40)).toEqual({ x: 100, y: 60 })
    expect(companionPosition(f, 'left', 40)).toEqual({ x: 140, y: 100 })
    expect(companionPosition(f, 'right', 40)).toEqual({ x: 60, y: 100 })
  })
  it('facing4: 斜めは左右を優先、4 方向はそのまま', () => {
    const cases: Array<[Facing8, string]> = [
      ['upLeft', 'left'],
      ['downLeft', 'left'],
      ['upRight', 'right'],
      ['downRight', 'right'],
      ['up', 'up'],
      ['down', 'down'],
    ]
    for (const [a, b] of cases) expect(facing4(a)).toBe(b)
    expect(companionPosition({ x: 0, y: 0 }, 'upRight', 10)).toEqual({ x: -10, y: 0 })
  })
  it('assistSpeed: 橙の上で ghost でないときだけ倍率。それ以外は等速', () => {
    expect(assistSpeed(100, true, false, 0.7)).toBeCloseTo(70)
    expect(assistSpeed(100, true, true, 0.7)).toBe(100) // ghost は押されない
    expect(assistSpeed(100, false, false, 0.7)).toBe(100)
  })
  it('stepCompanionAlpha: wanted で fadeMs かけて 0→1、外れて 1→0。0..1 に収まる', () => {
    expect(stepCompanionAlpha(0, true, 100, 200)).toBeCloseTo(0.5)
    expect(stepCompanionAlpha(0.9, true, 100, 200)).toBe(1)
    expect(stepCompanionAlpha(1, false, 100, 200)).toBeCloseTo(0.5)
    expect(stepCompanionAlpha(0.1, false, 100, 200)).toBe(0)
    expect(stepCompanionAlpha(0.5, true, -50, 200)).toBe(0.5) // 負の dt は進めない
  })
  it('stepCompanionAlpha: fadeMs が 0 以下なら即座に切り替える', () => {
    expect(stepCompanionAlpha(0, true, 16, 0)).toBe(1)
    expect(stepCompanionAlpha(1, false, 16, 0)).toBe(0)
  })
  it('companionDisplayAlpha: ghost のときだけ ghostAlpha を掛ける', () => {
    expect(companionDisplayAlpha(1, true, 0.5)).toBe(0.5)
    expect(companionDisplayAlpha(0.5, true, 0.5)).toBe(0.25)
    expect(companionDisplayAlpha(1, false, 0.5)).toBe(1)
  })
})

describe('橙の通行状態のラッチ（橙の上で通行が止まっても渡り切れない）', () => {
  // 横一列: 白 20 + 橙 40 + 白 20。x=0..19 白、20..59 橙、60..79 白
  const base = maskOf(['.'.repeat(20) + 'o'.repeat(40) + '.'.repeat(20)])
  const asst = maskWithAssist(base)
  const OPEN: AssistState = { passable: true, held: false, ghost: false }
  const REFUSE: AssistState = { passable: false, held: true, ghost: false }
  const LOCKED: AssistState = { passable: false, held: false, ghost: false }
  const RIGHT: Vec = { x: 1, y: 0 }
  const LEFT: Vec = { x: -1, y: 0 }

  interface Trace {
    pos: Vec
    runtime: AssistRuntime
    blockedFrames: number
    emits: number
    companionFrames: number
    slowFrames: number
    stuckFrames: number
  }
  /** 1 フレーム 16ms・速さ 100px/秒 を frames 回。stateAt(f) でフレームごとの状態を変えられる */
  function run(
    start: Trace,
    frames: number,
    vec: Vec,
    stateAt: (f: number) => AssistState,
    armed0 = { v: true }
  ): Trace {
    let t = { ...start }
    for (let f = 0; f < frames; f++) {
      const fr = stepAssistFrame({
        base,
        assisted: asst,
        pos: t.pos,
        vec,
        state: stateAt(f),
        runtime: t.runtime,
      })
      const ev = stepBlockedEvent(armed0.v, fr.blocked)
      armed0.v = ev.armed
      const moved = stepMove(fr.walkMask, t.pos, fr.moveVec, fr.onAssist ? 70 : 100, 16)
      const r = fr.retreatFrom ? limitRetreat(fr.retreatFrom, t.pos, moved) : moved
      t = {
        pos: r.pos,
        runtime: fr.runtime,
        blockedFrames: t.blockedFrames + (fr.blocked ? 1 : 0),
        emits: t.emits + (ev.emit ? 1 : 0),
        companionFrames: t.companionFrames + (fr.wantCompanion ? 1 : 0),
        slowFrames: t.slowFrames + (fr.onAssist ? 1 : 0),
        stuckFrames: t.stuckFrames + (r.distance === 0 && vec.x !== 0 ? 1 : 0),
      }
    }
    return t
  }
  const t0 = (x: number): Trace => ({
    pos: { x, y: 0.5 },
    runtime: INITIAL_ASSIST_RUNTIME,
    blockedFrames: 0,
    emits: 0,
    companionFrames: 0,
    slowFrames: 0,
    stuckFrames: 0,
  })

  it('通れる状態で渡り切ると、橙の間ずっと同行者・速度倍率が続き、合図は出ない', () => {
    const t = run(t0(10.5), 200, RIGHT, () => OPEN)
    expect(t.pos.x).toBeGreaterThan(60)
    expect(t.emits).toBe(0)
    expect(t.companionFrames).toBeGreaterThan(30)
    expect(t.slowFrames).toBeGreaterThan(30)
  })

  it('橙の途中で拒否 (unless) を立てると、前へは進めず、同行者・速度は維持され、合図は出ない', () => {
    // 橙に入って 10px 進んだところで拒否に切り替える
    const mid = run(t0(10.5), 30, RIGHT, () => OPEN)
    expect(mid.pos.x).toBeGreaterThan(22)
    expect(mid.pos.x).toBeLessThan(58)
    const held = run(mid, 100, RIGHT, () => REFUSE)
    expect(held.pos.x).toBeLessThan(mid.pos.x + 0.001) // 前へは進まない
    expect(held.emits).toBe(0)
    expect(held.blockedFrames).toBe(0)
    expect(held.companionFrames - mid.companionFrames).toBe(100) // 同行者は出たまま
    expect(held.slowFrames - mid.slowFrames).toBe(100) // 倍率も維持
  })

  it('拒否中でも、入ってきた側へは戻れて（詰まらず）、橙を抜けたらラッチが外れる', () => {
    const mid = run(t0(10.5), 30, RIGHT, () => OPEN)
    const back = run(mid, 60, LEFT, () => REFUSE)
    expect(back.pos.x).toBeLessThan(20)
    expect(back.runtime.latch).toBeNull()
    expect(run(mid, 10, LEFT, () => REFUSE).pos.x).toBeLessThan(mid.pos.x - 5) // 戻り始めは詰まらない
    // 抜けたあとは通常の「通れない橙へ進もうとした」扱いに戻る
    const again = run(back, 30, RIGHT, () => REFUSE)
    expect(again.pos.x).toBeLessThan(21)
    expect(again.emits).toBe(1)
  })

  it('拒否が解けたら、橙の中からまた進める', () => {
    const mid = run(t0(10.5), 30, RIGHT, () => OPEN)
    const held = run(mid, 30, RIGHT, () => REFUSE)
    const go = run(held, 200, RIGHT, () => OPEN)
    expect(go.pos.x).toBeGreaterThan(60)
  })

  it('最初から通れない状態では、橙へ入れず合図は押し続けても 1 回だけ（入力が途切れたら再武装）', () => {
    const t = run(t0(10.5), 200, RIGHT, () => LOCKED)
    expect(t.pos.x).toBeLessThan(20)
    expect(t.emits).toBe(1)
    expect(t.blockedFrames).toBeGreaterThan(1)
    const idle = run(t, 3, { x: 0, y: 0 }, () => LOCKED)
    const again = run(idle, 30, RIGHT, () => LOCKED)
    expect(again.emits - idle.emits).toBe(1)
  })

  it('通行が止まっていても、最初から橙の上に置かれたとき（ワープ・開始位置）は詰まらず抜けられる', () => {
    const t = run(t0(40.5), 300, RIGHT, () => LOCKED)
    expect(t.pos.x).toBeGreaterThan(60)
    expect(t.emits).toBe(0)
    expect(t.companionFrames).toBe(0) // 入った場所が無いので押されない
  })
})

describe('stepBlockedEvent（通れない橙へ進もうとした合図は 1 回だけ）', () => {
  it('blocked が続く間は最初の 1 回だけ emit、途切れたら再武装', () => {
    let armed = true
    const seq = [true, true, true, false, true, true]
    const emits = seq.map((b) => {
      const r = stepBlockedEvent(armed, b)
      armed = r.armed
      return r.emit
    })
    expect(emits).toEqual([true, false, false, false, true, false])
  })
})

describe('arrivalMask（到着位置は通れる状態なら橙込みで）', () => {
  // 左端 3 セルが橙の階段（画像の端に接する）。そこが到着点
  const base = maskOf(['ooo....'])
  const asst = maskWithAssist(base)
  it('通れる状態なら橙の上にそのまま立てる / 通れなければ近い白へずらす', () => {
    const at = { x: 1.5, y: 0.5 }
    expect(snapToWalkable(arrivalMask(base, asst, true), at, 10)).toEqual(at)
    const shifted = snapToWalkable(arrivalMask(base, asst, false), at, 10)
    expect(shifted?.x).toBeGreaterThanOrEqual(3)
  })
})

describe('戻る動きだけを通す (limitRetreat)', () => {
  const from: Vec = { x: 0, y: 0 }
  const prev: Vec = { x: 10, y: 0 }
  it('入ってきた場所に近づく動きは通し、遠ざかる・横へそれる動きは無かったことにする', () => {
    const closer = { pos: { x: 9, y: 0.5 }, distance: 1 }
    expect(limitRetreat(from, prev, closer)).toBe(closer)
    expect(limitRetreat(from, prev, { pos: { x: 11, y: 0 }, distance: 1 })).toEqual({
      pos: prev,
      distance: 0,
    })
    expect(limitRetreat(from, prev, { pos: { x: 10, y: 1 }, distance: 1 })).toEqual({
      pos: prev,
      distance: 0,
    })
  })
})

describe('橙の帯の中で壁に沿って滑っても前へ進めない', () => {
  // 幅 30。上 10 行と下 10 行は白、間の 40 行は x=10..19 が橙で左右は壁（黒）
  const band = '#'.repeat(10) + 'o'.repeat(10) + '#'.repeat(10)
  const base = maskOf([
    ...Array(10).fill('.'.repeat(30)),
    ...Array(40).fill(band),
    ...Array(10).fill('.'.repeat(30)),
  ])
  const asst = maskWithAssist(base)
  const REFUSE: AssistState = { passable: false, held: true, ghost: false }
  const entry: Vec = { x: 19.5, y: 9.5 }

  function slide(vec: Vec, frames: number, start: Vec): Vec {
    let pos = start
    let runtime: AssistRuntime = { latch: { entry }, lastFree: entry }
    for (let f = 0; f < frames; f++) {
      const fr = stepAssistFrame({ base, assisted: asst, pos, vec, state: REFUSE, runtime })
      runtime = fr.runtime
      const moved = stepMove(fr.walkMask, pos, fr.moveVec, 70, 16)
      pos = (fr.retreatFrom ? limitRetreat(fr.retreatFrom, pos, moved) : moved).pos
    }
    return pos
  }

  it('入口側の壁へ寄せつつ前向きの成分が混ざる入力でも、前へ進めない（斜めの許可入力が壁で滑る）', () => {
    // entry より右の壁際。vec·(entry-pos) は正だが、右の壁に当たると y だけが前へ滑る
    const end = slide({ x: 1, y: 0.1 }, 400, { x: 19.2, y: 30 })
    expect(end.y).toBeLessThanOrEqual(30 + 1e-6)
  })

  it('入ってきた側（上）へはまっすぐ戻れる', () => {
    const end = slide({ x: 0, y: -1 }, 100, { x: 19.5, y: 30 })
    expect(end.y).toBeLessThan(15)
  })
})

describe('端リンクで橙の上に着いたときのラッチ (arrivalRuntime)', () => {
  // 橙の階段が上端に接する（y=0 から 14 行）。その下は白
  const base = maskOf([
    ...Array(14).fill('.'.repeat(5) + 'o'.repeat(10) + '.'.repeat(5)),
    ...Array(6).fill('.'.repeat(20)),
  ])
  const asst = maskWithAssist(base)
  const REFUSE: AssistState = { passable: false, held: true, ghost: false }
  const landing: Vec = { x: 10.5, y: 1.5 }

  it('橙の上に着いたら、来た端の外側を「入ってきた場所」にする（4 辺）', () => {
    expect(arrivalRuntime(base, landing, 'top').lastFree).toEqual({ x: 10.5, y: -1 })
    expect(arrivalRuntime(base, landing, 'bottom').lastFree).toEqual({ x: 10.5, y: base.height })
    expect(arrivalRuntime(base, landing, 'left').lastFree).toEqual({ x: -1, y: 1.5 })
    expect(arrivalRuntime(base, landing, 'right').lastFree).toEqual({ x: base.width, y: 1.5 })
  })

  it('橙でない場所に着いたときは何も持たない', () => {
    expect(arrivalRuntime(base, { x: 2.5, y: 2.5 }, 'top')).toBe(INITIAL_ASSIST_RUNTIME)
  })

  function walk(vec: Vec, frames: number, runtime: AssistRuntime): { pos: Vec; moved: number } {
    let pos = landing
    let rt = runtime
    let moved = 0
    for (let f = 0; f < frames; f++) {
      const fr = stepAssistFrame({ base, assisted: asst, pos, vec, state: REFUSE, runtime: rt })
      rt = fr.runtime
      const m = stepMove(fr.walkMask, pos, fr.moveVec, 70, 16)
      const r = fr.retreatFrom ? limitRetreat(fr.retreatFrom, pos, m) : m
      pos = r.pos
      moved += r.distance
    }
    return { pos, moved }
  }

  it('拒否の中、到着した橙を奥へは渡り切れず、来た端へは戻れる', () => {
    const rt = arrivalRuntime(base, landing, 'top')
    expect(walk({ x: 0, y: 1 }, 300, rt).pos.y).toBeLessThanOrEqual(landing.y + 1e-6)
    expect(walk({ x: 0, y: -1 }, 100, rt).pos.y).toBeLessThan(0.5)
  })

  it('比較: 到着時に何も持たせないと、拒否しても渡り切れてしまう', () => {
    expect(walk({ x: 0, y: 1 }, 300, INITIAL_ASSIST_RUNTIME).pos.y).toBeGreaterThan(14)
  })
})
