import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets, Graphics, Sprite, Text as PixiText, Rectangle, Texture } from 'pixi.js'
import { ChoiceOverlay, resolveChoiceVisual, resolveStyle } from './ChoiceOverlay'
import { computeSplitLayoutRegions, resolveChoiceIconKind } from './novelLayout'
import type { FederatedPointerEvent } from 'pixi.js'
import type { AudioManager } from './AudioManager'

// アイコン(#598)テスト用の共通ヘルパー。EventImageLayer.test.ts と同じ流儀
// （Assets.load をモックし、実 setTimeout(0) でマクロタスクを1回まわして then/catch を解決させる）。
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// 実 pixi.js の `new Sprite(texture)` は渡された値が `instanceof Texture` でないと
// テクスチャとして受理せず Texture.EMPTY に差し替えてしまう（options 分割代入で texture
// プロパティを探すため）。そのため素の `{}` キャストではなく実 `Texture` インスタンスを
// 使い、テクスチャの identity 比較（icon.texture === readIconTexture 等）が成立するようにする。
function mockTexture(): Texture {
  return new Texture()
}

/** Assets.load を常に成功させ、常に新しい mockTexture() を返すモックに差し替える。 */
function mockAssetsLoadResolved(): void {
  vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
}

/**
 * URL ごとに個別の結果（成功時に返すテクスチャ、または 'reject'）を出し分けるモック。
 * outcomes に無い URL は既定で mockTexture() 成功として扱う。
 */
function mockAssetsLoadRoutedByUrl(outcomes: Record<string, Texture | 'reject'>): void {
  vi.spyOn(Assets, 'load').mockImplementation((url: unknown) => {
    const outcome = outcomes[String(url)]
    if (outcome === 'reject') return Promise.reject(new Error('404')) as never
    if (outcome) return Promise.resolve(outcome) as never
    return Promise.resolve(mockTexture()) as never
  })
}

/**
 * Assets.load の resolve/reject を呼び出し側が任意タイミングで手動発火できるモック
 * （EventImageLayer.test.ts の race-guard テストと同じ流儀）。stale token 検証用。
 */
function mockAssetsLoadManual(): Record<
  string,
  { resolve: (t: Texture) => void; reject: (e: unknown) => void }
> {
  const resolvers: Record<string, { resolve: (t: Texture) => void; reject: (e: unknown) => void }> =
    {}
  vi.spyOn(Assets, 'load').mockImplementation(
    (url: unknown) =>
      new Promise((resolve, reject) => {
        resolvers[String(url)] = { resolve, reject }
      }) as never
  )
  return resolvers
}

/** private readIconTexture/unreadIconTexture を読むための internals ビュー。 */
interface ChoiceOverlayInternals {
  readIconTexture: Texture | null
  unreadIconTexture: Texture | null
}
function internals(overlay: ChoiceOverlay): ChoiceOverlayInternals {
  return overlay as unknown as ChoiceOverlayInternals
}

/** ボタン Container 直下から選択肢アイコンの Sprite を探す（無ければ undefined）。 */
function findIconSprite(button: { children: unknown[] }): Sprite | undefined {
  return button.children.find((child) => child instanceof Sprite) as Sprite | undefined
}

/** ボタン Container 直下からラベル Text を探す。 */
function findLabel(button: { children: unknown[] }): PixiText | undefined {
  return button.children.find((child) => child instanceof PixiText) as PixiText | undefined
}

afterEach(() => {
  vi.restoreAllMocks()
})

function pointerEvent(x: number, y: number, pointerId = 1): FederatedPointerEvent {
  return {
    global: { x, y },
    pointerId,
    stopPropagation: vi.fn(),
  } as unknown as FederatedPointerEvent
}

function choices(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    text: `選択肢${i + 1}`,
    jump: `next-${i + 1}`,
  }))
}

function scrollableContent(overlay: ChoiceOverlay) {
  const content = overlay.children.find((child) => child.children.length > 0)
  expect(content).toBeDefined()
  return content!
}

describe('resolveStyle', () => {
  it('未指定 (undefined) は default テーマ、警告なし', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle()
    expect(t.fontFamily).toContain('Noto Sans JP')
    expect(t.radius).toBe(8)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('null は default テーマ、警告なし', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle(null)
    expect(t.radius).toBe(8)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('空文字は default テーマ、警告なし', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle('')
    expect(t.radius).toBe(8)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('"default" 明示は default テーマ、警告なし', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle('default')
    expect(t.radius).toBe(8)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('"soft" は soft テーマ', () => {
    const t = resolveStyle('soft')
    expect(t.radius).toBe(24)
    expect(t.borderWidth).toBe(3)
  })

  it('"monochrome" は monochrome テーマ', () => {
    const t = resolveStyle('monochrome')
    expect(t.radius).toBe(0)
    expect(t.fontFamily).toContain('Noto Serif JP')
  })

  // #562: pixel は正規のスタイル名なので警告は出ない。
  it('"pixel" は console.warn を呼ばない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveStyle('pixel')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // #562: monochrome テストと同型のフィールド確認パターン。
  // #569: ノッチ付きフレーム撤去に伴い角丸なしの単純な直角矩形に変更。borderWidth も
  // default/monochrome と同じ 2 に統一（追加要望）。
  it('"pixel" は pixel テーマ（radius=0・borderWidth=2・monospace）', () => {
    const t = resolveStyle('pixel')
    expect(t.radius).toBe(0)
    expect(t.borderWidth).toBe(2)
    expect(t.fontFamily).toBe('monospace')
  })

  it('未知値は default にフォールバックし、警告を出す', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle('foo')
    expect(t.radius).toBe(8)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('foo')
    warnSpy.mockRestore()
  })

  it('typo (sof) も default にフォールバックして警告', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveStyle('sof')
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  // own-property ルックアップ修正の確認（#368）。choice_style が Object.prototype の
  // プロパティ名と一致しても、未知値と同じ扱いで default にフォールバックし警告を出す
  // （`constructor` 等が誤って ChoiceTheme として返らない）。
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    '修正確認: choice_style "%s" は Object.prototype 由来でも未知値と同じく default にフォールバックし警告を出す',
    (name) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = resolveStyle(name)
      expect(t.radius).toBe(8)
      expect(t.fontFamily).toContain('Noto Sans JP')
      expect(warnSpy).toHaveBeenCalledOnce()
      warnSpy.mockRestore()
    }
  )
})

// #594 再発防止: locked（押せない）と cleared（完了＝押せる）の明暗関係が
// luma(0.299R+0.587G+0.114B) で逆転していないかを4テーマ全てで機械的に検証する。
// 「押せない」より「押せる」の方が暗く見えるのは常に誤り（soft テーマの fill/border/text
// 全てで一度逆転していた実バグの再発を検出する）。
describe('ChoiceOverlay ロック/完了 luma 順序 (#594 回帰テスト)', () => {
  function luma(color: number): number {
    const r = (color >> 16) & 0xff
    const g = (color >> 8) & 0xff
    const b = color & 0xff
    return 0.299 * r + 0.587 * g + 0.114 * b
  }

  const styleNames = ['default', 'soft', 'monochrome', 'pixel'] as const

  it.each(styleNames)('%s テーマ: fillCleared は fillLocked より明るい', (name) => {
    const t = resolveStyle(name)
    expect(luma(t.fillCleared)).toBeGreaterThan(luma(t.fillLocked))
  })

  it.each(styleNames)('%s テーマ: borderCleared は borderLocked より明るい', (name) => {
    const t = resolveStyle(name)
    expect(luma(t.borderCleared)).toBeGreaterThan(luma(t.borderLocked))
  })

  it.each(styleNames)('%s テーマ: textClearedColor は textLockedColor より明るい', (name) => {
    const t = resolveStyle(name)
    expect(luma(t.textClearedColor)).toBeGreaterThan(luma(t.textLockedColor))
  })
})

describe('ChoiceOverlay rendering', () => {
  it('show は一瞬表示ではなくボタン alpha 0 から fade-in を開始する', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn())

    expect(overlay.visible).toBe(true)
    expect(overlay.alpha).toBe(1)
    expect(overlay.children[0].alpha).toBe(0)

    overlay.hide()
  })

  it('複数ボタンは後続ボタンも alpha 0 から開始し、同時に全表示されない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(
      [
        { text: 'A', jump: 'a' },
        { text: 'B', jump: 'b' },
        { text: 'C', jump: 'c' },
      ],
      vi.fn()
    )

    expect(overlay.children.map((child) => child.alpha)).toEqual([0, 0, 0])

    overlay.hide()
  })

  it('Text resolution に renderer resolution を反映して文字を高密度で描く', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setRenderResolution(2)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn())

    const button = overlay.children[0]
    const label = button?.children.find((child) => child instanceof PixiText) as
      | PixiText
      | undefined
    expect(label).toBeDefined()
    expect(label!.resolution).toBe(2)
    expect(label!.roundPixels).toBe(true)

    overlay.hide()
  })

  it('既読 jump の選択肢は既読用の文字色で描く', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const theme = resolveStyle('default')
    overlay.show(
      [
        { text: '未読', jump: 'new-scene' },
        { text: '既読', jump: 'read-scene' },
      ],
      vi.fn(),
      'default',
      new Set(['read-scene'])
    )

    const unreadLabel = overlay.children[0]?.children.find((child) => child instanceof PixiText) as
      | PixiText
      | undefined
    const readLabel = overlay.children[1]?.children.find((child) => child instanceof PixiText) as
      | PixiText
      | undefined

    expect(unreadLabel?.style.fill).toBe(theme.textColor)
    expect(readLabel?.style.fill).toBe(theme.textReadColor)

    overlay.hide()
  })

  // #591: 条件付きロック。alreadyRead（既読/未読）とは別配色になり、クリックを受け付けない。
  it('ロック中の選択肢はロック専用配色で描かれ、eventMode=none でクリックを受け付けない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const theme = resolveStyle('default')
    const onSelect = vi.fn()
    overlay.show(
      [
        { text: '選べる', jump: 'unlocked' },
        { text: '選べない', jump: 'locked', condition: 'route01_cleared' },
      ],
      onSelect,
      'default',
      undefined,
      undefined,
      [false, true]
    )

    const unlockedButton = overlay.children[0]
    const lockedButton = overlay.children[1]
    const unlockedLabel = unlockedButton?.children.find((child) => child instanceof PixiText) as
      | PixiText
      | undefined
    const lockedLabel = lockedButton?.children.find((child) => child instanceof PixiText) as
      | PixiText
      | undefined

    expect(unlockedLabel?.style.fill).toBe(theme.textColor)
    expect(lockedLabel?.style.fill).toBe(theme.textLockedColor)
    // #598: ロック中はダイム配色のみで表す。テキストへのアイコン/マーク付与はしない。
    expect(lockedLabel?.text).toBe('選べない')
    expect(unlockedLabel?.text).toBe('選べる')

    expect(unlockedButton.eventMode).toBe('static')
    expect(lockedButton.eventMode).toBe('none')

    // クリックしても選択できない（tap-guard を満たす移動量でも onSelect は呼ばれない）。
    lockedButton.emit('pointerdown', pointerEvent(400, 225))
    lockedButton.emit('pointerup', pointerEvent(400, 225))
    expect(onSelect).not.toHaveBeenCalled()

    overlay.hide()
  })

  it('locked 未指定時は全オプションが従来どおり選択可能（非破壊）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next', condition: 'never_set' }], vi.fn())

    const button = overlay.children[0]
    expect(button.eventMode).toBe('static')

    overlay.hide()
  })

  // #594: 完了(クリア済み)視覚状態（#596でキーワード改名）。ロックとの決定的な差異は、
  // 見た目は変わるがクリックは通常どおり受け付ける(eventMode='static'のまま)点。
  it('完了中の選択肢は完了専用配色で描かれ、eventMode=static のままクリックを受け付ける', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const theme = resolveStyle('default')
    const onSelect = vi.fn()
    overlay.show(
      [
        { text: '通常', jump: 'normal' },
        { text: '完了済み', jump: 'cleared-jump' },
      ],
      onSelect,
      'default',
      undefined,
      undefined,
      undefined,
      [false, true]
    )

    const normalButton = overlay.children[0]
    const clearedButton = overlay.children[1]
    const normalLabel = normalButton?.children.find((child) => child instanceof PixiText) as
      | PixiText
      | undefined
    const clearedLabel = clearedButton?.children.find((child) => child instanceof PixiText) as
      | PixiText
      | undefined

    expect(normalLabel?.style.fill).toBe(theme.textColor)
    expect(clearedLabel?.style.fill).toBe(theme.textClearedColor)
    // ロックと違い、GUI版はテキストにマークを付けない（色数が豊富なため配色だけで区別する設計）。
    expect(clearedLabel?.text).toBe('完了済み')

    expect(normalButton.eventMode).toBe('static')
    expect(clearedButton.eventMode).toBe('static')

    // クリックできる（ロックと違い選択は拒否されない）。
    clearedButton.emit('pointerdown', pointerEvent(400, 225))
    clearedButton.emit('pointerup', pointerEvent(400, 225))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('cleared-jump')

    overlay.hide()
  })

  it('cleared 未指定時は全オプションが従来どおり通常配色（非破壊）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const theme = resolveStyle('default')
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn())

    const button = overlay.children[0]
    const label = button?.children.find((child) => child instanceof PixiText) as
      | PixiText
      | undefined
    expect(label?.style.fill).toBe(theme.textColor)
    expect(button.eventMode).toBe('static')

    overlay.hide()
  })

  it('resolveChoiceVisual は既読/未読と hover で fill/border/text を切り替える', () => {
    const theme = resolveStyle('default')

    expect(resolveChoiceVisual(theme, false, false)).toEqual({
      fill: theme.fillNormal,
      border: theme.borderNormal,
      text: theme.textColor,
    })
    expect(resolveChoiceVisual(theme, false, true)).toEqual({
      fill: theme.fillHover,
      border: theme.borderHover,
      text: theme.textColor,
    })
    expect(resolveChoiceVisual(theme, true, false)).toEqual({
      fill: theme.fillRead,
      border: theme.borderRead,
      text: theme.textReadColor,
    })
    expect(resolveChoiceVisual(theme, true, true)).toEqual({
      fill: theme.fillReadHover,
      border: theme.borderReadHover,
      text: theme.textReadColor,
    })
  })

  // #591: locked は alreadyRead/hover より優先される専用の見た目になる。
  it('resolveChoiceVisual: locked=true は alreadyRead/hover に関わらずロック専用配色を返す', () => {
    const theme = resolveStyle('default')
    const expected = {
      fill: theme.fillLocked,
      border: theme.borderLocked,
      text: theme.textLockedColor,
    }
    expect(resolveChoiceVisual(theme, false, false, true)).toEqual(expected)
    expect(resolveChoiceVisual(theme, true, false, true)).toEqual(expected)
    expect(resolveChoiceVisual(theme, true, true, true)).toEqual(expected)
    // locked=false（既定値省略）は従来どおり。
    expect(resolveChoiceVisual(theme, false, false)).toEqual({
      fill: theme.fillNormal,
      border: theme.borderNormal,
      text: theme.textColor,
    })
  })

  // #594: cleared は alreadyRead/hover より優先される専用の見た目になる（locked と同じ構造）。
  it('resolveChoiceVisual: cleared=true は alreadyRead/hover に関わらず完了専用配色を返す', () => {
    const theme = resolveStyle('default')
    const expected = {
      fill: theme.fillCleared,
      border: theme.borderCleared,
      text: theme.textClearedColor,
    }
    expect(resolveChoiceVisual(theme, false, false, false, true)).toEqual(expected)
    expect(resolveChoiceVisual(theme, true, false, false, true)).toEqual(expected)
    expect(resolveChoiceVisual(theme, true, true, false, true)).toEqual(expected)
    expect(resolveChoiceVisual(theme, false, true, false, true)).toEqual(expected)
    // cleared=false（既定値省略）は従来どおり。
    expect(resolveChoiceVisual(theme, false, false)).toEqual({
      fill: theme.fillNormal,
      border: theme.borderNormal,
      text: theme.textColor,
    })
  })

  // #594: locked と cleared が同時に真のときは locked が優先される（resolveChoiceVisual の
  // if(locked)...if(cleared)... の判定順どおり）。
  it('resolveChoiceVisual: locked=true かつ cleared=true のときは locked が優先される', () => {
    const theme = resolveStyle('default')
    const result = resolveChoiceVisual(theme, false, false, true, true)
    expect(result).toEqual({
      fill: theme.fillLocked,
      border: theme.borderLocked,
      text: theme.textLockedColor,
    })
    expect(result).not.toEqual({
      fill: theme.fillCleared,
      border: theme.borderCleared,
      text: theme.textClearedColor,
    })
  })

  // #562 issue本文の明示的な配色制約: 青は端末/遠隔AIの識別色として予約されているため
  // pixel スタイルでは使わない。hover border は暖色(0xffd280)であり、pixel テーマの
  // border 系フィールドはどれも青チャンネルが支配的な「青系」色にならないことを直接検証する。
  it('resolveChoiceVisual: pixel テーマの hover border は暖色(0xffd280)で、border系フィールドに青系色を一切含まない', () => {
    const theme = resolveStyle('pixel')
    const visual = resolveChoiceVisual(theme, false, true)
    expect(visual.border).toBe(0xffd280)

    const borderFields = [
      theme.borderNormal,
      theme.borderHover,
      theme.borderRead,
      theme.borderReadHover,
    ]
    for (const color of borderFields) {
      const r = (color >> 16) & 0xff
      const g = (color >> 8) & 0xff
      const b = color & 0xff
      // 「青系」= 青チャンネルが赤・緑より支配的な色。暖色/白/グレーはいずれも該当しない。
      expect(b).toBeLessThanOrEqual(Math.max(r, g))
    }
  })
})

