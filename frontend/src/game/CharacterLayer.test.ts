import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import {
  CHARACTER_Y_RATIO,
  CharacterLayer,
  normalizePosition,
  alignToAnchorX,
  computeFitScale,
  computeTargetHeightScale,
} from './CharacterLayer'
import { CURSOR_DEFAULTS } from './textEffect'
import { NovelRenderer } from './NovelRenderer'
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
  sprite: { alpha: number; x: number; y: number; parent?: unknown }
  fadeAnimation: FadeAnimationLike | null
  snapshotHidden?: boolean
  attached?: boolean
}

interface CharacterLayerInternals {
  characters: Map<string, CharacterStateLike>
}

function asInternals(layer: CharacterLayer): CharacterLayerInternals {
  return layer as unknown as CharacterLayerInternals
}

describe('CharacterLayer fade (Issue #177)', () => {
  // Assets.load の spy 等を毎テスト後に確実に戻す（assert が throw しても mock が後続へ漏れない）。
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('show() の新規表示は texture load 完了後に alpha 0 から fade-in を開始する（#17: texture-gate）', async () => {
    // 退場衝突が無い（colliderCount===0）新規立ち絵でも、フェードは texture 読込後に始める。
    // 読込前にフェードを走らせると、初回コールドキャッシュで texture が fade より遅いとき
    // alpha が 1 に達し切ってから絵が現れ、フェードが見えず突然出る（本編入口の司会など・#17）。
    vi.spyOn(Assets, 'load').mockResolvedValue({ width: 200, height: 400 } as never)
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets')
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    // 読込前: alpha 0 で待機、フェードはまだ開始していない。
    expect(state!.sprite.alpha).toBe(0)
    expect(state!.fadeAnimation).toBeNull()
    // texture 読込完了 → ここで初めてフェードイン開始。
    await new Promise((resolve) => setTimeout(resolve, 0))
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
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
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
    cursor: {
      gfx: { destroyed: boolean; visible: boolean; x: number; y: number }
      blinkMs: number
    } | null
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

  it('cursor=on の初期フレームで配置済み・表示済みになり、未配置原点を見せない（#333）', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    await layer.applyTextEffect('Title', { effect: 'Typewriter', cursor: true, ms_per_char: 70 })
    const cursor = getTitleC(layer).textEffect!.cursor!.gfx

    expect(cursor.destroyed).toBe(false)
    expect(cursor.visible).toBe(true)
    expect(cursor.y).toBe(0)
    // buildCursor は (0,0) で作るが、初期 updateTextEffectFrame が先頭グリフ左端へ同期する。
    expect(cursor.x).not.toBe(0)
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

// ===== #303: 1 位置 1 キャラ（同位置に別キャラが出るとき前のキャラを退場させる） =====
//
// 実機（avatar__kantia）で「ヴィンチア(右)が話し終えても立ち絵が消えず、次に同じ右に出る
// カンティアと重なる」不具合の最小回帰。show() が targetX を占有する別キャラを退場させる。
// 役割配置 x（質問役=左 0.25 / 回答役=右 0.75）は xRatio override 経由で来るため、
// override 経路と position トークン経路の両方で衝突退場を検証する。
describe('CharacterLayer 1 位置 1 キャラ衝突退場 (#303)', () => {
  beforeEach(() => {
    __setDocumentForTest(null)
    resetFontLoaderCache()
  })
  afterEach(() => {
    __setDocumentForTest(typeof document === 'undefined' ? null : document)
    resetFontLoaderCache()
  })

  it('同じ override x に X→Y と続けて出すと、Y 表示前に X が退場フェードに入る', () => {
    const layer = new CharacterLayer(800, 450)
    // ヴィンチア(右=0.75) を出す。
    layer.show('ヴィンチア', 'normal', '中央', '/assets', { instant: true, xRatio: 0.75 })
    expect(asInternals(layer).characters.has('ヴィンチア')).toBe(true)
    // カンティア(右=0.75) を同じ位置へ。ヴィンチアは退場フェードへ。
    layer.show('カンティア', 'normal', '中央', '/assets', { xRatio: 0.75 })
    const vinchia = asInternals(layer).characters.get('ヴィンチア')
    expect(vinchia).toBeDefined()
    expect(vinchia!.fadeAnimation).not.toBeNull()
    expect(vinchia!.fadeAnimation!.toAlpha).toBe(0)
    expect(vinchia!.fadeAnimation!.destroyOnComplete).toBe(true)
    // カンティアは新規表示されている。
    expect(asInternals(layer).characters.has('カンティア')).toBe(true)
  })

  it('skip(instant) では衝突した前キャラが即座に Map から消える', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('ヴィンチア', 'normal', '中央', '/assets', { instant: true, xRatio: 0.75 })
    // instant: true（skipMode 相当）で衝突 → 即時退場。
    layer.show('カンティア', 'normal', '中央', '/assets', { instant: true, xRatio: 0.75 })
    expect(asInternals(layer).characters.has('ヴィンチア')).toBe(false)
    expect(asInternals(layer).characters.has('カンティア')).toBe(true)
  })

  it('別位置（左のせお）には干渉しない（左は残り、右だけ入れ替わる）', () => {
    const layer = new CharacterLayer(800, 450)
    // せお(左=0.25)・ヴィンチア(右=0.75)・カンティア(右=0.75) — avatar__kantia の配置。
    layer.show('せお', 'normal', '中央', '/assets', { instant: true, xRatio: 0.25 })
    layer.show('ヴィンチア', 'normal', '中央', '/assets', { instant: true, xRatio: 0.75 })
    layer.show('カンティア', 'normal', '中央', '/assets', { instant: true, xRatio: 0.75 })
    // 左のせおは残る。右はヴィンチア退場・カンティアだけ。
    expect(asInternals(layer).characters.has('せお')).toBe(true)
    expect(asInternals(layer).characters.has('ヴィンチア')).toBe(false)
    expect(asInternals(layer).characters.has('カンティア')).toBe(true)
  })

  it('同一キャラの再表示（表情/位置変更）は自分を退場させない', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('カンティア', 'normal', '中央', '/assets', { instant: true, xRatio: 0.75 })
    // 同じキャラを同位置で表情だけ変えて再 show → 退場しない。
    layer.show('カンティア', 'smile', '中央', '/assets', { instant: true, xRatio: 0.75 })
    const st = asInternals(layer).characters.get('カンティア')
    expect(st).toBeDefined()
    // 退場フェード（destroyOnComplete）に入っていないこと。
    expect(st!.fadeAnimation?.destroyOnComplete ?? false).toBe(false)
    expect(asInternals(layer).characters.has('カンティア')).toBe(true)
  })

  it('position トークン経路（左/右）でも同位置の別キャラを退場させる', () => {
    const layer = new CharacterLayer(800, 450)
    // override なし・position トークン「右」で 2 人続けて出す（adv 経路相当）。
    layer.show('A', 'normal', '右', '/assets', { instant: true })
    layer.show('B', 'normal', '右', '/assets', { instant: true })
    expect(asInternals(layer).characters.has('A')).toBe(false)
    expect(asInternals(layer).characters.has('B')).toBe(true)
  })

  it('別の position トークン（左 vs 右）は衝突せず両方残る', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('A', 'normal', '左', '/assets', { instant: true })
    layer.show('B', 'normal', '右', '/assets', { instant: true })
    expect(asInternals(layer).characters.has('A')).toBe(true)
    expect(asInternals(layer).characters.has('B')).toBe(true)
  })

  it('renderOnly（Label）は同位置でも退場対象にならない（立ち絵スロットを占有しない）', () => {
    const layer = new CharacterLayer(800, 450)
    // 中央(0.5)に Label と立ち絵が重なっても、Label は退場させない。
    layer.showLabel({
      id: 'L',
      text: 'タイトル',
      fontFamily: 'sans-serif',
      position: '中央',
      instant: true,
    })
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    expect(asInternals(layer).characters.has('L')).toBe(true)
    expect(asInternals(layer).characters.has('hero')).toBe(true)
  })

  it('退場フェード中（destroyOnComplete）のキャラは getCharacterStates に漏れない', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('ヴィンチア', 'normal', '中央', '/assets', { instant: true, xRatio: 0.75 })
    // カンティアを同位置へ（fade で退場）。ヴィンチアはまだ Map に居るがフェードアウト中。
    layer.show('カンティア', 'normal', '中央', '/assets', { xRatio: 0.75 })
    const names = layer.getCharacterStates().map((s) => s.name)
    expect(names).not.toContain('ヴィンチア')
    expect(names).toContain('カンティア')
  })
})

describe('CharacterLayer 立ち絵 transition semantics (#337)', () => {
  beforeEach(() => {
    vi.spyOn(Assets, 'load').mockResolvedValue(Texture.WHITE as never)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('同位置の別人物交代は、旧人物 fade-out 完了後に新人物 fade-in を始める', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('old', 'normal', '中央', '/assets', { instant: true })
    layer.show('new', 'normal', '中央', '/assets')

    await flushPromises()

    const states = asInternals(layer).characters
    const oldState = states.get('old')
    const newState = states.get('new')
    expect(oldState).toBeDefined()
    expect(newState).toBeDefined()
    expect(oldState!.fadeAnimation).toMatchObject({
      toAlpha: 0,
      destroyOnComplete: true,
    })
    expect(newState!.attached).toBe(false)
    expect(newState!.sprite.parent).toBeNull()
    expect(newState!.fadeAnimation).toBeNull()

    const internal = layer as unknown as {
      animTicker: { update: () => void } | null
      elapsedMs: number
    }
    internal.elapsedMs += 10000
    internal.animTicker?.update()

    expect(states.has('old')).toBe(false)
    expect(states.get('new')!.attached).toBe(true)
    expect(states.get('new')!.fadeAnimation).toMatchObject({
      fromAlpha: 0,
      toAlpha: 1,
      destroyOnComplete: false,
    })
  })

  it('同一人物の表情変更は旧 sprite と新 sprite を重ねてクロスフェードする', async () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.show('hero', 'smile', '中央', '/assets')

    await flushPromises()

    const states = asInternals(layer).characters
    const current = states.get('hero')
    const old = Array.from(states.entries()).find(([name]) => name.startsWith('hero__transition_'))
    expect(current).toBeDefined()
    expect(old).toBeDefined()
    expect(old![1].snapshotHidden).toBe(true)
    expect(old![1].fadeAnimation).toMatchObject({
      fromAlpha: 1,
      toAlpha: 0,
      destroyOnComplete: true,
    })
    expect(current!.fadeAnimation).toMatchObject({
      fromAlpha: 0,
      toAlpha: 1,
      destroyOnComplete: false,
    })
    expect(layer.getCharacterStates()).toEqual([
      { name: 'hero', expression: 'smile', position: 'center' },
    ])
  })
})

describe('CharacterLayer scene transition fade', () => {
  it('clearForSceneTransition は標準立ち絵を即時破棄せず fade-out に入れる', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('せお', 'normal', '左', '/assets', { instant: true })

    layer.clearForSceneTransition()

    const seo = asInternals(layer).characters.get('せお')
    expect(seo).toBeDefined()
    expect(seo!.fadeAnimation).toMatchObject({
      toAlpha: 0,
      destroyOnComplete: true,
    })
    expect(layer.getCharacterStates()).toEqual([])
  })

  it('scene transition fade-out 中に同名キャラが再 show されると fade-in に戻る', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('せお', 'normal', '左', '/assets', { instant: true })
    layer.clearForSceneTransition()

    layer.show('せお', 'normal', '左', '/assets')

    const seo = asInternals(layer).characters.get('せお')
    expect(seo).toBeDefined()
    expect(seo!.fadeAnimation).toMatchObject({
      toAlpha: 1,
      destroyOnComplete: false,
    })
  })
})

