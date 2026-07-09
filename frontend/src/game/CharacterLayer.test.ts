import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Assets, Sprite, Texture } from 'pixi.js'
import {
  CHARACTER_Y_RATIO,
  CHARACTER_SCALE_MIN,
  CHARACTER_SCALE_MAX,
  CharacterLayer,
  normalizePosition,
  alignToAnchorX,
  clampCharacterScale,
  computeFitScale,
  computeTargetHeightScale,
  resolveCharacterHeightRatio,
} from './CharacterLayer'
import { CURSOR_DEFAULTS } from './textEffect'
import { NovelRenderer, BACKGROUND_CROSSFADE_MS } from './NovelRenderer'
import { ASPECT_RATIOS } from './constants'
import { __setDocumentForTest, resetFontLoaderCache } from './FontLoader'
import { saveSlotToGameState, resolveCharacterImageUrls } from './novelLayout'
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

  // #407: 立ち絵フェードの既定値が 300ms → 700ms に変わったことの固定（DEFAULT_FADE_MS）。
  //   character_fade_ms 未指定（setCharacterFadeMs 未呼び出し）の全作品の立ち絵フェードが 700ms になる。
  //   DEFAULT_FADE_MS は export されていないので、挙動（fadeAnimation.durationMs）で観測する。
  //   併せて背景フェード既定 BACKGROUND_CROSSFADE_MS と揃っている（#407 の意図）ことも縛る。
  it('character_fade_ms 未指定の show() フェードインは既定 700ms(#407) で走る', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue({ width: 200, height: 400 } as never)
    const layer = new CharacterLayer(800, 450)
    // setCharacterFadeMs を呼ばない ＝ frontmatter 未指定 ＝ 既定 characterFadeMs(DEFAULT_FADE_MS)。
    layer.show('hero', 'normal', '中央', '/assets')
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    // texture-gate: 読込完了後にフェード開始（#17 と同じ経路）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state!.fadeAnimation).not.toBeNull()
    const fade = state!.fadeAnimation as unknown as { durationMs: number }
    expect(fade.durationMs).toBe(700) // #407 で 300→700
    expect(fade.durationMs).toBe(BACKGROUND_CROSSFADE_MS) // 背景フェード既定と揃う
  })

  it('character_fade_ms 未指定の remove() フェードアウトも既定 700ms(#407)', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    layer.remove('hero')
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    expect(state!.fadeAnimation).not.toBeNull()
    const fade = state!.fadeAnimation as unknown as { durationMs: number; toAlpha: number }
    expect(fade.toAlpha).toBe(0)
    expect(fade.durationMs).toBe(700) // #407 で 300→700
    expect(fade.durationMs).toBe(BACKGROUND_CROSSFADE_MS)
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

  // own-property ルックアップ修正の確認（#368。#364 resolveCharacterHeightRatio と同種の
  // prototype pollution 相当の不具合）。
  it('修正確認: Object.prototype のプロパティ名 "constructor" は未知の値としてそのまま返す（関数オブジェクトを返さない）', () => {
    expect(normalizePosition('constructor')).toBe('constructor')
  })

  it.each([
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__proto__',
  ])(
    '修正確認: position が Object.prototype のプロパティ名 "%s" でも own-property が無ければそのまま返す',
    (name) => {
      expect(normalizePosition(name)).toBe(name)
    }
  )

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

  // own-property ルックアップ修正の確認（#368）。position トークンが Object.prototype の
  // プロパティ名と一致しても、positionX テーブルの own-property が無ければ center にフォールバック
  // する（関数オブジェクトを sprite.x に代入しない）。
  it('修正確認: position が "constructor" でも sprite.x は center (800 * 0.5 = 400) にフォールバックする', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', 'constructor', '/assets', { instant: true })
    const state = asInternals(layer).characters.get('hero')
    expect(state).toBeDefined()
    expect(state!.sprite.x).toBeCloseTo(400, 0)
  })

  it.each(['toString', '__proto__', 'hasOwnProperty'])(
    '修正確認: position "%s" でも sprite.x は center にフォールバックする',
    (name) => {
      const layer = new CharacterLayer(800, 450)
      layer.show('hero', 'normal', name, '/assets', { instant: true })
      const state = asInternals(layer).characters.get('hero')
      expect(state).toBeDefined()
      expect(state!.sprite.x).toBeCloseTo(400, 0)
    }
  )

  it('状態遷移確認: constructor で center フォールバック後、left へ再配置すると正しく反映される', () => {
    const layer = new CharacterLayer(800, 450)
    layer.show('hero', 'normal', 'constructor', '/assets', { instant: true })
    const stateBefore = asInternals(layer).characters.get('hero')
    expect(stateBefore).toBeDefined()
    expect(stateBefore!.sprite.x).toBeCloseTo(400, 0)
    layer.show('hero', 'normal', 'left', '/assets', { instant: true })
    const stateAfter = asInternals(layer).characters.get('hero')
    expect(stateAfter).toBeDefined()
    // left = screenWidth(800) * CHARACTER_X_RATIO.left(150/800) = 150
    expect(stateAfter!.sprite.x).toBeCloseTo(150, 0)
  })

  it('修正確認: 既存 Title を position "constructor" で再配置（x/y override 無し）しても sprite.x は center にフォールバックする', () => {
    const layer = new CharacterLayer(800, 450)
    layer.showTitle('orber', 'sans-serif')
    layer.showTitle('orber', 'sans-serif', 'constructor')
    const state = asInternals(layer).characters.get('Title')
    expect(state).toBeDefined()
    expect(state!.sprite.x).toBeCloseTo(400, 0)
  })

  it.each(['toString', '__proto__'])(
    '修正確認: 既存 Title を position "%s" で再配置しても center にフォールバックする',
    (name) => {
      const layer = new CharacterLayer(800, 450)
      layer.showTitle('orber', 'sans-serif')
      layer.showTitle('orber', 'sans-serif', name)
      const state = asInternals(layer).characters.get('Title')
      expect(state).toBeDefined()
      expect(state!.sprite.x).toBeCloseTo(400, 0)
    }
  )
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
  snapshotHidden?: boolean
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

  // ---- 非正 ratio ガードの対称化（#360 セルフレビュー nit a）----
  // texH/screenH は「非有限 or 非正」をガードするのに、以前は ratio が非有限しかガードされず、
  // 有限で ratio<=0 だと scale=0（不可視）や負（上下反転）を返した。全引数で「不正入力→1」に統一する。
  it('非正の ratio（0・負値）は原寸 1 に倒す（scale=0 の不可視・負の反転を防ぐ）', () => {
    expect(computeTargetHeightScale(1000, 0, SH)).toBe(1)
    expect(computeTargetHeightScale(1000, -0.5, SH)).toBe(1)
    expect(computeTargetHeightScale(1000, -1, SH)).toBe(1)
    // 有限で正の最小級（下限クランプ前の生値）は素通し＝式どおり（非正だけを弾く）。
    expect(computeTargetHeightScale(1000, 0.0001, SH)).toBeCloseTo((0.0001 * SH) / 1000, 12)
  })

  it('非有限・非正の screenH は原寸 1 に倒す（screen 側ガード）', () => {
    expect(computeTargetHeightScale(1000, 0.8, Number.NaN)).toBe(1)
    expect(computeTargetHeightScale(1000, 0.8, Number.POSITIVE_INFINITY)).toBe(1)
    expect(computeTargetHeightScale(1000, 0.8, 0)).toBe(1)
    expect(computeTargetHeightScale(1000, 0.8, -SH)).toBe(1)
  })
})

