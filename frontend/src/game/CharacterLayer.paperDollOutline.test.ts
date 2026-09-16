/**
 * CharacterLayer 紙人形風輪郭 (#699) の単体テスト。
 *
 * outlineFilter.ts の `createPaperDollOutlineFilter` 自体の生成ロジック（OutlineFilter への
 * 変換）は薄い純粋関数のため、ここでは検証しない。ここで縛るのは `CharacterLayer` 側の
 * `applySpriteFilters()` 集約関数——既存の `PixelateFilter` 運用 (#628) と紙人形輪郭 (#699) が
 * 独立に有効・無効になりうる中で、どちらかを set する際にもう一方の `sprite.filters` を
 * 破壊しないこと（デシジョンテーブル a〜d）が最重要のレビュー指摘対象。
 *
 * デシジョンテーブル (c/d) とその後続（遷移完了・輪郭だけ解除）は、`applySpriteFilters` /
 * `clearImagePixelateState` を internals キャストで直接呼び、`pixelateState`/`pixelateFilter` を
 * 直接セットして構成する。理由: 実プロダクションで `pixelateState` を持つのは
 * `showImage()`（render-only #274）経由の状態だけだが、`setPaperDollOutline()` の再適用ループは
 * render-only を明示的に除外する（JSDoc 参照）ため、`showImage()` を素直に使うと
 * 「d の状態から輪郭だけ setPaperDollOutline(null) で解除する」が render-only 除外に阻まれて
 * 再現できない（render-only 自体の除外仕様は別途「render-only は変化しない」テストで縛る）。
 * ここで検証したいのは純粋に `applySpriteFilters` の組み合わせロジックなので、
 * render-only 制約から切り離した非 render-only state で組み立てる。
 *
 * `sprite.filters` の観測は internals(r) キャストパターン（CharacterLayer.imagePixelate.test.ts
 * と同形）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OutlineFilter, PixelateFilter } from 'pixi-filters'
import { CharacterLayer } from './CharacterLayer'

interface PixelateStateLike {
  phase: 'coarsen' | 'holding' | 'refine'
}
interface CharacterStateLike {
  sprite: { filters: unknown[] | null | undefined; destroyed: boolean; destroy: () => void }
  renderOnly?: boolean
  pixelateState?: PixelateStateLike
  pixelateFilter?: PixelateFilter
}
interface CharacterLayerInternals {
  characters: Map<string, CharacterStateLike>
  paperDollOutlineFilter: unknown | null
  applySpriteFilters(state: CharacterStateLike): void
  clearImagePixelateState(state: CharacterStateLike): void
}
function internals(layer: CharacterLayer): CharacterLayerInternals {
  return layer as unknown as CharacterLayerInternals
}

describe('CharacterLayer.applySpriteFilters() デシジョンテーブル (#699)', () => {
  it('a: 紙人形輪郭off・ピクセレート遷移off → sprite.filtersはnull', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })

    const st = internals(layer).characters.get('hero')!
    expect(st.sprite.filters).toBeNull()
  })

  it('b: 紙人形輪郭on・ピクセレート遷移off → sprite.filtersはOutlineFilterのみ', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })

    layer.setPaperDollOutline({ color: '#000000', thickness: 3 })

    const st = internals(layer).characters.get('hero')!
    expect(st.sprite.filters).toHaveLength(1)
    expect(st.sprite.filters![0]).toBeInstanceOf(OutlineFilter)
  })

  it('c: 紙人形輪郭off・ピクセレート遷移中 → sprite.filtersはPixelateFilterのみ', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    const st = internals(layer).characters.get('hero')!
    const pf = new PixelateFilter(1)
    st.pixelateFilter = pf
    st.pixelateState = { phase: 'coarsen' }
    internals(layer).applySpriteFilters(st)

    expect(st.sprite.filters).toEqual([pf])
  })

  it('d: 紙人形輪郭on・ピクセレート遷移中 → sprite.filtersはOutlineFilterとPixelateFilterの両方が共存する（輪郭が先）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.setPaperDollOutline({ color: '#000000', thickness: 3 })
    const st = internals(layer).characters.get('hero')!
    const pf = new PixelateFilter(1)
    st.pixelateFilter = pf
    st.pixelateState = { phase: 'coarsen' }
    internals(layer).applySpriteFilters(st)

    expect(st.sprite.filters).toHaveLength(2)
    expect(st.sprite.filters![0]).toBeInstanceOf(OutlineFilter)
    expect(st.sprite.filters![1]).toBe(pf)
  })
})

describe('CharacterLayer.setPaperDollOutline() の付随挙動 (#699)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('呼び出し後に新規 show() したキャラクターにも自動適用される（内部stateとして保持されているかの直接検証）', () => {
    const layer = new CharacterLayer(800, 450)

    // まだキャラクターが1体も無い状態で先に輪郭を有効化する。
    layer.setPaperDollOutline({ color: '#ff0000', thickness: 5 })
    const heldFilter = internals(layer).paperDollOutlineFilter
    expect(heldFilter).toBeInstanceOf(OutlineFilter)

    layer.show('newhero', 'normal', '中央', '/assets', { instant: true })

    const st = internals(layer).characters.get('newhero')!
    // createPortraitState が内部保持していたインスタンスをそのまま使い回している。
    expect(st.sprite.filters).toEqual([heldFilter])
  })

  it('dの状態からピクセレート遷移が完了する（clearImagePixelateState相当）と filters が輪郭のみに戻る', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.setPaperDollOutline({ color: '#000000', thickness: 3 })
    const st = internals(layer).characters.get('hero')!
    const pf = new PixelateFilter(1)
    st.pixelateFilter = pf
    st.pixelateState = { phase: 'coarsen' }
    internals(layer).applySpriteFilters(st)
    expect(st.sprite.filters).toHaveLength(2) // d の状態が成立している

    // ピクセレート遷移完了の後始末（clearImagePixelateState は pixelateState を外し、
    // pixelateFilter.size を1に戻し、applySpriteFilters を呼び直す）。
    internals(layer).clearImagePixelateState(st)

    expect(st.pixelateState).toBeUndefined()
    expect(st.sprite.filters).toHaveLength(1)
    expect(st.sprite.filters![0]).toBeInstanceOf(OutlineFilter)
  })

  it('dの状態から setPaperDollOutline(null) で輪郭だけ解除すると filters がピクセレートのみに戻る', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.setPaperDollOutline({ color: '#000000', thickness: 3 })
    const st = internals(layer).characters.get('hero')!
    const pf = new PixelateFilter(1)
    st.pixelateFilter = pf
    st.pixelateState = { phase: 'coarsen' }
    internals(layer).applySpriteFilters(st)
    expect(st.sprite.filters).toHaveLength(2) // d の状態が成立している

    layer.setPaperDollOutline(null)

    expect(st.sprite.filters).toEqual([pf])
  })

  it('setPaperDollOutline(null) で解除後、他フィルタが無ければ sprite.filters が null に戻る', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.setPaperDollOutline({ color: '#000000', thickness: 3 })
    const st = internals(layer).characters.get('hero')!
    expect(st.sprite.filters).toHaveLength(1)

    layer.setPaperDollOutline(null)

    expect(st.sprite.filters).toBeNull()
  })

  it('退場フェード中（destroyOnComplete予約、sprite未破棄）のキャラクターに setPaperDollOutline が呼ばれても例外を投げない', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.remove('hero') // 非instant → フェードアウト予約。sprite はまだ破棄されず characters にも残る。
    expect(internals(layer).characters.get('hero')?.sprite.destroyed).toBe(false)

    expect(() => layer.setPaperDollOutline({ color: '#000000', thickness: 2 })).not.toThrow()
  })

  it('sprite破棄済みだが内部stateがcharactersマップに残存する状態でも setPaperDollOutline は例外を投げない（applySpriteFiltersのsprite.destroyedガード）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    const st = internals(layer).characters.get('hero')!
    // 通常経路（remove の instant 分岐）は destroyCharacterState と characters.delete をセットで
    // 行うため sprite 破棄済み state が Map に残ることは無いが、applySpriteFilters 自体の
    // `sprite.destroyed` ガードを直接検証するため、ここでは sprite だけを破棄して map エントリを
    // あえて残す（想定外レースの再現）。
    st.sprite.destroy()

    expect(() => layer.setPaperDollOutline({ color: '#000000', thickness: 2 })).not.toThrow()
  })

  it('render-only（showTitle/showLabel/showImageのFade経路）で生成したスプライトは紙人形輪郭が有効でもfiltersが変化しない', () => {
    const layer = new CharacterLayer(800, 450)
    layer.setPaperDollOutline({ color: '#000000', thickness: 3 }) // 先に輪郭を有効化しておく

    layer.showTitle('タイトル', 'sans-serif')
    layer.showLabel({ text: 'ラベル', fontFamily: 'sans-serif' })
    // assetBaseUrl 空文字列 = 描画できないので loadTexture が即 no-op になる経路（Fade経路、
    // transition 未指定なので startImagePixelateTransition は通らない）。
    layer.showImage({ id: 'plainimg', path: 'a.png', assetBaseUrl: '' })

    // render-only は createPortraitState 経由でないため applySpriteFilters を一度も通らず、
    // sprite.filters は PixiJS の未設定既定値（undefined、effectsMixin 参照）のまま
    // ——「null に変わる」のではなく「一切触られない」ことを確認する。
    expect(internals(layer).characters.get('Title')!.sprite.filters).toBeUndefined()
    expect(internals(layer).characters.get('Label')!.sprite.filters).toBeUndefined()
    expect(internals(layer).characters.get('plainimg')!.sprite.filters).toBeUndefined()
  })
})
