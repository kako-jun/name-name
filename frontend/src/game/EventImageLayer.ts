/**
 * イベント絵レイヤー (#351)。
 *
 * `[イベント絵: path, 背面=hide/keep, フェード=800]` / `[イベント絵終了: フェード=600]` から
 * 駆動される、テキストより背面・背景/立ち絵より前面に出る「画面ぴったり」の単一スロット画像。
 * VideoLayer と同じ単一スロット意味論（新しい show() が前の画像を置換する）を踏襲するが、
 * 動画ではなく静止画で、位置/スケール指定は持たず常に画面全体を cover-fit で覆う。
 *
 * #427/#428 で見つかった「テクスチャ未ロードのままフェードを開始してしまう」バグを踏まないよう、
 * フェード開始（fadeAnimation のセット）は必ず Assets.load().then() の中で行う
 * （NovelRenderer.showLoadedBackground と同じ流儀）。
 *
 * 背景/動画の端フェードマスク（edgeFadeMask）は「画面ぴったり」の性質上不要（対象外）。
 * フェードは表示アルファの時間補間（フェードイン/アウト）のみを扱う。
 */

import { Assets, Container, Sprite, Texture } from 'pixi.js'
import { EventImageState } from './GameState'
import { computeCoverFit } from './novelLayout'
import { computeFadeAlpha } from './screenEffects'
import { TimeController, defaultTimeController } from './TimeController'

export interface EventImageShowOptions {
  /** 背面（背景・立ち絵）扱い。未指定は 'Hide'（既定） */
  back?: 'Hide' | 'Keep' | null
  /** 表示フェードイン時間 (ms)。未指定/0 以下は即時表示 */
  fadeMs?: number | null
}

export interface EventImageRemoveOptions {
  /** 退場フェードアウト時間 (ms)。未指定/0 以下は即時消去 */
  fadeMs?: number | null
}

interface EventImageFadeAnimation {
  startMs: number
  durationMs: number
  fromAlpha: number
  toAlpha: number
  /** true なら fade-out 完了時に sprite を破棄する（退場フェード用） */
  destroyOnComplete: boolean
}

export class EventImageLayer extends Container {
  private readonly screenWidth: number
  private readonly screenHeight: number
  private readonly time: TimeController
  /** 画像 URL のベース。背景/動画と同じ値を持たせ、相対パスから URL を再構築する */
  private assetBaseUrl = ''

  private sprite: Sprite | null = null
  private fadeAnimation: EventImageFadeAnimation | null = null
  private fadeTimer: number | null = null

  /**
   * 現在の「設定済み」状態（スナップショット用）。フェードの中間経過ではなく、常に
   * settled な目標値を指す（ADR-0002）。show()/remove() を呼んだ瞬間にここが更新される。
   */
  private current: { path: string; back: 'Hide' | 'Keep' } | null = null

  /** show() の非同期ロード用トークン。remove() / 再入との race 回避に使う */
  private loadToken = 0
  /** ロード待ち中かどうかの判定用（`[待機: 表示完了]` の観測対象） */
  private pendingLoadToken: number | null = null

