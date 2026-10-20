/**
 * PlaybackCursor（再生カーソルとイベント配列・履歴の唯一の書き手）の単体テスト (#824, #735 3/8)。
 *
 * `NovelRenderer` は import しない（Pixi・DOM・タイマーに依存しないことの確認も兼ねる）。
 * 切り出し前の `NovelRenderer.advance` / `goBack` / `seekTo` の位置更新ロジックの数行を「リファレンス」として
 * このファイルに写し、多入力で突き合わせる（doctrine 規律3）。リファレンスは切り出し後のコードを呼ばず、
 * `origin/main` の実装をそのまま写してある。期待値に定数計算を直書きせず、独立した求め方
 * （`resolveEvents` の直呼び・本文イベント数の数え直し）と突き合わせる。
 */
import { describe, it, expect } from 'vitest'
import type { Event, FlagValue } from '../types'
import {
  GameState,
  expandEvents,
  resolveEvents,
  type ExpansionEntry,
  type NovelGameState,
} from './GameState'
import { PlaybackCursor } from './PlaybackCursor'
import type { NovelPage } from './novelLayout'

// --- fixture ---

const narr = (s: string): Event => ({ Narration: { text: [s] } })
const dlg = (s: string): Event => ({
  Dialog: { character: 'a', expression: 'x', position: 'Left', text: [s] },
})
const flagEv = (name: string, value: boolean): Event => ({
  Flag: { name, value: { Bool: value } as FlagValue },
})
const cond = (name: string, events: Event[]): Event => ({ Condition: { flag: name, events } })

function gs(flags: Record<string, boolean>): GameState {
  const g = new GameState()
  for (const [k, v] of Object.entries(flags)) g.setFlag(k, { Bool: v })
  return g
}

/** 入場条件（逐次評価）。 */
function entryOf(flags: Record<string, boolean>, fromRawIndex = 0): ExpansionEntry {
  return { flags: gs(flags).toJSON(), fromRawIndex, legacyStatic: false }
}

/** 位置だけを持つスナップショット（NovelGameState の残りは PlaybackCursor が読まない）。 */
function snap(eventIndex: number, textIndex: number, sentenceIndex?: number): NovelGameState {
  const s: Record<string, unknown> = { eventIndex, textIndex }
  if (sentenceIndex !== undefined) s.sentenceIndex = sentenceIndex
  return s as unknown as NovelGameState
}

function pos(c: PlaybackCursor): [number, number, number] {
  return [c.eventIndex, c.textIndex, c.sentenceIndex]
}

/** 本文イベント数を cursor の実装と独立に数え直す。 */
function countText(events: readonly Event[]): number {
  return events.filter((e) => typeof e === 'object' && ('Narration' in e || 'Dialog' in e)).length
}

function plainRaw(n: number): Event[] {
  return Array.from({ length: n }, (_, i) => narr(`n${i}`))
}

/** 位置を適当な所へ動かした cursor を作る。 */
function movedCursor(): PlaybackCursor {
  const c = new PlaybackCursor()
  c.load(plainRaw(6), gs({}), 1)
  c.nextTextLine()
  c.nextSentence()
  c.nextSentence()
  c.pushHistory(snap(0, 0, 0))
  c.pushHistory(snap(1, 1, 2))
  c.cacheNovelPages([] as NovelPage[])
  c.cacheAdvSentencePages(['x'])
  return c
}

