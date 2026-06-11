import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CHARACTER_Y_RATIO, CharacterLayer, normalizePosition } from './CharacterLayer'
import { __setDocumentForTest, resetFontLoaderCache } from './FontLoader'

interface FadeAnimationLike {
  fromAlpha: number
  toAlpha: number
  destroyOnComplete: boolean
}

interface CharacterStateLike {
  sprite: { alpha: number; x: number; y: number }
  fadeAnimation: FadeAnimationLike | null
}

interface CharacterLayerInternals {
  characters: Map<string, CharacterStateLike>
}

function asInternals(layer: CharacterLayer): CharacterLayerInternals {
  return layer as unknown as CharacterLayerInternals
}

describe('CharacterLayer fade (Issue #177)', () => {
  it('show() の新規表示は alpha 0 から fade-in を開始する', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets')
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    expect(state!.sprite.alpha).toBe(0)
    expect(state!.fadeAnimation).not.toBeNull()
    expect(state!.fadeAnimation!.fromAlpha).toBe(0)
    expect(state!.fadeAnimation!.toAlpha).toBe(1)
    expect(state!.fadeAnimation!.destroyOnComplete).toBe(false)
  })

  it('show() に instant: true を渡すと alpha 1 で即時表示し fadeAnimation は無し', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    const state = asInternals(layer).characters.get('hero')
    expect(state!.sprite.alpha).toBe(1)
    expect(state!.fadeAnimation).toBeNull()
  })

  it('remove() のデフォルトは fade-out（destroyOnComplete=true）に切り替えるだけ', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.remove('hero')
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    expect(state!.fadeAnimation).not.toBeNull()
    expect(state!.fadeAnimation!.toAlpha).toBe(0)
    expect(state!.fadeAnimation!.destroyOnComplete).toBe(true)
  })

  it('remove() に instant: true を渡すと characters から即座に消える', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.remove('hero', { instant: true })
    expect(asInternals(layer).characters.has('hero')).toBe(false)
  })

  it('退場フェード中の同名キャラ再 show は fade-in に切り替える', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.remove('hero')
    // 退場フェード中
    layer.show('hero', 'normal', '中央', '/assets')
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    expect(state!.fadeAnimation).not.toBeNull()
    expect(state!.fadeAnimation!.toAlpha).toBe(1)
    expect(state!.fadeAnimation!.destroyOnComplete).toBe(false)
  })
})

describe('normalizePosition', () => {
  it('日本語の position を英語 key に正規化する', () => {
    expect(normalizePosition('左')).toBe('left')
    expect(normalizePosition('中央')).toBe('center')
    expect(normalizePosition('右')).toBe('right')
  })

  it('「真ん中」「中」も中央扱いにする', () => {
    expect(normalizePosition('真ん中')).toBe('center')
    expect(normalizePosition('中')).toBe('center')
  })

  it('英語表記はそのまま通す', () => {
    expect(normalizePosition('left')).toBe('left')
    expect(normalizePosition('center')).toBe('center')
    expect(normalizePosition('right')).toBe('right')
  })

  it('英語の大文字違いを正規化する', () => {
    expect(normalizePosition('Left')).toBe('left')
    expect(normalizePosition('Center')).toBe('center')
    expect(normalizePosition('Centre')).toBe('center')
    expect(normalizePosition('Right')).toBe('right')
  })

  it('未知の値はそのまま返す (CharacterLayer 側で center にフォールバック)', () => {
    expect(normalizePosition('foo')).toBe('foo')
  })

  it('空文字は center に倒す', () => {
    expect(normalizePosition('')).toBe('center')
  })

  it('日本語の揺れ (左寄り / 左端 / 真中 / まんなか / 右寄り / 右端) を吸収する', () => {
    expect(normalizePosition('左寄り')).toBe('left')
    expect(normalizePosition('左端')).toBe('left')
    expect(normalizePosition('真中')).toBe('center')
    expect(normalizePosition('まんなか')).toBe('center')
    expect(normalizePosition('右寄り')).toBe('right')
    expect(normalizePosition('右端')).toBe('right')
  })
})