// =====================================================================================
// #308: 立ち絵の足元 Y 比率 per-game 上書き（setCharacterYRatio）。
//   既定 1.0（後方互換）。CharacterLayer が null/NaN/±Inf→1.0、範囲外→[0,2] クランプを一元所有する。
//   観測は characters Map 直読み（sprite.y）/ private characterY / getPoseNudgeState。
//   期待値は必ず `H * ratio` 式で書く（数値直書き禁止＝#262 の陳腐化前科）。
//   境界は端点±ε の 3 点を必ず縛る（`>=`/`>` 取り違え狙い）。
// =====================================================================================
describe('CharacterLayer character_y_ratio (#308)', () => {
  // setCharacterYRatio で再ベースされる sprite.y と、再ベース除外条件（animation / poseNudge）を
  // 観測するため、既存 asInternals より広い形で characters と private characterY を読む。
  interface YRatioStateLike {
    sprite: { x: number; y: number }
    animation: unknown
    poseNudge: unknown
  }
  interface YRatioInternals {
    characters: Map<string, YRatioStateLike>
    characterY: number
  }
  function yInternals(layer: CharacterLayer): YRatioInternals {
    return layer as unknown as YRatioInternals
  }

  // ---- F1: 既定（setter を呼ばない）は後方互換で H * CHARACTER_Y_RATIO ----
  it('F1: setter を呼ばない既定の show は sprite.y = H * CHARACTER_Y_RATIO（後方互換）', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    const st = yInternals(layer).characters.get('hero')!
    expect(st.sprite.y).toBeCloseTo(H * CHARACTER_Y_RATIO, 5)
  })

  // ---- F2-F6: 非有効値（null / undefined / 非有限）は既定 1.0 に倒す ----
  it('F2: null → 既定 1.0（characterY = H * CHARACTER_Y_RATIO）', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(null)
    expect(yInternals(layer).characterY).toBeCloseTo(H * CHARACTER_Y_RATIO, 5)
  })

  it('F3: undefined → 既定 1.0', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(undefined)
    expect(yInternals(layer).characterY).toBeCloseTo(H * CHARACTER_Y_RATIO, 5)
  })

  it('F4: NaN → 既定 1.0（非有限を neutralize）', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(Number.NaN)
    expect(yInternals(layer).characterY).toBeCloseTo(H * CHARACTER_Y_RATIO, 5)
  })

  it('F5: +Infinity → 既定 1.0（非有限を neutralize）', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(Number.POSITIVE_INFINITY)
    expect(yInternals(layer).characterY).toBeCloseTo(H * CHARACTER_Y_RATIO, 5)
  })

  it('F6: −Infinity → 既定 1.0（非有限を neutralize）', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(Number.NEGATIVE_INFINITY)
    expect(yInternals(layer).characterY).toBeCloseTo(H * CHARACTER_Y_RATIO, 5)
  })

  // ---- F7: 下端境界 3 点（端点±ε）。クランプ下限 0 の `>=`/`>` 取り違え狙い ----
  it.each([
    [-0.0001, 0], // 下限未満 → 0 にクランプ
    [0, 0], // 下限ちょうど → 透過（0）
    [0.0001, 0.0001], // 下限直上 → 透過
  ] as const)('F7: 下端境界 ratio=%f は characterY = H * %f', (input, effective) => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(input)
    expect(yInternals(layer).characterY).toBeCloseTo(H * effective, 5)
  })

  // ---- F8: 上端境界 3 点（端点±ε）。クランプ上限 2 の `<=`/`<` 取り違え狙い ----
  it.each([
    [1.9999, 1.9999], // 上限直下 → 透過
    [2, 2], // 上限ちょうど → 透過
    [2.0001, 2], // 上限超過 → 2 にクランプ
  ] as const)('F8: 上端境界 ratio=%f は characterY = H * %f', (input, effective) => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(input)
    expect(yInternals(layer).characterY).toBeCloseTo(H * effective, 5)
  })

  // ---- F9: 既定値 1.0 は透過（クランプもされない） ----
  it('F9: ratio=1.0 は透過で characterY = H * 1.0', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(1.0)
    expect(yInternals(layer).characterY).toBeCloseTo(H * 1.0, 5)
  })

  // ---- F10: 中間値はそのまま透過 ----
  it.each([[0.5], [1.05]] as const)(
    'F10: 中間値 ratio=%f は透過で characterY = H * %f',
    (ratio) => {
      const H = 450
      const layer = new CharacterLayer(800, H)
      layer.setCharacterYRatio(ratio)
      expect(yInternals(layer).characterY).toBeCloseTo(H * ratio, 5)
    }
  )

  // ---- F11: 暴走値は上限 2 にクランプ（遥か下へ飛ばさない） ----
  it('F11: 暴走値 ratio=1000 は上限 2 にクランプ（characterY = H * 2）', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(1000)
    expect(yInternals(layer).characterY).toBeCloseTo(H * 2, 5)
  })

  // ---- F12: 設定後の新規 show が新しい足元 Y で出る ----
  it('F12: setCharacterYRatio(0.5) 後の新規 show は sprite.y = H * 0.5', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.setCharacterYRatio(0.5)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    const st = yInternals(layer).characters.get('hero')!
    expect(st.sprite.y).toBeCloseTo(H * 0.5, 5)
  })

  // ---- F13: 静的表示中の立ち絵を後から再ベースする ----
  it('F13: 静的表示中に setCharacterYRatio(0.5) すると既存 sprite.y が H * 0.5 へ再ベースされる', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    // 設定前は既定 H * 1.0。
    expect(yInternals(layer).characters.get('hero')!.sprite.y).toBeCloseTo(H * CHARACTER_Y_RATIO, 5)
    layer.setCharacterYRatio(0.5)
    expect(yInternals(layer).characters.get('hero')!.sprite.y).toBeCloseTo(H * 0.5, 5)
  })

  // ---- F14: 位置アニメ中の sprite は再ベースしない（中間状態を焼き込まない） ----
  it('F14: 位置アニメ中（animation 非 null）の sprite は setCharacterYRatio で再ベースされない', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    // 非ゼロ duration の animate で animation を進行中にする（dy で y を動かす）。
    layer.animate('hero', { dy: '-100', duration_ms: 500 })
    const st = yInternals(layer).characters.get('hero')!
    expect(st.animation).not.toBeNull()
    const yBefore = st.sprite.y
    layer.setCharacterYRatio(0.5)
    // アニメ中は再ベース対象外。sprite.y は触られず H * 0.5 にならない。
    expect(st.sprite.y).toBe(yBefore)
    expect(st.sprite.y).not.toBeCloseTo(H * 0.5, 5)
  })

  // ---- F15: nudge 中の sprite は再ベースせず baseY も不変 ----
  it('F15: pose nudge 中（poseNudge 非 null）は再ベースされず baseY も不変', () => {
    const H = 450
    const layer = new CharacterLayer(800, H)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.nudgePose('hero')
    const nudgeBefore = layer.getPoseNudgeState('hero')
    expect(nudgeBefore).not.toBeNull()
    const baseYBefore = nudgeBefore!.baseY
    const st = yInternals(layer).characters.get('hero')!
    expect(st.poseNudge).not.toBeNull()
    const yBefore = st.sprite.y
    layer.setCharacterYRatio(0.5)
    // nudge 中は再ベース対象外。sprite.y も baseY も動かない。
    expect(st.sprite.y).toBe(yBefore)
    expect(layer.getPoseNudgeState('hero')!.baseY).toBe(baseYBefore)
  })

  // ---- F16: 縦横で同 ratio でも px が変わる（H に比例） ----
  it.each([
    [800, 450], // 16:9
    [450, 800], // 9:16
  ] as const)('F16: (W=%i, H=%i) で ratio=1.0 の sprite.y は H に一致する', (W, H) => {
    const layer = new CharacterLayer(W, H)
    layer.setCharacterYRatio(1.0)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    const st = yInternals(layer).characters.get('hero')!
    expect(st.sprite.y).toBeCloseTo(H * 1.0, 5)
  })

  // ---- F17: NovelRenderer は値を持たず CharacterLayer へ素通しする ----
  it('F17: NovelRenderer.setCharacterYRatio(0.5) は内部 characterLayer の characterY を H * 0.5 にする', () => {
    const renderer = new NovelRenderer()
    const layer = (renderer as unknown as { characterLayer: CharacterLayer }).characterLayer
    const H = (renderer as unknown as { screenHeight: number }).screenHeight
    renderer.setCharacterYRatio(0.5)
    expect(yInternals(layer).characterY).toBeCloseTo(H * 0.5, 5)
  })

  // ---- F18: dialog_style 非依存（novel と adv で同 ratio・同 position の足元が一致） ----
  //   dialog_style は NovelRenderer 側の関心事なので、両モードの renderer を立てて内部 layer の
  //   characterY が同 ratio で一致することを縛る（足元 Y は dialog_style に分岐しない）。
  it('F18: novel と adv で同 ratio の characterY が一致する（dialog_style 非依存）', () => {
    const novel = new NovelRenderer()
    novel.setDialogStyle('novel')
    novel.setCharacterYRatio(0.5)
    const adv = new NovelRenderer()
    adv.setDialogStyle('adv')
    adv.setCharacterYRatio(0.5)
    const novelLayer = (novel as unknown as { characterLayer: CharacterLayer }).characterLayer
    const advLayer = (adv as unknown as { characterLayer: CharacterLayer }).characterLayer
    const H = (novel as unknown as { screenHeight: number }).screenHeight
    const yNovel = yInternals(novelLayer).characterY
    const yAdv = yInternals(advLayer).characterY
    expect(yNovel).toBeCloseTo(H * 0.5, 5)
    expect(yNovel).toBe(yAdv)
  })
})

