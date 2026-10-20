/**
 * 条件付き通行 (#862) の性質ベースのファズ。決定的なシード付きのランダム地形（白/橙/黒）を作り、本番の
 * stepAssistFrame / stepMove / resolveEdgeArrival を使って、8 方向入力の幅優先探索（位置を量子化）で到達できる
 * 位置の性質を確かめる。
 *
 * (P1) 通れない状態では、白から出発して到達できるどこも橙に入らない（入口の合図は押しっぱなしで 1 回だけ）
 * (P2) 通れる状態で橙に入ってラッチした後、途中でフラグを拒否側に切り替えても、渡り切れる（出口の集合が
 *      切り替えなしと同じ）。渡り切った後に拒否にすると橙に再び入れない
 * (P3) 詰まらない: ラッチ中のどの到達位置からも橙を抜けられる
 * (P4) 通れない状態の端リンク: 着地できた場合は、来た端の帯から橙を通らずにたどれる白。そうでなければ断られる
 * (P5) 橙の無いマスクは従来と完全に同じ動き
 */
import { describe, expect, it } from 'vitest'
import {
  ASSIST_LOOKAHEAD,
  orangeNear,
  refuseEdgeLink,
  resolveEdgeArrival,
  stepAssistFrame,
  stepBlockedEvent,
  INITIAL_BLOCKED_GATE,
  type BlockedGate,
  INITIAL_ASSIST_RUNTIME,
  type AssistRuntime,
  type AssistState,
} from './fieldAssist'
import {
  arrivalPosition,
  detectEdgeLink,
  isAssistCell,
  isOutward,
  maskWithAssist,
  snapToWalkable,
  stepMove,
  type Edge,
  type FieldLink,
  type Vec,
  type WalkMask,
} from './fieldWalk'

// ---- 乱数・地形 ----

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Cell = 0 | 1 | 2 // 0 黒 / 1 白 / 2 橙

class Grid {
  cells: Uint8Array
  constructor(
    readonly w: number,
    readonly h: number,
    fill: Cell
  ) {
    this.cells = new Uint8Array(w * h).fill(fill)
  }
  set(x: number, y: number, v: Cell): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.cells[y * this.w + x] = v
  }
  rect(x0: number, y0: number, x1: number, y1: number, v: Cell): void {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(this.w, x1); x++) this.cells[y * this.w + x] = v
  }
  /** 太さ thick の線分（カプセル）を v で塗る */
  line(a: Vec, b: Vec, thick: number, v: Cell): void {
    const r = thick / 2
    const x0 = Math.floor(Math.min(a.x, b.x) - r - 1)
    const x1 = Math.ceil(Math.max(a.x, b.x) + r + 1)
    const y0 = Math.floor(Math.min(a.y, b.y) - r - 1)
    const y1 = Math.ceil(Math.max(a.y, b.y) + r + 1)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy || 1
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const t = Math.max(0, Math.min(1, ((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / len2))
        const px = a.x + t * dx
        const py = a.y + t * dy
        if (Math.hypot(x + 0.5 - px, y + 0.5 - py) <= Math.max(r, 0.5)) this.set(x, y, v)
      }
  }
  mask(): WalkMask {
    const walkable = new Uint8Array(this.w * this.h)
    const assist = new Uint8Array(this.w * this.h)
    let any = false
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === 1) walkable[i] = 1
      if (this.cells[i] === 2) {
        assist[i] = 1
        any = true
      }
    }
    return any
      ? { width: this.w, height: this.h, walkable, assist }
      : { width: this.w, height: this.h, walkable }
  }
}

type Shape =
  | 'straight'
  | 'L'
  | 'U'
  | 'invU'
  | 'zigzag'
  | 'deadEnd'
  | 'steps'
  | 'diagonal'
  | 'thin'
  | 'gap'
const SHAPES: Shape[] = [
  'straight',
  'L',
  'U',
  'invU',
  'zigzag',
  'deadEnd',
  'steps',
  'diagonal',
  'thin',
  'gap',
]

