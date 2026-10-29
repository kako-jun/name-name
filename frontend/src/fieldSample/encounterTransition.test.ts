import { describe, expect, it, vi } from 'vitest'
import {
  beginBattleWithTransition,
  buildTalkState,
  endBattleWithTransition,
} from './encounterTransition'
import { canStartTalk, canStartWarp, decideTalkKey } from '../game/fieldNpc'
import { canStartBattleNow } from '../game/fieldWarp'
import type { EncounterTransitionPlayer } from './encounterTransition'
import { TRANSITION_MOSAIC_MAX_SIZE } from '../game/battleTransition'

function fakePlayer(): EncounterTransitionPlayer & {
  _active: boolean
  enters: Array<() => void>
  exits: Array<() => void>
  params: Array<{ mosaicMaxSize: number }>
} {
  const p = {
    _active: false,
    enters: [] as Array<() => void>,
    exits: [] as Array<() => void>,
    params: [] as Array<{ mosaicMaxSize: number }>,
    get active() {
      return p._active
    },
    setParams(x: { mosaicMaxSize: number }) {
      p.params.push(x)
    },
    playEnter(_w: number, _h: number, _f: unknown, onBlack: () => void) {
      p._active = true
      p.enters.push(onBlack)
    },
    playExit(_w: number, _h: number, _o: unknown, onBlack: () => void) {
      p._active = true
      p.exits.push(onBlack)
    },
  }
  return p
}

const base = { width: 100, height: 50, focus: () => ({ x: 1, y: 2 }) }

describe('beginBattleWithTransition (sit-by-me#55)', () => {
  it('モード未指定・none は従来どおり演出なしで即 open する', () => {
    for (const mode of [undefined, 'none'] as const) {
      const player = fakePlayer()
      const open = vi.fn()
      expect(beginBattleWithTransition({ ...base, mode, player, open })).toBe(true)
      expect(open).toHaveBeenCalledTimes(1)
      expect(player.enters).toHaveLength(0)
    }
  })

  it('ff-mosaic は演出を再生し、真っ暗になるまで open しない。モザイク付きのパラメータを使う', () => {
    const player = fakePlayer()
    const open = vi.fn()
    expect(beginBattleWithTransition({ ...base, mode: 'ff-mosaic', player, open })).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(player.enters).toHaveLength(1)
    expect(player.params[0].mosaicMaxSize).toBe(TRANSITION_MOSAIC_MAX_SIZE)
    player.enters[0]()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('ff はモザイクなし', () => {
    const player = fakePlayer()
    beginBattleWithTransition({ ...base, mode: 'ff', player, open: vi.fn() })
    expect(player.params[0].mosaicMaxSize).toBe(0)
  })

  it('演出中の開始要求（二重エンカウント）は無視する', () => {
    const player = fakePlayer()
    const open = vi.fn()
    expect(beginBattleWithTransition({ ...base, mode: 'ff-mosaic', player, open })).toBe(true)
    const open2 = vi.fn()
    expect(beginBattleWithTransition({ ...base, mode: 'ff-mosaic', player, open: open2 })).toBe(
      false
    )
    expect(player.enters).toHaveLength(1)
    player.enters[0]()
    expect(open2).not.toHaveBeenCalled()
  })

  it('none でも演出中（終了の演出など）の開始要求は無視する', () => {
    const player = fakePlayer()
    player._active = true
    const open = vi.fn()
    expect(beginBattleWithTransition({ ...base, mode: 'none', player, open })).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('endBattleWithTransition (sit-by-me#55)', () => {
  it('none は即 close する', () => {
    const player = fakePlayer()
    const close = vi.fn()
    endBattleWithTransition({ ...base, mode: 'none', player, outcome: 'victory', close })
    expect(close).toHaveBeenCalledTimes(1)
    expect(player.exits).toHaveLength(0)
  })

  it('ff-mosaic は黒の瞬間まで close しない', () => {
    const player = fakePlayer()
    const close = vi.fn()
    endBattleWithTransition({ ...base, mode: 'ff-mosaic', player, outcome: 'escaped', close })
    expect(close).not.toHaveBeenCalled()
    expect(player.params[0].mosaicMaxSize).toBe(TRANSITION_MOSAIC_MAX_SIZE)
    player.exits[0]()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('buildTalkState: 演出中は会話・ワープ・決定キー・強制エンカウントを始めない (sit-by-me#55)', () => {
  const idle = { battle: false, talking: false, transition: false, warping: false }
  const npc = { id: 'gate', x: 10, y: 20 }

  it('演出中は battle 扱いで取り込み中になる', () => {
    const s = buildTalkState({ ...idle, battleTransitionActive: true })
    expect(canStartTalk(s)).toBe(false)
    expect(canStartWarp(s)).toBe(false)
    expect(canStartBattleNow(s)).toBe(false)
  })

  it('戦闘中(演出外)は従来どおり会話・ワープ・強制エンカウント不可', () => {
    const s = buildTalkState({ ...idle, battle: true, battleTransitionActive: false })
    expect(canStartTalk(s)).toBe(false)
    expect(canStartWarp(s)).toBe(false)
    expect(canStartBattleNow(s)).toBe(false)
  })

  it('演出中でなければ従来どおり暇', () => {
    const s = buildTalkState({ ...idle, battleTransitionActive: false })
    expect(canStartTalk(s)).toBe(true)
    expect(canStartWarp(s)).toBe(true)
    expect(canStartBattleNow(s)).toBe(true)
  })

  it('演出中は NPC 正面の決定キーでも会話が始まらない', () => {
    const base = {
      code: 'Space',
      ctrl: false,
      alt: false,
      meta: false,
      repeat: false,
      focus: 'other' as const,
      npcs: [npc],
      pos: { x: 10, y: 40 },
      facing: 'up' as const,
    }
    const busy = decideTalkKey({
      ...base,
      state: buildTalkState({ ...idle, battleTransitionActive: true }),
    })
    expect(busy).toEqual({ action: 'ignore' })
    const free = decideTalkKey({
      ...base,
      state: buildTalkState({ ...idle, battleTransitionActive: false }),
    })
    expect(free).toEqual({ action: 'start', npcId: 'gate' })
  })
})
