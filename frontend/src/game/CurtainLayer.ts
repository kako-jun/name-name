/**
 * 幕レイヤー (#697)。
 *
 * シアターモード舞台構造（docs/architecture.md「シアターモード構想」節）の
 * `[幕: path]` / `[幕: path, 手前にキャラ]` / `[幕: 上げる]` を管理する専用レイヤークラス
 * （`BackgroundBoardLayer`/`PropLayer` と同系統の設計）。それらと異なり、幕は depth 配置・
 * カメラ射影を持たない**単一スロット**の全画面カバーフィット画像（kako-jun 確認済み: 現行の
 * 2D射影のまま実装する、3Dハイブリッド検討は #705 まで持ち越し）。単一スロットのため、
 * `show()` は既存の幕を即座に置き換える（Prop/BackgroundBoard の加算的な蓄積とは異なり、
 * `paperDollOutline`/`spotlight` と同じ「1個だけ」規律）。
 *
 * 配置は既存の単一スロット背景（`NovelRenderer.setBackground`）と同じ `novelLayout.computeCoverFit`
 * （anchor (0,0) 前提、画面いっぱいに覆う）を使う。`BackgroundBoardLayer`/`PropLayer` の
 * `computeBoardPlacement`（中心アンカー・カメラ射影込み）とは異なる。
 *
 * 昇降アニメーションは `novelLayout.ts` の `computeBoardSlideInOffset`（降ろす、#683 を流用）/
 * `computeCurtainRiseOffset`（上げる、#697 新設）純粋関数 + `TimeController` 駆動
 * （`BackgroundBoardLayer` と同じ設計パターン）。
 *
 * z-order はこのクラス自身では管理しない。`characters_in_front` に応じた stage 上の位置
 * （`propLayer` の直後 or `backgroundBoardLayer` の直後）は `NovelRenderer` が
 * `stage.setChildIndex()` で切り替える（docs/architecture.md「シアターモード構想」→
 * 「レイヤーモデル」節参照）。
 *
 * 復元（`restore()`、goBack/seekTo/セーブ復元/任意局面起動）は演出の中間状態を持たない
 * （ADR-0002）ため、昇降を起こさず即座に最終位置へ配置する。
 */
import { Assets, Container, Sprite, type Texture } from 'pixi.js'
import {
  BOARD_SLIDE_IN_MS,
  computeBoardSlideInOffset,
  computeCoverFit,
  computeCurtainRiseOffset,
  resolveAssetUrl,
} from './novelLayout'
import { TimeController, defaultTimeController } from './TimeController'

/** `getState()` の戻り値。`NovelGameState.curtain`（GameState.ts の `CurtainState`）と同形。 */
export interface CurtainLayerState {
  path: string
  charactersInFront: boolean
}