interface Terrain {
  grid: Grid
  base: WalkMask
  assisted: WalkMask
  start: Vec
  speed: number
  dtMs: number
  shape: Shape
}

function makeTerrain(seed: number): Terrain {
  const r = rng(seed)
  const ri = (a: number, b: number): number => a + Math.floor(r() * (b - a + 1))
  const w = ri(40, 200)
  const h = ri(40, 260)
  const shape = SHAPES[seed % SHAPES.length]
  const g = new Grid(w, h, r() < 0.2 ? 1 : 0)
  const sideWhite = g.cells[0] === 1
  // 白の領域: 下に必ず、上にも多くの場合
  const zb = ri(5, 14)
  const zt = r() < 0.7 ? ri(5, 14) : 0
  const gapTop = zt === 0 ? ri(0, 8) : 0 // 橙が上端から手前で止まる距離（黒い縁）
  if (!sideWhite) {
    g.rect(0, h - zb, w, h, 1)
    g.rect(0, 0, w, zt, 1)
  }
  const thick = shape === 'thin' ? ri(1, 3) : shape === 'gap' ? ri(2, 8) : ri(2, 24)
  const cx = ri(Math.floor(w * 0.25), Math.floor(w * 0.75))
  const yTop = zt === 0 ? gapTop : zt - 2
  const yBot = h - zb + 2
  const P = (x: number, y: number): Vec => ({ x, y })
  const clampX = (x: number): number => Math.max(thick, Math.min(w - thick, x))
  const x1 = clampX(cx + ri(-Math.floor(w / 3), Math.floor(w / 3)))
  const ym = ri(Math.floor(h * 0.3), Math.floor(h * 0.7))
  const poly: Vec[] = []
  switch (shape) {
    case 'straight':
    case 'thin':
    case 'gap':
      poly.push(P(cx, yTop), P(cx, yBot))
      break
    case 'L':
      poly.push(P(cx, yTop), P(cx, ym), P(x1, ym), P(x1, yBot))
      break
    case 'U':
      poly.push(P(cx, yBot), P(cx, ym), P(x1, ym), P(x1, yBot))
      break
    case 'invU':
      poly.push(P(cx, yTop), P(cx, ym), P(x1, ym), P(x1, yTop))
      break
    case 'zigzag': {
      const n = ri(3, 6)
      for (let i = 0; i <= n; i++)
        poly.push(P(i % 2 ? clampX(cx + 25) : clampX(cx - 25), yTop + ((yBot - yTop) * i) / n))
      break
    }
    case 'deadEnd':
      poly.push(P(cx, yBot), P(cx, ym))
      break
    case 'steps': {
      let x = cx
      let y = yTop
      poly.push(P(x, y))
      while (y < yBot - 4) {
        y = Math.min(yBot, y + ri(4, 30))
        poly.push(P(x, y))
        x = clampX(x + ri(-20, 20))
        poly.push(P(x, y))
      }
      break
    }
    case 'diagonal':
      poly.push(P(clampX(cx - 30), yTop), P(clampX(cx + 30), yBot))
      break
  }
  for (let i = 0; i + 1 < poly.length; i++) {
    const t = shape === 'steps' ? ri(2, 20) : thick
    g.line(poly[i], poly[i + 1], t, 2)
  }
  // 細い白で橙を 2 片に分ける（足元がたまたま細い白に止まっても詰まらない）
  if (shape === 'gap') {
    const gw = ri(1, 3)
    for (let y = ym; y < ym + gw; y++)
      for (let x = 0; x < w; x++) if (g.cells[y * w + x] === 2) g.set(x, y, 1)
  }
  // 橙が上端（または左右）に接する: 黒い縁を残さず上端まで伸ばす
  if (zt === 0 && gapTop === 0) g.line(P(poly[0].x, 0), poly[0], thick, 2)
  // 出発点: 下の白（無ければ上の白）
  let start: Vec | null = null
  for (let tries = 0; tries < 400 && !start; tries++) {
    const x = ri(0, w - 1)
    const y = r() < 0.5 ? ri(h - zb, h - 1) : ri(0, Math.max(0, zt - 1))
    if (g.cells[y * w + x] === 1) start = P(x + 0.5, y + 0.5)
  }
  if (!start) {
    g.set(1, h - 2, 1)
    start = P(1.5, h - 1.5)
  }
  const base = g.mask()
  return {
    grid: g,
    base,
    assisted: maskWithAssist(base),
    start,
    speed: r() < 0.5 ? 182 : 260,
    dtMs: [1000 / 60, 1000 / 30, 1000 / 120][ri(0, 2)],
    shape,
  }
}

