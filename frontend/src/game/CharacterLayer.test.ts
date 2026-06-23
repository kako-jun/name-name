import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Assets } from 'pixi.js'
import {
  CHARACTER_Y_RATIO,
  CharacterLayer,
  normalizePosition,
  alignToAnchorX,
  computeFitScale,
} from './CharacterLayer'
import { CURSOR_DEFAULTS } from './textEffect'
import { ASPECT_RATIOS } from './constants'
import { __setDocumentForTest, resetFontLoaderCache } from './FontLoader'
import { saveSlotToGameState } from './novelLayout'
import { SaveManager, type SaveSlotData } from './SaveManager'

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

describe('CharacterLayer showLabel / showImage (#274)', () => {
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  interface CharsInternals {
    characters: Map<
      string,
      {
        sprite: { x: number; y: number; alpha: number }
        label?: { text: string; style: { fontSize: number; fill: number } }
        renderOnly?: boolean
        fadeAnimation: { fromAlpha: number; toAlpha: number } | null
      }
    >
  }
  function chars(layer: CharacterLayer): CharsInternals {
    return layer as unknown as CharsInternals
  }

  it('showLabel は id で登録し、色・サイズ・2D 位置を反映してフェードインする', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({
      id: 'division',
      text: 'Planning Div. 42',
      color: '#7a9abf',
      position: '中上',
      size: 16,
      fontFamily: 'sans-serif',
    })
    const st = chars(layer).characters.get('division')
    expect(st).toBeDefined()
    // 位置: 中上 = (x=0.5, y=0.34) を screen に掛ける。
    expect(st!.sprite.x).toBe(800 * 0.5)
    expect(st!.sprite.y).toBeCloseTo(450 * 0.34, 5)
    // 色・サイズが label に反映される。
    expect(st!.label!.text).toBe('Planning Div. 42')
    expect(st!.label!.style.fontSize).toBe(16)
    expect(st!.label!.style.fill).toBe(0x7a9abf)
    // 登場フェードイン（alpha 0 → 1）。
    expect(st!.sprite.alpha).toBe(0)
    expect(st!.fadeAnimation).not.toBeNull()
    expect(st!.fadeAnimation!.toAlpha).toBe(1)
  })

  it('showLabel フェードイン完了で label.alpha が toAlpha(=1) に揃う（sprite と同期）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'name', text: 'kako-jun', fontFamily: 'sans-serif' })
    // 内部 ticker を完了まで決定論的に駆動する（elapsedMs を fade 期間より先へ進めて 1 フレーム更新）。
    const internal = layer as unknown as {
      animTicker: { update: () => void } | null
      elapsedMs: number
      characters: Map<string, { sprite: { alpha: number }; label?: { alpha: number } }>
    }
    internal.elapsedMs += 10000
    internal.animTicker?.update()
    const st = internal.characters.get('name')!
    // 完了フレームで sprite だけでなく label も toAlpha(=1) に揃う。
    // 進行中フレームのみ同期して完了で揃え忘れると label.alpha が半透明で固定される回帰。
    expect(st.sprite.alpha).toBe(1)
    expect(st.label!.alpha).toBe(1)
  })

  it('複数 id のラベルが共存できる', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'division', text: 'div', fontFamily: 'sans-serif' })
    layer.showLabel({ id: 'name', text: 'kako-jun', fontFamily: 'sans-serif' })
    expect(chars(layer).characters.has('division')).toBe(true)
    expect(chars(layer).characters.has('name')).toBe(true)
  })

  it('showLabel id 未指定は既定キー "Label"、size 未指定は 24', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ text: 'hi', fontFamily: 'sans-serif' })
    const st = chars(layer).characters.get('Label')
    expect(st).toBeDefined()
    expect(st!.label!.style.fontSize).toBe(24)
  })

  it('showLabel に空文字を渡すと既存ラベルを退場させる', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'x', text: 'hi', fontFamily: 'sans-serif', instant: true })
    expect(chars(layer).characters.has('x')).toBe(true)
    layer.showLabel({ id: 'x', text: '', fontFamily: 'sans-serif' })
    expect(chars(layer).characters.has('x')).toBe(false)
  })

  it('showImage は id で登録し 2D 位置を反映、フェードインする', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showImage({ id: 'avatar', path: 'a.png', position: '上', assetBaseUrl: '/assets' })
    const st = chars(layer).characters.get('avatar')
    expect(st).toBeDefined()
    expect(st!.sprite.x).toBe(800 * 0.5)
    expect(st!.sprite.y).toBeCloseTo(450 * 0.16, 5)
    expect(st!.sprite.alpha).toBe(0)
    expect(st!.fadeAnimation!.toAlpha).toBe(1)
  })

  it('Label / Image は renderOnly で getCharacterStates に漏れない（立ち絵だけ残る）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.showLabel({ id: 'division', text: 'div', fontFamily: 'sans-serif' })
    layer.showImage({ id: 'avatar', path: 'a.png', assetBaseUrl: '/assets' })
    layer.showTitle('orber', 'sans-serif')
    const states = layer.getCharacterStates()
    // 立ち絵 hero だけが snapshot に乗る。Title / Label / Image は render-only で除外。
    expect(states.map((s) => s.name)).toEqual(['hero'])
  })

  it('renderOnly フラグが Title / Label / Image に立つ', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'l', text: 'x', fontFamily: 'sans-serif' })
    layer.showImage({ id: 'i', path: 'a.png', assetBaseUrl: '/assets' })
    layer.showTitle('t', 'sans-serif')
    expect(chars(layer).characters.get('l')!.renderOnly).toBe(true)
    expect(chars(layer).characters.get('i')!.renderOnly).toBe(true)
    expect(chars(layer).characters.get('Title')!.renderOnly).toBe(true)
  })
})