describe('PlaybackCursor 進行', () => {
  it('nextSentence は sentenceIndex だけを進める', () => {
    const c = new PlaybackCursor()
    c.load(plainRaw(3), gs({}))
    c.nextSentence()
    c.nextSentence()
    expect(pos(c)).toEqual([0, 0, 2])
  })

  it('nextPageStart は textIndex を進め sentenceIndex を 0 に戻し eventIndex は触らない', () => {
    const c = movedCursor()
    const before = c.eventIndex
    expect(c.sentenceIndex).toBe(2)
    c.nextPageStart()
    expect(c.eventIndex).toBe(before)
    expect(c.textIndex).toBe(2)
    expect(c.sentenceIndex).toBe(0)
  })

  it('nextTextLine（adv）は textIndex だけを進め sentenceIndex を触らない', () => {
    const c = movedCursor()
    const [e, t, s] = pos(c)
    c.nextTextLine()
    expect(pos(c)).toEqual([e, t + 1, s])
  })

  it('nextEvent は eventIndex を進め textIndex/sentenceIndex を 0 に戻しページキャッシュを両方破棄する', () => {
    const c = movedCursor()
    expect(c.novelPagesCache).not.toBeNull()
    expect(c.advSentencePagesCache).not.toBeNull()
    const e = c.eventIndex
    c.nextEvent()
    expect(pos(c)).toEqual([e + 1, 0, 0])
    expect(c.novelPagesCache).toBeNull()
    expect(c.advSentencePagesCache).toBeNull()
  })

  it('skipDirective は eventIndex だけを進め、ページ内位置もキャッシュも履歴も触らない', () => {
    const c = movedCursor()
    const [e, t, s] = pos(c)
    const hist = c.history.length
    c.skipDirective()
    expect(pos(c)).toEqual([e + 1, t, s])
    expect(c.novelPagesCache).not.toBeNull()
    expect(c.advSentencePagesCache).not.toBeNull()
    expect(c.history.length).toBe(hist)
  })
})

describe('PlaybackCursor 戻る', () => {
  it('prevPage のコールバックにはデクリメント後の textIndex が渡り、戻り値が sentenceIndex になる', () => {
    const c = new PlaybackCursor()
    c.load(plainRaw(2), gs({}))
    c.nextPageStart()
    c.nextPageStart()
    c.nextPageStart() // textIndex 3
    const seen: number[] = []
    c.prevPage((t) => {
      seen.push(t)
      return 7
    })
    expect(seen).toEqual([2])
    expect(c.textIndex).toBe(2)
    expect(c.sentenceIndex).toBe(7)
  })

  it('prevSentence は sentenceIndex だけ、prevTextLine は textIndex だけを戻す', () => {
    const c = movedCursor()
    const [e, t, s] = pos(c)
    c.prevSentence()
    expect(pos(c)).toEqual([e, t, s - 1])
    c.prevTextLine()
    expect(pos(c)).toEqual([e, t - 1, s - 1])
  })

  it('popHistory は末尾を 1 件取り除き、空履歴でも落ちない', () => {
    const c = new PlaybackCursor()
    c.pushHistory(snap(0, 0, 0))
    c.pushHistory(snap(1, 0, 0))
    c.popHistory()
    expect(c.history.map((h) => h.eventIndex)).toEqual([0])
    c.popHistory()
    expect(c.history).toEqual([])
    expect(() => c.popHistory()).not.toThrow()
    expect(c.history).toEqual([])
  })
})

describe('PlaybackCursor シーク（履歴）', () => {
  it('truncateHistory(i) は i+1 件に切り詰め i 番目を返す', () => {
    const c = new PlaybackCursor()
    for (let i = 0; i < 5; i++) c.pushHistory(snap(i, 0, 0))
    const got = c.truncateHistory(2)
    expect(got?.eventIndex).toBe(2)
    expect(c.history.map((h) => h.eventIndex)).toEqual([0, 1, 2])
  })

  it('truncateHistory(末尾) は何も切らず、truncateHistory(0) は 1 件に切り詰める', () => {
    const c = new PlaybackCursor()
    for (let i = 0; i < 3; i++) c.pushHistory(snap(i, 0, 0))
    expect(c.truncateHistory(2)?.eventIndex).toBe(2)
    expect(c.history.length).toBe(3)
    expect(c.truncateHistory(0)?.eventIndex).toBe(0)
    expect(c.history.length).toBe(1)
  })

  it('範囲外・-1 は undefined を返す', () => {
    const c = new PlaybackCursor()
    for (let i = 0; i < 3; i++) c.pushHistory(snap(i, 0, 0))
    expect(c.truncateHistory(3 as number)).toBeUndefined()
    expect(c.truncateHistory(-1)).toBeUndefined()
  })

  it('範囲外では履歴が変わらない（-1 でも消えない）', () => {
    const c = new PlaybackCursor()
    for (let i = 0; i < 3; i++) c.pushHistory(snap(i, 0, 0))
    c.truncateHistory(-1)
    c.truncateHistory(3)
    c.truncateHistory(1.5)
    expect(c.history.map((h) => h.eventIndex)).toEqual([0, 1, 2])
  })

  it('resetHistory は空、またはスナップショット 1 件だけにする', () => {
    const c = movedCursor()
    c.resetHistory(snap(4, 0, 0))
    expect(c.history.map((h) => h.eventIndex)).toEqual([4])
    c.resetHistory()
    expect(c.history).toEqual([])
  })
})

