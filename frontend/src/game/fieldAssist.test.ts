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
  INITIAL_BLOCKED_GATE,
  type BlockedGate,
  arrivalMask,
  resolveEdgeArrival,
  whiteReachableFromEdge,
  ASSIST_LATCH_REACH,
  edgeArrivalPassable,
  findStrandedWhite,
  isPinched,
  type EdgeArrivalResult,
  INITIAL_ASSIST_RUNTIME,
  type AssistRuntime,
  type AssistState,
  type AssistConfig,
} from './fieldAssist'
import {
  arrivalPosition,
  maskWithAssist,
  snapToWalkable,
  stepMove,
  type Edge,
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
  // 橙が 1 点も無いマスクは assist を持たない（maskFromRgba と同じ）
  return assist.some((v) => v === 1)
    ? { width, height, walkable, assist }
    : { width, height, walkable }
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

describe('橙の通行状態のラッチ（入ったら渡り切るまで固定）', () => {
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
    orangeFrames: number
  }
  /** 1 フレーム 16ms・速さ 100px/秒 を frames 回。stateAt(f) でフレームごとの状態を変えられる */
  function run(
    start: Trace,
    frames: number,
    vec: Vec,
    stateAt: (f: number) => AssistState,
    gate0 = { v: INITIAL_BLOCKED_GATE as BlockedGate }
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
      const ev = stepBlockedEvent(gate0.v, fr.blocked, t.pos, vec)
      gate0.v = ev.gate
      const r = stepMove(fr.walkMask, t.pos, vec, fr.onAssist ? 70 : 100, 16)
      t = {
        pos: r.pos,
        runtime: fr.runtime,
        blockedFrames: t.blockedFrames + (fr.blocked ? 1 : 0),
        emits: t.emits + (ev.emit ? 1 : 0),
        companionFrames: t.companionFrames + (fr.wantCompanion ? 1 : 0),
        slowFrames: t.slowFrames + (fr.onAssist ? 1 : 0),
        orangeFrames: t.orangeFrames + (isAssistCellOf(base, r.pos) ? 1 : 0),
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
    orangeFrames: 0,
  })

  it('通れる状態で渡り切ると、橙の間ずっと同行者・速度倍率が続き、合図は出ない', () => {
    const t = run(t0(10.5), 200, RIGHT, () => OPEN)
    expect(t.pos.x).toBeGreaterThan(60)
    expect(t.emits).toBe(0)
    expect(t.companionFrames).toBeGreaterThan(0)
    expect(t.slowFrames).toBeGreaterThan(0)
  })
  it('橙の途中で拒否 (unless) を立てても、渡り切るまで通れて、同行者・速度は変わらず、合図は出ない', () => {
    const t = run(t0(10.5), 200, RIGHT, (f) => (f < 40 ? OPEN : REFUSE))
    expect(t.pos.x).toBeGreaterThan(60)
    expect(t.emits).toBe(0)
    expect(t.blockedFrames).toBe(0)
  })
  it('橙の途中で requires が偽になっても渡り切れる', () => {
    const t = run(t0(10.5), 200, RIGHT, (f) => (f < 40 ? OPEN : LOCKED))
    expect(t.pos.x).toBeGreaterThan(60)
  })
  it('橙の途中でフラグが拒否になっても、ラッチ中は橙の上で戻ることもできる（詰まらない）', () => {
    const mid = run(t0(10.5), 25, RIGHT, () => OPEN)
    expect(isAssistCellOf(base, mid.pos)).toBe(true)
    const back = run(mid, 200, LEFT, () => REFUSE)
    expect(back.pos.x).toBeLessThan(20)
  })
  it('渡り切った（橙から離れた）あとに拒否にすると、橙に再び入れず、合図が 1 回だけ出る', () => {
    const across = run(t0(10.5), 200, RIGHT, () => OPEN)
    expect(across.pos.x).toBeGreaterThan(60 + ASSIST_LATCH_REACH + 2)
    expect(across.runtime).toEqual(INITIAL_ASSIST_RUNTIME)
    const again = run({ ...across, emits: 0, orangeFrames: 0 }, 300, LEFT, () => REFUSE)
    expect(again.pos.x).toBeGreaterThanOrEqual(60)
    expect(again.orangeFrames).toBe(0)
    expect(again.emits).toBe(1)
  })
  it('最初から通れない状態では、橙へ入れず、合図は押し続けても 1 回だけ（入力が途切れたら再武装）', () => {
    const gate = { v: INITIAL_BLOCKED_GATE as BlockedGate }
    const t = run(t0(10.5), 200, RIGHT, () => REFUSE, gate)
    expect(t.pos.x).toBeLessThan(20)
    expect(t.emits).toBe(1)
    expect(t.orangeFrames).toBe(0)
    const idle = run(t, 3, { x: 0, y: 0 }, () => REFUSE, gate)
    const t2 = run(idle, 50, RIGHT, () => REFUSE, gate)
    expect(t2.emits).toBe(2)
  })
  it('ワープ・開始位置で橙の上に置かれたとき（ラッチなし）は、通れない状態でも閉じ込められず抜けられる', () => {
    const t = run(t0(40.5), 300, RIGHT, () => LOCKED)
    expect(t.pos.x).toBeGreaterThan(60)
    expect(t.emits).toBe(0)
  })
  it('橙から ASSIST_LATCH_REACH より離れるとラッチが解ける', () => {
    const t = run(t0(58.5), 60, RIGHT, () => OPEN)
    expect(t.pos.x).toBeGreaterThan(60 + ASSIST_LATCH_REACH)
    expect(t.runtime).toEqual(INITIAL_ASSIST_RUNTIME)
  })
})

