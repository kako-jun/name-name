/**
 * own-property セーフルックアップの共通ヘルパー hasOwn() のユニットテスト (#368)。
 *
 * `obj[key]` の素朴なブラケットアクセスは Object.prototype も辿ってしまうため、脚本側の
 * 自由記述の key が `constructor` 等の Object.prototype メンバー名と衝突すると誤動作する
 * （#364 セルフレビューで発見・修正した prototype pollution 相当の不具合と同種）。
 * hasOwn() はその境界だけを正しく判定できることを確認する。
 */
import { describe, it, expect } from 'vitest'
import { hasOwn, safeAssign, safeAssignAll } from './ownProperty'

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

/**
 * own-property セーフ代入の共通ヘルパー safeAssign() / safeAssignAll() のユニットテスト (#370)。
 *
 * `obj[key] = value` の素朴な代入は key が "__proto__" だと obj 自身の [[Prototype]] を
 * 書き換えてしまう（value がオブジェクト/nullの場合。scalar 値では no-op になり値が消える）。
 * safeAssign は Object.defineProperty で常に own data property を作るため、どちらの場合も
 * 正しく own-property として登録される。
 */
describe('safeAssign', () => {
  it('通常キーは通常の代入と同じ結果になる', () => {
    const obj: Record<string, number> = {}
    safeAssign(obj, 'a', 1)
    expect(obj).toEqual({ a: 1 })
    expect(obj.a).toBe(1)
  })

  it('key が "__proto__" でも obj の own-property として登録され、[[Prototype]] は汚染されない', () => {
    const obj: Record<string, number> = {}
    safeAssign(obj, '__proto__', 42)
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(obj, '__proto__')).toBe(true)
    expect(obj['__proto__']).toBe(42)
  })

  it('value がオブジェクトでも [[Prototype]] は汚染されない（素朴な代入なら汚染される値）', () => {
    const obj: Record<string, { evil: boolean }> = {}
    const evilValue = { evil: true }
    safeAssign(obj, '__proto__', evilValue)
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype)
    expect(obj['__proto__']).toBe(evilValue)
  })

  it('既存の own property を同じ key で上書きできる（通常の再代入と同じ挙動）', () => {
    const obj: Record<string, number> = { a: 1 }
    safeAssign(obj, 'a', 2)
    expect(obj.a).toBe(2)
  })

  it('隣接する正常キーは巻き込まれない', () => {
    const obj: Record<string, number> = {}
    safeAssign(obj, '__proto__', 1)
    safeAssign(obj, 'normal', 2)
    expect(obj['__proto__']).toBe(1)
    expect(obj.normal).toBe(2)
    expect(Object.keys(obj).sort()).toEqual(['__proto__', 'normal'])
  })

  // #370: value が undefined でも（存在しない扱いにせず）own-property として登録される。
  // Record<string, T> は値の有無を `key in obj` / hasOwnProperty で判定する呼び出し側がいるため、
  // 「登録されているが値が undefined」と「そもそも未登録」を区別できる必要がある。
  it('value が undefined でも own-property として登録される', () => {
    const obj: Record<string, number | undefined> = {}
    safeAssign<number | undefined>(obj, 'a', undefined)
    expect(Object.prototype.hasOwnProperty.call(obj, 'a')).toBe(true)
    expect(obj.a).toBeUndefined()
  })

  // #370: 素朴な `obj.__proto__ = null` は（オブジェクト値と同様）obj の [[Prototype]] を
  // null に書き換えてしまう（value が非オブジェクト/非nullのときだけ no-op になる scalar 値とは
  // 異なる危険なケース）。safeAssign なら null も通常の値として own-property に格納される。
  it('key が "__proto__" で value が null でも [[Prototype]] を汚染しない（素朴な代入なら汚染される値）', () => {
    const obj: Record<string, null> = {}
    safeAssign(obj, '__proto__', null)
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(obj, '__proto__')).toBe(true)
    expect(obj['__proto__']).toBeNull()
  })

  // #370: safeAssign は常に Object.defineProperty で descriptor を作り直すため、既存の
  // enumerable:false/writable:false なプロパティに safeAssign すると descriptor が
  // {enumerable:true, writable:true, configurable:true} へ正規化される（通常の代入と同じ気軽さで
  // 上書きできることを保証する）。
  it('既存の enumerable:false/writable:false なプロパティを safeAssign すると descriptor が正規化される', () => {
    const obj: Record<string, number> = {}
    Object.defineProperty(obj, 'a', {
      value: 1,
      enumerable: false,
      writable: false,
      configurable: true,
    })
    safeAssign(obj, 'a', 2)
    expect(Object.getOwnPropertyDescriptor(obj, 'a')).toEqual({
      value: 2,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  })
})

describe('safeAssignAll', () => {
  it('source の own property を全て target へコピーする（通常キー）', () => {
    const target: Record<string, number> = { a: 1 }
    const source: Record<string, number> = { b: 2, c: 3 }
    safeAssignAll(target, source)
    expect(target).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('source が "__proto__" を own-property として持っていても target の [[Prototype]] を汚染しない', () => {
    const target: Record<string, number> = {}
    const source: Record<string, number> = {}
    safeAssign(source, '__proto__', 7) // 事前に safeAssign で own property 化しておく
    safeAssignAll(target, source)
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(true)
    expect(target['__proto__']).toBe(7)
  })

  it('target 側の既存キーは source に無ければ残る（Object.assign と同じマージ挙動）', () => {
    const target: Record<string, number> = { keep: 1 }
    const source: Record<string, number> = { added: 2 }
    safeAssignAll(target, source)
    expect(target).toEqual({ keep: 1, added: 2 })
  })

  it('source が空オブジェクトなら target は変化しない', () => {
    const target: Record<string, number> = { a: 1, b: 2 }
    safeAssignAll(target, {})
    expect(target).toEqual({ a: 1, b: 2 })
  })

  it('target と source でキーが重複する場合 source の値で上書きされる', () => {
    const target: Record<string, number> = { a: 1, b: 2 }
    const source: Record<string, number> = { a: 99 }
    safeAssignAll(target, source)
    expect(target).toEqual({ a: 99, b: 2 })
  })

  // #370: safeAssignAll は `Object.keys(source)` で列挙する（Object.assign と同じ「enumerable own
  // property だけコピーする」契約）。非enumerable な own property は意図的にコピー対象外。
  it('source の非enumerable own property はコピーされない（Object.assign と同じ契約）', () => {
    const target: Record<string, number> = {}
    const source: Record<string, number> = {}
    Object.defineProperty(source, 'hidden', {
      value: 42,
      enumerable: false,
      writable: true,
      configurable: true,
    })
    safeAssignAll(target, source)
    expect(Object.prototype.hasOwnProperty.call(target, 'hidden')).toBe(false)
  })
})
