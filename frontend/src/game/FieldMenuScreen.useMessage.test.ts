/**
 * FieldMenuScreen の「使用成功の文」配線 (#1185)。`useMessage: false` のとき ok=true の文だけを出さず、
 * 失敗の文（ok=false）と HP の数字更新は従来どおり。未指定は従来どおり出す。
 */
import { describe, expect, it, vi } from 'vitest'
import { FieldMenuScreen, type FieldUseOutcome } from './FieldMenuScreen'
import type { FieldMenuItemDef } from './fieldMenu'

const E = (label: string, extra: Record<string, unknown> = {}) => ({ label, id: label, ...extra })
const ITEMS: FieldMenuItemDef[] = [
  {
    id: 'magic',
    label: 'まほう',
    content: { entriesByParty: { a: [E('かいふく', { target: 'all' })] } },
  },
  {
    id: 'item',
    label: 'どうぐ',
    content: {
      tabs: [{ label: 'つかう', action: 'use', entries: [E('ポーション', { target: 'single' })] }],
    },
  },
  { id: 'equip', label: 'そうび', content: { entriesByParty: { a: [E('かたな')] } } },
  {
    id: 'appstore',
    label: 'アプリストア',
    content: {
      tabs: [
        { label: 'かう', entries: [E('アプリ')] },
        { label: 'うる', action: 'sell', entries: [E('アプリ')] },
      ],
    },
  },
]

type Step = Parameters<FieldMenuScreen['dispatch']>[0]
const FLOWS: Record<string, Step[]> = {
  magic: [
    { type: 'select', target: 'party', index: 0 },
    { type: 'select', target: 'list', index: 0 },
  ],
  item: [
    { type: 'select', target: 'tab', index: 0 },
    { type: 'select', target: 'list', index: 0 },
    { type: 'confirm' },
  ],
  equip: [
    { type: 'select', target: 'party', index: 0 },
    { type: 'select', target: 'list', index: 0 },
  ],
  appstore: [
    { type: 'select', target: 'tab', index: 0 },
    { type: 'select', target: 'list', index: 0 },
    { type: 'select', target: 'confirm', index: 0 },
  ],
  appstoreSell: [
    { type: 'select', target: 'tab', index: 1 },
    { type: 'select', target: 'list', index: 0 },
    { type: 'select', target: 'confirm', index: 0 },
  ],
}

function setup(
  screen: string,
  useMessage: boolean | undefined,
  outcome: FieldUseOutcome,
  flow = screen
) {
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
    party: [{ id: 'a', name: 'A', hp: 10, maxHp: 30, mp: 5, maxMp: 5, texture: null }],
    info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
    slots: [null, null, null],
  })
  s.dispatch({ type: 'tap', index: ITEMS.findIndex((i) => i.id === screen) })
  s.tick(10_000)
  for (const st of FLOWS[flow]) s.dispatch(st)
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

  it('未指定・true は成功の文を出す（従来どおり）', () => {
    for (const v of [undefined, true]) {
      const { s, onUse } = setup('magic', v, ok)
      expect(onUse).toHaveBeenCalledTimes(1)
      expect(s.current).toMatchObject({ notice: ok.notice })
      expect(hpOf(s)).toBe(30)
    }
  })
  it('useMessage: false のまほうは成功の文を出さず、HP の数字は更新する', () => {
    const { s, onUse } = setup('magic', false, ok)
    expect(onUse).toHaveBeenCalledTimes(1)
    expect(s.current).toMatchObject({ notice: null })
    expect(hpOf(s)).toBe(30)
  })
  it('useMessage: false のどうぐ（単体）も成功の文を出さず、所持数の差し替えは反映する', () => {
    const out: FieldUseOutcome = {
      ok: true,
      notice: 'A は 20 回復した！',
      party: [{ id: 'a', hp: 30 }],
      items: [
        {
          id: 'item',
          label: 'どうぐ',
          content: { tabs: [{ label: 'つかう', action: 'use', entries: [] }] },
        },
      ],
    }
    const { s, onUse } = setup('item', false, out)
    expect(onUse).toHaveBeenCalledTimes(1)
    expect(s.current).toMatchObject({ notice: null })
    expect(hpOf(s)).toBe(30)
    const contents = (
      s as unknown as { contents: Record<string, { tabs: { entries: unknown[] }[] }> }
    ).contents
    expect(contents.item.tabs[0].entries).toHaveLength(0)
  })
  it('useMessage: false でも失敗の文は出す', () => {
    const { s } = setup('magic', false, ng)
    expect(s.current).toMatchObject({ notice: 'MPが たりない！' })
    expect(hpOf(s)).toBe(10)
  })
  it('useMessage: false でも、そうび・アプリストアの成功の文は出す', () => {
    for (const [screen, flow] of [
      ['equip', 'equip'],
      ['appstore', 'appstore'],
      ['appstore', 'appstoreSell'],
    ]) {
      const { s, onUse } = setup(screen, false, { ok: true, notice: `${flow} ok` }, flow)
      expect(onUse).toHaveBeenCalledTimes(1)
      expect(s.current).toMatchObject({ notice: `${flow} ok` })
    }
  })
})
