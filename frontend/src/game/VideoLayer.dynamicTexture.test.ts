// @vitest-environment node
/**
 * Pixi 実体で `Texture` の `dynamic` がサイズ確定の伝播を左右することを縛る (#980)。
 * VideoLayer 本体は video 要素・WebAudio に依存し実 Pixi では組み立てにくいため、VideoLayer が
 * `dynamic: true` を付ける根拠（dynamic の有無でサイズ確定が Sprite に届くか変わる）を実 Pixi の対照で守る。
 * VideoLayer 側の `dynamic: true` 指定自体は VideoLayer.error.test.ts が見る。
 */
import { describe, it, expect } from 'vitest'
import { Sprite, Texture, TextureSource } from 'pixi.js'

function boundsWidthAfterResize(dynamic: boolean): { before: number; after: number } {
  const source = new TextureSource({ width: 0, height: 0 })
  const sprite = new Sprite(new Texture({ source, dynamic }))
  const before = sprite.bounds.width
  source.resize(640, 360)
  return { before, after: sprite.bounds.width }
}

describe('Texture.dynamic とサイズ確定の伝播 (#980)', () => {
  it('dynamic: true ならサイズ確定後に Sprite の bounds が更新される', () => {
    expect(boundsWidthAfterResize(true).after).toBe(640)
  })

  it('dynamic: false ではサイズ確定が届かず bounds が固まる（対照）', () => {
    const { before, after } = boundsWidthAfterResize(false)
    expect(after).toBe(before)
    expect(after).not.toBe(640)
  })
})
