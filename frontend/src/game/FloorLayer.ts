/**
 * 床レイヤー (#706 第2弾)。
 *
 * `[床: path]` / `[床: path, 高さ=0.3]` / `[床: なし]` を管理する専用レイヤー。画面の下部に**下端揃え・画面の横幅いっぱい**の
 * 帯（高さ = 画面高さ × 高さ比、既定 0.25）として置く単一スロットのタイル画像。画像は帯の高さに合わせて横方向に
 * タイルする（継ぎ目なしのテクスチャを想定。`TilingSprite` の `tileScale` で画像の高さを帯の高さに合わせる）。
 * 新しい `show()` は前の床を置換する（`StageFrontLayer` / `WallLayer` と同じ単一スロット意味論）。
 *
 * - 画像のみ（動画は対象外）。`images/` から読む。
 * - 配置は `novelLayout.computeFloorPlacement`（下端揃え・横幅フィット・タイルの純粋関数）。
 * - 画面空間の帯で depth もカメラ射影も持たない。ただし `CameraZoomController` のズームは背景板・壁と同じに受ける
 *   （`getLayers` に入れる。床は舞台の地面で、ズームすれば背景板と一緒に拡大するのが自然）。
 * - 保存状態（`getState`）は「パス＋高さ」だけ（ADR-0002）。復元は最終状態で、同じ床（パス・高さ・assetBaseUrl が同一で
 *   表示中またはロード進行中）なら再読み込みせず、それ以外（失敗・baseUrl 差し替え・床なし→あり・高さ違い）は読み直す。
 */
import { Assets, Container, Texture, TilingSprite } from 'pixi.js'
import type { FloorState } from './GameState'
import { clampFloorHeight, computeFloorPlacement, resolveAssetUrl } from './novelLayout'
import { LayerTurn, type StageTurnRun } from './stageTurn'

/**
 * 床のタイル（`TilingSprite`）を、回転舞台 (#704 第2弾) の mesh に貼れる 1 枚のテクスチャへ焼く。
 * 描画可能な元画像（ブラウザの画像・ImageBitmap・canvas）でなければ null（呼び出し側は元テクスチャで代用する）。
 */
export function bakeFloorTexture(
  texture: Texture,
  width: number,
  height: number,
  tileScale: number
): Texture | null {
  try {
    if (typeof document === 'undefined') return null
    const resource = texture.source?.resource as unknown
    if (!resource || ArrayBuffer.isView(resource)) return null
    const k = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(width * k))
    canvas.height = Math.max(1, Math.ceil(height * k))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const tileW = texture.width * tileScale * k
    const tileH = texture.height * tileScale * k
    if (!(tileW > 0) || !(tileH > 0)) return null
    for (let x = 0; x < canvas.width; x += tileW) {
      ctx.drawImage(resource as CanvasImageSource, x, 0, tileW, tileH)
    }
    return Texture.from(canvas)
  } catch {
    return null
  }
}

