import { describe, it, expect } from 'vitest'
import {
  arrivalPosition,
  detectEdgeLink,
  facingFromVector,
  isOutward,
  isWalkable,
  keysToVector,
  maskFromRgba,
  playerScale,
  resolvePlayerHeight,
  pointerToVector,
  snapToWalkable,
  stepMove,
  walkFrame,
  type Edge,
  type FieldLink,
  type WalkMask,
} from './fieldWalk'

/** ASCII マスク: '.' = 歩ける、'#' = 歩けない。1 行 = 1 y */
function maskOf(rows: string[]): WalkMask {
  const height = rows.length
  const width = rows[0].length
  const walkable = new Uint8Array(width * height)
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) walkable[y * width + x] = row[x] === '.' ? 1 : 0
  })
  return { width, height, walkable }
}

/** 全面が歩けるマスク */
function openMask(width: number, height: number): WalkMask {
  return maskOf(Array.from({ length: height }, () => '.'.repeat(width)))
}

/** 全面が歩けないマスク */
function blockedMask(width: number, height: number): WalkMask {
  return maskOf(Array.from({ length: height }, () => '#'.repeat(width)))
}

const none = { up: false, down: false, left: false, right: false }

describe('maskFromRgba (Issue #807)', () => {
  it('白は歩ける', () => {
    const m = maskFromRgba(1, 1, [255, 255, 255, 255])
    expect(m.walkable[0]).toBe(1)
  })

  it('黒は歩けない', () => {
    const m = maskFromRgba(1, 1, [0, 0, 0, 255])
    expect(m.walkable[0]).toBe(0)
  })

  it('輝度は R ではなく (R+G+B)/3 の平均: (255,0,0)=85 は黒', () => {
    const m = maskFromRgba(1, 1, [255, 0, 0, 255])
    expect(m.walkable[0]).toBe(0)
  })

  it('閾値の境界: 127 は歩けない・128 は歩ける・129 は歩ける', () => {
    const m = maskFromRgba(3, 1, [127, 127, 127, 255, 128, 128, 128, 255, 129, 129, 129, 255])
    expect(Array.from(m.walkable)).toEqual([0, 1, 1])
  })

  it('閾値引数を変えられる', () => {
    const rgba = [100, 100, 100, 255]
    expect(maskFromRgba(1, 1, rgba, 128).walkable[0]).toBe(0)
    expect(maskFromRgba(1, 1, rgba, 100).walkable[0]).toBe(1)
  })

  it('alpha は無視する（透明でも輝度だけで決まる、現挙動の固定）', () => {
    expect(maskFromRgba(1, 1, [255, 255, 255, 0]).walkable[0]).toBe(1)
    expect(maskFromRgba(1, 1, [0, 0, 0, 255]).walkable[0]).toBe(0)
  })

  it('rgba が短いと欠損ぶんは歩けない（例外なし）', () => {
    const m = maskFromRgba(2, 1, [255, 255, 255, 255])
    expect(Array.from(m.walkable)).toEqual([1, 0])
  })

  it('幅・高さが 0 なら空のマスク', () => {
    const m = maskFromRgba(0, 0, [])
    expect(m.walkable.length).toBe(0)
    expect(m.width).toBe(0)
    expect(m.height).toBe(0)
  })

  it('幅・高さを保持し、y * width + x の並びで読む', () => {
    // 2x2: 左上だけ白
    const m = maskFromRgba(2, 2, [255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255])
    expect(m.width).toBe(2)
    expect(m.height).toBe(2)
    expect(Array.from(m.walkable)).toEqual([1, 0, 0, 0])
  })
})

