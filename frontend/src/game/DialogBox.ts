/**
 * PixiJS ベースのダイアログボックス
 *
 * - 半透明黒背景 + 白枠
 * - 話者名ボックス（名前がある場合のみ表示）
 * - 日本語ワードラップ（禁則処理付き）
 * - 続きインジケーター（▼ バウンスアニメーション）
 * - 枠なしナレ風モード (#135): 背景・枠を非表示にし DropShadow で可読性を確保
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
  /**
   * 枠なしナレ風モード（デフォルト: false）。
   * true のとき半透明黒背景・白枠・話者名ボックスを非表示にし、
   * テキストに drop-shadow を付けて可読性を確保する。
   * per-game デフォルトとして指定し、[枠なし]/[枠あり] で per-scene 上書き可能。
   */
  borderless?: boolean
}

/** typewriter のデフォルト速度（ms/char）。設定画面 #138 で上書き可能になる前提 */
const DEFAULT_MS_PER_CHAR = 30

/** 枠なしモードの DropShadow 設定 */
const BORDERLESS_DROP_SHADOW = { color: 0x000000, blur: 4, distance: 2, alpha: 0.9 } as const

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
  /** 枠なしモード (#135) */
  private borderless: boolean

  /** typewriter 状態 (#137) */
  private typewriter: TypewriterState = makeInitialTypewriterState()
  /** typewriter: 1 文字あたり ms */
  private msPerChar: number
  /** 続きインジケーターを「表示したい」かどうか。実表示は typewriter 完了後に解禁 */
  private indicatorWanted: boolean = false
  /**
   * typewriter 表示完了時に1度だけ呼ばれるコールバック。
   * setDialog() ごとに上書きされる。オートモード (#139) で使用。
   */
  private onTypingDone: (() => void) | null = null

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
      borderless = false,
    } = config

    this.padding = padding
    this.fontSize = fontSize
    this.fontFamily = fontFamily
    this.msPerChar = msPerChar
    this.borderless = borderless
    this.boxW = screenWidth - marginX * 2
    this.boxH = boxHeight
    this.boxX = marginX
    this.boxY = screenHeight - boxHeight - marginBottom

    // --- 半透明黒背景 + 白枠（枠なしモードでは非表示） ---
    this.bg = new Graphics()
    if (!this.borderless) {
      this.drawBackground()
    }
    this.addChild(this.bg)

    // --- 話者名ボックス（枠なしモードでは常に非表示） ---
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
    // 枠なしモードでは drop-shadow で可読性を確保
    this.dialogText = new Text({ text: '', style: this.makeDialogTextStyle() })
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
        const justFinished = isTypingActive(this.typewriter) && !isTypingActive(next)
        this.typewriter = next
        // タイピング完了した瞬間にコールバックを1度だけ呼ぶ
        if (justFinished && this.onTypingDone) {
          const cb = this.onTypingDone
          this.onTypingDone = null
          cb()
        }
      }

      // インジケーターは「表示したい」かつ「typewriter 完了」のときのみ可視
      this.indicator.visible = this.indicatorWanted && !isTypingActive(this.typewriter)
    })
    this.ticker.start()
  }

  /** ダイアログテキスト用 TextStyle を生成（borderless 状態に応じて drop-shadow を制御） */
  private makeDialogTextStyle(): TextStyle {
    return new TextStyle({
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      fill: 0xffffff,
      lineHeight: this.fontSize * 1.6,
      dropShadow: this.borderless ? BORDERLESS_DROP_SHADOW : false,
    })
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
   *
   * 枠なしモード（borderless=true）では name を無視して nameBox を非表示にする。
   * setBorderless(false) で枠ありに戻したあとも、nameBox の復元はこのメソッドの呼び出し時に行う。
   *
   * @param onTypingDone タイピング完了時に1度だけ呼ばれるコールバック（オートモード用）
   */
  setDialog(name: string | null, text: string, onTypingDone?: (() => void) | null): void {
    // 話者名（枠なしモードでは常に非表示）
    if (name && !this.borderless) {
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
    // タイピング完了コールバックをセット（空テキストはタイプライターが動かないので即呼び出し）
    this.onTypingDone = onTypingDone ?? null
    if (!isTypingActive(this.typewriter) && this.onTypingDone) {
      const cb = this.onTypingDone
      this.onTypingDone = null
      cb()
    }
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
    // スキップ時はオートモードコールバックを破棄（手動操作なので自動進行しない）
    this.onTypingDone = null
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
   * 枠なしナレ風モードを動的に切替える。
   *
   * - true: 半透明背景・白枠・話者名ボックスを非表示 + DropShadow を付与
   * - false: 通常モードに戻す。話者名の再表示は次の setDialog() 呼び出し時に行われる
   *
   * per-scene の [枠なし]/[枠あり] ディレクティブ、またはシーンリセット時に呼ぶ。
   */
  setBorderless(borderless: boolean): void {
    if (this.borderless === borderless) return
    this.borderless = borderless
    // 背景・枠の再描画
    this.bg.clear()
    if (!this.borderless) {
      this.drawBackground()
    }
    // drop-shadow は TextStyle を再生成して反映
    this.dialogText.style = this.makeDialogTextStyle()
    // 話者名ボックスは枠なしモードでは常に非表示。
    // 枠ありに戻したときの nameBox/nameText の表示復元は次の setDialog() に委ねる。
    if (this.borderless) {
      this.nameBox.visible = false
      this.nameText.visible = false
    }
  }

  /**
   * フォントファミリーを動的に切り替える (#147)。
   *
   * - dialogText / nameText / indicator の TextStyle を再生成して反映する
   * - 同じ family のときは何もしない（不要な再描画を避ける）
   * - 呼び出し側で `ensureFontLoaded(family)` を await したあとに呼ぶ前提
   *   （未ロードのまま呼んでも fallback フォントで表示されるだけで壊れはしない）
   */
  setFontFamily(family: string): void {
    if (this.fontFamily === family) return
    this.fontFamily = family
    // dialogText: borderless 状態を維持しつつ family を更新
    this.dialogText.style = this.makeDialogTextStyle()
    // nameText: 既存の style を新規生成し直す（font-weight bold を維持）
    this.nameText.style = new TextStyle({
      fontFamily: family,
      fontSize: this.fontSize - 2,
      fill: 0xffffff,
      fontWeight: 'bold',
    })
    // indicator (▼): default size 20, fill 0xa8dadc を維持
    this.indicator.style = new TextStyle({
      fontFamily: family,
      fontSize: 20,
      fill: 0xa8dadc,
    })
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
