/**
 * クイックセーブ/ロード通知 toast オーバーレイ (#630)。
 *
 * name-name の恒久ルール（docs/operations/doctrine/name-name/guidelines/README.md 規律8）に従い、
 * 旧 DOM 版 `NovelPlayer.tsx` の `role="status" aria-live="polite"` トースト表示を PixiJS 化する。
 * 表示時間管理（2秒後に自動的に消える、再表示で既存タイマーをクリアして再スタート）は
 * `NovelRenderer.showToast()` が `this.time`（TimeController）経由で行う——このクラス自身は
 * 「メッセージを描画する/消す」だけの薄いラッパー（`TitleScreenOverlay`/`EndingOverlay` と同型）。
 *
 * アクセシビリティは DOM 実装からの後退: `role="status" aria-live="polite"` は再現しない
 * （PixiJS canvas はスクリーンリーダーに読み上げ内容を渡せない）。`TitleScreenOverlay` の
 * JSDoc に既出の「PixiJS 移行に伴う既知の後退」と同種の制約であり、この移行で新たに生まれた
 * ものではない。
 */
import { Container, Graphics, Text as PixiText, TextStyle } from 'pixi.js'

/** 旧 DOM 版 `text-sm`（0.875rem）相当。 */
const TOAST_FONT_SIZE = 14
/** 旧 DOM 版 `px-4`（1rem）相当。 */
const TOAST_PADDING_X = 16
/** 旧 DOM 版 `py-2`（0.5rem）相当。 */
const TOAST_PADDING_Y = 8
/** 旧 DOM 版 `bottom-10`（2.5rem）相当。画面下端からの余白。 */
const TOAST_BOTTOM_OFFSET = 40
/** 旧 DOM 版 `bg-black/70` 相当。 */
const TOAST_BG_COLOR = 0x000000
const TOAST_BG_ALPHA = 0.7
const TOAST_TEXT_COLOR = 0xffffff

export class ToastOverlay extends Container {
  private renderResolution = 1
  private text: PixiText
  private bg: Graphics

  constructor(
    private screenWidth: number,
    private screenHeight: number
  ) {
    super()
    // 旧 DOM 版 `pointer-events-none` 相当（タップしても何も起きない）。
    this.eventMode = 'none'
    this.visible = false

    this.bg = new Graphics()
    this.addChild(this.bg)

    this.text = new PixiText({
      text: '',
      style: new TextStyle({
        fontFamily: "'Noto Sans JP', sans-serif",
        fontSize: TOAST_FONT_SIZE,
        // 旧 DOM 版 `font-medium`（500）相当。PixiJS TextStyle はこのコードベースの慣習上
        // 'normal'/'bold' の2値運用（DialogBox 等参照）のため、近い 'bold' で代替する。
        fontWeight: 'bold',
        fill: TOAST_TEXT_COLOR,
      }),
      resolution: this.renderResolution,
      roundPixels: true,
    })
    this.text.anchor.set(0.5, 0.5)
    this.addChild(this.text)
  }

  /** ChoiceOverlay.setRenderResolution 等と同じ狙い（DPR 描画時の文字の鮮明さ）。 */
  setRenderResolution(resolution: number): void {
    if (!(resolution > 0) || !Number.isFinite(resolution)) return
    this.renderResolution = resolution
    this.text.resolution = resolution
  }

  /** メッセージを表示する。背景（角丸半透明黒）はテキスト幅に応じて毎回引き直す。 */
  show(message: string): void {
    this.text.text = message
    const { width: textWidth, height: textHeight } = this.measureTextSize()
    const width = textWidth + TOAST_PADDING_X * 2
    const height = textHeight + TOAST_PADDING_Y * 2
    // 旧 DOM 版 `rounded-full` 相当（高さの半分を半径にして完全な丸みにする）。
    const radius = height / 2

    this.bg.clear()
    this.bg.roundRect(-width / 2, -height / 2, width, height, radius)
    this.bg.fill({ color: TOAST_BG_COLOR, alpha: TOAST_BG_ALPHA })

    this.x = this.screenWidth / 2
    this.y = this.screenHeight - TOAST_BOTTOM_OFFSET - height / 2

    this.visible = true
  }

  /**
   * `.width`/`.height` は canvas 2D context が使えない環境（jsdom のユニットテスト等）で例外を
   * 投げることがある（`CharacterLayer.measureGlyphWidth` と同じ既知の防御パターン）。
   * 計測できない場合は文字数×フォントサイズからの概算にフォールバックする。
   */
  private measureTextSize(): { width: number; height: number } {
    try {
      return { width: this.text.width, height: this.text.height }
    } catch {
      const approxCharWidth = TOAST_FONT_SIZE * 0.95
      return {
        width: this.text.text.length * approxCharWidth,
        height: TOAST_FONT_SIZE * 1.4,
      }
    }
  }

  hide(): void {
    this.visible = false
  }
}