describe('isWalkable (Issue #807)', () => {
  const m = maskOf(['..#', '...', '#..'])

  it('内側の歩ける点は true、壁は false', () => {
    expect(isWalkable(m, 1, 1)).toBe(true)
    expect(isWalkable(m, 2, 0)).toBe(false)
  })

  it('左上 (0,0) と右下 (w-1,h-1) を読める', () => {
    expect(isWalkable(m, 0, 0)).toBe(true)
    expect(isWalkable(m, 2, 2)).toBe(true)
    expect(isWalkable(maskOf(['#.', '.#']), 0, 0)).toBe(false)
    expect(isWalkable(maskOf(['#.', '.#']), 1, 1)).toBe(false)
  })

  it('範囲外の境界: -0.1・w・h は false', () => {
    const open = openMask(3, 3)
    expect(isWalkable(open, -0.1, 1)).toBe(false)
    expect(isWalkable(open, 1, -0.1)).toBe(false)
    expect(isWalkable(open, 3, 1)).toBe(false)
    expect(isWalkable(open, 1, 3)).toBe(false)
  })

  it('w-0.01 はまだ最後のセル内（true）', () => {
    const open = openMask(3, 3)
    expect(isWalkable(open, 3 - 0.01, 1)).toBe(true)
    expect(isWalkable(open, 1, 3 - 0.01)).toBe(true)
  })

  it('小数座標は floor でセルを決める', () => {
    expect(isWalkable(m, 1.9, 0.9)).toBe(true)
    expect(isWalkable(m, 2.0, 0.0)).toBe(false)
    expect(isWalkable(m, 2.99, 0.5)).toBe(false)
  })

  it('NaN は false', () => {
    const open = openMask(3, 3)
    expect(isWalkable(open, NaN, 1)).toBe(false)
    expect(isWalkable(open, 1, NaN)).toBe(false)
  })
})

describe('snapToWalkable (Issue #807)', () => {
  it('既に歩ける点はそのまま返す', () => {
    expect(snapToWalkable(openMask(5, 5), { x: 2, y: 2 }, 3)).toEqual({ x: 2, y: 2 })
  })

  it('距離 1 に歩ける点が 1 つだけあればそこへ寄る', () => {
    const m = maskOf(['###', '#.#', '###'])
    // 中心 (1,1) 以外は壁。壁 (0,1) から半径 1 なら (1,1)
    expect(snapToWalkable(m, { x: 0, y: 1 }, 1)).toEqual({ x: 1, y: 1 })
  })

  it('外周 r=1 の斜めの 1 点にも寄れる', () => {
    // (3,3) が壁。外周 r=1 には歩ける点が (4,4) だけ（斜め）、r=2 以降は見ない
    const m = maskOf(['#######', '#######', '#######', '#######', '####.##', '#######', '#######'])
    expect(snapToWalkable(m, { x: 3, y: 3 }, 3)).toEqual({ x: 4, y: 4 })
  })

  it('同じ外周では直進方向 (距離 d^2 が小さい) 点を斜めより優先する', () => {
    // 中心 (2,2) が壁。r=1 の外周で (3,2) [d=1] と (3,3) [d=2] が歩ける
    const m = maskOf(['#####', '#####', '###.#', '###.#', '#####'])
    // (3,2) と (3,3) は歩ける。中心 (2,2) から (3,2) が d=1
    expect(snapToWalkable(m, { x: 2, y: 2 }, 2)).toEqual({ x: 3, y: 2 })
  })

  it('半径ちょうどで見つかり、radius-1 では null', () => {
    const m = maskOf(['#####', '#####', '#####', '#####', '####.'])
    // (0,4) -> (4,4) は距離 4（チェビシェフ）
    expect(snapToWalkable(m, { x: 0, y: 4 }, 4)).toEqual({ x: 4, y: 4 })
    expect(snapToWalkable(m, { x: 0, y: 4 }, 3)).toBeNull()
  })

  it('radius=0 で歩けなければ null', () => {
    expect(snapToWalkable(openMask(3, 3), { x: -1, y: -1 }, 0)).toBeNull()
    expect(snapToWalkable(blockedMask(3, 3), { x: 1, y: 1 }, 0)).toBeNull()
  })

  it('マスク外の点から内側の歩ける点へ寄る', () => {
    expect(snapToWalkable(openMask(5, 5), { x: -2, y: 2 }, 3)).toEqual({ x: 0, y: 2 })
  })

  it('全面が壁なら null', () => {
    expect(snapToWalkable(blockedMask(6, 6), { x: 3, y: 3 }, 10)).toBeNull()
  })
})