describe('ChoiceOverlay tap guard', () => {
  it('選択肢は pointerdown だけでは確定せず、7px 移動の pointerup で確定する', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show([{ text: '選ぶ', jump: 'next' }], onSelect)

    const button = overlay.children[0]
    button.emit('pointerdown', pointerEvent(400, 225))
    expect(onSelect).not.toHaveBeenCalled()

    button.emit('pointerup', pointerEvent(403, 229))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('next')

    overlay.hide()
  })

  it('8px ちょうどの移動は選択確定する', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show([{ text: '選ぶ', jump: 'next' }], onSelect)

    const button = overlay.children[0]
    button.emit('pointerdown', pointerEvent(400, 225))
    button.emit('pointerup', pointerEvent(408, 225))

    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('next')

    overlay.hide()
  })

  it('9px 移動すると選択確定しない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show([{ text: '選ぶ', jump: 'next' }], onSelect)

    const button = overlay.children[0]
    button.emit('pointerdown', pointerEvent(400, 225))
    button.emit('pointerup', pointerEvent(409, 225))

    expect(onSelect).not.toHaveBeenCalled()

    overlay.hide()
  })

  it('スクロール可能な多数選択肢は drag でスクロールし、離しても選択確定しない', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onSelect = vi.fn()
    overlay.show(choices(10), onSelect)

    const content = scrollableContent(overlay)
    const button = content.children[0]
    const initialY = content.y

    button.emit('pointerdown', pointerEvent(400, 86))
    overlay.emit('pointermove', pointerEvent(400, 46))
    button.emit('pointerup', pointerEvent(400, 46))

    expect(content.y).toBeLessThan(initialY)
    expect(onSelect).not.toHaveBeenCalled()

    overlay.hide()
  })

  it('pointerup without pointerdown / pointerId 不一致 / cancel / upoutside は選択しない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show([{ text: '選ぶ', jump: 'next' }], onSelect)

    const button = overlay.children[0]
    button.emit('pointerup', pointerEvent(400, 225))

    button.emit('pointerdown', pointerEvent(400, 225, 1))
    button.emit('pointerup', pointerEvent(400, 225, 2))

    button.emit('pointerdown', pointerEvent(400, 225, 3))
    button.emit('pointercancel', pointerEvent(400, 225, 3))
    button.emit('pointerup', pointerEvent(400, 225, 3))

    button.emit('pointerdown', pointerEvent(400, 225, 4))
    button.emit('pointerupoutside', pointerEvent(400, 225, 4))
    button.emit('pointerup', pointerEvent(400, 225, 4))

    expect(onSelect).not.toHaveBeenCalled()

    overlay.hide()
  })
})

describe('ChoiceOverlay wheel scrolling', () => {
  it('scrollable の handleWheel(positive) は content を上へ動かし true を返す', () => {
    const overlay = new ChoiceOverlay(800, 220)
    overlay.show(choices(10), vi.fn())
    const content = scrollableContent(overlay)
    const initialY = content.y

    expect(overlay.handleWheel(40)).toBe(true)
    expect(content.y).toBeLessThan(initialY)

    overlay.hide()
  })

  it('上端で handleWheel(negative) は false を返す', () => {
    const overlay = new ChoiceOverlay(800, 220)
    overlay.show(choices(10), vi.fn())
    const content = scrollableContent(overlay)
    const initialY = content.y

    expect(overlay.handleWheel(-40)).toBe(false)
    expect(content.y).toBe(initialY)

    overlay.hide()
  })

  it('下端で過大 positive は clamp され、さらに positive しても false を返す', () => {
    const overlay = new ChoiceOverlay(800, 220)
    overlay.show(choices(10), vi.fn())
    const content = scrollableContent(overlay)

    expect(overlay.handleWheel(10_000)).toBe(true)
    const bottomY = content.y
    expect(overlay.handleWheel(1)).toBe(false)
    expect(content.y).toBe(bottomY)

    overlay.hide()
  })

  it('non-scrollable の handleWheel は false を返す', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn())

    expect(overlay.handleWheel(40)).toBe(false)
    expect(overlay.handleWheel(-40)).toBe(false)

    overlay.hide()
  })
})

describe('ChoiceOverlay scroll lifecycle', () => {
  it('drag 後 hide() → 再 show() で scrollOffset と press 状態が残らない', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const firstOnSelect = vi.fn()
    overlay.show(choices(10), firstOnSelect)

    const firstContent = scrollableContent(overlay)
    const firstButton = firstContent.children[0]
    firstButton.emit('pointerdown', pointerEvent(400, 86, 1))
    overlay.emit('pointermove', pointerEvent(400, 46, 1))
    expect(firstContent.y).toBeLessThan(24)

    overlay.hide()

    const secondOnSelect = vi.fn()
    overlay.show(choices(10), secondOnSelect)
    const secondContent = scrollableContent(overlay)
    expect(secondContent.y).toBe(24)

    const secondButton = secondContent.children[0]
    secondButton.emit('pointerup', pointerEvent(400, 86, 1))
    expect(firstOnSelect).not.toHaveBeenCalled()
    expect(secondOnSelect).not.toHaveBeenCalled()

    secondButton.emit('pointerdown', pointerEvent(400, 86, 2))
    secondButton.emit('pointerup', pointerEvent(400, 86, 2))
    expect(secondOnSelect).toHaveBeenCalledOnce()
    expect(secondOnSelect).toHaveBeenCalledWith('next-1')

    overlay.hide()
  })

  it('多数選択肢で最下部まで到達でき、最後の選択肢を tap 選択できる', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onSelect = vi.fn()
    overlay.show(choices(12), onSelect)

    const content = scrollableContent(overlay)
    expect(overlay.handleWheel(10_000)).toBe(true)
    const lastButton = content.children[content.children.length - 1]
    const tapY = 220 - 24 - 26

    lastButton.emit('pointerdown', pointerEvent(400, tapY, 1))
    lastButton.emit('pointerup', pointerEvent(400, tapY, 1))

    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('next-12')

    overlay.hide()
  })
})

describe('ChoiceOverlay scroll-lock notification (#434)', () => {
  it('show は scrollable (n=3, 境界値ちょうど) のときコールバックを true で呼ぶ', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)

    overlay.show(choices(3), vi.fn())

    expect(onScrollableChange).toHaveBeenCalledOnce()
    expect(onScrollableChange).toHaveBeenCalledWith(true)

    overlay.hide()
  })

  it('show は non-scrollable (n=2, 境界値-1) のときコールバックを false で呼ぶ', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)

    overlay.show(choices(2), vi.fn())

    expect(onScrollableChange).toHaveBeenCalledOnce()
    expect(onScrollableChange).toHaveBeenCalledWith(false)

    overlay.hide()
  })

  it('show は n=4（境界値+1）でもコールバックを true で呼ぶ', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)

    overlay.show(choices(4), vi.fn())

    expect(onScrollableChange).toHaveBeenCalledWith(true)

    overlay.hide()
  })

  it('hide は直前が scrollable=true でも無条件でコールバックを false で呼ぶ', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)
    overlay.show(choices(3), vi.fn())
    onScrollableChange.mockClear()

    overlay.hide()

    expect(onScrollableChange).toHaveBeenCalledOnce()
    expect(onScrollableChange).toHaveBeenCalledWith(false)
  })

  it('hide は直前が既に non-scrollable でも false で呼ぶ（冪等性）', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)
    overlay.show(choices(2), vi.fn())
    onScrollableChange.mockClear()

    overlay.hide()

    expect(onScrollableChange).toHaveBeenCalledOnce()
    expect(onScrollableChange).toHaveBeenCalledWith(false)
  })

  it('show([]) は早期returnし、コールバックを一切呼ばない（非回帰）', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)

    overlay.show([], vi.fn())

    expect(onScrollableChange).not.toHaveBeenCalled()
  })

  it('setOnScrollableChange 未登録でも show/hide は例外を投げない', () => {
    const overlay = new ChoiceOverlay(800, 220)

    expect(() => {
      overlay.show(choices(3), vi.fn())
      overlay.hide()
    }).not.toThrow()
  })

  it('show(scrollable)→hide→show(non-scrollable) の一連でコールバックが true/false/false の順に呼ばれる', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)

    overlay.show(choices(3), vi.fn())
    overlay.hide()
    overlay.show(choices(2), vi.fn())

    expect(onScrollableChange.mock.calls.map((args) => args[0])).toEqual([true, false, false])

    overlay.hide()
  })

  it('hide 後も登録済みコールバックは消えず、次の show でも通知される', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)
    overlay.show(choices(3), vi.fn())
    overlay.hide()
    onScrollableChange.mockClear()

    overlay.show(choices(3), vi.fn())

    expect(onScrollableChange).toHaveBeenCalledWith(true)

    overlay.hide()
  })

  it('show を連続で呼んでも（間に hide なし）都度その時点の scrollable 値で1回ずつ呼ばれる', () => {
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)

    overlay.show(choices(3), vi.fn())
    overlay.show(choices(2), vi.fn())
    overlay.show(choices(4), vi.fn())

    expect(onScrollableChange).toHaveBeenCalledTimes(3)
    expect(onScrollableChange.mock.calls.map((args) => args[0])).toEqual([true, false, true])

    overlay.hide()
  })

  it('show/hide/scroll-lock 切り替えの一連の進行で console.warn/console.error を出さない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const overlay = new ChoiceOverlay(800, 220)
    const onScrollableChange = vi.fn()
    overlay.setOnScrollableChange(onScrollableChange)

    overlay.show(choices(3), vi.fn())
    overlay.hide()
    overlay.show(choices(2), vi.fn())
    overlay.hide()

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

// #442 self-review should-5: ChoiceOverlay が split_layout の領域分割を認識しておらず、
// 選択肢が常に画面全幅・全体中央に配置されキャラ画像パネルに重なっていた不具合の回帰テスト。
// DialogBox.setSplitLayoutRegion / CharacterLayer.setSplitLayoutRegion と同じ契約
// （region を渡すとその矩形基準の幾何になり、null で従来の全画面ジオメトリへ戻る）を検証する。
describe('ChoiceOverlay setSplitLayoutRegion (#442 self-review should-5)', () => {
  // computeSplitLayoutRegions(800, 450).text 相当（横長・右半分）。BUTTON_WIDTH(480px) より
  // 領域幅(400px)が狭いため、ボタン幅がクランプされる契約もあわせて検証できる。
  const LANDSCAPE_REGION = computeSplitLayoutRegions(800, 450).text
  // computeSplitLayoutRegions(450, 800).text 相当（縦長・下半分）。幅450pxもBUTTON_WIDTHより狭い。
  const PORTRAIT_REGION = computeSplitLayoutRegions(450, 800).text

  it('getSplitLayoutRegion は既定で null、setSplitLayoutRegion 後はそのまま返す', () => {
    const overlay = new ChoiceOverlay(800, 450)
    expect(overlay.getSplitLayoutRegion()).toBeNull()
    overlay.setSplitLayoutRegion(LANDSCAPE_REGION)
    expect(overlay.getSplitLayoutRegion()).toEqual(LANDSCAPE_REGION)
    overlay.setSplitLayoutRegion(null)
    expect(overlay.getSplitLayoutRegion()).toBeNull()
  })

  it('region 未指定（従来）ではボタン中心が画面中央のまま非破壊', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn())
    const button = overlay.children[0]
    expect(button.x).toBe(400) // screenWidth / 2
    overlay.hide()
  })

  it('setSplitLayoutRegion(region) 後は選択肢中心が region 中心になり、ボタン幅が region 内に収まる（landscape）', () => {
    const overlayDefault = new ChoiceOverlay(800, 450)
    overlayDefault.show([{ text: '選ぶ', jump: 'next' }], vi.fn())
    const defaultButtonWidth = overlayDefault.children[0].pivot.x * 2
    overlayDefault.hide()

    const overlay = new ChoiceOverlay(800, 450)
    overlay.setSplitLayoutRegion(LANDSCAPE_REGION)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn())
    const button = overlay.children[0]

    expect(button.x).toBe(LANDSCAPE_REGION.x + LANDSCAPE_REGION.width / 2)
    // BUTTON_WIDTH がテキスト領域より広いケース: 従来幅よりクランプされて狭くなる。
    const regionButtonWidth = button.pivot.x * 2
    expect(regionButtonWidth).toBeLessThan(defaultButtonWidth)
    // 収まる契約: ボタンの左右端が region の外へはみ出さない（キャラ画像パネルへ重ならない）。
    expect(button.x - button.pivot.x).toBeGreaterThanOrEqual(LANDSCAPE_REGION.x)
    expect(button.x + button.pivot.x).toBeLessThanOrEqual(
      LANDSCAPE_REGION.x + LANDSCAPE_REGION.width
    )

    overlay.hide()
  })

  it('setSplitLayoutRegion(region) 後は選択肢が region 内に収まる（portrait・上下分割）', () => {
    const overlay = new ChoiceOverlay(450, 800)
    overlay.setSplitLayoutRegion(PORTRAIT_REGION)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn())
    const button = overlay.children[0]

    expect(button.x).toBe(PORTRAIT_REGION.x + PORTRAIT_REGION.width / 2)
    expect(button.x - button.pivot.x).toBeGreaterThanOrEqual(PORTRAIT_REGION.x)
    expect(button.x + button.pivot.x).toBeLessThanOrEqual(PORTRAIT_REGION.x + PORTRAIT_REGION.width)

    overlay.hide()
  })

  it('setSplitLayoutRegion(null) で従来の全画面中央寄せジオメトリに戻る', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setSplitLayoutRegion(LANDSCAPE_REGION)
    overlay.setSplitLayoutRegion(null)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn())
    const button = overlay.children[0]
    expect(button.x).toBe(400) // screenWidth / 2 の従来ジオメトリに復帰
    overlay.hide()
  })

  it('scrollable（多数選択肢）でも hitArea/mask が region 内（areaX起点・areaWidth幅）に収まる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setSplitLayoutRegion(LANDSCAPE_REGION)
    overlay.show(choices(20), vi.fn())

    const hitArea = overlay.hitArea as Rectangle
    expect(hitArea.x).toBe(LANDSCAPE_REGION.x)
    expect(hitArea.width).toBe(LANDSCAPE_REGION.width)

    overlay.hide()
  })

  it('setSplitLayoutRegion は show() 呼び出し前に設定しても即座に例外を投げない（値の保持のみ）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    expect(() => overlay.setSplitLayoutRegion(LANDSCAPE_REGION)).not.toThrow()
  })
})

