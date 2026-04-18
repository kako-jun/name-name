/**
 * 選択肢UI
 *
 * PixiJS の Container 内にボタン（Graphics + Text）を縦並びで表示する。
 * ホバーでハイライト、クリックで選択コールバックを呼ぶ。
 */

import { Container, Graphics, Text as PixiText, TextStyle } from 'pixi.js'
import { ChoiceOption } from '../types'

const BUTTON_WIDTH = 480
const BUTTON_HEIGHT = 52
const BUTTON_GAP = 16
const BUTTON_RADIUS = 8

const NORMAL_COLOR = 0x1a1a2e
const HOVER_COLOR = 0x16213e
const BORDER_COLOR = 0xa8dadc
const HOVER_BORDER_COLOR = 0xf1faee

export class ChoiceOverlay extends Container {
  private onSelect: ((jump: string) => void) | null = null

  constructor(
    private screenWidth: number,
    private screenHeight: number
  ) {
    super()
    this.eventMode = 'static'
  }

  /**
   * 選択肢を表示する
   */
  show(options: ChoiceOption[], onSelect: (jump: string) => void): void {
    if (options.length === 0) return
    this.onSelect = onSelect
    this.removeChildren()

    const totalHeight = options.length * BUTTON_HEIGHT + (options.length - 1) * BUTTON_GAP
    const startY = (this.screenHeight - totalHeight) / 2

    const textStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 20,
      fill: 0xf1faee,
      fontWeight: 'bold',
    })

    options.forEach((option, i) => {
      const buttonContainer = new Container()
      buttonContainer.eventMode = 'static'
      buttonContainer.cursor = 'pointer'

      const bg = new Graphics()
      this.drawButton(bg, NORMAL_COLOR, BORDER_COLOR)
      buttonContainer.addChild(bg)

      const label = new PixiText({ text: option.text, style: textStyle })
      label.x = BUTTON_WIDTH / 2
      label.y = BUTTON_HEIGHT / 2
      label.anchor.set(0.5, 0.5)
      buttonContainer.addChild(label)

      buttonContainer.x = (this.screenWidth - BUTTON_WIDTH) / 2
      buttonContainer.y = startY + i * (BUTTON_HEIGHT + BUTTON_GAP)

      buttonContainer.on('pointerover', () => {
        bg.clear()
        this.drawButton(bg, HOVER_COLOR, HOVER_BORDER_COLOR)
      })

      buttonContainer.on('pointerout', () => {
        bg.clear()
        this.drawButton(bg, NORMAL_COLOR, BORDER_COLOR)
      })

      buttonContainer.on('pointerdown', (e) => {
        e.stopPropagation()
        this.onSelect?.(option.jump)
      })

      this.addChild(buttonContainer)
    })

    this.visible = true
  }

  /**
   * 選択肢を非表示にする
   */
  hide(): void {
    this.visible = false
    this.removeChildren()
    this.onSelect = null
  }

  private drawButton(g: Graphics, fillColor: number, borderColor: number): void {
    g.roundRect(0, 0, BUTTON_WIDTH, BUTTON_HEIGHT, BUTTON_RADIUS)
    g.fill(fillColor)
    g.stroke({ color: borderColor, width: 2 })
  }
}
