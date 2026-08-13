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
 *
 * アンビエント演出 (#582): `[イベント絵: path, ゆらぎ=true, ビネット=true, グロー=true,
 * ろうそく=true]` で画像単位にオンにする、Gymnasia の「暗闇+オレンジ色のろうそく光+ゆらぎ+
 * ビネット」ルック向けフィルタチェーン。`sprite`/`glowSprite` を包む `imageGroup` に
 * ゆらぎ（`DisplacementFilter`, pixi.js core）・ビネット（自前 `VignetteFilter`）を掛け、
 * グローは同一テクスチャの複製 sprite を `pixi-filters` の `KawaseBlurFilter` で blur し
 * `blendMode: 'overlay'` で 45% 程度重ねる技法（#316 で確定した「自身を blur して overlay
 * 合成」）。ろうそく揺れは `sprite.tint`/`glowSprite.alpha` を数コマ単位で揺らす。
 * アニメーション位相（ゆらぎ・ろうそく揺れ）は settled state を持たず、`fadeAnimation` と
 * 同じ Ticker（`this.time.setInterval`）駆動の一時状態としてこのクラスだけが保持する
 * （ADR-0002 / dev-doctrine 規律1）。
 *
 * ピクセレート遷移 (#583): `[イベント絵: path, 遷移=pixelate, フェード=N]` で選べる、透明度
 * フェードの代わりのもう1つの遷移モード。表示中の絵はそのまま残し `pixi-filters` の
 * `PixelateFilter` を `imageGroup` に掛けてドットを段階的に粗くし（コルセン）、粗さが最大に
 * なった地点で新しい画像へ差し替え、以後は同じフィルタで粗さを段階的に戻す（リファイン）。
 * 配分の根拠・境界値の計算は `pixelateTransition.ts` の純粋関数（`computeCoarsenSize`/
 * `computeRefineSize` 等）に切り出し、このクラスは「いつ計算するか」（`pixelateTimer`）と
 * 「結果をどこへ反映するか」（`pixelateFilter.size`）だけを持つ（ambient 演出と同じ役割分担）。
 * 遷移の進行位相（コルセン/ホールド/リファインのどの段階か）は settled state に持たせず、
 * `pixelateState` としてこのクラスだけが保持する一時状態（ADR-0002 / dev-doctrine 規律1）。
 */

import {
  Assets,
  Container,
  DisplacementFilter,
  Sprite,
  Text,
  TextStyle,
  Texture,
  type Filter,
} from 'pixi.js'
import { KawaseBlurFilter, PixelateFilter } from 'pixi-filters'
// 'overlay' はアドバンスドブレンドモード。副作用 import で拡張登録する（KawaseBlurFilter で
// blur したグロー sprite の blendMode='overlay' を実際に描画するために必須、#582）。
import 'pixi.js/advanced-blend-modes'
import { VignetteFilter } from './VignetteFilter'
import {
  buildDisplacementNoiseCanvas,
  computeCandleFlicker,
  computeWobbleOffset,
} from './ambientEffects'
import {
  computeCoarsenSize,
  computeRefineSize,
  computeSwapAtMs,
  isCoarsenComplete,
  isRefineComplete,
  PIXELATE_TRANSITION_MAX_SIZE,
} from './pixelateTransition'
import type { AmbientEffects } from '../types'
import { EventImageState } from './GameState'
import {
  clampFullscreenImageScrollY,
  computeCoverFit,
  computeFullscreenImageFit,
  type LayoutRect,
} from './novelLayout'
import { computeFadeAlpha } from './screenEffects'
import { TimeController, defaultTimeController } from './TimeController'

/** effects 全フラグ false（無演出）の既定値。`AmbientEffects | undefined` の正規化に使う。 */
const NO_AMBIENT_EFFECTS: AmbientEffects = {
  wobble: false,
  vignette: false,
  glow: false,
  candle: false,
}

/** グロー sprite（自身を blur して overlay 合成）の基準 alpha。#316 の「45%dissolve程度」を踏襲。 */
const GLOW_BASE_ALPHA = 0.45
/** グロー sprite の blur 強度。#316 の「blur 20」を踏襲（KawaseBlurFilter.strength）。 */
const GLOW_BLUR_STRENGTH = 20
/** ゆらぎ (DisplacementFilter) のスケール。「微妙な歪み」に留める moderate 値。 */
const WOBBLE_DISPLACEMENT_SCALE = 22

/**
 * フルキャンバス画像表示モード (#530) の縦スクロールヒント文言（#547 must1）。
 * TUI版 `tui/src/ui.rs::draw_fullscreen_image` の `scrollable` 時ヒント
 * （"Enter / Space で開始 ↑/↓ でスクロール"）と対になる、GUI側の同等表示。GUIには
 * 「Enter / Space で開始」に相当するスプラッシュ専用の文言が無い（このモードは
 * script.md 中のあらゆるイベント絵に効く汎用機構のため）ので、スクロール可否のみを示す。
 */
const SCROLL_HINT_LABEL = '↑↓ スクロールできます'

export interface EventImageShowOptions {
  /** 背面（背景・立ち絵）扱い。未指定は 'Hide'（既定） */
  back?: 'Hide' | 'Keep' | null
  /** 表示フェードイン時間 (ms)。呼び出し元が個別指定または per-game 既定を渡す。0 以下は即時表示。
   *  `transition` が 'Pixelate' の場合は遷移全体（コルセン+リファイン）の所要時間として使う。 */
  fadeMs?: number | null
  /** 遷移モード (#583)。未指定/null は 'Fade'（既存の透明度フェード、非回帰）。
   *  'Pixelate' は表示中の絵が無い（初回表示等）場合、遷移するものが無いため 'Fade' 経路
   *  （実質は fadeMs に応じた通常のフェードイン/即時表示）にフォールバックする。 */
  transition?: 'Fade' | 'Pixelate' | null
  /** アンビエント演出フラグ (#582)。未指定/null は全 false（無演出、既存挙動のまま）。 */
  effects?: AmbientEffects | null
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

/**
 * ピクセレート遷移 (#583) の進行状態。settled state ではなくこのクラスだけが保持する一時状態
 * （ADR-0002 / dev-doctrine 規律1）。`phase`:
 *  - 'coarsen': 表示中（旧）画像のドットを 1→maxSize へ粗くしている最中。
 *  - 'holding': コルセン完了（swapAtMs 到達）はしたが新テクスチャのロードがまだ終わっていない。
 *    最大サイズで待機する。
 *  - 'refine': スワップ後、新画像のドットを maxSize→1 へ細かく戻している最中。
 */
interface PixelateTransitionState {
  path: string
  back: 'Hide' | 'Keep'
  effects: AmbientEffects
  /** 遷移全体の所要時間 (ms)。`fade_ms` を再利用（doc comment 参照）。 */
  durationMs: number
  /** コルセン→切替の境界時刻 (ms、startMs からの相対値)。 */
  swapAtMs: number
  startMs: number
  phase: 'coarsen' | 'holding' | 'refine'
  /** スワップが実際に起きた時刻。'refine' フェーズの経過時間計測の基準（holding で伸びた分は
   *  リファイン所要時間に食い込ませない・実装者裁量のコメント参照）。 */
  refineStartMs: number
  /** ロード完了済みだがまだスワップしていない場合の保留テクスチャ（'coarsen' 中にロードが
   *  先に終わった場合はここへ置き、swapAtMs 到達時に使う）。 */
  pendingTexture: Texture | null
  onSettled?: () => void
  onVisibilityChange?: () => void
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

  /** ピクセレート遷移 (#583) 用フィルタ。ステートレスに使い回す（ambient の displacementFilter/
   *  vignetteFilter と同じ流儀）。生成は初回のピクセレート遷移まで遅延させる（未使用のゲームでは
   *  pixi-filters のオブジェクトを作らない）。 */
  private pixelateFilter: PixelateFilter | null = null
  private pixelateTimer: number | null = null
  private pixelateState: PixelateTransitionState | null = null

  /**
   * 現在の「設定済み」状態（スナップショット用）。フェードの中間経過ではなく、常に
   * settled な目標値を指す（ADR-0002）。show()/remove() を呼んだ瞬間にここが更新される。
   */
  private current: { path: string; back: 'Hide' | 'Keep'; effects: AmbientEffects } | null = null

  /**
   * アンビエント演出 (#582) 用の wrapper container。`sprite`/`glowSprite` をここへ入れ、
   * ゆらぎ（displacement）・ビネットのフィルタはこのコンテナ単位で掛ける（scrollHintText には
   * 掛からない）。空でも常に `this` の子として存在する（show() のたびに作り直さない）。
   */
  private readonly imageGroup: Container
  /** グロー演出 (#582) 用、`sprite` と同一テクスチャの複製 sprite。blur + overlay 合成で使う。 */
  private glowSprite: Sprite | null = null
  /**
   * ゆらぎ演出 (#582) 用の変位マップ sprite。`DisplacementFilter` が `worldTransform` を参照する
   * ため、レンダーツリー内（`this` の子）に常駐させる（`renderable=false` はフィルタ側が自動設定）。
   * ノイズ canvas 生成に失敗する環境（jsdom 等、#582 参照）では `null` のまま — ゆらぎ指定時も
   * 静かに no-op になる（クラッシュしない）。
   */
  private displacementSprite: Sprite | null = null
  private displacementFilter: DisplacementFilter | null = null
  /** ビネットフィルタ (#582)。ステートレスなので show() をまたいで使い回す。 */
  private readonly vignetteFilter: VignetteFilter
  /** 現在表示中のイベント絵に適用中の演出フラグ（`current.effects` と同じ値のキャッシュ）。 */
  private currentEffects: AmbientEffects = NO_AMBIENT_EFFECTS
  /** ゆらぎ・ろうそく揺れ（時間経過で変化する演出）の毎フレーム再計算タイマー。 */
  private ambientTimer: number | null = null
  /** `computeWobbleOffset`/`computeCandleFlicker` の経過時間の基準時刻。show() のたびにリセットする。 */
  private ambientStartMs = 0
  /** 変位 sprite の静止位置（ゆらぎはこの周りをオフセットする）。setSplitLayoutRegion 等の影響を
   *  受けないよう画面中央に固定する（変位マップの意味論上、厳密な位置合わせは不要）。 */
  private readonly wobbleBaseX: number
  private readonly wobbleBaseY: number

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

  /**
   * フルキャンバス画像表示モード (#530) 中、`computeFullscreenImageFit().scrollable` が
   * true のときだけ表示する小さなヒントテキスト (#547 must1)。
   * `DialogBox.indicatorGlyph` と同じ流儀で常に生成しておき `visible` だけを切り替える。
   * ゲームごとの `setFontFamily`/`setFontSize`（本文フォント）とは独立の、固定スタイルの
   * 汎用エンジンUIヒント（TUI版のヒント行がゲーム本文と無関係な端末フォントで描かれるのと
   * 同じ位置づけ）。位置は画面下端中央に固定（`screenWidth`/`screenHeight` は construct 時
   * 固定のため、コンストラクタで一度だけ計算すればよい）。
   */
  private readonly scrollHintText: Text

  constructor(
    screenWidth: number,
    screenHeight: number,
    time: TimeController = defaultTimeController
  ) {
    super()
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.time = time

    // アンビエント演出 (#582)。imageGroup は sprite/glowSprite を入れる wrapper で、
    // ゆらぎ・ビネットのフィルタはここに掛ける（scrollHintText は含めない）。
    this.imageGroup = new Container()
    this.addChild(this.imageGroup)

    this.wobbleBaseX = this.screenWidth / 2
    this.wobbleBaseY = this.screenHeight / 2
    // 変位マップ (#582)。jsdom 等 canvas 2D が使えない環境では null のまま
    // （buildDisplacementNoiseCanvas の doc comment 参照。ゆらぎ指定時も静かに no-op）。
    const noiseCanvas = buildDisplacementNoiseCanvas()
    if (noiseCanvas) {
      this.displacementSprite = new Sprite(Texture.from(noiseCanvas))
      this.displacementSprite.anchor.set(0.5)
      this.displacementSprite.position.set(this.wobbleBaseX, this.wobbleBaseY)
      // renderable=false は DisplacementFilter のコンストラクタが自動設定するが、
      // フィルタが未使用の間（ゆらぎ未指定の画像を表示中）もこの sprite 自体は常駐するため、
      // 二重の安全策として明示しておく（万一 renderable のまま残る変更が pixi.js 側に入っても
      // 見えない位置＝中央に置いてあるので実害は無いが、意図を明確にする）。
      this.displacementSprite.renderable = false
      this.addChild(this.displacementSprite)
      this.displacementFilter = new DisplacementFilter({
        sprite: this.displacementSprite,
        scale: { x: WOBBLE_DISPLACEMENT_SCALE, y: WOBBLE_DISPLACEMENT_SCALE },
      })
    }
    this.vignetteFilter = new VignetteFilter()

    this.scrollHintText = new Text({
      text: SCROLL_HINT_LABEL,
      style: new TextStyle({
        fontFamily: "'Noto Sans JP', sans-serif",
        fontSize: 22,
        fill: 0xffffff,
      }),
    })
    this.scrollHintText.anchor.set(0.5, 1)
    this.scrollHintText.position.set(this.screenWidth / 2, this.screenHeight - 16)
    this.scrollHintText.alpha = 0.75
    this.scrollHintText.visible = false
    this.addChild(this.scrollHintText)
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
    // モード切替時点でスクロールヒントも隠す（次の show() が新モードに応じて再計算する、
    // #547 must1）。
    this.scrollHintText.visible = false
  }

  /** 現在フルキャンバス画像表示モードか (#530)。テスト・配線検証用。 */
  isFullscreenMode(): boolean {
    return this.fullscreenMode
  }

  /**
   * フルキャンバス画像表示モード (#530) のスクロールヒントが現在表示中か (#547 must1)。
   * テスト・配線検証用。
   */
  isScrollHintVisible(): boolean {
    return this.scrollHintText.visible
  }

  /**
   * フルキャンバス画像表示モード (#530) 中のマウスホイール縦スクロール。
   * `BacklogOverlay.handleWheel` と同じ手触り（`deltaY * 0.5`）に揃える。フルキャンバス
   * モードでない、画像の高さがキャンバスに収まっている（`maxScrollY <= 0`）、
   * または表示中の sprite が無い場合は no-op で `false` を返す（呼び出し元
   * `NovelRenderer.handleWheel` はこの場合に備えて他のスクロール対象へフォールスルーしてよい）。
   * 戻り値は `ChoiceOverlay.handleWheel` と同じく「イベントを実際に消費したか」（#547 should-C）。
   * 呼び出し元はこれが true のときのみ `e.preventDefault()` を呼ぶ。
   */
  handleWheel(deltaY: number): boolean {
    if (!this.fullscreenMode || this.maxScrollY <= 0 || !this.sprite) return false
    this.scrollOffsetY = clampFullscreenImageScrollY(
      this.scrollOffsetY + deltaY * 0.5,
      this.maxScrollY
    )
    this.sprite.y = -this.scrollOffsetY
    // グロー sprite (#582) は main sprite の複製表示なので、スクロールにも追従させる。
    if (this.glowSprite) this.glowSprite.y = this.sprite.y
    return true
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
   * `sprite` を現在のレイアウトモード（フルキャンバス表示 (#530) / split_layout (#464) /
   * 通常の全画面 cover-fit）に応じて配置する。`show()` の Fade 経路・`performPixelateSwap()`
   * (#583) の両方から呼ばれる共通ロジック（元は show() 内に直書きだったものを切り出した）。
   */
  private layoutSprite(sprite: Sprite, texture: Texture): void {
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
      // #547 must1: `computeFullscreenImageFit` が返す `scrollable` を消費し、TUI版の
      // 「↑/↓ でスクロール」ヒントに相当する表示をGUI側にも出す。
      this.scrollHintText.visible = fit.scrollable
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
  }

  /**
   * グロー演出 (#582) 用の複製 sprite を作る（`sprite` と同一テクスチャ、位置・サイズも揃える）。
   * `show()` の Fade 経路・`performPixelateSwap()` (#583) の両方から呼ばれる共通ロジック。
   * 呼び出し元が `this.imageGroup.addChild(glow)` / `this.glowSprite = glow` を行う。
   */
  private createGlowSprite(sprite: Sprite, texture: Texture): Sprite {
    // 同一テクスチャの複製 sprite を KawaseBlurFilter で blur し、blendMode='overlay' +
    // 45%程度の alpha で重ねる（#316 で確定した技法）。暖色 tint は使わない（背景まで色被り
    // するため NG、#316 で検証済み）。
    const glow = new Sprite(texture)
    Object.assign(glow, {
      width: sprite.width,
      height: sprite.height,
      x: sprite.x,
      y: sprite.y,
    })
    glow.blendMode = 'overlay'
    glow.alpha = GLOW_BASE_ALPHA
    // 既知の設計上の割り切り（修正しない、#582 スコープ外）: glowSprite.alpha は
    // updateFadeFrame() のフェード補間の対象外。ここで固定値 GLOW_BASE_ALPHA を設定した
    // 後は、candle=true の場合のみ updateAmbientFrame() が sprite.tint と同じ経路で
    // 毎フレーム上書きする。そのため glow=true かつ candle=false の画像では、フェードイン中
    // （本体の sprite.alpha がまだ 0 に近い間）もグローの overlay 合成（alpha 0.45）だけ
    // 最初から効いて見える。詳細は updateFadeFrame() のコメントも参照。
    glow.filters = [new KawaseBlurFilter({ strength: GLOW_BLUR_STRENGTH, quality: 3, clamp: true })]
    return glow
  }

  /**
   * imageGroup に適用するフィルタ配列を、現在の状態（ピクセレート遷移中か (#583) ・
   * アンビエント演出フラグ (#582)）から再構築して反映する。ピクセレートとアンビエント演出は
   * 独立に有効化できるため、両方アクティブなら両方のフィルタを合成する（順序: pixelate →
   * wobble → vignette。ピクセレートを先に適用し、その上にアンビエント演出を重ねる）。
   * displacementFilter はノイズ canvas が使えない環境（jsdom 等）では null のまま＝ゆらぎ
   * 指定時も静かに no-op。
   */
  private applyImageGroupFilters(): void {
    const filters: Filter[] = []
    if (this.pixelateFilter && this.pixelateState) filters.push(this.pixelateFilter)
    if (this.currentEffects.wobble && this.displacementFilter) filters.push(this.displacementFilter)
    if (this.currentEffects.vignette) filters.push(this.vignetteFilter)
    this.imageGroup.filters = filters.length > 0 ? filters : null
  }

  /**
   * イベント絵を表示する。既存のイベント絵があれば即座に破棄してから読み込む
   * （背景/動画と同じ単一スロット意味論）。
   *
   * `current`（settled state）は同期的に確定させるが、実際の sprite 生成・フェード開始は
   * テクスチャロード完了後（Assets.load().then() 内）まで遅延する（#427/#428 対策）。
   *
   * ピクセレート遷移 (#583, `opts.transition === 'Pixelate'`) は表示中の絵があり、かつ所要時間
   * （`fadeMs`）が正のときだけ `startPixelateTransition()` の専用経路を通す。表示中の絵が無い
   * （初回表示等）場合や fadeMs<=0（即時指定）の場合は遷移するものが無い/瞬時表示が明示されて
   * いるため、以下の Fade 経路（実質は即時表示）にフォールバックする。
   */
  show(path: string, opts: EventImageShowOptions = {}): void {
    const back: 'Hide' | 'Keep' = opts.back === 'Keep' ? 'Keep' : 'Hide'
    const fadeMs = typeof opts.fadeMs === 'number' && opts.fadeMs > 0 ? opts.fadeMs : 0
    const effects: AmbientEffects = opts.effects ?? NO_AMBIENT_EFFECTS
    const onSettled = opts.onSettled
    const onVisibilityChange = opts.onVisibilityChange

    if (opts.transition === 'Pixelate' && this.sprite && fadeMs > 0) {
      this.startPixelateTransition(path, {
        back,
        effects,
        durationMs: fadeMs,
        onSettled,
        onVisibilityChange,
      })
      return
    }

    // ここに来るのは Fade 経路（既定）、または Pixelate 指定でも遷移するものが無い/即時指定の
    // フォールバック。以前の呼び出しで開始したピクセレート遷移が進行中なら打ち切る。
    this.cancelPixelateTransition()
    this.destroySprite()
    this.stopFadeTimer()
    this.fadeAnimation = null
    this.current = { path, back, effects }
    this.currentEffects = effects
    this.loadFailed = false
    // フルキャンバス画像表示モード (#530) 中に新しい画像へ差し替わったら、スクロール位置を
    // 先頭へ戻す（前の画像のスクロール量を引きずらない）。
    this.scrollOffsetY = 0
    this.maxScrollY = 0
    // 新しい画像のロード完了までヒントは一旦隠す（#547 must1）。ロード完了後、fullscreenMode
    // かつ scrollable なら .then() 内で再度表示する。
    this.scrollHintText.visible = false

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
        this.layoutSprite(sprite, texture)
        this.sprite = sprite
        this.currentTexture = texture
        // #582: sprite は imageGroup の子にする（ゆらぎ/ビネットのフィルタは imageGroup 単位）。
        this.imageGroup.addChild(sprite)

        if (effects.glow) {
          const glow = this.createGlowSprite(sprite, texture)
          this.imageGroup.addChild(glow)
          this.glowSprite = glow
        }

        this.applyImageGroupFilters()

        // ヒントは sprite より前面に出す必要がある。scrollHintText はコンストラクタで
        // 一度だけ addChild 済みだが、以後の show() が imageGroup へ addChild するたびに
        // z順で埋もれてしまうため、既存の子を再 addChild すると末尾（最前面）へ移動する
        // PixiJS の挙動を利用して毎回前面へ戻す（#547 must1）。
        this.addChild(this.scrollHintText)

        // 時間経過で変化する演出（ゆらぎ・ろうそく揺れ）の再計算タイマー (#582)。
        if (effects.wobble || effects.candle) {
          this.ambientStartMs = this.time.now()
          this.ensureAmbientTimer()
        }

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

    // ピクセレート遷移 (#583) が進行中なら打ち切ってから通常の退場処理へ進む。
    this.cancelPixelateTransition()

    this.current = null
    // ロード中だった読み込みは無効化する（後から解決しても捨てられる）。
    this.loadToken++
    this.pendingLoadToken = null
    // イベント絵が消える（フェードアウト含む）ので、スクロールヒントも即座に隠す (#547 must1)。
    this.scrollHintText.visible = false

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
    // sprite.alpha のみを補間する。glowSprite.alpha はここでは更新しない（意図的、#582 スコープ外）
    // — glow=true かつ candle=false の画像では、フェード中もグローの overlay 合成だけ最初から
    // 効いて見える既知の割り切り。詳細は glow sprite 生成箇所（GLOW_BASE_ALPHA を設定している行）の
    // コメント参照。
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

  /**
   * 時間経過で変化するアンビエント演出（ゆらぎ・ろうそく揺れ、#582）の毎フレーム再計算タイマーを
   * 開始する。`fadeTimer` と同じ 16ms 間隔（`ensureFadeTimer` 参照）。既に動いていれば no-op。
   */
  private ensureAmbientTimer(): void {
    if (this.ambientTimer != null) return
    this.ambientTimer = this.time.setInterval(() => this.updateAmbientFrame(), 16)
  }

  private stopAmbientTimer(): void {
    if (this.ambientTimer == null) return
    this.time.clearInterval(this.ambientTimer)
    this.ambientTimer = null
  }

  /**
   * ゆらぎ（displacementSprite のオフセット）・ろうそく揺れ（sprite.tint / glowSprite.alpha）を
   * 現在時刻から再計算する (#582)。計算自体は `ambientEffects.ts` の純粋関数に委ねる
   * （このメソッドは「いつ計算するか」と「結果をどこへ反映するか」だけを持つ、`updateFadeFrame`
   * と同じ役割分担）。
   */
  private updateAmbientFrame(): void {
    if (!this.sprite) {
      this.stopAmbientTimer()
      return
    }
    const elapsed = this.time.now() - this.ambientStartMs
    if (this.currentEffects.wobble && this.displacementSprite) {
      const { x, y } = computeWobbleOffset(elapsed)
      this.displacementSprite.x = this.wobbleBaseX + x
      this.displacementSprite.y = this.wobbleBaseY + y
    }
    if (this.currentEffects.candle) {
      const factor = computeCandleFlicker(elapsed)
      const v = Math.max(0, Math.min(255, Math.round(factor * 255)))
      this.sprite.tint = (v << 16) | (v << 8) | v
      if (this.glowSprite) {
        this.glowSprite.alpha = GLOW_BASE_ALPHA * factor
      }
    }
  }

  /**
   * ピクセレート遷移 (#583) を開始する。表示中の絵（`this.sprite`）はそのまま画面に残し、
   * `imageGroup` に `PixelateFilter` を掛けてコルセン（ドットを粗くする）を開始しながら、
   * 並行して次の画像を読み込む。コルセンが完了した時点（`durationMs` の
   * `PIXELATE_TRANSITION_SWAP_RATIO` 地点）でロードが終わっていれば即座にスワップし
   * (`performPixelateSwap`)、終わっていなければロード完了まで最大サイズで保持してから
   * スワップする（`holding` フェーズ）。スワップ後は新しい画像を残り時間でリファイン
   * （細かく戻す）する。
   *
   * `current`（settled state）は他の show() 経路と同じく同期的に確定させる（ADR-0002）。
   */
  private startPixelateTransition(
    path: string,
    opts: {
      back: 'Hide' | 'Keep'
      effects: AmbientEffects
      durationMs: number
      onSettled?: () => void
      onVisibilityChange?: () => void
    }
  ): void {
    // 直前の（別画像への）ピクセレート遷移が進行中なら打ち切って新しい遷移をやり直す
    // （show() の Fade 経路が destroySprite() で前の sprite を破棄して再開するのと対称的な
    // 「割り込み・上書き」挙動）。
    this.cancelPixelateTransition()
    this.stopFadeTimer()
    this.fadeAnimation = null

    this.current = { path, back: opts.back, effects: opts.effects }
    this.loadFailed = false
    this.scrollOffsetY = 0
    this.maxScrollY = 0
    this.scrollHintText.visible = false

    if (!this.pixelateFilter) this.pixelateFilter = new PixelateFilter(1)
    this.pixelateFilter.size = 1

    const swapAtMs = computeSwapAtMs(opts.durationMs)
    this.pixelateState = {
      path,
      back: opts.back,
      effects: opts.effects,
      durationMs: opts.durationMs,
      swapAtMs,
      startMs: this.time.now(),
      phase: 'coarsen',
      refineStartMs: 0,
      pendingTexture: null,
      onSettled: opts.onSettled,
      onVisibilityChange: opts.onVisibilityChange,
    }
    this.applyImageGroupFilters()
    this.pixelateTimer = this.time.setInterval(() => this.updatePixelateFrame(), 16)

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
        const s = this.pixelateState
        if (!s) return // 既に別の show()/remove() に追い越された（cancelPixelateTransition 済み）
        if (s.phase === 'holding') {
          // コルセンは既に完了していてロード待ちだった場合、ここで即スワップする。
          this.performPixelateSwap(texture)
        } else {
          // まだコルセン中（ロードの方が速く終わった）。swapAtMs 到達を待つ。
          s.pendingTexture = texture
        }
      })
      .catch((err: unknown) => {
        if (this.pendingLoadToken === token) this.pendingLoadToken = null
        console.warn('[name-name] イベント絵の読み込みに失敗: ' + url, err)
        if (token === this.loadToken) {
          this.loadFailed = true
          this.cancelPixelateTransition()
          opts.onSettled?.()
        }
      })
  }

  /**
   * `pixelateTimer` の毎フレーム再計算。位相ごとの `PixelateFilter.size` 算出は
   * `pixelateTransition.ts` の純粋関数に委ねる（`updateFadeFrame`/`updateAmbientFrame` と同じ
   * 役割分担: このメソッドは「いつ計算するか」「結果をどこへ反映するか」だけを持つ）。
   */
  private updatePixelateFrame(): void {
    const s = this.pixelateState
    if (!s || !this.pixelateFilter) {
      this.stopPixelateTimer()
      return
    }
    const now = this.time.now()

    if (s.phase === 'coarsen') {
      const elapsed = now - s.startMs
      this.pixelateFilter.size = computeCoarsenSize(elapsed, s.swapAtMs)
      if (isCoarsenComplete(elapsed, s.swapAtMs)) {
        this.pixelateFilter.size = PIXELATE_TRANSITION_MAX_SIZE
        if (s.pendingTexture) {
          this.performPixelateSwap(s.pendingTexture)
        } else {
          s.phase = 'holding'
        }
      }
      return
    }

    if (s.phase === 'holding') {
      // ロード完了待ち。size は最大のまま（Assets.load().then() 側が performPixelateSwap を呼ぶ）。
      return
    }

    // phase === 'refine'
    const elapsed = now - s.refineStartMs
    const remaining = s.durationMs - s.swapAtMs
    this.pixelateFilter.size = computeRefineSize(elapsed, remaining)
    if (isRefineComplete(elapsed, remaining)) {
      this.completePixelateTransition()
    }
  }

  /**
   * コルセン完了かつロード完了のタイミングで、表示中スプライトを新しいテクスチャへ差し替える
   * （旧 sprite/glowSprite を破棄し、新しい sprite を作る。alpha フェードは行わない —
   * ピクセレート自体が視覚的な遷移を担うため常に alpha=1 で出す）。以後 `updatePixelateFrame`
   * が 'refine' フェーズへ移行し、`PixelateFilter.size` を最大値→1 へ戻す。
   *
   * `back=Hide` の可視性判定 (`shouldHideBackLayer`) はこの関数の呼び出し前後を通じて
   * `this.fadeAnimation === null` かつ `this.sprite !== null` のままなので、Fade 経路の
   * 「フェードイン完了まで背面を隠さない」制御は不要（ピクセレートは常時 alpha=1 で画面を
   * 覆っているため）。スワップの瞬間に `onVisibilityChange`/`onSettled` を発火する。
   */
  private performPixelateSwap(texture: Texture): void {
    const s = this.pixelateState
    if (!s) return

    // 旧 sprite/glowSprite・アンビエントタイマーの後始末。pixelateTimer/pixelateState は
    // destroySprite() が関知しないフィールドなのでここでは影響を受けない。
    this.destroySprite()

    texture.source.scaleMode = this.pixelArt ? 'nearest' : 'linear'
    const sprite = new Sprite(texture)
    this.layoutSprite(sprite, texture)
    sprite.alpha = 1
    this.sprite = sprite
    this.currentTexture = texture
    this.imageGroup.addChild(sprite)

    if (s.effects.glow) {
      const glow = this.createGlowSprite(sprite, texture)
      this.imageGroup.addChild(glow)
      this.glowSprite = glow
    }

    this.currentEffects = s.effects
    this.applyImageGroupFilters()
    this.addChild(this.scrollHintText)

    if (s.effects.wobble || s.effects.candle) {
      this.ambientStartMs = this.time.now()
      this.ensureAmbientTimer()
    }

    s.phase = 'refine'
    s.refineStartMs = this.time.now()
    s.onVisibilityChange?.()
    s.onSettled?.()
  }

  private stopPixelateTimer(): void {
    if (this.pixelateTimer == null) return
    this.time.clearInterval(this.pixelateTimer)
    this.pixelateTimer = null
  }

  /**
   * ピクセレート遷移 (#583) が進行中なら打ち切る。`sprite` 自体はここでは触らない
   * （呼び出し元が Fade 経路への切り替え・退場等それぞれの流儀で扱う）。
   */
  private cancelPixelateTransition(): void {
    if (!this.pixelateState) return
    this.stopPixelateTimer()
    this.pixelateState = null
    if (this.pixelateFilter) this.pixelateFilter.size = 1
    this.applyImageGroupFilters()
  }

  /** リファイン完了（`PixelateFilter.size` が 1 に戻った）時点で遷移を終える。 */
  private completePixelateTransition(): void {
    this.stopPixelateTimer()
    this.pixelateState = null
    if (this.pixelateFilter) this.pixelateFilter.size = 1
    this.applyImageGroupFilters()
  }

  private destroySprite(): void {
    // アンビエント演出 (#582) の後始末。sprite の有無に関わらず常に行う（防御的・冪等）。
    this.stopAmbientTimer()
    if (this.glowSprite) {
      this.glowSprite.removeFromParent()
      this.glowSprite.destroy()
      this.glowSprite = null
    }
    this.imageGroup.filters = null

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
   * フェード中でも settled な目標値（path/back/effects）を返す（ADR-0002）。
   *
   * `effects` は全フラグ false（無演出）のときキー自体を省略する（#582）。`EventImageState.effects`
   * は optional で「undefined = 無演出」の規約（フィールド doc 参照）— vitest `toEqual` は
   * undefined プロパティを無視するため、演出未指定の既存テスト・旧セーブ（`{path, back}` のみ）
   * との等価性を壊さない。
   */
  getState(): EventImageState | null {
    if (!this.current) return null
    const { path, back, effects } = this.current
    const hasEffects = effects.wobble || effects.vignette || effects.glow || effects.candle
    return hasEffects ? { path, back, effects } : { path, back }
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
    this.show(state.path, {
      back: state.back,
      effects: state.effects,
      onSettled: opts.onSettled,
    })
  }

  /**
   * `[待機: 表示完了]` 用の観測 API。
   * テクスチャロード中、フェード（表示イン/退場アウト）進行中、またはピクセレート遷移 (#583)
   * 進行中（コルセン/ホールド/リファインいずれか）なら true。
   */
  hasPendingVisualTransition(): boolean {
    return (
      this.pendingLoadToken !== null || this.fadeAnimation !== null || this.pixelateState !== null
    )
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