  constructor(
    screenWidth: number,
    screenHeight: number,
    time: TimeController = defaultTimeController
  ) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.time = time
  }

  /**
   * 画像 URL のベースを設定する（背景/動画の setAssetBaseUrl と対）。
   * show() に渡す相対パスは `assetBaseUrl + '/images/' + path` で URL 化される。
   */
  setAssetBaseUrl(url: string): void {
    this.assetBaseUrl = url
  }

  private buildImageUrl(path: string): string {
    const cleanPath = path.replace(/^\//, '')
    return `${this.assetBaseUrl}/images/${cleanPath}`
  }

  /**
   * イベント絵を表示する。既存のイベント絵があれば即座に破棄してから読み込む
   * （背景/動画と同じ単一スロット意味論）。
   *
   * `current`（settled state）は同期的に確定させるが、実際の sprite 生成・フェード開始は
   * テクスチャロード完了後（Assets.load().then() 内）まで遅延する（#427/#428 対策）。
   */
  show(path: string, opts: EventImageShowOptions = {}): void {
    const back: 'Hide' | 'Keep' = opts.back === 'Keep' ? 'Keep' : 'Hide'
    const fadeMs = typeof opts.fadeMs === 'number' && opts.fadeMs > 0 ? opts.fadeMs : 0

    this.destroySprite()
    this.stopFadeTimer()
    this.fadeAnimation = null
    this.current = { path, back }

    if (!this.assetBaseUrl) return

    const url = this.buildImageUrl(path)
    const token = ++this.loadToken
    this.pendingLoadToken = token

    Assets.load(url)
      .then((texture: Texture) => {
        // 新しい show()/remove() が後から呼ばれていれば、この読み込みは無効（古い世代）。
        if (token !== this.loadToken) return
        this.pendingLoadToken = null

        const sprite = new Sprite(texture)
        Object.assign(
          sprite,
          computeCoverFit(texture.width, texture.height, this.screenWidth, this.screenHeight)
        )
        this.sprite = sprite
        this.addChild(sprite)

        if (fadeMs > 0) {
          // フェード開始は必ずここ（テクスチャロード確定後）で行う。
          sprite.alpha = 0
          this.fadeAnimation = {
            startMs: this.time.now(),
            durationMs: fadeMs,
            fromAlpha: 0,
            toAlpha: 1,
            destroyOnComplete: false,
          }
          this.ensureFadeTimer()
        } else {
          sprite.alpha = 1
        }
      })
      .catch((err: unknown) => {
        if (this.pendingLoadToken === token) this.pendingLoadToken = null
        console.warn('[name-name] イベント絵の読み込みに失敗: ' + url, err)
      })
  }

  /**
   * イベント絵をクリアする。`current`（settled state）は同期的に null になる
   * （ADR-0002: スナップショットは常に settled 状態のみを持つ）。
   * fadeMs 指定時は表示中の sprite をフェードアウトさせてから破棄する（見た目の余韻のみで、
   * ゲーム状態としては既にクリア済み扱い）。
   */
  remove(opts: EventImageRemoveOptions = {}): void {
    const fadeMs = typeof opts.fadeMs === 'number' && opts.fadeMs > 0 ? opts.fadeMs : 0

    this.current = null
    // ロード中だった読み込みは無効化する（後から解決しても捨てられる）。
    this.loadToken++
    this.pendingLoadToken = null

    if (!this.sprite) {
      this.fadeAnimation = null
      this.stopFadeTimer()
      return
    }

    if (fadeMs <= 0) {
      this.destroySprite()
      this.fadeAnimation = null
      this.stopFadeTimer()
      return
    }

    this.fadeAnimation = {
      startMs: this.time.now(),
      durationMs: fadeMs,
      fromAlpha: this.sprite.alpha,
      toAlpha: 0,
      destroyOnComplete: true,
    }
    this.ensureFadeTimer()
  }

  private ensureFadeTimer(): void {
    if (this.fadeTimer != null) return
    this.fadeTimer = this.time.setInterval(() => this.updateFadeFrame(), 16)
  }

  private stopFadeTimer(): void {
    if (this.fadeTimer == null) return
    this.time.clearInterval(this.fadeTimer)
    this.fadeTimer = null
  }

  private updateFadeFrame(): void {
    const f = this.fadeAnimation
    if (!f || !this.sprite) {
      this.stopFadeTimer()
      return
    }
    const elapsed = this.time.now() - f.startMs
    const { alpha, done } = computeFadeAlpha(elapsed, f.fromAlpha, f.toAlpha, f.durationMs)
    this.sprite.alpha = alpha
    if (done) {
      this.fadeAnimation = null
      this.stopFadeTimer()
      if (f.destroyOnComplete) {
        this.destroySprite()
      }
    }
  }

  private destroySprite(): void {
    if (!this.sprite) return
    this.sprite.removeFromParent()
    // texture は PixiJS の Assets キャッシュが保有するので破棄しない
    // （NovelRenderer.destroyBackgroundEntry と同じ流儀。再表示時の再ダウンロードを防ぐ）。
    this.sprite.destroy()
    this.sprite = null
  }

  /** 現在表示中/表示予定のイベント絵があるか（settled state 基準） */
  hasEventImage(): boolean {
    return this.current !== null
  }

  /**
   * 現在の設定状態を返す（スナップショット用）。なければ null。
   * フェード中でも settled な目標値（path/back）を返す（ADR-0002）。
   */
  getState(): EventImageState | null {
    if (!this.current) return null
    return { path: this.current.path, back: this.current.back }
  }

  /**
   * 状態から即時復元する（巻き戻し・ロード・任意局面起動）。
   * フェードは行わない（復元は settled 状態への瞬時反映。CharacterLayer.show の
   * instant 復元・VideoLayer.restore と同じ流儀。ADR-0002）。
   */
  restore(state: EventImageState | null): void {
    if (!state) {
      this.remove()
      return
    }
    this.show(state.path, { back: state.back })
  }

  /**
   * `[待機: 表示完了]` 用の観測 API。
   * テクスチャロード中、またはフェード（表示イン/退場アウト）進行中なら true。
   */
  hasPendingVisualTransition(): boolean {
    return this.pendingLoadToken !== null || this.fadeAnimation !== null
  }
}
