/**
 * シークバー UI（シナリオスライダ）
 *
 * ダイアログボックスの下に薄いプログレスバーを表示し、
 * クリックで任意のスナップショット位置にジャンプできる。
 * 動画プレイヤー的な見た目のスクラブバー。
 *
 * #350: つまみ中心を下部丸ボタンの中央を貫く高さへ上げ（`computeSeekBarGeometry`）、通常時も
 * 控えめに常時表示する。スライダ操作/ホバーで `active` に入り、つまみ拡大＋背面に影を敷いて
 * 前面感を出す。active は **GameState に持たない transient な演出/UI 状態**（ADR 0002）。
 * 一定時間無操作で inactive に戻す。動画書き出し中は `setExportSuppressed(true)` で抑制し、
 * 録画にスライダが焼き込まれないようにする。
 */

import { Container, FederatedPointerEvent, Graphics } from 'pixi.js'
import { TimeController, defaultTimeController } from './TimeController'
import { computeSeekBarGeometry } from './novelLayout'

/** バー全体の高さ（px） */
const BAR_HEIGHT = 6
/** バー左右マージン */
const BAR_MARGIN_X = 20

/** バー背景色（暗いグレー） */
const BAR_BG_COLOR = 0x333333
/** バー進捗色（水色系、DialogBox のインジケーター色に合わせる） */
const BAR_FILL_COLOR = 0xa8dadc
/** バーの丸み */
const BAR_RADIUS = 3
/** つまみの半径 */
const THUMB_RADIUS = 7

/** active 時のつまみ拡大率 (#350)。丸ボタン退避中にスライダを前面に感じさせる。 */
const ACTIVE_THUMB_SCALE = 1.6
/** 通常（inactive）時のコンテナ不透明度 (#350)。控えめに常時表示しつつボタンより背面に見せる。 */
const INACTIVE_ALPHA = 0.5
/** 操作（タップ/ドラッグ/ホバー）が止まってから inactive に戻すまでの時間 (ms) (#350)。 */
const INACTIVITY_MS = 2800

/** active 時にスライダ背面へ敷く影（半透明黒の矩形）の見た目 (#350)。ChoiceOverlay の影実装が手本。 */
const SHADOW_COLOR = 0x000000
const SHADOW_ALPHA = 0.45
/** 影のずれ（右下方向、px） */
const SHADOW_OFFSET = 3
/** 影帯の左右パディング（バー両端より少し外へ広げる、px） */
const SHADOW_PAD_X = 10

export class SeekBar extends Container {
  /** active 時にスライダ背面へ敷く影。最背面の子。 */
  private shadow: Graphics
  private barBg: Graphics
  private barFill: Graphics
  private thumb: Graphics
  private clickRegion: Graphics

  private barWidth: number
  private barX: number
  private barY: number
  /** つまみ中心 Y（px）＝下部丸ボタンの中央（#350）。`computeSeekBarGeometry` で算出。 */
  private thumbCenterY: number

  private _total = 0
  private _current = 0

  /**
   * 演出/UI の一時状態 (#350)。`visible` とは別概念で、GameState には持たない transient フラグ。
   * active 中はつまみ拡大＋影で前面感を出し、丸ボタン行をフェード退避させる。
   */
  private _active = false
  /** 動画書き出し中の抑制フラグ (#350)。true の間は非表示・active 無効。 */
  private exportSuppressed = false
  /** 無操作で inactive に戻すタイマー（TimeController 経由なので number）。 */
  private inactivityTimer: number | null = null

  /** タイマー抽象化レイヤー（既存流儀: NovelRenderer / CharacterLayer と共有）。 */
  private readonly time: TimeController

  /** クリックで呼ばれるコールバック (historyIndex: number) => void */
  private onSeek: ((historyIndex: number) => void) | null = null
  /** active 状態変化コールバック (#350)。NovelRenderer 経由で NovelPlayer のボタンフェードに繋ぐ。 */
  private onActiveChange: ((active: boolean) => void) | null = null

  constructor(
    screenWidth: number,
    screenHeight: number,
    time: TimeController = defaultTimeController
  ) {
    super()

    this.time = time

    // 縦位置（つまみ中心＝丸ボタン中央）は純粋関数に集約 (#350)。
    const geom = computeSeekBarGeometry(screenWidth, screenHeight, BAR_MARGIN_X, BAR_HEIGHT)
    this.barX = geom.barX
    this.barWidth = geom.barWidth
    this.barY = geom.barY
    this.thumbCenterY = geom.thumbCenterY

    // 影（active 時のみ表示）。最背面に置き、スライダ全体を浮かせて見せる。
    // pixi-filters 依存は避け、半透明黒の矩形を背面に重ねる方式（ChoiceOverlay が手本）。
    this.shadow = new Graphics()
    const bandHeight = THUMB_RADIUS * 2 * ACTIVE_THUMB_SCALE + 10
    this.shadow.roundRect(
      this.barX - SHADOW_PAD_X + SHADOW_OFFSET,
      this.thumbCenterY - bandHeight / 2 + SHADOW_OFFSET,
      this.barWidth + SHADOW_PAD_X * 2,
      bandHeight,
      bandHeight / 2
    )
    this.shadow.fill({ color: SHADOW_COLOR, alpha: SHADOW_ALPHA })
    this.shadow.visible = false
    this.addChild(this.shadow)

    // 透明ヒットエリア（タップ/ドラッグ開始の検出を広めに取る）。つまみ中心の上下に余裕を持たせる。
    const hitHeight = THUMB_RADIUS * 2 * ACTIVE_THUMB_SCALE + 16
    this.clickRegion = new Graphics()
    this.clickRegion.rect(this.barX, this.thumbCenterY - hitHeight / 2, this.barWidth, hitHeight)
    this.clickRegion.fill({ color: 0x000000, alpha: 0 })
    this.clickRegion.eventMode = 'static'
    this.clickRegion.cursor = 'pointer'
    this.clickRegion.on('pointerdown', this.handleClick)
    this.addChild(this.clickRegion)

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
    this.thumb.y = this.thumbCenterY
    this.addChild(this.thumb)

    // 通常時は控えめに常時表示（ボタンより背面に見せる）(#350)。
    this.applyActiveVisual()
    this.updateVisual()
  }