// #508: [選択: 列=N] によるグリッド配置。columns 未指定 or 1 は既存の縦一列と
// 完全に同じ結果になる（非破壊）ことと、2 以上で `i % columns` 列目・`i / columns` 行目に
// 並ぶことを検証する。Gymnasia の想定ユースケースである 10択・5列×2行を中心に見る。
describe('ChoiceOverlay グリッド配置 (#508)', () => {
  it('columns 未指定は従来の縦一列と同じ x（screenWidth/2 で全ボタン共通）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())
    for (const button of overlay.children) {
      expect(button.x).toBe(400)
    }
    overlay.hide()
  })

  it('columns=1 は明示指定でも縦一列と同じ結果（非破壊）', () => {
    const withColumns = new ChoiceOverlay(800, 450)
    withColumns.show(choices(3), vi.fn(), null, undefined, 1)
    const withColumnsX = withColumns.children.map((c) => c.x)
    const withColumnsY = withColumns.children.map((c) => c.y)
    const withColumnsWidth = withColumns.children[0].pivot.x * 2
    withColumns.hide()

    const withoutColumns = new ChoiceOverlay(800, 450)
    withoutColumns.show(choices(3), vi.fn())
    const withoutColumnsX = withoutColumns.children.map((c) => c.x)
    const withoutColumnsY = withoutColumns.children.map((c) => c.y)
    const withoutColumnsWidth = withoutColumns.children[0].pivot.x * 2
    withoutColumns.hide()

    expect(withColumnsX).toEqual(withoutColumnsX)
    expect(withColumnsY).toEqual(withoutColumnsY)
    expect(withColumnsWidth).toBe(withoutColumnsWidth)
  })

  it('columns=5・10択は 5列×2行に並び、1行目と2行目で y が変わり列ごとに x が変わる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(10), vi.fn(), null, undefined, 5)

    const buttons = overlay.children
    expect(buttons.length).toBe(10)

    // 1行目 (index 0-4) は同じ y、2行目 (index 5-9) はそれより下の同じ y。
    const row0Ys = buttons.slice(0, 5).map((b) => b.y)
    const row1Ys = buttons.slice(5, 10).map((b) => b.y)
    expect(new Set(row0Ys).size).toBe(1)
    expect(new Set(row1Ys).size).toBe(1)
    expect(row1Ys[0]).toBeGreaterThan(row0Ys[0])

    // 列ごとに x が変わり、5列分で一意な x が5つ、行が変わっても同じ列なら同じ x。
    const row0Xs = buttons.slice(0, 5).map((b) => b.x)
    const row1Xs = buttons.slice(5, 10).map((b) => b.x)
    expect(new Set(row0Xs).size).toBe(5)
    expect(row0Xs).toEqual(row1Xs)
    // 昇順（左から右へ列が並ぶ）
    expect([...row0Xs].sort((a, b) => a - b)).toEqual(row0Xs)

    overlay.hide()
  })

  it('列数が増えるとボタン幅が縦一列より狭くなる（画面幅に収める）', () => {
    const single = new ChoiceOverlay(800, 450)
    single.show(choices(1), vi.fn())
    const singleWidth = single.children[0].pivot.x * 2
    single.hide()

    const grid = new ChoiceOverlay(800, 450)
    grid.show(choices(10), vi.fn(), null, undefined, 5)
    const gridWidth = grid.children[0].pivot.x * 2
    grid.hide()

    expect(gridWidth).toBeLessThan(singleWidth)
  })

  it('グリッドの全ボタンが画面幅内に収まる（はみ出さない）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(10), vi.fn(), null, undefined, 5)
    for (const button of overlay.children) {
      expect(button.x - button.pivot.x).toBeGreaterThanOrEqual(0)
      expect(button.x + button.pivot.x).toBeLessThanOrEqual(800)
    }
    overlay.hide()
  })

  it('columns=0 や負値は 1 にフォールバックし縦一列になる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn(), null, undefined, 0)
    for (const button of overlay.children) {
      expect(button.x).toBe(400)
    }
    overlay.hide()
  })

  it('列数指定 + 選択肢過多でも縦スクロール可能（#339 のスクロール可能リスト化とグリッドが共存する）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    // 50 択 5列 = 10行分の高さは画面(450px)に収まらずスクロール可能になる。
    overlay.show(choices(50), vi.fn(), null, undefined, 5)
    const hitArea = overlay.hitArea as Rectangle | null
    expect(hitArea).not.toBeNull()
    const content = scrollableContent(overlay)
    expect(content.children.length).toBe(50)
    overlay.hide()
  })

  // #508 実バグ修正: ボタン幅の下限クランプ (100px) を先に適用すると、列数が多い/
  // split_layout でテキスト領域が狭いケースで `列数 * 幅 + ガター` が利用可能幅を
  // 超えてはみ出していた（テスト観点整理フェーズで発見）。下限クランプを撤廃し、
  // 常にグリッド全体が利用可能幅に収まることを保証する。
  it('列8・10択（800px画面）でもグリッド全体が画面幅に収まる（旧: 下限100pxクランプではみ出していた）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(10), vi.fn(), null, undefined, 8)
    for (const button of overlay.children) {
      expect(button.x - button.pivot.x).toBeGreaterThanOrEqual(0)
      expect(button.x + button.pivot.x).toBeLessThanOrEqual(800)
    }
    overlay.hide()
  })

  it('列10・10択（800px画面）でもグリッド全体が画面幅に収まる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(10), vi.fn(), null, undefined, 10)
    for (const button of overlay.children) {
      expect(button.x - button.pivot.x).toBeGreaterThanOrEqual(0)
      expect(button.x + button.pivot.x).toBeLessThanOrEqual(800)
    }
    overlay.hide()
  })

  it('split_layout有効・列5・10択（テキスト領域約400px）でもグリッド全体が領域幅に収まる（Gymnasia想定シナリオ）', () => {
    const region = computeSplitLayoutRegions(800, 450).text
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setSplitLayoutRegion(region)
    overlay.show(choices(10), vi.fn(), null, undefined, 5)
    for (const button of overlay.children) {
      expect(button.x - button.pivot.x).toBeGreaterThanOrEqual(region.x)
      expect(button.x + button.pivot.x).toBeLessThanOrEqual(region.x + region.width)
    }
    overlay.hide()
  })
})

// #508 テスト観点整理フェーズで「要追加」と判定された境界値・null/undefined等価性・状態遷移・
// i18n・レスポンシブの穴埋め。基本ケース・はみ出し修正自体は上の describe で既にカバー済みなので、
// ここでは「列数と選択肢数の関係」「show/hide のライフサイクルで内部状態が残留しないか」
// 「null と undefined が同一視されるか」など、まだ見ていなかった軸を狙う。
describe('ChoiceOverlay グリッド配置 境界値・状態遷移 (#508 テスト観点整理フェーズ追加分)', () => {
  it('選択肢数が列数より少ない場合（3個・列=5）は1行に3個だけ並び、余った列スロット分のボタンは生成されない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn(), null, undefined, 5)

    const buttons = overlay.children
    // 余った 2 列分の空ボタンが生成されていないこと（ボタン数 === 選択肢数）
    expect(buttons.length).toBe(3)
    // 1行のみなので全ボタンが同じ y
    expect(new Set(buttons.map((b) => b.y)).size).toBe(1)
    // 3個とも異なる x（3列分埋まる）
    expect(new Set(buttons.map((b) => b.x)).size).toBe(3)

    overlay.hide()
  })

  it('選択肢数が列数で割り切れない場合（7個・列=5）は2行になり、2行目は2個だけ左詰めで空白ボタンは生成されない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(7), vi.fn(), null, undefined, 5)

    const buttons = overlay.children
    // 5+2=7 のみ。3列分の空白パディングボタンは生成されない。
    expect(buttons.length).toBe(7)

    const row0 = buttons.slice(0, 5)
    const row1 = buttons.slice(5, 7)
    expect(new Set(row0.map((b) => b.y)).size).toBe(1)
    expect(new Set(row1.map((b) => b.y)).size).toBe(1)
    expect(row1[0].y).toBeGreaterThan(row0[0].y)

    // 左詰め: 2行目の1・2列目のxは1行目の1・2列目と同じ（右側の空いた3列分は生成されず、
    // 中央寄せなどでずれてもいない）。
    expect(row1.map((b) => b.x)).toEqual(row0.slice(0, 2).map((b) => b.x))

    overlay.hide()
  })

  it('columns に null を明示的に渡した場合と undefined を渡した場合で同一結果になる', () => {
    const withNull = new ChoiceOverlay(800, 450)
    withNull.show(choices(3), vi.fn(), null, undefined, null)
    const nullX = withNull.children.map((c) => c.x)
    const nullY = withNull.children.map((c) => c.y)
    const nullWidth = withNull.children[0].pivot.x * 2
    withNull.hide()

    const withUndefined = new ChoiceOverlay(800, 450)
    withUndefined.show(choices(3), vi.fn(), null, undefined, undefined)
    const undefinedX = withUndefined.children.map((c) => c.x)
    const undefinedY = withUndefined.children.map((c) => c.y)
    const undefinedWidth = withUndefined.children[0].pivot.x * 2
    withUndefined.hide()

    expect(nullX).toEqual(undefinedX)
    expect(nullY).toEqual(undefinedY)
    expect(nullWidth).toBe(undefinedWidth)
  })

  it('列数が異なる複数の [選択] ブロックが hide()→show() を挟んで連続しても互いに影響しない（通常フロー）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(10), vi.fn(), null, undefined, 5)
    const gridWidth = overlay.children[0].pivot.x * 2
    const gridX0 = overlay.children[0].x
    overlay.hide()

    overlay.show(choices(3), vi.fn(), null, undefined, 1)
    const singleWidth = overlay.children[0].pivot.x * 2
    // 縦一列の幅はグリッドのクランプ幅を引きずらず、より広い（残留破損なし）。
    expect(singleWidth).toBeGreaterThan(gridWidth)
    for (const button of overlay.children) {
      expect(button.x).toBe(400) // screenWidth / 2 の従来ジオメトリ
    }
    overlay.hide()

    overlay.show(choices(10), vi.fn(), null, undefined, 5)
    // 再度同じ列数グリッドに戻すと元と同じ幅・x に戻る。
    expect(overlay.children[0].pivot.x * 2).toBe(gridWidth)
    expect(overlay.children[0].x).toBe(gridX0)

    overlay.hide()
  })

  it('hide() を挟まず列数違いで show() を連続呼び出しても、直前の gridColumns 等の内部状態が残留しない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(10), vi.fn(), null, undefined, 5)
    const gridWidth = overlay.children[0].pivot.x * 2
    expect(overlay.children.length).toBe(10)

    // hide() を呼ばずに列数1（縦一列）へ直接切り替える。
    overlay.show(choices(3), vi.fn(), null, undefined, 1)
    const singleWidth = overlay.children[0].pivot.x * 2
    expect(singleWidth).toBeGreaterThan(gridWidth) // 前回のグリッド幅クランプが残っていない
    expect(overlay.children.length).toBe(3) // 前回の10ボタン分が残留していない
    for (const button of overlay.children) {
      expect(button.x).toBe(400)
    }

    overlay.hide()
  })

  it('10文字以上の長い日本語選択肢テキストを列5の狭いグリッドで表示してもクラッシュせず、テキストは処理される', () => {
    const longChoices = Array.from({ length: 5 }, (_, i) => ({
      text: `とても長い選択肢のテキストです${i + 1}`, // 16文字前後
      jump: `next-${i + 1}`,
    }))
    const overlay = new ChoiceOverlay(800, 450)

    expect(() => overlay.show(longChoices, vi.fn(), null, undefined, 5)).not.toThrow()

    const buttons = overlay.children
    expect(buttons.length).toBe(5)
    for (const button of buttons) {
      const label = button.children.find((child) => child instanceof PixiText) as
        | PixiText
        | undefined
      expect(label).toBeDefined()
      expect(label!.text.length).toBeGreaterThan(10)
    }

    overlay.hide()
  })

  it('狭い画面幅（375px相当）で列5グリッドを表示してもボタン幅が自動的に縮み、はみ出さない', () => {
    const overlay = new ChoiceOverlay(375, 667)
    overlay.show(choices(10), vi.fn(), null, undefined, 5)

    for (const button of overlay.children) {
      expect(button.x - button.pivot.x).toBeGreaterThanOrEqual(0)
      expect(button.x + button.pivot.x).toBeLessThanOrEqual(375)
    }

    overlay.hide()
  })
})

