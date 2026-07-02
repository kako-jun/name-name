import { describe, it, expect, vi } from 'vitest'
import { Text as PixiText } from 'pixi.js'
import { ChoiceOverlay, resolveChoiceVisual, resolveStyle } from './ChoiceOverlay'
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
