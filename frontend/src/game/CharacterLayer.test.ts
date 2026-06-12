import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CHARACTER_Y_RATIO, CharacterLayer, normalizePosition } from './CharacterLayer'
import { CURSOR_DEFAULTS } from './textEffect'
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
    glyphs: Array<{ glyph: { visible: boolean } }>
    typewriter: { displayedCharCount: number; acc: number } | null
    settled: boolean
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

  // ---- #271 本丸: 非 instant の cursor=on でカーソルが生成され、点滅し続ける ----
  // positionCursor は glyph 幅を measureGlyphWidth でガード経由に読むため、jsdom（canvas 未
  // インストール）でも build が throw せず、素直に await できる（#271 S1）。

  it('cursor=on の非 instant タイプはカーソルを生成し、gfx を破棄しない', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', cursor: true, ms_per_char: 70 })
    const st = getTitleC(layer)
    expect(st.textEffect).not.toBeNull()
    // 1: カーソルが生成され state に乗る。
    expect(st.textEffect!.cursor).not.toBeNull()
    // 3: カーソル本体 Graphics は破棄されていない。
    expect(st.textEffect!.cursor!.gfx.destroyed).toBe(false)
  })

  it('生成されたカーソルの blinkMs は既定（CURSOR_DEFAULTS）になる', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', cursor: true, ms_per_char: 70 })
    const st = getTitleC(layer)
    // 2: blink_ms 未指定なので既定値。直書きせず定数を参照（陳腐化防止）。
    expect(st.textEffect!.cursor!.blinkMs).toBe(CURSOR_DEFAULTS.blinkMs)
  })

  it('カーソルがある限り hasActiveAnimation()===true（reveal 完了・settle 後も止まらない＝settle モデルの小例外）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', cursor: true, ms_per_char: 70 })
    const st = getTitleC(layer)
    const te = st.textEffect!
    // build 直後（reveal 進行中）でも、カーソルがあるので ticker は止められない。
    expect(layer.hasActiveAnimation()).toBe(true)
    // reveal を「完了 + settle 済み」に進める。isTextEffectActive は effect.cursor を
    // settled より先に見て true を返すので、完了・settle 後もカーソルがある限り active。
    te.typewriter = { ...te.typewriter!, displayedCharCount: te.glyphs.length, acc: 0 }
    te.settled = true
    for (const { glyph } of te.glyphs) glyph.visible = true
    // 4: reveal 完了 + settle 済みでも、カーソルが点滅し続けるため active のまま。
    expect(te.typewriter!.displayedCharCount).toBe(te.glyphs.length)
    expect(te.settled).toBe(true)
    expect(te.cursor).not.toBeNull()
    expect(layer.hasActiveAnimation()).toBe(true)
  })

  it('対比: カーソルなしで reveal 完了・settle すると hasActiveAnimation()===false（カーソルが唯一の active 要因）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    // cursor=off は positionCursor を呼ばないので素直に await できる。ms_per_char=0 で即時完了。
    await layer.applyTextEffect('Title', { effect: 'Typewriter', ms_per_char: 0 })
    const st = getTitleC(layer)
    expect(st.textEffect!.cursor).toBeNull()
    // カーソルが無い完了済み reveal は ticker を止められる ⇒ 上記の active はカーソル由来だと裏付く。
    expect(layer.hasActiveAnimation()).toBe(false)
  })

  // ---- #271 リーク回帰: カーソルで回り続けた ticker が破棄経路で確実に止まる ----

  it('remove(instant) でカーソルが破棄され hasActiveAnimation()===false に戻る（ticker リーク防止）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', cursor: true, ms_per_char: 70 })
    // カーソルが点滅で ticker を回し続けている。
    const cursorGfx = getTitleC(layer).textEffect!.cursor!.gfx
    expect(layer.hasActiveAnimation()).toBe(true)
    // remove(instant) → clearTextEffect → destroyCursor を通り、カーソルが破棄される。
    layer.remove('Title', { instant: true })
    // Title 自体が消え、カーソルの Graphics も破棄されている（リークしない）。
    expect((layer as unknown as { characters: Map<string, unknown> }).characters.has('Title')).toBe(
      false
    )
    expect(cursorGfx.destroyed).toBe(true)
    // active 要因が無くなったので ticker は止められる。
    expect(layer.hasActiveAnimation()).toBe(false)
  })

  it('showTitle のテキスト差し替えでカーソルが破棄され hasActiveAnimation()===false に戻る（ticker リーク防止）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', cursor: true, ms_per_char: 70 })
    const cursorGfx = getTitleC(layer).textEffect!.cursor!.gfx
    expect(layer.hasActiveAnimation()).toBe(true)
    // showTitle のテキスト差し替えは clearTextEffect → destroyCursor を通り、グリフ演出ごと破棄する。
    layer.showTitle('next', 'sans-serif')
    const st = getTitleC(layer)
    expect(st.textEffect).toBeNull()
    expect(cursorGfx.destroyed).toBe(true)
    // カーソルが消えたので ticker は止められる（点滅で回り続けない）。
    expect(layer.hasActiveAnimation()).toBe(false)
  })
})

