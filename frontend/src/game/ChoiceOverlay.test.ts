import { describe, it, expect, vi } from 'vitest'
import { Graphics, Text as PixiText, Rectangle } from 'pixi.js'
import {
  ChoiceOverlay,
  buildPixelNotchPoints,
  resolveChoiceVisual,
  resolveStyle,
} from './ChoiceOverlay'
import { computeSplitLayoutRegions } from './novelLayout'
import type { FederatedPointerEvent } from 'pixi.js'

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

  // #562: pixel はノッチ付きフレーム (frameStyle: 'notched') を持つ新スタイル。
  // 未知値ではなく正規のスタイル名なので警告は出ない。
  it('"pixel" は frameStyle: notched のテーマを返し、console.warn を呼ばない', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = resolveStyle('pixel')
    expect(t.frameStyle).toBe('notched')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // #562: monochrome テストと同型のフィールド確認パターン。
  it('"pixel" は pixel テーマ（radius=0・borderWidth=4・monospace）', () => {
    const t = resolveStyle('pixel')
    expect(t.radius).toBe(0)
    expect(t.borderWidth).toBe(4)
    expect(t.fontFamily).toBe('monospace')
  })

  // #562: 4テーマすべての frameStyle を一括確認する位相回帰テスト。pixel だけが notched。
  it.each([
    ['default', 'rounded'],
    ['soft', 'rounded'],
    ['monochrome', 'rounded'],
    ['pixel', 'notched'],
  ] as const)('"%s" テーマの frameStyle は "%s"', (name, expected) => {
    expect(resolveStyle(name).frameStyle).toBe(expected)
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

// #562: pixel スタイルのフレーム描画方式（roundRect vs poly）を Graphics.prototype への spy で
// 直接検証する。ChoiceOverlay.ts の private 定数（BUTTON_WIDTH=480, BUTTON_HEIGHT=52,
// SHADOW_OFFSET=4, PIXEL_NOTCH_SIZE=6）はテスト側にミラーして持つ（このファイルの他の describe
// でも `tapY = 220 - 24 - 26` 等、同様に内部定数値をハードコードして検証する慣習に合わせる）。
describe('ChoiceOverlay pixel フレーム描画 (#562)', () => {
  const BUTTON_WIDTH = 480
  const BUTTON_HEIGHT = 52
  const SHADOW_OFFSET = 4
  const PIXEL_NOTCH_SIZE = 6

  it('style="default"（rounded）で show() すると roundRect が呼ばれ、poly は一度も呼ばれない', () => {
    const roundRectSpy = vi.spyOn(Graphics.prototype, 'roundRect')
    const polySpy = vi.spyOn(Graphics.prototype, 'poly')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn(), 'default')

    expect(roundRectSpy).toHaveBeenCalled()
    expect(polySpy).not.toHaveBeenCalled()

    overlay.hide()
    roundRectSpy.mockRestore()
    polySpy.mockRestore()
  })

  it('style="pixel"（notched）で show() すると poly が呼ばれ、roundRect は一度も呼ばれない', () => {
    const roundRectSpy = vi.spyOn(Graphics.prototype, 'roundRect')
    const polySpy = vi.spyOn(Graphics.prototype, 'poly')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn(), 'pixel')

    expect(polySpy).toHaveBeenCalled()
    expect(roundRectSpy).not.toHaveBeenCalled()

    overlay.hide()
    roundRectSpy.mockRestore()
    polySpy.mockRestore()
  })

  // 最重要回帰: g.poly() の第2引数(close)省略時、Polygon.closePath は undefined で
  // 上書きされコンストラクタの既定 true が効かない（今回発見・修正した実バグ）。
  // 複数ボタン・複数 poly 呼び出し（bg・shadow 双方）のすべてで close=true が明示されることを
  // 厳密等価で確認する。
  it('【最重要回帰】style="pixel" の全 poly 呼び出しで close(第2引数)が明示的に true(undefinedではない)', () => {
    const polySpy = vi.spyOn(Graphics.prototype, 'poly')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show(choices(3), vi.fn(), 'pixel')

    expect(polySpy.mock.calls.length).toBeGreaterThan(0)
    for (const call of polySpy.mock.calls) {
      expect(call[1]).toBe(true)
    }

    overlay.hide()
    polySpy.mockRestore()
  })

  it('style="pixel" の show() では poly が2回以上呼ばれ、(0,0)起点(bg)と SHADOW_OFFSET(4,4)起点(shadow)の両方が含まれる', () => {
    const polySpy = vi.spyOn(Graphics.prototype, 'poly')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn(), 'pixel')

    expect(polySpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    const calledPointArrays = polySpy.mock.calls.map(([points]) => points)
    const expectedBgPoints = buildPixelNotchPoints(
      0,
      0,
      BUTTON_WIDTH,
      BUTTON_HEIGHT,
      PIXEL_NOTCH_SIZE
    )
    const expectedShadowPoints = buildPixelNotchPoints(
      SHADOW_OFFSET,
      SHADOW_OFFSET,
      BUTTON_WIDTH,
      BUTTON_HEIGHT,
      PIXEL_NOTCH_SIZE
    )
    expect(calledPointArrays).toContainEqual(expectedBgPoints)
    expect(calledPointArrays).toContainEqual(expectedShadowPoints)

    overlay.hide()
    polySpy.mockRestore()
  })

  // hover 再描画パス（pointerover → bg.clear() → 再 drawButton）でも close 省略バグが
  // 再発しないことの確認。shadow は再描画されないため、クリア後の poly 呼び出しは bg の1回のみ。
  it('pointerover(hover)で style="pixel" のボタンにホバーすると、bg.clear() 後に再度 poly が close=true 付きで呼ばれる', () => {
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn(), 'pixel')

    const polySpy = vi.spyOn(Graphics.prototype, 'poly')
    const button = overlay.children[0]
    button.emit('pointerover', pointerEvent(400, 225))

    expect(polySpy.mock.calls.length).toBe(1)
    const [points, close] = polySpy.mock.calls[0] as [number[], boolean | undefined]
    expect(close).toBe(true)
    expect(points).toEqual(
      buildPixelNotchPoints(0, 0, BUTTON_WIDTH, BUTTON_HEIGHT, PIXEL_NOTCH_SIZE)
    )

    overlay.hide()
    polySpy.mockRestore()
  })

  // pixel テーマは暖色(ろうそくの灯り)の影を使う。default の黒影と異なることも合わせて確認する。
  it('style="pixel" の影レイヤの fill は theme.shadowColor（暖色 0xffd280）で、default の黒影とは異なる', () => {
    const fillSpy = vi.spyOn(Graphics.prototype, 'fill')
    const overlay = new ChoiceOverlay(800, 450)
    overlay.show([{ text: '選ぶ', jump: 'next' }], vi.fn(), 'pixel')
    const theme = resolveStyle('pixel')

    const shadowFillCall = fillSpy.mock.calls.find(
      (args) => typeof args[0] === 'object' && args[0] !== null && 'color' in args[0]
    )
    expect(shadowFillCall).toBeDefined()
    expect(shadowFillCall![0]).toEqual({ color: theme.shadowColor, alpha: theme.shadowAlpha })
    expect(theme.shadowColor).toBe(0xffd280)

    const defaultTheme = resolveStyle('default')
    expect(theme.shadowColor).not.toBe(defaultTheme.shadowColor)

    overlay.hide()
    fillSpy.mockRestore()
  })
})