describe('CharacterLayer portrait mode (Issue #209)', () => {
  it('足元 Y は screenHeight * CHARACTER_Y_RATIO になる（縦長モードでも比率追従）', () => {
    // CHARACTER_Y_RATIO は #210 後に 380/450 → 1.0 へ変更（足元を画面下端に下げる意図）。
    // 期待値は定数を直に参照して陳腐化を防ぐ（旧 `800*(380/450)≒676` 直書きの教訓・#262）。
    const layer = new CharacterLayer(450, 800)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    expect(state!.sprite.y).toBeCloseTo(800 * CHARACTER_Y_RATIO, 5)
  })
})

describe('CharacterLayer X position ratio (Issue #216)', () => {
  it('9:16（screenWidth=450）で center の sprite.x が 450 * 0.5 = 225 になる', () => {
    const layer = new CharacterLayer(450, 800)
    layer.show('hero', 'normal', 'center', '/assets', { instant: true })
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    expect(state!.sprite.x).toBeCloseTo(225, 0)
  })

  it('16:9（screenWidth=800）で center の sprite.x が 800 * 0.5 = 400 になる', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', 'center', '/assets', { instant: true })
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    expect(state!.sprite.x).toBeCloseTo(400, 0)
  })
})

interface GlyphEntryLike {
  glyph: { alpha: number; scale: { x: number }; visible: boolean; destroyed: boolean }
  restX: number
  restY: number
}

interface TextEffectStateLike {
  textEffect: {
    glyphs: GlyphEntryLike[]
    transform: unknown
    typewriter: unknown
  } | null
  label?: { visible: boolean; text: string }
}

describe('CharacterLayer applyTextEffect (#268)', () => {
  // applyTextEffect はフォント確定後（ensureFontLoaded）にグリフを構築する (#268 question8)。
  // document を null にすると ensureFontLoaded は即 resolve するため、await でグリフ構築を待てる。
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  function getTitle(layer: CharacterLayer): TextEffectStateLike {
    return (layer as unknown as { characters: Map<string, TextEffectStateLike> }).characters.get(
      'Title'
    )!
  }

  it('タイトル文字数ぶんのグリフに分解し、単一 label は隠す', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Explode' })
    const st = getTitle(layer)
    expect(st.textEffect).not.toBeNull()
    expect(st.textEffect!.glyphs.length).toBe(5) // o r b e r
    expect(st.textEffect!.transform).not.toBeNull()
    expect(st.label!.visible).toBe(false)
  })

  it('instant: true は全グリフを整列・不透明・全可視の静止状態にする（ADR 0002 復元）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Explode' }, { instant: true })
    const st = getTitle(layer)
    expect(st.textEffect).not.toBeNull()
    for (const { glyph } of st.textEffect!.glyphs) {
      expect(glyph.alpha).toBe(1)
      expect(glyph.scale.x).toBe(1)
      expect(glyph.visible).toBe(true)
    }
  })

  it('タイプ効果は transform を持たず typewriter 状態を持つ', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('$ orber.llll-ll.com', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', ms_per_char: 70 })
    const st = getTitle(layer)
    expect(st.textEffect!.transform).toBeNull()
    expect(st.textEffect!.typewriter).not.toBeNull()
  })

  it('showTitle でテキストを差し替えると進行中のグリフ演出は破棄され label が再表示される', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Explode' })
    expect(getTitle(layer).textEffect).not.toBeNull()
    layer.showTitle('next', 'sans-serif')
    const st = getTitle(layer)
    expect(st.textEffect).toBeNull()
    expect(st.label!.visible).toBe(true)
    expect(st.label!.text).toBe('next')
  })

  it('対象が存在しない / label が空なら no-op', async () => {
    const layer = new CharacterLayer(800, 450)
    // 対象なし
    await expect(layer.applyTextEffect('NoSuch', { effect: 'Explode' })).resolves.toBeUndefined()
    // 空タイトル（showTitle は空文字で退場するので Title 自体が無い）
    layer.showTitle('', 'sans-serif')
    await expect(layer.applyTextEffect('Title', { effect: 'Explode' })).resolves.toBeUndefined()
  })

  it('instant: true のタイプ効果は全グリフを可視にする（reveal の即時完了）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter' }, { instant: true })
    const st = getTitle(layer)
    expect(st.textEffect).not.toBeNull()
    for (const { glyph } of st.textEffect!.glyphs) {
      expect(glyph.visible).toBe(true)
    }
  })

  it('applyTextEffect を再適用すると前のグリフ列を破棄して貼り直す（重複しない）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Explode' })
    const first = getTitle(layer).textEffect!.glyphs
    expect(first.length).toBe(5)
    // 同じ Title へ別効果を再適用しても、グリフ数は文字数ぶんのまま（積み増しされない）。
    await layer.applyTextEffect('Title', { effect: 'Typewriter' })
    const st = getTitle(layer)
    expect(st.textEffect!.glyphs.length).toBe(5)
    expect(st.textEffect!.transform).toBeNull() // タイプへ切替済み
    expect(st.textEffect!.typewriter).not.toBeNull()
  })

  it('remove(instant) はグリフ container を破棄して Title を characters から消す（ADR0002 破棄）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Explode' })
    const glyphs = getTitle(layer).textEffect!.glyphs
    layer.remove('Title', { instant: true })
    // Title 自体が消える
    expect((layer as unknown as { characters: Map<string, unknown> }).characters.has('Title')).toBe(
      false
    )
    // グリフ Text も破棄される（UAF / 幽霊グリフ防止）
    for (const { glyph } of glyphs) {
      expect(glyph.destroyed).toBe(true)
    }
  })

  it('clear() はグリフ container を破棄して全キャラを消す', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Explode' })
    const glyphs = getTitle(layer).textEffect!.glyphs
    layer.clear()
    expect((layer as unknown as { characters: Map<string, unknown> }).characters.size).toBe(0)
    for (const { glyph } of glyphs) {
      expect(glyph.destroyed).toBe(true)
    }
  })
})