// =====================================================================================
// #360: 立ち絵の目標表示高さ比率（character_height_ratio）。
//   高解像度化した立ち絵（例: 2倍リサイズ）を原寸で置くと巨大化するため、
//   目標高さ = ratio * screenH に uniform scale で合わせる純関数 computeTargetHeightScale。
//   期待値は必ず式（(ratio*screenH)/texH）で書き、screenH は ASPECT_RATIOS から取る（#262 直書き禁止）。
// =====================================================================================
describe('computeTargetHeightScale 純粋関数（#360 目標表示高さ）', () => {
  // 9:16（縦長）の論理画面高さを参照。定数直書きせず ASPECT_RATIOS から取る（#262）。
  const { height: SH } = ASPECT_RATIOS['9:16']

  it('基本: (ratio*screenH)/texH を返す', () => {
    const texH = 1396 // 高解像度リサイズ後の立ち絵の縦px（例）
    const ratio = 0.8
    expect(computeTargetHeightScale(texH, ratio, SH)).toBeCloseTo((ratio * SH) / texH, 10)
  })

  // ---- この機能の肝: 高解像度不変性 ----
  // 同じ ratio・screenH のまま texH を 2 倍にすると scale は半分になり、
  // 画面上の表示高さ scale*texH = ratio*screenH は texH に依らず一定であること。
  it('高解像度不変性: texH を 2 倍にすると scale は半分になり、表示高さ scale*texH は不変', () => {
    const ratio = 0.8
    const base = 700
    const s1 = computeTargetHeightScale(base, ratio, SH)
    const s2 = computeTargetHeightScale(base * 2, ratio, SH)
    // texH 2 倍 → scale 半分。
    expect(s2).toBeCloseTo(s1 / 2, 10)
    // 画面上の表示高さ scale*texH は texH に依らず ratio*screenH で一定。
    expect(s1 * base).toBeCloseTo(ratio * SH, 6)
    expect(s2 * (base * 2)).toBeCloseTo(ratio * SH, 6)
    expect(s1 * base).toBeCloseTo(s2 * (base * 2), 6)
  })

  // texH の倍率をいくつ変えても、画面上の表示高さは常に ratio*screenH（高解像度化の吸収）。
  it.each([[1], [2], [4], [8]] as const)(
    'texH の倍率 %ix によらず表示高さ scale*texH = ratio*screenH で一定',
    (mult) => {
      const ratio = 0.6
      const base = 500
      const texH = base * mult
      const s = computeTargetHeightScale(texH, ratio, SH)
      expect(s * texH).toBeCloseTo(ratio * SH, 6)
    }
  )

  it('非有限・非正の texH は原寸 1 に倒す（0 除算・NaN ガード）', () => {
    expect(computeTargetHeightScale(Number.NaN, 0.8, SH)).toBe(1)
    expect(computeTargetHeightScale(Number.POSITIVE_INFINITY, 0.8, SH)).toBe(1)
    expect(computeTargetHeightScale(0, 0.8, SH)).toBe(1)
    expect(computeTargetHeightScale(-100, 0.8, SH)).toBe(1)
  })

  it('非有限 ratio は原寸 1 に倒す', () => {
    expect(computeTargetHeightScale(1000, Number.NaN, SH)).toBe(1)
    expect(computeTargetHeightScale(1000, Number.POSITIVE_INFINITY, SH)).toBe(1)
    expect(computeTargetHeightScale(1000, Number.NEGATIVE_INFINITY, SH)).toBe(1)
  })

  it('非有限・非正の screenH は原寸 1 に倒す（screen 側ガード）', () => {
    expect(computeTargetHeightScale(1000, 0.8, Number.NaN)).toBe(1)
    expect(computeTargetHeightScale(1000, 0.8, Number.POSITIVE_INFINITY)).toBe(1)
    expect(computeTargetHeightScale(1000, 0.8, 0)).toBe(1)
    expect(computeTargetHeightScale(1000, 0.8, -SH)).toBe(1)
  })
})