describe('PlaybackCursor.restorePosition', () => {
  it('sentenceIndex 未定義のスナップショットは 0 に倒す（古いセーブ）', () => {
    const c = movedCursor()
    expect(c.sentenceIndex).toBe(2)
    c.restorePosition(snap(3, 1))
    expect(pos(c)).toEqual([3, 1, 0])
  })

  it('sentenceIndex 付きはその値を復元する', () => {
    const c = new PlaybackCursor()
    c.load(plainRaw(6), gs({}))
    c.restorePosition(snap(4, 2, 5))
    expect(pos(c)).toEqual([4, 2, 5])
  })

  it('再展開しない: flags が別の値でも resolved は訪問の入場時に固定されたまま、キャッシュは破棄する (#799)', () => {
    const raw: Event[] = [cond('x', [narr('tx0'), dlg('tx1')]), narr('t1'), narr('t2')]
    const c = new PlaybackCursor()
    c.load(raw, gs({ x: true }))
    const before = c.resolvedEvents
    expect(c.resolvedEvents.length).toBe(4)
    expect(c.displayEventCount).toBe(4)
    c.cacheNovelPages([] as NovelPage[])
    c.cacheAdvSentencePages(['p'])

    c.restorePosition(snap(1, 0, 0))
    expect(c.resolvedEvents).toBe(before)
    expect(c.displayEventCount).toBe(4)
    expect(c.novelPagesCache).toBeNull()
    expect(c.advSentencePagesCache).toBeNull()
  })

  it('履歴には触れない', () => {
    const c = movedCursor()
    const hist = c.history.length
    c.restorePosition(snap(0, 0, 0))
    expect(c.history.length).toBe(hist)
  })
})

