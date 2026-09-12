/**
 * 大道具レイヤー (#692)。
 *
 * シアターモード舞台構造（docs/architecture.md「シアターモード構想」節）の
 * `[大道具: path, depth: N]` を管理する専用レイヤークラス。`BackgroundBoardLayer`（#683）を
 * ほぼそのまま複製・改名したもので、API 形状（add/clear/restore/getState/setCamera/
 * disposeTextures）は同一。既存の単一スロット背景（`NovelRenderer.setBackground` /
 * `Event::Background`）・背景板（`Event::BackgroundBoard`）とは完全に独立した加算的な仕組み:
 * 1シーン内に複数の `[大道具:]` を書けば、それぞれ別の大道具として蓄積される。
 *
 * `BackgroundBoardLayer` との違いは、**数値 depth を共有する空間ではなく独立した PixiJS
 * レイヤー**として、キャラレイヤーより前面に配置される点
 * （`奥 ← 背景板（depth複数）← キャラ ← 小道具（depth複数）← 手前`、「レイヤーモデル」節）。
 * レイヤー自体の描画順（`NovelRenderer` での `addChild` 順）が奥行きの群を決め、このクラス
 * 内部での depth 降順ソートは同一レイヤー内（大道具どうし）の奥行きだけを扱う。
 *
 * 各大道具は `computeCameraProjection`（#681/#682）が返す `scale`/`verticalOffset` を
 * `novelLayout.computeBoardPlacement` に通して配置する。ノベルモードは常に
 * `scale=1, verticalOffset=0` を返す（#681 の設計）ため、モード分岐をこのクラス内で
 * 自前実装する必要はない——`computeCameraProjection` の呼び出し元でモードを渡すだけで、
 * 全ての大道具が原寸で画面中心に重なって表示される（従来どおりの見た目、後方互換）。
 * シアターモードでは depth が大きいほど縮小して表示され、遠近法の奥行きを表現する。
 *
 * depth の降順（大きい=奥が先）で Container の子要素順に反映し、奥の大道具から手前の大道具の順に
 * 描画されるようにする（PixiJS は子要素の配列順＝描画順、後から描画された方が手前に見える）。
 *
 * 追加時は「上から降りてくる」tween アニメーションを付ける（`novelLayout.ts` の
 * `computeBoardSlideInOffset` 純粋関数 + PixiJS の `TimeController` 駆動、`BackgroundBoardLayer`
 * と同じ設計パターン。doctrine 規律4: 計算はこのクラスに直書きせず純粋関数に切り出す）。
 * 復元（`restore()`、goBack/seekTo/セーブ復元/任意局面起動）は演出の中間状態を持たない
 * （ADR-0002）ため、スライドインを起こさず即座に最終位置へ配置する。
 */
import { Assets, Container, Sprite, type Texture } from 'pixi.js'
import type { CameraElevation, CameraMode, CameraOrientation } from '../types'
import { computeCameraProjection } from './cameraProjection'
import {
  BOARD_SLIDE_IN_MS,
  computeBoardPlacement,
  computeBoardSlideInOffset,
  resolveAssetUrl,
} from './novelLayout'
import { TimeController, defaultTimeController } from './TimeController'

/** `getState()` の1要素。`NovelGameState.props` と同形（settled state）。 */
export interface PropState {
  path: string
  depth: number
}

interface PropEntry {
  path: string
  depth: number
  /** テクスチャロード完了まで null。ロード失敗時も null のまま（見た目には出ないが settled state 上は存在する）。 */
  sprite: Sprite | null
  /**
   * ロード完了した `Texture` 自身の width/height。`sprite.texture.width/height` ではなくここに
   * `Assets.load()` が resolve した texture オブジェクトから直接控える
   * （`BackgroundBoardLayer` と同じ流儀）。
   */
  textureWidth: number
  textureHeight: number
  /** clear()/destroy() 済みなら true。非同期ロード完了時にこれを見て古い応答を無視する。 */
  disposed: boolean
  /** layoutProp() が最後に計算した最終位置・サイズ(スライドイン中はここへ向けて補間する)。 */
  targetX: number
  targetY: number
  /** layoutProp() が最後に計算した最終サイズ。スライドイン中は sprite.width/height に即座には
   *  反映せず、targetY と同じく updateSlideFrame() が毎フレーム反映する。 */
  targetWidth: number
  targetHeight: number
  /** スライドイン中のみ非 null。 */
  interval: number | null
  phaseStartedAtMs: number
}

