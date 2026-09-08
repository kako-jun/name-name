/**
 * BackgroundBoardLayer（シアターモード舞台構造の背景板 #683）の単体テスト。
 *
 * 検証方針（EventImageLayer.test.ts / TelopLayer.test.ts と同じ流儀、CLAUDE.md ルール7）:
 *  - `Assets.load` をモックして jsdom で非同期ロード経路まで検証する。
 *  - スライドイン進行は `TimeController` を virtual モードで注入し、`tick()` で決定論的に進める
 *    （実 setInterval に乗らない）。
 *  - entries は private のため internals キャストで読む（公開 API 経由で駆動した結果の観測に限定）。
 *  - このファイルは Issue #683 実装コミットに含まれる基本的な動作確認。本格的な境界値・
 *    後方互換の網羅は別途テスト作成サブエージェントが担当する（doctrine 規律6のセルフレビュー参照）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, type Texture } from 'pixi.js'
import { BackgroundBoardLayer } from './BackgroundBoardLayer'
import { TimeController } from './TimeController'
import { BOARD_SLIDE_IN_MS } from './novelLayout'

const SCREEN_W = 800
const SCREEN_H = 450

/** virtual モードの TimeController を 1 つ作る（実時計に乗らず tick() で進める）。 */
function virtualTime(): TimeController {
  const t = new TimeController()
  t.setMode('virtual')
  return t
}

/** 画面と同じアスペクト比のテクスチャ（cover-fit で screenWidth/Height にぴったり一致させ、
 *  計算をシンプルに保つ）。 */
function mockTexture(width = SCREEN_W, height = SCREEN_H): Texture {
  return { width, height, source: { scaleMode: 'linear' } } as unknown as Texture
}

function mockAssetsLoadResolved(): void {
  vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
}

// flushPromises: add() の `Assets.load(url).then(...)` を解決させる
// （EventImageLayer.test.ts と同じ流儀。実 setTimeout(0) でマクロタスクを 1 回まわす）。
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface BoardEntryForTest {
  path: string
  depth: number
  sprite: { x: number; y: number; width: number; height: number } | null
  interval: number | null
}
interface BackgroundBoardLayerInternals {
  entries: BoardEntryForTest[]
}
function internals(layer: BackgroundBoardLayer): BackgroundBoardLayerInternals {
  return layer as unknown as BackgroundBoardLayerInternals
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BackgroundBoardLayer 基本', () => {
  it('assetBaseUrl が空なら Assets.load を呼ばないが、getState() には積まれる', () => {
    const loadSpy = vi.spyOn(Assets, 'load')
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('sky.png', 10, '')
    expect(loadSpy).not.toHaveBeenCalled()
    expect(layer.getState()).toEqual([{ path: 'sky.png', depth: 10 }])
  })

  it('複数枚を追加すると加算的に蓄積される（単一スロットの背景と違い置換しない）', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('sky.png', 10, '/assets')
    layer.add('mountain.png', 7, '/assets')
    layer.add('tree.png', 4, '/assets')
    await flushPromises()
    expect(layer.getState()).toEqual([
      { path: 'sky.png', depth: 10 },
      { path: 'mountain.png', depth: 7 },
      { path: 'tree.png', depth: 4 },
    ])
  })

  it('負値・非有限の depth は 0 にクランプされる（フロント側の最終防御）', () => {
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('a.png', -5, '')
    layer.add('b.png', NaN, '')
    expect(layer.getState()).toEqual([
      { path: 'a.png', depth: 0 },
      { path: 'b.png', depth: 0 },
    ])
  })

  it('depth 降順で Container の子要素順になる（奥=depth大 が先＝背面、手前が最後＝前面）', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('near.png', 2, '/assets')
    layer.add('far.png', 10, '/assets')
    layer.add('mid.png', 5, '/assets')
    await flushPromises()
    const entries = internals(layer).entries
    const spriteOf = (path: string) => entries.find((e) => e.path === path)?.sprite
    expect(layer.children).toEqual([spriteOf('far.png'), spriteOf('mid.png'), spriteOf('near.png')])
  })
})

