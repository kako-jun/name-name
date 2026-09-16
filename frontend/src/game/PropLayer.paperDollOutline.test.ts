/**
 * PropLayer 紙人形風輪郭 (#699) の単体テスト。
 *
 * PropLayer.test.ts の流儀（Assets.load モック・virtual TimeController・internals キャスト）を
 * 踏襲する。CharacterLayer と異なりこのレイヤーには他にフィルタ運用機構が無いため
 * （PropLayer.ts の `paperDollOutlineFilter` JSDoc 参照）、`sprite.filters = [filter] / null` の
 * 直代入だけで足りる——ここでは主に「ロード完了タイミング（既存/新規/未完了/disposed）との
 * 競合で例外を投げないか」を縛る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, type Texture } from 'pixi.js'
import { OutlineFilter } from 'pixi-filters'
import { PropLayer } from './PropLayer'
import { TimeController } from './TimeController'

const SCREEN_W = 800
const SCREEN_H = 450

function virtualTime(): TimeController {
  const t = new TimeController()
  t.setMode('virtual')
  return t
}

function mockTexture(width = SCREEN_W, height = SCREEN_H): Texture {
  return { width, height, source: { scaleMode: 'linear' } } as unknown as Texture
}

function mockAssetsLoadResolved(): void {
  vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
}

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface PropEntryForTest {
  sprite: { filters: unknown[] | null | undefined } | null
  disposed: boolean
}
interface PropLayerInternals {
  entries: PropEntryForTest[]
}
function internals(layer: PropLayer): PropLayerInternals {
  return layer as unknown as PropLayerInternals
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PropLayer.setPaperDollOutline() (#699)', () => {
  it('既存のロード済みエントリに反映され、以後 add() される新規エントリにも自動適用される', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('desk.png', 10, '/assets')
    await flushPromises()
    const existingEntry = internals(layer).entries[0]
    // 輪郭有効化前は一度も filters を触っていない（PixiJS 未設定既定値）。
    expect(existingEntry.sprite?.filters).toBeUndefined()

    layer.setPaperDollOutline({ color: '#111111', thickness: 2 })

    expect(existingEntry.sprite?.filters).toHaveLength(1)
    expect(existingEntry.sprite?.filters?.[0]).toBeInstanceOf(OutlineFilter)

    layer.add('chair.png', 5, '/assets')
    await flushPromises()
    const newEntry = internals(layer).entries[1]
    expect(newEntry.sprite?.filters).toHaveLength(1)
    expect(newEntry.sprite?.filters?.[0]).toBeInstanceOf(OutlineFilter)
  })

  it('テクスチャロードが未完了（entry.sprite=null）の状態で呼んでも例外を投げない', () => {
    vi.spyOn(Assets, 'load').mockReturnValue(new Promise<Texture>(() => {}) as never) // 永久pending
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('desk.png', 10, '/assets')
    expect(internals(layer).entries[0].sprite).toBeNull()

    expect(() => layer.setPaperDollOutline({ color: '#000000', thickness: 2 })).not.toThrow()
  })

  it('add() 後に clear() された disposed entry には、ロード完了時点でも sprite/フィルタが作られない', async () => {
    let resolveLoad!: (t: Texture) => void
    const pending = new Promise<Texture>((resolve) => {
      resolveLoad = resolve
    })
    vi.spyOn(Assets, 'load').mockReturnValue(pending as never)
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.setPaperDollOutline({ color: '#000000', thickness: 2 }) // 先に輪郭を有効化しておく
    layer.add('desk.png', 10, '/assets')
    const entry = internals(layer).entries[0]

    layer.clear() // disposed=true にする（sprite は元々 null のまま）
    expect(entry.disposed).toBe(true)

    resolveLoad(mockTexture())
    await expect(flushPromises()).resolves.toBeUndefined() // 例外を投げない

    expect(entry.sprite).toBeNull() // disposed ガードで sprite/filters とも作られない
  })

  it('setPaperDollOutline(null) で解除すると既存エントリの filters が null に戻る', async () => {
    mockAssetsLoadResolved()
    const layer = new PropLayer(SCREEN_W, SCREEN_H, virtualTime())
    layer.add('desk.png', 10, '/assets')
    await flushPromises()
    layer.setPaperDollOutline({ color: '#000000', thickness: 2 })
    const entry = internals(layer).entries[0]
    expect(entry.sprite?.filters).toHaveLength(1)

    layer.setPaperDollOutline(null)

    expect(entry.sprite?.filters).toBeNull()
  })
})