// ---- 探索 ----

const OPEN: AssistState = { passable: true, held: false, ghost: false }
const REFUSE: AssistState = { passable: false, held: true, ghost: false }
const DIRS: Vec[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
].map((d) => {
  const n = Math.hypot(d.x, d.y)
  return { x: d.x / n, y: d.y / n }
})

interface Node {
  pos: Vec
  rt: AssistRuntime
}

interface Ctx {
  base: WalkMask
  assisted: WalkMask
  speed: number
  dtMs: number
  q: number
}

function advance(
  c: Ctx,
  n: Node,
  vec: Vec,
  state: AssistState
): { node: Node; blocked: boolean; onAssist: boolean } {
  const fr = stepAssistFrame({
    base: c.base,
    assisted: c.assisted,
    pos: n.pos,
    vec,
    state,
    runtime: n.rt,
  })
  const speed = fr.onAssist ? c.speed * 0.7 : c.speed
  const r = stepMove(fr.walkMask, n.pos, vec, speed, c.dtMs)
  return {
    node: { pos: r.pos, rt: fr.runtime },
    blocked: fr.blocked,
    onAssist: fr.onAssist,
  }
}

const keyOf = (c: Ctx, n: Node): number =>
  ((Math.round(n.pos.x / c.q) * 4096 + Math.round(n.pos.y / c.q)) * 2 + (n.rt.latched ? 1 : 0)) | 0

// 量子化の幅は 1 フレームの歩幅（1.5〜8.7px）より十分小さくする（粗いと別の位置が同じ節点に潰れて、動けるのに動けないと誤判定する）
const qFor = (t: Terrain): number => ((t.speed * t.dtMs) / 1000 < 2.5 ? 0.75 : 1)
const ctxOf = (t: Terrain): Ctx => ({
  base: t.base,
  assisted: t.assisted,
  speed: t.speed,
  dtMs: t.dtMs,
  q: qFor(t),
})

/** 幅優先探索。stateOf で状態（通れる/拒否）を決め、visit が false を返したらその節点から先へは進まない */
function bfs(
  c: Ctx,
  starts: Node[],
  stateOf: (n: Node) => AssistState,
  cap: number,
  visit?: (n: Node) => boolean,
  /** 条件を満たす節点が count 個見つかったら探索を打ち切る */
  stop?: { when: (n: Node) => boolean; count: number }
): Node[] {
  const seen = new Set<number>()
  const list: Node[] = []
  for (const s of starts) {
    const k = keyOf(c, s)
    if (!seen.has(k)) {
      seen.add(k)
      list.push(s)
    }
  }
  let found = 0
  for (let i = 0; i < list.length && list.length < cap; i++) {
    const n = list[i]
    if (stop && stop.when(n) && ++found >= stop.count) break
    if (visit && visit(n) === false) continue
    const st = stateOf(n)
    for (const d of DIRS) {
      const { node } = advance(c, n, d, st)
      const k = keyOf(c, node)
      if (!seen.has(k)) {
        seen.add(k)
        list.push(node)
      }
    }
  }
  return list
}

/** その節点で次のフレームがラッチ中になるか（フレームの判定そのもの。フラグの状態には依らない） */
const latchedAt = (c: Ctx, n: Node): boolean =>
  stepAssistFrame({
    base: c.base,
    assisted: c.assisted,
    pos: n.pos,
    vec: { x: 0, y: 0 },
    state: REFUSE,
    runtime: n.rt,
  }).runtime.latched