// =====================================================================================
// #364: resolveCharacterHeightRatio 純粋関数。
//   優先順位: ratios[characterName]（per-character override）> defaultRatio（スクリプト単位）> null。
//   ratios のルックアップは own-property のみ見る（セルフレビュー修正）: `ratios[characterName]`
//   の素朴なブラケットアクセスは Object.prototype を辿ってしまい、キャラ名が `constructor` /
//   `toString` 等と一致すると関数オブジェクトを返す（呼び出し側の Number.isFinite ガードで
//   静かに scale=1 に化ける）。T-RESOLVE-05/06 は修正後の正しい挙動を縛る。
// =====================================================================================
describe('resolveCharacterHeightRatio 純粋関数（#364 per-character override 解決）', () => {
  it('override があれば override が勝つ（defaultRatio は無視）', () => {
    expect(resolveCharacterHeightRatio('theo', { theo: 0.65, hue: 0.68 }, null)).toBe(0.65)
  })

  it('override があれば defaultRatio が非 null でも override が勝つ', () => {
    expect(resolveCharacterHeightRatio('theo', { theo: 0.65 }, 0.9)).toBe(0.65)
  })

  it('override が無ければ defaultRatio が null のとき null を返す', () => {
    expect(resolveCharacterHeightRatio('aristo', { theo: 0.65 }, null)).toBeNull()
  })

  it('override が無ければ defaultRatio へフォールバックする', () => {
    expect(resolveCharacterHeightRatio('aristo', { theo: 0.65 }, 0.9)).toBe(0.9)
  })

  // ---- prototype pollution 修正の確認（#364 セルフレビュー）----
  it('修正確認: キャラ名が Object.prototype のプロパティ名 "constructor" でも own-property が無ければ defaultRatio を返す（関数オブジェクトを返さない）', () => {
    expect(resolveCharacterHeightRatio('constructor', {}, 0.9)).toBe(0.9)
  })

  it('修正確認: キャラ名が Object.prototype のプロパティ名 "toString" でも own-property が無ければ null を返す（関数オブジェクトを返さない）', () => {
    expect(resolveCharacterHeightRatio('toString', { theo: 0.5 }, null)).toBeNull()
  })

  it('ratios が空オブジェクトで defaultRatio も null なら null', () => {
    expect(resolveCharacterHeightRatio('theo', {}, null)).toBeNull()
  })

  it('ratios が空オブジェクトなら defaultRatio へフォールバックする', () => {
    expect(resolveCharacterHeightRatio('theo', {}, 0.7)).toBe(0.7)
  })

  it('override 値は再クランプせず生値のまま透過する（クランプは setCharacterHeightRatios の責務）', () => {
    expect(resolveCharacterHeightRatio('theo', { theo: 0.05 }, null)).toBe(0.05)
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
// #364: setCharacterHeightRatios（複数形・per-character override マップ）のクランプ/正規化。
//   null/undefined → 空 Record（マップ override なし）、各値は [0.05, 2.0] へクランプ、
//   非有限・非正の値はキーごと除去する。保持値は private characterHeightRatios を直読みして縛る
//   （setCharacterHeightRatio の単数形テストと同じ流儀）。全置換（マージでない）ことも縛る。
// =====================================================================================
describe('CharacterLayer setCharacterHeightRatios クランプ/正規化（#364）', () => {
  interface HRatiosInternals {
    characterHeightRatios: Record<string, number>
  }
  function hsInternals(layer: CharacterLayer): HRatiosInternals {
    return layer as unknown as HRatiosInternals
  }

  it('初期値（setter 未呼び出し）は空 Record（override なし・後方互換）', () => {
    const layer = new CharacterLayer(450, 800)
    expect(hsInternals(layer).characterHeightRatios).toEqual({})
  })

  it('null を渡すと characterHeightRatios は空 Record になる', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios(null)
    expect(hsInternals(layer).characterHeightRatios).toEqual({})
  })

  it('undefined を渡すと characterHeightRatios は空 Record になる', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios(undefined)
    expect(hsInternals(layer).characterHeightRatios).toEqual({})
  })

  it('値が入った状態から null を呼ぶと空 Record に戻る（残留しない）', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ theo: 0.5 })
    expect(hsInternals(layer).characterHeightRatios).toEqual({ theo: 0.5 })
    layer.setCharacterHeightRatios(null)
    expect(hsInternals(layer).characterHeightRatios).toEqual({})
  })

  it('{theo: 0.5} はそのまま透過する（クランプされない）', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ theo: 0.5 })
    expect(hsInternals(layer).characterHeightRatios.theo).toBeCloseTo(0.5, 10)
  })

  it('{theo: 0.01} は下限 0.05 にクランプされる', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ theo: 0.01 })
    expect(hsInternals(layer).characterHeightRatios.theo).toBeCloseTo(0.05, 10)
  })

  it('{theo: 5} は上限 2.0 にクランプされる', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ theo: 5 })
    expect(hsInternals(layer).characterHeightRatios.theo).toBeCloseTo(2.0, 10)
  })

  // ---- 非有効値（0 / 負値 / NaN / ±Infinity）はキー自体が消える。隣接する正常キーは巻き込まれない ----
  it.each([
    ['0', 0],
    ['-0.5', -0.5],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ] as const)(
    '非有効値 %s はキーごと除去され、隣接する正常キー(hue)は巻き込まれない',
    (_label, input) => {
      const layer = new CharacterLayer(450, 800)
      layer.setCharacterHeightRatios({ theo: input, hue: 0.6 })
      const ratios = hsInternals(layer).characterHeightRatios
      expect(Object.prototype.hasOwnProperty.call(ratios, 'theo')).toBe(false)
      expect(ratios.hue).toBeCloseTo(0.6, 10)
    }
  )

  // ---- `>`取り違え境界: 0 は採用不可（非正）、0.0001 は採用可（下限 0.05 にクランプされる） ----
  it.each([
    [-0.0001, false],
    [0, false],
    [0.0001, true],
  ] as const)('値=%f の採用可否は %s（採用時は下限 0.05 にクランプ）', (input, adopted) => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ theo: input })
    const ratios = hsInternals(layer).characterHeightRatios
    expect(Object.prototype.hasOwnProperty.call(ratios, 'theo')).toBe(adopted)
    if (adopted) {
      expect(ratios.theo).toBeCloseTo(0.05, 10)
    }
  })

  // ---- 下端境界 3 点（端点±ε） ----
  it.each([
    [0.0499, 0.05],
    [0.05, 0.05],
    [0.0501, 0.0501],
  ] as const)('下端境界 theo=%f は %f として保持される', (input, effective) => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ theo: input })
    expect(hsInternals(layer).characterHeightRatios.theo).toBeCloseTo(effective, 10)
  })

  // ---- 上端境界 3 点（端点±ε） ----
  it.each([
    [1.9999, 1.9999],
    [2, 2],
    [2.0001, 2],
  ] as const)('上端境界 theo=%f は %f として保持される', (input, effective) => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ theo: input })
    expect(hsInternals(layer).characterHeightRatios.theo).toBeCloseTo(effective, 10)
  })

  it('空オブジェクト {} は空 Record のまま', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({})
    expect(hsInternals(layer).characterHeightRatios).toEqual({})
  })

  it('複数キーはそれぞれ個別に正しい値で保持される', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ theo: 0.65, hue: 0.68, aristo: 0.68 })
    const ratios = hsInternals(layer).characterHeightRatios
    expect(ratios.theo).toBeCloseTo(0.65, 10)
    expect(ratios.hue).toBeCloseTo(0.68, 10)
    expect(ratios.aristo).toBeCloseTo(0.68, 10)
  })

  it('再呼び出しはマージでなく全置換される（前回のキーは残らない）', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ theo: 0.65, hue: 0.68 })
    expect(hsInternals(layer).characterHeightRatios).toEqual({ theo: 0.65, hue: 0.68 })
    layer.setCharacterHeightRatios({ hue: 0.7 })
    const ratios = hsInternals(layer).characterHeightRatios
    expect(Object.prototype.hasOwnProperty.call(ratios, 'theo')).toBe(false)
    expect(ratios.hue).toBeCloseTo(0.7, 10)
    expect(Object.keys(ratios)).toEqual(['hue'])
  })

  // #370: キャラ名（frontmatter character_height_ratios 由来の自由文字列）が "__proto__" だと、
  // 素朴な `next[name] = ...` は next 自身の [[Prototype]] を書き換えてしまう
  // （prototype pollution）。own-property として登録され、[[Prototype]] が汚染されないことを
  // 確認する。computed key で own property として "__proto__" を持つ入力を作る点に注意
  // （object literal の `{ '__proto__': x }` は proto 設定として特別扱いされ own property にならない）。
  it('キャラ名が "__proto__" でも [[Prototype]] を汚染せず own-property として登録される', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ ['__proto__']: 0.8, hue: 0.6 })
    const ratios = hsInternals(layer).characterHeightRatios
    expect(Object.getPrototypeOf(ratios)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(ratios, '__proto__')).toBe(true)
    expect(ratios['__proto__']).toBeCloseTo(0.8, 10)
    // 隣接する正常キーも巻き込まれない
    expect(ratios.hue).toBeCloseTo(0.6, 10)
  })

  // #370: キャラ名が "__proto__" であっても、通常キーと同じクランプ規約（[0.05, 2.0]）が
  // own-property 化の経路（safeAssign）でも変わらず適用されることを確認する。
  it('キャラ名が "__proto__" で値が上限超え(5)なら 2.0 にクランプされた上で own-property 化される', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ ['__proto__']: 5 })
    const ratios = hsInternals(layer).characterHeightRatios
    expect(Object.getPrototypeOf(ratios)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(ratios, '__proto__')).toBe(true)
    expect(ratios['__proto__']).toBeCloseTo(2.0, 10)
  })

  it('キャラ名が "__proto__" で値が下限未満・正(0.001)なら 0.05 にクランプされた上で own-property 化される', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ ['__proto__']: 0.001 })
    const ratios = hsInternals(layer).characterHeightRatios
    expect(Object.prototype.hasOwnProperty.call(ratios, '__proto__')).toBe(true)
    expect(ratios['__proto__']).toBeCloseTo(0.05, 10)
  })

  // #370: setCharacterHeightRatios は全置換（マージでない）。"__proto__" キーで own-property 化
  // された前回の値も、通常キーと同じく次の呼び出しで消える（残留しない）ことを確認する。
  it('"__proto__" キーを含む状態から再呼び出しすると前回のキーは残らない（全置換）', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterHeightRatios({ ['__proto__']: 0.8 })
    expect(
      Object.prototype.hasOwnProperty.call(hsInternals(layer).characterHeightRatios, '__proto__')
    ).toBe(true)
    layer.setCharacterHeightRatios({ hue: 0.6 })
    const ratios = hsInternals(layer).characterHeightRatios
    expect(Object.prototype.hasOwnProperty.call(ratios, '__proto__')).toBe(false)
    expect(ratios.hue).toBeCloseTo(0.6, 10)
    expect(Object.keys(ratios)).toEqual(['hue'])
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

  // ---- (e) アニメ進行中の立ち絵は即再適用の対象外（animation !== null 除外・#360 修正3）----
  //   setCharacterYRatio の F14 と対称。ticker は進めないので animate(dy) は scale を焼き込まず、
  //   除外が効いていれば scale は据え置きのまま。texture はロード済み（height>0）なので、
  //   scale が動かない理由が「texture 未ロード」ではなく「アニメ除外」であることを分離できる。
  it('(e) アニメ進行中（animation 非 null）の立ち絵は setCharacterHeightRatio の即再適用対象外（scale 不変）', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')! as unknown as {
      sprite: { scale: { x: number; y: number } }
      animation: unknown
    }
    // texture ロード済み・heightRatio 未設定なので原寸 1。
    expect(st.sprite.scale.x).toBe(1)
    // 非ゼロ duration の animate で animation を進行中にする（dy 移動なので scale は即時変更しない）。
    layer.animate('hero', { dy: '-100', duration_ms: 500 })
    expect(st.animation).not.toBeNull()
    expect(st.sprite.scale.x).toBe(1)
    // heightRatio を設定してもアニメ中なので即再適用はスキップされ、scale は据え置き。
    const ratio = 0.3
    layer.setCharacterHeightRatio(ratio)
    const wouldBe = computeTargetHeightScale(texH, ratio, SH)
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
    // 除外されなければ wouldBe(≠1) になっていたはず＝アニメ除外が効いている裏取り。
    expect(wouldBe).not.toBeCloseTo(1, 6)
    expect(st.sprite.scale.x).not.toBeCloseTo(wouldBe, 6)
  })

  // ---- (e) 名札の再フィット: 縮んだ立ち絵から名札がはみ出さない（#360 修正1・should）----
  //   off_right/off_left で登場した名札付き立ち絵は、ライブに heightRatio を変えると sprite が縮む。
  //   このとき loadTexture と同じ「名札を sprite 幅に収める」処理（fitLabelToSprite）を即再適用ループ
  //   からも呼び、名札が縮んだ sprite からはみ出さないようにする。
  //
  //   jsdom 制約: 実 PixiJS Text の width 測定は canvas 2D コンテキストを要し、jsdom（canvas 未
  //   インストール）では読むだけで throw する（"Cannot set properties of null (setting 'font')"）。
  //   さらに実 Sprite.width は texture.orig.width を要し、偽 texture には無い。そこで観測可能にするため
  //   (1) sprite.texture に orig 付きの偽 texture を与え（Sprite.width = scale.x * orig.width を計算可能に）、
  //   (2) state.label を width getter が scale 連動する観測可能な偽ラベルに差し替える。
  //   これで setCharacterHeightRatio の実ループ → fitLabelToSprite の実 fit 演算（配線＋計算）を縛れる。
  it('(e) 名札付き立ち絵の即再適用で名札が縮んだ sprite 幅に収め直される（#360 修正1・配線＋fit）', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    // 中央（名札なし）で出して texture をロード（off_right の実 Text は jsdom で width 測定不可）。
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const raw = imageChars(layer).characters.get('hero')! as unknown as {
      sprite: { scale: { x: number }; texture: unknown }
      label?: unknown
    }
    // Sprite.width = scale.x * orig.width を計算可能にするため orig 付き texture を与える。
    raw.sprite.texture = { width: SW, height: texH, orig: { width: SW, height: texH } }
    // 観測可能な偽ラベル。実 Text の width は canvas 測定に依存するので、scale 連動の getter で模す
    // （fitLabelToSprite は scale=1 に戻して natural width を測る → 実 Text と同じ意味論）。
    const naturalW = 10_000 // sprite 幅より確実に広い長い名札
    const fakeScale = {
      x: 1,
      y: 1,
      set(a: number, b?: number) {
        this.x = a
        this.y = b ?? a
      },
    }
    raw.label = {
      destroyed: false,
      scale: fakeScale,
      get width(): number {
        return naturalW * fakeScale.x
      },
    }
    // heightRatio を設定 → 立ち絵を縮小し、名札も新しい sprite 幅へ収め直す。
    const ratio = 0.3
    layer.setCharacterHeightRatio(ratio)
    const spriteScale = computeTargetHeightScale(texH, ratio, SH)
    const spriteW = SW * spriteScale
    // 名札 scale = sprite幅 / 名札自然幅（等比縮小）。
    expect(fakeScale.x).toBeCloseTo(spriteW / naturalW, 6)
    expect(fakeScale.x).toBe(fakeScale.y)
    // 収め直した名札の表示幅は sprite 幅以内（はみ出さない）。
    expect(naturalW * fakeScale.x).toBeCloseTo(spriteW, 4)
    expect(naturalW * fakeScale.x).toBeLessThanOrEqual(spriteW + 1e-6)
  })

  // ---- (f) #364: character_height_ratios（per-character override）の loadTexture 適用 ----
  //   優先順位 (#360 / #364): fit(#294) > per-character override > per-game character_height_ratio > 原寸1。
  it('(f) T-LOAD-01: override 単体（スクリプトデフォルト未設定）で効く', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatios({ hero: 0.8 })
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const expected = computeTargetHeightScale(texH, 0.8, SH)
    expect(st.sprite.scale.x).toBeCloseTo(expected, 10)
    expect(st.sprite.scale.y).toBeCloseTo(expected, 10)
  })

  it('(f) T-LOAD-02: override とスクリプトデフォルト両方設定時は override が勝つ（デフォルト値ではないことも反証）', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatio(0.3)
    layer.setCharacterHeightRatios({ hero: 0.8 })
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const overrideScale = computeTargetHeightScale(texH, 0.8, SH)
    const defaultScale = computeTargetHeightScale(texH, 0.3, SH)
    expect(st.sprite.scale.x).toBeCloseTo(overrideScale, 10)
    // default 値ではないことも反証する（override が本当に勝っていることの裏取り）。
    expect(st.sprite.scale.x).not.toBeCloseTo(defaultScale, 6)
  })

  it('(f) T-LOAD-03: override マップに対象外キャラ名がいても無害で、スクリプトデフォルトへフォールバックする', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatio(0.3)
    layer.setCharacterHeightRatios({ someoneElse: 0.9 })
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const expected = computeTargetHeightScale(texH, 0.3, SH)
    expect(st.sprite.scale.x).toBeCloseTo(expected, 10)
  })

  it('(f) T-LOAD-04: override・スクリプトデフォルトともに未設定なら原寸 scale=1', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatios({ someoneElse: 0.9 })
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })

  it('(f) T-LOAD-05: fit=true は override より優先される（fit の scale のまま、override の scale とは不一致）', async () => {
    const texW = SW * 2
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(texW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatios({ hero: 0.8 })
    layer.show('hero', 'normal', '中央', '/assets', { instant: true, fit: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const fitScale = computeFitScale(texW, texH, SW, SH)
    const overrideScale = computeTargetHeightScale(texH, 0.8, SH)
    expect(st.sprite.scale.x).toBe(fitScale)
    expect(st.sprite.scale.y).toBe(fitScale)
    // fit が勝つので override 由来の scale ではない（両者が別値であることを前提に反証）。
    expect(fitScale).not.toBeCloseTo(overrideScale, 6)
    expect(st.sprite.scale.x).not.toBeCloseTo(overrideScale, 6)
  })

  it('(f) T-LOAD-06（核心の回帰確認）: 2 キャラ同時表示は同一 texH でも override により異なる scale になる', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatios({ theo: 0.5, hue: 0.9 })
    layer.show('theo', 'normal', '左', '/assets', { instant: true })
    layer.show('hue', 'normal', '右', '/assets', { instant: true })
    await flushPromises()
    const theoState = imageChars(layer).characters.get('theo')!
    const hueState = imageChars(layer).characters.get('hue')!
    const theoExpected = computeTargetHeightScale(texH, 0.5, SH)
    const hueExpected = computeTargetHeightScale(texH, 0.9, SH)
    expect(theoState.sprite.scale.x).toBeCloseTo(theoExpected, 10)
    expect(hueState.sprite.scale.x).toBeCloseTo(hueExpected, 10)
    // 同一テクスチャ高さ（texH 同じ）でも身長差が潰れず、異なる scale になること（#364 の核心）。
    expect(theoState.sprite.scale.x).not.toBeCloseTo(hueState.sprite.scale.x, 6)
  })

  it('(f) T-LOAD-07: showImage / showTitle は render-only につき loadTexture 非経由。override 設定後も自前 sizing のまま不変', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    // showImage / showTitle が使う id と同名のキーを override に入れても無関係（loadTexture を通らない）。
    layer.setCharacterHeightRatios({ avatar: 0.8, Title: 0.8 })
    layer.showImage({ id: 'avatar', path: 'a.png', assetBaseUrl: '/assets' })
    await flushPromises()
    const image = imageChars(layer).characters.get('avatar')!
    expect(image.sprite.scale.x).toBe(1)
    expect(image.sprite.scale.y).toBe(1)
    layer.showTitle('orber', 'sans-serif')
    const title = imageChars(layer).characters.get('Title')!
    expect(title.sprite.scale.x).toBe(1)
    expect(title.sprite.scale.y).toBe(1)
  })
})

