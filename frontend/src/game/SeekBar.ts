/**
 * シークバー UI
 *
 * ダイアログボックスの下に薄いプログレスバーを表示し、
 * クリックで任意のスナップショット位置にジャンプできる。
 * 動画プレイヤー的な見た目のスクラブバー。
 */

import { Container, Graphics } from 'pixi.js'

const GAME_WIDTH = 800
const GAME_HEIGHT = 600

/** バー全体の高さ（px） */
const BAR_HEIGHT = 6
/** バー左右マージン */
const BAR_MARGIN_X = 20
/** バーの Y 位置（画面最下端からのオフセット） */
const BAR_Y = GAME_HEIGHT - 12

/** バー背景色（暗いグレー） */
const BAR_BG_COLOR = 0x333333
/** バー進捗色（水色系、DialogBox のインジケーター色に合わせる） */
const BAR_FILL_COLOR = 0xa8dadc
/** バーの丸み */
const BAR_RADIUS = 3
/** つまみの半径 */
const THUMB_RADIUS = 7

export class SeekBar extends Container {
  private barBg: Graphics
  private barFill: Graphics
  private thumb: Graphics
  private hitArea_: Graphics

  private barWidth: number
  private barX: number

  private _total = 0
  private _current = 0

  /** クリックで呼ばれるコールバック (historyIndex: number) => void */
  private onSeek: ((historyIndex: number) => void) | null = null

  constructor() {
    super()

    this.barX = BAR_MARGIN_X
    this.barWidth = GAME_WIDTH - BAR_MARGIN_X * 2

    // 透明ヒットエリア（クリック検出を広めに取る）
    this.hitArea_ = new Graphics()
    this.hitArea_.rect(this.barX, BAR_Y - 8, this.barWidth, BAR_HEIGHT + 16)
    this.hitArea_.fill({ color: 0x000000, alpha: 0 })
    this.hitArea_.eventMode = 'static'
    this.hitArea_.cursor = 'pointer'
    this.hitArea_.on('pointerdown', this.handleClick)
    this.addChild(this.hitArea_)

    // 背景バー
    this.barBg = new Graphics()
    this.drawBar(this.barBg, BAR_BG_COLOR, this.barWidth, 0.6)
    this.addChild(this.barBg)

    // 進捗バー
    this.barFill = new Graphics()
    this.addChild(this.barFill)

    // つまみ
    this.thumb = new Graphics()
    this.thumb.circle(0, 0, THUMB_RADIUS)
    this.thumb.fill({ color: BAR_FILL_COLOR, alpha: 0.9 })
    this.thumb.y = BAR_Y + BAR_HEIGHT / 2
    this.addChild(this.thumb)

    this.updateVisual()
  }

  /**
   * シークコールバックを設定する
   */
  setOnSeek(callback: (historyIndex: number) => void): void {
    this.onSeek = callback
  }

  /**
   * 現在位置と合計を更新する
   */
  update(current: number, total: number): void {
    this._current = current
    this._total = total
    this.updateVisual()
  }

  private drawBar(g: Graphics, color: number, width: number, alpha: number): void {
    g.clear()
    g.roundRect(this.barX, BAR_Y, width, BAR_HEIGHT, BAR_RADIUS)
    g.fill({ color, alpha })
  }

  private updateVisual(): void {
    const ratio = this._total > 0 ? Math.max(0, Math.min(1, this._current / this._total)) : 0
    const fillWidth = Math.max(BAR_RADIUS * 2, this.barWidth * ratio)

    this.barFill.clear()
    this.barFill.roundRect(this.barX, BAR_Y, fillWidth, BAR_HEIGHT, BAR_RADIUS)
    this.barFill.fill({ color: BAR_FILL_COLOR, alpha: 0.8 })

    // つまみ位置
    this.thumb.x = this.barX + this.barWidth * ratio
    this.thumb.visible = this._total > 0
  }

  private handleClick = (e: { globalX?: number; global?: { x: number } }): void => {
    if (this._total <= 0) return

    const globalX = e.globalX ?? e.global?.x ?? 0
    const localX = globalX - this.barX
    const ratio = Math.max(0, Math.min(1, localX / this.barWidth))
    const index = Math.round(ratio * (this._total - 1))

    this.onSeek?.(index)
  }
}