describe('PlaybackCursor 入場時展開 (#799)', () => {
  it('load は呼び出し時の flags を入場時 flags として固定し、その後 flags が変わっても列は変わらない', () => {
    const f = flagEv('x', false)
    const raw: Event[] = [cond('x', [narr('a'), f, narr('b')]), narr('c')]
    const c = new PlaybackCursor()
    const g = gs({ x: true })
    c.load(raw, g)
    const before = [...c.resolvedEvents]
    g.setFlag('x', { Bool: false }) // Flag の実行相当。再展開の入口は無い
    expect(c.resolvedEvents).toEqual(before)
    expect(c.displayEventCount).toBe(3)
  })

  it('snapshotEntry: 元列に [条件:] が無ければ何も出さない', () => {
    const c = new PlaybackCursor()
    c.load(plainRaw(3), gs({ x: true }))
    expect(c.snapshotEntry()).toEqual({})
    expect(Object.keys(c.snapshotEntry())).toEqual([])
  })

  it('snapshotEntry: [条件:] があれば入場時 flags を出し、entryRawIndex は非0のときだけ、entryStatic は旧セーブ由来のときだけ', () => {
    const raw: Event[] = [narr('a'), cond('x', [narr('b')]), narr('c')]
    const c = new PlaybackCursor()
    c.load(raw, gs({ x: true }))
    expect(c.snapshotEntry()).toEqual({ entryFlags: { x: { Bool: true } } })
    expect(Object.keys(c.snapshotEntry())).toEqual(['entryFlags'])
    c.load(raw, gs({ x: false }), 0, 2)
    expect(c.snapshotEntry()).toEqual({ entryFlags: { x: { Bool: false } }, entryRawIndex: 2 })
    c.replaceEvents(raw, { flags: { x: { Bool: true } }, fromRawIndex: 0, legacyStatic: true })
    expect(c.snapshotEntry()).toEqual({ entryFlags: { x: { Bool: true } }, entryStatic: true })
  })

  it('rawOffsets は元列のトップレベル i 番目の展開後の開始位置（長さ raw.length + 1）', () => {
    const raw: Event[] = [narr('a'), cond('x', [narr('b'), narr('c')]), narr('d')]
    const c = new PlaybackCursor()
    c.load(raw, gs({ x: true }))
    expect(c.rawOffsets).toEqual([0, 1, 3, 4])
    c.load(raw, gs({ x: false }))
    expect(c.rawOffsets).toEqual([0, 1, 1, 2])
  })
})

describe('PlaybackCursor.clampToPageCount (#789, #663)', () => {
  it('pageCount=0 は何もしない', () => {
    const c = movedCursor()
    const before = pos(c)
    expect(c.clampToPageCount(0)).toBe(false)
    expect(pos(c)).toEqual(before)
  })

  it('textIndex >= pageCount なら pageCount-1 に寄せ sentenceIndex を 0 にして true', () => {
    const c = movedCursor() // textIndex 1, sentenceIndex 2
    expect(c.clampToPageCount(1)).toBe(true)
    expect(c.textIndex).toBe(0)
    expect(c.sentenceIndex).toBe(0)
  })

  it('textIndex == pageCount の境界でも寄せる', () => {
    const c = new PlaybackCursor()
    c.load(plainRaw(1), gs({}))
    c.nextPageStart()
    c.nextPageStart() // textIndex 2
    c.nextSentence()
    expect(c.clampToPageCount(2)).toBe(true)
    expect(c.textIndex).toBe(1)
    expect(c.sentenceIndex).toBe(0)
  })

  it('textIndex < pageCount なら false で sentenceIndex を保持する', () => {
    const c = movedCursor()
    const before = pos(c)
    expect(c.clampToPageCount(5)).toBe(false)
    expect(pos(c)).toEqual(before)
    expect(c.sentenceIndex).toBe(2)
  })
})

describe('PlaybackCursor load / replaceEvents / 開始状態', () => {
  it('load は history を空にし、startIndex を反映し、位置を 0 に戻し、キャッシュを破棄する', () => {
    const c = movedCursor()
    expect(c.history.length).toBeGreaterThan(0)
    c.load(plainRaw(5), gs({}), 3)
    expect(pos(c)).toEqual([3, 0, 0])
    expect(c.history).toEqual([])
    expect(c.novelPagesCache).toBeNull()
    expect(c.advSentencePagesCache).toBeNull()
    expect(c.resolvedEvents.length).toBe(5)
    expect(c.rawEvents.length).toBe(5)
  })

  it('load の startIndex 省略は 0', () => {
    const c = movedCursor()
    c.load(plainRaw(2), gs({}))
    expect(c.eventIndex).toBe(0)
  })

  it('replaceEvents は 3 点セットだけ入れ替え、位置・履歴・キャッシュに触れない', () => {
    const c = movedCursor()
    const before = pos(c)
    const hist = [...c.history]
    const raw = [cond('x', [narr('a')]), narr('b')]
    c.replaceEvents(raw, entryOf({ x: true }))
    expect(c.rawEvents).toBe(raw)
    expect(c.resolvedEvents).toEqual(resolveEvents(raw, gs({ x: true })))
    expect(c.displayEventCount).toBe(2)
    expect(pos(c)).toEqual(before)
    expect(c.history).toEqual(hist)
    expect(c.novelPagesCache).not.toBeNull()
  })

  it('markStarted / markUnstarted は load で変わらない', () => {
    const c = new PlaybackCursor()
    expect(c.playbackStarted).toBe(false)
    c.load(plainRaw(1), gs({}))
    expect(c.playbackStarted).toBe(false)
    c.markStarted()
    expect(c.playbackStarted).toBe(true)
    c.load(plainRaw(2), gs({}))
    expect(c.playbackStarted).toBe(true)
    c.markUnstarted()
    expect(c.playbackStarted).toBe(false)
  })

  it('setCurrentSceneId は load で変わらない', () => {
    const c = new PlaybackCursor()
    c.setCurrentSceneId('s1')
    c.load(plainRaw(1), gs({}))
    expect(c.currentSceneId).toBe('s1')
    c.setCurrentSceneId(null)
    expect(c.currentSceneId).toBeNull()
  })
})