describe('細い白を跨いでも橙のラッチが切れない（10x18）', () => {
  // 上の橙片 (x5..9, y5..9) と下の橙片 (x0..4, y10..14) の間は、(4,9) の白 1 マスだけ
  const base = maskOf([
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '#####ooooo',
    '#####ooooo',
    '#####ooooo',
    '#####ooooo',
    '####.ooooo',
    'ooooo#####',
    'ooooo#####',
    'ooooo#####',
    'ooooo#####',
    'ooooo#####',
    '..........',
    '..........',
    '..........',
  ])
  const asst = maskWithAssist(base)
  const REFUSE: AssistState = { passable: false, held: true, ghost: false }
  const step = (
    pos: Vec,
    vec: Vec,
    runtime: AssistRuntime
  ): { pos: Vec; runtime: AssistRuntime } => {
    const fr = stepAssistFrame({ base, assisted: asst, pos, vec, state: REFUSE, runtime })
    const r = stepMove(fr.walkMask, pos, vec, 100, 16)
    return { pos: r.pos, runtime: fr.runtime }
  }
  it('上の橙から細い白に降りて止まっても、下の橙へ進め、下へ渡り切れる', () => {
    let s = {
      pos: { x: 7.5, y: 6.5 },
      runtime: { latched: true, walked: 0, last: null } as AssistRuntime,
    }
    // 橙の上から白 (4,9) へ（左・下を押して）
    for (let i = 0; i < 80 && !(Math.floor(s.pos.x) === 4 && Math.floor(s.pos.y) === 9); i++)
      s = step(s.pos, i % 2 ? { x: 0, y: 1 } : { x: -1, y: 0 }, s.runtime)
    expect(Math.floor(s.pos.x)).toBe(4)
    expect(Math.floor(s.pos.y)).toBe(9)
    // 白の上で立ち止まっても、ラッチは保たれる
    for (let i = 0; i < 30; i++) s = step(s.pos, { x: 0, y: 0 }, s.runtime)
    expect(s.runtime.latched).toBe(true)
    for (let i = 0; i < 200 && s.pos.y < 16; i++) s = step(s.pos, { x: 0, y: 1 }, s.runtime)
    expect(s.pos.y).toBeGreaterThanOrEqual(15)
  })
})

