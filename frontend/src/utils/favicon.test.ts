// kako-jun/name-name#552: setFavicon の単体テスト。
//
// 検証ポイント:
//   - url 指定時に <link rel="icon"> を新規作成する
//   - 既存タグがあれば再利用して href だけ更新する（複製しない）
//   - url が null のとき既存タグを削除する
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

  it('url 指定時に <link rel="icon"> を新規作成する', () => {
    setFavicon('https://example.com/favicon.png')

    const links = getFaviconLinks()
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://example.com/favicon.png')
  })

  it('既存の <link rel="icon"> があれば再利用して href だけ更新する（複製しない）', () => {
    setFavicon('https://example.com/a.png')
    setFavicon('https://example.com/b.png')

    const links = getFaviconLinks()
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://example.com/b.png')
  })

  it('url が null のとき既存の <link rel="icon"> を削除する', () => {
    setFavicon('https://example.com/a.png')
    setFavicon(null)

    expect(getFaviconLinks()).toHaveLength(0)
  })

  it('url が null かつ既存タグが無いときも例外を投げない', () => {
    expect(() => setFavicon(null)).not.toThrow()
    expect(getFaviconLinks()).toHaveLength(0)
  })
})
