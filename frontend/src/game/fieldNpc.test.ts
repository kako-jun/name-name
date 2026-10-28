import { describe, expect, it } from 'vitest'
import {
  NPC_APPROACH_STOP,
  NPC_BLOCK_RADIUS,
  NPC_APPROACH_STUCK_MS,
  NPC_TALK_CONE_DEG,
  NPC_TALK_REACH,
  TALK_KEY_CODES,
  acceptsWalkInput,
  approachAfterMove,
  approachArrived,
  approachBeforeMove,
  blockedByNpc,
  canStartTalk,
  canStartWarp,
  decideTalkKey,
  dialogMetricsFor,
  facingToward,
  nearestTalkableNpc,
  npcAtPoint,
  npcPlacementWarnings,
  stepMoveAroundNpcs,
} from './fieldNpc'
import { isWalkable, stepMove, type WalkMask } from './fieldWalk'

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

describe('stepMoveAroundNpcs: 円への斜め押しつけ・正面 (#841)', () => {
  const m = openMask(1000, 1000)
  const n = [npc('a', 760, 500)]
  it('再現: (790,559) から左上へ押しつけ続けても停止せず、円に入らず、進み続ける', () => {
    let pos = { x: 790, y: 559 }
    const v = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }
    let moved = 0
    for (let i = 0; i < 80; i++) {
      const r = stepMoveAroundNpcs(m, pos, v, 260, 16, n)
      expect(Math.hypot(r.pos.x - 760, r.pos.y - 500)).toBeGreaterThanOrEqual(NPC_BLOCK_RADIUS)
      moved += r.distance
      pos = r.pos
    }
    expect(moved).toBeGreaterThan(100)
    // 円の左上側へ回り込んでいる（y が NPC より上へ）
    expect(pos.y).toBeLessThan(500)
  })
  it('1 フレームの歩幅が大きくても円の中に入らない', () => {
    let pos = { x: 790, y: 559 }
    for (let i = 0; i < 40; i++) {
      pos = stepMoveAroundNpcs(m, pos, { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }, 260, 200, n).pos
      expect(blockedByNpc(n, pos)).toBe(false)
    }
  })
  it('あらゆる方向から押しつけても円に入らない（全周）', () => {
    for (let deg = 0; deg < 360; deg += 15) {
      const a = (deg * Math.PI) / 180
      let pos = { x: 760 + Math.cos(a) * 80, y: 500 + Math.sin(a) * 80 }
      const v = { x: -Math.cos(a + 0.4), y: -Math.sin(a + 0.4) }
      for (let i = 0; i < 100; i++) {
        pos = stepMoveAroundNpcs(m, pos, v, 260, 100, n).pos
        expect(blockedByNpc(n, pos)).toBe(false)
      }
    }
  })
  it('正面は円周ぴったりまで寄れる（隙間は 1px 未満）', () => {
    let pos = { x: 600, y: 500 }
    for (let i = 0; i < 200; i++) pos = stepMoveAroundNpcs(m, pos, { x: 1, y: 0 }, 260, 16, n).pos
    expect(760 - pos.x).toBeGreaterThanOrEqual(NPC_BLOCK_RADIUS - 1e-6)
    expect(760 - pos.x).toBeLessThan(NPC_BLOCK_RADIUS + 1)
  })
  it('射影先が歩行マスク外なら出ない（壁と NPC に挟まれたら止まる）', () => {
    const w = openMask(1000, 1000)
    // y < 480 を壁にする
    for (let y = 0; y < 480; y++) for (let x = 0; x < 1000; x++) w.walkable[y * 1000 + x] = 0
    let pos = { x: 790, y: 559 }
    for (let i = 0; i < 200; i++) {
      pos = stepMoveAroundNpcs(w, pos, { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }, 260, 16, n).pos
      expect(isWalkable(w, pos.x, pos.y)).toBe(true)
      expect(blockedByNpc(n, pos)).toBe(false)
    }
  })
  it('複数 NPC の円の隙間にも入らない', () => {
    const two = [npc('a', 300, 300), npc('b', 340, 300)]
    let pos = { x: 320, y: 400 }
    for (let i = 0; i < 100; i++) {
      pos = stepMoveAroundNpcs(m, pos, { x: 0, y: -1 }, 260, 16, two).pos
      expect(blockedByNpc(two, pos)).toBe(false)
    }
  })
})