describe('stepBlockedEvent（通れない橙へ進もうとした合図は 1 回だけ）', () => {
  const P = (x: number): Vec => ({ x, y: 0 })
  const GO: Vec = { x: 1, y: 0 }
  const STOP: Vec = { x: 0, y: 0 }
  const feed = (seq: Array<[boolean, number, Vec]>): boolean[] => {
    let gate: BlockedGate = INITIAL_BLOCKED_GATE
    return seq.map(([b, x, v]) => {
      const r = stepBlockedEvent(gate, b, P(x), v)
      gate = r.gate
      return r.emit
    })
  }
  it('押しっぱなしの間（blocked が点いたり消えたりしても）最初の 1 回だけ emit する', () => {
    expect(
      feed([
        [true, 10, GO],
        [true, 10, GO],
        [false, 11, GO],
        [true, 12, GO],
        [false, 13, GO],
        [true, 14, GO],
      ])
    ).toEqual([true, false, false, false, false, false])
  })
  it('入力が止まったら再武装する', () => {
    expect(
      feed([
        [true, 10, GO],
        [false, 10, STOP],
        [true, 10, GO],
      ])
    ).toEqual([true, false, true])
  })
  it('合図を出した場所から ASSIST_LOOKAHEAD 以上離れたら再武装する', () => {
    expect(
      feed([
        [true, 10, GO],
        [false, 10 + ASSIST_LOOKAHEAD, GO],
        [true, 10 + ASSIST_LOOKAHEAD, GO],
      ])
    ).toEqual([true, false, true])
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

describe('whiteReachableFromEdge（来た端の帯から橙を通らずにたどれる白）', () => {
  it('橙・黒は越えない。帯の幅だけ深い行までを種にする', () => {
    const base = maskOf(['..#..', '..o..', '..o..', '.....'])
    const ok = (e: Edge, band: number, x: number, y: number): number =>
      whiteReachableFromEdge(base, e, band)[y * base.width + x]
    expect(ok('top', 1, 0, 0)).toBe(1)
    expect(ok('top', 1, 4, 3)).toBe(1) // 左右の白は下の行でつながる
    const split = maskOf(['..o..', '..o..', '..o..'])
    const r = whiteReachableFromEdge(split, 'left', 1)
    expect(Array.from(r)).toEqual([1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0])
    expect(whiteReachableFromEdge(split, 'top', 1)[3]).toBe(1)
  })
  it('帯に白が無ければ空。黒い縁は越えて帯の白が種になるが、橙の向こうの白は帯の中でも種にしない', () => {
    const rim = maskOf(['###', '...', '...'])
    expect(whiteReachableFromEdge(rim, 'top', 1).some((v) => v === 1)).toBe(false)
    expect(whiteReachableFromEdge(rim, 'top', 2).some((v) => v === 1)).toBe(true)
    const orange = maskOf(['ooo', '...', '...'])
    expect(whiteReachableFromEdge(orange, 'top', 1).some((v) => v === 1)).toBe(false)
    expect(whiteReachableFromEdge(orange, 'top', 2).some((v) => v === 1)).toBe(false)
  })
})

describe('端リンクの着地 (resolveEdgeArrival)', () => {
  const grid = (
    w: number,
    h: number,
    cell: (x: number, y: number) => '.' | '#' | 'o'
  ): WalkMask => {
    const rows: string[] = []
    for (let y = 0; y < h; y++) {
      let row = ''
      for (let x = 0; x < w; x++) row += cell(x, y)
      rows.push(row)
    }
    return maskOf(rows)
  }
  const arrive = (
    base: WalkMask,
    over: Partial<Parameters<typeof resolveEdgeArrival>[0]> = {}
  ): EdgeArrivalResult =>
    resolveEdgeArrival({
      link: { edge: 'bottom', range: [30, 49], to: 'B' },
      back: { edge: 'top', range: [30, 49], to: 'A' },
      srcPos: { x: 47, y: 79 },
      base,
      assisted: maskWithAssist(base),
      inset: 18,
      passable: false,
      edgeBand: 6,
      ...over,
    })

  // 重大1の盤面: y=0..39 は x=10..69 が橙で他は黒、y=40..79 は白
  const stairs = grid(80, 80, (x, y) => (y < 40 ? (x >= 10 && x <= 69 ? 'o' : '#') : '.'))
  it('通れない状態: 橙の階段が来た端に接していて、向こう側にしか白が無い盤面は断る（詰まらない）', () => {
    expect(arrive(stairs).kind).toBe('locked')
  })
  it('通れる状態: 同じ盤面で橙の上に着き、押されて渡る状態でラッチして続く', () => {
    const r = arrive(stairs, { passable: true })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(isAssistCellOf(stairs, r.pos)).toBe(true)
      expect(r.runtime).toMatchObject({ latched: true })
    }
  })
  // 中2の盤面: 40x60。y=0..9 は x=10..29 が橙・他は黒、y=10..59 は白
  const thin = grid(40, 60, (x, y) => (y < 10 ? (x >= 10 && x <= 29 ? 'o' : '#') : '.'))
  it('通れない状態: 薄い橙（10px）の向こうの白には置かず、断る', () => {
    const r = arrive(thin, {
      link: { edge: 'bottom', range: [10, 29], to: 'B' },
      back: { edge: 'top', range: [10, 29], to: 'A' },
      srcPos: { x: 20, y: 59 },
    })
    expect(r.kind).toBe('locked')
  })
  it('通れない状態: 端いっぱいの薄い橙（3px。帯の幅の中）の向こうの白にも置かず、断る', () => {
    const m = grid(40, 60, (_x, y) => (y < 3 ? 'o' : '.'))
    const r = arrive(m, {
      link: { edge: 'bottom', range: [10, 29], to: 'B' },
      back: { edge: 'top', range: [10, 29], to: 'A' },
      srcPos: { x: 20, y: 59 },
    })
    expect(r.kind).toBe('locked')
  })
  it('通れない状態: 来た端の帯に白があれば、橙を通らずにたどれる白に着く', () => {
    const m = grid(40, 60, (x, y) => (y >= 20 && y < 30 && x >= 10 && x <= 29 ? 'o' : '.'))
    const r = arrive(m, {
      link: { edge: 'bottom', range: [10, 29], to: 'B' },
      back: { edge: 'top', range: [10, 29], to: 'A' },
      srcPos: { x: 20, y: 59 },
    })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(isAssistCellOf(m, r.pos)).toBe(false)
      expect(r.pos.y).toBeLessThan(20)
      expect(r.runtime).toEqual(INITIAL_ASSIST_RUNTIME)
    }
  })
  it('通れない状態: 橙の向こうでも、来た端の帯から白でつながっていれば着ける（橙を通らない）', () => {
    // 橙は左半分だけ。右半分は端からずっと白
    const m = grid(40, 60, (x, y) => (y < 20 && x < 20 ? 'o' : '.'))
    const r = arrive(m, {
      link: { edge: 'bottom', range: [0, 39], to: 'B' },
      back: { edge: 'top', range: [0, 39], to: 'A' },
      srcPos: { x: 5, y: 59 },
    })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(isAssistCellOf(m, r.pos)).toBe(false)
  })
  it('通れない状態: 黒い縁（帯より厚い）で来た端に白が無い盤面は断る', () => {
    const m = grid(40, 60, (x, y) => (y < 8 ? '#' : y < 20 && x >= 10 && x <= 29 ? 'o' : '.'))
    const r = arrive(m, {
      link: { edge: 'bottom', range: [10, 29], to: 'B' },
      back: { edge: 'top', range: [10, 29], to: 'A' },
      srcPos: { x: 20, y: 59 },
    })
    expect(r.kind).toBe('locked')
  })
  it('片道リンク（戻りが無い）は通れない状態でも橙の上に置かず、画面中心の近くの白に着く', () => {
    const r = arrive(stairs, { back: null })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(isAssistCellOf(stairs, r.pos)).toBe(false)
  })
  it('橙を含まないマスクは従来と同じ（arrivalPosition と一致・判定なし）', () => {
    const plain = grid(80, 80, (_x, y) => (y < 40 ? '#' : '.'))
    const link: FieldLink = { edge: 'bottom', range: [30, 49], to: 'B' }
    const back: FieldLink = { edge: 'top', range: [30, 49], to: 'A' }
    const r = arrive(plain)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.pos).toEqual(arrivalPosition(link, { x: 47, y: 79 }, back, plain, 18))
      expect(r.runtime).toEqual(INITIAL_ASSIST_RUNTIME)
    }
  })
  it('歩ける点がまったく無ければ none（橙なしのとき）', () => {
    const black = grid(10, 10, () => '#')
    expect(arrive(black).kind).toBe('none')
  })
})

