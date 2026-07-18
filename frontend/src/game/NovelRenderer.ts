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

import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text as PixiText,
  Texture,
  TextStyle,
} from 'pixi.js'
import { CharacterLayer, NOVEL_ROLE_X_RATIO } from './CharacterLayer'
import { DialogBox } from './DialogBox'
import { ensureFontLoaded } from './FontLoader'
import { AudioManager } from './AudioManager'
import {
  BackgroundFade,
  GameState,
  NovelGameState,
  StartFromOptions,
  Step,
  resolveEvents,
} from './GameState'
import { buildEdgeFadeMask, normalizeEdgeFade } from './edgeFadeMask'
import { VideoLayer } from './VideoLayer'
import { EventImageLayer } from './EventImageLayer'
import { ChoiceOverlay } from './ChoiceOverlay'
import { SaveManager, SaveSlotData } from './SaveManager'
import { SaveLoadOverlay } from './SaveLoadOverlay'
import { BacklogOverlay } from './BacklogOverlay'
import { SeekBar, DEFAULT_BAR_FILL_COLOR } from './SeekBar'
import { computeDisplayIndex, findHistoryIndexForDisplayIndex } from './seekMapping'
import { isSceneIdConfined } from './sceneConfinement'
import { Event, EventScene } from '../types'
import { ASPECT_RATIOS, type AspectRatio, parseAspectRatio } from './constants'
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
import { computeShakeOffset, computeFlashAlpha, computeFadeAlpha } from './screenEffects'
import {
  clampFadeMs,
  computeCoverFit,
  parseHexColor,
  parseColorToNumber,
  resolveAssetUrl,
  resolveCharacterImageUrls,
  saveSlotToGameState,
  resolveFontFamily,
  formatCounterText,
  computeSeekBarPosition,
  PLAYER_BUTTON_CENTER_FROM_BOTTOM_PX,
  describeEventForDebug,
  findSceneById,
  resolveSceneTitle,
  splitIntoSentences,
  paginateSentencesByLines,
  type NovelPage,
} from './novelLayout'
import { stripRubyMarkup } from './ruby'

/**
 * 立ち絵・背景先読み (#389) のテキストイベント数上限。旧仕様（8）は theo-hayami の実測値
 * （1話あたり Dialog 平均 13.9 件・最大 19 件、`free/` 業×住人セル 296 話計測）が上回っており、
 * 十分な読み込み時間があるにもかかわらず先読みが途中で打ち切られ立ち絵切り替えが遅延する事故を
 * 招いたため撤廃した (#417)。先読みの実質的な境界は「次の分岐（Choice/Condition）または配列末尾
 * まで」のまま変わらない（このループ構造自体は変更していない）。
 *
 * ⚠️ 無制限に安全というわけではない: 現時点で実運用中のゲームは theo-hayami のみのため撤廃の
 * 影響範囲は限定的だが、将来「分岐なしで極端に長い区間」を持つゲームが出た場合は、その時点で
 * 個別に上限を再検討する必要がある。
 */
const PRELOAD_MAX_TEXT_EVENTS = Infinity

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

/** Dialog / Narration から text を取り出すヘルパー */
export function getTextEvent(event: Event):
  | {
      type: 'dialog'
      character: string | null
      expression: string | null
      position: string | null
      text: string[]
      /** 立ち絵の明示フィット指定 (#294)。true のとき loadTexture で旧 fit-down を適用する。 */
      fit: boolean
    }
  | { type: 'narration'; text: string[] }
  | null {
  if (typeof event === 'object' && event !== null) {
    if ('Dialog' in event) {
      return {
        type: 'dialog',
        character: event.Dialog.character,
        expression: event.Dialog.expression,
        position: event.Dialog.position,
        text: event.Dialog.text,
        // 未指定 / false は原寸（fit=false）。明示 boolean に倒す。
        fit: event.Dialog.fit === true,
      }
    }
    if ('Narration' in event) {
      return { type: 'narration', text: event.Narration.text }
    }
  }
  return null
}

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
  events: Event[],
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

/**
 * 各端の生 fade 値（parser / セーブデータ由来）を正規化して BackgroundFade | null を返す (#250)。
 *
 * 実体は #252 で `edgeFadeMask` の共通関数 `normalizeEdgeFade` に切り出した。
 * 既存の import 経路（`NovelRenderer` から）と既存テストを壊さないため、ここに再エクスポートを残す。
 */
export const normalizeBackgroundFade = normalizeEdgeFade

/**
 * 背景の明るさ（brightness）の生値（parser / セーブデータ由来）を 0.0〜1.0 に正規化する。
 *
 * 同一画像をシーン毎に減光する持続プロパティ（「暗いシーンは背景も暗くする」演出用）。
 * - 非数値 / null / undefined / 非有限（NaN/Infinity）→ null（＝原画のまま＝tint 無効）
 * - 1.0 以上（原画と同義）→ null（tint=白 と区別がないため持たない・round-trip 安定）
 * - それ以外は 0.0〜1.0 にクランプして返す（負値は 0.0）
 *
 * parser 側でも同等のクランプ・1.0→None 化を行うが、セーブデータ由来の生値（古い手書き
 * セーブ等）でも安全になるよう、ランタイム側でも防御的に正規化する。
 */
export function normalizeBackgroundBrightness(
  brightness: number | null | undefined
): number | null {
  if (brightness == null || !Number.isFinite(brightness)) return null
  const clamped = Math.min(1, Math.max(0, brightness))
  return clamped < 1 ? clamped : null
}

/**
 * 背景明るさ（brightness、0.0〜1.0）を PixiJS の tint 値（24bit RGB number）に変換する。
 *
 * PixiJS の tint は乗算なので、明るさ b に対し各チャンネルを `round(b*255)` にした
 * グレー値（`rgb(g, g, g)`）を返すと、スプライト全体が b 倍に減光される（b=0.6 で 60%）。
 * null/未指定は 0xffffff（白）＝tint 無効＝原画のまま（後方互換）。
 * 入力は normalizeBackgroundBrightness 済みを想定するが、防御的に再クランプする。
 */
export function brightnessToTint(brightness: number | null | undefined): number {
  if (brightness == null || !Number.isFinite(brightness)) return 0xffffff
  const clamped = Math.min(1, Math.max(0, brightness))
  const g = Math.round(clamped * 255)
  return (g << 16) | (g << 8) | g
}

// playScript / startFrom で使う型を NovelRenderer 経由でも import できるよう再エクスポートする (#220)
export type { Step, StartFromOptions } from './GameState'

/**
 * novel スタイル (#283) のセリフ表示中スクリム不透明度。
 * ToHeart 式に背景・立ち絵を半分ほど沈め、白文字 + DropShadow の可読性を上げる。
 * blink/A-B 実機検証で詰める前提の初期値（テストが参照できるよう export する）。
 */
export const NOVEL_SCRIM_ALPHA = 0.5

/** novel スクリムの自動退避フェード時間（ms）。表情変化・場面転換で絵を見せるための退避/復帰 (#283)。 */
export const NOVEL_SCRIM_RETREAT_MS = 220

/** novel スクリム退避後、絵を見せたまま保持する時間（ms）。退避→ホールド→復帰の中段 (#283)。 */
export const NOVEL_SCRIM_HOLD_MS = 500

/** novel スクリムの通常表示/非表示フェード時間（ms）。ページ送り時の明暗ジャンプを抑える。 */
export const NOVEL_SCRIM_VISIBILITY_FADE_MS = 180

/** 本文を描き始める前に同期的に確保するスクリムの最低 alpha。本文先行の白フラッシュを防ぐ。 */
export const NOVEL_SCRIM_ENTRY_ALPHA_FLOOR = NOVEL_SCRIM_ALPHA * 0.7

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

interface BackgroundEntry {
  sprite: Sprite
  mask: Sprite | null
  fadeAnimation: BackgroundFadeAnimation | null
}

interface BackgroundFadeAnimation {
  startMs: number
  durationMs: number
  fromAlpha: number
  toAlpha: number
  /** true なら fade-out 完了時に sprite/mask を破棄して bgEntries から消す */
  destroyOnComplete: boolean
}

export class NovelRenderer {
  private app: Application
  /** init() 完了済みかのフラグ。React StrictMode 等で init 中に destroy が呼ばれたときの no-op 判定に使う */
  private appInitialized = false
  private dialogBox: DialogBox
  private bgGraphics: Graphics
  private bgContainer: Container
  /** 動画入力レイヤ (#252)。背景の直後・立ち絵の下に配置 */
  private videoLayer: VideoLayer
  private characterLayer: CharacterLayer
  /** イベント絵レイヤー (#351)。テキストより背面・背景/立ち絵より前面（立ち絵の直後）に配置 */
  private eventImageLayer: EventImageLayer
  private blackoutOverlay: Graphics
  /** novel スタイル (#283) の全画面スクリム。セリフ表示中だけ半透明黒を敷く。
   *  z 順は characterLayer の上・blackoutOverlay の下。adv では常に visible=false。 */
  private novelScrim: Graphics | null = null
  private counterText: PixiText | null = null
  private displayEventCount = 0

  /** Condition 展開前の元イベント配列（Flag 変更時の再展開に使用） */
  private rawEvents: Event[] = []
  /** Condition 展開済みのフラットなイベント配列 */
  private resolvedEvents: Event[] = []
  private eventIndex = 0
  private textIndex = 0
  /**
   * novel スタイル (#292) の「現ページ内で表示済みの最後の文 index」（0-based・息継ぎ送り）。
   * adv では未使用（常に 0）。textIndex（ページ index）の下位に位置する進行位置＝ゲーム状態。
   * snapshot / applyState / restoreToScene / セーブ復元で保存・復元する。
   */
  private sentenceIndex = 0

  /** スナップショット履歴スタック（テキストイベント到達ごとに push） */
  private history: NovelGameState[] = []

  private initialized = false
  private onEndCallback: (() => void) | null = null
  /** 動画エクスポート用 (#228)。`jumpToScene` / `setScenes` でシーンが切り替わったときに呼ぶ */
  private onSceneChangeCallback: ((sceneId: string) => void) | null = null
  private missingSceneResolver: ((sceneId: string) => Promise<EventScene[] | null>) | null = null
  private pendingMissingScenes = new Set<string>()
  /**
   * `?scene=` ディープリンク単独埋め込みの confinement（在圏）一覧 (#386)。
   * null なら制限なし（通常のハブ経由フロー）。非 null のときは `jumpToScene` がこの
   * 集合の外への遷移を検出し、通常のシーン遷移ではなく `endStory()`（終劇）にする。
   * `setConfinedSceneIds` で設定する（呼び出し側は `PlayerScreen` が対象 script ファイル
   * 自身の sceneId 一覧を渡す）。
   */
  private confinedSceneIds: string[] | null = null
  /**
   * 終劇状態 (#386)。GameState 上の宣言的フラグ（`NovelGameState.storyEnded`）と対になる
   * 実行時フィールド。true の間は `advance()` が no-op になり（choice/advance は反応しない）、
   * `jumpToScene` も再入しない。goBack/seekTo/セーブ復元は `applyState` 経由でこの値を
   * そのまま反映する（フェード演出は再生しない＝宣言的な瞬時反映）。
   */
  private storyEnded = false
  /** storyEnded 変化を DOM 側（NovelPlayer）に伝える hook (#386)。"to be continued..." 表示用。 */
  private onStoryEndedChangeCallback: ((ended: boolean) => void) | null = null
  private assetBaseUrl: string = ''
  private textureCache: Map<string, Texture> = new Map()
  /**
   * 先読み済みアセット URL の集合 (#389)。`preloadUpcomingAssets` が同一 URL を
   * `Assets.backgroundLoad` に二重に積まないための重複除去。backgroundLoad 自体は冪等だが
   * 無駄呼び出しを避ける。イベント列を差し替える `resetAndStartEvents` でクリアする＝
   * 新しいイベント列では先読み状態も作り直す。`setEvents` は表示済み背景を `Assets.unload`
   * するので、クリアしないと「積み済み」誤判定で先読みがスキップされコールドロードに戻る
   * （エディタのライブプレビュー等で再表示するケース）。`destroy` でもリーク予防にクリアする。
   */
  private preloadedUrls: Set<string> = new Set()
  /** setBackground の非同期ロード用トークン。destroy / 再入 の race 回避に使う */
  private bgLoadToken = 0
  /** 現在表示対象としてロード待ち中の背景 token。本文 reveal の背景待ち判定に使う。 */
  private pendingBackgroundLoadToken: number | null = null
  private audioManager: AudioManager

  /** ゲーム状態（フラグストア）— 章またぎで保持 */
  private gameState: GameState = new GameState()

  /** 選択肢オーバーレイ */
  private choiceOverlay: ChoiceOverlay

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

  /**
   * intermission.md 専用シーン (#404)。`assets/scripts/intermission.md` から取得・parse された
   * イベント列。null（未設定/取得失敗/空）なら endStory() は従来どおりフェードのみで終わり、
   * NovelPlayer 側の DOM "to be continued..." 表示にフォールバックする（完全オプトイン）。
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

  /**
   * novel 改頁キャッシュ (#283)。現在の text イベントを文境界で改頁した結果。
   * これは**派生**（純粋関数 paginateSentencesByLines で再計算可能）であり GameState には持たない。
   * eventIndex が変わったら破棄して再計算する（cacheEventIndex で識別）。
   */
  private novelPagesCache: { eventIndex: number; pages: NovelPage[] } | null = null
  /** #293: 立ち絵 ready 後に本文 reveal を遅延する描画トークン。古い rAF/setTimeout を無効化する。 */
  private deferredTextRenderToken = 0

  /** 直近で render した Dialog/Narration に紐付く resolved font family (#147 R1 M1)。
   *  ensureFontLoaded の Promise 解決時に「いま表示中の Dialog のフォントか」を判定する race guard 用。
   *  別の Dialog に進んだ後に古い family が `setFontFamily` で上書きされる事故を防ぐ。 */
  private currentResolvedFontFamily: string | null = null

  /** 選択肢表示中フラグ */
  private waitingForChoice = false
  /** 選択肢クリック直後の同フレーム advance を抑制するフラグ (#211) */
  private justSelectedChoice = false

  /**
   * SeekBar 操作（タップ/クリックでシーク）直後の同フレーム advance を抑制するフラグ (#350)。
   * SeekBar の clickRegion(Pixi federated) は canvas の DOM pointerdown(handleAdvance) より先に
   * 発火する（Pixi の EventSystem が init() で先に canvas へ listener を張るため）。スライダを
   * 常時タップ可能にした結果、下端帯タップが「シーク＋1つ進む」と二重発火するのを防ぐ
   * （justSelectedChoice と同型の抑制）。 */
  private suppressNextAdvance = false

  /** Wait イベント実行中フラグ */
  private waitingForWait = false

  /** playScript 実行中フラグ（再入ガード用 #220） */
  private isReplaying = false

  /** Wait タイマー（destroy 時キャンセル用）。TimeController 経由なので number */
  private waitTimer: number | null = null
  /** `[待機: 表示完了]` の polling timer。通常 Wait と同じ waitingForWait gate を使う。 */
  private waitDisplayCompleteTimer: number | null = null
  /** タイマー抽象化レイヤー (#228 動画エクスポート対応の土台) */
  private time: TimeController = defaultTimeController

  /** 全シーン情報（シーンジャンプ用） */
  private allScenes: EventScene[] = []

  /** セーブマネージャー */
  private saveManager: SaveManager = new SaveManager()

  /** セーブ/ロードオーバーレイ */
  private saveLoadOverlay!: SaveLoadOverlay

  /** バックログオーバーレイ */
  private backlogOverlay!: BacklogOverlay

  /** シークバー */
  private seekBar: SeekBar

  /** 現在のシーンID */
  private currentSceneId: string | null = null

  /** 現在の背景パス */
  private currentBackgroundPath: string | null = null

  /** 現在の単色地色 (#273)。背景パスと同じ永続状態。なしなら null（既定色＝下地ベタ）。
   *  背景画像とは独立スロット: bgGraphics を塗り直すだけで bgContainer の画像には触れない。 */
  private currentBackgroundColor: string | null = null

  /** 下地ベタ（bgGraphics）の既定色 (#409)。frontmatter `background_color:` の値。
   *  `[背景色:]`（#273）のシーン上書きが無いとき（`currentBackgroundColor === null`）の実塗り色になり、
   *  最初の背景絵がこの色から `background_fade_ms` でフェードインする。null なら黒 0x000000（後方互換）。
   *  `setDefaultBackgroundColor` が init 前後に受けて保持し、上書きが無ければ bgGraphics を塗り直す。 */
  private defaultBackgroundColor: string | null = null

  /** 現在の背景端フェードマスク (#250)。なしなら null */
  private currentBackgroundFade: BackgroundFade | null = null

