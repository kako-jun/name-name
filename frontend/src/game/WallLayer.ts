/**
 * 壁レイヤー (#703)。
 *
 * `[壁: path]` / `[壁: なし]` を管理する専用レイヤー。背景板（`BackgroundBoardLayer`）より奥（単一スロット背景の上）に置く、
 * 画面いっぱいの単一スロットの画像または動画（照明の模様・プロジェクションマッピング風の映像を流す用途）。
 * 新しい `show()` は前の壁を置換する（`VideoLayer` / `CurtainLayer` と同じ単一スロット意味論）。
 *
 * - 画像か動画かは path の拡張子で判別する（`isWallVideoPath`）。画像は `images/`、動画は `videos/` から読む。
 * - 動画の再生・音声ミックス・解放・書き出しの頭出しは既存の `VideoLayer` を内部に1つ持って委譲する
 *   （動画のライフサイクルを新しく書き起こさない）。壁の既定はループ・ミュート。
 * - 壁は画面全体を覆う面で depth を持たず、カメラ射影（depth 縮小・仰角オフセット）は受けない。
 *   受けるのはズーム（`CameraZoomController` がこのレイヤー自身のコンテナに掛ける scale/position）だけ。
 * - 保存状態（`getState`）は「パス＋設定」だけ。動画の再生位置は持たない。復元は常に頭から再生する最終状態
 *   （ADR-0002）。スライドイン等の演出もない。
 */
import { Assets, Container, Sprite, type Texture } from 'pixi.js'
import type { AudioManager } from './AudioManager'
import type { WallState } from './GameState'
import { computeBoardPlacement, isWallVideoPath, resolveAssetUrl } from './novelLayout'
import { VideoLayer } from './VideoLayer'

export class WallLayer extends Container {
  private readonly videoLayer: VideoLayer
  private sprite: Sprite | null = null
  private current: WallState | null = null
  /** 非同期ロードの世代。show()/clear() ごとに進め、古いロード完了を無視する。 */
  private generation = 0
  /** これまでにロードした画像 URL（GPU テクスチャのリーク防止用。BackgroundBoardLayer.loadedUrls と同じ流儀）。 */
  private loadedUrls: Set<string> = new Set()

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number,
    audioManager?: AudioManager
  ) {
    super()
    // 壁そのものはクリックしても何も起きない（背景板と同じ流儀）。
    this.eventMode = 'none'
    this.videoLayer = new VideoLayer(screenWidth, screenHeight, audioManager)
    this.addChild(this.videoLayer)
  }

  /**
   * 壁を表示する。既存の壁があれば置換する（単一スロット）。`assetBaseUrl` が空なら読み込まない
   * （他レイヤーの同種ガードと同じ。状態は記録するので `getState()` には載る）。
   */
  show(path: string, opts: { loop?: boolean; mute?: boolean }, assetBaseUrl: string): void {
    this.clear()
    const loop = opts.loop !== false
    const mute = opts.mute !== false
    this.current = { path, loop, mute }
    if (!assetBaseUrl) return

    const gen = this.generation
    if (isWallVideoPath(path)) {
      this.videoLayer.setAssetBaseUrl(assetBaseUrl)
      this.videoLayer.show(path, { position: 'center', loop, mute })
      return
    }
    const url = resolveAssetUrl(assetBaseUrl, 'images', path)
    Assets.load(url)
      .then((texture: Texture) => {
        // 読み込み中に clear() や次の show() が来ていたら無視する（古い応答の race 防止）。
        if (gen !== this.generation) return
        this.loadedUrls.add(url)
        const placement = computeBoardPlacement(
          texture.width,
          texture.height,
          this.screenWidth,
          this.screenHeight,
          { scale: 1, verticalOffset: 0 }
        )
        const sprite = new Sprite(texture)
        sprite.anchor.set(0.5, 0.5)
        sprite.width = placement.width
        sprite.height = placement.height
        sprite.x = placement.x
        sprite.y = placement.y
        this.sprite = sprite
        this.addChild(sprite)
      })
      .catch((err: unknown) => {
        console.warn('[name-name] 壁の読み込みに失敗: ' + url, err)
      })
  }

  /** 壁を消す（`[壁: なし]` / `[場面転換]` / 新規開始 / 破棄）。video 要素・Sprite を解放する。 */
  clear(): void {
    this.generation++
    this.videoLayer.remove()
    if (this.sprite) {
      this.sprite.removeFromParent()
      // texture は PixiJS の Assets キャッシュが保有するので破棄しない（BackgroundBoardLayer.clear と同じ流儀）。
      this.sprite.destroy()
      this.sprite = null
    }
    this.current = null
  }

  /**
   * 完成済みスナップショット（`NovelGameState.wall`）へ宣言的に復元する（goBack/seekTo/セーブ復元/任意局面起動）。
   * 現在と異なる壁・壁なしからの復元では動画を頭から再生し直す（再生位置は保存しない、ADR-0002）。同一の壁ならそのまま流し続ける。
   */
  restore(state: WallState | null, assetBaseUrl: string): void {
    if (!state) {
      this.clear()
      return
    }
    // 表示中の壁と path・設定が同一なら、clear→再 show せずそのまま流し続ける（動画を頭出ししない）。
    // 保存状態は最終状態のまま（ADR-0002 に反しない）。
    const cur = this.current
    if (cur && cur.path === state.path && cur.loop === state.loop && cur.mute === state.mute) {
      return
    }
    this.show(state.path, { loop: state.loop, mute: state.mute }, assetBaseUrl)
  }

  /** 現在の壁を settled state として返す。ロードの成否に関わらず宣言された事実を返す（ADR-0002）。 */
  getState(): WallState | null {
    return this.current ? { ...this.current } : null
  }

  /** 動画の壁が表示中か（テスト・検証用）。 */
  hasVideo(): boolean {
    return this.videoLayer.hasVideo()
  }

  /** 画像の壁の Sprite が載っているか（テスト・検証用）。 */
  hasImage(): boolean {
    return this.sprite !== null
  }

  /** 動画書き出しの頭出し（`VideoLayer.prepareForExport` に委譲）。壁が動画でなければ即解決。 */
  prepareForExport(): Promise<void> {
    return this.videoLayer.prepareForExport()
  }

  /** ループしない動画の壁が再生中か（書き出しの停滞判定用、`VideoLayer.isPlayingToEnd` に委譲）。 */
  isPlayingToEnd(): boolean {
    return this.videoLayer.isPlayingToEnd()
  }

  /**
   * これまでにロードした画像 URL を PixiJS の Assets キャッシュから解放する
   * （GPU テクスチャのリーク防止。`BackgroundBoardLayer.disposeTextures` と同じ流儀・fire-and-forget）。
   */
  disposeTextures(): void {
    const urls = Array.from(this.loadedUrls)
    this.loadedUrls.clear()
    if (urls.length === 0) return
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err: unknown) => {
      console.warn('[name-name] 壁テクスチャの解放に失敗', err)
    })
  }
}
