import { describe, expect, it } from 'vitest'
import {
  NPC_APPROACH_STOP,
  NPC_BLOCK_RADIUS,
  NPC_TALK_REACH,
  TALK_KEY_CODES,
  acceptsWalkInput,
  approachArrived,
  blockedByNpc,
  canStartTalk,
  facingToward,
  nearestTalkableNpc,
  npcAtPoint,
  npcZ,
  stepMoveAroundNpcs,
} from './fieldNpc'
import { stepMove, type WalkMask } from './fieldWalk'

function openMask(width: number, height: number): WalkMask {
  return { width, height, walkable: new Uint8Array(width * height).fill(1) }
}

const mask = openMask(600, 600)
const npc = (id: string, x: number, y: number) => ({ id, x, y })

describe('blockedByNpc (#841)', () => {
  it('円の内側は塞がれ、外側・ちょうど半径は通れる', () => {
    const n = [npc('a', 100, 100)]
    expect(blockedByNpc(n, { x: 100, y: 100 })).toBe(true)
    expect(blockedByNpc(n, { x: 100 + NPC_BLOCK_RADIUS - 1, y: 100 })).toBe(true)
    expect(blockedByNpc(n, { x: 100 + NPC_BLOCK_RADIUS, y: 100 })).toBe(false)
  })
  it('NPC が無ければ常に通れる', () => {
    expect(blockedByNpc([], { x: 1, y: 1 })).toBe(false)
  })
})

