/**
 * PixiJS ベースのノベルレンダラー
 *
 * Event[] を受け取り、クリック/タップ/キーボードで進行する。
 * - Dialog/Narration: text[] の各要素を1つずつ表示（カノソ方式 = 一瞬表示）
 * - 改行 = テキスト送り、空行 = 改ページ（ボックス内テキストクリア）
 * - Background: 背景画像表示（アスペクト比維持カバー）
 * - Blackout: 暗転/暗転解除
 * - SceneTransition: 背景クリア + 暗転解除
 * - BGM: ループ再生、切り替え、フェードアウト停止
 * - SE: 単発再生（複数同時可）
 */

import { CameraZoomController } from './cameraZoom'
import { Application, Text as PixiText, TextStyle, type Container } from 'pixi.js'
import {
  CharacterLayer,
  CHARACTER_X_RATIO,
  normalizePosition,
  NOVEL_ROLE_X_RATIO,
} from './CharacterLayer'
import { BackgroundBoardLayer } from './BackgroundBoardLayer'
import { PropLayer } from './PropLayer'
import { CurtainLayer } from './CurtainLayer'
import { BubbleLayer, type BubbleStyle } from './BubbleLayer'
import { resolveTextDisplay } from './bubblePresentation'
import { DialogBox } from './DialogBox'
import { ensureFontLoaded } from './FontLoader'
import {
  backgroundPreload,
  clearBackgroundPreload,
  clearBackgroundPreloadQueue,
} from './backgroundPreload'
import { AudioManager } from './AudioManager'
import { GameState, NovelGameState, StartFromOptions, Step, entryFromState } from './GameState'
import { VideoLayer } from './VideoLayer'
import { WallLayer } from './WallLayer'
import { StageFrontLayer } from './StageFrontLayer'
import { WeatherLayer } from './WeatherLayer'
import { FloorLayer } from './FloorLayer'
import { StageTurnController } from './stageTurn'
import { EventImageLayer } from './EventImageLayer'
import { TelopLayer } from './TelopLayer'
import { ChoiceOverlay } from './ChoiceOverlay'
import { TitleScreenOverlay, TITLE_LOGO_Y_RATIO } from './TitleScreenOverlay'
import {
  type BackgroundController,
  brightnessToTint,
  normalizeBackgroundBrightness,
  normalizeBackgroundFade,
} from './BackgroundController'
import { type ScreenEffectsController } from './ScreenEffectsController'
import { Stage } from './Stage'
import { dispatchDirective, type DirectiveContext } from './directives'
import { SaveController } from './SaveController'
import { SaveLoadOverlay } from './SaveLoadOverlay'
import { BacklogOverlay } from './BacklogOverlay'
import { EndingOverlay } from './EndingOverlay'
import { ToastOverlay } from './ToastOverlay'
import { SeekBar, DEFAULT_BAR_FILL_COLOR } from './SeekBar'
import { computeDisplayIndex, findHistoryIndexForDisplayIndex } from './seekMapping'
import { getTextEvent } from './eventCursor'
import { collectUpcomingAssetUrls } from './preloadPlan'
import { buildDebugState, type DebugState } from './debugState'
import { isSceneIdConfined } from './sceneConfinement'
import { PlaybackCursor } from './PlaybackCursor'
import { SceneIndex } from './SceneIndex'
import { JUMP_CHAIN_LIMIT, TransitionState } from './TransitionState'
import { SceneEntryController } from './SceneEntryController'
import {
  type CarryPolicy,
  type SceneEntryResult,
  segmentAt,
  type ResolvedSegment,
} from './sceneEntry'
import { ChoiceOption, Event, EventImageTransition, EventScene, FlagValue } from '../types'
import { LightingLayer } from './LightingLayer'
import { ASPECT_RATIOS, type AspectRatio, DEFAULT_ASPECT_RATIO } from './constants'
import {
  isRead,
  isReadForLine,
  loadReadLineProgress,
  loadReadProgress,
  loadReadSceneProgress,
  makeReadLineKey,
  migrateLegacyReadProgressForScene,
  markRead,
  markReadLine,
  markReadScene,
} from './readProgress'
import { TimeController, defaultTimeController } from './TimeController'
import {
  clampFadeMs,
  parseColorToNumber,
  resolveAssetUrl,
  resolveFontFamily,
  formatCounterText,
  computeSeekBarPosition,
  PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX,
  PLAYER_BUTTON_ROW_HEIGHT_PX,
  splitIntoSentences,
  paginateSentencesByLines,
  type NovelPage,
  computeSplitLayoutRegions,
  splitTextRegionForDualWindow,
  type LayoutRect,
  computeTelopBottomReserveHeight,
  resolveCharacterXRatio,
} from './novelLayout'
import {
  STAGE_LAYER_RULES,
  computeStageLayerState,
  type StageLayerKey,
} from './stageLayerVisibility'
import { stripRubyMarkup, mapSentencesToRubyPreservedText } from './ruby'
import { resolveVoiceSpatialization } from './voiceSpatialization'

/**
 * novel 型 canvas の既定 touch-action (#434)。
 *
 * PixiJS の `Application.init()` はゲームタイプに関係なく無条件で canvas に
 * `touch-action: none` を設定する（Pixi 内部の EventSystem 実装。`eventFeatures` オプションの
 * 適用より後に効くため、Pixi 標準オプションでは無効化できない）。そのため init 完了後に
 * こちらで明示的に上書きする必要がある。
 *
 * novel 型はクリック/タップで1行送りするだけのポインター操作しか使わず、スワイプそのものを
 * ゲーム入力として消費しない。iframe 埋め込み（theo-hayami 等）で touch-action:'none' のままだと、
 * 埋め込み枠内のスワイプがすべて「ゲーム側のタップ」として捕捉されてしまい、外側ページの
 * スクロールができなくなる (#434)。縦方向のスワイプはブラウザのネイティブスクロール/パンへ
 * 開放してよいため 'pan-y' にする。横方向は 'none' のまま維持し、ピンチズーム等の意図しない
 * ネイティブジェスチャは禁止する。
 *
 * RPG型 (`TopDownRenderer.ts`) ・raycast型 (`RaycastRenderer.ts`) は `touchInput.ts` の
 * スワイプ移動/タップメニューでスワイプ自体をゲーム操作として捕捉する必要があるため、
 * touch-action:'none' のまま無改修とする（このファイルの対象外）。
 * 「ゲームタイプごとに入力要件が異なるので touch-action もレンダラーごとに自身の入力要件に応じて
 * 宣言する」という設計であり、novel 型だけの特別扱いハックではない（設計方針の記録は
 * docs/architecture.md「レンダリングパイプライン」参照）。
 */

/** canvas.style.touchAction に実際に設定する値 (#434)。novel 型はこの2値しか使わない。 */
export type CanvasTouchAction = 'none' | 'pan-y'

const NOVEL_CANVAS_TOUCH_ACTION: CanvasTouchAction = 'pan-y'

/**
 * 復元 (#294) 用: 指定キャラの立ち絵フィット指定を resolvedEvents から解決する純粋関数。
 *
 * fit は GameState（スナップショット / セーブ）に持たない脚本由来の表示属性なので、
 * goBack / seekTo / セーブ復元のときは現在イベント (`eventIndex`) 以前で、その立ち絵を
 * 最後に出した Dialog（speaker == character）の fit を引き当てる。
 * 見つからなければ false（原寸）。Condition は resolveEvents で展開済みの前提で、
 * 平坦な resolvedEvents だけを走査する（NovelRenderer の復元と同じ列）。
 */
export function resolveCharacterFit(
  events: readonly Event[],
  eventIndex: number,
  character: string
): boolean {
  const upper = Math.min(eventIndex, events.length - 1)
  for (let i = upper; i >= 0; i--) {
    const e = events[i]
    if (typeof e === 'object' && e !== null && 'Dialog' in e) {
      if (e.Dialog.character === character) {
        return e.Dialog.fit === true
      }
    }
  }
  return false
}

// 背景の正規化・tint 変換の純粋関数は BackgroundController (#828 7a) へ移った。既存の import 経路
// （`NovelRenderer` から）と既存テストを壊さないため、ここに再エクスポートを残す。
export { normalizeBackgroundFade, normalizeBackgroundBrightness, brightnessToTint }

// playScript / startFrom で使う型を NovelRenderer 経由でも import できるよう再エクスポートする (#220)
export type { Step, StartFromOptions } from './GameState'

// novel スクリムの定数は ScreenEffectsController (#828 7b) へ移った。既存の import 経路（`NovelRenderer` から）と
// 既存テストを壊さないため、ここに再エクスポートを残す。
export {
  NOVEL_SCRIM_ALPHA,
  NOVEL_SCRIM_RETREAT_MS,
  NOVEL_SCRIM_HOLD_MS,
  NOVEL_SCRIM_VISIBILITY_FADE_MS,
} from './ScreenEffectsController'

export const BACKGROUND_CROSSFADE_MS = 700
export const EVENT_IMAGE_FADE_MS = 700

/** 背景フェード時間の下限（ms）。character_fade_ms（CharacterLayer）と対称の [0, 5000] レンジ (#407)。 */
const BACKGROUND_FADE_MS_MIN = 0
/** 背景フェード時間の上限（ms）。character_fade_ms（CharacterLayer）と対称の [0, 5000] レンジ (#407)。 */
const BACKGROUND_FADE_MS_MAX = 5_000

/**
 * intermission.md 専用シーン (#404) の背景/立ち絵消去フェード既定値（ms）。
 * `background_fade_ms`/`character_fade_ms` フロントマターが intermission.md 自身に無いときの
 * フォールバック。通常の物語中トランジション既定 `BACKGROUND_CROSSFADE_MS`（700ms）より遅めにして
 * 「幕がゆっくり降りる」演出にする（設計確定コメント #404 参照）。値はフェード時間の推奨3値
 * （基本700ms・短め300ms・長め1400ms＝700の2倍。#424）のうち「長め」を採用。クランプ範囲は
 * BACKGROUND_FADE_MS_MIN/MAX と同じ [0, 5000] を共有する（clampFadeMs 経由）。
 */
const INTERMISSION_FADE_MS_DEFAULT = 1_400

export class NovelRenderer {
  private app: Application
  /** init() 完了済みかのフラグ。React StrictMode 等で init 中に destroy が呼ばれたときの no-op 判定に使う */
  private appInitialized = false
  private dialogBox: DialogBox
  /** DialogBox の代替として本文を描く、イベント宣言由来の吹き出し (#698)。 */
  private bubbleLayer: BubbleLayer
  /** 動画入力レイヤ (#252)。背景の直後・立ち絵の下に配置 */
  private videoLayer: VideoLayer
  private characterLayer: CharacterLayer
  /** イベント絵レイヤー (#351)。テキストより背面・全背面レイヤー（背景・背景板・動画・立ち絵・大道具）より前面に配置 */
  private eventImageLayer: EventImageLayer
  /** テロップレイヤー (#674)。dialogBox の直後・SeekBar/選択肢/終劇オーバーレイの下に配置。 */
  private telopLayer: TelopLayer
  /** テロップのアクセント縦線色 (#674)。`setSeekBarColor` と同じ色解決を共有する（Issue コメント
   *  「アクセント色は SeekBar と同じ色解決」）。 */
  private telopAccentColorNum: number = DEFAULT_BAR_FILL_COLOR
  /** テロップ帯予約 (#674)。frontmatter `telop_reserve:` から `setTelopReserve` 経由で設定される。 */
  private telopReserveEnabled = false
  /**
   * 下部丸ボタン行ぶんの論理座標マージン (#677)。既定は表示倍率 1:1 の `PLAYER_BUTTON_ROW_HEIGHT_PX`。
   * `syncTelopBottomMarginToButtons` が `canvas.clientHeight` から求めた実倍率で更新する
   * （`PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX` を使う SeekBar 側の同期と同じ流儀、#350）。
   * `telopLayer.setButtonRowHeightPx` と `dialogBox.setNovelBottomReserve`（テロップ帯予約）の
   * 両方がこの値を共有し、二重計上を避ける。
   */
  private telopButtonRowHeightPx: number = PLAYER_BUTTON_ROW_HEIGHT_PX
  /**
   * `telopLayer.clear()`（destroy 以外の呼び出し = scene切替/goBack/seekTo/セーブ復元）が
   * 起きるたびに1つ増える世代カウンタ (#679 レビューS3)。`directives/stageDirectives.ts` の `Telop` ハンドラ（旧 processDirective の Telop 分岐）は
   * `ensureFontLoaded()` の完了を待ってから `telopLayer.show()` する（フォント未ロードのまま
   * 折り返し行数が確定してしまう問題の修正）が、待機中にシーン切替等が起きて古いテロップを
   * 出すのは事故なので、show 呼び出し予定時にこの値を記録し、完了時に変化していないか
   * `clearTelopLayer()` 経由の呼び出しと突き合わせて確認する。
   */
  private telopClearEpoch = 0
  private counterText: PixiText | null = null
  /**
   * 再生カーソルとイベント配列・履歴の唯一の書き手 (#824)。`rawEvents` / `resolvedEvents` / `eventIndex` /
   * `textIndex` / `sentenceIndex` / `displayEventCount` / 派生ページキャッシュ / `history` /
   * `currentSceneId` / `playbackStarted` は、ここから読み、書き込みは必ず `PlaybackCursor` のメソッド経由にする。
   * `rawEvents` は「今どのルートを再生中か」を表す（エントリ文書本来の events を持つ `SceneIndex` とは別物）。
   * ページ分割そのもの（`getNovelPages` / `getAdvSentencePages`）はスタイル設定に依存するのでレンダラに残す。
   */
  private readonly cursor = new PlaybackCursor()

  /**
   * 再生が開始済みか (#768)。fluid 再マウントの引き継ぎ判定に使う。未開始のスナップショットは
   * 意味のある位置ではないので引き継がない。sceneId が null でも（ジャンプ前の線形ストリーム）開始済みはあり得る。
   * `loadEvents` / `loadScenes` の直後は false（文書だけ入って位置が未確定）で、入場の適用
   * （`resetAndStartEvents` / `restoreToScene`）で true になる。未開始の位置は index 0 の仮置きにすぎないので、
   * 入場が失敗しても遷移状態を導出し直さない（先頭が Choice だと、開始前に選択肢が出て skipMode が解除されるため）。
   */
  hasStartedPlayback(): boolean {
    return this.cursor.playbackStarted
  }

  private initialized = false
  private onEndCallback: (() => void) | null = null
  /** 動画エクスポート用 (#228)。`jumpToScene` / `setScenes` でシーンが切り替わったときに呼ぶ */
  private onSceneChangeCallback: ((sceneId: string) => void) | null = null
  /**
   * デバッグ用の全選択肢ロック解除フラグ (#652)。false（既定）は従来どおり
   * `option.condition` を `checkFlag` で判定する。true のときは `option.condition` の
   * 有無に関わらず choice の `locked` 配列を全 false にする（全ルート強制解放）。
   * `setDebugUnlockAllChoices` で設定する（呼び出し側は `NovelPlayer` が
   * `?debug_unlock_all=1`（`debugQuery.ts` の `parseDebugUnlockAll`）から渡す）。
   * TUI版 `Playback.debug_unlock_all`（`--debug-unlock-all`）と対称。
   */
  private debugUnlockAllChoices = false
  /**
   * 終劇状態 (#386)。GameState 上の宣言的フラグ（`NovelGameState.storyEnded`）と対になる
   * 実行時フィールド。true の間は `advance()` が no-op になり（choice/advance は反応しない）、
   * `jumpToScene` も再入しない。goBack/seekTo/セーブ復元は `applyState` 経由でこの値を
   * そのまま反映する（フェード演出は再生しない＝宣言的な瞬時反映）。
   */
  private storyEnded = false
  /** storyEnded 変化を DOM 側（NovelPlayer）に伝える hook (#386)。postMessage 通知・React state
   *  同期（DOM ボタンの disabled 制御・デバッグ HUD 等）用。"to be continued..." 表示自体は
   *  この callback とは独立に `endingOverlay`（PixiJS 内部描画、#630）が担う。 */
  private onStoryEndedChangeCallback: ((ended: boolean) => void) | null = null
  private assetBaseUrl: string = ''
  /**
   * 先読み済みアセット URL の集合 (#389)。`preloadUpcomingAssets` が同一 URL を
   * `backgroundPreload` に二重に積まないための重複除去（無駄呼び出しを避ける）。
   * イベント列を差し替える `resetAndStartEvents` でクリアする＝
   * 新しいイベント列では先読み状態も作り直す。`setEvents` は表示済み背景を `Assets.unload`
   * するので、クリアしないと「積み済み」誤判定で先読みがスキップされコールドロードに戻る
   * （エディタのライブプレビュー等で再表示するケース）。`destroy` でもリーク予防にクリアする。
   */
  private preloadedUrls: Set<string> = new Set()
  private audioManager: AudioManager

  /** ゲーム状態（フラグストア）— 章またぎで保持 */
  private gameState: GameState = new GameState()

  /** 選択肢オーバーレイ */
  private choiceOverlay: ChoiceOverlay

  /**
   * タイトル画面オーバーレイ (#628 フェーズ2b)。旧 DOM `TitleOverlay.tsx` の PixiJS 版。
   * ロゴ画像は自前で持たず `characterLayer.showImage()` 経由で表示する（`showTitleScreen` 参照）。
   */
  private titleScreenOverlay: TitleScreenOverlay
  /** タイトルロゴ画像を `characterLayer` に保持させる際の予約 id。脚本側の `[画像: id=...]`
   *  と衝突しない専用名にし、`hideTitleScreen()` で確実に `remove()` して後始末する。 */
  private static readonly TITLE_LOGO_IMAGE_ID = '__title_logo__'
  /**
   * split_layout (#442) プロジェクトで `showTitleScreen()` が一時的に解除する前の
   * `characterLayer.getSplitLayoutRegion()` の退避値 (#628 フェーズ2b)。タイトル画面は
   * ゲーム画面（split_layout の画像/テキスト分割）の外側にある全画面 UI のため、ロゴは画面
   * 中央に出したい。しかし `characterLayer.setSplitLayoutRegion()` は Container 全体の
   * scale/position を書き換える設計（`CharacterLayer.setSplitLayoutRegion` 参照。カメラズームの
   * ポーズと合成する `applyLayerTransform` 経由）で、
   * `showImage()` の x/y 比率はそのまま「領域内での比率」に射影されてしまう——結果、
   * `[選択: x=0.5]` のつもりのロゴが split_layout のキャラ領域（画面半分）の中央に寄って
   * 見えてしまう（実機検証で発覚。gymnasia で確認）。`showTitleScreen()` は分割を一時解除して
   * 全画面座標系に戻し、`hideTitleScreen()` で退避値を復元してゲーム本編の split_layout 表示に
   * 影響を残さない。null（split_layout 未使用/解除中）ならそもそも何もしない。
   */
  private titleScreenSavedCharacterSplitRegion: LayoutRect | null = null
  /** 直近の本文が吹き出し表示か (#982/#714)。`hideTitleScreen()` が会話窓を戻すときに、吹き出し本文の裏へ
   *  会話窓を二重に出さないために使う（本文の表示方法は render() が決める）。 */
  private textDisplayIsBubble = false

  /**
   * 終劇オーバーレイ (#630)。旧 DOM 版 `NovelPlayer.tsx` の "to be continued..." 表示の PixiJS 版。
   * `storyEnded && !hasIntermissionScene()` の判定は `syncEndingOverlayVisibility()` が内部化して
   * 行う（旧版の React 側 `usedIntermissionScene` スナップショットと同じ意味論。当該メソッドの
   * JSDoc 参照）。ロゴ画像は自前で持たず `characterLayer.showImage()` に委譲する
   * （`titleScreenOverlay`/`showTitleScreen()` と同じ流儀）。
   */
  private endingOverlay: EndingOverlay
  /** 終劇ロゴ画像を `characterLayer` に保持させる際の予約 id（`TITLE_LOGO_IMAGE_ID` と同型）。 */
  private static readonly ENDING_LOGO_IMAGE_ID = '__ending_logo__'
  /** 旧 DOM 版 `max-w-[20%]`（終劇ロゴの表示幅）相当。 */
  private static readonly ENDING_LOGO_WIDTH_RATIO = 0.2
  /**
   * 旧 DOM 版 `max-h-16`（4rem=64px）相当（#630 セルフレビュー must M2）。`ENDING_LOGO_PADDING_PX`
   * と同じ論理解像度（px）基準。幅比率と高さ上限の両方を満たす小さい方のスケールを
   * `characterLayer.showImage()` の `maxHeight` オプション経由で採用させ、旧版の
   * `object-contain` 2軸制約を再現する（1280×720系アセットで幅基準のみだと旧比2倍超に
   * なり "to be continued..." と重なる崩れが実証されている）。
   */
  private static readonly ENDING_LOGO_MAX_HEIGHT_PX = 64
  /** 旧 DOM 版 `top-3 left-3`（0.75rem=12px）相当。終劇ロゴの左上余白。 */
  private static readonly ENDING_LOGO_PADDING_PX = 12

  /**
   * クイックセーブ/ロード通知 toast オーバーレイ (#630)。旧 DOM 版 `NovelPlayer.tsx` の
   * `role="status"` トースト表示の PixiJS 版。表示タイマー管理は `showToast()` が
   * `this.time`（TimeController）経由で行う。
   */
  private toastOverlay: ToastOverlay
  /** toast の自動消去タイマー。`showToast()` 呼び出し時に既存タイマーをクリアして再スタートする。 */
  private toastTimer: number | null = null
  /** 旧 DOM 版 `setTimeout(..., 2000)` 相当（toast 表示時間）。 */
  private static readonly TOAST_DURATION_MS = 2000

  /** 選択肢スタイル名 (#146)。frontmatter `choice_style:` の値。null なら default 扱い */
  private choiceStyle: string | null = null

  /** 会話の描画スタイル (#283)。frontmatter `dialog_style:` の値（`adv` / `novel`）。
   *  null/未知値は adv 相当（未指定時フォールバック。「正規デフォルト」ではない）。
   *  `isNovelStyle()` で判定する。 */
  private dialogStyle: string | null = null

  /** 質問役（主人公）の話者名 (#286)。frontmatter `protagonist:` の値。
   *  novel スタイルの左右配置で「この名前の話者＝質問役＝左 / それ以外（住人）＝回答役＝右」と決める。
   *  null（未指定）なら従来配置（position トークンのまま）＝後方互換。adv では一切使わない。 */
  private protagonist: string | null = null

  /** 直前に喋った話者名 (#286)。話者交代の検出に使う。
   *  Dialog の character が変わったら novel ではポーズ変化（nudgePose）を起こす。
   *  resetAndStartEvents / シーン遷移でリセットする（前シーンの話者を引きずらない）。 */
  private lastSpeaker: string | null = null

  /** 話者交代 nudge（ぴょこ）を novel で発火させるか (#382)。frontmatter `speaker_nudge:` の値。
   *  既定 false・nudge は opt-in（`speaker_nudge: true` で発火）。標準は話者交代時のポーズ差し替え
   *  （#337 クロスフェード）が「今この人」の合図を担うため nudge は不要。nudge は開発中の稀な合図で、
   *  欲しい作品だけ opt-in する。theo-hayami は未指定のまま（＝非発火）。 */
  private speakerNudge: boolean = false

  /** 画面比率に応じて画像/テキストを左右・上下に分割配置する split_layout モード (#442)。
   *  frontmatter `split_layout:` の値。既定 false＝従来どおり（画像全面 + テキストオーバーレイ）。
   *  dialog_style（adv/novel、テキスト送りの挙動）とは独立の軸で、両者は併用できる。
   *  true のとき `applySplitLayout()` が screenWidth/screenHeight から画像/テキスト領域を算出し、
   *  DialogBox・CharacterLayer 双方へ配る。screenWidth/screenHeight は construct 時に固定される
   *  （#442: fluid `aspect_ratio: auto` は向きが変わるたびに NovelPlayer が renderer ごと
   *  再マウントする設計のため、renderer 自身は resize ハンドラを持たない）。 */
  private splitLayout: boolean = false

  /** フルキャンバス画像表示モード (#530)。frontmatter `fullscreen_image:` の値。既定
   *  false＝従来どおり。true の間、イベント絵表示中は DialogBox/ChoiceOverlay を隠し、
   *  イベント絵をキャンバス全幅 contain（+縦スクロール）で表示する。`splitLayout` とは
   *  排他的なレイアウトモード（両方 true になる想定のscript.mdは無い、#530 スコープ外）。 */
  private fullscreenImage: boolean = false

  /** 文単位の厳密改頁 (#448)。frontmatter `sentence_per_page:` の値。既定 false＝従来どおり
   *  （novel は行数キャップで複数文が1ページに同居しうる／adv は markdown 行単位でページが決まる）。
   *  dialog_style（adv/novel）とは独立の軸で、両者と併用できる。true のとき、adv/novel どちらでも
   *  1 ページ＝厳密に 1 文になる:
   *   - novel: `paginateSentencesByLines` の行数キャップ（オーバーフロー防止・常時 ON）はそのまま、
   *     追加で「1 ページ最大 1 文」を重ねる（`getNovelPages` が `maxSentencesPerPage` を渡す）。
   *   - adv: markdown 行単位の `text[]` を捨て、`getAdvSentencePages` が `splitIntoSentences` で
   *     割った 1 文＝1 ページに切り替える。 */
  private sentencePerPage: boolean = false

  /** 背景クロスフェード・退場（終劇）フェード時間（ms）(#407)。frontmatter `background_fade_ms:` の値。
   *  `character_fade_ms`（立ち絵）と対称の per-game 数値設定。背景の表示（イン）・切り替え
   *  （クロスフェード）・退場（アウト）すべてこの時間で動く（余韻用途の「ものすごくゆっくり」も可）。
   *  初期値は現行の既定 `BACKGROUND_CROSSFADE_MS`（700ms）で、未指定作品は非回帰。
   *  `setBackgroundFadeMs` が [0, 5000] にクランプして保持し、null/非有限は既定へフォールバックする。 */
  private backgroundFadeMs: number = BACKGROUND_CROSSFADE_MS

  /** イベント絵の表示・退場フェード時間（ms）。frontmatter `event_image_fade_ms:` の値。
   *  個別ディレクティブの `フェード=` がある場合はそちらが優先され、未指定時だけ使う。
   *  初期値は 700ms。立ち絵/背景と同じ [0, 5000] クランプを使う。 */
  private eventImageFadeMs: number = EVENT_IMAGE_FADE_MS

  /** イベント絵の遷移モードのプロジェクト単位デフォルト (#599)。frontmatter `event_image_transition:`
   *  の値。parser がタグ解析時点で `遷移=` 未指定分を既にこの値へ解決済み（`Event.EventImage.transition`
   *  は常に解決済みの値を持つ）なので、通常はここまで未解決の `undefined` は来ない。念のための
   *  二重防御としてのみ使う（`ei.transition ?? this.eventImageTransitionDefault` 参照）。 */
  private eventImageTransitionDefault: EventImageTransition = 'Fade'

  /**
   * intermission.md 専用シーン (#404)。`assets/scripts/intermission.md` から取得・parse された
   * イベント列。null（未設定/取得失敗/空）なら endStory() は従来どおりフェードのみで終わり、
   * `endingOverlay`（PixiJS 内部描画、#630）の "to be continued..." 表示にフォールバックする
   * （完全オプトイン）。
   * `setIntermissionScene` が設定する。GameState には持たない（storyEnded 同様、演出の中間状態
   * ではなく一度きりの見た目でしかないため、セーブ/シークの対象外 — doctrine 規律3）。
   */
  private intermissionEvents: Event[] | null = null

  /** intermission.md 自身の frontmatter `background_fade_ms:` から読んだ消去フェード時間（ms）。
   *  物語本編の `backgroundFadeMs`（共有フィールド）は流用しない。未指定は
   *  `INTERMISSION_FADE_MS_DEFAULT` へフォールバックし、[0, 5000] にクランプする（clampFadeMs 共有）。 */
  private intermissionBackgroundFadeMs: number = INTERMISSION_FADE_MS_DEFAULT

  /** intermission.md 自身の frontmatter `character_fade_ms:` から読んだ立ち絵消去フェード時間（ms）。
   *  CharacterLayer が保持する per-game `characterFadeMs`（共有フィールド）は流用せず、
   *  `clearForSceneTransition` の呼び出し時に一度きりの override として渡す。 */
  private intermissionCharacterFadeMs: number = INTERMISSION_FADE_MS_DEFAULT

  /** intermission.md 自身の frontmatter `event_image_fade_ms:` から読んだイベント絵フェード時間（ms）。
   *  物語本編の `eventImageFadeMs` は流用せず、intermission タブロー描画中だけ一時適用する。 */
  private intermissionEventImageFadeMs: number = INTERMISSION_FADE_MS_DEFAULT

  /** intermission タブロー描画をフェード完了後に遅延実行するタイマー (#404)。goBack/seekTo/destroy で
   *  必ずキャンセルする（フェード中に巻き戻された後、古いタイマーが復元済みの画面を上書きする事故防止）。 */
  private intermissionTimer: number | null = null

  /** 主人公セリフの本文色 (#305)。固定でやや暖かいアイボリー #FFF0D8。
   *  protagonist と一致する話者の novel 本文をこの色にし、住人は純白 (#FFFFFF) のまま。
   *  `setProtagonistTextColor` は内部/テスト用フックで本番経路からは呼ばれない（frontmatter 上書きは未実装）。
   *  protagonist 未指定なら色差は起こさず全員白（後方互換）。 */
  private protagonistTextColor: number = parseColorToNumber(
    NovelRenderer.DEFAULT_PROTAGONIST_TEXT_COLOR,
    0xffffff
  )

  /** 住人（非主人公）の本文色 (#305)。純白。protagonist 未指定時は全員これになる。 */
  private static readonly RESIDENT_TEXT_COLOR = 0xffffff

  /**
   * 2窓モード（#444）で相手側（上窓）の本文色。淡い水色。
   * TUI 版 gymnasia#39「文字色: プレイヤー側は白、相手側は水色」に準拠。
   * `split_layout: true` + `protagonist:` 指定時のみ使う（#305 の主人公色とは別軸・別配色）。
   * 2窓モードの自分側（下窓）は既存 `RESIDENT_TEXT_COLOR`（白）をそのまま流用する。
   */
  private static readonly OPPONENT_TEXT_COLOR = 0x9ad4e8

  /** 主人公本文色の既定 (#305)。kako-jun 確定のやや暖かいアイボリー #FFF0D8。 */
  private static readonly DEFAULT_PROTAGONIST_TEXT_COLOR = '#FFF0D8'

  /** per-game デフォルトフォント (#147)。frontmatter `font_family:` の値。
   *  null なら DialogBox の組み込み既定 (`'Noto Sans JP', sans-serif`) を使う。
   *  per-line `[フォント:]` で個別 Dialog/Narration が上書き可能。 */
  private gameDefaultFontFamily: string | null = null

  /** runtime 既定フォント。Document.font_family / per-line 共に未指定のときの最終フォールバック (#147) */
  private static readonly RUNTIME_DEFAULT_FONT_FAMILY = "'Noto Sans JP', sans-serif"

  /** per-game デフォルト本文フォントサイズ (px) (#283 補遺)。frontmatter `font_size:` の値。
   *  null なら runtime 既定 40 を使う。 */
  private gameDefaultFontSize: number | null = null

  /** runtime 既定本文フォントサイズ。Document.font_size 未指定時の最終フォールバック (#283 補遺)。
   *  DialogBox コンストラクタの既定 (40) と一致させる。 */
  private static readonly RUNTIME_DEFAULT_FONT_SIZE = 40

  /** #293: 立ち絵 ready 後に本文 reveal を遅延する描画トークン。古い rAF/setTimeout を無効化する。 */
  private deferredTextRenderToken = 0

  /** 直近で render した Dialog/Narration に紐付く resolved font family (#147 R1 M1)。
   *  ensureFontLoaded の Promise 解決時に「いま表示中の Dialog のフォントか」を判定する race guard 用。
   *  別の Dialog に進んだ後に古い family が `setFontFamily` で上書きされる事故を防ぐ。 */
  private currentResolvedFontFamily: string | null = null

  /** playScript 実行中フラグ（再入ガード用 #220） */
  private isReplaying = false

  /** Wait タイマー（destroy 時キャンセル用）。TimeController 経由なので number */
  private waitTimer: number | null = null
  /** `[待機: 表示完了]` の polling timer。通常 Wait と同じ waitingForWait gate を使う。 */
  private waitDisplayCompleteTimer: number | null = null
  /** タイマー抽象化レイヤー (#228 動画エクスポート対応の土台) */
  private readonly time: TimeController = defaultTimeController

  /**
   * 遷移ゲートと `[ジャンプ:]` 予約の状態機械 (#825)。`waitingForChoice` / `waitingForWait` / `jumpState` /
   * `pendingEntry` / 世代 / 入力抑制フラグの唯一の書き手。レンダラは getter で読み、書き込みはメソッド経由。
   */
  private readonly transition = new TransitionState(this.time, () => this.setSkipMode(false))

  /** シーン索引・エントリ文書・遅延ロード・線形区間 (#823)。再生中の配列（rawEvents）は持たない */
  private readonly sceneIndex = new SceneIndex()

  /**
   * シーン入場の単一入口 (#826)。ADR 0003 の手続き（世代・confinement・解決・適用・失敗処理）と
   * `confinedSceneIds` を持つ。適用の実体（演出リセット・宣言的復元・通知）は Host として渡す下のコールバック。
   * メソッドをレンダラの公開 API にしないよう、`implements` ではなくオブジェクトで渡す。
   */
  private readonly entry = new SceneEntryController(
    {
      isActive: () => this.initialized,
      endStory: () => this.endStory(),
      applyFreshContext: (flags) => {
        this.gameState.fromJSON(flags)
        this.clearStoryEnded()
      },
      startEvents: (sceneId, events, opts) => {
        // 終劇状態の解除は適用の前 (#398, ADR 0003 §3 の5)。#386: 通常のシーン遷移が成立する経路なので、
        // 終劇状態は解除しておく（宣言的整合性の保険）。
        this.clearStoryEnded()
        this.cursor.setCurrentSceneId(sceneId)
        this.resetAndStartEvents([...events], opts)
      },
      restoreToScene: (scene, state, presetStoryEnded) => {
        if (presetStoryEnded) {
          // storyEnded 重複発火防止 (#460 セルフレビュー must M2): このメソッドは新規 construct された
          // renderer インスタンス（this.storyEnded は常にデフォルト false）に対して呼ばれる。下の
          // applyState は「前回値と比較して変化した時だけ onStoryEndedChangeCallback を発火する」ガードを
          // 持つが、新規インスタンスの初期値 false のままだと「true で復元＝変化あり」と誤判定され、
          // fluid 再マウントのたびに終劇 postMessage（NovelPlayer 側）が再送されてしまう。ここで復元先の
          // 値を先に直接セットしておき、applyState の比較を「変化なし」にして二重発火を防ぐ。
          // ("to be continued..." 表示自体は callback の発火有無とは独立に、applyState() 内の
          // syncEndingOverlayVisibility() が毎回呼ばれることで同期される (#630)。新規 renderer インスタンスの
          // `endingOverlay` は必ず非表示から始まる——旧 DOM 版のように React state が再マウントを跨いで
          // 保持される仕組みは無い——ため、この明示的な同期が無いと表示が消える regression になる。
          // 詳細は applyState() 内 syncEndingOverlayVisibility() 呼び出し箇所のコメント参照。)
          this.storyEnded = state.storyEnded
        }
        this.restoreToScene(scene, state)
      },
      notify: (notice) => {
        if (notice.kind === 'sceneChange') this.onSceneChangeCallback?.(notice.sceneId)
        else if (notice.kind === 'loadSuccess') this.save.notifyLoadSuccess(notice.origin)
        else this.save.notifyLoadFailure()
      },
      rederiveTransition: () => this.rederiveTransitionAtCurrentPosition(),
      isTextPaginated: () => this.isNovelStyle() || this.sentencePerPage,
    },
    this.sceneIndex,
    this.transition,
    this.cursor
  )