/** pos のセルから、橙・黒を通らずにたどれる白のマス数（上限 400 で打ち切り） */
function whiteComponentSize(base: WalkMask, pos: Vec): number {
  const { width: w, height: h, walkable } = base
  const seen = new Set<number>()
  const q: number[] = []
  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = y * w + x
    if (walkable[i] !== 1 || seen.has(i)) return
    seen.add(i)
    q.push(i)
  }
  push(Math.floor(pos.x), Math.floor(pos.y))
  while (q.length && seen.size < 400) {
    const i = q.pop()!
    const x = i % w
    const y = (i - x) / w
    push(x - 1, y)
    push(x + 1, y)
    push(x, y - 1)
    push(x, y + 1)
  }
  return seen.size
}

const onOrange = (t: Terrain, p: Vec): boolean => isAssistCell(t.base, p.x, p.y)

const COUNT = 212
const CAP = 20000

describe('性質ベースのファズ: 橙の通行', () => {
  it('(P1) 通れない状態では、白から出発して到達できる位置のどこも橙に入らず、入口の合図は 1 回だけ', () => {
    for (let seed = 1; seed <= COUNT; seed++) {
      const t = makeTerrain(seed)
      const c = ctxOf(t)
      const nodes = bfs(c, [{ pos: t.start, rt: INITIAL_ASSIST_RUNTIME }], () => REFUSE, CAP)
      for (const n of nodes)
        if (onOrange(t, n.pos))
          throw new Error(`seed ${seed} (${t.shape}): 橙に入った ${JSON.stringify(n.pos)}`)
      // 橙に最も近い数か所で、各方向を押しっぱなしにして合図が 1 回だけ出ることを確かめる
      const w = t.base.width
      // 橙に近い（lookahead 内）節点を、ばらけた順に最大 3 つ選ぶ
      const near: Node[] = []
      for (let i = 0; i < nodes.length && near.length < 3; i += 3)
        if (orangeNear(t.base, nodes[i].pos, ASSIST_LOOKAHEAD)) near.push(nodes[i])
      for (const n of near)
        for (const d of DIRS) {
          let cur = n
          let gate: BlockedGate = INITIAL_BLOCKED_GATE
          let last: Vec | null = null
          const trace: string[] = []
          for (let f = 0; f < 90; f++) {
            const a = advance(c, cur, d, REFUSE)
            trace.push(`${a.blocked ? 'B' : '.'}${cur.pos.x.toFixed(1)},${cur.pos.y.toFixed(1)}`)
            const ev = stepBlockedEvent(gate, a.blocked, cur.pos, d)
            gate = ev.gate
            if (ev.emit) {
              // 押しっぱなしで同じ場所から連発しない（壁沿いに離れた別の場所での合図は別の試み）
              if (last && Math.hypot(last.x - cur.pos.x, last.y - cur.pos.y) < ASSIST_LOOKAHEAD)
                throw new Error(
                  `seed ${seed}: 同じ場所から合図が連発した d=${JSON.stringify(d)} ${trace.slice(0, 40).join(' ')}`
                )
              last = { ...cur.pos }
            }
            cur = a.node
            if (onOrange(t, cur.pos))
              throw new Error(`seed ${seed}: 押しっぱなしで橙に入った (w=${w})`)
          }
        }
    }
  }, 60000)

  it('(P2)(P3) 通れる状態で入ってラッチした後は、拒否に切り替えても渡り切れ、詰まらない。渡り切った後は橙に再び入れない', () => {
    let latchedCases = 0
    let exitCases = 0
    for (let seed = 1; seed <= COUNT; seed++) {
      const t = makeTerrain(seed)
      const c = ctxOf(t)
      // 通れる状態で白から出発し、最初にラッチした節点を集める
      const open = bfs(
        c,
        [{ pos: t.start, rt: INITIAL_ASSIST_RUNTIME }],
        () => OPEN,
        CAP,
        undefined,
        {
          when: (n) => onOrange(t, n.pos),
          count: 12,
        }
      )
      const onO = open.filter((n) => onOrange(t, n.pos))
      if (!onO.length) continue
      const entries = [onO[0], onO[onO.length - 1]]
      latchedCases++
      for (const entry of entries) {
        // ラッチ中だけを辿る（フラグを拒否に切り替えた場合 / 切り替えない場合）
        const exits = (state: AssistState): { latched: Node[]; exits: Node[] } => {
          // 展開はラッチ中の節点だけ。ラッチが解けた節点が出口
          const all = bfs(
            c,
            [entry],
            () => state,
            CAP,
            (n) => latchedAt(c, n)
          )
          return {
            latched: all.filter((n) => latchedAt(c, n)),
            exits: all.filter((n) => !latchedAt(c, n)),
          }
        }
        const withRefuse = exits(REFUSE)
        const withOpen = exits(OPEN)
        const ek = (n: Node): number => keyOf(c, n)
        // (P2) ラッチ中の動きはフラグに依らない: 出口の集合が同じ
        expect(new Set(withRefuse.exits.map(ek)), `seed ${seed}`).toEqual(
          new Set(withOpen.exits.map(ek))
        )
        expect(new Set(withRefuse.latched.map(ek)), `seed ${seed}`).toEqual(
          new Set(withOpen.latched.map(ek))
        )
        // 同行者・速度倍率もラッチ中は変わらない
        for (const n of withRefuse.latched.slice(0, 50)) {
          const a = stepAssistFrame({ ...ctxFrame(c, n), state: REFUSE })
          const b = stepAssistFrame({ ...ctxFrame(c, n), state: OPEN })
          if (a.onAssist !== b.onAssist || a.wantCompanion !== b.wantCompanion)
            throw new Error(`seed ${seed}: ラッチ中に同行者/速度が変わった`)
          if (a.onAssist !== true) throw new Error(`seed ${seed}: ラッチ中なのに押されていない`)
          if (a.blocked) throw new Error(`seed ${seed}: ラッチ中に合図が出た`)
        }
        // (P3) ラッチ中のどの位置からも橙を抜けられる（逆向きの到達性）
        if (withRefuse.exits.length > 0) {
          exitCases++
          const idx = new Map<number, number>()
          const nodes = withRefuse.latched
          nodes.forEach((n, i) => idx.set(ek(n), i))
          const rev: number[][] = nodes.map(() => [])
          const canExit = new Uint8Array(nodes.length)
          const stack: number[] = []
          nodes.forEach((n, i) => {
            for (const d of DIRS) {
              const nx = advance(c, n, d, REFUSE).node
              if (!latchedAt(c, nx)) {
                if (!canExit[i]) {
                  canExit[i] = 1
                  stack.push(i)
                }
              } else {
                const j = idx.get(ek(nx))
                if (j !== undefined) rev[j].push(i)
              }
            }
          })
          while (stack.length) {
            const j = stack.pop()!
            for (const i of rev[j])
              if (!canExit[i]) {
                canExit[i] = 1
                stack.push(i)
              }
          }
          const stuck = nodes.filter((_, i) => !canExit[i])
          // 量子化で節点が打ち切られた（CAP）場合の端は除く
          if (nodes.length < CAP && stuck.length > 0)
            throw new Error(
              `seed ${seed} (${t.shape}): 橙の中で詰まる位置 ${JSON.stringify(stuck[0].pos)} (${stuck.length}/${nodes.length})`
            )
        } else if (withRefuse.latched.length < CAP) {
          throw new Error(
            `seed ${seed} (${t.shape}): ラッチ中に橙から出る道が無い entry=${JSON.stringify(entry)} n=${withRefuse.latched.length} W=${t.base.width}x${t.base.height} sp=${t.speed} dt=${t.dtMs.toFixed(1)}`
          )
        }
        // 渡り切った（ラッチが解けた）後に拒否にすると、橙に再び入れない
        const after = bfs(c, withRefuse.exits.slice(0, 5), () => REFUSE, CAP)
        for (const n of after)
          if (onOrange(t, n.pos))
            throw new Error(`seed ${seed} (${t.shape}): 渡り切った後に橙へ再び入った`)
        // 渡り切ったところ（ラッチが解けた位置）のどこでも閉じ込められない: 細い白に挟まれて狭い範囲にしか動けない、ということが無い
        const ex = withRefuse.exits
        for (let i = 0; i < Math.min(30, ex.length); i++) {
          const e = ex[Math.floor((i * ex.length) / Math.min(30, ex.length))]
          const room = whiteComponentSize(t.base, e.pos)
          if (room < 30)
            throw new Error(
              `seed ${seed} (${t.shape}): 渡り切った位置 ${JSON.stringify(e.pos)} で動ける範囲が狭い (${room} マス)`
            )
        }
      }
    }
    expect(latchedCases).toBeGreaterThan(40)
    expect(exitCases).toBeGreaterThan(20)
  }, 120000)

  it('(P5) 橙の無いマスクは、従来の stepMove だけの動きと完全に同じ', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const t = makeTerrain(seed * 7)
      const plainGrid = new Grid(t.grid.w, t.grid.h, 0)
      for (let i = 0; i < t.grid.cells.length; i++)
        plainGrid.cells[i] = t.grid.cells[i] === 2 ? 0 : t.grid.cells[i]
      const base = plainGrid.mask()
      expect(base.assist).toBeUndefined()
      const assisted = maskWithAssist(base)
      expect(assisted).toBe(base)
      const r = rng(seed)
      let a = { x: t.start.x, y: t.start.y }
      let b = { x: t.start.x, y: t.start.y }
      let rt = INITIAL_ASSIST_RUNTIME
      let vec = DIRS[0]
      for (let f = 0; f < 400; f++) {
        if (r() < 0.1) vec = r() < 0.15 ? { x: 0, y: 0 } : DIRS[Math.floor(r() * 8)]
        for (const st of [OPEN, REFUSE]) {
          const fr = stepAssistFrame({ base, assisted, pos: a, vec, state: st, runtime: rt })
          expect(fr.walkMask).toBe(base)
          expect(fr.blocked).toBe(false)
          expect(fr.onAssist).toBe(false)
          expect(fr.wantCompanion).toBe(false)
        }
        const fr = stepAssistFrame({ base, assisted, pos: a, vec, state: OPEN, runtime: rt })
        rt = fr.runtime
        a = stepMove(fr.walkMask, a, vec, t.speed, t.dtMs).pos
        b = stepMove(base, b, vec, t.speed, t.dtMs).pos
        expect(a).toEqual(b)
      }
    }
  })
})