describe('nearestTalkableNpc: 円錐の境界 (#841)', () => {
  const me = { x: 300, y: 300 }
  it('ちょうど 60° は対象・60° を超えると対象外', () => {
    const r = 80
    const at = (deg: number) => {
      const a = (deg * Math.PI) / 180
      return [npc('t', me.x + Math.cos(a) * r, me.y + Math.sin(a) * r)]
    }
    expect(NPC_TALK_CONE_DEG).toBe(60)
    expect(nearestTalkableNpc(at(60), me, 'right')).toBe('t')
    expect(nearestTalkableNpc(at(-60), me, 'right')).toBe('t')
    expect(nearestTalkableNpc(at(60.5), me, 'right')).toBeNull()
  })
  it('距離ちょうど reach は対象・超えると対象外', () => {
    expect(nearestTalkableNpc([npc('t', 300 + NPC_TALK_REACH, 300)], me, 'right')).toBe('t')
    expect(nearestTalkableNpc([npc('t', 300 + NPC_TALK_REACH + 1, 300)], me, 'right')).toBeNull()
  })
})

describe('canStartWarp (#841)', () => {
  const idle = { battle: false, talking: false, transition: false, warping: false }
  it('会話・戦闘・遷移・ワープ中は不可', () => {
    expect(canStartWarp(idle)).toBe(true)
    for (const k of ['battle', 'talking', 'transition', 'warping'] as const)
      expect(canStartWarp({ ...idle, [k]: true })).toBe(false)
  })
})

describe('decideTalkKey (#841)', () => {
  const idle = { battle: false, talking: false, transition: false, warping: false }
  const base = {
    code: 'Space',
    ctrl: false,
    alt: false,
    meta: false,
    repeat: false,
    focus: 'other' as const,
    state: idle,
    npcs: [npc('a', 360, 300)],
    pos: { x: 300, y: 300 },
    facing: 'right' as const,
  }
  it('向いた先に NPC がいれば start', () => {
    expect(decideTalkKey(base)).toEqual({ action: 'start', npcId: 'a' })
    for (const code of ['Enter', 'NumpadEnter', 'KeyZ'])
      expect(decideTalkKey({ ...base, code }).action).toBe('start')
  })
  it('npcs が無い・向いた先に NPC がいない・遠いときは ignore（ボタンの Space を奪わない）', () => {
    expect(decideTalkKey({ ...base, npcs: [] }).action).toBe('ignore')
    expect(decideTalkKey({ ...base, facing: 'left' }).action).toBe('ignore')
    expect(decideTalkKey({ ...base, npcs: [npc('a', 900, 300)] }).action).toBe('ignore')
  })
  it('決定キー以外・修飾キー付き・文字入力中・戦闘中は ignore', () => {
    expect(decideTalkKey({ ...base, code: 'KeyA' }).action).toBe('ignore')
    expect(decideTalkKey({ ...base, ctrl: true }).action).toBe('ignore')
    expect(decideTalkKey({ ...base, alt: true }).action).toBe('ignore')
    expect(decideTalkKey({ ...base, meta: true }).action).toBe('ignore')
    expect(decideTalkKey({ ...base, focus: 'text' }).action).toBe('ignore')
    expect(decideTalkKey({ ...base, state: { ...idle, battle: true } }).action).toBe('ignore')
    expect(
      decideTalkKey({ ...base, focus: 'text', state: { ...idle, talking: true } }).action
    ).toBe('ignore')
  })
  it('押しっぱなし(repeat)は開かない・遷移/ワープ中は開かない', () => {
    expect(decideTalkKey({ ...base, repeat: true }).action).toBe('ignore')
    expect(decideTalkKey({ ...base, state: { ...idle, transition: true } }).action).toBe('ignore')
    expect(decideTalkKey({ ...base, state: { ...idle, warping: true } }).action).toBe('ignore')
  })
  it('会話中は advance、repeat なら swallow（送らないが既定動作は止める）', () => {
    const talking = { ...idle, talking: true }
    expect(decideTalkKey({ ...base, state: talking }).action).toBe('advance')
    expect(decideTalkKey({ ...base, state: talking, npcs: [] }).action).toBe('advance')
    expect(decideTalkKey({ ...base, state: talking, repeat: true }).action).toBe('swallow')
  })
})