describe('端リンクの着地: 予定点が橙の向こうでも、帯から辿れる白があればそこへ置く', () => {
  const rows: string[] = []
  for (let y = 0; y < 60; y++) {
    let row = ''
    for (let x = 0; x < 40; x++) {
      if (x >= 32)
        row += '.' // 右の通路（端の帯から辿れる）
      else if (y < 10)
        row += x >= 10 && x < 30 ? 'o' : '#' // 上の橙
      else if (y < 20)
        row += x >= 10 && x < 30 ? '.' : '#' // 橙の向こうの小部屋（帯から辿れない）
      else row += '#'
    }
    rows.push(row)
  }
  const base = maskOf(rows)
  const args = {
    link: { edge: 'bottom', range: [10, 29], to: 'B' } as FieldLink,
    back: { edge: 'top', range: [10, 29], to: 'A' } as FieldLink,
    srcPos: { x: 20, y: 59 },
    base,
    assisted: maskWithAssist(base),
    inset: 18,
    passable: false,
    edgeBand: 6,
  }
  it('予定点は橙の向こうの小部屋だが、右の通路の最寄りに置き、断らない', () => {
    const planned = arrivalPosition(args.link, args.srcPos, args.back, base, args.inset)
    expect(planned).not.toBeNull()
    expect(planned!.x).toBeLessThan(30) // 予定点は小部屋の中
    const r = resolveEdgeArrival(args)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.pos.x).toBeGreaterThanOrEqual(32)
      expect(isAssistCellOf(base, r.pos)).toBe(false)
      expect(r.runtime).toEqual(INITIAL_ASSIST_RUNTIME)
      const reach = whiteReachableFromEdge(base, 'top', 6)
      expect(reach[Math.floor(r.pos.y) * 40 + Math.floor(r.pos.x)]).toBe(1)
    }
  })
  it('辿れる白がひとつも無ければ、従来どおり断る', () => {
    const blocked = maskOf(rows.map((row, y) => (y < 10 ? row.replace(/\./g, '#') : row)))
    expect(
      resolveEdgeArrival({ ...args, base: blocked, assisted: maskWithAssist(blocked) }).kind
    ).toBe('locked')
  })
})

