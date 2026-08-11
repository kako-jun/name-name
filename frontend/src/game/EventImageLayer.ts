/**
 * イベント絵レイヤー (#351)。
 *
 * `[イベント絵: path, 背面=hide/keep, フェード=1400]` / `[イベント絵終了: フェード=700]` から
 * 駆動される、テキストより背面・背景/立ち絵より前面に出る「画面ぴったり」の単一スロット画像。
 * VideoLayer と同じ単一スロット意味論（新しい show() が前の画像を置換する）を踏襲するが、
 * 動画ではなく静止画で、独自の位置/スケール指定は持たず常に cover-fit で覆う。通常は画面全体、
 * `split_layout: true`（#464）で `setSplitLayoutRegion` が設定されていればその矩形（キャラ画像側の
 * 半分）を覆う（CharacterLayer と同じ画像側領域。テキスト領域には重ねない）。
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
import {
  clampFullscreenImageScrollY,
  computeCoverFit,
  computeFullscreenImageFit,
  type LayoutRect,
} from './novelLayout'
import { computeFadeAlpha } from './screenEffects'
import { TimeController, defaultTimeController } from './TimeController'

export interface EventImageShowOptions {
  /** 背面（背景・立ち絵）扱い。未指定は 'Hide'（既定） */
  back?: 'Hide' | 'Keep' | null
  /** 表示フェードイン時間 (ms)。呼び出し元が個別指定または per-game 既定を渡す。0 以下は即時表示 */
  fadeMs?: number | null
  /**
   * ロード成否に関わらず一度だけ発火する（CharacterLayer の #293 `onReady` と同じ流儀）。
   * 呼び出し元（NovelRenderer）はこれを機に `applyEventImageVisibility()` を再計算する。
   * ロード失敗時に `shouldHideBackLayer()` が false へ切り替わることを反映させ、覆うものが
   * 無いのに背面（背景・立ち絵）だけ隠れっぱなしになる事故を防ぐ（セルフレビュー指摘）。
   * 世代が古い（後から来た show()/remove() に追い越された）呼び出しでは発火しない。
   */
  onSettled?: () => void
  /**
   * 背面の可視性判定が変わりうるタイミングで発火する。
   * 例: back=Hide のイベント絵がフェードイン完了し、背面を隠してよい状態になったとき。
   */
  onVisibilityChange?: () => void
}

export interface EventImageRemoveOptions {
  /** 退場フェードアウト時間 (ms)。呼び出し元が個別指定または per-game 既定を渡す。0 以下は即時消去 */
  fadeMs?: number | null
}

interface EventImageFadeAnimation {
  startMs: number
  durationMs: number
  fromAlpha: number
  toAlpha: number
  /** true なら fade-out 完了時に sprite を破棄する（退場フェード用） */
  destroyOnComplete: boolean
  onComplete?: () => void
}

export class EventImageLayer extends Container {
  private readonly screenWidth: number
  private readonly screenHeight: number
  private readonly time: TimeController
  /** 画像 URL のベース。背景/動画と同じ値を持たせ、相対パスから URL を再構築する */
  private assetBaseUrl = ''

  private sprite: Sprite | null = null
  /** show() でロード成功した直近の Texture オブジェクトそのもの (#466 pixel_art ライブ再適用用)。
   *  `sprite.texture` 経由だと、Sprite コンストラクタが実 Texture インスタンスでない値
   *  （テストのプレーンオブジェクトモック等）を無条件に `Texture.EMPTY`（共有シングルトン）へ
   *  差し替えてしまう pixi.js の挙動を踏んでしまう（EventImageLayer.test.ts 参照）ため、
   *  show() が受け取った texture オブジェクトを直接保持し、それを再適用対象にする。
   *  destroySprite() で null に戻す（表示中でなくなったら再適用対象からも外す）。 */
  private currentTexture: Texture | null = null
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
  /**
   * 直近の show() のロードが失敗したか（現行世代のみ）。`current`（settled state・ADR-0002）は
   * ロード成否に関わらず作者の意図（path/back）を保持し続けるが、`shouldHideBackLayer()`（可視性
   * 判定専用）はこのフラグを見て「覆うものが実際に無い」間は背面を隠さないようにする
   * （セルフレビュー指摘: ロード失敗のまま back=Hide が残ると背景・立ち絵が永久に隠れっぱなしになる事故）。
   */
  private loadFailed = false

