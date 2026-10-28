/**
 * 壁レイヤー (#703)。
 *
 * `[壁: path]` / `[壁: なし]` を管理する専用レイヤー。背景板（`BackgroundBoardLayer`）よりさらに奥に置く、
 * 画面いっぱいの単一スロットの画像または動画（照明の模様・プロジェクションマッピング風の映像を流す用途）。
 * 新しい `show()` は前の壁を置換する（`VideoLayer` / `CurtainLayer` と同じ単一スロット意味論）。
 *
 * - 画像か動画かは path の拡張子で判別する（`isWallVideoPath`）。画像は `images/`、動画は `videos/` から読む。
 * - 動画の再生・音声ミックス・解放・書き出しの頭出しは既存の `VideoLayer` を内部に1つ持って委譲する
 *   （動画のライフサイクルを新しく書き起こさない）。壁の既定はループ・ミュート。
 * - カメラ・ズームは背景板と同じ経路で受ける。`computeCameraProjection` の scale/verticalOffset は内側の
 *   `frame` コンテナに掛け、ズーム（`CameraZoomController`）はこのレイヤー自身のコンテナに掛かる。
 *   壁は最奥の画面いっぱいの面なので、深さは定数 `WALL_DEPTH`（画面全体を覆う 0）を射影に通す。
 * - 保存状態（`getState`）は「パス＋設定」だけ。動画の再生位置は持たない。復元は常に頭から再生する最終状態
 *   （ADR-0002）。スライドイン等の演出もない。
 */
import { Assets, Container, Sprite, type Texture } from 'pixi.js'
import type { CameraElevation, CameraMode, CameraOrientation } from '../types'
import type { AudioManager } from './AudioManager'
import { computeCameraProjection } from './cameraProjection'
import type { WallState } from './GameState'
import { computeBoardPlacement, isWallVideoPath, resolveAssetUrl } from './novelLayout'
import { VideoLayer } from './VideoLayer'

/**
 * 壁を射影に通すときの深さ。壁は背景板より奥の「舞台の背面」で、画面全体を覆う面として扱うため、
 * 背景板が縮小して見える奥行き（depth > 0）とは別に、縮小しない 0 を採る。
 */
export const WALL_DEPTH = 0

export interface WallFrame {
  /** frame.position.x（常に画面水平中央） */
  x: number
  /** frame.position.y（画面垂直中央 + 仰角由来の垂直オフセット） */
  y: number
  /** frame.scale（カメラ射影のスケール） */
  scale: number
}

/**
 * カメラ状態から、壁の `frame` コンテナ（pivot は画面中央）に掛ける変換を求める純粋関数。
 * ノベルモードは常に原寸（`computeCameraProjection` が identity を返す）。
 */
export function computeWallFrame(
  mode: CameraMode,
  orientation: CameraOrientation,
  elevation: CameraElevation | null,
  screenWidth: number,
  screenHeight: number
): WallFrame {
  const projection = computeCameraProjection(mode, orientation, elevation, WALL_DEPTH)
  return {
    x: screenWidth / 2,
    y: screenHeight / 2 + projection.verticalOffset,
    scale: projection.scale,
  }
}

export class WallLayer extends Container {
  /** 射影を掛ける内側コンテナ。pivot が画面中央なので scale は画面中心基準で効く。 */
  private readonly frame = new Container()
  private readonly videoLayer: VideoLayer
  private sprite: Sprite | null = null
  private current: WallState | null = null
  /** 非同期ロードの世代。show()/clear() ごとに進め、古いロード完了を無視する。 */
  private generation = 0
  /** これまでにロードした画像 URL（GPU テクスチャのリーク防止用。BackgroundBoardLayer.loadedUrls と同じ流儀）。 */
  private loadedUrls: Set<string> = new Set()
  private cameraMode: CameraMode = 'Novel'
  private cameraOrientation: CameraOrientation = 'Audience'
  private cameraElevation: CameraElevation | null = null

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number,
    audioManager?: AudioManager
  ) {
    super()
    // 壁そのものはクリックしても何も起きない（背景板と同じ流儀）。
    this.eventMode = 'none'
    this.frame.pivot.set(screenWidth / 2, screenHeight / 2)
    this.addChild(this.frame)
    this.videoLayer = new VideoLayer(screenWidth, screenHeight, audioManager)
    this.frame.addChild(this.videoLayer)
    this.applyFrame()
  }

  /** カメラ状態が変わったとき（`[カメラ:]` イベント処理）に呼ぶ。壁を新しい射影で置き直す（演出なし）。 */
  setCamera(
    mode: CameraMode,
    orientation: CameraOrientation,
    elevation: CameraElevation | null
  ): void {
    this.cameraMode = mode
    this.cameraOrientation = orientation
    this.cameraElevation = elevation
    this.applyFrame()
  }

  private applyFrame(): void {
    const f = computeWallFrame(
      this.cameraMode,
      this.cameraOrientation,
      this.cameraElevation,
      this.screenWidth,
      this.screenHeight
    )
    this.frame.position.set(f.x, f.y)
    this.frame.scale.set(f.scale, f.scale)
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
        this.frame.addChild(sprite)
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
   * 動画は頭から再生し直す（再生位置は保存しない、ADR-0002）。
   */
  restore(state: WallState | null, assetBaseUrl: string): void {
    if (!state) {
      this.clear()
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
