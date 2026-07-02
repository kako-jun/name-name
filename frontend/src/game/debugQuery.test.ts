/**
 * parseDebugQuery(search) のテスト (#220 Phase 3)。
 *
 * URL の query string を playScript() / startFrom() の引数へ変換する純粋パーサの検証。
 * 副作用なし・DOM 非依存なので、`new URLSearchParams` を内部で使う関数に文字列を渡し、
 * 戻り値（{ script } / { scene } / null）を直接突き合わせる最小構成で行う。
 *
 * 観点ごとに 1 テスト。正常系だけでなく flag 型変換の境界・script トークンの堅牢性
 * （不正トークンのスキップ）・index の NaN・null/空文字も網羅する。
 */
import { describe, it, expect } from 'vitest'
import { parseDebugQuery } from './debugQuery'
import type { FlagValue } from '../types'

// flag 期待値ヘルパ（startFrom.test.ts と同じスタイル）
const boolFlag = (b: boolean): FlagValue => ({ Bool: b })

describe('parseDebugQuery (#220)', () => {
  // ===== A. 正常系 =====

  it('1: debug_script=advance,advance,choice:1-1 → script 3 Step', () => {
    const r = parseDebugQuery('?debug_script=advance,advance,choice:1-1')
    expect(r).toEqual({
      script: [{ type: 'advance' }, { type: 'advance' }, { type: 'choice', jump: '1-1' }],
    })
  })

  it('2: debug_scene=1-2 のみ → { scene: { sceneId: "1-2" } }', () => {
    const r = parseDebugQuery('?debug_scene=1-2')
    expect(r).toEqual({ scene: { sceneId: '1-2' } })
  })

  it('3: debug_scene + debug_flags → flags に Bool が入る', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=saw_characters:true')
    expect(r).toEqual({
      scene: { sceneId: '1-2', flags: { saw_characters: boolFlag(true) } },
    })
  })

  it('4: debug_script=wait:500 → { type: "wait", ms: 500 }', () => {
    const r = parseDebugQuery('?debug_script=wait:500')
    expect(r).toEqual({ script: [{ type: 'wait', ms: 500 }] })
  })

  // ===== B. 優先順位 =====

  it('5: script と scene 両方指定 → script が優先される', () => {
    const r = parseDebugQuery('?debug_script=advance&debug_scene=1-2')
    expect(r).toEqual({ script: [{ type: 'advance' }] })
  })

  // ===== C. flags 型変換（境界・同値） =====

  it('6: flag "true" → Bool(true)', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=k:true')
    expect((r as { scene: { flags: Record<string, FlagValue> } }).scene.flags).toEqual({
      k: { Bool: true },
    })
  })

  it('7: flag "false" → Bool(false)', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=k:false')
    expect((r as { scene: { flags: Record<string, FlagValue> } }).scene.flags).toEqual({
      k: { Bool: false },
    })
  })

  it('8: flag "42" → Number(42)', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=k:42')
    expect((r as { scene: { flags: Record<string, FlagValue> } }).scene.flags).toEqual({
      k: { Number: 42 },
    })
  })

  it('9: flag "-1.5" → Number(-1.5)', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=k:-1.5')
    expect((r as { scene: { flags: Record<string, FlagValue> } }).scene.flags).toEqual({
      k: { Number: -1.5 },
    })
  })

  it('10: flag "hello" → String', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=k:hello')
    expect((r as { scene: { flags: Record<string, FlagValue> } }).scene.flags).toEqual({
      k: { String: 'hello' },
    })
  })

  it('11: flag の値が空文字 → String("")（Number(0) にしない）', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=k:')
    expect((r as { scene: { flags: Record<string, FlagValue> } }).scene.flags).toEqual({
      k: { String: '' },
    })
  })

  it('12: 複数 flag a:true,b:5,c:x がそれぞれ正しい型に変換される', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=a:true,b:5,c:x')
    expect((r as { scene: { flags: Record<string, FlagValue> } }).scene.flags).toEqual({
      a: { Bool: true },
      b: { Number: 5 },
      c: { String: 'x' },
    })
  })

  // ===== D. script 堅牢性（異常系・不正トークンのスキップ） =====

  it('13: 不正 script トークン（空 / choice: / wait:abc / 未知）をスキップする', () => {
    // 空トークン, jump 空の choice:, NaN な wait:abc, 引数無しの未知トークン foo を挟む
    const r = parseDebugQuery('?debug_script=advance,,choice:,wait:abc,foo,advance')
    expect(r).toEqual({ script: [{ type: 'advance' }, { type: 'advance' }] })
  })

  it('14: flag の key 無し（:val）はスキップされる', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=:val,ok:true')
    expect((r as { scene: { flags: Record<string, FlagValue> } }).scene.flags).toEqual({
      ok: { Bool: true },
    })
  })

  it('15: flag の val 無し（区切り無しの key だけ）はスキップされる', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=key,ok:true')
    expect((r as { scene: { flags: Record<string, FlagValue> } }).scene.flags).toEqual({
      ok: { Bool: true },
    })
  })

  // ===== E. index =====

  it('16: debug_eventIndex / debug_textIndex が scene に反映される', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_eventIndex=3&debug_textIndex=2')
    expect(r).toEqual({ scene: { sceneId: '1-2', eventIndex: 3, textIndex: 2 } })
  })

  it('17: NaN な index はキーを付けない', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_eventIndex=abc&debug_textIndex=xyz')
    const scene = (r as unknown as { scene: Record<string, unknown> }).scene
    expect(scene).toEqual({ sceneId: '1-2' })
    expect('eventIndex' in scene).toBe(false)
    expect('textIndex' in scene).toBe(false)
  })

  // ===== F. null / 空 =====

  it('18: 該当パラメータ無し → null', () => {
    expect(parseDebugQuery('?other=1')).toBeNull()
    expect(parseDebugQuery('')).toBeNull()
  })

  it('19: debug_scene=（空文字）→ null（script も無いため）', () => {
    expect(parseDebugQuery('?debug_scene=')).toBeNull()
  })

  it('20: 先頭 ? の有無で結果は変わらない', () => {
    const withQ = parseDebugQuery('?debug_scene=1-2&debug_flags=k:true')
    const withoutQ = parseDebugQuery('debug_scene=1-2&debug_flags=k:true')
    expect(withoutQ).toEqual(withQ)
  })

  it('21: 空/全無効 debug_script は scene へフォールスルー（空 script が scene を握りつぶさない）', () => {
    // 空 script のみ → null
    expect(parseDebugQuery('?debug_script=')).toBeNull()
    // 空 script + 有効 scene → scene が返る（script が空配列で握りつぶさない）
    expect(parseDebugQuery('?debug_script=&debug_scene=1-2')).toEqual({ scene: { sceneId: '1-2' } })
    // 全トークン無効な script + 有効 scene → scene が返る
    expect(parseDebugQuery('?debug_script=foo,bar&debug_scene=1-2')).toEqual({
      scene: { sceneId: '1-2' },
    })
  })

  // #370: debug_flags の key が "__proto__" だと、素朴な `flags[key] = val` は
  // flags オブジェクト自身の [[Prototype]] を書き換えてしまう（prototype pollution）。
  // own-property として登録され、[[Prototype]] が汚染されないことを確認する。
  it('22: debug_flags の key が "__proto__" でも [[Prototype]] を汚染せず own-property として登録される', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=__proto__:true,ok:true')
    const flags = (r as { scene: { flags: Record<string, FlagValue> } }).scene.flags
    expect(Object.getPrototypeOf(flags)).toBe(Object.prototype)
    expect(flags['__proto__']).toEqual({ Bool: true })
    expect(flags.ok).toEqual({ Bool: true })
  })

  // #370: debug_flags の key は `pair.slice(0, sep).trim()` で trim される。URL エンコードされた
  // 前後空白付き key（`%20__proto__%20` → URLSearchParams のデコードで " __proto__ "）でも
  // trim 後は "__proto__" として同じ安全経路（safeAssign）で処理されることを確認する。
  it('23: debug_flags の key が前後空白付き "%20__proto__%20" でも trim 後は "__proto__" として安全に処理される', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=%20__proto__%20:true,ok:true')
    const flags = (r as { scene: { flags: Record<string, FlagValue> } }).scene.flags
    expect(Object.getPrototypeOf(flags)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(flags, '__proto__')).toBe(true)
    expect(flags['__proto__']).toEqual({ Bool: true })
    expect(flags.ok).toEqual({ Bool: true })
  })

  // #370: safeAssign 自体が通常キーと同じ「後勝ち」で上書きされる（ownProperty.test.ts の
  // 「既存の own property を同じ key で上書きできる」と同じ挙動）ことを、debug_flags の
  // "__proto__" キーが複数回登場するケースで固定する。
  it('24: debug_flags に "__proto__" キーが2回登場すると後勝ちで上書きされる', () => {
    const r = parseDebugQuery('?debug_scene=1-2&debug_flags=__proto__:1,__proto__:2')
    const flags = (r as { scene: { flags: Record<string, FlagValue> } }).scene.flags
    expect(Object.getPrototypeOf(flags)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(flags, '__proto__')).toBe(true)
    expect(flags['__proto__']).toEqual({ Number: 2 })
  })
})