  /** 現在の背景明るさ（brightness、0.0〜1.0）。同一画像をシーン毎に減光する持続プロパティ。
   *  null/未指定は原画のまま（tint=白）。背景スプライト生成/復元時に tint として乗算適用する。 */
  private currentBackgroundBrightness: number | null = null

  /** 背景 sprite と対応 mask の所有リスト。クロスフェード中は旧 + 新の複数枚になる。 */
  private bgEntries: BackgroundEntry[] = []

  /** 現在の背景に適用中のマスク Sprite (#250)。解放時に破棄する。互換用に最前面 mask を指す */
  private bgMaskSprite: Sprite | null = null

  /** 背景クロスフェード用タイマー。GameState には持たない演出中間状態。 */
  private bgCrossfadeTimer: number | null = null

  /** 現在の BGM パス（スナップショット用） */
  private currentBgmPath: string | null = null

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

  /** SeekBar の縦位置をキャンバス表示倍率に追従させる ResizeObserver (#350)。 */
  private seekBarResizeObserver: ResizeObserver | null = null

  // ---- 画面効果 (#143) ----
  /** flash/fade 用全画面オーバーレイ Graphics */
  private effectOverlay: Graphics | null = null
  /** shake アニメーション用タイマー */
  private shakeTimer: number | null = null
  /** shake 開始時刻（ms） */
  private shakeStartMs: number = 0
  /** flash/fade アニメーション用タイマー */
  private effectTimer: number | null = null

  // ---- novel スクリム自動退避 (#283) ----
  /** スクリム退避フェード中フラグ。true の間は updateNovelScrim が触らない（フェードが制御） */
  private scrimRetreatActive = false
  /** スクリム退避フェード用タイマー */
  private scrimRetreatTimer: number | null = null
  /** スクリム通常表示/非表示フェード用タイマー */
  private scrimVisibilityTimer: number | null = null

