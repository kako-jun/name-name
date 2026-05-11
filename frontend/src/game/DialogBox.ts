/**
 * PixiJS ベースのダイアログボックス
 *
 * ノベル・RPG 共通のテキストウィンドウ基盤。#194 で旧 RpgDialogBox の機能を統合済み。
 *
 * ## モード
 * - **ノベルモード**（デフォルト）: 半透明黒背景 + 白枠、話者名別枠、▼インジケーター、禁則ワードラップ
 * - **RPG モード**（`bgColor` / `nameColor` 指定）: 紺背景・黄名前など外観をカスタマイズ可能
 * - **枠なしモード**（`borderless: true`）: 背景・枠を非表示にし DropShadow で可読性を確保
 *
 * ## portrait
 * `portrait` オプションで NPC 顔画像を左側に表示できる（#73 / #101）。
 * 非同期ロード・token による race 防止・contain fit（アスペクト比維持）を実装。
 *
 * ## 複数同時表示
 * インスタンスを複数生成して stage に追加するだけで実現できる。
 */

import { Assets, Container, Graphics, Sprite, Text, TextStyle, Texture, Ticker } from 'pixi.js'
import { wordwrap } from './wordwrap'
import { parseRubyText, stripRubyMarkup } from './ruby'
import { type RubyPlacement, computeRubyPlacements } from './rubyLayout'
import { ensureFontLoaded } from './FontLoader'
import {
  type TypewriterState,
  isTypingActive,
  makeInitialTypewriterState,
  skipTypewriter as typewriterSkip,
  startTypewriter,
  tickTypewriter,
  visibleText,
} from './typewriter'

// ---------------------------------------------------------------------------
// portrait レイアウト定数（テストが参照する）
// ---------------------------------------------------------------------------
export const PORTRAIT_SIZE = 80
export const PORTRAIT_MARGIN = 20
export const PORTRAIT_X = 40
export const PORTRAIT_Y_OFFSET = 20

/**
 * portrait 画像を `PORTRAIT_SIZE` 正方形枠に「contain」（アスペクト比維持で内接）するときの
 * 表示矩形を計算する純関数。余白は portraitFrame の半透明黒で埋まる前提。
 */
export function computePortraitContainFit(
  srcW: number,
  srcH: number,
  frameX: number,
  frameY: number,
  frameSize: number
): { x: number; y: number; width: number; height: number } {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    return { x: frameX, y: frameY, width: frameSize, height: frameSize }
  }
  const scale = Math.min(frameSize / srcW, frameSize / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return {
    x: frameX + (frameSize - w) / 2,
    y: frameY + (frameSize - h) / 2,
    width: w,
    height: h,
  }
}

// ---------------------------------------------------------------------------
// portrait テクスチャキャッシュ（モジュールグローバル）
// 複数の DialogBox インスタンスでキャッシュを共有する。
// 同一パスへの重複ロードを避け、ちらつきを防ぐ。
// テスト間でキャッシュが汚染される可能性があるため、テストでは vi.mock 等で隔離すること。
// ---------------------------------------------------------------------------
const portraitCache: Map<string, Promise<Texture>> = new Map()

function loadPortraitTexture(path: string): Promise<Texture> {
  const cached = portraitCache.get(path)
  if (cached) return cached
  const promise = Assets.load(path).then((tex: unknown) => {
    if (!(tex instanceof Texture)) {
      throw new Error(`[DialogBox] loaded asset for "${path}" is not a Texture`)
    }
    return tex
  })
  portraitCache.set(path, promise)
  promise.catch((err: unknown) => {
    console.warn(`[DialogBox] failed to load portrait "${path}":`, err)
    portraitCache.delete(path)
  })
  return promise
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
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
   */
  borderless?: boolean
  /**
   * 背景色（デフォルト: 0x000000）。
   * RPG 用に紺（0x000033）などを指定できる。
   */
  bgColor?: number
  /**
   * 話者名テキスト色（デフォルト: 0xffffff）。
   * RPG 用に黄色（0xffe066）などを指定できる。
   */
  nameColor?: number
  /**
   * 話者名を別ボックスとして表示するか（デフォルト: true）。
   * false にするとウィンドウ内上部にインライン表示する（RPG スタイル）。
   */
  nameSeparateBox?: boolean
}

/** typewriter のデフォルト速度（ms/char） */
const DEFAULT_MS_PER_CHAR = 30