export class PropLayer extends Container {
  private entries: PropEntry[] = []
  private cameraMode: CameraMode = 'Novel'
  private cameraOrientation: CameraOrientation = 'Audience'
  private cameraElevation: CameraElevation | null = null
  /** これまでにロードした画像 URL（GPU テクスチャのリーク防止用。BackgroundBoardLayer.loadedUrls と同じ流儀）。 */
  private loadedUrls: Set<string> = new Set()

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number,
    private readonly time: TimeController = defaultTimeController
  ) {
    super()
    // 背景板と同じく、大道具そのものはクリックしても何も起きない（誤タップで本文が進むのを防ぐ）。
    this.eventMode = 'none'
  }

  /**
   * カメラ状態が変わったとき（`[カメラ:]` イベント処理）に呼ぶ。既存の全大道具を新しいカメラ状態で
   * 再配置する。カメラ切り替え自体は「大道具の追加」ではないため、スライドインは起こさず即座に
   * 新しい位置へ反映する。
   */
  setCamera(
    mode: CameraMode,
    orientation: CameraOrientation,
    elevation: CameraElevation | null
  ): void {
    this.cameraMode = mode
    this.cameraOrientation = orientation
    this.cameraElevation = elevation
    for (const entry of this.entries) {
      if (entry.sprite) this.layoutProp(entry)
    }
  }

  /**
   * 大道具を1つ追加する（既存の大道具は消さない。加算的、#692）。
   * `assetBaseUrl` が空なら何もしない（他レイヤーの同種ガードと同じ）。
   * `opts.instant`（復元専用、goBack/seekTo/セーブ復元/任意局面起動）はスライドインを起こさず
   * 即座に最終位置へ配置する（ADR-0002: 演出の中間状態を復元しない）。
   */
  add(path: string, depth: number, assetBaseUrl: string, opts?: { instant?: boolean }): void {
    // 非有限値・負値はフロント側の最終防御としてクランプする（parser 側は非数値を 0.0 に
    // フォールバック済みだが、二重に守る。BackgroundBoardLayer と同じ方針）。
    const clampedDepth = Number.isFinite(depth) ? Math.max(0, depth) : 0
    const entry: PropEntry = {
      path,
      depth: clampedDepth,
      sprite: null,
      textureWidth: 0,
      textureHeight: 0,
      disposed: false,
      targetX: this.screenWidth / 2,
      targetY: this.screenHeight / 2,
      targetWidth: 0,
      targetHeight: 0,
      interval: null,
      phaseStartedAtMs: this.time.now(),
    }
    this.entries.push(entry)
    if (!assetBaseUrl) return

    const url = resolveAssetUrl(assetBaseUrl, 'images', path)
    Assets.load(url)
      .then((texture: Texture) => {
        // add() 後に clear()/destroy() された、または他の理由でこの entry が既に取り除かれて
        // いたら無視する（UAF / race 防止）。
        if (entry.disposed) return
        this.loadedUrls.add(url)
        entry.textureWidth = texture.width
        entry.textureHeight = texture.height
        const sprite = new Sprite(texture)
        sprite.anchor.set(0.5, 0.5)
        entry.sprite = sprite
        this.insertSorted()
        this.layoutProp(entry)
        if (opts?.instant) {
          sprite.y = entry.targetY
        } else {
          entry.phaseStartedAtMs = this.time.now()
          this.startSlideIn(entry)
        }
      })
      .catch((err: unknown) => {
        console.warn('[name-name] 大道具の読み込みに失敗: ' + url, err)
      })
  }

  /**
   * 全ての大道具を即座に消去する（`[場面転換]` / 新しいシーンの開始時）。既存の単一画像背景の
   * `clearBackground()` / `BackgroundBoardLayer.clear()` と対になる操作。フェード等の退場演出は
   * 持たない（追加時のスライドインのみ）。
   */
  clear(): void {
    for (const entry of this.entries) {
      this.stopInterval(entry)
      entry.disposed = true
      if (entry.sprite) {
        entry.sprite.removeFromParent()
        // texture は PixiJS の Assets キャッシュが保有するので破棄しない。
        entry.sprite.destroy()
        entry.sprite = null
      }
    }
    this.entries = []
  }

  /**
   * 完成済みスナップショット（`NovelGameState.props`）へ宣言的に復元する
   * （goBack/seekTo/セーブ復元/任意局面起動、#256 の `applyState` と同じ経路）。
   * 既存の大道具を全消去してから、渡された大道具をスライドインなし（`instant: true`）で積み直す。
   */
  restore(props: readonly PropState[], assetBaseUrl: string): void {
    this.clear()
    for (const prop of props) {
      this.add(prop.path, prop.depth, assetBaseUrl, { instant: true })
    }
  }

  /** 現在の大道具リストを settled state として返す（`NovelGameState.props` 用）。
   *  テクスチャのロード中/失敗に関わらず、`add()` された事実（path/depth）をそのまま返す
   *  ——「今このシーンにどの大道具があるか」という宣言であり、描画の成否とは独立（ADR-0002）。 */
  getState(): PropState[] {
    return this.entries.map((e) => ({ path: e.path, depth: e.depth }))
  }

  /**
   * これまでにロードした画像 URL を PixiJS の Assets キャッシュから解放する
   * （GPU テクスチャのリーク防止。`BackgroundBoardLayer.disposeTextures` と同じ流儀・fire-and-forget）。
   * 呼び出し元（`NovelRenderer.setEvents()` / `destroy()`）が新しいイベント列の開始・
   * レンダラ破棄と同期させる責務を持つ。
   */
  disposeTextures(): void {
    const urls = Array.from(this.loadedUrls)
    this.loadedUrls.clear()
    if (urls.length === 0) return
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err: unknown) => {
      console.warn('[name-name] 大道具テクスチャの解放に失敗', err)
    })
  }

  /**
   * `entry.sprite` の位置・サイズをカメラ射影に基づいて再計算する。スライドイン中（interval
   * が動いている）の場合は `targetX/targetY/targetWidth/targetHeight` の更新だけ行い、実際の
   * sprite.width/height/x/y は `updateSlideFrame` が毎フレーム反映するので触らない
   * （瞬間移動を避ける、`BackgroundBoardLayer.layoutBoard` と同じ配慮）。
   */
  private layoutProp(entry: PropEntry): void {
    if (!entry.sprite) return
    const projection = computeCameraProjection(
      this.cameraMode,
      this.cameraOrientation,
      this.cameraElevation,
      entry.depth
    )
    const placement = computeBoardPlacement(
      entry.textureWidth,
      entry.textureHeight,
      this.screenWidth,
      this.screenHeight,
      projection
    )
    entry.targetX = placement.x
    entry.targetY = placement.y
    entry.targetWidth = placement.width
    entry.targetHeight = placement.height
    if (entry.interval == null) {
      entry.sprite.width = placement.width
      entry.sprite.height = placement.height
      entry.sprite.x = placement.x
      entry.sprite.y = placement.y
    }
  }

  /**
   * depth 降順（大きい=奥）で Container の子要素順を再構築する。テクスチャ未ロードの大道具は
   * 対象外（sprite が無いので描画しようがない）。呼び出しごとに全件並べ直す
   * （`BackgroundBoardLayer.insertSorted` と同じ「点数は小さいので毎回組み直して構わない」割り切り）。
   */
  private insertSorted(): void {
    const sorted = [...this.entries]
      .filter((e) => e.sprite !== null && !e.disposed)
      .sort((a, b) => b.depth - a.depth)
    this.removeChildren()
    for (const e of sorted) {
      if (e.sprite) this.addChild(e.sprite)
    }
  }

  private startSlideIn(entry: PropEntry): void {
    if (!entry.sprite) return
    // 開始位置: 最終位置から画面の高さぶん上（画面外＝完全に見えない状態）。
    entry.sprite.y = entry.targetY - this.screenHeight
    entry.interval = this.time.setInterval(() => this.updateSlideFrame(entry), 16)
  }

  private updateSlideFrame(entry: PropEntry): void {
    if (!entry.sprite) {
      this.stopInterval(entry)
      return
    }
    const elapsed = this.time.now() - entry.phaseStartedAtMs
    const offset = computeBoardSlideInOffset(elapsed, BOARD_SLIDE_IN_MS)
    // width/height/x はスライドイン中に setCamera() 等で targetWidth/targetHeight/targetX が
    // 更新されていても layoutProp() が触らないため、y と同じタイミング（このフレーム）で
    // ここに反映する（BackgroundBoardLayer.updateSlideFrame と同じ配慮）。
    entry.sprite.width = entry.targetWidth
    entry.sprite.height = entry.targetHeight
    entry.sprite.x = entry.targetX
    entry.sprite.y = entry.targetY + offset * this.screenHeight
    if (elapsed >= BOARD_SLIDE_IN_MS) {
      entry.sprite.y = entry.targetY
      this.stopInterval(entry)
    }
  }

  private stopInterval(entry: PropEntry): void {
    if (entry.interval != null) {
      this.time.clearInterval(entry.interval)
      entry.interval = null
    }
  }
}