// =====================================================================================
// #360: fitLabelToSprite ヘルパ単体（修正1で loadTexture と即再適用ループが共有する fit 演算）。
//   実 PixiJS Text/Sprite の width は jsdom で canvas を要して測れないため、演算そのものを
//   偽オブジェクトで純粋に縛る（規律4: 単一責務ヘルパの契約を直接テスト）。width getter は
//   scale.x に連動させ、実 Text の「scale=1 に戻して natural width を測る」意味論を再現する。
// =====================================================================================
describe('CharacterLayer fitLabelToSprite ヘルパ（#360 修正1）', () => {
  const { width: SW, height: SH } = ASPECT_RATIOS['9:16']

  interface FakeLabel {
    destroyed: boolean
    scale: { x: number; y: number; set: (a: number, b?: number) => void }
    readonly width: number
  }
  function makeFakeLabel(naturalW: number, destroyed = false): FakeLabel {
    const scale = {
      x: 1,
      y: 1,
      set(a: number, b?: number): void {
        this.x = a
        this.y = b ?? a
      },
    }
    return {
      destroyed,
      scale,
      get width(): number {
        return naturalW * scale.x
      },
    }
  }
  function callFit(layer: CharacterLayer, sprite: unknown, label: unknown): void {
    ;(layer as unknown as { fitLabelToSprite: (s: unknown, l: unknown) => void }).fitLabelToSprite(
      sprite,
      label
    )
  }

  it('名札の natural 幅が sprite 幅を超えたら等比縮小する（scale = sprite幅 / 名札幅）', () => {
    const layer = new CharacterLayer(SW, SH)
    const label = makeFakeLabel(200)
    callFit(layer, { width: 100 }, label)
    expect(label.scale.x).toBeCloseTo(0.5, 10)
    expect(label.scale.y).toBeCloseTo(0.5, 10)
    // 収め直した表示幅は sprite 幅に一致（はみ出さない）。
    expect(label.width).toBeCloseTo(100, 10)
  })

  it('名札が sprite 幅に収まっていれば等倍のまま（拡大しない）', () => {
    const layer = new CharacterLayer(SW, SH)
    const label = makeFakeLabel(80)
    callFit(layer, { width: 100 }, label)
    expect(label.scale.x).toBe(1)
    expect(label.scale.y).toBe(1)
  })

  it('前回縮小済み（scale<1）でも一旦 1 に戻してから測り直す（sprite が広がれば等倍へ復帰）', () => {
    const layer = new CharacterLayer(SW, SH)
    const label = makeFakeLabel(80)
    label.scale.set(0.2, 0.2) // 前回の縮小状態を模す
    // sprite が名札より広い → 1 に戻して測り直し、収まるので等倍。
    callFit(layer, { width: 100 }, label)
    expect(label.scale.x).toBe(1)
  })

  it('label 無し（undefined）は no-op（throw しない）', () => {
    const layer = new CharacterLayer(SW, SH)
    expect(() => callFit(layer, { width: 100 }, undefined)).not.toThrow()
  })

  it('destroy 済み label は no-op（UAF 防止・sprite.width も読まない）', () => {
    const layer = new CharacterLayer(SW, SH)
    const label = makeFakeLabel(200, true)
    // destroyed なら sprite にすら触らない。sprite.width が throw する細工でも安全。
    const sprite = {
      get width(): number {
        throw new Error('should not read sprite.width for destroyed label')
      },
    }
    expect(() => callFit(layer, sprite, label)).not.toThrow()
    // scale は触られない（縮小されない）。
    expect(label.scale.x).toBe(1)
  })
})