// #562: buildPixelNotchPoints は ChoiceOverlay から export された純粋関数。境界値・位相・
// 平行移動を drawFrame 等を経由せず直接単体テストする。notch=10 は暗算しやすい値として選ぶ。
describe('buildPixelNotchPoints (#562)', () => {
  const NOTCH = 10

  // 上辺は points[8]=x0+notch（始点）, points[10]=x1-notch（終点）。
  // width < 2*notch だと終点が始点より左に来て自己交差する。
  describe('width の境界値（height は十分広い固定値 100 を使う）', () => {
    it(`width = 2*notch-1 (=${2 * NOTCH - 1}) は上辺の始点xが終点xより大きくなる（自己交差）`, () => {
      const points = buildPixelNotchPoints(0, 0, 2 * NOTCH - 1, 100, NOTCH)
      const topStartX = points[8]
      const topEndX = points[10]
      expect(topStartX).toBeGreaterThan(topEndX)
    })

    it(`width = 2*notch (=${2 * NOTCH}) は上辺の長さが0の縮退ケースで例外を投げない`, () => {
      expect(() => buildPixelNotchPoints(0, 0, 2 * NOTCH, 100, NOTCH)).not.toThrow()
      const points = buildPixelNotchPoints(0, 0, 2 * NOTCH, 100, NOTCH)
      const topStartX = points[8]
      const topEndX = points[10]
      expect(topStartX).toBe(topEndX)
    })

    it(`width = 2*notch+1 (=${2 * NOTCH + 1}) は上辺の長さが正で通常の非交差ポリゴンになる`, () => {
      const points = buildPixelNotchPoints(0, 0, 2 * NOTCH + 1, 100, NOTCH)
      const topStartX = points[8]
      const topEndX = points[10]
      expect(topEndX).toBeGreaterThan(topStartX)
    })
  })

  // 右辺は points[19]=y0+notch（始点）, points[21]=y1-notch（終点）。width と対称の境界。
  describe('height の境界値（width は十分広い固定値 100 を使う）', () => {
    it(`height = 2*notch-1 (=${2 * NOTCH - 1}) は右辺の始点yが終点yより大きくなる（自己交差）`, () => {
      const points = buildPixelNotchPoints(0, 0, 100, 2 * NOTCH - 1, NOTCH)
      const rightStartY = points[19]
      const rightEndY = points[21]
      expect(rightStartY).toBeGreaterThan(rightEndY)
    })

    it(`height = 2*notch (=${2 * NOTCH}) は右辺の長さが0の縮退ケースで例外を投げない`, () => {
      expect(() => buildPixelNotchPoints(0, 0, 100, 2 * NOTCH, NOTCH)).not.toThrow()
      const points = buildPixelNotchPoints(0, 0, 100, 2 * NOTCH, NOTCH)
      const rightStartY = points[19]
      const rightEndY = points[21]
      expect(rightStartY).toBe(rightEndY)
    })

    it(`height = 2*notch+1 (=${2 * NOTCH + 1}) は右辺の長さが正で通常の非交差ポリゴンになる`, () => {
      const points = buildPixelNotchPoints(0, 0, 100, 2 * NOTCH + 1, NOTCH)
      const rightStartY = points[19]
      const rightEndY = points[21]
      expect(rightEndY).toBeGreaterThan(rightStartY)
    })
  })

  // 形状の位相回帰: 引数の組み合わせによらず、常に20点(40要素のフラット配列)を返す。
  it.each([
    [0, 0, 100, 50, 10],
    [5, 5, 480, 52, 6],
    [4, 4, 1, 52, 6],
    [0, 0, 1000, 1000, 1],
    [-10, -10, 50, 50, 6],
  ])(
    '常に20点(40要素)を返す (offsetX=%d, offsetY=%d, width=%d, height=%d, notch=%d)',
    (offsetX, offsetY, width, height, notch) => {
      const points = buildPixelNotchPoints(offsetX, offsetY, width, height, notch)
      expect(points.length).toBe(40)
    }
  )

  // 影レイヤの位置ズレ回帰: offsetX/offsetY が0以外のとき、全点が単純に平行移動しているだけで
  // 形状(相対座標)自体は変わらないことを確認する。
  it('offsetX/offsetY が0以外のとき、全点が単純に平行移動している（影レイヤの位置ズレ回帰）', () => {
    const base = buildPixelNotchPoints(0, 0, 480, 52, 6)
    const shifted = buildPixelNotchPoints(4, 4, 480, 52, 6)

    expect(shifted.length).toBe(base.length)
    for (let i = 0; i < base.length; i += 2) {
      expect(shifted[i]).toBe(base[i] + 4) // x 座標
      expect(shifted[i + 1]).toBe(base[i + 1] + 4) // y 座標
    }
  })
})

