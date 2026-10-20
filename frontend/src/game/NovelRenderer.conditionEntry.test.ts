/**
 * `[条件:]` のブロック入場時評価と、セーブからの決定的な再現 (#799, ADR 0002 / 0003)。
 *
 * 実パーサ（wasm）で #799 の再現スクリプトを parse → NovelRenderer で再生し、
 * - ブロック内でそのフラグを偽にしても、入場済みのブロックの残りが流れる（TUI と同じ）
 * - 任意の位置でのセーブ → ロード（別インスタンス）が、同じ位置・同じ残りを再現する
 * - goBack / seekTo / SeekBar の番号付けが、フラグをまたいでもずれない（訪問中は列が不変）
 * - 旧セーブ（`entryFlags` 無し）が従来の静的展開で読める
 * - `[条件:]` を使わない脚本のセーブ JSON は従来と 1 バイトも変わらない
 * を固定する。ランダムな木では、レンダラの再生順が参照インタプリタ（実行時に1イベントずつ進む素朴な実装）と
 * 一致し、全位置で保存 → 復元が同一になることを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { defaultTimeController } from './TimeController'
import { parseMarkdown } from '../wasm/parser'
import type { Event, EventScene, FlagValue } from '../types'
import type { SaveSlotData } from './SaveManager'
import type { NovelGameState } from './GameState'
import { internalsOf } from '../test/rendererInternals'

// --- ヘルパー ---

const body = (text: string): string =>
  [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    '---',
    '',
    '## a: 場面A',
    '',
    text,
    '',
  ].join('\n')

async function scenesOf(md: string): Promise<EventScene[]> {
  const doc = await parseMarkdown(md)
  return doc.chapters.flatMap((c) => c.scenes)
}

const textOf = (r: NovelRenderer): string =>
  (r.getDebugState().eventText ?? '').replace(/["\s]/g, '')
const advance = (r: NovelRenderer): void => (r as unknown as { advance(): void }).advance()

function build(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  r.setDocKey('t799')
  return r
}

/** 現在位置から最後まで進めた本文の列（現在の本文を含む）。同じ本文が続く/本文が無くなったら止まる。 */
function playRest(r: NovelRenderer, max = 60): string[] {
  const out: string[] = []
  for (let i = 0; i < max; i++) {
    const t = textOf(r)
    if (t === '' || t === out[out.length - 1]) break
    out.push(t)
    advance(r)
  }
  return out
}

/** 最後の本文まで進める（終劇にはしない: 終劇後は SeekBar・goBack が無効になる #815）。 */
function advanceToLastText(r: NovelRenderer, textCount: number): void {
  for (let i = 0; i < textCount - 1; i++) advance(r)
}

interface SeekInternals {
  seekToTextEventDisplayIndex(i: number): void
  displayEventCount: number
  resolvedEvents: Event[]
  eventIndex: number
}
const I = (r: NovelRenderer): SeekInternals => internalsOf<SeekInternals>(r)

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

const X_TRUE: Record<string, FlagValue> = { x: { Bool: true } }

// --- #799 の再現スクリプト ---

const REPRO = body(
  [
    '> 前置き',
    '',
    '[条件: x]',
    '> 本文A',
    '[フラグ: x = false]',
    '> 本文B',
    '[/条件]',
    '> 本文C',
  ].join('\n')
)

