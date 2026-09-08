/**
 * 背景板レイヤー (#683)。
 *
 * シアターモード舞台構造（docs/architecture.md「シアターモード構想」節）の
 * `[背景板: path, depth: N]` を管理する専用レイヤークラス（`CharacterLayer`/`TelopLayer` と
 * 同じ設計パターン）。既存の単一スロット背景（`NovelRenderer.setBackground` /
 * `Event::Background`）とは完全に独立した加算的な仕組み: 1シーン内に複数の `[背景板:]` を
 * 書けば、それぞれ別の板として蓄積される（`Background` の「新しいのが古いのを置き換える」
 * 単一スロット意味論とは異なる）。既存の単一画像背景システムには一切触れない。
 *
 * 各板は `computeCameraProjection`（#681/#682）が返す `scale`/`verticalOffset` を
 * `novelLayout.computeBoardPlacement` に通して配置する。ノベルモードは常に
 * `scale=1, verticalOffset=0` を返す（#681 の設計）ため、モード分岐をこのクラス内で
 * 自前実装する必要はない——`computeCameraProjection` の呼び出し元でモードを渡すだけで、
 * 全ての板が原寸で画面中心に重なって表示される（従来の背景切り替えと同じ見た目、後方互換）。
 * シアターモードでは depth が大きいほど縮小して表示され、遠近法の奥行きを表現する。
 *
 * depth の降順（大きい=奥が先）で Container の子要素順に反映し、奥の板から手前の板の順に
 * 描画されるようにする（PixiJS は子要素の配列順＝描画順、後から描画された方が手前に見える）。
 *
 * 板の追加時は「上から降りてくる」tween アニメーションを付ける（`novelLayout.ts` の
 * `computeBoardSlideInOffset` 純粋関数 + PixiJS の `TimeController` 駆動、`TelopLayer` と
 * 同じ設計パターン。doctrine 規律4: 計算はこのクラスに直書きせず純粋関数に切り出す）。
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

/** `getState()` の1要素。`NovelGameState.backgroundBoards` と同形（settled state）。 */
export interface BackgroundBoardState {
  path: string
  depth: number
}

interface BoardEntry {
  path: string
  depth: number
  /** テクスチャロード完了まで null。ロード失敗時も null のまま（見た目には出ないが settled state 上は存在する）。 */
  sprite: Sprite | null
  /**
   * ロード完了した `Texture` 自身の width/height。`sprite.texture.width/height` ではなくここに
   * `Assets.load()` が resolve した texture オブジェクトから直接控える
   * （`EventImageLayer.layoutSprite` と同じ流儀）。`new Sprite(texture)` 後に `sprite.texture` を
   * 読み直すのは避ける——テスト用の簡易 Texture モック等、実体が `Texture` インスタンスでない
   * 値を渡すと `Sprite` 側が正規化してしまい、期待した width/height を返さないケースがある。
   */
  textureWidth: number
  textureHeight: number
  /** clear()/destroy() 済みなら true。非同期ロード完了時にこれを見て古い応答を無視する。 */
  disposed: boolean
  /** layoutBoard() が最後に計算した最終位置(スライドイン中はここへ向けて補間する)。 */
  targetX: number
  targetY: number
  /** スライドイン中のみ非 null。TelopLayer の interval 駆動と同じ流儀。 */
  interval: number | null
  phaseStartedAtMs: number
}

export class BackgroundBoardLayer extends Container {
  private entries: BoardEntry[] = []
  private cameraMode: CameraMode = 'Novel'
  private cameraOrientation: CameraOrientation = 'Audience'
  private cameraElevation: CameraElevation | null = null
  /** これまでにロードした画像 URL（GPU テクスチャのリーク防止用。EventImageLayer.loadedUrls と同じ流儀）。 */
  private loadedUrls: Set<string> = new Set()

  constructor(
    private readonly screenWidth: number,
    private readonly screenHeight: number,
    private readonly time: TimeController = defaultTimeController
  ) {
    super()
    // 背景と同じく、板そのものはクリックしても何も起きない（誤タップで本文が進むのを防ぐ、
    // TelopLayer と同じ流儀）。
    this.eventMode = 'none'
  }

  /**
   * カメラ状態が変わったとき（`[カメラ:]` イベント処理）に呼ぶ。既存の全板を新しいカメラ状態で
   * 再配置する。カメラ切り替え自体は「板の追加」ではないため、スライドインは起こさず即座に
   * 新しい位置へ反映する（スライドイン中の板があれば、その場で新しい targetY へ向けて
   * 補間を続ける——updateSlideFrame が毎フレーム最新の targetY を読むため自然に追従する）。
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
      if (entry.sprite) this.layoutBoard(entry)
    }
  }

  /**
   * 板を1枚追加する（既存の板は消さない。加算的、#683）。
   * `assetBaseUrl` が空なら何もしない（他レイヤーの同種ガードと同じ）。
   * `opts.instant`（復元専用、goBack/seekTo/セーブ復元/任意局面起動）はスライドインを起こさず
   * 即座に最終位置へ配置する（ADR-0002: 演出の中間状態を復元しない）。
   */
  add(path: string, depth: number, assetBaseUrl: string, opts?: { instant?: boolean }): void {
    // 非有限値・負値はフロント側の最終防御としてクランプする（parser 側は非数値を 0.0 に
    // フォールバック済みだが、二重に守る。Issue #683 方針）。
    const clampedDepth = Number.isFinite(depth) ? Math.max(0, depth) : 0
    const entry: BoardEntry = {
      path,
      depth: clampedDepth,
      sprite: null,
      textureWidth: 0,
      textureHeight: 0,
      disposed: false,
      targetX: this.screenWidth / 2,
      targetY: this.screenHeight / 2,
      interval: null,
      phaseStartedAtMs: this.time.now(),
    }
    this.entries.push(entry)
    if (!assetBaseUrl) return

    const url = resolveAssetUrl(assetBaseUrl, 'images', path)
    Assets.load(url)
      .then((texture: Texture) => {
        // add() 後に clear()/destroy() された、または他の理由でこの entry が既に取り除かれて
        // いたら無視する（UAF / race 防止。NovelRenderer.setBackground の bgLoadToken と同じ懸念、
        // ここでは entry 自身の disposed フラグで足りる——単一 URL の再入がないため）。
        if (entry.disposed) return
        this.loadedUrls.add(url)
        entry.textureWidth = texture.width
        entry.textureHeight = texture.height
        const sprite = new Sprite(texture)
        sprite.anchor.set(0.5, 0.5)
        entry.sprite = sprite
        this.insertSorted()
        this.layoutBoard(entry)
        if (opts?.instant) {
          sprite.y = entry.targetY
        } else {
          entry.phaseStartedAtMs = this.time.now()
          this.startSlideIn(entry)
        }
      })
      .catch((err: unknown) => {
        console.warn('[name-name] 背景板の読み込みに失敗: ' + url, err)
      })
  }

