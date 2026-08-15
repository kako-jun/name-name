/**
 * NovelRenderer の終劇オーバーレイ ("to be continued..." + 埋め込み元ロゴ) 単体テスト (#630)。
 *
 * DOM 版 NovelPlayer.tsx の "to be continued..." 表示を PixiJS 化した際の、NovelRenderer 側の
 * 「仲介・判定」契約だけを縛る（EndingOverlay 自身のテキスト描画・スタイルは対象外。
 * NovelRenderer.titleScreen.test.ts と同じ切り分け方針）:
 *   - endStory() で storyEnded=true になった瞬間、intermissionEvents が未設定なら endingOverlay
 *     が表示され、ロゴが characterLayer.showImage() 経由で表示される（常に Fade・
 *     id='__ending_logo__' 固定であることの回帰テスト）
 *   - assetBaseUrl 未設定ならロゴのロード自体を試みない（テキストのみ表示）
 *   - intermissionEvents 設定済みなら表示されない（PixiJS タブローへの一本化・二重表示防止）
 *   - race 条件: endStory() 発火時点の intermissionEvents 値でスナップショットする（旧 DOM 版
 *     NovelPlayer の usedIntermissionScene と同じ意味論。NP-IM-3 の移行先）
 *   - storyEnded が false に戻ると非表示になり、ロゴは即時破棄される
 *   - fluid 再マウント (restoreSnapshot) で storyEnded:true を復元した新規 renderer でも表示される
 *     （onStoryEndedChangeCallback は M2 の重複防止ガードで発火しないが、表示は同期される）
 *
 * 駆動方式（NovelRenderer.titleScreen.test.ts / NovelRenderer.exhaustedEnding.test.ts と同形）:
 *   `new NovelRenderer()` のみ（init() は呼ばない）。endingOverlay/characterLayer は constructor で
 *   同期生成されるため、init 不要で private フィールドへ直接到達できる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { NovelGameState } from './GameState'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

const ENDING_LOGO_IMAGE_ID = '__ending_logo__'

interface EndingOverlayInternals {
  endingOverlay: { visible: boolean }
  characterLayer: {
    showImage: (...args: unknown[]) => void
    remove: (...args: unknown[]) => void
  }
}
function internals(r: NovelRenderer): EndingOverlayInternals {
  return r as unknown as EndingOverlayInternals
}

function makeConfinedRenderer(): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes([scene('entry', [narration('本文')]), scene('out', [narration('圏外')])])
  r.setConfinedSceneIds(['entry'])
  return r
}

describe('NovelRenderer 終劇オーバーレイ (#630)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('1: confinement 外ジャンプで storyEnded=true になると endingOverlay が表示される（intermission 未設定）', () => {
    const r = makeConfinedRenderer()

    r.jumpToScene('out')

    expect(internals(r).endingOverlay.visible).toBe(true)
  })

  it('2: assetBaseUrl 設定済みなら characterLayer.showImage が id=__ending_logo__, path=title.png, transition未指定 で呼ばれる', () => {
    const r = makeConfinedRenderer()
    r.setAssetBaseUrl('/asset-base')
    const showImageSpy = vi.spyOn(internals(r).characterLayer, 'showImage')

    r.jumpToScene('out')

    expect(showImageSpy).toHaveBeenCalledTimes(1)
    const call = showImageSpy.mock.calls[0][0] as Record<string, unknown>
    expect(call.id).toBe(ENDING_LOGO_IMAGE_ID)
    expect(call.path).toBe('title.png')
    expect(call.assetBaseUrl).toBe('/asset-base')
    expect(call.transition).toBeUndefined()
  })

  it('3: assetBaseUrl 未設定なら characterLayer.showImage は呼ばれない（テキストのみ表示）', () => {
    const r = makeConfinedRenderer()
    const showImageSpy = vi.spyOn(internals(r).characterLayer, 'showImage')

    r.jumpToScene('out')

    expect(showImageSpy).not.toHaveBeenCalled()
    expect(internals(r).endingOverlay.visible).toBe(true)
  })

  it('4: intermissionEvents 設定済みで storyEnded=true になっても endingOverlay は表示されない（PixiJS タブローに一本化）', () => {
    const r = makeConfinedRenderer()
    r.setIntermissionScene([narration('つづく')], {})

    r.jumpToScene('out')

    expect(internals(r).endingOverlay.visible).toBe(false)
  })

  it('5 (race・NP-IM-3 移行先): endStory() 発火後に setIntermissionScene が呼ばれても、既に表示済みの endingOverlay は消えない（スナップショット固定）', () => {
    const r = makeConfinedRenderer()

    r.jumpToScene('out')
    expect(internals(r).endingOverlay.visible).toBe(true)

    // intermission が遅れて届く（PlayerScreen の非同期 fetch 解決）想定。
    r.setIntermissionScene([narration('つづく')], {})

    expect(internals(r).endingOverlay.visible).toBe(true)
  })

  it('6: storyEnded が false に戻ると endingOverlay は非表示になり、ロゴは即時破棄される', () => {
    const r = makeConfinedRenderer()
    r.setAssetBaseUrl('/asset-base')
    r.jumpToScene('out')
    expect(internals(r).endingOverlay.visible).toBe(true)

    const removeSpy = vi.spyOn(internals(r).characterLayer, 'remove')
    // 通常のシーン遷移に戻す（startScene() 経由の storyEnded=false 復帰、confinement 解除）。
    r.setConfinedSceneIds(null)
    r.jumpToScene('entry')

    expect(internals(r).endingOverlay.visible).toBe(false)
    expect(removeSpy).toHaveBeenCalledWith(ENDING_LOGO_IMAGE_ID, { instant: true })
  })

  it('7 (M2 対): restoreSnapshot で storyEnded:true のスナップショットを新規 renderer に復元すると、onStoryEndedChangeCallback は発火しないが endingOverlay は表示される', () => {
    const r = new NovelRenderer()
    const cb = vi.fn()
    r.setOnStoryEndedChange(cb)
    r.setScenes([scene('a', [narration('本文')])])

    const snapshot: NovelGameState = {
      sceneId: 'a',
      eventIndex: 0,
      textIndex: 0,
      sentenceIndex: 0,
      flags: {},
      backgroundPath: null,
      backgroundColor: null,
      backgroundFade: null,
      backgroundBrightness: null,
      video: null,
      eventImage: null,
      isBlackout: false,
      characters: [],
      currentBgmPath: null,
      storyEnded: true,
    }
    r.restoreSnapshot(snapshot)

    expect(cb).not.toHaveBeenCalled()
    expect(internals(r).endingOverlay.visible).toBe(true)
  })
})