// #591 テスト観点整理フェーズ 最優先1: grid×lock整合性。過去の事故パターン（グリッドの
// 行×列マッピングとインデックス対応がずれる不具合）が locked 配列でも再発していないかを
// 狙い撃ちする。10択・columns=5・locked を交互パターンで渡し、各ボタンの eventMode・
// ラベル本文の2つすべてが locked 配列と同じインデックスの選択肢に対応することを確認する。
// #598: ロック中のテキストへのマーク付与（旧🔒）は撤去したため、ラベル本文はロック有無に
// 関わらず選択肢テキストそのものと一致する。
describe('ChoiceOverlay グリッド×ロック整合性 (#591 テスト観点整理フェーズ 最優先1)', () => {
  it('columns=5・10択でlockedが交互パターンのとき、各ボタンのeventMode/ラベルがインデックス通りに対応する（ずれを検出）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    // 偶数indexはロックなし、奇数indexはロック中（市松パターンで隣接セルとの取り違えも検出できる）。
    const locked = Array.from({ length: 10 }, (_, i) => i % 2 === 1)
    overlay.show(choices(10), vi.fn(), null, undefined, 5, locked)

    const buttons = overlay.children
    expect(buttons.length).toBe(10)

    buttons.forEach((button, i) => {
      const label = button.children.find((child) => child instanceof PixiText) as
        | PixiText
        | undefined
      const expectedLocked = locked[i]
      expect(
        button.eventMode,
        `index ${i}: eventMode が locked[${i}]=${expectedLocked} と対応していない`
      ).toBe(expectedLocked ? 'none' : 'static')
      // ラベル本文自体もそのインデックスの選択肢と一致しているはず（行×列ずれで
      // 別インデックスの選択肢のロック状態を見てしまっていないかの取り違え検出）。
      expect(label?.text).toBe(`選択肢${i + 1}`)
    })

    overlay.hide()
  })

  it('二重送信ガード: ロック中ボタンへpointerdown/pointerupを複数回連打してもonSelectは一度も呼ばれない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show(
      [{ text: '選べない', jump: 'locked', condition: 'flag' }],
      onSelect,
      'default',
      undefined,
      undefined,
      [true]
    )

    const button = overlay.children[0]
    for (let i = 0; i < 5; i++) {
      button.emit('pointerdown', pointerEvent(400, 225, i))
      button.emit('pointerup', pointerEvent(400, 225, i))
    }

    expect(onSelect).not.toHaveBeenCalled()

    overlay.hide()
  })
})

// #594 テスト観点整理フェーズ 最優先3/4: grid×cleared整合性・locked×cleared優先順位。
// #591 の「ChoiceOverlay グリッド×ロック整合性」describe を cleared 版に踏襲する。
// fill/border は Graphics.prototype.fill / .stroke をスパイして検証する——
// drawButton() が影(shadow)には g.fill({color, alpha}) というオブジェクト引数、
// ボタン本体には g.fill(number) という数値引数を渡す実装（#569 pixel テストの
// shadowFillCall フィルタと同じ判別法）を利用し、number型のfill呼び出しだけを
// ボタン本体の描画としてボタン順に対応させる。stroke はボタン本体でしか呼ばれないため
// フィルタ不要。
describe('ChoiceOverlay グリッド×完了整合性・ロック優先順位 (#594 テスト観点整理フェーズ 最優先3/4)', () => {
  it('columns=5・10択でclearedが交互パターンのとき、各ボタンのfill/border/eventModeがインデックス通りに対応する', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const theme = resolveStyle('default')
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    // 偶数indexは未完了、奇数indexは完了中（市松パターンで隣接セルとの取り違えも検出できる）。
    const cleared = Array.from({ length: 10 }, (_, i) => i % 2 === 1)
    overlay.show(choices(10), vi.fn(), null, undefined, 5, undefined, cleared)

    const buttons = overlay.children
    expect(buttons.length).toBe(10)
    const buttonFillCalls = fillSpy.mock.calls.filter((args) => typeof args[0] === 'number')
    expect(buttonFillCalls.length).toBe(10)
    // 10 ボタン本体分のみ。show() は最初の未ロック選択肢(index 0)へ自動フォーカスするが、
    // #639 focus-visible化により、キーボード操作前は visible focus 枠線の stroke を呼ばない
    // （マウス/タップだけのユーザーには見せない）。
    expect(strokeSpy.mock.calls.length).toBe(10)

    buttons.forEach((button, i) => {
      const expectedCleared = cleared[i]
      const fillColor = buttonFillCalls[i]?.[0]
      const strokeArg = strokeSpy.mock.calls[i]?.[0] as { color: number; width: number }
      expect(fillColor, `index ${i}: fillがcleared[${i}]=${expectedCleared}と対応していない`).toBe(
        expectedCleared ? theme.fillCleared : theme.fillNormal
      )
      expect(
        strokeArg?.color,
        `index ${i}: borderがcleared[${i}]=${expectedCleared}と対応していない`
      ).toBe(expectedCleared ? theme.borderCleared : theme.borderNormal)
      expect(
        button.eventMode,
        `index ${i}: eventModeはcleared中でも static のまま(選択可能)のはず`
      ).toBe('static')
    })

    overlay.hide()
    fillSpy.mockRestore()
    strokeSpy.mockRestore()
  })

  it('locked と cleared が同じ index に重なるとき、そのボタンは locked の配色・eventMode になる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const theme = resolveStyle('default')
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    // index0: 通常 / index1: lockedのみ / index2: clearedのみ / index3: 両方重複(lockedが勝つはず)
    const locked = [false, true, false, true]
    const cleared = [false, false, true, true]
    overlay.show(choices(4), vi.fn(), null, undefined, undefined, locked, cleared)

    const buttons = overlay.children
    const buttonFillCalls = fillSpy.mock.calls.filter((args) => typeof args[0] === 'number')
    const buttonStrokeCalls = strokeSpy.mock.calls

    const expectButton = (
      i: number,
      fill: number,
      border: number,
      eventMode: string,
      label: string
    ) => {
      expect(buttonFillCalls[i]?.[0], `index ${i} (${label}): fill`).toBe(fill)
      expect(
        (buttonStrokeCalls[i]?.[0] as { color: number })?.color,
        `index ${i} (${label}): border`
      ).toBe(border)
      expect(buttons[i]?.eventMode, `index ${i} (${label}): eventMode`).toBe(eventMode)
    }

    expectButton(0, theme.fillNormal, theme.borderNormal, 'static', '通常')
    expectButton(1, theme.fillLocked, theme.borderLocked, 'none', 'lockedのみ')
    expectButton(2, theme.fillCleared, theme.borderCleared, 'static', 'clearedのみ')
    // locked と cleared が重複するとき、lockedの配色・eventModeが勝つ(clearedの配色が漏れない)。
    expectButton(3, theme.fillLocked, theme.borderLocked, 'none', 'locked×cleared重複')

    overlay.hide()
    fillSpy.mockRestore()
    strokeSpy.mockRestore()
  })
})

// #569: pixel スタイルのノッチ付きフレームを撤去し、他テーマと同じ roundRect(radius=0) で
// 単純な直角矩形を描くようにした（#562 で追加した poly ベースのノッチ描画は完全に削除）。
// 影も pixel テーマでは不要になったため shadowAlpha=0 とし、fill 呼び出しの alpha が
// 0 で渡ることを確認する（描画自体は他テーマ用に残っている）。
describe('ChoiceOverlay pixel フレーム描画 (#569)', () => {
  it('style="pixel" で show() すると roundRect が呼ばれる（default/soft/monochrome と同じ描画経路）', () => {
    const roundRectSpy = vi.spyOn(Graphics.prototype, 'roundRect')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn(), 'pixel')

    expect(roundRectSpy).toHaveBeenCalled()

    overlay.hide()
    roundRectSpy.mockRestore()
  })

  // pixel テーマは暖色(ろうそくの灯り)の影色を持つが、shadowAlpha=0 のため実際には不可視になる。
  it('style="pixel" の影レイヤの fill は theme.shadowColor で alpha は 0（影は不可視）', () => {
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn(), 'pixel')
    const theme = resolveStyle('pixel')

    const shadowFillCall = fillSpy.mock.calls.find(
      (args) => typeof args[0] === 'object' && args[0] !== null && 'color' in args[0]
    )
    expect(shadowFillCall).toBeDefined()
    expect(shadowFillCall![0]).toEqual({ color: theme.shadowColor, alpha: theme.shadowAlpha })
    expect(theme.shadowAlpha).toBe(0)

    overlay.hide()
    fillSpy.mockRestore()
  })
})

// #569: show() の統合的なふるまい確認。フレーム描画方式以外のロジック
// （ボタン数・座標計算・ライフサイクル）は pixel でも default と非破壊で共通であることを見る。
describe('ChoiceOverlay pixel 統合フロー (#569)', () => {
  it('show(choices, onSelect, "pixel") は例外を投げずボタンを生成し、ボタン数・座標計算が default と同じロジックで求まる', () => {
    const pixelOverlay = new ChoiceOverlay(800, 450)
    expect(() => pixelOverlay.show(choices(3), vi.fn(), 'pixel')).not.toThrow()
    expect(pixelOverlay.children.length).toBe(3)
    const pixelPositions = pixelOverlay.children.map((c) => ({ x: c.x, y: c.y }))
    pixelOverlay.hide()

    const defaultOverlay = new ChoiceOverlay(800, 450)
    defaultOverlay.show(choices(3), vi.fn(), 'default')
    const defaultPositions = defaultOverlay.children.map((c) => ({ x: c.x, y: c.y }))
    defaultOverlay.hide()

    expect(pixelPositions).toEqual(defaultPositions)
  })

  it('style="pixel" の show()→hover→hide() の一連のフローで console.warn/console.error が一切出ない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const overlay = new ChoiceOverlay(800, 450)

    overlay.show(choices(3), vi.fn(), 'pixel')
    const button = overlay.children[0]
    button.emit('pointerover', pointerEvent(400, 225))
    button.emit('pointerout', pointerEvent(400, 225))
    overlay.hide()

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

// #598 追記3: 選択肢アイコン（既読=read-icon.webp / 未読=unread-icon.webp）の setAssetBaseUrl 基本ロード。
// EventImageLayer.test.ts と同じ Assets.load モック流儀を踏襲する。
describe('ChoiceOverlay setAssetBaseUrl 基本ロード (#598)', () => {
  it('url未設定のままshow()しても例外を投げず、アイコンなし・BUTTON_HEIGHT(52)のままフォールバックする', () => {
    const overlay = new ChoiceOverlay(800, 450)
    expect(() =>
      overlay.show(
        [{ text: '選ぶ', jump: 'next' }],
        vi.fn(),
        null,
        undefined,
        undefined,
        [false],
        [true]
      )
    ).not.toThrow()

    const button = overlay.children[0]
    expect(findIconSprite(button)).toBeUndefined()
    expect(button.pivot.y).toBe(26) // BUTTON_HEIGHT / 2

    overlay.hide()
  })

  it('setAssetBaseUrl直後（Assets.loadのPromise未解決）にshow()するとアイコンなし・BUTTON_HEIGHTのまま', () => {
    vi.spyOn(Assets, 'load').mockImplementation(() => new Promise(() => {}) as never)
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')

    overlay.show(
      [{ text: '選ぶ', jump: 'next' }],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false],
      [true]
    )
    const button = overlay.children[0]
    expect(findIconSprite(button)).toBeUndefined()
    expect(button.pivot.y).toBe(26)

    overlay.hide()
  })

  it('Assets.load成功後（flushPromises）にshow()するとread/unread両テクスチャが反映されそれぞれ描画される', async () => {
    mockAssetsLoadResolved()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [
        { text: '未読', jump: 'unread' },
        { text: '既読', jump: 'read' },
      ],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false, false],
      [false, true]
    )
    const buttons = overlay.children
    expect(findIconSprite(buttons[0])).toBeDefined()
    expect(findIconSprite(buttons[1])).toBeDefined()

    overlay.hide()
  })

  it('setAssetBaseUrl("")は即座にreadIconTexture/unreadIconTextureをnullへリセットし、Assets.loadを呼ばない', async () => {
    const loadSpy = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()
    expect(internals(overlay).readIconTexture).not.toBeNull()
    expect(internals(overlay).unreadIconTexture).not.toBeNull()

    loadSpy.mockClear()
    overlay.setAssetBaseUrl('')

    expect(internals(overlay).readIconTexture).toBeNull()
    expect(internals(overlay).unreadIconTexture).toBeNull()
    expect(loadSpy).not.toHaveBeenCalled()
  })

  it('同一urlでsetAssetBaseUrlを連続呼び出しすると2回目はAssets.loadを呼ばない（早期return）', () => {
    const loadSpy = vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
    const overlay = new ChoiceOverlay(800, 450)

    overlay.setAssetBaseUrl('/assets')
    expect(loadSpy).toHaveBeenCalledTimes(2) // read-icon + unread-icon

    loadSpy.mockClear()
    overlay.setAssetBaseUrl('/assets')
    expect(loadSpy).not.toHaveBeenCalled()
  })
})