describe('keysToVector (Issue #807)', () => {
  it('入力なしは (0,0)', () => {
    expect(keysToVector(none)).toEqual({ x: 0, y: 0 })
  })

  it.each([
    ['up', { x: 0, y: -1 }],
    ['down', { x: 0, y: 1 }],
    ['left', { x: -1, y: 0 }],
    ['right', { x: 1, y: 0 }],
  ] as const)('%s だけで単位ベクトル', (key, expected) => {
    const v = keysToVector({ ...none, [key]: true })
    expect(v.x).toBeCloseTo(expected.x)
    expect(v.y).toBeCloseTo(expected.y)
  })

  it.each([
    ['up', 'left'],
    ['up', 'right'],
    ['down', 'left'],
    ['down', 'right'],
  ] as const)('斜め %s+%s は長さ 1', (a, b) => {
    const v = keysToVector({ ...none, [a]: true, [b]: true })
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1)
    expect(Math.abs(v.x)).toBeCloseTo(Math.SQRT1_2)
    expect(Math.abs(v.y)).toBeCloseTo(Math.SQRT1_2)
  })

  it('左右同時押しは打ち消し合って (0,0)', () => {
    expect(keysToVector({ ...none, left: true, right: true })).toEqual({ x: 0, y: 0 })
  })

  it('上下同時押しは打ち消し合って (0,0)', () => {
    expect(keysToVector({ ...none, up: true, down: true })).toEqual({ x: 0, y: 0 })
  })

  it('上下が打ち消し合い、左右だけが残ると横方向の単位ベクトル', () => {
    const v = keysToVector({ up: true, down: true, left: false, right: true })
    expect(v.x).toBeCloseTo(1)
    expect(v.y).toBeCloseTo(0)
  })

  it('上下＋左右（全部押し）は (0,0)', () => {
    expect(keysToVector({ up: true, down: true, left: true, right: true })).toEqual({ x: 0, y: 0 })
  })
})