// ===== #273: タイトル文字色（label / グリフ演出 / カーソルへの波及）=====
//
// showTitle(text, font, position?, color?) で解決した色を state.titleColor に保持し、
// 単一 label・爆発グリフ・タイプカーソルの全てへ波及させる。観測点は CPU 側で読める:
//   - titleColor:      characters.get('Title').titleColor（解決済み Pixi 数値カラー）
//   - label fill:      characters.get('Title').label.style.fill（PIXI Text.style、CPU 側）
//   - glyph fill:      textEffect.glyphs[i].glyph.style.fill
//   - cursor 色:       textEffect.cursor.colorNum（#273 で追加した一次情報の観測点）
// いずれも canvas/getContext を要さず jsdom で読める（CLAUDE.md doctrine: env-limit を盾にしない）。
//
// TITLE_FILL（白フォールバック）は private static のため、直書きせず 0xffffff を期待値にする。
// これは #270/#271 既存テストが TITLE_FILL=0xffffff を前提に書いているのと同じ流儀。
const TITLE_FILL = 0xffffff
const NAVY = 0x1a4a7a // orber OP/ED の紺タイトル #1a4a7a

interface TitleColorStateLike {
  titleColor?: number
  label?: { style: { fill: number }; text: string }
  textEffect: {
    glyphs: Array<{ glyph: { style: { fill: number } } }>
    cursor: { colorNum: number } | null
  } | null
}

