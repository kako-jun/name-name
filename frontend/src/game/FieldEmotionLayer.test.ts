/**
 * フィールドの感情吹き出しの描画層 (#937): 頭上に出る・時間で消える・置き換わる・画像が読めない種類は出さない・追従する。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BufferImageSource, Texture } from 'pixi.js'
import { FieldEmotionLayer } from './FieldEmotionLayer'
import type { EmotionSheet, EmotionSheets } from './fieldEmotion'

function sheetTexture(frames: number, cell = 16, h = 20): Texture {
  const source = new BufferImageSource({
    resource: new Uint8Array(cell * frames * h * 4),
    width: cell * frames,
    height: h,
  })
  return new Texture({ source })
}
const sh = (over: Partial<EmotionSheet> = {}): EmotionSheet => ({
  image: 'a.png',
  frames: 1,
  columns: 1,
  frameMs: 100,
  durationMs: 1000,
  offset: { x: 0, y: -4 },
  scale: 1,
  motion: 'none',
  ...over,
})

const created: FieldEmotionLayer[] = []
function setup(emotions: EmotionSheets, textures: Map<string, Texture | null>) {
  const l = new FieldEmotionLayer(emotions, textures)
  created.push(l)
  return l
}
afterEach(() => {
  while (created.length) created.pop()?.destroy({ children: true })
})

const heads = { player: { x: 100, y: 80 }, companion: null }

describe('FieldEmotionLayer', () => {
  it('出すと頭上（下端中央 = 頭 + offset）に置かれ、時間で消える', () => {
    const l = setup({ '!': sh() }, new Map([['a.png', sheetTexture(1)]]))
    expect(l.children).toHaveLength(0)
    expect(l.show('player', '!')).toBe(true)
    l.tick(0, heads)
    const sp = l.children[0] as unknown as { x: number; y: number; visible: boolean }
    expect([sp.x, sp.y, sp.visible]).toEqual([100, 76, true])
    l.tick(500, heads)
    expect(sp.visible).toBe(true)
    l.tick(500, heads)
    expect(sp.visible).toBe(false)
    expect(l.active()).toEqual({})
  })

  it('show の第3引数で 1 回だけ持続を上書きし、省略は宣言どおり（#946）', () => {
    const l = setup({ '!': sh() }, new Map([['a.png', sheetTexture(1)]])) // 宣言は 1000ms
    expect(l.show('player', '!', 300)).toBe(true)
    l.tick(299, heads)
    expect(l.active().player?.durationMs).toBe(300)
    l.tick(1, heads)
    expect(l.active()).toEqual({})
    l.show('player', '!')
    l.tick(999, heads)
    expect(l.active().player?.kind).toBe('!')
    l.tick(1, heads)
    expect(l.active()).toEqual({})
  })

  it('人物が動けば追従する（毎フレームの頭の位置に置き直す）', () => {
    const l = setup({ '!': sh() }, new Map([['a.png', sheetTexture(1)]]))
    l.show('player', '!')
    l.tick(16, heads)
    l.tick(16, { player: { x: 140, y: 60 }, companion: null })
    const sp = l.children[0] as unknown as { x: number; y: number }
    expect([sp.x, sp.y]).toEqual([140, 56])
  })

  it('吹き出しの不透明度は人物の alpha に連動する（省略は 1）', () => {
    const l = setup({ '!': sh() }, new Map([['a.png', sheetTexture(1)]]))
    l.show('companion', '!')
    l.tick(16, { player: null, companion: { x: 10, y: 10, alpha: 0.4 } })
    const sp = l.children[0] as unknown as { alpha: number }
    expect(sp.alpha).toBeCloseTo(0.4)
    l.tick(16, { player: null, companion: { x: 10, y: 10 } })
    expect(sp.alpha).toBe(1)
  })

  it('同じ人物に続けて出すと 1 つに置き換わる（Sprite は増えない）', () => {
    const l = setup(
      { '!': sh(), '?': sh({ image: 'b.png', durationMs: 300 }) },
      new Map([
        ['a.png', sheetTexture(1)],
        ['b.png', sheetTexture(1)],
      ])
    )
    l.show('player', '!')
    l.tick(600, heads)
    l.show('player', '?')
    l.tick(0, heads)
    expect(l.children).toHaveLength(1)
    expect(l.active()).toEqual({ player: { kind: '?', elapsed: 0 } })
    l.tick(299, heads)
    expect(l.active().player?.kind).toBe('?')
    l.tick(1, heads)
    expect(l.active()).toEqual({})
  })

  it('主人公と同行者に同時に出せる。同行者が出ていない（head が null）間は描かない', () => {
    const l = setup({ '!': sh() }, new Map([['a.png', sheetTexture(1)]]))
    l.show('player', '!')
    l.show('companion', '!')
    l.tick(10, heads)
    expect(l.children).toHaveLength(1) // 同行者は head が null
    l.tick(10, { player: { x: 1, y: 50 }, companion: { x: 30, y: 50 } })
    expect(l.children).toHaveLength(2)
    expect(l.children.map((c) => c.visible)).toEqual([true, true])
  })

  it('画像が読めなかった種類・未宣言の種類は出さない（false）。ほかの種類は出せる', () => {
    const l = setup(
      { '!': sh(), '?': sh({ image: 'missing.png' }) },
      new Map<string, Texture | null>([
        ['a.png', sheetTexture(1)],
        ['missing.png', null],
      ])
    )
    expect(l.show('player', '?')).toBe(false)
    expect(l.show('player', 'zzz')).toBe(false)
    expect(l.show('player', 'constructor')).toBe(false)
    l.tick(10, heads)
    expect(l.children).toHaveLength(0)
    expect(l.show('player', '!')).toBe(true)
  })

  it('画像が読めなかった種類を出そうとしても、出ていた別の吹き出しを消さない', () => {
    const l = setup(
      { '!': sh(), '?': sh({ image: 'missing.png' }) },
      new Map<string, Texture | null>([
        ['a.png', sheetTexture(1)],
        ['missing.png', null],
      ])
    )
    l.show('player', '!')
    l.show('player', '?')
    expect(l.active().player?.kind).toBe('!')
  })

  it('コマ割りシートはコマを送る（3 コマ・100ms）', () => {
    const l = setup({ d: sh({ frames: 3, columns: 3 }) }, new Map([['a.png', sheetTexture(3)]]))
    l.show('player', 'd')
    const frameX = () => (l.children[0] as unknown as { texture: Texture }).texture.frame.x
    l.tick(0, heads)
    expect(frameX()).toBe(0)
    l.tick(100, heads)
    expect(frameX()).toBe(16)
    l.tick(100, heads)
    expect(frameX()).toBe(32)
  })

  it('pop は小さい所から大きくなる。scale 宣言が掛かる', () => {
    const l = setup({ '!': sh({ motion: 'pop', scale: 2 }) }, new Map([['a.png', sheetTexture(1)]]))
    l.show('player', '!')
    l.tick(0, heads)
    const sp = l.children[0] as unknown as { scale: { x: number } }
    expect(sp.scale.x).toBeCloseTo(0.8)
    l.tick(200, heads)
    expect(sp.scale.x).toBeCloseTo(2)
  })

  it('clear で全部消える', () => {
    const l = setup({ '!': sh() }, new Map([['a.png', sheetTexture(1)]]))
    l.show('player', '!')
    l.tick(10, heads)
    l.clear()
    expect(l.active()).toEqual({})
    expect(l.children.every((c) => !c.visible)).toBe(true)
  })

  it('吹き出しは歩行に関与しない: 層は位置を読むだけで、渡した heads を書き換えない', () => {
    const l = setup({ '!': sh() }, new Map([['a.png', sheetTexture(1)]]))
    const h = { player: { x: 5, y: 9 }, companion: null }
    l.show('player', '!')
    l.tick(10, h)
    expect(h).toEqual({ player: { x: 5, y: 9 }, companion: null })
  })

  it('NPC (npc:<id>) の頭上にも出る。主人公と独立で、頭が無い・消えた NPC は隠れる（#946）', () => {
    const l = setup({ '!': sh() }, new Map([['a.png', sheetTexture(1)]]))
    expect(l.show('npc:kid', '!')).toBe(true)
    expect(l.show('player', '!')).toBe(true)
    const h = { ...heads, 'npc:kid': { x: 300, y: 200 } }
    l.tick(0, h)
    const vis = l.children.filter((c) => c.visible) as unknown as { x: number; y: number }[]
    expect(vis.map((c) => [c.x, c.y]).sort()).toEqual([
      [100, 76],
      [300, 196],
    ])
    expect(Object.keys(l.active()).sort()).toEqual(['npc:kid', 'player'])
    // 頭が渡されない（別シーンの NPC など）と隠れるが、時間は進む
    l.tick(500, heads)
    expect(l.children.filter((c) => c.visible)).toHaveLength(1)
    l.tick(500, h)
    expect(l.children.filter((c) => c.visible)).toHaveLength(0)
    expect(l.active()).toEqual({})
  })
})