// =====================================================================================
// #364: setCharacterHeightRatios のライブ再適用（reapplyCharacterHeightRatios 共有ループ）。
//   setCharacterHeightRatio（単数形 #360）の "(e) 即再適用" テスト群と対称の観点を、
//   複数形 override マップで縛る。除外条件（fit / アニメ中）とラベル追従（fitLabelToSprite 共有）
//   は単数形と同じ実装（reapplyCharacterHeightRatios）を通るため、同じ流儀で確認する。
// =====================================================================================
describe('CharacterLayer character_height_ratios ライブ再適用（#364）', () => {
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
  const { width: SW, height: SH } = ASPECT_RATIOS['9:16']

  it('T-REAPPLY-01: 表示済みキャラに setCharacterHeightRatios を呼ぶと即座に再スケールされる', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    // 設定前は原寸 1（後方互換）。
    expect(st.sprite.scale.x).toBe(1)
    const ratio = 0.8
    layer.setCharacterHeightRatios({ hero: ratio })
    const expected = computeTargetHeightScale(texH, ratio, SH)
    expect(st.sprite.scale.x).toBeCloseTo(expected, 10)
    expect(st.sprite.scale.x).not.toBe(1)
  })

  it('T-REAPPLY-02: マップから外すとスクリプトデフォルト（character_height_ratio）へ即降格する', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatio(0.3)
    layer.setCharacterHeightRatios({ hero: 0.8 })
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const overrideScale = computeTargetHeightScale(texH, 0.8, SH)
    expect(st.sprite.scale.x).toBeCloseTo(overrideScale, 10)
    // hero をマップから外す（他キャラだけ残す）→ スクリプトデフォルト 0.3 へ即降格。
    layer.setCharacterHeightRatios({ other: 0.5 })
    const defaultScale = computeTargetHeightScale(texH, 0.3, SH)
    expect(st.sprite.scale.x).toBeCloseTo(defaultScale, 10)
    expect(st.sprite.scale.x).not.toBeCloseTo(overrideScale, 6)
  })

  it('T-REAPPLY-02: スクリプトデフォルトも無い場合はマップから外すと原寸 scale=1 へ即降格する', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatios({ hero: 0.8 })
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    expect(st.sprite.scale.x).not.toBe(1)
    layer.setCharacterHeightRatios(null)
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })

  it('T-REAPPLY-03: fit=true 表示中の立ち絵は setCharacterHeightRatios の即再適用対象外（scale は fit のまま不変）', async () => {
    const texW = SW * 2
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(texW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true, fit: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const fitScale = computeFitScale(texW, texH, SW, SH)
    expect(st.sprite.scale.x).toBe(fitScale)
    layer.setCharacterHeightRatios({ hero: 0.3 })
    expect(st.sprite.scale.x).toBe(fitScale)
    expect(st.sprite.scale.y).toBe(fitScale)
  })

  it('T-REAPPLY-04: アニメ進行中（animation 非 null）の立ち絵は setCharacterHeightRatios の即再適用対象外（scale 不変）', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')! as unknown as {
      sprite: { scale: { x: number; y: number } }
      animation: unknown
    }
    expect(st.sprite.scale.x).toBe(1)
    // 非ゼロ duration の animate で animation を進行中にする（dy 移動なので scale は即時変更しない）。
    layer.animate('hero', { dy: '-100', duration_ms: 500 })
    expect(st.animation).not.toBeNull()
    const ratio = 0.3
    layer.setCharacterHeightRatios({ hero: ratio })
    const wouldBe = computeTargetHeightScale(texH, ratio, SH)
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
    // 除外されなければ wouldBe(≠1) になっていたはず＝アニメ除外が効いている裏取り。
    expect(wouldBe).not.toBeCloseTo(1, 6)
    expect(st.sprite.scale.x).not.toBeCloseTo(wouldBe, 6)
  })

  // jsdom 制約は単数形の "(e) 名札の再フィット" テストと同じ（実 Text.width は canvas 測定に依存し
  // jsdom では throw するため、偽 label/texture で fitLabelToSprite の実演算を観測可能にする）。
  it('T-REAPPLY-05: 名札付き立ち絵の即再適用で名札が縮んだ sprite 幅に収め直される（fitLabelToSprite 配線＋fit）', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const raw = imageChars(layer).characters.get('hero')! as unknown as {
      sprite: { scale: { x: number }; texture: unknown }
      label?: unknown
    }
    raw.sprite.texture = { width: SW, height: texH, orig: { width: SW, height: texH } }
    const naturalW = 10_000 // sprite 幅より確実に広い長い名札
    const fakeScale = {
      x: 1,
      y: 1,
      set(a: number, b?: number) {
        this.x = a
        this.y = b ?? a
      },
    }
    raw.label = {
      destroyed: false,
      scale: fakeScale,
      get width(): number {
        return naturalW * fakeScale.x
      },
    }
    const ratio = 0.3
    layer.setCharacterHeightRatios({ hero: ratio })
    const spriteScale = computeTargetHeightScale(texH, ratio, SH)
    const spriteW = SW * spriteScale
    expect(fakeScale.x).toBeCloseTo(spriteW / naturalW, 6)
    expect(fakeScale.x).toBe(fakeScale.y)
    expect(naturalW * fakeScale.x).toBeCloseTo(spriteW, 4)
    expect(naturalW * fakeScale.x).toBeLessThanOrEqual(spriteW + 1e-6)
  })

  // ---- T-REAPPLY-06: texture 未ロード時は例外を投げない ----
  // 実測 (session 検証): pixi.js v8 の Sprite() 既定テクスチャ（Texture.EMPTY 相当）は
  // orig.height=1（0 ではない）ため、"texture.height <= 0" ガードは実際には素通りし、
  // 未ロード中の一時的な scale 計算が起きる。ここでは (1) 例外を投げないこと、
  // (2) texture ロード完了後は loadTexture 自身が override 由来の正しい scale で
  // 上書きし最終的に破綻しないこと、の 2 点を現状の実装に即して縛る
  // （「並行実行中は一切何もしない」という強い主張はしない）。
  it('T-REAPPLY-06: texture 未ロード中に setCharacterHeightRatios を呼んでも例外を投げず、ロード完了後は正しい scale に収束する', async () => {
    const texH = SH * 2
    let resolveLoad!: (texture: unknown) => void
    vi.spyOn(Assets, 'load').mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve
      }) as never
    )
    const layer = new CharacterLayer(SW, SH)
    // texture 未ロード（Assets.load が pending のまま）。
    layer.show('hero', 'normal', '中央', '/assets')
    expect(() => layer.setCharacterHeightRatios({ hero: 0.9 })).not.toThrow()
    // texture ロード完了 → loadTexture が resolveCharacterHeightRatio で正しい override を
    // 解決し直し、最終的な scale は override 由来の値に収束する。
    resolveLoad(fakeTexture(SW, texH))
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const expected = computeTargetHeightScale(texH, 0.9, SH)
    expect(st.sprite.scale.x).toBeCloseTo(expected, 10)
  })
})

// =====================================================================================
// #364: クロスフェード中の新旧 sprite と height_ratio 再適用。
//   show() の表情変更クロスフェード（#337）は旧 sprite を `${character}__transition_N` という
//   別キー（snapshotHidden: true）へリネームして両立させる。reapplyCharacterHeightRatios は
//   getCharacterStates（#337 の前例）と同じく snapshotHidden な state を再スケール対象から除外する。
//   旧 sprite は Map キーがそのまま override 解決に使われる訳ではなくなり（そもそも触らない）、
//   クロスフェード中に override を変更しても旧 sprite は元のスケールのまま変化しない。
//   新 sprite は loadTexture が実際の character 名を明示引数で渡すため、texture ロード完了後に
//   正しく override が効く。
// =====================================================================================
describe('CharacterLayer クロスフェード中の character_height_ratios 再適用: 旧 sprite を除外して不一致を防ぐ（#364）', () => {
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
  const { width: SW, height: SH } = ASPECT_RATIOS['9:16']

  it('T-RACE-01: クロスフェード中に override を変更しても、旧 sprite（transition key・snapshotHidden）は再スケール対象から除外され元のスケールのまま変化せず、新 sprite は texture ロード完了後に新 override が正しく効く', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatios({ hero: 0.5 })
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const chars = imageChars(layer).characters
    const beforeScale = chars.get('hero')!.sprite.scale.x
    expect(beforeScale).toBeCloseTo(computeTargetHeightScale(texH, 0.5, SH), 10)

    // 表情変更 → 非 instant・既定 fade あり → クロスフェード分岐（#337）。
    // 旧 sprite は `hero__transition_N` へリネームされ（snapshotHidden: true）、
    // 新 sprite が新規に 'hero' キーへ入る。
    layer.show('hero', 'sad', '中央', '/assets')
    const oldKey = [...chars.keys()].find((k) => k !== 'hero')!
    expect(oldKey).toMatch(/^hero__transition_/)
    expect(chars.get(oldKey)!.snapshotHidden).toBe(true)

    // クロスフェード中（新 sprite の texture load 未完了）に override を変更する。
    layer.setCharacterHeightRatios({ hero: 0.9 })

    // 修正後の挙動: 旧 sprite は snapshotHidden により再スケール対象から除外されるため、
    // override 変更の影響を受けず、クロスフェード開始時点のスケールのまま変化しない
    // （transition key が override マップにヒットせず原寸 1 に落ちる、という不一致は起きない）。
    expect(chars.get(oldKey)!.sprite.scale.x).toBeCloseTo(beforeScale, 10)

    await flushPromises()

    // 新 sprite は loadTexture が実引数の characterName="hero" で正しく override を解決するため、
    // texture ロード完了後は override 0.9 が正しく効く。
    const newScaleAfterLoad = chars.get('hero')!.sprite.scale.x
    expect(newScaleAfterLoad).toBeCloseTo(computeTargetHeightScale(texH, 0.9, SH), 10)

    // 旧 sprite はその後も reapplyCharacterHeightRatios の対象外のままなので、
    // クロスフェード開始時点のスケールを保ち続ける（新 sprite に引きずられて崩れない）。
    const oldScaleAfterLoad = chars.get(oldKey)!.sprite.scale.x
    expect(oldScaleAfterLoad).toBeCloseTo(beforeScale, 10)
  })
})