describe('#799 の再現スクリプト: ブロック入場時評価', () => {
  it('実パーサの出力: [条件:] ブロックは Condition にパースされ、内側に Flag を含む', async () => {
    const scenes = await scenesOf(REPRO)
    const cond = scenes[0].events.find((e) => typeof e === 'object' && 'Condition' in e)
    expect(cond).toBeDefined()
    expect(JSON.stringify(cond)).toContain('"Flag"')
  })

  it('x が真で入場: 本文A のあと [フラグ: x = false] を実行しても、本文B が流れる', async () => {
    const r = build(await scenesOf(REPRO))
    await r.startFrom({ sceneId: 'a', flags: X_TRUE })
    expect(playRest(r)).toEqual(['前置き', '本文A', '本文B', '本文C'])
    // 実フラグは Flag の実行で偽になっている
    expect(r.getSnapshot().flags.x).toEqual({ Bool: false })
  })

  it('x が偽で入場: ブロックは丸ごと飛ばされ（内側の Flag も実行されない）、前置きと本文C だけ', async () => {
    const r = build(await scenesOf(REPRO))
    await r.startFrom({ sceneId: 'a', flags: { x: { Bool: false } } })
    expect(playRest(r)).toEqual(['前置き', '本文C'])
    expect(r.getSnapshot().flags.x).toEqual({ Bool: false })
  })

  it('SeekBar の総数は訪問中不変（その訪問で流れる本文数）で、フラグを実行しても変わらない', async () => {
    const r = build(await scenesOf(REPRO))
    await r.startFrom({ sceneId: 'a', flags: X_TRUE })
    const counts: number[] = []
    for (let i = 0; i < 4; i++) {
      counts.push(I(r).displayEventCount)
      advance(r)
    }
    expect(counts).toEqual([4, 4, 4, 4])
  })

  it('SeekBar で戻って進んでも、同じ列になる（番号付けがずれない）', async () => {
    const r = build(await scenesOf(REPRO))
    await r.startFrom({ sceneId: 'a', flags: X_TRUE })
    advanceToLastText(r, 4) // 前置き, A, B, C まで進める（Flag は A→B の間で実行済み）
    expect(textOf(r)).toBe('本文C')
    // 表示番号 n(0 始まり) → 戻した先の本文。SeekBar は訪問済みの位置へだけ戻れるので、後ろから順に戻る
    for (const [n, expected] of [
      [3, '本文C'],
      [2, '本文B'],
      [1, '本文A'],
      [0, '前置き'],
    ] as const) {
      I(r).seekToTextEventDisplayIndex(n)
      expect(textOf(r), `display ${n}`).toBe(expected)
      expect(I(r).displayEventCount).toBe(4)
    }
    // 戻ったあとの進行も同じ列
    expect(playRest(r)).toEqual(['前置き', '本文A', '本文B', '本文C'])
  })

  it('goBack でフラグを越えて戻って進んでも、同じ列になる', async () => {
    const r = build(await scenesOf(REPRO))
    await r.startFrom({ sceneId: 'a', flags: X_TRUE })
    advance(r) // A
    advance(r) // B（Flag 実行後）
    expect(textOf(r)).toBe('本文B')
    r.goBack()
    expect(textOf(r)).toBe('本文A')
    expect(r.getSnapshot().flags.x).toEqual({ Bool: true }) // flags は戻した先の値
    expect(playRest(r)).toEqual(['本文A', '本文B', '本文C'])
  })

  it('全位置でクイックセーブ → 別インスタンスでクイックロード: 同じ位置・同じ残りを再現する', async () => {
    const scenes = await scenesOf(REPRO)
    const trace = ['前置き', '本文A', '本文B', '本文C']
    for (let k = 0; k < trace.length; k++) {
      const saver = build(scenes)
      await saver.startFrom({ sceneId: 'a', flags: X_TRUE })
      for (let i = 0; i < k; i++) advance(saver)
      expect(textOf(saver)).toBe(trace[k])
      expect(saver.quickSave()).toBe(true)
      const loaded = build(scenes)
      expect((await loaded.quickLoad())?.status).toBe('entered')
      expect(textOf(loaded), `position ${k}`).toBe(trace[k])
      expect(playRest(loaded), `rest ${k}`).toEqual(trace.slice(k))
      // 総数・SeekBar の番号付けも同じ
      expect(I(loaded).displayEventCount).toBe(4)
    }
  })

  it('ロードしたあとで戻って進んでも同じ列（履歴は復元位置の1件から）', async () => {
    const scenes = await scenesOf(REPRO)
    const saver = build(scenes)
    await saver.startFrom({ sceneId: 'a', flags: X_TRUE })
    advance(saver)
    advance(saver)
    expect(textOf(saver)).toBe('本文B')
    saver.quickSave()
    const loaded = build(scenes)
    await loaded.quickLoad()
    expect(textOf(loaded)).toBe('本文B')
    expect(I(loaded).displayEventCount).toBe(4)
    expect(playRest(loaded)).toEqual(['本文B', '本文C'])
  })
})

