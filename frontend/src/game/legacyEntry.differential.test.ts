/**
 * 旧形式セーブ（`entryFlags` 無し）の復元 (`entryFromState`) の差分テスト (#799)。
 *
 * ランダムな脚本（`[条件:]` のネストは深さ3まで、`[フラグ:]` をブロックの内外・トップレベルの線形ストリームに置く）
 * × 保存時 flags 3通り × 全位置で、復元後の再生列を「理想形の参照」と突き合わせる。
 * 参照は `expandEvents` / `entryFromState` を呼ばない独立実装（明示スタックのインタプリタ）:
 *   - 位置（保存時の flags での静的展開の添字 p）に達するまでは、`[条件:]` を保存時の flags で判定し `[フラグ:]` は適用しない
 *     （位置を囲むブロックには入った状態になる）
 *   - 達した後は、1イベントずつ `[フラグ:]` を適用しながら、`[条件:]` に達した時点の flags で判定する
 * もう一つ、導入前の実装（`[フラグ:]` の実行ごとに最新 flags で全体を再展開）を模した再生も作り、理想形との差が
 * 「ブロックの内側の `[フラグ:]`（ブロック入場時評価の差）」か「導入前の再展開による位置のずれ」だけであることを確かめる。
 * 固定シードで決定的。
 */
import { describe, it, expect } from 'vitest'
import type { Event, FlagValue } from '../types'
import {
  entryFromState,
  expandEvents,
  resolveEvents,
  GameState,
  type NovelGameState,
} from './GameState'

const narr = (s: string): Event => ({ Narration: { text: [s] } })
const flagB = (name: string, v: boolean): Event => ({ Flag: { name, value: { Bool: v } } })
const cond = (flag: string, ...events: Event[]): Event => ({ Condition: { flag, events } })

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

function tree(rand: () => number, counter: { n: number }, depth: number): Event[] {
  const len = 1 + Math.floor(rand() * (depth === 0 ? 7 : 4))
  const out: Event[] = []
  for (let i = 0; i < len; i++) {
    const r = rand()
    const name = NAMES[Math.floor(rand() * NAMES.length)]
    if (r < 0.4) out.push(narr(`t${counter.n++}`))
    else if (r < 0.65) out.push(flagB(name, rand() < 0.5))
    else if (depth < 3) out.push(cond(name, ...tree(rand, counter, depth + 1)))
    else out.push(narr(`t${counter.n++}`))
  }
  return out
}

type Flags = Record<string, boolean>

const truthy = (f: Flags, name: string): boolean => f[name] === true

/** 参照: 保存時の flags での静的展開（導入前の実装の添字）。 */
function staticList(list: readonly Event[], f: Flags): Event[] {
  const out: Event[] = []
  for (const e of list) {
    if (typeof e === 'object' && 'Condition' in e) {
      if (truthy(f, e.Condition.flag)) out.push(...staticList(e.Condition.events, f))
    } else out.push(e)
  }
  return out
}

/** 参照（理想形）: 明示スタックで1イベントずつ。出力が `resume` 個に達するまで静的、達した後は逐次。位置以降の本文だけ返す。 */
function idealTexts(raw: readonly Event[], saved: Flags, resume: number): string[] {
  const f: Flags = { ...saved }
  const texts: string[] = []
  let count = 0
  const stack = [{ list: raw, i: 0 }]
  while (stack.length) {
    const top = stack[stack.length - 1]
    if (top.i >= top.list.length) {
      stack.pop()
      continue
    }
    const e = top.list[top.i++]
    const sequential = count >= resume
    if (typeof e === 'object' && 'Condition' in e) {
      if (truthy(sequential ? f : saved, e.Condition.flag))
        stack.push({ list: e.Condition.events, i: 0 })
      continue
    }
    if (sequential && typeof e === 'object' && 'Flag' in e)
      f[e.Flag.name] = (e.Flag.value as { Bool: boolean }).Bool
    if (sequential && typeof e === 'object' && 'Narration' in e) texts.push(e.Narration.text[0])
    count++
  }
  return texts
}

/**
 * 導入前の実装を模した再生: 位置 p から1つずつ実行し、`[フラグ:]` のたびに最新 flags で全体を再展開する。
 * `shifted` は、再展開で実行済みの部分の長さが変わった（位置がずれた）ことがあるか。
 */
function oldMainReplay(
  raw: readonly Event[],
  saved: Flags,
  p: number
): { texts: string[]; shifted: boolean } {
  const gs = new GameState()
  gs.fromJSON(toJson(saved))
  let events = resolveEvents(raw, gs)
  const texts: string[] = []
  let shifted = false
  for (let i = p; i < events.length; i++) {
    const e = events[i]
    if (typeof e === 'object' && 'Narration' in e) texts.push(e.Narration.text[0])
    if (typeof e === 'object' && 'Flag' in e) {
      gs.setFlag(e.Flag.name, e.Flag.value)
      const next = resolveEvents(raw, gs)
      const same =
        next.length > i &&
        JSON.stringify(next.slice(0, i + 1)) === JSON.stringify(events.slice(0, i + 1))
      if (!same) shifted = true
      events = next
    }
  }
  return { texts, shifted }
}

const hasFlagInsideBlock = (list: readonly Event[], inside = false): boolean =>
  list.some((e) =>
    typeof e === 'object' && 'Condition' in e
      ? hasFlagInsideBlock(e.Condition.events, true)
      : inside && typeof e === 'object' && 'Flag' in e
  )

const toJson = (f: Flags): Record<string, FlagValue> =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { Bool: v }]))

const textsOf = (events: readonly Event[]): string[] =>
  events.flatMap((e) => (typeof e === 'object' && 'Narration' in e ? [e.Narration.text[0]] : []))

describe('旧形式セーブの復元は理想形の参照と一致する (#799)', () => {
  it('ランダムな脚本 200 本 × 保存時 flags 3通り × 全位置（固定シード）', () => {
    let positions = 0
    let differsFromMain = 0
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed * 7919)
      const raw = tree(rand, { n: 0 }, 0)
      const blockFlags = hasFlagInsideBlock(raw)
      for (let variant = 0; variant < 3; variant++) {
        const saved: Flags = {}
        for (const n of NAMES) if (rand() < 0.6) saved[n] = rand() < 0.6
        const base = staticList(raw, saved)

        for (let p = 0; p < base.length; p++) {
          positions++
          const expected = idealTexts(raw, saved, p)
          const state = { flags: toJson(saved), eventIndex: p } as unknown as NovelGameState
          const got = textsOf(expandEvents(raw, entryFromState(state, raw)).events.slice(p))
          expect(got, `seed=${seed} v=${variant} p=${p}`).toEqual(expected)

          const main = oldMainReplay(raw, saved, p)
          if (JSON.stringify(main.texts) !== JSON.stringify(expected)) {
            differsFromMain++
            // 導入前との差は、ブロックの内側に `[フラグ:]` がある（ブロック入場時評価の差）か、
            // 導入前の再展開で実行済みの部分が変わって位置がずれた（導入前の不具合）ときだけ
            expect(
              blockFlags || main.shifted,
              `seed=${seed} v=${variant} p=${p}: 導入前との想定外の差`
            ).toBe(true)
          }
        }
      }
    }
    // 乱数列が痩せて空回りしていないこと（件数は固定シードで決定的）
    expect(positions).toBeGreaterThan(2000)
    expect(differsFromMain).toBeGreaterThan(0)
  })
})
