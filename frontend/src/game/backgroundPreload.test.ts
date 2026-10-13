/**
 * backgroundPreload (#782): 先読みの 404 が unhandled rejection（pageerror）にならず、
 * 以降の先読みも止まらないことを固定する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import {
  backgroundPreload,
  clearBackgroundPreload,
  clearBackgroundPreloadQueue,
} from './backgroundPreload'

// @types/node 非導入のため、使う面だけ宣言する（Node 実行時の unhandledRejection 検知用）
declare const process: {
  on(event: 'unhandledRejection', fn: (reason: unknown) => void): void
  off(event: 'unhandledRejection', fn: (reason: unknown) => void): void
}

describe('backgroundPreload (#782)', () => {
  afterEach(() => {
    clearBackgroundPreload()
    vi.restoreAllMocks()
  })

  it('途中の URL が reject しても unhandled rejection を出さず、残りを末尾(nearest)から順に読み切る', async () => {
    const seen: unknown[] = []
    const onUnhandled = (r: unknown): void => {
      seen.push(r)
    }
    process.on('unhandledRejection', onUnhandled)
    const loaded: string[] = []
    vi.spyOn(Assets, 'load').mockImplementation((async (url: string) => {
      loaded.push(url)
      if (url.endsWith('.webp')) throw new Error(`[Loader.load] Failed to load ${url}. 404`)
      return Texture.WHITE
    }) as never)
    try {
      backgroundPreload(['far.png', 'mid.webp', 'near.png'])
      await vi.waitFor(() => expect(loaded).toHaveLength(3))
      await Promise.resolve()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(seen).toEqual([])
    // LIFO: 末尾 near が先。404 の mid.webp の後も far.png まで止まらず進む
    expect(loaded).toEqual(['near.png', 'mid.webp', 'far.png'])
  })

  it('全件 reject でも unhandled rejection なし・後続呼び出しの先読みは動き続ける', async () => {
    const seen: unknown[] = []
    const onUnhandled = (r: unknown): void => {
      seen.push(r)
    }
    process.on('unhandledRejection', onUnhandled)
    const loaded: string[] = []
    const spy = vi.spyOn(Assets, 'load').mockImplementation((async (url: string) => {
      loaded.push(url)
      throw new Error('404')
    }) as never)
    try {
      backgroundPreload(['a.png', 'b.png'])
      await vi.waitFor(() => expect(loaded).toHaveLength(2))
      await Promise.resolve()
      spy.mockImplementation((async (url: string) => {
        loaded.push(url)
        return Texture.WHITE
      }) as never)
      backgroundPreload(['c.png'])
      await vi.waitFor(() => expect(loaded).toHaveLength(3))
      await Promise.resolve()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(seen).toEqual([])
    expect(loaded).toEqual(['b.png', 'a.png', 'c.png'])
  })

  it('clear 後は積み残しが load されない（取得中の1件は完走）', async () => {
    const loaded: string[] = []
    let release: () => void = () => {}
    vi.spyOn(Assets, 'load').mockImplementation((async (url: string) => {
      loaded.push(url)
      if (url === 'near.png') await new Promise<void>((r) => (release = r))
      return Texture.WHITE
    }) as never)
    backgroundPreload(['far.png', 'mid.png', 'near.png'])
    await vi.waitFor(() => expect(loaded).toEqual(['near.png']))
    clearBackgroundPreload()
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(loaded).toEqual(['near.png'])
  })

  it('先読みで失敗した URL は再先読みしない・clear 後は再び試す', async () => {
    const loaded: string[] = []
    vi.spyOn(Assets, 'load').mockImplementation((async (url: string) => {
      loaded.push(url)
      throw new Error('404')
    }) as never)
    backgroundPreload(['think.png'])
    await vi.waitFor(() => expect(loaded).toEqual(['think.png']))
    await Promise.resolve()
    backgroundPreload(['think.png'])
    await new Promise((r) => setTimeout(r, 0))
    expect(loaded).toEqual(['think.png'])
    clearBackgroundPreload()
    backgroundPreload(['think.png'])
    await vi.waitFor(() => expect(loaded).toEqual(['think.png', 'think.png']))
  })

  it('キューだけの clear では失敗済み URL を再先読みしない', async () => {
    const loaded: string[] = []
    vi.spyOn(Assets, 'load').mockImplementation((async (url: string) => {
      loaded.push(url)
      throw new Error('404')
    }) as never)
    backgroundPreload(['think.png'])
    await vi.waitFor(() => expect(loaded).toEqual(['think.png']))
    await Promise.resolve()
    clearBackgroundPreloadQueue()
    backgroundPreload(['think.png'])
    await new Promise((r) => setTimeout(r, 0))
    expect(loaded).toEqual(['think.png'])
  })
})