function ctxFrame(
  c: Ctx,
  n: Node
): { base: WalkMask; assisted: WalkMask; pos: Vec; vec: Vec; runtime: AssistRuntime } {
  return { base: c.base, assisted: c.assisted, pos: n.pos, vec: DIRS[0], runtime: n.rt }
}

// ---- (P4) 端リンク ----

/** テスト側の独立な実装: 来た端の帯の白から、橙・黒を通らずに 4 近傍でたどれるセル */
function floodFromBand(base: WalkMask, edge: Edge, band: number): Set<number> {
  const { width: w, height: h, walkable } = base
  const seen = new Set<number>()
  const q: number[] = []
  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = y * w + x
    if (walkable[i] !== 1 || seen.has(i)) return
    seen.add(i)
    q.push(i)
  }
  for (let d = 0; d < Math.max(1, Math.ceil(band)); d++) {
    if (edge === 'top') for (let x = 0; x < w; x++) push(x, d)
    if (edge === 'bottom') for (let x = 0; x < w; x++) push(x, h - 1 - d)
    if (edge === 'left') for (let y = 0; y < h; y++) push(d, y)
    if (edge === 'right') for (let y = 0; y < h; y++) push(w - 1 - d, y)
  }
  while (q.length) {
    const i = q.pop()!
    const x = i % w
    const y = (i - x) / w
    push(x - 1, y)
    push(x + 1, y)
    push(x, y - 1)
    push(x, y + 1)
  }
  return seen
}

