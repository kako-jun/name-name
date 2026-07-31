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
import { ASPECT_RATIOS, DEFAULT_ASPECT_RATIO, type AspectRatio } from './constants'

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

  // #444: 2窓モード（split_layout:true + protagonist 指定）が成立していても、novelScrim は
  // 話者別2窓（相手上/自分下）に追従して分割されず、従来どおり split_layout のテキスト領域
  // 全体（computeSplitLayoutRegions(...).text）のまま——という非破壊確認（E群 / NR-15）。
  it('2窓モード (#444: split_layout:true + protagonist 設定) でも novelScrim の矩形は分割されず computeSplitLayoutRegions(...).text 全体のまま', () => {
    const renderer = makeRenderer('16:9')
    const scrim = attachFakeScrim(renderer)
    const { screenWidth, screenHeight } = scrimInternals(renderer)

    renderer.setProtagonist('せお')
    renderer.setSplitLayout(true)

    const region = computeSplitLayoutRegions(screenWidth, screenHeight).text
    expect(scrim.rect).toHaveBeenLastCalledWith(region.x, region.y, region.width, region.height)
  })
})

// #444: NovelRenderer コンストラクタの aspectRatio 解決（実バグの回帰pin）。
//
// 修正前は `parseAspectRatio(config?.aspectRatio)` を通していたため、'2:1'/'1:2'（#444 で
// AspectRatio 型に追加された値）が parseAspectRatio の raw 文字列パーサ（3値専用）で無効値扱いされ、
// 黙って DEFAULT_ASPECT_RATIO（16:9・800x450）に落ちていた。修正後は「呼び出し側で検証済みの
// AspectRatio が渡される」前提で ASPECT_RATIOS を直接引き、未指定時だけ DEFAULT_ASPECT_RATIO に
// フォールバックする。
describe('NovelRenderer コンストラクタの aspectRatio 解決 (#444 回帰pin)', () => {
  it('aspectRatio: "2:1" は内部 screenWidth/screenHeight が 900/450 になる（黙って16:9に落ちない）', () => {
    const renderer = makeRenderer('2:1')
    const { screenWidth, screenHeight } = scrimInternals(renderer)
    expect(screenWidth).toBe(900)
    expect(screenHeight).toBe(450)
  })

  it('aspectRatio: "1:2" は内部 screenWidth/screenHeight が 450/900 になる（黙って9:16に落ちない）', () => {
    const renderer = makeRenderer('1:2')
    const { screenWidth, screenHeight } = scrimInternals(renderer)
    expect(screenWidth).toBe(450)
    expect(screenHeight).toBe(900)
  })

  it('対照: aspectRatio: undefined は従来どおり DEFAULT_ASPECT_RATIO(16:9・800x450) にフォールバックする', () => {
    const renderer = new NovelRenderer({ aspectRatio: undefined })
    const { screenWidth, screenHeight } = scrimInternals(renderer)
    expect(screenWidth).toBe(ASPECT_RATIOS[DEFAULT_ASPECT_RATIO].width)
    expect(screenHeight).toBe(ASPECT_RATIOS[DEFAULT_ASPECT_RATIO].height)
  })
})
