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
 * （`奥 ← 背景板（depth複数）← キャラ ← 大道具（depth複数）← 手前`、「レイヤーモデル」節）。
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
import { Assets, Container, Sprite, type Filter, type Texture } from 'pixi.js'
import type { OutlineFilter } from 'pixi-filters'
import type { CameraElevation, CameraMode, CameraOrientation } from '../types'
import { computeCameraProjection } from './cameraProjection'
import {
  BOARD_SLIDE_IN_MS,
  computeBoardPlacement,
  clampFadeMs,
  computeBoardSlideInOffset,
  resolveAssetUrl,
} from './novelLayout'
import { createPaperDollOutlineFilter, type PaperDollOutlineConfig } from './outlineFilter'
import { TimeController, defaultTimeController } from './TimeController'
import {
  BoardFaceFlipRun,
  isBoardFaceFlipEnabled,
  prefersReducedMotion,
  type BoardFaceGeometry,
} from './boardFaceFlip'
import { LayerTurn, type StageTurnRun } from './stageTurn'

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
  /**
   * 面の切り替え (#704)。差し替え元の旧い面の sprite。新しい面のロードが終わるまで画面に残り、
   * 回転（または即時切替）の開始で手放す。通常の追加では null。
   */
  pendingOld: Sprite | null
  /** `pendingOld` の元テクスチャ寸法（ロード待ち中のカメラ変更で再配置するため）。 */
  pendingOldTextureWidth: number
  pendingOldTextureHeight: number
  /** この差し替えをスキップ前進中に受けたか（回転を出さず即時切替）。 */
  flipSkip: boolean
  /** 回転の所要時間（ms）。差し替え時に確定する。 */
  flipDurationMs: number
  /** 回転中のみ非 null。旧面・新面の mesh を持ち、`sprite` は回転が終わるまで画面に出さない。 */
  run: BoardFaceFlipRun | null
  flipInterval: number | null
  /** 回転舞台 (#704 第2弾) の新面として予約したトークン。ロード完了で `run.resolveNew`、失敗で `failNew`。 */
  turnToken: number | null
  /** 回転舞台の新面としてロード済み。回転が終わるまで画面（layer の子）に載せない。 */
  turnHold: boolean
  /** 回転舞台が先に終わった／打ち切られた。ロード完了時にスライドインを付けず即座に置く。 */
  instantOnLoad: boolean
}

