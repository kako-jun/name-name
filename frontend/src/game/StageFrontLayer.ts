/**
 * 舞台前面レイヤー (#705)。
 *
 * `[舞台前面: path]` / `[舞台前面: なし]` を管理する専用レイヤー。画面最下部に**下端揃え・画面の横幅に合わせて**
 * 置く単一スロットの透過画像（舞台エプロンの段差や、手前にちらっと見える観客席を作者が1枚に描く前提）。
 * 新しい `show()` は前の舞台前面を置換する（`WallLayer` / `CurtainLayer` と同じ単一スロット意味論）。
 * 会場（芝生公園・ホール・お笑いライブ会場・寄席）の組み込みプリセットは持たず、絵は path で切り替える。
 *
 * - 画像のみ（動画は対象外）。`images/` から読む。
 * - 画面空間のオーバーレイ。depth もカメラ射影も持たず、`CameraZoomController` のズームも受けない
 *   （`getLayers` に入れない。手前の固定物がズームで拡大すると不自然になるため）。
 * - 配置は `novelLayout.computeStageFrontPlacement`（横幅フィット・下端揃えの純粋関数）。
 * - 保存状態（`getState`）は「パス」だけ（ADR-0002）。復元は最終状態で、同じ前面（表示中またはロード進行中）なら
 *   再読み込みせず、それ以外（失敗・baseUrl 差し替え・前面なし→あり）は読み直す。演出（スライドイン等）はない。
 */
import { Assets, Container, Sprite, type Texture } from 'pixi.js'
import type { StageFrontState } from './GameState'
import { computeStageFrontPlacement, resolveAssetUrl } from './novelLayout'

export class StageFrontLayer extends Container {
  private sprite: Sprite | null = null
  private current: StageFrontState | null = null
  /** show() で使った assetBaseUrl（同一判定用。空なら読み込んでいない）。 */
  private shownBaseUrl = ''
  /** 画像のロードが進行中か（現世代）。 */
  private loading = false
  /** 非同期ロードの世代。show()/clear() ごとに進め、古いロード完了を無視する。 */
  private generation = 0
  /** これまでにロードした画像 URL（GPU テクスチャのリーク防止用。WallLayer.loadedUrls と同じ流儀）。 */
  private loadedUrls: Set<string> = new Set()

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number
  ) {
    super()
    // 舞台前面そのものはクリックしても何も起きない（誤タップで本文が進むのを防ぐ。他の演出レイヤーと同じ）。
    this.eventMode = 'none'
  }

  /**
   * 舞台前面を表示する。既存の前面があれば置換する（単一スロット）。`assetBaseUrl` が空なら読み込まない
   * （他レイヤーの同種ガードと同じ。状態は記録するので `getState()` には載る）。
   */
  show(path: string, assetBaseUrl: string): void {
    this.clear()
    this.current = { path }
    this.shownBaseUrl = assetBaseUrl
    if (!assetBaseUrl) return

    const gen = this.generation
    const url = resolveAssetUrl(assetBaseUrl, 'images', path)
    this.loading = true
    Assets.load(url)
      .then((texture: Texture) => {
        // 読み込み中に clear() や次の show() が来ていたら無視する（古い応答の race 防止）。
        if (gen !== this.generation) return
        this.loading = false
        this.loadedUrls.add(url)
        const placement = computeStageFrontPlacement(
          texture.width,
          texture.height,
          this.screenWidth,
          this.screenHeight
        )
        if (!placement) return
        const sprite = new Sprite(texture)
        sprite.x = placement.x
        sprite.y = placement.y
        sprite.width = placement.width
        sprite.height = placement.height
        this.sprite = sprite
        this.addChild(sprite)
      })
      .catch((err: unknown) => {
        if (gen === this.generation) this.loading = false
        console.warn('[name-name] 舞台前面の読み込みに失敗: ' + url, err)
      })
  }

  /** 舞台前面を消す（`[舞台前面: なし]` / `[場面転換]` / 新規開始 / 終劇 / 破棄）。Sprite を解放する。 */
  clear(): void {
    this.generation++
    if (this.sprite) {
      this.sprite.removeFromParent()
      // texture は PixiJS の Assets キャッシュが保有するので破棄しない（WallLayer.clear と同じ流儀）。
      this.sprite.destroy()
      this.sprite = null
    }
    this.current = null
    this.shownBaseUrl = ''
    this.loading = false
  }

  /**
   * 完成済みスナップショット（`NovelGameState.stageFront`）へ宣言的に復元する（goBack/seekTo/セーブ復元/任意局面起動）。
   * 表示中の前面と同一ならそのまま残す（再読み込みしない）。保存状態は最終状態のまま（ADR-0002）。
   * 宣言（path）が同じでも、実際に表示できていない（assetBaseUrl が空だった・読み込み失敗・assetBaseUrl が
   * 差し替わった）ときは show し直す。
   */
  restore(state: StageFrontState | null, assetBaseUrl: string): void {
    if (!state) {
      this.clear()
      return
    }
    if (this.isShowing(state, assetBaseUrl)) return
    this.show(state.path, assetBaseUrl)
  }

  private isShowing(state: StageFrontState, assetBaseUrl: string): boolean {
    const cur = this.current
    if (!cur || cur.path !== state.path) return false
    if (!assetBaseUrl || assetBaseUrl !== this.shownBaseUrl) return false
    // 読み込み失敗（404・デコード失敗）は sprite も loading も無い → 表示できていない扱いで再読み込みする。
    // restore はイベント時（goBack・seek・復元）にしか呼ばれないので、失敗が続いても無限にリロードはしない。
    return this.sprite !== null || this.loading
  }

  /** 現在の舞台前面を settled state として返す。ロードの成否に関わらず宣言された事実を返す（ADR-0002）。 */
  getState(): StageFrontState | null {
    return this.current ? { ...this.current } : null
  }

  /** 画像の Sprite が載っているか（テスト・検証用）。 */
  hasImage(): boolean {
    return this.sprite !== null
  }

  /**
   * これまでにロードした画像 URL を PixiJS の Assets キャッシュから解放する
   * （GPU テクスチャのリーク防止。`WallLayer.disposeTextures` と同じ流儀・fire-and-forget）。
   */
  disposeTextures(): void {
    const urls = Array.from(this.loadedUrls)
    this.loadedUrls.clear()
    if (urls.length === 0) return
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err: unknown) => {
      console.warn('[name-name] 舞台前面テクスチャの解放に失敗', err)
    })
  }
}
