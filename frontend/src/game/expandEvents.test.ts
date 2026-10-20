/**
 * `expandEvents`（`[条件:]` の入場時評価）のテスト (#799)。
 *
 * 仕様は「実行時に1イベントずつ進み、`[条件:]` に達した時点の現在の flags で入る/飛ばす。`[フラグ:]` は
 * 実フラグを更新する」（TUI の `build_scene_items` と同じ）。ここでは、その仕様を `expandEvents` と
 * 独立に書いた素朴なインタプリタ（明示スタックで走る）に写し、固定シードのランダムな木と突き合わせる。
 * 旧実装（`resolveEvents`: 全体を最新 flags で静的に展開）との一致は、`[フラグ:]` を含まない入力で確かめる。
 */
import { describe, it, expect } from 'vitest'
import type { Event, FlagValue } from '../types'
import {
  GameState,
  entryFromState,
  expandEvents,
  hasCondition,
  resolveEvents,
  type ExpansionEntry,
  type NovelGameState,
} from './GameState'

// --- fixture ---

const narr = (s: string): Event => ({ Narration: { text: [s] } })
const setFlag = (name: string, value: FlagValue): Event => ({ Flag: { name, value } })
const flagB = (name: string, v: boolean): Event => setFlag(name, { Bool: v })
const cond = (flag: string, ...events: Event[]): Event => ({ Condition: { flag, events } })
const jump = (target: string): Event => ({ Jump: { target } })

const entryOf = (flags: Record<string, FlagValue>, fromRawIndex = 0): ExpansionEntry => ({
  flags,
  fromRawIndex,
})

const bools = (o: Record<string, boolean>): Record<string, FlagValue> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { Bool: v }]))

/** 展開結果を比べやすい文字列にする（本文は text、Flag は F:name=…、その他は JSON）。 */
function token(e: Event): string {
  if (typeof e === 'object' && e !== null) {
    if ('Narration' in e) return e.Narration.text.join('')
    if ('Flag' in e) return `F:${e.Flag.name}=${JSON.stringify(e.Flag.value)}`
  }
  return JSON.stringify(e)
}
const tokens = (events: readonly Event[]): string[] => events.map(token)

/**
 * 仕様の素朴な実装: 明示スタックで元列を走り、Condition に達した時点の「現在の flags」で入る/飛ばす。
 * `expandEvents` の再帰とは別の書き方（反復＋スタック）にしてある。戻り値は出力イベントと、
 * トップレベル i 番目を処理する直前の出力数。
 */
function runReference(
  raw: readonly Event[],
  entry: Record<string, FlagValue>
): { out: Event[]; offsets: number[] } {
  const flags = new GameState()
  flags.fromJSON(entry)
  const out: Event[] = []
  const offsets: number[] = []
  const stack: Array<{ list: readonly Event[]; i: number }> = [{ list: raw, i: 0 }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    if (top.i >= top.list.length) {
      stack.pop()
      continue
    }
    if (stack.length === 1) offsets.push(out.length)
    const ev = top.list[top.i++]
    if (typeof ev === 'object' && ev !== null && 'Condition' in ev) {
      if (flags.checkFlag(ev.Condition.flag)) stack.push({ list: ev.Condition.events, i: 0 })
      continue
    }
    if (typeof ev === 'object' && ev !== null && 'Flag' in ev)
      flags.setFlag(ev.Flag.name, ev.Flag.value)
    out.push(ev)
  }
  offsets.push(out.length)
  return { out, offsets }
}

// --- 固定シード PRNG とランダムな木 ---

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

