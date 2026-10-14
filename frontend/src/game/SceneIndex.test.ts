/**
 * SceneIndex（シーン索引・エントリ文書・遅延ロードの共有 Promise・線形区間キャッシュ）の単体テスト
 * (#823, #735 2/8)。NovelRenderer は import しない。
 *
 * 切り出し前の `NovelRenderer.requestMissingScene` / `resolveScene` / `getLinearSegments` /
 * `linearStartIndex` / `isEntryStreamActive` を `origin/main` の実装から写した数行を「リファレンス」として
 * このファイルに置き、複数入力で突き合わせる（doctrine 規律3）。リファレンスは切り出し後のコードを呼ばない。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Event, EventScene, FlagValue } from '../types'
import { GameState, resolveEvents } from './GameState'
import { findSceneById } from './novelLayout'
import { findLinearSegments, resolveLinearSegments } from './sceneEntry'
import { SceneIndex, type MissingSceneResolver } from './SceneIndex'

const narration = (...lines: string[]): Event => ({ Narration: { text: lines } })
const scene = (id: string, events: Event[]): EventScene => ({
  id,
  title: id,
  view: 'TopDown',
  events,
})
const cond = (name: string, events: Event[]): Event => ({ Condition: { flag: name, events } })
function flatten(scenes: EventScene[]): Event[] {
  const events: Event[] = []
  scenes.forEach((s, i) => {
    if (i > 0) events.push('SceneTransition')
    events.push(...s.events)
  })
  return events
}

/** 解決を手動で完了できる resolver。 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------
describe('SceneIndex.resolve', () => {
  it('読み込み済みなら同期で found を返す（Promise ではない）', () => {
    const idx = new SceneIndex()
    const a = scene('a', [narration('a')])
    idx.setJumpSceneIndex([a])
    const r = idx.resolve('a')
    expect(r instanceof Promise).toBe(false)
    expect(r).toEqual({ status: 'found', scene: a })
  })

  it('読み込み済みなら resolver が設定されていても呼ばない', () => {
    const idx = new SceneIndex()
    const resolver = vi.fn<MissingSceneResolver>()
    idx.setMissingSceneResolver(resolver)
    idx.setJumpSceneIndex([scene('a', [])])
    idx.resolve('a')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('未ロードで resolver なしなら同期で failed/not-found（isDefinitelyUnresolvable が true）', () => {
    const idx = new SceneIndex()
    idx.setJumpSceneIndex([scene('a', [])])
    expect(idx.isDefinitelyUnresolvable('zzz')).toBe(true)
    const r = idx.resolve('zzz')
    expect(r instanceof Promise).toBe(false)
    expect(r).toMatchObject({ status: 'failed', reason: 'not-found' })
  })

  it('isDefinitelyUnresolvable: 読み込み済みなら false、resolver があれば未ロードでも false', () => {
    const idx = new SceneIndex()
    idx.setJumpSceneIndex([scene('a', [])])
    expect(idx.isDefinitelyUnresolvable('a')).toBe(false)
    idx.setMissingSceneResolver(async () => null)
    expect(idx.isDefinitelyUnresolvable('zzz')).toBe(false)
    idx.setMissingSceneResolver(null)
    expect(idx.isDefinitelyUnresolvable('zzz')).toBe(true)
  })

  it('未ロードで resolver ありなら Promise で loaded を返し、索引はまだ更新しない', async () => {
    const idx = new SceneIndex()
    const b = scene('b', [narration('b')])
    idx.setMissingSceneResolver(async () => [b])
    const r = idx.resolve('b')
    expect(r instanceof Promise).toBe(true)
    expect(await r).toEqual({ status: 'loaded', scenes: [b] })
    expect(idx.getScenes()).toEqual([])
    expect(idx.findScene('b')).toBeUndefined()
  })

  it('resolver が null を返すと failed/not-found', async () => {
    const idx = new SceneIndex()
    idx.setMissingSceneResolver(async () => null)
    expect(await idx.resolve('b')).toMatchObject({ status: 'failed', reason: 'not-found' })
  })

  it('resolver が reject すると failed/resolver-error（error を保持する）', async () => {
    const idx = new SceneIndex()
    const boom = new Error('net')
    idx.setMissingSceneResolver(() => Promise.reject(boom))
    const r = await idx.resolve('b')
    expect(r).toMatchObject({ status: 'failed', reason: 'resolver-error' })
    expect((r as { error?: unknown }).error).toBe(boom)
  })

  it('resolver が同期 throw しても failed/resolver-error（error を保持する）', async () => {
    const idx = new SceneIndex()
    const boom = new Error('sync')
    idx.setMissingSceneResolver(() => {
      throw boom
    })
    const r = await idx.resolve('b')
    expect(r).toMatchObject({ status: 'failed', reason: 'resolver-error' })
    expect((r as { error?: unknown }).error).toBe(boom)
  })
})

// ---------------------------------------------------------------------------
// requestMissingScene
// ---------------------------------------------------------------------------
describe('SceneIndex.requestMissingScene', () => {
  it('同一 sceneId の二重要求で resolver は1回だけ呼ばれ、同一 Promise を共有する', async () => {
    const idx = new SceneIndex()
    const d = deferred<EventScene[] | null>()
    const resolver = vi.fn<MissingSceneResolver>(() => d.promise)
    idx.setMissingSceneResolver(resolver)
    const p1 = idx.requestMissingScene('x')
    const p2 = idx.requestMissingScene('x')
    expect(p2).toBe(p1)
    expect(resolver).toHaveBeenCalledTimes(1)
    const x = scene('x', [])
    d.resolve([x])
    expect(await p1).toEqual([x])
  })

  it('別 sceneId は独立して resolver を呼ぶ', () => {
    const idx = new SceneIndex()
    const resolver = vi.fn<MissingSceneResolver>(() => new Promise(() => {}))
    idx.setMissingSceneResolver(resolver)
    const p1 = idx.requestMissingScene('x')
    const p2 = idx.requestMissingScene('y')
    expect(p2).not.toBe(p1)
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(resolver).toHaveBeenNthCalledWith(1, 'x')
    expect(resolver).toHaveBeenNthCalledWith(2, 'y')
  })

  it('成功で settle した後は pending から消え、再要求で resolver が再度呼ばれる', async () => {
    const idx = new SceneIndex()
    const resolver = vi.fn<MissingSceneResolver>(async () => [scene('x', [])])
    idx.setMissingSceneResolver(resolver)
    const p1 = idx.requestMissingScene('x')
    await p1
    await Promise.resolve() // 副チェーン（取り除き）を流す
    const p2 = idx.requestMissingScene('x')
    expect(p2).not.toBe(p1)
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('失敗で settle した後も pending から消え、再要求で resolver が再度呼ばれる', async () => {
    const idx = new SceneIndex()
    const resolver = vi.fn<MissingSceneResolver>(() => Promise.reject(new Error('x')))
    idx.setMissingSceneResolver(resolver)
    const p1 = idx.requestMissingScene('x')
    await p1.catch(() => {})
    await Promise.resolve()
    const p2 = idx.requestMissingScene('x')
    p2.catch(() => {})
    expect(p2).not.toBe(p1)
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('解決中は共有され、settle の前に再要求しても resolver は増えない', async () => {
    const idx = new SceneIndex()
    const d = deferred<EventScene[] | null>()
    const resolver = vi.fn<MissingSceneResolver>(() => d.promise)
    idx.setMissingSceneResolver(resolver)
    idx.requestMissingScene('x')
    await Promise.resolve()
    idx.requestMissingScene('x')
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('resolver 未設定でも null で解決する', async () => {
    const idx = new SceneIndex()
    expect(await idx.requestMissingScene('x')).toBeNull()
  })

  it('resolver の同期 throw は reject に畳まれる', async () => {
    const idx = new SceneIndex()
    idx.setMissingSceneResolver(() => {
      throw new Error('sync')
    })
    await expect(idx.requestMissingScene('x')).rejects.toThrow('sync')
  })

  it('resolve 経由でも二重要求は resolver 1回に束ねられる', async () => {
    const idx = new SceneIndex()
    const d = deferred<EventScene[] | null>()
    const resolver = vi.fn<MissingSceneResolver>(() => d.promise)
    idx.setMissingSceneResolver(resolver)
    const r1 = idx.resolve('x') as Promise<unknown>
    const r2 = idx.resolve('x') as Promise<unknown>
    d.resolve([scene('x', [])])
    await Promise.all([r1, r2])
    expect(resolver).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// indexLoaded / setJumpSceneIndex
// ---------------------------------------------------------------------------
describe('SceneIndex.indexLoaded / setJumpSceneIndex', () => {
  it('反映後に目的シーンがあれば found、無ければ failed/not-found', () => {
    const idx = new SceneIndex()
    const b = scene('b', [])
    expect(idx.indexLoaded('b', [b])).toEqual({ status: 'found', scene: b })
    expect(idx.findScene('b')).toBe(b)
    expect(idx.indexLoaded('c', [b])).toMatchObject({ status: 'failed', reason: 'not-found' })
  })

  it('setJumpSceneIndex は置換であり累積しない', () => {
    const idx = new SceneIndex()
    idx.setJumpSceneIndex([scene('a', []), scene('b', [])])
    idx.setJumpSceneIndex([scene('c', [])])
    expect(idx.getAllSceneIds()).toEqual(['c'])
    expect(idx.findScene('a')).toBeUndefined()
    // indexLoaded も置換（先に読み込んだ a は消える）
    idx.indexLoaded('d', [scene('d', [])])
    expect(idx.getAllSceneIds()).toEqual(['d'])
  })

  it('setJumpSceneIndex はエントリ文書に触れない', () => {
    const idx = new SceneIndex()
    const events = [narration('e')]
    idx.setEntry(events, 's')
    idx.setJumpSceneIndex([scene('a', [])])
    expect(idx.getEntryEvents()).toEqual(events)
    expect(idx.getEntrySceneId()).toBe('s')
  })
})

// ---------------------------------------------------------------------------
// setEntry
// ---------------------------------------------------------------------------
describe('SceneIndex.setEntry', () => {
  it('setEntry は events をコピーする（渡した配列を後から変更しても影響しない）', () => {
    const idx = new SceneIndex()
    const events = [narration('a')]
    idx.setEntry(events)
    expect(idx.getEntryEvents()).not.toBe(events)
    events.push(narration('b'))
    expect(idx.getEntryEvents()).toHaveLength(1)
    // 要素の参照は保つ（isEntryStreamActive の参照比較の前提）
    expect(idx.getEntryEvents()[0]).toBe(events[0])
  })

  it('setEntry は sceneId を省略すると entrySceneId を null にする（前の sceneId を引き継がない）', () => {
    const idx = new SceneIndex()
    idx.setEntry([narration('a')], 's')
    expect(idx.getEntrySceneId()).toBe('s')
    idx.setEntry([narration('a')])
    expect(idx.getEntrySceneId()).toBeNull()
  })

  it('setEntry([]) で旧文書が残らない（0件 loadScenes 相当）', () => {
    const idx = new SceneIndex()
    idx.setEntry([narration('a')], 's')
    idx.setEntry([])
    expect(idx.getEntryEvents()).toEqual([])
    expect(idx.getEntrySceneId()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isEntryStreamActive
// ---------------------------------------------------------------------------
describe('SceneIndex.isEntryStreamActive', () => {
  function entryIndex(sceneId: string | null) {
    const idx = new SceneIndex()
    const a = narration('a')
    const b = narration('b')
    idx.setEntry([a, b], sceneId)
    return { idx, a, b }
  }

  it('currentSceneId が entrySceneId と一致し、要素参照が全て同じなら true', () => {
    const { idx, a, b } = entryIndex('s')
    expect(idx.isEntryStreamActive('s', [a, b])).toBe(true)
  })

  it('loadEvents 経路（entrySceneId null）で currentSceneId null なら true', () => {
    const { idx, a, b } = entryIndex(null)
    expect(idx.isEntryStreamActive(null, [a, b])).toBe(true)
  })

  it('currentSceneId が entrySceneId と不一致なら false', () => {
    const { idx, a, b } = entryIndex('s')
    expect(idx.isEntryStreamActive('other', [a, b])).toBe(false)
    expect(idx.isEntryStreamActive(null, [a, b])).toBe(false)
    const n = entryIndex(null)
    expect(n.idx.isEntryStreamActive('s', [n.a, n.b])).toBe(false)
  })

  it('要素参照が1つでも違えば false（内容が同じでも別オブジェクトなら false）', () => {
    const { idx, a } = entryIndex('s')
    expect(idx.isEntryStreamActive('s', [a, narration('b')])).toBe(false)
    expect(idx.isEntryStreamActive('s', [narration('a'), narration('b')])).toBe(false)
  })

  it('長さ違いは false', () => {
    const { idx, a, b } = entryIndex('s')
    expect(idx.isEntryStreamActive('s', [a])).toBe(false)
    expect(idx.isEntryStreamActive('s', [a, b, b])).toBe(false)
  })

  it('entry が空なら false（空同士でも）', () => {
    const idx = new SceneIndex()
    expect(idx.isEntryStreamActive(null, [])).toBe(false)
  })

  it('旧実装（origin/main の isEntryStreamActive）と複数入力で一致する', () => {
    // origin/main の NovelRenderer.isEntryStreamActive を写したリファレンス
    function reference(
      currentSceneId: string | null,
      entrySceneId: string | null,
      raw: readonly Event[],
      entry: readonly Event[]
    ): boolean {
      if (currentSceneId !== entrySceneId) return false
      if (raw.length !== entry.length || entry.length === 0) return false
      for (let i = 0; i < raw.length; i++) if (raw[i] !== entry[i]) return false
      return true
    }
    const a = narration('a')
    const b = narration('b')
    const c = narration('c')
    const entries: Event[][] = [[], [a], [a, b]]
    const raws: Event[][] = [[], [a], [a, b], [b, a], [a, c], [a, b, c], [narration('a')]]
    const ids: Array<string | null> = [null, 's', 't']
    for (const entry of entries) {
      for (const entryId of ids) {
        const idx = new SceneIndex()
        idx.setEntry(entry, entryId)
        for (const raw of raws) {
          for (const cur of ids) {
            expect(
              idx.isEntryStreamActive(cur, raw),
              `${entry.length}/${entryId}/${raw.length}/${cur}`
            ).toBe(reference(cur, entryId, raw, entry))
          }
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// getLinearSegments / resolveLinearSegmentsNow / linearStartIndex
// ---------------------------------------------------------------------------
describe('SceneIndex.getLinearSegments', () => {
  const scenes = [
    scene('a', [narration('a1')]),
    scene('b', [narration('b1')]),
    scene('c', [narration('c1')]),
  ]

  it('エントリ文書が allScenes 上で連続しているとき、線形区間を検出する (#777)', () => {
    const idx = new SceneIndex()
    idx.setEntry(flatten(scenes))
    idx.setJumpSceneIndex(scenes)
    expect(idx.getLinearSegments()).toEqual([
      { sceneId: 'a', start: 0, length: 1 },
      { sceneId: 'b', start: 2, length: 1 },
      { sceneId: 'c', start: 4, length: 1 },
    ])
  })

  it('entryRawEvents と allScenes の参照が同じならキャッシュ（同一配列インスタンス）を返す', () => {
    const idx = new SceneIndex()
    idx.setEntry(flatten(scenes))
    idx.setJumpSceneIndex(scenes)
    const first = idx.getLinearSegments()
    expect(idx.getLinearSegments()).toBe(first)
  })

  it('setEntry 後は引き直す（新しい配列インスタンス）', () => {
    const idx = new SceneIndex()
    idx.setEntry(flatten(scenes))
    idx.setJumpSceneIndex(scenes)
    const first = idx.getLinearSegments()
    idx.setEntry(flatten(scenes)) // 同じ内容でも entryRawEvents は新しいコピー
    const second = idx.getLinearSegments()
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  })

  it('setJumpSceneIndex 後は引き直す（同じ内容の別配列でも、結果が変わるなら反映される）', () => {
    const idx = new SceneIndex()
    idx.setEntry(flatten(scenes))
    idx.setJumpSceneIndex(scenes)
    const first = idx.getLinearSegments()
    expect(first).toHaveLength(3)
    idx.setJumpSceneIndex(scenes.slice(0, 2))
    const second = idx.getLinearSegments()
    expect(second).not.toBe(first)
    expect(second.map((s) => s.sceneId)).toEqual(['a', 'b'])
  })

  it('索引が空なら区間は 0 件', () => {
    const idx = new SceneIndex()
    idx.setEntry(flatten(scenes))
    expect(idx.getLinearSegments()).toEqual([])
  })

  it('旧実装（findLinearSegments(entryRawEvents, allScenes)）と複数入力で一致する', () => {
    const one = scene('one', [narration('o')])
    const empty = scene('empty', [])
    const cases: Array<{ entry: Event[]; index: EventScene[] }> = [
      { entry: flatten(scenes), index: scenes },
      { entry: flatten(scenes.slice(0, 2)), index: scenes },
      { entry: flatten([scenes[1], scenes[2]]), index: scenes }, // 先頭が a でない
      { entry: flatten([one]), index: [one] },
      { entry: flatten([scenes[0], empty, scenes[2]]), index: [scenes[0], empty, scenes[2]] },
      { entry: [narration('x')], index: scenes }, // 照合できない
      { entry: [], index: scenes },
      { entry: flatten(scenes), index: [] },
      { entry: flatten(scenes), index: [scenes[2], scenes[0], scenes[1]] }, // 並びが違う
    ]
    for (const [i, { entry, index }] of cases.entries()) {
      const idx = new SceneIndex()
      idx.setEntry(entry)
      idx.setJumpSceneIndex(index)
      // リファレンス: origin/main は this.entryRawEvents（setEntry のコピー）と this.allScenes で引いていた
      const ref = findLinearSegments([...entry], index)
      expect(idx.getLinearSegments(), `case ${i}`).toEqual(ref)
    }
  })
})

describe('SceneIndex.resolveLinearSegmentsNow', () => {
  const scenes = [scene('a', [narration('a1')]), scene('b', [narration('b1'), narration('b2')])]
  const count = (events: readonly Event[]): number => events.length

  function active() {
    const idx = new SceneIndex()
    idx.setEntry(flatten(scenes))
    idx.setJumpSceneIndex(scenes)
    return idx
  }

  it('アクティブなら展開後のシーン区間を返す', () => {
    const idx = active()
    const raw = idx.getEntryEvents()
    expect(idx.resolveLinearSegmentsNow(null, raw, count)).toEqual([
      { sceneId: 'a', start: 0, separator: null },
      { sceneId: 'b', start: 2, separator: 1 },
    ])
  })

  it('非アクティブ（別シーン再生中）なら null', () => {
    const idx = active()
    expect(idx.resolveLinearSegmentsNow('b', scenes[1].events, count)).toBeNull()
    expect(idx.resolveLinearSegmentsNow('b', idx.getEntryEvents(), count)).toBeNull()
  })

  it('区間が 0 件なら null', () => {
    const idx = new SceneIndex()
    idx.setEntry([narration('x')])
    idx.setJumpSceneIndex(scenes)
    expect(idx.getLinearSegments()).toEqual([])
    expect(idx.resolveLinearSegmentsNow(null, idx.getEntryEvents(), count)).toBeNull()
  })

  it('countResolved に各区間の元イベント列が渡る', () => {
    const idx = active()
    const seen: number[] = []
    idx.resolveLinearSegmentsNow(null, idx.getEntryEvents(), (events) => {
      seen.push(events.length)
      return events.length
    })
    expect(seen).toEqual([1, 2])
  })
})

describe('SceneIndex.linearStartIndex', () => {
  // a: [条件: f -> x,y] + a2 、b: b1 。f が真なら a は 3 件、偽なら 1 件に展開される。
  const a = scene('a', [cond('f', [narration('x'), narration('y')]), narration('a2')])
  const b = scene('b', [narration('b1')])
  const scenes = [a, b]

  function index() {
    const idx = new SceneIndex()
    idx.setEntry(flatten(scenes))
    idx.setJumpSceneIndex(scenes)
    return idx
  }

  it('対象が線形区間に無ければ null', () => {
    expect(index().linearStartIndex('zzz', {})).toBeNull()
  })

  it('先頭のシーンは 0', () => {
    expect(index().linearStartIndex('a', {})).toBe(0)
  })

  it('flags undefined でも動く（空の flags 扱い）', () => {
    expect(index().linearStartIndex('b', undefined)).toBe(index().linearStartIndex('b', {}))
  })

  it('[条件:] の真偽で開始位置が変わる', () => {
    const idx = index()
    const on: Record<string, FlagValue> = { f: { Bool: true } }
    // 偽: a は 1 件 + 境界 1 件 → b は 2。真: a は 3 件 + 境界 → b は 4
    expect(idx.linearStartIndex('b', {})).toBe(2)
    expect(idx.linearStartIndex('b', on)).toBe(4)
  })

  it('線形ストリームの途中のシーンを索引から引ける（区間が 0 件なら null）', () => {
    const idx = new SceneIndex()
    idx.setEntry([narration('x')])
    idx.setJumpSceneIndex(scenes)
    expect(idx.linearStartIndex('b', {})).toBeNull()
  })

  it('旧実装（origin/main の linearStartIndex）と複数入力で一致する', () => {
    // origin/main の NovelRenderer.linearStartIndex を写したリファレンス
    function reference(
      entryRawEvents: readonly Event[],
      allScenes: EventScene[],
      sceneId: string,
      flags: Record<string, FlagValue> | undefined
    ): number | null {
      const segments = findLinearSegments(entryRawEvents, allScenes)
      const at = segments.findIndex((seg) => seg.sceneId === sceneId)
      if (at < 0) return null
      const gs = new GameState()
      gs.fromJSON(flags ?? {})
      const resolved = resolveLinearSegments(
        entryRawEvents,
        segments,
        (events) => resolveEvents(events, gs).length
      )
      return resolved.find((seg) => seg.sceneId === sceneId)?.start ?? null
    }
    const c = scene('c', [cond('g', [narration('g1')]), narration('c1')])
    const all = [a, b, c]
    const flagSets: Array<Record<string, FlagValue> | undefined> = [
      undefined,
      {},
      { f: { Bool: true } },
      { g: { Bool: true } },
      { f: { Bool: true }, g: { Bool: true } },
      { f: { Bool: false } },
    ]
    const docs: Array<{ entry: Event[]; index: EventScene[] }> = [
      { entry: flatten(all), index: all },
      { entry: flatten([a, b]), index: all },
      { entry: [narration('q')], index: all },
    ]
    for (const { entry, index: sceneIdx } of docs) {
      const idx = new SceneIndex()
      idx.setEntry(entry)
      idx.setJumpSceneIndex(sceneIdx)
      for (const id of ['a', 'b', 'c', 'nope']) {
        for (const flags of flagSets) {
          expect(idx.linearStartIndex(id, flags), `${id}/${JSON.stringify(flags)}`).toBe(
            reference(idx.getEntryEvents(), sceneIdx, id, flags)
          )
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// resolve の結果分類: 旧実装との突き合わせ
// ---------------------------------------------------------------------------
describe('SceneIndex.resolve は旧 NovelRenderer.resolveScene と同じ結果分類を返す', () => {
  type Kind = 'sync-found' | 'sync-not-found' | 'loaded' | 'not-found' | 'resolver-error'

  /** origin/main の `resolveScene` + `requestMissingScene` を、クラスに依存しない形で写したリファレンス。 */
  async function reference(
    allScenes: EventScene[],
    resolver: MissingSceneResolver | null,
    sceneId: string
  ): Promise<{ kind: Kind; sync: boolean }> {
    const scene = findSceneById(allScenes, sceneId)
    if (scene) return { kind: 'sync-found', sync: true }
    if (!resolver) return { kind: 'sync-not-found', sync: true }
    try {
      let p: Promise<EventScene[] | null>
      try {
        p = resolver(sceneId)
      } catch (err) {
        p = Promise.reject(err)
      }
      const scenes = await p
      return { kind: scenes ? 'loaded' : 'not-found', sync: false }
    } catch {
      return { kind: 'resolver-error', sync: false }
    }
  }

  async function actual(
    allScenes: EventScene[],
    resolver: MissingSceneResolver | null,
    sceneId: string
  ): Promise<{ kind: Kind; sync: boolean }> {
    const idx = new SceneIndex()
    idx.setJumpSceneIndex(allScenes)
    idx.setMissingSceneResolver(resolver)
    const r = idx.resolve(sceneId)
    if (r instanceof Promise) {
      const v = await r
      if (v.status === 'loaded') return { kind: 'loaded', sync: false }
      if (v.status === 'failed') {
        return { kind: v.reason === 'resolver-error' ? 'resolver-error' : 'not-found', sync: false }
      }
      throw new Error('想定外')
    }
    return { kind: r.status === 'found' ? 'sync-found' : 'sync-not-found', sync: true }
  }

  it('読み込み済み / 未ロード × resolver（なし・成功・null・reject・同期 throw）の全組み合わせ', async () => {
    const loaded = [scene('a', [])]
    const resolvers: Array<[string, () => MissingSceneResolver | null]> = [
      ['none', () => null],
      ['ok', () => async () => [scene('b', [])]],
      ['null', () => async () => null],
      ['reject', () => () => Promise.reject(new Error('x'))],
      [
        'throw',
        () => () => {
          throw new Error('y')
        },
      ],
    ]
    for (const index of [[], loaded]) {
      for (const id of ['a', 'b']) {
        for (const [name, make] of resolvers) {
          const label = `${index.length}件/${id}/${name}`
          expect(await actual(index, make(), id), label).toEqual(await reference(index, make(), id))
        }
      }
    }
  })
})