export class CurtainLayer extends Container {
  private sprite: Sprite | null = null
  private state: CurtainLayerState | null = null
  /** ロード済みテクスチャの URL。`disposeTextures()` で Assets キャッシュから解放する対象。 */
  private loadedUrl: string | null = null
  /** アニメーション中の最終停止位置（`computeCoverFit` の y）。sprite.y はここへ向けて補間する。 */
  private targetY = 0
  /** スライド中のみ非 null（`BackgroundBoardLayer`/`PropLayer` と同じ interval 駆動）。 */
  private interval: number | null = null
  private phaseStartedAtMs = 0
  /**
   * 現在の show()/raise()/clear() 呼び出しの世代カウンタ。単一スロットのため
   * `BackgroundBoardLayer.entries[].disposed` 相当をこの数値の比較で代替する:
   * 非同期ロード完了時にこの値と食い違っていれば、その後に別の show()/raise()/clear() が
   * 呼ばれた古い応答なので無視する（UAF / race 防止）。
   */
  private generation = 0

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number,
    private readonly time: TimeController = defaultTimeController
  ) {
    super()
    // 他の演出レイヤーと同じく、幕そのものはクリックしても何も起きない（誤タップで本文が進むのを防ぐ）。
    this.eventMode = 'none'
  }

  /**
   * 幕を降ろす（`[幕: path]` / `[幕: path, 手前にキャラ]`）。既存の幕があれば即座に置き換える
   * （単一スロット）。`assetBaseUrl` が空なら何もしない（他レイヤーの同種ガードと同じ）。
   * `opts.instant`（復元専用、goBack/seekTo/セーブ復元/任意局面起動）はスライドダウンを起こさず
   * 即座に最終位置へ配置する（ADR-0002: 演出の中間状態を復元しない）。
   */
  show(
    path: string,
    charactersInFront: boolean,
    assetBaseUrl: string,
    opts?: { instant?: boolean }
  ): void {
    this.state = { path, charactersInFront }
    const myGeneration = ++this.generation
    this.disposeCurrentSprite()
    if (!assetBaseUrl) return

    const url = resolveAssetUrl(assetBaseUrl, 'images', path)
    Assets.load(url)
      .then((texture: Texture) => {
        // 古い応答（この後に別の show()/raise()/clear() が呼ばれ世代が進んでいる）は無視する。
        if (myGeneration !== this.generation) return
        this.loadedUrl = url
        const sprite = new Sprite(texture)
        // 幕は depth 配置・カメラ射影を持たない全画面カバーフィット（単一スロット背景と同じ
        // 流儀。BackgroundBoardLayer/PropLayer の中心アンカー配置とは異なる）。
        const fit = computeCoverFit(
          texture.width,
          texture.height,
          this.screenWidth,
          this.screenHeight
        )
        Object.assign(sprite, fit)
        this.targetY = fit.y
        this.sprite = sprite
        this.addChild(sprite)
        if (opts?.instant) {
          sprite.y = this.targetY
        } else {
          this.phaseStartedAtMs = this.time.now()
          this.startLower(sprite, myGeneration)
        }
      })
      .catch((err: unknown) => {
        console.warn('[name-name] 幕の読み込みに失敗: ' + url, err)
      })
  }

  /**
   * 幕を上げる（`[幕: 上げる]`）。settled state は即座に `null`（幕なし）になる——上昇アニメーション
   * 自体は演出の中間状態であり GameState には持たせない（ADR-0002、他の一過性演出と同じ規律）。
   * 幕が無ければ何もしない。復元経路（goBack/seekTo/セーブ復元/任意局面起動）はこのメソッドを
   * 経由しない——`restore()` が `state=null` を直接 `clear()`（即座に消去、アニメーションなし）
   * へ振り分ける。
   */
  raise(): void {
    this.state = null
    const sprite = this.sprite
    if (!sprite) return
    ++this.generation // 進行中のロードを無効化する
    this.stopInterval()
    this.phaseStartedAtMs = this.time.now()
    this.startRaise(sprite)
  }

  /** 幕を即座に消去する（`[場面転換]`）。上昇アニメーションは起こさない。 */
  clear(): void {
    this.state = null
    ++this.generation
    this.disposeCurrentSprite()
  }

  /**
   * 完成済みスナップショット（`NovelGameState.curtain`）へ宣言的に復元する
   * （goBack/seekTo/セーブ復元/任意局面起動、`BackgroundBoardLayer.restore`/`PropLayer.restore`
   * と同じ役割）。`null` は幕なし。
   */
  restore(state: CurtainLayerState | null, assetBaseUrl: string): void {
    if (state) {
      this.show(state.path, state.charactersInFront, assetBaseUrl, { instant: true })
    } else {
      this.clear()
    }
  }

  /** 現在の幕の状態を settled state として返す（`NovelGameState.curtain` 用）。
   *  テクスチャのロード中/失敗に関わらず、`show()` された事実（path/charactersInFront）を
   *  そのまま返す（ADR-0002、`BackgroundBoardLayer.getState` と同じ規律）。 */
  getState(): CurtainLayerState | null {
    return this.state ? { ...this.state } : null
  }

  /**
   * ロード済みテクスチャを PixiJS の Assets キャッシュから解放する（GPU テクスチャのリーク防止。
   * `BackgroundBoardLayer.disposeTextures`/`PropLayer.disposeTextures` と同じ流儀・fire-and-forget）。
   * 呼び出し元（`NovelRenderer.setEvents()` / `destroy()`）が新しいイベント列の開始・
   * レンダラ破棄と同期させる責務を持つ。
   */
  disposeTextures(): void {
    if (!this.loadedUrl) return
    const url = this.loadedUrl
    this.loadedUrl = null
    Assets.unload(url).catch((err: unknown) => {
      console.warn('[name-name] 幕テクスチャの解放に失敗', err)
    })
  }

  private disposeCurrentSprite(): void {
    this.stopInterval()
    if (this.sprite) {
      this.sprite.removeFromParent()
      // texture は PixiJS の Assets キャッシュが保有するので破棄しない
      // （EventImageLayer.destroySprite 等と同じ流儀）。
      this.sprite.destroy()
      this.sprite = null
    }
  }

  private startLower(sprite: Sprite, myGeneration: number): void {
    // 開始位置: 最終位置から画面の高さぶん上（画面外＝完全に見えない状態）。
    sprite.y = this.targetY - this.screenHeight
    this.interval = this.time.setInterval(() => this.updateLowerFrame(sprite, myGeneration), 16)
  }

  private updateLowerFrame(sprite: Sprite, myGeneration: number): void {
    if (myGeneration !== this.generation || this.sprite !== sprite) {
      this.stopInterval()
      return
    }
    const elapsed = this.time.now() - this.phaseStartedAtMs
    const offset = computeBoardSlideInOffset(elapsed, BOARD_SLIDE_IN_MS)
    sprite.y = this.targetY + offset * this.screenHeight
    if (elapsed >= BOARD_SLIDE_IN_MS) {
      sprite.y = this.targetY
      this.stopInterval()
    }
  }

  private startRaise(sprite: Sprite): void {
    const myGeneration = this.generation
    this.interval = this.time.setInterval(() => this.updateRaiseFrame(sprite, myGeneration), 16)
  }

  private updateRaiseFrame(sprite: Sprite, myGeneration: number): void {
    if (myGeneration !== this.generation || this.sprite !== sprite) {
      this.stopInterval()
      return
    }
    const elapsed = this.time.now() - this.phaseStartedAtMs
    const offset = computeCurtainRiseOffset(elapsed, BOARD_SLIDE_IN_MS)
    sprite.y = this.targetY + offset * this.screenHeight
    if (elapsed >= BOARD_SLIDE_IN_MS) {
      this.disposeCurrentSprite()
    }
  }

  private stopInterval(): void {
    if (this.interval != null) {
      this.time.clearInterval(this.interval)
      this.interval = null
    }
  }
}