describe('pointerToVector (Issue #807)', () => {
  const feet = { x: 100, y: 100 }

  it('deadzone 内は (0,0)', () => {
    expect(pointerToVector(feet, { x: 102, y: 101 }, 10)).toEqual({ x: 0, y: 0 })
  })

  it('長さが deadzone ちょうどは (0,0)', () => {
    expect(pointerToVector({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toEqual({ x: 0, y: 0 })
  })

  it('deadzone を少しでも超えると単位ベクトル', () => {
    const v = pointerToVector({ x: 0, y: 0 }, { x: 3, y: 4.001 }, 5)
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1)
    expect(v.y).toBeGreaterThan(0)
  })

  it('deadzone-1 は (0,0)・deadzone+1 は単位ベクトル', () => {
    expect(pointerToVector(feet, { x: 109, y: 100 }, 10)).toEqual({ x: 0, y: 0 })
    expect(pointerToVector(feet, { x: 111, y: 100 }, 10)).toEqual({ x: 1, y: 0 })
  })

  it('長さ 0 かつ deadzone=0 でも NaN にならない', () => {
    expect(pointerToVector(feet, { x: 100, y: 100 }, 0)).toEqual({ x: 0, y: 0 })
  })

  it('負の deadzone でも長さ 0 は (0,0)（0 除算の保護）', () => {
    expect(pointerToVector(feet, { x: 100, y: 100 }, -5)).toEqual({ x: 0, y: 0 })
  })

  it('斜めは正規化される', () => {
    const v = pointerToVector({ x: 0, y: 0 }, { x: 50, y: 50 }, 5)
    expect(v.x).toBeCloseTo(Math.SQRT1_2)
    expect(v.y).toBeCloseTo(Math.SQRT1_2)
  })

  it('左上へ向かうと負の成分', () => {
    const v = pointerToVector({ x: 10, y: 10 }, { x: 0, y: 0 }, 1)
    expect(v.x).toBeCloseTo(-Math.SQRT1_2)
    expect(v.y).toBeCloseTo(-Math.SQRT1_2)
  })
})

describe('stepMove (Issue #807)', () => {
  it('空き地では speed × dt / 1000 だけ進み、distance も一致する', () => {
    const r = stepMove(openMask(40, 40), { x: 5, y: 5 }, { x: 1, y: 0 }, 100, 100)
    expect(r.pos.x).toBeCloseTo(15)
    expect(r.pos.y).toBeCloseTo(5)
    expect(r.distance).toBeCloseTo(10)
  })

  it('斜めでも進んだ距離は speed × dt / 1000（長さ 1 のベクトル）', () => {
    const v = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    const r = stepMove(openMask(60, 60), { x: 5, y: 5 }, v, 100, 200)
    expect(r.distance).toBeCloseTo(20)
    expect(r.pos.x).toBeCloseTo(5 + 20 * Math.SQRT1_2)
    expect(r.pos.y).toBeCloseTo(5 + 20 * Math.SQRT1_2)
  })

  it('入力なしなら位置は不変（同一参照）で distance=0', () => {
    const pos = { x: 5, y: 5 }
    const r = stepMove(openMask(10, 10), pos, { x: 0, y: 0 }, 100, 100)
    expect(r.pos).toBe(pos)
    expect(r.distance).toBe(0)
  })

  it('dt=0 なら不変（同一参照）', () => {
    const pos = { x: 5, y: 5 }
    const r = stepMove(openMask(10, 10), pos, { x: 1, y: 0 }, 100, 0)
    expect(r.pos).toBe(pos)
    expect(r.distance).toBe(0)
  })

  it('speed=0 なら不変（同一参照）', () => {
    const pos = { x: 5, y: 5 }
    const r = stepMove(openMask(10, 10), pos, { x: 1, y: 0 }, 0, 100)
    expect(r.pos).toBe(pos)
    expect(r.distance).toBe(0)
  })

  it('壁に垂直に押しつけると distance=0 で動かない', () => {
    const m = maskOf(['.....#', '.....#', '.....#'])
    const r = stepMove(m, { x: 4.5, y: 1 }, { x: 1, y: 0 }, 1000, 1000)
    expect(r.pos.x).toBeLessThan(5)
    // もう一度押しても進まない
    const r2 = stepMove(m, r.pos, { x: 1, y: 0 }, 1000, 1000)
    expect(r2.distance).toBe(0)
    expect(r2.pos).toEqual(r.pos)
  })

  it('下の壁に斜めに当たると x 方向へ滑る', () => {
    // y >= 10 が壁
    const rows = [...Array.from({ length: 10 }, () => '.'.repeat(40)), '#'.repeat(40)]
    const v = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    const r = stepMove(maskOf(rows), { x: 5, y: 9.5 }, v, 10, 1000)
    expect(r.pos.y).toBeLessThan(10)
    expect(r.pos.x).toBeGreaterThan(5 + 5)
    expect(r.distance).toBeGreaterThan(5)
  })

  it('右の壁に斜めに当たると y 方向へ滑る', () => {
    // x >= 10 が壁
    const rows = Array.from({ length: 40 }, () => '.'.repeat(10) + '#'.repeat(30))
    const v = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    const r = stepMove(maskOf(rows), { x: 9.5, y: 5 }, v, 10, 1000)
    expect(r.pos.x).toBeLessThan(10)
    expect(r.pos.y).toBeGreaterThan(5 + 5)
    expect(r.distance).toBeGreaterThan(5)
  })

  it('1px の細い壁を大きな dt でもすり抜けない', () => {
    // x=10 の 1 列だけが壁
    const rows = Array.from({ length: 5 }, () => '.'.repeat(10) + '#' + '.'.repeat(19))
    const r = stepMove(maskOf(rows), { x: 5, y: 2 }, { x: 1, y: 0 }, 1000, 1000)
    expect(r.pos.x).toBeLessThan(10)
  })

  it('マスクの端（範囲外）で止まる', () => {
    const r = stepMove(openMask(10, 10), { x: 5, y: 5 }, { x: 1, y: 0 }, 1000, 1000)
    expect(r.pos.x).toBeLessThan(10)
    expect(r.pos.x).toBeGreaterThan(8)
    expect(r.pos.y).toBe(5)
  })

  it('凹んだ角（右と下が壁）に斜めに突っ込むと止まり、それ以上進まない', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => '.'.repeat(10) + '#'.repeat(2)),
      '#'.repeat(12),
      '#'.repeat(12),
    ]
    const m = maskOf(rows)
    const v = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    const r = stepMove(m, { x: 8.5, y: 8.5 }, v, 100, 1000)
    expect(r.pos.x).toBeLessThan(10)
    expect(r.pos.y).toBeLessThan(10)
    const r2 = stepMove(m, r.pos, v, 100, 1000)
    expect(r2.distance).toBe(0)
    expect(r2.pos).toEqual(r.pos)
  })

  it('小さい dt の端数が累積する（呼び出しごとに位置を引き継ぐ）', () => {
    const m = openMask(40, 10)
    let pos = { x: 5, y: 5 }
    let total = 0
    for (let i = 0; i < 4; i++) {
      const r = stepMove(m, pos, { x: 1, y: 0 }, 100, 5)
      pos = r.pos
      total += r.distance
    }
    expect(pos.x).toBeCloseTo(7)
    expect(total).toBeCloseTo(2)
  })

  it('開始位置が歩けない場所でも例外なしで動かない', () => {
    const pos = { x: 1, y: 1 }
    const r = stepMove(blockedMask(5, 5), pos, { x: 1, y: 0 }, 100, 100)
    expect(r.pos).toEqual({ x: 1, y: 1 })
    expect(r.distance).toBe(0)
  })

  it('角抜け禁止: 市松の角を斜めにすり抜けて反対側 (1,1) へ出ない', () => {
    const m = maskOf(['.#', '#.'])
    const v = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    const r = stepMove(m, { x: 0.5, y: 0.5 }, v, 10, 1000)
    expect(r.pos.x).toBeLessThan(1)
    expect(r.pos.y).toBeLessThan(1)
    expect(r.distance).toBe(0)
  })

  it('角抜け禁止: 反対向きの斜め移動でも市松の角を抜けない', () => {
    const m = maskOf(['#.', '.#'])
    const v = { x: -Math.SQRT1_2, y: Math.SQRT1_2 }
    const r = stepMove(m, { x: 1.5, y: 0.5 }, v, 10, 1000)
    expect(r.pos.x).toBeGreaterThanOrEqual(1)
    expect(r.pos.y).toBeLessThan(1)
  })
})

