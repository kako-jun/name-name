/**
 * 旧形式のセーブ（`entryFlags` 無し）を読み込んだ後の再生列が、`[条件:]` のブロック入場時評価 (#799) の導入前
 * （`[フラグ:]` の実行ごとに最新 flags で再展開していた実装）と一致することを固定する。
 *
 * 期待値は導入前の実装で同じ固定フィクスチャを実行して得た列。保存位置（`eventIndex`）は導入前の展開
 * （保存時の flags での静的展開）に対する添字で、`[フラグ:]` の前後・`[条件:]` ブロックの内外・線形ストリームを含む。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { parseMarkdown } from '../wasm/parser'
import type { Event, EventScene, FlagValue } from '../types'
import type { SaveSlotData } from './SaveManager'

const header = ['---', 'engine: name-name', 'chapter: 1', 'title: t', '---', ''].join('\n')

async function scenesOf(sceneBodies: string[]): Promise<EventScene[]> {
  const md =
    header + sceneBodies.map((b, i) => `\n## ${'abc'[i]}: 場面${'ABC'[i]}\n\n${b}\n`).join('')
  const doc = await parseMarkdown(md)
  return doc.chapters.flatMap((c) => c.scenes)
}

const textOf = (r: NovelRenderer): string =>
  (r.getDebugState().eventText ?? '').replace(/["\s]/g, '')
const advance = (r: NovelRenderer): void => (r as unknown as { advance(): void }).advance()

function playRest(r: NovelRenderer, max = 40): string[] {
  const out: string[] = []
  for (let i = 0; i < max; i++) {
    const t = textOf(r)
    if (t === '' || t === out[out.length - 1]) break
    out.push(t)
    advance(r)
  }
  return out
}

function legacySlot(
  sceneId: string | null,
  eventIndex: number,
  flags: Record<string, FlagValue>
): SaveSlotData {
  return {
    slot: -1,
    sceneId,
    eventIndex,
    textIndex: 0,
    sentenceIndex: 0,
    flags,
    backgroundPath: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    savedAt: '2026-10-21T00:00:00.000Z',
    sceneName: null,
  }
}

const T: FlagValue = { Bool: true }

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

async function loadLegacy(
  scenes: EventScene[],
  slot: SaveSlotData,
  linear = false
): Promise<NovelRenderer> {
  localStorage.setItem('name-name-save-legacy-quick', JSON.stringify(slot))
  const r = new NovelRenderer()
  if (linear) {
    const flat: Event[] = scenes.flatMap((sc, i) =>
      i ? (['SceneTransition', ...sc.events] as Event[]) : sc.events
    )
    r.setEvents(flat)
    r.setJumpSceneIndex(scenes)
  } else {
    r.setScenes(scenes)
  }
  r.setDocKey('legacy')
  const res = await r.quickLoad()
  expect(res?.status).toBe('entered')
  return r
}

// [フラグ:] が [条件:] より前（トップレベル）にある脚本
const AFTER_FLAG = [
  '> s0',
  '> s1',
  '[フラグ: y = true]',
  '[条件: y]',
  '> Y',
  '[/条件]',
  '> end',
].join('\n\n')
// ブロックの中に [フラグ:] があり、ブロックの後ろの [条件:] がそれに依存する脚本
const FLAG_IN_BLOCK = [
  '> p',
  '[条件: x]',
  '> A',
  '[フラグ: z = true]',
  '> B',
  '[/条件]',
  '[条件: z]',
  '> Z',
  '[/条件]',
  '> end',
].join('\n\n')
// ブロックが入れ子で、内側の [条件:] が外側の中の [フラグ:] に依存する脚本
const NESTED = [
  '> n0',
  '[条件: x]',
  '> A',
  '[フラグ: w = true]',
  '[条件: w]',
  '> W',
  '[/条件]',
  '> B',
  '[/条件]',
  '> end',
].join('\n\n')

interface Case {
  name: string
  bodies: string[]
  eventIndex: number
  flags: Record<string, FlagValue>
  linear?: boolean
  /** 導入前の実装で得た、ロード後に最後まで進めた本文の列 */
  expected: string[]
}

const CASES: Case[] = [
  {
    name: 'フラグ前で保存（flags 空）',
    bodies: [AFTER_FLAG],
    eventIndex: 0,
    flags: {},
    expected: ['s0', 's1', 'Y', 'end'],
  },
  {
    name: '2つ目の本文で保存（flags 空）',
    bodies: [AFTER_FLAG],
    eventIndex: 1,
    flags: {},
    expected: ['s1', 'Y', 'end'],
  },
  {
    name: '[フラグ:] 実行後に保存（y 真）',
    bodies: [AFTER_FLAG],
    eventIndex: 3,
    flags: { y: T },
    expected: ['Y', 'end'],
  },
  {
    name: 'ブロックの中（A）で保存: 後ろの [フラグ:] が後続の条件に効く',
    bodies: [FLAG_IN_BLOCK],
    eventIndex: 1,
    flags: { x: T },
    expected: ['A', 'B', 'Z', 'end'],
  },
  {
    name: 'ブロックの中（B）で保存',
    bodies: [FLAG_IN_BLOCK],
    eventIndex: 3,
    flags: { x: T, z: T },
    expected: ['B', 'Z', 'end'],
  },
  {
    name: 'ブロックの外（p）で保存',
    bodies: [FLAG_IN_BLOCK],
    eventIndex: 0,
    flags: { x: T },
    expected: ['p', 'A', 'B', 'Z', 'end'],
  },
  {
    name: '線形ストリーム: 先頭シーン内で保存',
    bodies: [AFTER_FLAG, FLAG_IN_BLOCK],
    eventIndex: 0,
    flags: {},
    linear: true,
    expected: ['s0', 's1', 'Y', 'end', 'p', 'end'],
  },
  {
    name: '線形ストリーム: 2つ目のシーン内で保存',
    bodies: [AFTER_FLAG, FLAG_IN_BLOCK],
    eventIndex: 7,
    flags: { y: T, x: T },
    linear: true,
    expected: ['A', 'B', 'Z', 'end'],
  },
]

describe('旧形式セーブの再生列が導入前の実装と一致する (#799)', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const scenes = await scenesOf(c.bodies)
      const r = await loadLegacy(
        scenes,
        legacySlot(c.linear ? null : 'a', c.eventIndex, c.flags),
        c.linear
      )
      const got = playRest(r)
      expect(got).toEqual(c.expected)
    })
  }
})

describe('旧形式セーブの既知の差分 (#799)', () => {
  it('位置を含むブロックの中で、位置より後ろの [フラグ:] を同じブロックの内側の [条件:] が見るときは、評価し直されない', async () => {
    // 導入前の実装は [フラグ: w = true] の実行で再展開し ['A', 'W', 'B', 'end'] になっていた。
    // 位置を含むトップレベルの要素は保存位置の添字を保つため静的に展開するので、その内側の条件は評価し直されない。
    const scenes = await scenesOf([NESTED])
    const r = await loadLegacy(scenes, legacySlot('a', 1, { x: T }))
    expect(playRest(r)).toEqual(['A', 'B', 'end'])
  })
})