describe('シーンをまたぐ階段のラッチ', () => {
  // A: 上端まで続く橙の階段（x5..14）、B: 下端から始まる橙の階段。どちらも他は黒
  const stairsRows = (h: number): string[] =>
    Array.from({ length: h }, () => '#####oooooooooo#####')
  const A = maskOf(stairsRows(40))
  const B = maskOf(stairsRows(40))
  const REFUSE_ST: AssistState = { passable: false, held: true, ghost: false }
  const OPEN_ST: AssistState = { passable: true, held: false, ghost: false }
  const link: FieldLink = { edge: 'top', range: [5, 14], to: 'B' }
  const back: FieldLink = { edge: 'bottom', range: [5, 14], to: 'A' }

  it('edgeArrivalPassable: 通れる状態か、ラッチ中なら true。どちらでもなければ false', () => {
    const latched: AssistRuntime = { latched: true, walked: 0, last: null }
    expect(edgeArrivalPassable(OPEN_ST, INITIAL_ASSIST_RUNTIME)).toBe(true)
    expect(edgeArrivalPassable(REFUSE_ST, latched)).toBe(true)
    expect(edgeArrivalPassable(REFUSE_ST, INITIAL_ASSIST_RUNTIME)).toBe(false)
    expect(edgeArrivalPassable(null, INITIAL_ASSIST_RUNTIME)).toBe(false)
  })

  it('A の階段の途中で通れない状態にして上端まで進んでも、B 側に橙の上へ着地して渡り切れる', () => {
    // A: 通れる状態で入り、途中で通れない状態にして上端まで
    let pos: Vec = { x: 9.5, y: 30.5 }
    let rt: AssistRuntime = { latched: true, walked: 0, last: pos }
    const up = { x: 0, y: -1 }
    for (let i = 0; i < 300 && pos.y > 2; i++) {
      const fr = stepAssistFrame({
        base: A,
        assisted: maskWithAssist(A),
        pos,
        vec: up,
        state: REFUSE_ST,
        runtime: rt,
      })
      rt = fr.runtime
      pos = stepMove(fr.walkMask, pos, up, 60, 16).pos
    }
    expect(pos.y).toBeLessThanOrEqual(2)
    expect(rt.latched).toBe(true)
    // 端リンクの着地: ラッチ中なので通れる状態として扱う
    const arrival = resolveEdgeArrival({
      link,
      back,
      srcPos: pos,
      base: B,
      assisted: maskWithAssist(B),
      inset: 18,
      passable: edgeArrivalPassable(REFUSE_ST, rt),
      edgeBand: 6,
    })
    expect(arrival.kind).toBe('ok')
    if (arrival.kind !== 'ok') return
    expect(isAssistCellOf(B, arrival.pos)).toBe(true)
    expect(arrival.runtime.latched).toBe(true)
    expect(arrival.runtime.walked).toBe(0) // 端リンクの到着は新しいラッチ（歩いた距離 0）
    // B: 通れない状態のまま上へ渡り切る
    pos = arrival.pos
    rt = arrival.runtime
    for (let i = 0; i < 600 && pos.y > 1; i++) {
      const fr = stepAssistFrame({
        base: B,
        assisted: maskWithAssist(B),
        pos,
        vec: up,
        state: REFUSE_ST,
        runtime: rt,
      })
      rt = fr.runtime
      pos = stepMove(fr.walkMask, pos, up, 60, 16).pos
    }
    expect(pos.y).toBeLessThanOrEqual(1)
  })

  it('ラッチしていない通れない状態では、同じ着地を断る（橙の上へは置かない）', () => {
    const arrival = resolveEdgeArrival({
      link,
      back,
      srcPos: { x: 9.5, y: 1 },
      base: B,
      assisted: maskWithAssist(B),
      inset: 18,
      passable: edgeArrivalPassable(REFUSE_ST, INITIAL_ASSIST_RUNTIME),
      edgeBand: 6,
    })
    expect(arrival.kind).toBe('locked')
  })
})