describe('facingFromVector (Issue #807)', () => {
  it.each([
    [{ x: 1, y: 0 }, 'right'],
    [{ x: -1, y: 0 }, 'left'],
    [{ x: 0, y: 1 }, 'down'],
    [{ x: 0, y: -1 }, 'up'],
  ] as const)('%j は %s', (vec, expected) => {
    expect(facingFromVector(vec, 'up' === expected ? 'down' : 'up')).toBe(expected)
  })

  it('横成分が大きければ左右を優先する', () => {
    expect(facingFromVector({ x: 0.9, y: 0.4 }, 'up')).toBe('right')
    expect(facingFromVector({ x: -0.9, y: -0.4 }, 'up')).toBe('left')
  })

  it('縦成分が大きければ上下を優先する', () => {
    expect(facingFromVector({ x: 0.4, y: 0.9 }, 'left')).toBe('down')
    expect(facingFromVector({ x: -0.4, y: -0.9 }, 'left')).toBe('up')
  })

  it('完全な斜めは直前の向きを保つ', () => {
    expect(facingFromVector({ x: 1, y: 1 }, 'left')).toBe('left')
    expect(facingFromVector({ x: -1, y: 1 }, 'up')).toBe('up')
  })

  it('入力なしは直前の向きを保つ', () => {
    expect(facingFromVector({ x: 0, y: 0 }, 'right')).toBe('right')
  })
})

describe('walkFrame (Issue #807)', () => {
  const F = 140

  it('停止中は経過時間に関わらず 0', () => {
    expect(walkFrame(false, 0, F)).toBe(0)
    expect(walkFrame(false, F * 1.5, F)).toBe(0)
  })

  it('0 .. frameMs-1 は 0、frameMs で 1、2*frameMs で 2、3*frameMs で 0', () => {
    expect(walkFrame(true, 0, F)).toBe(0)
    expect(walkFrame(true, F - 1, F)).toBe(0)
    expect(walkFrame(true, F, F)).toBe(1)
    expect(walkFrame(true, 2 * F - 1, F)).toBe(1)
    expect(walkFrame(true, 2 * F, F)).toBe(2)
    expect(walkFrame(true, 3 * F - 1, F)).toBe(2)
    expect(walkFrame(true, 3 * F, F)).toBe(0)
    expect(walkFrame(true, 3 * F + 1, F)).toBe(0)
  })

  it('frameMs が 0 以下なら 0', () => {
    expect(walkFrame(true, 500, 0)).toBe(0)
    expect(walkFrame(true, 500, -10)).toBe(0)
  })

  it('経過時間が負なら 0', () => {
    expect(walkFrame(true, -1, F)).toBe(0)
  })

  it('長時間歩いても 0..2 に収まる', () => {
    for (const ms of [1e5, 123456.7, 9e9]) {
      const f = walkFrame(true, ms, F)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(2)
    }
  })

  it('NaN・非有限は 0', () => {
    expect(walkFrame(true, NaN, F)).toBe(0)
    expect(walkFrame(true, Infinity, F)).toBe(0)
    expect(walkFrame(true, 500, NaN)).toBe(0)
    expect(walkFrame(true, 500, Infinity)).toBe(0)
  })
})

