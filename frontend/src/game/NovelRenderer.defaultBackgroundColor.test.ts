/**
 * NovelRenderer 下地ベタの既定色 background_color と最初の背景のフェードイン (#409)。
 *
 * #273 の `[背景色:]`（シーン単位の上書き）とは別スロットの、frontmatter `background_color:` 由来の
 * per-game「既定色」を検証する。観測点は jsdom セーフな CPU 側のみ:
 *   - bgGraphics.fill(spy) の引数        … 下地ベタの実塗り色（既定色 / 上書き / 黒）
 *   - defaultBackgroundColorNum()        … 既定色の数値解決（未設定=黒 0x000000）
 *   - currentBackgroundColor             … [背景色:] 上書きの有無（優先関係）
 *   - bgEntries[].fadeAnimation / alpha  … 最初の背景の crossfade（下地から alpha 0→1）
 *
 * bgGraphics の clear/rect/fill は PIXI v8 で CPU 側のため init() を要さない（backgroundColor.test.ts と同じ）。
 * 実ピクセル・z-order は対象外でライブ blink に委ねる（CLAUDE.md ルール7）。
 * 非回帰の期待値（既定色 null = 黒）は直書きせず parseColorToNumber を参照して書く。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Texture } from 'pixi.js'
import { BACKGROUND_CROSSFADE_MS, NovelRenderer } from './NovelRenderer'
import { parseColorToNumber } from './novelLayout'
import type { NovelGameState } from './GameState'
import { defaultTimeController } from './TimeController'

/** 既定色 未設定時の下地色。parseColorToNumber の黒フォールバックと同じ値（直書きしない）。 */
const BLACK = parseColorToNumber('', 0x000000)

interface BackgroundEntryForTest {
  sprite: { alpha: number; removeFromParent: () => void; destroy: () => void }
  mask: null | { removeFromParent: () => void; destroy: (opts?: unknown) => void }
  fadeAnimation: null | {
    startMs: number
    durationMs: number
    fromAlpha: number
    toAlpha: number
    destroyOnComplete: boolean
  }
}