describe('PlaybackCursor ページキャッシュ', () => {
  it('cacheNovelPages / cacheAdvSentencePages は現在の eventIndex で保存する', () => {
    const c = new PlaybackCursor()
    c.load(plainRaw(5), gs({}), 2)
    const pages = [] as NovelPage[]
    c.cacheNovelPages(pages)
    c.cacheAdvSentencePages(['a', 'b'])
    expect(c.novelPagesCache).toEqual({ eventIndex: 2, pages })
    expect(c.advSentencePagesCache).toEqual({ eventIndex: 2, pages: ['a', 'b'] })
    c.nextEvent()
    c.cacheAdvSentencePages(['c'])
    expect(c.advSentencePagesCache?.eventIndex).toBe(3)
  })

  it('invalidatePages は両方を null にする', () => {
    const c = movedCursor()
    c.invalidatePages()
    expect(c.novelPagesCache).toBeNull()
    expect(c.advSentencePagesCache).toBeNull()
  })
})

// --- 不変条件 ---

/** 固定シードの擬似乱数（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RAW_POOL: Event[][] = [
  [
    narr('p0'),
    cond('a', [narr('a0'), cond('b', [dlg('ab0'), flagEv('c', true)]), narr('a1')]),
    narr('p1'),
  ],
  [cond('c', [narr('c0'), flagEv('a', false)]), dlg('q0'), cond('b', [narr('b0')]), narr('q1')],
  [flagEv('a', true), cond('a', [cond('c', [narr('ac')])]), cond('b', [dlg('b0'), dlg('b1')])],
  [narr('only')],
]

describe('PlaybackCursor 不変条件: resolved は常に expandEvents(raw, 入場条件) で再現でき、displayEventCount は導出と一致する', () => {
  it('固定シードの多数の操作列でも成り立ち、状態が実際に変わった件数も十分ある', () => {
    const rand = rng(824)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
    const randFlags = (): Record<string, boolean> => ({
      a: rand() < 0.5,
      b: rand() < 0.5,
      c: rand() < 0.5,
    })

    let changed = 0
    let total = 0
    for (let run = 0; run < 40; run++) {
      const c = new PlaybackCursor()
      let raw = pick(RAW_POOL)
      let flags = randFlags()
      let entry = entryOf(flags)
      c.load(raw, gs(flags), 0)
      for (let step = 0; step < 30; step++) {
        const prevResolved = c.resolvedEvents
        const prevIndex = c.eventIndex
        const op = Math.floor(rand() * 5)
        if (op === 0) {
          c.nextEvent()
        } else if (op === 1) {
          // 訪問中の flags 変化は列に影響しない（再展開の入口が無い）
          flags = randFlags()
        } else if (op === 2) {
          c.restorePosition(snap(Math.floor(rand() * 6), Math.floor(rand() * 3)))
        } else if (op === 3) {
          raw = pick(RAW_POOL)
          flags = randFlags()
          entry = entryOf(flags)
          c.load(raw, gs(flags), Math.floor(rand() * 3))
        } else {
          raw = pick(RAW_POOL)
          flags = randFlags()
          entry = entryOf(flags)
          c.replaceEvents(raw, entry)
        }
        total++
        expect(c.rawEvents).toBe(raw)
        expect(c.resolvedEvents).toEqual(expandEvents(raw, entry).events)
        expect(c.displayEventCount).toBe(countText(c.resolvedEvents))
        if (
          JSON.stringify(c.resolvedEvents) !== JSON.stringify(prevResolved) ||
          c.eventIndex !== prevIndex
        ) {
          changed++
        }
      }
    }
    expect(total).toBe(1200)
    // 空虚でないこと: 操作の大半で resolved か位置が実際に変わっている。
    expect(changed).toBeGreaterThan(total / 2)
  })
})

// --- 旧実装との等価性 ---

/**
 * 1 イベントのページ構成（各ページの文数）。eventIndex から決定的に決める。レンダラの getNovelPages の
 * 代役で、cursor 側も参照側も同じものを見る。
 */