// #598: read/unread はそれぞれ独立に Assets.load される。片方だけ 404 でも、もう片方の
// 表示・console 静粛性に影響しないことを検証する（デシジョンテーブル2の異常系）。
describe('ChoiceOverlay read/unreadアイコンの独立フォールバック (#598)', () => {
  it('read-icon.webpだけ404のとき、unread-iconは正常表示されread側だけ配色のみのフォールバックになる', async () => {
    mockAssetsLoadRoutedByUrl({ '/assets/images/read-icon.webp': 'reject' })
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [
        { text: '既読', jump: 'r' },
        { text: '未読', jump: 'u' },
      ],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false, false],
      [true, false]
    )
    const buttons = overlay.children
    expect(findIconSprite(buttons[0])).toBeUndefined() // read は 404 でフォールバック
    expect(findIconSprite(buttons[1])).toBeDefined() // unread は正常表示

    overlay.hide()
  })

  it('unread-icon.webpだけ404のとき、read-iconは正常表示されunread側だけ配色のみのフォールバックになる', async () => {
    mockAssetsLoadRoutedByUrl({ '/assets/images/unread-icon.webp': 'reject' })
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [
        { text: '既読', jump: 'r' },
        { text: '未読', jump: 'u' },
      ],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false, false],
      [true, false]
    )
    const buttons = overlay.children
    expect(findIconSprite(buttons[0])).toBeDefined() // read は正常表示
    expect(findIconSprite(buttons[1])).toBeUndefined() // unread は 404 でフォールバック

    overlay.hide()
  })

  it('read/unread両方404のとき、両方フォールバックしshow()は例外を投げない', async () => {
    mockAssetsLoadRoutedByUrl({
      '/assets/images/read-icon.webp': 'reject',
      '/assets/images/unread-icon.webp': 'reject',
    })
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    expect(() =>
      overlay.show(
        [
          { text: '既読', jump: 'r' },
          { text: '未読', jump: 'u' },
        ],
        vi.fn(),
        null,
        undefined,
        undefined,
        [false, false],
        [true, false]
      )
    ).not.toThrow()
    const buttons = overlay.children
    expect(findIconSprite(buttons[0])).toBeUndefined()
    expect(findIconSprite(buttons[1])).toBeUndefined()

    overlay.hide()
  })

  it('read/unreadのAssets.loadが両方成功すると、各行が対応するテクスチャのアイコンをそれぞれ独立して描画する', async () => {
    const readTex = mockTexture()
    const unreadTex = mockTexture()
    mockAssetsLoadRoutedByUrl({
      '/assets/images/read-icon.webp': readTex,
      '/assets/images/unread-icon.webp': unreadTex,
    })
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [
        { text: '既読', jump: 'r' },
        { text: '未読', jump: 'u' },
      ],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false, false],
      [true, false]
    )
    const readIcon = findIconSprite(overlay.children[0])
    const unreadIcon = findIconSprite(overlay.children[1])
    expect(readIcon?.texture).toBe(readTex)
    expect(unreadIcon?.texture).toBe(unreadTex)

    overlay.hide()
  })
})

// #598: console 汚染防止。404 はフォールバック対象として catch で握りつぶす仕様なので、
// warn/error を一切出さないことを直接確認する（EventImageLayer 等の画像ロード失敗時とは
// 異なり、選択肢アイコンは「無ければ配色のみ」で完全に無音の設計）。
describe('ChoiceOverlay アイコンロード失敗時のconsole静粛性 (#598)', () => {
  it('read/unread両方404でもconsole.error/console.warnは呼ばれない', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockAssetsLoadRoutedByUrl({
      '/assets/images/read-icon.webp': 'reject',
      '/assets/images/unread-icon.webp': 'reject',
    })
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [{ text: '選ぶ', jump: 'n' }],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false],
      [false]
    )
    await flushPromises()

    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    overlay.hide()
  })
})

// #598: race / stale token。setAssetBaseUrl が連続で呼ばれたとき、古い世代の Assets.load 解決が
// 後から届いても現在のテクスチャフィールドを上書きしない（EventImageLayer.test.ts の
// loadToken race-guard テストと同じ流儀。ChoiceOverlay は read/unread 2本の Promise を
// 1つの iconLoadToken で共有するため、両方について stale ignore を確認する）。
describe('ChoiceOverlay アイコンrace/staleトークン (#598)', () => {
  it('setAssetBaseUrl(url1)→即座にurl2に切替後、url1のread-icon Promiseが後から解決してもreadIconTextureは上書きされない', async () => {
    const resolvers = mockAssetsLoadManual()
    const overlay = new ChoiceOverlay(800, 450)

    overlay.setAssetBaseUrl('/url1')
    overlay.setAssetBaseUrl('/url2')

    resolvers['/url1/images/read-icon.webp'].resolve(mockTexture())
    await flushPromises()

    expect(internals(overlay).readIconTexture).toBeNull()
  })

  it('同条件でunread側も同様にstale ignoreされる', async () => {
    const resolvers = mockAssetsLoadManual()
    const overlay = new ChoiceOverlay(800, 450)

    overlay.setAssetBaseUrl('/url1')
    overlay.setAssetBaseUrl('/url2')

    resolvers['/url1/images/unread-icon.webp'].resolve(mockTexture())
    await flushPromises()

    expect(internals(overlay).unreadIconTexture).toBeNull()
  })

  it('url1のunread-iconだけ先に解決済み→setAssetBaseUrl(url2)を呼ぶと同期的にunreadIconTextureがnullへリセットされる', async () => {
    const resolvers = mockAssetsLoadManual()
    const overlay = new ChoiceOverlay(800, 450)

    overlay.setAssetBaseUrl('/url1')
    const tex1 = mockTexture()
    resolvers['/url1/images/unread-icon.webp'].resolve(tex1)
    await flushPromises()
    expect(internals(overlay).unreadIconTexture).toBe(tex1)

    overlay.setAssetBaseUrl('/url2')
    // Assets.load の resolve を待たず、setAssetBaseUrl 呼び出し自体で同期的にリセットされる。
    expect(internals(overlay).unreadIconTexture).toBeNull()
  })

  it('read/unreadの2つのAssets.load()が異なるタイミングで解決しても互いのtextureフィールドを誤って上書きしない', async () => {
    const resolvers = mockAssetsLoadManual()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')

    const readTex = mockTexture()
    resolvers['/assets/images/read-icon.webp'].resolve(readTex)
    await flushPromises()
    expect(internals(overlay).readIconTexture).toBe(readTex)
    expect(internals(overlay).unreadIconTexture).toBeNull()

    const unreadTex = mockTexture()
    resolvers['/assets/images/unread-icon.webp'].resolve(unreadTex)
    await flushPromises()
    expect(internals(overlay).readIconTexture).toBe(readTex) // read側は変化しない
    expect(internals(overlay).unreadIconTexture).toBe(unreadTex)
  })
})

// #598: 未実行→実行→ロード完了の3段階を1テストで連続検証する状態遷移テスト。
describe('ChoiceOverlay アイコン状態遷移 (#598)', () => {
  it('未実行→実行→ロード完了の3段階で、アイコン無し→無し→有りと連続的に変化する', async () => {
    const resolvers = mockAssetsLoadManual()
    const overlay = new ChoiceOverlay(800, 450)
    const showUnreadChoice = () =>
      overlay.show(
        [{ text: '未読選択肢', jump: 'u' }],
        vi.fn(),
        null,
        undefined,
        undefined,
        [false],
        [false]
      )

    // 段階1: setAssetBaseUrl 未実行。
    showUnreadChoice()
    expect(findIconSprite(overlay.children[0])).toBeUndefined()
    overlay.hide()

    // 段階2: setAssetBaseUrl 実行直後（Assets.load の Promise 未解決）。
    overlay.setAssetBaseUrl('/assets')
    showUnreadChoice()
    expect(findIconSprite(overlay.children[0])).toBeUndefined()
    overlay.hide()

    // 段階3: ロード完了後。
    resolvers['/assets/images/unread-icon.webp'].resolve(mockTexture())
    await flushPromises()
    showUnreadChoice()
    expect(findIconSprite(overlay.children[0])).toBeDefined()
    overlay.hide()
  })
})

// #598 重点: ボタン高さ波及。1行でもアイコンが実際に描画されれば、その回の show() 全体が
// BUTTON_HEIGHT_WITH_ICON(68) に嵩上げされ、アイコン非表示の他の行も textY=34（68/2）に
// 揃う。旧実装のような「一部の行だけ26のまま取り残される」事故の再発を検出する。
describe('ChoiceOverlay ボタン高さ波及 (#598 重点)', () => {
  it('read種別のアイコンが表示されるとき、ロック中の行もunread-iconを表示し両方ともBUTTON_HEIGHT_WITH_ICON(68)を使う（#604: ロックはアイコンに影響しない）', async () => {
    mockAssetsLoadResolved()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [
        { text: '既読', jump: 'r' },
        { text: 'ロック', jump: 'l', condition: 'flag' },
      ],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false, true],
      [true, false]
    )
    const buttons = overlay.children
    const readIcon = findIconSprite(buttons[0])
    expect(readIcon).toBeDefined() // read 表示行
    expect(readIcon?.texture).toBe(internals(overlay).readIconTexture)

    // ロック中(cleared=false)の行も unread-icon を表示する（#604）。
    const lockedIcon = findIconSprite(buttons[1])
    expect(lockedIcon).toBeDefined()
    expect(lockedIcon?.texture).toBe(internals(overlay).unreadIconTexture)

    const lockedLabel = findLabel(buttons[1])
    expect(buttons[1].pivot.y).toBe(34) // BUTTON_HEIGHT_WITH_ICON / 2
    // ロック中の行自身もアイコンを表示するため、textY はアイコン分オフセットした 47
    // （center(34) + offset(13)）になる。26 に取り残されないことも同時に確認する。
    expect(lockedLabel?.y).toBe(47)

    overlay.hide()
  })

  it('unread種別のアイコンが表示されるとき、ロック中(既読)の行もread-iconを表示し両方ともBUTTON_HEIGHT_WITH_ICON(68)を使う（#604: ロックはアイコンに影響しない）', async () => {
    mockAssetsLoadResolved()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [
        { text: '未読', jump: 'u' },
        { text: 'ロック済み完了', jump: 'l', condition: 'flag' },
      ],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false, true],
      [false, true]
    )
    const buttons = overlay.children
    const unreadIcon = findIconSprite(buttons[0])
    expect(unreadIcon).toBeDefined() // unread 表示行
    expect(unreadIcon?.texture).toBe(internals(overlay).unreadIconTexture)

    // ロック中でも cleared=true なら read-icon を表示する（#604: 稀だがフラグは直交）。
    const lockedIcon = findIconSprite(buttons[1])
    expect(lockedIcon).toBeDefined()
    expect(lockedIcon?.texture).toBe(internals(overlay).readIconTexture)

    const lockedLabel = findLabel(buttons[1])
    expect(buttons[1].pivot.y).toBe(34)
    // ロック中の行自身も read-icon を表示するため textY は 47（center(34) + offset(13)）。
    expect(lockedLabel?.y).toBe(47)

    overlay.hide()
  })

  it('テクスチャ未ロードで全行アイコン非表示のとき、layoutButtonHeightはBUTTON_HEIGHT(52)のまま、全ラベルyが26', () => {
    // setAssetBaseUrl 未実行 = テクスチャ未ロード。
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(
      [
        { text: 'A', jump: 'a' },
        { text: 'B', jump: 'b' },
      ],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false, false],
      [true, false]
    )
    const buttons = overlay.children
    for (const button of buttons) {
      expect(button.pivot.y).toBe(26)
      expect(findLabel(button)?.y).toBe(26)
    }

    overlay.hide()
  })

  it('混在ケース（option0=read表示, option1=locked+unreadだが404フォールバック, option2=unreadフォールバック=404）で、option1・option2のtextYも34になる', async () => {
    mockAssetsLoadRoutedByUrl({ '/assets/images/unread-icon.webp': 'reject' })
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [
        { text: 'read表示', jump: 'r' },
        { text: 'locked', jump: 'l', condition: 'flag' },
        { text: 'unreadフォールバック', jump: 'u' },
      ],
      vi.fn(),
      null,
      undefined,
      undefined,
      [false, true, false],
      [true, false, false]
    )
    const buttons = overlay.children
    expect(findIconSprite(buttons[0])).toBeDefined() // option0: read は正常表示
    // option1: locked でも本来 unread-icon 対象（#604）だが、unread-icon.webp 自体が
    // 404 のためフォールバックで非表示になる（ロックが理由ではない）。
    expect(findIconSprite(buttons[1])).toBeUndefined()
    expect(findIconSprite(buttons[2])).toBeUndefined() // option2: unread は 404 フォールバック

    for (const button of buttons) {
      expect(button.pivot.y).toBe(34)
    }
    expect(findLabel(buttons[1])?.y).toBe(34)
    expect(findLabel(buttons[2])?.y).toBe(34)

    overlay.hide()
  })
})

