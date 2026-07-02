/**
 * own-property セーフルックアップの共通ヘルパー hasOwn() のユニットテスト (#368)。
 *
 * `obj[key]` の素朴なブラケットアクセスは Object.prototype も辿ってしまうため、脚本側の
 * 自由記述の key が `constructor` 等の Object.prototype メンバー名と衝突すると誤動作する
 * （#364 セルフレビューで発見・修正した prototype pollution 相当の不具合と同種）。
 * hasOwn() はその境界だけを正しく判定できることを確認する。
 */
import { describe, it, expect } from 'vitest'
import { hasOwn } from './ownProperty'

describe('hasOwn', () => {
  it.each([
    ['own property が値ありで存在', { a: 1 }, 'a', true],
    ['own property が値 undefined で存在', { a: undefined }, 'a', true],
    ['key が全く存在しない', {}, 'a', false],
    [
      'key が Object.prototype 由来（inherited、own でない）: constructor',
      {},
      'constructor',
      false,
    ],
    ['key が Object.prototype 由来（inherited、own でない）: toString', {}, 'toString', false],
    ['key が Object.prototype 由来（inherited、own でない）: __proto__', {}, '__proto__', false],
    ['空オブジェクト', {}, 'anything', false],
  ] as const)('%s', (_desc, obj, key, expected) => {
    expect(hasOwn(obj, key)).toBe(expected)
  })

  it('Object.create(null) で key が無ければ false（例外を投げない）', () => {
    const obj = Object.create(null) as object
    expect(() => hasOwn(obj, 'anything')).not.toThrow()
    expect(hasOwn(obj, 'anything')).toBe(false)
  })

  it('Object.create(null) で own property があれば true', () => {
    const obj = Object.create(null) as Record<string, number>
    obj.foo = 1
    expect(hasOwn(obj, 'foo')).toBe(true)
  })

  it('配列の index own property は true', () => {
    expect(hasOwn([1, 2, 3], '0')).toBe(true)
  })

  it('配列の length own property は true', () => {
    expect(hasOwn([1, 2, 3], 'length')).toBe(true)
  })

  it('配列の Array.prototype 由来メソッド名は false（inherited）', () => {
    expect(hasOwn([1, 2, 3], 'map')).toBe(false)
  })

  it('computed key で own の "constructor" を明示設定していれば true', () => {
    const obj = { ['constructor']: 'custom' }
    expect(hasOwn(obj, 'constructor')).toBe(true)
  })
})