// =====================================================================================
// #376: loadTexture の webp→png フォールバック（loadFirstAvailableTexture 経由）。
//   候補は resolveCharacterImageUrls が作る [.webp, .png]。loadTexture は先頭から Assets.load し、
//   最初に成功した Texture を使う。全滅時のみ console.warn（joined URL・最後のエラー）で false を返す。
//   onReady は 成功 / フォールバック成功 / 全滅 / assetBaseUrl 空 いずれでも finally でちょうど 1 回
//   発火する（#293 セマンティクス）。
//
//   loadTexture は private。戻り値 Promise<boolean>・onReady 発火回数・console.warn・どの URL を
//   load したかは全て CPU 側で観測できるので、show() の非公開経路に頼らず cast で直接叩いて縛る
//   （show() は boolean を露出しないため。jsdom の canvas 未実装は迂回不要＝観測点が CPU 側で完結）。
//   texture は既存 showImage/#294 テストと同流儀の plain object で足りる（Sprite.texture は dynamic
//   でない値には .on を張らないので plain object を代入・読み戻しできる）。
// =====================================================================================
describe('CharacterLayer loadTexture webp→png フォールバック (#376)', () => {
  afterEach(() => {
    // Assets.load / console.warn の spy を毎テスト後に戻す（assert が throw しても後続へ漏らさない）。
    vi.restoreAllMocks()
    // #389 の瞬断リトライ待機を fake timer で進めるテストがあるので、必ず実タイマーへ戻す。
    vi.useRealTimers()
  })

  interface LoadTextureInternals {
    loadTexture: (
      sprite: Sprite,
      characterName: string,
      expression: string,
      assetBaseUrl: string,
      label?: unknown,
      fit?: boolean,
      onReady?: () => void
    ) => Promise<boolean>
  }
  function asLoadable(layer: CharacterLayer): LoadTextureInternals {
    return layer as unknown as LoadTextureInternals
  }

  // 期待 URL は候補列を作る当の関数 resolveCharacterImageUrls で組み立てて陳腐化を防ぐ（doctrine 規律4）。
  // loadTexture が内部で使うのと同一の候補なので、生の URL 文字列を直書きしていない。
  const BASE = '/assets'
  const EXPR = 'spino/soften'
  const [WEBP_URL, PNG_URL] = resolveCharacterImageUrls(BASE, EXPR)

  // 偽 texture（{width,height} で sprite.texture 代入・scale 計算に足りる。__tag で webp/png を弁別する）。
  const fakeTexture = (tag: 'webp' | 'png'): unknown => ({ width: 100, height: 200, __tag: tag })
  const textureTag = (sprite: Sprite): string | undefined =>
    (sprite.texture as unknown as { __tag?: string }).__tag

  // 観点7: webp 成功 → webp だけを load して使う（png は試さない）・warn なし・onReady 1 回・戻り値 true。
  it('webp 成功なら webp だけを load して使う（png は試さない・warn なし・onReady 1 回・true）', async () => {
    const loadSpy = vi
      .spyOn(Assets, 'load')
      .mockImplementation((url: unknown) =>
        String(url).endsWith('.webp')
          ? (Promise.resolve(fakeTexture('webp')) as never)
          : (Promise.resolve(fakeTexture('png')) as never)
      )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    const sprite = new Sprite()
    let onReadyCount = 0
    const result = await asLoadable(layer).loadTexture(
      sprite,
      'spino',
      EXPR,
      BASE,
      undefined,
      false,
      () => {
        onReadyCount++
      }
    )
    expect(result).toBe(true)
    // webp が先頭で成功したので png は試されない（1 回のみ・webp URL）。
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenNthCalledWith(1, WEBP_URL)
    expect(loadSpy).not.toHaveBeenCalledWith(PNG_URL)
    // 使われた texture は webp。
    expect(textureTag(sprite)).toBe('webp')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(onReadyCount).toBe(1)
  })

  // 観点8: webp 失敗 → png 成功。png Texture へフォールバックし warn なし・onReady 1 回・戻り値 true。
  it('webp が失敗し png が成功すれば png へフォールバックする（warn なし・onReady 1 回・true）', async () => {
    const loadSpy = vi
      .spyOn(Assets, 'load')
      .mockImplementation((url: unknown) =>
        String(url).endsWith('.webp')
          ? (Promise.reject(new Error('webp 413')) as never)
          : (Promise.resolve(fakeTexture('png')) as never)
      )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    const sprite = new Sprite()
    let onReadyCount = 0
    const result = await asLoadable(layer).loadTexture(
      sprite,
      'spino',
      EXPR,
      BASE,
      undefined,
      false,
      () => {
        onReadyCount++
      }
    )
    expect(result).toBe(true)
    // webp → png の順で試し、png で成功する。
    expect(loadSpy).toHaveBeenCalledTimes(2)
    expect(loadSpy).toHaveBeenNthCalledWith(1, WEBP_URL)
    expect(loadSpy).toHaveBeenNthCalledWith(2, PNG_URL)
    // フォールバック先の png texture が使われる。
    expect(textureTag(sprite)).toBe('png')
    // webp が落ちても png が拾えたので警告は出さない。
    expect(warnSpy).not.toHaveBeenCalled()
    expect(onReadyCount).toBe(1)
  })

  // 観点9: 全滅（webp/png とも reject）→ console.warn が joined URL（' , ' 区切り）で 1 回・
  //   第 2 引数は最後（png）のエラー・戻り値 false・onReady 1 回。
  it('webp/png とも失敗なら warn（joined URL・最後のエラー）を 1 回出し false を返す（onReady 1 回）', async () => {
    // #389: 全滅時は 300ms 待機を挟んで 1 回リトライする。実時間を待たず fake timer で進める。
    vi.useFakeTimers()
    const webpErr = new Error('webp fail')
    const pngErr = new Error('png fail')
    const loadSpy = vi
      .spyOn(Assets, 'load')
      .mockImplementation((url: unknown) =>
        String(url).endsWith('.webp')
          ? (Promise.reject(webpErr) as never)
          : (Promise.reject(pngErr) as never)
      )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    const sprite = new Sprite()
    let onReadyCount = 0
    const p = asLoadable(layer).loadTexture(sprite, 'spino', EXPR, BASE, undefined, false, () => {
      onReadyCount++
    })
    // 1 巡目の失敗を消化し、300ms 待機を越えてリトライ 2 巡目（これも全滅）まで走らせて確定させる。
    await vi.advanceTimersByTimeAsync(300)
    const result = await p
    expect(result).toBe(false)
    // 先頭から順に両方試す。全滅時は #389 の瞬断リトライで、待機後もう一巡（webp→png）試す
    // ため計 4 回呼ばれる（初回 2 + リトライ 2）。1〜2 が初回、3〜4 がリトライ。
    expect(loadSpy).toHaveBeenCalledTimes(4)
    expect(loadSpy).toHaveBeenNthCalledWith(1, WEBP_URL)
    expect(loadSpy).toHaveBeenNthCalledWith(2, PNG_URL)
    expect(loadSpy).toHaveBeenNthCalledWith(3, WEBP_URL)
    expect(loadSpy).toHaveBeenNthCalledWith(4, PNG_URL)
    // warn は 1 回だけ（リトライ後の確定失敗で 1 回のみ）。メッセージは joined URL（' , ' 区切り）、
    // 第 2 引数は最後（png）のエラー。
    const expectedMsg = '[name-name] 立ち絵の読み込みに失敗: ' + [WEBP_URL, PNG_URL].join(' , ')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expectedMsg, pngErr)
    expect(onReadyCount).toBe(1)
  })

  // 観点10: assetBaseUrl 空 → Assets.load を呼ばず即 true・onReady 1 回（描画不能でテキストを詰まらせない）。
  it('assetBaseUrl が空ならロードせず即 true・onReady 1 回（Assets.load を呼ばない）', async () => {
    const loadSpy = vi.spyOn(Assets, 'load')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    const sprite = new Sprite()
    let onReadyCount = 0
    const result = await asLoadable(layer).loadTexture(
      sprite,
      'spino',
      EXPR,
      '',
      undefined,
      false,
      () => {
        onReadyCount++
      }
    )
    expect(result).toBe(true)
    expect(loadSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(onReadyCount).toBe(1)
  })

  // 観点11: onReady はどの経路でも複数回発火しない。成功 / フォールバック / 全滅の 3 経路を通し、
  //   各経路で onReady 呼び出しがちょうど 1 回であることを縛る（#293 の finally ちょうど 1 回）。
  it('onReady は成功・フォールバック・全滅のいずれの経路でもちょうど 1 回だけ発火する', async () => {
    const layer = new CharacterLayer(800, 450)

    // 成功経路（webp 成功）。
    let successCount = 0
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture('webp') as never)
    await asLoadable(layer).loadTexture(new Sprite(), 'a', EXPR, BASE, undefined, false, () => {
      successCount++
    })
    expect(successCount).toBe(1)
    vi.restoreAllMocks()

    // フォールバック経路（webp 失敗 → png 成功）。
    let fallbackCount = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockImplementation((url: unknown) =>
      String(url).endsWith('.webp')
        ? (Promise.reject(new Error('x')) as never)
        : (Promise.resolve(fakeTexture('png')) as never)
    )
    await asLoadable(layer).loadTexture(new Sprite(), 'b', EXPR, BASE, undefined, false, () => {
      fallbackCount++
    })
    expect(fallbackCount).toBe(1)
    vi.restoreAllMocks()

    // 全滅経路（webp/png とも失敗）。#389 の 300ms リトライ待機は fake timer で進める。
    vi.useFakeTimers()
    let failCount = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockRejectedValue(new Error('all fail'))
    const failP = asLoadable(layer).loadTexture(
      new Sprite(),
      'c',
      EXPR,
      BASE,
      undefined,
      false,
      () => {
        failCount++
      }
    )
    await vi.advanceTimersByTimeAsync(300)
    await failP
    expect(failCount).toBe(1)
  })
})

