/**
 * CurtainLayer（シアターモード舞台構造の幕 #697）の単体テスト。
 *
 * 検証方針（BackgroundBoardLayer.test.ts / PropLayer.test.ts / EventImageLayer.test.ts と同じ流儀、
 * CLAUDE.md ルール7）:
 *  - `Assets.load` をモックして jsdom で非同期ロード経路まで検証する。
 *  - 昇降アニメーション進行は `TimeController` を virtual モードで注入し、`tick()` で決定論的に
 *    進める（実 setInterval に乗らない）。
 *  - sprite/interval/generation は private のため internals キャストで読む
 *    （公開 API 経由で駆動した結果の観測に限定）。
 *  - CurtainLayer は BackgroundBoardLayer/PropLayer と異なり**単一スロット**（幕は1枚のみ）。
 *    race・世代カウンタ（`generation`）の検証はこのファイル固有の観点になる
 *    （EventImageLayer.test.ts の loadToken race テストと同型）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, type Texture } from 'pixi.js'
import { CurtainLayer } from './CurtainLayer'
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
 *  targetY=0 になるよう計算をシンプルに保つ。BackgroundBoardLayer.test.ts と同じ流儀）。 */
function mockTexture(width = SCREEN_W, height = SCREEN_H): Texture {
  return { width, height, source: { scaleMode: 'linear' } } as unknown as Texture
}

function mockAssetsLoadResolved(): void {
  vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
}

// flushPromises: show() の `Assets.load(url).then(...)` を解決させる
// （BackgroundBoardLayer.test.ts と同じ流儀。実 setTimeout(0) でマクロタスクを 1 回まわす）。
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface CurtainLayerInternals {
  sprite: { x: number; y: number; width: number; height: number } | null
  interval: number | null
  generation: number
  loadedUrl: string | null
}
function internals(layer: CurtainLayer): CurtainLayerInternals {
  return layer as unknown as CurtainLayerInternals
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CurtainLayer 基本', () => {
  it('コンストラクタで eventMode="none"（クリックで本文が進行しない、他の演出レイヤーと同じ規律）', () => {
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())
    expect(layer.eventMode).toBe('none')
  })

  it('assetBaseUrl が空文字なら show() は Assets.load を呼ばない', () => {
    const loadSpy = vi.spyOn(Assets, 'load')
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.show('a.png', false, '')
    expect(loadSpy).not.toHaveBeenCalled()
  })

  it('show() 直後（load 未解決）でも getState() が即座に {path, charactersInFront} を返す（ADR-0002）', () => {
    // Assets.load を解決しない Promise にして「ロード中」の状態を作る。
    vi.spyOn(Assets, 'load').mockImplementation(() => new Promise(() => {}) as never)
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())

    layer.show('a.png', true, '/assets')

    expect(layer.getState()).toEqual({ path: 'a.png', charactersInFront: true })
  })

  it('charactersInFront: false でも getState() に正しく反映される', () => {
    vi.spyOn(Assets, 'load').mockImplementation(() => new Promise(() => {}) as never)
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())

    layer.show('b.png', false, '/assets')

    expect(layer.getState()).toEqual({ path: 'b.png', charactersInFront: false })
  })

  it('アセットロード失敗時、console.warn を出すが例外は投げず、getState() には path/charactersInFront が残り sprite は null のまま', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('load failed'))
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())

    expect(() => layer.show('broken.png', false, '/assets')).not.toThrow()
    await flushPromises()

    expect(warnSpy).toHaveBeenCalled()
    expect(layer.getState()).toEqual({ path: 'broken.png', charactersInFront: false })
    expect(internals(layer).sprite).toBeNull()
  })
})

