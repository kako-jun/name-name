/**
 * 一枚絵フィールドの脚本トリガー判定 (#1072) の純関数テスト。
 * 場面移動後の inside のクリア・once の記録は呼び出し側 (startFieldGame) の責務なので、ここでは扱わない。
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TRIGGER_RADIUS, type FieldTrigger } from './config'
import { autoTriggers, isInsideCircle, stepTriggers, triggerKey } from './triggerRuntime'

const step = (x: number, y: number, radius = 48, event = 'e', once = false): FieldTrigger => ({
  auto: false,
  x,
  y,
  radius,
  event,
  once,
})
const auto = (event: string, once = false): FieldTrigger => ({ auto: true, event, once })
const none = new Set<never>()

describe('triggerKey', () => {
  it('場面ID#添字 になる', () => {
    expect(triggerKey('本堂', 2)).toBe('本堂#2')
  })
})

describe('isInsideCircle', () => {
  const c = { x: 100, y: 100 }
  it('半径-1 は内側', () => expect(isInsideCircle({ x: 147, y: 100 }, c, 48)).toBe(true))
  it('半径ちょうど（円周上）は内側', () =>
    expect(isInsideCircle({ x: 148, y: 100 }, c, 48)).toBe(true))
  it('半径+1 は外側', () => expect(isInsideCircle({ x: 149, y: 100 }, c, 48)).toBe(false))
  it('斜めでも距離で判定する（3-4-5 の円周上は内側）', () => {
    expect(isInsideCircle({ x: 103, y: 104 }, c, 5)).toBe(true)
    expect(isInsideCircle({ x: 104, y: 105 }, c, 5)).toBe(false)
  })
  it('既定半径 32 の境界 3 点', () => {
    expect(DEFAULT_TRIGGER_RADIUS).toBe(32)
    expect(isInsideCircle({ x: 131, y: 100 }, c, DEFAULT_TRIGGER_RADIUS)).toBe(true)
    expect(isInsideCircle({ x: 132, y: 100 }, c, DEFAULT_TRIGGER_RADIUS)).toBe(true)
    expect(isInsideCircle({ x: 133, y: 100 }, c, DEFAULT_TRIGGER_RADIUS)).toBe(false)
  })
})

describe('stepTriggers', () => {
  const base = { sceneId: 's', onceFired: new Set<string>() }

  it('外 → 内で 1 回だけ発火する', () => {
    const triggers = [step(100, 100, 32, 'go')]
    const r = stepTriggers({ ...base, pos: { x: 100, y: 100 }, triggers, inside: none })
    expect(r.fired).toEqual([{ key: 's#0', event: 'go', once: false }])
    expect([...r.inside]).toEqual([0])
  })

  it('円周上（半径ちょうど）でも発火する', () => {
    const r = stepTriggers({
      ...base,
      pos: { x: 132, y: 100 },
      triggers: [step(100, 100, 32)],
      inside: none,
    })
    expect(r.fired).toHaveLength(1)
  })

  it('半径+1 では発火しない', () => {
    const r = stepTriggers({
      ...base,
      pos: { x: 133, y: 100 },
      triggers: [step(100, 100, 32)],
      inside: none,
    })
    expect(r.fired).toEqual([])
    expect(r.inside.size).toBe(0)
  })

  it('内に居続けても再発火しない', () => {
    const triggers = [step(100, 100, 32)]
    const r = stepTriggers({ ...base, pos: { x: 101, y: 100 }, triggers, inside: new Set([0]) })
    expect(r.fired).toEqual([])
    expect([...r.inside]).toEqual([0])
  })

  it('内 → 外 → 内で再発火する', () => {
    const triggers = [step(100, 100, 32)]
    let inside: ReadonlySet<number> = none
    const at = (x: number) => {
      const r = stepTriggers({ ...base, pos: { x, y: 100 }, triggers, inside })
      inside = r.inside
      return r.fired.length
    }
    expect(at(100)).toBe(1)
    expect(at(200)).toBe(0)
    expect(inside.size).toBe(0)
    expect(at(100)).toBe(1)
  })

  it('once 発火済みは再入場で発火しないが inside には入る', () => {
    const triggers = [step(100, 100, 32, 'e', true)]
    const r = stepTriggers({
      sceneId: 's',
      pos: { x: 100, y: 100 },
      triggers,
      inside: none,
      onceFired: new Set(['s#0']),
    })
    expect(r.fired).toEqual([])
    expect([...r.inside]).toEqual([0])
  })

  it('once 未記録なら once=true で発火し、key と once を返す', () => {
    const r = stepTriggers({
      ...base,
      pos: { x: 100, y: 100 },
      triggers: [step(100, 100, 32, 'e', true)],
      inside: none,
    })
    expect(r.fired).toEqual([{ key: 's#0', event: 'e', once: true }])
  })

  it('別の場面の once 記録は影響しない', () => {
    const r = stepTriggers({
      sceneId: 's',
      pos: { x: 100, y: 100 },
      triggers: [step(100, 100, 32, 'e', true)],
      inside: none,
      onceFired: new Set(['other#0']),
    })
    expect(r.fired).toHaveLength(1)
  })

  it('auto トリガーは踏み込み判定に出ない（添字はそのまま数える）', () => {
    const r = stepTriggers({
      ...base,
      pos: { x: 100, y: 100 },
      triggers: [auto('a'), step(100, 100, 32, 'b')],
      inside: none,
    })
    expect(r.fired).toEqual([{ key: 's#1', event: 'b', once: false }])
    expect([...r.inside]).toEqual([1])
  })

  it('複数トリガーは書いた順（添字順）に fired に出る', () => {
    const r = stepTriggers({
      ...base,
      pos: { x: 100, y: 100 },
      triggers: [
        step(100, 100, 32, 'first'),
        step(500, 500, 32, 'far'),
        step(110, 100, 32, 'third'),
      ],
      inside: none,
    })
    expect(r.fired.map((f) => f.event)).toEqual(['first', 'third'])
    expect([...r.inside]).toEqual([0, 2])
  })

  it('入力集合を破壊しない', () => {
    const inside = new Set([5])
    const onceFired = new Set(['s#0'])
    const triggers = [step(100, 100, 32, 'e', true)]
    const frozenTriggers = JSON.stringify(triggers)
    const r = stepTriggers({ sceneId: 's', pos: { x: 100, y: 100 }, triggers, inside, onceFired })
    expect([...inside]).toEqual([5])
    expect([...onceFired]).toEqual(['s#0'])
    expect(JSON.stringify(triggers)).toBe(frozenTriggers)
    expect(r.inside).not.toBe(inside)
  })

  it('正常系で console.warn を出さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stepTriggers({ ...base, pos: { x: 1, y: 1 }, triggers: [step(1, 1)], inside: none })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('autoTriggers', () => {
  const base = { sceneId: 's', onceFired: new Set<string>(), resumedStart: false }

  it('auto だけを書いた順に返す（踏み込みは除く）', () => {
    const r = autoTriggers({ ...base, triggers: [auto('a'), step(1, 1), auto('b')] })
    expect(r).toEqual([
      { key: 's#0', event: 'a', once: false },
      { key: 's#2', event: 'b', once: false },
    ])
  })

  it('resumedStart=true なら空', () => {
    expect(autoTriggers({ ...base, resumedStart: true, triggers: [auto('a')] })).toEqual([])
  })

  it('once 記録済みは除外し、未記録は残す', () => {
    const r = autoTriggers({
      ...base,
      onceFired: new Set(['s#0']),
      triggers: [auto('a', true), auto('b', true), auto('c')],
    })
    expect(r.map((f) => f.event)).toEqual(['b', 'c'])
  })

  it('トリガーが無ければ空', () => {
    expect(autoTriggers({ ...base, triggers: [] })).toEqual([])
  })

  it('入力を破壊しない', () => {
    const onceFired = new Set(['s#0'])
    const triggers = [auto('a', true)]
    autoTriggers({ ...base, onceFired, triggers })
    expect([...onceFired]).toEqual(['s#0'])
    expect(triggers).toHaveLength(1)
  })
})