// =====================================================================================
// #389: loadFirstAvailableTexture の瞬断リトライ（loadTexture 経由）。
//   全候補（webp→png）が一巡失敗したら、LOAD_RETRY_DELAY_MS(=300ms) だけ待って **1 回だけ**
//   もう一巡リトライしてから確定する。一時的なネットワーク瞬断で #293 のフォールバックが
//   「立ち絵なし・テキストあり」に倒れるのを緩和する。#376 のフォールバック（webp→png）と
//   両立し、成功が挟まればリトライには入らない（過剰ロードを避ける）。
//
//   観測点は #376 と同じく loadTexture を cast で直接叩く（戻り値 boolean・onReady 回数・
//   console.warn・Assets.load の呼び出し列が CPU 側で完結）。待機の 300ms は fake timer で進めるため
//   実時間を待たない（loadTexture の Promise と advanceTimersByTimeAsync を併走させる）。
//   期待 URL は候補を作る resolveCharacterImageUrls で組み立て、生 URL を直書きしない。
// =====================================================================================
describe('CharacterLayer loadFirstAvailableTexture 瞬断リトライ (#389)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // fake timer を使うテストがあるので必ず実タイマーへ戻す（他 describe へ漏らさない）。
    vi.useRealTimers()
  })

  interface LoadTextureInternals {
    loadTexture: (
      sprite: Sprite,
      characterName: string,
      expression: string,
      assetBaseUrl: string,
      label?: unknown,
      fit?: boolean,
      onReady?: () => void
    ) => Promise<boolean>
  }
  function asLoadable(layer: CharacterLayer): LoadTextureInternals {
    return layer as unknown as LoadTextureInternals
  }

  const BASE = '/assets'
  const EXPR = 'spino/soften' // 拡張子なし → webp/png の 2 候補。
  const [WEBP_URL, PNG_URL] = resolveCharacterImageUrls(BASE, EXPR)
  // 拡張子明示 → 候補 1 本（.png のみ）。単一候補の全滅リトライ用。
  const EXPR_PNG = 'spino/soften.png'
  const [PNG_ONLY] = resolveCharacterImageUrls(BASE, EXPR_PNG)

  const fakeTexture = (tag: 'webp' | 'png'): unknown => ({ width: 100, height: 200, __tag: tag })
  const textureTag = (sprite: Sprite): string | undefined =>
    (sprite.texture as unknown as { __tag?: string }).__tag

  // 観点19: 1 巡目 webp/png とも失敗 → 待機 → 2 巡目 webp 成功。load は webp,png,webp の 3 回。
  //   warn なし・戻り値 true・onReady 1 回・texture は webp（瞬断が回復して拾えたら警告は出さない）。
  it('19: 1 巡目全滅→リトライ 2 巡目 webp 成功（load 3 回・warn なし・true・onReady 1）', async () => {
    vi.useFakeTimers()
    let webpCalls = 0
    const loadSpy = vi.spyOn(Assets, 'load').mockImplementation((url: unknown) => {
      if (String(url).endsWith('.webp')) {
        webpCalls++
        // 1 巡目 webp は失敗、リトライ（2 回目）で成功する。
        return (
          webpCalls >= 2
            ? Promise.resolve(fakeTexture('webp'))
            : Promise.reject(new Error('webp glitch'))
        ) as never
      }
      return Promise.reject(new Error('png glitch')) as never
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    const sprite = new Sprite()
    let onReadyCount = 0
    const p = asLoadable(layer).loadTexture(sprite, 'spino', EXPR, BASE, undefined, false, () => {
      onReadyCount++
    })
    // 1 巡目の失敗を消化し、300ms 待機を越えてリトライ 2 巡目を走らせる。
    await vi.advanceTimersByTimeAsync(300)
    const result = await p
    expect(result).toBe(true)
    // 1 巡目 webp,png（失敗）→ 2 巡目 webp（成功）。png はリトライで試す前に webp で成功する。
    expect(loadSpy.mock.calls.map((c) => c[0])).toEqual([WEBP_URL, PNG_URL, WEBP_URL])
    expect(textureTag(sprite)).toBe('webp')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(onReadyCount).toBe(1)
  })

  // 観点20: 1 巡目全滅 → 待機 → 2 巡目 webp 失敗・png 成功。load は webp,png,webp,png の 4 回。
  //   warn なし・true・onReady 1 回・texture は png（リトライ内でも webp→png のフォールバック順を保つ）。
  it('20: 1 巡目全滅→リトライ 2 巡目 png 成功（load 4 回・warn なし・true・onReady 1・png）', async () => {
    vi.useFakeTimers()
    let pngCalls = 0
    const loadSpy = vi.spyOn(Assets, 'load').mockImplementation((url: unknown) => {
      if (String(url).endsWith('.webp')) return Promise.reject(new Error('webp glitch')) as never
      pngCalls++
      // 1 巡目 png は失敗、リトライ（2 回目）で成功する。
      return (
        pngCalls >= 2
          ? Promise.resolve(fakeTexture('png'))
          : Promise.reject(new Error('png glitch'))
      ) as never
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    const sprite = new Sprite()
    let onReadyCount = 0
    const p = asLoadable(layer).loadTexture(sprite, 'spino', EXPR, BASE, undefined, false, () => {
      onReadyCount++
    })
    await vi.advanceTimersByTimeAsync(300)
    const result = await p
    expect(result).toBe(true)
    expect(loadSpy.mock.calls.map((c) => c[0])).toEqual([WEBP_URL, PNG_URL, WEBP_URL, PNG_URL])
    expect(textureTag(sprite)).toBe('png')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(onReadyCount).toBe(1)
  })

  // 観点21: リトライは 300ms 待機を挟む。1 巡目全滅→2 巡目成功のケースで、300ms 未満では未解決、
  //   300ms 経過で初めて解決する（待機時間 LOAD_RETRY_DELAY_MS の存在を縛る）。
  it('21: リトライ前に 300ms 待機する（299ms では未解決・300ms で解決）', async () => {
    vi.useFakeTimers()
    let webpCalls = 0
    vi.spyOn(Assets, 'load').mockImplementation((url: unknown) => {
      if (String(url).endsWith('.webp')) {
        webpCalls++
        return (
          webpCalls >= 2
            ? Promise.resolve(fakeTexture('webp'))
            : Promise.reject(new Error('webp glitch'))
        ) as never
      }
      return Promise.reject(new Error('png glitch')) as never
    })
    const layer = new CharacterLayer(800, 450)
    let settled = false
    const p = asLoadable(layer)
      .loadTexture(new Sprite(), 'spino', EXPR, BASE)
      .then((r) => {
        settled = true
        return r
      })
    // 1 巡目の失敗は消化されるが、待機（300ms）が明けないのでリトライ成功はまだ来ない。
    await vi.advanceTimersByTimeAsync(299)
    expect(settled).toBe(false)
    // 残り 1ms で 300ms に到達 → リトライ 2 巡目 webp 成功で解決する。
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(settled).toBe(true)
  })

  // 観点22: 候補 1 本（expression に `.png` 明示）の全滅は「初回 + リトライ」で最大 2 回 load して確定。
  //   warn 1 回（joined URL は 1 本ぶん・最後のエラー）・戻り値 false・onReady 1 回。
  it('22: 候補 1 本(.png 明示)の全滅は最大 2 回 load で確定（warn 1・false・onReady 1）', async () => {
    vi.useFakeTimers()
    const err = new Error('png glitch')
    const loadSpy = vi.spyOn(Assets, 'load').mockRejectedValue(err as never)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    let onReadyCount = 0
    const p = asLoadable(layer).loadTexture(
      new Sprite(),
      'spino',
      EXPR_PNG,
      BASE,
      undefined,
      false,
      () => {
        onReadyCount++
      }
    )
    await vi.advanceTimersByTimeAsync(300)
    const result = await p
    expect(result).toBe(false)
    // 候補は .png の 1 本。初回 1 + リトライ 1 = 計 2 回試して確定失敗する。
    expect(loadSpy.mock.calls.map((c) => c[0])).toEqual([PNG_ONLY, PNG_ONLY])
    // warn は確定失敗で 1 回だけ。メッセージは候補 1 本ぶんの URL・第 2 引数は最後のエラー。
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith('[name-name] 立ち絵の読み込みに失敗: ' + PNG_ONLY, err)
    expect(onReadyCount).toBe(1)
  })

  // 観点23: 1 巡目 webp 成功はリトライに入らない。load は 1 回だけで、待機（setTimeout）も入らない
  //   （タイマーを一切進めずに await が解決することで「待機なし」を縛る）。
  it('23: 1 巡目 webp 成功はリトライも待機もしない（load 1 回・タイマー未進行で解決）', async () => {
    vi.useFakeTimers()
    const loadSpy = vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture('webp') as never)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const layer = new CharacterLayer(800, 450)
    // タイマーを進めずに await する。リトライ待機（setTimeout）が挟まればここで解決せずハングする。
    const result = await asLoadable(layer).loadTexture(new Sprite(), 'spino', EXPR, BASE)
    expect(result).toBe(true)
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledWith(WEBP_URL)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// =====================================================================================
// #378: clampCharacterScale 純粋関数（立ち絵の元絵基準スケールのクランプ）。
//   値を [CHARACTER_SCALE_MIN, CHARACTER_SCALE_MAX] = [0.05, 4] にクランプする。
//   期待値は export された定数を参照し、0.05 / 4 を直書きしない（#262 直書き禁止）。
//   境界は端点±ε の 3 点を縛り、`>=`/`>` と `<=`/`<` の取り違えを狙う。
//   非有限・非正の弾き（→ null）は setCharacterScale の責務なので、ここでは有限値のクランプだけを縛る。
// =====================================================================================
describe('clampCharacterScale 純粋関数（#378 元絵基準スケールのクランプ）', () => {
  it('範囲内（下限〜上限の間）の値はそのまま返す', () => {
    expect(clampCharacterScale(0.5)).toBe(0.5)
    expect(clampCharacterScale(1)).toBe(1)
    expect(clampCharacterScale(3.9)).toBe(3.9)
  })

  it('下限未満は CHARACTER_SCALE_MIN にクランプされる（0.04 / 0 / 負）', () => {
    expect(clampCharacterScale(0.04)).toBe(CHARACTER_SCALE_MIN)
    expect(clampCharacterScale(0)).toBe(CHARACTER_SCALE_MIN)
    expect(clampCharacterScale(-1)).toBe(CHARACTER_SCALE_MIN)
  })

  it('上限超過は CHARACTER_SCALE_MAX にクランプされる（5 / 100）', () => {
    expect(clampCharacterScale(5)).toBe(CHARACTER_SCALE_MAX)
    expect(clampCharacterScale(100)).toBe(CHARACTER_SCALE_MAX)
  })

  // ±Infinity は clamp のみ（NaN・非正の弾きは setCharacterScale 側）。
  // Math.min/Math.max の素の挙動で +Infinity は上限へ、-Infinity は下限へ落ちる。
  it('+Infinity は上限、-Infinity は下限へクランプされる', () => {
    expect(clampCharacterScale(Number.POSITIVE_INFINITY)).toBe(CHARACTER_SCALE_MAX)
    expect(clampCharacterScale(Number.NEGATIVE_INFINITY)).toBe(CHARACTER_SCALE_MIN)
  })

  // ---- 下端境界 3 点（端点±ε）。下限 CHARACTER_SCALE_MIN の `>=`/`>` 取り違え狙い ----
  it.each([
    [CHARACTER_SCALE_MIN - 0.0001, CHARACTER_SCALE_MIN], // 下限未満 → クランプ
    [CHARACTER_SCALE_MIN, CHARACTER_SCALE_MIN], // 下限ちょうど → 透過
    [CHARACTER_SCALE_MIN + 0.0001, CHARACTER_SCALE_MIN + 0.0001], // 下限直上 → 透過
  ] as const)('下端境界 scale=%f → %f', (input, effective) => {
    expect(clampCharacterScale(input)).toBeCloseTo(effective, 10)
  })

  // ---- 上端境界 3 点（端点±ε）。上限 CHARACTER_SCALE_MAX の `<=`/`<` 取り違え狙い ----
  it.each([
    [CHARACTER_SCALE_MAX - 0.0001, CHARACTER_SCALE_MAX - 0.0001], // 上限直下 → 透過
    [CHARACTER_SCALE_MAX, CHARACTER_SCALE_MAX], // 上限ちょうど → 透過
    [CHARACTER_SCALE_MAX + 0.0001, CHARACTER_SCALE_MAX], // 上限超過 → クランプ
  ] as const)('上端境界 scale=%f → %f', (input, effective) => {
    expect(clampCharacterScale(input)).toBeCloseTo(effective, 10)
  })
})

// =====================================================================================
// #378: setCharacterScale の未設定判定/クランプ。
//   null/undefined/非有限/≤0 → null（未設定＝下位優先順位へフォールバック）。
//   有効値は clampCharacterScale で [CHARACTER_SCALE_MIN, MAX] へクランプして保持する。
//   保持値は private characterScale を直読みして縛る（#360 characterHeightRatio と同じ流儀）。
// =====================================================================================
describe('CharacterLayer setCharacterScale 未設定判定/クランプ（#378）', () => {
  interface ScaleInternals {
    characterScale: number | null
  }
  function sInternals(layer: CharacterLayer): ScaleInternals {
    return layer as unknown as ScaleInternals
  }

  it('初期値（setter 未呼び出し）は null（未設定・後方互換）', () => {
    const layer = new CharacterLayer(450, 800)
    expect(sInternals(layer).characterScale).toBeNull()
  })

  // null/undefined/NaN/±Infinity/0/負 は全て null（未設定＝下位フォールバック）へ倒す。
  // 一度有効値を入れてから無効値で null へ戻ることも確かめる（残留しない）。
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['0', 0],
    ['-1', -1],
  ] as const)('非有効値 %s → characterScale は null（未設定）', (_label, input) => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterScale(1.5)
    expect(sInternals(layer).characterScale).toBe(1.5)
    layer.setCharacterScale(input)
    expect(sInternals(layer).characterScale).toBeNull()
  })

  it('有効値 0.5 はそのまま透過する（クランプされない）', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterScale(0.5)
    expect(sInternals(layer).characterScale).toBeCloseTo(0.5, 10)
  })

  it('上限超過 10 は CHARACTER_SCALE_MAX にクランプされる', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterScale(10)
    expect(sInternals(layer).characterScale).toBeCloseTo(CHARACTER_SCALE_MAX, 10)
  })

  it('下限未満の正値 0.01 は CHARACTER_SCALE_MIN にクランプされる', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterScale(0.01)
    expect(sInternals(layer).characterScale).toBeCloseTo(CHARACTER_SCALE_MIN, 10)
  })

  // 下端境界: 0 は「非正で null」、CHARACTER_SCALE_MIN ちょうどは「採用・透過」に分岐する
  // （setCharacterScale の `<= 0` 弾きと clampCharacterScale の下限クランプの境目）。
  it('下端境界: 0 は非正で null、CHARACTER_SCALE_MIN ちょうどは採用して透過', () => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterScale(0)
    expect(sInternals(layer).characterScale).toBeNull()
    layer.setCharacterScale(CHARACTER_SCALE_MIN)
    expect(sInternals(layer).characterScale).toBeCloseTo(CHARACTER_SCALE_MIN, 10)
  })

  // ---- 上端境界 3 点（端点±ε）。上限 CHARACTER_SCALE_MAX の `<=`/`<` 取り違え狙い ----
  it.each([
    [CHARACTER_SCALE_MAX - 0.0001, CHARACTER_SCALE_MAX - 0.0001],
    [CHARACTER_SCALE_MAX, CHARACTER_SCALE_MAX],
    [CHARACTER_SCALE_MAX + 0.0001, CHARACTER_SCALE_MAX],
  ] as const)('上端境界 scale=%f は characterScale = %f', (input, effective) => {
    const layer = new CharacterLayer(450, 800)
    layer.setCharacterScale(input)
    expect(sInternals(layer).characterScale).toBeCloseTo(effective, 10)
  })
})