export class FloorLayer extends Container {
  private sprite: TilingSprite | null = null
  private current: FloorState | null = null
  /** show() で使った assetBaseUrl（同一判定用。空なら読み込んでいない）。 */
  private shownBaseUrl = ''
  /** 画像のロードが進行中か（現世代）。 */
  private loading = false
  /** 非同期ロードの世代。show()/clear() ごとに進め、古いロード完了を無視する。 */
  private generation = 0
  /** これまでにロードした画像 URL（GPU テクスチャのリーク防止用。StageFrontLayer.loadedUrls と同じ流儀）。 */
  private loadedUrls: Set<string> = new Set()
  /** 回転舞台 (#704 第2弾) への参加。 */
  private readonly turn = new LayerTurn(this, () => this.endStageTurn())
  /** 回転舞台の新面として予約したトークン。 */
  private turnToken: number | null = null

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number
  ) {
    super()
    // 床そのものはクリックしても何も起きない（誤タップで本文が進むのを防ぐ。他の演出レイヤーと同じ）。
    this.eventMode = 'none'
  }

  /**
   * 床を表示する。既存の床があれば置換する（単一スロット）。`height` は画面高さに対する帯の比
   * （`clampFloorHeight` で範囲に寄せる。未指定・不正値は既定）。`assetBaseUrl` が空なら読み込まない
   * （他レイヤーの同種ガードと同じ。状態は記録するので `getState()` には載る）。
   */
  show(path: string, height: number | undefined, assetBaseUrl: string): void {
    this.clear()
    const h = clampFloorHeight(height)
    this.current = { path, height: h }
    this.shownBaseUrl = assetBaseUrl
    if (!assetBaseUrl) return

    const gen = this.generation
    const url = resolveAssetUrl(assetBaseUrl, 'images', path)
    // 回転舞台 (#704 第2弾) の裏側の指定なら新面として予約する（ロードが終わるまで回転は始まらない）。
    this.turnToken = this.turn.run?.expectNew() ?? null
    this.loading = true
    Assets.load(url)
      .then((texture: Texture) => {
        // 読み込み中に clear() や次の show() が来ていたら無視する（古い応答の race 防止）。
        if (gen !== this.generation) return
        this.loading = false
        this.loadedUrls.add(url)
        const placement = computeFloorPlacement(
          texture.width,
          texture.height,
          this.screenWidth,
          this.screenHeight,
          h
        )
        if (!placement) {
          this.failTurnToken()
          return
        }
        const sprite = new TilingSprite({
          texture,
          width: placement.width,
          height: placement.height,
        })
        sprite.tileScale.set(placement.tileScale, placement.tileScale)
        sprite.x = placement.x
        sprite.y = placement.y
        this.sprite = sprite
        const run = this.turn.run
        const host = this.turn.host
        if (this.turnToken != null && run && host) {
          // 回転舞台の新面。回転が終わるまで sprite は載せず、焼いたタイルを mesh の素材として run へ渡す。
          const token = this.turnToken
          this.turnToken = null
          const baked = bakeFloorTexture(
            texture,
            placement.width,
            placement.height,
            placement.tileScale
          )
          run.resolveNew(
            token,
            host,
            baked ?? texture,
            {
              x: placement.x + placement.width / 2,
              y: placement.y + placement.height / 2,
              width: placement.width,
              height: placement.height,
            },
            0,
            { ownedTexture: baked }
          )
          return
        }
        this.addChild(sprite)
      })
      .catch((err: unknown) => {
        if (gen === this.generation) {
          this.loading = false
          this.failTurnToken()
        }
        console.warn('[name-name] 床の読み込みに失敗: ' + url, err)
      })
  }

  /** 床を消す（`[床: なし]` / `[場面転換]` / 新規開始 / 終劇 / 破棄）。Sprite を解放する。 */
  clear(): void {
    // 回転舞台 (#704 第2弾) の最中なら打ち切る（場面転換・復元・新規開始は最終状態へ即時）。
    this.turn.interrupt()
    this.failTurnToken()
    this.generation++
    if (this.sprite) {
      this.sprite.removeFromParent()
      // texture は PixiJS の Assets キャッシュが保有するので破棄しない（StageFrontLayer.clear と同じ流儀）。
      this.sprite.destroy()
      this.sprite = null
    }
    this.current = null
    this.shownBaseUrl = ''
    this.loading = false
  }

  /**
   * 完成済みスナップショット（`NovelGameState.floor`）へ宣言的に復元する（goBack/seekTo/セーブ復元/任意局面起動）。
   * 表示中の床と同一ならそのまま残す（再読み込みしない）。保存状態は最終状態のまま（ADR-0002）。
   * 宣言（パス・高さ）が同じでも、実際に表示できていない（assetBaseUrl が空だった・読み込み失敗・assetBaseUrl が
   * 差し替わった）ときは show し直す。
   */
  restore(state: FloorState | null, assetBaseUrl: string): void {
    // 復元は最終状態へ即時（進行中の回転舞台 (#704 第2弾) は畳む）。
    this.turn.interrupt()
    if (!state) {
      this.clear()
      return
    }
    if (this.isShowing(state, assetBaseUrl)) return
    this.show(state.path, state.height, assetBaseUrl)
  }

  private isShowing(state: FloorState, assetBaseUrl: string): boolean {
    const cur = this.current
    if (!cur || cur.path !== state.path || cur.height !== clampFloorHeight(state.height)) {
      return false
    }
    if (!assetBaseUrl || assetBaseUrl !== this.shownBaseUrl) return false
    // 読み込み失敗（404・デコード失敗）は sprite も loading も無い → 表示できていない扱いで再読み込みする。
    // restore はイベント時（goBack・seek・復元）にしか呼ばれないので、失敗が続いても無限にリロードはしない。
    return this.sprite !== null || this.loading
  }

  /**
   * 回転舞台 `[舞台回転]` (#704 第2弾)。いま表示している床（旧面）を `run` に渡して空になる。
   * 以後の `show()` は新面で、ロードが終わるまで・回転が終わるまで画面に載せない。
   */
  beginStageTurn(run: StageTurnRun): void {
    const host = this.turn.begin(run)
    const sprite = this.sprite
    if (sprite) {
      const width = sprite.width
      const height = sprite.height
      const geometry = { x: sprite.x + width / 2, y: sprite.y + height / 2, width, height }
      const baked = bakeFloorTexture(sprite.texture, width, height, sprite.tileScale.y)
      run.addOld(host, baked ?? sprite.texture, geometry, 0, { ownedTexture: baked })
    }
    // 旧い床と読み込み中の床を手放す。
    this.generation++
    if (sprite) {
      sprite.removeFromParent()
      sprite.destroy()
    }
    this.sprite = null
    this.current = null
    this.shownBaseUrl = ''
    this.loading = false
    this.turnToken = null
  }

  /** 回転が終わった／打ち切られた。新面の sprite を載せる（ロード中のものは完了時に即座に載る）。 */
  private endStageTurn(): void {
    this.turnToken = null
    if (this.sprite && !this.sprite.parent) this.addChild(this.sprite)
  }

  private failTurnToken(): void {
    if (this.turnToken == null) return
    const token = this.turnToken
    this.turnToken = null
    this.turn.run?.failNew(token)
  }

  /** 現在の床を settled state として返す。ロードの成否に関わらず宣言された事実を返す（ADR-0002）。 */
  getState(): FloorState | null {
    return this.current ? { ...this.current } : null
  }

  /** 画像の帯が載っているか（テスト・検証用）。 */
  hasImage(): boolean {
    return this.sprite !== null
  }

  /**
   * これまでにロードした画像 URL を PixiJS の Assets キャッシュから解放する
   * （GPU テクスチャのリーク防止。`StageFrontLayer.disposeTextures` と同じ流儀・fire-and-forget）。
   */
  disposeTextures(): void {
    const urls = Array.from(this.loadedUrls)
    this.loadedUrls.clear()
    if (urls.length === 0) return
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err: unknown) => {
      console.warn('[name-name] 床テクスチャの解放に失敗', err)
    })
  }
}
