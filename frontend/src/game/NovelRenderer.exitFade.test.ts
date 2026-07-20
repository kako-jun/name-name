import { describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event } from '../types'

interface RendererExitFadeHooks {
  processDirective(event: Event): void
  characterLayer: {
    remove: (
      character: string,
      options?: { instant?: boolean; durationMsOverride?: number }
    ) => void
  }
}

function hooks(renderer: NovelRenderer): RendererExitFadeHooks {
  return renderer as unknown as RendererExitFadeHooks
}

describe('NovelRenderer character exit fade override', () => {
  it('passes [退場: name, フェード=N] fade_ms to CharacterLayer.remove only for that exit', () => {
    const renderer = new NovelRenderer()
    const h = hooks(renderer)
    const removeSpy = vi.spyOn(h.characterLayer, 'remove').mockImplementation(() => {})

    h.processDirective({ Exit: { character: 'ヴィンチア', fade_ms: 2100 } })

    expect(removeSpy).toHaveBeenCalledWith('ヴィンチア', {
      instant: false,
      durationMsOverride: 2100,
    })
  })

  it('keeps legacy [退場: name] on the runtime character_fade_ms path', () => {
    const renderer = new NovelRenderer()
    const h = hooks(renderer)
    const removeSpy = vi.spyOn(h.characterLayer, 'remove').mockImplementation(() => {})

    h.processDirective({ Exit: { character: 'トモ', fade_ms: null } })

    expect(removeSpy).toHaveBeenCalledWith('トモ', {
      instant: false,
      durationMsOverride: undefined,
    })
  })
})
