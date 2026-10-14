/**
 * GameState のユニットテスト。
 *
 * #370: toJSON() はフラグを Map から Record へ変換する（セーブ用シリアライズ）。フラグ名が
 * 脚本データ由来の自由文字列で、たまたま "__proto__" と一致すると、素朴な `obj[key] = value`
 * は obj 自身の [[Prototype]] を書き換えてしまう（prototype pollution。読み取り側の同種問題は
 * #368 参照）。ここでは回帰の最小確認として toJSON() のみを対象にする。
 */
import { describe, it, expect } from 'vitest'
import { GameState, countSurvivingBefore } from './GameState'
import type { Event, FlagValue } from '../types'

describe('GameState.toJSON', () => {
  it('通常のフラグを Record として書き出す', () => {
    const gs = new GameState()
    gs.setFlag('saw_intro', { Bool: true })
    gs.setFlag('gold', { Number: 10 })
    expect(gs.toJSON()).toEqual({
      saw_intro: { Bool: true },
      gold: { Number: 10 },
    })
  })

  // #370: フラグ名が "__proto__" でも obj 自身の [[Prototype]] を汚染せず own-property として
  // 登録される。FlagValue はオブジェクト値のため、対策前は obj の [[Prototype]] が実際に
  // 書き換わってしまう（scalar 値と異なり no-op にならない）。
  it('フラグ名が "__proto__" でも [[Prototype]] を汚染せず own-property として登録される', () => {
    const gs = new GameState()
    gs.setFlag('__proto__', { Bool: true })
    gs.setFlag('ok', { Bool: true })

    const obj = gs.toJSON()

    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(obj, '__proto__')).toBe(true)
    expect(obj['__proto__']).toEqual({ Bool: true })
    // 隣接する正常キーも巻き込まれない
    expect(obj.ok).toEqual({ Bool: true })
  })

  it('fromJSON → toJSON のラウンドトリップで元の Record と一致する', () => {
    const gs = new GameState()
    const data: Record<string, FlagValue> = {
      saw_intro: { Bool: true },
      name: { String: 'ゆうしゃ' },
    }
    gs.fromJSON(data)
    expect(gs.toJSON()).toEqual(data)
  })

  // #370: "__proto__" フラグを含むセーブデータを fromJSON で読み込み、toJSON で書き出す
  // ラウンドトリップが安全に一致することを確認する（fromJSON は Map.set のため key 名に
  // 依存する脆弱性は無いが、書き出し側 toJSON の safeAssign 経路を通した回帰として固定する）。
  // computed key で own property として "__proto__" を持つ入力を作る点に注意
  // （object literal の `{ __proto__: x }` は proto 設定として特別扱いされ own property にならない）。
  it('"__proto__" フラグを含む状態で fromJSON → toJSON のラウンドトリップが一致する', () => {
    const gs = new GameState()
    const data: Record<string, FlagValue> = {
      saw_intro: { Bool: true },
      ['__proto__']: { String: 'ゆうしゃ' },
    }
    gs.fromJSON(data)
    const result = gs.toJSON()
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true)
    expect(result['__proto__']).toEqual({ String: 'ゆうしゃ' })
    expect(result.saw_intro).toEqual({ Bool: true })
    expect(result).toEqual(data)
  })
})

describe('countSurvivingBefore (#777)', () => {
  const text = (t: string): Event => ({ Narration: { text: [t] } })
  const cond = (flag: string, ...events: Event[]): Event => ({ Condition: { flag, events } })
  const flagEv: Event = { Flag: { name: 'x', value: { Bool: false } } }
  const withFlags = (flags: Record<string, boolean>): GameState => {
    const gs = new GameState()
    for (const [k, v] of Object.entries(flags)) gs.setFlag(k, { Bool: v })
    return gs
  }

  it('Flag が条件の外: 手前の残るイベントの数', () => {
    expect(
      countSurvivingBefore(
        [text('a'), cond('x', text('b')), flagEv, text('c')],
        flagEv,
        withFlags({ x: true })
      )
    ).toBe(2)
    expect(
      countSurvivingBefore(
        [text('a'), cond('x', text('b')), flagEv, text('c')],
        flagEv,
        withFlags({ x: false })
      )
    ).toBe(1)
  })

  it('Flag が先頭・末尾', () => {
    expect(countSurvivingBefore([flagEv, text('a')], flagEv, withFlags({}))).toBe(0)
    expect(countSurvivingBefore([text('a'), text('b'), flagEv], flagEv, withFlags({}))).toBe(2)
  })

  it('入れ子（外側偽・内側真）: Flag 自身は消え、数は次に残るイベントの位置になる', () => {
    const events = [
      text('a'),
      cond('o', text('b'), cond('i', text('c'), flagEv, text('d'))),
      text('e'),
    ]
    // 外側偽: b, c は消える。数は a の 1 つ（次に残る e の位置 = 1）
    expect(countSurvivingBefore(events, flagEv, withFlags({ o: false, i: true }))).toBe(1)
    // 外側真・内側真: a, b, c が残る
    expect(countSurvivingBefore(events, flagEv, withFlags({ o: true, i: true }))).toBe(3)
    // 外側真・内側偽: a, b が残り、Flag は消える
    expect(countSurvivingBefore(events, flagEv, withFlags({ o: true, i: false }))).toBe(2)
  })

  it('見つからなければ null', () => {
    expect(countSurvivingBefore([text('a')], flagEv, withFlags({}))).toBeNull()
  })
})
