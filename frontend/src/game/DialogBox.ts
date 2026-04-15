/**
 * PixiJS ベースのダイアログボックス
 *
 * - 半透明黒背景 + 白枠
 * - 話者名ボックス（名前がある場合のみ表示）
 * - 日本語ワードラップ（禁則処理付き）
 * - 続きインジケーター（▼ バウンスアニメーション）
 */

import { Container, Graphics, Text, TextStyle, Ticker } from 'pixi.js'
import { wordwrap } from './wordwrap'

export interface DialogBoxConfig {
  /** ゲーム画面幅 */
  screenWidth: number
  /** ゲーム画面高さ */
  screenHeight: number
  /** ボックスの高さ（デフォルト: 180） */
  boxHeight?: number
  /** ボックスの左右マージン（デフォルト: 20） */
  marginX?: number
  /** ボックスの下マージン（デフォルト: 20） */
  marginBottom?: number
  /** テキスト内パディング（デフォルト: 20） */
  padding?: number
  /** フォントサイズ（デフォルト: 22） */
  fontSize?: number
  /** フォントファミリー（デフォルト: Noto Sans JP, sans-serif） */
  fontFamily?: string
}

export class DialogBox extends Container {
  private bg: Graphics
  private nameBox: Graphics
  private nameText: Text
  private dialogText: Text
  private indicator: Text
  private indicatorBaseY: number
  private indicatorTime = 0

  private boxX: number
  private boxY: number
  private boxW: number
  private boxH: number
  private padding: number
  private fontSize: number
  private fontFamily: string

  private ticker: Ticker

  constructor(config: DialogBoxConfig) {
    super()

    const {
      screenWidth,
      screenHeight,
      boxHeight = 180,
      marginX = 20,
      marginBottom = 20,
      padding = 20,
      fontSize = 22,
      fontFamily = "'Noto Sans JP', sans-serif",
    } = config

    this.padding = padding
    this.fontSize = fontSize
    this.fontFamily = fontFamily
    this.boxW = screenWidth - marginX * 2
    this.boxH = boxHeight
    this.boxX = marginX
    this.boxY = screenHeight - boxHeight - marginBottom

    // --- 半透明黒背景 + 白枠 ---
    this.bg = new Graphics()
    this.drawBackground()
    this.addChild(this.bg)

    // --- 話者名ボックス ---
    this.nameBox = new Graphics()
    this.addChild(this.nameBox)

    const nameStyle = new TextStyle({
      fontFamily,
      fontSize: fontSize - 2,
      fill: 0xffffff,
      fontWeight: 'bold',
    })
    this.nameText = new Text({ text: '', style: nameStyle })
    this.nameText.x = this.boxX + padding + 8
    this.nameText.y = this.boxY - 36
    this.addChild(this.nameText)
    this.nameBox.visible = false
    this.nameText.visible = false

    // --- ダイアログテキスト ---
    const textStyle = new TextStyle({
      fontFamily,
      fontSize,
      fill: 0xffffff,
      lineHeight: fontSize * 1.6,
    })
    this.dialogText = new Text({ text: '', style: textStyle })
    this.dialogText.x = this.boxX + padding
    this.dialogText.y = this.boxY + padding
    this.addChild(this.dialogText)

    // --- 続きインジケーター（▼） ---
    const indicatorStyle = new TextStyle({
      fontFamily,
      fontSize: 20,
      fill: 0xa8dadc,
    })
    this.indicator = new Text({ text: '\u25BC', style: indicatorStyle })
    this.indicatorBaseY = this.boxY + this.boxH - 30
    this.indicator.x = this.boxX + this.boxW - 40
    this.indicator.y = this.indicatorBaseY
    this.addChild(this.indicator)

    // --- バウンスアニメーション ---
    this.ticker = new Ticker()
    this.ticker.add(() => {
      this.indicatorTime = (this.indicatorTime + this.ticker.deltaMS / 1000) % ((2 * Math.PI) / 3)
      this.indicator.y = this.indicatorBaseY + Math.sin(this.indicatorTime * 3) * 4
    })
    this.ticker.start()
  }

  private drawBackground(): void {
    this.bg.clear()
    // 半透明黒背景
    this.bg.roundRect(this.boxX, this.boxY, this.boxW, this.boxH, 8)
    this.bg.fill({ color: 0x000000, alpha: 0.85 })
    // 白枠
    this.bg.roundRect(this.boxX, this.boxY, this.boxW, this.boxH, 8)
    this.bg.stroke({ color: 0xf1faee, width: 2, alpha: 1 })
  }

  private drawNameBox(textWidth: number): void {
    const nameBoxW = textWidth + this.padding * 2 + 16
    const nameBoxH = 36
    const nameBoxX = this.boxX
    const nameBoxY = this.boxY - nameBoxH - 4

    this.nameBox.clear()
    this.nameBox.roundRect(nameBoxX, nameBoxY, nameBoxW, nameBoxH, 6)
    this.nameBox.fill({ color: 0x000000, alpha: 0.85 })
    this.nameBox.roundRect(nameBoxX, nameBoxY, nameBoxW, nameBoxH, 6)
    this.nameBox.stroke({ color: 0xf1faee, width: 2, alpha: 1 })

    this.nameText.x = nameBoxX + this.padding
    this.nameText.y = nameBoxY + (nameBoxH - this.fontSize + 2) / 2
  }

  /**
   * ダイアログを表示（話者名 + テキスト）
   */
  setDialog(name: string | null, text: string): void {
    // 話者名
    if (name) {
      this.nameText.text = name
      // テキスト幅を測定して名前ボックスを描画
      const measured = this.nameText.width
      this.drawNameBox(measured)
      this.nameBox.visible = true
      this.nameText.visible = true
    } else {
      this.nameBox.visible = false
      this.nameText.visible = false
    }

    // テキスト（ワードラップ適用）
    const font = `${this.fontSize}px ${this.fontFamily}`
    const maxTextWidth = this.boxW - this.padding * 2
    const lines = wordwrap(text, maxTextWidth, font)
    this.dialogText.text = lines.join('\n')
  }

  /**
   * テキストのみクリアする
   */
  clearText(): void {
    this.dialogText.text = ''
  }

  /**
   * 続きインジケーターの表示/非表示
   */
  setIndicatorVisible(visible: boolean): void {
    this.indicator.visible = visible
  }

  /**
   * リソース解放
   */
  dispose(): void {
    this.ticker.stop()
    this.ticker.destroy()
  }
}
