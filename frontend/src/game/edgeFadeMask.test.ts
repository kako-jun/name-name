/**
 * edgeFadeMask の共有 Texture キャッシュ (#791) のテスト。
 * jsdom には WebGL / 2D canvas が無いので pixi.js と canvas を最小スタブにして、キーと共有・破棄の契約だけ検証する。
 * 実際の描画落ち（AlphaMaskEffect の束縛破棄）は実ブラウザでしか再現しない。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const textureFromMock = vi.fn()
vi.mock('pixi.js', () => {
  class Sprite {
    texture: unknown
    x = 0
    y = 0
    width = 0
    height = 0
    destroy = vi.fn()
    constructor(texture: unknown) {
      this.texture = texture
    }
  }
  return { Sprite, Texture: { from: (c: unknown) => textureFromMock(c) } }
})

import {
  getSharedEdgeFadeMask,
  buildEdgeFadeMask,
  resetSharedEdgeFadeMasksForTest,
} from './edgeFadeMask'

function fakeCtx() {
  return {
    fillRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: '',
    globalCompositeOperation: '',
  }
}

beforeEach(() => {
  resetSharedEdgeFadeMasksForTest()
  textureFromMock.mockReset()
  textureFromMock.mockImplementation(() => ({ destroy: vi.fn(), source: { destroy: vi.fn() } }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeCtx() as never)
})

describe('getSharedEdgeFadeMask', () => {
  it('fade が null / 全端 0 なら null（Texture も作らない）', () => {
    expect(getSharedEdgeFadeMask(null, 100, 50)).toBeNull()
    expect(getSharedEdgeFadeMask({ top: 0 }, 100, 50)).toBeNull()
    expect(textureFromMock).not.toHaveBeenCalled()
  })

  it('同じ画面サイズ × フェード指定なら Texture は共有し、Sprite は毎回別物', () => {
    const a = getSharedEdgeFadeMask({ top: 10, left: 5 }, 100, 50)!
    const b = getSharedEdgeFadeMask({ top: 10, left: 5 }, 100, 50)!
    expect(textureFromMock).toHaveBeenCalledTimes(1)
    expect(a).not.toBe(b)
    expect(a.texture).toBe(b.texture)
  })

  it('画面サイズ・フェード指定が違えば別 Texture', () => {
    const a = getSharedEdgeFadeMask({ top: 10 }, 100, 50)!
    const sizeDiff = getSharedEdgeFadeMask({ top: 10 }, 200, 50)!
    const fadeDiff = getSharedEdgeFadeMask({ bottom: 10 }, 100, 50)!
    expect(textureFromMock).toHaveBeenCalledTimes(3)
    expect(a.texture).not.toBe(sizeDiff.texture)
    expect(a.texture).not.toBe(fadeDiff.texture)
  })

  it('キーは丸めた画面サイズで引く（小数差は同じ Texture）', () => {
    const a = getSharedEdgeFadeMask({ top: 10 }, 100.2, 50.4)!
    const b = getSharedEdgeFadeMask({ top: 10 }, 99.8, 49.6)!
    expect(a.texture).toBe(b.texture)
  })

  it('Sprite を destroy() しても共有 Texture / source は壊れず、次も同じ Texture を返す', () => {
    const a = getSharedEdgeFadeMask({ top: 10 }, 100, 50)!
    const tex = a.texture as unknown as {
      destroy: ReturnType<typeof vi.fn>
      source: { destroy: ReturnType<typeof vi.fn> }
    }
    a.destroy()
    expect(tex.destroy).not.toHaveBeenCalled()
    expect(tex.source.destroy).not.toHaveBeenCalled()
    const b = getSharedEdgeFadeMask({ top: 10 }, 100, 50)!
    expect(b.texture).toBe(a.texture)
    expect(textureFromMock).toHaveBeenCalledTimes(1)
  })

  it('2D コンテキストが取れないときは null を返し、覚えない', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
    expect(getSharedEdgeFadeMask({ top: 10 }, 100, 50)).toBeNull()
    expect(textureFromMock).not.toHaveBeenCalled()
  })
})

describe('buildEdgeFadeMask（従来版・BackgroundController 用）は共有しない', () => {
  it('呼ぶたびに新しい Texture を作る', () => {
    buildEdgeFadeMask({ top: 10 }, 100, 50)
    buildEdgeFadeMask({ top: 10 }, 100, 50)
    expect(textureFromMock).toHaveBeenCalledTimes(2)
  })
})
