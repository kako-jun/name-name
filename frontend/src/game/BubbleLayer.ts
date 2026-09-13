import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import {
  computeBubbleLayout,
  computeBubbleFrameSize,
  getBubblePresentation,
  type BubblePresentation,
  type BubbleStyle,
} from './bubblePresentation'
import type { CameraElevation, CameraMode, CameraOrientation } from '../types'
import { ensureFontLoaded } from './FontLoader'
import { parseRubyText, stripRubyMarkup } from './ruby'
import { computeRubyPlacements, type RubyPlacement } from './rubyLayout'
import { wordwrap } from './wordwrap'

export type { BubbleStyle } from './bubblePresentation'

export interface BubbleLayerOptions {
  /**
   * Text の実測を差し替えるテスト用境界。実行時は Pixi の実測値を使う。
   * Canvas の有無で枠計算の契約を変えないため、例外を握り潰す代替ではない。
   */
  measureText?: (text: Text) => { width: number; height: number }
  /** Node 上でも吹き出し幅の折返し契約を検証するためのテスト境界。 */
  wordwrap?: (text: string, maxWidth: number, font: string) => string[]
}

/** 台詞の代替表示。Novel は平面、Theater は同じ宣言値をカメラ射影して表示する。 */
export class BubbleLayer extends Container {
  private readonly frame = new Graphics()
  private readonly textNode = new Text({ text: '', style: new TextStyle({}) })
  /** 本文と同じ plain text に重ねるルビ専用コンテナ。 */
  private readonly rubyContainer = new Container()
  private rubyEntries: Array<{
    placement: RubyPlacement
    text: Text
    revealCharacterCount: number
  }> = []
  private showToken = 0
  private options: {
    style: BubbleStyle
    xRatio: number
    depth: number
    mode: CameraMode
    orientation: CameraOrientation
    elevation: CameraElevation | null
    fontFamily: string
    fontSize: number
    text: string
    visibleCharacterCount: number
    fullText: string
  } | null = null

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number,
    private readonly optionsForTest: BubbleLayerOptions = {}
  ) {
    super()
    this.addChild(this.frame, this.textNode, this.rubyContainer)
    this.visible = false
  }

  show(options: {
    style: BubbleStyle
    text: string
    /** DialogBox が進めた本文文字数。折返しは BubbleLayer 自身が決める。 */
    visibleCharacterCount: number
    xRatio: number
    depth: number
    mode: CameraMode
    orientation: CameraOrientation
    elevation: CameraElevation | null
    /** per-line → game default → runtime default で解決済みの本文フォント。 */
    fontFamily: string
    /** frontmatter / runtime default で解決済みの本文サイズ。 */
    fontSize: number
  }): void {
    const token = ++this.showToken
    this.options = {
      style: options.style,
      xRatio: options.xRatio,
      depth: options.depth,
      mode: options.mode,
      orientation: options.orientation,
      elevation: options.elevation,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      text: options.text,
      visibleCharacterCount: options.visibleCharacterCount,
      fullText: '',
    }
    // DialogBox と同じ FontLoader を通す。未ロードのフォントの字形幅で吹き出し枠だけが
    // 固定されることを避け、古い非同期ロード結果は token で破棄する。
    void ensureFontLoaded(options.fontFamily)
      .catch(() => {
        // DialogBox と同じく、フォント取得失敗は既定フォールバックで継続する。
      })
      .then(() => {
        if (token !== this.showToken || !this.options) return
        this.renderTextAndRuby()
        this.visible = true
      })
  }

  /** DialogBox の typewriter が進めた本文文字数だけを反映する。独自の typing 状態は持たない。 */
  setVisibleCharacterCount(count: number): void {
    if (!this.options) return
    this.options.visibleCharacterCount = Math.max(0, count)
    if (this.visible) this.applyVisibleText()
  }

  /** テスト・アクセシビリティ用途。吹き出し幅で折り返した可視本文を返す。 */
  getVisibleText(): string {
    return this.textNode.text
  }

  /**
   * 本文・枠・ルビの幾何を一度だけ構築する。
   *
   * DialogBox と同様に枠は全文の寸法を使い、本文は左上基準で typewriter 表示する。これにより
   * 文字送り中に中央寄せの基準が動かず、ルビの base との相対位置と revealAt を安定させる。
   */
  private renderTextAndRuby(): void {
    const options = this.options
    if (!options) return
    const presentation = getBubblePresentation(options.style)
    const textStyle = new TextStyle({
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      fill: presentation.text,
      // wordwrap() が DialogBox と同じ禁則規則で明示改行を挿入する。Pixi の自動 wrap に
      // 任せると rubyLayout の行番号とずれるため、ここでは無効にする。
      wordWrap: false,
      align: 'left',
    })
    this.textNode.style = textStyle
    const plainText = stripRubyMarkup(options.text)
    // 本番ブラウザでは DialogBox と同じ Canvas wordwrap を使う。Node の Pixi 単体テストは
    // Canvas を持たないため、そこでだけ明示改行を保った一行配列へフォールバックする（描画時の
    // 実測・ルビ配置・reveal の契約は Pixi 実体で検証する）。
    const wrap =
      this.optionsForTest.wordwrap ??
      (typeof document === 'undefined' ? (text: string) => text.split('\n') : wordwrap)
    const fullLines = wrap(
      plainText,
      this.screenWidth * presentation.wordWrapRatio,
      `${options.fontSize}px ${options.fontFamily}`
    )
    const fullText = fullLines.join('\n')
    // DialogBox の幅で挿入された改行文字列は受け取らない。吹き出し自身の幅で構築した
    // canonical text から、typewriter の「本文文字数」だけを可視化する。
    options.fullText = fullText
    // 枠は全文を測る。テスト用の注入点も同じ full text を観測する。
    this.textNode.text = fullText
    const measured = this.optionsForTest.measureText
      ? this.optionsForTest.measureText(this.textNode)
      : { width: this.textNode.width, height: this.textNode.height }
    const frameSize = computeBubbleFrameSize(measured, presentation)
    this.textNode.anchor.set(0, 0)
    this.textNode.x = -measured.width / 2
    this.textNode.y = -measured.height / 2
    this.drawFrame(frameSize.width, frameSize.height, presentation)
    this.rebuildRubyEntries(fullLines, measured, presentation)
    const layout = computeBubbleLayout({
      ...options,
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
    })
    this.x = layout.x
    this.y = layout.y
    this.scale.set(layout.scale)
    this.applyVisibleText()
  }

  /** 吹き出し自身の折返し本文と同じ位置で、対応するルビだけを reveal する。 */
  private applyVisibleText(): void {
    if (!this.options) return
    this.textNode.text = visibleTextForCharacterCount(
      this.options.fullText,
      this.options.visibleCharacterCount
    )
    for (const entry of this.rubyEntries) {
      entry.text.visible = this.options.visibleCharacterCount >= entry.revealCharacterCount
    }
  }

  hide(): void {
    this.showToken += 1
    this.visible = false
  }

  private rebuildRubyEntries(
    lines: string[],
    measured: { width: number; height: number },
    presentation: BubblePresentation
  ): void {
    for (const entry of this.rubyEntries) {
      this.rubyContainer.removeChild(entry.text)
      entry.text.destroy()
    }
    this.rubyEntries = []
    const options = this.options
    if (!options) return

    const placements = computeRubyPlacements(parseRubyText(options.text), lines)
    if (placements.length === 0) return

    const bodyStyle = new TextStyle({
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      fill: presentation.text,
    })
    const rubyFontSize = Math.max(10, Math.round(options.fontSize * 0.48))
    const rubyStyle = new TextStyle({
      fontFamily: options.fontFamily,
      fontSize: rubyFontSize,
      fill: presentation.text,
    })
    const measureNode = (text: string, style: TextStyle): { width: number; height: number } => {
      const node = new Text({ text, style })
      return this.optionsForTest.measureText
        ? this.optionsForTest.measureText(node)
        : { width: node.width, height: node.height }
    }
    const measure = (text: string): number => measureNode(text, bodyStyle).width
    const lineHeight = measureNode('あ', bodyStyle).height

    for (const placement of placements) {
      const line = lines[placement.lineIndex] ?? ''
      const before = line.substring(0, placement.charStartInLine)
      const base = line.substring(placement.charStartInLine, placement.charEndInLine)
      const xLine = -measured.width / 2
      const xBase = xLine + measure(before)
      const baseWidth = measure(base)
      const ruby = new Text({ text: placement.ruby, style: rubyStyle })
      ruby.x = xBase + baseWidth / 2 - measureNode(placement.ruby, rubyStyle).width / 2
      ruby.y = -measured.height / 2 + placement.lineIndex * lineHeight - rubyFontSize + 2
      ruby.visible = false
      this.rubyContainer.addChild(ruby)
      // RubyPlacement.revealAt は wrapped text（改行を含む）上の offset。DialogBox から受ける
      // count は表示済み本文文字数なので、吹き出し側の canonical text で同じ単位へ変換する。
      this.rubyEntries.push({
        placement,
        text: ruby,
        revealCharacterCount: fullTextCharacterCount(lines.join('\n'), placement.revealAt),
      })
    }
  }

  private drawFrame(width: number, height: number, presentation: BubblePresentation): void {
    this.frame.clear()
    const x = -width / 2
    const y = -height / 2
    if (presentation.shape === 'zigzag') {
      this.frame.poly(makeZigzagRectPoints(x, y, width, height, 8))
    } else if (presentation.shape === 'cloud') {
      // 雲形は丸い突起を持つ輪郭。静か/内心を通常の台詞枠から区別する。
      this.frame.roundRect(x, y + 8, width, height - 16, 18)
      this.frame.circle(x + width * 0.2, y + 10, 15)
      this.frame.circle(x + width * 0.46, y + 3, 18)
      this.frame.circle(x + width * 0.72, y + 10, 15)
      this.frame.circle(x + width * 0.28, y + height - 8, 13)
      this.frame.circle(x + width * 0.65, y + height - 7, 14)
    } else {
      this.frame.roundRect(x, y, width, height, 18)
    }
    this.frame.fill({ color: presentation.fill, alpha: 0.96 })
    this.frame.stroke({
      color: presentation.stroke,
      width: presentation.strokeWidth,
      alpha: presentation.linePattern === 'dotted' ? 0.72 : 1,
    })
    if (presentation.linePattern !== 'solid') {
      this.drawLinePattern(x + 12, y + 12, width - 24, height - 24, presentation)
    }
  }

  private drawLinePattern(
    x: number,
    y: number,
    width: number,
    height: number,
    presentation: BubblePresentation
  ): void {
    const step = presentation.linePattern === 'dotted' ? 10 : 18
    const length = presentation.linePattern === 'dotted' ? 2 : 9
    const segments: Array<[number, number, number, number]> = []
    for (let offset = 0; offset < width; offset += step) {
      segments.push([x + offset, y, Math.min(x + offset + length, x + width), y])
      segments.push([x + offset, y + height, Math.min(x + offset + length, x + width), y + height])
    }
    for (let offset = 0; offset < height; offset += step) {
      segments.push([x, y + offset, x, Math.min(y + offset + length, y + height)])
      segments.push([x + width, y + offset, x + width, Math.min(y + offset + length, y + height)])
    }
    for (const [x1, y1, x2, y2] of segments) {
      this.frame.moveTo(x1, y1).lineTo(x2, y2)
    }
    this.frame.stroke({ color: presentation.stroke, width: presentation.strokeWidth + 0.5 })
  }
}

