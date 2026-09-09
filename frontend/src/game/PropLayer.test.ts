/**
 * PropLayer（シアターモード舞台構造の大道具 #692）の単体テスト。
 *
 * `BackgroundBoardLayer.test.ts`（#683）の全ケースを PropLayer 向けに移植したもの。
 * PropLayer は BackgroundBoardLayer をほぼそのまま複製・改名した実装（API 形状同一）のため、
 * 検証方針も同じに揃える（EventImageLayer.test.ts / TelopLayer.test.ts と同じ流儀、CLAUDE.md ルール7）:
 *  - `Assets.load` をモックして jsdom で非同期ロード経路まで検証する。
 *  - スライドイン進行は `TimeController` を virtual モードで注入し、`tick()` で決定論的に進める
 *    （実 setInterval に乗らない）。
 *  - entries は private のため internals キャストで読む（公開 API 経由で駆動した結果の観測に限定）。
 *  - BackgroundBoardLayer 側に無い新規ケース（add()〜clear() の race）も追加する（#692）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, type Texture } from 'pixi.js'
import { PropLayer } from './PropLayer'
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

interface PropEntryForTest {
  path: string
  depth: number
  sprite: { x: number; y: number; width: number; height: number } | null
  interval: number | null
  disposed: boolean
}
interface PropLayerInternals {
  entries: PropEntryForTest[]
}
function internals(layer: PropLayer): PropLayerInternals {
  return layer as unknown as PropLayerInternals
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PropLayer 基本', () => {
  it('assetBaseUrl が空なら Assets.load を呼ばないが、getState() には積まれる', () => {
    const loadSpy = vi.spyOn(Assets, 'load')
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('desk.png', 10, '')
    expect(loadSpy).not.toHaveBeenCalled()
    expect(layer.getState()).toEqual([{ path: 'desk.png', depth: 10 }])
  })

  it('複数個を追加すると加算的に蓄積される（単一スロットの背景と違い置換しない）', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('desk.png', 10, '/assets')
    layer.add('chair.png', 7, '/assets')
    layer.add('lamp.png', 4, '/assets')
    await flushPromises()
    expect(layer.getState()).toEqual([
      { path: 'desk.png', depth: 10 },
      { path: 'chair.png', depth: 7 },
      { path: 'lamp.png', depth: 4 },
    ])
  })

  it('負値・非有限の depth は 0 にクランプされる（フロント側の最終防御）', () => {
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('a.png', -5, '')
    layer.add('b.png', NaN, '')
    expect(layer.getState()).toEqual([
      { path: 'a.png', depth: 0 },
      { path: 'b.png', depth: 0 },
    ])
  })

  it('depth 降順で Container の子要素順になる（奥=depth大 が先＝背面、手前が最後＝前面）', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('near.png', 2, '/assets')
    layer.add('far.png', 10, '/assets')
    layer.add('mid.png', 5, '/assets')
    await flushPromises()
    const entries = internals(layer).entries
    const spriteOf = (path: string) => entries.find((e) => e.path === path)?.sprite
    expect(layer.children).toEqual([spriteOf('far.png'), spriteOf('mid.png'), spriteOf('near.png')])
  })

  it('同一 depth の複数大道具は Container の子要素順が挿入順のまま安定する', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
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

  it('path が空文字でも例外を投げず getState() に空文字のまま積まれる', () => {
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    expect(() => layer.add('', 3, '')).not.toThrow()
    expect(layer.getState()).toEqual([{ path: '', depth: 3 }])
  })
})

describe('カメラ射影 (#681/#682) との連携', () => {
  it('ノベルモード（既定）: depth に関わらず scale=1・画面いっぱいに表示される', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('desk.png', 10, '/assets', { instant: true })
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
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
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

  it('setCamera() は既存の大道具を新しいカメラ状態で再配置する（追加し直さなくてよい）', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('desk.png', 10, '/assets', { instant: true })
    await flushPromises()
    const sprite = internals(layer).entries[0].sprite
    expect(sprite?.width).toBe(SCREEN_W) // まだノベルモード

    layer.setCamera('Theater', 'Audience', null)
    expect(sprite?.width).toBeCloseTo(SCREEN_W * 0.5) // シアターモードへ切替と同時に再配置される
  })

  it('depth が Number.MAX_VALUE でも scale は 0 除算・NaN化せず極小の正の有限値になる', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
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

describe('スライドインアニメーション (#692)', () => {
  it('add()（既定）は画面上方向から降りてくる: 開始直後は最終位置より上、経過後に最終位置へ収束する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, time)
    layer.add('desk.png', 0, '/assets')
    await flushPromises()
    const entry = internals(layer).entries[0]
    // 開始位置: 最終位置(screenHeight/2)から screenHeight ぶん上。
    expect(entry.sprite?.y).toBeCloseTo(SCREEN_H / 2 - SCREEN_H)
    expect(entry.interval).not.toBeNull()

    time.tick(BOARD_SLIDE_IN_MS + 32)
    expect(entry.sprite?.y).toBe(SCREEN_H / 2)
    expect(entry.interval).toBeNull()
  })

  it('スライドイン中に setCamera() を呼ぶと、tween が中断されず新しい targetY へ向けて継続する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, time)
    const depth = 5
    layer.add('desk.png', depth, '/assets') // ノベルモード（既定）でスライドイン開始
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

  // [#690パターン回帰] BackgroundBoardLayer.test.ts の観点21と完全に同型の移植。
  // layoutProp() は sprite.y だけ interval 稼働中（スライドイン中）ならガードして補間に委ねるが、
  // width/height/x を毎回無条件で即座に上書きすると、カメラ切替がスライドイン中に起きたとき
  // サイズと横位置だけ瞬間的にジャンプし、縦位置だけ滑らかに補間されるという非対称な
  // アニメーションになる。PropLayer のコード自体は既にこの修正パターンを継承しているが、
  // 無回帰を保証するテストがこれまで存在しなかったため必須で移植する。
  it('スライドイン中の setCamera() は width/height/x も y と同じく即座にジャンプせず、次の tick まで反映を遅らせる', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, time)
    const depth = 10 // THEATER_CAMERA_REFERENCE_DEPTH と揃えて scale=0.5 にする
    layer.add('desk.png', depth, '/assets') // ノベルモード（既定）でスライドイン開始（scale=1）
    await flushPromises()
    const entry = internals(layer).entries[0]
    expect(entry.interval).not.toBeNull()
    expect(entry.sprite?.width).toBe(SCREEN_W)

    time.tick(BOARD_SLIDE_IN_MS / 2) // スライドイン継続中

    layer.setCamera('Theater', 'Audience', null) // depth=10 → scale = 10/(10+10) = 0.5

    // setCamera() 呼び出し直後（同じ tick 内）は、y と同じく width/height/x もまだジャンプしない。
    expect(entry.sprite?.width).toBe(SCREEN_W)
    expect(entry.sprite?.height).toBe(SCREEN_H)
    expect(entry.interval).not.toBeNull() // tween 自体は中断されない

    // 次の tick（16ms）で width/height/x も y と同じタイミングで新しい値へ反映される。
    time.tick(16)
    expect(entry.sprite?.width).toBeCloseTo(SCREEN_W * 0.5)
    expect(entry.sprite?.height).toBeCloseTo(SCREEN_H * 0.5)

    // スライドイン完了後も新しいカメラ状態のサイズのまま。
    time.tick(BOARD_SLIDE_IN_MS)
    expect(entry.sprite?.width).toBeCloseTo(SCREEN_W * 0.5)
    expect(entry.sprite?.y).toBe(SCREEN_H / 2)
    expect(entry.interval).toBeNull()
  })

  it('restore()（instant）はスライドインを起こさず即座に最終位置へ配置する（ADR-0002）', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.restore([{ path: 'desk.png', depth: 0 }], '/assets')
    await flushPromises()
    const entry = internals(layer).entries[0]
    expect(entry.sprite?.y).toBe(SCREEN_H / 2)
    expect(entry.interval).toBeNull()
  })
})

describe('clear / getState / restore', () => {
  it('clear() は全ての大道具を消去し、getState() と Container の子要素が空になる', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('a.png', 1, '/assets')
    layer.add('b.png', 2, '/assets')
    await flushPromises()
    expect(layer.getState().length).toBe(2)

    layer.clear()
    expect(layer.getState()).toEqual([])
    expect(layer.children.length).toBe(0)
  })

  it('restore() は既存の大道具を全消去してから渡された大道具を積み直す', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
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

describe('PropLayer disposeTextures（GPU テクスチャのリーク防止）', () => {
  it('ロード成功した URL を Assets.unload で解放し、内部の追跡集合をクリアする', async () => {
    mockAssetsLoadResolved()
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('a.png', 1, '/assets')
    await flushPromises()

    layer.disposeTextures()
    await flushPromises()

    expect(unloadSpy).toHaveBeenCalledWith('/assets/images/a.png')
  })

  it('何もロードしていなければ Assets.unload を呼ばない', () => {
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.disposeTextures()
    expect(unloadSpy).not.toHaveBeenCalled()
  })
})

describe('アセットロード失敗 (#692)', () => {
  it('アセットロード失敗時、console.warn を出すが例外は投げず、getState() には path/depth が残り sprite は null のまま', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('load failed'))
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())

    expect(() => layer.add('broken.png', 3, '/assets')).not.toThrow()
    await flushPromises()

    expect(warnSpy).toHaveBeenCalled()
    expect(layer.getState()).toEqual([{ path: 'broken.png', depth: 3 }])
    expect(internals(layer).entries[0].sprite).toBeNull()
  })
})

describe('並行実行 / race (#692 新規)', () => {
  // add() が同期的に entry を push した直後、Assets.load() が解決する前に clear() が呼ばれると、
  // clear() は entry.disposed = true を立てて entries を空にする。その後 Assets.load の
  // .then コールバックが実行されても、`if (entry.disposed) return` に捕まって
  // sprite 化（entry.sprite への代入）や insertSorted()/layoutProp() を一切行わないはず。
  // これを怠ると、既に clear() 済みのはずの Container に古い大道具が紛れ込む（UAF 類似のバグ）。
  it('add() 後、Assets.load 解決前に clear() が呼ばれた場合、解決時のコールバックは entry.disposed を見て無視する', async () => {
    let resolveLoad: (texture: Texture) => void = () => {}
    vi.spyOn(Assets, 'load').mockImplementation(
      () =>
        new Promise<Texture>((resolve) => {
          resolveLoad = resolve
        }) as never
    )
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('desk.png', 3, '/assets')

    // Assets.load がまだ解決していないうちに clear() を呼ぶ。
    layer.clear()
    expect(layer.getState()).toEqual([])
    expect(layer.children.length).toBe(0)

    // ここで初めて Assets.load を解決させる（clear() より後）。
    resolveLoad(mockTexture())
    await flushPromises()

    // disposed 済みの entry はコールバック内で無視されるため、sprite 化されず
    // Container にも積まれないまま（clear() 後の状態が保たれる）。
    expect(layer.getState()).toEqual([])
    expect(layer.children.length).toBe(0)
  })
})
