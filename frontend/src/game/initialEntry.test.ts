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
