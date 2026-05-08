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
import {
  type TypewriterState,
  isTypingActive,
  makeInitialTypewriterState,
  skipTypewriter as typewriterSkip,
  startTypewriter,
  tickTypewriter,
  visibleText,
} from './typewriter'

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
  /** typewriter 表示の 1 文字あたり ms（デフォルト: 30ms/char） */
  msPerChar?: number
}

/** typewriter のデフォルト速度（ms/char）。設定画面 #138 で上書き可能になる前提 */
const DEFAULT_MS_PER_CHAR = 30

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

  /** typewriter 状態 (#137) */
  private typewriter: TypewriterState = makeInitialTypewriterState()
  /** typewriter: 1 文字あたり ms */
  private msPerChar: number
  /** 続きインジケーターを「表示したい」かどうか。実表示は typewriter 完了後に解禁 */
  private indicatorWanted: boolean = false

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
      msPerChar = DEFAULT_MS_PER_CHAR,
    } = config

    this.padding = padding
    this.fontSize = fontSize
    this.fontFamily = fontFamily
    this.msPerChar = msPerChar
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

    // --- ticker: バウンスアニメーション + typewriter 進行 ---
    this.ticker = new Ticker()
    this.ticker.add(() => {
      // インジケーターのバウンス（typewriter 中は表示されないが計算は無害なので継続）
      this.indicatorTime = (this.indicatorTime + this.ticker.deltaMS / 1000) % ((2 * Math.PI) / 3)
      this.indicator.y = this.indicatorBaseY + Math.sin(this.indicatorTime * 3) * 4

      // typewriter: 文字を 1 文字ずつ進める
      if (isTypingActive(this.typewriter)) {
        const next = tickTypewriter(this.typewriter, this.ticker.deltaMS, this.msPerChar)
        if (next.displayedCharCount !== this.typewriter.displayedCharCount) {
          this.dialogText.text = visibleText(next)
        }
        this.typewriter = next
      }

      // インジケーターは「表示したい」かつ「typewriter 完了」のときのみ可視
      this.indicator.visible = this.indicatorWanted && !isTypingActive(this.typewriter)
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

    // テキスト（ワードラップ適用）+ typewriter 開始
    const font = `${this.fontSize}px ${this.fontFamily}`
    const maxTextWidth = this.boxW - this.padding * 2
    const lines = wordwrap(text, maxTextWidth, font)
    this.typewriter = startTypewriter(lines.join('\n'))
    this.dialogText.text = ''
  }

  /**
   * テキストのみクリアする
   */
  clearText(): void {
    this.typewriter = makeInitialTypewriterState()
    this.dialogText.text = ''
  }

  /**
   * typewriter 表示中なら全文を即時表示し完了させる。
   * 表示完了済みなら何もしない。
   */
  skipTypewriter(): void {
    if (!isTypingActive(this.typewriter)) return
    this.typewriter = typewriterSkip(this.typewriter)
    this.dialogText.text = visibleText(this.typewriter)
  }

  /**
   * typewriter が進行中（まだ全文表示されていない）か。
   */
  isTyping(): boolean {
    return isTypingActive(this.typewriter)
  }

  /**
   * typewriter 速度を設定する (#138 設定画面から呼ぶ前提)。
   * @param msPerChar 1 文字あたり ms。0 以下は瞬間表示扱い。
   */
  setMsPerChar(msPerChar: number): void {
    this.msPerChar = Math.max(0, msPerChar)
    if (this.msPerChar === 0) {
      this.skipTypewriter()
    }
  }

  /**
   * 続きインジケーターの表示要望を保存する。
   * 実際の表示は typewriter 完了後に ticker 内で反映される。
   */
  setIndicatorVisible(visible: boolean): void {
    this.indicatorWanted = visible
    // typewriter 中なら抑止、完了済みなら即時反映
    this.indicator.visible = visible && !isTypingActive(this.typewriter)
  }

  /**
   * リソース解放
   */
  dispose(): void {
    this.ticker.stop()
    this.ticker.destroy()
  }
}