export class PropLayer extends Container {
  private entries: PropEntry[] = []
  private cameraMode: CameraMode = 'Novel'
  private cameraOrientation: CameraOrientation = 'Audience'
  private cameraElevation: CameraElevation | null = null
  /** これまでにロードした画像 URL（GPU テクスチャのリーク防止用。BackgroundBoardLayer.loadedUrls と同じ流儀）。 */
  private loadedUrls: Set<string> = new Set()
  /** 面の切り替え (#704) の既定の所要時間（`character_fade_ms` と同じ値。NovelRenderer が同期する）。 */
  private flipDefaultMs = 700
  /** 動画書き出し中か (#350)。書き出し中は回さない。 */
  private exporting = false
  /** 回転舞台 (#704 第2弾) への参加。旧面を `run` に渡して空になり、新面のロード完了を `run` に伝える。 */
  private readonly turn = new LayerTurn(this, () => this.endStageTurn())
  /**
   * 紙人形風の輪郭 (#699)。`setPaperDollOutline()`（`[紙人形輪郭:]` イベント処理 / applyState
   * 復元）でしか同期されない。`null` = 輪郭なし（既定）。`CharacterLayer` と異なりこのレイヤーの
   * スプライトには他にフィルタ運用が無いため、`sprite.filters = [filter] / null` の直代入でよい。
   */
  private paperDollOutlineFilter: OutlineFilter | null = null

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
    // mode・向き・仰角が変わったときだけ回転を打ち切る。ズームだけの変更は setCamera の引数が
    // 変わらず、ズームはレイヤーのコンテナに掛かって mesh にも効くので、回転は続ける。
    const changed =
      mode !== this.cameraMode ||
      orientation !== this.cameraOrientation ||
      elevation !== this.cameraElevation
    this.cameraMode = mode
    this.cameraOrientation = orientation
    this.cameraElevation = elevation
    // 回転舞台 (#704 第2弾) もカメラ（mode/向き/仰角）が変わると打ち切って最終状態へ。ズームだけなら続ける。
    if (changed) this.turn.finish()
    for (const entry of this.entries) {
      // 回転中にカメラが変わったら回転を打ち切って最終状態へ（旧面の配置を追従させない）。
      if (changed && entry.run) this.finishFlip(entry)
      if (entry.sprite) this.layoutProp(entry)
      // ロード待ちの旧面（pendingOld）も新しいカメラの射影位置へ置き直す。
      if (entry.pendingOld && entry.pendingOldTextureWidth > 0) {
        const placement = computeBoardPlacement(
          entry.pendingOldTextureWidth,
          entry.pendingOldTextureHeight,
          this.screenWidth,
          this.screenHeight,
          computeCameraProjection(
            this.cameraMode,
            this.cameraOrientation,
            this.cameraElevation,
            entry.depth
          )
        )
        entry.pendingOld.width = placement.width
        entry.pendingOld.height = placement.height
        entry.pendingOld.x = placement.x
        entry.pendingOld.y = placement.y
      }
    }
  }

  /** 面の切り替え (#704) の既定の所要時間（ms）を設定する。`character_fade_ms` と同じ値を渡す。 */
  setFlipDefaultMs(ms: number | null | undefined): void {
    this.flipDefaultMs = clampFadeMs(ms, 700)
  }

  /** 動画書き出しの開始/終了を通知する (#704)。開始時に進行中の回転は最終状態へ即時に畳む。 */
  setExporting(exporting: boolean): void {
    this.exporting = exporting
    if (!exporting) return
    this.turn.finish()
    for (const entry of this.entries) {
      if (entry.run) this.finishFlip(entry)
    }
  }

  /**
   * 紙人形風の輪郭 (#699) を設定する。`[紙人形輪郭:]` イベント処理 / applyState 復元から呼ぶ。
   * `null` は解除。現在ロード済みの全大道具へ即座に反映し、以後 `add()` でロードされる大道具にも
   * 自動適用される（スコープはキャラクター個別ではなくシナリオ全体、`CharacterLayer` と同じ
   * Issue #699 方針）。
   */
  setPaperDollOutline(config: PaperDollOutlineConfig | null): void {
    this.paperDollOutlineFilter = config ? createPaperDollOutlineFilter(config) : null
    for (const entry of this.entries) {
      const filters = this.paperDollOutlineFilter ? [this.paperDollOutlineFilter] : null
      if (entry.sprite) entry.sprite.filters = filters
      if (entry.pendingOld) entry.pendingOld.filters = filters
      entry.run?.setFilters(filters)
    }
    // 回転舞台 (#704 第2弾) の mesh にも輪郭を追従させる。
    if (this.turn.host) {
      this.turn.run?.setFilters(
        this.turn.host,
        this.paperDollOutlineFilter ? [this.paperDollOutlineFilter] : null
      )
    }
  }

  /**
   * 大道具を1つ追加する（既存のものは消さない。加算的）。
   * `assetBaseUrl` が空なら何もしない（他レイヤーの同種ガードと同じ）。
   * `opts.instant`（復元専用、goBack/seekTo/セーブ復元/任意局面起動）はスライドインを起こさず
   * 即座に最終位置へ配置する（ADR-0002: 演出の中間状態を復元しない）。
   */
  add(path: string, depth: number, assetBaseUrl: string, opts?: { instant?: boolean }): void {
    // 回転舞台の最中の再指定は先の回転を最終状態へ畳む（裏側の指定の流し込み中だけは畳まない）。
    this.turn.interrupt()
    const entry = this.createEntry(path, depth)
    // 回転舞台 (#704 第2弾) の裏側の指定なら新面として予約する（ロードが終わるまで回転は始まらない）。
    entry.turnToken = this.turn.run?.expectNew() ?? null
    this.entries.push(entry)
    this.load(entry, assetBaseUrl, opts?.instant === true)
  }

  /**
   * 同じ depth の `fromPath` の大道具を `path` の面へ差し替える (#704)。加算せず、旧い面の位置に
   * 新しい面が入る（`getState()` は直ちに新しい面になる）。シアターモードでは板の Y 軸回転で
   * 切り替え、ノベル・スキップ・動画書き出し・prefers-reduced-motion では即時に入れ替える。
   * 該当する大道具が無ければ通常の追加（`add`）として扱う。
   *
   * 新しい面のロードが終わるまで旧い面は画面に残る。ロード中にさらに差し替え・撤去が来ても
   * 旧い面は残り続けず、最後に指定した面だけが残る（#952 と同種の競合）。
   */
  replace(
    path: string,
    depth: number,
    fromPath: string,
    assetBaseUrl: string,
    opts?: { flipMs?: number | null; skip?: boolean }
  ): void {
    this.turn.interrupt()
    const clampedDepth = Number.isFinite(depth) ? Math.max(0, depth) : 0
    let index = -1
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e.path === fromPath && e.depth === clampedDepth) {
        index = i
        break
      }
    }
    if (index >= 0 && this.turn.active) {
      // 回転舞台の最中の `回転:` は個別の面の切り替えにしない。同じ舞台の裏側で指定済みの板を差し替えるだけ。
      this.dropEntry(index)
      this.add(path, depth, assetBaseUrl)
      return
    }
    if (index < 0) {
      this.add(path, depth, assetBaseUrl)
      return
    }
    const old = this.entries[index]
    // 旧い面を引き継ぐ。回転中なら打ち切って新面側の sprite を、ロード待ちなら待っている旧面を。
    if (old.run) this.finishFlip(old)
    const oldFace = old.sprite ?? old.pendingOld
    const oldTexW = old.sprite ? old.textureWidth : old.pendingOldTextureWidth
    const oldTexH = old.sprite ? old.textureHeight : old.pendingOldTextureHeight
    old.pendingOld = null
    old.disposed = true
    // スライドイン中の旧面は宙の位置で固まらないよう、最終配置へスナップしてから止める。
    if (old.interval != null && old.sprite) {
      old.sprite.width = old.targetWidth
      old.sprite.height = old.targetHeight
      old.sprite.x = old.targetX
      old.sprite.y = old.targetY
    }
    this.stopInterval(old)
    if (old.sprite) {
      // 引き継いだ sprite は新しい entry の pendingOld になる（destroy しない）。
      old.sprite = null
    }
    const entry = this.createEntry(path, depth)
    entry.pendingOld = oldFace
    entry.pendingOldTextureWidth = oldTexW
    entry.pendingOldTextureHeight = oldTexH
    entry.flipSkip = opts?.skip === true
    entry.flipDurationMs = clampFadeMs(opts?.flipMs, this.flipDefaultMs)
    this.entries[index] = entry
    this.load(entry, assetBaseUrl, false)
  }

  /**
   * 回転舞台 `[舞台回転]` (#704 第2弾)。いま表示している板（旧面）を全て `run` に渡して空になる。
   * 以後 `add()` された板は新面で、ロードが終わるまで・回転が終わるまで画面に載せない。
   */
  beginStageTurn(run: StageTurnRun): void {
    const host = this.turn.begin(run)
    const filters = this.turnFilters()
    for (const entry of this.entries) {
      if (entry.run) this.finishFlip(entry)
      const sprite = entry.sprite
      const face = sprite ?? entry.pendingOld
      if (face && !entry.disposed) {
        // スライドイン中は最終位置を旧面の配置とする（宙の位置で固めない）。
        const geometry = sprite
          ? {
              x: entry.targetX,
              y: entry.targetY,
              width: entry.targetWidth,
              height: entry.targetHeight,
            }
          : { x: face.x, y: face.y, width: face.width, height: face.height }
        run.addOld(host, face.texture, geometry, entry.depth, { filters })
      }
      this.releaseEntry(entry)
    }
    this.entries = []
    this.removeChildren()
    this.addChild(host)
  }

  /** 面の切り替え (#704 第1弾) の回転中、または新しい面のロード待ちの板があるか（`[待機: 表示完了]` が待つ）。 */
  hasPendingFlip(): boolean {
    return this.entries.some((e) => !e.disposed && (e.run !== null || e.pendingOld !== null))
  }

  /** 回転が終わった／打ち切られた。新面の sprite を載せ、まだロード中の板は即座に置くようにする。 */
  private endStageTurn(): void {
    for (const entry of this.entries) {
      entry.turnHold = false
      if (entry.turnToken != null) {
        entry.turnToken = null
        entry.instantOnLoad = true
      }
    }
    this.insertSorted()
  }

  private failTurnToken(entry: PropEntry): void {
    if (entry.turnToken == null) return
    const token = entry.turnToken
    entry.turnToken = null
    this.turn.run?.failNew(token)
  }

  /** 回転舞台の最中に、裏側で指定済みの板を取り除く（同じ舞台の中での差し替え）。 */
  private dropEntry(index: number): void {
    const [entry] = this.entries.splice(index, 1)
    if (entry.turnToken != null) {
      const token = entry.turnToken
      entry.turnToken = null
      this.turn.run?.failNew(token)
    }
    this.releaseEntry(entry)
    this.insertSorted()
  }

  /** 板の sprite・タイマーを手放す（texture は Assets キャッシュが持つので破棄しない）。 */
  private releaseEntry(entry: PropEntry): void {
    this.stopInterval(entry)
    this.stopFlipInterval(entry)
    entry.disposed = true
    entry.run?.dispose()
    entry.run = null
    for (const sprite of [entry.pendingOld, entry.sprite]) {
      if (sprite) {
        sprite.removeFromParent()
        sprite.destroy()
      }
    }
    entry.pendingOld = null
    entry.sprite = null
  }

  private turnFilters(): Filter[] | null {
    return this.paperDollOutlineFilter ? [this.paperDollOutlineFilter] : null
  }

  private createEntry(path: string, depth: number): PropEntry {
    // 非有限値・負値はフロント側の最終防御としてクランプする（parser 側は非数値を 0.0 に
    // フォールバック済みだが、二重に守る）。
    const clampedDepth = Number.isFinite(depth) ? Math.max(0, depth) : 0
    return {
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
      pendingOld: null,
      pendingOldTextureWidth: 0,
      pendingOldTextureHeight: 0,
      flipSkip: false,
      flipDurationMs: this.flipDefaultMs,
      run: null,
      flipInterval: null,
      turnToken: null,
      turnHold: false,
      instantOnLoad: false,
    }
  }

  private load(entry: PropEntry, assetBaseUrl: string, instant: boolean): void {
    if (!assetBaseUrl) {
      this.failTurnToken(entry)
      return
    }

    const url = resolveAssetUrl(assetBaseUrl, 'images', entry.path)
    Assets.load(url)
      .then((texture: Texture) => {
        // add()/replace() 後に clear() や次の replace() でこの entry が取り除かれていたら無視する
        // （UAF / race 防止。旧面の sprite は取り除いた側が引き継ぐか破棄している）。
        if (entry.disposed) return
        this.loadedUrls.add(url)
        entry.textureWidth = texture.width
        entry.textureHeight = texture.height
        const sprite = new Sprite(texture)
        sprite.anchor.set(0.5, 0.5)
        // 紙人形輪郭 (#699): ロード完了時点で有効なら新規スプライトにも即座に適用する。
        if (this.paperDollOutlineFilter) sprite.filters = [this.paperDollOutlineFilter]
        entry.sprite = sprite
        this.layoutProp(entry)
        if (entry.turnToken != null && this.turn.run && this.turn.host) {
          // 回転舞台 (#704 第2弾) の新面。回転が終わるまで sprite は載せず、mesh の素材として run へ渡す。
          const token = entry.turnToken
          entry.turnToken = null
          entry.turnHold = true
          this.turn.run.resolveNew(
            token,
            this.turn.host,
            texture,
            {
              x: entry.targetX,
              y: entry.targetY,
              width: entry.targetWidth,
              height: entry.targetHeight,
            },
            entry.depth,
            { filters: this.turnFilters() }
          )
          return
        }
        const old = entry.pendingOld
        entry.pendingOld = null
        if (old) {
          // 面の切り替え (#704)。差し替えの新面はスライドインしない。
          this.swapFace(entry, old, texture)
        } else {
          this.insertSorted()
          if (instant || entry.instantOnLoad) {
            sprite.y = entry.targetY
          } else {
            entry.phaseStartedAtMs = this.time.now()
            this.startSlideIn(entry)
          }
        }
      })
      .catch((err: unknown) => {
        console.warn('[name-name] 大道具の読み込みに失敗: ' + url, err)
        this.failTurnToken(entry)
        // 新しい面が読めなかったら旧い面も残さない（宣言上は新しい面に差し替わっている）。
        if (!entry.disposed && entry.pendingOld) {
          entry.pendingOld.removeFromParent()
          entry.pendingOld.destroy()
          entry.pendingOld = null
        }
      })
  }

  /**
   * 旧い面 `old` を新しい面 `entry.sprite` へ切り替える (#704)。回転してよければ 2 枚の mesh で
   * 回し、そうでなければ即時に入れ替える。旧い面の sprite はここで手放す（destroy）。
   */
  private swapFace(entry: PropEntry, old: Sprite, newTexture: Texture): void {
    const sprite = entry.sprite
    if (!sprite) return
    const flip = isBoardFaceFlipEnabled({
      isTheater: this.cameraMode === 'Theater',
      skip: entry.flipSkip,
      exporting: this.exporting,
      reducedMotion: prefersReducedMotion(),
      durationMs: entry.flipDurationMs,
    })
    const oldTexture = old.texture
    const oldFace: BoardFaceGeometry = {
      x: old.x,
      y: old.y,
      width: old.width,
      height: old.height,
    }
    old.removeFromParent()
    old.destroy()
    if (!flip) {
      this.insertSorted()
      return
    }
    const newFace: BoardFaceGeometry = {
      x: entry.targetX,
      y: entry.targetY,
      width: entry.targetWidth,
      height: entry.targetHeight,
    }
    const now = this.time.now()
    const run = new BoardFaceFlipRun(
      oldTexture,
      newTexture,
      oldFace,
      newFace,
      now,
      entry.flipDurationMs
    )
    entry.run = run
    if (this.paperDollOutlineFilter) run.setFilters([this.paperDollOutlineFilter])
    this.insertSorted()
    run.update(now)
    entry.flipInterval = this.time.setInterval(() => this.tickFlip(entry), 16)
  }

  private tickFlip(entry: PropEntry): void {
    const run = entry.run
    if (!run || entry.disposed) {
      this.stopFlipInterval(entry)
      return
    }
    const now = this.time.now()
    if (run.isFinished(now)) {
      this.finishFlip(entry)
    } else {
      run.update(now)
    }
  }

  /** 回転を打ち切って最終状態（新しい面の sprite）にする。 */
  private finishFlip(entry: PropEntry): void {
    this.stopFlipInterval(entry)
    const run = entry.run
    if (!run) return
    entry.run = null
    run.dispose()
    this.insertSorted()
  }

  private stopFlipInterval(entry: PropEntry): void {
    if (entry.flipInterval != null) {
      this.time.clearInterval(entry.flipInterval)
      entry.flipInterval = null
    }
  }

  /**
   * 全ての大道具を即座に消去する（`[場面転換]` / 新しいシーンの開始時）。既存の単一画像背景の
   * `clearBackground()` / `BackgroundBoardLayer.clear()` と対になる操作。フェード等の退場演出は
   * 持たない（追加時のスライドインのみ）。
   */
  clear(): void {
    // 回転舞台 (#704 第2弾) の最中なら打ち切る（場面転換・復元・新規開始は最終状態へ即時）。
    this.turn.interrupt()
    for (const entry of this.entries) this.releaseEntry(entry)
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
      .filter((e) => (e.sprite !== null || e.pendingOld !== null) && !e.disposed && !e.turnHold)
      .sort((a, b) => b.depth - a.depth)
    this.removeChildren()
    for (const e of sorted) {
      if (e.run) {
        // 回転中は新旧 2 枚の mesh が sprite の代わりに描かれる (#704)。
        e.run.attach(this, this.children.length)
      } else if (e.sprite) {
        this.addChild(e.sprite)
      } else if (e.pendingOld) {
        // 新しい面のロード待ちの間は旧い面を残す (#704)。
        this.addChild(e.pendingOld)
      }
    }
    // 回転舞台 (#704 第2弾) の mesh は常に最前（このレイヤーの内側）に載せる。
    if (this.turn.host) this.addChild(this.turn.host)
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
