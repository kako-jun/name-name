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
  buildDistanceField,
  resolveEdgeArrival,
  INITIAL_ASSIST_RUNTIME,
  type AssistRuntime,
  type AssistState,
  type AssistConfig,
} from './fieldAssist'
import {
  maskWithAssist,
  snapToWalkable,
  stepMove,
  type FieldLink,
  type Facing8,
  type Vec,
  type WalkMask,
} from './fieldWalk'

import { isAssistCell } from './fieldWalk'
const isAssistCellOf = (m: WalkMask, p: Vec): boolean => isAssistCell(m, p.x, p.y)

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
      const moved = stepMove(fr.walkMask, t.pos, vec, fr.onAssist ? 70 : 100, 16)
      const r = fr.retreatField ? limitRetreat(fr.retreatField, t.pos, moved) : moved
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
  // 横一列。x=0 が入口。場の値は x と同じ
  const field = buildDistanceField(maskOf(['.'.repeat(30)]), { x: 0.5, y: 0.5 })
  const prev: Vec = { x: 10.5, y: 0.5 }
  it('場の値が増えない動きは通し、増える動きは無かったことにする', () => {
    const closer = { pos: { x: 9.5, y: 0.5 }, distance: 1 }
    expect(limitRetreat(field, prev, closer)).toBe(closer)
    expect(limitRetreat(field, prev, { pos: { x: 11.5, y: 0.5 }, distance: 1 })).toEqual({
      pos: prev,
      distance: 0,
    })
  })
})

describe('経路距離の場 (buildDistanceField)', () => {
  it('入口から 4 近傍で辿った歩数になり、辿れないセルは -1。黒は越えない', () => {
    const f = buildDistanceField(maskOf(['..#..', '.o#.o']), { x: 0.5, y: 0.5 })
    expect(Array.from(f.dist)).toEqual([0, 1, -1, -1, -1, 1, 2, -1, -1, -1])
  })
  it('入口がマスクの外（来た端の外側）なら、その端の歩けるセルすべてが 0 の種になる', () => {
    const f = buildDistanceField(maskOf(['.#.', '...', '#..']), { x: 1, y: -1 })
    expect(Array.from(f.dist.slice(0, 3))).toEqual([0, -1, 0])
    expect(Array.from(f.dist.slice(3, 6))).toEqual([1, 2, 1])
    const b = buildDistanceField(maskOf(['...', '#..']), { x: 1, y: 2 })
    expect(Array.from(b.dist)).toEqual([2, 1, 1, -1, 0, 0])
  })
})