function geometry(eventIndex: number): number[] {
  const pages = (eventIndex % 3) + 1
  return Array.from({ length: pages }, (_, p) => ((eventIndex + p) % 3) + 1)
}

interface Ref {
  eventIndex: number
  textIndex: number
  sentenceIndex: number
  history: Array<[number, number, number]>
}

/** origin/main の `advance` の novel 本文イベント分岐を位置更新だけ写したリファレンス。 */
function refAdvance(r: Ref, resolvedLength: number): void {
  const pages = geometry(r.eventIndex)
  const sentences = pages[r.textIndex]
  if (r.sentenceIndex < sentences - 1) {
    r.sentenceIndex++
    return
  }
  if (r.textIndex < pages.length - 1) {
    r.textIndex++
    r.sentenceIndex = 0
    return
  }
  r.eventIndex++
  r.textIndex = 0
  r.sentenceIndex = 0
  if (r.eventIndex < resolvedLength) r.history.push([r.eventIndex, 0, 0])
}

/** origin/main の `goBack`（novel 本文イベント）の位置更新だけを写したリファレンス。 */
function refGoBack(r: Ref): void {
  if (r.sentenceIndex > 0) {
    r.sentenceIndex--
    return
  }
  if (r.textIndex > 0) {
    r.textIndex--
    const prev = geometry(r.eventIndex)[r.textIndex]
    r.sentenceIndex = Math.max(0, (prev ?? 1) - 1)
    return
  }
  if (r.history.length > 1) {
    r.history.pop()
    const [e, t, s] = r.history[r.history.length - 1]
    r.eventIndex = e
    r.textIndex = t
    r.sentenceIndex = s
  }
}

/** origin/main の `seekTo` の位置更新だけを写したリファレンス。 */
function refSeekTo(r: Ref, i: number): void {
  if (i < 0 || i >= r.history.length) return
  r.history = r.history.slice(0, i + 1)
  const [e, t, s] = r.history[i]
  r.eventIndex = e
  r.textIndex = t
  r.sentenceIndex = s
}

// cursor を、レンダラが advance/goBack/seekTo で呼ぶのと同じ判断順で駆動する。
function curAdvance(c: PlaybackCursor): void {
  const pages = geometry(c.eventIndex)
  const sentences = pages[c.textIndex]
  if (c.sentenceIndex < sentences - 1) {
    c.nextSentence()
    return
  }
  if (c.textIndex < pages.length - 1) {
    c.nextPageStart()
    return
  }
  c.nextEvent()
  if (c.eventIndex < c.resolvedEvents.length) c.pushHistory(snap(c.eventIndex, 0, 0))
}

