import { describe, it, expect, vi } from 'vitest'
import { Text as PixiText, Rectangle } from 'pixi.js'
import { ChoiceOverlay, resolveChoiceVisual, resolveStyle } from './ChoiceOverlay'
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
