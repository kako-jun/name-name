// kako-jun/name-name#552: useFavicon の単体テスト。
//
// setFavicon 導入当初は fetch で事前に画像の存在確認をしてから href を
// 設定していたが、ブラウザが同じ画像を二重取得してしまうためセルフレビュー
// (PR #555) で `<link>` 要素の href を直接設定し onerror で存在確認する
// 方式に変更した（TitleOverlay.tsx の `<img onError>` と同じ単一フェッチ
// パターン）。以下はその実装に合わせたテスト。
//
// 検証ポイント:
//   - url が null のときは favicon を設定しない（既定のまま）
//   - url 指定時は fetch を挟まず即座に <link> の href を設定する
//   - <link> の onerror が発火すると favicon をデフォルトに戻す（404相当）
//   - url が変わると（プロジェクト切替）新しい url で href を更新し、
//     古い url の onerror が後から発火しても新しい href を上書きしない
//   - アンマウント時に favicon を既定に戻す

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useFavicon } from './useFavicon'

function getFaviconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]')
}

function getFaviconHref(): string | null {
  return getFaviconLink()?.getAttribute('href') ?? null
}

beforeEach(() => {
  document.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
})

afterEach(() => {
  vi.restoreAllMocks()
  document.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
})

describe('useFavicon', () => {
  it('url が null のとき favicon を設定しない（既定のまま）', () => {
    renderHook(() => useFavicon(null))

    expect(getFaviconHref()).toBeNull()
  })

  it('url 指定時に fetch を挟まず <link> の href を即座に設定する（二重フェッチしない）', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    renderHook(() => useFavicon('/images/favicon.png'))

    expect(getFaviconHref()).toBe('/images/favicon.png')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('<link> の error イベントが発火すると favicon をデフォルトに戻す（404相当）', () => {
    renderHook(() => useFavicon('/images/favicon.png'))
    const link = getFaviconLink()
    expect(link).not.toBeNull()

    link!.dispatchEvent(new Event('error'))

    expect(getFaviconHref()).toBeNull()
  })

  it('url が変わる（プロジェクト切替）と新しい url で href を更新する', () => {
    const { rerender } = renderHook(({ url }) => useFavicon(url), {
      initialProps: { url: '/images/a.png' as string | null },
    })
    expect(getFaviconHref()).toBe('/images/a.png')

    rerender({ url: '/images/b.png' })

    expect(getFaviconHref()).toBe('/images/b.png')
  })

  it('古い url の error イベントが切替後に発火しても新しい href を上書きしない', () => {
    const { rerender } = renderHook(({ url }) => useFavicon(url), {
      initialProps: { url: '/images/a.png' as string | null },
    })
    const oldLink = getFaviconLink()

    rerender({ url: '/images/b.png' })
    expect(getFaviconHref()).toBe('/images/b.png')

    // cleanup で onerror は外れているはずなので、古い要素で発火させても無視される
    oldLink?.dispatchEvent(new Event('error'))

    expect(getFaviconHref()).toBe('/images/b.png')
  })

  it('アンマウント時に favicon を既定に戻す', () => {
    const { unmount } = renderHook(() => useFavicon('/images/favicon.png'))
    expect(getFaviconHref()).toBe('/images/favicon.png')

    unmount()

    expect(getFaviconHref()).toBeNull()
  })
})