// =====================================================================================
// #275: 揃え (align) / 隣接 (後ろ=after) / 位置 override (x/y) / タイトル サイズ。
//   ED の 2 色インストール行（プロンプト灰 + コマンド青タイプ + カーソル）を組むための配線。
//   観測は characters Map 直読み（anchorX / titleFontSize / label.anchor / textEffect.container.x）。
// =====================================================================================
describe('CharacterLayer alignToAnchorX (#275)', () => {
  it('left=0 / center=0.5 / right=1。未指定・未知は中央 0.5', () => {
    expect(alignToAnchorX('left')).toBe(0)
    expect(alignToAnchorX('center')).toBe(0.5)
    expect(alignToAnchorX('right')).toBe(1)
    expect(alignToAnchorX(undefined)).toBe(0.5)
    expect(alignToAnchorX('斜め')).toBe(0.5)
  })
})

describe('CharacterLayer 揃え/隣接/位置 override (#275)', () => {
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  interface LabelInternals {
    characters: Map<
      string,
      {
        sprite: { x: number; y: number }
        label?: { anchor: { x: number; y: number }; text: string; style: { fontSize: number } }
        anchorX?: number
        titleFontSize?: number
        textEffect: {
          container: { x: number }
          glyphs: { restX: number }[]
          cursor: { gfx: { x: number; destroyed: boolean } } | null
        } | null
      }
    >
  }
  function chars(layer: CharacterLayer): LabelInternals {
    return layer as unknown as LabelInternals
  }

  // measureGlyphWidth は jsdom（canvas 未インストール）で TITLE_FONT_SIZE(64)*0.6 = 38.4 の
  // 決定論 fallback を返す（#271 と同じ）。fontSize に依らず定数なので厳密値で縛れる。
  const GLYPH_W = 64 * 0.6 // 38.4

  it('揃え=左 で label.anchor.x=0、state.anchorX=0（静止ラベルが左に寄る）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'l', text: 'hi', fontFamily: 'sans-serif', align: 'left' })
    const st = chars(layer).characters.get('l')!
    expect(st.label!.anchor.x).toBe(0)
    expect(st.anchorX).toBe(0)
  })

  it('揃え=右 で anchor.x=1、揃え未指定は中央 0.5（現状維持）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'r', text: 'hi', fontFamily: 'sans-serif', align: 'right' })
    layer.showLabel({ id: 'c', text: 'hi', fontFamily: 'sans-serif' })
    expect(chars(layer).characters.get('r')!.anchorX).toBe(1)
    expect(chars(layer).characters.get('c')!.anchorX).toBe(0.5)
  })

  it('x/y override が position トークンより優先される（厳密配置）', () => {
    const layer = new CharacterLayer(800, 450)
    // position 中下 = (0.5, 0.64) だが x=0.36, y=0.62 で上書き。
    layer.showLabel({
      id: 'p',
      text: '$',
      fontFamily: 'sans-serif',
      position: '中下',
      x: 0.36,
      y: 0.62,
    })
    const st = chars(layer).characters.get('p')!
    expect(st.sprite.x).toBeCloseTo(800 * 0.36, 5)
    expect(st.sprite.y).toBeCloseTo(450 * 0.62, 5)
  })

  it('範囲外 x はトークンにフォールバック（落ちない）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'p', text: '$', fontFamily: 'sans-serif', position: '中央', x: 1.5 })
    const st = chars(layer).characters.get('p')!
    // x=1.5 は無効 → トークン 中央(0.5)。
    expect(st.sprite.x).toBeCloseTo(800 * 0.5, 5)
  })

  it('後ろ=参照 で自動左揃え＋参照ラベルの右端に左端を接続（同 y）', () => {
    const layer = new CharacterLayer(800, 450)
    // プロンプト（左揃え・厳密配置）。
    layer.showLabel({
      id: 'prompt',
      text: '$ ',
      fontFamily: 'sans-serif',
      align: 'left',
      x: 0.36,
      y: 0.62,
    })
    const prompt = chars(layer).characters.get('prompt')!
    // 参照ラベルの measure 幅（jsdom では measureGlyphWidth が fontSize*0.6 にフォールバック）。
    // anchorX=0（左揃え）なので右端 = sprite.x + width。
    // コマンド（後ろ=prompt）。
    layer.showLabel({
      id: 'cmd',
      text: 'cargo install orber',
      fontFamily: 'sans-serif',
      color: '#2b6cb0',
      after: 'prompt',
    })
    const cmd = chars(layer).characters.get('cmd')!
    // 自動左揃え。
    expect(cmd.anchorX).toBe(0)
    // y は参照と同じ。
    expect(cmd.sprite.y).toBeCloseTo(prompt.sprite.y, 5)
    // x は参照の右端（prompt.sprite.x より右）。参照は左揃えなので右端 = x + width > x。
    expect(cmd.sprite.x).toBeGreaterThan(prompt.sprite.x)
  })

  it('後ろ=存在しない参照 は通常配置にフォールバックする（落ちない）', () => {
    const layer = new CharacterLayer(800, 450)
    expect(() =>
      layer.showLabel({
        id: 'cmd',
        text: 'x',
        fontFamily: 'sans-serif',
        after: 'nonexistent',
      })
    ).not.toThrow()
    const st = chars(layer).characters.get('cmd')!
    // 自動左揃えは after 指定だけで立つ（参照不在でも）。
    expect(st.anchorX).toBe(0)
  })

  // #3: computeAfterAnchor の右端式 `x + (1-anchorX)*w` を参照の揃え別に厳密値で縛る。
  //   measureGlyphWidth は jsdom で GLYPH_W(38.4) の定数 fallback なので右端を直接計算できる。
  //   左揃え参照だけでなく中央・右揃え参照でも検証し、`(1-anchorX)` を `anchorX` に
  //   書き間違えたら（左↔右が反転して）落ちる強さにする。
  it.each([
    ['left', 0, 1 - 0], // 左揃え参照: 右端 = sprite.x + 1.0*w
    ['center', 0.5, 1 - 0.5], // 中央揃え参照: 右端 = sprite.x + 0.5*w
    ['right', 1, 1 - 1], // 右揃え参照: 右端 = sprite.x（sprite.x が右端）
  ] as const)(
    '後ろ= の左端は参照(%s)の右端 sprite.x + (1-anchorX)*w に厳密一致する',
    (align, refAnchorX, factor) => {
      const layer = new CharacterLayer(800, 450)
      layer.showLabel({ id: 'ref', text: '$ ', fontFamily: 'sans-serif', align, x: 0.4, y: 0.5 })
      const ref = chars(layer).characters.get('ref')!
      expect(ref.anchorX).toBe(refAnchorX)
      layer.showLabel({ id: 'cmd', text: 'cargo', fontFamily: 'sans-serif', after: 'ref' })
      const cmd = chars(layer).characters.get('cmd')!
      // 右端 = ref.sprite.x + (1-anchorX)*GLYPH_W。緩い不等号でなく厳密値で縛る。
      expect(cmd.sprite.x).toBeCloseTo(ref.sprite.x + factor * GLYPH_W, 5)
      // y は参照と同じ行。
      expect(cmd.sprite.y).toBeCloseTo(ref.sprite.y, 5)
    }
  )

  it('左揃えラベルにタイプ演出を当てるとグリフ群が左へオフセットする（container.x>0）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'cmd', text: 'abc', fontFamily: 'sans-serif', align: 'left' })
    await layer.applyTextEffect('cmd', { effect: 'Typewriter' })
    const st = chars(layer).characters.get('cmd')!
    expect(st.textEffect).not.toBeNull()
    // 左揃え（anchorX=0）→ glyphAnchorOffset = +totalWidth/2 > 0。
    // 'abc' は 3 グリフ・各 GLYPH_W → totalWidth=3*GLYPH_W → container.x=1.5*GLYPH_W。
    expect(st.textEffect!.container.x).toBeCloseTo(1.5 * GLYPH_W, 5)
  })

  it('中央揃えラベル（既定）のタイプ演出は container.x=0（従来挙動）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'cmd', text: 'abc', fontFamily: 'sans-serif' })
    await layer.applyTextEffect('cmd', { effect: 'Typewriter' })
    const st = chars(layer).characters.get('cmd')!
    expect(st.textEffect!.container.x).toBe(0)
  })

  // #2 本丸: 左揃えタイプのカーソル「頭位置」が中央揃えと異なる（左端オフセット後に乗る）。
  //   cursor.gfx.x（container ローカル）はどちらも先頭グリフ左端で同値だが、container.x の
  //   左端オフセットが効くため、container 適用後の頭位置（container.x + cursor.gfx.x）が
  //   左揃えと中央揃えで異なる。#271 に倣い cursor.gfx を観測（jsdom で throw せず gfx に乗る）。
  it('左揃えタイプのカーソル頭位置（container.x+gfx.x）は中央揃えと異なり、左端基準に乗る', async () => {
    // 中央揃え（既定）。
    const center = new CharacterLayer(800, 450)
    center.showLabel({ id: 'cmd', text: 'abc', fontFamily: 'sans-serif' })
    await center.applyTextEffect('cmd', { effect: 'Typewriter', cursor: true })
    const cTe = chars(center).characters.get('cmd')!.textEffect!
    expect(cTe.cursor).not.toBeNull()
    // 開始直後（displayed=0）はカーソルが先頭グリフ左端。'abc' は 3 グリフ・各 GLYPH_W:
    // 先頭中心 restX = -GLYPH_W、その左端 = restX - GLYPH_W/2 = -1.5*GLYPH_W（container ローカル）。
    const cHead = cTe.container.x + cTe.cursor!.gfx.x
    // 中央揃えは container.x=0 なので頭位置 = -1.5*GLYPH_W。
    expect(cHead).toBeCloseTo(-1.5 * GLYPH_W, 5)

    // 左揃え。
    const left = new CharacterLayer(800, 450)
    left.showLabel({ id: 'cmd', text: 'abc', fontFamily: 'sans-serif', align: 'left' })
    await left.applyTextEffect('cmd', { effect: 'Typewriter', cursor: true })
    const lTe = chars(left).characters.get('cmd')!.textEffect!
    expect(lTe.cursor).not.toBeNull()
    const lHead = lTe.container.x + lTe.cursor!.gfx.x
    // 左揃えは container.x=+1.5*GLYPH_W シフト → 頭位置 = 1.5*GLYPH_W + (-1.5*GLYPH_W) = 0。
    // ラベル左端（sprite 原点 0）に先頭グリフ左端がちょうど乗る（左から右へタイプする起点）。
    expect(lHead).toBeCloseTo(0, 5)
    // 左揃え ≠ 中央揃え（左端オフセットぶんだけ右へ寄る）。緩い不等号でなく差で縛る。
    expect(lHead - cHead).toBeCloseTo(1.5 * GLYPH_W, 5)
  })

  it('showImage の x/y override が position トークンより優先される', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showImage({ id: 'av', path: 'a.png', position: '上', assetBaseUrl: '/a', x: 0.2, y: 0.8 })
    const st = chars(layer).characters.get('av')!
    expect(st.sprite.x).toBeCloseTo(800 * 0.2, 5)
    expect(st.sprite.y).toBeCloseTo(450 * 0.8, 5)
  })

  it('showTitle サイズ= で label.fontSize と titleFontSize が反映される（既定 64）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('gitpp', 'sans-serif', undefined, '#1a4a7a', { size: 56 })
    const st = chars(layer).characters.get('Title')!
    expect(st.label!.style.fontSize).toBe(56)
    expect(st.titleFontSize).toBe(56)
    // 別タイトルで size 未指定なら既定 64。
    const layer2 = new CharacterLayer(800, 450)
    layer2.showTitle('orber', 'sans-serif')
    expect(chars(layer2).characters.get('Title')!.titleFontSize).toBe(64)
  })

  it('showTitle x/y override で sprite/label が ratio 配置される（positionX スロット経路を上書き）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif', undefined, undefined, { x: 0.3, y: 0.4 })
    const st = chars(layer).characters.get('Title')!
    expect(st.sprite.x).toBeCloseTo(800 * 0.3, 5)
    expect(st.sprite.y).toBeCloseTo(450 * 0.4, 5)
    expect(st.label!.anchor.x).toBe(0.5)
  })

  // #274: タイトルも縦位置トークンを尊重する（label/image と同系統。opening.html の縦スタック内ツール名）。
  it('showTitle が縦位置トークンを尊重する（中下=横中央・縦0.64、左下=結合、横のみ・無指定は縦中央で無回帰）', () => {
    // 縦のみ `中下` → 横は中央(0.5)・縦は 0.64。
    const lv = new CharacterLayer(800, 450)
    lv.showTitle('orber', 'sans-serif', '中下')
    const sv = chars(lv).characters.get('Title')!
    expect(sv.sprite.x).toBeCloseTo(800 * 0.5, 5)
    expect(sv.sprite.y).toBeCloseTo(450 * 0.64, 5)
    // 結合 `左下` → 横 0.1875・縦 0.84。
    const lc = new CharacterLayer(800, 450)
    lc.showTitle('orber', 'sans-serif', '左下')
    const sc = chars(lc).characters.get('Title')!
    expect(sc.sprite.x).toBeCloseTo(800 * 0.1875, 5)
    expect(sc.sprite.y).toBeCloseTo(450 * 0.84, 5)
    // 横のみ `左` → 縦は中央 0.5 のまま（従来挙動・無回帰）。x は positionX スロットと同値。
    const lh = new CharacterLayer(800, 450)
    lh.showTitle('orber', 'sans-serif', '左')
    const sh = chars(lh).characters.get('Title')!
    expect(sh.sprite.x).toBeCloseTo(800 * 0.1875, 5)
    expect(sh.sprite.y).toBeCloseTo(450 * 0.5, 5)
    // 無指定 → 画面中央（0.5, 0.5）で従来どおり。
    const ld = new CharacterLayer(800, 450)
    ld.showTitle('orber', 'sans-serif')
    const sd = chars(ld).characters.get('Title')!
    expect(sd.sprite.x).toBeCloseTo(800 * 0.5, 5)
    expect(sd.sprite.y).toBeCloseTo(450 * 0.5, 5)
  })

  it('タイトル サイズ= がグリフ演出グリフの fontSize に波及する', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('ab', 'sans-serif', undefined, undefined, { size: 32 })
    await layer.applyTextEffect('Title', { effect: 'Explode' })
    const internal = layer as unknown as {
      characters: Map<
        string,
        { textEffect: { glyphs: { glyph: { style: { fontSize: number } } }[] } | null }
      >
    }
    const te = internal.characters.get('Title')!.textEffect!
    expect(te.glyphs.length).toBeGreaterThan(0)
    for (const g of te.glyphs) {
      expect(g.glyph.style.fontSize).toBe(32)
    }
  })
})

