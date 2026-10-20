/**
 * Stage: 演出状態（背景・画面効果・カメラ3つ組・紙人形輪郭）を束ねる薄いコンポジタ (#828 7c)。
 *
 * `BackgroundController`（7a）と `ScreenEffectsController`（7b）の持ち主で、`cameraMode` / `cameraOrientation` /
 * `cameraElevation` / `paperDollOutline` の唯一の書き手でもある。`resetAndStartEvents` / `applyState` / `destroy` に
 * 重複していた「タイマー停止と演出消去」の分岐をここのメソッドに集め、レンダラ側の3メソッドは呼び出し列になる。
 * 複数モジュールをまたいでリセットしてよいのはこの3メソッドだけ（立ち絵・大道具・背景板・動画・テロップなど
 * 演出レイヤー以外はレンダラに残り、レンダラが前後で呼ぶ）。
 *
 * - `reset(policy)`: `resetAndStartEvents` の演出部。持ち越し判定は `CarryPolicy`（`carryPolicyFor` の戻り値）だけを見る。
 * - `restore(state)`: `applyState` の演出部。クリーンアップ（`reset` と同じ中間状態の消去）＋宣言的復元。
 * - `capture()`: `getSnapshot()` の演出部。セーブ形式（フィールド集合）は不変。
 * - `setCamera(...)` / `setPaperDollOutline(...)`: ディレクティブ処理・reset・restore が共有する唯一の更新口。
 * - `cancelAllTimers()` / `release()`: `destroy` の演出部。
 *
 * カメラ・紙人形輪郭は立ち絵・大道具・背景板が自前で保持する写しを持つため、更新のたびに Host 経由で
 * それらへ伝える（伝える順序は旧実装どおり、輪郭は 立ち絵→大道具、カメラは 背景板→大道具→立ち絵）。
 */
import type { Container } from 'pixi.js'
import type { CameraElevation, CameraMode, CameraOrientation } from '../types'
import { BackgroundController, type BackgroundHost } from './BackgroundController'
import type { NovelGameState } from './GameState'
import type { PaperDollOutlineConfig } from './outlineFilter'
import { ScreenEffectsController, type ScreenEffectsHost } from './ScreenEffectsController'
import type { CarryPolicy } from './sceneEntry'
import type { TimeController } from './TimeController'

/** Stage が外へ出す依存。背景・画面効果の Host に、カメラ・輪郭の伝播先を足したもの。 */
export interface StageHost extends BackgroundHost, ScreenEffectsHost {
  /** カメラ3つ組を背景板・大道具・立ち絵へ伝える（この順）。 */
  applyCamera(
    mode: CameraMode,
    orientation: CameraOrientation,
    elevation: CameraElevation | null
  ): void
  /** 紙人形輪郭を立ち絵・大道具へ伝える（この順）。 */
  applyPaperDollOutline(config: PaperDollOutlineConfig | null): void
}

/** `capture()` / `restore()` が扱うセーブ形式の演出フィールド集合。 */
export type StageState = Pick<
  NovelGameState,
  | 'backgroundPath'
  | 'backgroundColor'
  | 'backgroundFade'
  | 'backgroundBrightness'
  | 'isBlackout'
  | 'cameraMode'
  | 'cameraOrientation'
  | 'cameraElevation'
  | 'paperDollOutline'
>

export class Stage {
  readonly background: BackgroundController
  readonly effects: ScreenEffectsController

  private _cameraMode: CameraMode = 'Novel'
  private _cameraOrientation: CameraOrientation = 'Audience'
  private _cameraElevation: CameraElevation | null = null
  private _paperDollOutline: PaperDollOutlineConfig | null = null

  constructor(
    private readonly host: StageHost,
    time: TimeController
  ) {
    this.background = new BackgroundController(host, time)
    this.effects = new ScreenEffectsController(host, time)
  }

  // --- 状態の読み取り ---

  /** カメラモード (#681)。`Novel` のとき向き・仰角は意味を持たない。 */
  get cameraMode(): CameraMode {
    return this._cameraMode
  }
  get cameraOrientation(): CameraOrientation {
    return this._cameraOrientation
  }
  get cameraElevation(): CameraElevation | null {
    return this._cameraElevation
  }
  get paperDollOutline(): PaperDollOutlineConfig | null {
    return this._paperDollOutline
  }

  // --- 更新口 ---