/** 枠なしモードの DropShadow 設定 */
const BORDERLESS_DROP_SHADOW = { color: 0x000000, blur: 4, distance: 2, alpha: 0.9 } as const

/**
 * ルビの x 位置計算用の Canvas measure コンテキスト。
 */
let cachedRubyCanvas: HTMLCanvasElement | null = null
let cachedRubyCtx: CanvasRenderingContext2D | null = null
function getMeasureContext(): CanvasRenderingContext2D | null {
  if (!cachedRubyCtx) {
    cachedRubyCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
    cachedRubyCtx = cachedRubyCanvas?.getContext('2d') ?? null
  }
  return cachedRubyCtx
}

// ---------------------------------------------------------------------------
// DialogBox
// ---------------------------------------------------------------------------
export class DialogBox extends Container {
  // --- 背景・枠 ---
  private bg: Graphics
  // --- 話者名（separate box モード） ---
  private nameBox: Graphics
  private nameText: Text
  // --- RPG インライン名（separate box = false モード） ---
  private inlineNameText: Text | null = null
  // --- ダイアログ本文 ---
  private dialogText: Text
  /** ルビ描画用 Container */
  private rubyContainer: Container
  private rubyEntries: Array<{ placement: RubyPlacement; text: Text }> = []
  private rubyPlacements: RubyPlacement[] = []
  // --- ▼インジケーター ---
  private indicator: Text
  private indicatorBaseY: number
  private indicatorTime = 0
  // --- portrait ---
  private portraitFrame: Graphics | null = null
  private portraitSprite: Sprite | null = null
  private currentPortrait: string | undefined = undefined
  private currentPortraitToken = 0
  private rubyBuildToken = 0

  // --- レイアウト ---
  private boxX: number
  private boxY: number
  private boxW: number
  private boxH: number
  private padding: number
  private fontSize: number
  private fontFamily: string
  private marginX: number
  private marginBottom: number

  // --- 設定 ---
  private borderless: boolean
  private bgColor: number
  private nameColor: number
  private nameSeparateBox: boolean

  // --- 状態 ---
  private currentText: string = ''
  private showing = false