  constructor(config?: { dialogBorderless?: boolean; aspectRatio?: AspectRatio }) {
    this.app = new Application()
    this.bgGraphics = new Graphics()
    this.bgContainer = new Container()
    const ratio = parseAspectRatio(config?.aspectRatio)
    this.screenWidth = ASPECT_RATIOS[ratio].width
    this.screenHeight = ASPECT_RATIOS[ratio].height
    this.characterLayer = new CharacterLayer(this.screenWidth, this.screenHeight, this.time)
    // イベント絵レイヤー (#351)。立ち絵と同じ TimeController を共有し、動画 export でも
    // フェードが決定論的に進む（this.time が virtual モードなら仮想時刻で駆動される）。
    this.eventImageLayer = new EventImageLayer(this.screenWidth, this.screenHeight, this.time)
    this.blackoutOverlay = new Graphics()
    this.defaultDialogBorderless = config?.dialogBorderless ?? false
    this.dialogBox = new DialogBox({
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      borderless: this.defaultDialogBorderless,
    })
    this.audioManager = new AudioManager()
    // 動画入力レイヤ (#252)。音声ミックスのため audioManager を注入する。
    this.videoLayer = new VideoLayer(this.screenWidth, this.screenHeight, this.audioManager)
    this.choiceOverlay = new ChoiceOverlay(this.screenWidth, this.screenHeight)
    // 選択肢の確定音／ホバー音を AudioManager で鳴らせるように注入 (#146)
    this.choiceOverlay.setAudioManager(this.audioManager)
    this.saveLoadOverlay = new SaveLoadOverlay(
      this.screenWidth,
      this.screenHeight,
      this.saveManager
    )
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

    // Pixi が init() 内で設定した touch-action:'none' を上書きする (#434)。
    // 詳細な判断根拠は NOVEL_CANVAS_TOUCH_ACTION 定義部のコメント参照。init() 完了直後
    // （Pixi 自身の設定が済んだ後）でなければ上書きしても意味がないため、ここで行う。
    this.setCanvasTouchAction(NOVEL_CANVAS_TOUCH_ACTION)

    container.appendChild(this.app.canvas as HTMLCanvasElement)

    // 下地ベタ（既定色・#409）。frontmatter `background_color:` の既定色（未指定なら黒）で全面を塗る。
    // 最初の背景絵はこの地色の上に alpha 0→1 で重なってフェードインする（コールドスタート）。
    this.bgGraphics.rect(0, 0, this.screenWidth, this.screenHeight)
    this.bgGraphics.fill(this.defaultBackgroundColorNum())
    this.app.stage.addChild(this.bgGraphics)

    // 背景画像コンテナ
    this.app.stage.addChild(this.bgContainer)

    // 動画入力レイヤー (#252)。背景の直後・立ち絵の下に配置（背景の上、キャラの下）。
    this.app.stage.addChild(this.videoLayer)

    // 立ち絵レイヤー
    this.app.stage.addChild(this.characterLayer)

    // イベント絵レイヤー (#351)。z 順はテキストより背面・背景/立ち絵より前面
    // （立ち絵の直後・novelScrim/ダイアログより前）。
    this.app.stage.addChild(this.eventImageLayer)

    // novel スタイルの全画面スクリム (#283)。z 順は立ち絵の上・暗転/効果/ダイアログの下。
    // セリフ表示中だけ半透明黒を敷き、白文字の可読性を上げつつ ToHeart 的な「絵を薄く沈める」
    // 見え方にする。adv では常に非表示。表情変化/場面転換では NovelRenderer がフェード退避する。
    this.novelScrim = new Graphics()
    this.novelScrim.rect(0, 0, this.screenWidth, this.screenHeight)
    this.novelScrim.fill(0x000000)
    this.novelScrim.alpha = 0
    this.novelScrim.visible = false
    this.app.stage.addChild(this.novelScrim)

    // 暗転レイヤー
    this.blackoutOverlay.rect(0, 0, this.screenWidth, this.screenHeight)
    this.blackoutOverlay.fill(0x000000)
    this.setBlackout(false)
    this.app.stage.addChild(this.blackoutOverlay)

    // 画面効果オーバーレイ（#143: flash/fade — blackout より上、dialog より下）
    // fill 色は startFlash/startFade で毎回 clear() → fill(color) し直すため初期値は任意
    this.effectOverlay = new Graphics()
    this.effectOverlay.rect(0, 0, this.screenWidth, this.screenHeight)
    this.effectOverlay.fill(0x000000)
    this.effectOverlay.alpha = 0
    this.effectOverlay.visible = false
    this.app.stage.addChild(this.effectOverlay)

    // ダイアログボックス
    this.app.stage.addChild(this.dialogBox)

    // シークバー（シナリオスライダ）。つまみ中心は下部丸ボタンの中央を貫く高さ (#350)。
    this.seekBar.setOnSeek((displayIndex) => {
      // スライダ操作は「シーク」であって「1つ進む」ではない。同フレームの handleAdvance を抑止する (#350)。
      this.suppressNextAdvance = true
      this.seekToTextEventDisplayIndex(displayIndex)
    })
    // active 変化を React 側へ伝え、丸ボタン行をフェード退避させる (#350)。
    this.seekBar.setOnActiveChange((active) => {
      // 起こすタップ（inactive→active）でも本文を送らないよう、この native pointerdown の後続
      // handleAdvance を 1 回抑止する (#350)。シーク無しの「操作可能化だけ」のタップでも、同フレームの
      // canvas pointerdown で dialogue が進むのを防ぐ（onSeek 経路と同じ suppressNextAdvance を使う）。
      if (active) this.suppressNextAdvance = true
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
      this.syncSeekBarVerticalToButtons()
      if (typeof ResizeObserver !== 'undefined') {
        this.seekBarResizeObserver = new ResizeObserver(() => this.syncSeekBarVerticalToButtons())
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
  getDebugState(): {
    eventIndex: number
    eventCount: number
    eventKind: string
    eventText?: string
    autoMode: boolean
    waitingForChoice: boolean
    waitingForWait: boolean
    currentResolvedFontFamily: string | null
    sceneId: string | null
    audioWarning: string | null
    characters: Array<{
      name: string
      expression: string
      position: string
      x: number
      y: number
      scale: number
    }>
  } {
    const current = this.resolvedEvents[this.eventIndex]
    // イベントから debug HUD 用の {kind, text} を取り出す純粋計算は
    // novelLayout.describeEventForDebug に集約 (#260)。
    const { kind, text } = describeEventForDebug(current)
    const chars = this.characterLayer.getCharacterStates().map((s) => {
      // 私的フィールドへの最小アクセス: x/y/scale をスナップショット
      const inner = this.characterLayer as unknown as {
        characters: Map<string, { sprite: { x: number; y: number; scale: { x: number } } }>
      }
      const st = inner.characters.get(s.name)
      return {
        name: s.name,
        expression: s.expression,
        position: s.position,
        x: st?.sprite.x ?? -1,
        y: st?.sprite.y ?? -1,
        scale: st?.sprite.scale.x ?? -1,
      }
    })
    return {
      eventIndex: this.eventIndex,
      eventCount: this.resolvedEvents.length,
      eventKind: kind,
      eventText: text,
      autoMode: this.autoMode,
      waitingForChoice: this.waitingForChoice,
      waitingForWait: this.waitingForWait,
      currentResolvedFontFamily: this.currentResolvedFontFamily,
      sceneId: this.currentSceneId ?? null,
      audioWarning: this.audioManager.getLastWarning(),
      characters: chars,
    }
  }

  setEvents(events: Event[]): void {
    // PixiJS v8 の Assets.load で取得した Texture は Assets の内部キャッシュに残り続けるため、
    // キャッシュ済みURLを Assets.unload で解放してから textureCache をクリアする
    const urls = Array.from(this.textureCache.keys())
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err) => {
      console.warn('[name-name] テクスチャの解放に失敗', err)
    })
    this.textureCache.clear()
    // イベント絵レイヤーのテクスチャも同じタイミングで解放する (#351 セルフレビュー指摘:
    // 背景と違い textureCache 相当の登録先が無く、GPU テクスチャが解放されずリークしていた)。
    this.eventImageLayer.disposeTextures()
    this.resetAndStartEvents([...events])
  }

  /**
   * 同じ scenario を最初から再開する (texture cache は維持)。
   * 動画モードの「新規開始」直後に AudioContext を起動してから冒頭の voice 付き event を
   * 再走させる用途。setEvents() は texture を Assets.unload するため、render と並行すると
   * Pixi が `Cannot read properties of null (reading 'alphaMode')` で落ちる。restart() は
   * texture を維持するため安全。
   */
  restart(): void {
    if (this.rawEvents.length === 0) return
    this.resetAndStartEvents([...this.rawEvents])
  }

  /**
   * 全シーンを設定して最初のシーンから開始する。
   *
   * 注意 (#284): これは `allScenes`（ジャンプ解決索引）の設定**と同時に**
   * 再生ストリームを `scenes[0].events` だけに差し替える。複数シーンを線形に
   * 連結して自動進行させたい場合は使わないこと（scene1 で停止する）。
   * 線形再生を維持したままジャンプ索引だけを差し替えたいときは
   * `setEvents(flattened)` ＋ `setJumpSceneIndex(scenes)` を使う。
   */
  setScenes(scenes: EventScene[]): void {
    this.allScenes = scenes
    this.gameState.clear()
    if (scenes.length > 0) {
      this.currentSceneId = scenes[0].id
      this.setEvents(scenes[0].events)
      this.onSceneChangeCallback?.(scenes[0].id)
    }
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
    this.allScenes = scenes
  }

  setMissingSceneResolver(
    resolver: ((sceneId: string) => Promise<EventScene[] | null>) | null
  ): void {
    this.missingSceneResolver = resolver
  }

  /**
   * `?scene=` ディープリンク単独埋め込みの confinement（在圏）一覧を設定する (#386)。
   * null（既定）なら制限なし。渡した場合、`jumpToScene` はこの集合の外への遷移を
   * 終劇として扱う（`endStory()`）。通常のハブ経由フロー（`/play/:projectName`）では
   * 呼ばれない、または null を渡す想定。
   */
  setConfinedSceneIds(ids: string[] | null): void {
    this.confinedSceneIds = ids
  }

  /**
   * 指定シーンにジャンプする
   */
  jumpToScene(sceneId: string): void {
    // #386: confinement（在圏）外への choice ジャンプは通常のシーン遷移にせず終劇にする。
    // theo-hayami の hub（別の問いを聞く → hub）等、埋め込み外の内容が漏れるのを防ぐ唯一の
    // choke point。scene の存在チェックより前に判定する（allScenes に実在する hub 等でも
    // 圏外なら即終劇＝lazy load すら試みない）。
    if (!isSceneIdConfined(sceneId, this.confinedSceneIds)) {
      // #386 レビュー Q1（dev 診断のみ・production の挙動/見た目は不変）:
      // fail-closed（圏外は理由を問わず終劇）という設計は維持する。ただし「圏外だが
      // 実在するシーン（例: hub。意図した終劇）」と「原稿の typo でどこにも存在しない
      // sceneId（正常な終劇に偽装された事故）」を区別できないと、typo が気づかれない
      // まま「正常な終劇」として素通りしてしまう。allScenes（entry + 圏内 script の
      // 全シーン）にも見つからない場合だけ、開発時に気づけるよう警告を残す。
      if (import.meta.env.DEV && !findSceneById(this.allScenes, sceneId)) {
        console.warn(
          `[name-name] confinement: sceneId "${sceneId}" は allScenes にも存在しません。終劇として扱いますが、原稿の typo の可能性があります（意図した圏外遷移なら無視してください）。`
        )
      }
      this.endStory()
      return
    }
    const scene = findSceneById(this.allScenes, sceneId)
    if (!scene) {
      if (this.missingSceneResolver) {
        void this.resolveMissingSceneAndJump(sceneId)
      } else {
        console.warn(`[name-name] シーンが見つからない: ${sceneId}`)
      }
      return
    }
    this.startScene(sceneId, scene)
  }

  private startScene(sceneId: string, scene: EventScene): void {
    // #386: 通常のシーン遷移が成立する経路なので、終劇状態は解除しておく（宣言的整合性の保険。
    // 通常はここに来る前に jumpToScene の confinement チェックで弾かれるため storyEnded は
    // 既に false のはずだが、デバッグ等から直接呼ばれた場合の保険として明示的に戻す）。
    if (this.storyEnded) {
      this.storyEnded = false
      this.onStoryEndedChangeCallback?.(false)
    }
    this.currentSceneId = sceneId
    this.resetAndStartEvents([...scene.events], { preserveBackgroundForTransition: true })
    this.onSceneChangeCallback?.(sceneId)
  }

  private async resolveMissingSceneAndJump(sceneId: string): Promise<void> {
    if (!this.missingSceneResolver || this.pendingMissingScenes.has(sceneId)) return
    this.pendingMissingScenes.add(sceneId)
    try {
      const scenes = await this.missingSceneResolver(sceneId)
      if (!scenes) return
      this.setJumpSceneIndex(scenes)
      const scene = findSceneById(this.allScenes, sceneId)
      if (!scene) {
        console.warn(`[name-name] lazy load 後もシーンが見つかりません: ${sceneId}`)
        return
      }
      this.startScene(sceneId, scene)
    } catch (err) {
      console.warn(`[name-name] シーンの追加読み込みに失敗しました: ${sceneId}`, err)
    } finally {
      this.pendingMissingScenes.delete(sceneId)
    }
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
    this.waitingForChoice = false
    this.choiceOverlay.hide()
    this.dialogBox.clearText()

    // 画面効果の後始末 (#386 レビュー S1)。Shake/Flash/Fade は fire-and-forget なので、
    // これらを仕込んだ直後の text から confinement 外への choice が続くと、そのタイマーが
    // endStory() 後も生き続けて "to be continued..." 画面に効果（Fade の色かぶり等）が
    // 残ってしまう。applyState() の画面効果リセットブロックと同じロジックをそのまま流用する。
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    this.app.stage.position.set(0, 0)
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    if (this.effectOverlay) {
      this.effectOverlay.alpha = 0
      this.effectOverlay.visible = false
    }

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

    // 宣言的な終端状態を即座に確定する（背景/色地/動画/立ち絵はすべて「なし」）。
    // 見た目のフェードはこの下で別途アニメさせるが、GameState としては最初からこの値。
    this.currentBackgroundPath = null
    this.currentBackgroundFade = null
    this.currentBackgroundBrightness = null
    this.bgLoadToken++
    this.pendingBackgroundLoadToken = null
    this.clearBackgroundColor()
    this.videoLayer.remove()
    // イベント絵レイヤーも終劇で「なし」に確定する (#351)。back=Hide で背景・立ち絵を隠したまま
    // 終劇していると、可視性を戻さない限り以後（intermission タブロー等）ずっと隠れたままになる。
    this.eventImageLayer.remove()
    this.applyEventImageVisibility()

    // 見た目のフェード演出（既存の背景クロスフェード / 立ち絵退場フェードの仕組みをそのまま流用）。
    this.fadeOutBackgroundEntries(eraseBackgroundFadeMs)
    this.characterLayer.clearForSceneTransition(eraseCharacterFadeMs)

    // #404: onStoryEndedChangeCallback の発火位置・タイミングは変更しない（postMessage 契約の正本）。
    this.onStoryEndedChangeCallback?.(true)

    // intermission.md 専用シーン (#404): 消去フェードが終わった後にタブローを1回だけ描画して
    // 凍結する。通常のシーン遷移機構（resetAndStartEvents/jumpToScene）には一切乗せない —
    // resetAndStartEvents は背景を finishBackgroundCrossfadeInstant() で瞬間消去する別経路であり、
    // ここに乗せると「幕がゆっくり降りる」演出がフェード無しの瞬間消去に負けて台無しになる。
    if (this.intermissionEvents) {
      const events = this.intermissionEvents
      if (this.intermissionTimer) this.time.clearTimeout(this.intermissionTimer)
      const delayMs = Math.max(eraseBackgroundFadeMs, this.intermissionCharacterFadeMs)
      this.intermissionTimer = this.time.setTimeout(() => {
        this.intermissionTimer = null
        // goBack/seekTo で storyEnded が解除されていたら描画しない（applyState 側でも
        // このタイマーをキャンセルするが、二重の安全策として storyEnded も確認する）。
        if (!this.initialized || !this.storyEnded) return
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
   * - Choice/WaitDisplayComplete/Flag は resolvedEvents/eventIndex を前提にする（Choice）か
   *   `NovelGameState` を恒久的に書き換える（Flag → `gameState.setFlag` + `reResolveEvents`）かのいずれかで、
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
        if (textEvt) {
          const name = textEvt.type === 'dialog' ? textEvt.character : null
          const text = textEvt.text.join('\n')
          const hasVisibleText = text.replace(/[\s\u3000]/g, '') !== ''
          // novel は本文より先に最低限の黒みを用意する。本文先行の白フラッシュを避けるため。
          if (this.isNovelStyle() && hasVisibleText) this.updateNovelScrim(true)
          this.dialogBox.setBodyTextColor(this.resolveBodyTextColor(name))
          if (this.isNovelStyle()) {
            this.dialogBox.setNovelDialogProgressive(name, text, 0, null)
          } else {
            this.dialogBox.setDialog(name, text)
          }
          this.dialogBox.skipTypewriter()
          // novel スクリムはセリフが表示されている間だけ敷く。render() と同じ判定を流用する。
          if (!this.isNovelStyle() || !hasVisibleText) this.updateNovelScrim(hasVisibleText)
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
          (typeof event === 'object' && event !== null && ('Choice' in event || 'Flag' in event))
        ) {
          if (import.meta.env.DEV) {
            console.warn(
              '[name-name] intermission.md: Choice/[待機: 表示完了]/Flag は静止画タブローでは無視されます'
            )
          }
          continue
        }
        this.processDirective(event)
      }
    } finally {
      this.eventImageFadeMs = previousEventImageFadeMs
    }
  }

  /**
   * 複数の背景 entry に「alpha 0 へフェードアウト → 完了後に破棄」の fadeAnimation を
   * 一括で仕込む (#386 セルフレビュー nit)。`crossfadeToBackgroundEntry`（次背景を追加する
   * クロスフェード）と `fadeOutBackgroundEntries`（次背景を追加しない終劇演出）の両方が
   * 「旧背景を消す」部分としてこの手続きを共有する（重複実装の解消）。
   */
  private beginFadeOutEntries(
    entries: BackgroundEntry[],
    startMs: number,
    durationMs: number
  ): void {
    for (const entry of entries) {
      entry.fadeAnimation = {
        startMs,
        durationMs,
        fromAlpha: entry.sprite.alpha,
        toAlpha: 0,
        destroyOnComplete: true,
      }
    }
  }

  /**
   * 現在の背景画像 entry 群をフェードアウトさせる (#386 終劇演出)。
   * `crossfadeToBackgroundEntry` の「旧背景を消す」半分だけを取り出した形（次背景を
   * 追加しない）。完了後は `updateBackgroundFadeFrame` の `destroyOnComplete` で自動的に
   * 破棄される。ステージ最背面の `bgGraphics` は endStory 側の `clearBackgroundColor()` で
   * 先に下地ベタの既定色（`background_color:` #409。未指定なら黒）へリセット済みのため、
   * フェード完了後は自然にその地色が残る。
   */
  private fadeOutBackgroundEntries(durationMs: number): void {
    if (this.bgEntries.length === 0) return
    this.stopBackgroundCrossfade()
    const startMs = this.time.now()
    this.beginFadeOutEntries(this.bgEntries, startMs, durationMs)
    this.updateBackgroundFadeFrame()
    this.ensureBackgroundCrossfadeTicker()
  }

  /** 現在表示中のシーンID (#228 動画エクスポート用) */
  getCurrentSceneId(): string | null {
    return this.currentSceneId
  }

  /** 登録済みシーンIDの一覧（順序保持）(#228 動画エクスポート UI 用) */
  getAllSceneIds(): string[] {
    return this.allScenes.map((s) => s.id)
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
  }

  /**
   * 動画 export 用に動画レイヤを頭出しする (#252)。
   * 録画開始（recorder.start）の前に呼び、表示中の動画を currentTime=0 へ seek して
   * ready を待ってから再生し直す。これで録画の先頭から動画が正しく映る/鳴る。
   * 動画が無ければ即解決。
   */
  async prepareVideosForExport(): Promise<void> {
    await this.videoLayer.prepareForExport()
  }

  /**
   * 動画書き出しの開始/終了をレンダラに通知する (#350)。
   * 現状は SeekBar を抑制（非表示）して録画にスライダが焼き込まれないようにするだけだが、
   * 将来ほかの UI（HUD 等）も書き出し中に退避させたくなったらここにぶら下げる薄い 1 メソッド。
   * VideoExporter が録画開始で true / 終了（cleanup・例外時を含む）で false を必ず呼ぶ。
   */
  setExporting(exporting: boolean): void {
    this.seekBar.setExportSuppressed(exporting)
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
    options?: { preserveBackgroundForTransition?: boolean }
  ): void {
    this.waitingForChoice = false
    this.waitingForWait = false
    if (this.waitTimer) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    this.clearWaitDisplayCompleteTimer()
    // intermission タブロー描画の遅延タイマーをキャンセルする (#404)。restart()/jumpToScene で
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
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    if (this.effectOverlay) {
      this.effectOverlay.alpha = 0
      this.effectOverlay.visible = false
    }
    this.choiceOverlay.hide()
    this.audioManager.stopBgm(0)
    if (options?.preserveBackgroundForTransition) {
      this.bgLoadToken++
      this.pendingBackgroundLoadToken = null
      this.finishBackgroundCrossfadeInstant()
      this.videoLayer.remove()
    } else {
      this.clearBackground()
    }
    if (options?.preserveBackgroundForTransition) {
      this.characterLayer.clearForSceneTransition()
    } else {
      this.characterLayer.clear()
    }
    // イベント絵レイヤーは新しいイベント列の開始で常にクリアする (#351)。前シーンのイベント絵は
    // 引き継がない（両分岐共通）。back=Hide で隠れていた背景・立ち絵の可視性もここで戻す。
    this.eventImageLayer.remove()
    this.applyEventImageVisibility()
    this.setBlackout(false)
    this.currentBgmPath = null
    // シーン遷移時にダイアログを明示的にクリアする（前シーンの残留テキスト防止 #217）
    this.dialogBox.clearText()
    // per-scene [枠なし]/[枠あり] はシーン遷移でデフォルト値にリセット
    this.dialogBox.setBorderless(this.defaultDialogBorderless)
    // novel (#283): setBorderless が borderless を上書きしたので novel 幾何を再適用し、
    // スクリム退避状態と alpha をリセットする（前シーンの退避途中が残らないようにする）。
    this.resetNovelScrimState()
    this.dialogBox.setNovelMode(this.isNovelStyle())

    // 元イベントを保持し、Condition をフラグに基づいて展開
    this.rawEvents = events
    this.resolvedEvents = resolveEvents(events, this.gameState)
    this.eventIndex = 0
    this.textIndex = 0
    this.sentenceIndex = 0
    this.history = []
    // novel 改頁キャッシュ (#283) はイベント列に紐づくので破棄する。
    this.novelPagesCache = null
    // 先読み済み URL 集合 (#389) もイベント列に紐づくので破棄する。setEvents は表示済み背景を
    // Assets.unload するため、ここでクリアしないと「積み済み」誤判定で先読みがスキップされ
    // コールドロードに戻る。新しいイベント列＝先読み状態も作り直すのが正しい（末尾の
    // processUntilNextTextEvent → preloadUpcomingAssets が先頭から積み直す）。
    this.preloadedUrls.clear()
    // 話者交代追跡 (#286) をリセット（前シーン末尾の話者を引きずらない）。
    // resetAndStartEvents 直後の最初の Dialog で初めて話者がセットされ、初回は nudge しない
    // （何もないところから登場する初回は「交代」ではない）。
    this.lastSpeaker = null
    this.displayEventCount = this.resolvedEvents.filter((e) => getTextEvent(e) !== null).length
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
   */
  setProtagonist(name: string | null | undefined): void {
    this.protagonist = name && name.length > 0 ? name : null
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

  /**
   * intermission.md 専用シーンを設定する (#404)。
   *
   * `events` は `assets/scripts/intermission.md` を parseMarkdown した EventDocument から
   * flatten した Event 列（呼び出し側 = PlayerScreen の責務）。null/undefined/空配列は
   * 「未設定」として扱い、endStory() は従来どおりフェードのみで終わる（NovelPlayer の DOM
   * "to be continued..." 表示にフォールバック。完全後方互換・オプトイン）。
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
   * NovelPlayer が DOM 側 "to be continued..." 表示（フェーズ1）を出すかどうかの判定に使う
   * （intermission シーン設定時は PixiJS 側のタブローに一本化し、二重表示を避ける）。
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
   * 現在の話者から本文色を決定論的に導出する (#305)。
   *  - adv / protagonist 未指定 / 話者不明 → 住人色（純白）。色差しない（後方互換）。
   *  - novel かつ話者が protagonist と一致 → 主人公本文色（既定 #FFF0D8）。
   *  - それ以外（novel の住人）→ 住人色（純白）。
   * 演出中間状態でなく per-line の描画属性なので、render() の都度ここで導出して DialogBox に渡す。
   */
  private resolveBodyTextColor(speaker: string | null): number {
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
    if (!novel && this.novelScrim) {
      // adv ではスクリムを常に消す。
      this.setNovelScrimImmediate(false, 0)
    }
    // 改頁は幾何（boxH）依存なので、スタイル切替で派生キャッシュを破棄する (#283)。
    this.novelPagesCache = null
    // 既にテキスト表示中なら新スタイルで描き直す（adv↔novel 切替が即反映される）。
    if (this.initialized && this.eventIndex < this.resolvedEvents.length) {
      this.render()
    }
  }

  /**
   * novel スクリムの表示状態を「セリフ表示中か」に合わせて更新する (#283)。
   * adv では no-op。退避フェード中（scrimRetreatActive）は触らない（フェードが制御する）。
   * 通常のページ/イベント送りでは短くフェードさせ、立ち絵切替時の明暗ジャンプを抑える。
   */
  private updateNovelScrim(visibleForDialog: boolean): void {
    if (!this.novelScrim) return
    if (!this.isNovelStyle()) {
      this.setNovelScrimImmediate(false, 0)
      return
    }
    if (this.scrimRetreatActive) return
    this.startNovelScrimVisibilityFade(visibleForDialog)
  }

  private cancelNovelScrimVisibilityFade(): void {
    if (!this.scrimVisibilityTimer) return
    this.time.clearInterval(this.scrimVisibilityTimer)
    this.scrimVisibilityTimer = null
  }

  private startNovelScrimVisibilityFade(visibleForDialog: boolean): void {
    if (!this.novelScrim) return
    this.cancelNovelScrimVisibilityFade()
    const targetAlpha = visibleForDialog ? NOVEL_SCRIM_ALPHA : 0
    const currentAlpha = this.novelScrim.visible ? this.novelScrim.alpha : 0
    const fromAlpha = visibleForDialog
      ? Math.max(currentAlpha, NOVEL_SCRIM_ENTRY_ALPHA_FLOOR)
      : currentAlpha
    if (fromAlpha === targetAlpha) {
      this.novelScrim.visible = visibleForDialog
      this.novelScrim.alpha = targetAlpha
      return
    }
    this.novelScrim.visible = true
    this.novelScrim.alpha = fromAlpha
    const durationMs = NOVEL_SCRIM_VISIBILITY_FADE_MS
    const startedAt = this.time.now()
    const tick = () => {
      if (!this.novelScrim) return
      const elapsed = this.time.now() - startedAt
      const { alpha, done } = computeFadeAlpha(elapsed, fromAlpha, targetAlpha, durationMs)
      this.novelScrim.alpha = alpha
      if (!done) return
      this.novelScrim.alpha = targetAlpha
      this.novelScrim.visible = visibleForDialog
      this.cancelNovelScrimVisibilityFade()
    }
    tick()
    if (!this.scrimVisibilityTimer) {
      this.scrimVisibilityTimer = this.time.setInterval(tick, 1000 / 60)
    }
  }

  private setNovelScrimImmediate(visible: boolean, alpha: number): void {
    if (!this.novelScrim) return
    this.cancelNovelScrimVisibilityFade()
    this.novelScrim.visible = visible
    this.novelScrim.alpha = alpha
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
    } else if (!this.waitingForChoice && !this.waitingForWait && !this.isAtScriptEnd()) {
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
    if (this.resolvedEvents.length === 0) return true
    if (this.eventIndex >= this.resolvedEvents.length) return true
    const current = this.resolvedEvents[this.eventIndex]
    const textEvt = getTextEvent(current)
    if (!textEvt) return false
    const isLastEvent = this.eventIndex >= this.resolvedEvents.length - 1
    if (!isLastEvent) return false
    const pageCount = this.currentPageCount(textEvt)
    const isLastPage = this.textIndex >= pageCount - 1
    if (!isLastPage) return false
    if (this.isNovelStyle()) {
      const page = this.getNovelPages(textEvt)[this.textIndex]
      const sentenceCount = page?.sentences.length ?? 0
      // render() の novelSentenceIndex のような clamp はせず raw sentenceIndex を使う。
      // over-range（復元等で範囲外）でも `>=` で "末尾扱い" に倒れ、即時オートを抑止する安全方向。
      const isLastSentenceOnPage = this.sentenceIndex >= sentenceCount - 1
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
   */
  setDocKey(docKey: string): void {
    this.docKey = docKey
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
    if (!this.docKey || !this.currentSceneId) return
    markReadScene(this.docKey, this.readSceneProgress, this.currentSceneId)
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
      this.finishBackgroundCrossfadeInstant()
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

  /** 終劇状態の変化コールバックを登録する (#386)。NovelPlayer が "to be continued..." の
   *  DOM 表示に繋ぐ（setOnAutoModeChange 等と同じ配線パターン）。 */
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
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    if (this.scrimRetreatTimer) {
      this.time.clearInterval(this.scrimRetreatTimer)
      this.scrimRetreatTimer = null
    }
    this.cancelNovelScrimVisibilityFade()
    // 動画レイヤを破棄（video 要素解放・AudioManager から detach・Sprite/Texture/mask 破棄）(#252)。
    // audioManager.destroy() より前に呼んで detach を確実に通す。
    this.videoLayer.remove()
    // イベント絵レイヤーも破棄する（sprite/texture 参照を解放）(#351)。
    this.eventImageLayer.remove()
    // イベント絵レイヤーが読み込んだテクスチャも解放する (#351 セルフレビュー指摘。
    // setEvents() と同じ理由: textureCache 相当の登録先が無いと GPU テクスチャがリークする)。
    this.eventImageLayer.disposeTextures()
    this.audioManager.destroy()
    this.characterLayer.clear()
    this.choiceOverlay.hide()
    this.saveLoadOverlay.hide()
    this.backlogOverlay.hide()
    this.dialogBox.dispose()
    // GPU テクスチャのリーク防止: Assets.unload で内部キャッシュから解放
    const urls = Array.from(this.textureCache.keys())
    Promise.all(urls.map((u) => Assets.unload(u))).catch((err) => {
      console.warn('[name-name] テクスチャの解放に失敗', err)
    })
    this.textureCache.clear()
    // 先読み済み URL 集合もクリアする（リーク予防・#389）。
    this.preloadedUrls.clear()
    // canvas 由来マスクテクスチャを含む背景 entry を全て解放する (#250/#319)
    this.clearBackgroundEntries()
    this.app.destroy(true, { children: true })
    this.initialized = false
  }

  // ---- 画面効果メソッド (#143) ----
  // 16進カラーパース parseHexColor は novelLayout に切り出した (#260)

  /**
   * 画面シェイク演出 (#143)。
   * sin 波ベースの決定論的な揺れ。stage の position を直接動かして実現する。
   */
  private startShake(intensityPx: number, durationMs: number): void {
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    this.shakeStartMs = performance.now()

    const FPS = 60
    const intervalMs = 1000 / FPS

    const tick = (): void => {
      const elapsed = performance.now() - this.shakeStartMs
      // 減衰 sin/cos 揺れの数式は screenEffects.computeShakeOffset に集約 (#260)
      const { offsetX, offsetY, done } = computeShakeOffset(elapsed, intensityPx, durationMs)
      this.app.stage.position.set(offsetX, offsetY)

      if (!done) {
        this.shakeTimer = this.time.setTimeout(tick, intervalMs)
      } else {
        this.app.stage.position.set(0, 0)
        this.shakeTimer = null
      }
    }
    tick()
  }

  /**
   * フラッシュ演出 (#143)。
   * effectOverlay を指定色で alpha ピーク → 0 にフェードアウトする。
   */
  private startFlash(colorHex: string, peakAlpha: number, durationMs: number): void {
    if (!this.effectOverlay) return
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }

    const color = parseHexColor(colorHex)
    this.effectOverlay.clear()
    this.effectOverlay.rect(0, 0, this.screenWidth, this.screenHeight)
    this.effectOverlay.fill(color)
    this.effectOverlay.alpha = peakAlpha
    this.effectOverlay.visible = true

    const startMs = performance.now()
    const FPS = 60
    const intervalMs = 1000 / FPS

    this.effectTimer = this.time.setInterval(() => {
      const elapsed = performance.now() - startMs
      if (!this.effectOverlay) return
      // alpha 補間は screenEffects.computeFlashAlpha に集約 (#260)
      const { alpha, done } = computeFlashAlpha(elapsed, peakAlpha, durationMs)
      this.effectOverlay.alpha = alpha
      if (done) {
        this.effectOverlay.visible = false
        this.effectOverlay.alpha = 0
        if (this.effectTimer) {
          this.time.clearInterval(this.effectTimer)
          this.effectTimer = null
        }
      }
    }, intervalMs)
  }

  /**
   * フェード演出 (#143)。
   * effectOverlay を指定色・指定アルファ範囲で補間する。
   * target: "bg"（背景のみ）は将来拡張。現状は "all" と同じ全画面オーバーレイ。
   */
  private startFade(
    _target: string,
    colorHex: string,
    fromAlpha: number,
    toAlpha: number,
    durationMs: number
  ): void {
    if (!this.effectOverlay) return
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }

    const color = parseHexColor(colorHex)
    this.effectOverlay.clear()
    this.effectOverlay.rect(0, 0, this.screenWidth, this.screenHeight)
    this.effectOverlay.fill(color)
    this.effectOverlay.alpha = fromAlpha
    this.effectOverlay.visible = true

    const startMs = performance.now()
    const FPS = 60
    const intervalMs = 1000 / FPS

    this.effectTimer = this.time.setInterval(() => {
      const elapsed = performance.now() - startMs
      if (!this.effectOverlay) return
      // alpha 補間は screenEffects.computeFadeAlpha に集約 (#260)。
      // done 時に alpha=toAlpha ちょうどを返すので、従来の「progress>=1 で toAlpha を当て直す」挙動と一致。
      const { alpha, done } = computeFadeAlpha(elapsed, fromAlpha, toAlpha, durationMs)
      this.effectOverlay.alpha = alpha
      if (done) {
        // toAlpha が 0 なら不可視に戻す
        if (toAlpha <= 0) {
          this.effectOverlay.visible = false
        }
        if (this.effectTimer) {
          this.time.clearInterval(this.effectTimer)
          this.effectTimer = null
        }
      }
    }, intervalMs)
  }

  /**
   * novel スクリム退避の途中状態をリセットする (#283)。
   * シーン遷移・状態復元・破棄で退避フェードのタイマーを止め、文字 alpha を元に戻す。
   * 退避中間状態（フェード途中）は GameState に持たないため、復元では「退避していない」前提に倒す。
   */
  private resetNovelScrimState(): void {
    this.cancelNovelScrimVisibilityFade()
    if (this.scrimRetreatTimer) {
      this.time.clearInterval(this.scrimRetreatTimer)
      this.scrimRetreatTimer = null
    }
    this.scrimRetreatActive = false
    this.dialogBox.alpha = 1
    this.setNovelScrimImmediate(false, 0)
  }

  /**
   * novel スクリム自動退避 (#283)。
   *
   * 表情変化 / 場面転換のとき、スクリム（とその上の白文字）を一旦 α→0 へ滑らかに退避して
   * 絵を見せ、`holdMs` 後に元の不透明度へ戻す。エンジン自動（作者は記述不要）。
   * adv では no-op。セリフ非表示中（スクリムが既に消えている）も no-op。
   *
   * 退避中は `scrimRetreatActive=true` にして updateNovelScrim が触らないようにする。
   * フェード計算は screenEffects.computeFadeAlpha を流用（演出中間状態は GameState に持たない）。
   */
  private retreatNovelScrim(holdMs = NOVEL_SCRIM_HOLD_MS): void {
    if (!this.isNovelStyle() || !this.novelScrim) return
    // セリフが表示されておらずスクリムが既に消えているなら退避不要。
    if (!this.novelScrim.visible || this.novelScrim.alpha <= 0) return

    this.cancelNovelScrimVisibilityFade()
    if (this.scrimRetreatTimer) {
      this.time.clearInterval(this.scrimRetreatTimer)
      this.scrimRetreatTimer = null
    }
    this.scrimRetreatActive = true
    const text = this.dialogBox
    const FPS = 60
    const intervalMs = 1000 / FPS
    const durationMs = NOVEL_SCRIM_RETREAT_MS

    // フェーズ: 0 = 退避(α: ALPHA→0)、1 = ホールド、2 = 復帰(α: 0→ALPHA)
    let phase: 0 | 1 | 2 = 0
    let phaseStart = performance.now()

    this.scrimRetreatTimer = this.time.setInterval(() => {
      if (!this.novelScrim) return
      const elapsed = performance.now() - phaseStart
      if (phase === 0) {
        const { alpha, done } = computeFadeAlpha(elapsed, NOVEL_SCRIM_ALPHA, 0, durationMs)
        this.novelScrim.alpha = alpha
        text.alpha = 1 - (NOVEL_SCRIM_ALPHA - alpha) / NOVEL_SCRIM_ALPHA // 文字も一緒に退避
        if (done) {
          this.novelScrim.alpha = 0
          text.alpha = 0
          phase = 1
          phaseStart = performance.now()
        }
      } else if (phase === 1) {
        if (elapsed >= holdMs) {
          phase = 2
          phaseStart = performance.now()
        }
      } else {
        const { alpha, done } = computeFadeAlpha(elapsed, 0, NOVEL_SCRIM_ALPHA, durationMs)
        this.novelScrim.alpha = alpha
        text.alpha = alpha / NOVEL_SCRIM_ALPHA
        if (done) {
          this.novelScrim.alpha = NOVEL_SCRIM_ALPHA
          text.alpha = 1
          if (this.scrimRetreatTimer) {
            this.time.clearInterval(this.scrimRetreatTimer)
            this.scrimRetreatTimer = null
          }
          this.scrimRetreatActive = false
        }
      }
    }, intervalMs)
  }

  /**
   * 現在のゲーム状態のスナップショットを返す
   */
  getSnapshot(): NovelGameState {
    return {
      sceneId: this.currentSceneId,
      eventIndex: this.eventIndex,
      textIndex: this.textIndex,
      sentenceIndex: this.sentenceIndex,
      flags: this.gameState.toJSON(),
      backgroundPath: this.currentBackgroundPath,
      backgroundColor: this.currentBackgroundColor,
      backgroundFade: this.currentBackgroundFade,
      backgroundBrightness: this.currentBackgroundBrightness,
      video: this.videoLayer.getState(),
      eventImage: this.eventImageLayer.getState(),
      isBlackout: this.blackoutOverlay.visible,
      characters: this.characterLayer.getCharacterStates(),
      currentBgmPath: this.currentBgmPath,
      storyEnded: this.storyEnded,
    }
  }

  /**
   * 次のテキスト / 次のイベントへ進む
   */
  advance(): void {
    // #386: 終劇後は入力を受け付けない（タップしても何も起きない状態を維持する）。
    if (this.storyEnded) return
    if (this.resolvedEvents.length === 0) return
    if (this.waitingForChoice || this.waitingForWait) return

    const current = this.resolvedEvents[this.eventIndex]
    const textEvt = getTextEvent(current)
    const novel = this.isNovelStyle()

    if (textEvt && novel) {
      // --- novel 文単位送り (#292) ---
      // backlog は「ページを離れる時」だけ記録する（文ごとに記録して断片化させない）。
      const pages = this.getNovelPages(textEvt)
      const page = pages[this.textIndex]
      const sentences = page?.sentences ?? []
      const character = textEvt.type === 'dialog' ? textEvt.character : null

      // 1) 同ページにまだ続く文がある → 次の文へ（既出は溜まる）。backlog はまだ記録しない。
      if (this.sentenceIndex < sentences.length - 1) {
        this.sentenceIndex++
        this.render()
        return
      }

      // 2) ページ最後の文。ここでページを離れるので、このページ全文を backlog に記録する。
      this.backlogOverlay.addEntry(character, page?.text ?? '')

      // 2a) 同イベントに次ページがある → 新ページの先頭文へ（クリア表示）。
      if (this.textIndex < pages.length - 1) {
        this.textIndex++
        this.sentenceIndex = 0
        this.render()
        return
      }
      // 2b) 最後のページ → 下の「次イベントへ」へフォールスルー。
    } else if (textEvt) {
      // --- adv（従来どおり・#283） ---
      // 現在表示中の text 行をそのまま backlog に記録する。
      const currentLine = textEvt.text[this.textIndex] ?? ''
      const character = textEvt.type === 'dialog' ? textEvt.character : null
      this.backlogOverlay.addEntry(character, currentLine)

      this.textIndex++
      const pageCount = this.currentPageCount(textEvt)
      if (this.textIndex < pageCount) {
        // まだ text 行が残っている → クリック = 改頁（次行をクリア表示）
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
      this.updateNovelScrim(false)
    }

    this.eventIndex++
    this.textIndex = 0
    // novel 文 index もイベントを跨ぐのでページ先頭にリセットする (#292)。
    this.sentenceIndex = 0
    // novel 改頁キャッシュは eventIndex 単位。次イベントへ進むので破棄する (#283)。
    this.novelPagesCache = null

    if (this.eventIndex >= this.resolvedEvents.length) {
      // 全イベント完了
      this.markCurrentSceneRead()
      this.dialogBox.setDialog(null, '')
      this.dialogBox.setIndicatorVisible(false)
      this.updateCounter()
      this.onEndCallback?.()
      return
    }

    this.processUntilNextTextEvent()

    // 立ち絵 →（同時/直後に）テキスト の順序保証 (#293)。立ち絵 sprite を同期生成してから
    // スナップショットを記録（afterShow）し、render を順序保証して呼ぶ。
    this.showCharacterThenRender(() => this.pushSnapshot())
  }

  /**
   * デバッグ用リプレイ API (#220 Phase 1)。
   *
   * シーン+操作列（Step[]）を順に適用して任意の状態を再現する。
   * - `advance`: クリック相当。`this.advance()` を呼ぶ
   * - `choice`: 選択肢の確定パスと同等にフラグを整合させてから直接 `jumpToScene(jump)` する
   *   （Choice オーバーレイの表示はスキップする）
   * - `wait`: ms ミリ秒だけ待つ（将来の非同期イベント用）
   *
   * デバッグ/テスト用のリプレイ API。再生中は msPerChar=0（タイプライター即スキップ）とし、
   * 完了時・例外時とも元の msPerChar に必ず復元する（try/finally）。
   * 完了は Promise で通知し、その後は通常操作に戻る。
   *
   * choice の jump 先が存在しない場合は jumpToScene の既存挙動に従い console.warn して
   * no-op となる（例外は投げない）。
   * 既知の制限: 不正な jump を指定した choice ステップでは、表示中の Choice オーバーレイが
   * 残る場合がある（デバッグ用途のため許容）。
   *
   * 同時実行は非対応。実行中（wait 待機中など）の再呼び出しは throw する。
   */
  async playScript(steps: Step[]): Promise<void> {
    if (this.isReplaying) throw new Error('playScript is already running')
    this.isReplaying = true
    const savedMsPerChar = this.dialogBox.getMsPerChar()
    this.dialogBox.setMsPerChar(0)
    try {
      for (const step of steps) {
        switch (step.type) {
          case 'advance':
            this.advance()
            break
          case 'choice':
            // 選択肢確定パス（ChoiceOverlay のコールバック）と同じフラグ整合を保つ。
            // justSelectedChoice は同フレーム advance 抑制用だが、playScript は
            // 同期的に進むため即リセットしてよい。
            this.justSelectedChoice = false
            // jump 成功時は resetAndStartEvents が false にするが、jump 失敗（存在しない
            // シーン）時は resetAndStartEvents が呼ばれないため、ここで明示的にリセットする。
            this.waitingForChoice = false
            this.jumpToScene(step.jump)
            break
          case 'wait':
            await new Promise<void>((resolve) => this.time.setTimeout(resolve, step.ms))
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
    if (this.storyEnded) return
    if (this.resolvedEvents.length === 0) return
    if (this.waitingForChoice || this.waitingForWait) return

    const current = this.resolvedEvents[this.eventIndex]
    const textEvt = getTextEvent(current)
    const novel = this.isNovelStyle()

    if (textEvt && novel) {
      // --- novel 文単位送り (#292) ---
      // 1) 同ページ内を 1 文戻る。
      if (this.sentenceIndex > 0) {
        this.sentenceIndex--
        this.render()
        return
      }
      // 2) ページ先頭の文で更に戻る → 前ページへ。前ページは全文見えている状態に復元する
      //    （sentenceIndex = 前ページ最後の文）＝戻った先は溜まりきった状態が自然。
      if (this.textIndex > 0) {
        this.textIndex--
        const prevPage = this.getNovelPages(textEvt)[this.textIndex]
        this.sentenceIndex = Math.max(0, (prevPage?.sentences.length ?? 1) - 1)
        this.render()
        return
      }
      // 3) 先頭ページの先頭文 → スナップショット/イベント戻りへフォールスルー。
    } else if (textEvt && this.textIndex > 0) {
      // --- adv（従来どおり）: text 行を 1 つ戻る。 ---
      this.textIndex--
      this.render()
      return
    }

    // 前のスナップショットへ（現在の分を pop して、その前に戻る）
    if (this.history.length > 1) {
      this.history.pop()
      const prevState = this.history[this.history.length - 1]
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
    if (historyIndex < 0 || historyIndex >= this.history.length) return
    if (this.waitingForChoice || this.waitingForWait) return

    // シーク操作時はスキップモードを解除する (#140): ユーザーが特定箇所を見たくてシークしているため
    this.setSkipMode(false)
    // シーク操作時はボイスを停止する（再生中のボイスが残留しないよう）
    this.audioManager.stopVoice()

    // 履歴を指定位置まで切り詰める（アンドゥスタック方式: 戻った地点から再進行すると新しい履歴が積まれる）
    this.history = this.history.slice(0, historyIndex + 1)
    const targetState = this.history[historyIndex]
    this.applyState(targetState)
    this.render()
  }

  // --- private ---

  /**
   * スナップショットを履歴に push する
   */
  private pushSnapshot(): void {
    if (
      this.eventIndex < this.resolvedEvents.length &&
      getTextEvent(this.resolvedEvents[this.eventIndex])
    ) {
      this.history.push(this.getSnapshot())
    }
  }

  /**
   * スナップショットから状態を宣言的に復元する
   */
  private applyState(state: NovelGameState): void {
    // intermission タブロー描画の遅延タイマーをキャンセルする (#404)。goBack/seekTo でフェード中の
    // 終劇が巻き戻された後、古いタイマーが発火して復元済みの画面をタブローで上書きしてしまう事故を防ぐ。
    if (this.intermissionTimer) {
      this.time.clearTimeout(this.intermissionTimer)
      this.intermissionTimer = null
    }
    // 画面効果をリセット（シーク・バック時に演出が残留しないよう）
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    this.app.stage.position.set(0, 0)
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    if (this.effectOverlay) {
      this.effectOverlay.alpha = 0
      this.effectOverlay.visible = false
    }
    // novel スクリム退避途中（#283）は演出中間状態なので復元では持たない。リセットして
    // 「退避していない」前提に倒す。render() が現在ページのスクリム可視性を再設定する。
    this.resetNovelScrimState()

    // フラグ復元。goBack/seekTo は applyState を単独で呼ぶため、ここでの復元は必須。
    // restoreToScene 経由では resolveEvents 用に先んじて同じ復元が行われるが、
    // 冪等な fromJSON なので二重適用に副作用はない（詳細は restoreToScene のコメント #256）。
    this.gameState.fromJSON(state.flags)

    // インデックス復元
    this.eventIndex = state.eventIndex
    this.textIndex = state.textIndex
    // novel 文 index (#292)。古い snapshot/セーブには無い → ?? 0（ページ先頭の文）に倒す。
    this.sentenceIndex = state.sentenceIndex ?? 0
    // novel 改頁キャッシュは派生。任意局面復元で events / 幾何 / eventIndex が変わり得るので破棄し、
    // render() 側で現在の eventIndex に対して再計算させる (#283)。
    this.novelPagesCache = null

    // 終劇状態の復元 (#386)。goBack/seekTo/セーブ復元はすべて即時反映（フェード演出はしない）。
    // DOM 側（NovelPlayer の "to be continued..." 表示）は callback で同期する。
    this.storyEnded = state.storyEnded
    this.onStoryEndedChangeCallback?.(state.storyEnded)

    // 背景復元
    if (state.backgroundPath) {
      this.setBackground(state.backgroundPath, state.backgroundFade, state.backgroundBrightness, {
        instant: true,
      })
    } else {
      this.clearBackground()
    }

    // 単色地色の復元 (#273)。背景画像とは独立スロット（bgGraphics）なので別分岐で復元する。
    // 古いセーブ・スナップショットには backgroundColor が無い → ?? null で「色なし」に倒す。
    if (state.backgroundColor) {
      this.setBackgroundColor(state.backgroundColor)
    } else {
      this.clearBackgroundColor()
    }

    // 動画レイヤ復元 (#252)。clearBackground / setBackground は背景のみを扱い
    // 動画には触れないため（show が単一スロットを置換、なしなら remove）、背景復元の後に行う。
    this.videoLayer.restore(state.video)

    // イベント絵レイヤー復元 (#351)。フェードは行わず即時反映（ADR-0002）。背景・立ち絵・動画の
    // 可視性は eventImageLayer の復元後の状態を見て宣言的に再計算する（processDirective と
    // 同じ applyEventImageVisibility を共有）。onSettled でロード完了/失敗後にも再計算する
    // （processDirective の EventImage 分岐と同じセルフレビュー対応）。
    this.eventImageLayer.restore(state.eventImage, {
      onSettled: () => this.applyEventImageVisibility(),
    })
    this.applyEventImageVisibility()

    // 暗転復元（セーブ/ロード・シーク・任意局面起動の applyState はすべてここを通る #350）
    this.setBlackout(state.isBlackout)

    // 立ち絵復元（フェードインは入れず、スナップショット時点の状態を即時表示する #177）。
    // novel 役割配置 (#286): protagonist 指定時は復元でも質問役=左 / 回答役=右の x を当てる
    // （token のままだと前進時の配置と食い違うため）。ポーズ nudge は演出なので復元では起こさない。
    this.characterLayer.clear()
    for (const ch of state.characters) {
      const xRatio = this.resolveNovelRoleXRatio(ch.name)
      // 明示フィット (#294) は GameState に持たない脚本由来属性なので、復元時は
      // 現在イベント以前の最新 Dialog から引き当てて再現する（goBack/seekTo/セーブ復元）。
      const fit = resolveCharacterFit(this.resolvedEvents, this.eventIndex, ch.name)
      this.characterLayer.show(ch.name, ch.expression, ch.position, this.assetBaseUrl, {
        instant: true,
        xRatio,
        fit,
      })
    }
    // 話者交代追跡 (#286) を復元位置の話者に合わせる。任意局面復元の直後に同じ話者で
    // 前進しても誤って nudge しないよう、現在イベントの Dialog 話者を lastSpeaker に据える。
    // 復元自体ではポーズ変化を起こさない（演出は GameState に持たない）。
    const restoredEvt = getTextEvent(this.resolvedEvents[this.eventIndex])
    this.lastSpeaker = restoredEvt?.type === 'dialog' ? restoredEvt.character : null

    // BGM復元
    if (state.currentBgmPath) {
      const soundUrl = resolveAssetUrl(this.assetBaseUrl, 'sounds', state.currentBgmPath)
      this.audioManager.playBgm(soundUrl)
      this.currentBgmPath = state.currentBgmPath
    } else {
      this.audioManager.stopBgm(0)
      this.currentBgmPath = null
    }
  }

  /**
   * rawEvents を現在のフラグ状態で再展開し、eventIndex を維持する。
   * Flag イベント処理後に呼ばれ、後続の Condition が新しいフラグ値で評価される。
   */
  private reResolveEvents(): void {
    const oldIndex = this.eventIndex
    this.resolvedEvents = resolveEvents(this.rawEvents, this.gameState)
    this.displayEventCount = this.resolvedEvents.filter((e) => getTextEvent(e) !== null).length
    // novel 改頁キャッシュは展開後のイベント列に紐づくので破棄する (#283)。
    this.novelPagesCache = null

    // 再展開で配列長が変わった場合、eventIndex を安全な範囲に収める
    if (oldIndex >= this.resolvedEvents.length) {
      this.eventIndex = Math.max(0, this.resolvedEvents.length - 1)
    }
    // 再展開前と同じイベントを指しているか確認（Flag イベント自体は展開で位置が変わらない）
    // Flag は Condition の外にあるため、Flag の位置は再展開で変動しない
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
   * 暗転オーバーレイの表示を切り替え、SeekBar の可視ゲートと同期する (#350)。
   * 暗転中はスライダを隠す（z 順は変えず可視性ゲートで対処し、黒の上に薄いスライダ線が残らない）。
   * active も SeekBar 側で解除する。GameState の永続 isBlackout から導出する transient な見た目同期で、
   * 適用/解除/復元（processDirective / restoreToScene / applyState）すべてこの 1 経路に集約する。
   */
  private setBlackout(visible: boolean): void {
    this.blackoutOverlay.visible = visible
    this.seekBar.setBlackoutHidden(visible)
  }

  /**
   * イベント絵レイヤー (#351) の `back` 値に応じて、背景・立ち絵・動画の可視性を宣言的にトグルする。
   *
   * `setBlackout` と同じ「単一の宣言的セッター」パターン: processDirective（ライブ進行）と
   * applyState（goBack/seekTo/セーブ復元）の両方から、eventImageLayer の現在状態を毎回
   * 素直に読んで反映するだけにする。退避 → 復元のような一回限りのアニメーションは持たない
   * （ADR-0002: スナップショットは常に settled 状態のみを持つ）。
   *
   * 判定は `eventImageLayer.shouldHideBackLayer()` に委ねる（`getState()?.back==='Hide'` の単純な
   * 意図参照ではなく、ロード失敗時は覆うものが無いため隠さない可視性専用ロジック。セルフレビュー
   * 指摘: back=Hide のままロードが永久に失敗すると背面が隠れっぱなしになる事故を防ぐ）。
   * `videoLayer`（#252）も背面スタックの一部（characterLayer と bgContainer の間に位置）なので
   * 同じトグルに含める（セルフレビュー指摘: event image の前面に動画だけ透けて見える事故を防ぐ）。
   */
  private applyEventImageVisibility(): void {
    const hide = this.eventImageLayer.shouldHideBackLayer()
    this.bgGraphics.visible = !hide
    this.bgContainer.visible = !hide
    this.videoLayer.visible = !hide
    this.characterLayer.visible = !hide
  }

  private handleAdvance = (): void => {
    if (this.justSelectedChoice) {
      this.justSelectedChoice = false
      // 「1 ポインタジェスチャで 1 回だけ」を守るため、このフレームで進めないと決まった時点で
      // suppressNextAdvance も一緒に消費する (#350)。choice 直後の同フレームに SeekBar 由来の
      // suppressNextAdvance が同居していても、固着させて後続の独立ポインタへ漏らさない。
      this.suppressNextAdvance = false
      return
    }
    // SeekBar の clickRegion(Pixi) が同じ native pointerdown でこの DOM ハンドラより先に発火し
    // onSeek 内で suppressNextAdvance を立てる (#350)。スライダ下端帯タップが「シーク＋1つ進む」と
    // 二重発火するのを防ぐため、立っていれば 1 回だけ消費して早期 return する（justSelectedChoice と同型）。
    if (this.suppressNextAdvance) {
      this.suppressNextAdvance = false
      return
    }
    // ここに到達 = スライダ以外への通常タップ/送り。SeekBar が active なら即 inactive へ戻して
    // 丸ボタンを復帰させる（無操作タイマー満了を待たない） (#350)。inactive 時は no-op。
    this.seekBar.deactivate()
    this.audioManager.ensureContext()
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
    if (this.waitingForChoice && this.choiceOverlay.handleWheel(e.deltaY)) {
      e.preventDefault()
      return
    }
    if (this.backlogOverlay.visible) {
      e.preventDefault()
      this.backlogOverlay.handleWheel(e.deltaY)
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.justSelectedChoice) {
      this.justSelectedChoice = false
      return
    }
    this.audioManager.ensureContext()

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
        if (!this.waitingForChoice) {
          this.openSaveMenu()
        }
        break
      case 'l':
      case 'L':
        if (!this.waitingForChoice) {
          this.openLoadMenu()
        }
        break
      case 'b':
      case 'B':
        if (!this.waitingForChoice) {
          this.backlogOverlay.toggle()
        }
        break
    }
  }

  /**
   * 非テキストイベントを実行しながら次のテキストイベントまで進む
   */
  private processUntilNextTextEvent(): void {
    while (this.eventIndex < this.resolvedEvents.length) {
      if (getTextEvent(this.resolvedEvents[this.eventIndex])) break
      this.processDirective(this.resolvedEvents[this.eventIndex])
      // Choice / Wait は進行を止める
      if (this.waitingForChoice || this.waitingForWait) break
      this.eventIndex++
    }
    // 次に出る立ち絵・背景をバックグラウンドで先読みする (#389)。
    // advance / setScenes / jumpToScene は全てここを通るので、この 1 箇所で全トリガーを覆う。
    // 走査は同期・実ダウンロードは backgroundLoad に投げっぱなし（await しない＝本編を待たせない）。
    this.preloadUpcomingAssets()
  }

  /**
   * 立ち絵・背景テクスチャの先読み (#389)。
   *
   * 立ち絵・背景は従来「表示の瞬間に初めて `Assets.load`」する遅延ロード（初出は必ず
   * ネット取得のコールドロード）で、遅延・瞬断すると #293 のフォールバック（ロード成否に
   * 関わらず onReady 発火でテキスト解禁）により「立ち絵なし・テキストあり」を招く。これを
   * 緩和するため、現在の `eventIndex` から `resolvedEvents` を前方走査し、次に出るアセット
   * URL を PixiJS の `Assets.backgroundLoad` に積んで事前に温めておく。
   *
   * - 走査は**次の分岐に当たるまで**。分岐 = `Choice`（`{ Choice: {...} }`）または
   *   `Condition`（`{ Condition: {...} }`、フラグ依存分岐）。分岐先が確定するまで先読みは
   *   できないため、当たったら止める（配列末尾でも止める）。
   *   ※ `Condition` は `resolveEvents` で展開済みのため `resolvedEvents` には通常現れないが、
   *     仕様として境界扱いを明示しておく（防御的・非回帰）。
   * - 収集対象: `Dialog` / `ExpressionChange` の立ち絵（`resolveCharacterImageUrls`、
   *   webp/png の複数候補）と `Background` の背景画像（`resolveAssetUrl`）。Video 等
   *   `Assets.load` 経路でないものは対象外。単独画像 `[画像:]`（#274, renderOnly）も対象外＝
   *   先読みは立ち絵・背景に限定する。Dialog の立ち絵は実表示ガード（`showCharacterFromDialog`:
   *   `expression` / `position` / `character` が全て truthy）に揃え、空文字・position 欠落は積まない。
   * - **緩い上限**: 分岐までが極端に長い場合に備え、先読みするテキストイベント
   *   （`getTextEvent` 非 null）を最大 {@link PRELOAD_MAX_TEXT_EVENTS} 個ぶんに抑える。
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
    if (!this.assetBaseUrl) return

    const urls: string[] = []
    let textEventCount = 0

    // 走査開始 i = this.eventIndex は「今表示するテキストイベント」を含む（未来だけでなく現在も
    // 先読み対象）。PRELOAD_MAX_TEXT_EVENTS=Infinity のため、この予算チェック自体は常に false
    // になり実質的な上限は「次の分岐（Choice/Condition）または配列末尾まで」に一本化される (#417)。
    for (let i = this.eventIndex; i < this.resolvedEvents.length; i++) {
      const event = this.resolvedEvents[i]
      // 文字列 variant（'SceneTransition' / 'PageBreak' / 'VideoExit' 等）は分岐でも
      // テキストでも先読み対象アセットでもないので読み飛ばす。
      if (typeof event !== 'object' || event === null) continue

      // 分岐に当たったら走査終了（分岐先が確定しないと先読みできない）
      if ('Choice' in event || 'Condition' in event) break

      // テキストイベント数の緩い上限で打ち切る（Dialog も下でアセットを積むので判定を先に）
      if (getTextEvent(event) !== null) {
        if (textEventCount >= PRELOAD_MAX_TEXT_EVENTS) break
        textEventCount++
      }

      if ('Dialog' in event) {
        // 実表示ガード（showCharacterFromDialog: `!expression || !position || !speaker`）に
        // 揃える＝立ち絵を実際に show する Dialog だけ先読みする。falsy チェックで空文字も弾き、
        // position も要求する（空文字 expression の無効 URL 先読みを消す）。
        const { character, expression, position } = event.Dialog
        if (expression && character && position) {
          for (const u of resolveCharacterImageUrls(
            this.assetBaseUrl,
            expression.replace(/^\//, '')
          )) {
            urls.push(u)
          }
        }
      } else if ('ExpressionChange' in event) {
        // ExpressionChange は position を持たない。expression / character の falsy チェックに
        // 揃える（空文字を弾く）。
        const { character, expression } = event.ExpressionChange
        if (expression && character) {
          for (const u of resolveCharacterImageUrls(
            this.assetBaseUrl,
            expression.replace(/^\//, '')
          )) {
            urls.push(u)
          }
        }
      } else if ('Enter' in event) {
        // 無言登場 (#401) の立ち絵も先読みする。Dialog の立ち絵と同じ実表示ガード
        // （expression / position / character が全て truthy）に揃える。
        const { character, expression, position } = event.Enter
        if (expression && character && position) {
          for (const u of resolveCharacterImageUrls(
            this.assetBaseUrl,
            expression.replace(/^\//, '')
          )) {
            urls.push(u)
          }
        }
      } else if ('Background' in event) {
        urls.push(resolveAssetUrl(this.assetBaseUrl, 'images', event.Background.path))
      }
    }

    // スキャン内での重複URL（同じキャラの表情が2回以上登場する等）を先に除去する（#417）。
    // 近い順の並びを保つため、初出（最も近い方）を残して後続の重複を落とす。
    const seen = new Set<string>()
    const dedupedUrls = urls.filter((u) => {
      if (seen.has(u)) return false
      seen.add(u)
      return true
    })

    // 未積みの URL だけを backgroundLoad に積む（同期は走査のみ・実 DL は投げっぱなし）
    const fresh = dedupedUrls.filter((u) => !this.preloadedUrls.has(u))
    if (fresh.length === 0) return
    for (const u of fresh) this.preloadedUrls.add(u)
    // 先読み失敗で本編を止めない。#293 のフォールバックがテキストは従来どおり解禁する。
    //
    // fresh は近い順（nearest→farthest）に組み立てているが、PixiJS v8 の BackgroundLoader
    // （node_modules/pixi.js/lib/assets/BackgroundLoader.mjs）は add() で配列末尾へ push した
    // アセットを _next() で Array.pop()（末尾取り出し＝LIFO）で消化する非公開の内部実装になっている。
    // そのままだと最も遠い（優先度が低い）アセットから読まれ、直後に必要な立ち絵が最後回しになる
    // (#414)。reverse() して [farthest, ..., nearest] にしてから渡すことで、末尾＝nearest が
    // 最初に pop されるようにする。
    // ⚠️ これは PixiJS の非公開内部実装（pop=LIFO）依存の脆い前提。将来の PixiJS バージョンアップで
    // BackgroundLoader の消化順が変わったら、この reverse は無意味になるか逆効果になり得る
    // （#414 が静かに再発し得る）。
    Assets.backgroundLoad(fresh.reverse()).catch(() => {})
  }

  /**
   * 演出イベント（Background, Blackout, SceneTransition）を実行する
   *
   * Condition は resolvedEvents では既に展開済みなので、ここでは処理しない。
   */
  private processDirective(event: Event): void {
    if (typeof event === 'string') {
      if (event === 'SceneTransition') {
        this.clearBackground()
        // 場面転換では動画レイヤも背景と同じ扱いでクリアする (#252)
        this.videoLayer.remove()
        // イベント絵レイヤーも場面転換でクリアする (#351)。作者が [イベント絵終了] を書き忘れても
        // 背景・立ち絵が隠れたまま次のシーンに持ち越されないようにする防御。
        this.eventImageLayer.remove()
        this.applyEventImageVisibility()
        this.setBlackout(false)
        // novel: 場面転換でスクリム+文字を退避して新しい絵を見せ、戻す (#283)
        this.retreatNovelScrim()
      }
      if (event === 'VideoExit') {
        // [動画退場] で動画レイヤをクリア (#252)
        this.videoLayer.remove()
      }
      if (event === 'WaitDisplayComplete') {
        this.beginWaitDisplayComplete()
      }
      return
    }
    if ('Background' in event) {
      const bg = event.Background
      this.setBackground(
        bg.path,
        normalizeBackgroundFade({
          top: bg.fade_top,
          bottom: bg.fade_bottom,
          left: bg.fade_left,
          right: bg.fade_right,
        }),
        bg.brightness
      )
      return
    }
    if ('BackgroundColor' in event) {
      // 単色地色 (#273)。背景画像と同じ永続状態（snapshot / applyState / セーブ復元で復元）。
      this.setBackgroundColor(event.BackgroundColor.color)
      return
    }
    if ('Video' in event) {
      // 動画入力レイヤ (#252)。URL 構築は VideoLayer 側（assetBaseUrl + '/videos/' + path）に委譲し、
      // ここでは相対パスをそのまま渡す。背景の setBackground と同じ責務分担で、
      // セーブ/スナップショットには相対パスが保持される（ドメイン変更後のロードでも壊れない）。
      const v = event.Video
      if (this.assetBaseUrl) {
        this.videoLayer.show(v.path, {
          position: v.position,
          scale: v.scale,
          loop: v.loop,
          mute: v.mute,
          fade: normalizeBackgroundFade({
            top: v.fade_top,
            bottom: v.fade_bottom,
            left: v.fade_left,
            right: v.fade_right,
          }),
        })
      }
      return
    }
    if ('EventImage' in event) {
      // イベント絵レイヤー (#351)。URL 構築は EventImageLayer 側（assetBaseUrl + '/images/' + path）
      // に委譲する。表示後、背面（背景・立ち絵・動画）の可視性を back 値に応じて宣言的に更新する
      // （applyEventImageVisibility は setBlackout と同じく processDirective / applyState の
      // 両方から呼ばれる単一の宣言的トグル。一回限りのアニメーションにはしない・ADR-0002）。
      // onSettled でロード完了/失敗後にも再計算する（セルフレビュー指摘: ロード失敗のまま
      // back=Hide が残ると背面が隠れっぱなしになる事故を防ぐ。shouldHideBackLayer() 参照）。
      const ei = event.EventImage
      if (this.assetBaseUrl) {
        this.eventImageLayer.show(ei.path, {
          back: ei.back,
          fadeMs: ei.fade_ms ?? this.eventImageFadeMs,
          onSettled: () => this.applyEventImageVisibility(),
          onVisibilityChange: () => this.applyEventImageVisibility(),
        })
        this.applyEventImageVisibility()
      }
      return
    }
    if ('EventImageExit' in event) {
      // [イベント絵終了] でイベント絵レイヤーをクリアする (#351)。
      this.eventImageLayer.remove({ fadeMs: event.EventImageExit.fade_ms ?? this.eventImageFadeMs })
      this.applyEventImageVisibility()
      return
    }
    if ('Blackout' in event) {
      this.setBlackout(event.Blackout.action === 'On')
      return
    }
    if ('Bgm' in event) {
      if (event.Bgm.action === 'Play' && event.Bgm.path) {
        const soundUrl = resolveAssetUrl(this.assetBaseUrl, 'sounds', event.Bgm.path)
        // fade_ms (#145): 指定があれば fade-in、未指定なら即時再生
        this.audioManager.playBgm(soundUrl, event.Bgm.fade_ms ?? undefined)
        this.currentBgmPath = event.Bgm.path
      } else {
        // fade_ms (#145): 指定があればその ms で fade-out、未指定は AudioManager 既定 (1000ms)
        if (event.Bgm.fade_ms != null) {
          this.audioManager.stopBgm(event.Bgm.fade_ms)
        } else {
          this.audioManager.stopBgm()
        }
        this.currentBgmPath = null
      }
      return
    }
    if ('Se' in event) {
      const soundUrl = resolveAssetUrl(this.assetBaseUrl, 'sounds', event.Se.path)
      // fade_ms (#145): 指定があれば fade-in、未指定なら即時再生
      this.audioManager.playSe(soundUrl, event.Se.fade_ms ?? undefined)
      return
    }
    if ('Flag' in event) {
      this.gameState.setFlag(event.Flag.name, event.Flag.value)
      // フラグ変更により後続の Condition の評価結果が変わる可能性がある。
      // 現在のシーンの元イベントを再取得して resolvedEvents を再計算する。
      this.reResolveEvents()
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
        this.confinedSceneIds !== null &&
        event.Choice.options.every((o) => !isSceneIdConfined(o.jump, this.confinedSceneIds))
      ) {
        this.endStory()
        return
      }
      // 選択肢に到達したらスキップモードを解除（手動選択が必要） (#140)
      this.setSkipMode(false)
      // 複数埋め込みで他インスタンスが読んだ scene を、選択肢表示直前に反映する (#366)。
      this.reloadReadProgress()
      this.waitingForChoice = true
      this.choiceOverlay.show(
        event.Choice.options,
        (jump: string) => {
          // 同フレームの advance を抑制。jumpToScene が例外を投げても次の
          // イベントループで確実にリセットされるよう setTimeout(0) を使う (#211)
          this.justSelectedChoice = true
          this.time.setTimeout(() => {
            this.justSelectedChoice = false
          }, 0)
          this.waitingForChoice = false
          this.choiceOverlay.hide()
          this.jumpToScene(jump)
        },
        this.choiceStyle,
        this.readSceneProgress
      )
      return
    }
    if ('ExpressionChange' in event) {
      this.characterLayer.changeExpression(
        event.ExpressionChange.character,
        event.ExpressionChange.expression,
        this.assetBaseUrl
      )
      // novel: 表情変化でスクリム+文字を退避して立ち絵の変化を見せ、戻す (#283)
      this.retreatNovelScrim()
      return
    }
    if ('Exit' in event) {
      // スキップモード中はフェードを抑制して即時退場（既読を素早く流す UX に揃える）#177
      this.characterLayer.remove(event.Exit.character, { instant: this.skipMode })
      return
    }
    if ('Enter' in event) {
      // 無言の立ち絵登場 (#401)。`[登場: 名前 (sprite/表情, 位置)]`。
      // Dialog 経由の showCharacterFromDialog と同じ show ロジック（役割配置の xRatio / fit /
      // skip 中の即時表示）で立ち絵を出すが、本文を持たないため lastSpeaker 追跡・nudge・
      // scrim 退避は行わない（無言のまま立たせるだけ・話者交代の合図ではない）。
      // expression / position / character が揃っていない不完全な指定は showCharacterFromDialog の
      // 実表示ガードに揃えて silent skip（立ち絵を出さない）。
      // 冪等: 同一 name/expression/position/fit の再宣言は CharacterLayer.show 側の no-op ガードで無効。
      const { character, expression, position, fit } = event.Enter
      if (character && expression && position) {
        const xRatio = this.resolveNovelRoleXRatio(character)
        this.characterLayer.show(character, expression, position, this.assetBaseUrl, {
          instant: this.skipMode,
          xRatio,
          fit: fit === true,
        })
      }
      return
    }
    if ('Animate' in event) {
      // 立ち絵アニメ (#134) — fire-and-forget。完了を待たず次へ進む。
      this.characterLayer.animate(event.Animate.target, {
        dx: event.Animate.dx,
        dy: event.Animate.dy,
        rotation: event.Animate.rotation,
        scale: event.Animate.scale,
        duration_ms: event.Animate.duration_ms,
        easing: event.Animate.easing,
      })
      return
    }
    if ('DialogBorderless' in event) {
      // 文字ウィンドウ枠の ON/OFF (#135)
      this.dialogBox.setBorderless(event.DialogBorderless.borderless)
      return
    }
    if ('TitleShow' in event) {
      // 動画タイトル中央表示 (llll-ll-media 用)
      // Label / Image と同じく union 絞り込み済みの型付きアクセス（types.ts に size/x/y 済み）。
      const ts = event.TitleShow
      // フォント解決の優先順チェーンは novelLayout.resolveFontFamily に集約 (#260)。
      const font = resolveFontFamily(
        ts.font_family,
        this.gameDefaultFontFamily,
        NovelRenderer.RUNTIME_DEFAULT_FONT_FAMILY
      )
      // タイトル文字色 (#273)。color は CharacterLayer 側で解決し、グリフ演出・カーソルにも波及する。
      // サイズ・x/y override (#275) は CharacterLayer 側で fontSize / resolvePositionWithOverride に渡す。
      this.characterLayer.showTitle(ts.text, font, ts.position, ts.color, {
        size: ts.size,
        x: ts.x,
        y: ts.y,
      })
      return
    }
    if ('Label' in event) {
      // 単独の色付きラベル (#274) — OP タイトルカードの肩書 / 名前。
      // フォント解決は TitleShow と共通の resolveFontFamily（per-line → per-game → runtime）。
      // 位置・色・サイズは CharacterLayer.showLabel が resolvePositionWithOverride / parseColorToNumber で解決する。
      // 揃え・隣接・x/y override (#275) もそのまま showLabel に渡す（ED の install-line 用）。
      const lb = event.Label
      const font = resolveFontFamily(
        lb.font_family,
        this.gameDefaultFontFamily,
        NovelRenderer.RUNTIME_DEFAULT_FONT_FAMILY
      )
      // skipMode 中はフェードインを飛ばして即時表示する（立ち絵と揃える）。
      this.characterLayer.showLabel({
        id: lb.id,
        text: lb.text,
        color: lb.color,
        position: lb.position,
        size: lb.size,
        fontFamily: font,
        align: lb.align,
        after: lb.after,
        x: lb.x,
        y: lb.y,
        instant: this.skipMode,
      })
      return
    }
    if ('Image' in event) {
      // 単独の画像 (#274) — OP タイトルカードのアバター。
      // url 解決は背景画像と同じ assetBaseUrl + '/images/' + path（CharacterLayer 側で resolveAssetUrl）。
      const im = event.Image
      this.characterLayer.showImage({
        id: im.id,
        path: im.path,
        position: im.position,
        shape: im.shape,
        size: im.size,
        // 位置 override (#275)。position トークンより優先。
        x: im.x,
        y: im.y,
        assetBaseUrl: this.assetBaseUrl,
        instant: this.skipMode,
      })
      return
    }
    if ('TextEffect' in event) {
      // グリフ単位の文字演出 (#268) — fire-and-forget。完了を待たず次へ進む。
      // skipMode 中は演出を畳んで即時完了（整列・不透明）にする。ADR 0002 に従い
      // アニメ進行中の中間状態は持たないため、復元/スキップ時は静止状態でよい。
      const te = event.TextEffect
      // フォント確定後にグリフ構築する Promise を返すが、fire-and-forget なので待たない。
      void this.characterLayer.applyTextEffect(
        te.target,
        {
          effect: te.effect,
          stagger_ms: te.stagger_ms,
          ms_per_char: te.ms_per_char,
          dx: te.dx,
          dy: te.dy,
          rotation: te.rotation,
          scale: te.scale,
          alpha: te.alpha,
          duration_ms: te.duration_ms,
          easing: te.easing,
          // #271 点滅カーソル（効果=タイプ 専用）
          cursor: te.cursor,
          blink_ms: te.blink_ms,
          cursor_color: te.cursor_color,
        },
        { instant: this.skipMode }
      )
      return
    }
    if ('Underline' in event) {
      // 下線ビーム (#270) — fire-and-forget。完了を待たず次へ進む。
      // skipMode 中は伸び切った静止線にする（ADR0002: 中間状態を持たない）。
      const ul = event.Underline
      void this.characterLayer.applyUnderline(
        ul.target,
        {
          color: ul.color,
          thickness: ul.thickness,
          duration_ms: ul.duration_ms,
          offset: ul.offset,
          easing: ul.easing,
        },
        { instant: this.skipMode }
      )
      return
    }
    if ('Shake' in event) {
      // 画面シェイク (#143) — fire-and-forget
      this.startShake(event.Shake.intensity_px, event.Shake.duration_ms)
      return
    }
    if ('Flash' in event) {
      // フラッシュ (#143) — fire-and-forget
      this.startFlash(event.Flash.color, event.Flash.alpha, event.Flash.duration_ms)
      return
    }
    if ('Fade' in event) {
      // フェード (#143) — fire-and-forget
      this.startFade(
        event.Fade.target,
        event.Fade.color,
        event.Fade.from_alpha,
        event.Fade.to_alpha,
        event.Fade.duration_ms
      )
      return
    }
    if ('Wait' in event) {
      // 進行を停止し、指定ミリ秒後に再開（eventIndex のインクリメントはコールバック内で行う）
      // Wait 中もスキップを停止する（Wait を無視するのは仕様違反） (#140)
      this.setSkipMode(false)
      this.waitingForWait = true
      this.waitTimer = this.time.setTimeout(() => {
        this.waitTimer = null
        if (!this.initialized) return
        this.waitingForWait = false
        this.eventIndex++
        this.processUntilNextTextEvent()
        // [待機] 明け後の表示も「立ち絵 →（同時/直後に）テキスト」の順序保証 (#293)。
        // 立ち絵 sprite を同期生成してからスナップショットを記録（afterShow）する。
        this.showCharacterThenRender(() => this.pushSnapshot())
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
      this.hasPendingBackgroundLoad() ||
      this.hasActiveBackgroundFade() ||
      this.characterLayer.hasPendingVisualTransition() ||
      this.eventImageLayer.hasPendingVisualTransition()
    )
  }

  private finishWaitAndContinue(): void {
    if (!this.initialized) return
    this.waitingForWait = false
    this.eventIndex++
    this.processUntilNextTextEvent()
    // [待機] 明け後の表示も「立ち絵 →（同時/直後に）テキスト」の順序保証 (#293)。
    // 立ち絵 sprite を同期生成してからスナップショットを記録（afterShow）する。
    this.showCharacterThenRender(() => this.pushSnapshot())
  }

  private beginWaitDisplayComplete(): void {
    this.setSkipMode(false)
    this.waitingForWait = true

    const poll = () => {
      this.updateBackgroundFadeFrame()
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
      { instant: this.skipMode, xRatio, fit: textEvt.fit, onReady }
    )

    // 話者交代でポーズ変化 (#286)。novel のみ・スキップ中は抑制（高速進行で乱発しない）。
    // #283 の scrim 自動退避に相乗りして「絵を見せる」タイミングと揃える。
    // nudge は既定オフ・opt-in (#382)。`speaker_nudge: true` の作品だけ発火する（未指定/false は非発火）。
    // scrim 退避は「絵を見せる」タイミングとして nudge とは独立に維持する（nudge の有無に関わらず退避する）。
    if (speakerChanged && this.isNovelStyle() && !this.skipMode) {
      if (this.speakerNudge) {
        this.characterLayer.nudgePose(speaker)
      }
      this.retreatNovelScrim()
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
    if (this.eventIndex >= this.resolvedEvents.length) {
      // 立ち絵対象が無い。afterShow（スナップショット）だけ走らせ、render は呼ばない
      // （render() 自体も範囲外では no-op だが、呼ばないことで意図を明確にする）。
      afterShow?.()
      return
    }
    const event = this.resolvedEvents[this.eventIndex]
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
    const expectedEventIndex = this.eventIndex
    const expectedTextIndex = this.textIndex
    const expectedSentenceIndex = this.sentenceIndex
    const token = ++this.deferredTextRenderToken
    const isStillCurrent = () =>
      token === this.deferredTextRenderToken &&
      this.eventIndex === expectedEventIndex &&
      this.textIndex === expectedTextIndex &&
      this.sentenceIndex === expectedSentenceIndex
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
          // 立ち絵の fade / nudge / transform が落ち着くまでは本文 reveal を始めない。
          // renderOnly のタイトル演出やカーソル点滅は CharacterLayer 側で除外している。
          if (
            this.characterLayer.hasActivePortraitTransition() &&
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
        this.updateBackgroundFadeFrame()
        if (
          (this.hasPendingBackgroundLoad() || this.hasActiveBackgroundFade()) &&
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
   * 背景画像を設定する（アスペクト比維持でカバー）。
   * fade を渡すと端フェードマスク (#250) を適用する。
   */
  private setBackground(
    path: string,
    fade?: BackgroundFade | null,
    brightness?: number | null,
    opts?: { instant?: boolean }
  ): void {
    const previousPath = this.currentBackgroundPath
    this.currentBackgroundPath = path
    const normalizedFade = normalizeBackgroundFade(fade)
    const normalizedBrightness = normalizeBackgroundBrightness(brightness)
    this.currentBackgroundFade = normalizedFade
    this.currentBackgroundBrightness = normalizedBrightness

    if (!this.assetBaseUrl) {
      this.clearBackgroundEntries()
      return
    }

    const url = resolveAssetUrl(this.assetBaseUrl, 'images', path)
    // #409: コールドスタート（直前に背景画像が無い＝物語/シーンの最初の背景）も
    // crossfade 経路（alpha 0→1）で `background_fade_ms` フェードインさせる。ステージ最背面の
    // bgGraphics は下地ベタの既定色（frontmatter `background_color:`・未指定なら黒 0x000000）なので、
    // これは「下地ベタ（既定は黒）から浮かび上がる」フェードインになる（黒フラッシュにはならない）。
    // 復元（applyState が opts.instant:true を明示＝goBack/seekTo/セーブ復元/任意局面起動）と
    // skipMode・同一 path だけを即時に残す。以前あった `!previousPath` /
    // `this.bgEntries.length === 0`（＝コールドスタート指標）は #409 で削除した。
    const instant = opts?.instant === true || this.skipMode || previousPath === path

    // ロード要求ごとにトークンを更新し、古い非同期完了による UAF / race を防ぐ。
    // キャッシュヒットで同期描画する場合も必ず進めること。さもないと直前に
    // 走っていた別背景の Assets.load().then が後から解決し、即描画した背景の上に
    // 古い sprite+fade を addChild してしまう。
    const token = ++this.bgLoadToken
    this.pendingBackgroundLoadToken = null

    // キャッシュ済みの Texture があれば再利用（戻る操作時のフリッカー防止）
    const cached = this.textureCache.get(url)
    if (cached) {
      this.showLoadedBackground(cached, {
        fade: normalizedFade,
        brightness: normalizedBrightness,
        instant,
      })
      return
    }

    this.pendingBackgroundLoadToken = token
    Assets.load(url)
      .then((texture) => {
        if (token !== this.bgLoadToken) return
        if (this.pendingBackgroundLoadToken === token) this.pendingBackgroundLoadToken = null
        if (!this.initialized) return
        this.textureCache.set(url, texture)
        this.showLoadedBackground(texture, {
          fade: normalizedFade,
          brightness: normalizedBrightness,
          instant: instant || this.skipMode,
        })
      })
      .catch((err) => {
        if (this.pendingBackgroundLoadToken === token) this.pendingBackgroundLoadToken = null
        console.warn('[name-name] 背景画像の読み込みに失敗: ' + url, err)
      })
  }

  private showLoadedBackground(
    texture: Texture,
    opts: {
      fade: BackgroundFade | null
      brightness: number | null
      instant: boolean
    }
  ): void {
    const sprite = new Sprite(texture)
    this.applyCoverFit(sprite)
    this.applyBrightnessTint(sprite, opts.brightness)
    const mask = this.applyEdgeFadeMask(sprite, opts.fade)
    const entry: BackgroundEntry = { sprite, mask, fadeAnimation: null }
    this.bgMaskSprite = mask

    if (opts.instant) {
      this.replaceBackgroundEntries(entry)
      return
    }

    this.crossfadeToBackgroundEntry(entry)
  }

  private replaceBackgroundEntries(entry: BackgroundEntry): void {
    this.stopBackgroundCrossfade()
    this.clearBackgroundEntries()
    entry.sprite.alpha = 1
    entry.fadeAnimation = null
    this.addBackgroundEntryToContainer(entry)
    this.bgEntries = [entry]
    this.bgMaskSprite = entry.mask
  }

  private crossfadeToBackgroundEntry(next: BackgroundEntry): void {
    this.stopBackgroundCrossfade()
    const startMs = this.time.now()
    const durationMs = this.backgroundFadeMs
    const previous = [...this.bgEntries]
    this.beginFadeOutEntries(previous, startMs, durationMs)
    next.sprite.alpha = 0
    next.fadeAnimation = {
      startMs,
      durationMs,
      fromAlpha: 0,
      toAlpha: 1,
      destroyOnComplete: false,
    }
    this.addBackgroundEntryToContainer(next)
    this.bgEntries = [...previous, next]
    this.updateBackgroundFadeFrame()
    this.ensureBackgroundCrossfadeTicker()
  }

  private stopBackgroundCrossfade(): void {
    if (this.bgCrossfadeTimer == null) return
    this.time.clearInterval(this.bgCrossfadeTimer)
    this.bgCrossfadeTimer = null
  }

  private finishBackgroundCrossfadeInstant(): void {
    if (!this.hasActiveBackgroundFade()) return
    this.stopBackgroundCrossfade()
    const latest = this.bgEntries[this.bgEntries.length - 1]
    for (const entry of this.bgEntries) {
      if (entry !== latest) this.destroyBackgroundEntry(entry)
    }
    if (!latest) {
      this.bgEntries = []
      this.bgMaskSprite = null
      return
    }
    latest.sprite.alpha = 1
    latest.fadeAnimation = null
    this.bgEntries = [latest]
    this.bgMaskSprite = latest.mask
  }

  private ensureBackgroundCrossfadeTicker(): void {
    if (this.bgCrossfadeTimer != null) return
    if (!this.hasActiveBackgroundFade()) return
    this.bgCrossfadeTimer = this.time.setInterval(() => {
      this.updateBackgroundFadeFrame()
    }, 16)
  }

  private hasActiveBackgroundFade(): boolean {
    return this.bgEntries.some((entry) => entry.fadeAnimation !== null)
  }

  private hasPendingBackgroundLoad(): boolean {
    return this.pendingBackgroundLoadToken === this.bgLoadToken
  }

  private updateBackgroundFadeFrame(): void {
    let anyActive = false
    for (const entry of [...this.bgEntries]) {
      const f = entry.fadeAnimation
      if (!f) continue
      const t =
        f.durationMs <= 0
          ? 1
          : Math.min(1, Math.max(0, (this.time.now() - f.startMs) / f.durationMs))
      if (t >= 1) {
        entry.sprite.alpha = f.toAlpha
        entry.fadeAnimation = null
        if (f.destroyOnComplete) {
          this.destroyBackgroundEntry(entry)
          this.bgEntries = this.bgEntries.filter((candidate) => candidate !== entry)
        }
      } else {
        anyActive = true
        entry.sprite.alpha = f.fromAlpha + (f.toAlpha - f.fromAlpha) * t
      }
    }
    const top = this.bgEntries[this.bgEntries.length - 1] ?? null
    this.bgMaskSprite = top?.mask ?? null
    if (!anyActive) this.stopBackgroundCrossfade()
  }

  private addBackgroundEntryToContainer(entry: BackgroundEntry): void {
    this.bgContainer.addChild(entry.sprite)
    if (entry.mask) this.bgContainer.addChild(entry.mask)
  }

  /**
   * 現在の currentBackgroundBrightness に基づいて背景スプライトの tint（減光）を適用する。
   * PixiJS の tint は乗算なので、明るさ b（0.0〜1.0）に対し
   * `tint = rgb(round(b*255), round(b*255), round(b*255))` で全体を b 倍に減光する。
   * null/未指定（＝原画のまま）は 0xffffff（白＝tint 無効）で従来動作。
   */
  private applyBrightnessTint(
    sprite: { tint: number },
    brightness: number | null = this.currentBackgroundBrightness
  ): void {
    sprite.tint = brightnessToTint(brightness)
  }

  private applyCoverFit(sprite: Sprite): void {
    // カバーフィット幾何は novelLayout.computeCoverFit に集約 (#260)。
    // 戻り値の {width,height,x,y} を Object.assign で sprite の各 setter に流し込む。
    const { width, height } = sprite.texture
    Object.assign(sprite, computeCoverFit(width, height, this.screenWidth, this.screenHeight))
  }

  /**
   * 現在の currentBackgroundFade に基づいて端フェードマスク (#250) を sprite に適用する。
   * フェード指定がなければ何もしない（従来動作）。
   */
  private applyEdgeFadeMask(
    sprite: Sprite,
    fade: BackgroundFade | null = this.currentBackgroundFade
  ): Sprite | null {
    // #252 で共通ユーティリティ buildEdgeFadeMask に切り出した（VideoLayer と共有）。
    const maskSprite = buildEdgeFadeMask(fade, this.screenWidth, this.screenHeight)
    if (!maskSprite) return null
    sprite.mask = maskSprite
    return maskSprite
  }

  /** 背景 entry が所有する mask Sprite とそのテクスチャを破棄する (#250)。メモリリーク防止 */
  private disposeBgMask(maskSprite: Sprite | null = this.bgMaskSprite): void {
    if (maskSprite) {
      maskSprite.removeFromParent()
      // canvas 由来のテクスチャは textureCache に乗らないので確実に破棄する
      maskSprite.destroy({ texture: true, textureSource: true })
      if (this.bgMaskSprite === maskSprite) this.bgMaskSprite = null
    }
  }

  private destroyBackgroundEntry(entry: BackgroundEntry): void {
    entry.sprite.removeFromParent()
    entry.sprite.destroy()
    this.disposeBgMask(entry.mask)
  }

  private clearBackgroundEntries(): void {
    this.stopBackgroundCrossfade()
    for (const entry of this.bgEntries) this.destroyBackgroundEntry(entry)
    this.bgEntries = []
    this.bgMaskSprite = null
    this.bgContainer.removeChildren()
  }

  /**
   * 背景画像をクリアする
   */
  private clearBackground(): void {
    this.currentBackgroundPath = null
    this.currentBackgroundFade = null
    this.currentBackgroundBrightness = null
    this.bgLoadToken++
    this.pendingBackgroundLoadToken = null
    this.clearBackgroundEntries()
    // 動画レイヤも背景と同じ扱いでクリアする (#252)
    this.videoLayer.remove()
  }

  /**
   * 単色の地色を設定する (#273)。`bgGraphics`（全面を覆う最背面の塗り）を塗り直す。
   *
   * 背景画像とは独立スロット: bgContainer の画像には触れない（画像が上に乗る）。
   * 色解決は novelLayout.parseColorToNumber に委譲（不正値は黒 0x000000 にフォールバック）。
   * init 時に一度 rect+fill 済みなので、重ね塗りで透けないよう必ず clear() してから塗り直す。
   */
  private setBackgroundColor(color: string): void {
    this.currentBackgroundColor = color
    const colorNum = parseColorToNumber(color, 0x000000)
    this.bgGraphics.clear()
    this.bgGraphics.rect(0, 0, this.screenWidth, this.screenHeight)
    this.bgGraphics.fill(colorNum)
  }

  /**
   * 単色の地色をリセットする (#273)。地色を下地ベタの既定色（`background_color:` #409。未指定なら黒）に戻す。
   * 背景画像の clearBackground と対をなす（背景色スロットだけを初期化する）。`[背景色:]` の解除・終劇で呼ぶ。
   */
  private clearBackgroundColor(): void {
    this.currentBackgroundColor = null
    this.bgGraphics.clear()
    this.bgGraphics.rect(0, 0, this.screenWidth, this.screenHeight)
    this.bgGraphics.fill(this.defaultBackgroundColorNum())
  }

  /**
   * 下地ベタ（bgGraphics）の既定色を数値で解決する (#409)。`defaultBackgroundColor`（frontmatter
   * `background_color:`）が設定されていれば parseColorToNumber で解決、未指定なら黒 0x000000（後方互換）。
   */
  private defaultBackgroundColorNum(): number {
    return this.defaultBackgroundColor
      ? parseColorToNumber(this.defaultBackgroundColor, 0x000000)
      : 0x000000
  }

  /**
   * 下地ベタ（bgGraphics）の既定色を設定する (#409)。frontmatter `background_color:` の値（`#rrggbb`）を
   * 渡す。`setBackgroundFadeMs`（#407）と対称の per-game 設定で、`NovelPlayer` の init（初回背景表示より前）で
   * 一度呼ばれ、以後の下地色になる。null/空文字は既定の黒に倒す。
   *
   * `[背景色:]`（#273）のシーン上書きが**無い**とき（`currentBackgroundColor === null`）だけ bgGraphics を
   * 即座に塗り直す。上書きが有効な間は `currentBackgroundColor` が勝つ（上書きを踏み潰さない）。
   * 復元（applyState → setBackgroundColor / clearBackgroundColor）は不変で、null 復元時の戻り先が
   * この既定色になるだけ（従来は暗黙の黒）。
   */
  setDefaultBackgroundColor(color: string | null | undefined): void {
    this.defaultBackgroundColor = color && color.length > 0 ? color : null
    // シーン上書きが無いときだけ地色を新しい既定色へ即反映する。上書き中は触らない。
    if (this.currentBackgroundColor === null) {
      this.bgGraphics.clear()
      this.bgGraphics.rect(0, 0, this.screenWidth, this.screenHeight)
      this.bgGraphics.fill(this.defaultBackgroundColorNum())
    }
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
  }

  // --- クイックセーブ / クイックロード (#142) ---

  /**
   * 現在のゲーム状態をクイックセーブスロットに保存する。
   * 選択肢・Wait 待機中・終劇後は保存しない（不整合状態を避けるため）。
   *
   * 終劇後 (#386) を除外する理由: `endStory()` は `waitingForChoice` を false に戻すため
   * その条件だけでは終劇後のセーブを防げない。また `SaveSlotData`/`saveSlotToGameState` は
   * 意図的に `storyEnded` を保存しない設計（常に false で復元）なので、もし終劇後の
   * eventIndex（圏外 choice に到達したまま止まっている位置）でセーブを許すと、ロード時に
   * 「storyEnded=false なのに Choice イベント位置で止まっている」行き止まり（テキストも
   * 選択肢も "to be continued..." も出ない空白画面）になる。
   * 成功したら true、保存できない状態なら false を返す。
   */
  quickSave(): boolean {
    if (this.waitingForChoice || this.waitingForWait || this.storyEnded) return false

    // シーンタイトルの解決（sceneId ガード + find + ?.title ?? null）は openSaveMenu と
    // 共通の novelLayout.resolveSceneTitle に集約 (#260)。
    const sceneName = resolveSceneTitle(this.allScenes, this.currentSceneId)

    const snapshot = this.getSnapshot()
    const data: SaveSlotData = {
      slot: -1, // クイックセーブはスロット番号不使用
      sceneId: snapshot.sceneId,
      eventIndex: snapshot.eventIndex,
      textIndex: snapshot.textIndex,
      sentenceIndex: snapshot.sentenceIndex,
      flags: snapshot.flags,
      backgroundPath: snapshot.backgroundPath,
      backgroundColor: snapshot.backgroundColor,
      backgroundFade: snapshot.backgroundFade,
      backgroundBrightness: snapshot.backgroundBrightness,
      video: snapshot.video,
      eventImage: snapshot.eventImage,
      isBlackout: snapshot.isBlackout,
      characters: snapshot.characters,
      currentBgmPath: snapshot.currentBgmPath,
      savedAt: new Date().toISOString(),
      sceneName,
    }
    this.saveManager.quickSave(data)
    return true
  }

  /**
   * クイックセーブスロットからゲーム状態を復元する。
   * 選択肢・Wait 待機中はロードしない（不整合状態を避けるため）。
   * データがない・復元できない場合は false を返す。
   */
  quickLoad(): boolean {
    if (this.waitingForChoice || this.waitingForWait) return false
    const data = this.saveManager.quickLoad()
    if (!data) return false
    this.loadFromSaveData(data)
    return true
  }

  /**
   * クイックセーブデータが存在するか返す。
   */
  hasQuickSave(): boolean {
    return this.saveManager.hasQuickSave()
  }

  /**
   * セーブメニューを表示する。
   * 終劇後 (#386) はメニュー自体を開かない。理由は quickSave() の doc コメント参照
   * （SaveSlotData は storyEnded を持たないため、終劇後のセーブは行き止まりの原因になる）。
   */
  private openSaveMenu(): void {
    if (this.storyEnded) return
    this.saveLoadOverlay.showSave((slot: number) => {
      // quickSave と共通のシーンタイトル解決 (#260)。
      const sceneName = resolveSceneTitle(this.allScenes, this.currentSceneId)

      const snapshot = this.getSnapshot()
      const data: SaveSlotData = {
        slot,
        sceneId: snapshot.sceneId,
        eventIndex: snapshot.eventIndex,
        textIndex: snapshot.textIndex,
        sentenceIndex: snapshot.sentenceIndex,
        flags: snapshot.flags,
        backgroundPath: snapshot.backgroundPath,
        backgroundColor: snapshot.backgroundColor,
        backgroundFade: snapshot.backgroundFade,
        backgroundBrightness: snapshot.backgroundBrightness,
        video: snapshot.video,
        eventImage: snapshot.eventImage,
        isBlackout: snapshot.isBlackout,
        characters: snapshot.characters,
        currentBgmPath: snapshot.currentBgmPath,
        savedAt: new Date().toISOString(),
        sceneName,
      }
      this.saveManager.save(slot, data)
    })
  }

  /**
   * ロードメニューを表示する
   */
  private openLoadMenu(): void {
    this.saveLoadOverlay.showLoad((data: SaveSlotData) => {
      this.loadFromSaveData(data)
    })
  }

  /**
   * 指定シーン + 完成済み NovelGameState へ宣言的に復元する共通コア (#256)。
   *
   * loadFromSaveData / startFrom の均質な骨格を集約する:
   * 「フラグ設定 → 選択肢/待機リセット → resolveEvents → applyState → history リセット → render」。
   *
   * 呼び出し側の責務:
   * - シーン探索と「見つからない場合の挙動」（no-op か警告か）は呼び出し側が決める。
   * - 復元先の状態（背景/動画/立ち絵/BGM 等）を含む完全な NovelGameState を構築して渡す。
   *   state.flags は this.gameState へ反映され、resolveEvents の判定にも使われる。
   *
   * @param scene 復元先シーン（events を rawEvents として保持する）
   * @param state applyState に渡す完成済みの状態スナップショット
   */
  private restoreToScene(scene: EventScene, state: NovelGameState): void {
    // フラグを設定（置換セマンティクス）。
    // resolveEvents が flags に依存するため、必ず resolveEvents より前に設定する。
    //
    // 注意 (#256): この fromJSON は後段の applyState 内でも同じ state.flags で
    // 再度呼ばれる（goBack/seekTo は applyState を単独で叩くため applyState 側の
    // フラグ復元も必須）。二重適用に見えるが両者は別目的:
    //   - ここ: resolveEvents（下の展開）より前に flags を確定させるため
    //   - applyState 内: applyState を直接呼ぶ経路のフラグ復元のため
    // 同一値の冪等な fromJSON なので副作用はない。どちらか一方を消すと
    // resolveEvents の展開か直接 applyState 経路のどちらかが壊れるため残す。
    this.gameState.fromJSON(state.flags)

    this.currentSceneId = state.sceneId

    // 選択肢/待機状態をリセット
    this.waitingForChoice = false
    this.waitingForWait = false
    // 直前の choice 確定による同フレーム advance 抑制フラグも消す
    // （完全リセットなので残留させない）
    this.justSelectedChoice = false
    if (this.waitTimer) {
      this.time.clearTimeout(this.waitTimer)
      this.waitTimer = null
    }
    this.clearWaitDisplayCompleteTimer()
    this.choiceOverlay.hide()

    // 元イベントを保持し、Condition をフラグに基づいて展開
    this.rawEvents = [...scene.events]
    this.resolvedEvents = resolveEvents(this.rawEvents, this.gameState)
    this.displayEventCount = this.resolvedEvents.filter((e) => getTextEvent(e) !== null).length

    // 完成済み NovelGameState を applyState で宣言的に復元
    this.applyState(state)

    // 履歴をリセット（復元後は現在位置のみ）
    this.history = [this.getSnapshot()]

    this.render()
  }

  /**
   * セーブデータからゲーム状態を復元する（applyState ベースの宣言的復元）
   */
  private loadFromSaveData(data: SaveSlotData): void {
    if (!data.sceneId) {
      // sceneId が無い空セーブはフラグだけ復元して終了（restoreToScene を通さない）
      this.gameState.fromJSON(data.flags)
      return
    }

    // シーンを探す
    const scene = findSceneById(this.allScenes, data.sceneId)
    if (!scene) {
      // シーンが無い場合はフラグだけ復元（従来挙動を維持）
      this.gameState.fromJSON(data.flags)
      console.warn(`[name-name] セーブデータのシーンが見つからない: ${data.sceneId}`)
      return
    }

    // SaveSlotData → NovelGameState のフィールド対応・後方互換フォールバックは
    // novelLayout.saveSlotToGameState に集約 (#260)。fade だけは PixiJS を間接参照する
    // normalizeBackgroundFade をここで適用し、純粋関数には正規化済みの値を渡す。
    const state = saveSlotToGameState(data, normalizeBackgroundFade(data.backgroundFade))
    this.restoreToScene(scene, state)
  }

  /**
   * sceneId と flags を直接指定して任意の状態からシーンを開始する (#220 Phase 2)。
   *
   * デバッグ/テスト用。history をリセットする（呼び出し後は現在位置のみ）。
   * 指定フラグは置換であり merge ではない（省略時は空でクリア）。
   * 復元は applyState に委譲し、新規の描画/状態ロジックは持たない。
   *
   * - 存在しない sceneId は完全な no-op（flags も含め一切状態を変えない）。
   * - eventIndex/textIndex は範囲チェックしない（呼び出し側責任。範囲外でもクラッシュ
   *   はしないが未定義位置になる）。
   * - playScript 実行中の呼び出しは想定外（デバッグ API 同士の同時使用は非対応）。
   */
  startFrom(opts: StartFromOptions): void {
    const flags = opts.flags ?? {}

    // シーンを探す。無ければ完全な no-op（この時点で flags/index/history を一切触らない）。
    // loadFromSaveData と違い、見つからない場合はフラグも復元しない（最小状態への厳格な no-op）。
    const scene = findSceneById(this.allScenes, opts.sceneId)
    if (!scene) {
      console.warn(`[name-name] startFrom: シーンが見つからない: ${opts.sceneId}`)
      return
    }

    const eventIndex = opts.eventIndex ?? 0
    const textIndex = opts.textIndex ?? 0
    const sentenceIndex = opts.sentenceIndex ?? 0

    // #399: シーン先頭からの新規開始（本番の `?scene=` deep-link は常に eventIndex=0 固定）は、
    // 通常入場（jumpToScene → startScene）と同じ fresh-start 経路に乗せる。startScene →
    // resetAndStartEvents は末尾で processUntilNextTextEvent（冒頭の [背景:]/[BGM:] 等の
    // ディレクティブを最初のテキストまで実行）と showCharacterThenRender（最初の話者の立ち絵を
    // 表示）を通すため、開始直後に背景と立ち絵が出る。
    //
    // これに対し restoreToScene は「完成済み state を applyState で宣言的に復元する」経路で、
    // 冒頭ディレクティブを一切実行しない（eventIndex=0 のまま render するだけ）。だから従来の
    // startFrom は背景も立ち絵も出ず eventIndex=0 で止まっていた（#399 の症状）。restoreToScene
    // は save/load 復元専用（完成状態を持つ SaveSlotData を渡す loadFromSaveData）として残す。
    //
    // eventIndex/textIndex/sentenceIndex が指定されるのは DEV の debug_scene（シーン途中からの
    // 起動）だけ。fresh-start 経路は resetAndStartEvents が index を 0 にリセットしてしまうため
    // 途中局面を再現できない。そのため index 指定がある場合だけ従来どおり restoreToScene の
    // 宣言的復元にフォールバックする（production は常に 0 なのでこの分岐には入らない）。
    if (eventIndex === 0 && textIndex === 0 && sentenceIndex === 0) {
      // フラグを先に確定させる（resetAndStartEvents 内の resolveEvents が this.gameState の
      // flags に依存するため）。fromJSON は置換セマンティクス（restoreToScene と同じ）。
      this.gameState.fromJSON(flags)
      this.startScene(opts.sceneId, scene)
      return
    }

    // DEV（debug_scene で index 指定あり）: 最小 NovelGameState を構築して共通コアで宣言的復元。
    const state: NovelGameState = {
      sceneId: opts.sceneId,
      eventIndex,
      textIndex,
      sentenceIndex,
      flags,
      backgroundPath: null,
      backgroundColor: null,
      backgroundFade: normalizeBackgroundFade(undefined),
      backgroundBrightness: null,
      video: null,
      eventImage: null,
      isBlackout: false,
      characters: [],
      currentBgmPath: null,
      storyEnded: false,
    }
    this.restoreToScene(scene, state)
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
   *
   * テキストが空（立ち絵だけの空ダイアログ等）なら 1 ページ（空文字）を返し、従来の空表示を保つ。
   */
  private getNovelPages(textEvt: { text: string[] }): NovelPage[] {
    if (this.novelPagesCache && this.novelPagesCache.eventIndex === this.eventIndex) {
      return this.novelPagesCache.pages
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
      pages = paginateSentencesByLines(sentences, lineCounts, this.dialogBox.novelMaxLinesPerPage())
      if (pages.length === 0) pages = [{ text: '', sentences: [], lineCount: 0 }]
    }
    this.novelPagesCache = { eventIndex: this.eventIndex, pages }
    return pages
  }

  /** 現在の text イベントの総ページ数 (#283)。novel は改頁数、adv は text 行数。 */
  private currentPageCount(textEvt: { text: string[] }): number {
    if (this.isNovelStyle()) return this.getNovelPages(textEvt).length
    return textEvt.text.length
  }

  /**
   * 現在のイベント/テキスト行を画面に反映
   */
  private render(): void {
    if (!this.initialized) return
    if (this.eventIndex >= this.resolvedEvents.length) return

    const current = this.resolvedEvents[this.eventIndex]
    const textEvt = getTextEvent(current)

    if (!textEvt) {
      this.dialogBox.clearText()
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
      const page = this.getNovelPages(textEvt)[this.textIndex]
      novelPageSentences = page?.sentences ?? []
      // 文 index を現ページの範囲にクランプ（復元で範囲外を渡されても落とさない・空ページは 0）。
      const maxSentence = Math.max(0, novelPageSentences.length - 1)
      novelSentenceIndex = Math.min(Math.max(0, this.sentenceIndex), maxSentence)
      cumulativeText = novelPageSentences.slice(0, novelSentenceIndex + 1).join('')
      shownPlainLength = novelPageSentences.slice(0, novelSentenceIndex).join('').length
    }
    // line は scrim 可視判定や（adv の）表示テキストに使う。novel は累積テキスト。
    const line = novel ? cumulativeText : (textEvt.text[this.textIndex] ?? '')
    const displayIndex = computeDisplayIndex(this.eventIndex, this.resolvedEvents)
    const readLineKey = this.currentSceneId
      ? makeReadLineKey(this.currentSceneId, displayIndex)
      : null
    if (this.docKey && this.currentSceneId) {
      migrateLegacyReadProgressForScene(
        this.docKey,
        this.readProgress,
        this.readLineProgress,
        this.currentSceneId
      )
    }

    // スキップモード処理 (#140): 既読チェックはマーク前に行う
    if (this.skipMode && this.docKey) {
      const alreadyRead = readLineKey
        ? isReadForLine(this.readProgress, this.readLineProgress, this.currentSceneId, displayIndex)
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
    const atEventStart = this.textIndex === 0 && (!novel || novelSentenceIndex === 0)
    let voicePath: string | null = null
    let perLineFontFamily: string | null = null
    if (typeof current === 'object' && current !== null) {
      if ('Dialog' in current) {
        if (atEventStart) {
          voicePath = current.Dialog.voice_path ?? null
        }
        perLineFontFamily = current.Dialog.font_family ?? null
      } else if ('Narration' in current) {
        if (atEventStart) {
          voicePath = current.Narration.voice_path ?? null
        }
        perLineFontFamily = current.Narration.font_family ?? null
      }
    }

    if (voicePath) {
      const voiceUrl = resolveAssetUrl(this.assetBaseUrl, 'sounds', voicePath)
      // voice は fire-and-forget で再生する。autoAdvance は typing onDone / [待機] が決定する。
      // 以前は voice 終了で scheduleAutoAdvance を呼んでいたが、これだと voice の長さで
      // 中央ホールド時間が伸びてしまい「決まった時間で次へ進む」設計と合わなかった。
      // voice が長くて次イベントが先に来ると stopVoice で切られるが、短句ナレ用途ではOK。
      this.audioManager.playVoice(voiceUrl)
    }

    // フォント解決 (#147): per-line override → per-game default → runtime default の優先順。
    // 優先順チェーンは TitleShow と共通の novelLayout.resolveFontFamily に集約 (#260)。
    const resolvedFontFamily = resolveFontFamily(
      perLineFontFamily,
      this.gameDefaultFontFamily,
      NovelRenderer.RUNTIME_DEFAULT_FONT_FAMILY
    )
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

    // 本文色 (#305): 話者から決定論的に導出して DialogBox に渡す（主人公=暖アイボリー / 住人=白）。
    // adv / protagonist 未指定では常に白＝後方互換。setDialog/setNovelDialogProgressive の前に当てる。
    this.dialogBox.setBodyTextColor(this.resolveBodyTextColor(name))

    // novel スクリム (#283): セリフが表示されている間だけ半透明黒を敷く。
    // 空ページ（立ち絵だけの空ダイアログ）はテキスト非表示なのでスクリムも出さない。
    const hasVisibleText = line.replace(/[\s\u3000]/g, '') !== ''
    // novel は本文より先に最低限の黒みを用意する。本文先行の白フラッシュを避けるため。
    if (novel && hasVisibleText) this.updateNovelScrim(true)

    // オートモード時はタイピング完了後に autoWaitMs 待機してから自動進行 (#139)。
    // voice 有無に関わらず typing onDone で進める (voice は fire-and-forget)。
    const onTypingDone = this.autoMode ? () => this.scheduleAutoAdvance() : null
    if (novel) {
      // novel 文単位送り (#292): 既出の文は即時表示・最後に足した文だけタイプする。
      this.dialogBox.setNovelDialogProgressive(name, cumulativeText, shownPlainLength, onTypingDone)
    } else {
      this.dialogBox.setDialog(name, line, onTypingDone)
    }

    if (!novel || !hasVisibleText) this.updateNovelScrim(hasVisibleText)

    // インジケータ (#292):
    //  - 種別: novel で「現在がそのページの最後の文」なら pageturn（❯・改頁）、それ以外は next（▼・次の文）。
    //    adv は setIndicatorKind を呼ばず既定 next（▼・従来の右下固定）のまま＝非回帰。
    //  - 可視: novel は「最後のページの最後の文」かつ最後のイベントで非表示（それ以上進めない）。
    //    adv は従来どおり「最後のページ（text 行）かつ最後のイベント」で非表示。
    const pageCount = this.currentPageCount(textEvt)
    const isLastPage = this.textIndex >= pageCount - 1
    const isLastEvent = this.eventIndex >= this.resolvedEvents.length - 1
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
    if (this.waitingForChoice || this.waitingForWait) return
    if (this.autoTimer) {
      this.time.clearTimeout(this.autoTimer)
    }
    this.autoTimer = this.time.setTimeout(() => {
      this.autoTimer = null
      if (this.autoMode && !this.waitingForChoice && !this.waitingForWait) {
        this.advance()
      }
    }, this.autoWaitMs)
  }

  private updateCounter(): void {
    if (!this.counterText) return
    const displayIndex = computeDisplayIndex(this.eventIndex, this.resolvedEvents)
    // 表示文字列の整形は novelLayout.formatCounterText に集約 (#260)。
    this.counterText.text = formatCounterText(displayIndex, this.displayEventCount)
  }

  /**
   * シークバーの表示を更新する。Counter と同じ「テキストイベント表示位置」で動く。
   * (旧実装は history.length - 1 / history.length で常に ratio≈1 になりバーが
   *  満タンに張り付いていた #125)
   */
  private updateSeekBar(): void {
    const displayIndex = computeDisplayIndex(this.eventIndex, this.resolvedEvents)
    // 0-based 変換 + クランプは novelLayout.computeSeekBarPosition に集約 (#260)。
    // SeekBar は ratio = current/(total-1) を計算する。
    const { current, total } = computeSeekBarPosition(displayIndex, this.displayEventCount)
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
      this.resolvedEvents,
      this.history
    )
    if (historyIdx < 0) return
    this.seekTo(historyIdx)
  }
}
