/**
 * backgroundPreload (#782): 先読みの 404 が unhandled rejection（pageerror）にならず、
 * 以降の先読みも止まらないことを固定する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { backgroundPreload } from './backgroundPreload'

// @types/node 非導入のため、使う面だけ宣言する（Node 実行時の unhandledRejection 検知用）
declare const process: {
  on(event: 'unhandledRejection', fn: (reason: unknown) => void): void
  off(event: 'unhandledRejection', fn: (reason: unknown) => void): void
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20))
}

describe('backgroundPreload (#782)', () => {
  afterEach(() => {
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
      await flush()
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
      await flush()
      spy.mockImplementation((async (url: string) => {
        loaded.push(url)
        return Texture.WHITE
      }) as never)
      backgroundPreload(['c.png'])
      await flush()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(seen).toEqual([])
    expect(loaded).toEqual(['b.png', 'a.png', 'c.png'])
  })
})