// #562: show() の統合的なふるまい確認。フレーム描画方式(rounded/notched)以外のロジック
// （ボタン数・座標計算・ライフサイクル）は pixel でも default と非破壊で共通であることを見る。
describe('ChoiceOverlay pixel 統合フロー (#562)', () => {
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

// #562 現状記録（修正を要求するテストではない）: pixel スタイルは PIXEL_NOTCH_SIZE(6px)*2=12px
// 未満のボタン幅になる極端な設定（狭い画面 × 多列グリッド）で、buildPixelNotchPoints が
// 自己交差ポリゴンを返す設計上の未対応領域を持つ。これは既知の未対応領域であり、修正は
// 本 issue (#562) のスコープ外。将来 pixel スタイル × 極端な多列グリッドを実際に使うことに
// なったら、drawFrame 側で notch を
// `Math.min(PIXEL_NOTCH_SIZE, layoutButtonWidth / 2, BUTTON_HEIGHT / 2)` のようにクランプする
// 対応を検討する。ここでは現状の挙動をテストとして記録するだけに留める。
describe('ChoiceOverlay pixel×極端に狭いグリッド (#562 現状記録・修正スコープ外)', () => {
  it('狭い画面(200px)×style="pixel"×列20(多列グリッド)で show() を呼んでも例外は投げない（クラッシュしないことの最低保証）', () => {
    const overlay = new ChoiceOverlay(200, 400)
    expect(() => overlay.show(choices(20), vi.fn(), 'pixel', undefined, 20)).not.toThrow()
    overlay.hide()
  })

  it('現状記録: 上記シナリオで実際の layoutButtonWidth は PIXEL_NOTCH_SIZE*2=12px を下回り、buildPixelNotchPoints が自己交差ポリゴンを返す状態に実際に到達する', () => {
    const polySpy = vi.spyOn(Graphics.prototype, 'poly')
    const overlay = new ChoiceOverlay(200, 400)
    overlay.show(choices(20), vi.fn(), 'pixel', undefined, 20)

    expect(polySpy.mock.calls.length).toBeGreaterThan(0)
    const points = polySpy.mock.calls[0][0] as number[]
    // width = x1 - x0（buildPixelNotchPoints の点順で x0=points[0], x1=points[16]）
    const width = points[16] - points[0]
    expect(width).toBeLessThan(12) // PIXEL_NOTCH_SIZE(6) * 2

    // 上辺の始点(points[8]=x0+notch)が終点(points[10]=x1-notch)より右＝自己交差に実際に到達
    const topStartX = points[8]
    const topEndX = points[10]
    expect(topStartX).toBeGreaterThan(topEndX)

    overlay.hide()
    polySpy.mockRestore()
  })
})