// --- ネスト・Jump・閉じ忘れ・選択肢行末の [条件:] ---

describe('入場時評価の周辺ケース (#799)', () => {
  it('ネスト: 外側ブロック内の Flag が内側の入場時評価に効き、内側で外側を偽にしても外側の残りが流れる', async () => {
    const md = body(
      [
        '> 0',
        '[条件: o]',
        '[フラグ: i = true]',
        '> 1',
        '[条件: i]',
        '> 2',
        '[フラグ: o = false]',
        '> 3',
        '[/条件]',
        '> 4',
        '[/条件]',
        '> 5',
      ].join('\n')
    )
    const scenes = await scenesOf(md)
    const r = build(scenes)
    await r.startFrom({ sceneId: 'a', flags: { o: { Bool: true } } })
    expect(playRest(r)).toEqual(['0', '1', '2', '3', '4', '5'])
    const off = build(scenes)
    await off.startFrom({ sceneId: 'a', flags: {} })
    expect(playRest(off)).toEqual(['0', '5'])
  })

  it('内側に [ジャンプ:]: 真なら到達した位置でジャンプし、偽なら展開されず通り抜ける', async () => {
    const md = ['---', 'engine: name-name', 'chapter: 1', 'title: t', '---', '']
      .concat([
        '## a: A',
        '',
        '> a1',
        '[条件: go]',
        '> a2',
        '[ジャンプ: b]',
        '[/条件]',
        '> a3',
        '',
        '## b: B',
        '',
        '> b1',
        '',
      ])
      .join('\n')
    const scenes = await scenesOf(md)
    {
      // Jump は次の macrotask で遷移する（TimeController を virtual にして tick で駆動する）
      const makeVirtual = (): NovelRenderer => {
        const r = new NovelRenderer()
        r.getTimeController().setMode('virtual')
        internalsOf<{ initialized: boolean; render(): void }>(r).initialized = true
        vi.spyOn(internalsOf<{ render(): void }>(r), 'render').mockImplementation(() => {})
        r.setScenes(scenes)
        return r
      }
      const on = makeVirtual()
      const entered: string[] = []
      on.setOnSceneChange((id) => entered.push(id))
      await on.startFrom({ sceneId: 'a', flags: { go: { Bool: true } } })
      advance(on) // a2
      advance(on) // Jump 予約
      on.getTimeController().tick(1)
      expect(on.getDebugState().sceneId).toBe('b')
      expect(entered).toEqual(['a', 'b'])
      // 偽: ジャンプせず a3 へ
      const off = makeVirtual()
      await off.startFrom({ sceneId: 'a', flags: {} })
      expect(playRest(off)).toEqual(['a1', 'a3'])
      defaultTimeController.setMode('live')
    }
  })

  it('閉じ忘れ（[/条件] 無し）: 末尾までがブロックで、入場済みなら Flag 後も最後まで流れる', async () => {
    const md = body(['> p', '[条件: x]', '> q', '[フラグ: x = false]', '> r'].join('\n'))
    const scenes = await scenesOf(md)
    const r = build(scenes)
    await r.startFrom({ sceneId: 'a', flags: X_TRUE })
    expect(playRest(r)).toEqual(['p', 'q', 'r'])
  })

  it('選択肢行末の [条件:] は別構文（Condition ブロックにならず、オプションのロックになる）', async () => {
    const md = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## a: A',
      '',
      '> 選ぶ',
      '',
      '[選択]',
      '- 行く → b [条件: x]',
      '- 戻る → b',
      '[/選択]',
      '',
      '## b: B',
      '',
      '> b1',
      '',
    ].join('\n')
    const scenes = await scenesOf(md)
    const ev = scenes[0].events
    expect(ev.some((e) => typeof e === 'object' && 'Condition' in e)).toBe(false)
    const choice = ev.find((e) => typeof e === 'object' && 'Choice' in e)
    expect(JSON.stringify(choice)).toContain('"condition"')
  })
})