describe('カメラ射影 (#681/#682) との連携', () => {
  it('ノベルモード（既定）: depth に関わらず scale=1・画面いっぱいに表示される', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('sky.png', 10, '/assets', { instant: true })
    await flushPromises()
    const sprite = internals(layer).entries[0].sprite
    expect(sprite).not.toBeNull()
    expect(sprite?.width).toBe(SCREEN_W)
    expect(sprite?.height).toBe(SCREEN_H)
    expect(sprite?.x).toBe(SCREEN_W / 2)
    expect(sprite?.y).toBe(SCREEN_H / 2)
  })

  it('シアターモード: depth が大きいほど縮小し、depth=0 は原寸のまま', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.setCamera('Theater', 'Audience', null)
    layer.add('near.png', 0, '/assets', { instant: true })
    layer.add('far.png', 10, '/assets', { instant: true })
    await flushPromises()
    const entries = internals(layer).entries
    const near = entries.find((e) => e.path === 'near.png')?.sprite
    const far = entries.find((e) => e.path === 'far.png')?.sprite
    expect(near?.width).toBe(SCREEN_W)
    // computeCameraProjection: scale = REF_DEPTH / (REF_DEPTH + depth) = 10 / (10 + 10) = 0.5
    expect(far?.width).toBeCloseTo(SCREEN_W * 0.5)
    expect(far?.width).toBeLessThan(near?.width ?? 0)
  })

  it('setCamera() は既存の板を新しいカメラ状態で再配置する（追加し直さなくてよい）', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('board.png', 10, '/assets', { instant: true })
    await flushPromises()
    const sprite = internals(layer).entries[0].sprite
    expect(sprite?.width).toBe(SCREEN_W) // まだノベルモード

    layer.setCamera('Theater', 'Audience', null)
    expect(sprite?.width).toBeCloseTo(SCREEN_W * 0.5) // シアターモードへ切替と同時に再配置される
  })
})

describe('スライドインアニメーション (#683)', () => {
  it('add()（既定）は画面上方向から降りてくる: 開始直後は最終位置より上、経過後に最終位置へ収束する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, time)
    layer.add('board.png', 0, '/assets')
    await flushPromises()
    const entry = internals(layer).entries[0]
    // 開始位置: 最終位置(screenHeight/2)から screenHeight ぶん上。
    expect(entry.sprite?.y).toBeCloseTo(SCREEN_H / 2 - SCREEN_H)
    expect(entry.interval).not.toBeNull()

    time.tick(BOARD_SLIDE_IN_MS + 32)
    expect(entry.sprite?.y).toBe(SCREEN_H / 2)
    expect(entry.interval).toBeNull()
  })

  it('restore()（instant）はスライドインを起こさず即座に最終位置へ配置する（ADR-0002）', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.restore([{ path: 'board.png', depth: 0 }], '/assets')
    await flushPromises()
    const entry = internals(layer).entries[0]
    expect(entry.sprite?.y).toBe(SCREEN_H / 2)
    expect(entry.interval).toBeNull()
  })
})

describe('clear / getState / restore', () => {
  it('clear() は全ての板を消去し、getState() と Container の子要素が空になる', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('a.png', 1, '/assets')
    layer.add('b.png', 2, '/assets')
    await flushPromises()
    expect(layer.getState().length).toBe(2)

    layer.clear()
    expect(layer.getState()).toEqual([])
    expect(layer.children.length).toBe(0)
  })

  it('restore() は既存の板を全消去してから渡された板を積み直す', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('old.png', 1, '/assets')
    await flushPromises()

    layer.restore(
      [
        { path: 'new1.png', depth: 3 },
        { path: 'new2.png', depth: 1 },
      ],
      '/assets'
    )
    await flushPromises()

    expect(layer.getState()).toEqual([
      { path: 'new1.png', depth: 3 },
      { path: 'new2.png', depth: 1 },
    ])
  })
})

describe('BackgroundBoardLayer disposeTextures（GPU テクスチャのリーク防止）', () => {
  it('ロード成功した URL を Assets.unload で解放し、内部の追跡集合をクリアする', async () => {
    mockAssetsLoadResolved()
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('a.png', 1, '/assets')
    await flushPromises()

    layer.disposeTextures()
    await flushPromises()

    expect(unloadSpy).toHaveBeenCalledWith('/assets/images/a.png')
  })

  it('何もロードしていなければ Assets.unload を呼ばない', () => {
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.disposeTextures()
    expect(unloadSpy).not.toHaveBeenCalled()
  })
})
