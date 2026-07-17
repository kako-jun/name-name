/**
 * シークバー UI（シナリオスライダ）
 *
 * ダイアログボックスの下に薄いプログレスバーを表示し、
 * クリックで任意のスナップショット位置にジャンプできる。
 * 動画プレイヤー的な見た目のスクラブバー。
 *
 * #350: つまみ中心を下部丸ボタンの中央を貫く高さへ上げ（`computeSeekBarGeometry`）、通常時も
 * 控えめに常時表示する。スライダの実操作（タップ/ドラッグ）で `active` に入り、つまみを拡大して
 * 前面感を出す（ホバーでは入らない）。初回タップ（inactive→active）は「操作可能化」だけでシークせず、
 * active 中の以降のタップ/ドラッグでシークする。active は **GameState に持たない transient な演出/UI
 * 状態**（ADR 0002）。一定時間無操作で inactive に戻す。動画書き出し中は `setExportSuppressed(true)`、
 * 暗転中は `setBlackoutHidden(true)` で非表示にし（表示可否は `updateVisibility` に一元化）、録画や
 * 黒画面にスライダが焼き込まれない・残らないようにする。
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
/**
 * バー進捗色（フィル／つまみ）の既定値（水色系、DialogBox のインジケーター色に合わせる）(#440)。
 * per-game の `seekbar_color:` 未指定時のフォールバック。SeekBar は全ゲーム共有部品なので
 * ここをグローバルに変えず、作品ごとに `setFillColor` で上書きする。
 */
export const DEFAULT_BAR_FILL_COLOR = 0xa8dadc
/** バーの丸み */
const BAR_RADIUS = 3
/** つまみの半径 */
const THUMB_RADIUS = 7

/** active 時のつまみ拡大率 (#350)。スライダを前面に感じさせる。 */
export const ACTIVE_THUMB_SCALE = 1.6
/** 通常（inactive）時のコンテナ不透明度 (#350)。控えめに常時表示しつつボタンより背面に見せる。 */
export const INACTIVE_ALPHA = 0.2
/** 操作（タップ/ドラッグ）が止まってから inactive に戻すまでの時間 (ms) (#350)。 */
export const INACTIVITY_MS = 2800