// --- 旧セーブ・旧挙動不変 ---

describe('後方互換 (#799)', () => {
  it('[条件:] を使わない脚本: スナップショットにも SaveSlotData にも入場時 flags のキーが出ない', async () => {
    const scenes = await scenesOf(body(['> a', '[フラグ: x = true]', '> b'].join('\n')))
    const r = build(scenes)
    await r.startFrom({ sceneId: 'a', flags: {} })
    advance(r)
    const snap = r.getSnapshot()
    expect(Object.keys(snap)).not.toContain('entryFlags')
    expect(Object.keys(snap)).not.toContain('entryRawIndex')
    expect(Object.keys(snap)[Object.keys(snap).length - 1]).toBe('storyEnded')
    r.quickSave()
    const raw = JSON.parse(localStorage.getItem('name-name-save-t799-quick') ?? '{}')
    expect(Object.keys(raw).filter((k) => k.startsWith('entry'))).toEqual([])
  })

  it('[条件:] を使う脚本: 入場時 flags が末尾に載り、SaveSlotData にも savedAt の直前に載る', async () => {
    const r = build(await scenesOf(REPRO))
    await r.startFrom({ sceneId: 'a', flags: X_TRUE })
    advance(r)
    advance(r)
    const keys = Object.keys(r.getSnapshot())
    expect(keys.slice(-2)).toEqual(['storyEnded', 'entryFlags'])
    expect(r.getSnapshot().entryFlags).toEqual(X_TRUE)
    r.quickSave()
    const saved = JSON.parse(localStorage.getItem('name-name-save-t799-quick') ?? '{}')
    const slotKeys = Object.keys(saved)
    expect(slotKeys.slice(-4)).toEqual(['paperDollOutline', 'entryFlags', 'savedAt', 'sceneName'])
    expect(saved.entryFlags).toEqual(X_TRUE)
    // 保存した flags は位置時点の最新値（Flag 実行後）で、入場時 flags とは別
    expect(saved.flags.x).toEqual({ Bool: false })
  })

  it('旧セーブ（entryFlags 無し）: 保存位置までは従来どおり state.flags での静的展開で復元する', async () => {
    // [t0, Flag c=true, Cond c [X], t3]。旧実装の静的展開（flags 空）は [t0, Flag, t3] で、位置2 は t3。
    const md = body(
      ['> t0', '[フラグ: c = true]', '[条件: c]', '> X', '[/条件]', '> t3'].join('\n')
    )
    const scenes = await scenesOf(md)
    const legacy: SaveSlotData = legacySlot({ sceneId: 'a', eventIndex: 2, flags: {} })
    localStorage.setItem('name-name-save-t799-quick', JSON.stringify(legacy))
    const r = build(scenes)
    expect((await r.quickLoad())?.status).toBe('entered')
    expect(textOf(r)).toBe('t3')
    // 位置 t3 は最後の要素なので、再保存すると全体を静的に展開する印（entryRawIndex = 元列の長さ）が付き、同じ列を再現する
    const snap = r.getSnapshot()
    expect(snap.entryRawIndex).toBe(4)
    expect(snap.entryFlags).toEqual({})
    r.quickSave()
    const loaded = build(scenes)
    await loaded.quickLoad()
    expect(textOf(loaded)).toBe('t3')
    expect(I(loaded).resolvedEvents.length).toBe(3)
    // 同じ入場時 flags で新規の逐次評価をすると別の列になる（= 旧セーブの位置までが静的であることの対照）
    const fresh = build(scenes)
    await fresh.startFrom({ sceneId: 'a', flags: {} })
    expect(I(fresh).resolvedEvents.length).toBe(4)
  })

  it('旧セーブ: 保存位置より後ろの [フラグ:] で切り替わる [条件:] は逐次評価される（s0 → s1 → Y → end）', async () => {
    const md = body(
      ['> s0', '> s1', '[フラグ: y = true]', '[条件: y]', '> Y', '[/条件]', '> end'].join('\n\n')
    )
    const scenes = await scenesOf(md)
    localStorage.setItem(
      'name-name-save-t799-quick',
      JSON.stringify(legacySlot({ sceneId: 'a', eventIndex: 0, flags: {} }))
    )
    const r = build(scenes)
    expect((await r.quickLoad())?.status).toBe('entered')
    expect(playRest(r)).toEqual(['s0', 's1', 'Y', 'end'])
    // 1つ進めて再保存 → 別インスタンスで復元しても同じ残り（保存位置までの静的展開と後ろの逐次評価を entryFlags / entryRawIndex で再現）
    const second = build(scenes)
    await second.quickLoad()
    advance(second)
    second.quickSave()
    const loaded = build(scenes)
    await loaded.quickLoad()
    expect(playRest(loaded)).toEqual(['s1', 'Y', 'end'])
  })

  it('旧セーブの範囲検証は従来と同じ（静的展開後の長さで判定し、範囲外は復元失敗）', async () => {
    const md = body(
      ['> t0', '[フラグ: c = true]', '[条件: c]', '> X', '[/条件]', '> t3'].join('\n')
    )
    const scenes = await scenesOf(md)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 静的展開 [t0, Flag, t3] の長さ 3: eventIndex 3 は終端で有効、4 は範囲外
    for (const [eventIndex, status] of [
      [3, 'entered'],
      [4, 'failed'],
    ] as const) {
      localStorage.setItem(
        'name-name-save-t799-quick',
        JSON.stringify(legacySlot({ sceneId: 'a', eventIndex, flags: {} }))
      )
      const r = build(scenes)
      expect((await r.quickLoad())?.status, `eventIndex ${eventIndex}`).toBe(status)
    }
  })

  it('新形式の範囲検証: entryFlags で展開した長さで判定する', async () => {
    const md = body(
      ['> t0', '[フラグ: c = true]', '[条件: c]', '> X', '[/条件]', '> t3'].join('\n')
    )
    const scenes = await scenesOf(md)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 逐次評価 [t0, Flag, X, t3] の長さ 4: eventIndex 4 は終端で有効、5 は範囲外（latest flags が空でも entryFlags が優先）
    for (const [eventIndex, status] of [
      [3, 'entered'],
      [4, 'entered'],
      [5, 'failed'],
    ] as const) {
      localStorage.setItem(
        'name-name-save-t799-quick',
        JSON.stringify({ ...legacySlot({ sceneId: 'a', eventIndex, flags: {} }), entryFlags: {} })
      )
      const r = build(scenes)
      expect((await r.quickLoad())?.status, `eventIndex ${eventIndex}`).toBe(status)
    }
  })
})