/**
 * 折返しで挿入した改行を typewriter の進捗に数えず、可視文字数から canonical wrapped text を作る。
 * 行末の文字が表示された瞬間に改行も出すため、次の文字送りを待たずに正しい行レイアウトになる。
 */
export function visibleTextForCharacterCount(fullText: string, characterCount: number): string {
  let visible = ''
  let seen = 0
  for (let index = 0; index < fullText.length; index += 1) {
    const char = fullText[index]
    if (char === '\n') {
      if (seen <= characterCount) visible += char
      continue
    }
    // DialogBox は text.substring(0, offset) で UTF-16 code unit ごとに表示する。
    // サロゲートペア途中の表示も既存の台詞レイヤーと完全に一致させる。
    if (seen >= characterCount) break
    visible += char
    seen += 1
  }
  return visible
}

/** wrapped text の offset を、改行を除いた本文文字数へ変換する。 */
function fullTextCharacterCount(fullText: string, offset: number): number {
  return fullText.slice(0, offset).replace(/\n/g, '').length
}

/**
 * 叫び吹き出しの枠点列。PixiJS への描画前に純粋値として検証できるよう公開する。
 */
export function makeZigzagRectPoints(
  x: number,
  y: number,
  width: number,
  height: number,
  tooth: number
): number[] {
  const points: number[] = []
  const pushEdge = (
    startX: number,
    startY: number,
    dx: number,
    dy: number,
    length: number
  ): void => {
    const count = Math.max(2, Math.ceil(length / tooth))
    for (let index = 0; index <= count; index += 1) {
      const progress = index / count
      const outward = index % 2 === 0 ? 0 : tooth * 0.45
      points.push(startX + dx * length * progress + -dy * outward)
      points.push(startY + dy * length * progress + dx * outward)
    }
  }
  pushEdge(x, y, 1, 0, width)
  pushEdge(x + width, y, 0, 1, height)
  pushEdge(x + width, y + height, -1, 0, width)
  pushEdge(x, y + height, 0, -1, height)
  return points
}