  /**
   * 全ての板を即座に消去する（`[場面転換]` / 新しいシーンの開始時）。既存の単一画像背景の
   * `clearBackground()` と対になる操作——`processDirective` の `SceneTransition` 分岐、
   * `resetAndStartEvents` の非 preserve 分岐から呼ばれる想定。フェード等の退場演出は持たない
   * （Issue #683 のスコープはスライドイン＝追加時の演出のみ）。
   */
  clear(): void {
    for (const entry of this.entries) {
      this.stopInterval(entry)
      entry.disposed = true
      if (entry.sprite) {
        entry.sprite.removeFromParent()
        // texture は PixiJS の Assets キャッシュが保有するので破棄しない
        // （EventImageLayer.destroySprite / NovelRenderer.destroyBackgroundEntry と同じ流儀）。
        entry.sprite.destroy()
        entry.sprite = null
      }
    }
    this.entries = []
  }

  /**
   * 完成済みスナップショット（`NovelGameState.backgroundBoards`）へ宣言的に復元する
   * （goBack/seekTo/セーブ復元/任意局面起動、#256 の `applyState` と同じ経路）。
   * 既存の板を全消去してから、渡された板をスライドインなし（`instant: true`）で積み直す。
   */
  restore(boards: readonly BackgroundBoardState[], assetBaseUrl: string): void {
    this.clear()
    for (const board of boards) {
      this.add(board.path, board.depth, assetBaseUrl, { instant: true })
    }
  }

  /** 現在の板リストを settled state として返す（`NovelGameState.backgroundBoards` 用）。
   *  テクスチャのロード中/失敗に関わらず、`add()` された事実（path/depth）をそのまま返す
   *  ——「今このシーンにどの板があるか」という宣言であり、描画の成否とは独立（ADR-0002）。 */
  getState(): BackgroundBoardState[] {
    return this.entries.map((e) => ({ path: e.path, depth: e.depth }))
  }

  /**
   * これまでにロードした画像 URL を PixiJS の Assets キャッシュから解放する
   * （GPU テクスチャのリーク防止。`EventImageLayer.disposeTextures` と同じ流儀・fire-and-forget）。
   * 呼び出し元（`NovelRenderer.setEvents()` / `destroy()`）が新しいイベント列の開始・
   * レンダラ破棄と同期させる責務を持つ。
   */
  disposeTextures(): void {
    const urls = Array.from(this.loadedUrls)
    this.loadedUrls.clear()
    if (urls.length === 0) return
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err: unknown) => {
      console.warn('[name-name] 背景板テクスチャの解放に失敗', err)
    })
  }

  /**
   * `entry.sprite` の位置・サイズをカメラ射影に基づいて再計算する。スライドイン中（interval
   * が動いている）の場合は `targetX/targetY` の更新だけ行い、実際の sprite.y は
   * `updateSlideFrame` が毎フレーム補間するので触らない（瞬間移動を避ける）。
   */
  private layoutBoard(entry: BoardEntry): void {
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
    entry.sprite.width = placement.width
    entry.sprite.height = placement.height
    entry.sprite.x = placement.x
    if (entry.interval == null) {
      entry.sprite.y = placement.y
    }
  }

  /**
   * depth 降順（大きい=奥）で Container の子要素順を再構築する。テクスチャ未ロードの板は
   * 対象外（sprite が無いので描画しようがない）。呼び出しごとに全件並べ直す（TelopLayer.relayout
   * と同じ「板の枚数は小さいので毎回組み直して構わない」割り切り）。
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

  private startSlideIn(entry: BoardEntry): void {
    if (!entry.sprite) return
    // 開始位置: 最終位置から画面の高さぶん上（画面外＝完全に見えない状態）。
    entry.sprite.y = entry.targetY - this.screenHeight
    entry.interval = this.time.setInterval(() => this.updateSlideFrame(entry), 16)
  }

  private updateSlideFrame(entry: BoardEntry): void {
    if (!entry.sprite) {
      this.stopInterval(entry)
      return
    }
    const elapsed = this.time.now() - entry.phaseStartedAtMs
    const offset = computeBoardSlideInOffset(elapsed, BOARD_SLIDE_IN_MS)
    entry.sprite.y = entry.targetY + offset * this.screenHeight
    if (elapsed >= BOARD_SLIDE_IN_MS) {
      entry.sprite.y = entry.targetY
      this.stopInterval(entry)
    }
  }

  private stopInterval(entry: BoardEntry): void {
    if (entry.interval != null) {
      this.time.clearInterval(entry.interval)
      entry.interval = null
    }
  }
}