function randomTree(
  rand: () => number,
  opts: { flags: boolean; depth?: number; counter?: { n: number } }
): Event[] {
  const counter = opts.counter ?? { n: 0 }
  const depth = opts.depth ?? 0
  const len = Math.floor(rand() * 6)
  const out: Event[] = []
  for (let i = 0; i < len; i++) {
    const r = rand()
    const name = NAMES[Math.floor(rand() * NAMES.length)]
    if (r < 0.35) out.push(narr(`t${counter.n++}`))
    else if (r < 0.55 && opts.flags) {
      const v = rand()
      out.push(
        setFlag(
          name,
          v < 0.5
            ? { Bool: rand() < 0.5 }
            : v < 0.75
              ? { String: 'x' }
              : { Number: Math.floor(rand() * 2) }
        )
      )
    } else if (r < 0.62) out.push(rand() < 0.5 ? 'SceneTransition' : jump(`s${counter.n++}`))
    else if (depth < 3)
      out.push({
        Condition: { flag: name, events: randomTree(rand, { ...opts, depth: depth + 1, counter }) },
      })
    else out.push(narr(`t${counter.n++}`))
  }
  return out
}

function randomFlags(rand: () => number): Record<string, FlagValue> {
  const f: Record<string, FlagValue> = {}
  for (const n of NAMES) {
    const r = rand()
    if (r < 0.3) continue
    f[n] = r < 0.65 ? { Bool: true } : r < 0.85 ? { Bool: false } : { Number: 0 }
  }
  return f
}

// --- ゴールデン ---

describe('expandEvents ゴールデン (#799)', () => {
  it('#799 の症状: ブロック内でそのフラグを偽にしても、入場済みの残りは流れる', () => {
    const raw = [cond('x', narr('A'), flagB('x', false), narr('B')), narr('C')]
    expect(tokens(expandEvents(raw, entryOf(bools({ x: true }))).events)).toEqual([
      'A',
      'F:x={"Bool":false}',
      'B',
      'C',
    ])
  })

  it('入場時に偽なら、ブロック内の Flag も実行されず、その後の判定にも効かない', () => {
    const raw = [cond('x', flagB('y', true)), cond('y', narr('Y')), narr('end')]
    expect(tokens(expandEvents(raw, entryOf({})).events)).toEqual(['end'])
  })

  it('ブロックの外の先行 Flag は、後ろの Condition の入場時評価に効く', () => {
    const raw = [flagB('x', true), cond('x', narr('in')), narr('end')]
    expect(tokens(expandEvents(raw, entryOf({})).events)).toEqual([
      'F:x={"Bool":true}',
      'in',
      'end',
    ])
  })

  it('ブロック内トグル（true→false→true）: 入場済みなら全部流れ、出た後の再評価は最新の値', () => {
    const raw = [
      cond('x', narr('1'), flagB('x', false), narr('2'), flagB('x', true), narr('3')),
      cond('x', narr('after')),
    ]
    expect(tokens(expandEvents(raw, entryOf(bools({ x: true }))).events)).toEqual([
      '1',
      'F:x={"Bool":false}',
      '2',
      'F:x={"Bool":true}',
      '3',
      'after',
    ])
  })

  it('ブロックを出た時点で偽なら、直後の同じ条件ブロックは入らない', () => {
    const raw = [cond('x', narr('1'), flagB('x', false)), cond('x', narr('again')), narr('end')]
    expect(tokens(expandEvents(raw, entryOf(bools({ x: true }))).events)).toEqual([
      '1',
      'F:x={"Bool":false}',
      'end',
    ])
  })

  it('ネスト: 内側の条件は内側入場時の flags（外側ブロック内の先行 Flag が効く）', () => {
    const raw = [cond('o', flagB('i', true), cond('i', narr('inner')), narr('o-tail')), narr('end')]
    expect(tokens(expandEvents(raw, entryOf(bools({ o: true }))).events)).toEqual([
      'F:i={"Bool":true}',
      'inner',
      'o-tail',
      'end',
    ])
    expect(tokens(expandEvents(raw, entryOf({})).events)).toEqual(['end'])
  })

  it('ネスト: 内側ブロックが外側のフラグを偽にしても、外側の残りは流れる', () => {
    const raw = [cond('o', cond('i', flagB('o', false), narr('i1')), narr('o2')), narr('end')]
    expect(tokens(expandEvents(raw, entryOf(bools({ o: true, i: true }))).events)).toEqual([
      'F:o={"Bool":false}',
      'i1',
      'o2',
      'end',
    ])
  })

  it('内側に [ジャンプ:]: 展開列に残り、その位置で予約される（以降は到達しない）', () => {
    const j = jump('next')
    const raw = [narr('a'), cond('x', narr('b'), j, narr('unreachable')), narr('c')]
    const { events } = expandEvents(raw, entryOf(bools({ x: true })))
    expect(events.indexOf(j)).toBe(2)
    expect(tokens(events).slice(0, 3)).toEqual(['a', 'b', JSON.stringify(j)])
  })

  it('閉じ忘れ（パーサが EOF まで取り込んだ形）: 末尾までを1つのブロックとして扱う', () => {
    const raw = [narr('a'), cond('x', narr('b'), flagB('x', false), narr('c'))]
    expect(tokens(expandEvents(raw, entryOf(bools({ x: true }))).events)).toEqual([
      'a',
      'b',
      'F:x={"Bool":false}',
      'c',
    ])
  })

  it('空ブロック・条件だけの元列', () => {
    expect(expandEvents([cond('x')], entryOf(bools({ x: true }))).events).toEqual([])
    expect(expandEvents([cond('x')], entryOf(bools({ x: true }))).rawOffsets).toEqual([0, 0])
    expect(expandEvents([], entryOf({}))).toEqual({ events: [], rawOffsets: [0] })
  })

  it('真偽規則: Bool 以外は存在すれば真、未設定は偽（GameState.checkFlag と同じ）', () => {
    const raw = [cond('s', narr('S')), cond('n', narr('N')), cond('z', narr('Z'))]
    const flags: Record<string, FlagValue> = { s: { String: '' }, n: { Number: 0 } }
    expect(tokens(expandEvents(raw, entryOf(flags)).events)).toEqual(['S', 'N'])
  })

  it('入力を変更しない（不変）', () => {
    const raw = [cond('x', narr('A'), flagB('x', false)), narr('B')]
    const snapshot = JSON.stringify(raw)
    const flags = bools({ x: true })
    const flagsSnapshot = JSON.stringify(flags)
    expandEvents(raw, entryOf(flags))
    expect(JSON.stringify(raw)).toBe(snapshot)
    expect(JSON.stringify(flags)).toBe(flagsSnapshot)
  })

  it('Condition 以外のイベントは同一参照のまま残る（Choice の連番などが参照に依存）', () => {
    const f = flagB('y', true)
    const t = narr('t')
    const raw = [cond('x', f, t)]
    const { events } = expandEvents(raw, entryOf(bools({ x: true })))
    expect(events[0]).toBe(f)
    expect(events[1]).toBe(t)
  })
})