describe('CurtainLayer 単一スロット race（世代カウンタ、最重要）', () => {
  it('show(a) → 未解決のうちに show(b) → b が先に解決 → a が後から解決しても、最終的に b のみが残る', async () => {
    const resolvers: Record<string, (t: Texture) => void> = {}
    vi.spyOn(Assets, 'load').mockImplementation(
      (url: unknown) =>
        new Promise((resolve) => {
          resolvers[String(url)] = resolve
        }) as never
    )
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())

    layer.show('a.png', false, '/assets')
    const urlA = '/assets/images/a.png'
    layer.show('b.png', true, '/assets')
    const urlB = '/assets/images/b.png'

    // b を先に解決する。
    resolvers[urlB](mockTexture())
    await flushPromises()
    expect(internals(layer).sprite).not.toBeNull()
    expect(layer.children.length).toBe(1)
    expect(layer.getState()).toEqual({ path: 'b.png', charactersInFront: true })
    const bSprite = internals(layer).sprite

    // a が後から解決しても、古い世代の応答として無視される。
    resolvers[urlA](mockTexture())
    await flushPromises()
    expect(internals(layer).sprite).toBe(bSprite) // 差し替わっていない
    expect(layer.children.length).toBe(1) // a 用の sprite が追加されていない
    expect(layer.getState()).toEqual({ path: 'b.png', charactersInFront: true })
  })

  it('clear() 後に pending load が解決しても無視される（世代カウンタ、場面転換後の「幽霊幕」防止）', async () => {
    const resolvers: Record<string, (t: Texture) => void> = {}
    vi.spyOn(Assets, 'load').mockImplementation(
      (url: unknown) =>
        new Promise((resolve) => {
          resolvers[String(url)] = resolve
        }) as never
    )
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())

    layer.show('a.png', false, '/assets')
    const urlA = '/assets/images/a.png'
    layer.clear()
    expect(layer.getState()).toBeNull()

    resolvers[urlA](mockTexture())
    await flushPromises()

    expect(internals(layer).sprite).toBeNull()
    expect(layer.children.length).toBe(0)
    expect(layer.getState()).toBeNull()
  })
})

describe('CurtainLayer raise()（幕を上げる）', () => {
  it('幕が無い（sprite===null）場合、raise() は何もしない（no-op）', () => {
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())
    expect(() => layer.raise()).not.toThrow()
    expect(layer.children.length).toBe(0)
    expect(internals(layer).interval).toBeNull()
    expect(layer.getState()).toBeNull()
  })

  it('降下完了後に raise() を呼ぶと、targetY から画面上方向へ消えて最終的に sprite が破棄される', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, time)
    layer.show('a.png', false, '/assets')
    await flushPromises()

    time.tick(BOARD_SLIDE_IN_MS + 32) // 降下完了
    expect(internals(layer).sprite?.y).toBe(0) // targetY（画面と同じアスペクト比のテクスチャなので 0）

    layer.raise()
    expect(internals(layer).interval).not.toBeNull()

    time.tick(BOARD_SLIDE_IN_MS + 32) // 上昇完了
    expect(internals(layer).sprite).toBeNull()
    expect(layer.children.length).toBe(0)
    // settled state（getState()）は raise() 呼び出し直後に即座に null になっている
    // （上昇アニメーション自体は演出の中間状態、ADR-0002）。
    expect(layer.getState()).toBeNull()
  })

  // 回帰防止テスト: 降下アニメ中に raise() が呼ばれた場合の連続性（#697バグ修正、コミット96137ed）。
  //
  // 仕様: raise() は「その時点の現在位置」から上昇を始める。一旦「完全に降りた位置」へ
  // ジャンプしてから上昇を始めることはない（見た目上のポップ/瞬間移動は演出として許容されない、
  // 他の全アニメーションが tween 中断時も現在値から継続する規律
  // （BackgroundBoardLayer.test.ts 観点3/21 参照）と一貫させるため）。
  //
  // 修正前は CurtainLayer.raise()/updateRaiseFrame() が raise() 時点で phaseStartedAtMs を
  // this.time.now() にリセットし、computeCurtainRiseOffset(elapsed, ...) を elapsed=0 から
  // 測り直していたため、computeCurtainRiseOffset(0, duration) が常に返す 0（= targetY、
  // 「幕が完全に降りきった位置」）へ一旦ジャンプしてから上昇するバグがあった。
  // raise() 呼び出し時点の実際の sprite.y から startOffset を算出して
  // computeCurtainRiseOffset(elapsed, duration, startOffset) に渡すよう修正済み。
  it('降下70%地点相当でraise()を呼んでも、次フレームのsprite.yが完全に降りた位置へジャンプせず現在位置から連続的に上昇する', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, time)
    layer.show('a.png', false, '/assets')
    await flushPromises()

    // 降下を 50%（elapsed=300/600）まで進める。ちょうど半分の経過時間だが、easeOut により
    // 見た目上はより最終位置に近い（ここでは厳密な割合ではなく「まだ完全には降りきっていない
    // 中間状態」を作れればよい）。
    time.tick(BOARD_SLIDE_IN_MS / 2)
    const yAtRaiseCall = internals(layer).sprite?.y
    expect(yAtRaiseCall).toBeDefined()
    // 中間状態であることの確認: 開始位置(-SCREEN_H)にも最終位置(0)にも一致しない。
    expect(yAtRaiseCall).not.toBe(0)
    expect(yAtRaiseCall).not.toBe(-SCREEN_H)

    layer.raise()

    // raise() 呼び出し直後（次の interval tick が発火する前）は sprite.y はまだ変化していない。
    expect(internals(layer).sprite?.y).toBe(yAtRaiseCall)

    // 次フレーム（16ms）分だけ進める。
    time.tick(16)
    const yAfterOneRaiseFrame = internals(layer).sprite?.y as number

    // 正しい仕様: 1フレーム(16ms)ぶんの自然な移動量に収まる（現在位置から連続的に上昇する）。
    // 大きなジャンプ（「完全に降りた位置(0)」付近へ飛ぶ）が起きていないことを確認する。
    const movement = Math.abs(yAfterOneRaiseFrame - (yAtRaiseCall as number))
    expect(movement).toBeLessThan(20) // 1 フレームの自然な移動量の目安（600ms/450pxの補間なら数px程度のはず）
  })
})