// ===== #270: applyUnderline（下線ビーム）=====
interface UnderlineStateLike {
  underline: {
    gfx: { scale: { x: number }; destroyed: boolean; parent: unknown }
    resolved: { durationMs: number }
    settled: boolean
  } | null
  label?: { text: string }
}

describe('CharacterLayer applyUnderline (#270)', () => {
  // applyUnderline はフォント確定後（ensureFontLoaded）に線を構築する。
  // document を null にすると ensureFontLoaded は即 resolve するため await で構築を待てる。
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  function getTitleU(layer: CharacterLayer): UnderlineStateLike {
    return (layer as unknown as { characters: Map<string, UnderlineStateLike> }).characters.get(
      'Title'
    )!
  }

  it('タイトル表示後に下線を適用すると Graphics が生成され進行中は scale.x<1 で始まる', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyUnderline('Title', {})
    const st = getTitleU(layer)
    expect(st.underline).not.toBeNull()
    expect(st.underline!.gfx.destroyed).toBe(false)
    // 初期フレームを反映してから ticker を回すので、伸長中は scale.x<1（まだ伸び切っていない）。
    expect(st.underline!.gfx.scale.x).toBeLessThan(1)
    expect(st.underline!.settled).toBe(false)
  })

  it('instant: true は伸び切った静止線（scale.x=1, settled）になる（ADR0002 復元）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyUnderline('Title', {}, { instant: true })
    const st = getTitleU(layer)
    expect(st.underline).not.toBeNull()
    expect(st.underline!.gfx.scale.x).toBe(1)
    expect(st.underline!.settled).toBe(true)
  })

  it('target 不在 / 空タイトルは no-op（silent skip、下線を作らない）', async () => {
    const layer = new CharacterLayer(800, 450)
    // 対象なし
    await expect(layer.applyUnderline('NoSuch', {})).resolves.toBeUndefined()
    // 空タイトルは Title 自体が無い
    layer.showTitle('', 'sans-serif')
    await expect(layer.applyUnderline('Title', {})).resolves.toBeUndefined()
    expect((layer as unknown as { characters: Map<string, unknown> }).characters.has('Title')).toBe(
      false
    )
  })

  it('showTitle でテキストを差し替えると下線は破棄される（幅が変わるため）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyUnderline('Title', {}, { instant: true })
    const gfx = getTitleU(layer).underline!.gfx
    layer.showTitle('next', 'sans-serif')
    const st = getTitleU(layer)
    expect(st.underline).toBeNull()
    expect(gfx.destroyed).toBe(true)
  })

  it('再適用すると前の線を破棄して貼り直す（重複しない）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyUnderline('Title', {}, { instant: true })
    const first = getTitleU(layer).underline!.gfx
    await layer.applyUnderline('Title', {}, { instant: true })
    const second = getTitleU(layer).underline!.gfx
    expect(first.destroyed).toBe(true) // 旧線は破棄
    expect(second.destroyed).toBe(false)
    expect(second).not.toBe(first)
  })

  it('remove(instant) は下線 Graphics を破棄して Title を消す', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyUnderline('Title', {}, { instant: true })
    const gfx = getTitleU(layer).underline!.gfx
    layer.remove('Title', { instant: true })
    expect((layer as unknown as { characters: Map<string, unknown> }).characters.has('Title')).toBe(
      false
    )
    expect(gfx.destroyed).toBe(true)
  })
})