  /** これまでにロードした画像 URL（GPU テクスチャのリーク防止用。NovelRenderer.textureCache と同じ流儀） */
  private loadedUrls: Set<string> = new Set()

  /** split_layout (#464) のイベント絵領域。null = 従来どおり画面全体。CharacterLayer と同じ
   *  画像側領域（`regions.character`）を渡す想定（`setSplitLayoutRegion` 参照）。 */
  private splitLayoutRegion: LayoutRect | null = null

  /** テクスチャ拡大縮小フィルタを nearest-neighbor にするか (#466)。既定 false ＝従来どおり linear。
   *  frontmatter `pixel_art:` から `setPixelArt` 経由で反映される（Gymnasia の 128x128 ドット絵向け）。 */
  private pixelArt = false

  /** フルキャンバス画像表示モード (#530)。frontmatter `fullscreen_image: true` から
   *  `setFullscreenMode` 経由で反映される。true の間は `splitLayoutRegion` を無視し、
   *  `computeFullscreenImageFit` でキャンバス全幅 contain 表示（クロップなし）にする。
   *  `splitLayoutRegion` と同時に true になることは想定していない（互いに排他的なレイアウト
   *  モード、呼び出し元 `NovelRenderer` が両立させない）。 */
  private fullscreenMode = false
  /** フルキャンバス画像表示モードの縦スクロールオフセット (#530、px、0以上)。
   *  `handleWheel` が `clampFullscreenImageScrollY` でクランプしながら更新する。
   *  `show()` の度に 0 へ戻す（新しい画像を表示するたびにスクロール位置をリセットする、
   *  `BacklogOverlay` を開き直すたびに末尾へ戻すのと対称的な「表示し直したら初期状態」方針）。 */
  private scrollOffsetY = 0
  /** 直近の `show()` で `computeFullscreenImageFit` が算出した最大スクロールオフセット (#530)。
   *  `scrollable=false`（画像がキャンバス高さに収まる）なら常に0。 */
  private maxScrollY = 0

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

  /**
   * split_layout (#442/#464) のイベント絵領域を設定・解除する。`novelLayout.ts` の
   * `computeSplitLayoutRegions(...).character`（CharacterLayer と同じ画像側領域）をそのまま
   * 渡す想定。null で解除し、従来どおり画面全体（this.screenWidth/screenHeight 基準）に戻す。
   *
   * 参照タイミングは `show()` の同期呼び出し時点ではなく、ロード完了（`Assets.load()` 解決）
   * 時点の最新の `splitLayoutRegion` で cover-fit の基準矩形を決める（ロード未解決の間に
   * region を差し替えた場合は解決時点の値が使われる。`EventImageLayer.test.ts` の
   * race テスト参照）。既に表示中の sprite の位置・サイズはここでは触らない
   * （`setSplitLayout`/`setProtagonist` はいずれも通常 mount 時、最初の `show()` より前に
   * 呼ばれるため実運用上は問題にならない）。
   */
  setSplitLayoutRegion(region: LayoutRect | null): void {
    this.splitLayoutRegion = region
  }

  /** 現在の split_layout イベント絵領域 (#464)。null = 従来どおり全画面。テスト・配線検証用。 */
  getSplitLayoutRegion(): LayoutRect | null {
    return this.splitLayoutRegion
  }

  /**
   * フルキャンバス画像表示モード (#530) を設定・解除する。frontmatter `fullscreen_image:`
   * の値を渡す想定（`setSplitLayoutRegion` と対の役割）。有効/無効の切り替え時、以後の
   * スクロール操作が新しい状態を正しく前提にできるよう `scrollOffsetY`/`maxScrollY` を
   * 0 へ戻す（表示中の sprite の位置・サイズはここでは触らない。次の `show()` 呼び出しで
   * 新モードに応じたフィットが反映される、`setSplitLayoutRegion` と同じ流儀）。
   */
  setFullscreenMode(enabled: boolean): void {
    this.fullscreenMode = enabled
    this.scrollOffsetY = 0
    this.maxScrollY = 0
  }

  /** 現在フルキャンバス画像表示モードか (#530)。テスト・配線検証用。 */
  isFullscreenMode(): boolean {
    return this.fullscreenMode
  }