// =====================================================================================
// #274 追加: showLabel 差し替え・演出対象・既定値、showImage の async load（Assets モック）、
//            render-only 復元の往復。観測は既存流儀の characters Map 直読みで取る。
// =====================================================================================

// flushPromises: showImage の `Assets.load(url).then(...)` を解決させる。
// setTimeout(0) で macrotask 1 回まわすと、解決済み Promise の .then チェーンも消化される。
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface LabelStateLike {
  sprite: { x: number; y: number; alpha: number }
  label?: {
    text: string
    visible: boolean
    style: { fontSize: number; fill: number }
    x: number
    y: number
  }
  textEffect: unknown
  underline: unknown
  fadeAnimation: { toAlpha: number } | null
}
function labelChars(layer: CharacterLayer): { characters: Map<string, LabelStateLike> } {
  return layer as unknown as { characters: Map<string, LabelStateLike> }
}

describe('CharacterLayer showLabel 差し替え・演出対象・既定 (#274)', () => {
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  // 5: 同 id 差し替え（textEffect 進行中）→ clearTextEffect が呼ばれ textEffect=null・text 更新。
  it('同 id 差し替えは進行中の文字演出を破棄し textEffect=null・label.text を更新する', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'name', text: 'kako-jun', fontFamily: 'sans-serif' })
    await layer.applyTextEffect('name', { effect: 'Explode' })
    expect(labelChars(layer).characters.get('name')!.textEffect).not.toBeNull()
    // 同 id へテキスト差し替え。clearTextEffect を通って演出は畳まれる。
    layer.showLabel({ id: 'name', text: 'NEXT', fontFamily: 'sans-serif' })
    const st = labelChars(layer).characters.get('name')!
    expect(st.textEffect).toBeNull()
    expect(st.label!.text).toBe('NEXT')
    expect(st.label!.visible).toBe(true)
  })

  // 6: 同 id 差し替え → text/位置/色/サイズ新値・sprite.x/y と label.x/y を両方更新。
  it('同 id 差し替えで text・色・サイズ・2D 位置を新値にし、sprite と label の x/y を両更新する', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({
      id: 'name',
      text: 'old',
      color: '#111111',
      position: '上',
      size: 16,
      fontFamily: 'sans-serif',
    })
    layer.showLabel({
      id: 'name',
      text: 'new',
      color: '#abcdef',
      position: '下',
      size: 40,
      fontFamily: 'sans-serif',
    })
    const st = labelChars(layer).characters.get('name')!
    expect(st.label!.text).toBe('new')
    expect(st.label!.style.fill).toBe(0xabcdef)
    expect(st.label!.style.fontSize).toBe(40)
    // 下 = (x=0.5, y=0.84)。sprite と label の両方が新位置に動く。
    expect(st.sprite.x).toBe(800 * 0.5)
    expect(st.sprite.y).toBeCloseTo(450 * 0.84, 5)
    expect(st.label!.x).toBe(800 * 0.5)
    expect(st.label!.y).toBeCloseTo(450 * 0.84, 5)
  })

  // 7: 本丸。ラベルが `[文字演出: id]` の対象になれる（applyTextEffect 後 textEffect!==null）。
  //    showLabel は label Text を作るので、Title と同様グリフ演出を貼れる。
  it('本丸: ラベルは文字演出の対象になれる（applyTextEffect 後 textEffect が立つ）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'name', text: 'kako-jun', fontFamily: 'sans-serif' })
    await layer.applyTextEffect('name', { effect: 'Explode' })
    expect(labelChars(layer).characters.get('name')!.textEffect).not.toBeNull()
  })

  // 8: ラベルが `[下線: id]` の対象になれる（applyUnderline 後 underline!==null）。
  it('ラベルは下線の対象になれる（applyUnderline 後 underline が立つ）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'name', text: 'kako-jun', fontFamily: 'sans-serif' })
    await layer.applyUnderline('name', {})
    expect(labelChars(layer).characters.get('name')!.underline).not.toBeNull()
  })

  // 9: color 未指定 → label.style.fill===0xffffff（白フォールバック）。
  it('color 未指定なら label.style.fill は白（0xffffff）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'name', text: 'hi', fontFamily: 'sans-serif' })
    expect(labelChars(layer).characters.get('name')!.label!.style.fill).toBe(0xffffff)
  })

  // 10: position 未指定 → 中央 (0.5, 0.5)。
  it('position 未指定なら中央 (0.5, 0.5) に置く', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'name', text: 'hi', fontFamily: 'sans-serif' })
    const st = labelChars(layer).characters.get('name')!
    expect(st.sprite.x).toBe(800 * 0.5)
    expect(st.sprite.y).toBe(450 * 0.5)
  })

  // 11: instant:true（skipMode 相当）→ alpha=1・fadeAnimation=null。
  it('instant:true は alpha=1 で即時表示し fadeAnimation を持たない（skip）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showLabel({ id: 'name', text: 'hi', fontFamily: 'sans-serif', instant: true })
    const st = labelChars(layer).characters.get('name')!
    expect(st.sprite.alpha).toBe(1)
    expect(st.fadeAnimation).toBeNull()
  })
})