interface RendererInternals {
  setBackground(
    path: string,
    fade?: unknown,
    brightness?: number | null,
    opts?: { instant?: boolean }
  ): void
  setBackgroundColor(color: string): void
  clearBackgroundColor(): void
  applyState(state: NovelGameState): void
  defaultBackgroundColorNum(): number
  currentBackgroundColor: string | null
  defaultBackgroundColor: string | null
  bgEntries: BackgroundEntryForTest[]
  bgGraphics: { clear(): unknown; rect(...a: number[]): unknown; fill(color: number): unknown }
  textureCache: Map<string, Texture>
  initialized: boolean
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

function makeRenderer(): NovelRenderer {
  const r = new NovelRenderer()
  r.setAssetBaseUrl('/assets')
  r.getTimeController().setMode('virtual')
  internals(r).initialized = true
  return r
}

function cacheTexture(r: NovelRenderer, path: string): void {
  internals(r).textureCache.set(`/assets/images/${path}`, Texture.WHITE)
}

function baseState(r: NovelRenderer): NovelGameState {
  return {
    ...r.getSnapshot(),
    sceneId: 'a',
    eventIndex: 0,
    textIndex: 0,
    flags: {},
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
  }
}

describe('NovelRenderer 下地ベタの既定色 background_color (#409)', () => {
  afterEach(() => {
    defaultTimeController.setMode('live')
    vi.restoreAllMocks()
  })

  // ===== 既定色の塗り（上書きが無いとき）=====

  it('setDefaultBackgroundColor("#112233") は上書きが無いとき bgGraphics を既定色 0x112233 で塗る', () => {
    const r = makeRenderer()
    const fillSpy = vi.spyOn(internals(r).bgGraphics, 'fill')
    r.setDefaultBackgroundColor('#112233')
    // シーン上書き（[背景色:]）は無い状態。
    expect(internals(r).currentBackgroundColor).toBeNull()
    expect(internals(r).defaultBackgroundColor).toBe('#112233')
    // 実塗り色が既定色になる（parseColorToNumber の解決値＝0x112233）。
    const expected = parseColorToNumber('#112233', BLACK)
    expect(expected).toBe(0x112233) // 参照値の自己確認
    expect(fillSpy).toHaveBeenLastCalledWith(expected)
    expect(internals(r).defaultBackgroundColorNum()).toBe(0x112233)
  })

  it('既定色 未設定（null）は黒 0x000000（非回帰）', () => {
    const r = makeRenderer()
    expect(internals(r).defaultBackgroundColor).toBeNull()
    // defaultBackgroundColorNum は未設定なら黒に倒す。
    expect(internals(r).defaultBackgroundColorNum()).toBe(BLACK)
    expect(BLACK).toBe(0x000000)
    // 明示 null を渡しても黒で塗る（上書きが無いので即反映）。
    const fillSpy = vi.spyOn(internals(r).bgGraphics, 'fill')
    r.setDefaultBackgroundColor(null)
    expect(fillSpy).toHaveBeenLastCalledWith(BLACK)
  })

  it('空文字の既定色は null 扱いで黒（後方互換）', () => {
    const r = makeRenderer()
    r.setDefaultBackgroundColor('')
    expect(internals(r).defaultBackgroundColor).toBeNull()
    expect(internals(r).defaultBackgroundColorNum()).toBe(BLACK)
  })

  // ===== [背景色:] 上書きとの優先関係 =====

  it('[背景色:] 上書きが有効な間は setDefaultBackgroundColor で地色を塗り替えない（上書きが勝つ）', () => {
    const r = makeRenderer()
    internals(r).setBackgroundColor('#ff0000') // シーン上書きあり
    expect(internals(r).currentBackgroundColor).toBe('#ff0000')

    const fillSpy = vi.spyOn(internals(r).bgGraphics, 'fill')
    r.setDefaultBackgroundColor('#00ff00') // 既定色だけ差し替え
    // 既定色フィールドは更新されるが、上書き中は bgGraphics を塗り直さない（上書きを踏み潰さない）。
    expect(internals(r).defaultBackgroundColor).toBe('#00ff00')
    expect(fillSpy).not.toHaveBeenCalled()
  })

  it('clearBackgroundColor は上書き解除で黒でなく既定色（#112233）に戻す', () => {
    const r = makeRenderer()
    r.setDefaultBackgroundColor('#112233') // 既定色 = #112233
    internals(r).setBackgroundColor('#ff0000') // シーン上書き
    expect(internals(r).currentBackgroundColor).toBe('#ff0000')

    const fillSpy = vi.spyOn(internals(r).bgGraphics, 'fill')
    internals(r).clearBackgroundColor()
    expect(internals(r).currentBackgroundColor).toBeNull()
    // 戻り先は黒 0x000000 ではなく設定した既定色 0x112233（#409 の要点）。
    expect(fillSpy).toHaveBeenLastCalledWith(parseColorToNumber('#112233', BLACK))
    expect(fillSpy).not.toHaveBeenLastCalledWith(BLACK)
  })

  // ===== 最初の背景（コールドスタート）のフェードイン =====

  it('コールドスタート初回背景は crossfade（alpha 0→1）で background_fade_ms フェードインする', () => {
    const r = makeRenderer()
    cacheTexture(r, 'first.png')
    internals(r).setBackground('first.png') // 初回・previousPath なし＝コールドスタート
    const entries = internals(r).bgEntries
    expect(entries).toHaveLength(1)
    // 下地ベタ（bgGraphics）の上に alpha 0→1 で浮かび上がる（黒フラッシュにはならない）。
    expect(entries[0].fadeAnimation).toMatchObject({
      fromAlpha: 0,
      toAlpha: 1,
      durationMs: BACKGROUND_CROSSFADE_MS,
      destroyOnComplete: false,
    })
    expect(entries[0].sprite.alpha).toBe(0) // t=0 は下地色そのもの

    // duration を越えて進めると alpha 1 に到達しフェード完了（entry は残る＝背景は消えない）。
    // 16ms 刻みの ticker が duration 境界ちょうどでは発火しないため、+16ms 進めて完了を踏ませる。
    r.getTimeController().tick(BACKGROUND_CROSSFADE_MS + 16)
    expect(entries[0].sprite.alpha).toBe(1)
    expect(entries[0].fadeAnimation).toBeNull()
    expect(internals(r).bgEntries).toHaveLength(1)
  })

  it('setBackgroundFadeMs(2000) 後のコールドスタート初回背景は durationMs=2000 でフェードイン', () => {
    const r = makeRenderer()
    cacheTexture(r, 'first.png')
    r.setBackgroundFadeMs(2000)
    internals(r).setBackground('first.png')
    const fade = internals(r).bgEntries[0].fadeAnimation
    expect(fade?.durationMs).toBe(2000)
    expect(fade?.fromAlpha).toBe(0)
    expect(fade?.toAlpha).toBe(1)
  })

  // ===== 復元・skip・同一 path は即時（非回帰）=====

  it('復元（applyState の instant:true）はコールドスタート fade を踏まず即時 alpha1', () => {
    const r = makeRenderer()
    cacheTexture(r, 'restored.png')
    internals(r).applyState({
      ...baseState(r),
      backgroundPath: 'restored.png',
      backgroundFade: null,
      backgroundBrightness: null,
    })
    const entries = internals(r).bgEntries
    expect(entries).toHaveLength(1)
    expect(entries[0].sprite.alpha).toBe(1)
    expect(entries[0].fadeAnimation).toBeNull()
  })

  it('skipMode 中のコールドスタート初回背景は即時 alpha1（フェードしない・非回帰）', () => {
    const r = makeRenderer()
    cacheTexture(r, 'first.png')
    r.setSkipMode(true)
    internals(r).setBackground('first.png')
    const entries = internals(r).bgEntries
    expect(entries).toHaveLength(1)
    expect(entries[0].sprite.alpha).toBe(1)
    expect(entries[0].fadeAnimation).toBeNull()
  })

  it('同一 path への再 setBackground は即時（フェードしない・非回帰）', () => {
    const r = makeRenderer()
    cacheTexture(r, 'same.png')
    // 1 枚目を instant で settle（前景 alpha=1）。
    internals(r).setBackground('same.png', undefined, undefined, { instant: true })
    // 同一 path への再設定は previousPath === path で即時。
    internals(r).setBackground('same.png')
    const entries = internals(r).bgEntries
    expect(entries).toHaveLength(1)
    expect(entries[0].sprite.alpha).toBe(1)
    expect(entries[0].fadeAnimation).toBeNull()
  })
})