describe('CharacterLayer title color (#273)', () => {
  // applyTextEffect / showTitle の async フォントロードを await で待てるよう document を null に。
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  function getTitleTC(layer: CharacterLayer): TitleColorStateLike {
    return (layer as unknown as { characters: Map<string, TitleColorStateLike> }).characters.get(
      'Title'
    )!
  }

  // ---- T1/T2: showTitle が color を解決して titleColor に保持する ----

  it('T1: color 指定で titleColor が解決済み数値（#1a4a7a → 0x1a4a7a）になる', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif', undefined, '#1a4a7a')
    expect(getTitleTC(layer).titleColor).toBe(NAVY)
  })

  it('T2: color 未指定なら titleColor は白フォールバック（TITLE_FILL=0xffffff）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    expect(getTitleTC(layer).titleColor).toBe(TITLE_FILL)
  })

  // ---- T3: 新規 Text 経路の label.fill ----

  it('T3: color 指定で新規生成 label の style.fill が 0x1a4a7a になる', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif', undefined, '#1a4a7a')
    expect(getTitleTC(layer).label!.style.fill).toBe(NAVY)
  })

  // ---- T4: 既存 Title へのテキスト差し替え（差し替え経路の label/titleColor 更新）----

  it('T4: 既存 Title に color 指定で差し替えると titleColor と label.style.fill が更新される', () => {
    const layer = new CharacterLayer(800, 450)
    // まず白で出す
    layer.showTitle('orber', 'sans-serif')
    expect(getTitleTC(layer).titleColor).toBe(TITLE_FILL)
    // 同名 Title へテキスト＋紺色で差し替え（differential 経路）
    layer.showTitle('ORBER', 'sans-serif', undefined, '#1a4a7a')
    const st = getTitleTC(layer)
    expect(st.label!.text).toBe('ORBER')
    expect(st.titleColor).toBe(NAVY)
    expect(st.label!.style.fill).toBe(NAVY)
  })

  // ---- T5: 本丸。color 指定 Title の爆発グリフ全てが紺になる ----

  it('T5: color 指定 Title に Explode → 全グリフの style.fill が 0x1a4a7a（本丸）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif', undefined, '#1a4a7a')
    await layer.applyTextEffect('Title', { effect: 'Explode' })
    const st = getTitleTC(layer)
    expect(st.textEffect).not.toBeNull()
    expect(st.textEffect!.glyphs.length).toBe(5) // o r b e r
    for (const { glyph } of st.textEffect!.glyphs) {
      expect(glyph.style.fill).toBe(NAVY)
    }
  })

  // ---- T6: color 未指定 Title の爆発グリフは白のまま（回帰防止）----

  it('T6: color 未指定 Title に Explode → 全グリフが白（TITLE_FILL）のまま', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Explode' })
    const st = getTitleTC(layer)
    for (const { glyph } of st.textEffect!.glyphs) {
      expect(glyph.style.fill).toBe(TITLE_FILL)
    }
  })

  // ---- T7: カーソル色未指定なら titleColor へ波及（DT-B2）----

  it('T7: color 指定 Title の Typewriter cursor=on（カーソル色なし）→ cursor.colorNum が titleColor(0x1a4a7a)', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif', undefined, '#1a4a7a')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', cursor: true, ms_per_char: 70 })
    const st = getTitleTC(layer)
    expect(st.textEffect!.cursor).not.toBeNull()
    // カーソル色未指定なので、グリフと同じ解決済みタイトル色（紺）にフォールバックする。
    expect(st.textEffect!.cursor!.colorNum).toBe(NAVY)
  })

  // ---- T8: カーソル色指定があれば titleColor より優先（DT-B3/B4）----

  it('T8: カーソル色指定（cursor_color=#ff0000）は titleColor より優先され colorNum=0xff0000', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif', undefined, '#1a4a7a')
    await layer.applyTextEffect('Title', {
      effect: 'Typewriter',
      cursor: true,
      cursor_color: '#ff0000',
      ms_per_char: 70,
    })
    const st = getTitleTC(layer)
    expect(st.textEffect!.cursor).not.toBeNull()
    // `カーソル色` 指定 > タイトル色 fallback。紺(0x1a4a7a)ではなく赤(0xff0000)が勝つ。
    expect(st.textEffect!.cursor!.colorNum).toBe(0xff0000)
  })

  // ---- T9: 紺 Title を color 未指定で差し替えると白へ戻る（前の色が残らない回帰）----

  it('T9: 紺 Title を color 未指定で差し替えると titleColor が白へ戻る（前色の残留なし）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif', undefined, '#1a4a7a')
    expect(getTitleTC(layer).titleColor).toBe(NAVY)
    // color を渡さずに差し替え → 解決は TITLE_FILL に倒れ、前の紺が残ってはならない。
    layer.showTitle('plain', 'sans-serif')
    const st = getTitleTC(layer)
    expect(st.titleColor).toBe(TITLE_FILL)
    expect(st.label!.style.fill).toBe(TITLE_FILL)
  })

  // ---- S3: 日本語＋サロゲートペア混じりタイトル＋色 → 全グリフへ色適用 ----

  it('S3: サロゲートペア混じりタイトル＋color → Array.from 分解した全グリフに 0x1a4a7a 適用', async () => {
    const layer = new CharacterLayer(800, 450)
    // "あ𝕏z" = ひらがな1 + 数学英字（サロゲートペア）1 + ASCII 1 = code point 3 つ。
    const title = 'あ𝕏z'
    expect(Array.from(title).length).toBe(3) // UTF-16 長は 4 だが code point は 3
    layer.showTitle(title, 'sans-serif', undefined, '#1a4a7a')
    await layer.applyTextEffect('Title', { effect: 'Explode' })
    const st = getTitleTC(layer)
    // Array.from 分解なのでサロゲートペアが割れず 3 グリフ。
    expect(st.textEffect!.glyphs.length).toBe(3)
    for (const { glyph } of st.textEffect!.glyphs) {
      expect(glyph.style.fill).toBe(NAVY)
    }
  })
})