describe('折り返す（逆 U 字の）橙でも渡り切れず、入口へは経路どおりに戻れる', () => {
  // 逆 U 字の橙。左腕 (x=1..2) と右腕 (x=7..8) が y=1..10、上 (y=0) でつながる。腕の下は左が入口の白、右が向こう側の白
  // （黒で隔てられ、橙を通らないと行き来できない）。入口の白から左腕へ入り、上を回って右腕まで来た状態で拒否される
  const base = maskOf([
    '#oooooooo#',
    ...Array(10).fill('#oo####oo#'),
    ...Array(3).fill('#..####..#'),
  ])
  const asst = maskWithAssist(base)
  const REFUSE: AssistState = { passable: false, held: true, ghost: false }
  const entry: Vec = { x: 1.5, y: 11.5 }
  const start: Vec = { x: 7.5, y: 5.5 }
  function walk(legs: [Vec, number][], from: Vec): Vec {
    let pos = from
    let runtime: AssistRuntime = { latch: { entry, pushed: true }, lastFree: entry }
    for (const [vec, frames] of legs)
      for (let f = 0; f < frames; f++) {
        const fr = stepAssistFrame({ base, assisted: asst, pos, vec, state: REFUSE, runtime })
        runtime = fr.runtime
        const m = stepMove(fr.walkMask, pos, vec, 40, 16)
        pos = (fr.retreatField ? limitRetreat(fr.retreatField, pos, m) : m).pos
      }
    return pos
  }
  it('前（右腕の下の向こう側の白）へは、直線では入口に近づいていても抜けられない', () => {
    const down = walk([[{ x: 0, y: 1 }, 400]], start)
    expect(down.y).toBeLessThanOrEqual(start.y + 1e-6)
  })
  it('入口へは経路どおり（右腕を上り → 上を左へ → 左腕を下る）戻れて、橙を出る', () => {
    const up = walk([[{ x: 0, y: -1 }, 100]], start)
    expect(up.y).toBeLessThan(1) // 戻る側（上）は詰まらない
    const out = walk(
      [
        [{ x: 0, y: -1 }, 100],
        [{ x: -1, y: 0 }, 150],
        [{ x: 0, y: 1 }, 150],
      ],
      start
    )
    expect(out.y).toBeGreaterThan(10.9)
    expect(out.x).toBeLessThan(3)
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
    let runtime: AssistRuntime = { latch: { entry, pushed: true }, lastFree: entry }
    for (let f = 0; f < frames; f++) {
      const fr = stepAssistFrame({ base, assisted: asst, pos, vec, state: REFUSE, runtime })
      runtime = fr.runtime
      const moved = stepMove(fr.walkMask, pos, vec, 70, 16)
      pos = (fr.retreatField ? limitRetreat(fr.retreatField, pos, moved) : moved).pos
    }
    return pos
  }

  it('入口側の壁へ寄せつつ前向きの成分が混ざる入力でも、前へ進めない（斜めの許可入力が壁で滑る）', () => {
    // entry より右の壁際。vec·(entry-pos) は正だが、右の壁に当たると y だけが前へ滑る
    const end = slide({ x: 1, y: 0.1 }, 400, { x: 19.2, y: 30 })
    expect(end.y).toBeLessThan(31) // 場はセル単位なので、同じセルの中の 1 セル未満は動ける。それ以上は前へ進めない
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
      const m = stepMove(fr.walkMask, pos, vec, 70, 16)
      const r = fr.retreatField ? limitRetreat(fr.retreatField, pos, m) : m
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

describe('端リンク到着の挙動（4 辺。拒否・通れない状態で、前へ渡れず来た端へ戻れる）', () => {
  // 20x20。橙の階段（x/y=5..14）が指定の端から深さ 14 まで接し、その奥と両脇は白
  function stairs(edge: 'top' | 'bottom' | 'left' | 'right'): WalkMask {
    const rows: string[] = []
    for (let y = 0; y < 20; y++) {
      let row = ''
      for (let x = 0; x < 20; x++) {
        const along = edge === 'top' || edge === 'bottom' ? x : y
        const depth = edge === 'top' ? y : edge === 'bottom' ? 19 - y : edge === 'left' ? x : 19 - x
        row += along >= 5 && along <= 14 && depth < 14 ? 'o' : '.'
      }
      rows.push(row)
    }
    return maskOf(rows)
  }
  const cases = [
    { edge: 'top', inward: { x: 0, y: 1 }, landing: { x: 10.5, y: 1.5 } },
    { edge: 'bottom', inward: { x: 0, y: -1 }, landing: { x: 10.5, y: 18.5 } },
    { edge: 'left', inward: { x: 1, y: 0 }, landing: { x: 1.5, y: 10.5 } },
    { edge: 'right', inward: { x: -1, y: 0 }, landing: { x: 18.5, y: 10.5 } },
  ] as const
  const LOCKED: AssistState = { passable: false, held: false, ghost: false }
  function walk(
    base: WalkMask,
    from: Vec,
    edge: 'top' | 'bottom' | 'left' | 'right',
    vec: Vec,
    frames: number
  ): Vec {
    const asst = maskWithAssist(base)
    let pos = from
    let runtime = arrivalRuntime(base, from, edge)
    for (let f = 0; f < frames; f++) {
      const fr = stepAssistFrame({ base, assisted: asst, pos, vec, state: LOCKED, runtime })
      runtime = fr.runtime
      const m = stepMove(fr.walkMask, pos, vec, 70, 16)
      pos = (fr.retreatField ? limitRetreat(fr.retreatField, pos, m) : m).pos
    }
    return pos
  }
  for (const c of cases) {
    it(`${c.edge}: 通れない間は奥へ渡り切れず、来た端へは戻れる`, () => {
      const base = stairs(c.edge)
      const inward = walk(base, c.landing, c.edge, c.inward, 300)
      const gain = (inward.x - c.landing.x) * c.inward.x + (inward.y - c.landing.y) * c.inward.y
      expect(gain).toBeLessThan(1)
      const out = walk(base, c.landing, c.edge, { x: -c.inward.x, y: -c.inward.y }, 100)
      const depth =
        c.edge === 'top'
          ? out.y
          : c.edge === 'bottom'
            ? 20 - out.y
            : c.edge === 'left'
              ? out.x
              : 20 - out.x
      expect(depth).toBeLessThan(0.5)
    })
  }
})

describe('端リンクの着地 (resolveEdgeArrival。通行状態によらず橙の上に着く)', () => {
  // 着地側 A: 橙の階段が上端に接し（x=5..14, y=0..13）、その下が白。上端に戻りリンクがある
  const A = maskOf([
    ...Array(14).fill('#####' + 'o'.repeat(10) + '#####'),
    ...Array(26).fill('.'.repeat(20)),
  ])
  const aAsst = maskWithAssist(A)
  const fromLink: FieldLink = { edge: 'bottom', range: [5, 15], to: 'A' }
  const back: FieldLink = { edge: 'top', range: [5, 15], to: 'B' }
  const src: Vec = { x: 10, y: 59 }
  const LOCKED: AssistState = { passable: false, held: false, ghost: false }
  const OPEN: AssistState = { passable: true, held: false, ghost: false }

  it('通れない状態でも橙の上に着き、橙を飛び越えた向こうの白には置かれない', () => {
    const r = resolveEdgeArrival({
      link: fromLink,
      back,
      srcPos: src,
      base: A,
      assisted: aAsst,
      inset: 1.5,
    })
    expect(r).not.toBeNull()
    expect(r!.pos.y).toBeLessThan(14)
    expect(isAssistCellOf(A, r!.pos)).toBe(true)
    expect(r!.runtime.lastFree).toEqual({ x: r!.pos.x, y: -1 })
    // 比較: 通れない扱いのマスクで探すと階段の向こうの白へずらされる（修正前の挙動）
    const old = snapToWalkable(A, { x: 10, y: 1.5 }, 80)
    expect(old!.y).toBeGreaterThanOrEqual(14)
  })

  it('通れない状態で着くと、同行者は出ず速度も落ちず、来た端へ戻ることしかできない', () => {
    const r = resolveEdgeArrival({
      link: fromLink,
      back,
      srcPos: src,
      base: A,
      assisted: aAsst,
      inset: 1.5,
    })!
    const fr = stepAssistFrame({
      base: A,
      assisted: aAsst,
      pos: r.pos,
      vec: { x: 0, y: 1 },
      state: LOCKED,
      runtime: r.runtime,
    })
    expect(fr.wantCompanion).toBe(false)
    expect(fr.onAssist).toBe(false)
    expect(fr.retreatField).not.toBeNull()
    expect(fr.runtime.latch?.pushed).toBe(false)
    // 着いたあとで通れるようになれば、押される
    const open = stepAssistFrame({
      base: A,
      assisted: aAsst,
      pos: r.pos,
      vec: { x: 0, y: 1 },
      state: OPEN,
      runtime: fr.runtime,
    })
    expect(open.wantCompanion).toBe(true)
    expect(open.onAssist).toBe(true)
  })

  it('通れる状態で着いたラッチは、あとで通れなくなっても押されたまま', () => {
    const r = resolveEdgeArrival({
      link: fromLink,
      back,
      srcPos: src,
      base: A,
      assisted: aAsst,
      inset: 1.5,
    })!
    const a = stepAssistFrame({
      base: A,
      assisted: aAsst,
      pos: r.pos,
      vec: { x: 0, y: 1 },
      state: OPEN,
      runtime: r.runtime,
    })
    expect(a.runtime.latch?.pushed).toBe(true)
    const b = stepAssistFrame({
      base: A,
      assisted: aAsst,
      pos: r.pos,
      vec: { x: 0, y: 1 },
      state: LOCKED,
      runtime: a.runtime,
    })
    expect(b.onAssist).toBe(true)
    expect(b.wantCompanion).toBe(true)
  })

  it('戻りリンクが無い片道リンクでも、画面中心の近くの橙の上に着き、来た端（link.edge の反対側）を入口にする', () => {
    // 中央に縦の橙の帯 (x=5..14)。左右は白。中心 (10, 20) は橙
    const strip = maskOf(Array(40).fill('.....' + 'o'.repeat(10) + '.....'))
    const sAsst = maskWithAssist(strip)
    const link: FieldLink = { edge: 'top', range: [5, 15], to: 'S' }
    const r = resolveEdgeArrival({
      link,
      back: null,
      srcPos: src,
      base: strip,
      assisted: sAsst,
      inset: 1.5,
    })!
    expect(isAssistCellOf(strip, r.pos)).toBe(true) // 通れない扱いのマスクなら橙の外の白へずらされる
    expect(r.runtime.lastFree).toEqual({ x: r.pos.x, y: strip.height })
    // 拒否中は、入口（下端）の側へしか動けない
    const fr = stepAssistFrame({
      base: strip,
      assisted: sAsst,
      pos: r.pos,
      vec: { x: 0, y: -1 },
      state: LOCKED,
      runtime: r.runtime,
    })
    expect(fr.retreatField).not.toBeNull()
    const up = limitRetreat(fr.retreatField!, r.pos, {
      pos: { x: r.pos.x, y: r.pos.y - 3 },
      distance: 3,
    })
    expect(up.distance).toBe(0)
    const down = limitRetreat(fr.retreatField!, r.pos, {
      pos: { x: r.pos.x, y: r.pos.y + 3 },
      distance: 3,
    })
    expect(down.distance).toBe(3)
  })

  it('歩ける点が無ければ null', () => {
    const wall = maskOf(['###', '###'])
    expect(
      resolveEdgeArrival({
        link: fromLink,
        back,
        srcPos: src,
        base: wall,
        assisted: maskWithAssist(wall),
        inset: 1,
      })
    ).toBeNull()
  })
})