// #604 訂正: resolveChoiceIconKind（アイコン種別）と resolveChoiceVisual（配色）は別軸の判定で、
// locked は配色にのみ影響しアイコンには一切影響しない（#598 時点の「どちらも locked が
// 最優先」という想定は誤りだった。ロックは「読むことすらできない」だけで「未読でない」わけ
// ではないため、locked=true でも cleared の値に応じたアイコンが出る）。
describe('ChoiceOverlay ロックとアイコンの軸独立性 (#604)', () => {
  it('locked=true, cleared=falseの行はread/unread両方のテクスチャがロード済みならunread-iconが描画される（ロックはアイコンに影響しない）', async () => {
    mockAssetsLoadResolved()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()
    expect(internals(overlay).readIconTexture).not.toBeNull()
    expect(internals(overlay).unreadIconTexture).not.toBeNull()

    overlay.show(
      [{ text: 'ロック済み', jump: 'l', condition: 'flag' }],
      vi.fn(),
      null,
      undefined,
      undefined,
      [true],
      [false]
    )
    const icon = findIconSprite(overlay.children[0])
    expect(icon).toBeDefined()
    expect(icon?.texture).toBe(internals(overlay).unreadIconTexture)

    overlay.hide()
  })

  it('locked=true, cleared=trueが同時に真の行は、配色はlocked優先だがアイコンはclearedに従いread-iconが出る（フラグは直交）', async () => {
    mockAssetsLoadResolved()
    const theme = resolveStyle('default')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [{ text: 'ロック済み完了', jump: 'lc', condition: 'flag' }],
      vi.fn(),
      null,
      undefined,
      undefined,
      [true],
      [true]
    )
    const button = overlay.children[0]
    const label = findLabel(button)
    // 配色は locked 優先（cleared 色ではない、resolveChoiceVisual と同じ判定順、変更なし）。
    expect(label?.style.fill).toBe(theme.textLockedColor)
    // アイコンは cleared=true なので read-icon（locked とは無関係、resolveChoiceIconKind の
    // 仕様どおり）。
    const icon = findIconSprite(button)
    expect(icon).toBeDefined()
    expect(icon?.texture).toBe(internals(overlay).readIconTexture)

    overlay.hide()
  })

  it('locked=true, cleared=falseでunread-icon.webpが404の行はアイコン非表示になるが、それはtexture欠如が理由でありlocked起因ではない（#604: 判定過程の回帰固定）', async () => {
    // 表示結果（アイコンなし）だけを見ると #598 時点の「locked→'none'」実装と区別が
    // つかない。しかしこのテストは unreadIconTexture が null（404）であることも同時に
    // 確認することで、非表示の理由が「resolveChoiceIconKind が 'none' を返したから」では
    // なく「テクスチャの先読みに失敗したから」であることを固定する。将来
    // resolveChoiceIconKind に locked を誤って再導入しても、この行だけでは検出できない
    // （どちらの実装でも結果は非表示）ため、readIconTexture 側の同種テストと対で見る。
    mockAssetsLoadRoutedByUrl({ '/assets/images/unread-icon.webp': 'reject' })
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()
    expect(internals(overlay).unreadIconTexture).toBeNull() // texture欠如を明示的に確認

    overlay.show(
      [{ text: 'ロック済み・未読', jump: 'l', condition: 'flag' }],
      vi.fn(),
      null,
      undefined,
      undefined,
      [true],
      [false]
    )
    // resolveChoiceIconKind(false, false) 自体は 'unread' を返す（locked起因の'none'ではない）。
    expect(resolveChoiceIconKind(false, false)).toBe('unread')
    // だが対応する unreadIconTexture が null なので、実際の描画は非表示になる
    // （ChoiceOverlay.show 内の `showIcon = iconTexture !== null` 判定による）。
    expect(findIconSprite(overlay.children[0])).toBeUndefined()

    overlay.hide()
  })

  it('locked引数を渡さない(undefined)呼び出しでもclearedだけでアイコン種別が決まる（locked?.[i] ?? falseのデフォルト経路が新シグネチャでも生きている）', async () => {
    mockAssetsLoadResolved()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [{ text: 'ロック未指定・完了済み', jump: 'x' }],
      vi.fn(),
      null,
      undefined,
      undefined,
      undefined, // locked を丸ごと省略
      [true]
    )
    const icon = findIconSprite(overlay.children[0])
    expect(icon).toBeDefined()
    expect(icon?.texture).toBe(internals(overlay).readIconTexture)

    overlay.hide()
  })
})

// #598 / #604 / #658: alreadyRead（背景色の既読/未読色分け、#366）とアイコンの関係。
// #604 時点では「アイコンは cleared だけで決まり、alreadyRead は一切参照しない」だったが、
// #658 の Gymnasia route10 実機確認で「背景色は既読（灰色）なのにアイコンだけ未読のまま」
// という食い違いが報告され、cleared || alreadyRead の OR 合成に訂正された。
describe('ChoiceOverlay alreadyReadとアイコンの連動 (#658)', () => {
  it('alreadyRead=trueならcleared=false・locked=falseでもread-iconが表示される（#658: 背景色と同じ既読シグナルに揃う）', async () => {
    mockAssetsLoadResolved()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [{ text: '既読jumpだが完了フラグ未設定', jump: 'read-scene' }],
      vi.fn(),
      'default',
      new Set(['read-scene']),
      undefined,
      [false],
      [false]
    )
    const icon = findIconSprite(overlay.children[0])
    expect(icon).toBeDefined()
    expect(icon?.texture).toBe(internals(overlay).readIconTexture)

    overlay.hide()
  })

  it('alreadyRead=falseでもcleared=true・locked=falseならread-iconが表示される（従来どおり変化なし）', async () => {
    mockAssetsLoadResolved()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [{ text: '未読jumpだが完了', jump: 'new-scene' }],
      vi.fn(),
      'default',
      undefined,
      undefined,
      [false],
      [true]
    )
    const icon = findIconSprite(overlay.children[0])
    expect(icon).toBeDefined()
    expect(icon?.texture).toBe(internals(overlay).readIconTexture)

    overlay.hide()
  })

  it('cleared=false・alreadyRead=falseのときだけunread-iconが表示される（両方falseの唯一の未読経路）', async () => {
    mockAssetsLoadResolved()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.setAssetBaseUrl('/assets')
    await flushPromises()

    overlay.show(
      [{ text: '未読jumpかつ未完了', jump: 'new-scene' }],
      vi.fn(),
      'default',
      undefined,
      undefined,
      [false],
      [false]
    )
    const icon = findIconSprite(overlay.children[0])
    expect(icon).toBeDefined()
    expect(icon?.texture).toBe(internals(overlay).unreadIconTexture)

    overlay.hide()
  })

  it('alreadyReadをtrue/falseで振るとアイコン表示結果が変化する（#658: 軸独立の撤回を直接証明）', async () => {
    // read/unread で別インスタンスのテクスチャを返すモックを使う（mockAssetsLoadResolved は
    // 呼び出しに関わらず同一インスタンスを返すため、read/unreadの区別が texture identity
    // 比較で検出できない）。
    const readTex = mockTexture()
    const unreadTex = mockTexture()
    mockAssetsLoadRoutedByUrl({
      '/assets/images/read-icon.webp': readTex,
      '/assets/images/unread-icon.webp': unreadTex,
    })

    const makeOverlayAndShow = async (readJumps: ReadonlySet<string> | undefined) => {
      const overlay = new ChoiceOverlay(800, 450)
      overlay.setAssetBaseUrl('/assets')
      await flushPromises()
      overlay.show(
        [{ text: '選択肢', jump: 'x' }],
        vi.fn(),
        'default',
        readJumps,
        undefined,
        [false],
        [false]
      )
      return overlay
    }

    const withAlreadyRead = await makeOverlayAndShow(new Set(['x']))
    const iconWith = findIconSprite(withAlreadyRead.children[0])
    // hide() は子を destroy するため texture 参照が失われる。hide() の前に読み取っておく。
    const textureWith = iconWith?.texture
    const readIconTexture = internals(withAlreadyRead).readIconTexture
    withAlreadyRead.hide()

    const withoutAlreadyRead = await makeOverlayAndShow(undefined)
    const iconWithout = findIconSprite(withoutAlreadyRead.children[0])
    const textureWithout = iconWithout?.texture
    const unreadIconTexture = internals(withoutAlreadyRead).unreadIconTexture
    withoutAlreadyRead.hide()

    expect(iconWith).toBeDefined()
    expect(iconWithout).toBeDefined()
    // alreadyRead=true側はread-icon、false側はunread-iconになり、テクスチャが異なる。
    expect(textureWith).toBe(readIconTexture)
    expect(textureWithout).toBe(unreadIconTexture)
    expect(textureWith).not.toBe(textureWithout)
  })
})

// #633 テスト観点整理: ChoiceOverlay のキーボード操作（Tab/Shift+Tab・矢印・Enter/Space・
// scrollFocusedIntoView 併用・show() 再入時の状態リセット）。TitleScreenOverlay.test.ts と同じ
// 流儀で private フィールド（choiceEntries/focusedIndex/choiceIsGrid/currentOptions/
// scrollOffset/maxScroll/viewportHeight）に internals ビューで直接到達する。
interface FocusableChoiceEntryLike {
  container: { eventMode: string }
  focusRing: Graphics
  locked: boolean
  row: number
  col: number
}
interface ChoiceOverlayFocusInternals {
  choiceEntries: FocusableChoiceEntryLike[]
  focusedIndex: number
  choiceIsGrid: boolean
  currentOptions: { jump: string }[]
  scrollOffset: number
  maxScroll: number
  viewportHeight: number
  keyboardNavActive: boolean
}
function focusInternals(overlay: ChoiceOverlay): ChoiceOverlayFocusInternals {
  return overlay as unknown as ChoiceOverlayFocusInternals
}

describe('ChoiceOverlay キーボード操作 フラットフォーカス移動 (#633 非グリッド)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-C1: 非グリッド・ロックなしでshow()直後、index 0にフォーカスがあるが黄色いリングはまだ描画されない（#639 focus-visible化: マウス/タップ操作だけのユーザーには見せない）', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())

    expect(focusInternals(overlay).focusedIndex).toBe(0)
    const entry0 = focusInternals(overlay).choiceEntries[0]
    expect(strokeSpy.mock.instances).not.toContain(entry0.focusRing)

    overlay.hide()
  })

  it('TC-C1b: Tabキーでフォーカス移動すると、その時点で初めて黄色いリングが描画される（#639 focus-visible化）', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())
    const entry0 = focusInternals(overlay).choiceEntries[0]
    const entry1 = focusInternals(overlay).choiceEntries[1]
    // ボタン枠線 (drawButton) の stroke は show() だけで既に発生しているため、
    // 「一切 stroke されない」ではなく focusRing だけを見て判定する。
    expect(strokeSpy.mock.instances).not.toContain(entry0.focusRing)
    expect(strokeSpy.mock.instances).not.toContain(entry1.focusRing)

    overlay.handleKeyDown('Tab')

    expect(strokeSpy.mock.instances).toContain(entry1.focusRing)

    overlay.hide()
  })

  it('TC-C1c: 選択肢が1件のときArrowDownを押してもフォーカス位置は変わらないが、キーボード操作した事実でリングは描画される（#639 setFocusedIndexの早期returnを取りこぼさない）', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(1), vi.fn())

    overlay.handleKeyDown('ArrowDown')

    expect(focusInternals(overlay).focusedIndex).toBe(0)
    const entry0 = focusInternals(overlay).choiceEntries[0]
    expect(strokeSpy.mock.instances).toContain(entry0.focusRing)

    overlay.hide()
  })

  it('TC-C2: 非グリッドでTabを選択肢数ぶん押すと先頭に循環する', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(4), vi.fn())

    for (let i = 0; i < 4; i++) {
      overlay.handleKeyDown('Tab')
    }

    expect(focusInternals(overlay).focusedIndex).toBe(0)
    overlay.hide()
  })

  it('TC-C3: 非グリッドでShift+Tabは末尾へ循環する', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(4), vi.fn())

    overlay.handleKeyDown('Tab', true)

    expect(focusInternals(overlay).focusedIndex).toBe(3)
    overlay.hide()
  })

  it('TC-C4: 先頭ロック時、show()直後のフォーカスは2番目（最初の非ロック）に立つ', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn(), null, undefined, undefined, [true, false, false])

    expect(focusInternals(overlay).focusedIndex).toBe(1)
    overlay.hide()
  })

  it('TC-C5: 末尾ロック時、非ロック最後からTabで先頭へ循環し、ロック済み末尾はスキップされる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn(), null, undefined, undefined, [false, false, true])
    // 初期フォーカス=index0。まず非ロック最後(index1)まで移動する。
    overlay.handleKeyDown('Tab')
    expect(focusInternals(overlay).focusedIndex).toBe(1)

    overlay.handleKeyDown('Tab')

    // ロック済みのindex2を跨いで先頭(index0)へ循環する。
    expect(focusInternals(overlay).focusedIndex).toBe(0)
    overlay.hide()
  })

  it('TC-C6: 先頭+末尾ロック時、中間からTab連打で非ロックのみを巡回し、ロック2件には一度もフォーカスが止まらない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(4), vi.fn(), null, undefined, undefined, [true, false, false, true])
    expect(focusInternals(overlay).focusedIndex).toBe(1)

    const visited: number[] = []
    for (let i = 0; i < 6; i++) {
      overlay.handleKeyDown('Tab')
      visited.push(focusInternals(overlay).focusedIndex)
    }

    expect(visited.every((idx) => idx === 1 || idx === 2)).toBe(true)
    overlay.hide()
  })

  it('TC-C7: 全選択肢ロック時、show()直後focusedIndexは-1相当（focusRingがどのボタンにも描画されない）', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn(), null, undefined, undefined, [true, true, true])

    expect(focusInternals(overlay).focusedIndex).toBe(-1)
    const rings = focusInternals(overlay).choiceEntries.map((e) => e.focusRing)
    expect(rings.some((ring) => strokeSpy.mock.instances.includes(ring))).toBe(false)

    overlay.hide()
  })

  it('TC-C8: 全ロック時にEnter/Spaceを押してもonSelectは呼ばれず例外・console.errorも出ない', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show(choices(2), onSelect, null, undefined, undefined, [true, true])

    expect(() => {
      overlay.handleKeyDown('Enter')
      overlay.handleKeyDown(' ')
    }).not.toThrow()
    expect(onSelect).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    overlay.hide()
    errorSpy.mockRestore()
  })

  it('TC-C9: ロック済みのフォーカス中エントリでEnterがno-opであること（activateFocusedButtonのentry.lockedチェックの直接検証）', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show(choices(2), onSelect, null, undefined, undefined, [false, true])
    // 内部状態を直接操作し、ロック済みエントリ(index1)へフォーカスを強制する
    // （activateFocusedButton の `entry.locked` チェック自体を狙い撃つための細工）。
    focusInternals(overlay).focusedIndex = 1

    overlay.handleKeyDown('Enter')

    expect(onSelect).not.toHaveBeenCalled()
    overlay.hide()
  })
})