// =====================================================================================
// #378: loadTexture の scale 優先順位（fit > character_scale > height_ratios > height_ratio > 原寸1）
//   と character_scale の「元絵基準（身長差保存）」の核。
//   立ち絵の実 scale を Assets.load モック + flushPromises で観測する（#360 と同流儀）。
//   期待値は export 定数 / computeFitScale / computeTargetHeightScale を参照し、計算結果を直書きしない（#262）。
// =====================================================================================
describe('CharacterLayer character_scale loadTexture 優先順位・元絵基準（#378）', () => {
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
  const { width: SW, height: SH } = ASPECT_RATIOS['9:16']

  // ---- character_scale は元絵基準: sprite.scale = 値（texture.height に依らず一定）----
  it('character_scale 設定時、sprite.scale = 値（元絵基準・texture.height に依らず一定）', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterScale(0.5)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    expect(st.sprite.scale.x).toBe(0.5)
    expect(st.sprite.scale.y).toBe(0.5)
  })

  // ---- 身長差保存の核 ----
  //   異なる texture.height（1000 / 1400）に同じ character_scale を与えると、両 sprite の scale は
  //   等しくなり（元絵基準＝値そのまま）、表示高さ scale*texH の比は texH 比 1000:1400 に保たれる。
  it('身長差保存: 異なる texH（1000/1400）に同じ character_scale を与えると scale は等しく、表示高さ比 = texH 比', async () => {
    const scaleValue = 0.5

    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, 1000) as never)
    const layerA = new CharacterLayer(SW, SH)
    layerA.setCharacterScale(scaleValue)
    layerA.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const scaleA = imageChars(layerA).characters.get('hero')!.sprite.scale.x

    vi.restoreAllMocks()
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, 1400) as never)
    const layerB = new CharacterLayer(SW, SH)
    layerB.setCharacterScale(scaleValue)
    layerB.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const scaleB = imageChars(layerB).characters.get('hero')!.sprite.scale.x

    // 元絵基準: texture.height に依らず scale は同じ値（= character_scale）。
    expect(scaleA).toBe(scaleValue)
    expect(scaleB).toBe(scaleValue)
    expect(scaleA).toBe(scaleB)
    // 表示高さ = scale * texH。scale が同じなので表示高さ比は texH 比 1000:1400 に保たれる（身長差保存）。
    const displayA = scaleA * 1000
    const displayB = scaleB * 1400
    expect(displayA / displayB).toBeCloseTo(1000 / 1400, 10)
    // 表示高さそのものは揃わない（元絵に焼き込んだ身長差が残る）。
    expect(displayA).not.toBeCloseTo(displayB, 6)
  })

  // ---- 対比（画面基準）: character_height_ratio は同 ratio・異 texH でも表示高さが揃う（身長差が潰れる）----
  it('対比（画面基準）: character_height_ratio は異なる texH でも表示高さが揃い、身長差が潰れる', async () => {
    const ratio = 0.8

    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, 1000) as never)
    const layerA = new CharacterLayer(SW, SH)
    layerA.setCharacterHeightRatio(ratio)
    layerA.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const scaleA = imageChars(layerA).characters.get('hero')!.sprite.scale.x

    vi.restoreAllMocks()
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, 1400) as never)
    const layerB = new CharacterLayer(SW, SH)
    layerB.setCharacterHeightRatio(ratio)
    layerB.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const scaleB = imageChars(layerB).characters.get('hero')!.sprite.scale.x

    // 画面基準: scale = (ratio*screenH)/texH。texH が違えば scale も違う（元絵基準と逆）。
    expect(scaleA).toBeCloseTo(computeTargetHeightScale(1000, ratio, SH), 10)
    expect(scaleB).toBeCloseTo(computeTargetHeightScale(1400, ratio, SH), 10)
    expect(scaleA).not.toBeCloseTo(scaleB, 6)
    // 表示高さ scale*texH は両者とも ratio*screenH で揃う（身長差が潰れる）。
    expect(scaleA * 1000).toBeCloseTo(ratio * SH, 6)
    expect(scaleB * 1400).toBeCloseTo(ratio * SH, 6)
    expect(scaleA * 1000).toBeCloseTo(scaleB * 1400, 6)
  })

  // ---- fit=true は character_scale より優先（computeFitScale が勝つ）----
  it('fit=true は character_scale より優先され computeFitScale が勝つ', async () => {
    const texW = SW * 2
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(texW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    // character_scale は fitScale(=min(SW/texW,SH/texH)=0.5) とは別値の 0.7 にする（反証を成立させる）。
    const scaleValue = 0.7
    layer.setCharacterScale(scaleValue)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true, fit: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const fitScale = computeFitScale(texW, texH, SW, SH)
    expect(st.sprite.scale.x).toBe(fitScale)
    expect(st.sprite.scale.y).toBe(fitScale)
    // fit が勝つので character_scale(0.7) ではない（両者が別値であることを前提に反証）。
    expect(fitScale).not.toBeCloseTo(scaleValue, 6)
    expect(st.sprite.scale.x).not.toBeCloseTo(scaleValue, 6)
  })

  // ---- character_scale は character_height_ratio（スクリプト単位・画面基準）より優先 ----
  it('character_scale は character_height_ratio より優先される（元絵基準の値がそのまま出る）', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatio(0.8)
    layer.setCharacterScale(0.5)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const heightScale = computeTargetHeightScale(texH, 0.8, SH)
    expect(st.sprite.scale.x).toBe(0.5)
    // height_ratio 由来の scale ではない（character_scale が勝つ裏取り）。
    expect(st.sprite.scale.x).not.toBeCloseTo(heightScale, 6)
  })

  // ---- character_scale は character_height_ratios（per-character override・画面基準）より優先 ----
  it('character_scale は character_height_ratios（per-character override）より優先される', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatios({ hero: 0.9 })
    layer.setCharacterScale(0.5)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const overrideScale = computeTargetHeightScale(texH, 0.9, SH)
    expect(st.sprite.scale.x).toBe(0.5)
    expect(st.sprite.scale.x).not.toBeCloseTo(overrideScale, 6)
  })

  // ---- character_scale 未設定は下位（height_ratio / 原寸1）へフォールバック ----
  it('character_scale 未設定なら character_height_ratio へフォールバックする', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatio(0.8)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    expect(st.sprite.scale.x).toBeCloseTo(computeTargetHeightScale(texH, 0.8, SH), 10)
  })

  it('character_scale・height_ratio ともに未設定なら原寸 scale=1（後方互換）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })
})