interface ImageStateLike {
  sprite: {
    x: number
    y: number
    alpha: number
    scale: { x: number; y: number }
    mask: unknown
    texture: unknown
  }
  maskGraphics?: { destroyed: boolean; scale: { x: number; y: number } }
  fadeAnimation: unknown
  position: string
  label?: unknown
  textEffect: unknown
}
function imageChars(layer: CharacterLayer): { characters: Map<string, ImageStateLike> } {
  return layer as unknown as { characters: Map<string, ImageStateLike> }
}

describe('CharacterLayer showImage async load (Assets モック) (#274)', () => {
  // showImage は `Assets.load(url).then(...)` の非同期部分（texture セット / アスペクトスケール /
  // 円形マスク / mask 半径 / scale 打ち消し / clearMask）が本丸。Assets.load をモックして
  // 偽 texture を解決させ、flushPromises で .then を消化してから観測する（doctrine session627）。
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  // 偽 texture（{width,height} だけ持てば showImage のアスペクト計算には十分）。
  const fakeTexture = (width: number, height: number): unknown => ({ width, height })

  // 12: url 解決。Assets.load が resolveAssetUrl(base,'images',path) の実値で呼ばれる。
  it('Assets.load は resolveAssetUrl(base, "images", path) の実 URL で呼ばれる', async () => {
    const loadSpy = vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(10, 10) as never)
    const layer = new CharacterLayer(800, 450)
    layer.showImage({ id: 'x', path: 'avatar.png', assetBaseUrl: '/assets' })
    await flushPromises()
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledWith('/assets/images/avatar.png')
  })

  it('Assets.load の URL 解決は先頭スラッシュを 1 つ落とす（resolveAssetUrl 準拠）', async () => {
    const loadSpy = vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(10, 10) as never)
    const layer = new CharacterLayer(800, 450)
    layer.showImage({ id: 'x', path: '/avatar.png', assetBaseUrl: 'https://cdn.example.com' })
    await flushPromises()
    expect(loadSpy).toHaveBeenCalledWith('https://cdn.example.com/images/avatar.png')
  })

  // 13: 円形マスク。load 解決後 sprite.mask セット・maskGraphics に入る・半径=表示幅/2。
  it('円形は load 解決後に sprite.mask をセットし maskGraphics を持つ', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(200, 100) as never)
    const layer = new CharacterLayer(800, 450)
    layer.showImage({
      id: 'avatar',
      path: 'a.png',
      shape: '円形',
      size: 160,
      assetBaseUrl: '/assets',
    })
    // load 解決前はまだ mask なし（同期部分では円形マスクを張らない）。
    expect(imageChars(layer).characters.get('avatar')!.maskGraphics).toBeUndefined()
    await flushPromises()
    const st = imageChars(layer).characters.get('avatar')!
    expect(st.maskGraphics).toBeDefined()
    expect(st.sprite.mask).toBe(st.maskGraphics)
    // texture も解決後に張られる。
    expect(st.sprite.texture).toEqual({ width: 200, height: 100 })
  })

  it('円形マスクの半径は表示幅/2（size=160 → Graphics.circle 半径 80）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(200, 100) as never)
    // Graphics.circle の引数（半径）を捕捉する。jsdom でも circle().fill() は throw しない。
    const { Graphics } = await import('pixi.js')
    const circleSpy = vi.spyOn(Graphics.prototype, 'circle')
    const layer = new CharacterLayer(800, 450)
    layer.showImage({
      id: 'avatar',
      path: 'a.png',
      shape: '円形',
      size: 160,
      assetBaseUrl: '/assets',
    })
    await flushPromises()
    // 円形マスク生成時に circle(0, 0, radius) が呼ばれる。radius = displayWidth/2 = 160/2 = 80。
    expect(circleSpy).toHaveBeenCalledWith(0, 0, 80)
  })

  // 14: size 指定でアスペクト維持スケール（scale.x===scale.y===size/texture.width）＋mask の scale 打ち消し。
  it('size 指定はアスペクト維持スケール（size/texture.width）で、mask が sprite.scale を打ち消す', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(200, 100) as never)
    const layer = new CharacterLayer(800, 450)
    layer.showImage({
      id: 'avatar',
      path: 'a.png',
      shape: '円形',
      size: 160,
      assetBaseUrl: '/assets',
    })
    await flushPromises()
    const st = imageChars(layer).characters.get('avatar')!
    // scale = size / texture.width = 160/200 = 0.8（x/y 等しい＝アスペクト維持）。
    expect(st.sprite.scale.x).toBeCloseTo(0.8, 5)
    expect(st.sprite.scale.y).toBeCloseTo(0.8, 5)
    // mask は sprite の子なので sprite.scale が二重に効く。mask.scale で 1/0.8 を当てて打ち消す。
    expect(st.maskGraphics!.scale.x).toBeCloseTo(1 / 0.8, 5)
    expect(st.maskGraphics!.scale.y).toBeCloseTo(1 / 0.8, 5)
  })

  // 15: size 未指定で自然サイズ（scale=1,1）・矩形（mask なし）。
  it('size 未指定は自然サイズ（scale=1,1）で矩形（mask を張らない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(200, 100) as never)
    const layer = new CharacterLayer(800, 450)
    // shape を渡さない＝矩形。
    layer.showImage({ id: 'rect', path: 'a.png', assetBaseUrl: '/assets' })
    await flushPromises()
    const st = imageChars(layer).characters.get('rect')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
    // 矩形は mask を張らない（pixi 既定の sprite.mask は undefined）。
    expect(st.sprite.mask).toBeFalsy()
    expect(st.maskGraphics).toBeUndefined()
  })

  // 16: 退場(remove instant)で clearMask → sprite.mask=null・maskGraphics=undefined・mask.destroy 呼ばれる。
  it('remove(instant) は円形マスクを破棄する（sprite.mask=null・maskGraphics=undefined・destroy 済み）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(200, 100) as never)
    const layer = new CharacterLayer(800, 450)
    layer.showImage({
      id: 'avatar',
      path: 'a.png',
      shape: '円形',
      size: 160,
      assetBaseUrl: '/assets',
    })
    await flushPromises()
    const mask = imageChars(layer).characters.get('avatar')!.maskGraphics!
    layer.remove('avatar', { instant: true })
    // Image 自体が消える。
    expect(imageChars(layer).characters.has('avatar')).toBe(false)
    // mask Graphics は破棄される（リーク防止）。
    expect(mask.destroyed).toBe(true)
  })

  // 17: clearAll / fadeOut 完了経路でも mask 破棄（漏れ3経路）。
  it('clear() でも円形マスクが破棄される', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(200, 100) as never)
    const layer = new CharacterLayer(800, 450)
    layer.showImage({
      id: 'avatar',
      path: 'a.png',
      shape: '円形',
      size: 160,
      assetBaseUrl: '/assets',
    })
    await flushPromises()
    const mask = imageChars(layer).characters.get('avatar')!.maskGraphics!
    layer.clear()
    expect(imageChars(layer).characters.size).toBe(0)
    expect(mask.destroyed).toBe(true)
  })

  it('fadeOut 完了（remove デフォルト）経路でも円形マスクが破棄され char が消える', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(200, 100) as never)
    const layer = new CharacterLayer(800, 450)
    layer.showImage({
      id: 'avatar',
      path: 'a.png',
      shape: '円形',
      size: 160,
      assetBaseUrl: '/assets',
      instant: true,
    })
    await flushPromises()
    const mask = imageChars(layer).characters.get('avatar')!.maskGraphics!
    // デフォルト remove はフェードアウト（destroyOnComplete=true）。
    layer.remove('avatar')
    // 内部 ticker を完了まで駆動する（elapsedMs を fade 期間より先へ進めて 1 フレーム更新）。
    const internal = layer as unknown as {
      animTicker: { update: () => void } | null
      elapsedMs: number
    }
    internal.elapsedMs += 10000
    internal.animTicker?.update()
    // fade 完了の destroyOnComplete 経路で clearMask が呼ばれ、char ごと消える。
    expect(imageChars(layer).characters.has('avatar')).toBe(false)
    expect(mask.destroyed).toBe(true)
  })

  // 18: 同 id 再表示は位置のみ更新（texture 差し替えなし）。
  it('同 id 再表示は位置のみ更新し、Assets.load を再度呼ばない（texture 差し替えなし）', async () => {
    const loadSpy = vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(200, 100) as never)
    const layer = new CharacterLayer(800, 450)
    layer.showImage({ id: 'avatar', path: 'a.png', position: '上', assetBaseUrl: '/assets' })
    await flushPromises()
    expect(loadSpy).toHaveBeenCalledTimes(1)
    // 同 id で別位置に再表示。
    layer.showImage({ id: 'avatar', path: 'b.png', position: '下', assetBaseUrl: '/assets' })
    const st = imageChars(layer).characters.get('avatar')!
    // 位置だけ更新される（下 = y 0.84）。
    expect(st.sprite.x).toBe(800 * 0.5)
    expect(st.sprite.y).toBeCloseTo(450 * 0.84, 5)
    expect(st.position).toBe('下')
    // load は追加で呼ばれない（texture は最初のまま）。
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })

  // 19: Assets.load reject → console.warn 1 回・例外を投げない・fade state は残る（例外握り潰し禁止）。
  it('Assets.load 失敗時は console.warn を 1 回出し、例外を投げず fade state を残す', async () => {
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('load failed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    // 例外を投げない（showImage は同期で返り、reject は .catch で握る）。
    expect(() => layer.showImage({ id: 'x', path: 'a.png', assetBaseUrl: '/assets' })).not.toThrow()
    await flushPromises()
    // warn は 1 回だけ。
    expect(warnSpy).toHaveBeenCalledTimes(1)
    // fade state（登場フェードイン）は残る（load 失敗で消えない）。
    const st = imageChars(layer).characters.get('x')!
    expect(st.fadeAnimation).not.toBeNull()
  })

  // 20: 本丸。画像は `[文字演出: id]` の対象になれない（label 無し → 早期 return、reject しない）。
  it('本丸: 画像は文字演出の対象になれない（label 無しで早期 return・textEffect は立たない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(10, 10) as never)
    const layer = new CharacterLayer(800, 450)
    layer.showImage({ id: 'avatar', path: 'a.png', assetBaseUrl: '/assets' })
    await flushPromises()
    // label を持たないので applyTextEffect は no-op（resolve）し、textEffect は立たない。
    await expect(layer.applyTextEffect('avatar', { effect: 'Explode' })).resolves.toBeUndefined()
    const st = imageChars(layer).characters.get('avatar')!
    expect(st.label).toBeUndefined()
    expect(st.textEffect).toBeNull()
  })
})