function curGoBack(c: PlaybackCursor): void {
  if (c.sentenceIndex > 0) {
    c.prevSentence()
    return
  }
  if (c.textIndex > 0) {
    c.prevPage((t) => Math.max(0, (geometry(c.eventIndex)[t] ?? 1) - 1))
    return
  }
  if (c.history.length > 1) {
    c.popHistory()
    c.restorePosition(c.history[c.history.length - 1])
  }
}

function curSeekTo(c: PlaybackCursor, i: number): void {
  if (i < 0 || i >= c.history.length) return
  const target = c.truncateHistory(i)
  if (target) c.restorePosition(target)
}

function refOf(c: PlaybackCursor): Ref {
  return {
    eventIndex: c.eventIndex,
    textIndex: c.textIndex,
    sentenceIndex: c.sentenceIndex,
    history: c.history.map((h) => [h.eventIndex, h.textIndex, h.sentenceIndex ?? 0]),
  }
}

describe('旧 NovelRenderer（origin/main）の位置更新との等価性', () => {
  it('advance / goBack / seekTo の固定シード操作列で、位置と履歴が全ステップ一致する（初期状態を変えて）', () => {
    const rand = rng(735)
    const initials = [0, 2, 5]
    const distinct = new Set<string>()
    let backs = 0
    let seeks = 0
    for (const start of initials) {
      for (let run = 0; run < 25; run++) {
        const c = new PlaybackCursor()
        c.load(plainRaw(12), gs({}), start)
        c.pushHistory(snap(start, 0, 0))
        const ref: Ref = refOf(c)
        for (let step = 0; step < 60; step++) {
          const op = rand()
          if (op < 0.55) {
            curAdvance(c)
            refAdvance(ref, c.resolvedEvents.length)
          } else if (op < 0.9) {
            const h0 = c.history.length
            curGoBack(c)
            refGoBack(ref)
            if (c.history.length < h0) backs++
          } else {
            const i = Math.floor(rand() * (ref.history.length + 1)) - 1
            curSeekTo(c, i)
            refSeekTo(ref, i)
            if (i >= 0 && i < ref.history.length) seeks++
          }
          expect(pos(c)).toEqual([ref.eventIndex, ref.textIndex, ref.sentenceIndex])
          expect(c.history.length).toBe(ref.history.length)
          distinct.add(pos(c).join(','))
        }
      }
    }
    // 空虚でないこと: 履歴を巻き戻す goBack とシークが実際に走り、位置も多様に動いている。
    expect(backs).toBeGreaterThan(10)
    expect(seeks).toBeGreaterThan(10)
    expect(distinct.size).toBeGreaterThan(10)
  })

  it('決まった台本（全部進める → 全部戻す → 途中へシーク → 再度進める）でリファレンスと一致する', () => {
    const c = new PlaybackCursor()
    c.load(plainRaw(8), gs({}), 0)
    c.pushHistory(snap(0, 0, 0))
    const ref = refOf(c)
    const trace: string[] = []
    const both = (f: 'a' | 'b' | number): void => {
      if (f === 'a') {
        curAdvance(c)
        refAdvance(ref, c.resolvedEvents.length)
      } else if (f === 'b') {
        curGoBack(c)
        refGoBack(ref)
      } else {
        curSeekTo(c, f)
        refSeekTo(ref, f)
      }
      expect(pos(c)).toEqual([ref.eventIndex, ref.textIndex, ref.sentenceIndex])
      expect(c.history.length).toBe(ref.history.length)
      trace.push(pos(c).join(','))
    }
    for (let i = 0; i < 20; i++) both('a')
    const afterForward = c.eventIndex
    expect(afterForward).toBeGreaterThan(3)
    for (let i = 0; i < 25; i++) both('b')
    both(2)
    for (let i = 0; i < 10; i++) both('a')
    both(99) // 範囲外は無視
    both(-1)
    // 履歴の末尾から seek した位置は、その履歴要素の位置と一致する
    both(c.history.length - 1)
    expect(new Set(trace).size).toBeGreaterThan(8)
  })
})