const OPPOSITE: Record<Edge, Edge> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/** 到着側の端 back.edge に橙の帯（厚さ thick）を持つ地形 */
function makeEdgeTerrain(seed: number): {
  base: WalkMask
  back: FieldLink | null
  link: FieldLink
  srcPos: Vec
  edgeBand: number
  inset: number
  shape: string
} {
  const r = rng(seed * 977)
  const ri = (a: number, b: number): number => a + Math.floor(r() * (b - a + 1))
  const w = ri(40, 120)
  const h = ri(40, 120)
  const edge = (['top', 'bottom', 'left', 'right'] as Edge[])[ri(0, 3)]
  const horiz = edge === 'top' || edge === 'bottom'
  const along = horiz ? w : h
  const depth = horiz ? h : w
  const g = new Grid(w, h, 0)
  // 奥の白: 端から rim + thick の先
  const rim = r() < 0.4 ? ri(1, 8) : 0 // 橙が端から手前で止まる（黒い縁）
  const thick = ri(1, 18)
  const whiteFrom = rim + thick
  const a0 = ri(0, Math.floor(along / 3))
  const a1 = ri(Math.floor((along * 2) / 3), along)
  const put = (d0: number, d1: number, c0: number, c1: number, v: Cell): void => {
    for (let d = d0; d < d1; d++)
      for (let c = c0; c < c1; c++) {
        const dd = edge === 'top' || edge === 'left' ? d : depth - 1 - d
        if (horiz) g.set(c, dd, v)
        else g.set(dd, c, v)
      }
  }
  put(whiteFrom, depth, 0, along, 1)
  put(rim, whiteFrom, a0, a1, 2)
  // 端沿いに白の通路を作ることもある（橙を通らずにたどれる白）
  const shape = r() < 0.3 ? 'corridor' : 'plain'
  if (shape === 'corridor') {
    const cc = ri(0, along - 1)
    put(0, whiteFrom, cc, Math.min(along, cc + ri(1, 6)), 1)
  }
  const base = g.mask()
  const half = Math.floor(along / 4)
  const range: [number, number] = [ri(0, half), ri(along - half, along - 1)]
  const back: FieldLink | null = r() < 0.8 ? { edge, range, to: 'A' } : null
  const link: FieldLink = { edge: OPPOSITE[edge], range, to: 'B' }
  const srcPos: Vec = horiz
    ? { x: ri(range[0], range[1]), y: link.edge === 'bottom' ? 99 : 0 }
    : { x: link.edge === 'right' ? 99 : 0, y: ri(range[0], range[1]) }
  const edgeBand = ri(3, 10)
  return {
    base,
    back,
    link,
    srcPos,
    edgeBand,
    inset: edgeBand * 3,
    shape: `${edge}/${thick}/${rim}/${shape}`,
  }
}

