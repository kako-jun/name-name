import { describe, expect, it } from 'vitest'
import { createFlagStore } from './flagStore'

describe('createFlagStore (#862: フラグ名に " 等を含んでも例外にならない)', () => {
  it('宣言済みなら値とチェックボックスを更新する', () => {
    const s = createFlagStore({ a: false })
    const box = { checked: false }
    s.register('a', box)
    expect(s.set('a', true)).toBe(true)
    expect(s.flags.a).toBe(true)
    expect(box.checked).toBe(true)
  })

  it('未宣言は false を返し、何も変えない', () => {
    const s = createFlagStore({ a: false })
    expect(s.set('b', true)).toBe(false)
    expect(s.flags).toEqual({ a: false })
    expect(s.set('toString', true)).toBe(false) // 継承されたプロパティ名も未宣言
    expect(s.set('__proto__', true)).toBe(false)
  })

  it.each(['a"b', 'x]y', "it's", 'a\\b', 'a b', '日本語"'])(
    '名前 %s でも例外にならない',
    (name) => {
      const s = createFlagStore({ [name]: false })
      const box = { checked: false }
      s.register(name, box)
      expect(() => s.set(name, true)).not.toThrow()
      expect(s.flags[name]).toBe(true)
      expect(box.checked).toBe(true)
    }
  )

  it('初期値は渡したオブジェクトを書き換えない', () => {
    const init = { a: false }
    const s = createFlagStore(init)
    s.set('a', true)
    expect(init.a).toBe(false)
  })
})