describe('新規開始の位置指定（debug_eventIndex）と線形ストリーム (#799)', () => {
  const md = body(['[フラグ: y = true]', '[条件: y]', '> Y', '[/条件]', '> t'].join('\n'))

  it('位置指定の新規開始: 指定した flags が入場時 flags になり、eventIndex は逐次評価の列の添字', async () => {
    const scenes = await scenesOf(md)
    // 逐次評価の列は [Flag, Y, t]。eventIndex 2 は t（旧セーブ扱いの静的展開だと [Flag, t] で範囲外になる）
    const r = build(scenes)
    const result = await r.startFrom({ sceneId: 'a', flags: {}, eventIndex: 2 })
    expect(result.status).toBe('entered')
    expect(textOf(r)).toBe('t')
    expect(r.getSnapshot().entryFlags).toEqual({})
    // 先頭からも同じ列
    const head = build(scenes)
    await head.startFrom({ sceneId: 'a', flags: {} })
    expect(playRest(head)).toEqual(['Y', 't'])
  })

  it('線形ストリームの途中のシーンから始めたセーブは entryRawIndex を持ち、復元が同じ位置・同じ残りになる', async () => {
    const two = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## a: A',
      '',
      '[フラグ: k = true]',
      '> a1',
      '',
      '## b: B',
      '',
      '[条件: k]',
      '> bk',
      '[/条件]',
      '> b1',
      '',
    ].join('\n')
    const scenes = await scenesOf(two)
    const flat: Event[] = scenes.flatMap((sc, i) =>
      i ? (['SceneTransition', ...sc.events] as Event[]) : sc.events
    )
    const mk = (): NovelRenderer => {
      const r = new NovelRenderer()
      r.setEvents(flat)
      r.setJumpSceneIndex(scenes)
      r.setDocKey('t799')
      return r
    }
    // b から線形に始める: a の [フラグ:] は実行されない（開始シーン先頭時点の flags = 空）ので bk は出ない
    const r = mk()
    await r.startFrom({ sceneId: 'b', linear: true, flags: {} })
    const snap = r.getSnapshot()
    expect(snap.entryRawIndex).toBe(3)
    const restored = mk()
    expect((await restored.restoreSnapshot(snap)).status).toBe('entered')
    expect(playRest(restored)).toEqual(['b1'])
    // a から線形に始める: Flag が走査され、b の [条件: k] に入る
    const a = mk()
    await a.startFrom({ sceneId: 'a', linear: true, flags: {} })
    expect(a.getSnapshot().entryRawIndex).toBeUndefined()
    expect(playRest(a)).toEqual(['a1', 'bk', 'b1'])
  })

  it('線形ストリームの途中から始めた訪問は、SaveSlotData（quickSave / quickLoad）を通っても同じ位置・同じ残りになる', async () => {
    const two = [
      '---',
      'engine: name-name',
      'chapter: 1',
      'title: t',
      '---',
      '',
      '## a: A',
      '',
      '[フラグ: k = true]',
      '> a1',
      '',
      '## b: B',
      '',
      '[条件: k]',
      '> bk',
      '[/条件]',
      '> b1',
      '',
      '> b2',
      '',
    ].join('\n')
    const scenes = await scenesOf(two)
    const flat: Event[] = scenes.flatMap((sc, i) =>
      i ? (['SceneTransition', ...sc.events] as Event[]) : sc.events
    )
    const mk = (): NovelRenderer => {
      const r = new NovelRenderer()
      r.setEvents(flat)
      r.setJumpSceneIndex(scenes)
      r.setDocKey('t799')
      return r
    }
    const r = mk()
    await r.startFrom({ sceneId: 'b', linear: true, flags: {} })
    advance(r)
    expect(textOf(r)).toBe('b2')
    r.quickSave()
    const saved = JSON.parse(localStorage.getItem('name-name-save-t799-quick') ?? '{}')
    expect(saved.entryRawIndex).toBe(3)
    const loaded = mk()
    expect((await loaded.quickLoad())?.status).toBe('entered')
    expect(textOf(loaded)).toBe('b2')
    expect(playRest(loaded)).toEqual(['b2'])
  })
})