// =====================================================================================
// #294: 立ち絵（show 経路 = loadTexture）は常に原寸（scale=1）。
//   旧仕様は論理画面より大きいテクスチャを fit-down していたが、画面全体の wrapper スケール
//   だけが唯一の正しい縮小であり、立ち絵を個別に縮めてはいけない（上端・左右のはみ出しは許容）。
//   ASPECT_RATIOS から 16:9 = 800x450 を参照して期待値を直書きしない。
// =====================================================================================
describe('CharacterLayer 立ち絵は原寸表示（fit-down 廃止 #294）', () => {
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  const fakeTexture = (width: number, height: number): unknown => ({ width, height })
  const { width: SW, height: SH } = ASPECT_RATIOS['16:9']

  it('論理画面より大きい立ち絵（車のような横長）でも scale=1 のまま（個別縮小しない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW * 2, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('truck', 'wheel_loader-a', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('truck')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })

  it('画面高さより縦長の立ち絵（人物のような縦長）でも scale=1 のまま（上端はみ出し許容）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW / 2, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('kako', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('kako')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })

  it('論理画面に収まる小さい立ち絵も従来どおり scale=1', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(100, 100) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('mini', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('mini')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })
})

// =====================================================================================
// #294: 明示フィット（show の fit オプション = 脚本の `フィット`）。
//   fit=true のときだけ旧 fit-down を適用する（大きい時だけ収める・小さい時は原寸）。
//   境界値は computeFitScale を参照し、定数の計算結果を直書きしない。
// =====================================================================================
describe('computeFitScale 純粋関数（#294 旧 fit-down ロジック）', () => {
  const { width: SW, height: SH } = ASPECT_RATIOS['16:9']

  it('横長 2x のテクスチャは min(SW/texW, SH/texH) に収める', () => {
    // 1600x900 → SW=800,SH=450 に対して min(800/1600, 450/900)=0.5。
    expect(computeFitScale(SW * 2, SH * 2, SW, SH)).toBe(Math.min(SW / (SW * 2), SH / (SH * 2)))
  })

  it('幅だけ画面超過なら横方向の比率で収める', () => {
    expect(computeFitScale(SW * 2, SH, SW, SH)).toBe(SW / (SW * 2))
  })

  it('高さだけ画面超過なら縦方向の比率で収める', () => {
    expect(computeFitScale(SW, SH * 2, SW, SH)).toBe(SH / (SH * 2))
  })

  it('画面ちょうど（境界）は原寸 1（> 判定なので等倍は縮めない）', () => {
    expect(computeFitScale(SW, SH, SW, SH)).toBe(1)
  })

  it('画面より小さいテクスチャは原寸 1（拡大しない）', () => {
    expect(computeFitScale(100, 100, SW, SH)).toBe(1)
  })

  it('不正・非正・非有限の寸法は原寸 1 に倒す', () => {
    expect(computeFitScale(0, 100, SW, SH)).toBe(1)
    expect(computeFitScale(100, 0, SW, SH)).toBe(1)
    expect(computeFitScale(NaN, 100, SW, SH)).toBe(1)
    expect(computeFitScale(100, 100, 0, SH)).toBe(1)
  })

  it('画面寸法が NaN・非正でも原寸 1 に倒す（screen 側ガード）', () => {
    // texture は画面超過サイズでも、screen 側が不正なら 1（0 除算・NaN を出さない）。
    expect(computeFitScale(SW * 2, SH * 2, NaN, SH)).toBe(1)
    expect(computeFitScale(SW * 2, SH * 2, SW, NaN)).toBe(1)
    expect(computeFitScale(SW * 2, SH * 2, -SW, SH)).toBe(1)
    expect(computeFitScale(SW * 2, SH * 2, SW, -SH)).toBe(1)
  })
})

describe('CharacterLayer 明示フィット show({ fit }) （#294）', () => {
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  const fakeTexture = (width: number, height: number): unknown => ({ width, height })
  const { width: SW, height: SH } = ASPECT_RATIOS['16:9']

  it('fit=true・論理画面より大きい立ち絵は computeFitScale で収める', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW * 2, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('truck', 'wheel_loader-a', '中央', '/assets', { instant: true, fit: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('truck')!
    const expected = computeFitScale(SW * 2, SH * 2, SW, SH)
    expect(st.sprite.scale.x).toBe(expected)
    expect(st.sprite.scale.y).toBe(expected)
  })

  it('fit=true でも論理画面に収まる小さい立ち絵は原寸 1（拡大しない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(100, 100) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('mini', 'normal', '中央', '/assets', { instant: true, fit: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('mini')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })

  it('fit 省略（既定）は大きい立ち絵でも原寸 1（ca5308a の既定挙動を壊さない）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW * 2, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('truck', 'wheel_loader-a', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('truck')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })
})

describe('CharacterLayer render-only 除外と save→load 往復 (#274)', () => {
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  // 21: showTitle のみ → getCharacterStates 空（Title 漏れ修正の独立回帰防止）。
  it('showTitle 単独では getCharacterStates が空（Title は render-only で漏れない）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    expect(layer.getCharacterStates()).toEqual([])
  })

  // 22: save→load 実往復。Label/Image を出した局面を SaveManager 経由で保存→applyState 相当で
  //     復元し、立ち絵だけ show され Label/Image が復元されないことを縛る（結合）。
  //     applyState の立ち絵復元ロジック（clear → state.characters を instant show）を直に再現する。
  it('save→load 往復: Label/Image を出した局面を保存・復元すると立ち絵だけ残り Label/Image は復元されない', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue({ width: 10, height: 10 } as never)
    // ---- セーブ前の局面: 立ち絵 + Label + Image + Title を出す ----
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.showLabel({ id: 'division', text: 'div', fontFamily: 'sans-serif' })
    layer.showImage({ id: 'avatar', path: 'a.png', assetBaseUrl: '/assets' })
    layer.showTitle('orber', 'sans-serif')
    await flushPromises()

    // ---- セーブ: getCharacterStates() は render-only を除外し立ち絵だけ返す ----
    const snapshotChars = layer.getCharacterStates()
    expect(snapshotChars.map((s) => s.name)).toEqual(['hero'])

    // SaveManager 経由で実際に localStorage へ書き、読み戻す（保存形式を通す）。
    const manager = new SaveManager()
    manager.deleteQuickSave()
    const saveData: SaveSlotData = {
      slot: -1,
      sceneId: 'scene-1',
      eventIndex: 0,
      textIndex: 0,
      flags: {},
      backgroundPath: null,
      isBlackout: false,
      characters: snapshotChars,
      currentBgmPath: null,
      savedAt: new Date().toISOString(),
      sceneName: 's',
    }
    manager.quickSave(saveData)
    const loaded = manager.quickLoad()
    expect(loaded).not.toBeNull()

    // セーブスロット → GameState（純関数）。characters はここで復元対象になる。
    const restoredState = saveSlotToGameState(loaded!, null)
    expect(restoredState.characters.map((c) => c.name)).toEqual(['hero'])

    // ---- ロード: applyState の立ち絵復元（clear → 各 character を instant show）を再現 ----
    const fresh = new CharacterLayer(800, 450)
    fresh.clear()
    for (const ch of restoredState.characters) {
      fresh.show(ch.name, ch.expression, ch.position, '/assets', { instant: true })
    }

    // 立ち絵 hero だけが復元され、Label(division)/Image(avatar)/Title は復元されない。
    const internal = fresh as unknown as { characters: Map<string, unknown> }
    expect(internal.characters.has('hero')).toBe(true)
    expect(internal.characters.has('division')).toBe(false)
    expect(internal.characters.has('avatar')).toBe(false)
    expect(internal.characters.has('Title')).toBe(false)
    expect(fresh.getCharacterStates().map((s) => s.name)).toEqual(['hero'])

    manager.deleteQuickSave()
  })
})

// ===== #286: 話者交代ポーズ変化＋役割で左右配置（novel の話者表示） =====
describe('CharacterLayer 役割配置の xRatio override (#286)', () => {
  it('show() に xRatio を渡すと sprite.x が screenWidth * xRatio になる（position トークン非依存）', () => {
    const layer = new CharacterLayer(800, 450)
    // 質問役=左 (0.25)。position トークンは「中央」でも override が優先する。
    layer.show('seo', 'normal', '中央', '/assets', { instant: true, xRatio: 0.25 })
    expect(layer.getSpritePosition('seo')).toEqual({ x: 800 * 0.25, y: 450 * CHARACTER_Y_RATIO })
  })

  it('xRatio 未指定なら従来の position トークン配置（中央=screenWidth*0.5）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('seo', 'normal', '中央', '/assets', { instant: true })
    expect(layer.getSpritePosition('seo')!.x).toBe(800 * 0.5)
  })

  it('既存キャラの xRatio が変わると（質問役↔回答役の入替）sprite.x が更新される', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hina', 'normal', '中央', '/assets', { instant: true, xRatio: 0.75 })
    expect(layer.getSpritePosition('hina')!.x).toBe(800 * 0.75)
    // 同じ position トークン「中央」でも、override x が変われば位置が動く
    layer.show('hina', 'normal', '中央', '/assets', { instant: true, xRatio: 0.25 })
    expect(layer.getSpritePosition('hina')!.x).toBe(800 * 0.25)
  })

  it('縦位置（y）は xRatio に依らず全員共通ベースライン（CHARACTER_Y_RATIO）固定', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('left', 'normal', '中央', '/assets', { instant: true, xRatio: 0.25 })
    layer.show('right', 'normal', '中央', '/assets', { instant: true, xRatio: 0.75 })
    const baseY = 450 * CHARACTER_Y_RATIO
    expect(layer.getSpritePosition('left')!.y).toBe(baseY)
    expect(layer.getSpritePosition('right')!.y).toBe(baseY)
  })
})