// ===== #271: 点滅カーソル（効果=タイプ 専用）=====
interface CursorTitleLike {
  textEffect: {
    cursor: { gfx: { destroyed: boolean }; blinkMs: number } | null
  } | null
}

describe('CharacterLayer cursor (#271)', () => {
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  function getTitleC(layer: CharacterLayer): CursorTitleLike {
    return (layer as unknown as { characters: Map<string, CursorTitleLike> }).characters.get(
      'Title'
    )!
  }

  // 注意: カーソル「生成あり」の非 instant 経路（cursor=on で settle せずに保持）は、
  // buildTextEffect → updateTextEffectFrame(0) → positionCursor が glyph.width を読むため、
  // canvas 無しの jsdom（CanvasTextMetrics.measureFont）でクラッシュする。これは production
  // バグではなく純粋にテスト環境（canvas 未インストール）の観測限界。カーソル生成条件・点滅・
  // 解決値そのものは textEffect.test.ts の resolveCursor / cursorVisible で厚くカバーする。
  // ここでは glyph.width を読まない instant / cursor=off 経路だけを CharacterLayer 配線として検証する。

  it('cursor=off（既定）のタイプはカーソルを持たず、完了すれば ticker は止められる', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', ms_per_char: 0 })
    const st = getTitleC(layer)
    expect(st.textEffect!.cursor).toBeNull()
    expect(layer.hasActiveAnimation()).toBe(false)
  })

  it('instant(skip) はカーソル=on でもカーソルなしの静止全表示に畳む（#271 ADR0002）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', cursor: true }, { instant: true })
    const st = getTitleC(layer)
    expect(st.textEffect).not.toBeNull()
    // skip はカーソルを破棄（cursor=null）し、点滅も走らせないので ticker は止められる。
    expect(st.textEffect!.cursor).toBeNull()
    expect(layer.hasActiveAnimation()).toBe(false)
  })

  it('reveal でない効果（爆発）はカーソル=on を指定してもカーソルを作らない', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    // 爆発は reveal でないので resolveCursor.enabled=false → buildCursor は null。
    // 爆発経路は positionCursor を呼ばないため glyph.width に触れずクラッシュしない。
    await layer.applyTextEffect('Title', { effect: 'Explode', cursor: true }, { instant: true })
    const st = getTitleC(layer)
    expect(st.textEffect!.cursor).toBeNull()
  })
})