  /**
   * クイックセーブ・自動セーブ・セーブ/ロードメニュー・ロード通知 (#827)。`autoSavePending` と `SaveManager` の
   * 持ち主。`applyState` / `restoreToScene` / `getSnapshot` はステージとカーソルを横断する合成なのでレンダラに残し、
   * Host として渡す（`implements` ではなくオブジェクトで渡し、メソッドをレンダラの公開 API にしない）。
   */
  private readonly save = new SaveController(
    {
      getSnapshot: () => this.getSnapshot(),
      isStoryEnded: () => this.storyEnded,
      getPlayheadSceneId: () => this.getPlayheadSceneId(),
      showToast: (message) => this.showToast(message),
      ensureAudioContext: () => this.audioManager.ensureContext(),
      normalizeBackgroundFade: (fade) => normalizeBackgroundFade(fade),
      enter: (request) => this.entry.enter(request),
    },
    this.sceneIndex,
    this.transition,
    this.cursor
  )

  /**
   * 演出状態（背景・画面効果・カメラ3つ組・紙人形輪郭）の束ね役 (#828 7c)。`BackgroundController`（7a）・
   * `ScreenEffectsController`（7b）の持ち主で、`cameraMode` / `cameraOrientation` / `cameraElevation` /
   * `paperDollOutline` の唯一の書き手。タイマー停止と演出消去の分岐は `resetAndStartEvents` / `applyState` /
   * `destroy` の3か所だけが `stage.reset` / `restore` / `cancelAllTimers` + `release` として呼ぶ。
   * Host はオブジェクトで渡す（`implements` にしない）。立ち絵・大道具・背景板へのカメラと輪郭の伝播は
   * `applyCamera` / `applyPaperDollOutline` が担う（旧実装と同じ順序）。
   */
  private readonly stage = new Stage(
    {
      getAssetBaseUrl: () => this.assetBaseUrl,
      isSkipMode: () => this.skipMode,
      isInitialized: () => this.initialized,
      getScreenSize: () => ({ width: this.screenWidth, height: this.screenHeight }),
      getCrossfadeMs: () => this.backgroundFadeMs,
      setStagePosition: (x, y) => this.app.stage.position.set(x, y),
      isNovelStyle: () => this.isNovelStyle(),
      setDialogAlpha: (alpha) => {
        this.dialogBox.alpha = alpha
      },
      setSeekBarBlackoutHidden: (hidden) => this.seekBar.setBlackoutHidden(hidden),
      applyCamera: (mode, orientation, elevation, zoom, snap) => {
        // 背景板 → 大道具 → 立ち絵の順（#683/#692/#694。各レイヤーはカメラ状態を自前で保持する）。
        this.backgroundBoardLayer.setCamera(mode, orientation, elevation)
        this.propLayer.setCamera(mode, orientation, elevation)
        this.characterLayer.setCamera(mode, orientation, elevation)
        // ズーム (#702)。復元・リセット・スキップは snap で最終ポーズへ即時スナップする。
        this.cameraZoom.set(mode, zoom, snap)
      },
      applyPaperDollOutline: (config) => {
        this.characterLayer.setPaperDollOutline(config)
        this.propLayer.setPaperDollOutline(config)
      },
    },
    this.time
  )

  /**
   * シアターモードのカメラズーム (#702)。壁・背景板・スポットライト・大道具・立ち絵のコンテナに
   * 共通の scale/position を掛ける。状態（`cameraZoom`）の正本は `stage`、ここは描画反映だけを担う。
   */
  private readonly cameraZoom = new CameraZoomController(
    {
      getLayers: () => [
        this.wallLayer,
        this.backgroundBoardLayer,
        this.floorLayer,
        this.lightingLayer,
        this.propLayer,
      ],
      applyCharacterPose: (pose) => this.characterLayer.setZoomPose(pose),
      getFocus: (target) => this.characterLayer.getZoomFocus(target),
      getScreenSize: () => ({ width: this.screenWidth, height: this.screenHeight }),
      isSplitLayoutActive: () => this.characterLayer.getSplitLayoutRegion() !== null,
      isSkipMode: () => this.skipMode,
      hasCharacter: (target) => this.characterLayer.hasCharacter(target),
    },
    this.time
  )

  /**
   * 回転舞台 `[舞台回転]` (#704 第2弾)。直後から「進行を止めるイベント」までの壁・背景板・大道具・床の指定を
   * 裏側の舞台としてため、`processUntilNextTextEvent` のループ終端で回転（または即時切替）を起こす。
   * 立ち絵・舞台前面・天候・照明・幕には触れない。保存状態は持たない（ADR 0002）。
   */
  private readonly stageTurn = new StageTurnController(
    {
      layers: () => ({
        wall: this.wallLayer,
        backgroundBoard: this.backgroundBoardLayer,
        floor: this.floorLayer,
        prop: this.propLayer,
      }),
      isTheater: () => this.stage.cameraMode === 'Theater',
      isSkip: () => this.skipMode,
      isExporting: () => this.exporting,
      defaultMs: () => this.stageTurnDefaultMs,
      screenSize: () => ({ width: this.screenWidth, height: this.screenHeight }),
    },
    this.time
  )

  /** `[舞台回転]` の既定の所要時間（`character_fade_ms` と同じ値。第1弾の面の切り替えと同じ）。 */
  private stageTurnDefaultMs = 700

  /**
   * ディレクティブのハンドラ（`directives/`）に渡す最小ポート (#829)。値は getter で毎回最新を返す
   * （設定値は `setXxx` で後から差し替わるため getter が必須。レイヤーや Stage は代入がコンストラクタでの1回だけだが、
   * このフィールド初期化はその代入より前に走るので、生成時には未代入であり、getter で遅延評価する）。
   */
  private readonly directiveContext: DirectiveContext = this.createDirectiveContext()

  private createDirectiveContext(): DirectiveContext {
    // getter から private フィールドを読むための別名（アロー関数だと getter 構文にできない）。
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const r = this
    return {
      get stage() {
        return r.stage
      },
      get audio() {
        return r.audioManager
      },
      get characters() {
        return r.characterLayer
      },
      layers: {
        get video() {
          return r.videoLayer
        },
        get wall() {
          return r.wallLayer
        },
        get stageFront() {
          return r.stageFrontLayer
        },
        get weather() {
          return r.weatherLayer
        },
        get floor() {
          return r.floorLayer
        },
        get backgroundBoard() {
          return r.backgroundBoardLayer
        },
        get prop() {
          return r.propLayer
        },
        get curtain() {
          return r.curtainLayer
        },
        get lighting() {
          return r.lightingLayer
        },
        get eventImage() {
          return r.eventImageLayer
        },
        get telop() {
          return r.telopLayer
        },
        get dialogBox() {
          return r.dialogBox
        },
        get choiceOverlay() {
          return r.choiceOverlay
        },
      },
      env: {
        get skipMode() {
          return r.skipMode
        },
        get initialized() {
          return r.initialized
        },
        get assetBaseUrl() {
          return r.assetBaseUrl
        },
        get fullscreenImage() {
          return r.fullscreenImage
        },
        get eventImageFadeMs() {
          return r.eventImageFadeMs
        },
        get eventImageTransitionDefault() {
          return r.eventImageTransitionDefault
        },
        get gameDefaultFontFamily() {
          return r.gameDefaultFontFamily
        },
        get gameDefaultFontSize() {
          return r.gameDefaultFontSize
        },
        get runtimeDefaultFontFamily() {
          return NovelRenderer.RUNTIME_DEFAULT_FONT_FAMILY
        },
        get runtimeDefaultFontSize() {
          return NovelRenderer.RUNTIME_DEFAULT_FONT_SIZE
        },
        get telopAccentColorNum() {
          return r.telopAccentColorNum
        },
        get telopClearEpoch() {
          return r.telopClearEpoch
        },
      },
      hooks: {
        applyEventImageVisibility: () => r.applyEventImageVisibility(),
        clearTelopLayer: () => r.clearTelopLayer(),
        setCurtainZOrder: (front) => r.setCurtainZOrder(front),
        resolveNovelRoleXRatio: (character) => r.resolveNovelRoleXRatio(character),
        setCurrentBgmPath: (path) => {
          r.currentBgmPath = path
        },
        beginStageTurn: (ms) => r.stageTurn.begin(ms),
        deferToStageTurn: (fn) => r.stageTurn.defer(fn),
        cancelStageTurn: () => r.stageTurn.cancel(),
      },
    }
  }

  /** 背景（7a）。実体は `stage.background`。 */
  private get background(): BackgroundController {
    return this.stage.background
  }

  /** 画面効果（7b）。実体は `stage.effects`。 */
  private get screenEffects(): ScreenEffectsController {
    return this.stage.effects
  }

  /** セーブ/ロードオーバーレイ */
  private saveLoadOverlay!: SaveLoadOverlay

  /** バックログオーバーレイ */
  private backlogOverlay!: BacklogOverlay

  /** シークバー */
  private seekBar: SeekBar
  private currentBgmPath: string | null = null

  /**
   * 舞台構造の背景板レイヤー (#683)。`[背景板: path, depth: N]` の加算的な蓄積を管理する。
   * 既存の単一スロット背景（bgContainer / setBackground）とは完全に独立。
   */
  private backgroundBoardLayer: BackgroundBoardLayer
  /**
   * 舞台の壁 (#703)。背景板よりさらに奥の単一スロット（画像または動画）。settled state は
   * `NovelGameState.wall`。カメラ・ズームは背景板と同じ経路で受ける。
   */
  private wallLayer: WallLayer
  /**
   * 舞台前面 (#705)。画面最下部に下端揃え・横幅フィットで置く単一スロットの透過画像（エプロンの段差・手前の客席）。
   * 画面空間のオーバーレイでカメラのズーム・射影は受けない（`cameraZoom.getLayers` に入れない）。
   * stage 上はイベント絵の直後・画面効果（スクリム・暗転）より奥。settled state は `NovelGameState.stageFront`。
   */
  private stageFrontLayer: StageFrontLayer
  /**
   * 天候 (#706)。雨・雪・桜吹雪の粒を降らせる単一スロットの画面空間オーバーレイ。粒の位置は保存せず経過時間から
   * 決定論的に出す。カメラのズーム・射影は受けない（`cameraZoom.getLayers` に入れない）。
   * stage 上は舞台前面の直後・画面効果（スクリム・暗転）より奥。settled state は `NovelGameState.weather`（種類＋強さ）。
   */
  private weatherLayer: WeatherLayer
  /**
   * 床 (#706 第2弾)。画面の下部に下端揃え・横幅フィットで置く単一スロットのタイル画像の帯（高さ = 画面高さ × 高さ比）。
   * stage 上は動画の直後・タイトル画面と立ち絵より奥（背景板より手前、大道具・キャラより奥）。カメラのズームは
   * 背景板・壁と同じに受ける（`cameraZoom.getLayers` に入れる）が、射影（depth 縮小・仰角）は受けない。
   * settled state は `NovelGameState.floor`（パス＋高さ）。
   */
  private floorLayer: FloorLayer

  /**
   * 舞台構造の大道具レイヤー (#692)。`[大道具: path, depth: N]` の加算的な蓄積を管理する。
   * `backgroundBoardLayer` と独立した PixiJS レイヤー（数値 depth を共有する空間ではなく、
   * レイヤー自体の描画順で「背景板・キャラより手前、イベント絵/UIより奥」の群を作る）。
   */
  private propLayer: PropLayer

  /**
   * 追うスポットライトレイヤー (#693)。`[スポットライト: ...]`/`[スポットライト消灯]` の
   * 永続ライティング要素（settled state、`NovelGameState.spotlight`）を管理する。
   * `backgroundBoardLayer`/`propLayer` と同系統だが、独自の depth 空間は持たない
   * （光源なので `CharacterLayer` の直後・`propLayer` の前に固定、下記 addChild 順参照）。
   */
  private lightingLayer: LightingLayer

  /**
   * 幕レイヤー (#697)。`[幕: path]`/`[幕: path, 手前にキャラ]`/`[幕: 上げる]` の単一スロット
   * settled state（`NovelGameState.curtain`）を管理する。`backgroundBoardLayer`/`propLayer` と
   * 異なり depth 配置・カメラ射影は持たない。`characters_in_front` に応じて stage 上の
   * z-order を `setCurtainZOrder()` で切り替える（下記 addChild 順参照）。
   */
  private curtainLayer: CurtainLayer

  /** 枠なしモードのデフォルト値（per-game 設定）。per-scene の DialogBorderless で上書きされる */
  private defaultDialogBorderless: boolean = false

  /** 論理画面幅（aspectRatio から決定） */
  private screenWidth: number
  /** 論理画面高さ（aspectRatio から決定） */
  private screenHeight: number

  /** オートモード ON/OFF (#139) */
  private autoMode: boolean = false
  /** オートモード待機タイマー（destroy 時・手動操作時にキャンセル） */
  private autoTimer: number | null = null
  /** オートモード待機時間 ms（settings.autoWaitMs から更新） */
  private autoWaitMs: number = 2500
  /** autoMode 変更時の React 側同期コールバック */
  private onAutoModeChange: ((on: boolean) => void) | null = null

  /** スキップモード ON/OFF (#140) */
  private skipMode: boolean = false
  /** スキップ連続進行タイマー */
  private skipTimer: number | null = null
  /** 既読進捗（display index の Set）。docKey が設定されている場合に使用 */
  private readProgress: Set<number> = new Set()
  /** 既読進捗（sceneId + display index の Set）。scene ジャンプ後のスキップに使用 */
  private readLineProgress: Set<string> = new Set()
  /** 既読 sceneId の Set。選択肢の既読表示に使用 */
  private readSceneProgress: Set<string> = new Set()
  /** 既読永続化のキー（undefined の場合はスキップ機能無効） */
  private docKey: string | undefined = undefined
  /** skipMode 変更時の React 側同期コールバック */
  private onSkipModeChange: ((on: boolean) => void) | null = null

  /** SeekBar の active 変化時の React 側同期コールバック (#350)。NovelPlayer の丸ボタン
   *  フェード退避に繋ぐ（onAutoModeChange と同じ配線パターン）。 */
  private onSeekActiveChange: ((active: boolean) => void) | null = null

  /** 動画書き出し中かどうか (#446)。setExporting() 経由で更新される。NovelPlayer の
   *  実表示サイズ追従 ResizeObserver（containerRef 監視・#446）が、VideoExporter が
   *  書き出し中だけ一時的に上げているレンダラ解像度を誤って通常値へ巻き戻さないための
   *  ガードに isExporting() 経由で使う。 */
  private exporting = false

  /** SeekBar の縦位置をキャンバス表示倍率に追従させる ResizeObserver (#350)。 */
  private seekBarResizeObserver: ResizeObserver | null = null

  constructor(config?: { dialogBorderless?: boolean; aspectRatio?: AspectRatio }) {
    this.app = new Application()
    // config.aspectRatio は既に厳密な AspectRatio 型（呼び出し側 NovelPlayer が生の
    // frontmatter 文字列を parseAspectRatio で検証・解決済み。fluid 時は pickFluidAspectRatio
    // が '2:1'/'1:2'（#444）を含めて選ぶ）。ここで再度 parseAspectRatio に通すと、
    // parseAspectRatio 自身は raw 文字列用に '16:9'/'4:3'/'9:16' の3値しか認識しないため
    // '2:1'/'1:2' が無効値として黙って DEFAULT_ASPECT_RATIO に落ちてしまう（#444 で発覚した
    // 実バグ）。すでに検証済みの値を渡された前提で、未指定時のフォールバックだけ行う。
    const ratio = config?.aspectRatio ?? DEFAULT_ASPECT_RATIO
    this.screenWidth = ASPECT_RATIOS[ratio].width
    this.screenHeight = ASPECT_RATIOS[ratio].height
    this.characterLayer = new CharacterLayer(this.screenWidth, this.screenHeight, this.time)
    // 舞台構造の背景板レイヤー (#683)。他のレイヤーと同じ TimeController を共有し、
    // 動画 export でもスライドインが決定論的に進む（CharacterLayer/TelopLayer と同じ流儀）。
    this.backgroundBoardLayer = new BackgroundBoardLayer(
      this.screenWidth,
      this.screenHeight,
      this.time
    )
    // 舞台構造の大道具レイヤー (#692)。背景板と同じ TimeController を共有する。
    this.propLayer = new PropLayer(this.screenWidth, this.screenHeight, this.time)
    // 追うスポットライトレイヤー (#693)。対象キャラの現在座標を characterLayer に問い合わせる
    // ため、characterLayer 構築後にインスタンス化する。
    this.lightingLayer = new LightingLayer(
      this.screenWidth,
      this.screenHeight,
      this.characterLayer,
      this.time
    )
    // 幕レイヤー (#697)。背景板/大道具と同じ TimeController を共有する。
    this.curtainLayer = new CurtainLayer(this.screenWidth, this.screenHeight, this.time)
    this.bubbleLayer = new BubbleLayer(this.screenWidth, this.screenHeight)
    // イベント絵レイヤー (#351)。立ち絵と同じ TimeController を共有し、動画 export でも
    // フェードが決定論的に進む（this.time が virtual モードなら仮想時刻で駆動される）。
    this.eventImageLayer = new EventImageLayer(this.screenWidth, this.screenHeight, this.time)
    // テロップレイヤー (#674)。同じ TimeController を共有し、動画 export でもスライドイン/
    // フェードアウトが決定論的に進む（EventImageLayer と同じ流儀）。
    this.telopLayer = new TelopLayer(this.screenWidth, this.screenHeight, this.time)
    this.defaultDialogBorderless = config?.dialogBorderless ?? false
    this.dialogBox = new DialogBox({
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      borderless: this.defaultDialogBorderless,
    })
    // BubbleLayer は DialogBox の typewriter 状態を複製しない。可視本文文字数だけを購読し、
    // 自身の幅で折り返した本文へ同じ進捗を適用するため、操作・auto の進行契約は本文と一致する。
    this.dialogBox.onVisibleCharacterCountChange((count) =>
      this.bubbleLayer.setVisibleCharacterCount(count)
    )
    // this.time を共有注入する (#672 フォローアップ)。playSeSequence の gap 待機を
    // NovelRenderer の他タイマーと同じ TimeController 管理下に置き、cancelSeSequence() で
    // シーン遷移・終劇・状態復元・dispose 時にキャンセルできるようにする
    // （AudioManager コンストラクタのdoc comment参照）。
    this.audioManager = new AudioManager(this.time)
    // 動画入力レイヤ (#252)。音声ミックスのため audioManager を注入する。
    this.videoLayer = new VideoLayer(this.screenWidth, this.screenHeight, this.audioManager)
    // 舞台の壁レイヤー (#703)。動画の壁は VideoLayer と同じ AudioManager 経由で音をミックスする。
    this.wallLayer = new WallLayer(this.screenWidth, this.screenHeight, this.audioManager)
    // 舞台前面レイヤー (#705)。画像のみ・画面空間のオーバーレイ。
    this.stageFrontLayer = new StageFrontLayer(this.screenWidth, this.screenHeight)
    // 天候レイヤー (#706)。アンビエント演出と同じ TimeController の時計で粒を動かす。
    this.weatherLayer = new WeatherLayer(this.screenWidth, this.screenHeight, this.time)
    // 床レイヤー (#706 第2弾)。画像のみ・タイル帯。
    this.floorLayer = new FloorLayer(this.screenWidth, this.screenHeight)
    this.choiceOverlay = new ChoiceOverlay(this.screenWidth, this.screenHeight)
    // 選択肢の確定音／ホバー音を AudioManager で鳴らせるように注入 (#146)
    this.choiceOverlay.setAudioManager(this.audioManager)
    // タイトル画面オーバーレイ (#628 フェーズ2b)
    this.titleScreenOverlay = new TitleScreenOverlay(this.screenWidth, this.screenHeight)
    // 終劇オーバーレイ / toast オーバーレイ (#630)
    this.endingOverlay = new EndingOverlay(this.screenWidth, this.screenHeight)
    this.toastOverlay = new ToastOverlay(this.screenWidth, this.screenHeight)
    this.saveLoadOverlay = new SaveLoadOverlay(
      this.screenWidth,
      this.screenHeight,
      this.save.saveManager
    )
    this.save.attachMenu(this.saveLoadOverlay)
    this.backlogOverlay = new BacklogOverlay(this.screenWidth, this.screenHeight)
    // SeekBar の無操作タイマーも既存の TimeController 流儀に乗せる (#350)。
    this.seekBar = new SeekBar(this.screenWidth, this.screenHeight, this.time)
  }