function legacySlot(p: {
  sceneId: string | null
  eventIndex: number
  flags: Record<string, FlagValue>
}): SaveSlotData {
  return {
    slot: -1,
    sceneId: p.sceneId,
    eventIndex: p.eventIndex,
    textIndex: 0,
    sentenceIndex: 0,
    flags: p.flags,
    backgroundPath: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    savedAt: '2026-10-21T00:00:00.000Z',
    sceneName: null,
  }
}

// --- ランダムな木: レンダラの再生順が参照インタプリタと一致し、全位置で保存 → 復元が同一 ---

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

const NAMES = ['a', 'b', 'c']
function randomTree(rand: () => number, counter: { n: number }, depth = 0): Event[] {
  const len = 1 + Math.floor(rand() * 5)
  const out: Event[] = []
  for (let i = 0; i < len; i++) {
    const r = rand()
    const name = NAMES[Math.floor(rand() * NAMES.length)]
    if (r < 0.4) out.push({ Narration: { text: [`n${counter.n++}`] } })
    else if (r < 0.65) {
      const v = rand()
      const value: FlagValue =
        v < 0.6 ? { Bool: rand() < 0.5 } : v < 0.8 ? { String: 's' } : { Number: 0 }
      out.push({ Flag: { name, value } })
    } else if (depth < 3)
      out.push({ Condition: { flag: name, events: randomTree(rand, counter, depth + 1) } })
    else out.push({ Narration: { text: [`n${counter.n++}`] } })
  }
  return out
}

