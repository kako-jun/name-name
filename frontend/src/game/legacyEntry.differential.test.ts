/**
 * 旧形式セーブ（`entryFlags` 無し）の復元 (`entryFromState`) の差分テスト (#799)。
 *
 * ランダムな脚本（`[条件:]` のネスト、`[フラグ:]` を位置の前後・ブロックの内外に置く）× 全本文位置で、
 * 復元後の再生列を「理想形の参照」と突き合わせる。参照は `expandEvents` / `entryFromState` を呼ばない独立実装:
 *   - 保存位置を含むトップレベル要素 k は保存時の flags で静的に展開する（導入前の実装と添字が一致する）
 *   - k+1 以降は「保存時の flags ＋ k の位置より後ろの `[フラグ:]`」から1イベントずつ逐次評価する
 * 固定シードで決定的。要素 k の内側の `[条件:]` が k 自身の残りの `[フラグ:]` で評価し直されないこと
 * （記録済みの制約）は、参照も同じ規則（静的展開）なので一致する。
 */
import { describe, it, expect } from 'vitest'
import type { Event, FlagValue } from '../types'
import { entryFromState, expandEvents, type NovelGameState } from './GameState'

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
    else if (depth < 2) out.push(cond(name, ...tree(rand, counter, depth + 1)))
    else out.push(narr(`t${counter.n++}`))
  }
  return out
}

type Flags = Record<string, boolean>

const truthy = (f: Flags, name: string): boolean => f[name] === true

/** 参照: 入れ子を再帰で静的に展開（Flag は残す、Condition は与えられた flags で判定）。 */
function staticList(list: readonly Event[], f: Flags): Event[] {
  const out: Event[] = []
  for (const e of list) {
    if (typeof e === 'object' && 'Condition' in e) {
      if (truthy(f, e.Condition.flag)) out.push(...staticList(e.Condition.events, f))
    } else out.push(e)
  }
  return out
}

/** 参照: 明示スタックで1イベントずつ。Condition に達した時点の flags で入る/飛ばす。本文だけ返す。 */
function sequentialTexts(list: readonly Event[], start: Flags): string[] {
  const f: Flags = { ...start }
  const texts: string[] = []
  const stack = [{ list, i: 0 }]
  while (stack.length) {
    const top = stack[stack.length - 1]
    if (top.i >= top.list.length) {
      stack.pop()
      continue
    }
    const e = top.list[top.i++]
    if (typeof e === 'object' && 'Condition' in e) {
      if (truthy(f, e.Condition.flag)) stack.push({ list: e.Condition.events, i: 0 })
    } else if (typeof e === 'object' && 'Flag' in e) {
      f[e.Flag.name] = (e.Flag.value as { Bool: boolean }).Bool
    } else if (typeof e === 'object' && 'Narration' in e) texts.push(e.Narration.text[0])
  }
  return texts
}

const toJson = (f: Flags): Record<string, FlagValue> =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { Bool: v }]))

const textsOf = (events: readonly Event[]): string[] =>
  events.flatMap((e) => (typeof e === 'object' && 'Narration' in e ? [e.Narration.text[0]] : []))

describe('旧形式セーブの復元は理想形の参照と一致する (#799)', () => {
  it('ランダムな脚本 150 本 × 全本文位置（固定シード）', () => {
    let positions = 0
    let withScan = 0
    for (let seed = 1; seed <= 150; seed++) {
      const rand = rng(seed * 7919)
      const raw = tree(rand, { n: 0 }, 0)
      for (let variant = 0; variant < 3; variant++) {
        // 保存時の flags（ランダム）。保存位置はこの flags での静的展開の添字（導入前の実装と同じ）。
        const saved: Flags = {}
        for (const n of NAMES) if (rand() < 0.6) saved[n] = rand() < 0.6

        const per = raw.map((e) => staticList([e], saved))
        const base = per.flat()
        const offsets = [0]
        for (const q of per) offsets.push(offsets[offsets.length - 1] + q.length)

        for (let p = 0; p < base.length; p++) {
          const ev = base[p]
          if (!(typeof ev === 'object' && 'Narration' in ev)) continue
          positions++
          let k = 0
          while (!(offsets[k] <= p && p < offsets[k + 1])) k++

          const tail = base.slice(p, offsets[k + 1])
          const scanStart: Flags = { ...saved }
          for (const e of tail)
            if (typeof e === 'object' && 'Flag' in e)
              scanStart[e.Flag.name] = (e.Flag.value as { Bool: boolean }).Bool
          const expected = [...textsOf(tail), ...sequentialTexts(raw.slice(k + 1), scanStart)]

          const state = { flags: toJson(saved), eventIndex: p } as unknown as NovelGameState
          const entry = entryFromState(state, raw)
          if (entry.scanFlags !== undefined) withScan++
          const got = textsOf(expandEvents(raw, entry).events.slice(p))
          expect(got, `seed=${seed} p=${p}`).toEqual(expected)
        }
      }
    }
    // 乱数列が痩せて空回りしていないこと（件数は固定シードで決定的）
    expect(positions).toBeGreaterThan(500)
    expect(withScan).toBeGreaterThan(50)
  })
})
