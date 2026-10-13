/**
 * 初期入場の決定表と実行規則 (#734 PR2, ADR 0003 §5)。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  resolveInitialEntry,
  runInitialEntry,
  summarizeInitialEntry,
  type InitialEntryRenderer,
  type ResolveInitialEntryInput,
} from './initialEntry'
import { parseDebugQuery } from './debugQuery'
import type { NovelGameState } from './GameState'
import type { SceneEntryResult } from './sceneEntry'
import type { FlagValue } from '../types'

const SNAPSHOT = { sceneId: 'snap', flags: { s: { Bool: true } } } as unknown as NovelGameState

function input(over: Partial<ResolveInitialEntryInput> = {}): ResolveInitialEntryInput {
  return {
    snapshot: null,
    debugQuery: null,
    initialSceneId: null,
    confinedSceneIds: null,
    hasQuickSave: false,
    ...over,
  }
}

const kinds = (i: ResolveInitialEntryInput) => resolveInitialEntry(i).map((a) => a.kind)

describe('resolveInitialEntry: 決定表', () => {
  it('何も無い → エントリ', () => {
    expect(kinds(input())).toEqual(['entry'])
  })

  it('クイックセーブ有り → 自動クイックロード → エントリ', () => {
    expect(kinds(input({ hasQuickSave: true }))).toEqual(['quick-load', 'entry'])
  })

  it('?debug_scene= → debug 起点 → エントリ（自動クイックロードはしない）', () => {
    const debugQuery = parseDebugQuery('?debug_scene=x')
    expect(kinds(input({ debugQuery, hasQuickSave: true }))).toEqual(['debug-scene', 'entry'])
  })

  it('?debug_script= 単独でも自動クイックロードはしない（不整合8）', () => {
    const debugQuery = parseDebugQuery('?debug_script=advance')
    expect(kinds(input({ debugQuery, hasQuickSave: true }))).toEqual(['entry'])
  })

  it('?scene= → ?scene= の入場 → エントリ（自動クイックロードはしない）', () => {
    expect(
      kinds(input({ initialSceneId: 's', confinedSceneIds: ['s'], hasQuickSave: true }))
    ).toEqual(['scene-param', 'entry'])
    expect(resolveInitialEntry(input({ initialSceneId: 's', confinedSceneIds: ['s'] }))[0]).toEqual(
      { kind: 'scene-param', sceneId: 's', confinedSceneIds: ['s'] }
    )
  })

  it('?scene= と ?debug_scene= の併用 → debug が先、?scene= が次（confinement は ?scene= のものが残る）', () => {
    const debugQuery = parseDebugQuery('?debug_scene=x')
    const attempts = resolveInitialEntry(
      input({ debugQuery, initialSceneId: 's', confinedSceneIds: ['s'] })
    )
    expect(attempts.map((a) => a.kind)).toEqual(['debug-scene', 'scene-param', 'entry'])
    expect(attempts[1]).toMatchObject({ confinedSceneIds: ['s'] })
  })

  it('スナップショット（fluid 再マウント）→ 復元のみ。debug 起点・?scene=・自動クイックロードは再実行しない（不整合14）', () => {
    const debugQuery = parseDebugQuery('?debug_scene=x')
    expect(
      kinds(
        input({
          snapshot: SNAPSHOT,
          debugQuery,
          initialSceneId: 's',
          confinedSceneIds: ['s'],
          hasQuickSave: true,
        })
      )
    ).toEqual(['snapshot', 'entry'])
  })
})

function fakeRenderer(over: Partial<InitialEntryRenderer> = {}) {
  const entered: SceneEntryResult = { status: 'entered', sceneId: 'x' }
  const calls: string[] = []
  const renderer: InitialEntryRenderer = {
    restoreSnapshot: vi.fn(async () => {
      calls.push('snapshot')
      return entered
    }),
    startFrom: vi.fn(async (o) => {
      calls.push(`startFrom:${JSON.stringify(o)}`)
      return entered
    }),
    quickLoad: vi.fn(async () => {
      calls.push('quickLoad')
      return entered
    }),
    getQuickSaveFlags: vi.fn(() => null),
    ...over,
  }
  return { renderer, calls }
}

describe('runInitialEntry: 打ち切り規則', () => {
  it('entered で打ち切る（後続の試行は実行しない）', async () => {
    const { renderer, calls } = fakeRenderer()
    const out = await runInitialEntry(renderer, resolveInitialEntry(input({ hasQuickSave: true })))
    expect(calls).toEqual(['quickLoad'])
    expect(out.final.status).toBe('entered')
    expect(out.autoSave).toBe(true)
  })

  it('failed で次の試行へ進む（debug_scene 不在 → ?scene=）', async () => {
    const startFrom = vi
      .fn()
      .mockResolvedValueOnce({ status: 'failed', reason: 'not-found' })
      .mockResolvedValueOnce({ status: 'entered', sceneId: 's' })
    const { renderer } = fakeRenderer({ startFrom })
    const attempts = resolveInitialEntry(
      input({
        debugQuery: parseDebugQuery('?debug_scene=ghost'),
        initialSceneId: 's',
        confinedSceneIds: ['s'],
      })
    )
    const out = await runInitialEntry(renderer, attempts)
    expect(startFrom).toHaveBeenNthCalledWith(1, { sceneId: 'ghost', confinedSceneIds: null })
    expect(startFrom).toHaveBeenNthCalledWith(2, { sceneId: 's', confinedSceneIds: ['s'] })
    expect(startFrom).toHaveBeenCalledTimes(2)
    expect(summarizeInitialEntry(out)).toEqual({
      debugScene: { sceneId: 'ghost', entered: false },
    })
  })

  it('quickLoad が null（データ無し・ゲート）なら次（エントリ）へ進む', async () => {
    const { renderer, calls } = fakeRenderer({ quickLoad: vi.fn(async () => null) })
    await runInitialEntry(renderer, resolveInitialEntry(input({ hasQuickSave: true })))
    expect(calls).toEqual(['startFrom:{}'])
  })

  it('superseded で打ち切る（より新しい入場が始まっているので連鎖を続けない）', async () => {
    const { renderer, calls } = fakeRenderer({
      quickLoad: vi.fn(async () => ({ status: 'superseded' }) as const),
    })
    const out = await runInitialEntry(renderer, resolveInitialEntry(input({ hasQuickSave: true })))
    expect(calls).toEqual([]) // startFrom は呼ばれない
    expect(out.final).toEqual({ status: 'superseded' })
  })

  it('quickLoad が not-found で失敗 → セーブの flags を保ってエントリから始め、自動セーブは配線してよい', async () => {
    const flags: Record<string, FlagValue> = { milestone: { Bool: true } }
    const { renderer, calls } = fakeRenderer({
      quickLoad: vi.fn(async () => ({ status: 'failed', reason: 'not-found' }) as const),
      getQuickSaveFlags: vi.fn(() => flags),
    })
    const out = await runInitialEntry(renderer, resolveInitialEntry(input({ hasQuickSave: true })))
    expect(calls).toEqual([`startFrom:${JSON.stringify({ flags })}`])
    expect(out.autoSave).toBe(true)
  })

  it('quickLoad が resolver-error で失敗 → flags を保ってエントリから始めるが、自動セーブは配線しない', async () => {
    const flags: Record<string, FlagValue> = { milestone: { Bool: true } }
    const { renderer, calls } = fakeRenderer({
      quickLoad: vi.fn(async () => ({ status: 'failed', reason: 'resolver-error' }) as const),
      getQuickSaveFlags: vi.fn(() => flags),
    })
    const out = await runInitialEntry(renderer, resolveInitialEntry(input({ hasQuickSave: true })))
    expect(calls).toEqual([`startFrom:${JSON.stringify({ flags })}`])
    expect(out.autoSave).toBe(false)
  })

  it('スナップショットの復元が失敗したらスナップショットの flags を保ってエントリへ', async () => {
    const { renderer, calls } = fakeRenderer({
      restoreSnapshot: vi.fn(async () => ({ status: 'failed', reason: 'not-found' }) as const),
    })
    await runInitialEntry(renderer, resolveInitialEntry(input({ snapshot: SNAPSHOT })))
    expect(calls).toEqual([`startFrom:${JSON.stringify({ flags: SNAPSHOT.flags })}`])
  })
})

describe('resolveInitialEntry: 決定表の補足', () => {
  it('?debug_script= と ?scene= の併用 → ?scene= の入場 → エントリ（debug_script は入場の試行に含まれない）', () => {
    const debugQuery = parseDebugQuery('?debug_script=advance')
    expect(
      kinds(input({ debugQuery, initialSceneId: 's', confinedSceneIds: ['s'], hasQuickSave: true }))
    ).toEqual(['scene-param', 'entry'])
  })

  it('confinedSceneIds が undefined / null の ?scene= は confinement なし（null）で渡す', () => {
    for (const confinedSceneIds of [undefined, null]) {
      expect(resolveInitialEntry(input({ initialSceneId: 's', confinedSceneIds }))[0]).toEqual({
        kind: 'scene-param',
        sceneId: 's',
        confinedSceneIds: null,
      })
    }
  })

  it('空の initialSceneId（null / 空文字 / undefined）は ?scene= なしとして扱い、クイックセーブがあれば自動クイックロード', () => {
    for (const initialSceneId of [null, '', undefined]) {
      expect(kinds(input({ initialSceneId, hasQuickSave: true }))).toEqual(['quick-load', 'entry'])
    }
  })

  it('スナップショットがあれば hasQuickSave の値に関わらず自動クイックロードは試さない', () => {
    expect(kinds(input({ snapshot: SNAPSHOT, hasQuickSave: false }))).toEqual(['snapshot', 'entry'])
    expect(kinds(input({ snapshot: SNAPSHOT, hasQuickSave: true }))).toEqual(['snapshot', 'entry'])
  })

  it('空文字の ?debug_scene= / ?debug_script=（パース結果 null）は debug なし扱いで、自動クイックロードを試す', () => {
    for (const q of ['?debug_scene=', '?debug_script=']) {
      expect(kinds(input({ debugQuery: parseDebugQuery(q), hasQuickSave: true }))).toEqual([
        'quick-load',
        'entry',
      ])
    }
  })

  it('debug 起点の位置指定（eventIndex など）は options にそのまま載る', () => {
    const debugQuery = parseDebugQuery('?debug_scene=x&debug_eventIndex=3')
    const [first] = resolveInitialEntry(input({ debugQuery }))
    expect(first).toMatchObject({ kind: 'debug-scene', options: { sceneId: 'x', eventIndex: 3 } })
  })
})

describe('runInitialEntry: 打ち切り規則の補足', () => {
  const flags: Record<string, FlagValue> = { milestone: { Bool: true } }

  it('スナップショットが entered ならエントリへ進まない（fluid 再マウントで位置を上書きしない）', async () => {
    const { renderer, calls } = fakeRenderer()
    const out = await runInitialEntry(renderer, resolveInitialEntry(input({ snapshot: SNAPSHOT })))
    expect(calls).toEqual(['snapshot'])
    expect(out.final.status).toBe('entered')
    expect(out.autoSave).toBe(true)
  })

  it('スナップショットが superseded でもエントリへ進まない', async () => {
    const { renderer, calls } = fakeRenderer({
      restoreSnapshot: vi.fn(async () => ({ status: 'superseded' }) as const),
    })
    const out = await runInitialEntry(renderer, resolveInitialEntry(input({ snapshot: SNAPSHOT })))
    expect(calls).toEqual([])
    expect(out.final).toEqual({ status: 'superseded' })
  })

  it('スナップショット失敗 → エントリへ（flags 保持）。そのエントリが entered なら自動セーブは配線してよい', async () => {
    const { renderer } = fakeRenderer({
      restoreSnapshot: vi.fn(async () => ({ status: 'failed', reason: 'resolver-error' }) as const),
    })
    const out = await runInitialEntry(renderer, resolveInitialEntry(input({ snapshot: SNAPSHOT })))
    expect(out.autoSave).toBe(true)
    expect(out.steps.map((s) => s.attempt.kind)).toEqual(['snapshot', 'entry'])
  })

  it('スナップショットが失敗しても debug 起点・自動クイックロードは挟まない', async () => {
    const quickLoad = vi.fn(async () => null)
    const { renderer, calls } = fakeRenderer({
      restoreSnapshot: vi.fn(async () => ({ status: 'failed', reason: 'not-found' }) as const),
      quickLoad,
    })
    await runInitialEntry(
      renderer,
      resolveInitialEntry(
        input({
          snapshot: SNAPSHOT,
          debugQuery: parseDebugQuery('?debug_scene=x'),
          hasQuickSave: true,
        })
      )
    )
    expect(quickLoad).not.toHaveBeenCalled()
    expect(calls).toEqual([`startFrom:${JSON.stringify({ flags: SNAPSHOT.flags })}`])
  })

  it('quickLoad が apply-error で失敗 → flags を保ってエントリから始め、自動セーブは配線してよい', async () => {
    const { renderer, calls } = fakeRenderer({
      quickLoad: vi.fn(async () => ({ status: 'failed', reason: 'apply-error' }) as const),
      getQuickSaveFlags: vi.fn(() => flags),
    })
    const out = await runInitialEntry(renderer, resolveInitialEntry(input({ hasQuickSave: true })))
    expect(calls).toEqual([`startFrom:${JSON.stringify({ flags })}`])
    expect(out.autoSave).toBe(true)
  })

  it('quickLoad が null（ゲート）でもセーブの flags があればエントリへ引き継ぐ。flags が無ければ空の startFrom({})', async () => {
    const a = fakeRenderer({
      quickLoad: vi.fn(async () => null),
      getQuickSaveFlags: vi.fn(() => flags),
    })
    await runInitialEntry(a.renderer, resolveInitialEntry(input({ hasQuickSave: true })))
    expect(a.calls).toEqual([`startFrom:${JSON.stringify({ flags })}`])

    const b = fakeRenderer({ quickLoad: vi.fn(async () => null) })
    const out = await runInitialEntry(
      b.renderer,
      resolveInitialEntry(input({ hasQuickSave: true }))
    )
    expect(b.calls).toEqual(['startFrom:{}'])
    expect(out.autoSave).toBe(true)
  })

  it('?scene= が失敗してもエントリには flags を持ち越さない（startFrom({})）', async () => {
    const startFrom = vi
      .fn()
      .mockResolvedValueOnce({ status: 'failed', reason: 'not-found' })
      .mockResolvedValueOnce({ status: 'entered', sceneId: null })
    const { renderer } = fakeRenderer({ startFrom })
    await runInitialEntry(
      renderer,
      resolveInitialEntry(input({ initialSceneId: 'ghost', confinedSceneIds: ['ghost'] }))
    )
    expect(startFrom).toHaveBeenNthCalledWith(2, {})
  })

  it('debug 起点が entered なら ?scene= もエントリも試さない。debug は confinement を外して呼ぶ', async () => {
    const { renderer, calls } = fakeRenderer()
    const out = await runInitialEntry(
      renderer,
      resolveInitialEntry(
        input({
          debugQuery: parseDebugQuery('?debug_scene=x&debug_eventIndex=2'),
          initialSceneId: 's',
          confinedSceneIds: ['s'],
        })
      )
    )
    expect(calls).toHaveLength(1)
    const sent = JSON.parse(calls[0].replace('startFrom:', ''))
    expect(sent).toMatchObject({ sceneId: 'x', eventIndex: 2, confinedSceneIds: null })
    expect(out.steps).toHaveLength(1)
  })

  it('debug 起点が superseded なら ?scene= もエントリも試さない', async () => {
    const startFrom = vi.fn().mockResolvedValue({ status: 'superseded' })
    const { renderer } = fakeRenderer({ startFrom })
    const out = await runInitialEntry(
      renderer,
      resolveInitialEntry(
        input({
          debugQuery: parseDebugQuery('?debug_scene=x'),
          initialSceneId: 's',
          confinedSceneIds: ['s'],
        })
      )
    )
    expect(startFrom).toHaveBeenCalledTimes(1)
    expect(out.final).toEqual({ status: 'superseded' })
  })

  it('全試行が失敗したら最後（エントリ）の失敗が final。自動セーブは通信失敗でなければ true のまま', async () => {
    const startFrom = vi.fn().mockResolvedValue({ status: 'failed', reason: 'not-found' })
    const { renderer } = fakeRenderer({ startFrom })
    const out = await runInitialEntry(renderer, resolveInitialEntry(input()))
    expect(out.final).toEqual({ status: 'failed', reason: 'not-found' })
    expect(out.autoSave).toBe(true)
  })

  it('quickLoad の resolver-error の後、エントリが失敗しても自動セーブは配線しない（false を保つ）', async () => {
    const startFrom = vi.fn().mockResolvedValue({ status: 'failed', reason: 'not-found' })
    const { renderer } = fakeRenderer({
      startFrom,
      quickLoad: vi.fn(async () => ({ status: 'failed', reason: 'resolver-error' }) as const),
    })
    const out = await runInitialEntry(renderer, resolveInitialEntry(input({ hasQuickSave: true })))
    expect(out.autoSave).toBe(false)
  })
})

describe('summarizeInitialEntry', () => {
  it('debug 起点を試していなければ debugScene は null', async () => {
    const { renderer } = fakeRenderer()
    const out = await runInitialEntry(renderer, resolveInitialEntry(input()))
    expect(summarizeInitialEntry(out)).toEqual({ debugScene: null })
  })

  it('debug 起点が入場できたら entered: true', async () => {
    const { renderer } = fakeRenderer()
    const out = await runInitialEntry(
      renderer,
      resolveInitialEntry(input({ debugQuery: parseDebugQuery('?debug_scene=x') }))
    )
    expect(summarizeInitialEntry(out)).toEqual({ debugScene: { sceneId: 'x', entered: true } })
  })

  it('debug 起点が superseded でも entered ではない', async () => {
    const { renderer } = fakeRenderer({
      startFrom: vi.fn().mockResolvedValue({ status: 'superseded' }),
    })
    const out = await runInitialEntry(
      renderer,
      resolveInitialEntry(input({ debugQuery: parseDebugQuery('?debug_scene=x') }))
    )
    expect(summarizeInitialEntry(out).debugScene).toEqual({ sceneId: 'x', entered: false })
  })

  it('?debug_script= だけなら debugScene は null（script は入場の試行でない）', async () => {
    const { renderer } = fakeRenderer()
    const out = await runInitialEntry(
      renderer,
      resolveInitialEntry(input({ debugQuery: parseDebugQuery('?debug_script=advance') }))
    )
    expect(summarizeInitialEntry(out)).toEqual({ debugScene: null })
  })
})