  /**
   * シークコールバックを設定する
   */
  setOnSeek(callback: (historyIndex: number) => void): void {
    this.onSeek = callback
  }

  /** active 状態変化コールバックを設定する (#350)。 */
  setOnActiveChange(callback: (active: boolean) => void): void {
    this.onActiveChange = callback
  }

  /** 現在 active かどうか (#350)。 */
  isActive(): boolean {
    return this._active
  }

  /**
   * active に入る／無操作タイマーを延長する (#350)。
   * スライダ領域でのタップ/ドラッグ開始（モバイル）やデスクトップの下端帯ホバーで呼ぶ。
   * 動画書き出し中（exportSuppressed）は no-op。
   */
  activate(): void {
    if (this.exportSuppressed) return
    this.setActive(true)
    this.restartInactivityTimer()
  }

  /** active を即解除する (#350)。領域外タップ・キャンバス離脱・書き出し開始で呼ぶ。 */
  deactivate(): void {
    this.clearInactivityTimer()
    this.setActive(false)
  }

  /**
   * 動画書き出しの開始/終了に応じてスライダを抑制する (#350)。
   * true の間は非表示にし、録画にスライダが焼き込まれないようにする。active も解除する。
   */
  setExportSuppressed(suppressed: boolean): void {
    if (this.exportSuppressed === suppressed) return
    this.exportSuppressed = suppressed
    if (suppressed) {
      this.deactivate()
      this.visible = false
    } else {
      this.visible = true
    }
  }

  /**
   * 現在位置と合計を更新する
   */
  update(current: number, total: number): void {
    this._current = current
    this._total = total
    this.updateVisual()
  }

  /** リソース解放 (#350)。無操作タイマーを止めてから破棄する。 */
  override destroy(options?: Parameters<Container['destroy']>[0]): void {
    this.clearInactivityTimer()
    super.destroy(options)
  }

  private setActive(active: boolean): void {
    if (this._active === active) return
    this._active = active
    this.applyActiveVisual()
    this.onActiveChange?.(active)
  }

  /** active/inactive に応じて見た目（不透明度・影・つまみ拡大）を反映する (#350)。 */
  private applyActiveVisual(): void {
    this.alpha = this._active ? 1 : INACTIVE_ALPHA
    this.shadow.visible = this._active
    const scale = this._active ? ACTIVE_THUMB_SCALE : 1
    this.thumb.scale.set(scale)
  }

  private restartInactivityTimer(): void {
    this.clearInactivityTimer()
    this.inactivityTimer = this.time.setTimeout(() => {
      this.inactivityTimer = null
      this.setActive(false)
    }, INACTIVITY_MS)
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer !== null) {
      this.time.clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }
  }

  private drawBar(g: Graphics, color: number, width: number, alpha: number): void {
    g.clear()
    g.roundRect(this.barX, this.barY, width, BAR_HEIGHT, BAR_RADIUS)
    g.fill({ color, alpha })
  }

  private updateVisual(): void {
    const maxIndex = this._total - 1
    const ratio = maxIndex > 0 ? Math.max(0, Math.min(1, this._current / maxIndex)) : 0
    const fillWidth = Math.max(BAR_RADIUS * 2, this.barWidth * ratio)

    this.barFill.clear()
    this.barFill.roundRect(this.barX, this.barY, fillWidth, BAR_HEIGHT, BAR_RADIUS)
    this.barFill.fill({ color: BAR_FILL_COLOR, alpha: 0.8 })

    // つまみ位置（X のみ。Y はつまみ中心＝ボタン中央で固定）
    this.thumb.x = this.barX + this.barWidth * ratio
    this.thumb.visible = this._total > 0
  }

  private handleClick = (e: FederatedPointerEvent): void => {
    // スライダ操作（タップ/ドラッグ開始）で active に入る (#350)。
    this.activate()

    if (this._total <= 0) return

    const globalX = e.globalX
    const localX = globalX - this.barX
    const ratio = Math.max(0, Math.min(1, localX / this.barWidth))
    const index = Math.round(ratio * (this._total - 1))

    this.onSeek?.(index)
  }
}