// #633 テスト観点整理: グリッド配置 (#508) 時の ArrowUp/Down（列内移動）・ArrowLeft/Right
// （行内移動）。7択・列5（row0:5件・row1:2件のragged行）を主な題材にする。
describe('ChoiceOverlay キーボード操作 グリッド軸移動 (#633 グリッド + ragged last row)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-C10: 列5・7択で、col0のidx0からArrowDownでidx5へ、もう一度ArrowDownでidx0へ循環する', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(7), vi.fn(), null, undefined, 5)

    overlay.handleKeyDown('ArrowDown')
    expect(focusInternals(overlay).focusedIndex).toBe(5)

    overlay.handleKeyDown('ArrowDown')
    expect(focusInternals(overlay).focusedIndex).toBe(0)

    overlay.hide()
  })

  it('TC-C11: 同グリッドで、row0のみに存在する列(col2, idx2)からArrowDown/ArrowUpを押しても位置が変化しない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(7), vi.fn(), null, undefined, 5)
    focusInternals(overlay).focusedIndex = 2

    overlay.handleKeyDown('ArrowDown')
    expect(focusInternals(overlay).focusedIndex).toBe(2)

    overlay.handleKeyDown('ArrowUp')
    expect(focusInternals(overlay).focusedIndex).toBe(2)

    overlay.hide()
  })

  it('TC-C12: row0（5件=列数一致）のidx4からArrowRightで先頭(idx0)へ循環し、row1側には一切遷移しない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(7), vi.fn(), null, undefined, 5)
    focusInternals(overlay).focusedIndex = 4

    overlay.handleKeyDown('ArrowRight')

    expect(focusInternals(overlay).focusedIndex).toBe(0)
    overlay.hide()
  })

  it('TC-C13: row1（2件のragged行）のidx6からArrowRight/ArrowLeftでidx5と循環し、row0の余剰列(c2-c4)には遷移しない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(7), vi.fn(), null, undefined, 5)
    focusInternals(overlay).focusedIndex = 6

    overlay.handleKeyDown('ArrowRight')
    expect(focusInternals(overlay).focusedIndex).toBe(5)

    focusInternals(overlay).focusedIndex = 6
    overlay.handleKeyDown('ArrowLeft')
    expect(focusInternals(overlay).focusedIndex).toBe(5)

    overlay.hide()
  })

  it('TC-C14: count=6・列5（最終行1件のみ=col0だけ）で、col0はArrowDownで通常どおり2件を巡回し、col1-4はArrowDown/Upどちらもno-op', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(6), vi.fn(), null, undefined, 5)

    overlay.handleKeyDown('ArrowDown')
    expect(focusInternals(overlay).focusedIndex).toBe(5)
    overlay.handleKeyDown('ArrowDown')
    expect(focusInternals(overlay).focusedIndex).toBe(0)

    for (let col = 1; col <= 4; col++) {
      focusInternals(overlay).focusedIndex = col
      overlay.handleKeyDown('ArrowDown')
      expect(focusInternals(overlay).focusedIndex).toBe(col)
      overlay.handleKeyDown('ArrowUp')
      expect(focusInternals(overlay).focusedIndex).toBe(col)
    }

    overlay.hide()
  })

  it('TC-C15: count=10・列5（ちょうど割り切れる=raggedでない）で、全列がArrowDown/Upで2件を正常に巡回する', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(10), vi.fn(), null, undefined, 5)

    for (let col = 0; col < 5; col++) {
      focusInternals(overlay).focusedIndex = col
      overlay.handleKeyDown('ArrowDown')
      expect(focusInternals(overlay).focusedIndex).toBe(col + 5)
      overlay.handleKeyDown('ArrowUp')
      expect(focusInternals(overlay).focusedIndex).toBe(col)
    }

    overlay.hide()
  })

  it('TC-C16: 非グリッド時、ArrowLeft/ArrowRightはhandleKeyDownがfalseを返し、フォーカス位置も変化しない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())

    expect(overlay.handleKeyDown('ArrowRight')).toBe(false)
    expect(focusInternals(overlay).focusedIndex).toBe(0)

    expect(overlay.handleKeyDown('ArrowLeft')).toBe(false)
    expect(focusInternals(overlay).focusedIndex).toBe(0)

    overlay.hide()
  })

  it('TC-C17: グリッド時、ArrowUp/DownはchoiceIsGrid分岐で列内移動に切り替わり、非グリッド時のフラット移動にはならない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(6), vi.fn(), null, undefined, 3)
    // columns=3, idx0(row0,col0)。フラット移動(Tab)ならArrowDownでもidx1へ動くはずだが、
    // グリッド時のArrowDownは列内移動(moveFocusInColumn)でidx3(row1,col0)へ飛ぶ。
    expect(focusInternals(overlay).choiceIsGrid).toBe(true)

    overlay.handleKeyDown('ArrowDown')

    expect(focusInternals(overlay).focusedIndex).toBe(3)
    overlay.hide()
  })

  it('TC-C18: グリッドで下段(row1)の該当列がロックのとき、上段からArrowDownしても移動先候補が自分のみになりno-op', () => {
    const overlay = new ChoiceOverlay(800, 450)
    // columns=2, count=4: idx0(r0c0) idx1(r0c1) idx2(r1c0) idx3(r1c1)。idx2(col0)をロック。
    overlay.show(choices(4), vi.fn(), null, undefined, 2, [false, false, true, false])
    expect(focusInternals(overlay).focusedIndex).toBe(0)

    overlay.handleKeyDown('ArrowDown')

    expect(focusInternals(overlay).focusedIndex).toBe(0)
    overlay.hide()
  })
})

describe('ChoiceOverlay キーボード操作 フォーカス確定 (#633)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-C19: フォーカス中の非ロック選択肢でEnterを押すとonSelect(option.jump)が正しいjump文字列で1回だけ呼ばれる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show(choices(3), onSelect)
    overlay.handleKeyDown('Tab') // フォーカス=index1

    overlay.handleKeyDown('Enter')

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('next-2')
    overlay.hide()
  })

  it('TC-C20: フォーカス中の非ロック選択肢でSpaceでも同様に確定する', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show(choices(3), onSelect)

    overlay.handleKeyDown(' ')

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('next-1')
    overlay.hide()
  })

  it('TC-C21: Enterを押すとaudioManager.playSelectTone()が呼ばれる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const audioManager = {
      ensureContext: vi.fn(),
      playSelectTone: vi.fn(),
      playHoverTone: vi.fn(),
    }
    overlay.setAudioManager(audioManager as unknown as AudioManager)
    overlay.show(choices(1), vi.fn())

    overlay.handleKeyDown('Enter')

    expect(audioManager.playSelectTone).toHaveBeenCalledTimes(1)
    overlay.hide()
  })
})

// #633 テスト観点整理: scrollFocusedIntoView (#339 スクロール併用)。
// row1のtop=68・rowHeight=68・viewportHeight=172・maxScroll=492（10択・overlay(800,220)の場合の
// 実測値。BUTTON_HEIGHT=52・BUTTON_GAP=16・VIEWPORT_VERTICAL_MARGIN=24 から導かれる）。
// 境界値（ちょうど等しい/1px超過）は自然なキー操作の連打では厳密に再現しづらいため、
// テスト設計担当の指示どおり scrollOffset/maxScroll/focusedIndex を内部状態から直接細工する。
describe('ChoiceOverlay キーボード操作 scrollFocusedIntoView (#633 #339スクロール併用)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-C22: 非スクロール（maxScroll<=0）状態でフォーカス移動してもscrollOffsetは変化しない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())
    expect(focusInternals(overlay).maxScroll).toBeLessThanOrEqual(0)

    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Tab')

    expect(focusInternals(overlay).scrollOffset).toBe(0)
    overlay.hide()
  })

  it('TC-C23: フォーカス行のtopが現在のscrollOffsetより1px小さいときスクロールが発生しnext=topになる', () => {
    const overlay = new ChoiceOverlay(800, 220)
    overlay.show(choices(10), vi.fn())
    // row1のtop=68。scrollOffsetを69に細工し「top(68) < scrollOffset(69)」の状態を作る。
    focusInternals(overlay).scrollOffset = 69

    overlay.handleKeyDown('Tab') // index0→1 (row1)

    expect(focusInternals(overlay).scrollOffset).toBe(68)
    overlay.hide()
  })

  it('TC-C24: フォーカス行のtopが現在のscrollOffsetとちょうど等しいときスクロールは発生しない', () => {
    const overlay = new ChoiceOverlay(800, 220)
    overlay.show(choices(10), vi.fn())
    focusInternals(overlay).scrollOffset = 68 // row1のtopとちょうど同じ

    overlay.handleKeyDown('Tab') // index0→1 (row1)

    expect(focusInternals(overlay).scrollOffset).toBe(68) // 変化しない
    overlay.hide()
  })

  it('TC-C25: フォーカス行のbottomがビューポート下端とちょうど等しいときスクロールは発生しない', () => {
    const overlay = new ChoiceOverlay(800, 220)
    overlay.show(choices(10), vi.fn())
    // row2: top=136, bottom=188。viewportHeight=172。scrollOffset=16なら
    // bottom(188) === scrollOffset(16) + viewportHeight(172) がちょうど成立する。
    focusInternals(overlay).focusedIndex = 1
    focusInternals(overlay).scrollOffset = 16

    overlay.handleKeyDown('Tab') // index1→2 (row2)

    expect(focusInternals(overlay).scrollOffset).toBe(16) // 変化しない
    overlay.hide()
  })

  it('TC-C26: フォーカス行のbottomがビューポート下端より1px超過するときスクロールが発生しnext=bottom-viewportHeightになる', () => {
    const overlay = new ChoiceOverlay(800, 220)
    overlay.show(choices(10), vi.fn())
    // row2: bottom=188。scrollOffset=15なら scrollOffset+viewportHeight=187、bottomが1px超過する。
    focusInternals(overlay).focusedIndex = 1
    focusInternals(overlay).scrollOffset = 15

    overlay.handleKeyDown('Tab') // index1→2 (row2)

    expect(focusInternals(overlay).scrollOffset).toBe(16) // 188 - 172
    overlay.hide()
  })

  it('TC-C27: 最終行へフォーカスした結果算出されるnextがmaxScrollを超える場合、maxScrollにクランプされる', () => {
    const overlay = new ChoiceOverlay(800, 220)
    overlay.show(choices(10), vi.fn())
    // 自然な計算では最終行のnextは常にmaxScrollちょうど（totalHeight-viewportHeight）になるため、
    // クランプ分岐自体を踏ませるにはmaxScrollを人為的に小さく細工する必要がある。
    focusInternals(overlay).maxScroll = 100
    focusInternals(overlay).focusedIndex = 8

    overlay.handleKeyDown('Tab') // index8→9 (最終行, row9)

    expect(focusInternals(overlay).scrollOffset).toBe(100) // 492ではなくmaxScroll(100)にクランプ
    overlay.hide()
  })

  it('TC-C28: グリッド×スクロール併用（列2・多数行）で、ArrowDownによる列内移動が行の実Y座標に基づいて正しくスクロールを追従する', () => {
    const overlay = new ChoiceOverlay(800, 220)
    overlay.show(choices(20), vi.fn(), null, undefined, 2)

    overlay.handleKeyDown('ArrowDown') // idx0(row0,col0) → idx2(row1,col0)
    overlay.handleKeyDown('ArrowDown') // → idx4(row2,col0)
    overlay.handleKeyDown('ArrowDown') // → idx6(row3,col0)

    expect(focusInternals(overlay).focusedIndex).toBe(6)
    // row3: top=204, bottom=256。実rowに基づいて正しく追従していればscrollOffsetは84になる
    // （誤ってフォーカス済みindex(6)をrow扱いした場合はtop=408相当になり検出できる）。
    expect(focusInternals(overlay).scrollOffset).toBe(84)
    overlay.hide()
  })
})