  /** カメラ3つ組を更新し、背景板・大道具・立ち絵へ伝える（`[カメラ:]` ディレクティブ・reset・restore 共通）。 */
  setCamera(
    mode: CameraMode,
    orientation: CameraOrientation,
    elevation: CameraElevation | null
  ): void {
    this._cameraMode = mode
    this._cameraOrientation = orientation
    this._cameraElevation = elevation
    this.host.applyCamera(mode, orientation, elevation)
  }

  /** 紙人形輪郭を更新し、立ち絵・大道具へ伝える（`[紙人形輪郭:]` ディレクティブ・reset・restore 共通）。 */
  setPaperDollOutline(config: PaperDollOutlineConfig | null): void {
    this._paperDollOutline = config
    this.host.applyPaperDollOutline(config)
  }

  // --- 組み立て ---

  /** 下地ベタと背景画像コンテナを積む。z 順（背景板・動画より下）のため、画面効果とは別に呼ぶ。 */
  attachBackground(stage: Container): void {
    this.background.attachTo(stage)
  }

  /** スクリム・暗転・画面効果オーバーレイを積む（立ち絵・イベント絵より上、ダイアログより下）。 */
  attachEffects(stage: Container): void {
    this.effects.attachTo(stage)
  }

  // --- リセット・出し入れ ---

  /**
   * 新しいイベント列の開始 (`resetAndStartEvents`) の演出部。順序:
   * 1) 揺れ・フラッシュ/フェードのタイマー停止とオーバーレイ消去（stage 位置は戻さない＝#913 の現状維持）
   * 2) 背景: 持ち越すなら進行中のロードを無効化しクロスフェードを畳む／持ち越さないなら背景・地色を捨てる
   *    （ロード無効化のトークンはどちらの経路でも進む。持ち越し時は `cancelPendingLoad` 単独、
   *     非持ち越しは `clearBackground`→`forgetBackground` の中。旧実装と同じ）
   * 3) 紙人形輪郭: 持ち越さないときだけ通常表示へ戻す
   * 4) 暗転解除 → カメラ既定 → スクリム退避状態のリセット
   * 持ち越し判定は `policy.preserveBackgroundForTransition` だけを見る（個別フラグを増やさない）。
   * `policy.carryBgm` は音声の持ち越しでありレンダラが扱う。
   */
  reset(policy: CarryPolicy): void {
    this.effects.reset()
    if (policy.preserveBackgroundForTransition) {
      this.background.cancelPendingLoad()
      this.background.finishBackgroundCrossfadeInstant()
    } else {
      this.background.clearBackground()
      this.background.clearBackgroundColor()
      this.setPaperDollOutline(null)
    }
    this.effects.setBlackout(false)
    this.setCamera('Novel', 'Audience', null)
    this.effects.resetNovelScrimState()
  }

  /** `getSnapshot()` の演出部分。クロスフェード・揺れ・フラッシュなどの中間状態は含まない。 */
  capture(): StageState {
    return {
      ...this.background.capture(),
      ...this.effects.capture(),
      cameraMode: this._cameraMode,
      cameraOrientation: this._cameraOrientation,
      cameraElevation: this._cameraElevation,
      paperDollOutline: this._paperDollOutline,
    }
  }

  /**
   * `applyState`（goBack / seekTo / セーブ復元 / 任意局面起動）の演出部。`reset` と違い持ち越しはなく、
   * 画面効果・スクリム退避の中間状態と揺れの stage 位置を消してから、状態どおりに宣言的に復元する
   * （背景画像 → 地色 → 暗転 → 輪郭 → カメラ）。復元は即時反映でフェードしない。
   */
  restore(state: StageState): void {
    this.effects.reset()
    this.effects.resetStagePosition()
    this.effects.resetNovelScrimState()
    this.background.restore(state)
    this.effects.restore(state)
    this.setPaperDollOutline(state.paperDollOutline)
    this.setCamera(state.cameraMode, state.cameraOrientation, state.cameraElevation)
  }

  // --- 破棄 ---

  /** `destroy()` の部品。背景クロスフェード・揺れ・フラッシュ/フェード・スクリム退避/フェードのタイマーをすべて止める。 */
  cancelAllTimers(): void {
    this.effects.stopAllTimers()
    this.background.cancelTimers()
  }

  /** `destroy()` の部品。背景テクスチャを解放し、背景 entry（canvas 由来マスクを含む）を全て破棄する。 */
  release(): void {
    this.background.releaseTextures()
    this.background.clearBackgroundEntries()
  }
}