describe('stepMoveAroundNpcs (#841)', () => {
  it('NPC が無いときは stepMove と同一', () => {
    const a = stepMoveAroundNpcs(mask, { x: 100, y: 100 }, { x: 1, y: 0 }, 260, 16, [])
    const b = stepMove(mask, { x: 100, y: 100 }, { x: 1, y: 0 }, 260, 16)
    expect(a).toEqual(b)
  })
  it('正面の NPC は通り抜けられない（半径の手前で止まる）', () => {
    let pos = { x: 100, y: 200 }
    const n = [npc('a', 200, 200)]
    for (let i = 0; i < 200; i++)
      pos = stepMoveAroundNpcs(mask, pos, { x: 1, y: 0 }, 260, 16, n).pos
    expect(pos.x).toBeLessThanOrEqual(200 - NPC_BLOCK_RADIUS + 1e-6)
    expect(pos.x).toBeGreaterThan(200 - NPC_BLOCK_RADIUS - 5)
  })
  it('斜めに押しつけると NPC の円に沿って滑る（y 方向には進める）', () => {
    let pos = { x: 100, y: 190 }
    const n = [npc('a', 200, 200)]
    const v = { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    for (let i = 0; i < 120; i++) pos = stepMoveAroundNpcs(mask, pos, v, 260, 16, n).pos
    expect(blockedByNpc(n, pos)).toBe(false)
    expect(pos.y).toBeGreaterThan(190)
  })
  it('壁際で NPC に塞がれたら動かず distance 0', () => {
    const m = openMask(300, 300)
    const n = [npc('a', 150, 150)]
    const r = stepMoveAroundNpcs(
      m,
      { x: 150 - NPC_BLOCK_RADIUS, y: 150 },
      { x: 1, y: 0 },
      260,
      16,
      n
    )
    expect(r.distance).toBe(0)
  })
  it('すでに円の中にいても、離れる向きには動ける・近づく向きには動けない', () => {
    const n = [npc('a', 100, 100)]
    const start = { x: 110, y: 100 }
    const away = stepMoveAroundNpcs(mask, start, { x: 1, y: 0 }, 260, 16, n)
    expect(away.pos.x).toBeGreaterThan(110)
    const toward = stepMoveAroundNpcs(mask, start, { x: -1, y: 0 }, 260, 16, n)
    expect(toward.distance).toBe(0)
  })
})

describe('nearestTalkableNpc (#841)', () => {
  const me = { x: 300, y: 300 }
  it('向いた方向の近傍の NPC を選ぶ', () => {
    const n = [npc('right', 360, 300), npc('left', 240, 300)]
    expect(nearestTalkableNpc(n, me, 'right')).toBe('right')
    expect(nearestTalkableNpc(n, me, 'left')).toBe('left')
  })
  it('背後・横の NPC は対象外', () => {
    const n = [npc('behind', 240, 300), npc('side', 300, 360)]
    expect(nearestTalkableNpc(n, me, 'right')).toBeNull()
  })
  it('距離が reach を超えたら対象外（ちょうどは対象）', () => {
    expect(nearestTalkableNpc([npc('a', 300 + NPC_TALK_REACH + 1, 300)], me, 'right')).toBeNull()
    expect(nearestTalkableNpc([npc('a', 300 + NPC_TALK_REACH, 300)], me, 'right')).toBe('a')
  })
  it('複数いれば近いほう', () => {
    const n = [npc('far', 380, 300), npc('near', 350, 300)]
    expect(nearestTalkableNpc(n, me, 'right')).toBe('near')
  })
  it('斜めの向きも扱える', () => {
    const n = [npc('dr', 350, 350)]
    expect(nearestTalkableNpc(n, me, 'downRight')).toBe('dr')
    expect(nearestTalkableNpc(n, me, 'upLeft')).toBeNull()
  })
  it('円錐の境界: 60 度以内は対象・それより外は対象外', () => {
    const at = (deg: number) => {
      const r = 60
      const a = (deg * Math.PI) / 180
      return [npc('a', 300 + r * Math.cos(a), 300 + r * Math.sin(a))]
    }
    expect(nearestTalkableNpc(at(55), me, 'right')).toBe('a')
    expect(nearestTalkableNpc(at(70), me, 'right')).toBeNull()
  })
  it('NPC の円に重なるほど近ければ向きによらず対象', () => {
    expect(nearestTalkableNpc([npc('a', 310, 300)], me, 'left')).toBe('a')
  })
  it('NPC がいなければ null', () => {
    expect(nearestTalkableNpc([], me, 'down')).toBeNull()
  })
})

describe('approachArrived / npcAtPoint (#841)', () => {
  it('approachArrived は NPC_APPROACH_STOP 以内（NPC_TALK_REACH より内側）', () => {
    expect(NPC_APPROACH_STOP).toBeLessThan(NPC_TALK_REACH)
    expect(NPC_APPROACH_STOP).toBeGreaterThan(NPC_BLOCK_RADIUS)
    expect(approachArrived({ x: 0, y: 0 }, { x: NPC_APPROACH_STOP, y: 0 })).toBe(true)
    expect(approachArrived({ x: 0, y: 0 }, { x: NPC_APPROACH_STOP + 1, y: 0 })).toBe(false)
  })
  it('npcAtPoint: 矩形の内側だけ当たり、重なりは足元が下のもの', () => {
    const rects = [
      { id: 'back', left: 0, top: 0, right: 100, bottom: 100 },
      { id: 'front', left: 50, top: 50, right: 150, bottom: 150 },
    ]
    expect(npcAtPoint(rects, { x: 10, y: 10 })).toBe('back')
    expect(npcAtPoint(rects, { x: 75, y: 75 })).toBe('front')
    expect(npcAtPoint(rects, { x: 200, y: 200 })).toBeNull()
    expect(npcAtPoint([], { x: 1, y: 1 })).toBeNull()
  })
})

describe('npcZ (#841): 奥行き', () => {
  it('主人公より足元が下なら手前（10 より大）・上なら奥（10 より小）', () => {
    expect(npcZ(300, 200, 600)).toBeGreaterThan(10)
    expect(npcZ(100, 200, 600)).toBeLessThan(10)
  })
  it('NPC どうしは足元が下のほうが手前・前面レイヤー(20)より常に奥', () => {
    expect(npcZ(400, 100, 600)).toBeGreaterThan(npcZ(300, 100, 600))
    expect(npcZ(100000, 0, 600)).toBeLessThan(20)
    expect(npcZ(-5, 0, 600)).toBeGreaterThanOrEqual(9)
  })
})

describe('会話中の入力停止 (#841)', () => {
  const idle = { battle: false, talking: false, transition: false, warping: false }
  it('歩行入力は戦闘中と会話中に受けない', () => {
    expect(acceptsWalkInput({ battle: false, talking: false })).toBe(true)
    expect(acceptsWalkInput({ battle: true, talking: false })).toBe(false)
    expect(acceptsWalkInput({ battle: false, talking: true })).toBe(false)
  })
  it('話しかけは戦闘・会話・遷移・ワープのどれの最中も始められない', () => {
    expect(canStartTalk(idle)).toBe(true)
    expect(canStartTalk({ ...idle, battle: true })).toBe(false)
    expect(canStartTalk({ ...idle, talking: true })).toBe(false)
    expect(canStartTalk({ ...idle, transition: true })).toBe(false)
    expect(canStartTalk({ ...idle, warping: true })).toBe(false)
  })
  it('決定キーは Space / Enter / Z', () => {
    expect([...TALK_KEY_CODES].sort()).toEqual(['Enter', 'KeyZ', 'NumpadEnter', 'Space'])
  })
})

describe('facingToward (#841)', () => {
  it('支配軸の 4 方向', () => {
    expect(facingToward({ x: 0, y: 0 }, { x: 10, y: 3 })).toBe('right')
    expect(facingToward({ x: 0, y: 0 }, { x: -10, y: 3 })).toBe('left')
    expect(facingToward({ x: 0, y: 0 }, { x: 1, y: 9 })).toBe('down')
    expect(facingToward({ x: 0, y: 0 }, { x: 1, y: -9 })).toBe('up')
  })
})
