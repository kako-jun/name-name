/**
 * GameState のユニットテスト。
 *
 * #370: toJSON() はフラグを Map から Record へ変換する（セーブ用シリアライズ）。フラグ名が
 * 脚本データ由来の自由文字列で、たまたま "__proto__" と一致すると、素朴な `obj[key] = value`
 * は obj 自身の [[Prototype]] を書き換えてしまう（prototype pollution。読み取り側の同種問題は
 * #368 参照）。ここでは回帰の最小確認として toJSON() のみを対象にする。
 */
import { describe, it, expect } from 'vitest'
import { GameState } from './GameState'
import type { FlagValue } from '../types'

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
})