  /**
   * PixiJS Application を初期化し、親要素に Canvas を挿入する
   */
  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      width: this.screenWidth,
      height: this.screenHeight,
      background: 0x000000,
      antialias: true,
      // #279: device DPI でラスタライズして表示を鮮明にする。resolution 未指定だと PixiJS は 1
      // 固定になり、論理解像度（9:16=450×800 等）の裏バッファをそのまま拡大表示するためボケる。
      // resolution=DPR で裏バッファを device DPI 倍に取り、PixiJS v8 の Text もそれに追従して鮮明になる。
      resolution: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      // autoDensity は false。true だと PixiJS が canvas の CSS サイズを論理 px に固定し、
      // wrapper（レターボックス内接矩形）に追従せず＝ブラウザを縮めても中身が縮まず左上クロップになる。
      // false にして CSS（NovelPlayer の [&>canvas]:w-full/h-full）に表示サイズを委ね、固定解像度の
      // レンダリングを wrapper サイズへスケールさせる（背景・立ち絵・文字ごと縮小拡大）。鮮明さは
      // 上の resolution=DPR が担保する（裏バッファは論理×DPR のまま）。
      autoDensity: false,
    })
    this.appInitialized = true
    this.choiceOverlay.setRenderResolution(this.getRenderResolution())
    this.titleScreenOverlay.setRenderResolution(this.getRenderResolution())
    this.endingOverlay.setRenderResolution(this.getRenderResolution())
    this.toastOverlay.setRenderResolution(this.getRenderResolution())

    // Pixi が init() 内で設定した touch-action:'none' を上書きする (#434)。
    // 詳細な判断根拠は NOVEL_CANVAS_TOUCH_ACTION 定義部のコメント参照。init() 完了直後
    // （Pixi 自身の設定が済んだ後）でなければ上書きしても意味がないため、ここで行う。
    this.setCanvasTouchAction(NOVEL_CANVAS_TOUCH_ACTION)

    container.appendChild(this.app.canvas as HTMLCanvasElement)

    // 下地ベタ（既定色・#409）と背景画像コンテナ。frontmatter `background_color:` の既定色（未指定なら黒）で
    // 全面を塗る。最初の背景絵はこの地色の上に alpha 0→1 で重なってフェードインする（コールドスタート）。
    this.stage.attachBackground(this.app.stage)

    // 舞台の壁レイヤー (#703)。背景板よりさらに奥——単一スロット背景の直後・背景板の手前（下）に置く。
    this.app.stage.addChild(this.wallLayer)

    // 舞台構造の背景板レイヤー (#683)。既存の単一スロット背景の直後・動画/立ち絵より下
    // （舞台の書割は背景と同じ「奥の情景」なので、動画・キャラより手前には出さない）。
    this.app.stage.addChild(this.backgroundBoardLayer)

    // 動画入力レイヤー (#252)。背景の直後・立ち絵の下に配置（背景の上、キャラの下）。
    this.app.stage.addChild(this.videoLayer)

    // 床レイヤー (#706 第2弾)。背景板・動画より手前、大道具・キャラより奥——舞台の地面でキャラの足元の下。
    // 背面スタックの一部なのでイベント絵の背面隠し（applyEventImageVisibility）の対象に入れる。
    this.app.stage.addChild(this.floorLayer)

    // タイトル画面オーバーレイ (#628 フェーズ2b)。ゲーム開始前に画面全体を覆う不透明背景＋
    // ボタンを描く。z 順は背景/動画レイヤーより上・立ち絵レイヤーより下——タイトルロゴは
    // `characterLayer.showImage()`（#628 フェーズ2a）に委譲するため、ロゴ Sprite が
    // このオーバーレイの不透明背景より確実に上に来るよう立ち絵レイヤーの直前に置く。
    // 立ち絵レイヤーより上の舞台レイヤーはタイトル表示中に見えてしまわないよう、可視性規則
    // （stageLayerVisibility.ts）で一括して隠す (#982)。ダイアログボックス/シークバーは
    // `showTitleScreen`/`hideTitleScreen` 側で個別に切り替える（当該メソッド参照）。ボタンは非インタラクティブな立ち絵 Sprite（eventMode
    // 未設定=既定で非インタラクティブ）に隠れてもヒットテストには影響しない。
    this.app.stage.addChild(this.titleScreenOverlay)

    // 立ち絵レイヤー
    this.app.stage.addChild(this.characterLayer)

    // 追うスポットライトレイヤー (#693)。光源なのでキャラの直後・大道具の前に配置する
    // （docs/architecture.md「シアターモード構想」→「レイヤーモデル」節: 奥 ← 背景板 ← キャラ ←
    // スポットライト ← 大道具 ← 手前）。
    this.app.stage.addChild(this.lightingLayer)

    // 舞台構造の大道具レイヤー (#692, #695)。立ち絵の直後に配置してキャラより前面に出す。
    // レイヤー内の depth は大道具どうしの奥行きだけを扱い、背景板・キャラとは独立する。
    this.app.stage.addChild(this.propLayer)

    // 幕レイヤー (#697)。既定位置（characters_in_front: false）は propLayer の直後・
    // eventImageLayer の手前——舞台全体を覆う通常の閉幕として最前面に配置される。
    // カーテンコール（characters_in_front: true）時は setCurtainZOrder() が
    // backgroundBoardLayer の直後・characterLayer の手前へ差し替える
    // （docs/architecture.md「シアターモード構想」→「レイヤーモデル」節参照）。
    this.app.stage.addChild(this.curtainLayer)

    // イベント絵レイヤー (#351)。z 順はテキストより背面・全背面レイヤー
    // （背景・背景板・動画・立ち絵・大道具）より前面（novelScrim/ダイアログより前）。
    this.app.stage.addChild(this.eventImageLayer)

    // 舞台前面レイヤー (#705)。キャラ・小道具・イベント絵・幕より手前、暗転・画面効果・会話窓・テロップより奥。
    // 画面空間のオーバーレイなので、イベント絵の背面隠し（applyEventImageVisibility）の対象にも入れない。
    // 暗転はこの上に重なるので、暗転中は前面も暗くなる。
    this.app.stage.addChild(this.stageFrontLayer)

    // 天候レイヤー (#706)。舞台前面の直後——キャラ・小道具・舞台前面・イベント絵・幕より手前、暗転・画面効果・
    // 会話窓・テロップより奥。画面空間のオーバーレイなのでイベント絵の背面隠しの対象にも、カメラズームの対象にも入れない。
    this.app.stage.addChild(this.weatherLayer)

    // novel スクリム (#283, z 順は立ち絵の上) → 暗転 → 画面効果オーバーレイ (#143, blackout より上・dialog より下)。
    // 3枚は連続して積む。実体は ScreenEffectsController (#828 7b)。
    this.stage.attachEffects(this.app.stage)

    // ダイアログボックス
    this.app.stage.addChild(this.dialogBox)

    this.app.stage.addChild(this.bubbleLayer)

    // テロップレイヤー (#674)。イベント絵より上・本文の上に重なる（telop_reserve: false 時）位置で、
    // SeekBar・選択肢・終劇オーバーレイよりは下（後続の addChild が z 順で上に来る）。
    this.app.stage.addChild(this.telopLayer)

    // シークバー（シナリオスライダ）。つまみ中心は下部丸ボタンの中央を貫く高さ (#350)。
    this.seekBar.setOnSeek((displayIndex) => {
      // スライダ操作は「シーク」であって「1つ進む」ではない。同フレームの handleAdvance を抑止する (#350)。
      this.transition.suppressNextAdvance()
      this.seekToTextEventDisplayIndex(displayIndex)
    })
    // active 変化を React 側へ伝え、丸ボタン行をフェード退避させる (#350)。
    this.seekBar.setOnActiveChange((active) => {
      // 起こすタップ（inactive→active）でも本文を送らないよう、この native pointerdown の後続
      // handleAdvance を 1 回抑止する (#350)。シーク無しの「操作可能化だけ」のタップでも、同フレームの
      // canvas pointerdown で dialogue が進むのを防ぐ（onSeek 経路と同じ suppressNextAdvance を使う）。
      if (active) this.transition.suppressNextAdvance()
      this.onSeekActiveChange?.(active)
    })
    this.app.stage.addChild(this.seekBar)
    // #350: 通常時も控えめに常時表示する（モバイルはホバー不可・Issue「ボタンより背面に見える」を満たす）。
    // active はスライダの実操作（SeekBar.handleClick 内の activate）だけで入る。デスクトップのホバーで
    // active にすると、カーソルを下部へ寄せただけで丸ボタンが退避し押しづらくなる（帯から離れても戻らない）
    // ため mousemove 起動は廃止した (#350)。キャンバスから出たら即 active を解除してボタンを戻す
    // （書き出し中は setExporting(true) で非表示）。
    if (this.app.canvas) {
      const canvas = this.app.canvas as HTMLCanvasElement
      canvas.addEventListener('mouseleave', this.handleCanvasMouseLeave)
      // #350: スライダのつまみ中心を「丸ボタンの実中央（固定 CSS px）」へ合わせる。Pixi 論理座標は
      // キャンバスの表示倍率でスケールするため、表示高さ≠論理高さだと丸ボタン中央からズレる。実倍率を
      // canvas.clientHeight から求めて補正し、resize/回転にも追従する（ResizeObserver 未対応環境は初期同期のみ）。
      // #677: 同じ理由でテロップの下端アンカーもボタン行の実高さを避けて配置する
      // （syncTelopBottomMarginToButtons）。
      this.syncSeekBarVerticalToButtons()
      this.syncTelopBottomMarginToButtons()
      if (typeof ResizeObserver !== 'undefined') {
        this.seekBarResizeObserver = new ResizeObserver(() => {
          this.syncSeekBarVerticalToButtons()
          this.syncTelopBottomMarginToButtons()
        })
        this.seekBarResizeObserver.observe(canvas)
      }
    }

    // シーンカウンター
    const counterStyle = new TextStyle({
      fontFamily: "'Noto Sans JP', sans-serif",
      fontSize: 16,
      fill: 0xa8dadc,
      fontWeight: 'bold',
    })
    this.counterText = new PixiText({ text: '', style: counterStyle })
    this.counterText.x = this.screenWidth - 20
    this.counterText.y = 16
    this.counterText.anchor.set(1, 0)
    // カウンターはデバッグ HUD 側で出すので Pixi 側では非表示にしておく
    this.counterText.visible = false
    this.app.stage.addChild(this.counterText)

    // 選択肢オーバーレイ（カウンターより上に配置）
    this.choiceOverlay.visible = false
    this.app.stage.addChild(this.choiceOverlay)
    // スクロール可能な選択肢リスト（#339）は縦方向ドラッグで操作する。touch-action:'pan-y' の
    // ままだとブラウザがその縦ドラッグをネイティブスクロールとして奪ってしまうため、表示中だけ
    // 'none' に戻し、非表示に戻ったら NOVEL_CANVAS_TOUCH_ACTION（'pan-y'）へ復帰させる (#434)。
    // ChoiceOverlay 自身は「ロック」ではなく「スクロール可能かどうか」しか知らないため、
    // touch-action への変換（scrollable → 'none'/'pan-y'）はここ（NovelRenderer 側）の責務。
    this.choiceOverlay.setOnScrollableChange((scrollable) => {
      this.setCanvasTouchAction(scrollable ? 'none' : NOVEL_CANVAS_TOUCH_ACTION)
    })

    // セーブ/ロードオーバーレイ
    this.app.stage.addChild(this.saveLoadOverlay)

    // バックログオーバーレイ
    this.app.stage.addChild(this.backlogOverlay)

    // 終劇オーバーレイ (#630)。z 順は全ゲーム画面要素（ダイアログ/選択肢/セーブロード/バックログ等）
    // より確実に手前に来るよう、この時点で最上位に積む（#628 セルフレビューで z-order 見落としが
    // 実機バグとして発覚した前例があるため、最上位への配置を明示する）。
    this.app.stage.addChild(this.endingOverlay)

    // toast オーバーレイ (#630)。終劇オーバーレイよりさらに手前——終劇後もセーブ不可メッセージ等の
    // トーストは表示されうるため（F5/F8 は quickSave/quickLoad 側で storyEnded 中は失敗扱いになるが
    // その失敗通知トースト自体は出る）、常にトーストが最前面に見えるようにする。
    this.app.stage.addChild(this.toastOverlay)

    // クリック/タップで進行
    this.app.canvas.addEventListener('pointerdown', this.handleAdvance)

    // キーボードで進行
    window.addEventListener('keydown', this.handleKeyDown)

    // バックログスクロール
    this.app.canvas.addEventListener('wheel', this.handleWheel, { passive: false })

    this.initialized = true
  }

  /**
   * イベントキューを設定して最初の表示イベントを表示
   */
  /**
   * 動画エクスポート (#228) 等で時刻を仮想モードに切り替えるためのアクセサ。
   * 通常 (live) では何もしなくて良い。
   */
  getTimeController(): TimeController {
    return this.time
  }

  /**
   * デバッグ用: 現在の実行状態を返す。開発時の HUD 表示に使う。
   */
  getDebugState(): DebugState {
    // 整形は純粋関数 `buildDebugState`（debugState.ts）。ここでは `this` の読み取りだけを行う。
    return buildDebugState({
      resolvedEvents: this.cursor.resolvedEvents,
      eventIndex: this.cursor.eventIndex,
      autoMode: this.autoMode,
      waitingForChoice: this.transition.waitingForChoice,
      waitingForWait: this.transition.waitingForWait,
      jumpState: this.transition.jumpState,
      currentResolvedFontFamily: this.currentResolvedFontFamily,
      sceneId: this.getPlayheadSceneId(),
      audioWarning: this.audioManager.getLastWarning(),
      characterStates: this.characterLayer.getCharacterStates(),
      spriteGeometry: (name) => {
        // 私的フィールドへの最小アクセス: x/y/scale をスナップショット
        const inner = this.characterLayer as unknown as {
          characters: Map<string, { sprite: { x: number; y: number; scale: { x: number } } }>
        }
        const st = inner.characters.get(name)
        return st ? { x: st.sprite.x, y: st.sprite.y, scale: st.sprite.scale.x } : undefined
      },
    })
  }

  /**
   * エントリ文書の events を読み込むだけで、開始（自動進行・描画）はしない (#734, ADR 0003 §4)。
   * `NovelPlayer` のマウント時に使い、続く初期入場（`restoreSnapshot` / `startFrom` / `quickLoad`）が
   * 1回で位置を確定する。`setEvents` と違い、エントリ冒頭の演出（SE・ボイス・`[待機]`）を実行しない。
   */
  loadEvents(events: Event[]): void {
    this.loadEntry(events, null)
  }

  /** `loadEvents` / `loadScenes` の共通部。エントリ文書と新規開始の sceneId を一緒に入れ替える。 */
  private loadEntry(events: Event[], entrySceneId: string | null): void {
    this.releaseTextures()
    // #662: エントリ文書の events を(再)供給する公開経路。ここでスナップショットしておけば、この後
    // quickLoad/restoreToScene が rawEvents を直前ルートの events で上書きしても、新規開始の
    // 'entry' 対象は常にこのエントリ文書へ戻れる。
    this.sceneIndex.setEntry(events, entrySceneId)
    this.cursor.markUnstarted()
    this.cursor.load([...events], this.gameState)
    this.preloadedUrls.clear()
    clearBackgroundPreload()
  }

  /** 読み込み済みテクスチャを解放する（`setEvents` / `loadEvents` が文書を入れ替えるとき）。 */
  private releaseTextures(): void {
    // PixiJS v8 の Assets.load で取得した Texture は Assets の内部キャッシュに残り続けるため、
    // キャッシュ済みURLを Assets.unload で解放してからキャッシュをクリアする（BackgroundController が行う）。
    this.background.releaseTextures()
    // イベント絵レイヤーのテクスチャも同じタイミングで解放する (#351 セルフレビュー指摘:
    // 背景と違い textureCache 相当の登録先が無く、GPU テクスチャが解放されずリークしていた)。
    this.eventImageLayer.disposeTextures()
    // 背景板レイヤーのテクスチャも同じ理由で解放する (#683、eventImageLayer と同じ流儀)。
    this.backgroundBoardLayer.disposeTextures()
    // 壁レイヤーのテクスチャも同じ理由で解放する (#703、backgroundBoardLayer と同じ流儀)。
    this.wallLayer.disposeTextures()
    // 舞台前面レイヤーのテクスチャも同じ理由で解放する (#705、wallLayer と同じ流儀)。
    this.stageFrontLayer.disposeTextures()
    // 床レイヤーのテクスチャも同じ理由で解放する (#706 第2弾、stageFrontLayer と同じ流儀)。
    this.floorLayer.disposeTextures()
    // 大道具レイヤーのテクスチャも同じ理由で解放する (#692、backgroundBoardLayer と同じ流儀)。
    this.propLayer.disposeTextures()
    // 幕レイヤーのテクスチャも同じ理由で解放する (#697、backgroundBoardLayer と同じ流儀)。
    this.curtainLayer.disposeTextures()
  }

  /**
   * エントリ文書の events を(再)供給して、先頭から新規開始する (#734, ADR 0003 §4)。
   * 「`loadEvents` + `startFrom({})`」で、flags のクリア・終劇状態の解除・`consecutiveJumps` のリセット・
   * `currentSceneId` のエントリへの揃え（線形ストリームなので null）は新規開始の入口が担う。
   * エディタのライブ再パースでも、旧 flags や旧 `currentSceneId` が残らない。
   * 開始しない読み込みだけが要るときは `loadEvents` を使う。
   *
   * エントリの新規開始はシーンの引き当てを要さないので、適用は同期で行われる（返す Promise は
   * 既に `entered` で解決済み。適用中の例外は `failed`（`apply-error`）になる）。
   */
  setEvents(events: Event[]): Promise<SceneEntryResult> {
    this.loadEvents(events)
    return this.startFrom({})
  }

  /**
   * 全シーンを設定して最初のシーンから開始する (「`loadScenes` + `startFrom({})`」)。
   *
   * 注意 (#284): これは `allScenes`（ジャンプ解決索引）の設定**と同時に**
   * 再生ストリームを `scenes[0].events` だけに差し替える。複数シーンを線形に
   * 連結して自動進行させたい場合は使わないこと（scene1 で停止する）。
   * 線形再生を維持したままジャンプ索引だけを差し替えたいときは
   * `setEvents(flattened)` ＋ `setJumpSceneIndex(scenes)` を使う。
   *
   * シーンが0件のときは、`setEvents([])` と同じく空の文書として新規開始する（旧文書を残さない）。
   */
  setScenes(scenes: EventScene[]): Promise<SceneEntryResult> {
    this.loadScenes(scenes)
    return this.startFrom({})
  }

  /**
   * 全シーンの索引と `scenes[0]`（エントリ）を読み込むだけで、開始はしない (#734, ADR 0003 §4)。
   * `loadEvents` の `scenes` 版。続く初期入場が位置を確定する。
   */
  loadScenes(scenes: EventScene[]): void {
    this.sceneIndex.setJumpSceneIndex(scenes)
    // 0件は空の文書（`loadEvents([])`）。旧文書を entryRawEvents / entrySceneId に残さない。
    this.loadEntry(
      scenes.length > 0 ? scenes[0].events : [],
      scenes.length > 0 ? scenes[0].id : null
    )
  }

  /**
   * シーンジャンプ解決専用の索引だけを設定する (#284)。
   *
   * `setScenes` と違い、再生ストリーム（resolvedEvents / eventIndex / currentSceneId）には
   * 一切触れない。現在の線形再生（`setEvents(flattenDocumentEvents(...))` で流し込んだ
   * イベント列）をそのまま走らせたまま、`jumpToScene` / `loadFromSaveData` / `startFrom` /
   * `resolveSceneTitle` がファイル横断（複数 MD）で sceneId を解決できるようにする。
   *
   * 単一 script 作品では「自ファイルのシーンだけ」を渡すことになり、`allScenes` の内容は
   * 従来の `setScenes` と同じ集合になる（＝挙動も従来どおり）。
   */
  setJumpSceneIndex(scenes: EventScene[]): void {
    this.sceneIndex.setJumpSceneIndex(scenes)
  }

  setMissingSceneResolver(
    resolver: ((sceneId: string) => Promise<EventScene[] | null>) | null
  ): void {
    this.sceneIndex.setMissingSceneResolver(resolver)
  }

  /**
   * デバッグ用の全選択肢ロック解除を設定する (#652)。true にすると、以降表示される
   * choice の `locked` 配列が `option.condition` の有無に関わらず全 false になる
   * （既存動作からの変更は無し＝false が既定）。
   */
  setDebugUnlockAllChoices(enabled: boolean): void {
    this.debugUnlockAllChoices = enabled
  }

  /**
   * 指定シーンへ進行する (#734)。進行（選択肢の確定・`[ジャンプ:]`・`playScript` の choice）専用の
   * 公開 API で、実体は単一の入口（`SceneEntryController.enter`）に委譲する薄いラッパー。
   * 読み込み済みのシーンなら同期で入場し（戻り値は解決済みの Promise）、未ロードなら
   * `missingSceneResolver` の完了を待つ。結果は Promise で返る。
   * 適用中の例外は、同期で入場する場合も遅延ロード後の非同期の適用でも、`failed`（reason: 'apply-error'）で
   * 解決する（Promise は reject しない。`startFrom` / `quickLoad` / `restoreSnapshot` も同じ）。
   */
  jumpToScene(sceneId: string): Promise<SceneEntryResult> {
    return this.entry.jumpTo(sceneId)
  }

  /**
   * Jump の遷移を予約する (#725/#733)。processDirective（到達時）と applyState（Jump 位置への復元後）
   * の両方がここを通る。状態の遷移・タイマー・循環上限の判定は TransitionState が持ち、ここは発火時に
   * 必要な入場の実行と警告だけを渡す。
   */
  private armJump(target: string): void {
    this.transition.arm(target, {
      isActive: () => this.initialized,
      warnChainLimit: () =>
        console.warn(
          `[name-name] [ジャンプ:] が本文なしで ${JUMP_CHAIN_LIMIT} 回を超えて連続したため停止します（循環の可能性）: ${target}`
        ),
      enter: () => this.entry.run({ kind: 'progress', sceneId: target, origin: 'jump' }),
    })
  }

  /**
   * 終劇状態を解除する。進行・新規開始は適用の前に呼ぶ: 適用の中の `resetAndStartEvents` →
   * `processUntilNextTextEvent` で起きる先回り終劇（#398）の `endStory()` が二重発火ガード
   * （`storyEnded`）で潰れないようにするため (#734, ADR 0003 §3 の5)。
   */
  private clearStoryEnded(): void {
    if (this.storyEnded) {
      this.storyEnded = false
      this.syncSeekBarEnabled()
      this.onStoryEndedChangeCallback?.(false)
      this.syncEndingOverlayVisibility()
    }
  }

  /**
   * 終劇は行き止まり（kako-jun 決定 2026-10-20, #815）。storyEnded の間は SeekBar を無効表示にして
   * 「操作できない」ことを見た目で示す。巻き戻し自体は goBack()/seekTo() の storyEnded ガード（#386）が
   * 根本で止める。storyEnded が書き換わる箇所（endStory / clearStoryEnded / applyState。セーブ復元の
   * restoreToScene も applyState を通る）から呼んで SeekBar の状態を GameState 由来の値に常に揃える。
   */
  private syncSeekBarEnabled(): void {
    this.seekBar.setDisabled(this.storyEnded)
  }

  /**
   * 入場が失敗して位置が動かないとき、現在位置から遷移状態を導出し直す (#734)。
   * `rearmPendingJumpAfterFailedRestore` を一般化したもの。
   * - 現在位置が Jump: 予約中だったものは再予約する。停止中のものは据え置く（失敗のたびに再試行・再警告しない）
   * - 現在位置が Choice: 閉じられていた選択肢を再表示する（選択肢由来の進行が失敗しても、選択肢が
   *   閉じたまま残らない。TUI の選択肢が選択に失敗して留まるのと同じ）
   */
  private rederiveTransitionAtCurrentPosition(): void {
    const current = this.cursor.resolvedEvents[this.cursor.eventIndex]
    if (typeof current === 'object' && current !== null && 'Jump' in current) {
      if (this.transition.isJumpPending()) this.rearmJumpAtCurrentPosition()
      return
    }
    if (
      typeof current === 'object' &&
      current !== null &&
      'Choice' in current &&
      !this.transition.waitingForChoice &&
      !this.storyEnded
    ) {
      this.processDirective(current)
      return
    }
    // 現在位置が Jump でなければ再予約できない。pending を残すと詰むので確定させる（防御）。
    this.transition.settleJumpIdle()
    // 入場を待つ間はゲートでオート送り・スキップのタイマーが弾かれ、再予約されずに止まっていた。
    // 本文表示中の位置なら、ON のままのモードを再開する (#734)。
    if (this.autoMode) this.dialogBox.setOnTypingDone(() => this.scheduleAutoAdvance())
    if (this.skipMode) this.scheduleSkipStep()
  }

  /**
   * confinement（在圏）外へのシーンジャンプを終劇として扱う (#386)。
   *
   * `?scene=` ディープリンク単独埋め込み（`confinedSceneIds` が設定されている場合のみ）で、
   * hub や他ファイルへの choice ジャンプが埋め込みの外側の内容を漏らさないようにする
   * （theo-hayami #20: 他住人/業一覧への遷移は埋め込み内の choice ではなく HTML リンクで行う設計）。
   *
   * `storyEnded` は演出の中間状態ではなく GameState 上の宣言的フラグとして持つ（ADR0002 /
   * doctrine 規律3）。フェード演出（背景・立ち絵）はこの一度きりの遷移に付随する見た目でしか
   * なく、確定する状態そのものは「背景も立ち絵もない終劇後」という終端値（下記で即座に確定）。
   * これにより getSnapshot/applyState の往復（goBack・seekTo・セーブ復元）は常にこの終端状態
   * をそのまま扱えばよく、フェード途中を再現する必要がない。
   *
   * 通常のハブ経由フロー（confinedSceneIds が null）では jumpToScene 側の判定により
   * ここには来ない。
   */
  private endStory(): void {
    if (this.storyEnded) return // 二重発火防止（連打等でフェード/コールバックを重複させない）
    this.storyEnded = true
    this.syncSeekBarEnabled()
    // skipMode を宣言的にリセットする (#424 セルフレビュー must)。通常の Choice 表示は
    // setSkipMode(false) を経由するが、全 option 圏外の短絡（#398）はそれを飛ばして直接
    // endStory() へ来るため、skipMode=true のままここに到達し得る。renderIntermissionTableau
    // が委譲する Label/Image は instant: this.skipMode を見るため、リセットしないと段階フェード
    // （#424 の目玉機能）が瞬間タブローに退行する。this.storyEnded=true により以後 advance() は
    // no-op になるので skipMode の実効的な意味は既に無いが、onSkipModeChange コールバックは
    // React 側（NovelPlayer）の Skip ボタン表示状態を同期する唯一の経路であり、skipMode は
    // NovelGameState/applyState の対象外（ADR0002 で意図的に除外）なので他に同期手段がない
    // (#424 re-review should)。setSkipMode() 自身は storyEnded ガードで no-op になり呼べない
    // ため、true→false の遷移が実際に起きた時だけ setSkipMode() と同じ意味論でコールバックを
    // 発火させる（skipMode===on なら何もしない、というガードと同じ形）。
    if (this.skipMode) {
      this.skipMode = false
      this.onSkipModeChange?.(false)
    }
    this.transition.leaveChoiceWait()
    this.choiceOverlay.hide()
    this.dialogBox.clearText()

    // 画面効果の後始末 (#386 レビュー S1)。Shake/Flash/Fade は fire-and-forget なので、
    // これらを仕込んだ直後の text から confinement 外への choice が続くと、そのタイマーが
    // endStory() 後も生き続けて "to be continued..." 画面に効果（Fade の色かぶり等）が
    // 残ってしまう。applyState() の画面効果リセットブロックと同じロジックをそのまま流用する。
    this.screenEffects.reset()
    this.screenEffects.resetStagePosition()
    // 追うスポットライト (#693) も同じ理由で消灯する。settled state ではあるが、"to be
    // continued..." 画面まで光が残るのは Shake/Flash/Fade の残留と同種の見た目の事故のため。
    this.lightingLayer.clear()

    // 消去フェード時間の決定 (#404): intermission.md 専用シーンが設定されているときは、
    // 物語本編の per-game `backgroundFadeMs`/CharacterLayer の `characterFadeMs`（他の全
    // トランジションに影響する共有フィールド）を流用せず、intermission.md 自身の frontmatter
    // 値（`setIntermissionScene` で受け取り済み）を使う。未設定時は従来どおり backgroundFadeMs。
    const eraseBackgroundFadeMs = this.intermissionEvents
      ? this.intermissionBackgroundFadeMs
      : this.backgroundFadeMs
    const eraseCharacterFadeMs = this.intermissionEvents
      ? this.intermissionCharacterFadeMs
      : undefined

    // BGM を止める (#386 レビュー M2)。終劇は物語上の終端で、以後 BGM を止める Bgm イベントは
    // 二度と来ないため、ここで止めないと BGM が永久に鳴り続ける（初見訪問者はセーブが無いため
    // 止める手段がない）。見た目のフェードと揃えて背景フェード時間（#407）でフェードアウトする。
    this.audioManager.stopBgm(eraseBackgroundFadeMs)
    this.currentBgmPath = null
    // SE シーケンス（#672）も同じ理由でキャンセルする。終劇後は [SE:] イベントも二度と
    // 来ないため、ここで止めないと gap 待機中の残り再生が "to be continued..." 画面の裏で
    // 鳴り続ける（BGM と同じ M2 由来の理屈、AudioManager.cancelSeSequence のdoc comment参照）。
    this.audioManager.cancelSeSequence()

    // 宣言的な終端状態を即座に確定する（背景/色地/動画/立ち絵はすべて「なし」）。
    // 見た目のフェードはこの下で別途アニメさせるが、GameState としては最初からこの値。
    this.background.forgetBackground()
    this.background.clearBackgroundColor()
    this.videoLayer.remove()
    // 壁 (#703) も動画を持ちうるので終劇で止める（ミュート=false の壁が終劇後も鳴り続けない）。
    this.wallLayer.clear()
    // 舞台前面 (#705) も終劇で片付ける（終劇後の画面に前面だけ残らない。保存状態も終端どおり null）。
    this.stageFrontLayer.clear()
    // 天候 (#706) も終劇で片付ける（終劇後の画面に粒だけ降り続けない。保存状態も終端どおり null）。
    this.weatherLayer.clear()
    // 床 (#706 第2弾) も終劇で片付ける（終劇後の画面に床だけ残らない。保存状態も終端どおり null）。
    this.floorLayer.clear()
    // 見た目のフェード演出（既存の背景クロスフェード / 立ち絵退場フェードの仕組みをそのまま流用）。
    // イベント絵はここで消さない。back=Hide のイベント絵を即 remove() すると背面可視性が戻り、
    // 元の全背面レイヤー（背景・壁・背景板・床・動画・立ち絵・大道具）が一瞬見える。
    // 終劇専用の黒フェードで画面を覆い切った後に片付ける。
    this.background.fadeOutBackgroundEntries(eraseBackgroundFadeMs)
    this.characterLayer.clearForSceneTransition(eraseCharacterFadeMs)
    const eraseVisualFadeMs = Math.max(eraseBackgroundFadeMs, eraseCharacterFadeMs ?? 0)
    this.screenEffects.startEndStoryBlackoutFade(eraseVisualFadeMs, () => {
      if (!this.storyEnded) return
      // イベント絵レイヤーも終劇で「なし」に確定する (#351)。黒で覆った後なら、
      // back=Hide の背面可視性を戻しても読者には黒しか見えない。
      this.eventImageLayer.remove()
      this.applyEventImageVisibility()
    })

    // #404: onStoryEndedChangeCallback の発火位置・タイミングは変更しない（postMessage 契約の正本）。
    this.onStoryEndedChangeCallback?.(true)
    // 終劇オーバーレイ表示 (#630): intermission.md 専用シーンが使われた場合はこの表示を出さない
    // （PixiJS のタブローに一本化し、二重表示を避ける）。判定は intermissionEvents の「この時点の」
    // 値で行う（syncEndingOverlayVisibility の JSDoc 参照。旧版 DOM の usedIntermissionScene と同じ
    // タイミングでスナップショットする）。
    this.syncEndingOverlayVisibility()

    // intermission.md 専用シーン (#404): 消去フェードが終わった後にタブローを1回だけ描画して
    // 凍結する。通常のシーン遷移機構（resetAndStartEvents/jumpToScene）には一切乗せない —
    // resetAndStartEvents は背景を finishBackgroundCrossfadeInstant() で瞬間消去する別経路であり、
    // ここに乗せると「幕がゆっくり降りる」演出がフェード無しの瞬間消去に負けて台無しになる。
    if (this.intermissionEvents) {
      const events = this.intermissionEvents
      if (this.intermissionTimer) this.time.clearTimeout(this.intermissionTimer)
      const delayMs = Math.max(eraseVisualFadeMs, this.intermissionCharacterFadeMs)
      this.intermissionTimer = this.time.setTimeout(() => {
        this.intermissionTimer = null
        // goBack/seekTo で storyEnded が解除されていたら描画しない（applyState 側でも
        // このタイマーをキャンセルするが、二重の安全策として storyEnded も確認する）。
        if (!this.initialized || !this.storyEnded) return
        this.screenEffects.hideEffectOverlay()
        this.renderIntermissionTableau(events)
      }, delayMs)
    }
  }

  /**
   * intermission.md 専用シーンのイベント列を静止画タブローとして処理し、そこで凍結する (#404, #424)。
   *
   * 通常再生ストリーム（rawEvents/resolvedEvents/eventIndex/history/currentSceneId/既読進捗）には
   * 一切触れない — intermission は `storyEnded` に付随する一度きりの見た目でしかなく、GameState に
   * 新しい可変状態を持ち込まない（doctrine 規律3。ADR0002 の storyEnded 除外方針をそのまま踏襲）。
   * `storyEnded=true` により以後 `advance()` は no-op のため、Choice によるプレイヤー操作介入や
   * タイプライター進行は実装しない。ただし `Wait { ms }` による段階的な演出（#424: 黒くなった後
   * "To Be Continued..." がじわっと出て、それからタイトルロゴもさらにじわっと出る、等）は下記の
   * とおり `startIndex` からの再入可能な処理としてサポートする。GameState 自体は書き換えない
   * タブロー専用のローカル・ステージングなので、規律3には抵触しない。
   *
   * 演出プリミティブは既存のものを再利用する（規律4・重複実装の回避）:
   * - Background/BackgroundColor/Enter/Exit/Label/Image/TitleShow 等のディレクティブ →
   *   `processDirective` にそのまま委譲する。skipMode はもう一時的に強制しない (#424) ため、
   *   Label/Image はそれぞれのネイティブフェードイン（`CharacterLayer.TITLE_CARD_FADE_MS` = 700ms）
   *   で表示される。
   * - Dialog/Narration（テキスト）→ `render()` のタイプライター/ボイス/既読マーク/オート進行は
   *   一度きりのタブローには不要なため、DialogBox の `setDialog`/`setNovelDialogProgressive` +
   *   `skipTypewriter()` の組み合わせ（advanceOrSkipTypewriter と同じ2手）で全文を直接・即時表示する。
   * - `Wait { ms }`（#424）→ 通常再生ストリーム（eventIndex/waitingForWait 等）には一切触れない、
   *   タブロー専用のローカル・ステージング。`this.intermissionTimer`（endStory() の初回描画待ちと
   *   同じフィールドを再利用。destroy/resetAndStartEvents/applyState で既にキャンセルされる）で
   *   指定 ms 後に `renderIntermissionTableau(events, i + 1)` を呼び、残りのイベントから再開する。
   * - Choice/WaitDisplayComplete/Flag/Jump は resolvedEvents/eventIndex を前提にする（Choice）か
   *   `NovelGameState` を恒久的に書き換える（Flag → `gameState.setFlag`）かのいずれかで、
   *   単発タブローには意味を持たない・持たせてはいけないため無視する（dev のみ warn）。特に Flag は
   *   docstring 冒頭の「GameState には一切触れない」を破るため、他の演出ディレクティブと違い明示除外が必須。
   * - Bgm/Se/Video 等はここでは意図的に素通しして `processDirective` に委譲する（エンディング演出の
   *   柔軟性を優先）。無視/素通しの基準は「GameState を書き換えるか」であり、Bgm/Se/Video は
   *   `currentBgmPath`/`AudioManager`/`VideoLayer` 止まりで GameState 自体は汚さないため対象外。
   *   `endStory()` 冒頭で本編 BGM を止めているのは「以後本編の Bgm イベントは来ない」ためであり、
   *   intermission.md 経由で新たに Bgm が鳴ること自体は妨げない（意図した上書き）。
   *
   * @param startIndex Wait ステージングの再開位置 (#424)。省略時 0（endStory からの初回呼び出しと
   *   後方互換）。
   */
  private renderIntermissionTableau(events: Event[], startIndex = 0): void {
    const previousEventImageFadeMs = this.eventImageFadeMs
    this.eventImageFadeMs = this.intermissionEventImageFadeMs
    try {
      for (let i = startIndex; i < events.length; i++) {
        const event = events[i]
        const textEvt = getTextEvent(event)
        // 回転舞台 (#704 第2弾) の範囲は本文・待機で閉じる（本編と同じ）。
        if (textEvt || (typeof event === 'object' && event !== null && 'Wait' in event)) {
          this.stageTurn.flush()
        }
        if (textEvt) {
          const name = textEvt.type === 'dialog' ? textEvt.character : null
          const text = textEvt.text.join('\n')
          // 2窓モード (#444): setBodyTextColor/setDialog 系より前にアクティブ側を確定する。
          if (this.isDualWindowMode()) {
            this.dialogBox.setDualWindowActiveRole(
              this.resolveDualWindowIsSelf(name) ? 'self' : 'opponent'
            )
          }
          this.dialogBox.setBodyTextColor(this.resolveBodyTextColor(name))
          if (this.isNovelStyle()) {
            this.dialogBox.setNovelDialogProgressive(name, text, 0, null)
          } else {
            this.dialogBox.setDialog(name, text)
          }
          this.dialogBox.skipTypewriter()
          // novel スクリムはセリフが表示されている間だけ敷く。render() と同じ判定を流用する。
          const hasVisibleText = text.replace(/[\s\u3000]/g, '') !== ''
          this.screenEffects.updateNovelScrim(hasVisibleText)
          // 凍結タブローには「次へ」が無いため、進行を示唆するインジケータは出さない。
          this.dialogBox.setIndicatorVisible(false)
          continue
        }
        if (typeof event === 'object' && event !== null && 'Wait' in event) {
          // タブロー専用のローカル・ステージング (#424)。通常再生ストリームには一切触れず、
          // intermissionTimer で ms 後に自分自身を i+1 から再入する（二重発火防止のため念のため
          // 既存タイマーを先に破棄する。endStory/前回のステージング完了時点では通常 null のはず）。
          if (this.intermissionTimer) this.time.clearTimeout(this.intermissionTimer)
          this.intermissionTimer = this.time.setTimeout(() => {
            this.intermissionTimer = null
            // goBack/seekTo で storyEnded が解除されていたら描画しない（applyState 側でも
            // このタイマーをキャンセルするが、二重の安全策として storyEnded も確認する）。
            if (!this.initialized || !this.storyEnded) return
            this.renderIntermissionTableau(events, i + 1)
          }, event.Wait.ms)
          return
        }
        if (
          event === 'WaitDisplayComplete' ||
          (typeof event === 'object' &&
            event !== null &&
            ('Choice' in event || 'Flag' in event || 'Jump' in event))
        ) {
          if (import.meta.env.DEV) {
            console.warn(
              '[name-name] intermission.md: Choice/[待機: 表示完了]/Flag/[ジャンプ:] は静止画タブローでは無視されます'
            )
          }
          continue
        }
        this.processDirective(event)
      }
    } finally {
      this.stageTurn.flush()
      this.eventImageFadeMs = previousEventImageFadeMs
    }
  }

  /**
   * 選択肢の各 option がロックされているか (#591, #652)。`option.condition` が未定義なら false。
   * `debugUnlockAllChoices` が true のときは全 false（全ルート強制解放）。
   */
  private computeChoiceLocked(options: ChoiceOption[]): boolean[] {
    return this.debugUnlockAllChoices
      ? options.map(() => false)
      : options.map((option) =>
          option.condition ? !this.gameState.checkFlag(option.condition) : false
        )
  }

  /**
   * 選択肢の確定（ChoiceOverlay のコールバックと `selectPendingChoice` の共通の実体）。
   * 確定できたら true、受け付けなかったら false（false だと ChoiceOverlay は確定音を出さない）。
   */
  private confirmChoiceJump(jump: string): boolean {
    // 入場中（別の遷移・復元の遅延ロードを待っている間）は確定を受け付けない。選択肢は表示されたまま、
    // 確定音も鳴らさない (#734)。
    if (this.transition.isGated('confirmChoice')) return false
    // 遷移先が確実に無い（解決手段も無い）なら、選択肢を閉じずその場に留める。閉じてから再表示すると
    // フェード再生・フォーカス初期化が起きるため (#734)。TUI の選択肢が選択に失敗して留まるのと同じ。
    if (
      isSceneIdConfined(jump, this.entry.confinedSceneIds) &&
      this.sceneIndex.isDefinitelyUnresolvable(jump)
    ) {
      console.warn(`[name-name] シーンが見つからない: ${jump}`)
      return false
    }
    // 同フレームの advance を抑制。入場が例外を投げても次の
    // イベントループで確実にリセットされるよう setTimeout(0) を使う (#211)
    this.transition.markChoiceJustSelected()
    this.transition.leaveChoiceWait()
    this.choiceOverlay.hide()
    // 進行として入場する。遷移先が見つからなければ、入口が選択肢を再表示する (#734)。
    void this.entry.run({ kind: 'progress', sceneId: jump, origin: 'choice' })
    return true
  }

  /**
   * いま表示中の選択肢の遷移先とロック状態を返す (#780 動画書き出しの自動選択用)。
   * 選択肢待ちでなければ null。
   */
  getPendingChoice(): {
    /** 選択肢の同一性を表すキー（元の Choice イベントの参照ごとの連番）。辺の記憶に使う */
    key: string
    sceneId: string | null
    options: Array<{ jump: string; locked: boolean }>
  } | null {
    if (!this.transition.waitingForChoice) return null
    const current = this.cursor.resolvedEvents[this.cursor.eventIndex]
    if (typeof current !== 'object' || current === null || !('Choice' in current)) return null
    const locked = this.computeChoiceLocked(current.Choice.options)
    const sceneId = this.getPlayheadSceneId()
    return {
      key: this.choiceIdentityKey(current),
      sceneId,
      options: current.Choice.options.map((o, i) => ({ jump: o.jump, locked: locked[i] ?? false })),
    }
  }

  /**
   * 元の Choice イベント（`resolveEvents` は参照を保つ）ごとの連番。展開後の位置（eventIndex）は
   * `[条件:]` の再展開や線形入場／ジャンプ入場で変わるので、同じ選択肢を同一視するキーには使えない (#780)。
   */
  private choiceIds = new WeakMap<object, number>()
  private nextChoiceId = 1
  private choiceIdentityKey(event: object): string {
    let id = this.choiceIds.get(event)
    if (id === undefined) {
      id = this.nextChoiceId++
      this.choiceIds.set(event, id)
    }
    return `choice#${id}`
  }

  /** レンダラが初期化済みで破棄されていないか (#780。書き出しの後始末が破棄済みレンダラに触らないため) */
  isReady(): boolean {
    return this.initialized
  }

  /**
   * 入場中（遅延ロード待ちなど）の進行を取り消し、解決しても何も適用させない (#780)。
   * 書き出しを録画前に中止したとき、遅延ロード中の `startFrom` が後から解決してプレビューを
   * 書き換えるのを防ぐ。入場中でなければ何もしない。
   */
  cancelPendingEntry(): void {
    if (!this.transition.hasPendingEntry) return
    this.transition.advanceGeneration()
    // 世代を進めるだけでは遷移状態が古いまま残る（遅延ロード待ちの [ジャンプ:] 予約など）ので、
    // 現在位置から導き直す。
    if (this.cursor.playbackStarted) this.rederiveTransitionAtCurrentPosition()
  }

  /**
   * 表示中の選択肢のうち、遷移先が `jump` のロックされていない option を確定する (#780)。
   * クリックと同じ確定経路を通る。選択肢待ちでない・該当 option が無い・ロック中・入場中なら false。
   */
  selectPendingChoice(jump: string): boolean {
    const pending = this.getPendingChoice()
    if (!pending) return false
    if (!pending.options.some((o) => o.jump === jump && !o.locked)) return false
    // ChoiceOverlay の確定経路（確定音を含む）を通す。クリックと同じ音が録音に乗る。
    return this.choiceOverlay.selectByJump(jump)
  }

  /**
   * 動画書き出しの停滞判定用の軽量な進行状況 (#780)。`getSnapshot()` のような全状態の複製をせず、
   * 位置の署名に使う値と、「進行中として扱うべき待ち」だけを返す。
   * - `waitMs`: `[待機: N]` で待っている間はその N ms。それ以外は null
   * - `videoPlaying`: 終わりのある動画の再生中
   */
  getExportProgress(): {
    sceneId: string | null
    eventIndex: number
    textIndex: number
    sentenceIndex: number
    waitMs: number | null
    videoPlaying: boolean
  } {
    const current = this.cursor.resolvedEvents[this.cursor.eventIndex]
    const waitMs =
      this.transition.waitingForWait &&
      typeof current === 'object' &&
      current !== null &&
      'Wait' in current
        ? current.Wait.ms
        : null
    return {
      sceneId: this.cursor.currentSceneId,
      eventIndex: this.cursor.eventIndex,
      textIndex: this.cursor.textIndex,
      sentenceIndex: this.cursor.sentenceIndex,
      waitMs,
      videoPlaying: this.videoLayer.isPlayingToEnd() || this.wallLayer.isPlayingToEnd(),
    }
  }

  /** 現在表示中のシーンID (#228 動画エクスポート用) */
  getCurrentSceneId(): string | null {
    return this.cursor.currentSceneId
  }

  /**
   * いま再生位置があるシーンの ID (#777)。エントリの線形ストリームを再生中は eventIndex がどのシーン区間に
   * あるかで答える（ジャンプ前の線形ストリームで `getCurrentSceneId()` が null でも、先頭のシーンの ID を返す）。
   * それ以外は `getCurrentSceneId()` と同じ。保存・既読・履歴が使う `currentSceneId`（ストリームの持ち主）は
   * 変えないので、セーブの意味は従来どおり。
   */
  getPlayheadSceneId(): string | null {
    const resolved = this.resolveLinearSegmentsNow()
    if (resolved)
      return segmentAt(resolved, this.cursor.eventIndex)?.sceneId ?? this.cursor.currentSceneId
    return this.cursor.currentSceneId
  }

  /**
   * 線形ストリームのシーン境界（シーンの間に挟んだ `SceneTransition`）を通過したとき、入ったシーンで
   * `onSceneChange` を発火する (#777)。作者の `[場面転換]`（シーン内）は境界ではないので何もしない。
   */
  private notifyLinearSceneEntered(): boolean {
    const resolved = this.resolveLinearSegmentsNow()
    if (!resolved) return false
    const entered = resolved.find((seg) => seg.separator === this.cursor.eventIndex)
    if (!entered) return false
    // 抜けたシーンを既読にする（線形に読み終えたシーン。選択肢・Jump に到達しない通常再生でも付く）
    const exited = resolved[resolved.indexOf(entered) - 1]
    if (exited && this.docKey) markReadScene(this.docKey, this.readSceneProgress, exited.sceneId)
    if (!isSceneIdConfined(entered.sceneId, this.entry.confinedSceneIds)) {
      // `?scene=` 埋め込みは、閉じ込め外のシーンへ入る進行を終劇にする (#386)。線形に続く次のシーンも同じ。
      this.endStory()
      return true
    }
    this.onSceneChangeCallback?.(entered.sceneId)
    return false
  }

  /** 入場時に展開した、エントリの線形ストリームのシーン区間。線形ストリームでなければ null (#777)。 */
  private resolveLinearSegmentsNow(): ResolvedSegment[] | null {
    return this.sceneIndex.resolveLinearSegmentsNow(
      this.cursor.currentSceneId,
      this.cursor.rawEvents,
      this.cursor.rawOffsets
    )
  }

  /** 登録済みシーンIDの一覧（順序保持）(#228 動画エクスポート UI 用) */
  getAllSceneIds(): string[] {
    return this.sceneIndex.getAllSceneIds()
  }

  /** 描画 canvas を取得する (#228 `captureStream` 用) */
  getCanvas(): HTMLCanvasElement | null {
    return (this.app?.canvas as HTMLCanvasElement | undefined) ?? null
  }

  /** AudioManager にアクセスする (#228 動画エクスポートの音声配線用) */
  getAudioManager(): AudioManager {
    return this.audioManager
  }

  /**
   * 論理解像度（screenWidth/screenHeight）を返す (#455)。construct 時に固定・以後不変
   * （上のコンストラクタ参照）。VideoExporter が書き出し終了時に実表示幅から
   * `computeDynamicRenderResolution` で解像度を再計算する際、論理サイズの分母として使う。
   */
  getScreenSize(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight }
  }

  /**
   * 現在のレンダラ解像度を返す (#279 動画書き出しの高解像度化)。
   * 書き出し前後で bump → restore するために退避用として使う。
   */
  getRenderResolution(): number {
    return this.app?.renderer?.resolution ?? 1
  }

  /**
   * レンダラ解像度を変更する (#279)。論理サイズ（screenWidth/Height）は据え置きで
   * 裏バッファだけ resolution 倍にする。動画書き出し時に一時的に上げ、終了後に元へ戻す。
   * 次フレームの再描画（VideoExporter は直後に jumpToScene する）で render-only 要素も
   * 高解像度で再生成される。PixiJS v8 の Text はレンダラ解像度に追従する。
   */
  setRenderResolution(resolution: number): void {
    if (!this.app?.renderer) return
    if (!(resolution > 0) || !Number.isFinite(resolution)) return
    this.app.renderer.resize(this.screenWidth, this.screenHeight, resolution)
    this.choiceOverlay.setRenderResolution(resolution)
    this.titleScreenOverlay.setRenderResolution(resolution)
  }

  /**
   * 進行中の背景画像ロードの完了を待つ (#734)。動画書き出しは新規開始で背景が地色から始まるため、
   * 未キャッシュの背景が録画の先頭に間に合うよう、録画開始前に待つ。ロードが無ければ即解決。
   * 失敗・破棄（より新しい背景要求）でも reject せず解決する。
   */
  async waitForBackgroundLoad(): Promise<void> {
    await this.background.waitForLoad()
  }

  /**
   * 動画 export 用に動画レイヤを頭出しする (#252)。
   * 録画開始（recorder.start）の前に呼び、表示中の動画を currentTime=0 へ seek して
   * ready を待ってから再生し直す。これで録画の先頭から動画が正しく映る/鳴る。
   * 動画が無ければ即解決。
   */
  async prepareVideosForExport(): Promise<void> {
    await this.videoLayer.prepareForExport()
    // 動画の壁 (#703) も同じく頭出しする。
    await this.wallLayer.prepareForExport()
  }

  /**
   * 動画書き出しの開始/終了をレンダラに通知する (#350)。
   * 現状は SeekBar を抑制（非表示）して録画にスライダが焼き込まれないようにするだけだが、
   * 将来ほかの UI（HUD 等）も書き出し中に退避させたくなったらここにぶら下げる薄い 1 メソッド。
   * VideoExporter が録画開始で true / 終了（cleanup・例外時を含む）で false を必ず呼ぶ。
   */
  setExporting(exporting: boolean): void {
    this.exporting = exporting
    this.characterLayer.setExporting(exporting)
    // 大道具・背景板の面の切り替え (#704) も書き出し中は回さない。
    this.backgroundBoardLayer.setExporting(exporting)
    this.propLayer.setExporting(exporting)
    // 天候 (#706) は書き出し中、reduced-motion でも降らせる（作品として出力するため）。
    this.weatherLayer.setExporting(exporting)
    this.seekBar.setExportSuppressed(exporting)
  }

  /**
   * 動画書き出し中かどうかを返す (#446)。NovelPlayer の実表示サイズ追従 ResizeObserver が、
   * VideoExporter が書き出し中だけ一時的に上げているレンダラ解像度（#279）を誤って
   * 通常値へ巻き戻さないためのガードに使う。
   */
  isExporting(): boolean {
    return this.exporting
  }

  /** シーン切り替えコールバックを登録する (#228) */
  setOnSceneChange(cb: ((sceneId: string) => void) | null): void {
    this.onSceneChangeCallback = cb
  }

  /**
   * 現在登録されている onEnd を取り出して null クリアする (#228 動画エクスポート用)。
   * VideoExporter が録画中に onEnd を占有する間、既存のリスナを退避するために使う。
   */
  takeOnEnd(): (() => void) | null {
    const prev = this.onEndCallback
    this.onEndCallback = null
    return prev
  }

  /**
   * 現在登録されている onSceneChange を取り出して null クリアする (#228 動画エクスポート用)。
   */
  takeOnSceneChange(): ((sceneId: string) => void) | null {
    const prev = this.onSceneChangeCallback
    this.onSceneChangeCallback = null
    return prev
  }

  /**
   * イベント配列をリセットし、最初のテキストイベントまで進めて描画する
   */
  private resetAndStartEvents(
    events: Event[],
    options?: Partial<CarryPolicy> & {
      /** 展開後のイベント列のこの位置から始める（既定 0）。線形ストリーム上のシーン先頭から始めるとき (#777)。 */
      startIndex?: number
      /** 線形ストリーム上のシーン先頭から始めるときの、元列での開始位置 (#799)。それ以前は入場時 flags で静的に展開する。 */
      fromRawIndex?: number
    }
  ): void {
    // 持ち越し方針は `carryPolicyFor` の戻り値（`SceneEntryController` が全項目を渡す）。省略は「持ち越さない」。
    // ここで1つの `CarryPolicy` にまとめ、以降の判定と `stage.reset` はこれだけを見る（個別フラグを増やさない）。
    const carry: CarryPolicy = {
      preserveBackgroundForTransition: options?.preserveBackgroundForTransition ?? false,
      carryBgm: options?.carryBgm ?? false,
    }
    this.cursor.markStarted()
    this.save.discardPendingAutoSave()
    this.transition.resetForNewPosition()
    if (this.waitTimer) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    this.clearWaitDisplayCompleteTimer()
    // intermission タブロー描画の遅延タイマーをキャンセルする (#404)。新規開始・jumpToScene で
    // 新しいシーンが始まった後、endStory() で仕込んだ古いタイマーが発火して上書きする事故を防ぐ。
    if (this.intermissionTimer) {
      this.time.clearTimeout(this.intermissionTimer)
      this.intermissionTimer = null
    }
    if (this.autoTimer) {
      this.time.clearTimeout(this.autoTimer)
      this.autoTimer = null
    }
    if (this.skipTimer) {
      this.time.clearTimeout(this.skipTimer)
      this.skipTimer = null
    }
    // 動画レイヤは背景と同じ扱いでクリアする (#252)。背景コントローラは動画に触れないのでここで消す。
    this.videoLayer.remove()
    if (!carry.preserveBackgroundForTransition) {
      // 背景板 (#683) も既存の単一スロット背景と同じ持続規律にする: 通常のシーン間ジャンプ
      // （preserveBackgroundForTransition=true）では持ち越し、この非 preserve 分岐（新しい
      // イベント列の最初の開始・setEvents() 経由）と明示的な `[場面転換]` でのみクリアする。
      this.backgroundBoardLayer.clear()
      // 壁 (#703) も背景板と同じ持続規律にする。
      this.wallLayer.clear()
      // 舞台前面 (#705) も背景板と同じ持続規律にする。
      this.stageFrontLayer.clear()
      // 天候 (#706) も背景板と同じ持続規律にする。
      this.weatherLayer.clear()
      // 床 (#706 第2弾) も背景板と同じ持続規律にする。
      this.floorLayer.clear()
      // 大道具 (#692) も背景板と同じ持続規律にする。
      this.propLayer.clear()
      // 幕 (#697) も背景板・大道具と同じ持続規律にする。z-order も既定位置へ戻す。
      this.curtainLayer.clear()
      this.setCurtainZOrder(false)
    }
    if (carry.preserveBackgroundForTransition) {
      this.characterLayer.clearForSceneTransition()
    } else {
      this.characterLayer.clear()
    }
    // 演出（背景・画面効果・カメラ3つ組・紙人形輪郭）をまとめてリセットする (#828 7c)。タイマー停止
    // （揺れ・フラッシュ/フェード）→ 背景（持ち越しなら進行中ロードの無効化とクロスフェードの畳み込み、
    // そうでなければ背景・地色を捨てる）→ 輪郭（持ち越さないときだけ解除。#699 でシナリオ全体で持続させる設計）
    // → 暗転解除 → カメラを既定（Novel）へ（背景板・大道具・立ち絵へも伝える）→ スクリム退避状態のリセット。
    // isBlackout / cameraMode と同じ規律: シーンをまたいで暗黙に持ち越さず、必要なら脚本で明示する。
    // カメラの伝播は立ち絵・大道具・背景板の clear / clearForSceneTransition の後でなければならない
    // （持ち越しで退場に入る立ち絵が、退場開始の後で再配置される旧順序を保つため、ここに置く）。
    // 順序: タイマー停止 → 演出消去（ここまで）→ BGM → カーソル → 再生開始。
    this.stage.reset(carry)
    this.choiceOverlay.hide()
    // BGM は「変えるまで鳴り続ける」(#724): 選択肢・物語進行によるジャンプ（carryBgm=true）では
    // 持ち越し、次シーン冒頭の同一曲 [BGM:] も頭出ししない（AudioManager.playBgm の同一 URL 継続分岐）。
    // 新規開始（setEvents・startFrom の ?scene= / ?debug_scene=）では従来どおり停止する。
    // 背景等の持ち越し（preserveBackgroundForTransition）とは独立した別オプション。
    if (!carry.carryBgm) {
      this.audioManager.stopBgm(0)
    }
    // SE シーケンス（#672）の gap 待機タイマーをキャンセルする。新しいシーンへ遷移した後も
    // 前シーンで発火した [SE: 複数候補] の残りが setTimeout 越しにバックグラウンド再生され
    // 続けないようにする（他タイマーと同じ規律、AudioManager.cancelSeSequence のdoc comment参照）。
    this.audioManager.cancelSeSequence()
    // イベント絵レイヤーは新しいイベント列の開始で常にクリアする (#351)。前シーンのイベント絵は
    // 引き継がない（両分岐共通）。back=Hide で隠れていた全背面レイヤー
    // （背景・背景板・動画・立ち絵・大道具）の可視性もここで戻す。
    this.eventImageLayer.remove()
    this.applyEventImageVisibility()
    // テロップ (#674) も新しいイベント列の開始で常にクリアする。前シーンの表示中テロップを
    // 引き継がない（演出の中間状態を持ち越さない、eventImageLayer と同じ規律）。
    this.clearTelopLayer()
    // currentBgmPath は上の stopBgm と対で、持ち越し時（#724）は保持して snapshot/save と整合させる。
    if (!carry.carryBgm) {
      this.currentBgmPath = null
    }
    // 追うスポットライト (#693) も新しいシーンの開始で常に消灯する。isBlackout/cameraMode と
    // 同じ規律: target キャラは次シーンに存在するとは限らないため、シーンをまたいで暗黙に
    // 持ち越さず、そのシーンで必要なら明示的に [スポットライト:] を書く。
    this.lightingLayer.clear()
    // シーン遷移時にダイアログを明示的にクリアする（前シーンの残留テキスト防止 #217）
    this.dialogBox.clearText()
    // 吹き出しも DialogBox と同じ一時的な本文表示であり、シーン/イベント列の境界をまたいで
    // 残してはならない。
    this.bubbleLayer.hide()
    this.textDisplayIsBubble = false
    // per-scene [枠なし]/[枠あり] はシーン遷移でデフォルト値にリセット
    this.dialogBox.setBorderless(this.defaultDialogBorderless)
    // novel (#283): setBorderless が borderless を上書きしたので novel 幾何を再適用する
    // （スクリム退避状態と alpha のリセットは上の `stage.reset` で済んでいる）。
    this.dialogBox.setNovelMode(this.isNovelStyle())

    // 元イベントを保持し、Condition をフラグに基づいて展開
    // novel 改頁キャッシュ (#283)・adv 文単位ページキャッシュ (#448) などの派生データも load が破棄する。
    this.cursor.load(events, this.gameState, options?.startIndex ?? 0, options?.fromRawIndex ?? 0)
    // 先読み済み URL 集合 (#389) もイベント列に紐づくので破棄する。setEvents は表示済み背景を
    // Assets.unload するため、ここでクリアしないと「積み済み」誤判定で先読みがスキップされ
    // コールドロードに戻る。新しいイベント列＝先読み状態も作り直すのが正しい（末尾の
    // processUntilNextTextEvent → preloadUpcomingAssets が先頭から積み直す）。
    this.preloadedUrls.clear()
    clearBackgroundPreloadQueue()
    // 話者交代追跡 (#286) をリセット（前シーン末尾の話者を引きずらない）。
    // resetAndStartEvents 直後の最初の Dialog で初めて話者がセットされ、初回は nudge しない
    // （何もないところから登場する初回は「交代」ではない）。
    this.lastSpeaker = null

    this.processUntilNextTextEvent()

    // 立ち絵 →（同時/直後に）テキスト の順序保証 (#293)。立ち絵 sprite を同期生成してから
    // 最初のテキストイベントのスナップショットを記録し（afterShow）、novel は立ち絵テクスチャの
    // 用意完了まで render を遅延、adv/skip は従来どおり同期描画する。
    this.showCharacterThenRender(() => this.pushSnapshot())
  }

  /**
   * 背景画像のベースURLを設定する
   */
  setAssetBaseUrl(url: string): void {
    this.assetBaseUrl = url
    this.dialogBox.setIndicatorAssetBaseUrl(url)
    // 動画レイヤも同じベース URL で相対パスを URL 化するため伝播する (#252)
    this.videoLayer.setAssetBaseUrl(url)
    // イベント絵レイヤーも同じベース URL で相対パスを URL 化するため伝播する (#351)
    this.eventImageLayer.setAssetBaseUrl(url)
    // 選択肢オーバーレイも既読/未読アイコン (#598 追記3, assets/images/read-icon.webp /
    // assets/images/unread-icon.webp) の先読みに同じベース URL を使う。
    this.choiceOverlay.setAssetBaseUrl(url)
  }

  /**
   * タイトル画面を表示する (#628 フェーズ2b)。旧 DOM `TitleOverlay.tsx` の PixiJS 版。
   * ロゴ画像 (`${assetBaseUrl}/images/title.png`) は `characterLayer.showImage()`
   * （#628 フェーズ2a のピクセレート遷移機構を持つ）に読み込みを委譲し、`TitleScreenOverlay`
   * 自身は背景/フォールバックテキスト/ボタンだけを描く（表示の合成は本メソッドが仲介する）。
   *
   * ボタンのコールバックは `justSelectedChoice` フラグでラップする。ChoiceOverlay の選択と
   * 同じ理由（#146）: canvas の native `pointerdown` リスナー（`handleAdvance`）が同一タップ
   * ジェスチャで二重発火した場合に、タイトル操作直後の意図しない `advance()` を 1 回だけ
   * 抑止する。
   *
   * z 順の制約 (#628 フェーズ2b): `titleScreenOverlay` は立ち絵レイヤーより下に置かれている
   * （ロゴ Sprite が `characterLayer` 経由で描かれ、不透明背景より上に見える必要があるため）。
   * その結果、立ち絵レイヤーより上の層はタイトル背景で隠れない。旧 DOM 版は canvas 全体を不透明 div で
   * 覆っていたためこれらは完全に不可視だった——同じ見た目を再現するため、ここで明示的に隠し
   * `hideTitleScreen()` で戻す。舞台レイヤー（立ち絵・照明・大道具・幕・イベント絵・舞台前面・天候・
   * 吹き出し・テロップ・床）の可視性は `stageLayerVisibility.ts` の1つの規則で決め
   * `applyStageLayerVisibility()` が適用する (#982)。復元時も強制 true にせず、背面隠し等の
   * 「あるべき可視性」に従う。会話窓とシークバーはここで個別に切り替える。
   *
   * 実機検証で発覚した実バグ (#628 フェーズ2b): エントリスクリプトは NovelPlayer マウント時点で
   * 既に最初の text event まで自動進行済み（PlayerScreen 側コメント参照）——`[イベント絵:]`
   * 等で `eventImageLayer` に何か表示されていた場合、これも立ち絵レイヤーと同じく
   * titleScreenOverlay より上の z 順のため、タイトル背景を突き抜けて見えてしまう
   * （gymnasia の実プロジェクトで実際に発生・確認: エントリ冒頭の `gymnasia_logo_square.webp`
   * イベント絵がタイトル画面のロゴであるかのように透けて見えた）。
   */
  showTitleScreen(opts: {
    title: string
    hasSaveData: boolean
    dark?: boolean
    onNewGame: () => void
    onContinue: () => void
    onOpenSettings: () => void
    onBack: () => void
    /** 「終了」ボタンを表示するか (#643)。TitleScreenShowOptions 参照。既定 true。 */
    showExitButton?: boolean
  }): void {
    this.dialogBox.visible = false
    // タイトル画面中は立ち絵レイヤーにロゴを載せるので、カメラズームを一時的に無効にする (#702)。
    this.cameraZoom.setSuppressed('title', true)
    this.seekBar.setTitleScreenHidden(true)
    // split_layout の一時解除（上記 titleScreenSavedCharacterSplitRegion の JSDoc 参照）。
    this.titleScreenSavedCharacterSplitRegion = this.characterLayer.getSplitLayoutRegion()
    if (this.titleScreenSavedCharacterSplitRegion) {
      this.characterLayer.setSplitLayoutRegion(null)
    }
    const suppressAdvanceThenRun = (fn: () => void) => () => {
      this.transition.markChoiceJustSelected()
      fn()
    }
    this.titleScreenOverlay.show({
      title: opts.title,
      hasSaveData: opts.hasSaveData,
      dark: opts.dark,
      onNewGame: suppressAdvanceThenRun(opts.onNewGame),
      onContinue: suppressAdvanceThenRun(opts.onContinue),
      onOpenSettings: suppressAdvanceThenRun(opts.onOpenSettings),
      onBack: suppressAdvanceThenRun(opts.onBack),
      showExitButton: opts.showExitButton,
    })
    // ロゴ画像。読み込み成否は onLoaded/onError で TitleScreenOverlay に伝え、
    // フォールバックテキストの表示可否を切り替える（#628 フェーズ2b、CharacterLayer.showImage
    // 拡張分。'transition' は未指定＝既定 'Fade' のまま — タイトルはピクセレート遷移対象外）。
    this.characterLayer.showImage({
      id: NovelRenderer.TITLE_LOGO_IMAGE_ID,
      path: 'title.png',
      x: 0.5,
      y: TITLE_LOGO_Y_RATIO,
      assetBaseUrl: this.assetBaseUrl,
      onLoaded: () => this.titleScreenOverlay.hideFallbackText(),
      onError: () => {
        // 404 等: フォールバックテキストは表示したまま（初期状態がそのまま正）。何もしない。
      },
    })
    // 実バグ修正 (#628 フェーズ2b): 上記 titleScreenOverlay.show() は呼ばれるたびに無条件で
    // 新しい titleText（既定 visible: true）を作り直す。一方 showImage() は同 id 再表示時
    // （`hideTitleScreen()` を経由せずロゴを破棄しないまま再度 showTitleScreen() が呼ばれた場合、
    // 例: NovelPlayer の effect で title/hasSaveData が変わり再レンダーされたケース）は
    // `existing` 分岐に入りテクスチャ差し替えを行わず、onLoaded も発火しない
    // （ただしテクスチャが未ロード（`hasLoadedTexture()` が false）かつロード in-flight でない
    // 場合は例外的に最新の `assetBaseUrl` で再ロードを試み、成功時は onLoaded が発火する。#646）。
    // そのため「ロゴは既に表示済みなのにフォールバックテキストだけ再び見えてしまう」不整合が
    // 起きていた。showImage() は existing 分岐を同期的に処理するため、直後にロード済みかを
    // 確認すれば判定できる（新規ロード中はまだ false のはずで、それは正しい——後で onLoaded が
    // 呼ばれる）。
    if (this.characterLayer.hasLoadedTexture(NovelRenderer.TITLE_LOGO_IMAGE_ID)) {
      this.titleScreenOverlay.hideFallbackText()
    }
    // タイトルより手前に積まれる舞台レイヤー（大道具・照明・幕・立ち絵・イベント絵・舞台前面・天候・吹き出し・
    // テロップ）と、タイトル中は見せない床を、1か所の規則（stageLayerVisibility.ts）で隠す (#982)。
    // ロゴ sprite が登録された後（立ち絵レイヤーはロゴだけ免除する）に呼ぶ。
    this.applyStageLayerVisibility()
  }

  /**
   * タイトル画面を非表示にする (#628 フェーズ2b)。ロゴ画像は `characterLayer.remove()` で
   * 即時破棄する——`showImage` は同 id 再表示時にテクスチャを差し替えない仕様
   * （`existing` 分岐、位置更新のみ。ただしテクスチャが未ロード（`hasLoadedTexture()` が false）
   * かつロード in-flight でない場合は例外的に最新の `assetBaseUrl` で再ロードを試みる。#646）
   * のため、破棄せず残すと次回 `showTitleScreen()` が新規ロード・フェードイン演出を
   * やり直せなくなる。
   */
  hideTitleScreen(): void {
    this.titleScreenOverlay.hide()
    this.characterLayer.remove(NovelRenderer.TITLE_LOGO_IMAGE_ID, { instant: true })
    // showTitleScreen() で隠した層を復元する（上記 JSDoc 参照）。
    this.dialogBox.visible = !this.textDisplayIsBubble
    this.cameraZoom.setSuppressed('title', false)
    this.seekBar.setTitleScreenHidden(false)
    // 強制 true にせず、背面隠し（イベント絵）を含む「あるべき可視性」へ戻す (#982)。上の overlay.hide() で
    // titleScreenOverlay.visible が false になっているので、規則は titleActive=false で評価される。
    this.applyStageLayerVisibility()
    // split_layout の一時解除を復元する（titleScreenSavedCharacterSplitRegion の JSDoc 参照）。
    if (this.titleScreenSavedCharacterSplitRegion) {
      this.characterLayer.setSplitLayoutRegion(this.titleScreenSavedCharacterSplitRegion)
      this.titleScreenSavedCharacterSplitRegion = null
    }
  }

  /**
   * 終劇オーバーレイ ("to be continued..." + 埋め込み元ロゴ) を表示する (#630)。
   * ロゴは `characterLayer.showImage()`（#628 フェーズ2a のフェード機構）に委譲する。
   * `transition` は指定しない＝既定 Fade のまま（この用途にピクセレート演出は不要、Issue 方針）。
   * 呼び出しは常に `syncEndingOverlayVisibility()` 経由（このメソッド自体は判定を持たない）。
   *
   * @param instant `showImage()` に渡す即時表示フラグ (#630 セルフレビュー must M1)。goBack/seekTo/
   *   セーブ復元（`applyState()` 経由）は true を渡し、フェード（既定 700ms）を発火させない。
   *   通常の物語進行による storyEnded 遷移（`endStory()` 経由）は false（既定 Fade）のまま。
   */
  private showEndingOverlay(instant = false): void {
    this.endingOverlay.setFontFamily(
      resolveFontFamily(null, this.gameDefaultFontFamily, NovelRenderer.RUNTIME_DEFAULT_FONT_FAMILY)
    )
    this.endingOverlay.show()
    // 終劇ロゴも立ち絵レイヤーに載るので、タイトル画面と同様にカメラズームを一時無効にする (#702)。
    this.cameraZoom.setSuppressed('ending', true)
    // 旧 DOM 版と同じく `assetBaseUrl` が無ければロゴ表示自体を試みない（404 ログを増やさない。
    // `showTitleScreen()` は常に呼ぶ設計だが、あちらはフォールバックテキストを持つため無条件で
    // 呼んでも実害が無い——終劇ロゴはフォールバックが無い仕様のため、ここでガードする）。
    if (this.assetBaseUrl) {
      const logoSize = this.screenWidth * NovelRenderer.ENDING_LOGO_WIDTH_RATIO
      const centerX = NovelRenderer.ENDING_LOGO_PADDING_PX + logoSize / 2
      const centerY = NovelRenderer.ENDING_LOGO_PADDING_PX + logoSize / 2
      this.characterLayer.showImage({
        id: NovelRenderer.ENDING_LOGO_IMAGE_ID,
        path: 'title.png',
        x: centerX / this.screenWidth,
        y: centerY / this.screenHeight,
        size: logoSize,
        maxHeight: NovelRenderer.ENDING_LOGO_MAX_HEIGHT_PX,
        assetBaseUrl: this.assetBaseUrl,
        instant,
        onError: () => {
          // 404 等: 旧 DOM 版と同じくロゴは単に出さない（テキストへのフォールバックは無い）。
        },
      })
    }
  }

  /** 終劇オーバーレイを非表示にする (#630)。ロゴは `hideTitleScreen()` と同じく即時破棄する。 */
  private hideEndingOverlay(): void {
    this.endingOverlay.hide()
    this.cameraZoom.setSuppressed('ending', false)
    this.characterLayer.remove(NovelRenderer.ENDING_LOGO_IMAGE_ID, { instant: true })
  }

  /**
   * 終劇オーバーレイの表示/非表示を現在の状態から同期する (#630)。
   *
   * 旧 DOM 版 `NovelPlayer.tsx` の `storyEnded && !usedIntermissionScene` 判定を内部化したもの。
   * `usedIntermissionScene` は旧版では「storyEnded が true に立ち上がった瞬間の
   * `hasIntermissionScene()`」を React state にスナップショットし、以後 `intermissionEvents` が
   * 変化してもライブ再評価しない設計だった（早すぎる fetch で intermission がまだ届いていない
   * 場合に表示が消えてしまう事故を防ぐため）。このメソッドを `this.storyEnded`/
   * `this.intermissionEvents` が変化する箇所（`endStory()`/`jumpToScene` の巻き戻し/`applyState()`）
   * それぞれの変化直後に呼ぶことで、呼び出しタイミング自体が同じスナップショット効果を持つ
   * （`intermissionEvents` は `setIntermissionScene()` からしか変わらず、そちらはこのメソッドの
   * 呼び出し元では無いため、意図せず再評価されることはない）。
   *
   * @param instant `showEndingOverlay()` へそのまま渡す即時表示フラグ (#630 セルフレビュー must M1)。
   *   既定 false（Fade）。goBack/seekTo/セーブ復元を扱う `applyState()` からの呼び出しだけ true を渡す。
   */
  private syncEndingOverlayVisibility(instant = false): void {
    if (this.storyEnded && !this.intermissionEvents) {
      this.showEndingOverlay(instant)
    } else {
      this.hideEndingOverlay()
    }
  }

  /**
   * クイックセーブ/ロード完了通知の toast を表示する (#630)。旧 DOM 版 `NovelPlayer.tsx` の
   * `showToast` ヘルパーの PixiJS 版。2秒後に自動的に消える。連続呼び出し時は既存タイマーを
   * クリアして再スタートする（旧版と同じ挙動）。
   */
  showToast(message: string): void {
    if (this.toastTimer) {
      this.time.clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    this.toastOverlay.show(message)
    this.toastTimer = this.time.setTimeout(() => {
      this.toastTimer = null
      this.toastOverlay.hide()
    }, NovelRenderer.TOAST_DURATION_MS)
  }

  /**
   * 選択肢スタイルを設定する (#146)。
   * frontmatter `choice_style:` の値（`default` / `soft` / `monochrome` 等）を渡す。
   * null/undefined のときは default 扱い。
   */
  setChoiceStyle(style: string | null | undefined): void {
    this.choiceStyle = style ?? null
  }

  /**
   * per-game デフォルトフォントを設定する (#147)。
   * frontmatter `font_family:` の値（CSS の font-family 文字列）を渡す。
   * null/undefined のときは runtime 既定 (`'Noto Sans JP', sans-serif`) にフォールバック。
   *
   * 設定された family は描画前に [フォント:] per-line override が無い場合に Dialog/Narration へ
   * 適用される。フォントロードは描画時に lazy に行われる。
   */
  setFontFamily(family: string | null | undefined): void {
    this.gameDefaultFontFamily = family ?? null
    // per-game default は描画時に適用するため、ここでは即時に DialogBox を切り替えない。
    // 早期に切り替えると未ロードのフォントで bake されるため、render() 側で
    // ensureFontLoaded → setFontFamily の順を担保する。
    // バックログは per-line を再現せず per-game フォントだけを反映する (#147 R1 S1)。
    this.backlogOverlay.setFontFamily(family ?? null)
  }

  /**
   * per-game 本文フォントサイズを設定する (#283 補遺)。
   * frontmatter `font_size:` の値（px）を渡す。null/undefined のときは runtime 既定 40。
   *
   * font_family と違いフォント lazy load を伴わないので即座に DialogBox に反映する。
   * これにより 9:16 ノベル（font_size: 26）と 16:9 ADV（既定 40）を per-game で切り替えられ、
   * DialogBox の組み込み既定 (40) を全ゲーム共通で縮めずに済む（隠れた退行の回避）。
   * バックログは本文サイズに連動しない固定レイアウトのため反映しない（font_family と同方針）。
   */
  setFontSize(size: number | null | undefined): void {
    this.gameDefaultFontSize = size ?? null
    this.dialogBox.setFontSize(size ?? NovelRenderer.RUNTIME_DEFAULT_FONT_SIZE)
  }

  /**
   * 会話の描画スタイルを設定する (#283)。
   * frontmatter `dialog_style:` の値（`adv` / `novel`）を渡す。null/undefined/未知値は adv 相当。
   *
   * adv と novel は対等。未指定は壊さないため adv 描画にフォールバックするだけで「正規デフォルト」ではない。
   * DialogBox の幾何・名札・スクリムを novel 用に切り替える。改頁は render/advance 側で処理する。
   */
  setDialogStyle(style: string | null | undefined): void {
    this.dialogStyle = style ?? null
    this.applyDialogStyle()
  }

  /**
   * 質問役（主人公）の話者名を設定する (#286)。
   * frontmatter `protagonist:` の値（話者名）を渡す。null/undefined/空文字は未指定扱い。
   *
   * novel スタイルでこの名前と一致する話者を質問役＝左、それ以外（住人）を回答役＝右に振る。
   * 未指定なら立ち絵は従来配置（脚本の position トークンのまま）＝後方互換。
   * adv では一切使わない（左右配置は novel 限定）。
   *
   * #444: `split_layout: true` と組み合わさっていると「2窓モード」の有効/無効も決まる
   * （`applySplitLayout()` 参照）ため、protagonist が変わったらここで再適用する。
   * 通常は setSplitLayout より先に一度だけ呼ばれる（mount 時）ため実質 no-op だが、
   * protagonist prop が後から動的に変わるケースでも 2窓判定が追従するようにする。
   */
  setProtagonist(name: string | null | undefined): void {
    this.protagonist = name && name.length > 0 ? name : null
    this.applySplitLayout()
  }

  /**
   * 話者交代 nudge（ぴょこ）を発火させるか設定する (#382)。
   * frontmatter `speaker_nudge:` の値を渡す。true のときだけ発火（opt-in）。
   * null/undefined/false は非発火（既定オフ）。標準はポーズ差し替え（#337 クロスフェード）が
   * 話者合図を担うため nudge は不要で、稀に nudge を欲しい作品だけ `speaker_nudge: true` で opt-in する。
   *
   * #286 の nudge ロジック自体は変えない。showCharacterFromDialog の発火条件
   *（novel かつ話者交代かつ非スキップ）にこのフラグを AND するだけ。adv では元々 nudge しない。
   */
  setSpeakerNudge(enabled: boolean | null | undefined): void {
    this.speakerNudge = enabled === true
  }

  /**
   * split_layout モードを設定する (#442)。
   * frontmatter `split_layout:` の値を渡す。null/undefined/false は従来どおり（既定・後方互換）。
   *
   * dialog_style（adv/novel、テキスト送りの挙動）とは独立の軸。true のとき、画面比率に応じて
   * キャラ画像とテキストウィンドウを左右（横長）/上下（縦長）に隙間なく分割配置する
   * （`computeSplitLayoutRegions` 参照）。false/未指定は画像全面 + テキストオーバーレイのまま
   * 一切変えない（既存ゲームは非破壊）。
   */
  setSplitLayout(enabled: boolean | null | undefined): void {
    this.splitLayout = enabled === true
    this.applySplitLayout()
  }

  /**
   * フルキャンバス画像表示モードを設定する (#530)。
   * frontmatter `fullscreen_image:` の値を渡す。null/undefined/false は従来どおり
   * （既定・後方互換）。true のとき `EventImageLayer` にキャンバス全幅 contain 表示への
   * 切り替えを伝える（実際の表示反映は次の `[イベント絵:]` の `show()` 呼び出し時点、
   * `setSplitLayoutRegion` と同じ流儀）。DialogBox/ChoiceOverlay の非表示化はイベント絵
   * 表示中（`processEvent` の `EventImage` 分岐）でのみ行う — このメソッド自体は状態を
   * 切り替えるだけで、まだ何も画面には反映しない。
   */
  setFullscreenImageMode(enabled: boolean | null | undefined): void {
    this.fullscreenImage = enabled === true
    this.eventImageLayer.setFullscreenMode(this.fullscreenImage)
  }

  /**
   * 文単位の厳密改頁を設定する (#448)。
   * frontmatter `sentence_per_page:` の値を渡す。null/undefined/false は従来どおり（既定・後方互換）。
   *
   * dialog_style（adv/novel）とは独立の軸で true のとき、どちらのスタイルでも 1 ページ＝厳密に 1 文
   * に固定する（novel は行数キャップに「1 ページ最大 1 文」を追加で重ねる／adv は markdown 行単位
   * の `text[]` をやめ `splitIntoSentences` 由来の 1 文＝1 ページに切り替える。詳細は
   * `getNovelPages` / `getAdvSentencePages` 参照）。派生ページキャッシュはページ単位が変わるため破棄する。
   *
   * `setDialogStyle`（`applyDialogStyle`）と同じパターンで、既にテキスト表示中なら即座に新ページ構成で
   * 描き直す (#448 Part2)。EditorScreen のライブプレビューは frontmatter をライブバインドしているため、
   * これが無いとテキスト表示中に `sentence_per_page` を ON/OFF しても次のクリックまで画面が古いページ
   * 構成のまま stale になる。
   */
  setSentencePerPage(enabled: boolean | null | undefined): void {
    this.sentencePerPage = enabled === true
    this.cursor.invalidatePages()
    this.clampTextIndexToPageCount()
    if (this.initialized && this.cursor.eventIndex < this.cursor.resolvedEvents.length) {
      this.render()
    }
  }

  /**
   * ページ構成が変わった（`setDialogStyle` / `setSentencePerPage` のライブ切り替え）後、textIndex が
   * 現在のイベントのページ数以上なら最終ページへ寄せる (#789)。#663 の `applyState` の寄せと同じ。
   * 寄せないと範囲外の textIndex が残り（adv は空ページ表示）、そのスナップショットが次の再マウントで
   * 範囲外の復元失敗になる。ページが変わるので sentenceIndex は 0 に戻す。
   */
  private clampTextIndexToPageCount(): void {
    if (this.cursor.eventIndex >= this.cursor.resolvedEvents.length) return
    // ノベルの改頁数は DialogBox の計測（初期化後）が要る。adv の行数・文単位ページは初期化前でも数えられる。
    if (this.isNovelStyle() && !this.initialized) return
    const textEvt = getTextEvent(this.cursor.resolvedEvents[this.cursor.eventIndex])
    if (!textEvt) return
    const pageCount = this.currentPageCount(textEvt)
    this.cursor.clampToPageCount(pageCount)
  }

  /**
   * テクスチャ拡大縮小フィルタを nearest-neighbor（ドット絵向け）にするか設定する (#466)。
   * frontmatter `pixel_art:` の値を渡す。null/undefined/false は従来どおり linear（既定・後方互換、
   * theo-hayami 等の滑らかな塗り絵に影響しない）。
   *
   * 値の所有権は CharacterLayer / EventImageLayer 側にあるため renderer はフィールドを持たず
   * 素通しする（`setCharacterScale` と同じ流儀）。setEvents/setScenes（＝最初のテクスチャロード）
   * より前に設定し、初回描画から反映されるようにする。
   */
  setPixelArt(enabled: boolean | null | undefined): void {
    const v = enabled === true
    this.characterLayer.setPixelArt(v)
    this.eventImageLayer.setPixelArt(v)
  }

  /**
   * 現在の splitLayout フラグを DialogBox / CharacterLayer / novelScrim に反映する (#442)。
   * screenWidth/screenHeight は construct 時に固定（fluid `aspect_ratio: auto` は向きが変わる
   * たびに NovelPlayer が renderer ごと再マウントするため、ここで resize を待つ必要はない）。
   * false のときは両者へ null を渡し、従来ジオメトリ（adv 下部バー/novel 全画面・立ち絵全画面）に戻す。
   *
   * #442 self-review must-2: novelScrim（セリフ表示中に画面全体へ敷く半透明黒）も、split_layout
   * 有効時はテキスト領域だけに矩形を絞る（キャラ画像領域には暗幕をかけず、はっきり見せる）。
   * scrim の表示/非表示・alpha フェードは既存の updateNovelScrim 系がそのまま制御し、ここでは
   * 矩形（`rect()` の引数）だけを更新する。
   */
  private applySplitLayout(): void {
    if (!this.splitLayout) {
      this.dialogBox.setSplitLayoutRegion(null)
      this.dialogBox.setDualWindowRegions(null)
      this.characterLayer.setSplitLayoutRegion(null)
      this.choiceOverlay.setSplitLayoutRegion(null)
      this.eventImageLayer.setSplitLayoutRegion(null)
      this.screenEffects.resetNovelScrimRegion()
      return
    }
    const regions = computeSplitLayoutRegions(this.screenWidth, this.screenHeight)
    this.dialogBox.setSplitLayoutRegion(regions.text)
    // 2窓モード (#444): 新規frontmatterフィールドを増やさず、既存の split_layout: true +
    // protagonist: の組み合わせをこのモードの明示トリガーにする（実装方針）。protagonist
    // 未指定なら従来どおり単一テキストウィンドウ（枠あり）のまま変わらない。
    this.dialogBox.setDualWindowRegions(
      this.isDualWindowMode() ? splitTextRegionForDualWindow(regions.text) : null
    )
    this.characterLayer.setSplitLayoutRegion(regions.character)
    // イベント絵も画像側領域へ収める (#464)。CharacterLayer と同じ regions.character を使い、
    // テキスト領域には重ねない（画面全体に引き伸ばされていたバグの修正）。
    this.eventImageLayer.setSplitLayoutRegion(regions.character)
    // 選択肢UIもテキスト領域へ収める (#442 self-review should-5)。キャラ画像パネルへの
    // 重なりを防ぐ（[選択] ブロックは Gymnasia の実脚本で使われるためスコープ外にできない）。
    this.choiceOverlay.setSplitLayoutRegion(regions.text)
    this.screenEffects.applyNovelScrimRegion(regions.text)
  }

  /**
   * 話者別2窓（相手=上/自分=下、#444）表示モードが有効か。
   * `split_layout: true` かつ `protagonist:` 指定時のみ true（dialog_style/novel 判定は問わない
   * — 2窓モードは #305/#286 の novel 限定機能とは独立の軸）。
   */
  private isDualWindowMode(): boolean {
    return this.splitLayout && this.protagonist !== null
  }

  /**
   * 2窓モード (#444) で話者が自分側（protagonist）か相手側かを判定する。
   * 話者不明（ナレーション等・null）も自分側（下窓・白）に倒す独自分岐を持つ（#549）。
   * `resolveNovelRoleXRatio`/`resolveBodyTextColor` の非2窓分岐は null/空文字を事前ガードして
   * `undefined`/住人色を返すのみで `speaker === this.protagonist` の比較へ進まないため、
   * ここでの判定はそれらと同じ考え方ではない。相手側（上窓・水色）になるのは、protagonist と
   * 異なる明示的な話者名（住人等）のときだけ。
   */
  private resolveDualWindowIsSelf(speaker: string | null): boolean {
    return speaker === null || speaker === this.protagonist
  }

  /**
   * 立ち絵の足元 Y 比率を設定する (#308)。
   * frontmatter `character_y_ratio:` の値を渡す。null/undefined のときは既定 1.0（後方互換）。
   *
   * 値の所有権は CharacterLayer 側にあるため renderer はフィールドを持たず素通しする
   * （font_size と違い renderer 側の再計算に値が要らないため）。不正値クランプは
   * CharacterLayer.setCharacterYRatio が担う。1.0 = 足が画面下端 / >1.0 で靴が画面外に切れる。
   * dialog_style: novel/adv 非依存（両モードで同じ足元）。
   */
  setCharacterYRatio(ratio: number | null | undefined): void {
    this.characterLayer.setCharacterYRatio(ratio ?? null)
  }

  /**
   * 立ち絵の目標表示高さ比率を設定する (#360)。
   * frontmatter `character_height_ratio:` の値を渡す。null/undefined のときは原寸 (scale=1)＝後方互換。
   *
   * setCharacterYRatio (#308) と対称に、値の所有権は CharacterLayer 側にあるため renderer は
   * フィールドを持たず素通しする（renderer 側の再計算に値が要らない）。クランプ・原寸フォールバックは
   * CharacterLayer.setCharacterHeightRatio が担う。高解像度立ち絵を per-game の目標高さで表示する。
   */
  setCharacterHeightRatio(ratio: number | null | undefined): void {
    this.characterLayer.setCharacterHeightRatio(ratio ?? null)
  }

  /**
   * キャラごとの立ち絵目標表示高さ比率 override を設定する (#364)。
   * frontmatter `character_height_ratios:` の値（キー=キャラ表示名、値=character_height_ratio と
   * 同じ意味の比率）を渡す。null/undefined のときは空 Record（＝マップ override なし・後方互換）。
   *
   * setCharacterHeightRatio (#360) と対称に、値の所有権は CharacterLayer 側にあるため renderer は
   * フィールドを持たず素通しする。マップに無いキャラは character_height_ratio（スクリプト単位）へ
   * フォールバックする解決ロジックは CharacterLayer.setCharacterHeightRatios / loadTexture が担う。
   */
  setCharacterHeightRatios(ratios: Record<string, number> | null | undefined): void {
    this.characterLayer.setCharacterHeightRatios(ratios ?? null)
  }

  /**
   * 立ち絵の元絵基準の一律スケールを設定する (#378)。
   * frontmatter `character_scale:` の値を渡す。null/undefined/非有限/非正のときは未設定＝下位優先順位
   * （character_height_ratios > character_height_ratio > 原寸 scale=1）へフォールバック（後方互換）。
   *
   * setCharacterHeightRatio (#360) と対称に、値の所有権は CharacterLayer 側にあるため renderer は
   * フィールドを持たず素通しする。クランプ・未設定フォールバックは CharacterLayer.setCharacterScale が担う。
   * character_height_ratio (#360, 画面基準) が元絵の縦pxを割り消し身長差を潰すのに対し、character_scale は
   * 元絵基準（sprite.scale = 値）で元絵に焼き込んだ身長差をそのまま出す。
   */
  setCharacterScale(scale: number | null | undefined): void {
    this.characterLayer.setCharacterScale(scale ?? null)
  }

  /**
   * 立ち絵の新規表示・退場フェード時間を設定する。
   * frontmatter `character_fade_ms:` の値（ms）を渡す。null/undefined のときは既定 700ms (#407)。
   */
  setCharacterFadeMs(ms: number | null | undefined): void {
    this.characterLayer.setCharacterFadeMs(ms ?? null)
    // 大道具・背景板の面の切り替え (#704) の既定の所要時間も同じ値にそろえる。
    this.backgroundBoardLayer.setFlipDefaultMs(ms ?? null)
    this.propLayer.setFlipDefaultMs(ms ?? null)
    this.stageTurnDefaultMs = clampFadeMs(ms, 700)
  }

  /**
   * 入場・退場の方向モーション（上手/下手）の徒歩移動所要時間を設定する (#684)。
   * frontmatter `character_move_ms:` の値（ms）を渡す。null/undefined のときは既定 1400ms。
   * 方向引数を指定した `[登場:]`/`[退場:]` にだけ効く（従来の瞬間表示/フェードには影響しない）。
   */
  setCharacterMoveMs(ms: number | null | undefined): void {
    this.characterLayer.setCharacterMoveMs(ms ?? null)
  }

  /**
   * 背景クロスフェード・退場（終劇）フェード時間を設定する (#407)。
   * frontmatter `background_fade_ms:` の値（ms）を渡す。null/undefined/非有限のときは既定
   * `BACKGROUND_CROSSFADE_MS`（700ms）にフォールバックし、範囲外は [0, 5000] にクランプする
   * （setCharacterFadeMs と対称）。背景の表示（イン）・切り替え・退場（アウト）すべてに効く。
   */
  setBackgroundFadeMs(ms: number | null | undefined): void {
    this.backgroundFadeMs = clampFadeMs(
      ms,
      BACKGROUND_CROSSFADE_MS,
      BACKGROUND_FADE_MS_MIN,
      BACKGROUND_FADE_MS_MAX
    )
  }

  setEventImageFadeMs(ms: number | null | undefined): void {
    this.eventImageFadeMs = clampFadeMs(
      ms,
      EVENT_IMAGE_FADE_MS,
      BACKGROUND_FADE_MS_MIN,
      BACKGROUND_FADE_MS_MAX
    )
  }

  /** frontmatter `event_image_transition:`（#599）を受け取る。不正値・未指定は既定 `'Fade'`。 */
  setEventImageTransitionDefault(value: EventImageTransition | null | undefined): void {
    this.eventImageTransitionDefault = value === 'Pixelate' ? 'Pixelate' : 'Fade'
  }

  /**
   * intermission.md 専用シーンを設定する (#404)。
   *
   * `events` は `assets/scripts/intermission.md` を parseMarkdown した EventDocument から
   * flatten した Event 列（呼び出し側 = PlayerScreen の責務）。null/undefined/空配列は
   * 「未設定」として扱い、endStory() は従来どおりフェードのみで終わる（`endingOverlay`
   * （PixiJS 内部描画、#630）の "to be continued..." 表示にフォールバック。完全後方互換・オプトイン）。
   *
   * `options.backgroundFadeMs`/`characterFadeMs`/`eventImageFadeMs` は intermission.md 自身の frontmatter
   * `background_fade_ms:`/`character_fade_ms:`/`event_image_fade_ms:` の値。物語本編の同名 per-game 設定
   * （`backgroundFadeMs`/CharacterLayer の `characterFadeMs`、他の全トランジションに影響する
   * 共有フィールド）とは独立に保持し、endStory() の消去フェードにだけ使う。未指定（null/
   * undefined/非有限）は `INTERMISSION_FADE_MS_DEFAULT`（1400ms、通常既定 700ms より遅い
   * 「幕が降りる」用の値）にフォールバックし、[0, 5000] にクランプする
   * （setBackgroundFadeMs/setCharacterFadeMs と同じ clampFadeMs を共有）。
   */
  setIntermissionScene(
    events: Event[] | null | undefined,
    options?: {
      backgroundFadeMs?: number | null
      characterFadeMs?: number | null
      eventImageFadeMs?: number | null
    }
  ): void {
    this.intermissionEvents = events && events.length > 0 ? events : null
    this.intermissionBackgroundFadeMs = clampFadeMs(
      options?.backgroundFadeMs,
      INTERMISSION_FADE_MS_DEFAULT,
      BACKGROUND_FADE_MS_MIN,
      BACKGROUND_FADE_MS_MAX
    )
    this.intermissionCharacterFadeMs = clampFadeMs(
      options?.characterFadeMs,
      INTERMISSION_FADE_MS_DEFAULT,
      BACKGROUND_FADE_MS_MIN,
      BACKGROUND_FADE_MS_MAX
    )
    this.intermissionEventImageFadeMs = clampFadeMs(
      options?.eventImageFadeMs,
      INTERMISSION_FADE_MS_DEFAULT,
      BACKGROUND_FADE_MS_MIN,
      BACKGROUND_FADE_MS_MAX
    )
  }

  /**
   * intermission.md 専用シーンが設定されているか (#404)。
   *
   * #630 以降、この判定（`storyEnded && !hasIntermissionScene()`）は `syncEndingOverlayVisibility()`
   * が `this.intermissionEvents` を直接参照する形に内部化されており、このメソッド自体は
   * `NovelRenderer.intermission.test.ts` の同値分割テスト以外からは呼ばれていない。外部から
   * `intermissionEvents` の設定有無を検査できる公開 API として残している（プロダクションコードの
   * 呼び出し元は無い）。
   */
  hasIntermissionScene(): boolean {
    return this.intermissionEvents !== null
  }

  /**
   * 主人公セリフの本文色を設定する (#305)。CSS hex を渡す。null/undefined/空文字・不正値の
   * ときは既定のやや暖かいアイボリー #FFF0D8 に倒す（parseColorToNumber の fallback）。
   *
   * protagonist と一致する話者の novel 本文をこの色にし、住人は純白のまま。
   * protagonist 未指定なら色差は起こさない（全員白＝後方互換）。adv では色差しない（novel 限定）。
   *
   * 注意（#305 / #307）: 現状この setter を呼ぶ本番経路は無い（parser は色を解析せず、NovelPlayer も
   * 渡さない）。本番の主人公本文色は常に renderer 既定 #FFF0D8。この setter はテストと将来の
   * frontmatter 上書き実装に備えた内部フックとして残してある（呼ばなければ既定が効く）。
   */
  setProtagonistTextColor(color: string | null | undefined): void {
    const fallback = parseColorToNumber(NovelRenderer.DEFAULT_PROTAGONIST_TEXT_COLOR, 0xffffff)
    this.protagonistTextColor =
      color && color.length > 0 ? parseColorToNumber(color, fallback) : fallback
  }

  /**
   * 現在の話者から本文色を決定論的に導出する (#305 / #444)。
   *  - 2窓モード（#444: split_layout + protagonist 指定）→ dialog_style（novel/adv）に関わらず
   *    常にこちらを優先。自分（protagonist 一致・話者不明含む）＝白（`RESIDENT_TEXT_COLOR`）、
   *    相手（protagonist と異なる明示的な話者のみ）＝水色（`OPPONENT_TEXT_COLOR`、#549）。
   *  - adv / protagonist 未指定 / 話者不明 → 住人色（純白）。色差しない（後方互換）。
   *  - novel かつ話者が protagonist と一致 → 主人公本文色（既定 #FFF0D8）。
   *  - それ以外（novel の住人）→ 住人色（純白）。
   * 演出中間状態でなく per-line の描画属性なので、render() の都度ここで導出して DialogBox に渡す。
   */
  private resolveBodyTextColor(speaker: string | null): number {
    if (this.isDualWindowMode()) {
      return this.resolveDualWindowIsSelf(speaker)
        ? NovelRenderer.RESIDENT_TEXT_COLOR
        : NovelRenderer.OPPONENT_TEXT_COLOR
    }
    if (!this.isNovelStyle()) return NovelRenderer.RESIDENT_TEXT_COLOR
    if (this.protagonist === null) return NovelRenderer.RESIDENT_TEXT_COLOR
    if (!speaker) return NovelRenderer.RESIDENT_TEXT_COLOR
    return speaker === this.protagonist
      ? this.protagonistTextColor
      : NovelRenderer.RESIDENT_TEXT_COLOR
  }

  /**
   * novel スタイルの役割配置 x 比率を返す (#286)。
   * 話者が protagonist と一致 → 質問役＝左、それ以外（住人 / 司会など）→ 回答役＝右。
   * 役割配置を使わない（adv / protagonist 未指定 / 話者不明）場合は undefined を返し、
   * 呼び出し側は脚本の position トークンによる従来配置にフォールバックする。
   *
   * TODO(#286 v1): 司会ヴィンチアの定位置は未対応。現状は「非主人公＝右」に倒している。
   * 3 人目以降の同時表示や司会の中央固定が要るときは、ここに役割→配置の対応を足す。
   */
  private resolveNovelRoleXRatio(character: string | null): number | undefined {
    if (!this.isNovelStyle()) return undefined
    if (this.protagonist === null) return undefined
    if (!character) return undefined
    return character === this.protagonist
      ? NOVEL_ROLE_X_RATIO.questioner
      : NOVEL_ROLE_X_RATIO.responder
  }

  /** novel スタイルか (#283)。`dialog_style: novel` のときだけ true。それ以外（adv / 未指定 / 未知値）は false。 */
  private isNovelStyle(): boolean {
    return this.dialogStyle === 'novel'
  }

  /**
   * 現在の dialogStyle を DialogBox とスクリムに反映する (#283)。
   * setDialogStyle / setEvents 経路から呼ぶ。adv へ戻すときはスクリムも消す。
   */
  private applyDialogStyle(): void {
    const novel = this.isNovelStyle()
    this.dialogBox.setNovelMode(novel)
    // per-game 本文サイズ (#283 補遺) を再アサートする。setNovelMode は geometry/borderless を
    // 冪等に再適用するため、スタイル切替を跨いでも gameDefaultFontSize が確実に効くようにする。
    this.dialogBox.setFontSize(this.gameDefaultFontSize ?? NovelRenderer.RUNTIME_DEFAULT_FONT_SIZE)
    if (!novel) {
      // adv ではスクリムを常に消す（スクリム未生成＝init 前なら no-op）。
      this.screenEffects.hideNovelScrim()
    }
    // 改頁は幾何（boxH）依存なので、スタイル切替で派生キャッシュを破棄する (#283)。
    this.cursor.invalidatePages()
    this.clampTextIndexToPageCount()
    // 既にテキスト表示中なら新スタイルで描き直す（adv↔novel 切替が即反映される）。
    if (this.initialized && this.cursor.eventIndex < this.cursor.resolvedEvents.length) {
      this.render()
    }
  }

  /**
   * 終了コールバック
   */
  onEnd(callback: () => void): void {
    this.onEndCallback = callback
  }

  /** 終了コールバックを設定する（null で解除可能）(#228 動画エクスポート復元用) */
  setOnEnd(callback: (() => void) | null): void {
    this.onEndCallback = callback
  }

  /**
   * 設定（テキスト速度・音量）をリアルタイムに反映する。
   * voiceVolume は voice 専用 masterGain 実装後に対応予定 (#144 follow-up)。
   */
  applySettings(settings: {
    msPerChar: number
    bgmVolume: number
    seVolume: number
    autoWaitMs?: number
  }): void {
    this.dialogBox.setMsPerChar(settings.msPerChar)
    this.audioManager.setBgmVolume(settings.bgmVolume)
    this.audioManager.setSeVolume(settings.seVolume)
    if (settings.autoWaitMs !== undefined) {
      this.autoWaitMs = settings.autoWaitMs
    }
  }

  /**
   * オートモードの ON/OFF を切り替える (#139 / #302)。
   * OFF にした場合は待機中のオートタイマーをキャンセルする。
   * React 側から呼ぶ場合は setAutoMode、renderer 内部から呼ぶ場合も同じメソッドを使う。
   *
   * 会話中トグルの即時反映 (#302): `onTypingDone` は render()（setDialog /
   * setNovelDialogProgressive 呼び出し時）に `this.autoMode ? …scheduleAutoAdvance : null` で
   * **その時点の autoMode で確定**する。auto OFF で描画された行は callback=null になる。よって
   * 会話中に auto を ON にしただけでは、現在行が「タイプ中」でも「完了済み」でも自動送りが
   * 始まらなかった（完了済み行は再発火せず、タイプ中行も onTypingDone が null のまま）。
   *
   * 修正: on=true かつ choice/wait 待機でなく スクリプト末尾でないとき、DialogBox の
   * onTypingDone を **live で張り替える**（`setOnTypingDone`）。これで—
   *  - 現在行が**タイプ中**なら、その行の完了時に scheduleAutoAdvance が発火する。
   *  - 現在行が**完了済み**なら、setOnTypingDone がその場で 1 回だけ scheduleAutoAdvance を呼ぶ。
   * どちらも同一経路で扱え、完了時の onTypingDone は ticker 側で一度 null 化されてから呼ばれる
   * ため二重発火しない。auto を OFF にしたら onTypingDone も解除し、OFF 中の完了で誤って進めない。
   */
  setAutoMode(on: boolean): void {
    if (this.autoMode === on) return
    this.autoMode = on
    if (!on) {
      if (this.autoTimer) {
        this.time.clearTimeout(this.autoTimer)
        this.autoTimer = null
      }
      // オート OFF: onTypingDone も解除する。OFF 中にタイプが完了して誤って進めないように
      // （#139 手動 OFF 経路と整合。次行の render() が auto=false で null を張り直すのと同義）。
      this.dialogBox.setOnTypingDone(null)
      // オートモード OFF 時はボイスを停止する（onEnded が誤発火しないよう）
      this.audioManager.stopVoice()
    } else if (!this.transition.isGated('autoAdvance') && !this.isAtScriptEnd()) {
      // 会話中にオート ON にした瞬間の即時反映 (#302)。
      // setOnTypingDone が「タイプ中なら完了時に発火・完了済みなら即発火」を一手に引き受ける。
      // choice/wait 待機中・スクリプト末尾は対象外（進める先がない）。
      this.dialogBox.setOnTypingDone(() => this.scheduleAutoAdvance())
    }
    // React state との同期。コールバック内で setAutoMode が再度呼ばれても
    // 同値 no-op（上の早期 return）で無限ループを防いでいる。
    this.onAutoModeChange?.(on)
  }

  /**
   * 現在の表示位置が「これ以上 advance しても進む先がない」スクリプト末尾かを判定する純粋な
   * 述語 (#302)。setAutoMode の即時 scheduleAutoAdvance を末尾で抑止するために使う
   * （末尾でタイマーを張ると、advance が onEndCallback だけ叩いて空回りするのを防ぐ）。
   *
   * 末尾の定義は render() のインジケータ可視判定と同型にする:
   *  - 表示イベントが無い／既に範囲外 → 末尾扱い。
   *  - text を持つイベントでないなら（演出のみ等）→ 末尾扱いしない（advance で次へ進める）。
   *  - text イベントなら「最後のページ かつ（novel は）ページ最後の文 かつ 最後のイベント」が末尾。
   */
  private isAtScriptEnd(): boolean {
    if (this.cursor.resolvedEvents.length === 0) return true
    if (this.cursor.eventIndex >= this.cursor.resolvedEvents.length) return true
    const current = this.cursor.resolvedEvents[this.cursor.eventIndex]
    const textEvt = getTextEvent(current)
    if (!textEvt) return false
    const isLastEvent = this.cursor.eventIndex >= this.cursor.resolvedEvents.length - 1
    if (!isLastEvent) return false
    const pageCount = this.currentPageCount(textEvt)
    const isLastPage = this.cursor.textIndex >= pageCount - 1
    if (!isLastPage) return false
    if (this.isNovelStyle()) {
      const page = this.getNovelPages(textEvt)[this.cursor.textIndex]
      const sentenceCount = page?.sentences.length ?? 0
      // render() の novelSentenceIndex のような clamp はせず raw sentenceIndex を使う。
      // over-range（復元等で範囲外）でも `>=` で "末尾扱い" に倒れ、即時オートを抑止する安全方向。
      const isLastSentenceOnPage = this.cursor.sentenceIndex >= sentenceCount - 1
      return isLastSentenceOnPage
    }
    return true
  }

  /** オートモード変更コールバックを登録する（NovelPlayer が setAutoMode(false) を検知するため） */
  setOnAutoModeChange(cb: (on: boolean) => void): void {
    this.onAutoModeChange = cb
  }

  /** オートモードの現在状態を取得する */
  isAutoMode(): boolean {
    return this.autoMode
  }

  /**
   * 既読永続化キーを設定する (#140)。
   * 設定するとスキップモードが有効になり、既読進捗を localStorage から読み込む。
   *
   * SaveManager のセーブキー名前空間も同じ docKey に切り替える (#578)。saveLoadOverlay は
   * コンストラクタで this.save.saveManager への参照を保持したまま渡されているため、ここでは
   * インスタンスを差し替えず（差し替えると saveLoadOverlay 側が古い docKey のままの
   * インスタンスを握り続けてしまう）、SaveManager.setDocKey() で内部の docKey だけ更新する。
   */
  setDocKey(docKey: string): void {
    this.docKey = docKey
    this.save.saveManager.setDocKey(docKey)
    this.reloadReadProgress()
  }

  private reloadReadProgress(): void {
    if (!this.docKey) return
    const docKey = this.docKey
    this.readProgress = loadReadProgress(docKey)
    this.readLineProgress = loadReadLineProgress(docKey)
    this.readSceneProgress = loadReadSceneProgress(docKey)
  }

  private markCurrentSceneRead(): void {
    // 線形ストリーム再生中は、持ち主（エントリ）ではなく再生位置のシーンを既読にする (#777)
    const sceneId = this.getPlayheadSceneId()
    if (!this.docKey || !sceneId) return
    markReadScene(this.docKey, this.readSceneProgress, sceneId)
  }

  /**
   * スキップモードの ON/OFF を切り替える (#140)。
   * OFF にした場合はスキップタイマーをキャンセルする。
   *
   * 終劇後 (#386) はガードして no-op にする (#404 セルフレビュー S1)。`endStory()` の
   * `fadeOutBackgroundEntries()`（次背景を追加しない全消去フェード）進行中に呼ばれると、
   * `finishBackgroundCrossfadeInstant()` が「crossfade 中で次背景が来る」前提のまま
   * 「最後の bgEntry = 次背景」の alpha を 1 にリセットしてしまい、消去フェード中だった
   * 背景を誤って完全不透明へ巻き戻す事故があった（tick が止まる skip 中はそのまま固定）。
   * `advance()`/`quickSave()`/`openSaveMenu()` と同じ「storyEnded 中は根本メソッド自体で
   * no-op」の設計イディオム（ADR0002）をここにも適用する。ボタン側の disabled 制御だけでは
   * Skip(S) ボタン以外から setSkipMode を直接呼ぶ経路（`NovelPlayer` の「つづきから」初期化等）
   * を防げないため必須。
   */
  setSkipMode(on: boolean): void {
    if (this.storyEnded) return
    if (this.skipMode === on) return
    this.skipMode = on
    if (on) {
      // 別の埋め込みインスタンスが増やした既読も、スキップ開始時点で取り込む (#366)。
      this.reloadReadProgress()
      // スキップモードとオートモードは排他: スキップ ON 時にオートを解除 (#140)
      this.setAutoMode(false)
      // 既に走っている背景クロスフェードも畳み、skip 中の表示を最新状態へ即時収束させる。
      this.background.finishBackgroundCrossfadeInstant()
    }
    if (!on && this.skipTimer) {
      this.time.clearTimeout(this.skipTimer)
      this.skipTimer = null
    }
    this.onSkipModeChange?.(on)
  }

  /** スキップモード変更コールバックを登録する */
  setOnSkipModeChange(cb: (on: boolean) => void): void {
    this.onSkipModeChange = cb
  }

  /** SeekBar の active 変化コールバックを登録する (#350)。NovelPlayer が下部丸ボタン行の
   *  フェード退避に繋ぐ（setOnAutoModeChange / setOnSkipModeChange と同じ配線パターン）。 */
  setOnSeekActiveChange(cb: (active: boolean) => void): void {
    this.onSeekActiveChange = cb
  }

  /** 終劇状態の変化コールバックを登録する (#386)。NovelPlayer が postMessage 通知・React state
   *  同期（DOM ボタンの disabled 制御・デバッグ HUD 等）に繋ぐ（setOnAutoModeChange 等と同じ
   *  配線パターン）。"to be continued..." 表示自体は `endingOverlay`（PixiJS 内部描画、#630）が
   *  この callback とは独立に担う。 */
  setOnStoryEndedChange(cb: ((ended: boolean) => void) | null): void {
    this.onStoryEndedChangeCallback = cb
  }

  /** スキップモードの現在状態を取得する */
  isSkipMode(): boolean {
    return this.skipMode
  }

  /**
   * リソース解放
   */
  destroy(): void {
    if (!this.appInitialized) {
      // React StrictMode では init() が走り切る前に unmount が来る場合がある。
      // その時 this.app.canvas は undefined のため触ると落ちる。何もせず終了。
      return
    }
    this.app.canvas.removeEventListener('pointerdown', this.handleAdvance)
    this.app.canvas.removeEventListener('wheel', this.handleWheel)
    this.app.canvas.removeEventListener('mouseleave', this.handleCanvasMouseLeave)
    this.seekBarResizeObserver?.disconnect()
    this.seekBarResizeObserver = null
    window.removeEventListener('keydown', this.handleKeyDown)
    if (this.waitTimer) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    this.transition.dispose()
    this.clearWaitDisplayCompleteTimer()
    if (this.intermissionTimer) {
      this.time.clearTimeout(this.intermissionTimer)
      this.intermissionTimer = null
    }
    if (this.autoTimer) {
      this.time.clearTimeout(this.autoTimer)
      this.autoTimer = null
    }
    if (this.skipTimer) {
      this.time.clearTimeout(this.skipTimer)
      this.skipTimer = null
    }
    this.stage.cancelAllTimers()
    this.cameraZoom.dispose()
    if (this.toastTimer) {
      this.time.clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    // 動画レイヤを破棄（video 要素解放・AudioManager から detach・Sprite/Texture/mask 破棄）(#252)。
    // audioManager.destroy() より前に呼んで detach を確実に通す。
    this.videoLayer.remove()
    // イベント絵レイヤーも破棄する（sprite/texture 参照を解放）(#351)。
    this.eventImageLayer.remove()
    // イベント絵レイヤーが読み込んだテクスチャも解放する (#351 セルフレビュー指摘。
    // setEvents() と同じ理由: textureCache 相当の登録先が無いと GPU テクスチャがリークする)。
    this.eventImageLayer.disposeTextures()
    // 背景板レイヤーも破棄・テクスチャ解放する (#683、eventImageLayer と同じ流儀)。
    this.backgroundBoardLayer.clear()
    this.backgroundBoardLayer.disposeTextures()
    // 壁レイヤーも破棄・テクスチャ解放する (#703、backgroundBoardLayer と同じ流儀)。
    this.wallLayer.clear()
    this.wallLayer.disposeTextures()
    // 舞台前面レイヤーも破棄・テクスチャ解放する (#705、wallLayer と同じ流儀)。
    this.stageFrontLayer.clear()
    this.stageFrontLayer.disposeTextures()
    // 天候レイヤーも破棄する (#706)。タイマーと粒の Graphics を片付ける（テクスチャは持たない）。
    this.weatherLayer.clear()
    // 床レイヤーも破棄・テクスチャ解放する (#706 第2弾、stageFrontLayer と同じ流儀)。
    this.floorLayer.clear()
    this.floorLayer.disposeTextures()
    // 大道具レイヤーも破棄・テクスチャ解放する (#692、backgroundBoardLayer と同じ流儀)。
    this.propLayer.clear()
    this.propLayer.disposeTextures()
    // 幕レイヤーも破棄・テクスチャ解放する (#697、backgroundBoardLayer と同じ流儀)。
    this.curtainLayer.clear()
    this.curtainLayer.disposeTextures()
    // スポットライトレイヤーの ticker を停止する (#693)。グラデーションテクスチャ自体は
    // 専用の disposeTextures() を持たず、この後の app.destroy(true, { children: true }) で解放される。
    this.lightingLayer.clear()
    // テロップレイヤーのタイマー・表示中の段を破棄する (#674)。
    this.clearTelopLayer()
    this.audioManager.destroy()
    this.characterLayer.clear()
    this.choiceOverlay.hide()
    this.titleScreenOverlay.hide()
    this.endingOverlay.hide()
    this.toastOverlay.hide()
    this.saveLoadOverlay.hide()
    this.backlogOverlay.hide()
    this.dialogBox.dispose()
    // GPU テクスチャのリーク防止: Assets.unload で内部キャッシュから解放し、背景 entry を全て解放する。
    // マスク Sprite は破棄するが、共有 Texture はキャッシュなので残す (#250/#319/#791)。
    this.stage.release()
    // 先読み済み URL 集合もクリアする（リーク予防・#389）。
    this.preloadedUrls.clear()
    clearBackgroundPreload()
    this.app.destroy(true, { children: true })
    this.initialized = false
  }

  /**
   * 現在のゲーム状態のスナップショットを返す
   */
  getSnapshot(): NovelGameState {
    // 演出フィールドは `stage.capture()` の値を、従来の位置（キー順）に並べ直して入れる。キー順は
    // セーブ JSON 回帰テスト（snapshotJson / playbackCursor）が固定しているため、展開（...）はしない。
    const stage = this.stage.capture()
    return {
      sceneId: this.cursor.currentSceneId,
      eventIndex: this.cursor.eventIndex,
      textIndex: this.cursor.textIndex,
      sentenceIndex: this.cursor.sentenceIndex,
      flags: this.gameState.toJSON(),
      backgroundPath: stage.backgroundPath,
      backgroundColor: stage.backgroundColor,
      backgroundFade: stage.backgroundFade,
      backgroundBrightness: stage.backgroundBrightness,
      video: this.videoLayer.getState(),
      eventImage: this.eventImageLayer.getState(),
      backgroundBoards: this.backgroundBoardLayer.getState(),
      wall: this.wallLayer.getState(),
      stageFront: this.stageFrontLayer.getState(),
      weather: this.weatherLayer.getState(),
      floor: this.floorLayer.getState(),
      props: this.propLayer.getState(),
      spotlight: this.lightingLayer.getState(),
      curtain: this.curtainLayer.getState(),
      isBlackout: stage.isBlackout,
      characters: this.characterLayer.getCharacterStates(),
      currentBgmPath: this.currentBgmPath,
      cameraMode: stage.cameraMode,
      cameraOrientation: stage.cameraOrientation,
      cameraElevation: stage.cameraElevation,
      cameraZoom: stage.cameraZoom,
      paperDollOutline: stage.paperDollOutline,
      storyEnded: this.storyEnded,
      // 入場時 flags (#799)。元列に `[条件:]` が無い脚本では何も足さない（JSON は従来のまま）。末尾に足して既存のキー順を保つ。
      ...this.cursor.snapshotEntry(),
    }
  }

  /**
   * 次のテキスト / 次のイベントへ進む
   */
  advance(): void {
    // #386: 終劇後は入力を受け付けない（タップしても何も起きない状態を維持する）。
    if (this.storyEnded) return
    if (this.cursor.resolvedEvents.length === 0) return
    // 選択肢・待機・Jump の予約中／停止中・入場中 (#734)。Jump 停止中 (#725) は、遷移先不在・循環上限で
    // 止まっているとき、Jump を飛び越して後続へ（末尾なら終劇へ）進まないためにここで止める。
    // goBack/seekTo/quickLoad は stalled でも使える（'navigate'）。
    if (this.transition.isGated('advance')) return
    this.transition.resetChain()

    const current = this.cursor.resolvedEvents[this.cursor.eventIndex]
    const textEvt = getTextEvent(current)
    const novel = this.isNovelStyle()

    if (textEvt && novel) {
      // --- novel 文単位送り (#292) ---
      // backlog は「ページを離れる時」だけ記録する（文ごとに記録して断片化させない）。
      const pages = this.getNovelPages(textEvt)
      const page = pages[this.cursor.textIndex]
      const sentences = page?.sentences ?? []
      const character = textEvt.type === 'dialog' ? textEvt.character : null

      // 1) 同ページにまだ続く文がある → 次の文へ（既出は溜まる）。backlog はまだ記録しない。
      if (this.cursor.sentenceIndex < sentences.length - 1) {
        this.cursor.nextSentence()
        this.render()
        return
      }

      // 2) ページ最後の文。ここでページを離れるので、このページ全文を backlog に記録する。
      this.backlogOverlay.addEntry(character, page?.text ?? '')

      // 2a) 同イベントに次ページがある → 新ページの先頭文へ（クリア表示）。
      if (this.cursor.textIndex < pages.length - 1) {
        this.cursor.nextPageStart()
        this.render()
        return
      }
      // 2b) 最後のページ → 下の「次イベントへ」へフォールスルー。
    } else if (textEvt) {
      // --- adv（従来どおり・#283 / sentence_per_page 有効時は文単位ページ #448） ---
      // 現在表示中のページ（text 行、または文単位ページ）をそのまま backlog に記録する。
      const advPages = this.sentencePerPage ? this.getAdvSentencePages(textEvt) : textEvt.text
      const currentLine = advPages[this.cursor.textIndex] ?? ''
      const character = textEvt.type === 'dialog' ? textEvt.character : null
      this.backlogOverlay.addEntry(character, currentLine)

      this.cursor.nextTextLine()
      const pageCount = this.currentPageCount(textEvt)
      if (this.cursor.textIndex < pageCount) {
        // まだページが残っている → クリック = 改頁（次ページをクリア表示）
        this.render()
        return
      }
    }

    // 次のイベントへ
    if (novel) {
      // ページ/イベントを離れる時は、次の立ち絵変化を始める前に前ページ文字を切りよく消す。
      // showCharacterThenRender() は立ち絵遷移が落ち着くまで本文 reveal を遅延するため、
      // ここで消しておかないと「前ページの文字が残ったまま次の立ち絵が動く」見え方になる。
      this.dialogBox.clearText()
      this.dialogBox.setIndicatorVisible(false)
      this.screenEffects.updateNovelScrim(false)
    }

    // textIndex / novel 文 index (#292) はページ先頭へ戻り、eventIndex 単位の派生ページキャッシュ
    // (#283, #448) は破棄される。
    this.cursor.nextEvent()

    if (this.cursor.eventIndex >= this.cursor.resolvedEvents.length) {
      // 全イベント完了
      this.markCurrentSceneRead()
      this.dialogBox.setDialog(null, '')
      this.dialogBox.setIndicatorVisible(false)
      this.updateCounter()
      if (this.onEndCallback) {
        // VideoExporter 等、onEnd/setOnEnd で専用の終了処理が登録されている場合はそちらに
        // 完全に委譲する（endStory() の演出フェード・"to be continued..." 表示を重ねない）。
        this.onEndCallback()
      } else {
        // [選択] を持たないまま記述が尽きたケース (#470)。confinement 経由の正規終劇
        // （choice が圏外シーンへジャンプ→ jumpToScene 内で endStory()）とは発生源が違うが、
        // 「無反応で固まる」を避けるため同じ終劇処理（"to be continued..." 表示・BGM 停止・
        // 背景/立ち絵フェード）を流用する。endStory() 自身が二重発火ガードを持つ。
        this.endStory()
      }
      return
    }

    this.processUntilNextTextEvent()

    // 立ち絵 →（同時/直後に）テキスト の順序保証 (#293)。立ち絵 sprite を同期生成してから
    // スナップショットを記録（afterShow）し、render を順序保証して呼ぶ。
    this.showCharacterThenRender(() => this.pushSnapshot())
  }

  /**
   * letterbox/pillarbox の黒帯（canvas の外側）タップ用の公開 API (#467)。
   * canvas 自身に張っている `pointerdown` リスナー（`handleAdvance`）と全く同じ処理を、
   * canvas の外側（NovelPlayer 側の `fluidRootRef` の黒帯部分）からも起動できるようにする。
   * 黒帯には canvas が無いため canvas 自身のリスナーは発火しない — その代替経路。
   */
  handleOutsideCanvasTap(): void {
    this.handleAdvance()
  }

  /**
   * デバッグ用リプレイ API (#220 Phase 1)。
   *
   * シーン+操作列（Step[]）を順に適用して任意の状態を再現する。
   * - `advance`: クリック相当。`this.advance()` を呼ぶ
   * - `choice`: 選択肢の確定パスと同等にフラグを整合させてから直接 `jumpToScene(jump)` する
   *   （Choice オーバーレイの表示はスキップする）
   * - `wait`: ms ミリ秒だけ待つ（将来の非同期イベント用）
   * - `[ジャンプ:]` (#725) に到達した `advance`/`choice` ステップの直後は、遷移の macrotask
   *   （setTimeout(0)）を自動で消化してから次のステップへ進む（`wait` を挟む必要はない）
   *
   * デバッグ/テスト用のリプレイ API。再生中は msPerChar=0（タイプライター即スキップ）とし、
   * 完了時・例外時とも元の msPerChar に必ず復元する（try/finally）。
   * 完了は Promise で通知し、その後は通常操作に戻る。
   *
   * choice は `jumpToScene` の入場結果を await する（未ロードのシーンは遅延ロードの完了まで待つ、#729）。
   * 結果が `entered` 以外（遷移先が無い・resolver 失敗・適用例外・より新しい入場に置き換えられた・
   * 終劇）なら、後続のステップを消化せず `playScript` を打ち切る（例外は投げない）。
   * 不正な jump を指定した choice ステップでは、選択肢が再表示される（PR1 の契約）。
   *
   * 同時実行は非対応。実行中（wait 待機中など）の再呼び出しは throw する。
   *
   * destroy 後ガード (#515): `wait` ステップの `await` 中に destroy() が呼ばれると
   * `this.initialized` が false になる。#460/#462/#463 と同型のパターンとして、wait 明け
   * 直後に必ずチェックし、破棄済みなら以降の step（advance/choice 含む）を処理せず終了する
   * （finally は try/finally により通常どおり実行され、isReplaying/msPerChar は後始末される）。
   */
  async playScript(steps: Step[]): Promise<void> {
    if (this.isReplaying) throw new Error('playScript is already running')
    this.isReplaying = true
    const savedMsPerChar = this.dialogBox.getMsPerChar()
    this.dialogBox.setMsPerChar(0)
    try {
      for (const [stepIndex, step] of steps.entries()) {
        switch (step.type) {
          case 'advance':
            this.advance()
            while (await this.transition.awaitPending()) {
              if (!this.initialized) return
            }
            break
          case 'choice':
            // 選択肢確定パス（ChoiceOverlay のコールバック）と同じフラグ整合を保つ。
            // justSelectedChoice は同フレーム advance 抑制用だが、playScript は
            // 同期的に進むため即リセットしてよい。
            this.transition.clearJustSelectedChoice()
            // jump 成功時は resetAndStartEvents が false にするが、jump 失敗（存在しない
            // シーン）時は resetAndStartEvents が呼ばれないため、ここで明示的にリセットする。
            this.transition.leaveChoiceWait()
            {
              // 遅延ロードの完了まで待ち、入場できなかったら（不在・resolver 失敗・適用例外・
              // より新しい入場に置き換えられた・終劇）後続のステップを消化せず打ち切る (#729, #734 PR3)。
              const result = await this.jumpToScene(step.jump)
              if (result.status !== 'entered') {
                console.warn(
                  `[name-name] playScript: choice:${step.jump} → ${result.status}、残り ${steps.length - stepIndex - 1} ステップを打ち切り`
                )
                return
              }
            }
            while (await this.transition.awaitPending()) {
              if (!this.initialized) return
            }
            break
          case 'wait':
            await new Promise<void>((resolve) => this.time.setTimeout(resolve, step.ms))
            // wait 待機中に destroy() され得る (#515)。破棄済みなら以降の step には進まない。
            if (!this.initialized) return
            break
        }
      }
    } finally {
      this.dialogBox.setMsPerChar(savedMsPerChar)
      this.isReplaying = false
    }
  }

  /**
   * 1つ前の表示イベントに戻る（スナップショットベースの宣言的復元）
   */
  goBack(): void {
    // #386: 終劇後は無効化する。endStory() は pushSnapshot() を呼ばないため、
    // history の末尾には confinement 違反前の最後のテキストイベント（storyEnded: false の
    // スナップショット）が残ったままになる。ここをガードしないと goBack で applyState が
    // storyEnded を false に巻き戻し、"to be continued..." が消えて背景/立ち絵/BGM が
    // 直前の状態に戻ってしまう（終劇の無効化）。
    // 終劇は行き止まり（決定 2026-10-20, #815）。SeekBar も同じ理由で無効表示にしている。
    if (this.storyEnded) return
    if (this.cursor.resolvedEvents.length === 0) return
    if (this.transition.isGated('navigate')) return
    // Jump 停止中 (#725): 画面は直前の本文のままなので、history 末尾（＝その本文）を pop せずに
    // 復元し直す（pop すると一つ前の行まで飛ばす／本文 1 行のシーンでは何も起きない）。
    // 復元後の advance で Jump が再発火する。
    if (this.transition.isJumpStalled()) {
      const last = this.cursor.history[this.cursor.history.length - 1]
      if (last) {
        this.applyState(last)
        this.render()
      }
      return
    }

    const current = this.cursor.resolvedEvents[this.cursor.eventIndex]
    const textEvt = getTextEvent(current)
    const novel = this.isNovelStyle()

    if (textEvt && novel) {
      // --- novel 文単位送り (#292) ---
      // 1) 同ページ内を 1 文戻る。
      if (this.cursor.sentenceIndex > 0) {
        this.cursor.prevSentence()
        this.render()
        return
      }
      // 2) ページ先頭の文で更に戻る → 前ページへ。前ページは全文見えている状態に復元する
      //    （sentenceIndex = 前ページ最後の文）＝戻った先は溜まりきった状態が自然。
      if (this.cursor.textIndex > 0) {
        this.cursor.prevPage((prevTextIndex) => {
          const prevPage = this.getNovelPages(textEvt)[prevTextIndex]
          return Math.max(0, (prevPage?.sentences.length ?? 1) - 1)
        })
        this.render()
        return
      }
      // 3) 先頭ページの先頭文 → スナップショット/イベント戻りへフォールスルー。
    } else if (textEvt && this.cursor.textIndex > 0) {
      // --- adv（従来どおり）: text 行を 1 つ戻る。 ---
      this.cursor.prevTextLine()
      this.render()
      return
    }

    // 前のスナップショットへ（現在の分を pop して、その前に戻る）
    if (this.cursor.history.length > 1) {
      this.cursor.popHistory()
      const prevState = this.cursor.history[this.cursor.history.length - 1]
      this.applyState(prevState)
      this.render()
    }
  }

  /**
   * 履歴の任意位置にジャンプする（シークバーから呼ばれる）
   */
  seekTo(historyIndex: number): void {
    // #386: goBack() と同じ理由で終劇後は無効化する（SeekBar ドラッグでの巻き戻し防止）。
    if (this.storyEnded) return
    if (historyIndex < 0 || historyIndex >= this.cursor.history.length) return
    if (this.transition.isGated('navigate')) return

    // シーク操作時はスキップモードを解除する (#140): ユーザーが特定箇所を見たくてシークしているため
    this.setSkipMode(false)
    // シーク操作時はボイスを停止する（再生中のボイスが残留しないよう）
    this.audioManager.stopVoice()

    // 履歴を指定位置まで切り詰める（アンドゥスタック方式: 戻った地点から再進行すると新しい履歴が積まれる）
    const targetState = this.cursor.truncateHistory(historyIndex)
    if (!targetState) return
    this.applyState(targetState)
    this.render()
  }

  // --- private ---

  /**
   * スナップショットを履歴に push する
   */
  private pushSnapshot(): void {
    if (
      this.cursor.eventIndex < this.cursor.resolvedEvents.length &&
      getTextEvent(this.cursor.resolvedEvents[this.cursor.eventIndex])
    ) {
      // 本文を描画した時点で、Jump だけが続く連鎖の回数をリセットする (#725)。
      this.transition.resetChain()
      this.cursor.pushHistory(this.getSnapshot())
      this.save.flushAutoSave()
    }
  }

  /**
   * スナップショットから状態を宣言的に復元する
   */
  private applyState(state: NovelGameState): void {
    this.transition.resetChain()
    this.save.discardPendingAutoSave()
    // Jump の遷移状態は GameState に載せず位置から導出する (#733)。復元は新しい到達として扱うので、
    // 予約中・停止中のどちらも持ち越さず idle へ戻し、末尾で位置が Jump なら再予約する。
    this.transition.resetJumpForRestore()
    // intermission タブロー描画の遅延タイマーをキャンセルする (#404)。goBack/seekTo でフェード中の
    // 終劇が巻き戻された後、古いタイマーが発火して復元済みの画面をタブローで上書きしてしまう事故を防ぐ。
    if (this.intermissionTimer) {
      this.time.clearTimeout(this.intermissionTimer)
      this.intermissionTimer = null
    }
    // SE シーケンス（#672）の gap 待機タイマーも画面効果と同じくリセットする。goBack/seekTo/
    // セーブロードで別の時点へ飛ぶ以上、飛ぶ前の [SE: 複数候補] の残りを鳴らし続けるのは
    // 画面効果の残留と同じ種類の事故（AudioManager.cancelSeSequence のdoc comment参照）。
    this.audioManager.cancelSeSequence()
    // テロップ (#674) も演出の中間状態なので復元（goBack/seekTo/セーブ復元/任意局面起動）では
    // 一切持たない（NovelGameState に持たせない設計、ADR-0002）。表示中の段があれば即座に消す。
    this.clearTelopLayer()

    // フラグ復元。goBack/seekTo は applyState を単独で呼ぶため、ここでの復元は必須。
    // restoreToScene 経由では列の展開より前に同じ復元が行われるが、
    // 冪等な fromJSON なので二重適用に副作用はない（詳細は restoreToScene のコメント #256）。
    this.gameState.fromJSON(state.flags)

    // 展開後の列は訪問の入場時 flags で決まり、訪問中は固定する (#799)。goBack/seekTo は flags だけを過去の値に
    // 戻すが列は変わらないので、ここでは再展開せず位置だけを復元する（シーンをまたぐ復元は restoreToScene が
    // 先に列を作る）。
    // 続けて位置（eventIndex / textIndex / sentenceIndex）を復元する。novel 文 index (#292) は古い
    // snapshot/セーブには無い → ?? 0（ページ先頭の文）に倒す。novel 改頁キャッシュ (#283)・adv 文単位
    // ページキャッシュ (#448) は派生データなので、任意局面復元で破棄し render() 側で再計算させる。
    this.cursor.restorePosition(state)

    // fluid remount 対応 (#663): aspect_ratio:auto プロジェクトは画面幅リサイズで向きの
    // カテゴリ境界を跨ぐと新しい gameWidth/gameHeight で renderer が再構築され、この
    // applyState() で旧レイアウト幅のスナップショットが復元される。ページ折り返しは表示幅に
    // 依存するため、同じイベントでも新レイアウトではページ数が変わり得る。render() 側の
    // sentenceIndex クランプ（#283、上記コメント参照）は現ページの範囲外を防ぐが、textIndex
    // 自体は検証なしでコピーされていた。textIndex が新しいページ数を超えたまま advance() に
    // 渡ると「同ページに続きがある」「次ページがある」の両判定が偽になり次イベントへ素通り
    // してしまい、最悪 #470 の終劇フォールバックに到達して ToBeContinued が早期表示される。
    // 既存の sentenceIndex クランプと同種の防御として、ここで最後の有効ページへクランプし、
    // 読んでいた位置になるべく近いページに留める。goBack/seekTo 等の通常復元では textIndex は
    // 既に有効範囲内なので no-op（advance() 自体の挙動には影響しない）。
    const clampTextEvt = getTextEvent(this.cursor.resolvedEvents[this.cursor.eventIndex])
    if (clampTextEvt) {
      const pageCount = this.currentPageCount(clampTextEvt)
      // セルフレビュー must S1 (#666): textIndex を新ページへクランプしても、直前に復元済みの
      // sentenceIndex（旧ページの文 index）はそのまま残ってしまう。render() の #283 クランプは表示用
      // ローカル変数だけを補正し sentenceIndex 自体は直さないため、goBack()（sentenceIndex > 0 を見る）が
      // 旧ページの生値を見て「新ページの先頭文まで見た目上変化しない goBack を複数回叩かないと前ページへ
      // 戻れない」というファントム動作を起こす。クランプが発火した＝ページが変わったので、
      // `clampToPageCount` は textIndex を最終ページへ寄せるのと同時に sentenceIndex を 0（新ページの
      // 先頭文）に戻す。
      this.cursor.clampToPageCount(pageCount)
    }

    // 終劇状態の復元 (#386)。goBack/seekTo/セーブ復元はすべて即時反映（フェード演出はしない）。
    // "to be continued..." 表示は callback とは独立に syncEndingOverlayVisibility() で同期する（#630）。
    // #460 セルフレビュー must M2: 値が実際に変化した時だけコールバックを発火する（変化なしなら
    // 発火しない）。goBack/seekTo/loadFromSaveData は同一 renderer インスタンス上で this.storyEnded
    // が真の直前状態を保持しているため、この比較は「本当に変わったか」を正しく判定できる
    // （例: 終劇直後に goBack で false に戻り、再度 advance して true に達すれば、両方とも
    // prevStoryEnded と異なるので発火し続ける＝既存挙動を壊さない）。restoreSnapshot（fluid 再マウント
    // で新規 renderer インスタンスに対して呼ばれる）は、呼び出し側で this.storyEnded を復元先の値に
    // 事前セットしてから applyState を呼ぶため、ここでは常に「変化なし」となり発火しない
    // （再マウントのたびに終劇 postMessage が重複送信されるのを防ぐ）。
    const prevStoryEnded = this.storyEnded
    this.storyEnded = state.storyEnded
    this.syncSeekBarEnabled()
    if (prevStoryEnded !== state.storyEnded) {
      this.onStoryEndedChangeCallback?.(state.storyEnded)
    }
    // 終劇オーバーレイの表示同期 (#630) はコールバック発火の有無に関わらず毎回行う
    // （callback 側は postMessage 重複防止のため変化時だけ発火するが、表示自体は fluid 再マウント
    // で新規 renderer インスタンスが作られた際にも正しい storyEnded 値を反映する必要があるため。
    // 旧 DOM 版は React state が再マウントを跨いで保持されることで表示を維持していたが、新
    // renderer インスタンスの endingOverlay は必ず非表示から始まるため、ここで明示的に同期しないと
    // 「fluid 再マウント直後は終劇表示が消える」regression になる）。
    // instant: true (#630 セルフレビュー must M1)。applyState() はすべて goBack/seekTo/セーブ復元
    // 経由（このメソッド自体のコメント冒頭 #386 参照）なので、CharacterLayer 既定の Fade（700ms）を
    // 発火させず即時反映する。通常の物語進行（endStory()）はこの経路を通らないため影響しない。
    this.syncEndingOverlayVisibility(true)

    // 演出の復元 (#828 7c)。`stage.restore` が、画面効果（揺れ・フラッシュ/フェード）の停止と stage 位置の
    // 原点戻し、novel スクリム退避途中（#283）のリセット（render() が現在ページのスクリム可視性を再設定する）
    // を先に行ってから、背景画像 → 単色地色 → 暗転（#350）→ 紙人形輪郭 (#699) → カメラ3つ組 (#681/#682) を
    // 宣言的に復元する。クロスフェード・揺れ・スクリム退避などの中間状態は持たない（ADR-0002）。
    // 輪郭とカメラは立ち絵・大道具・背景板へも伝わる。以降の show()/restore() で新規作成される
    // スプライトにも自動適用されるため、それらより前にここで行う。
    this.stage.restore(state)
    // 背景なしの復元は動画レイヤも消す扱い (#252)。コントローラは動画に触れないのでここで行う。
    if (!state.backgroundPath) this.videoLayer.remove()

    // 動画レイヤ復元 (#252)。clearBackground / setBackground は背景のみを扱い
    // 動画には触れないため（show が単一スロットを置換、なしなら remove）、背景復元の後に行う。
    this.videoLayer.restore(state.video)

    // イベント絵レイヤー復元 (#351)。フェードは行わず即時反映（ADR-0002）。全背面レイヤー
    // （背景・背景板・動画・立ち絵・大道具）の可視性は復元後の状態を見て宣言的に再計算する（ライブ進行の `directives/stageDirectives.ts` の
    // `EventImage` ハンドラと同じ applyEventImageVisibility を共有）。onSettled でロード完了/失敗後にも再計算する
    // （`EventImage` ハンドラと同じセルフレビュー対応）。
    this.eventImageLayer.restore(state.eventImage, {
      onSettled: () => this.applyEventImageVisibility(),
    })
    this.applyEventImageVisibility()

    // 舞台構造の背景板復元 (#683)。characters と同じくスライドインは起こさず、スナップショット
    // 時点の状態を即時表示する（ADR-0002: 演出の中間状態を復元しない）。BackgroundBoardLayer は
    // カメラ状態を自前で保持しているため、restore() で板を再配置する前にカメラを同期させる必要がある
    // （`stage.restore` が `applyCamera` で済ませてある）。
    this.backgroundBoardLayer.restore(state.backgroundBoards, this.assetBaseUrl)

    // 舞台の壁復元 (#703)。壁はカメラ射影を受けない（ズームはレイヤー自身に掛かる）。同じ壁が表示中なら流し続け、
    // 異なる・表示できていない・非ループ動画が再生し終えているときは差し替える（動画は頭から再生）。
    this.wallLayer.restore(state.wall, this.assetBaseUrl)

    // 舞台前面復元 (#705)。画面空間のオーバーレイでカメラ射影・ズームを受けない。同じ前面が表示中（または
    // ロード進行中）なら再読み込みせず、異なる・表示できていないときだけ差し替える。
    this.stageFrontLayer.restore(state.stageFront, this.assetBaseUrl)

    // 天候復元 (#706)。画面空間のオーバーレイでカメラ射影・ズームを受けない。粒の位置は保存しないので、
    // 同じ天候が降っていれば流し続け、違うときだけ経過 0 から降らせ直す。
    this.weatherLayer.restore(state.weather ?? null)

    // 床復元 (#706 第2弾)。ズームは背景板と同じに受けるが射影は受けない。同じ床（パス・高さ・assetBaseUrl が同一）が
    // 表示中（またはロード進行中）なら再読み込みせず、異なる・表示できていないときだけ差し替える。
    this.floorLayer.restore(state.floor ?? null, this.assetBaseUrl)

    // 舞台構造の大道具復元 (#692)。backgroundBoardLayer と同じ理由・同じ手順
    // （カメラは `stage.restore` で同期済み）。
    this.propLayer.restore(state.props, this.assetBaseUrl)

    // 幕復元 (#697)。backgroundBoardLayer/propLayer と異なりカメラ射影は持たないため
    // setCamera() は不要。z-order を charactersInFront に合わせてから（既定 false）、
    // スライド無しで即座に最終位置へ配置する。
    this.setCurtainZOrder(state.curtain?.charactersInFront ?? false)
    this.curtainLayer.restore(state.curtain, this.assetBaseUrl)

    // 立ち絵復元（フェードインは入れず、スナップショット時点の状態を即時表示する #177）。
    // novel 役割配置 (#286): protagonist 指定時は復元でも質問役=左 / 回答役=右の x を当てる
    // （token のままだと前進時の配置と食い違うため）。ポーズ nudge は演出なので復元では起こさない。
    // 立ち絵レイヤー (#694) も背景板/大道具と同じ理由・同じ手順（カメラは `stage.restore` で同期済みで、
    // 以下の show() 呼び出しより前に済んでいる）。
    this.characterLayer.clear()
    for (const ch of state.characters) {
      const xRatio = this.resolveNovelRoleXRatio(ch.name)
      // 明示フィット (#294) は GameState に持たない脚本由来属性なので、復元時は
      // 現在イベント以前の最新 Dialog から引き当てて再現する（goBack/seekTo/セーブ復元）。
      const fit = resolveCharacterFit(this.cursor.resolvedEvents, this.cursor.eventIndex, ch.name)
      this.characterLayer.show(ch.name, ch.expression, ch.position, this.assetBaseUrl, {
        instant: true,
        xRatio,
        fit,
        // シアターモードの奥行き配置 (#694)。NovelGameState.characters に直接持つ（fit と違い
        // 脚本の再走査は不要）。
        depth: ch.depth,
      })
    }
    // 話者交代追跡 (#286) を復元位置の話者に合わせる。任意局面復元の直後に同じ話者で
    // 前進しても誤って nudge しないよう、現在イベントの Dialog 話者を lastSpeaker に据える。
    // 復元自体ではポーズ変化を起こさない（演出は GameState に持たない）。
    const restoredEvt = getTextEvent(this.cursor.resolvedEvents[this.cursor.eventIndex])
    this.lastSpeaker = restoredEvt?.type === 'dialog' ? restoredEvt.character : null

    // 追うスポットライト復元 (#693)。対象キャラの座標問い合わせに使う characterLayer への
    // 復元が終わった直後に行う（target が存在しなくても LightingLayer 側が画面中央へ
    // フォールバックするので順序自体は必須ではないが、依存関係として自然な位置に置く）。
    this.lightingLayer.restore(state.spotlight)

    // BGM復元
    if (state.currentBgmPath) {
      const soundUrl = resolveAssetUrl(this.assetBaseUrl, 'sounds', state.currentBgmPath)
      this.audioManager.playBgm(soundUrl)
      this.currentBgmPath = state.currentBgmPath
    } else {
      this.audioManager.stopBgm(0)
      this.currentBgmPath = null
    }

    // カメラズームの再スナップ (#702)。`stage.restore` 内のスナップは立ち絵の復元より前に走るため、
    // 対象キャラの位置が未確定で全景に倒れる。立ち絵復元後にもう一度最終ポーズへ即時スナップする。
    this.cameraZoom.set(this.stage.cameraMode, this.stage.cameraZoom, true)

    // Jump 位置への復元 (#733): 宣言的復元は現在位置のディレクティブを再実行しないため、
    // eventIndex が Jump を指していると遷移の予約が無く行き止まりになる（startFrom の eventIndex 指定・
    // 古いセーブ等）。到達時と同じ経路で再予約する。[条件:] 内の Jump は resolvedEvents（復元後のフラグで
    // 展開済み）の現在イベントで判定するので、条件が偽なら Jump はここに現れず再予約もしない。
    // 遷移先不在なら通常到達時と同じく warn して stalled に戻る。
    this.rearmJumpAtCurrentPosition()
  }

  /**
   * 現在位置が Jump を指していれば遷移を再予約する (#733)。applyState の末尾と、遅延ロード中の復元が
   * 失敗して位置が動かない分岐（flags も適用しない #765）の両方が通る。Jump の遷移状態は GameState に載せず
   * 位置から導出する、という規則の実装。遷移先が不在でも stallJump は使わず、通常到達時と同じ経路
   * （armJump → jumpToScene → 不在確定で stalled）に任せる。
   */
  private rearmJumpAtCurrentPosition(): void {
    const restoredJump = this.cursor.resolvedEvents[this.cursor.eventIndex]
    if (typeof restoredJump === 'object' && restoredJump !== null && 'Jump' in restoredJump) {
      this.markCurrentSceneRead()
      this.armJump(restoredJump.Jump.target)
    }
  }

  /**
   * typewriter 表示中なら全文表示にスキップ、完了済みなら次イベントへ進む (#137)。
   * advance() / クリック / Enter / Space / ArrowRight 共通の入力ハンドラから呼ぶ。
   *
   * 呼び出し元は必ず先に setAutoMode(false) してから本メソッドを呼ぶこと。
   * skipTypewriter() 内は onTypingDone を破棄するが、この時点では autoMode がすでに
   * false になっているため、次の render() でコールバックがセットされず自動進行しない。
   */
  private advanceOrSkipTypewriter(): void {
    if (this.dialogBox.isTyping()) {
      this.dialogBox.skipTypewriter()
      return
    }
    this.advance()
  }

  /**
   * canvas の touch-action を設定する (#434)。canvas 未初期化時は no-op。
   * 既定は NOVEL_CANVAS_TOUCH_ACTION（'pan-y'）。スクロール可能な選択肢リスト（#339）表示中だけ
   * ChoiceOverlay からの setOnScrollableChange 通知（scrollable=true）で 'none' に戻す
   * （下記 init 内の配線を参照）。
   */
  private setCanvasTouchAction(value: CanvasTouchAction): void {
    if (!this.appInitialized) return
    const canvas = this.app.canvas as HTMLCanvasElement
    canvas.style.touchAction = value
  }

  /**
   * キャンバスからカーソルが出たら SeekBar の active を解除して丸ボタンを戻す (#350)。
   * 匿名リスナにせずフィールド束縛し、destroy で removeEventListener できるようにする
   * （handleAdvance / handleWheel / handleKeyDown と同じ流儀）。
   */
  private handleCanvasMouseLeave = (): void => {
    this.seekBar.deactivate()
  }

  /**
   * SeekBar のつまみ中心を下部丸ボタンの実中央（固定 CSS px）に一致させる (#350)。
   * 丸ボタンは DOM の固定 px（`bottom` + 半径 = PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX）でスケールしない。
   * スライダは Pixi 論理座標で表示倍率に応じてスケールするため、`canvas.clientHeight / screenHeight` の
   * 実倍率で割って「画面下端から常に固定 CSS px」に来る論理 Y を算出して渡す。これで表示高さが論理と
   * 異なる端末でもボタン中央を貫く。clientHeight 不明（0/未測定）のときは触らない（constructor 既定のまま）。
   */
  private syncSeekBarVerticalToButtons(): void {
    const canvas = this.app?.canvas as HTMLCanvasElement | undefined
    if (!canvas) return
    const clientH = canvas.clientHeight
    if (!(clientH > 0)) return
    const scale = clientH / this.screenHeight
    const logicalFromBottom = PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX / scale
    this.seekBar.setVerticalCenter(this.screenHeight - logicalFromBottom)
  }

  /**
   * テロップの下端アンカー（BottomLeft/BottomRight）が下部丸ボタン行の実際の高さ（固定 CSS px）を
   * 避けられるよう、論理座標換算のボタン行高さを算出して `telopLayer` / `dialogBox` の予約に
   * 反映する (#677)。`syncSeekBarVerticalToButtons` と同じ理由・同じ算出方法（`canvas.clientHeight`
   * から実倍率を求め、固定 CSS px をその倍率で割って論理座標に変換する）。
   * clientHeight 未測定（0）のときは触らない（constructor 既定の `PLAYER_BUTTON_ROW_HEIGHT_PX` のまま）。
   * `telopReserveEnabled` が false（`telop_reserve:` 未指定/false）の作品では帯予約自体が常に 0 のため、
   * `applyTelopReserve`（→ `dialogBox.setNovelBottomReserve` → 改頁行数の再計算）は無駄な再計算になる。
   * テロップ帯そのものの高さ同期（`setButtonRowHeightPx`）は予約の有無に関係なく必要なので常に行う（#678）。
   */
  /**
   * `telopLayer.clear()` を呼びつつ `telopClearEpoch` を1つ進める (#679 レビューS3)。
   * scene切替（resetAndStartEvents / SceneTransition）・goBack/seekTo/セーブ復元（applyState）・
   * destroy() の4箇所全てここ経由にし、`directives/stageDirectives.ts` の `Telop` ハンドラが
   * `ensureFontLoaded()` 完了時にこのエポックの変化を見て「待機中に打ち切られたか」を判定する。
   */
  private clearTelopLayer(): void {
    this.telopLayer.clear()
    this.telopClearEpoch++
  }

  private syncTelopBottomMarginToButtons(): void {
    const canvas = this.app?.canvas as HTMLCanvasElement | undefined
    if (!canvas) return
    const clientH = canvas.clientHeight
    if (!(clientH > 0)) return
    const scale = clientH / this.screenHeight
    this.telopButtonRowHeightPx = PLAYER_BUTTON_ROW_HEIGHT_PX / scale
    this.telopLayer.setButtonRowHeightPx(this.telopButtonRowHeightPx)
    if (this.telopReserveEnabled) {
      this.applyTelopReserve()
    }
  }

  /**
   * イベント絵レイヤー (#351) の `back` 値に応じて、背景・背景板・動画・立ち絵・スポットライト・
   * 大道具の可視性を宣言的にトグルする。
   *
   * `setBlackout` と同じ「単一の宣言的セッター」パターン: `directives/stageDirectives.ts` の `EventImage` ハンドラ（ライブ進行）と
   * applyState（goBack/seekTo/セーブ復元）の両方から、eventImageLayer の現在状態を毎回
   * 素直に読んで反映するだけにする。退避 → 復元のような一回限りのアニメーションは持たない
   * （ADR-0002: スナップショットは常に settled 状態のみを持つ）。
   *
   * 判定は `eventImageLayer.shouldHideBackLayer()` に委ねる（`getState()?.back==='Hide'` の単純な
   * 意図参照ではなく、ロード失敗時は覆うものが無いため隠さない可視性専用ロジック。セルフレビュー
   * 指摘: back=Hide のままロードが永久に失敗すると背面が隠れっぱなしになる事故を防ぐ）。
   * `backgroundBoardLayer`（#683）・`videoLayer`（#252）・`propLayer`（#692）・
   * `lightingLayer`（#693）・`curtainLayer`（#697）も背面スタックの一部なので同じトグルに含める
   * （event image の前面に追加レイヤーだけ透けて見える事故を防ぐ）。
   */
  private applyEventImageVisibility(): void {
    this.applyStageLayerVisibility()
  }

  /**
   * 舞台レイヤー全部の可視性を `stageLayerVisibility.ts` の規則から再計算して適用する (#982)。
   * 入力は「タイトル表示中か（titleScreenOverlay.visible）」と「イベント絵の背面隠し」の2つだけ。
   * 状態（キャラ・アニメ・ticker・ボイス）は触らず、visible / renderable だけを書く。冪等。
   */
  private applyStageLayerVisibility(): void {
    const input = {
      titleActive: this.titleScreenOverlay.visible,
      hideBack: this.eventImageLayer.shouldHideBackLayer(),
    }
    const targets = this.stageLayerTargets()
    for (const key of Object.keys(STAGE_LAYER_RULES) as StageLayerKey[]) {
      const state = computeStageLayerState(key, input)
      if (key === 'background') {
        this.background.setVisible(state.visible)
        continue
      }
      const layer = targets[key]
      if (key === 'character') {
        this.characterLayer.visible = state.visible
        this.characterLayer.setTitleSuppressed(
          state.titleSuppressed,
          NovelRenderer.TITLE_LOGO_IMAGE_ID
        )
        continue
      }
      // 'renderable' のレイヤー: 吹き出しは自身の show()/hide() が visible を管理するため触らない。テロップは
      // visible を書かないが、吹き出しと同じ手段に揃える。
      if (STAGE_LAYER_RULES[key].title === 'renderable') {
        layer.renderable = !state.titleSuppressed
      } else {
        layer.visible = state.visible
      }
    }
  }

  /** 可視性規則の対象レイヤー（背景は BackgroundController 経由なので含まない）。テストの網羅チェックも使う。 */
  private stageLayerTargets(): Record<Exclude<StageLayerKey, 'background'>, Container> {
    return {
      wall: this.wallLayer,
      backgroundBoard: this.backgroundBoardLayer,
      video: this.videoLayer,
      floor: this.floorLayer,
      character: this.characterLayer,
      lighting: this.lightingLayer,
      prop: this.propLayer,
      curtain: this.curtainLayer,
      eventImage: this.eventImageLayer,
      stageFront: this.stageFrontLayer,
      weather: this.weatherLayer,
      bubble: this.bubbleLayer,
      telop: this.telopLayer,
    }
  }

  /**
   * 幕レイヤーの stage 上の z-order を `characters_in_front` に応じて切り替える (#697)。
   * このコードベースで動的な z-order 差し替えの前例が無いため、`stage.removeChild()` で
   * 一旦取り除いてから `stage.addChildAt()` で挿入する（`Container.setChildIndex()` は内部で
   * 「現在位置から取り除いてから挿入する」ため、移動元と移動先の位置関係によっては index が
   * 1つズレる——先に明示的に取り除いておけば、この後の `getChildIndex()` は curtainLayer を
   * 含まない配列に対する値になり、ズレの心配なく `+1` するだけで正しい位置に挿入できる）。
   *
   * - `false`（既定）: `propLayer` の直後（最前面、`eventImageLayer` の手前）
   * - `true`（カーテンコール）: `backgroundBoardLayer` の直後（`characterLayer` の手前）
   *
   * `init()` 完了前（PixiJS canvas 未構築。jsdom テストが `setScenes()`/`setEvents()` を
   * 呼んでいる状態、`NovelRenderer.restoreSnapshot.test.ts` 等）は各レイヤーがまだ
   * `app.stage` の子ではない——`init()` が全レイヤーを一括で `addChild` するまではこの
   * メソッドが動かす対象自体が存在しないので、その場合は何もしない（本番経路は必ず
   * `renderer.init(container).then(() => renderer.setScenes/setEvents(...))` の順で呼ばれる
   * ため、init() 完了後は常に全レイヤーが揃っている）。
   */
  private setCurtainZOrder(charactersInFront: boolean): void {
    const stage = this.app.stage
    const referenceLayer = charactersInFront ? this.backgroundBoardLayer : this.propLayer
    if (referenceLayer.parent !== stage) return
    if (this.curtainLayer.parent === stage) {
      stage.removeChild(this.curtainLayer)
    }
    const referenceIndex = stage.getChildIndex(referenceLayer)
    stage.addChildAt(this.curtainLayer, referenceIndex + 1)
  }

  private handleAdvance = (): void => {
    if (this.transition.consumeJustSelectedChoice()) {
      // 「1 ポインタジェスチャで 1 回だけ」を守るため、このフレームで進めないと決まった時点で
      // suppressNextAdvance も一緒に消費する (#350)。choice 直後の同フレームに SeekBar 由来の
      // suppressNextAdvance が同居していても、固着させて後続の独立ポインタへ漏らさない。
      this.transition.consumeSuppressNextAdvance()
      return
    }
    // SeekBar の clickRegion(Pixi) が同じ native pointerdown でこの DOM ハンドラより先に発火し
    // onSeek 内で suppressNextAdvance を立てる (#350)。スライダ下端帯タップが「シーク＋1つ進む」と
    // 二重発火するのを防ぐため、立っていれば 1 回だけ消費して早期 return する（justSelectedChoice と同型）。
    if (this.transition.consumeSuppressNextAdvance()) {
      return
    }
    // ここに到達 = スライダ以外への通常タップ/送り。SeekBar が active なら即 inactive へ戻して
    // 丸ボタンを復帰させる（無操作タイマー満了を待たない） (#350)。inactive 時は no-op。
    this.seekBar.deactivate()
    this.audioManager.ensureContext()
    // タイトル画面表示中 (#628 フェーズ2b) は canvas 全体を覆う UI なので、canvas への
    // native pointerdown をゲーム進行として扱わない（backlogOverlay/saveLoadOverlay と同型）。
    if (this.titleScreenOverlay.visible) return
    if (this.backlogOverlay.visible) {
      this.backlogOverlay.hide()
      return
    }
    if (this.saveLoadOverlay.visible) return
    // 手動クリック/タップでオートモード・スキップモードをキャンセル (#139 #140)
    this.setAutoMode(false)
    this.setSkipMode(false)
    this.advanceOrSkipTypewriter()
  }

  private handleWheel = (e: WheelEvent): void => {
    if (this.transition.waitingForChoice && this.choiceOverlay.handleWheel(e.deltaY)) {
      e.preventDefault()
      return
    }
    if (this.backlogOverlay.visible) {
      e.preventDefault()
      this.backlogOverlay.handleWheel(e.deltaY)
      return
    }
    // フルキャンバス画像表示モード (#530)。画像がキャンバス高さに収まっている場合や
    // モードが無効な場合は EventImageLayer.handleWheel 側が no-op になるので、常に呼んで
    // 問題ない（`waitingForChoice`/`backlogOverlay` と違い、ここでは事前ガードを重複させない）。
    // `choiceOverlay` と同じく戻り値（実際に消費したか）を見て、消費した場合のみ
    // preventDefault する（#547 should-C）。
    if (this.eventImageLayer.handleWheel(e.deltaY)) {
      e.preventDefault()
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.transition.consumeJustSelectedChoice()) {
      return
    }
    this.audioManager.ensureContext()

    // タイトル画面表示中 (#633): キー入力は TitleScreenOverlay 自身のキーボードフォーカス管理
    // （Tab/Shift+Tab・矢印でのフォーカス移動、Enter/Space での実行）に委譲する。ここで早期
    // return することで、Enter/Space/矢印キー等が advanceOrSkipTypewriter()/
    // backlogOverlay.toggle() 等のゲーム進行処理へ漏れるのを防ぐ（#628 でタイトル画面を
    // PixiJS 描画へ移行した際、handleAdvance には同種のガードがあったが handleKeyDown には
    // 無かったガード漏れの修正）。
    if (this.titleScreenOverlay.visible) {
      const handled = this.titleScreenOverlay.handleKeyDown(e.key, e.shiftKey)
      if (handled) e.preventDefault()
      return
    }

    // 選択肢表示中 (#633 フェーズB): キー入力は ChoiceOverlay 自身のキーボードフォーカス管理
    // （Tab/Shift+Tab・矢印でのフォーカス移動、Enter/Space での確定）に委譲する。
    // titleScreenOverlay.visible ガード（#633 フェーズA）と同じ「委譲して即 return」パターン。
    // `choiceOverlay.visible` ではなく `waitingForChoice` を見るのは、`handleWheel`（3319行目
    // 付近）が既に同じ状態変数で choiceOverlay への委譲有無を判定しており、判定軸を増やさない
    // ため。ChoiceOverlay.handleKeyDown が false を返すキー（縦一列時の ArrowLeft/ArrowRight 等）
    // でもここで return する — advance()/goBack() は自前で waitingForChoice ガードを持つため、
    // switch 文へフォールスルーさせなくても no-op のまま変わらない（handleKeyDown 全体の早期
    // return なので二重チェックにならない）。
    if (this.transition.waitingForChoice) {
      const handled = this.choiceOverlay.handleKeyDown(e.key, e.shiftKey)
      if (handled) e.preventDefault()
      return
    }

    // Escape: 開いているオーバーレイを閉じる
    if (e.key === 'Escape') {
      if (this.backlogOverlay.visible) {
        this.backlogOverlay.hide()
        return
      }
      if (this.saveLoadOverlay.visible) {
        this.saveLoadOverlay.hide()
        return
      }
      return
    }

    // バックログ表示中のキー操作
    if (this.backlogOverlay.visible) {
      switch (e.key) {
        case 'b':
        case 'B':
          this.backlogOverlay.hide()
          break
        case 'ArrowUp':
          e.preventDefault()
          this.backlogOverlay.handleKeyScroll('up')
          break
        case 'ArrowDown':
          e.preventDefault()
          this.backlogOverlay.handleKeyScroll('down')
          break
      }
      return
    }

    // セーブ/ロードオーバーレイ表示中は入力を無視
    if (this.saveLoadOverlay.visible) return

    // オーバーレイが開いていない場合のキー操作
    switch (e.key) {
      case ' ':
      case 'Enter':
        e.preventDefault()
        // 手動キー操作でオートモード・スキップモードをキャンセル (#139 #140)
        this.setAutoMode(false)
        this.setSkipMode(false)
        this.advanceOrSkipTypewriter()
        break
      case 'ArrowRight':
        this.setAutoMode(false)
        this.setSkipMode(false)
        this.advanceOrSkipTypewriter()
        break
      case 'ArrowLeft':
        this.setAutoMode(false)
        this.setSkipMode(false)
        this.goBack()
        break
      case 's':
      case 'S':
        if (!this.transition.waitingForChoice) {
          this.save.openSaveMenu()
        }
        break
      case 'l':
      case 'L':
        if (!this.transition.waitingForChoice) {
          this.save.openLoadMenu()
        }
        break
      case 'b':
      case 'B':
        if (!this.transition.waitingForChoice) {
          this.backlogOverlay.toggle()
        }
        break
    }
  }

  /**
   * 非テキストイベントを実行しながら次のテキストイベントまで進む
   */
  private processUntilNextTextEvent(): void {
    try {
      this.runDirectivesUntilStop()
    } finally {
      // 回転舞台 `[舞台回転]` (#704 第2弾) の範囲は「進行を止めるイベント」（台詞・ナレーション・選択肢・待機・
      // ジャンプ）か終端で閉じる。ためた裏側の指定をここで流し込み、回転（または即時切替）を起こす。
      this.stageTurn.flush()
    }
    // 次に出る立ち絵・背景をバックグラウンドで先読みする (#389)。
    // advance / setScenes / jumpToScene は全てここを通るので、この 1 箇所で全トリガーを覆う。
    // 走査は同期・実ダウンロードは backgroundPreload に投げっぱなし（await しない＝本編を待たせない）。
    this.preloadUpcomingAssets()
  }

  private runDirectivesUntilStop(): void {
    while (this.cursor.eventIndex < this.cursor.resolvedEvents.length) {
      if (getTextEvent(this.cursor.resolvedEvents[this.cursor.eventIndex])) break
      const directive = this.cursor.resolvedEvents[this.cursor.eventIndex]
      this.processDirective(directive)
      // エントリの線形ストリームのシーン境界なら、入ったシーンを知らせる (#777)。本編ストリームの処理だけで
      // 通知する（intermission のタブローは別のイベント列を processDirective に流すので通知しない）。
      // 閉じ込め外のシーンに入るときは終劇にして、これ以上進めない。
      if (directive === 'SceneTransition' && this.notifyLinearSceneEntered()) break
      // Choice / Wait / Jump 予約中は進行を止める。ユーザー操作のゲートではなく、この同期ループ自身が
      // 今立てた状態を見るだけ（入場中は同期の適用中には立たない）ので isTransitionGated は使わない。
      if (
        this.transition.waitingForChoice ||
        this.transition.waitingForWait ||
        this.transition.isJumpPending()
      )
        break
      this.cursor.skipDirective()
    }
  }

  /**
   * 立ち絵・背景テクスチャの先読み (#389)。
   *
   * 立ち絵・背景は従来「表示の瞬間に初めて `Assets.load`」する遅延ロード（初出は必ず
   * ネット取得のコールドロード）で、遅延・瞬断すると #293 のフォールバック（ロード成否に
   * 関わらず onReady 発火でテキスト解禁）により「立ち絵なし・テキストあり」を招く。これを
   * 緩和するため、現在の `eventIndex` から `resolvedEvents` を前方走査し、次に出るアセット
   * URL を `backgroundPreload` に積んで事前に温めておく。
   *
   * - 走査は**次の分岐に当たるまで**。分岐 = `Choice`（`{ Choice: {...} }`）または
   *   `Condition`（`{ Condition: {...} }`、フラグ依存分岐）。分岐先が確定するまで先読みは
   *   できないため、当たったら止める（配列末尾でも止める）。
   *   ※ `Condition` は入場時に展開済みのため `resolvedEvents` には通常現れないが、
   *     仕様として境界扱いを明示しておく（防御的・非回帰）。
   * - 収集対象: `Dialog` / `ExpressionChange` の立ち絵（`resolveCharacterImageUrls`、
   *   webp/png の複数候補）、`Background` の背景画像、`BackgroundBoard` の背景板 (#683)、
   *   `Wall` の壁 (#703, 画像の壁のみ。動画の壁は対象外)、`StageFront` の舞台前面 (#705)、`EventImage` のイベント絵、単独画像 `[画像:]`（#274, `Image`）（いずれも
   *   `resolveAssetUrl`）(#621)。Video 等
   *   `Assets.load` 経路でないものは対象外。Dialog の立ち絵は実表示ガード（`showCharacterFromDialog`:
   *   `expression` / `position` / `character` が全て truthy）に揃え、空文字・position 欠落は積まない。
   * - **緩い上限**: 分岐までが極端に長い場合に備え、先読みするテキストイベント
   *   （`getTextEvent` 非 null）を最大 `PRELOAD_MAX_TEXT_EVENTS`（preloadPlan.ts）個ぶんに抑える。
   *   テキストイベント以外（Background / ExpressionChange 等）は予算に数えず、予算を使い切った
   *   後の**次のテキストイベントに達した時点で**走査を終了する（そこに至るまでの Background 等は
   *   積む＝test18 が固定する挙動。上限で即座に走査終了するわけではない）。
   * - **重複除去**: まずスキャン内（`urls`）で重複する URL を除去する（同じキャラの表情が
   *   Dialog→ExpressionChange で連続する、同じ表情が複数回登場する等で発生し得る。近い順の並びを
   *   保つため初出＝最も近い方を残す）。その上で `preloadedUrls` で既に積んだ URL もスキップする
   *   （#417）。
   * - **ガード**: `assetBaseUrl` が空なら何もしない。実ダウンロードは投げっぱなしで、
   *   失敗は握りつぶす（先読み失敗で本編を止めない）。#293 の順序保証とは独立で、先読みが
   *   未完でも従来どおりテキストは詰まらない（後方互換）。
   */
  private preloadUpcomingAssets(): void {
    // URL の収集（走査範囲・分岐での打ち切り・近い順・重複除去・assetBaseUrl が空なら空）は純粋関数
    // `collectUpcomingAssetUrls`（preloadPlan.ts）。ここには積み済み集合との差分と実ロードの投入だけを残す。
    const dedupedUrls = collectUpcomingAssetUrls(
      this.cursor.resolvedEvents,
      this.cursor.eventIndex,
      this.assetBaseUrl
    )

    // 未積みの URL だけを backgroundPreload に積む（同期は走査のみ・実 DL は投げっぱなし）
    const fresh = dedupedUrls.filter((u) => !this.preloadedUrls.has(u))
    if (fresh.length === 0) return
    for (const u of fresh) this.preloadedUrls.add(u)
    // 先読み失敗で本編を止めない。#293 のフォールバックがテキストは従来どおり解禁する。
    //
    // fresh は近い順（nearest→farthest）に組み立てている。backgroundPreload は積まれた配列を
    // 末尾から pop（LIFO）して1件ずつ読むので、reverse() して [farthest, ..., nearest] にし、
    // 末尾＝nearest が最初に読まれるようにする (#414)。消化順は自前の backgroundPreload が決めて
    // いるため PixiJS の内部実装には依存しない。
    // Assets.backgroundLoad は内部で reject を握らず pageerror になる＋以降の先読みが止まるため
    // 使わない (#782)。
    backgroundPreload(fresh.reverse())
  }

  /**
   * 演出イベントを実行する。
   *
   * 背景・立ち絵・オーディオなど演出系の種は `directives/` の領域別ハンドラ（`dispatchDirective`）が処理する (#829)。
   * ここには再生状態（フラグ・カーソル・遷移・待機タイマー）を同時に触るフロー制御系
   * （`WaitDisplayComplete` / `Flag` / `Choice` / `Jump` / `Wait`）だけが残る。
   *
   * Condition は resolvedEvents では既に展開済みなので、ここでは処理しない。
   */
  private processDirective(event: Event): void {
    if (dispatchDirective(event, this.directiveContext)) return
    if (typeof event === 'string') {
      if (event === 'WaitDisplayComplete') {
        this.beginWaitDisplayComplete()
      }
      return
    }
    if ('Emotion' in event) {
      // [感情:] (#943) はフィールドの吹き出し用。ノベル再生にはフィールドが無いので何もしない。
      if (import.meta.env.DEV) {
        console.warn('[name-name] [感情:] はフィールドが無い場面では無視されます')
      }
      return
    }
    if ('Flag' in event) {
      // `[条件:]` はシーン訪問の入場時に展開済みで、訪問中は列を固定する (#799)。ここで再展開しない
      // （ブロック内でそのフラグを変えても、入場済みのブロックの残りは流れる。TUI と同じ）。
      this.gameState.setFlag(event.Flag.name, event.Flag.value)
      return
    }
    if ('Choice' in event) {
      // Choice に到達した時点で、そこまでの本文を読み終えた scene とみなす (#366)。
      this.markCurrentSceneRead()
      // #398: `?scene=` 単独埋め込み（confinement 設定時）で、全 option が圏外を指す choice は
      // 描画せずに終劇へ倒す。jumpToScene は「選んだ jump 先」でしか圏外判定できないため、
      // クリックするまで endStory に到達せず、その結果 #395/#397 の story-ended postMessage が
      // 発火せず theo 側で既読化されなかった。既読化（上の markCurrentSceneRead）を済ませてから
      // ここで先回りして終劇する＝選択肢を出さずに完読を通知できる。通常のハブ経由フロー
      // （confinedSceneIds === null）では isSceneIdConfined が常に true を返すため短絡しない。
      if (
        this.entry.confinedSceneIds !== null &&
        event.Choice.options.every((o) => !isSceneIdConfined(o.jump, this.entry.confinedSceneIds))
      ) {
        this.endStory()
        return
      }
      // 選択肢に到達したらスキップモードを解除（手動選択が必要） (#140)
      this.setSkipMode(false)
      // 複数埋め込みで他インスタンスが読んだ scene を、選択肢表示直前に反映する (#366)。
      this.reloadReadProgress()
      this.transition.enterChoiceWait()
      // 条件付きロック (#591)。`option.condition` が未定義なら常に false（ロックしない、
      // 既存動作）。指定されていれば `checkFlag` で判定する（未定義/false ならロック）。
      // `resolveEvents` の Condition 判定・GameFlags.check（TUI版）と同じ真偽規則。
      // #652: `debugUnlockAllChoices` が true のときは `option.condition` を見ずに
      // 全 false（全ルート強制解放。TUI版 `Playback.is_option_locked` と対称）。
      const locked = this.computeChoiceLocked(event.Choice.options)
      // 完了(クリア済み)視覚状態 (#594、#596でキーワード改名)。`option.cleared` が未定義
      // なら常に false（完了しない、既存動作）。指定されていれば `checkFlag` で判定する
      // （`locked` と違い真がそのまま完了——真偽判定自体は `[条件:]` と同じ規則）。
      // ロックとは独立配列で持つ。この `cleared` は既読アイコンの唯一の判定材料ではない——
      // ChoiceOverlay.show() 内部で `readSceneProgress`（下で渡す既読 scene 集合）による
      // `alreadyRead` と OR 合成される（#658、`resolveChoiceIconKind`）。
      const cleared = event.Choice.options.map((option) =>
        option.cleared ? this.gameState.checkFlag(option.cleared) : false
      )
      this.choiceOverlay.show(
        event.Choice.options,
        (jump: string): boolean => this.confirmChoiceJump(jump),
        this.choiceStyle,
        this.readSceneProgress,
        event.Choice.columns,
        locked,
        cleared
      )
      return
    }
    if ('Jump' in event) {
      // 無条件ジャンプ (#725)。Choice 確定と同じ `jumpToScene` を呼ぶ（confinement #386・
      // missingSceneResolver による遅延ロード #460 をそのまま再利用）。
      // Choice 到達時と同様、ここまでを読み終えた scene とみなす (#366)。
      this.markCurrentSceneRead()
      // 遷移の予約（pending への移行・次 tick での発火・循環上限）は armJump に集約 (#733)。
      this.armJump(event.Jump.target)
      return
    }
    if ('Wait' in event) {
      // 進行を停止し、指定ミリ秒後に再開（eventIndex のインクリメントはコールバック内で行う）
      // Wait 中もスキップを停止する（Wait を無視するのは仕様違反） (#140)
      this.setSkipMode(false)
      this.transition.enterWait()
      const resume = (): void => {
        this.transition.leaveWait()
        this.cursor.skipDirective()
        this.processUntilNextTextEvent()
        // [待機] 明け後の表示も「立ち絵 →（同時/直後に）テキスト」の順序保証 (#293)。
        // 立ち絵 sprite を同期生成してからスナップショットを記録（afterShow）する。
        this.showCharacterThenRender(() => this.pushSnapshot())
      }
      // 入場（復元の遅延ロードなど）を待っている間に進めると、Jump の予約などで世代が進み、
      // ユーザーのロードが黙って破棄される (#734)。決着を待ち、その間に別の文脈へ移っていたら
      // （復元の成功で待機が解除された等）何もしない。決着した時点でさらに別の入場が始まっていれば
      // （待っていた入場が置き換えられた場合）、その決着も待つ。
      const tryResume = (): void => {
        if (!this.initialized || !this.transition.waitingForWait || this.waitTimer !== null) return
        const entry = this.transition.pendingEntry
        if (entry) {
          void entry.promise.then(tryResume)
          return
        }
        resume()
      }
      this.waitTimer = this.time.setTimeout(() => {
        this.waitTimer = null
        tryResume()
      }, event.Wait.ms)
      return
    }
  }

  private clearWaitDisplayCompleteTimer(): void {
    if (this.waitDisplayCompleteTimer == null) return
    this.time.clearInterval(this.waitDisplayCompleteTimer)
    this.waitDisplayCompleteTimer = null
  }

  private hasPendingVisualTransition(): boolean {
    // `[待機: 表示完了]` の視覚演出集約点。対象は背景 load/fade・立ち絵 load/fade/transform/nudge・
    // イベント絵 load/fade (#351)。将来さらにレイヤを足す場合も、各レイヤの pending API を
    // ここに OR する。
    return (
      this.background.hasPendingBackgroundLoad() ||
      this.background.hasActiveBackgroundFade() ||
      this.characterLayer.hasPendingVisualTransition() ||
      this.eventImageLayer.hasPendingVisualTransition()
    )
  }

  private finishWaitAndContinue(): void {
    if (!this.initialized) return
    this.transition.leaveWait()
    this.cursor.skipDirective()
    this.processUntilNextTextEvent()
    // [待機] 明け後の表示も「立ち絵 →（同時/直後に）テキスト」の順序保証 (#293)。
    // 立ち絵 sprite を同期生成してからスナップショットを記録（afterShow）する。
    this.showCharacterThenRender(() => this.pushSnapshot())
  }

  private beginWaitDisplayComplete(): void {
    this.setSkipMode(false)
    this.transition.enterWait()

    const poll = () => {
      this.background.updateBackgroundFadeFrame()
      if (this.hasPendingVisualTransition()) return
      this.clearWaitDisplayCompleteTimer()
      this.finishWaitAndContinue()
    }

    // processUntilNextTextEvent() がこの directive 呼び出し後に waitingForWait を見て停止するため、
    // たとえ既に落ち着いていても同期完了させず、次 tick の polling で eventIndex を進める。
    if (this.waitDisplayCompleteTimer == null) {
      this.waitDisplayCompleteTimer = this.time.setInterval(poll, 16)
    }
  }

  /**
   * Dialog イベントに立ち絵情報（expression + position）があれば表示する。
   *
   * novel スタイル (#286): protagonist 指定時は立ち絵を役割で左右に振る（質問役=左 / 回答役=右）。
   * さらに直前と異なる話者になったら、その立ち絵をポーズ変化（nudgePose）させて「今この人」を示す。
   * adv / protagonist 未指定では従来配置のまま（後方互換）。
   *
   * 話者交代の検出は Dialog の character で行い、立ち絵 show の有無に依らず lastSpeaker を更新する
   * （立ち絵が無い Dialog でも話者の連続性は追う）。
   */
  /**
   * Dialog の立ち絵を表示する。
   *
   * @param onReady (#293) 立ち絵の用意（テクスチャ load 完了／表示すべき立ち絵が無い場合の即時）が
   *   済んだら呼ばれるフック。呼び出し側（forward novel）はこれを使ってテキスト reveal を
   *   立ち絵の登場に揃える。立ち絵が無い Dialog（expression/position/character 欠落）でも
   *   **必ず1回**発火させ、テキストが詰まらないようにする。
   */
  private showCharacterFromDialog(event: Event, onReady?: () => void): void {
    const textEvt = getTextEvent(event)
    if (!textEvt || textEvt.type !== 'dialog') {
      onReady?.()
      return
    }

    const speaker = textEvt.character
    // 話者交代の検出（novel のみ意味を持つ）。立ち絵表示の前に判定する。
    // 初回（lastSpeaker===null＝場面冒頭/復元直後）は「交代」ではないので nudge しない
    // （何もないところから登場する初出は交代ではない）。
    const speakerChanged =
      speaker !== null && this.lastSpeaker !== null && speaker !== this.lastSpeaker
    if (speaker !== null) this.lastSpeaker = speaker

    if (!textEvt.expression || !textEvt.position || !speaker) {
      // 立ち絵が無い Dialog（ナレ的セリフ等）。待つ対象が無いので即 ready (#293)。
      onReady?.()
      return
    }

    // novel 役割配置 (#286): protagonist と一致 → 質問役=左 / それ以外 → 回答役=右。
    // adv / protagonist 未指定では undefined（脚本 position トークンのまま）。
    const xRatio = this.resolveNovelRoleXRatio(speaker)
    this.characterLayer.show(
      speaker,
      textEvt.expression,
      textEvt.position,
      this.assetBaseUrl,
      // スキップモード中はフェードを抑制（既読シーンの高速進行で違和感を出さない）#177
      // 明示フィット (#294): 脚本の話者行 `フィット` 由来。adv/novel で分岐しない。
      // onReady (#293): 立ち絵テクスチャの用意完了でテキスト reveal を解禁する。
      { instant: this.skipMode, xRatio, fit: textEvt.fit, depth: textEvt.depth, onReady }
    )

    // 話者交代でポーズ変化 (#286)。novel のみ・スキップ中は抑制（高速進行で乱発しない）。
    // #283 の scrim 自動退避に相乗りして「絵を見せる」タイミングと揃える。
    // nudge は既定オフ・opt-in (#382)。`speaker_nudge: true` の作品だけ発火する（未指定/false は非発火）。
    // scrim 退避は「絵を見せる」タイミングとして nudge とは独立に維持する（nudge の有無に関わらず退避する）。
    if (speakerChanged && this.isNovelStyle() && !this.skipMode) {
      if (this.speakerNudge) {
        this.characterLayer.nudgePose(speaker)
      }
      this.screenEffects.retreatNovelScrim()
    }
  }

  /**
   * forward（前進）パスで「背景 → 立ち絵 → テキスト」の順序を保証して描画する (#293/#319)。
   *
   * 問題: テキスト reveal（typewriter）は render() → DialogBox で**同期開始**するのに対し、
   * 立ち絵は CharacterLayer が Assets.load で**非同期に**テクスチャ取得する。そのため呼び出し順は
   * 立ち絵が先でも、見た目は「文字が出てから立ち絵が遅れて出る」順序逆転になっていた。
   *
   * 対策: novel スタイルではまず直前の [背景:] クロスフェード完了を待ち、その後
   * showCharacterFromDialog の onReady（テクスチャ用意完了）まで render() を遅延し、立ち絵がフレームに
   * 乗ってからテキストをタイプし始める。adv / skip 中 / 立ち絵なし Dialog は従来どおり同期描画
   * （onReady は即時発火するため実質ノーディレイ＝非回帰）。
   *
   * 重要: 立ち絵 sprite の生成と `afterShow`（スナップショット記録）は **同期** で済ませる。
   * snapshot は CharacterLayer の現在状態を写すため、立ち絵を出した後・テキスト reveal の前に
   * 撮る必要がある（さもないと goBack/seek の復元で立ち絵が欠ける）。遅延するのは render（テキスト
   * reveal）だけ。演出中間状態は GameState に持ち込まない（規律3）。順序保証は描画駆動のローカルな
   * トークン照合で行い、保留中に eventIndex が進んだ場合は stale な onReady では描画しない。
   *
   * @param afterShow 立ち絵 show 直後・render 前に同期実行するフック（スナップショット記録に使う）
   */
  private showCharacterThenRender(afterShow?: () => void): void {
    if (this.cursor.eventIndex >= this.cursor.resolvedEvents.length) {
      // 立ち絵対象が無い。afterShow（スナップショット）だけ走らせ、render は呼ばない
      // （render() 自体も範囲外では no-op だが、呼ばないことで意図を明確にする）。
      afterShow?.()
      return
    }
    const event = this.cursor.resolvedEvents[this.cursor.eventIndex]
    // adv / skip は同期描画でよい（skip は instant 表示でラグが無く、adv は #293 の対象外＝非回帰）。
    if (!this.isNovelStyle() || this.skipMode) {
      this.showCharacterFromDialog(event)
      afterShow?.()
      this.render()
      return
    }
    // novel forward: 背景フェードと onReady（テクスチャ用意完了）まで render を遅延し、順序を保証する。
    // 保留中に advance 等で表示位置が動いたら stale な発火では描画しない。
    // 設計判断 (Q2): タイムアウトで先に render しない（低速回線で先に出すと #293 で直した
    // 「文字先行→立ち絵後出し」が再発するため。load 失敗は CharacterLayer の `.finally` → onReady で
    // render され「永久に出ない」事故は防止済み）。
    const expectedEventIndex = this.cursor.eventIndex
    const expectedTextIndex = this.cursor.textIndex
    const expectedSentenceIndex = this.cursor.sentenceIndex
    const token = ++this.deferredTextRenderToken
    const isStillCurrent = () =>
      token === this.deferredTextRenderToken &&
      this.cursor.eventIndex === expectedEventIndex &&
      this.cursor.textIndex === expectedTextIndex &&
      this.cursor.sentenceIndex === expectedSentenceIndex
    let rendered = false
    const renderOnce = () => {
      if (rendered) return
      rendered = true
      const run = () => {
        // 保留中に進行した（別イベント/別ページ/別文へ移った／レンダラ破棄）場合は描画しない。
        if (!isStillCurrent()) return
        if (!this.initialized) return
        this.render()
      }
      const runAfterPortraitSettles = () => {
        const startedAt = this.time.now()
        const poll = () => {
          if (!isStillCurrent()) return
          if (!this.initialized) return
          // 立ち絵の fade / nudge / transform、または novel スクリム退避が落ち着くまでは
          // 本文 reveal を始めない。話者交代で立ち絵 show が no-op でも、retreatNovelScrim() は
          // dialogBox.alpha を一時的に下げるため、ここで待たないと数文字だけ出て消える。
          // renderOnly のタイトル演出やカーソル点滅は CharacterLayer 側で除外している。
          if (
            (this.characterLayer.hasActivePortraitTransition() ||
              this.screenEffects.isScrimRetreatActive()) &&
            this.time.now() - startedAt < 6_000
          ) {
            this.time.setTimeout(poll, 16)
            return
          }
          run()
        }
        poll()
      }
      // texture ready 直後に同じタスクで本文 reveal を始めると、ブラウザの最初の paint 前に
      // テキストも乗ってしまい「文字が少し出てから立ち絵が変わる」に見える端末がある。
      // rAF を 2 回待つことで、立ち絵だけの frame を 1 回通し、その後さらに立ち絵の
      // fade / nudge / transform が落ち着いてから本文を開始する。
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => window.requestAnimationFrame(runAfterPortraitSettles))
      } else {
        this.time.setTimeout(runAfterPortraitSettles, 0)
      }
    }
    const showAfterBackgroundSettles = () => {
      const startedAt = this.time.now()
      const poll = () => {
        if (!isStillCurrent()) return
        this.background.updateBackgroundFadeFrame()
        if (
          (this.background.hasPendingBackgroundLoad() ||
            this.background.hasActiveBackgroundFade()) &&
          this.time.now() - startedAt < 6_000
        ) {
          this.time.setTimeout(poll, 16)
          return
        }
        // showCharacterFromDialog は sprite を**同期**生成し（CharacterLayer.show 内）、
        // onReady（renderOnce）は show 経路で必ず1回呼ばれる契約:
        //  - 立ち絵なし Dialog / no-op / 位置のみ変更 / assetBaseUrl 空 → 同期発火（この場で即 render）。
        //  - 新規・表情/フィット変更で texture load → load の settle 後に発火（render を遅延＝順序保証）。
        // Assets.load は必ず settle（resolve/reject）し finally で onReady を呼ぶため、テキストが
        // 永久に出ない事態は起きない。
        // 注意（将来の改変者へ）: 現状この関数の末尾にフォールバックの renderOnce() は無い。将来も
        // 足してはいけない。非同期 load 中に末尾で先に render すると、立ち絵より文字が先に出る
        // 順序逆転（#293 で直した不具合）が再発する。onReady（renderOnce）だけが唯一の render 起点。
        this.showCharacterFromDialog(event, renderOnce)
        // sprite は上の呼び出しで同期生成済み。スナップショットはここで撮る（テキスト reveal の前）。
        afterShow?.()
      }
      poll()
    }
    showAfterBackgroundSettles()
  }

  /**
   * 下地ベタの既定色を設定する (#409)。frontmatter `background_color:` の値（`#rrggbb`）を渡す。
   * `setBackgroundFadeMs`（#407）と対称の per-game 設定で、`NovelPlayer` の init（初回背景表示より前）で
   * 一度呼ばれる。実体は `BackgroundController`（#828 7a）。
   */
  setDefaultBackgroundColor(color: string | null | undefined): void {
    this.background.setDefaultBackgroundColor(color)
  }

  /**
   * SeekBar（シナリオスライダ）のフィル／つまみ色を設定する (#440)。frontmatter `seekbar_color:` の
   * 値（`#rrggbb`）を渡す。`setDefaultBackgroundColor`（#409）と対称の per-game 設定で、`NovelPlayer`
   * の init／prop 変化時に呼ばれる。null/空文字/不正値は `parseColorToNumber` により既定の水色
   * `DEFAULT_BAR_FILL_COLOR` に倒れる。トラック背景色は据え置き。
   */
  setSeekBarColor(color: string | null | undefined): void {
    const num =
      color && color.length > 0
        ? parseColorToNumber(color, DEFAULT_BAR_FILL_COLOR)
        : DEFAULT_BAR_FILL_COLOR
    this.seekBar.setFillColor(num)
    // テロップのアクセント縦線色 (#674) も同じ色解決を共有する（Issue コメント「アクセント色は
    // SeekBar と同じ色解決＝setSeekBarColor で保持している値」）。次回以降の show() だけでなく、
    // 既に表示中の段の縦線も setAccentColor() で即座に描き直す（#674 セルフレビュー Q1）。
    this.telopAccentColorNum = num
    this.telopLayer.setAccentColor(num)
  }

  /**
   * テロップ帯の予約 (#674)。frontmatter `telop_reserve:` の値を渡す。`true` のとき
   * `dialog_style: novel` の本文領域の下端をテロップ帯1段ぶん＋下部丸ボタン行ぶん
   * （`computeTelopBottomReserveHeight`、#677）上げる（`DialogBox.setNovelBottomReserve` 経由）。
   * 改頁行数もこの縮小後の boxH から導かれるため自動で追従する。
   * `false`/未指定は予約なし（テロップは本文の上に半透明で重なる）。
   */
  setTelopReserve(enabled: boolean | null | undefined): void {
    this.telopReserveEnabled = enabled === true
    this.applyTelopReserve()
  }

  /**
   * `telopReserveEnabled` / `telopButtonRowHeightPx` の現在値から `dialogBox.setNovelBottomReserve`
   * を再適用する (#677)。`setTelopReserve`（frontmatter 反映）と
   * `syncTelopBottomMarginToButtons`（表示倍率変化）の両方から呼ばれる。
   */
  private applyTelopReserve(): void {
    const fontSize = this.gameDefaultFontSize ?? NovelRenderer.RUNTIME_DEFAULT_FONT_SIZE
    this.dialogBox.setNovelBottomReserve(
      this.telopReserveEnabled
        ? computeTelopBottomReserveHeight(fontSize, this.telopButtonRowHeightPx)
        : 0
    )
  }

  // --- クイックセーブ / クイックロード (#142) --- 手続きは SaveController (#827)。公開 API の署名はここに残す。

  /** クイックセーブ。保存できない状態なら false（理由は SaveController.quickSave 参照）。 */
  quickSave(): boolean {
    return this.save.quickSave()
  }

  /** シーン入場の自動セーブを要求する (#768)。 */
  requestAutoSave(): void {
    this.save.requestAutoSave()
  }

  /** クイックロード。null はデータ無し／ゲートで弾かれた場合 (#734)。 */
  quickLoad(origin: 'quick' | 'auto' = 'quick'): Promise<SceneEntryResult | null> {
    return this.save.quickLoad(origin)
  }

  /** クイックセーブの flags（データが無ければ null）(#734)。 */
  getQuickSaveFlags(): Record<string, FlagValue> | null {
    return this.save.getQuickSaveFlags()
  }

  /** クイックセーブデータが存在するか。 */
  hasQuickSave(): boolean {
    return this.save.hasQuickSave()
  }

  /**
   * AudioContext を起動する。ユーザー操作（タイトル画面のボタン等）の中で呼ぶ。
   * `NovelPlayerHandle` 経由で `PlayerScreen` が使う（自動進行の動画モードでは他に起動の契機が無い）。
   */
  ensureAudioContext(): void {
    this.audioManager.ensureContext()
  }

  /** クイックセーブデータを消去する (#637)。 */
  clearQuickSave(): void {
    this.save.clearQuickSave()
  }

  /**
   * 指定シーン + 完成済み NovelGameState へ宣言的に復元する共通コア (#256)。
   *
   * loadFromSaveData / startFrom / restoreSnapshot の均質な骨格を集約する:
   * 「フラグ設定 → 選択肢/待機リセット → 入場時 flags での展開 → applyState → history リセット → render」。
   *
   * 呼び出し側の責務:
   * - シーン探索と「見つからない場合の挙動」（no-op か警告か）は呼び出し側が決める。
   * - 復元先の状態（背景/動画/立ち絵/BGM 等）を含む完全な NovelGameState を構築して渡す。
   *   state.flags は this.gameState へ反映される。展開は state.entryFlags（無ければ state.flags で静的に）で行う (#799)。
   *
   * @param scene 復元先シーン（events を rawEvents として保持する）
   * @param state applyState に渡す完成済みの状態スナップショット
   */
  private restoreToScene(scene: EventScene, state: NovelGameState): void {
    this.cursor.markStarted()
    // フラグを設定（置換セマンティクス）。
    // 旧セーブ（entryFlags 無し）の展開が state.flags に依存するため、必ず展開より前に設定する。
    //
    // 注意 (#256): この fromJSON は後段の applyState 内でも同じ state.flags で
    // 再度呼ばれる（goBack/seekTo は applyState を単独で叩くため applyState 側の
    // フラグ復元も必須）。二重適用に見えるが両者は別目的:
    //   - ここ: 展開（下の replaceEvents）より前に flags を確定させるため
    //   - applyState 内: applyState を直接呼ぶ経路のフラグ復元のため
    // 同一値の冪等な fromJSON なので副作用はない。どちらか一方を消すと
    // 展開か直接 applyState 経路のどちらかが壊れるため残す。
    this.gameState.fromJSON(state.flags)

    this.cursor.setCurrentSceneId(state.sceneId)

    // 選択肢/待機状態をリセット
    this.transition.leaveChoiceWait()
    this.transition.leaveWait()
    // 直前の choice 確定による同フレーム advance 抑制フラグも消す
    // （完全リセットなので残留させない）
    this.transition.clearJustSelectedChoice()
    if (this.waitTimer) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    this.clearWaitDisplayCompleteTimer()
    this.choiceOverlay.hide()

    // 元イベントを保持し、Condition をフラグに基づいて展開
    // 展開は入場時 flags（`state.entryFlags`。古いセーブには無く、その場合は保存位置までを `state.flags` で静的展開し後ろは逐次評価）から
    // 1回だけ行い、訪問中は固定する (#799)。
    this.cursor.replaceEvents([...scene.events], entryFromState(state, scene.events))

    // 完成済み NovelGameState を applyState で宣言的に復元
    this.applyState(state)

    // 履歴をリセット（復元後は現在位置のみ）
    this.cursor.resetHistory(this.getSnapshot())

    this.render()
  }

  /**
   * 完成済み NovelGameState スナップショットへ宣言的に復元する (#460)。
   *
   * fluid（`aspect_ratio: auto`）モードで向きカテゴリが変わり NovelPlayer が renderer を
   * 再マウントする際 (#442)、旧 renderer の `getSnapshot()` をそのままこの新 renderer に
   * 渡すことで、読み進め位置（背景/立ち絵/BGM 等の視覚状態込み）を引き継ぐために使う。
   *
   * 復元の入場（`SceneEntryController.enter` の restore）に委譲する薄いラッパー (#734)。シーンの引き当て・遅延ロード・
   * 世代による後勝ち・遷移中のゲート・失敗時の扱い（見つからなければ位置・flags とも変えず warn
   * #765）は入口が担う。結果は Promise で返る（`entered` / `failed` / `superseded`）。
   *
   * 呼び出し側の責務: `allScenes` が構築済み（setEvents/setScenes 呼び出し後）である
   * タイミングで呼ぶこと。
   *
   * #460 再発修正: Gymnasia のような hub(entry doc) + ルート別 md のマルチMD構成では、
   * 再マウント直後の新 renderer の `allScenes` には entry doc のシーンしか無く、ルート側の
   * sceneId（例: `r01-01-terminal-light`）はまだ遅延ロードされていない。入口が
   * `missingSceneResolver` で当該 md を非同期取得してから復元する。
   */
  restoreSnapshot(snapshot: NovelGameState): Promise<SceneEntryResult> {
    // AudioContext 初期化 (#460 セルフレビュー must M1): この renderer は NovelPlayer の
    // マウント effect（ユーザー操作を伴わない非同期コールバック）から生成される新規インスタンスで、
    // ensureContext() が一度も呼ばれていない＝AudioManager.ctx が null のまま。この後
    // restoreToScene → applyState の BGM 復元が audioManager.playBgm() を呼ぶが、playBgm は
    // ctx が無いと即 return するため、何もしないと BGM がサイレントに止まったまま復帰しない。
    // 通常経路（goBack/seekTo/loadFromSaveData）は同一 renderer インスタンス上でユーザー操作
    // （handleAdvance/handleKeyDown 等）を経て既に ensureContext 済みのためこの穴が露呈しない。
    // 注意: ブラウザの自動再生ポリシー上、ユーザー操作を経ていない状態での AudioContext.resume()
    // が実際に有効になるかはブラウザ依存の可能性がある。実機での動作確認が必要。
    this.audioManager.ensureContext()

    return this.entry.enter({ kind: 'restore', state: snapshot, source: 'snapshot' })
  }

  /**
   * 新規開始 (#734, ADR 0003)。文脈を捨てて、ある局面から始める。単一の入口（`SceneEntryController.enter` の fresh）に
   * 委譲する薄いラッパー。`?scene=`・`?debug_scene=`・デバッガガイドの `startFrom` が使う。
   *
   * - `sceneId` を省略すると、エントリ文書の線形ストリームの先頭から始める。
   * - `sceneId` 指定は、そのシーンの events だけを流して末尾で終劇する。`linear: true` を渡したときだけ、
   *   エントリの線形ストリーム上のシーンをストリーム全体で流す（動画書き出しの範囲指定。#817）。
   * - シーンの引き当ては `jumpToScene` と同じ遅延ロードの解決口（`missingSceneResolver`）を通る。
   *   読み込み済みなら同期のまま適用する。未ロードなら入場中ゲートで止めて待つ。
   * - 解決できた後、適用の前に flags を置換（省略時は空）し、`confinedSceneIds` を置き換え（省略時は
   *   解除）、`storyEnded` と `consecutiveJumps` をリセットする。背景・背景板・大道具・幕・立ち絵・BGM は
   *   持ち越さない。history は空から積む（位置を指定したときは `[snapshot]`）。
   * - 解決できなかったとき（不在・resolver 失敗）は状態を一切変えず `failed` を返す。
   * - 位置（`eventIndex` / `textIndex`）の指定は、適用の前に解決したシーンの展開後イベント列に照らして
   *   範囲チェックする。範囲外は状態を変えず `failed`（`out-of-range`）を返す (#789)。`sentenceIndex` は
   *   範囲チェックしない（描画側が現ページの範囲へ寄せる）。
   * - playScript 実行中の呼び出しは想定外（デバッグ API 同士の同時使用は非対応）。
   */
  startFrom(opts: StartFromOptions = {}): Promise<SceneEntryResult> {
    return this.entry.startFrom(opts)
  }

  /**
   * 現在の text イベントを novel スタイルの「文境界改頁ページ」へ分割して返す (#283)。
   *
   * - **派生**であり GameState には持たない（純粋関数 paginateSentencesByLines で再計算可能）。
   * - eventIndex 単位で `novelPagesCache` にキャッシュし、同イベント内の改頁クリックでは再計算しない。
   *
   * 手順:
   *  1. `textEvt.text[]`（複数行）を連結し、ルビ記法を `stripRubyMarkup` で除去した plain text にする。
   *  2. `splitIntoSentences` で文境界に割る（純粋関数）。
   *  3. 各文を現フォントで wordwrap した行数（`DialogBox.measureLineCount`）を測る。
   *  4. `paginateSentencesByLines` で利用可能行数（`DialogBox.novelMaxLinesPerPage`）に貪欲改頁（純粋関数）。
   *     `sentence_per_page: true` (#448) のときは追加で `maxSentencesPerPage=1` を渡し、行数キャップ
   *     （オーバーフロー防止・常時 ON）はそのまま「1 ページ最大 1 文」を重ねる。
   *
   * テキストが空（立ち絵だけの空ダイアログ等）なら 1 ページ（空文字）を返し、従来の空表示を保つ。
   */
  private getNovelPages(textEvt: { text: string[] }): NovelPage[] {
    if (
      this.cursor.novelPagesCache &&
      this.cursor.novelPagesCache.eventIndex === this.cursor.eventIndex
    ) {
      return this.cursor.novelPagesCache.pages
    }
    // 複数 text 行はノベルでは 1 連続本文として扱い、文境界で改めて割る。
    // 改行は stripRubyMarkup 前に空白へ畳んでおく（splitIntoSentences は改行を文内改行として温存
    // するが、ノベルでは元の手動改行ではなく wordwrap に委ねるため空白に正規化する）。
    const joined = textEvt.text.join('\n').replace(/\n+/g, ' ')
    const plain = stripRubyMarkup(joined)
    const sentences = splitIntoSentences(plain)
    let pages: NovelPage[]
    if (sentences.length === 0) {
      pages = [{ text: '', sentences: [], lineCount: 0 }]
    } else {
      const lineCounts = sentences.map((s) => this.dialogBox.measureLineCount(s))
      pages = paginateSentencesByLines(
        sentences,
        lineCounts,
        this.dialogBox.novelMaxLinesPerPage(),
        undefined,
        this.sentencePerPage ? 1 : undefined
      )
      if (pages.length === 0) pages = [{ text: '', sentences: [], lineCount: 0 }]
    }
    this.cursor.cacheNovelPages(pages)
    return pages
  }

  /**
   * 現在の text イベントを adv スタイルの「文単位ページ」へ分割して返す (#448)。
   * `sentence_per_page: true` のときだけ呼ばれる（false なら従来どおり `textEvt.text[]` を直接使う）。
   *
   * `getNovelPages` と違い行数キャップは持たない — 現行 adv はそもそも 1 ページの行数上限・スクロールを
   * 持たず、`DialogBox.setDialog` が wordwrap した結果をそのまま箱に収める（既存のオーバーフロー安全策
   * ＝wordwrap 任せ）。sentence_per_page はページを区切る単位を「markdown 行」から「文」に変えるだけで、
   * 1 文がボックス高さを超える場合の折返しは従来と同じ wordwrap がそのまま処理する（挙動不変）。
   *
   * - **派生**であり GameState には持たない。eventIndex 単位で `advSentencePagesCache` にキャッシュする。
   * - テキストが空なら 1 ページ（空文字）を返し、従来の空表示を保つ。
   *
   * バグ1（ルビ記法の消失・#448 テスト設計で発覚）: 文境界判定（`splitIntoSentences`）は
   * `stripRubyMarkup` 済みの plain text に対して行う必要がある（`》` が SENTENCE_TRAILERS の
   * 1 つのため、ルビ記法混在のままだと文末トレーラとして誤吸収されうる）。しかし `DialogBox.setDialog`
   * に渡す表示テキストはルビ記法を保持したままにしたい（setDialog は自前で `parseRubyText` を呼ぶ設計。
   * novel は元々ルビ非対応＝既存の前例で非回帰だが、adv は従来ルビ対応していたためここだけ新規に
   * 失われる）。`mapSentencesToRubyPreservedText` で plain 文境界をルビ込み原文へマッピングし直す。
   *
   * バグ2（Narration の空白ポーズページ消滅・#448 テスト設計で発覚）: parser.rs の `>` 単独行は
   * `narration_lines.push(String::new())` で意図的な空文字要素を作り、従来 adv（sentence_per_page:false）
   * では「間を置く」空白ページとして機能していた（`["一言目。", "", "二言目。"]` → 3 ページ）。単純に
   * `text[].join('\n').replace(/\n+/g,' ')` すると連続 `\n\n`（空要素由来）が半角スペース 1 個に
   * 潰れて空白ページが消えるため、`text[]` を空文字要素で分割し、各グループを独立に文分割してから
   * グループの間に空文字 1 ページを挿入する。
   */
  private getAdvSentencePages(textEvt: { text: string[] }): string[] {
    if (
      this.cursor.advSentencePagesCache &&
      this.cursor.advSentencePagesCache.eventIndex === this.cursor.eventIndex
    ) {
      return this.cursor.advSentencePagesCache.pages
    }
    const pages: string[] = []
    let group: string[] = []
    const flushGroup = (): void => {
      if (group.length === 0) return
      const joined = group.join('\n').replace(/\n+/g, ' ')
      const plain = stripRubyMarkup(joined)
      const sentences = splitIntoSentences(plain)
      pages.push(...mapSentencesToRubyPreservedText(joined, sentences))
      group = []
    }
    for (const line of textEvt.text) {
      if (line === '') {
        // `>` 単独行由来の空文字要素 (#448 バグ2) = 意図的な空白ポーズページ。
        flushGroup()
        pages.push('')
      } else {
        group.push(line)
      }
    }
    flushGroup()
    if (pages.length === 0) pages.push('')
    this.cursor.cacheAdvSentencePages(pages)
    return pages
  }

  /** 現在の text イベントの総ページ数 (#283)。novel は改頁数、adv は text 行数
   *  （`sentence_per_page: true` のときは adv も文単位ページ数 #448）。 */
  private currentPageCount(textEvt: { text: string[] }): number {
    if (this.isNovelStyle()) return this.getNovelPages(textEvt).length
    if (this.sentencePerPage) return this.getAdvSentencePages(textEvt).length
    return textEvt.text.length
  }

  /**
   * 現在のイベント/テキスト行を画面に反映
   */
  private render(): void {
    if (!this.initialized) return
    if (this.cursor.eventIndex >= this.cursor.resolvedEvents.length) {
      // 空イベント列・終端へ切り替わった後に、直前の本文吹き出しだけが残るのを防ぐ。
      this.dialogBox.clearText()
      this.bubbleLayer.hide()
      this.textDisplayIsBubble = false
      return
    }

    const current = this.cursor.resolvedEvents[this.cursor.eventIndex]
    const textEvt = getTextEvent(current)

    if (!textEvt) {
      this.dialogBox.clearText()
      this.bubbleLayer.hide()
      this.textDisplayIsBubble = false
      return
    }

    // 表示テキスト: adv は text 行をそのまま、novel は文境界改頁ページ (#283/#292)。
    // novel の textIndex は「ページ index」、sentenceIndex は「ページ内の表示済み最後の文 index」。
    // novel は文単位送り (#292): 累積表示テキスト = ページ内 sentences[0..sentenceIndex] の連結。
    const novel = this.isNovelStyle()
    // novel: 現ページの文配列と、現在までの累積テキスト・既出プレフィックス長を算出する。
    let novelPageSentences: string[] = []
    let novelSentenceIndex = 0
    let cumulativeText = ''
    let shownPlainLength = 0
    if (novel) {
      const page = this.getNovelPages(textEvt)[this.cursor.textIndex]
      novelPageSentences = page?.sentences ?? []
      // 文 index を現ページの範囲にクランプ（復元で範囲外を渡されても落とさない・空ページは 0）。
      const maxSentence = Math.max(0, novelPageSentences.length - 1)
      novelSentenceIndex = Math.min(Math.max(0, this.cursor.sentenceIndex), maxSentence)
      cumulativeText = novelPageSentences.slice(0, novelSentenceIndex + 1).join('')
      shownPlainLength = novelPageSentences.slice(0, novelSentenceIndex).join('').length
    }
    // line は scrim 可視判定や（adv の）表示テキストに使う。novel は累積テキスト。
    // adv は sentence_per_page (#448) が有効なら文単位ページ、無効なら従来どおり text[] 行。
    const advLine = this.sentencePerPage
      ? (this.getAdvSentencePages(textEvt)[this.cursor.textIndex] ?? '')
      : (textEvt.text[this.cursor.textIndex] ?? '')
    const line = novel ? cumulativeText : advLine
    const displayIndex = computeDisplayIndex(this.cursor.eventIndex, this.cursor.resolvedEvents)
    const readLineKey = this.cursor.currentSceneId
      ? makeReadLineKey(this.cursor.currentSceneId, displayIndex)
      : null
    if (this.docKey && this.cursor.currentSceneId) {
      migrateLegacyReadProgressForScene(
        this.docKey,
        this.readProgress,
        this.readLineProgress,
        this.cursor.currentSceneId
      )
    }

    // スキップモード処理 (#140): 既読チェックはマーク前に行う
    if (this.skipMode && this.docKey) {
      const alreadyRead = readLineKey
        ? isReadForLine(
            this.readProgress,
            this.readLineProgress,
            this.cursor.currentSceneId,
            displayIndex
          )
        : isRead(this.readProgress, displayIndex)
      if (!alreadyRead) {
        // 未読到達 → スキップ終了（現在の行は表示して待機）
        this.setSkipMode(false)
      } else {
        // 既読 → 即 advance をスケジュール
        this.scheduleSkipStep()
      }
    }

    // 既読マーク (#140): チェック後にマーク（次回以降は既読として扱う）
    if (this.docKey) {
      markRead(this.docKey, this.readProgress, displayIndex)
      if (readLineKey) {
        markReadLine(this.docKey, this.readLineProgress, readLineKey)
      }
    }

    // 空行 = 改ページ（テキストクリア後に次行へ自動進行はしない。空表示する）
    const name = textEvt.type === 'dialog' ? textEvt.character : null

    // per-line voice 再生 (#144): イベント先頭でのみ再生。
    // novel (#292) は文単位送りで render が文ごとに走るため、ページ先頭（textIndex===0）かつ
    // 文先頭（sentenceIndex===0）に限る。adv は従来どおり textIndex===0（最初の text 行）。
    const atEventStart = this.cursor.textIndex === 0 && (!novel || novelSentenceIndex === 0)
    let voicePath: string | null = null
    let perLineFontFamily: string | null = null
    let bubbleStyle: BubbleStyle | null = null
    if (typeof current === 'object' && current !== null) {
      if ('Dialog' in current) {
        if (atEventStart) {
          voicePath = current.Dialog.voice_path ?? null
        }
        perLineFontFamily = current.Dialog.font_family ?? null
        bubbleStyle = this.resolveBubbleStyle(current.Dialog.bubble_style)
      } else if ('Narration' in current) {
        if (atEventStart) {
          voicePath = current.Narration.voice_path ?? null
        }
        perLineFontFamily = current.Narration.font_family ?? null
        bubbleStyle = this.resolveBubbleStyle(current.Narration.bubble_style)
      }
    }

    if (voicePath) {
      const voiceUrl = resolveAssetUrl(this.assetBaseUrl, 'sounds', voicePath)
      // voice は fire-and-forget で再生する。autoAdvance は typing onDone / [待機] が決定する。
      // 以前は voice 終了で scheduleAutoAdvance を呼んでいたが、これだと voice の長さで
      // 中央ホールド時間が伸びてしまい「決まった時間で次へ進む」設計と合わなかった。
      // voice が長くて次イベントが先に来ると stopVoice で切られるが、短句ナレ用途ではOK。
      // #696: ナレーションは音源位置を持たないため従来どおり中央・無加工にする。
      // Dialog だけ既存 #694 の position/depth をシアターモードの音響へ投影する。
      const spatialization =
        typeof current === 'object' && current !== null && 'Dialog' in current
          ? resolveVoiceSpatialization(
              this.stage.cameraMode,
              resolveCharacterXRatio(
                normalizePosition(current.Dialog.position ?? 'center'),
                CHARACTER_X_RATIO
              ),
              current.Dialog.depth ?? 0
            )
          : null
      this.audioManager.playVoice(voiceUrl, undefined, spatialization)
    }

    // フォント解決 (#147): per-line override → per-game default → runtime default の優先順。
    // 優先順チェーンは TitleShow と共通の novelLayout.resolveFontFamily に集約 (#260)。
    const resolvedFontFamily = resolveFontFamily(
      perLineFontFamily,
      this.gameDefaultFontFamily,
      NovelRenderer.RUNTIME_DEFAULT_FONT_FAMILY
    )
    const resolvedFontSize = this.gameDefaultFontSize ?? NovelRenderer.RUNTIME_DEFAULT_FONT_SIZE
    this.currentResolvedFontFamily = resolvedFontFamily
    // フォント未ロードのままで TextStyle に当てると fallback で bake されるため、
    // 非同期ロードしてから DialogBox に反映する。先に既存フォントで描画しておくと
    // 完了後に自然にグリフが置き換わる（pixi v8 は style 差し替えで再 bake する）。
    void ensureFontLoaded(resolvedFontFamily)
      .then(() => {
        // 非同期完了の race ガード (#147 R1 M1): 解決時点の resolvedFontFamily と
        // 「いま表示中の」currentResolvedFontFamily が一致するときだけ適用する。
        // ユーザーが連続 advance してフォント A → B と進んだ場合、A のロード完了で
        // B の表示中に A を上書きしてしまう事故を防ぐ。
        // 文字列比較なので A → A → A の連続は弾かれない（同 family 適用は no-op で害なし）。
        if (this.currentResolvedFontFamily !== resolvedFontFamily) return
        this.dialogBox.setFontFamily(resolvedFontFamily)
      })
      .catch((err) => {
        console.warn('[name-name] フォントロードに失敗', resolvedFontFamily, err)
      })

    // 2窓モード (#444): setBodyTextColor/setDialog 系より前にアクティブ側（自分=下/相手=上）を確定する。
    // dualWindowRegions が未設定（2窓モード無効）なら DialogBox 側で no-op になる。
    if (this.isDualWindowMode()) {
      this.dialogBox.setDualWindowActiveRole(
        this.resolveDualWindowIsSelf(name) ? 'self' : 'opponent'
      )
    }

    // 本文色 (#305 / #444): 話者から決定論的に導出して DialogBox に渡す（主人公=暖アイボリー / 住人=白 /
    // 2窓モードは自分=白・相手=水色）。adv / protagonist 未指定では常に白＝後方互換。
    // setDialog/setNovelDialogProgressive の前に当てる。
    this.dialogBox.setBodyTextColor(this.resolveBodyTextColor(name))

    // オートモード時はタイピング完了後に autoWaitMs 待機してから自動進行 (#139)。
    // voice 有無に関わらず typing onDone で進める (voice は fire-and-forget)。
    const onTypingDone = this.autoMode ? () => this.scheduleAutoAdvance() : null
    if (novel) {
      // novel 文単位送り (#292): 既出の文は即時表示・最後に足した文だけタイプする。
      this.dialogBox.setNovelDialogProgressive(name, cumulativeText, shownPlainLength, onTypingDone)
    } else {
      this.dialogBox.setDialog(name, line, onTypingDone)
    }

    // setDialog が DialogBox を再表示するため、本文を設定してから可視レイヤーを置換する。
    // Event の bubble_style から毎回導くので snapshot/seek/reload に独立した状態を持たない。
    // タイトル画面表示中 (#713): showTitleScreen() が dialogBox.visible = false にしても、
    // エントリスクリプトの自動進行が render() を再度呼ぶとここが無条件で true に戻してしまい
    // タイトルボタンの裏でシナリオ1行目が表示される回帰があった。handleAdvance() 等が使う
    // titleScreenOverlay.visible ガードをここにも適用する。
    const textDisplay = resolveTextDisplay(bubbleStyle, line)
    this.textDisplayIsBubble = textDisplay === 'bubble'
    this.dialogBox.visible = !this.titleScreenOverlay.visible && textDisplay === 'dialogBox'
    if (textDisplay === 'bubble' && bubbleStyle) {
      const dialog =
        typeof current === 'object' && current !== null && 'Dialog' in current
          ? current.Dialog
          : null
      this.bubbleLayer.show({
        style: bubbleStyle,
        text: line,
        visibleCharacterCount: this.dialogBox.getVisibleCharacterCount(),
        xRatio: dialog
          ? resolveCharacterXRatio(
              normalizePosition(dialog.position ?? 'center'),
              CHARACTER_X_RATIO
            )
          : 0.5,
        depth: dialog?.depth ?? 0,
        mode: this.stage.cameraMode,
        orientation: this.stage.cameraOrientation,
        elevation: this.stage.cameraElevation,
        fontFamily: resolvedFontFamily,
        fontSize: resolvedFontSize,
      })
    } else {
      this.bubbleLayer.hide()
    }

    // novel スクリム (#283): セリフが表示されている間だけ半透明黒を敷く。
    // 空ページ（立ち絵だけの空ダイアログ）はテキスト非表示なのでスクリムも出さない。
    const hasVisibleText = line.replace(/[\s\u3000]/g, '') !== ''
    this.screenEffects.updateNovelScrim(hasVisibleText)

    // インジケータ (#292):
    //  - 種別: novel で「現在がそのページの最後の文」なら pageturn（❯・改頁）、それ以外は next（▼・次の文）。
    //    adv は setIndicatorKind を呼ばず既定 next（▼・従来の右下固定）のまま＝非回帰。
    //  - 可視: novel は「最後のページの最後の文」かつ最後のイベントで非表示（それ以上進めない）。
    //    adv は従来どおり「最後のページ（text 行）かつ最後のイベント」で非表示。
    const pageCount = this.currentPageCount(textEvt)
    const isLastPage = this.cursor.textIndex >= pageCount - 1
    const isLastEvent = this.cursor.eventIndex >= this.cursor.resolvedEvents.length - 1
    if (novel) {
      const isLastSentenceOnPage = novelSentenceIndex >= novelPageSentences.length - 1
      this.dialogBox.setIndicatorKind(isLastSentenceOnPage ? 'pageturn' : 'next')
      // 空ページ（立ち絵だけの空ダイアログ）は setNovelDialogProgressive が hide() する。
      // 隠れた箱の上にクリッカーが浮くのを防ぐため、可視テキストが無い novel ページでは
      // インジケータを出さない (#292 セルフレビュー N1)。adv は従来どおりで不変。
      this.dialogBox.setIndicatorVisible(
        hasVisibleText && !(isLastPage && isLastSentenceOnPage && isLastEvent)
      )
    } else {
      this.dialogBox.setIndicatorVisible(!(isLastPage && isLastEvent))
    }

    this.updateCounter()
    this.updateSeekBar()
  }

  private resolveBubbleStyle(value: string | null | undefined): BubbleStyle | null {
    return value === '通常' ||
      value === '静か' ||
      value === '叫び' ||
      value === '内心' ||
      value === 'ナレーション'
      ? value
      : null
  }

  /**
   * スキップモード: 既読行を高速スキップする (#140)。
   * タイプライターをスキップしてから advance() を setTimeout(0) で呼ぶ。
   * Choice / Wait 到達時は processDirective() 内で setSkipMode(false) が呼ばれるため、
   * タイマー発火時に skipMode が false になっており advance() は通常呼び出しになる。
   * sceneId がある場面では `sceneId#displayIndex` を使うため、別 MD / 別 scene の
   * 同じ行番号へ既読が誤爆しない。
   */
  private scheduleSkipStep(): void {
    if (!this.skipMode) return
    if (this.skipTimer) {
      this.time.clearTimeout(this.skipTimer)
    }
    this.skipTimer = this.time.setTimeout(() => {
      this.skipTimer = null
      if (!this.skipMode) return
      // タイプライター中なら全文スキップ（skipTypewriter は onTypingDone を破棄するため
      // オートモードとの二重 advance は起きない）
      if (this.dialogBox.isTyping()) {
        this.dialogBox.skipTypewriter()
      }
      this.advance()
    }, 0)
  }

  /**
   * オートモード: autoWaitMs 後に advance() を呼ぶタイマーをセット (#139)。
   * 選択肢待ち・Wait 待ち中は発動しない。
   */
  private scheduleAutoAdvance(): void {
    if (!this.autoMode) return
    if (this.transition.isGated('autoAdvance')) return
    if (this.autoTimer) {
      this.time.clearTimeout(this.autoTimer)
    }
    this.autoTimer = this.time.setTimeout(() => {
      this.autoTimer = null
      if (this.autoMode && !this.transition.isGated('autoAdvance')) {
        this.advance()
      }
    }, this.autoWaitMs)
  }

  private updateCounter(): void {
    if (!this.counterText) return
    const displayIndex = computeDisplayIndex(this.cursor.eventIndex, this.cursor.resolvedEvents)
    // 表示文字列の整形は novelLayout.formatCounterText に集約 (#260)。
    this.counterText.text = formatCounterText(displayIndex, this.cursor.displayEventCount)
  }

  /**
   * シークバーの表示を更新する。Counter と同じ「テキストイベント表示位置」で動く。
   * (旧実装は history.length - 1 / history.length で常に ratio≈1 になりバーが
   *  満タンに張り付いていた #125)
   */
  private updateSeekBar(): void {
    const displayIndex = computeDisplayIndex(this.cursor.eventIndex, this.cursor.resolvedEvents)
    // 0-based 変換 + クランプは novelLayout.computeSeekBarPosition に集約 (#260)。
    // SeekBar は ratio = current/(total-1) を計算する。
    const { current, total } = computeSeekBarPosition(displayIndex, this.cursor.displayEventCount)
    this.seekBar.update(current, total)
  }

  /**
   * SeekBar からのクリック (テキストイベント表示 index 0-based) を
   * 適切な history index にマップして seekTo する。
   *
   * - 訪問済み (history に対応エントリあり) → そこへ巻き戻し
   * - 未訪問 (前方ジャンプ) → forward-play は未実装なので no-op。
   *   TODO: 将来 visual hint (DialogBox 上の小フラッシュ等) を出して
   *   「無効操作」とユーザーに伝えるか検討する
   */
  private seekToTextEventDisplayIndex(displayIndex: number): void {
    const historyIdx = findHistoryIndexForDisplayIndex(
      displayIndex,
      this.cursor.resolvedEvents,
      this.cursor.history
    )
    if (historyIdx < 0) return
    this.seekTo(historyIdx)
  }
}
