/**
 * バックログUI
 *
 * 過去のダイアログ/ナレーションを全画面オーバーレイで表示する。
 * スクロールで遡って読める。
 */

import { Container, Graphics, Text as PixiText, TextStyle } from 'pixi.js'

const OVERLAY_ALPHA = 0.85
const TEXT_PADDING_X = 40
const TEXT_PADDING_TOP = 60
const TEXT_PADDING_BOTTOM = 40
const LINE_HEIGHT = 28
const NAME_COLOR = 0xa8dadc
const TEXT_COLOR = 0xf1faee
const NARRATION_COLOR = 0xcccccc
const TITLE_COLOR = 0xf1faee

export interface BacklogEntry {
  character: string | null
  text: string
}

export class BacklogOverlay extends Container {
  private screenWidth: number
  private screenHeight: number
  private entries: BacklogEntry[] = []
  private scrollOffset = 0
  private contentContainer: Container
  private maskGraphics: Graphics
  private totalContentHeight = 0

  constructor(screenWidth: number, screenHeight: number) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.eventMode = 'static'
    this.visible = false

    this.contentContainer = new Container()
    this.maskGraphics = new Graphics()
  }

  /**
   * バックログにエントリを追加する
   */
  addEntry(character: string | null, text: string): void {
    // 空行（改ページ）は記録しない
    if (text === '') return
    this.entries.push({ character, text })
  }

  /**
   * バックログを表示する
   */
  show(): void {
    this.rebuild()
    this.visible = true
  }

  /**
   * バックログを非表示にする
   */
  hide(): void {
    this.visible = false
    this.removeChildren()
  }

  /**
   * 表示/非表示をトグルする
   */
  toggle(): void {
    if (this.visible) {
      this.hide()
    } else {
      this.show()
    }
  }

  /**
   * マウスホイールでスクロールする
   */
  handleWheel(deltaY: number): void {
    if (!this.visible) return
    this.scrollOffset += deltaY * 0.5
    this.clampScroll()
    this.contentContainer.y = -this.scrollOffset + TEXT_PADDING_TOP
  }

  /**
   * キーボードでスクロールする
   */
  handleKeyScroll(direction: 'up' | 'down'): void {
    if (!this.visible) return
    const step = LINE_HEIGHT * 3
    this.scrollOffset += direction === 'down' ? step : -step
    this.clampScroll()
    this.contentContainer.y = -this.scrollOffset + TEXT_PADDING_TOP
  }

  private clampScroll(): void {
    const viewableHeight = this.screenHeight - TEXT_PADDING_TOP - TEXT_PADDING_BOTTOM
    const maxScroll = Math.max(0, this.totalContentHeight - viewableHeight)
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll))
  }

  private rebuild(): void {
    this.removeChildren()

    // 半透明黒背景
    const bg = new Graphics()
    bg.rect(0, 0, this.screenWidth, this.screenHeight)
    bg.fill({ color: 0x000000, alpha: OVERLAY_ALPHA })
    bg.eventMode = 'static'
    bg.on('pointerdown', (e) => e.stopPropagation())
    this.addChild(bg)

    // タイトル
    const titleStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 22,
      fill: TITLE_COLOR,
      fontWeight: 'bold',
    })
    const titleText = new PixiText({ text: 'BACKLOG', style: titleStyle })
    titleText.x = this.screenWidth / 2
    titleText.y = 16
    titleText.anchor.set(0.5, 0)
    this.addChild(titleText)

    // マスク（タイトル下からスクリーン下端まで）
    this.maskGraphics = new Graphics()
    this.maskGraphics.rect(
      0,
      TEXT_PADDING_TOP,
      this.screenWidth,
      this.screenHeight - TEXT_PADDING_TOP - TEXT_PADDING_BOTTOM
    )
    this.maskGraphics.fill(0xffffff)
    this.addChild(this.maskGraphics)

    // コンテンツコンテナ
    this.contentContainer = new Container()
    this.contentContainer.mask = this.maskGraphics
    this.addChild(this.contentContainer)

    const nameStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 16,
      fill: NAME_COLOR,
      fontWeight: 'bold',
    })
    const textStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 16,
      fill: TEXT_COLOR,
      wordWrap: true,
      wordWrapWidth: this.screenWidth - TEXT_PADDING_X * 2,
    })
    const narrationStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 16,
      fill: NARRATION_COLOR,
      fontStyle: 'italic',
      wordWrap: true,
      wordWrapWidth: this.screenWidth - TEXT_PADDING_X * 2,
    })

    let y = 0
    for (const entry of this.entries) {
      if (entry.character) {
        const nameText = new PixiText({ text: entry.character, style: nameStyle })
        nameText.x = TEXT_PADDING_X
        nameText.y = y
        this.contentContainer.addChild(nameText)
        y += 22
      }

      const style = entry.character ? textStyle : narrationStyle
      const lineText = new PixiText({ text: entry.text, style })
      lineText.x = TEXT_PADDING_X
      lineText.y = y
      this.contentContainer.addChild(lineText)
      y += lineText.height + 12
    }

    this.totalContentHeight = y

    // 最新エントリが見えるようにスクロール位置を初期化
    const viewableHeight = this.screenHeight - TEXT_PADDING_TOP - TEXT_PADDING_BOTTOM
    if (this.totalContentHeight > viewableHeight) {
      this.scrollOffset = this.totalContentHeight - viewableHeight
    } else {
      this.scrollOffset = 0
    }

    this.contentContainer.y = -this.scrollOffset + TEXT_PADDING_TOP

    // 「閉じる」ヒント
    const hintStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 14,
      fill: 0x888888,
    })
    const hintText = new PixiText({
      text: 'ESC / B / クリックで閉じる',
      style: hintStyle,
    })
    hintText.x = this.screenWidth / 2
    hintText.y = this.screenHeight - 24
    hintText.anchor.set(0.5, 0.5)
    this.addChild(hintText)
  }
}