describe('isPinched / findStrandedWhite', () => {
  // 30x40。上の橙 y2..7、白 gap セル、下の橙 y(8+gap)..(13+gap)、その下は白
  const board = (gap: number): WalkMask =>
    maskOf(
      Array.from({ length: 40 }, (_, y) => {
        const orange = (y >= 2 && y < 8) || (y >= 8 + gap && y < 14 + gap)
        return '#' + (orange ? 'o'.repeat(28) : '.'.repeat(28)) + '#'
      })
    )
  it('橙に挟まれた白（8 セル以下）は全部挟まれている。9 セルでは端のセルが外れる', () => {
    const b8 = board(8)
    for (let y = 8; y < 16; y++) expect(isPinched(b8, { x: 15.5, y: y + 0.5 }), `y${y}`).toBe(true)
    const b9 = board(9)
    expect(isPinched(b9, { x: 15.5, y: 8.5 })).toBe(false) // 上の端: 下の橙まで 9 セル
    expect(isPinched(b9, { x: 15.5, y: 12.5 })).toBe(true)
    // 挟まれていない縁（下の橙の下）
    expect(isPinched(b8, { x: 15.5, y: 25.5 })).toBe(false)
    // 橙の無いマスクは false
    expect(isPinched(maskOf(['...', '...']), { x: 1.5, y: 0.5 })).toBe(false)
  })
  it('黒を挟んだ向こうの橙は数えない', () => {
    const m = maskOf(['o#.#o'])
    expect(isPinched(m, { x: 2.5, y: 0.5 })).toBe(false)
  })
  it('橙に接しているが start・リンクの帯・ワープの at のどれにも通じていない白を返す', () => {
    const b = board(12) // 白の踊り場 y8..19、その下の橙 y20..25、その下 y26.. が start 側
    const found = findStrandedWhite(b, [{ x: 15.5, y: 35.5 }], [])
    // 踊り場と、上の橙の上（y0..1）の白が候補。踊り場は両側の橙に 28 セルずつ接している
    const platform = found.find((r) => r.sample.y >= 8 && r.sample.y < 20)
    expect(platform).toBeDefined()
    expect(platform!.contact).toBeGreaterThanOrEqual(28)
  })
  it('start・リンクの帯・ワープの at のどれかを含む白は返さない', () => {
    const b = board(12)
    const viaStart = findStrandedWhite(
      b,
      [
        { x: 15.5, y: 12.5 },
        { x: 15.5, y: 35.5 },
      ],
      []
    )
    expect(viaStart.some((r) => r.sample.y >= 8 && r.sample.y < 20)).toBe(false)
    const m = maskOf(['.o.o.', '.o.o.', '.o.o.'])
    // 中央の列だけが 2 つの橙に挟まれている（左右の端の列は 1 つの橙にしか接しない）
    expect(findStrandedWhite(m, [], [], 1).map((r) => r.sample.x)).toEqual([2.5])
    // 上の端の帯はどの列も含むので、中央の列も通じていることになる
    expect(findStrandedWhite(m, [], [{ edge: 'top', band: 1 }], 1)).toEqual([])
  })
  it('1 つの橙にしか接しない白（階段の先の広場など）は返さない', () => {
    const m = maskOf(['....', 'oooo', '....', '....'])
    expect(findStrandedWhite(m, [{ x: 0.5, y: 3.5 }], [], 1)).toEqual([])
  })
  it('橙に接する長さが短い白の島は返さない。橙の無いマスクは空', () => {
    const m = maskOf(['#####', '#o.o#', '#####'])
    expect(findStrandedWhite(m, [], [])).toEqual([]) // 接する長さ 2 < 8
    expect(findStrandedWhite(m, [], [], 1).length).toBe(1)
    expect(findStrandedWhite(maskOf(['...', '...']), [], [])).toEqual([])
  })
})
