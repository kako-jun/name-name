/**
 * NovelRenderer の Enter/Exit 方向モーション（上手/下手, #684）の cameraMode ゲーティング配線テスト。
 *
 * processDirective は cameraMode（'Theater'/'Novel'）を見て Enter.enter_direction /
 * Exit.exit_direction を CharacterLayer.show/remove の enterDirection/exitDirection へ
 * 通す/undefined に潰すを切り替える（NovelRenderer.ts 'Enter'/'Exit' 分岐）。
 * ここでは「NovelRenderer が正しい options で CharacterLayer を呼ぶか」だけを検証する
 * （実際の歩行モーション自体の意味論は CharacterLayer.test.ts の責務）。
 *
 * 駆動方式: private processDirective を internals キャストで直呼びする
 * （NovelRenderer.exitFade.test.ts と同じ流儀。playScript/startFrom のテキストイベント待ちを
 * 経由しない分、CameraMode/Enter/Exit という非テキストディレクティブの検証には最短）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, StageDirection } from '../types'

interface RendererCameraDirectionHooks {
  processDirective(event: Event): void
  characterLayer: {
    show: (
      character: string,
      expression: string,
      position: string,
      assetBaseUrl: string,
      options?: {
        instant?: boolean
        xRatio?: number
        fit?: boolean
        enterDirection?: StageDirection
      }
    ) => void
    remove: (
      character: string,
      options?: {
        instant?: boolean
        durationMsOverride?: number
        exitDirection?: StageDirection
      }
    ) => void
  }
}

function hooks(renderer: NovelRenderer): RendererCameraDirectionHooks {
  return renderer as unknown as RendererCameraDirectionHooks
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelRenderer Enter/Exit の方向モーション cameraMode ゲーティング (#684)', () => {
  it('cameraMode===Theater では Enter.enter_direction が CharacterLayer.show の enterDirection へ伝播する', () => {
    const renderer = new NovelRenderer()
    const h = hooks(renderer)
    const showSpy = vi.spyOn(h.characterLayer, 'show').mockImplementation(() => {})

    h.processDirective({ CameraMode: { mode: 'Theater', orientation: null } })
    h.processDirective({
      Enter: {
        character: 'せお',
        expression: 'theo/normal',
        position: '左',
        fit: false,
        enter_direction: 'Kamite',
      },
    })

    expect(showSpy).toHaveBeenCalledWith('せお', 'theo/normal', '左', '', {
      instant: false,
      xRatio: undefined,
      fit: false,
      enterDirection: 'Kamite',
      depth: 0,
    })
  })

  it('cameraMode===Theater では Exit.exit_direction が CharacterLayer.remove の exitDirection へ伝播する', () => {
    const renderer = new NovelRenderer()
    const h = hooks(renderer)
    const removeSpy = vi.spyOn(h.characterLayer, 'remove').mockImplementation(() => {})

    h.processDirective({ CameraMode: { mode: 'Theater', orientation: null } })
    h.processDirective({ Exit: { character: 'せお', exit_direction: 'Shimote' } })

    expect(removeSpy).toHaveBeenCalledWith('せお', {
      instant: false,
      durationMsOverride: undefined,
      exitDirection: 'Shimote',
    })
  })

  it('cameraMode===Novel（既定）では enter_direction/exit_direction が undefined に潰されて CharacterLayer へ渡る', () => {
    const renderer = new NovelRenderer()
    const h = hooks(renderer)
    const showSpy = vi.spyOn(h.characterLayer, 'show').mockImplementation(() => {})
    const removeSpy = vi.spyOn(h.characterLayer, 'remove').mockImplementation(() => {})

    // cameraMode を明示的に Theater にしない = 既定の Novel のまま。
    h.processDirective({
      Enter: {
        character: 'せお',
        expression: 'theo/normal',
        position: '左',
        fit: false,
        enter_direction: 'Kamite',
      },
    })
    h.processDirective({ Exit: { character: 'せお', exit_direction: 'Shimote' } })

    expect(showSpy).toHaveBeenCalledWith('せお', 'theo/normal', '左', '', {
      instant: false,
      xRatio: undefined,
      fit: false,
      enterDirection: undefined,
      depth: 0,
    })
    expect(removeSpy).toHaveBeenCalledWith('せお', {
      instant: false,
      durationMsOverride: undefined,
      exitDirection: undefined,
    })
  })

  it('スキップモード中は cameraMode===Theater でも方向引数より instant 優先で即時表示/破棄される（NovelRenderer→CharacterLayer の一気通貫）', () => {
    const renderer = new NovelRenderer()
    const h = hooks(renderer)
    const showSpy = vi.spyOn(h.characterLayer, 'show').mockImplementation(() => {})
    const removeSpy = vi.spyOn(h.characterLayer, 'remove').mockImplementation(() => {})

    renderer.setSkipMode(true)
    h.processDirective({ CameraMode: { mode: 'Theater', orientation: null } })
    h.processDirective({
      Enter: {
        character: 'せお',
        expression: 'theo/normal',
        position: '左',
        fit: false,
        enter_direction: 'Kamite',
      },
    })
    h.processDirective({ Exit: { character: 'せお', exit_direction: 'Shimote' } })

    // instant: true は NovelRenderer が渡す（enterDirection/exitDirection 自体は cameraMode 通りに
    // 渡るが、instant: true が優先されるのは CharacterLayer.show/remove 側の責務。
    // CharacterLayer.test.ts の「instant: true なら従来通り即時表示/即座に破棄」で意味論を固定済み）。
    expect(showSpy).toHaveBeenCalledWith('せお', 'theo/normal', '左', '', {
      instant: true,
      xRatio: undefined,
      fit: false,
      enterDirection: 'Kamite',
      depth: 0,
    })
    expect(removeSpy).toHaveBeenCalledWith('せお', {
      instant: true,
      durationMsOverride: undefined,
      exitDirection: 'Shimote',
    })
  })
})
