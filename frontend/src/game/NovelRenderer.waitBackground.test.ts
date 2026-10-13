/**
 * NovelRenderer.waitForBackgroundLoad (#734 PR4) 単体テスト。
 * 動画書き出しが録画開始前に開始シーンの背景ロード完了を待つための API。
 * Assets.load はモックし、private な setBackground / showLoadedBackground を直接観測する
 * （NovelRenderer.preload.test.ts と同流儀）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'

interface Hooks {
  initialized: boolean
  setBackground(path: string): void
  showLoadedBackground: (...a: unknown[]) => void
  clearBackground(): void
}

function setup() {
  vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
  const r = new NovelRenderer()
  r.setAssetBaseUrl('/assets')
  const h = r as unknown as Hooks
  h.initialized = true
  const shown = vi.spyOn(h, 'showLoadedBackground').mockImplementation(() => {})
  return { r, h, shown }
}

/** 外から解決・拒否できる Assets.load */
function deferredLoad() {
  const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
  vi.spyOn(Assets, 'load').mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve: () => resolve(Texture.WHITE), reject })
      }) as never
  )
  return pending
}

async function settled(p: Promise<void>): Promise<boolean> {
  let done = false
  void p.then(() => {
    done = true
  })
  await new Promise((r) => setTimeout(r, 0))
  return done
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('waitForBackgroundLoad (#734)', () => {
  it('未キャッシュのロード中は未解決で、ロード後に解決する（showLoadedBackground まで済む）', async () => {
    const { r, h, shown } = setup()
    const pending = deferredLoad()
    h.setBackground('bg.png')
    const w = r.waitForBackgroundLoad()
    expect(await settled(w)).toBe(false)
    expect(shown).not.toHaveBeenCalled()
    pending[0].resolve()
    await w
    expect(shown).toHaveBeenCalledTimes(1)
  })

  it('ロードが reject しても resolve する', async () => {
    const { r, h } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = deferredLoad()
    h.setBackground('bg.png')
    const w = r.waitForBackgroundLoad()
    pending[0].reject(new Error('404'))
    await expect(w).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('ロード中に別の setBackground が来ても、呼び出し時点の promise だけを待つ', async () => {
    const { r, h } = setup()
    const pending = deferredLoad()
    h.setBackground('a.png')
    const w = r.waitForBackgroundLoad()
    h.setBackground('b.png')
    pending[0].resolve() // a のロード完了（b はまだ）
    await expect(w).resolves.toBeUndefined()
    const w2 = r.waitForBackgroundLoad()
    expect(await settled(w2)).toBe(false)
    pending[1].resolve()
    await w2
  })

  it('ロード無し・キャッシュ済み・地色のみは即解決する', async () => {
    const { r, h } = setup()
    const pending = deferredLoad()
    await expect(r.waitForBackgroundLoad()).resolves.toBeUndefined() // ロード無し
    h.setBackground('bg.png')
    pending[0].resolve()
    await r.waitForBackgroundLoad()
    h.setBackground('bg.png') // キャッシュヒット（同期描画）
    expect(await settled(r.waitForBackgroundLoad())).toBe(true)
    expect(pending).toHaveLength(1)
    h.clearBackground() // 地色のみ
    expect(await settled(r.waitForBackgroundLoad())).toBe(true)
  })

  it('背景クリアでロード待ちの対象が外れる（新規開始で破棄された古いロードを待たない）', async () => {
    const { r, h } = setup()
    deferredLoad()
    h.setBackground('bg.png')
    h.clearBackground()
    expect(await settled(r.waitForBackgroundLoad())).toBe(true)
  })
})