describe('isOutward (Issue #807)', () => {
  it.each([
    // [edge, vec, expected]
    ['left', { x: -1, y: 0 }, true],
    ['left', { x: 1, y: 0 }, false],
    ['left', { x: 0, y: 0 }, false],
    ['left', { x: 0, y: 1 }, false],
    ['right', { x: 1, y: 0 }, true],
    ['right', { x: -1, y: 0 }, false],
    ['right', { x: 0, y: 0 }, false],
    ['right', { x: 0, y: 1 }, false],
    ['top', { x: 0, y: -1 }, true],
    ['top', { x: 0, y: 1 }, false],
    ['top', { x: 0, y: 0 }, false],
    ['top', { x: 1, y: 0 }, false],
    ['bottom', { x: 0, y: 1 }, true],
    ['bottom', { x: 0, y: -1 }, false],
    ['bottom', { x: 0, y: 0 }, false],
    ['bottom', { x: 1, y: 0 }, false],
  ] as [Edge, { x: number; y: number }, boolean][])('%s × %j は %s', (edge, vec, expected) => {
    expect(isOutward(edge, vec)).toBe(expected)
  })
})

describe('detectEdgeLink (Issue #807)', () => {
  const size = { width: 1000, height: 500 }
  const T = 6
  const right: FieldLink = { edge: 'right', range: [100, 200], to: 'b' }
  const links = [right]
  const out = { x: 1, y: 0 }

  it('① 近い・区間内・外向き・disarmed なしならリンクを返す', () => {
    expect(detectEdgeLink({ x: 995, y: 150 }, size, links, T, out)).toBe(right)
  })

  it('② 同一リンクが disarmed なら null', () => {
    expect(detectEdgeLink({ x: 995, y: 150 }, size, links, T, out, right)).toBeNull()
  })

  it('③ 内向きなら null', () => {
    expect(detectEdgeLink({ x: 995, y: 150 }, size, links, T, { x: -1, y: 0 })).toBeNull()
  })

  it('③ 入力なしなら null', () => {
    expect(detectEdgeLink({ x: 995, y: 150 }, size, links, T, { x: 0, y: 0 })).toBeNull()
  })

  it('④ 区間外なら null', () => {
    expect(detectEdgeLink({ x: 995, y: 300 }, size, links, T, out)).toBeNull()
  })

  it('⑤ 端から遠い (> T) なら null', () => {
    expect(detectEdgeLink({ x: 500, y: 150 }, size, links, T, out)).toBeNull()
  })

  it('⑥ 別のリンクが disarmed でも、こちらは返す', () => {
    const other: FieldLink = { edge: 'left', range: [0, 500], to: 'c' }
    expect(detectEdgeLink({ x: 995, y: 150 }, size, links, T, out, other)).toBe(right)
  })

  it('⑦ 直交方向のみの入力なら null', () => {
    expect(detectEdgeLink({ x: 995, y: 150 }, size, links, T, { x: 0, y: 1 })).toBeNull()
  })

  it('⑧ 区間端ちょうど (100 と 200) は返す（閉区間）', () => {
    expect(detectEdgeLink({ x: 995, y: 100 }, size, links, T, out)).toBe(right)
    expect(detectEdgeLink({ x: 995, y: 200 }, size, links, T, out)).toBe(right)
  })

  it('⑨ 区間端の外側 ±1 (99 と 201) は null', () => {
    expect(detectEdgeLink({ x: 995, y: 99 }, size, links, T, out)).toBeNull()
    expect(detectEdgeLink({ x: 995, y: 201 }, size, links, T, out)).toBeNull()
  })

  it('⑩ 複数リンクで先頭が区間外・2 番目が区間内で先頭が disarmed なら 2 番目を返す', () => {
    const first: FieldLink = { edge: 'right', range: [300, 400], to: 'x' }
    const second: FieldLink = { edge: 'right', range: [100, 200], to: 'y' }
    expect(detectEdgeLink({ x: 995, y: 150 }, size, [first, second], T, out, first)).toBe(second)
  })

  it('⑩ 先頭が区間内で disarmed なら、同じ辺の 2 番目の区間内リンクへ進む', () => {
    const first: FieldLink = { edge: 'right', range: [100, 200], to: 'x' }
    const second: FieldLink = { edge: 'right', range: [120, 180], to: 'y' }
    expect(detectEdgeLink({ x: 995, y: 150 }, size, [first, second], T, out, first)).toBe(second)
  })

  it('しきい値: 距離 T-1 と T は返し、T+1 は null (right は w-1-x)', () => {
    // 距離 = 999 - x
    expect(detectEdgeLink({ x: 999 - (T - 1), y: 150 }, size, links, T, out)).toBe(right)
    expect(detectEdgeLink({ x: 999 - T, y: 150 }, size, links, T, out)).toBe(right)
    expect(detectEdgeLink({ x: 999 - (T + 1), y: 150 }, size, links, T, out)).toBeNull()
  })

  it('left の距離は pos.x', () => {
    const left: FieldLink = { edge: 'left', range: [100, 200], to: 'b' }
    const v = { x: -1, y: 0 }
    expect(detectEdgeLink({ x: T, y: 150 }, size, [left], T, v)).toBe(left)
    expect(detectEdgeLink({ x: T + 1, y: 150 }, size, [left], T, v)).toBeNull()
  })

  it('top の距離は pos.y、区間は x', () => {
    const top: FieldLink = { edge: 'top', range: [100, 200], to: 'b' }
    const v = { x: 0, y: -1 }
    expect(detectEdgeLink({ x: 150, y: T }, size, [top], T, v)).toBe(top)
    expect(detectEdgeLink({ x: 150, y: T + 1 }, size, [top], T, v)).toBeNull()
    expect(detectEdgeLink({ x: 250, y: T }, size, [top], T, v)).toBeNull()
  })

  it('bottom の距離は h-1-y、区間は x', () => {
    const bottom: FieldLink = { edge: 'bottom', range: [100, 200], to: 'b' }
    const v = { x: 0, y: 1 }
    expect(detectEdgeLink({ x: 150, y: 499 - T }, size, [bottom], T, v)).toBe(bottom)
    expect(detectEdgeLink({ x: 150, y: 499 - T - 1 }, size, [bottom], T, v)).toBeNull()
    expect(detectEdgeLink({ x: 250, y: 499 - T }, size, [bottom], T, v)).toBeNull()
  })

  it('links が空なら null', () => {
    expect(detectEdgeLink({ x: 995, y: 150 }, size, [], T, out)).toBeNull()
  })
})