describe('性質ベースのファズ: 通れない状態の端リンク (P4)', () => {
  it('着地できたら来た端の帯から橙を通らずにたどれる白、そうでなければ断られる', () => {
    let ok = 0
    let locked = 0
    for (let seed = 1; seed <= 600; seed++) {
      const e = makeEdgeTerrain(seed)
      const res = resolveEdgeArrival({
        link: e.link,
        back: e.back,
        srcPos: e.srcPos,
        base: e.base,
        assisted: maskWithAssist(e.base),
        inset: e.inset,
        passable: false,
        edgeBand: e.edgeBand,
      })
      if (res.kind === 'ok') {
        ok++
        expect(isAssistCell(e.base, res.pos.x, res.pos.y), `seed ${seed} ${e.shape}`).toBe(false)
        expect(res.runtime).toEqual(INITIAL_ASSIST_RUNTIME)
        if (e.back) {
          const flood = floodFromBand(e.base, e.back.edge, e.edgeBand)
          const i = Math.floor(res.pos.y) * e.base.width + Math.floor(res.pos.x)
          expect(flood.has(i), `seed ${seed} ${e.shape}: 着地点が帯から辿れない`).toBe(true)
        }
      } else {
        // 断るのは、戻りリンクがあって橙を含むマスクのときだけ。着地点（橙を除いて探した点）が辿れないとき
        locked++
        expect(res.kind, `seed ${seed}`).toBe('locked')
        expect(e.back, `seed ${seed}`).not.toBeNull()
        const flood = floodFromBand(e.base, e.back!.edge, e.edgeBand)
        const p =
          arrivalPosition(e.link, e.srcPos, e.back!, e.base, e.inset) ??
          snapToWalkable(
            e.base,
            { x: e.base.width / 2, y: e.base.height / 2 },
            Math.max(e.base.width, e.base.height)
          )
        const reach = p ? flood.has(Math.floor(p.y) * e.base.width + Math.floor(p.x)) : false
        expect(reach, `seed ${seed} ${e.shape}: 辿れる着地点なのに断った`).toBe(false)
      }
    }
    expect(ok).toBeGreaterThan(50)
    expect(locked).toBeGreaterThan(50)
  })

  it('断られたリンクは、その端へ向かう入力が続く間は再発火せず、合図は 1 回、入力が途切れたら再び使える', () => {
    const link: FieldLink = { edge: 'bottom', range: [0, 39], to: 'B' }
    const size = { width: 40, height: 40 }
    const refused = refuseEdgeLink(link, 'locked', false)
    expect(refused.reason).toBe('locked')
    expect(refuseEdgeLink(link, 'locked', true).reason).toBe('held')
    expect(refuseEdgeLink(link, 'none', false).reason).toBeNull()
    let disarmed: FieldLink | null = refused.disarmed
    const down = { x: 0, y: 1 }
    let fired = 0
    for (let f = 0; f < 60; f++) {
      // main と同じ規則: その端へ向かう入力が途切れたら解除
      if (disarmed && !isOutward(disarmed.edge, down)) disarmed = null
      if (detectEdgeLink({ x: 20, y: 38 }, size, [link], 6, down, disarmed)) fired++
    }
    expect(fired).toBe(0)
    const idle = { x: 0, y: 0 }
    if (disarmed && !isOutward(disarmed.edge, idle)) disarmed = null
    expect(detectEdgeLink({ x: 20, y: 38 }, size, [link], 6, down, disarmed)).toBe(link)
  })
})

