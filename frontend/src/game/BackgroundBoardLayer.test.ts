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
import { THEATER_ELEVATION_OFFSET_PER_DEPTH } from './cameraProjection'

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

  // テスト観点14: insertSorted() は `[...entries].sort((a, b) => b.depth - a.depth)` を使う。
  // JS の Array.prototype.sort は ES2019 以降 stable 保証（同値の要素は元の相対順を保つ）ため、
  // 同一 depth の複数板は比較関数が常に 0 を返し、追加した順序のまま Container の子要素順になる。
  it('14: 同一 depth の複数板は Container の子要素順が挿入順のまま安定する', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('first.png', 5, '/assets')
    layer.add('second.png', 5, '/assets')
    layer.add('third.png', 5, '/assets')
    await flushPromises()
    const entries = internals(layer).entries
    const spriteOf = (path: string) => entries.find((e) => e.path === path)?.sprite
    expect(layer.children).toEqual([
      spriteOf('first.png'),
      spriteOf('second.png'),
      spriteOf('third.png'),
    ])
  })

  // テスト観点15: path が空文字でも add() は特別扱いせず、getState() にそのまま積まれる
  // （Rust パーサー側も path の空文字バリデーションを行わないため、値をそのまま通す一貫した挙動）。
  it('15: path が空文字でも例外を投げず getState() に空文字のまま積まれる', () => {
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    expect(() => layer.add('', 3, '')).not.toThrow()
    expect(layer.getState()).toEqual([{ path: '', depth: 3 }])
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

  // テスト観点9: depth に上限クランプは無い（add() がクランプするのは非有限値・負値のみ、
  // Math.max(0, depth)）。巨大な有限値でも computeCameraProjection の
  // `scale = REF_DEPTH / (REF_DEPTH + depth)` は 0 除算にならず、限りなく 0 に近い正の有限値に
  // 漸近する（NaN/Infinity 化しない）。
  it('9: depth が Number.MAX_VALUE でも scale は 0 除算・NaN化せず極小の正の有限値になる', async () => {
    mockAssetsLoadResolved()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.setCamera('Theater', 'Audience', null)
    layer.add('far.png', Number.MAX_VALUE, '/assets', { instant: true })
    await flushPromises()
    const entry = internals(layer).entries[0]
    // 上限クランプが無いこと自体も確認する（depth がそのまま Number.MAX_VALUE で保持される）。
    expect(entry.depth).toBe(Number.MAX_VALUE)
    const sprite = entry.sprite
    expect(sprite).not.toBeNull()
    expect(Number.isFinite(sprite?.width)).toBe(true)
    expect(Number.isFinite(sprite?.height)).toBe(true)
    expect(sprite?.width).toBeGreaterThan(0)
    expect(sprite?.height).toBeGreaterThan(0)
    // 極小に縮小されている（原寸 SCREEN_W よりはるかに小さい）ことの確認。
    expect(sprite?.width).toBeLessThan(1)
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

  // テスト観点3: スライドイン中（interval 稼働中）に setCamera() を呼んでも layoutBoard() は
  // targetX/targetY を更新するだけで、interval 自体は止め直さない（updateSlideFrame は毎フレーム
  // 最新の entry.targetY を読むため、tween は中断されず新しい着地点へ向けて自然に継続する）。
  it('3: スライドイン中に setCamera() を呼ぶと、tween が中断されず新しい targetY へ向けて継続する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, time)
    const depth = 5
    layer.add('board.png', depth, '/assets') // ノベルモード（既定）でスライドイン開始
    await flushPromises()
    const entry = internals(layer).entries[0]
    const intervalBeforeCameraChange = entry.interval
    expect(intervalBeforeCameraChange).not.toBeNull()

    // スライドインの半分ほど進めてから、tween 継続中にカメラ状態を切り替える。
    time.tick(BOARD_SLIDE_IN_MS / 2)

    layer.setCamera('Theater', 'Audience', 'LookDown')
    // シアター + LookDown: verticalOffset = depth * THEATER_ELEVATION_OFFSET_PER_DEPTH（正値）。
    const newTargetY = SCREEN_H / 2 + depth * THEATER_ELEVATION_OFFSET_PER_DEPTH

    // setCamera() は稼働中の interval を止め直さない（同じ id のまま、tween は中断されない）。
    expect(entry.interval).toBe(intervalBeforeCameraChange)
    expect(entry.interval).not.toBeNull()

    // 残り時間を進めると、旧 targetY（画面中央）ではなく新しい targetY へ収束する。
    time.tick(BOARD_SLIDE_IN_MS / 2 + 32)
    expect(entry.sprite?.y).toBeCloseTo(newTargetY)
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

describe('アセットロード失敗 (#683)', () => {
  // テスト観点5: Assets.load() が reject したとき、add() の .catch() ハンドラは
  // console.warn を出すだけで例外を投げ直さない（呼び出し元の processDirective まで伝播しない）。
  // entry 自体は add() 冒頭で同期的に push 済みのため getState() には path/depth が残り、
  // sprite はロード成功時にのみ代入される（entry.sprite = new Sprite(texture)）ため null のまま。
  it('5: アセットロード失敗時、console.warn を出すが例外は投げず、getState() には path/depth が残り sprite は null のまま', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('load failed'))
    const layer = new BackgroundBoardLayer(SCREEN_W, SCREEN_H, virtualTime())

    expect(() => layer.add('broken.png', 3, '/assets')).not.toThrow()
    await flushPromises()

    expect(warnSpy).toHaveBeenCalled()
    expect(layer.getState()).toEqual([{ path: 'broken.png', depth: 3 }])
    expect(internals(layer).entries[0].sprite).toBeNull()
  })
})
