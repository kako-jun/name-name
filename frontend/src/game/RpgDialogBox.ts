/**
 * PixiJS ベースの RPG 用ダイアログボックス。
 *
 * TopDownRenderer / RaycastRenderer で共通利用する会話 UI。
 * - 紺背景 + 白枠 + 黄色話者名 + 白本文（PixiText wordWrap）
 * - 長文は mask でボックス内にクリップ
 *
 * ノベル用 DialogBox（話者名別枠 + ▼インジケーター + 禁則ワードラップ）とは見た目が別系統のため独立クラスとして分離している。
 */

import { Container, Graphics, Text as PixiText, TextStyle } from 'pixi.js'

export class RpgDialogBox extends Container {
  private bg: Graphics | null = null
  private nameText: PixiText | null = null
  private messageText: PixiText | null = null
  private maskGraphics: Graphics | null = null
  private currentName = ''
  private currentMessage = ''
  private screenWidth: number
  private screenHeight: number
  private showing = false

  constructor(screenWidth: number, screenHeight: number) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.build()
  }

  get isShowing(): boolean {
    return this.showing
  }

  show(name: string, message: string): void {
    this.showing = true
    this.currentName = name
    this.currentMessage = message
    if (this.bg) this.bg.visible = true
    if (this.nameText) {
      this.nameText.text = name
      this.nameText.visible = true
    }
    if (this.messageText) {
      this.messageText.text = message
      this.messageText.visible = true
    }
  }

  hide(): void {
    this.showing = false
    if (this.bg) this.bg.visible = false
    if (this.nameText) this.nameText.visible = false
    if (this.messageText) this.messageText.visible = false
  }

  redraw(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.disposeChildren()
    this.build()
  }

  override destroy(): void {
    // super.destroy({ children: true }) が自身と全子要素を破棄する
    this.bg = null
    this.nameText = null
    this.messageText = null
    this.maskGraphics = null
    super.destroy({ children: true })
  }

  private disposeChildren(): void {
    this.removeChildren()
    if (this.bg) {
      this.bg.destroy()
      this.bg = null
    }
    if (this.nameText) {
      this.nameText.destroy()
      this.nameText = null
    }
    if (this.messageText) {
      this.messageText.destroy()
      this.messageText = null
    }
    if (this.maskGraphics) {
      this.maskGraphics.destroy()
      this.maskGraphics = null
    }
  }

  private build(): void {
    const height = 120
    const width = this.screenWidth - 40
    const boxTop = this.screenHeight - 140

    const bg = new Graphics()
    bg.roundRect(20, boxTop, width, height, 8)
    bg.fill({ color: 0x000033, alpha: 0.92 })
    bg.stroke({ width: 3, color: 0xffffff })
    bg.visible = this.showing
    this.bg = bg
    this.addChild(bg)

    const nameStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 18,
      fill: 0xffe066,
      fontWeight: 'bold',
    })
    const name = new PixiText({ text: this.currentName, style: nameStyle })
    name.x = 40
    name.y = boxTop + 10
    name.visible = this.showing
    this.nameText = name
    this.addChild(name)

    const textStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 18,
      fill: 0xffffff,
      wordWrap: true,
      wordWrapWidth: width - 40,
      breakWords: true,
      lineHeight: 26,
    })
    const message = new PixiText({ text: this.currentMessage, style: textStyle })
    message.x = 40
    message.y = boxTop + 40
    message.visible = this.showing
    this.messageText = message
    this.addChild(message)

    const mask = new Graphics()
    mask.rect(20, boxTop, width, height)
    mask.fill(0xffffff)
    this.maskGraphics = mask
    this.addChild(mask)
    message.mask = mask
  }
}
