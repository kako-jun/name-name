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
 * novel スタイル (#283) のテキスト領域マージン（px、論理座標）。
 * 全画面ノベル（ToHeart 式）では画面の大半をテキストに使う。本文は左上付近から始め、
 * 左右・上下に小さな余白を残す。テストが参照できるよう export する。
 */
export const NOVEL_TEXT_MARGIN_X = 60
/** 本文域の上端 Y（画面高に対する比率）。本文は画面上部（左上付近）から始める。 */
export const NOVEL_TEXT_TOP_RATIO = 0.08
/** 本文域の下端マージン（px）。 */
export const NOVEL_TEXT_MARGIN_BOTTOM = 50

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

  // --- 画面寸法（novel モードの全画面テキスト領域算出に使う #283） ---
  private screenWidth: number
  private screenHeight: number
  /**
   * novel スタイル (#283)。true のとき:
   *  - borderless 相当（枠・背景・名札なし、白文字 + DropShadow）
   *  - テキスト領域を画面の大半に拡張（boxH=180 固定を解除）
   * adv スタイルは false（従来の下部 ADV 箱）。NovelRenderer が改頁と組み合わせて使う。
   */
  private novelMode = false
  /** adv モードの ADV 箱高さ（novel → adv 復帰時に boxH を戻すため保持 #283） */
  private advBoxHeight: number

  // --- 状態 ---
  private currentText: string = ''
  private showing = false
  /**
   * `show()` を最後に呼んだ時刻 (performance.now())。0 = 一度も show されていない（差分が
   * 常に巨大になるためガード判定は偽になる）。
   * `isJustShown(guardMs)` 経由で「メニュー → tryTalk → dialog.show 直後に到達した tap で
   * dialog がすぐ閉じる事故」のガード判定に使う。`hide()` でリセットしない（次の `show()`
   * で上書きされるため）。
   */
  private lastShownAtMs = 0

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
      fontSize = 40,
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
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.boxW = screenWidth - marginX * 2
    this.boxH = boxHeight
    this.advBoxHeight = boxHeight
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
    this.lastShownAtMs = performance.now()
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
   * 直前の `show()` から `guardMs` ミリ秒以内なら true を返す。
   * 「タップによってダイアログを開いた瞬間の同一ジェスチャに含まれる二重発火 tap で
   * dialog がすぐ閉じる事故」を防ぐためのガード判定。
   */
  isJustShown(guardMs: number): boolean {
    return this.showing && performance.now() - this.lastShownAtMs < guardMs
  }

  /**
   * novel スタイル (#283) の全画面テキスト領域へ幾何を再計算する。
   * 画面の下 60%（`NOVEL_TEXT_TOP_RATIO` 以下）をテキスト域にし、左右・下に小さな余白を残す。
   * 改頁はこの領域に収まる行数 (`novelMaxLinesPerPage`) で行う。
   */
  private applyNovelGeometry(): void {
    const topY = Math.round(this.screenHeight * NOVEL_TEXT_TOP_RATIO)
    this.boxX = NOVEL_TEXT_MARGIN_X
    this.boxW = this.screenWidth - NOVEL_TEXT_MARGIN_X * 2
    this.boxY = topY
    this.boxH = this.screenHeight - topY - NOVEL_TEXT_MARGIN_BOTTOM

    // テキスト位置更新（borderless 前提なので背景・名札は描かない）。
    this.dialogText.x = this.textStartX()
    this.dialogText.y = this.textStartY()
    this.rubyContainer.x = this.dialogText.x
    this.rubyContainer.y = this.dialogText.y
    this.indicator.x = this.boxX + this.boxW - 40
    this.indicatorBaseY = this.boxY + this.boxH - 30
    this.indicator.y = this.indicatorBaseY
  }

  /**
   * 画面リサイズ時にレイアウトを再計算する。
   */
  redraw(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    if (this.novelMode) {
      // novel モードは全画面テキスト領域なので redraw でも novel geometry を維持する。
      this.applyNovelGeometry()
      return
    }
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
    // テキストが空 (空文字 / 空白だけ / 全角空白だけ) なら DialogBox は隠す。
    // 立ち絵を登場させるためだけの空ダイアログで ▼ インジケーターや透明枠が残るのを避ける。
    const trimmedText = text.replace(/\s/g, '').replace(/\u3000/g, '')
    if (trimmedText === '') {
      this.hide()
      this.onTypingDone = null
      // 呼び出し側 (NovelRenderer) は onTypingDone でオートモードを進めるので、
      // 即時 done を通知する
      if (onTypingDone) onTypingDone()
      return
    }
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
        // msPerChar=0 の場合も update() が skipTypewriter() を呼ぶため、ここでの特別処理は不要。
        // setFontFamily 側は typewriter をリセットするため .then 内での即時スキップが必要（設計上の非対称点）。
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

  /** 現在のタイプライター速度（ms/文字）。playScript の保存/復元用 (#220)。 */
  getMsPerChar(): number {
    return this.msPerChar
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

  /**
   * novel スタイル (#283) の ON/OFF を切り替える。
   *
   * ON のとき:
   *  - borderless 相当（枠・背景・名札なし、白文字 + DropShadow）にする
   *  - テキスト領域を画面の大半に拡張する（`boxH=180` 固定を解除し全画面ノベル化）
   * OFF（adv）は従来の下部 ADV 箱に戻す。
   *
   * 名札 OFF と DropShadow は `setBorderless(true)` のロジックを流用する（novel は実質 borderless 描画）。
   * 改頁・スクリムは NovelRenderer 側が制御する。本メソッドは DialogBox の幾何と外観だけを担う。
   */
  setNovelMode(novel: boolean): void {
    // 早期 return しない（冪等に再適用する）。NovelRenderer は setEvents 内で
    // `setBorderless(defaultDialogBorderless)` を呼んだ直後に setNovelMode を呼び直すため、
    // 「novelMode は変わっていないが borderless が剥がされた」状態でも novel 描画を復元する必要がある。
    this.novelMode = novel
    // novel は枠なし白文字（名札 OFF）。setBorderless の既存ロジックを流用する。
    // setBorderless は同値ガードで no-op になり得るので、borderless が既に望む値でも
    // 確実に geometry を再適用するため下の applyNovelGeometry / redraw を必ず通す。
    this.setBorderless(novel)
    if (novel) {
      this.applyNovelGeometry()
    } else {
      // adv に戻す: 下部 ADV 箱の幾何へ復帰する。
      this.boxH = this.advBoxHeight
      this.redraw(this.screenWidth, this.screenHeight)
    }
  }

  /** novel スタイルか (#283)。NovelRenderer が改頁・スクリムの分岐に使う。 */
  get isNovelMode(): boolean {
    return this.novelMode
  }

  /**
   * 本文を 1 行ずつ wordwrap し、各文の占有行数を測るためのメトリクスを提供する (#283)。
   * novel 改頁（`paginateSentencesByLines`）の入力に使う。
   * 純粋関数の wordwrap を現在のフォント設定で呼ぶだけのアダプタ。
   */
  measureLineCount(plainText: string): number {
    const font = `${this.fontSize}px ${this.fontFamily}`
    return wordwrap(plainText, this.maxTextWidth(), font).length
  }

  /**
   * novel モードで 1 ページに収まる最大行数 (#283)。
   * 利用可能テキスト高さ ÷ 行高（端数切り捨て・最低 1）。
   */
  novelMaxLinesPerPage(): number {
    const usable = this.boxH - this.padding * 2
    return Math.max(1, Math.floor(usable / this.lineHeight()))
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
          if (this.msPerChar === 0) {
            this.skipTypewriter()
            this.dialogText.text = fullText
            this.revealAllRuby()
          } else if (!isTypingActive(this.typewriter)) {
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