describe('arrivalPosition (Issue #807)', () => {
  const src: FieldLink = { edge: 'right', range: [100, 200], to: 'b' }
  const dstLeft: FieldLink = { edge: 'left', range: [300, 500], to: 'a' }
  const dstMask = openMask(1000, 600)

  it.each([
    [100, 300],
    [150, 400],
    [200, 500],
  ])('出口の y=%i が遷移先 range の %i に写る (t=0 / 0.5 / 1)', (srcY, expectedY) => {
    const p = arrivalPosition(src, { x: 999, y: srcY }, dstLeft, dstMask, 10)
    expect(p).toEqual({ x: 10, y: expectedY })
  })

  it('srcPos が range の外にあっても 0..1 にクランプされる', () => {
    expect(arrivalPosition(src, { x: 999, y: 50 }, dstLeft, dstMask, 10)).toEqual({ x: 10, y: 300 })
    expect(arrivalPosition(src, { x: 999, y: 250 }, dstLeft, dstMask, 10)).toEqual({
      x: 10,
      y: 500,
    })
  })

  it('遷移先が left: x = inset', () => {
    expect(arrivalPosition(src, { x: 999, y: 150 }, dstLeft, dstMask, 12)?.x).toBe(12)
  })

  it('遷移先が right: x = w-1-inset', () => {
    const dst: FieldLink = { edge: 'right', range: [300, 500], to: 'a' }
    expect(arrivalPosition(src, { x: 999, y: 150 }, dst, dstMask, 12)).toEqual({ x: 987, y: 400 })
  })

  it('遷移先が top: y = inset、x が range に写る', () => {
    const dst: FieldLink = { edge: 'top', range: [300, 500], to: 'a' }
    expect(arrivalPosition(src, { x: 999, y: 150 }, dst, dstMask, 12)).toEqual({ x: 400, y: 12 })
  })

  it('遷移先が bottom: y = h-1-inset、x が range に写る', () => {
    const dst: FieldLink = { edge: 'bottom', range: [300, 500], to: 'a' }
    expect(arrivalPosition(src, { x: 999, y: 150 }, dst, dstMask, 12)).toEqual({ x: 400, y: 587 })
  })

  it('src の辺が top/bottom のときは x 方向の位置で t を決める', () => {
    const srcBottom: FieldLink = { edge: 'bottom', range: [100, 200], to: 'b' }
    const p = arrivalPosition(srcBottom, { x: 200, y: 599 }, dstLeft, dstMask, 10)
    expect(p).toEqual({ x: 10, y: 500 })
  })

  it('range が a==b なら t=0.5（遷移先 range の中央）', () => {
    const point: FieldLink = { edge: 'right', range: [150, 150], to: 'b' }
    expect(arrivalPosition(point, { x: 999, y: 150 }, dstLeft, dstMask, 10)).toEqual({
      x: 10,
      y: 400,
    })
  })

  it('到着点が壁なら近い歩ける点へスナップする', () => {
    // x < 4 が壁。到着点 (2,10) -> 最も近い歩ける点 (4,10)
    const rows = Array.from({ length: 20 }, () => '####' + '.'.repeat(16))
    const dst: FieldLink = { edge: 'left', range: [10, 10], to: 'a' }
    const p = arrivalPosition(src, { x: 999, y: 150 }, dst, maskOf(rows), 2)
    expect(p).toEqual({ x: 4, y: 10 })
  })

  it('snap 半径内に歩ける点が無ければ null', () => {
    const rows = Array.from({ length: 20 }, () => '#'.repeat(10) + '.'.repeat(10))
    const dst: FieldLink = { edge: 'left', range: [10, 10], to: 'a' }
    expect(arrivalPosition(src, { x: 999, y: 150 }, dst, maskOf(rows), 2, 3)).toBeNull()
    expect(arrivalPosition(src, { x: 999, y: 150 }, dst, blockedMask(20, 20), 2)).toBeNull()
  })

  it('inset > threshold なら到着直後に同じリンクへ反応しない', () => {
    const T = 6
    const p = arrivalPosition(src, { x: 999, y: 150 }, dstLeft, dstMask, 10)!
    const size = { width: dstMask.width, height: dstMask.height }
    expect(detectEdgeLink(p, size, [dstLeft], T, { x: -1, y: 0 })).toBeNull()
  })

  it('inset ≤ threshold では disarmed が無いと反応し、disarmed なら反応しない', () => {
    const T = 6
    const p = arrivalPosition(src, { x: 999, y: 150 }, dstLeft, dstMask, 2)!
    const size = { width: dstMask.width, height: dstMask.height }
    const into = { x: -1, y: 0 }
    expect(detectEdgeLink(p, size, [dstLeft], T, into)).toBe(dstLeft)
    expect(detectEdgeLink(p, size, [dstLeft], T, into, dstLeft)).toBeNull()
  })
})

describe('resolvePlayerHeight / playerScale (#810)', () => {
  it('シーン指定が無ければ全体値', () => {
    expect(resolvePlayerHeight(undefined, 96)).toBe(96)
  })
  it('シーン指定があればそれを使う', () => {
    expect(resolvePlayerHeight(60, 96)).toBe(60)
  })
  it('不正なシーン値（0・負・NaN）は全体値へ戻す', () => {
    expect(resolvePlayerHeight(0, 96)).toBe(96)
    expect(resolvePlayerHeight(-5, 96)).toBe(96)
    expect(resolvePlayerHeight(NaN, 96)).toBe(96)
  })
  it('倍率は表示高さ / 画像の高さ。画像高さ 0 は 1', () => {
    expect(playerScale(96, 192)).toBe(0.5)
    expect(playerScale(96, 0)).toBe(1)
  })
})
