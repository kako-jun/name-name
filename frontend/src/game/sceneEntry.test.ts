/**
 * sceneEntry.ts（入場の持ち越し方針・遷移ゲートの純粋ロジック）のテスト (#734)。
 */
import { describe, it, expect } from 'vitest'
import {
  carryPolicyFor,
  createDeferred,
  isTransitionGated,
  type GatedOperation,
  type TransitionGateState,
} from './sceneEntry'

describe('carryPolicyFor (#734)', () => {
  it('進行は背景等と BGM を持ち越す', () => {
    expect(carryPolicyFor('progress')).toEqual({
      preserveBackgroundForTransition: true,
      carryBgm: true,
    })
  })

  it('新規開始・復元は何も持ち越さない（復元は状態どおりに組み立てる）', () => {
    for (const kind of ['fresh', 'restore'] as const) {
      expect(carryPolicyFor(kind)).toEqual({
        preserveBackgroundForTransition: false,
        carryBgm: false,
      })
    }
  })

  it('返した方針を書き換えても表は変わらない', () => {
    carryPolicyFor('progress').carryBgm = false
    expect(carryPolicyFor('progress').carryBgm).toBe(true)
  })
})

describe('isTransitionGated (#734)', () => {
  const idle: TransitionGateState = {
    waitingForChoice: false,
    waitingForWait: false,
    jumpState: 'idle',
    hasPendingEntry: false,
  }
  const ops: GatedOperation[] = [
    'advance',
    'quickSave',
    'saveMenu',
    'navigate',
    'loadMenu',
    'confirmChoice',
  ]

  it('何も立っていなければ、どの操作も通る', () => {
    for (const op of ops) expect(isTransitionGated(op, idle)).toBe(false)
  })

  it('入場中は、どの操作も止める', () => {
    for (const op of ops) {
      expect(isTransitionGated(op, { ...idle, hasPendingEntry: true })).toBe(true)
    }
  })

  it('Jump の予約中は、どの操作も止める', () => {
    for (const op of ops) {
      expect(isTransitionGated(op, { ...idle, jumpState: 'pending' })).toBe(true)
    }
  })

  it('Jump の停止中は、advance とセーブを止め、goBack/シーク/クイックロード/ロードメニュー/選択肢の確定は通す', () => {
    const s: TransitionGateState = { ...idle, jumpState: 'stalled' }
    expect(isTransitionGated('advance', s)).toBe(true)
    expect(isTransitionGated('quickSave', s)).toBe(true)
    expect(isTransitionGated('saveMenu', s)).toBe(true)
    expect(isTransitionGated('navigate', s)).toBe(false)
    expect(isTransitionGated('loadMenu', s)).toBe(false)
    expect(isTransitionGated('confirmChoice', s)).toBe(false)
  })

  it('選択肢の表示中・待機中は、advance・クイックセーブ・navigate を止める（メニューと確定は止めない）', () => {
    for (const key of ['waitingForChoice', 'waitingForWait'] as const) {
      const s: TransitionGateState = { ...idle, [key]: true }
      expect(isTransitionGated('advance', s)).toBe(true)
      expect(isTransitionGated('quickSave', s)).toBe(true)
      expect(isTransitionGated('navigate', s)).toBe(true)
      expect(isTransitionGated('saveMenu', s)).toBe(false)
      expect(isTransitionGated('loadMenu', s)).toBe(false)
      expect(isTransitionGated('confirmChoice', s)).toBe(false)
    }
  })
})

describe('createDeferred (#734)', () => {
  it('外から解決できる', async () => {
    const d = createDeferred<number>()
    d.resolve(3)
    await expect(d.promise).resolves.toBe(3)
  })
})