describe('回帰: 直近の再現盤面', () => {
  const edgeArgs = {
    inset: 18,
    edgeBand: 6,
    passable: false,
  }
  it('重大1（80x80。上半分が橙の階段、下半分が白）: 端リンクで橙の向こうの白に置かれず、断られて詰まらない', () => {
    const g = new Grid(80, 80, 0)
    g.rect(10, 0, 70, 40, 2)
    g.rect(0, 40, 80, 80, 1)
    const base = g.mask()
    const res = resolveEdgeArrival({
      link: { edge: 'bottom', range: [30, 49], to: 'B' },
      back: { edge: 'top', range: [30, 49], to: 'A' },
      srcPos: { x: 47, y: 79 },
      base,
      assisted: maskWithAssist(base),
      ...edgeArgs,
    })
    expect(res.kind).toBe('locked')
  })
  it('中2（40x60。橙の向こうにだけ白）: 橙の向こうの白に置かれず、断られる', () => {
    const g = new Grid(40, 60, 0)
    g.rect(10, 0, 30, 10, 2)
    g.rect(0, 10, 40, 60, 1)
    const base = g.mask()
    const res = resolveEdgeArrival({
      link: { edge: 'bottom', range: [10, 29], to: 'B' },
      back: { edge: 'top', range: [10, 29], to: 'A' },
      srcPos: { x: 20, y: 59 },
      base,
      assisted: maskWithAssist(base),
      ...edgeArgs,
    })
    expect(res.kind).toBe('locked')
  })
})