  /**
   * フルキャンバス画像表示モード (#530) 中のマウスホイール縦スクロール。
   * `BacklogOverlay.handleWheel` と同じ手触り（`deltaY * 0.5`）に揃える。フルキャンバス
   * モードでない、画像の高さがキャンバスに収まっている（`maxScrollY <= 0`）、
   * または表示中の sprite が無い場合は no-op（呼び出し元 `NovelRenderer.handleWheel` は
   * この場合に備えて他のスクロール対象へフォールスルーしてよい）。
   */
  handleWheel(deltaY: number): void {
    if (!this.fullscreenMode || this.maxScrollY <= 0 || !this.sprite) return
    this.scrollOffsetY = clampFullscreenImageScrollY(
      this.scrollOffsetY + deltaY * 0.5,
      this.maxScrollY
    )
    this.sprite.y = -this.scrollOffsetY
  }

  /**
   * テクスチャ拡大縮小フィルタを nearest-neighbor にするか設定する (#466)。
   * frontmatter `pixel_art:` の値を渡す。以後 `show()` でロードするテクスチャに適用される
   * （`show()` の同期呼び出し時点ではなく、ロード完了 `Assets.load().then()` 内で最新値を参照する。
   * `setSplitLayoutRegion` と同じ「解決時点の最新値を使う」流儀）。
   *
   * CharacterLayer.setPixelArt/reapplyPixelArt (#466 セルフレビュー指摘) と同じく、既に表示中の
   * sprite があればその場で即再適用する。EventImageLayer は単一スロット（this.sprite）なので、
   * ロード済み（currentTexture が非 null＝Assets.load().then() 済み）ならそのまま scaleMode を
   * 書き換えるだけでよい。`this.sprite.texture` ではなく `currentTexture` を使う理由は同フィールドの
   * JSDoc 参照。
   */
  setPixelArt(enabled: boolean): void {
    this.pixelArt = enabled
    if (this.currentTexture) {
      this.currentTexture.source.scaleMode = enabled ? 'nearest' : 'linear'
    }
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
    const onSettled = opts.onSettled
    const onVisibilityChange = opts.onVisibilityChange

    this.destroySprite()
    this.stopFadeTimer()
    this.fadeAnimation = null
    this.current = { path, back }
    this.loadFailed = false
    // フルキャンバス画像表示モード (#530) 中に新しい画像へ差し替わったら、スクロール位置を
    // 先頭へ戻す（前の画像のスクロール量を引きずらない）。
    this.scrollOffsetY = 0
    this.maxScrollY = 0

    if (!this.assetBaseUrl) return

    const url = this.buildImageUrl(path)
    const token = ++this.loadToken
    this.pendingLoadToken = token

    Assets.load(url)
      .then((texture: Texture) => {
        // 新しい show()/remove() が後から呼ばれていれば、この読み込みは無効（古い世代）。
        if (token !== this.loadToken) return
        this.pendingLoadToken = null
        this.loadedUrls.add(url)
        // ドット絵の拡大縮小フィルタ (#466)。既定 linear（滑らか）を pixel_art: true で
        // nearest-neighbor に切り替え、cover-fit で拡大表示してもブロック状のドットを保つ。
        texture.source.scaleMode = this.pixelArt ? 'nearest' : 'linear'

        const sprite = new Sprite(texture)
        if (this.fullscreenMode) {
          // フルキャンバス画像表示モード (#530): splitLayoutRegion は無視し、常にキャンバス
          // 全幅で contain（クロップなし）。高さがキャンバスを超える場合は追加の縮小をせず、
          // 縦スクロール（`handleWheel` 参照）で見せる。
          const fit = computeFullscreenImageFit(
            texture.width,
            texture.height,
            this.screenWidth,
            this.screenHeight
          )
          Object.assign(sprite, { width: fit.width, height: fit.height, x: fit.x, y: 0 })
          this.maxScrollY = fit.maxScrollY
        } else {
          // region 未設定（従来どおり全画面）の場合は原点起点・画面サイズの矩形で代用する
          // （x/y=0 なので下の加算は実質 no-op になる）。
          const region = this.splitLayoutRegion ?? {
            x: 0,
            y: 0,
            width: this.screenWidth,
            height: this.screenHeight,
          }
          // computeCoverFit は常に原点 (0, 0) 基準の矩形を返すため、region のオフセット分を
          // 後から足す（CharacterLayer とは異なり、EventImageLayer は Container 全体の
          // scale/position ではなく sprite 個別の x/y/width/height で領域に収める）。
          const fit = computeCoverFit(texture.width, texture.height, region.width, region.height)
          Object.assign(sprite, { ...fit, x: fit.x + region.x, y: fit.y + region.y })
        }
        this.sprite = sprite
        this.currentTexture = texture
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
            onComplete: onVisibilityChange,
          }
          this.ensureFadeTimer()
        } else {
          sprite.alpha = 1
        }
        onSettled?.()
      })
      .catch((err: unknown) => {
        if (this.pendingLoadToken === token) this.pendingLoadToken = null
        console.warn('[name-name] イベント絵の読み込みに失敗: ' + url, err)
        // 現行世代の失敗だけ shouldHideBackLayer() に反映する（古い世代の失敗は現在の current に無関係）。
        if (token === this.loadToken) {
          this.loadFailed = true
          onSettled?.()
        }
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
      const onComplete = f.onComplete
      this.fadeAnimation = null
      this.stopFadeTimer()
      if (f.destroyOnComplete) {
        this.destroySprite()
      }
      onComplete?.()
    }
  }

  private destroySprite(): void {
    if (!this.sprite) return
    this.sprite.removeFromParent()
    // texture は PixiJS の Assets キャッシュが保有するので破棄しない
    // （NovelRenderer.destroyBackgroundEntry と同じ流儀。再表示時の再ダウンロードを防ぐ）。
    this.sprite.destroy()
    this.sprite = null
    // 表示中でなくなったので setPixelArt (#466) のライブ再適用対象からも外す。
    this.currentTexture = null
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
  restore(state: EventImageState | null, opts: { onSettled?: () => void } = {}): void {
    if (!state) {
      this.remove()
      return
    }
    this.show(state.path, { back: state.back, onSettled: opts.onSettled })
  }

  /**
   * `[待機: 表示完了]` 用の観測 API。
   * テクスチャロード中、またはフェード（表示イン/退場アウト）進行中なら true。
   */
  hasPendingVisualTransition(): boolean {
    return this.pendingLoadToken !== null || this.fadeAnimation !== null
  }

  /**
   * `back=Hide` によって背面（背景・立ち絵）を実際に隠すべきかを返す（NovelRenderer.
   * applyEventImageVisibility() の可視性判定専用 API）。
   *
   * `getState()`（settled state・ADR-0002・作者の意図として path/back を保持し続ける。
   * セーブ/リトライのため load 成否に関わらず不変）とは別に、こちらは「実際に画像が
   * 覆っているか」を返す。ロード前・フェードイン中は背面を残して暗転フラッシュを避け、
   * ロードが失敗した世代では覆うものが存在しないため false を返し、背景・立ち絵が永久に
   * 隠れっぱなしになる事故も防ぐ（セルフレビュー指摘）。
   */
  shouldHideBackLayer(): boolean {
    if (this.current === null || this.current.back !== 'Hide' || this.loadFailed) return false
    if (this.pendingLoadToken !== null || this.sprite === null) return false
    if (
      this.fadeAnimation &&
      !this.fadeAnimation.destroyOnComplete &&
      this.fadeAnimation.toAlpha === 1
    ) {
      return false
    }
    return true
  }

  /**
   * これまでにロードした画像 URL を PixiJS の Assets キャッシュから解放する
   * （GPU テクスチャのリーク防止。NovelRenderer.textureCache と同じ流儀・fire-and-forget）。
   * 呼び出し後も表示中の sprite はそのまま（Texture オブジェクト自体への参照は保持されるため
   * 描画は壊れない。破棄すべきタイミングは呼び出し元が新しいイベント列の開始・レンダラ破棄と
   * 同期させる責務を持つ）。
   */
  disposeTextures(): void {
    const urls = Array.from(this.loadedUrls)
    this.loadedUrls.clear()
    if (urls.length === 0) return
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err: unknown) => {
      console.warn('[name-name] イベント絵テクスチャの解放に失敗', err)
    })
  }
}