// =====================================================================================
// #360: setCharacterHeightRatio のクランプ/正規化。
//   null/undefined/非有限 → null（原寸）、有効値は [0.05, 2.0] へクランプ。
//   保持値は private characterHeightRatio を直読みして縛る（#308 の characterY 直読みと同じ流儀）。
//   境界は端点±ε の 3 点を縛り、`>=`/`>` と `<=`/`<` の取り違えを狙う。
// =====================================================================================
describe('CharacterLayer setCharacterHeightRatio クランプ/正規化（#360）', () => {
  interface HRatioInternals {
    characterHeightRatio: number | null
  }
  function hInternals(layer: CharacterLayer): HRatioInternals {
    return layer as unknown as HRatioInternals
  }

  it('初期値（setter 未呼び出し）は null（原寸・後方互換）', () => {
    const layer = new CharacterLayer(450, 800)
    expect(hInternals(layer).characterHeightRatio).toBeNull()
  })

  // ---- 非有効値（null / undefined / 非有限）は null（原寸挙動）に倒す ----
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ] as const)('非有効値 %s → characterHeightRatio は null（原寸）', (_label, input) => {
    const layer = new CharacterLayer(450, 800)
    // 一度有効値を入れてから無効値で null へ戻ることも確かめる（残留しない）。
    layer.setCharacterHeightRatio(0.5)
    expect(hInternals(layer).characterHeightRatio).toBe(0.5)
    layer.setCharacterHeightRatio(input)
    expect(hInternals(layer).characterHeightRatio).toBeNull()
  })

  it('0.01 は下限 0.05 にクランプされる', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatio(0.01)
    expect(hInternals(layer).characterHeightRatio).toBeCloseTo(0.05, 10)
  })

  it('5 は上限 2.0 にクランプされる', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatio(5)
    expect(hInternals(layer).characterHeightRatio).toBeCloseTo(2.0, 10)
  })

  it('0.88 はそのまま透過する（クランプされない）', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatio(0.88)
    expect(hInternals(layer).characterHeightRatio).toBeCloseTo(0.88, 10)
  })

  // ---- 下端境界 3 点（端点±ε）。下限 0.05 の `>=`/`>` 取り違え狙い ----
  it.each([
    [0.0499, 0.05], // 下限未満 → 0.05 にクランプ
    [0.05, 0.05], // 下限ちょうど → 透過
    [0.0501, 0.0501], // 下限直上 → 透過
  ] as const)('下端境界 ratio=%f は characterHeightRatio = %f', (input, effective) => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatio(input)
    expect(hInternals(layer).characterHeightRatio).toBeCloseTo(effective, 10)
  })

  // ---- 上端境界 3 点（端点±ε）。上限 2.0 の `<=`/`<` 取り違え狙い ----
  it.each([
    [1.9999, 1.9999], // 上限直下 → 透過
    [2, 2], // 上限ちょうど → 透過
    [2.0001, 2], // 上限超過 → 2.0 にクランプ
  ] as const)('上端境界 ratio=%f は characterHeightRatio = %f', (input, effective) => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatio(input)
    expect(hInternals(layer).characterHeightRatio).toBeCloseTo(effective, 10)
  })
})