describe('approach (クリックで近づく) (#841)', () => {
  const target = { x: 300, y: 300 }
  const far = { x: 100, y: 300 }
  it('approach が無ければ何もしない', () => {
    expect(approachBeforeMove(null, target, far, false)).toEqual({ approach: null, arrived: false })
  })
  it('対象が消えた・方向キーが押された → 取り消し', () => {
    const a = { id: 'a', stuckMs: 0 }
    expect(approachBeforeMove(a, undefined, far, false).approach).toBeNull()
    expect(approachBeforeMove(a, target, far, true).approach).toBeNull()
    expect(approachBeforeMove(a, target, far, true).arrived).toBe(false)
  })
  it('着いたら arrived（ちょうど停止距離でも着いた扱い）・遠ければ継続', () => {
    const a = { id: 'a', stuckMs: 0 }
    expect(approachBeforeMove(a, target, { x: 300 - NPC_APPROACH_STOP, y: 300 }, false)).toEqual({
      approach: null,
      arrived: true,
    })
    const r = approachBeforeMove(a, target, { x: 300 - NPC_APPROACH_STOP - 1, y: 300 }, false)
    expect(r.approach).toEqual(a)
    expect(r.arrived).toBe(false)
  })
  it('動けたら stuck をリセット・動けなければ加算', () => {
    const a = { id: 'a', stuckMs: 300 }
    expect(approachAfterMove(a, target, far, 3, 16).approach?.stuckMs).toBe(0)
    expect(approachAfterMove(a, target, far, 0, 16).approach?.stuckMs).toBe(316)
  })
  it('stuck が上限に達したら打ち切り。届く距離なら talk、届かなければ諦めるだけ', () => {
    const a = { id: 'a', stuckMs: NPC_APPROACH_STUCK_MS - 16 }
    const near = { x: 300 - NPC_TALK_REACH, y: 300 }
    expect(approachAfterMove(a, target, near, 0, 16)).toEqual({ approach: null, talk: true })
    expect(approachAfterMove(a, target, far, 0, 16)).toEqual({ approach: null, talk: false })
    // 上限の 1 ms 手前では継続
    expect(
      approachAfterMove({ id: 'a', stuckMs: NPC_APPROACH_STUCK_MS - 17 }, target, near, 0, 16)
        .approach
    ).not.toBeNull()
  })
})

describe('dialogMetricsFor (#841)', () => {
  it('シーンの高さに比例し、小さいシーンでも文字は 16 以上', () => {
    expect(dialogMetricsFor(1000)).toEqual({ boxHeight: 220, fontSize: 40 })
    expect(dialogMetricsFor(2000)).toEqual({ boxHeight: 440, fontSize: 80 })
    expect(dialogMetricsFor(100).fontSize).toBe(16)
  })
})

describe('npcPlacementWarnings (#841)', () => {
  it('歩行マスク外の NPC を警告（歩ける位置・境界内は警告なし）', () => {
    const m = openMask(100, 100)
    m.walkable[50 * 100 + 50] = 0
    const w = npcPlacementWarnings(
      m,
      [npc('ok', 10, 10), npc('wall', 50, 50), npc('out', 500, 5)],
      'a'
    )
    expect(w).toHaveLength(2)
    expect(w[0]).toContain('"wall"')
    expect(w[1]).toContain('"out"')
    expect(npcPlacementWarnings(m, [npc('ok', 10, 10)], 'a')).toEqual([])
  })
})