function gsOf(flags: Record<string, FlagValue>): GameState {
  const g = new GameState()
  g.fromJSON(flags)
  return g
}

// --- rawOffsets / fromRawIndex ---

describe('expandEvents rawOffsets / fromRawIndex (#799)', () => {
  it('rawOffsets: 元列のトップレベル i 番目の展開後の開始位置（長さ raw.length + 1）', () => {
    const raw = [narr('a'), cond('x', narr('b'), narr('c')), narr('d')]
    expect(expandEvents(raw, entryOf(bools({ x: true }))).rawOffsets).toEqual([0, 1, 3, 4])
    expect(expandEvents(raw, entryOf(bools({ x: false }))).rawOffsets).toEqual([0, 1, 1, 2])
  })

  it('fromRawIndex より前は入場時 flags で静的に展開し（Flag は効かない）、以降を逐次評価する', () => {
    // 0: Flag x=true / 1: [条件 x] P / 2: ST / 3: [条件 x] Q
    const raw: Event[] = [
      flagB('x', true),
      cond('x', narr('P')),
      'SceneTransition',
      cond('x', narr('Q')),
    ]
    // 先頭から逐次: Flag が効いて P も Q も出る
    expect(tokens(expandEvents(raw, entryOf({}, 0)).events)).toEqual([
      'F:x={"Bool":true}',
      'P',
      '"SceneTransition"',
      'Q',
    ])
    // 3 から: 0..2 は x 未設定の flags で静的展開（P は出ない）、3 以降は x 未設定のまま（Flag は走査されない）
    const from3 = expandEvents(raw, entryOf({}, 3))
    expect(tokens(from3.events)).toEqual(['F:x={"Bool":true}', '"SceneTransition"'])
    expect(from3.rawOffsets[3]).toBe(2)
  })

  it('fromRawIndex = raw.length は resolveEvents と同じ（Flag を無視して全体を入場時 flags で静的に展開）', () => {
    const raw = [cond('x', narr('A'), flagB('x', false), narr('B')), narr('C')]
    const flags = bools({ x: true })
    expect(expandEvents(raw, entryOf(flags, raw.length)).events).toEqual(
      resolveEvents(raw, gsOf(flags))
    )
  })

  it('entryFromState: entryFlags が無ければ保存位置に達するまでを静的、位置から後ろを逐次評価にする（古いセーブ）', () => {
    // 0: t0 / 1: Flag / 2: [条件 c] X / 3: t3。flags 空の静的展開は [t0, Flag, t3]
    const raw: Event[] = [narr('t0'), flagB('c', true), cond('c', narr('X')), narr('t3')]
    const at = (eventIndex: number): NovelGameState =>
      ({ flags: {}, eventIndex }) as unknown as NovelGameState
    expect(entryFromState(at(0), raw)).toEqual({ flags: {}, resumeIndex: 0, fromRawIndex: 0 })
    expect(entryFromState(at(1), raw)).toEqual({ flags: {}, resumeIndex: 1, fromRawIndex: 0 })
    expect(entryFromState(at(2), raw)).toEqual({ flags: {}, resumeIndex: 2, fromRawIndex: 0 })
    // 終端・範囲外・負は全体を静的展開
    expect(entryFromState(at(3), raw)).toEqual({ flags: {}, fromRawIndex: 4 })
    expect(entryFromState(at(9), raw)).toEqual({ flags: {}, fromRawIndex: 4 })
    expect(entryFromState(at(-1), raw)).toEqual({ flags: {}, fromRawIndex: 4 })
    // 再開位置 1（Flag の直前）以降は逐次: c=true が [条件 c] に効く
    expect(expandEvents(raw, entryFromState(at(1), raw)).events).toEqual([
      narr('t0'),
      flagB('c', true),
      narr('X'),
      narr('t3'),
    ])
    // 再開位置 2（Flag の後）: Flag は適用されないので [条件 c] は偽のまま
    expect(expandEvents(raw, entryFromState(at(2), raw)).events).toEqual([
      narr('t0'),
      flagB('c', true),
      narr('t3'),
    ])
    const modern = {
      flags: bools({ x: false }),
      entryFlags: bools({ x: true }),
      entryRawIndex: 4,
    } as unknown as NovelGameState
    expect(entryFromState(modern, raw)).toEqual({ flags: bools({ x: true }), fromRawIndex: 4 })
    const resumed = { ...modern, entryResumeIndex: 2 } as unknown as NovelGameState
    expect(entryFromState(resumed, raw)).toEqual({
      flags: bools({ x: true }),
      resumeIndex: 2,
      fromRawIndex: 4,
    })
  })

  it('hasCondition', () => {
    expect(hasCondition([narr('a'), flagB('x', true)])).toBe(false)
    expect(hasCondition([narr('a'), cond('x')])).toBe(true)
    expect(hasCondition([])).toBe(false)
  })
})

