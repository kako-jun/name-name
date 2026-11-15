/**
 * FieldMenuScreen の「使用成功の文」配線 (#1185)。`useMessage: false` のとき ok=true の文だけを出さず、
 * 失敗の文（ok=false）と HP の数字更新は従来どおり。未指定は従来どおり出す。
 */
import { describe, expect, it, vi } from 'vitest'
import { FieldMenuScreen, type FieldUseOutcome } from './FieldMenuScreen'
import type { FieldMenuItemDef } from './fieldMenu'

const ITEMS: FieldMenuItemDef[] = [
  {
    id: 'magic',
    label: 'まほう',
    content: {
      entriesByParty: {
        a: [{ label: 'かいふく', id: 'heal', target: 'all' }],
      },
    },
  },
]

function setup(useMessage: boolean | undefined, outcome: FieldUseOutcome) {
  const onUse = vi.fn(() => outcome)
  const s = new FieldMenuScreen({
    width: 1600,
    height: 900,
    acrylic: false,
    onClose: () => {},
    onUse,
    ...(useMessage !== undefined ? { useMessage } : {}),
  })
  s.open({
    items: ITEMS,
    party: [{ id: 'a', name: 'A', hp: 10, maxHp: 30, mp: 5, maxMp: 5 }],
    info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
    slots: [null, null, null],
  })
  s.dispatch({ type: 'tap', index: 0 })
  s.tick(10_000)
  s.dispatch({ type: 'select', target: 'party', index: 0 })
  s.dispatch({ type: 'select', target: 'list', index: 0 })
  return { s, onUse }
}

const hpOf = (s: FieldMenuScreen) =>
  (s as unknown as { data: { party: { hp: number }[] } }).data.party[0].hp

describe('FieldMenuScreen: 使用成功の文 (#1185)', () => {
  const ok: FieldUseOutcome = {
    ok: true,
    notice: 'A は かいふく を となえた！',
    party: [{ id: 'a', hp: 30 }],
  }
  const ng: FieldUseOutcome = { ok: false, notice: 'MPが たりない！' }

  it('未指定は成功の文を出す（従来どおり）', () => {
    const { s, onUse } = setup(undefined, ok)
    expect(onUse).toHaveBeenCalledTimes(1)
    expect(s.current).toMatchObject({ notice: ok.notice })
    expect(hpOf(s)).toBe(30)
  })
  it('useMessage: true も出す', () => {
    const { s } = setup(true, ok)
    expect(s.current).toMatchObject({ notice: ok.notice })
  })
  it('useMessage: false は成功の文を出さず、HP の数字は更新する', () => {
    const { s, onUse } = setup(false, ok)
    expect(onUse).toHaveBeenCalledTimes(1)
    expect(s.current).toMatchObject({ notice: null })
    expect(hpOf(s)).toBe(30)
  })
  it('useMessage: false でも失敗の文は出す', () => {
    const { s } = setup(false, ng)
    expect(s.current).toMatchObject({ notice: 'MPが たりない！' })
    expect(hpOf(s)).toBe(10)
  })
})
