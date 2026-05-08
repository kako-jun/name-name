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
import { parseRubyText, stripRubyMarkup } from './ruby'
import { type RubyPlacement, computeRubyPlacements } from './rubyLayout'
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

/**
 * ルビの x 位置計算用の Canvas measure コンテキスト (#148)。
 * wordwrap.ts と独立にキャッシュを持つ（フォントが異なる用途で衝突しないように）。
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

export class DialogBox extends Container {
  private bg: Graphics
  private nameBox: Graphics
  private nameText: Text
  private dialogText: Text
  /** ルビ描画用の Container。dialogText の上に重ねる (#148)。 */
  private rubyContainer: Container
  /** 各 placement に対応する Text と reveal 状態 */
  private rubyEntries: Array<{ placement: RubyPlacement; text: Text }> = []
  /** 直近 setDialog で算出した ruby placements（typewriter 進行と突き合わせる） */
  private rubyPlacements: RubyPlacement[] = []
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
  /** setDialog で受け取った最新のテキストを保持しておき、setFontFamily で
   *  wordwrap を再計算するために使う (#147 R1 S2)。 */
  private currentText: string = ''
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

    // --- ルビ用 Container (#148) ---
    // dialogText と同じ原点に重ねる。Text は表示タイミングに応じて add/remove する。
    this.rubyContainer = new Container()
    this.rubyContainer.x = this.dialogText.x
    this.rubyContainer.y = this.dialogText.y
    this.addChild(this.rubyContainer)

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
          // base が typewriter で表示完了したルビを reveal する (#148)
          this.updateRubyVisibility(next.displayedCharCount)
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
      lineHeight: this.lineHeight(),
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
    this.currentText = text
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

    // テキスト（ルビ記号を除いた plain にワードラップ適用）+ typewriter 開始 (#148)
    const font = `${this.fontSize}px ${this.fontFamily}`
    const maxTextWidth = this.boxW - this.padding * 2
    const runs = parseRubyText(text)
    const plainText = stripRubyMarkup(text)
    const lines = wordwrap(plainText, maxTextWidth, font)
    this.typewriter = startTypewriter(lines.join('\n'))
    this.dialogText.text = ''
    // ルビ配置を再構築（typewriter と同期して順次表示する）
    this.rubyPlacements = computeRubyPlacements(runs, lines)
    this.rebuildRubyEntries(lines, font)
    // タイピング完了コールバックをセット（空テキストはタイプライターが動かないので即呼び出し）
    this.onTypingDone = onTypingDone ?? null
    if (!isTypingActive(this.typewriter) && this.onTypingDone) {
      const cb = this.onTypingDone
      this.onTypingDone = null
      cb()
    }
  }

  /**
   * ルビ用 Text 群を捨てて placements から再構築する (#148)。
   * 表示は最初すべて invisible。typewriter 進行に応じて updateRubyVisibility で順次出す。
   */
  private rebuildRubyEntries(lines: string[], font: string): void {
    // 既存 Text を破棄
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
      // borderless と同じ DropShadow を付ければ読みやすいが、最小実装では fill のみ
      dropShadow: this.borderless ? BORDERLESS_DROP_SHADOW : false,
    })

    for (const p of this.rubyPlacements) {
      const line = lines[p.lineIndex] ?? ''
      const before = line.substring(0, p.charStartInLine)
      const baseStr = line.substring(p.charStartInLine, p.charEndInLine)
      const xStart = measure(before)
      const baseWidth = measure(baseStr)

      // ルビが base より広い場合は base 中心に配置（はみ出しは許容）
      const rubyWidth = measure(p.ruby)
      const xRubyCenter = xStart + baseWidth / 2
      const xRuby = xRubyCenter - rubyWidth / 2

      // y: 行の上端より少し上にルビを置く（ベースライン上にかぶせる）
      const yLineTop = p.lineIndex * lineHeight
      const yRuby = yLineTop - rubyFontSize + 2 // 少し下げて base に近づける

      const t = new Text({ text: p.ruby, style: rubyStyle })
      t.x = xRuby
      t.y = yRuby
      t.visible = false
      this.rubyContainer.addChild(t)
      this.rubyEntries.push({ placement: p, text: t })
    }
  }

  /**
   * typewriter の displayedCharCount に応じてルビの可視性を更新する (#148)。
   * base 末尾が表示済みなら ruby を visible にする。
   */
  private updateRubyVisibility(displayedCharCount: number): void {
    for (const e of this.rubyEntries) {
      e.text.visible = displayedCharCount >= e.placement.revealAt
    }
  }

  /** すべてのルビを表示状態にする（skip 用）。 */
  private revealAllRuby(): void {
    for (const e of this.rubyEntries) {
      e.text.visible = true
    }
  }

  /** ルビ Text をすべて破棄する（clearText 用）。 */
  private clearRubyEntries(): void {
    for (const e of this.rubyEntries) {
      this.rubyContainer.removeChild(e.text)
      e.text.destroy()
    }
    this.rubyEntries = []
    this.rubyPlacements = []
  }

  /**
   * テキストのみクリアする。
   * 後続の setFontFamily で消したテキストが復活しないよう currentText もリセットする (#147 R2 M-R2-1)。
   * onTypingDone も解除して、新フォントで再生成された typewriter が完了した際に
   * 古いコールバックが auto-advance を発火しないようにする。
   */
  clearText(): void {
    this.typewriter = makeInitialTypewriterState()
    this.dialogText.text = ''
    this.currentText = ''
    this.onTypingDone = null
    this.clearRubyEntries()
  }

  /**
   * typewriter 表示中なら全文を即時表示し完了させる。
   * 表示完了済みなら何もしない。
   */
  skipTypewriter(): void {
    if (!isTypingActive(this.typewriter)) return
    this.typewriter = typewriterSkip(this.typewriter)
    this.dialogText.text = visibleText(this.typewriter)
    // スキップ時もルビは全表示にする (#148)
    this.revealAllRuby()
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
    // ルビ Text も同じ DropShadow ポリシーで揃える (#148)
    const rubyFontSize = this.rubyFontSize()
    for (const e of this.rubyEntries) {
      e.text.style = new TextStyle({
        fontFamily: this.fontFamily,
        fontSize: rubyFontSize,
        fill: 0xffffff,
        dropShadow: this.borderless ? BORDERLESS_DROP_SHADOW : false,
      })
    }
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
    // フォントが変わると 1 文字あたりの幅が変わるため wordwrap を再計算する (#147 R1 S2)。
    // 表示中のテキストがあれば再 wordwrap して typewriter を新規開始する。
    // typewriter 進行中だった場合は新フォントでの再生成になるが、フォント切替自体が
    // 稀な操作なので「タイプ位置リセット」は許容する。
    // 注: `onTypingDone` には触らない (#147 R3 M-R3-1)。`render()` の呼び出し順は
    //   1) ensureFontLoaded(...).then(setFontFamily) を登録（必ず microtask で実行）
    //   2) setDialog(name, text, onTypingDone) で auto-advance コールバックを登録
    //   3) microtask 起動 → ここに来る
    // この時点で `onTypingDone` は「今表示中の Dialog の auto-advance」なので
    // null に倒すと autoMode + per-line フォント切替時に自動進行が止まる。
    // 古い typewriter は this.typewriter の差し替えで破棄され、ticker は新 typewriter
    // のみを観測するため二重発火は元から起きない。
    if (this.currentText) {
      const font = `${this.fontSize}px ${this.fontFamily}`
      const maxTextWidth = this.boxW - this.padding * 2
      const runs = parseRubyText(this.currentText)
      const plainText = stripRubyMarkup(this.currentText)
      const lines = wordwrap(plainText, maxTextWidth, font)
      const fullText = lines.join('\n')
      this.typewriter = startTypewriter(fullText)
      // ルビ配置も新フォントで再構築 (#148)
      this.rubyPlacements = computeRubyPlacements(runs, lines)
      this.rebuildRubyEntries(lines, font)
      if (!isTypingActive(this.typewriter)) {
        // 既に最後まで表示し終わっていた場合は即時完了させて表示崩れを防ぐ
        this.dialogText.text = fullText
        this.revealAllRuby()
      } else {
        // 進行中で再開する場合は旧フォントの bake 済みグリフを一旦消して
        // 新フォントの先頭から typewriter が始まるように見せる (#147 R2 S-R2-2)
        this.dialogText.text = ''
        // ルビは進行 0 状態にリセット
        this.updateRubyVisibility(0)
      }
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
   * 行高さ。dialogText style と ruby placement の両方で使うため private メソッドに集約 (#148 R1 S4)。
   */
  private lineHeight(): number {
    return this.fontSize * 1.6
  }

  /**
   * ルビフォントサイズ: base の半分、ただし可読性のため最低 12px (#148 R1 S4)。
   */
  private rubyFontSize(): number {
    return Math.max(12, Math.round(this.fontSize * 0.5))
  }

  /**
   * リソース解放。
   * ルビ overlay の Text 群も明示 destroy する (#148 R1 S3)。
   * 通常は NovelRenderer.destroy 経由で stage 全体が破棄されるが、DialogBox 単体を
   * 入れ替える将来パスでもリソースが孤立しないようにしておく。
   */
  dispose(): void {
    this.clearRubyEntries()
    this.ticker.stop()
    this.ticker.destroy()
  }
}
