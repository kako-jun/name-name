/**
 * VideoLayer の端フェードマスク破棄・共有 (#791) のテスト。
 * pixi.js と canvas を最小スタブにして、「共有版を使うこと」「remove() が引数なし destroy() でマスクを壊すこと」を守る。
 * （Pixi 8.18.1 の Sprite.destroy は引数なし＝既定 false で texture に触れない。
 * 実際に落ちる/落ちないは jsdom では再現せず、実ブラウザで検証済み。）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('pixi.js', () => {
  class Container {
    children: unknown[] = []
    addChild(c: unknown) {
      this.children.push(c)
      return c
    }
  }
  class Sprite {
    texture: unknown
    x = 0
    y = 0
    width = 0
    height = 0
    mask: unknown = null
    removeFromParent = vi.fn()
    destroy = vi.fn()
    constructor(texture?: unknown) {
      this.texture = texture
    }
  }
  return {
    Container,
    Sprite,
    Texture: { from: () => ({ destroy: vi.fn(), source: { destroy: vi.fn() } }) },
    VideoSource: class {},
  }
})

import { VideoLayer } from './VideoLayer'
import { resetSharedEdgeFadeMasksForTest } from './edgeFadeMask'

type Internals = {
  applyMask(sprite: unknown, fade: unknown): void
  sprite: unknown
  maskSprite: {
    texture: { destroy: ReturnType<typeof vi.fn>; source: { destroy: ReturnType<typeof vi.fn> } }
    destroy: ReturnType<typeof vi.fn>
  } | null
}

beforeEach(() => {
  resetSharedEdgeFadeMasksForTest()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        fillRect: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      }) as never
  )
})

function newLayer(): { layer: VideoLayer; i: Internals } {
  const layer = new VideoLayer(100, 50)
  return { layer, i: layer as unknown as Internals }
}

describe('VideoLayer のマスク (#791)', () => {
  it('同じフェードで 2 回マスクを付けると、マスクの Texture は同一（共有版を使う）', () => {
    const a = newLayer()
    const b = newLayer()
    a.i.applyMask({}, { top: 10 })
    b.i.applyMask({}, { top: 10 })
    expect(a.i.maskSprite).not.toBe(b.i.maskSprite)
    expect(a.i.maskSprite!.texture).toBe(b.i.maskSprite!.texture)
  })

  it('remove() はマスク Sprite を引数なしで destroy() し、Texture / source は壊さない', () => {
    const { layer, i } = newLayer()
    i.applyMask({}, { top: 10 })
    const mask = i.maskSprite!
    layer.remove()
    expect(mask.destroy).toHaveBeenCalledTimes(1)
    expect(mask.destroy.mock.calls[0]).toEqual([])
    expect(mask.texture.destroy).not.toHaveBeenCalled()
    expect(mask.texture.source.destroy).not.toHaveBeenCalled()
    expect(i.maskSprite).toBeNull()
  })
})
