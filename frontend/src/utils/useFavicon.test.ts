// kako-jun/name-name#552: useFavicon の単体テスト。
//
// 検証ポイント:
//   - url が null のときは favicon を設定しない（既定のまま）
//   - fetch が ok を返すと favicon を設定する
//   - fetch が 404 を返すと favicon を設定しない（デフォルトのまま）
//   - fetch がネットワークエラーで reject しても例外を投げない
//   - url が変わると（プロジェクト切替）新しい url で再判定する
//   - アンマウント時に favicon を既定に戻す

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useFavicon } from './useFavicon'

function getFaviconHref(): string | null {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  return link ? link.getAttribute('href') : null
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

  it('fetch が ok を返すと favicon を url で設定する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    renderHook(() => useFavicon('/images/favicon.png'))

    await waitFor(() => expect(getFaviconHref()).toBe('/images/favicon.png'))
  })

  it('fetch が 404 を返すと favicon を設定しない（デフォルトのまま）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
    } as Response)

    renderHook(() => useFavicon('/images/favicon.png'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/images/favicon.png'))
    expect(getFaviconHref()).toBeNull()
  })

  it('fetch がネットワークエラーで reject しても例外を投げず favicon は既定のまま', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))

    renderHook(() => useFavicon('/images/favicon.png'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(getFaviconHref()).toBeNull()
  })

  it('url が変わる（プロジェクト切替）と一旦リセットしてから新しい url を確認する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    const { rerender } = renderHook(({ url }) => useFavicon(url), {
      initialProps: { url: '/images/a.png' as string | null },
    })
    await waitFor(() => expect(getFaviconHref()).toBe('/images/a.png'))

    rerender({ url: '/images/b.png' })

    await waitFor(() => expect(getFaviconHref()).toBe('/images/b.png'))
  })

  it('アンマウント時に favicon を既定に戻す', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    const { unmount } = renderHook(() => useFavicon('/images/favicon.png'))
    await waitFor(() => expect(getFaviconHref()).toBe('/images/favicon.png'))

    unmount()

    expect(getFaviconHref()).toBeNull()
  })
})
