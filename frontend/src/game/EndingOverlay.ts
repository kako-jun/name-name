/**
 * 終劇オーバーレイ (#630)。
 *
 * name-name の恒久ルール（docs/operations/doctrine/name-name/guidelines/README.md 規律8）に従い、
 * 旧 DOM 版 `NovelPlayer.tsx` の "to be continued..." 表示を PixiJS 化する
 * （`TitleScreenOverlay`/#628 フェーズ2b と同じ移行パターン）。
 *
 * ロゴ画像 (`${assetBaseUrl}/images/title.png`) 自体は自前で持たない。`NovelRenderer` が
 * `showTitleScreen()` と同じ流儀で `CharacterLayer.showImage()` に委譲する（このクラスは
 * "to be continued..." テキストの描画/表示切替だけを担う、薄いラッパー）。
 *
 * `storyEnded && !hasIntermissionScene()` の判定・intermission.md 専用シーンとの排他は
 * `NovelRenderer` 側（`syncEndingOverlayVisibility()`）が内部化して行う。このクラス自身は
 * 判定ロジックを持たない。
 */
import { Container, Text as PixiText, TextStyle } from 'pixi.js'

/** 旧 DOM 版 `text-3xl`（1.875rem）相当。 */
const ENDING_TEXT_FONT_SIZE = 30
/** 旧 DOM 版 `px-8`（2rem）相当。折り返し幅の左右余白。 */
const ENDING_TEXT_PADDING_X = 32
/** 旧 DOM 版 `text-white/80` 相当。 */
const ENDING_TEXT_ALPHA = 0.8

export class EndingOverlay extends Container {
  private renderResolution = 1
  private text: PixiText

  constructor(screenWidth: number, screenHeight: number) {
    super()
    // 旧 DOM 版 `pointer-events-none` 相当（タップしても何も起きない。見た目のヒットテストにも
    // 参加させない）。
    this.eventMode = 'none'
    this.visible = false

    this.text = new PixiText({
      text: 'to be continued...',
      style: new TextStyle({
        fontFamily: "'Noto Sans JP', sans-serif",
        fontSize: ENDING_TEXT_FONT_SIZE,
        fontStyle: 'italic',
        fill: 0xffffff,
        align: 'center',
        wordWrap: true,
        wordWrapWidth: Math.max(1, screenWidth - ENDING_TEXT_PADDING_X * 2),
      }),
      resolution: this.renderResolution,
      roundPixels: true,
    })
    this.text.alpha = ENDING_TEXT_ALPHA
    this.text.anchor.set(0.5, 0.5)
    this.text.x = screenWidth / 2
    this.text.y = screenHeight / 2
    this.addChild(this.text)
  }

  /**
   * Pixi Text は既定 resolution=1 で canvas 化されるため、DPR 描画時に文字が低解像度に見える。
   * ChoiceOverlay.setRenderResolution / TitleScreenOverlay.setRenderResolution と同じ狙い。
   */
  setRenderResolution(resolution: number): void {
    if (!(resolution > 0) || !Number.isFinite(resolution)) return
    this.renderResolution = resolution
    this.text.resolution = resolution
  }

  /** per-game フォント設定を反映する（`NovelRenderer.setFontFamily` 由来。旧 DOM 版 `fontFamily` prop 相当）。 */
  setFontFamily(fontFamily: string): void {
    this.text.style.fontFamily = fontFamily
  }

  show(): void {
    this.visible = true
  }

  hide(): void {
    this.visible = false
  }
}