// =====================================================================================
// #360: loadTexture の scale 優先順位（fit > character_height_ratio > 原寸1）と後方互換。
//   立ち絵の実 scale を Assets.load モック + flushPromises で観測する（#294 の fit テストと同流儀）。
//   render-only（Title/Image）は loadTexture 非経由なので heightRatio の影響を受けないことも縛る。
//   期待値は computeTargetHeightScale / computeFitScale を参照し、計算結果を直書きしない（#262）。
// =====================================================================================
describe('CharacterLayer character_height_ratio loadTexture 優先順位・後方互換（#360）', () => {
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
  // 縦長 9:16（この機能の主戦場は縦長の高解像度立ち絵）。
  const { width: SW, height: SH } = ASPECT_RATIOS['9:16']

  // ---- (a) 後方互換: setter 未呼び出し（既定 null）→ 立ち絵は原寸 scale=1 ----
  it('(a) 後方互換: setCharacterHeightRatio 未呼び出しなら大きい立ち絵でも scale=1', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })

  // 非有効値を setter に渡しても null（原寸）に倒れ、立ち絵は scale=1（後方互換の絶対条件）。
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
  ] as const)(
    '(a) 非有効値 %s を設定しても立ち絵は原寸 scale=1（loadTexture 経由で確認）',
    async (_label, input) => {
      vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, SH * 2) as never)
      const layer = new CharacterLayer(SW, SH)
      layer.setCharacterHeightRatio(input)
      layer.show('hero', 'normal', '中央', '/assets', { instant: true })
      await flushPromises()
      const st = imageChars(layer).characters.get('hero')!
      expect(st.sprite.scale.x).toBe(1)
      expect(st.sprite.scale.y).toBe(1)
    }
  )

  // ---- (b) heightRatio 設定・fit=false → scale = computeTargetHeightScale 相当 ----
  it('(b) heightRatio 設定・fit=false の立ち絵は computeTargetHeightScale で目標高さへ合わせる', async () => {
    const texH = SH * 2 // 高解像度立ち絵
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    const ratio = 0.8
    layer.setCharacterHeightRatio(ratio)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const expected = computeTargetHeightScale(texH, ratio, SH)
    expect(st.sprite.scale.x).toBeCloseTo(expected, 10)
    expect(st.sprite.scale.y).toBeCloseTo(expected, 10)
    // 目標高さ scale*texH = ratio*screenH（原寸 1 とは明確に異なる）。
    expect(st.sprite.scale.y * texH).toBeCloseTo(ratio * SH, 6)
    expect(st.sprite.scale.x).not.toBe(1)
  })

  // ---- (c) fit=true かつ heightRatio 設定 → computeFitScale が勝つ（heightRatio 無視）----
  it('(c) fit=true は heightRatio より優先され computeFitScale が勝つ', async () => {
    const texW = SW * 2
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(texW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    const ratio = 0.8
    layer.setCharacterHeightRatio(ratio)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true, fit: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const fitScale = computeFitScale(texW, texH, SW, SH)
    const heightScale = computeTargetHeightScale(texH, ratio, SH)
    expect(st.sprite.scale.x).toBe(fitScale)
    expect(st.sprite.scale.y).toBe(fitScale)
    // fit が勝つので、heightRatio 由来の scale ではない（両者が別値であることを前提に反証）。
    expect(fitScale).not.toBeCloseTo(heightScale, 6)
    expect(st.sprite.scale.y).not.toBeCloseTo(heightScale, 6)
  })

  // ---- (d) render-only 非対象: showImage / showTitle は loadTexture 非経由で heightRatio 無影響 ----
  it('(d) showImage は heightRatio 設定後も自前 sizing のまま（loadTexture 非経由・scale 不変）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    // 設定を先に入れておく。
    layer.setCharacterHeightRatio(0.8)
    // size 未指定の画像は自前 sizing で自然サイズ scale=(1,1)（#274）。heightRatio の影響を受けない。
    layer.showImage({ id: 'avatar', path: 'a.png', assetBaseUrl: '/assets' })
    await flushPromises()
    const before = imageChars(layer).characters.get('avatar')!
    expect(before.sprite.scale.x).toBe(1)
    expect(before.sprite.scale.y).toBe(1)
    // 表示後に heightRatio を変えても render-only は即再適用の対象外（scale 不変）。
    layer.setCharacterHeightRatio(0.3)
    const after = imageChars(layer).characters.get('avatar')!
    expect(after.sprite.scale.x).toBe(1)
    expect(after.sprite.scale.y).toBe(1)
  })

  it('(d) showTitle は heightRatio 設定後も sprite.scale=(1,1)（render-only・loadTexture 非経由）', () => {
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatio(0.8)
    layer.showTitle('orber', 'sans-serif')
    const st = imageChars(layer).characters.get('Title')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
    // 表示後に heightRatio を変えても Title の scale は不変（renderOnly は即再適用の対象外）。
    layer.setCharacterHeightRatio(0.3)
    const st2 = imageChars(layer).characters.get('Title')!
    expect(st2.sprite.scale.x).toBe(1)
    expect(st2.sprite.scale.y).toBe(1)
  })

  // ---- (e) 即再適用: 表示中の静的立ち絵に setCharacterHeightRatio → sprite.scale 更新・null 復帰で 1 ----
  it('(e) 表示中の静的立ち絵に setCharacterHeightRatio を呼ぶと sprite.scale が即再適用され、null 復帰で 1 に戻る', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    // 設定前は原寸 1（後方互換）。
    expect(st.sprite.scale.x).toBe(1)
    // heightRatio を設定 → texture ロード済みなので即再スケール。
    const ratio = 0.8
    layer.setCharacterHeightRatio(ratio)
    const expected = computeTargetHeightScale(texH, ratio, SH)
    expect(st.sprite.scale.x).toBeCloseTo(expected, 10)
    expect(st.sprite.scale.y).toBeCloseTo(expected, 10)
    expect(st.sprite.scale.x).not.toBe(1)
    // null 復帰 → 原寸 1 へ即戻す。
    layer.setCharacterHeightRatio(null)
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })

  // fit の立ち絵は即再適用の対象外（fit が優先されるため heightRatio 変更で scale を触らない）。
  it('(e) fit=true の立ち絵は setCharacterHeightRatio の即再適用対象外（scale は fit のまま不変）', async () => {
    const texW = SW * 2
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(texW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true, fit: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const fitScale = computeFitScale(texW, texH, SW, SH)
    expect(st.sprite.scale.x).toBe(fitScale)
    // heightRatio を設定しても fit の立ち絵は触らない（即再適用がスキップ）。
    layer.setCharacterHeightRatio(0.3)
    expect(st.sprite.scale.x).toBe(fitScale)
    expect(st.sprite.scale.y).toBe(fitScale)
  })
})