  // --- typewriter ---
  private typewriter: TypewriterState = makeInitialTypewriterState()
  private msPerChar: number
  private indicatorWanted: boolean = false
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
      bgColor = 0x000000,
      nameColor = 0xffffff,
      nameSeparateBox = true,
    } = config

    this.padding = padding
    this.fontSize = fontSize
    this.fontFamily = fontFamily
    this.msPerChar = msPerChar
    this.borderless = borderless
    this.bgColor = bgColor
    this.nameColor = nameColor
    this.nameSeparateBox = nameSeparateBox
    this.marginX = marginX
    this.marginBottom = marginBottom
    this.boxW = screenWidth - marginX * 2
    this.boxH = boxHeight
    this.boxX = marginX
    this.boxY = screenHeight - boxHeight - marginBottom

    // --- 背景 ---
    this.bg = new Graphics()
    if (!this.borderless) {
      this.drawBackground()
    }
    this.addChild(this.bg)

    // --- portrait 顔枠（常に作成し visible=false で保持） ---
    this.portraitFrame = new Graphics()
    const portraitY = this.boxY + PORTRAIT_Y_OFFSET
    this.portraitFrame.rect(PORTRAIT_X, portraitY, PORTRAIT_SIZE, PORTRAIT_SIZE)
    this.portraitFrame.fill({ color: 0x000000, alpha: 0.6 })
    this.portraitFrame.stroke({ width: 2, color: 0xffffff })
    this.portraitFrame.visible = false
    this.addChild(this.portraitFrame)

    // --- 話者名（separate box モード） ---
    this.nameBox = new Graphics()
    this.addChild(this.nameBox)

    const nameStyle = new TextStyle({
      fontFamily,
      fontSize: fontSize - 2,
      fill: this.nameColor,
      fontWeight: 'bold',
    })
    this.nameText = new Text({ text: '', style: nameStyle })
    this.nameText.x = this.boxX + padding + 8
    this.nameText.y = this.boxY - 36
    this.addChild(this.nameText)
    this.nameBox.visible = false
    this.nameText.visible = false

    // --- インライン名（nameSeparateBox = false のとき使用） ---
    if (!nameSeparateBox) {
      const inlineStyle = new TextStyle({
        fontFamily,
        fontSize: fontSize - 4,
        fill: this.nameColor,
        fontWeight: 'bold',
      })
      this.inlineNameText = new Text({ text: '', style: inlineStyle })
      this.inlineNameText.x = this.boxX + padding
      this.inlineNameText.y = this.boxY + padding
      this.inlineNameText.visible = false
      this.addChild(this.inlineNameText)
    }

    // --- ダイアログテキスト ---
    this.dialogText = new Text({ text: '', style: this.makeDialogTextStyle() })
    this.dialogText.x = this.textStartX()
    this.dialogText.y = this.textStartY()
    this.addChild(this.dialogText)

    // --- ルビ Container ---
    this.rubyContainer = new Container()
    this.rubyContainer.x = this.dialogText.x
    this.rubyContainer.y = this.dialogText.y
    this.addChild(this.rubyContainer)

    // --- ▼インジケーター ---
    const indicatorStyle = new TextStyle({
      fontFamily,
      fontSize: 20,
      fill: 0xa8dadc,
    })
    this.indicator = new Text({ text: '▼', style: indicatorStyle })
    this.indicatorBaseY = this.boxY + this.boxH - 30
    this.indicator.x = this.boxX + this.boxW - 40
    this.indicator.y = this.indicatorBaseY
    this.addChild(this.indicator)

    // --- ticker ---
    this.ticker = new Ticker()
    this.ticker.add(() => {
      // ▼バウンス
      this.indicatorTime = (this.indicatorTime + this.ticker.deltaMS / 1000) % ((2 * Math.PI) / 3)
      this.indicator.y = this.indicatorBaseY + Math.sin(this.indicatorTime * 3) * 4

      // typewriter
      if (isTypingActive(this.typewriter)) {
        const next = tickTypewriter(this.typewriter, this.ticker.deltaMS, this.msPerChar)
        if (next.displayedCharCount !== this.typewriter.displayedCharCount) {
          this.dialogText.text = visibleText(next)
          this.updateRubyVisibility(next.displayedCharCount)
        }
        const justFinished = isTypingActive(this.typewriter) && !isTypingActive(next)
        this.typewriter = next
        if (justFinished && this.onTypingDone) {
          const cb = this.onTypingDone
          this.onTypingDone = null
          cb()
        }
      }

      this.indicator.visible = this.indicatorWanted && !isTypingActive(this.typewriter)
    })
    this.ticker.start()
  }

  // ---------------------------------------------------------------------------
  // show / hide（RPG スタイル API）
  // ---------------------------------------------------------------------------

  /**
   * ダイアログを表示する（RPG スタイル用）。
   * ノベル用には `setDialog` を直接呼ぶこともできる。
   *
   * Note: ルビ記法（`漢字《かんじ》`）は RPG モードでは非対応。
   * `stripRubyMarkup` でマークアップを除去してから表示する。
   */
  show(name: string, message: string, portrait?: string): void {
    const cleanMessage = stripRubyMarkup(message)
    const previousPortrait = this.currentPortrait
    this.showing = true
    this.currentPortrait = portrait && portrait.length > 0 ? portrait : undefined

    // setDialog が bg.visible / showing を管理するため、ここでは bg.visible を触らない。
    // （show() で bg.visible = true した直後に setDialog() が borderless 状態に応じて上書きするのを防ぐ）
    this.setDialog(name, cleanMessage)

    // portrait
    this.applyPortraitLayout()
    if (this.currentPortrait) {
      const samePath = previousPortrait === this.currentPortrait
      this.beginPortraitLoad(this.currentPortrait, samePath)
    } else {
      this.hidePortrait()
    }
  }

  hide(): void {
    this.showing = false
    this.bg.visible = false
    this.nameBox.visible = false
    this.nameText.visible = false
    if (this.inlineNameText) this.inlineNameText.visible = false
    this.dialogText.visible = false
    this.indicator.visible = false
    this.hidePortrait()
    this.typewriter = makeInitialTypewriterState()
    this.onTypingDone = null
  }

  get isShowing(): boolean {
    return this.showing
  }

  /**
   * 画面リサイズ時にレイアウトを再計算する。
   */
  redraw(screenWidth: number, screenHeight: number): void {
    this.boxW = screenWidth - this.marginX * 2
    this.boxX = this.marginX
    this.boxY = screenHeight - this.boxH - this.marginBottom

    // 背景再描画
    this.bg.clear()
    if (!this.borderless) this.drawBackground()

    // テキスト位置更新
    this.dialogText.x = this.textStartX()
    this.dialogText.y = this.textStartY()
    this.rubyContainer.x = this.dialogText.x
    this.rubyContainer.y = this.dialogText.y
    this.indicator.x = this.boxX + this.boxW - 40
    this.indicatorBaseY = this.boxY + this.boxH - 30
    this.indicator.y = this.indicatorBaseY

    // 名前テキスト位置
    this.nameText.x = this.boxX + this.padding + 8
    this.nameText.y = this.boxY - 36
    if (this.inlineNameText) {
      this.inlineNameText.x = this.boxX + this.padding
      this.inlineNameText.y = this.boxY + this.padding
    }

    // portrait 枠位置
    if (this.portraitFrame) {
      const portraitY = this.boxY + PORTRAIT_Y_OFFSET
      this.portraitFrame.clear()
      this.portraitFrame.rect(PORTRAIT_X, portraitY, PORTRAIT_SIZE, PORTRAIT_SIZE)
      this.portraitFrame.fill({ color: 0x000000, alpha: 0.6 })
      this.portraitFrame.stroke({ width: 2, color: 0xffffff })
    }

    if (this.showing) {
      this.applyPortraitLayout()
      if (this.currentPortrait) {
        this.beginPortraitLoad(this.currentPortrait, false)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ノベル用 API
  // ---------------------------------------------------------------------------

  /**
   * ダイアログを表示（話者名 + テキスト）。
   *
   * テキスト開始 x / wordwrap 幅は `currentPortrait` に依存する。
   * portrait を変更してからこのメソッドを呼ぶ場合は、事前に `this.currentPortrait` を
   * 更新しておくこと。`show()` 経由の場合は自動的に順序が保証される。
   *
   * @param onTypingDone タイピング完了時コールバック（オートモード用）
   */
  setDialog(name: string | null, text: string, onTypingDone?: (() => void) | null): void {
    this.currentText = text
    this.showing = true
    this.bg.visible = !this.borderless

    // 話者名
    this.updateNameDisplay(name)

    // テキスト
    this.dialogText.visible = true
    const font = `${this.fontSize}px ${this.fontFamily}`
    const maxTextWidth = this.maxTextWidth()
    const runs = parseRubyText(text)
    const plainText = stripRubyMarkup(text)
    const lines = wordwrap(plainText, maxTextWidth, font)
    this.typewriter = startTypewriter(lines.join('\n'))
    this.dialogText.text = ''
    this.rubyPlacements = computeRubyPlacements(runs, lines)
    this.rubyBuildToken += 1
    const rubyToken = this.rubyBuildToken
    ensureFontLoaded(this.fontFamily)
      .then(() => {
        if (rubyToken !== this.rubyBuildToken) return
        this.rebuildRubyEntries(lines, font)
      })
      .catch(() => {
        // フォントロード失敗時はルビなしで継続（クラッシュ防止）
      })
    this.onTypingDone = onTypingDone ?? null
    if (!isTypingActive(this.typewriter) && this.onTypingDone) {
      const cb = this.onTypingDone
      this.onTypingDone = null
      cb()
    }
  }

  clearText(): void {
    this.rubyBuildToken += 1
    this.typewriter = makeInitialTypewriterState()
    this.dialogText.text = ''
    this.currentText = ''
    this.onTypingDone = null
    this.clearRubyEntries()
  }

  skipTypewriter(): void {
    if (!isTypingActive(this.typewriter)) return
    this.typewriter = typewriterSkip(this.typewriter)
    this.dialogText.text = visibleText(this.typewriter)
    this.revealAllRuby()
    this.onTypingDone = null
  }

  isTyping(): boolean {
    return isTypingActive(this.typewriter)
  }

  setMsPerChar(msPerChar: number): void {
    this.msPerChar = Math.max(0, msPerChar)
    if (this.msPerChar === 0) {
      this.skipTypewriter()
    }
  }

  setBorderless(borderless: boolean): void {
    if (this.borderless === borderless) return
    this.borderless = borderless
    this.bg.clear()
    if (!this.borderless) {
      this.drawBackground()
    }
    this.dialogText.style = this.makeDialogTextStyle()
    const rubyFontSize = this.rubyFontSize()
    for (const e of this.rubyEntries) {
      e.text.style = new TextStyle({
        fontFamily: this.fontFamily,
        fontSize: rubyFontSize,
        fill: 0xffffff,
        dropShadow: this.borderless ? BORDERLESS_DROP_SHADOW : false,
      })
    }
    if (this.borderless) {
      this.nameBox.visible = false
      this.nameText.visible = false
      if (this.inlineNameText) this.inlineNameText.visible = false
    }
  }

  setFontFamily(family: string): void {
    if (this.fontFamily === family) return
    this.fontFamily = family
    this.dialogText.style = this.makeDialogTextStyle()
    this.nameText.style = new TextStyle({
      fontFamily: family,
      fontSize: this.fontSize - 2,
      fill: this.nameColor,
      fontWeight: 'bold',
    })
    this.indicator.style = new TextStyle({
      fontFamily: family,
      fontSize: 20,
      fill: 0xa8dadc,
    })
    if (this.currentText) {
      const font = `${this.fontSize}px ${this.fontFamily}`
      const maxTextWidth = this.maxTextWidth()
      const runs = parseRubyText(this.currentText)
      const plainText = stripRubyMarkup(this.currentText)
      const lines = wordwrap(plainText, maxTextWidth, font)
      const fullText = lines.join('\n')
      this.typewriter = startTypewriter(fullText)
      this.rubyPlacements = computeRubyPlacements(runs, lines)
      this.rubyBuildToken += 1
      const rubyToken = this.rubyBuildToken
      ensureFontLoaded(this.fontFamily)
        .then(() => {
          if (rubyToken !== this.rubyBuildToken) return
          this.rebuildRubyEntries(lines, font)
          if (!isTypingActive(this.typewriter)) {
            this.dialogText.text = fullText
            this.revealAllRuby()
          } else {
            this.dialogText.text = ''
            this.updateRubyVisibility(0)
          }
        })
        .catch(() => {
          // フォントロード失敗時はルビなしで継続（クラッシュ防止）
        })
    }
  }

  setIndicatorVisible(visible: boolean): void {
    this.indicatorWanted = visible
    this.indicator.visible = visible && !isTypingActive(this.typewriter)
  }

  dispose(): void {
    this.clearRubyEntries()
    this.ticker.stop()
    this.ticker.destroy()
  }

  // ---------------------------------------------------------------------------
  // private: レイアウト
  // ---------------------------------------------------------------------------

  private textStartX(): number {
    if (this.currentPortrait) {
      return PORTRAIT_X + PORTRAIT_SIZE + PORTRAIT_MARGIN
    }
    return this.boxX + this.padding
  }

  private textStartY(): number {
    if (!this.nameSeparateBox && this.inlineNameText) {
      // インライン名の下
      return this.boxY + this.padding + (this.fontSize - 4) + 4
    }
    return this.boxY + this.padding
  }

  private maxTextWidth(): number {
    const left = this.currentPortrait
      ? PORTRAIT_X + PORTRAIT_SIZE + PORTRAIT_MARGIN
      : this.boxX + this.padding
    return this.boxX + this.boxW - this.padding - left
  }

  private updateNameDisplay(name: string | null): void {
    if (this.borderless || !name) {
      this.nameBox.visible = false
      this.nameText.visible = false
      if (this.inlineNameText) this.inlineNameText.visible = false
      return
    }
    if (this.nameSeparateBox) {
      this.nameText.text = name
      const measured = this.nameText.width
      this.drawNameBox(measured)
      this.nameBox.visible = true
      this.nameText.visible = true
      if (this.inlineNameText) this.inlineNameText.visible = false
    } else {
      if (this.inlineNameText) {
        this.inlineNameText.text = name
        this.inlineNameText.visible = true
      }
      this.nameBox.visible = false
      this.nameText.visible = false
    }
  }

  private drawBackground(): void {
    this.bg.clear()
    this.bg.roundRect(this.boxX, this.boxY, this.boxW, this.boxH, 8)
    this.bg.fill({ color: this.bgColor, alpha: 0.92 })
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
    this.nameBox.fill({ color: this.bgColor, alpha: 0.92 })
    this.nameBox.roundRect(nameBoxX, nameBoxY, nameBoxW, nameBoxH, 6)
    this.nameBox.stroke({ color: 0xf1faee, width: 2, alpha: 1 })

    this.nameText.x = nameBoxX + this.padding
    this.nameText.y = nameBoxY + (nameBoxH - this.fontSize + 2) / 2
  }

  private makeDialogTextStyle(): TextStyle {
    return new TextStyle({
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      fill: 0xffffff,
      lineHeight: this.lineHeight(),
      dropShadow: this.borderless ? BORDERLESS_DROP_SHADOW : false,
    })
  }

  private lineHeight(): number {
    return this.fontSize * 1.6
  }

  private rubyFontSize(): number {
    return Math.max(12, Math.round(this.fontSize * 0.5))
  }

  // ---------------------------------------------------------------------------
  // private: portrait
  // ---------------------------------------------------------------------------

  private applyPortraitLayout(): void {
    const hasPortrait = !!this.currentPortrait
    if (this.portraitFrame) {
      this.portraitFrame.visible = hasPortrait && this.showing
    }
    const tx = this.textStartX()
    this.dialogText.x = tx
    this.rubyContainer.x = tx
  }

  private hidePortrait(): void {
    if (this.portraitFrame) this.portraitFrame.visible = false
    if (this.portraitSprite) this.portraitSprite.visible = false
  }

  private beginPortraitLoad(path: string, keepSpriteVisible: boolean): void {
    this.currentPortraitToken += 1
    const token = this.currentPortraitToken
    if (!keepSpriteVisible && this.portraitSprite) {
      this.portraitSprite.visible = false
    }

    void loadPortraitTexture(path).then(
      (texture) => {
        if (token !== this.currentPortraitToken) return
        if (!this.portraitFrame) return

        const portraitY = this.boxY + PORTRAIT_Y_OFFSET
        const fit = computePortraitContainFit(
          texture.width,
          texture.height,
          PORTRAIT_X,
          portraitY,
          PORTRAIT_SIZE
        )

        if (!this.portraitSprite) {
          const sprite = new Sprite(texture)
          sprite.x = fit.x
          sprite.y = fit.y
          sprite.width = fit.width
          sprite.height = fit.height
          this.portraitSprite = sprite
          this.addChild(sprite)
        } else {
          this.portraitSprite.texture = texture
          this.portraitSprite.x = fit.x
          this.portraitSprite.y = fit.y
          this.portraitSprite.width = fit.width
          this.portraitSprite.height = fit.height
        }
        this.portraitSprite.visible = this.showing && !!this.currentPortrait
      },
      () => {
        if (token !== this.currentPortraitToken) return
        if (this.portraitSprite) this.portraitSprite.visible = false
      }
    )
  }

  // ---------------------------------------------------------------------------
  // private: ruby
  // ---------------------------------------------------------------------------

  private rebuildRubyEntries(lines: string[], font: string): void {
    for (const e of this.rubyEntries) {
      this.rubyContainer.removeChild(e.text)
      e.text.destroy()
    }
    this.rubyEntries = []

    if (this.rubyPlacements.length === 0) return

    const ctx = getMeasureContext()
    if (ctx) ctx.font = font
    const measure = (s: string): number =>
      ctx ? ctx.measureText(s).width : s.length * this.fontSize

    const lineHeight = this.lineHeight()
    const rubyFontSize = this.rubyFontSize()
    const rubyStyle = new TextStyle({
      fontFamily: this.fontFamily,
      fontSize: rubyFontSize,
      fill: 0xffffff,
      dropShadow: this.borderless ? BORDERLESS_DROP_SHADOW : false,
    })

    for (const p of this.rubyPlacements) {
      const line = lines[p.lineIndex] ?? ''
      const before = line.substring(0, p.charStartInLine)
      const baseStr = line.substring(p.charStartInLine, p.charEndInLine)
      const xStart = measure(before)
      const baseWidth = measure(baseStr)
      const rubyWidth = measure(p.ruby)
      const xRubyCenter = xStart + baseWidth / 2
      const xRuby = xRubyCenter - rubyWidth / 2
      const yLineTop = p.lineIndex * lineHeight
      const yRuby = yLineTop - rubyFontSize + 2

      const t = new Text({ text: p.ruby, style: rubyStyle })
      t.x = xRuby
      t.y = yRuby
      t.visible = false
      this.rubyContainer.addChild(t)
      this.rubyEntries.push({ placement: p, text: t })
    }
  }

  private updateRubyVisibility(displayedCharCount: number): void {
    for (const e of this.rubyEntries) {
      e.text.visible = displayedCharCount >= e.placement.revealAt
    }
  }

  private revealAllRuby(): void {
    for (const e of this.rubyEntries) {
      e.text.visible = true
    }
  }

  private clearRubyEntries(): void {
    for (const e of this.rubyEntries) {
      this.rubyContainer.removeChild(e.text)
      e.text.destroy()
    }
    this.rubyEntries = []
    this.rubyPlacements = []
  }
}