// --- 参照インタプリタとのプロパティテスト ---

describe('expandEvents プロパティテスト (#799)', () => {
  it('固定シードのランダムな木 × ランダムな入場時 flags で、参照インタプリタの出力と全イベント・rawOffsets が一致する', () => {
    const rand = rng(799)
    let withCond = 0
    let diffFromStatic = 0
    for (let n = 0; n < 600; n++) {
      const raw = randomTree(rand, { flags: true })
      const E = randomFlags(rand)
      const got = expandEvents(raw, entryOf(E))
      const ref = runReference(raw, E)
      expect(tokens(got.events), `case ${n}`).toEqual(tokens(ref.out))
      expect(got.rawOffsets, `case ${n} offsets`).toEqual(ref.offsets)
      expect(got.rawOffsets.length).toBe(raw.length + 1)
      expect(got.rawOffsets[got.rawOffsets.length - 1]).toBe(got.events.length)
      for (let i = 1; i < got.rawOffsets.length; i++) {
        expect(got.rawOffsets[i]).toBeGreaterThanOrEqual(got.rawOffsets[i - 1])
      }
      if (hasCondition(raw)) withCond++
      if (JSON.stringify(got.events) !== JSON.stringify(resolveEvents(raw, gsOf(E))))
        diffFromStatic++
    }
    // 空虚でないこと: 条件を含む入力が大半で、静的展開と結果が分かれる入力も十分ある
    expect(withCond).toBeGreaterThan(300)
    expect(diffFromStatic).toBeGreaterThan(30)
  })

  it('[フラグ:] を含まない入力では、旧実装 resolveEvents（静的展開）と完全に一致する（旧挙動不変）', () => {
    const rand = rng(1799)
    let compared = 0
    for (let n = 0; n < 600; n++) {
      const raw = randomTree(rand, { flags: false })
      const E = randomFlags(rand)
      const got = expandEvents(raw, entryOf(E))
      const old = resolveEvents(raw, gsOf(E))
      expect(got.events, `case ${n}`).toEqual(old)
      // 参照同一性も旧実装と同じ（Condition 以外は元の参照のまま）
      got.events.forEach((e, i) => expect(e).toBe(old[i]))
      compared++
    }
    expect(compared).toBe(600)
  })

  it('[条件:] を含まない入力は元列そのもの（flags に依存しない）', () => {
    const rand = rng(2799)
    for (let n = 0; n < 200; n++) {
      const raw = randomTree(rand, { flags: true }).filter(
        (e) => !(typeof e === 'object' && e !== null && 'Condition' in e)
      )
      for (const E of [{}, bools({ a: true, b: true, c: true })]) {
        const { events, rawOffsets } = expandEvents(raw, entryOf(E))
        expect(events).toEqual(raw)
        expect(rawOffsets).toEqual(raw.map((_, i) => i).concat(raw.length))
      }
    }
  })

  it('決定論: 同じ入力は何度呼んでも同じ列（乱数・時刻・呼び出し順に依存しない）', () => {
    const rand = rng(3799)
    for (let n = 0; n < 100; n++) {
      const raw = randomTree(rand, { flags: true })
      const E = randomFlags(rand)
      const first = JSON.stringify(expandEvents(raw, entryOf(E)))
      // 別の入力を挟んでも、同じ入力は同じ結果（モジュール状態を持たない）
      expandEvents(randomTree(rand, { flags: true }), entryOf(randomFlags(rand)))
      expect(JSON.stringify(expandEvents(raw, entryOf(E)))).toBe(first)
    }
  })

  it('fromRawIndex k: 先頭 k 個は静的展開、以降は「E から始めた」参照インタプリタと一致する', () => {
    const rand = rng(4799)
    let nonTrivial = 0
    for (let n = 0; n < 400; n++) {
      const raw = randomTree(rand, { flags: true })
      if (raw.length === 0) continue
      const E = randomFlags(rand)
      const k = Math.floor(rand() * (raw.length + 1))
      const got = expandEvents(raw, entryOf(E, k))
      const head = resolveEvents(raw.slice(0, k), gsOf(E))
      const tail = runReference(raw.slice(k), E).out
      expect(tokens(got.events), `case ${n}`).toEqual(tokens([...head, ...tail]))
      expect(got.rawOffsets[k]).toBe(head.length)
      if (k > 0 && k < raw.length) nonTrivial++
    }
    expect(nonTrivial).toBeGreaterThan(100)
  })

  it('fromRawIndex = raw.length はどの入力でも resolveEvents と一致する', () => {
    const rand = rng(5799)
    for (let n = 0; n < 300; n++) {
      const raw = randomTree(rand, { flags: true })
      const E = randomFlags(rand)
      expect(expandEvents(raw, entryOf(E, raw.length)).events).toEqual(resolveEvents(raw, gsOf(E)))
    }
  })
})