// =====================================================================================
// #378: setCharacterScale のライブ再適用（reapplyCharacterHeightRatios 共有ループ）。
//   #360/#364 の "即再適用" テスト群と対称の観点を character_scale で縛る。
//   除外条件（fit / アニメ中 / render-only / snapshotHidden）は同じ実装（reapplyCharacterHeightRatios）を通る。
// =====================================================================================
describe('CharacterLayer character_scale ライブ再適用（#378）', () => {
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
  const { width: SW, height: SH } = ASPECT_RATIOS['9:16']

  it('表示中の静的立ち絵に setCharacterScale を呼ぶと sprite.scale が即再適用される', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    // 設定前は原寸 1（後方互換）。
    expect(st.sprite.scale.x).toBe(1)
    // character_scale を設定 → texture ロード済みなので即再スケール（元絵基準・値そのまま）。
    layer.setCharacterScale(0.5)
    expect(st.sprite.scale.x).toBe(0.5)
    expect(st.sprite.scale.y).toBe(0.5)
    // 別値へ変更しても即追従する。
    layer.setCharacterScale(2)
    expect(st.sprite.scale.x).toBe(2)
    expect(st.sprite.scale.y).toBe(2)
  })

  it('character_scale を null に戻すと character_height_ratio へ、それも無ければ原寸 1 へ即降格する', async () => {
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterHeightRatio(0.8)
    layer.setCharacterScale(0.5)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    expect(st.sprite.scale.x).toBe(0.5)
    // null 復帰 → character_height_ratio（画面基準）の scale へ即降格。
    layer.setCharacterScale(null)
    const heightScale = computeTargetHeightScale(texH, 0.8, SH)
    expect(st.sprite.scale.x).toBeCloseTo(heightScale, 10)
    expect(st.sprite.scale.x).not.toBe(0.5)
    // height_ratio も外すと原寸 1 へ。
    layer.setCharacterHeightRatio(null)
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })

  it('fit=true の立ち絵は setCharacterScale の即再適用対象外（scale は fit のまま不変）', async () => {
    const texW = SW * 2
    const texH = SH * 2
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(texW, texH) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true, fit: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')!
    const fitScale = computeFitScale(texW, texH, SW, SH)
    expect(st.sprite.scale.x).toBe(fitScale)
    layer.setCharacterScale(0.5)
    expect(st.sprite.scale.x).toBe(fitScale)
    expect(st.sprite.scale.y).toBe(fitScale)
  })

  it('アニメ進行中（animation 非 null）の立ち絵は setCharacterScale の即再適用対象外（scale 不変）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const st = imageChars(layer).characters.get('hero')! as unknown as {
      sprite: { scale: { x: number; y: number } }
      animation: unknown
    }
    expect(st.sprite.scale.x).toBe(1)
    // 非ゼロ duration の animate で animation を進行中にする（dy 移動なので scale は即時変更しない）。
    layer.animate('hero', { dy: '-100', duration_ms: 500 })
    expect(st.animation).not.toBeNull()
    // アニメ中なので即再適用はスキップされ、scale は据え置き（1 のまま）。
    layer.setCharacterScale(0.5)
    expect(st.sprite.scale.x).toBe(1)
    expect(st.sprite.scale.y).toBe(1)
  })

  it('render-only（showImage / showTitle）は setCharacterScale の即再適用対象外（自前 sizing のまま不変）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.showImage({ id: 'avatar', path: 'a.png', assetBaseUrl: '/assets' })
    await flushPromises()
    layer.showTitle('orber', 'sans-serif')
    // 表示後に character_scale を変えても render-only は触らない（scale 不変）。
    layer.setCharacterScale(0.5)
    const image = imageChars(layer).characters.get('avatar')!
    const title = imageChars(layer).characters.get('Title')!
    expect(image.sprite.scale.x).toBe(1)
    expect(image.sprite.scale.y).toBe(1)
    expect(title.sprite.scale.x).toBe(1)
    expect(title.sprite.scale.y).toBe(1)
  })

  // クロスフェード中（#337）の旧 sprite は snapshotHidden で再スケール対象から除外される
  // （#364 の T-RACE-01 と対称）。旧 sprite は元のスケールを保ち、新 sprite は texture ロード完了後に
  // 新 character_scale が効く。
  it('クロスフェード中の旧 sprite（snapshotHidden）は setCharacterScale の即再適用対象外（元のスケールのまま）', async () => {
    vi.spyOn(Assets, 'load').mockResolvedValue(fakeTexture(SW, SH * 2) as never)
    const layer = new CharacterLayer(SW, SH)
    layer.setCharacterScale(0.5)
    layer.show('hero', 'normal', '中央', '/assets', { instant: true })
    await flushPromises()
    const chars = imageChars(layer).characters
    const beforeScale = chars.get('hero')!.sprite.scale.x
    expect(beforeScale).toBe(0.5)

    // 表情変更 → 非 instant・既定 fade あり → クロスフェード分岐（#337）。旧 sprite は snapshotHidden。
    layer.show('hero', 'sad', '中央', '/assets')
    const oldKey = [...chars.keys()].find((k) => k !== 'hero')!
    expect(oldKey).toMatch(/^hero__transition_/)
    expect(chars.get(oldKey)!.snapshotHidden).toBe(true)

    // クロスフェード中に character_scale を変更 → 旧 sprite は snapshotHidden により再スケール対象外。
    layer.setCharacterScale(2)
    expect(chars.get(oldKey)!.sprite.scale.x).toBe(beforeScale)

    await flushPromises()
    // 新 sprite は loadTexture 完了後に新 character_scale(2) が効く。
    expect(chars.get('hero')!.sprite.scale.x).toBe(2)
    // 旧 sprite は対象外のままなので元のスケールを保つ（新 sprite に引きずられない）。
    expect(chars.get(oldKey)!.sprite.scale.x).toBe(beforeScale)
  })
})