export class SeekBar extends Container {
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
   * フィル／つまみ色 (#440)。per-game の `seekbar_color:` を反映する。既定は水色（後方互換）。
   * トラック背景 `BAR_BG_COLOR` は据え置きで、この色だけを上書きする。
   */
  private fillColor: number = DEFAULT_BAR_FILL_COLOR

  /**
   * 演出/UI の一時状態 (#350)。`visible` とは別概念で、GameState には持たない transient フラグ。
   * active 中はつまみ拡大＋影で前面感を出し、丸ボタン行をフェード退避させる。
   */
  private _active = false
  /** 動画書き出し中の抑制フラグ (#350)。true の間は非表示・active 無効。 */
  private exportSuppressed = false
  /**
   * 暗転（blackout）中の非表示フラグ (#350)。GameState の永続 isBlackout から導出する transient ゲート。
   * true の間は非表示にし、暗転オーバーレイ（黒）の上に薄いスライダ線が残らないようにする。
   */
  private blackoutHidden = false
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
    this.thumb.fill({ color: this.fillColor, alpha: 0.9 })
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

  /**
   * フィル／つまみ色を上書きする (#440)。per-game の `seekbar_color:` を反映する。
   * 呼び出し側で `parseColorToNumber` により文字列→数値に解決済みの色を渡す（不正/未指定は
   * 既定の水色にフォールバック済み）。トラック背景は変えない。即座に再描画して反映する。
   */
  setFillColor(color: number): void {
    if (!Number.isFinite(color) || this.fillColor === color) return
    this.fillColor = color
    // つまみ色を描き直す（円は原点基準・scale/位置は据え置き）。
    this.thumb.clear()
    this.thumb.circle(0, 0, THUMB_RADIUS)
    this.thumb.fill({ color: this.fillColor, alpha: 0.9 })
    // フィルバーは updateVisual が this.fillColor を参照して描き直す。
    this.updateVisual()
  }

  /** 現在 active かどうか (#350)。 */
  isActive(): boolean {
    return this._active
  }

  /**
   * active に入る／無操作タイマーを延長する (#350)。
   * スライダ領域での実操作（タップ/ドラッグ/クリック開始）で呼ぶ（ホバーでは呼ばない）。
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
    if (suppressed) this.deactivate()
    this.updateVisibility()
  }

  /**
   * 暗転（blackout）の適用/解除に応じてスライダの表示を切り替える (#350)。
   * 暗転中は非表示にして黒オーバーレイの上に薄線が残らないようにし、active も解除する。
   * 表示可否は exportSuppressed と併せて updateVisibility に一元化する。
   */
  setBlackoutHidden(hidden: boolean): void {
    if (this.blackoutHidden === hidden) return
    this.blackoutHidden = hidden
    if (hidden) this.deactivate()
    this.updateVisibility()
  }

  /** exportSuppressed / blackoutHidden の両ゲートから表示可否を一元決定する (#350)。 */
  private updateVisibility(): void {
    this.visible = !this.exportSuppressed && !this.blackoutHidden
  }

  /**
   * つまみ中心 Y（論理 px）を更新して縦位置を再配置する (#350)。
   *
   * 下部丸ボタンは DOM の固定 CSS px（`bottom` + 半径）で配置され、キャンバスの表示倍率で
   * スケールしない。一方このスライダは Pixi 論理座標で描かれ表示倍率でスケールするため、表示高さが
   * 論理高さと異なると丸ボタン中央からズレる。NovelRenderer が `canvas.clientHeight` から実倍率を
   * 求め、ボタンの実中央（固定 CSS px）に一致する論理 Y を算出して渡す。resize/回転でも追従させる。
   */
  setVerticalCenter(thumbCenterY: number): void {
    if (!Number.isFinite(thumbCenterY)) return
    this.thumbCenterY = thumbCenterY
    this.barY = thumbCenterY - BAR_HEIGHT / 2
    this.thumb.y = thumbCenterY

    const hitHeight = THUMB_RADIUS * 2 * ACTIVE_THUMB_SCALE + 16
    this.clickRegion.clear()
    this.clickRegion.rect(this.barX, thumbCenterY - hitHeight / 2, this.barWidth, hitHeight)
    this.clickRegion.fill({ color: 0x000000, alpha: 0 })

    this.drawBar(this.barBg, BAR_BG_COLOR, this.barWidth, 0.6)
    this.updateVisual()
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

  /** active/inactive に応じて見た目（不透明度・つまみ拡大）を反映する (#350)。 */
  private applyActiveVisual(): void {
    this.alpha = this._active ? 1 : INACTIVE_ALPHA
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
    this.barFill.fill({ color: this.fillColor, alpha: 0.8 })

    // つまみ位置（X のみ。Y はつまみ中心＝ボタン中央で固定）
    this.thumb.x = this.barX + this.barWidth * ratio
    this.thumb.visible = this._total > 0
  }

  private handleClick = (e: FederatedPointerEvent): void => {
    const wasActive = this._active
    // スライダの実操作で active に入る (#350)。初回タップ（inactive→active）は「操作可能化」だけ
    // にしてシークしない。すでに active のとき（2回目以降のタップ/ドラッグ）だけシークする。
    this.activate()
    if (!wasActive) return

    if (this._total <= 0) return

    const globalX = e.globalX
    const localX = globalX - this.barX
    const ratio = Math.max(0, Math.min(1, localX / this.barWidth))
    const index = Math.round(ratio * (this._total - 1))

    this.onSeek?.(index)
  }
}