/** 参照インタプリタ: 実行時に1イベントずつ進み、Condition に達した時点の現在の flags で入る/飛ばす。本文だけ返す。 */
function referenceTexts(raw: readonly Event[], entry: Record<string, FlagValue>): string[] {
  const flags = new Map<string, FlagValue>(Object.entries(entry))
  const truthy = (n: string): boolean => {
    const v = flags.get(n)
    if (v === undefined) return false
    return 'Bool' in v ? v.Bool : true
  }
  const out: string[] = []
  const stack: Array<{ list: readonly Event[]; i: number }> = [{ list: raw, i: 0 }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    if (top.i >= top.list.length) {
      stack.pop()
      continue
    }
    const ev = top.list[top.i++]
    if (typeof ev !== 'object' || ev === null) continue
    if ('Condition' in ev) {
      if (truthy(ev.Condition.flag)) stack.push({ list: ev.Condition.events, i: 0 })
    } else if ('Flag' in ev) flags.set(ev.Flag.name, ev.Flag.value)
    else if ('Narration' in ev) out.push(ev.Narration.text.join(''))
  }
  return out
}

describe('ランダムな木での決定性 (#799)', () => {
  it('レンダラの再生順は参照インタプリタと一致し、全位置で スナップショット／クイックセーブ → 復元が同じ残りを再現する', async () => {
    const rand = rng(9799)
    let positions = 0
    let withFlagInCondition = 0
    for (let n = 0; n < 60; n++) {
      const raw = randomTree(rand, { n: 0 })
      const E: Record<string, FlagValue> = {}
      for (const name of NAMES) {
        const r = rand()
        if (r < 0.7) E[name] = { Bool: r < 0.45 }
      }
      const expected = referenceTexts(raw, E)
      if (expected.length === 0) continue
      const scenes: EventScene[] = [{ id: 'a', title: 'a', view: 'TopDown', events: raw }]
      const base = build(scenes)
      await base.startFrom({ sceneId: 'a', flags: E })
      const trace = playRest(base)
      expect(trace, `case ${n}`).toEqual(expected)
      if (JSON.stringify(raw).includes('"Condition"') && JSON.stringify(raw).includes('"Flag"')) {
        withFlagInCondition++
      }
      for (let k = 0; k < expected.length; k++) {
        const saver = build(scenes)
        await saver.startFrom({ sceneId: 'a', flags: E })
        for (let i = 0; i < k; i++) advance(saver)
        expect(textOf(saver)).toBe(expected[k])
        const snap = JSON.parse(JSON.stringify(saver.getSnapshot())) as NovelGameState
        // restoreSnapshot（JSON を往復したスナップショット）
        const viaSnap = build(scenes)
        expect((await viaSnap.restoreSnapshot(snap)).status, `case ${n} pos ${k}`).toBe('entered')
        expect(playRest(viaSnap), `case ${n} snap ${k}`).toEqual(expected.slice(k))
        // クイックセーブ → クイックロード
        expect(saver.quickSave()).toBe(true)
        const viaLoad = build(scenes)
        expect((await viaLoad.quickLoad())?.status).toBe('entered')
        expect(playRest(viaLoad), `case ${n} load ${k}`).toEqual(expected.slice(k))
        // 総数は訪問中不変
        expect(I(viaLoad).displayEventCount).toBe(expected.length)
        positions++
      }
    }
    expect(positions).toBeGreaterThan(150)
    expect(withFlagInCondition).toBeGreaterThan(15)
  })

  it('goBack / seekTo の任意の往復でも列と総数が不変で、再び進めると同じ本文列になる', async () => {
    const rand = rng(8799)
    let checked = 0
    for (let n = 0; n < 40; n++) {
      const raw = randomTree(rand, { n: 0 })
      const E: Record<string, FlagValue> = { a: { Bool: true }, b: { Bool: true } }
      const expected = referenceTexts(raw, E)
      if (expected.length < 2) continue
      const scenes: EventScene[] = [{ id: 'a', title: 'a', view: 'TopDown', events: raw }]
      const total = expected.length
      for (let round = 0; round < 3; round++) {
        // 最後の本文まで進めてから、後ろ向きに SeekBar で戻る（訪問済みの位置へだけ戻れる）
        const r = build(scenes)
        await r.startFrom({ sceneId: 'a', flags: E })
        expect(I(r).displayEventCount).toBe(total)
        advanceToLastText(r, total)
        const target = Math.floor(rand() * total)
        for (let k = total - 1; k >= target; k--) {
          I(r).seekToTextEventDisplayIndex(k)
          expect(textOf(r), `case ${n} seek ${k}`).toBe(expected[k])
          expect(I(r).displayEventCount).toBe(total)
        }
        // 戻った先から進めると、同じ本文列
        expect(playRest(r), `case ${n} replay ${target}`).toEqual(expected.slice(target))
        // goBack を2回（履歴が足りなければ先頭まで）しても総数は不変で、そこから進めて同じ列
        const g = build(scenes)
        await g.startFrom({ sceneId: 'a', flags: E })
        advanceToLastText(g, total)
        g.goBack()
        g.goBack()
        expect(I(g).displayEventCount).toBe(total)
        const at = expected.indexOf(textOf(g))
        expect(at).toBeGreaterThanOrEqual(0)
        expect(playRest(g)).toEqual(expected.slice(at))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(40)
  })
})

// --- 前提の固定: 再生中に flags を書くのは [フラグ:] の実行だけ ---

describe('フラグの書き手の固定 (#799)', () => {
  // 入場時展開は「シーン訪問の中で flags を変えるのは `[フラグ:]` だけ」という前提に立つ。将来この前提が崩れる
  // 変更（戦闘結果→フラグ等）を入れるときは、同じ変更で展開をプログラム側（遅延展開）へ移す必要がある。
  // テスト以外の game/ 配下のソース（相対パス → 本文）。Vite の ?raw で読む。
  const sourceMap = import.meta.glob(['./**/*.ts', '!./**/*.test.ts', '!./**/*.oracle.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
  const sources = Object.keys(sourceMap).map((p) => p.replace(/^\.\//, ''))
  const read = (f: string): string => sourceMap[`./${f}`]

  it('setFlag の呼び出しは GameState.ts の走査用の複製への適用（expandEvents・entryFromState）と NovelRenderer の Flag 分岐 1 か所だけ', () => {
    const hits: string[] = []
    for (const f of sources) {
      const text = read(f)
      const count = (text.match(/\.setFlag\(/g) ?? []).length
      if (count > 0) hits.push(`${f}:${count}`)
    }
    expect(hits.sort()).toEqual(['GameState.ts:2', 'NovelRenderer.ts:1'])
  })

  it('gameState.fromJSON（flags の置換）は 新規開始・復元の 3 か所だけ', () => {
    const hits: string[] = []
    for (const f of sources) {
      const text = read(f)
      // GameState.ts 自身（定義）とコメント行は除く
      if (f === 'GameState.ts') continue
      const code = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      const count = (code.match(/gameState\.fromJSON\(/g) ?? []).length
      if (count > 0) hits.push(`${f}:${count}`)
    }
    // applyFreshContext / restoreToScene / applyState
    expect(hits.sort()).toEqual(['NovelRenderer.ts:3'])
  })
})