describe('CurtainLayer restore / clear', () => {
  it('restore(state, url) で state が非nullなら即座に最終位置（アニメ無し）に配置される', async () => {
    mockAssetsLoadResolved()
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())

    layer.restore({ path: 'a.png', charactersInFront: false }, '/assets')
    await flushPromises()

    expect(internals(layer).sprite?.y).toBe(0) // targetY へ即座配置
    expect(internals(layer).interval).toBeNull() // スライドインが起きていない
    expect(layer.getState()).toEqual({ path: 'a.png', charactersInFront: false })
  })

  it('restore(null, url) は clear() と同義（既存の幕を即座に消去する）', async () => {
    mockAssetsLoadResolved()
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.show('a.png', false, '/assets', { instant: true })
    await flushPromises()
    expect(layer.children.length).toBe(1)

    layer.restore(null, '/assets')

    expect(layer.children.length).toBe(0)
    expect(internals(layer).sprite).toBeNull()
    expect(layer.getState()).toBeNull()
  })

  it('clear() は幕が無い状態でも例外を投げない', () => {
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())
    expect(() => layer.clear()).not.toThrow()
    expect(layer.getState()).toBeNull()
  })
})

describe('CurtainLayer disposeTextures（GPU テクスチャのリーク防止）', () => {
  it('何もロードしていない状態でも安全（Assets.unload を呼ばない）', () => {
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())
    expect(() => layer.disposeTextures()).not.toThrow()
    expect(unloadSpy).not.toHaveBeenCalled()
  })

  it('ロード成功後は Assets.unload で解放され、内部の追跡 URL がクリアされる', async () => {
    mockAssetsLoadResolved()
    const unloadSpy = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.show('a.png', false, '/assets')
    await flushPromises()

    layer.disposeTextures()
    await flushPromises()

    expect(unloadSpy).toHaveBeenCalledWith('/assets/images/a.png')
    expect(internals(layer).loadedUrl).toBeNull()

    // 2回目の呼び出しは何も解放しない（既に解放済み・追跡URLがnullのため）。
    unloadSpy.mockClear()
    layer.disposeTextures()
    expect(unloadSpy).not.toHaveBeenCalled()
  })
})

describe('CurtainLayer interval リーク防止', () => {
  it('show() → clear() → show() の連続呼び出しで interval がリークしない', async () => {
    mockAssetsLoadResolved()
    const time = virtualTime()
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, time)

    layer.show('a.png', false, '/assets')
    await flushPromises()
    expect(internals(layer).interval).not.toBeNull()
    expect(time.getPendingTimerCount()).toBe(1)

    layer.clear()
    expect(internals(layer).interval).toBeNull()
    expect(time.getPendingTimerCount()).toBe(0)

    layer.show('b.png', false, '/assets')
    await flushPromises()
    expect(internals(layer).interval).not.toBeNull()
    expect(time.getPendingTimerCount()).toBe(1) // 前の interval が残留して 2 にならない

    time.tick(BOARD_SLIDE_IN_MS + 32)
    expect(internals(layer).interval).toBeNull()
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('同じ値を連続で show() しても冪等（余計な子要素が増えない）', async () => {
    mockAssetsLoadResolved()
    const layer = new CurtainLayer(SCREEN_W, SCREEN_H, virtualTime())

    layer.show('a.png', false, '/assets', { instant: true })
    await flushPromises()
    expect(layer.children.length).toBe(1)

    layer.show('a.png', false, '/assets', { instant: true })
    await flushPromises()
    expect(layer.children.length).toBe(1)
    expect(layer.getState()).toEqual({ path: 'a.png', charactersInFront: false })
  })
})