describe('CharacterLayer 話者交代ポーズ変化 nudgePose (#286)', () => {
  it('nudgePose() で pose nudge がセットされ、baseY は nudge 開始時の sprite.y', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('seo', 'normal', '中央', '/assets', { instant: true, xRatio: 0.25 })
    expect(layer.getPoseNudgeState('seo')).toBeNull() // 初期は無し
    layer.nudgePose('seo')
    const pn = layer.getPoseNudgeState('seo')
    expect(pn).not.toBeNull()
    expect(pn!.active).toBe(true)
    expect(pn!.baseY).toBe(450 * CHARACTER_Y_RATIO) // 立ち絵のベースライン
  })

  it('nudgePose() は hasActiveAnimation を true にする（ticker 駆動対象）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('seo', 'normal', '中央', '/assets', { instant: true })
    expect(layer.hasActiveAnimation()).toBe(false)
    layer.nudgePose('seo')
    expect(layer.hasActiveAnimation()).toBe(true)
  })

  it('連続 nudgePose は前回の baseY を引き継ぐ（高速入替でも基準がずれない）', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('seo', 'normal', '中央', '/assets', { instant: true })
    const baseY = 450 * CHARACTER_Y_RATIO
    layer.nudgePose('seo')
    layer.nudgePose('seo') // 連続呼び出し
    expect(layer.getPoseNudgeState('seo')!.baseY).toBe(baseY)
  })

  it('居ないキャラへの nudgePose は no-op（例外を吐かない）', () => {
    const layer = new CharacterLayer(800, 450)
    expect(() => layer.nudgePose('absent')).not.toThrow()
    expect(layer.getPoseNudgeState('absent')).toBeNull()
  })
})
