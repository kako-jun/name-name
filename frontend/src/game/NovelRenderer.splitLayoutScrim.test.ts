/**
 * NovelRenderer の split_layout (#442) 時の novelScrim 矩形テスト (#442 self-review must-2)。
 *
 * novelScrim は init() 完了後にしか実体化しない実 PixiJS Graphics のため、既存の
 * NovelRenderer.novel.test.ts の attachFakeNovelScrim 流儀にならい、clear/rect/fill を
 * スパイできる最小限のフェイクを注入して検証する。実 stage 上の描画反映（init 必須）は
 * NovelRenderer.novel.test.ts のコメントと同じ理由で対象外とする（実機検証・単体テストの
 * 使い分け。CLAUDE.md ルール7）。
 *
 * 検証する契約:
 *  - split_layout: true のとき、novelScrim の矩形（rect() 呼び出し引数）が画面全体ではなく
 *    computeSplitLayoutRegions(...).text（テキスト領域）に一致する（キャラ画像領域には
 *    暗幕をかけない）。
 *  - split_layout: false/未指定のときは従来どおり画面全体のまま（非破壊）。
 *  - true→false と切り替えると矩形が画面全体へ戻る（片方向の適用で終わらない）。
 */
import { describe, it, expect, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { computeSplitLayoutRegions } from './novelLayout'
import type { AspectRatio } from './constants'

interface FakeScrimGraphics {
  visible: boolean
  alpha: number
  clear: ReturnType<typeof vi.fn>
  rect: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>
}

function makeFakeScrimGraphics(): FakeScrimGraphics {
  return {
    visible: false,
    alpha: 0,
    clear: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
  }
}

interface RendererScrimInternals {
  novelScrim: FakeScrimGraphics | null
  screenWidth: number
  screenHeight: number
}
function scrimInternals(r: NovelRenderer): RendererScrimInternals {
  return r as unknown as RendererScrimInternals
}

/** init() を経ずに novelScrim をフェイクへ差し替える（既存 attachFakeNovelScrim と同じ手筋）。 */
function attachFakeScrim(r: NovelRenderer): FakeScrimGraphics {
  const fake = makeFakeScrimGraphics()
  scrimInternals(r).novelScrim = fake
  return fake
}

function makeRenderer(aspectRatio: AspectRatio): NovelRenderer {
  return new NovelRenderer({ aspectRatio })
}

describe('NovelRenderer split_layout + novelScrim 矩形 (#442 self-review must-2)', () => {
  it('landscape (16:9): split_layout: true でテキスト領域の矩形へ絞る（キャラ画像領域は暗幕なし）', () => {
    const renderer = makeRenderer('16:9')
    const scrim = attachFakeScrim(renderer)
    const { screenWidth, screenHeight } = scrimInternals(renderer)

    renderer.setSplitLayout(true)

    const region = computeSplitLayoutRegions(screenWidth, screenHeight).text
    expect(scrim.clear).toHaveBeenCalled()
    expect(scrim.rect).toHaveBeenLastCalledWith(region.x, region.y, region.width, region.height)
  })

  it('portrait (9:16): split_layout: true でテキスト領域(下半分)の矩形へ絞る', () => {
    const renderer = makeRenderer('9:16')
    const scrim = attachFakeScrim(renderer)
    const { screenWidth, screenHeight } = scrimInternals(renderer)

    renderer.setSplitLayout(true)

    const region = computeSplitLayoutRegions(screenWidth, screenHeight).text
    expect(scrim.rect).toHaveBeenLastCalledWith(region.x, region.y, region.width, region.height)
  })

  it('split_layout: false（未指定既定）では矩形は画面全体のまま（非破壊）', () => {
    const renderer = makeRenderer('16:9')
    const scrim = attachFakeScrim(renderer)
    const { screenWidth, screenHeight } = scrimInternals(renderer)

    renderer.setSplitLayout(false)

    expect(scrim.rect).toHaveBeenLastCalledWith(0, 0, screenWidth, screenHeight)
  })

  it('split_layout を true→false と切り替えると矩形が画面全体へ戻る', () => {
    const renderer = makeRenderer('16:9')
    const scrim = attachFakeScrim(renderer)
    const { screenWidth, screenHeight } = scrimInternals(renderer)

    renderer.setSplitLayout(true)
    renderer.setSplitLayout(false)

    expect(scrim.rect).toHaveBeenLastCalledWith(0, 0, screenWidth, screenHeight)
  })

  it('novelScrim 未生成（init 前）でも setSplitLayout が例外を投げない', () => {
    const renderer = makeRenderer('16:9')
    // attachFakeScrim を呼ばない = novelScrim は null のまま。
    expect(() => renderer.setSplitLayout(true)).not.toThrow()
    expect(() => renderer.setSplitLayout(false)).not.toThrow()
  })
})