describe('ChoiceOverlay キーボード操作 show()再入・状態遷移 (#633)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('TC-C29: 1回目show()でTabを数回押し中間にフォーカスがある状態から、columns/lockedが変化した2回目show()を呼ぶと、choiceEntriesが総入れ替えされフォーカスが新しい先頭の非ロック選択肢にリセットされる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())
    overlay.handleKeyDown('Tab')
    overlay.handleKeyDown('Tab')
    expect(focusInternals(overlay).focusedIndex).toBe(2)
    const firstFocusRing = focusInternals(overlay).choiceEntries[0].focusRing

    const secondOnSelect = vi.fn()
    overlay.show(
      [
        { text: 'X', jump: 'jump-x' },
        { text: 'Y', jump: 'jump-y' },
        { text: 'Z', jump: 'jump-z' },
      ],
      secondOnSelect,
      null,
      undefined,
      undefined,
      [true, false, false]
    )

    // choiceEntries は総入れ替えされ、Graphics インスタンスも新しくなる。
    expect(focusInternals(overlay).choiceEntries[0].focusRing).not.toBe(firstFocusRing)
    // フォーカスは新しい選択肢群の最初の非ロック(index1)にリセットされる。
    expect(focusInternals(overlay).focusedIndex).toBe(1)

    overlay.handleKeyDown('Enter')
    expect(secondOnSelect).toHaveBeenCalledWith('jump-y')

    overlay.hide()
  })

  it('TC-C30: hide()後にchoiceEntries=[]・focusedIndex=-1・currentOptions=[]にクリアされ、hide()直後にhandleKeyDownを呼んでも例外にならない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show(choices(3), onSelect)

    overlay.hide()

    expect(focusInternals(overlay).choiceEntries).toEqual([])
    expect(focusInternals(overlay).focusedIndex).toBe(-1)
    expect(focusInternals(overlay).currentOptions).toEqual([])
    expect(() => {
      overlay.handleKeyDown('Tab')
      overlay.handleKeyDown('Enter')
    }).not.toThrow()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('TC-C31: locked配列がoptionsより短い場合、未指定インデックスはfalse扱い（ロックなし）でフォーカス移動対象に含まれる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    // locked は index0 だけ指定（true）。index1・index2は未指定=ロックなし扱い。
    overlay.show(choices(3), onSelect, null, undefined, undefined, [true])

    // 初期フォーカスはindex0がロックされているためindex1（最初の非ロック）に立つ。
    expect(focusInternals(overlay).focusedIndex).toBe(1)
    expect(overlay.children[1].eventMode).toBe('static')
    expect(overlay.children[2].eventMode).toBe('static')

    overlay.handleKeyDown('Enter')
    expect(onSelect).toHaveBeenCalledWith('next-2')

    overlay.hide()
  })
})

// #639 テスト観点整理フェーズ追加分: 黄色いフォーカスリングの visible focus 化
// （keyboardNavActive）そのものを狙い撃つ回帰テスト。TC-C1/C1b/C1c で導入済みの
// stroke スパイ・focusInternals（keyboardNavActive を含む）流儀をそのまま踏襲する。
//
// #591 の「ロック中ボタンへのマウスクリックは確定しない」は 1231〜1279 行目の
// 「ChoiceOverlay グリッド×ロック整合性 (#591 テスト観点整理フェーズ 最優先1)」に
// 既に「二重送信ガード」テストとして存在するため、ここでは重複させない。
describe('ChoiceOverlay keyboardNavActive 追加回帰テスト (#639)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 最重要（テスト設計担当の指摘）: リング描画ガード（keyboardNavActive）と
  // スクロール追従ガード（scrollFocusedIntoView）が同じ if ブロックに入っていないことの
  // 回帰テスト。show() 直後は必ず keyboardNavActive=false（マウス操作の体）だが、
  // 初期フォーカスがビューポート外の行に立つ状況（先頭を複数ロックして下の行から開始）を
  // 作り、それでも scrollOffset がその行まで追従することを確認する。もし
  // scrollFocusedIntoView(next.row) が `if (this.keyboardNavActive) { ... }` の内側に
  // 誤って移動されていたら、ここで scrollOffset が 0 のまま止まり検出できる。
  it('TC-C32(最重要): keyboardNavActive=falseの初回show()でも、ビューポート外の初期フォーカス行までscrollOffsetが追従する(リング描画ガードとスクロール追従ガードの分離)', () => {
    const overlay = new ChoiceOverlay(800, 220)
    // 先頭5件をロックし、最初の非ロック(index5)から開始させる。
    const locked = [true, true, true, true, true, false, false, false, false, false]
    overlay.show(choices(10), vi.fn(), null, undefined, undefined, locked)

    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
    expect(focusInternals(overlay).focusedIndex).toBe(5)
    // row5: top=340, bottom=392。viewportHeight=172(TC-C23と同じoverlay(800,220)・10択の実測値)。
    // bottom(392) が scrollOffset(0)+viewportHeight(172) を超えるため next=392-172=220 になる。
    expect(focusInternals(overlay).scrollOffset).toBe(220)

    overlay.hide()
  })

  it('TC-C33: マウスクリックで選択確定してもkeyboardNavActiveはfalseのまま(フォーカスリングの描画に影響しない)', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new ChoiceOverlay(800, 450)
    const onSelect = vi.fn()
    overlay.show(choices(3), onSelect)
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
    const entry0 = focusInternals(overlay).choiceEntries[0]
    strokeSpy.mockClear()

    const button = overlay.children[0]
    button.emit('pointerdown', pointerEvent(400, 225))
    button.emit('pointerup', pointerEvent(400, 225))

    expect(onSelect).toHaveBeenCalledWith('next-1')
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
    expect(strokeSpy.mock.instances).not.toContain(entry0.focusRing)

    overlay.hide()
  })

  it('TC-C34: グリッドでArrowRightを押すとkeyboardNavActiveがtrueになり、同一行内の移動先にリングが描画される', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new ChoiceOverlay(800, 450)
    // columns=2, count=4: idx0(r0c0) idx1(r0c1) idx2(r1c0) idx3(r1c1)。
    overlay.show(choices(4), vi.fn(), null, undefined, 2)
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
    const entry1 = focusInternals(overlay).choiceEntries[1]

    overlay.handleKeyDown('ArrowRight')

    expect(focusInternals(overlay).keyboardNavActive).toBe(true)
    // ArrowRight は行内移動(moveFocusInRow)のため、同じ行(row0)内のidx1へ移動する。
    expect(focusInternals(overlay).focusedIndex).toBe(1)
    expect(strokeSpy.mock.instances).toContain(entry1.focusRing)

    overlay.hide()
  })

  it('TC-C35: グリッドでもTabキーはflat順でリングを移動する(grid固有のmoveFocusInColumn/Rowとは異なる経路)', () => {
    const overlay = new ChoiceOverlay(800, 450)
    // columns=2, count=4: idx0(r0c0) idx1(r0c1) idx2(r1c0) idx3(r1c1)。
    // 同じidx0からでもArrowDown(moveFocusInColumn)ならidx2(同一列)へ飛ぶが、
    // Tab(moveFocus, flat)はグリッドを無視した通し順でidx1へ移動するはず。
    const overlay2 = new ChoiceOverlay(800, 450)
    overlay.show(choices(4), vi.fn(), null, undefined, 2)
    overlay2.show(choices(4), vi.fn(), null, undefined, 2)

    overlay.handleKeyDown('Tab')
    overlay2.handleKeyDown('ArrowDown')

    expect(focusInternals(overlay).focusedIndex).toBe(1)
    expect(focusInternals(overlay2).focusedIndex).toBe(2)

    overlay.hide()
    overlay2.hide()
  })

  it('TC-C36: グリッドで移動先候補が自分のみ(next===null)でもArrowDownを押せばkeyboardNavActiveはtrueになり現在位置にリングが再描画される(TC-C18の状況拡張)', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new ChoiceOverlay(800, 450)
    // columns=2, count=4: idx0(r0c0) idx1(r0c1) idx2(r1c0) idx3(r1c1)。idx2(col0)をロック。
    overlay.show(choices(4), vi.fn(), null, undefined, 2, [false, false, true, false])
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)
    const entry0 = focusInternals(overlay).choiceEntries[0]

    overlay.handleKeyDown('ArrowDown')

    // TC-C18と同じ前提: col0の移動先候補が自分(idx0)のみのためフォーカス位置自体は動かない。
    expect(focusInternals(overlay).focusedIndex).toBe(0)
    expect(focusInternals(overlay).keyboardNavActive).toBe(true)
    expect(strokeSpy.mock.instances).toContain(entry0.focusRing)

    overlay.hide()
  })

  it('TC-C37: 非グリッド時のArrowLeft/Rightは未処理のままkeyboardNavActiveも変化しない', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())
    expect(focusInternals(overlay).keyboardNavActive).toBe(false)

    overlay.handleKeyDown('ArrowRight')
    overlay.handleKeyDown('ArrowLeft')

    expect(focusInternals(overlay).keyboardNavActive).toBe(false)

    overlay.hide()
  })

  it('TC-C38: handleKeyDown("")および未知の文字列キーは例外を投げずfalseを返す', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())

    expect(() => {
      expect(overlay.handleKeyDown('')).toBe(false)
      expect(overlay.handleKeyDown('PageDown')).toBe(false)
    }).not.toThrow()
    expect(focusInternals(overlay).focusedIndex).toBe(0)

    overlay.hide()
  })

  // 実装コメント（ChoiceOverlay.ts の keyboardNavActive フィールド doc）で「一度 true に
  // なったら hide()/show() を跨いでも false に戻さない」と明言されている、セッション継続
  // 仕様の直接検証。専用テストが未追加だったため追加する。
  it('TC-C39: 1回目の選択画面でTab操作しkeyboardNavActive=trueになった後、hide()→show()で次の選択肢を表示すると即座にindex0へリングが描画される(セッション継続仕様)', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())
    overlay.handleKeyDown('Tab')
    expect(focusInternals(overlay).keyboardNavActive).toBe(true)
    overlay.hide()

    strokeSpy.mockClear()
    overlay.show(choices(2), vi.fn())

    expect(focusInternals(overlay).keyboardNavActive).toBe(true)
    expect(focusInternals(overlay).focusedIndex).toBe(0)
    const entry0 = focusInternals(overlay).choiceEntries[0]
    expect(strokeSpy.mock.instances).toContain(entry0.focusRing)

    overlay.hide()
  })

  // 任意(冪等性): activateKeyboardFocusVisible の早期return分岐（既にtrueなら何もしない）を
  // stroke呼び出し回数で直接検証する。
  it('TC-C40（任意）: Tabを2回連続で押しても、2回目はactivateKeyboardFocusVisibleの早期returnにより移動先のリング描画1回分しかstrokeが増えない', () => {
    const strokeSpy = vi.spyOn(Graphics.prototype, 'stroke')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn())

    overlay.handleKeyDown('Tab') // idx0→1。navActiveがfalse→trueになりidx0用に1回、idx1用に1回、計2回増える。
    const callCountAfterFirstTab = strokeSpy.mock.calls.length

    overlay.handleKeyDown('Tab') // idx1→2。navActiveは既にtrueのためactivate側は早期returnし、idx2用の1回だけ増える。

    expect(strokeSpy.mock.calls.length).toBe(callCountAfterFirstTab + 1)

    overlay.hide()
  })
})

// #658: 選択肢テキストがボタン幅から左右にはみ出す不具合の修正。DialogBox.ts と同じ禁則
// ワードラップ (wordwrap.ts) を使い、ボタン内側幅に収まるよう折り返す。wordwrap() は
// Canvas measureText 経由のため、wordwrap.test.ts と同じ流儀で HTMLCanvasElement.getContext
// を固定幅の mock に差し替えて検証する。
//
// 重要: wordwrap.ts はモジュールスコープで Canvas 2D context をキャッシュする
// （`getContext()` が一度非 null を返すと以後使い回す）ため、ここで mock を注入すると
// このテストファイル内で以後に実行される他の it() にも波及し得る。そのため、この
// describe はファイル最後尾に置き「以後に実行されるテストが無い」ことで汚染を避ける
// （wordwrap.test.ts のように vi.resetModules() で完全分離する手も検討したが、
// ChoiceOverlay 経由だと pixi.js のクラス実体まで作り直され instanceof 系の既存ヘルパー
// （findLabel 等）が壊れるため、位置での回避を採った）。
describe('ChoiceOverlay 選択肢テキストの折り返し (#658)', () => {
  /** 1文字 = 20px 固定の mock measureText。wordwrap.test.ts と同じ流儀。 */
  function mockFixedWidthCanvas(): { restore: () => void } {
    const mockCtx = {
      font: '',
      measureText: (s: string) => ({ width: s.length * 20 }),
    } as unknown as CanvasRenderingContext2D
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((contextId: string) =>
        contextId === '2d' ? mockCtx : null) as HTMLCanvasElement['getContext'])
    return { restore: () => getContext.mockRestore() }
  }

  it('ボタン内側幅を超える長さのテキストは複数行に折り返される', () => {
    const canvas = mockFixedWidthCanvas()
    const overlay = new ChoiceOverlay(800, 450)
    // BUTTON_WIDTH(480) - CHOICE_TEXT_PADDING_X*2(32) = 448px の折り返し幅。
    // 1文字20px・スペース無しの日本語想定で40文字なら 800px 相当となり確実に複数行になる。
    const longText = 'あ'.repeat(40)
    overlay.show([{ text: longText, jump: 'x' }], vi.fn(), null)

    const label = findLabel(overlay.children[0])
    expect(label?.text).toContain('\n')
    expect(label?.text.split('\n').length ?? 0).toBeGreaterThan(1)

    overlay.hide()
    canvas.restore()
  })

  it('折り返しで行数が増えた分だけlayoutButtonHeightが嵩上げされる(pivot.yで検証)', () => {
    const canvas = mockFixedWidthCanvas()
    const overlay = new ChoiceOverlay(800, 450)
    const longText = 'あ'.repeat(40)
    overlay.show([{ text: longText, jump: 'x' }], vi.fn(), null)

    const label = findLabel(overlay.children[0])
    const lineCount = label?.text.split('\n').length ?? 1
    // BUTTON_HEIGHT(52)/2=26 が基準。折り返しが無ければ pivot.y は26のまま。
    // 2行以上ならCHOICE_TEXT_LINE_HEIGHT(24)*(lineCount-1)ぶん高さが増え、pivot.yも増える。
    expect(lineCount).toBeGreaterThan(1)
    const expectedButtonHeight = 52 + (lineCount - 1) * 24
    expect(overlay.children[0].pivot.y).toBe(expectedButtonHeight / 2)

    overlay.hide()
    canvas.restore()
  })

  it('ボタン内側幅に収まる短いテキストは折り返されず、layoutButtonHeightもBUTTON_HEIGHT(52)のまま', () => {
    const canvas = mockFixedWidthCanvas()
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '近視', jump: 'x' }], vi.fn(), null)

    const label = findLabel(overlay.children[0])
    expect(label?.text).toBe('近視')
    expect(overlay.children[0].pivot.y).toBe(26) // BUTTON_HEIGHT(52) / 2、非破壊

    overlay.hide()
    canvas.restore()
  })

  it('折り返し済みラベルのTextStyleはalign: centerで各行を中央揃えする', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選択肢', jump: 'x' }], vi.fn(), null)

    const label = findLabel(overlay.children[0])
    expect(label?.style.align).toBe('center')

    overlay.hide()
  })
})
