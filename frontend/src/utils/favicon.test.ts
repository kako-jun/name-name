// kako-jun/name-name#552: setFavicon の単体テスト。
//
// 検証ポイント:
//   - url 指定時に <link rel="icon"> を新規作成し、その要素を返す
//   - 既存タグがあれば再利用して href だけ更新する（複製しない）
//   - url が null のとき既存タグを削除し、null を返す
//   - url が null かつ既存タグが無いときも例外を投げない

import { afterEach, describe, expect, it } from 'vitest'
import { setFavicon } from './favicon'

function getFaviconLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'))
}

describe('setFavicon', () => {
  afterEach(() => {
    getFaviconLinks().forEach((link) => link.remove())
  })

  it('url 指定時に <link rel="icon"> を新規作成し、その要素を返す', () => {
    const link = setFavicon('https://example.com/favicon.png')

    const links = getFaviconLinks()
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://example.com/favicon.png')
    expect(link).toBe(links[0])
  })

  it('既存の <link rel="icon"> があれば再利用して href だけ更新する（複製しない）', () => {
    const first = setFavicon('https://example.com/a.png')
    const second = setFavicon('https://example.com/b.png')

    const links = getFaviconLinks()
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://example.com/b.png')
    expect(second).toBe(first)
  })

  it('url が null のとき既存の <link rel="icon"> を削除し、null を返す', () => {
    setFavicon('https://example.com/a.png')
    const result = setFavicon(null)

    expect(result).toBeNull()
    expect(getFaviconLinks()).toHaveLength(0)
  })

  it('url が null かつ既存タグが無いときも例外を投げず null を返す', () => {
    let result: HTMLLinkElement | null = null
    expect(() => {
      result = setFavicon(null)
    }).not.toThrow()
    expect(result).toBeNull()
    expect(getFaviconLinks()).toHaveLength(0)
  })
})
