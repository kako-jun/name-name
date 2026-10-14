/**
 * RPG 戦闘画面 (#173)。
 *
 * Undertale 風レイアウト + DQ1/DQ5 風の「フィールド背景を残す」方針:
 *
 *   +-----------------------+
 *   |                       |  ← フィールドのフレーム（暗くする）
 *   |    [敵スプライト]       |
 *   |                       |
 *   +---+-------+-----------+
 *   |HP/MP|たたかう|じゅもん|どうぐ|にげる|
 *   +-----+-------+----------------------+
 *   |  > スライムがあらわれた！          |  ← 戦闘ログ（最新数行）
 *   |  > ゆうしゃのこうげき！...          |
 *   +-----+-------+----------------------+
 *
 * `layout: 'side'`（#736・FF 系サイドビュー）では配置が変わる。座標は battleLayout.ts が正本:
 *
 *   +-----------------------------------+
 *   | ログ帯（敵の数で 2〜4 行）          |
 *   |  [敵群 + 名前/HP ラベル]  [味方全員] |  ← 敵が左・味方が右。背景画像があれば cover で敷く
 *   +----------+------------------------+
 *   |たたかう … | ゆうしゃ HP 20/20 MP …  |  ← コマンド 2x2 / 味方全員分の HP パネル
 *   +----------+------------------------+
 *
 * BattleEngine（状態機械）を観測して描画する責務だけ持つ。コマンド入力は
 * 4 つのボタン (たたかう/じゅもん/どうぐ/にげる) を直接タップで決定。
 * `side` で commandLayout が `cross` のときは十字配置（上・左・右・下）にし、矢印キー 1 押しでも決定できる (#204)。
 *
 * 呪文 / アイテムは、`side` + `cross` で `menu`（候補）が渡されたときだけ、一覧の窓が重なって開く（窓のスタック・MP・
 * 手のカーソルによる対象選択 #204。状態は battleMenu.ts、座標は battleMenuLayout.ts、描画は BattleMenuLayer.ts）。
 * それ以外では何も起きない（従来どおり）。
 */

import {
  Assets,
  BlurFilter,
  ColorMatrixFilter,
  Container,
  Graphics,
  Mesh,
  MeshGeometry,
  Rectangle,
  Sprite,
  Text as PixiText,
  TextStyle,
  Texture,
  Ticker,
} from 'pixi.js'
import { ATB_GAUGE_MAX, BattleEngine } from './battleEngine'
import {
  crossKeyToCommandId,
  resolveCommandSpecs,
  type CommandId,
  type CommandLabels,
  type CommandLayout,
} from './battleCommands'
import type { BattleEntity } from './spellDsl'
import {
  EMPTY_STACK,
  buildMenuRows,
  cancel as cancelMenuWindow,
  confirm as confirmMenuWindow,
  menuKeyAction,
  moveCursor as moveMenuCursor,
  openList,
  refitList,
  scrollList,
  setListCursor,
  setTargetCursor,
  type BattleItemEntry,
  type BattleMenuData,
  type BattleSpellEntry,
  type MenuAction,
  type MenuContext,
  type MenuKind,
  type MenuStack,
  type TargetSide,
} from './battleMenu'
import { buildMenuView, listMaxRows, type MenuGeometry } from './battleMenuLayout'
import { BattleMenuLayer } from './BattleMenuLayer'
import {
  MOTION_EXTENT_PAD,
  MOTION_SCREEN_MARGIN,
  clampMotionDx,
  POPUP_COLORS,
  eventTimeline,
  SINK_DISTANCE,
  advancePlayback,
  emptyPlayback,
  enqueueEvents,
  isPlaybackBusy,
  messageWindowText,
  popupFontSize,
  popupText,
  resolvePose,
  restingSample,
  sampleActor,
  sampleDamagePopup,
  sampleTarget,
  type BattlePose,
  type BattlePresentation,
  type PlaybackState,
  type TargetSample,
} from './battleMotion'
import type { BattleHit } from './battleEngine'
import {
  SIDE_GAP,
  SIDE_LABEL_LINE_HEIGHT,
  SIDE_LOG_LINE_HEIGHT,
  computeContainFitRect,
  computeFallbackRect,
  computeSideBattleLayout,
  SIDE_COMMAND_TEXT_PADDING,
  fitCommandFontSize,
  SIDE_LABEL_FONT_SIZE,
  SIDE_LABEL_STROKE_WIDTH,
  fitHpLabel,
  fitLabel,
  computeStatusColumns,
  SIDE_STATUS_FONT_SIZE,
  SIDE_STATUS_GAUGE_HEIGHT,
  type StatusColumns,
  type BattleDepth,
  type BattleLayoutMode,
  type SpriteSlot,
} from './battleLayout'
import { getSharedDofMask, quantizeDofRamp } from './dofMaskCache'
import { createAcrylicPlateTexture, type AcrylicPlate } from './acrylicPlateTexture'
import { computeSlitY } from './acrylicBase'
import { computeShadowTransform } from './acrylicShadow'
import { getAcrylicBaseTexture, type AcrylicBaseTexture } from './acrylicBaseTexture'
import {
  computeAcrylicGeometry,
  resolveAcrylicParams,
  type AcrylicParams,
  type SpriteStyle,
} from './spriteStyle'
import { computeCoverFit, resolveRpgImagePath } from './novelLayout'
import { isEditableTarget, isHeldKeyBlocked } from './inputGuards'
import {
  computeBands,
  FF_BLUE_PANEL_ALPHA,
  FF_BLUE_TEXT_SHADOW,
  type WindowStyle,
} from './windowStyle'
import {
  BACKGROUND_TONE_BRIGHTNESS,
  BACKGROUND_TONE_SATURATION,
  saturationToPixiAmount,
  type BackgroundTone,
} from './backgroundTone'
import {
  DOF_MASK_TEXTURE_HEIGHT,
  DOF_DEFAULT_PARAMS,
  DOF_LEVEL_COUNT,
  computeDofFilterArea,
  computeDofLevels,
  computeDofQuad,
  dofMaskStops,
  type BackgroundDof,
} from './depthOfField'
import {
  BATTLE_LOG_MS_PER_CHAR,
  isBattleLogTyping,
  makeBattleLogTracker,
  skipBattleLog,
  syncBattleLog,
  tickBattleLog,
  visibleBattleLogTail,
  type BattleLogTracker,
  type BattleLogTypewriterMode,
} from './battleLogTypewriter'

const BG_DIM_ALPHA = 0.55
const PANEL_BG = 0x000000
const PANEL_BG_ALPHA = 0.85
const PANEL_STROKE = 0xffffff
/** パネルの角丸半径（dark / ff-blue 共通） */
const PANEL_RADIUS = 6
const TEXT_COLOR = 0xffffff
const HP_COLOR = 0x88ee88
/** ATB (#205): 行動する番の味方の名前色 / ゲージの色（溜まり中・満タン）/ ゲージの下地 */
const ACTOR_COLOR = 0xffee66
const ATB_BAR_FILLING_COLOR = 0x66aaff
const ATB_BAR_READY_COLOR = 0xffdd55
const ATB_BAR_BG_COLOR = 0x000000
/** front の ATB ゲージ（パネル下端に引く細い横棒）の高さ (#205)。side は列の右端に短く置く (#745, SIDE_STATUS_GAUGE_HEIGHT) */
const ATB_BAR_HEIGHT = 3
/** 番の味方の印 ▶ の文字サイズと、行の左端からの余白（左余白 SIDE_STATUS_TEXT_PADDING の中に収まる） */
const ATB_MARKER_FONT_SIZE = 10
const ATB_MARKER_INSET = 1
// MP_COLOR は HP/MP バー UI 実装時（戦闘 Phase 2、#175 と同時想定）に追加する

const STAGE_PADDING = 16
const STATS_HEIGHT = 32
const COMMAND_HEIGHT = 56
const LOG_HEIGHT = 96
const LOG_VISIBLE_LINES = 4
const PANEL_GAP = 6

/** 画像が無い（未指定・読み込み失敗）ときの色四角 (#736)。敵=赤系 / 味方=青系 */
const FALLBACK_ENEMY_COLOR = 0xcc5555
const FALLBACK_PARTY_COLOR = 0x5588cc
/** acrylic の台座の色 (#737)。黒に近い円形台座 */
const ACRYLIC_BASE_COLOR = 0x111111
const DEAD_ALPHA = 0.3
/** 敵ラベルの縁取り。写真背景（dim なし）でも読めるよう、背景指定の有無にかかわらず付ける (#736) */
export const SIDE_LABEL_STROKE_COLOR = 0x000000

const NAME_FONT_SIZE = 18
const COMMAND_FONT_SIZE = 18
const LOG_FONT_SIZE = 16
const HP_FONT_SIZE = 16

const TEXT_STYLE_NAME = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: NAME_FONT_SIZE,
  fill: TEXT_COLOR,
  fontWeight: 'bold',
})
const TEXT_STYLE_COMMAND = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: COMMAND_FONT_SIZE,
  fill: TEXT_COLOR,
  fontWeight: 'bold',
})
const TEXT_STYLE_LOG = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: LOG_FONT_SIZE,
  fill: TEXT_COLOR,
})
const TEXT_STYLE_HP = new TextStyle({
  fontFamily: "'Noto Sans JP', sans-serif",
  fontSize: HP_FONT_SIZE,
  fill: TEXT_COLOR,
})

/** 被写界深度の 1 段（ぼかしコピーとそのマスク）(#753) */
interface DofLevelView {
  /** 背景を四方へ広げた矩形メッシュ（端ピクセルを繰り返す）。ぼかしが画面端で欠けないようにする */
  sprite: Mesh
  mask: Sprite
  blur: BlurFilter
  /** 自前生成なので自分で破棄する */
  maskTexture: Texture | null
  /** マスクテクスチャを作ったときの立ち上がり割合 */
  maskRamp: number
}

interface CommandButton {
  id: CommandId
  hit: Container
  text: PixiText
}

/**
 * 戦闘で使うテクスチャの縮小・拡大フィルタを設定する (#760)。
 * RPG の Pixi は antialias:false・resolution 1 で、400px 級の画像をミップマップ無しで小さく縮小するとギザギザになる。
 * 既定は mipmap 生成＋linear で縮小をなめらかにする。`pixelArt`（frontmatter `pixel_art`・#466）なら nearest のまま
 * （ドット絵を保つ。mipmap も作らない）。GPU へ初回アップロードされる前（Assets.load 直後）に呼ぶこと。
 * フィールドのレイキャストのテクスチャには触れない。
 *
 * 注意: テクスチャが既に GPU へアップロード済み（他の画面・先に描画された）なら、`autoGenerateMipmaps` を後から立てても
 * mipmap は作られない（効くのは初回アップロード前）。また `Assets` のキャッシュは画面をまたいで共有されるので、
 * ここで書いた scaleMode / mipmap の設定は同じ画像を使う他の画面にも波及する。
 */
export function applyBattleTextureFilter(tex: Texture, pixelArt: boolean): void {
  const source = tex.source
  if (!source) return
  if (pixelArt) {
    source.scaleMode = 'nearest'
    return
  }
  source.autoGenerateMipmaps = true
  source.scaleMode = 'linear'
}

export interface BattleScreenOptions {
  /** バトル終了（victory / defeat / escaped）時に呼ばれる */
  onClose?: (outcome: 'victory' | 'defeat' | 'escaped') => void
  /**
   * 戦闘レイアウト (#736)。`front`（既定）= 従来の Undertale 風正面配置（先頭 1 人のみ表示）、
   * `side` = FF 系サイドビュー（敵群が左・味方全員が右・下にコマンドと HP パネル）。
   */
  layout?: BattleLayoutMode
  /**
   * 背景画像パス (#736)。指定して読み込みに成功したら、フィールドを暗くする半透明黒の代わりに
   * 画像を cover で敷く。未指定・読み込み失敗時は従来どおり半透明黒。
   */
  background?: string
  /**
   * スプライト表示スタイル (#737)。`none`（既定）= 素材そのまま、`acrylic` = アクリルスタンド風
   * （透明な余白・その外周の枠線・黒い円形台座・接地影）。画像のある枠（`side` のスプライト）にだけかけ、
   * 色四角のフォールバックにはかけない。`front` は敵・味方の画像を描かないので影響しない。
   */
  spriteStyle?: SpriteStyle
  /**
   * ウィンドウ配色テーマ (#744)。`dark`（既定）= 現行の半透明黒、`ff-blue` = FF 風の青い帯状グラデーション
   * （白枠は維持）＋文字に黒い影。色だけがテーマで、寸法は変えない。
   */
  windowStyle?: WindowStyle
  /**
   * 背景画像の彩度・明度を表示時のフィルタで落とすか (#753)。`on`（既定）= 落とす、`off` = 素材そのまま。
   * 背景スプライトにだけかかり、キャラ・敵・パネル・テキストには影響しない。背景なしのときは無関係。
   */
  backgroundTone?: BackgroundTone
  /**
   * 背景画像の被写界深度（DoF）風の手前ぼかし (#753)。`on` = 画面の下側ほど強くぼかす、`off`（既定）= ぼかさない。
   * 背景スプライトにだけかかり、キャラ・敵・パネル・テキストには影響しない。背景なしのときは無関係。
   */
  backgroundDof?: BackgroundDof
  /**
   * 戦闘ログの新しい行を 1 文字ずつ表示するか (#755)。`on` = 新しく積まれた行だけをタイプ表示（表示済みの行は即時）、
   * `off`（既定）= 従来どおり即時表示。`on` のときタイプ中にコマンド／ログをタップすると、まず全文を即時表示する
   * （その 1 タップではコマンドは実行しない。DialogBox の「タップで全文表示→もう一度で進む」と同じ流儀）。
   */
  logTypewriter?: BattleLogTypewriterMode
  /**
   * 演出方式 (#745)。`dq`（既定）= 現行の見た目・挙動、`ff` = 攻撃モーション・被ダメージののけぞり・倒れ・ダメージ数字の
   * ポップアップ・技名だけの中央寄せメッセージ窓。`ff` は `side` のときだけ効く（`front` は敵・味方の絵を動かさないので無視）。
   * `ff` では `logTypewriter` は使わない。
   */
  presentation?: BattlePresentation
  /**
   * 奥行き (#747)。指定して perspective が 0 超なら、`side` で行ごとの縮尺・床の高さを付け、奥→手前の順に描く。
   * 未指定・null は平面（現行どおり）。`front` は敵・味方の画像を描かないので影響しない。
   */
  depth?: BattleDepth | null
  /**
   * 前景レイヤー画像パス (#747)。`side` でスプライトより手前（パネル・テキストより奥）に cover で敷く。
   * 透過 PNG を想定。未指定・読み込み失敗は何も描かない。
   */
  foreground?: string
  /**
   * 画像パス（スプライト・背景・前景）を解決するプロジェクトのアセットのベース URL (#746)。
   * 相対パスは `resolveRpgImagePath` で `${base}/images/...` に解決する。未指定・絶対 URL は従来どおりそのまま読み込む。
   */
  assetBaseUrl?: string
  /**
   * ドット絵モード (#466 / #760)。`true` なら戦闘のテクスチャ（スプライト・敵・背景・前景）を nearest のまま使う。
   * 未指定・false は mipmap＋linear で縮小をなめらかにする。
   */
  pixelArt?: boolean
  /**
   * コマンド窓の配置 (#204)。`grid`（既定・2x2）/ `cross`（FF6「短縮」風の十字。上=たたかう・左=じゅもん・右=どうぐ・下=にげる）。
   * `cross` は `side` のときだけ効き、矢印キー 1 押しでその方向のコマンドを決定する（タップも従来どおり）。
   * `front` では無視する（キー操作も付けない）。
   */
  commandLayout?: CommandLayout
  /**
   * 戦闘開始の時点で押されていたキー（`KeyboardEvent.key`）。`cross` の矢印キーは、これらが一度 keyup されるまで無視する
   * （エンカウント直後に歩行で押しっぱなしだった矢印キーで、いきなりコマンドが決定されるのを防ぐ）(#204)
   */
  initialHeldKeys?: readonly string[]
  /** true を返している間（設定オーバーレイが開いているなど）は、戦闘のキー操作を無視する (#204) */
  isInputSuspended?: () => boolean
  /** コマンドの表示名の上書き (#204)。id（attack / spell / item / escape）は変えず label だけ差し替える。部分指定可 */
  commandLabels?: CommandLabels
  /**
   * 候補窓に出す呪文・アイテム (#204)。`commandLayout` が `cross` のとき（かつ 1 件以上あるとき）だけ有効で、
   * 「じゅもん」「どうぐ」を選ぶと一覧の窓が重なって開く（FF5/6 風の窓の階層）。MP が足りない呪文はグレー。
   * 未指定・空は従来どおり（じゅもん・どうぐは何も起きない）。有効なとき、ATB の wait は候補窓を開いている間だけ止まる
   */
  menu?: BattleMenuData
  /** `acrylic` のパラメータ上書き (#737)。省略した項目は既定値。値はスプライト枠一辺に対する比率 */
  spriteStyleParams?: Partial<AcrylicParams>
}

/** サイドビューの 1 体ぶんの表示物 */
interface EntityView {
  container: Container
  fallback: Graphics
  color: number
  sprite: Sprite | null
  /** acrylic のとき: 台座・影を描く Graphics（fallback の直上）と、スプライトの直下に敷く板のスプライト (#760)。画像読み込み成功まで null/非表示。板は canvas が使えない環境では null */
  acrylicBack: Graphics | null
  acrylicPlate: Sprite | null
  /** 透明アクリルの台座・影のスプライト (#760)。canvas が使えない環境では null（acrylicBack の Graphics で描く） */
  acrylicBase: Sprite | null
  /** 地面に落とす本体の影 (#760)。全キャラの下の層（shadowLayer）に置く。板を作れない環境では null */
  acrylicShadow: Sprite | null
  acrylicShadowFoot: { x: number; y: number }
  /** 板テクスチャの 1px が元画像の何 px か（板は縮小した解像度で作る） */
  acrylicPlateScale: number
  /** 板テクスチャ上で元画像の左上がある位置(px)。配置時にこのぶん左上へずらす */
  acrylicPlatePad: number
  acrylicBaseLayout: AcrylicBaseTexture['layout'] | null
  /** 敵のみ: 名前 + HP ラベル */
  label: PixiText | null
  /** 演出 (#745): 最後に placeEntityView が置いた枠。ポーズ差し替え時の再配置に使う */
  slotRef: SpriteSlot | null
  /** 演出 (#745): placeEntityView が置いた container の基準位置（モーションのずれを足す前）と、枠の一辺（距離の単位） */
  baseX: number
  baseY: number
  unit: number
  /** 演出 (#745): ダメージ数字の出る位置（画面絶対。枠の中央・上半身の高さ） */
  anchorX: number
  anchorY: number
  /** 演出 (#745): 敵ラベルの基準位置（中央 x と上端 y。モーションのずれを足す前） */
  labelBaseX: number
  labelBaseY: number
  /** 演出 (#745): 地面の影の基準位置（モーションのずれを足す前。shadowLayer 基準＝画面絶対） */
  shadowBaseX: number
  shadowBaseY: number
  /** 演出 (#745): 1 枚絵（entity.sprite）の見た目と、いま出している見た目、ポーズ別に読み込めた見た目 */
  baseVisual: PoseVisual | null
  shownVisual: PoseVisual | null
  poseVisuals: Partial<Record<BattlePose, PoseVisual>>
}

/** ポーズ 1 つ分の見た目: スプライトのテクスチャと、acrylic のときの板・影 (#745) */
interface PoseVisual {
  texture: Texture
  plate: AcrylicPlate | null
}

/** 浮いているダメージ数字 1 つ (#745)。画面が持つ演出の途中状態（GameState には持たない） */
interface DamagePopup {
  text: PixiText
  elapsed: number
  /** 対象。画面の作り直し（redraw）で枠が動いても追従するよう、位置は毎回この枠から読む */
  side: 'party' | 'enemy'
  index: number
  x: number
  y: number
  unit: number
}

export class BattleScreen extends Container {
  private engine: BattleEngine
  private screenWidth: number
  private screenHeight: number
  private opts: BattleScreenOptions

  private layoutMode: BattleLayoutMode
  /** 表示スタイル (#737)。`acrylic` のときだけ params が入る */
  private spriteStyle: SpriteStyle
  /** ウィンドウ配色テーマ (#744) */
  private windowStyle: WindowStyle
  /** 背景トーン調整 (#753) */
  private backgroundTone: BackgroundTone
  /** 背景スプライトにかけるフィルタ（1 個を使い回す。destroy で解放） */
  private backgroundToneFilter: ColorMatrixFilter | null = null
  /** 背景の被写界深度風ぼかし (#753) */
  private backgroundDof: BackgroundDof
  /** 背景と同じテクスチャのぼかしコピー（テクスチャは共有）を強さ別に重ねた段。各段に縦グラデーションのアルファマスクを持つ */
  private dofLevels: DofLevelView[] = []
  private acrylicParams: AcrylicParams | null
  private destroyedFlag = false
  /** 板・影のテクスチャを tex.source ごとに共有するキャッシュ (#760)。destroy で解放 */
  private plateCache = new Map<unknown, AcrylicPlate | null>()
  /** 戦闘ログのタイプ表示 (#755)。`off` のとき tracker / ticker は使わない */
  private logTypewriter: BattleLogTypewriterMode
  private logTracker: BattleLogTracker = makeBattleLogTracker()
  private logTicker: Ticker | null = null
  /** 演出方式 (#745)。`ff` は `side` のときだけ。ff の間の再生状態・浮いている数字・窓の言葉は画面が持つ（GameState には持たない） */
  private presentation: BattlePresentation
  private playback: PlaybackState = emptyPlayback()
  /** 取り込み済みの行動の累計数（`BattleState.eventTotal`）。作り直した画面は過去の行動を再生しない */
  private seenEventTotal = 0
  /** 再生が追いつくまで画面に出す HP（key=`party:0` 等）。命中の瞬間に確定値へ進める。再生が空になれば捨てる */
  private hpOverride = new Map<string, number>()
  private popups: DamagePopup[] = []
  /** ダメージ数字の層（敵ラベル層の手前・パネルの奥） */
  private popupLayer: Container | null = null
  /** FF 式メッセージ窓の言葉と、窓（ログ帯）の矩形。layoutSide が更新 */
  private messageText: PixiText | null = null
  private messageRect = { x: 0, y: 0, w: 0, h: 0 }
  private backgroundSprite: Sprite | null = null
  /** side: 敵・味方スプライトの親（奥行き有効時は zIndex で奥→手前に並べる） (#747) */
  private sideStage: Container | null = null
  /** acrylic のとき: 全キャラの影をまとめる層（sideStage の直下・全スプライトより下）(#760) */
  private shadowLayer: Container | null = null
  /** side: 敵の名前・HP ラベルの親 (#747)。前景より手前・パネルより奥（spec どおり、文字（敵ラベル）は前景より手前に置く） */
  private labelLayer: Container | null = null
  /** 前景レイヤー (#747)。スプライトより手前・パネルより奥 */
  private foregroundSprite: Sprite | null = null
  private enemyViews: EntityView[] = []
  private partyViews: EntityView[] = []
  /** side の status 行 (#745): 名前 / HP / MP を列ごとの Text に分け、列の左端（数値は右端）を味方全員でそろえる。同じ index が同じ味方 */
  private statusTexts: PixiText[] = []
  /** HP・MP は「見出し | 現在値 | /最大値」の 3 つの Text。`*Texts` が現在値（右寄せ）、`*Labels` が見出し（左寄せ）、`*Maxes` が「/最大値」（「/」の x で左寄せ）。見出しと「/」の x が全員そろう */
  private statusHpTexts: PixiText[] = []
  private statusMpTexts: PixiText[] = []
  private statusHpLabels: PixiText[] = []
  private statusMpLabels: PixiText[] = []
  private statusHpMaxes: PixiText[] = []
  private statusMpMaxes: PixiText[] = []
  /** ATB ゲージの棒 (#205)。味方ごとに 1 本（side は statusTexts と同じ index、front は 1 本）。ATB でなければ空 */
  private atbBars: Graphics[] = []
  /** 番の味方の印 ▶ (#205)。名前の文字列には混ぜず、行の左余白に別の Text で置く。bars と同じ index */
  private atbMarkers: PixiText[] = []
  /** 各ゲージ棒の矩形（画面絶対）。layout が更新 */
  private atbBarRects: Array<{ x: number; y: number; w: number; h: number }> = []
  /** onClose を 1 回だけ呼ぶためのフラグ（ATB は tick でも戦闘が終わる） */
  private closedFlag = false
  /** tick で表示の全更新（refresh）が要るかを見る前回の署名 (#205) */
  private atbSignature = ''
  private visibleLogLines = LOG_VISIBLE_LINES
  /** side: status 欄の列（layoutSide が更新）。null は未計算 */
  private sideStatusColumns: StatusColumns | null = null
  /** side: 敵ラベルに使える幅(px)（layoutSide が更新。enemyViews と同じ index） */
  private sideLabelWidths: number[] = []

  private dim: Graphics // フィールドを暗くする半透明黒
  private enemyNameText: PixiText
  private enemyHpText: PixiText
  private heroStatsText: PixiText
  /** dark = Graphics（従来どおり）、ff-blue = 子 [帯, mask, 枠] を持つ Container（Pixi 8 の Graphics は子を持てないため） */
  private statsPanel: Container
  private commandPanel: Container
  private logPanel: Container
  /** ff-blue パネルの子 Graphics（帯・mask・枠）。makePanel が 1 組だけ作り、drawPanel が使い回す */
  private ffBlueParts = new WeakMap<
    Container,
    { bands: Graphics; mask: Graphics; frame: Graphics }
  >()
  private logLines: PixiText[] = []
  private commands: CommandButton[] = []
  /** 実際に使うコマンド窓の配置 (#204)。`cross` は `side` のときだけ */
  private commandLayout: CommandLayout
  /** `cross` の矢印キーのリスナー (#204)。destroy で必ず外す */
  private keyListener: ((e: KeyboardEvent) => void) | null = null
  /** 開始時に押されていて、まだ離されていないキー (#204)。keyup で外れる */
  private heldKeys = new Set<string>()
  private keyUpListener: ((e: KeyboardEvent) => void) | null = null
  private blurListener: (() => void) | null = null
  /** 候補窓 (#204)。開いている窓のスタック・開いたときの味方・描画。画面の一時的な状態なので BattleState には持たない */
  private menuEnabled = false
  private menuStack: MenuStack = EMPTY_STACK
  private menuActorIndex = -1
  private menuLayer: BattleMenuLayer | null = null
  private menuGeometry: MenuGeometry | null = null

  constructor(
    engine: BattleEngine,
    screenWidth: number,
    screenHeight: number,
    opts: BattleScreenOptions = {}
  ) {
    super()
    this.engine = engine
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.opts = opts
    this.layoutMode = opts.layout === 'side' ? 'side' : 'front'
    this.spriteStyle = opts.spriteStyle === 'acrylic' ? 'acrylic' : 'none'
    this.windowStyle = opts.windowStyle === 'ff-blue' ? 'ff-blue' : 'dark'
    this.backgroundTone = opts.backgroundTone === 'off' ? 'off' : 'on'
    this.backgroundDof = opts.backgroundDof === 'on' ? 'on' : 'off'
    this.presentation = opts.presentation === 'ff' && this.layoutMode === 'side' ? 'ff' : 'dq'
    // FF 式の窓は一度に全文を出す。1 文字ずつ表示 (#755) は DQ 式のログ用で、ff では使わない
    this.logTypewriter = opts.logTypewriter === 'on' && this.presentation === 'dq' ? 'on' : 'off'
    this.commandLayout =
      opts.commandLayout === 'cross' && this.layoutMode === 'side' ? 'cross' : 'grid'
    this.acrylicParams =
      this.spriteStyle === 'acrylic' ? resolveAcrylicParams(opts.spriteStyleParams) : null

    this.dim = new Graphics()
    this.statsPanel = this.makePanel()
    this.commandPanel = this.makePanel()
    this.logPanel = this.makePanel()
    this.enemyNameText = new PixiText({ text: '', style: this.themedStyle(TEXT_STYLE_NAME) })
    this.enemyHpText = new PixiText({ text: '', style: this.themedStyle(TEXT_STYLE_HP) })
    this.heroStatsText = new PixiText({ text: '', style: this.themedStyle(TEXT_STYLE_HP) })

    this.addChild(this.dim)
    this.addChild(this.enemyNameText)
    this.addChild(this.enemyHpText)
    this.addChild(this.statsPanel)
    this.addChild(this.heroStatsText)
    this.addChild(this.commandPanel)
    this.addChild(this.logPanel)
    if (this.logTypewriter === 'on') {
      // ログ帯のタップでもタイプ中の行を即時表示できる (#755)
      this.logPanel.eventMode = 'static'
      this.logPanel.on('pointertap', () => this.skipLogTyping())
    }
    this.buildCommandButtons()
    this.attachCrossKeys()
    // front のログは固定 4 行。side は layoutSide が必要な行数だけ作る
    if (this.layoutMode === 'front') this.buildLogLines()
    else this.buildSideViews()
    this.buildAtbBars()
    this.buildMenu()
    // 作り直した画面は過去の行動を再生しない（確定した状態から始める）
    this.seenEventTotal = this.engine.getState().eventTotal
    if (opts.background) void this.loadBackground(opts.background)
    if (opts.foreground && this.layoutMode === 'side') void this.loadForeground(opts.foreground)
    this.layout()
    this.refresh()
  }

  /** 透明アクリルの台座テクスチャ (#760)。共有キャッシュ。canvas が使えないときは null（Graphics へフォールバック） */
  protected makeAcrylicBase(): AcrylicBaseTexture | null {
    return this.acrylicParams ? getAcrylicBaseTexture(this.acrylicParams) : null
  }

  /** アクリル板テクスチャを作る (#760)。canvas が使えない・読み出せないときは null（テストで差し替えられるよう分けてある） */
  protected makeAcrylicPlate(tex: Texture): AcrylicPlate | null {
    return this.acrylicParams ? createAcrylicPlateTexture(tex, this.acrylicParams) : null
  }

  /**
   * 同じ画像（tex.source 単位）の板・影は 1 回だけ作って共有する (#760)。同じ敵が複数いても生成と GPU メモリは 1 組。
   * 作れなかった（null）結果も覚えて、同じ画像で作り直さない。解放は destroy でまとめて行う。
   */
  private getAcrylicPlate(tex: Texture): AcrylicPlate | null {
    const key = tex.source
    if (this.plateCache.has(key)) return this.plateCache.get(key) ?? null
    const plate = this.makeAcrylicPlate(tex)
    this.plateCache.set(key, plate)
    return plate
  }

  /**
   * 破棄する。板・影のテクスチャは画面が自前で作ったものなので、TextureSource ごと（GPU・canvas）ここで解放する
   * （Sprite.destroy({texture:true}) は v8 で source を解放しない）。`options` に `texture` は付けないこと:
   * 台座は全画面で共有するキャッシュ、スプライト・背景・前景は Assets のキャッシュのテクスチャで、壊すと他で使えなくなる。
   */
  override destroy(options?: Parameters<Container['destroy']>[0]): void {
    this.destroyedFlag = true
    this.detachCrossKeys()
    this.engine.setAtbHold(false)
    if (this.menuEnabled) this.engine.setAtbWaitScope('command')
    for (const v of [...this.enemyViews, ...this.partyViews]) {
      v.acrylicPlate?.destroy()
      v.acrylicShadow?.destroy()
      v.acrylicShadow = null
      v.acrylicPlate = null
    }
    for (const plate of this.plateCache.values()) {
      plate?.texture.destroy(true)
      plate?.shadow?.destroy(true)
    }
    this.plateCache.clear()
    this.backgroundToneFilter?.destroy()
    this.backgroundToneFilter = null
    this.disposeBackgroundDof()
    this.disposeLogTicker()
    this.popups = []
    this.playback = emptyPlayback()
    super.destroy(options)
  }

  /** 前景画像を読み込み、敵・味方スプライトの直上（パネルより奥）に cover で敷く (#747)。失敗時は何も描かない */
  private async loadForeground(path: string): Promise<void> {
    try {
      const tex = (await Assets.load(resolveRpgImagePath(this.opts.assetBaseUrl, path))) as Texture
      applyBattleTextureFilter(tex, !!this.opts.pixelArt)
      if (this.destroyedFlag || !this.sideStage) return
      const sprite = new Sprite(tex)
      this.foregroundSprite = sprite
      this.addChildAt(sprite, this.getChildIndex(this.sideStage) + 1)
      this.layout()
    } catch (e) {
      console.warn(`[BattleScreen] failed to load foreground "${path}":`, e)
    }
  }

  /** 背景画像を読み込んで cover で敷く (#736)。失敗時は半透明黒のまま */
  private async loadBackground(path: string): Promise<void> {
    try {
      const tex = (await Assets.load(resolveRpgImagePath(this.opts.assetBaseUrl, path))) as Texture
      applyBattleTextureFilter(tex, !!this.opts.pixelArt)
      if (this.destroyedFlag) return
      const sprite = new Sprite(tex)
      this.backgroundSprite = sprite
      this.applyBackgroundTone(sprite)
      this.addChildAt(sprite, 0)
      this.applyBackgroundDof(sprite)
      this.layout()
    } catch (e) {
      console.warn(`[BattleScreen] failed to load background "${path}":`, e)
    }
  }

  /** 背景スプライトにだけ彩度・明度を落とすフィルタをかける (#753)。`off` のときはフィルタ無し。フィルタは 1 個を使い回す */
  private applyBackgroundTone(sprite: Sprite): void {
    if (this.backgroundTone === 'off') {
      sprite.filters = null
      return
    }
    if (!this.backgroundToneFilter) {
      const f = new ColorMatrixFilter()
      f.saturate(saturationToPixiAmount(BACKGROUND_TONE_SATURATION), false)
      f.brightness(BACKGROUND_TONE_BRIGHTNESS, true)
      this.backgroundToneFilter = f
    }
    sprite.filters = [this.backgroundToneFilter]
  }

  /**
   * 背景の手前ぼかし (#753)。背景と同じテクスチャのぼかしコピーを、強さを段階的に変えて DOF_LEVEL_COUNT 枚、
   * 背景の直上へ重ねる（可変半径ガウスの近似）。各段は縦グラデーションのアルファマスク（alpha チャンネル）で
   * 受け持つ帯だけ見せる。背景が差し替わっても積み増さないよう、先に前回分を破棄する。`off` のときは何も作らない。
   * マスクの絵が作れない環境（canvas 不可）では、作った段も含めて 1 段も残さない（ぼかし無しで続行。layout で再試行しない）。
   */
  private applyBackgroundDof(bg: Sprite): void {
    this.disposeBackgroundDof()
    if (this.backgroundDof === 'off') return
    const gs = computeDofLevels(this.screenHeight, DOF_DEFAULT_PARAMS, DOF_LEVEL_COUNT)
    let index = 1
    for (let i = 0; i < DOF_LEVEL_COUNT; i++) {
      const tex = this.createDofMaskTexture(gs[i].rampFraction)
      if (!tex) {
        this.disposeBackgroundDof()
        return
      }
      const q = computeDofQuad(bg.width, bg.height)
      const copy = new Mesh({
        geometry: new MeshGeometry({ positions: q.positions, uvs: q.uvs, indices: q.indices }),
        texture: bg.texture,
      })
      // repeatEdgePixels は padding を 0 にするだけ（端を繰り返す処理ではない）ので使わない。
      // clipToViewport で フィルタ領域が画面端で切れてカーネルが欠けるので、padding を残し viewport クリップも切る
      const blur = new BlurFilter({ strength: 0 })
      blur.clipToViewport = false
      copy.filters = this.backgroundToneFilter ? [this.backgroundToneFilter, blur] : [blur]
      const mask = new Sprite(tex)
      this.addChildAt(copy, index++)
      this.addChildAt(mask, index++)
      copy.setMask({ mask, channel: 'alpha' })
      this.dofLevels.push({
        sprite: copy,
        mask,
        blur,
        maskTexture: tex,
        maskRamp: gs[i].rampFraction,
      })
    }
  }

  /** ぼかしコピー・マスク・フィルタ・マスクのテクスチャを解放する（共有している背景テクスチャは壊さない） */
  private disposeBackgroundDof(): void {
    for (const lv of this.dofLevels) {
      lv.sprite.filters = null
      // Mesh.destroy は geometry を破棄しない（段ごとに作った MeshGeometry の GPU バッファが残る）ので自分で破棄する
      const geo = lv.sprite.geometry
      lv.sprite.destroy()
      geo.destroy()
      lv.mask.destroy()
      lv.blur.destroy()
      // マスクのテクスチャは共有キャッシュ（dofMaskCache.ts）のものなので壊さない
    }
    this.dofLevels = []
  }

  /** 画面サイズに合わせて各段の位置・強さ・フィルタ領域を更新する。立ち上がり割合が変わった段だけマスクの絵を作り直す */
  private layoutBackgroundDof(bg: Sprite, W: number, H: number): void {
    if (this.dofLevels.length === 0) return
    const gs = computeDofLevels(H, DOF_DEFAULT_PARAMS, this.dofLevels.length)
    this.dofLevels.forEach((lv, i) => {
      const g = gs[i]
      lv.sprite.position.copyFrom(bg.position)
      const q = computeDofQuad(bg.width, bg.height)
      lv.sprite.geometry.positions = q.positions
      lv.sprite.geometry.uvs = q.uvs
      lv.blur.strength = g.blurStrength
      // フィルタ領域をその段のマスクが見える帯に絞る（ローカル座標＝背景左上原点。マスクの上端は画面座標 startY）
      const fa = computeDofFilterArea(bg.width, bg.height, g.startY - bg.position.y)
      const area = lv.sprite.filterArea
      if (area instanceof Rectangle) {
        area.x = fa.x
        area.y = fa.y
        area.width = fa.width
        area.height = fa.height
      } else {
        lv.sprite.filterArea = new Rectangle(fa.x, fa.y, fa.width, fa.height)
      }
      if (quantizeDofRamp(g.rampFraction) !== quantizeDofRamp(lv.maskRamp)) {
        const tex = this.createDofMaskTexture(g.rampFraction)
        if (tex) {
          lv.maskTexture = tex
          lv.maskRamp = g.rampFraction
          lv.mask.texture = tex
        }
      }
      lv.mask.position.set(0, g.startY)
      lv.mask.width = W
      lv.mask.height = g.maskHeight
    })
  }

  /** 縦にアルファが 0 → 1 に立ち上がる 1 x N の canvas テクスチャを作る。canvas が使えない環境では null（ぼかし無しで続行） */
  private createDofMaskTexture(rampFraction: number): Texture | null {
    return getSharedDofMask(rampFraction, (ramp) => this.buildDofMaskTexture(ramp))
  }

  private buildDofMaskTexture(rampFraction: number): Texture | null {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = DOF_MASK_TEXTURE_HEIGHT
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      const grad = ctx.createLinearGradient(0, 0, 0, DOF_MASK_TEXTURE_HEIGHT)
      for (const s of dofMaskStops(rampFraction)) {
        grad.addColorStop(s.offset, `rgba(255,255,255,${s.alpha})`)
      }
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, 1, DOF_MASK_TEXTURE_HEIGHT)
      return Texture.from(canvas)
    } catch (e) {
      console.warn('[BattleScreen] failed to build DoF mask texture:', e)
      return null
    }
  }

  /** サイドビュー用の敵・味方スプライトとステータス行を作る (#736) */
  private buildSideViews(): void {
    const s = this.engine.getState()
    // 前面用（正面配置）の表示物は使わない
    this.enemyNameText.visible = false
    this.enemyHpText.visible = false
    this.heroStatsText.visible = false
    const stage = new Container()
    this.sideStage = stage
    // dim の直後（パネル・テキストより下）に差し込む
    this.addChildAt(stage, this.getChildIndex(this.dim) + 1)
    if (this.acrylicParams) {
      // 影は全キャラのスプライトより下の層にまとめる（手前のキャラの影が奥のキャラの上に乗らない）(#760)
      const shadowLayer = new Container()
      this.shadowLayer = shadowLayer
      this.addChildAt(shadowLayer, this.getChildIndex(stage))
    }
    // 敵ラベルは sideStage の直後（前景は loadForeground が sideStage の直後=ラベル層の手前に差し込む）
    const labelLayer = new Container()
    this.labelLayer = labelLayer
    this.addChildAt(labelLayer, this.getChildIndex(stage) + 1)
    if (this.presentation === 'ff') {
      // ダメージ数字は敵ラベルの手前・パネルの奥 (#745)
      const popupLayer = new Container()
      this.popupLayer = popupLayer
      this.addChildAt(popupLayer, this.getChildIndex(labelLayer) + 1)
    }
    for (const e of s.enemies) {
      const view = this.createEntityView(e, FALLBACK_ENEMY_COLOR, true)
      stage.addChild(view.container)
      this.enemyViews.push(view)
    }
    for (const p of s.party) {
      const view = this.createEntityView(p, FALLBACK_PARTY_COLOR, false)
      stage.addChild(view.container)
      this.partyViews.push(view)
    }
    for (let i = 0; i < s.party.length; i++) {
      const t = new PixiText({
        text: '',
        style: this.themedStyle(
          new TextStyle({
            fontFamily: "'Noto Sans JP', sans-serif",
            fontSize: SIDE_STATUS_FONT_SIZE,
            fill: TEXT_COLOR,
          })
        ),
      })
      this.statusTexts.push(t)
      this.addChild(t)
      const parts: Array<[PixiText[], boolean]> = [
        [this.statusHpLabels, false],
        [this.statusHpTexts, true],
        [this.statusHpMaxes, false],
        [this.statusMpLabels, false],
        [this.statusMpTexts, true],
        [this.statusMpMaxes, false],
      ]
      for (const [list, alignRight] of parts) {
        const n = new PixiText({
          text: '',
          style: this.themedStyle(
            new TextStyle({
              fontFamily: "'Noto Sans JP', sans-serif",
              fontSize: SIDE_STATUS_FONT_SIZE,
              fill: TEXT_COLOR,
            })
          ),
        })
        // 数値は列の基準 x に右寄せ（桁数が違っても右端がそろう）。見出しと「/最大値」は左寄せ
        n.anchor.set(alignRight ? 1 : 0, 0)
        list.push(n)
        this.addChild(n)
      }
    }
    if (this.presentation === 'ff') {
      // FF 式メッセージ窓の言葉 (#745)。ログ帯の上に中央寄せで置く。ログ行は ff では使わない
      const m = new PixiText({ text: '', style: this.themedStyle(TEXT_STYLE_LOG) })
      m.anchor.set(0.5, 0.5)
      m.visible = false
      this.messageText = m
      this.addChild(m)
      this.logPanel.visible = false
    }
  }

  private createEntityView(entity: BattleEntity, color: number, withLabel: boolean): EntityView {
    const container = new Container()
    const fallback = new Graphics()
    container.addChild(fallback)
    // acrylic: 台座・影は画像が読み込めるまで出さない（色四角にはかけない）
    // ff では、1 枚絵が無くても idle のポーズがあればそれを基本の絵にする (#745)
    const spritePath =
      entity.sprite ?? (this.presentation === 'ff' ? entity.poses?.idle : undefined)
    let acrylicBack: Graphics | null = null
    if (this.acrylicParams && spritePath) {
      acrylicBack = new Graphics()
      acrylicBack.visible = false
      container.addChild(acrylicBack)
    }
    const label = withLabel
      ? new PixiText({
          text: '',
          style: new TextStyle({
            fontFamily: "'Noto Sans JP', sans-serif",
            fontSize: SIDE_LABEL_FONT_SIZE,
            fill: TEXT_COLOR,
            align: 'center',
            lineHeight: SIDE_LABEL_LINE_HEIGHT,
            stroke: { color: SIDE_LABEL_STROKE_COLOR, width: SIDE_LABEL_STROKE_WIDTH },
            ...(this.windowStyle === 'ff-blue' ? { dropShadow: { ...FF_BLUE_TEXT_SHADOW } } : {}),
          }),
        })
      : null
    if (label) {
      label.anchor.set(0.5, 0)
      // sideStage の外（前景より上の層）へ置く。座標は画面絶対（placeEntityView が更新）
      this.labelLayer?.addChild(label)
    }
    const view: EntityView = {
      container,
      fallback,
      color,
      sprite: null,
      acrylicBack,
      acrylicPlate: null,
      acrylicBase: null,
      acrylicShadow: null,
      acrylicShadowFoot: { x: 0, y: 0 },
      acrylicPlateScale: 1,
      acrylicPlatePad: 0,
      acrylicBaseLayout: null,
      label,
      slotRef: null,
      baseX: 0,
      baseY: 0,
      unit: 0,
      anchorX: 0,
      anchorY: 0,
      labelBaseX: 0,
      labelBaseY: 0,
      shadowBaseX: 0,
      shadowBaseY: 0,
      baseVisual: null,
      shownVisual: null,
      poseVisuals: {},
    }
    if (spritePath) {
      void this.loadEntitySprite(view, spritePath).then(() => {
        if (this.presentation === 'ff' && entity.poses)
          void this.loadPoseVisuals(view, entity.poses)
      })
    }
    return view
  }

  private async loadEntitySprite(view: EntityView, path: string): Promise<void> {
    try {
      const tex = (await Assets.load(resolveRpgImagePath(this.opts.assetBaseUrl, path))) as Texture
      applyBattleTextureFilter(tex, !!this.opts.pixelArt)
      if (this.destroyedFlag || view.container.destroyed) return
      const sprite = new Sprite(tex)
      view.sprite = sprite
      if (view.acrylicBack) {
        // アクリル板 (#760): 長辺 192px の作業解像度で 1 回だけ作り（同じ画像は共有）、mipmap で拡縮してスプライトの直下に敷く。作れない環境では板なし
        let idx = 2
        let basePlate: AcrylicPlate | null = null
        const base = this.makeAcrylicBase()
        if (base) {
          view.acrylicBase = new Sprite(base.texture)
          view.acrylicBaseLayout = base.layout
          view.container.addChildAt(view.acrylicBase, idx++)
        }
        const plate = this.getAcrylicPlate(tex)
        basePlate = plate
        if (plate) {
          const plateSprite = new Sprite(plate.texture)
          view.acrylicPlate = plateSprite
          view.acrylicPlatePad = plate.pad
          view.acrylicPlateScale = plate.scale ?? 1
          if (plate.shadow && this.shadowLayer) {
            const sh = new Sprite(plate.shadow)
            view.acrylicShadow = sh
            view.acrylicShadowFoot = plate.foot ?? { x: 0, y: 0 }
            sh.pivot.set(view.acrylicShadowFoot.x, view.acrylicShadowFoot.y)
            this.shadowLayer.addChild(sh)
          }
          // 板を台座のスリットの高さで水平に切る mask (#760)。v8 では Sprite に子を足せないので、
          // 板の直後の兄弟として置く（座標は container と同じ）
          const mask = new Graphics()
          plateSprite.mask = mask
          view.container.addChildAt(plateSprite, idx++)
          view.container.addChildAt(mask, idx++)
        }
        view.container.addChildAt(sprite, idx)
        view.acrylicBack.visible = true
        view.baseVisual = { texture: tex, plate: basePlate }
      } else {
        view.container.addChildAt(sprite, 1)
        view.baseVisual = { texture: tex, plate: null }
      }
      view.shownVisual = view.baseVisual
      this.layout()
      this.refresh()
    } catch (e) {
      // 失敗時は色四角のまま
      console.warn(`[BattleScreen] failed to load sprite "${path}":`, e)
    }
  }

  redraw(screenWidth: number, screenHeight: number): void {
    this.screenWidth = screenWidth
    this.screenHeight = screenHeight
    this.layout()
    this.refresh()
  }

  /** UI からコマンドが選ばれたとき呼ばれる。エンジン側を進めて refresh */
  private handleCommand(id: CommandId): void {
    // ff（従来ターン制）: 演出が終わるまで次のコマンドは受けない。ATB は時間が流れ続けるので、演出中でも入力でき、
    // 入力した行動は演出キューの末尾に積まれる (#745)
    if (this.isInputBlockedByPresentation()) return
    // タイプ中の 1 タップ目は全文表示だけ（コマンドは実行しない）(#755)。
    // ATB (#205) ではコマンドのタップを skip に使わない（時間が流れていて空振りさせない）。全文表示はログ帯のタップだけ
    if (!this.engine.getState().atb && this.skipLogTyping()) return
    if (this.engine.isOver()) return
    switch (id) {
      case 'attack':
        this.engine.selectAttack()
        break
      case 'escape':
        this.engine.selectEscape()
        break
      case 'spell':
      case 'item':
        // 候補窓 (#204): cross で呪文・アイテムが渡されているときだけ一覧の窓を開く。
        // それ以外は従来どおり識別ログのみ（戦闘エンジン側の log には積まない）
        if (this.openMenu(id)) return
        console.info(`[BattleScreen] command '${id}' は #175 で実装`)
        break
    }
    this.refresh()
    this.closeIfOver()
  }

  /** 戦闘が終わっていれば onClose を 1 回だけ呼ぶ */
  private closeIfOver(): void {
    if (this.closedFlag || !this.engine.isOver()) return
    // ff: 最後の一撃の演出（のけぞり・倒れ・ダメージ数字）を見せ切ってから閉じる (#745)
    if (this.isPresenting() || this.popups.length > 0) return
    this.closedFlag = true
    const outcome = this.engine.getState().phase
    // outcome は victory / defeat / escaped のいずれか（isOver がガード）
    this.opts.onClose?.(outcome as 'victory' | 'defeat' | 'escaped')
  }

  /**
   * 時間を deltaMS 進める (#205)。ATB のときだけ働く（従来ターン制は何もしない）。
   * 時計は持たず、呼び出し側（本編の ticker / サンプルの ticker）が経過時間を渡す。
   * 状態が変わった（ログ・フェーズ・コマンド待ちの顔ぶれ）ときだけ全表示を更新し、毎回ゲージ棒だけ描き直す。
   */
  tick(deltaMS: number): void {
    if (this.destroyedFlag || this.closedFlag) return
    const ff = this.presentation === 'ff'
    const atb = !!this.engine.getState().atb
    if (!ff && !atb) return
    // ff: 演出（行動のモーション・ダメージ数字）を進める。従来ターン制でも時間が要る (#745)
    if (ff) this.advancePresentation(deltaMS)
    if (atb) {
      // ATB は演出の再生中も時間を進める（本家 FF5/6 と同じ）。敵の行動は events に積まれ、演出キューで順に再生される
      this.engine.tick(deltaMS)
      const sig = this.computeAtbSignature()
      if (sig !== this.atbSignature) this.refresh()
      else this.drawAtbBars()
    }
    this.closeIfOver()
  }

  private computeAtbSignature(): string {
    const s = this.engine.getState()
    return `${s.logTotal}|${s.eventTotal}|${s.phase}|${s.atb?.queue.join(',') ?? ''}`
  }

  /** ATB ゲージ棒を作る（ATB のときだけ）。side は味方ごと、front は先頭 1 人ぶん */
  private buildAtbBars(): void {
    if (!this.engine.getState().atb) return
    const n = this.layoutMode === 'side' ? this.engine.getState().party.length : 1
    for (let i = 0; i < n; i++) {
      const g = new Graphics()
      this.atbBars.push(g)
      this.addChild(g)
      const m = new PixiText({
        text: '▶',
        style: this.themedStyle(
          new TextStyle({
            fontFamily: "'Noto Sans JP', sans-serif",
            fontSize: ATB_MARKER_FONT_SIZE,
            fill: ACTOR_COLOR,
          })
        ),
      })
      m.visible = false
      this.atbMarkers.push(m)
      this.addChild(m)
    }
  }

  /** ゲージ棒を描く。満タン（コマンド待ち）は色を変える。倒れた味方は空 */
  private drawAtbBars(): void {
    const atb = this.engine.getState().atb
    if (!atb) return
    const party = this.engine.getState().party
    this.atbBars.forEach((g, i) => {
      const r = this.atbBarRects[i]
      g.clear()
      if (!r) return
      const alive = (party[i]?.hp ?? 0) > 0
      const ratio = alive ? Math.min(1, Math.max(0, (atb.partyGauge[i] ?? 0) / ATB_GAUGE_MAX)) : 0
      g.rect(r.x, r.y, r.w, r.h).fill({ color: ATB_BAR_BG_COLOR, alpha: 0.6 })
      if (ratio > 0) {
        g.rect(r.x, r.y, r.w * ratio, r.h).fill(
          ratio >= 1 ? ATB_BAR_READY_COLOR : ATB_BAR_FILLING_COLOR
        )
      }
      g.rect(r.x, r.y, r.w, r.h).stroke({ color: PANEL_STROKE, width: 1 })
    })
  }

  /** 今コマンドを出す味方の index（ATB のコマンド待ち先頭）。いなければ -1 */
  private actorIndex(): number {
    // 導出はエンジンの getCurrentActorIndex に一本化（表示側で queue[0] を直接読まない）。ATB 以外では印を出さない
    return this.engine.getState().atb ? this.engine.getCurrentActorIndex() : -1
  }

  private buildCommandButtons(): void {
    for (const item of resolveCommandSpecs(this.opts.commandLabels)) {
      const text = new PixiText({ text: item.label, style: this.themedStyle(TEXT_STYLE_COMMAND) })
      const hit = new Container()
      hit.eventMode = 'static'
      hit.cursor = 'pointer'
      hit.on('pointertap', () => this.handleCommand(item.id))
      this.addChild(hit)
      this.addChild(text)
      this.commands.push({ id: item.id, hit, text })
    }
  }

  /** そのコマンドを今選べるか。ATB (#205) ではにげるはゲージが溜まっていなくてもいつでも選べる */
  private isCommandEnabled(id: CommandId): boolean {
    // ff（従来ターン制）: 演出中は選べない (#745)
    if (this.isInputBlockedByPresentation()) return false
    const s = this.engine.getState()
    if (id === 'escape' && s.atb && (s.phase === 'party-input' || s.phase === 'atb-running')) {
      return true
    }
    return s.phase === 'party-input'
  }

  /** `cross` のとき、矢印キー 1 押しでその方向のコマンドを決定するリスナーを付ける (#204)。grid には付けない */
  private attachCrossKeys(): void {
    if (this.commandLayout !== 'cross' || typeof globalThis.addEventListener !== 'function') return
    this.heldKeys = new Set(this.opts.initialHeldKeys ?? [])
    this.keyListener = (e: KeyboardEvent) => {
      if (this.destroyedFlag || this.closedFlag) return
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      // フォーム部品の矢印キー操作（select の選択変更・入力のカーソル移動など）は奪わない
      if (isEditableTarget(e.target)) return
      // 設定オーバーレイなど外側の UI が入力を止めている間は戦闘のキー操作を無視する
      if (this.opts.isInputSuspended?.()) return
      // 候補窓が開いている間は、キーを窓の操作に使う（コマンドの決定には使わない）
      if (this.menuStack.length > 0) {
        this.handleMenuKey(e)
        return
      }
      const id = crossKeyToCommandId(e.key)
      if (!id) return
      // cross が有効な間は、コマンドを選べない局面でもページのスクロールを止める
      e.preventDefault()
      if (e.repeat) return
      // 戦闘開始時に押されていたキーは、一度離されるまで無視する
      if (isHeldKeyBlocked(this.heldKeys, e.key)) return
      if (!this.isCommandEnabled(id)) return
      this.handleCommand(id)
    }
    this.keyUpListener = (e: KeyboardEvent) => {
      this.heldKeys.delete(e.key)
    }
    globalThis.addEventListener('keydown', this.keyListener)
    globalThis.addEventListener('keyup', this.keyUpListener)
    // ウィンドウがフォーカスを失うと keyup が届かないので、押下状態を捨てる
    this.blurListener = () => this.heldKeys.clear()
    globalThis.addEventListener('blur', this.blurListener)
  }

  private detachCrossKeys(): void {
    if (this.keyListener) globalThis.removeEventListener('keydown', this.keyListener)
    if (this.keyUpListener) globalThis.removeEventListener('keyup', this.keyUpListener)
    if (this.blurListener) globalThis.removeEventListener('blur', this.blurListener)
    this.keyListener = null
    this.keyUpListener = null
    this.blurListener = null
  }

  private buildLogLines(): void {
    this.setLogLineCount(LOG_VISIBLE_LINES)
  }

  /** ログ行テキストの数を n に揃える（足りなければ作り、余れば破棄する） */
  private setLogLineCount(n: number): void {
    while (this.logLines.length < n) {
      const text = new PixiText({ text: '', style: this.themedStyle(TEXT_STYLE_LOG) })
      this.logLines.push(text)
      this.addChild(text)
    }
    while (this.logLines.length > n) {
      this.logLines.pop()?.destroy()
    }
    this.visibleLogLines = n
  }

  /**
   * ff-blue のとき文字スタイルに黒い影を足す (#744)。dark も含め常に clone する:
   * 共有 TextStyle（モジュール定数）を直接使うと、fill の書き換えが他のテキストや次の BattleScreen に漏れる（汚染）ため。
   */
  private themedStyle(base: TextStyle): TextStyle {
    const style = base.clone()
    if (this.windowStyle === 'ff-blue') style.dropShadow = { ...FF_BLUE_TEXT_SHADOW }
    return style
  }

  /**
   * パネル 1 枚を描く (#744)。dark は従来の半透明黒の角丸矩形。ff-blue は帯状グラデーション（横縞の rect を
   * 上から積む）を、同じ角丸矩形の mask で切り抜き、その上に同形の白枠を重ねる。寸法・半径・枠線はどちらも同じ。
   * ff-blue の g は Container で、子 [帯, mask, 枠] を持つ（枠を mask の外に置くのは、枠の外側半分が切れないようにするため）。
   * 子は makePanel が 1 組だけ作って使い回す（再描画で mask が積み増されない）。
   */
  private drawPanel(container: Container, x: number, y: number, w: number, h: number): void {
    const parts = this.ffBlueParts.get(container)
    if (parts) {
      parts.mask.clear().roundRect(x, y, w, h, PANEL_RADIUS).fill({ color: 0xffffff })
      parts.bands.clear()
      for (const band of computeBands(h)) {
        parts.bands
          .rect(x, y + band.y, w, band.h)
          .fill({ color: band.color, alpha: FF_BLUE_PANEL_ALPHA })
      }
      parts.frame
        .clear()
        .roundRect(x, y, w, h, PANEL_RADIUS)
        .stroke({ color: PANEL_STROKE, width: 2 })
      return
    }
    const g = container as Graphics
    g.clear()
    g.roundRect(x, y, w, h, PANEL_RADIUS)
      .fill({ color: PANEL_BG, alpha: PANEL_BG_ALPHA })
      .stroke({ color: PANEL_STROKE, width: 2 })
  }

  /** パネルの入れ物を作る。dark は Graphics、ff-blue は描画順 帯 → 枠（mask は描画されない）の子を持つ Container */
  private makePanel(): Container {
    if (this.windowStyle !== 'ff-blue') return new Graphics()
    const container = new Container()
    const bands = new Graphics()
    const mask = new Graphics()
    const frame = new Graphics()
    bands.mask = mask
    container.addChild(bands, mask, frame)
    this.ffBlueParts.set(container, { bands, mask, frame })
    return container
  }

  private layout(): void {
    const W = this.screenWidth
    const H = this.screenHeight
    const panelW = W - STAGE_PADDING * 2

    // 背景画像が読み込めていれば cover で敷き、暗くする半透明黒は使わない (#736)
    if (this.backgroundSprite) {
      const tex = this.backgroundSprite.texture
      const fit = computeCoverFit(tex.width, tex.height, W, H)
      this.backgroundSprite.position.set(fit.x, fit.y)
      this.backgroundSprite.width = fit.width
      this.backgroundSprite.height = fit.height
      this.layoutBackgroundDof(this.backgroundSprite, W, H)
      this.dim.clear()
    } else {
      // フィールド全体を暗くする半透明黒
      this.dim.clear().rect(0, 0, W, H).fill({ color: 0x000000, alpha: BG_DIM_ALPHA })
    }

    if (this.layoutMode === 'side') {
      this.layoutSide()
      return
    }

    // 敵スプライト領域: 上半分の中央。スプライトは未実装、名前と HP テキストだけ
    this.enemyNameText.anchor.set(0.5, 0)
    this.enemyNameText.x = W / 2
    this.enemyNameText.y = H * 0.15
    this.enemyHpText.anchor.set(0.5, 0)
    this.enemyHpText.x = W / 2
    this.enemyHpText.y = H * 0.15 + NAME_FONT_SIZE + 8

    // 縦積み構成: 下から ログ → コマンド → HP/MP の 3 段。
    // 9:16 縦長スマホ (W=360 程度) でもコマンドが画面幅をはみ出さない構造。
    const logY = H - LOG_HEIGHT - STAGE_PADDING
    const commandY = logY - PANEL_GAP - COMMAND_HEIGHT
    const statsY = commandY - PANEL_GAP - STATS_HEIGHT

    // HP/MP パネル
    this.drawPanel(this.statsPanel, STAGE_PADDING, statsY, panelW, STATS_HEIGHT)
    this.heroStatsText.x = STAGE_PADDING + 12
    this.heroStatsText.y = statsY + (STATS_HEIGHT - HP_FONT_SIZE) / 2
    if (this.atbBars.length > 0) {
      // 棒はパネルの下端に左右の文字余白ぶん内側で行幅いっぱい（文字の下に置くので重ならない）
      this.atbBarRects = [
        {
          x: STAGE_PADDING + 12,
          y: statsY + STATS_HEIGHT - ATB_BAR_HEIGHT - 1,
          w: Math.max(0, panelW - 24),
          h: ATB_BAR_HEIGHT,
        },
      ]
      const m = this.atbMarkers[0]
      m.x = STAGE_PADDING + ATB_MARKER_INSET
      m.y = statsY + (STATS_HEIGHT - ATB_MARKER_FONT_SIZE) / 2
      this.drawAtbBars()
    }

    // コマンドパネル（4 コマンドを画面幅で均等割）
    this.drawPanel(this.commandPanel, STAGE_PADDING, commandY, panelW, COMMAND_HEIGHT)
    // commands.length は固定 4。万一 0 になっても div by zero しないよう max(1) でガード
    const cmdW = panelW / Math.max(1, this.commands.length)
    for (let i = 0; i < this.commands.length; i++) {
      const node = this.commands[i]
      const cellX = STAGE_PADDING + i * cmdW
      node.hit.hitArea = new Rectangle(cellX, commandY, cmdW, COMMAND_HEIGHT)
      node.text.anchor.set(0.5, 0.5)
      node.text.x = cellX + cmdW / 2
      node.text.y = commandY + COMMAND_HEIGHT / 2
    }

    // ログパネル（画面最下部）
    this.drawPanel(this.logPanel, STAGE_PADDING, logY, panelW, LOG_HEIGHT)
    for (let i = 0; i < this.logLines.length; i++) {
      const text = this.logLines[i]
      text.x = STAGE_PADDING + 12
      text.y = logY + 8 + i * (LOG_FONT_SIZE + 4)
    }
  }

  /** サイドビューの配置 (#736)。座標は battleLayout.ts の純粋関数が正本 */
  private layoutSide(): void {
    const s = this.engine.getState()
    const L = computeSideBattleLayout({
      width: this.screenWidth,
      height: this.screenHeight,
      partyCount: s.party.length,
      enemyCount: s.enemies.length,
      commandCount: this.commands.length,
      commandLayout: this.commandLayout,
      partyRows: s.party.map((p) => p.row),
      // 敵の立ち絵の縦横比 (#760)。未読み込み・色四角は undefined（正方形扱い）
      enemyAspects: this.enemyViews.map((v) => this.layoutAspect(v)),
      depth: this.opts.depth,
    })
    const panel = (r: { x: number; y: number; w: number; h: number }, g: Container) =>
      this.drawPanel(g, r.x, r.y, r.w, r.h)
    const slotRect = (sl: SpriteSlot) => ({ x: sl.x, y: sl.y, w: sl.width, h: sl.size })
    this.menuGeometry = {
      width: this.screenWidth,
      height: this.screenHeight,
      command: L.command,
      top: L.log.y + L.log.h + SIDE_GAP,
      enemySlots: L.enemies.map(slotRect),
      partySlots: L.party.map(slotRect),
    }

    // ログ帯（上）
    panel(L.log, this.logPanel)
    this.setLogLineCount(L.logLines)
    for (let i = 0; i < this.logLines.length; i++) {
      const text = this.logLines[i]
      text.x = L.log.x + 12
      text.y = L.log.y + 8 + i * SIDE_LOG_LINE_HEIGHT
      // ff（FF 式）ではログ行を使わない。窓には言葉だけを中央寄せで出す (#745)
      if (this.presentation === 'ff') text.visible = false
    }
    this.messageRect = { x: L.log.x, y: L.log.y, w: L.log.w, h: L.log.h }

    // 敵・味方スプライト
    for (let i = 0; i < this.enemyViews.length; i++) {
      this.placeEntityView(this.enemyViews[i], L.enemies[i])
    }
    for (let i = 0; i < this.partyViews.length; i++) {
      this.placeEntityView(this.partyViews[i], L.party[i])
    }
    // 奥行き (#747): 床の基準 y の昇順（奥→手前）で重ねる。平面のときは従来どおり挿入順
    if (this.sideStage) {
      this.sideStage.sortableChildren = L.depthActive
      this.enemyViews.forEach((v, i) => {
        v.container.zIndex = L.depthActive ? (L.enemies[i]?.floor ?? 0) : 0
      })
      this.partyViews.forEach((v, i) => {
        v.container.zIndex = L.depthActive ? (L.party[i]?.floor ?? 0) : 0
      })
    }
    // 前景レイヤー (#747)
    if (this.foregroundSprite) {
      const tex = this.foregroundSprite.texture
      const fit = computeCoverFit(tex.width, tex.height, this.screenWidth, this.screenHeight)
      this.foregroundSprite.position.set(fit.x, fit.y)
      this.foregroundSprite.width = fit.width
      this.foregroundSprite.height = fit.height
    }

    // 下パネル: コマンド（左）
    panel(L.command, this.commandPanel)
    // 全コマンド共通で、いちばん狭いセルに最長ラベルが収まるフォントサイズにする
    const minCellW = L.commandCells.reduce((m, c) => Math.min(m, c.w), Infinity)
    const cmdFont = fitCommandFontSize(
      minCellW,
      this.commands.map((c) => c.text.text),
      COMMAND_FONT_SIZE,
      SIDE_COMMAND_TEXT_PADDING
    )
    for (let i = 0; i < this.commands.length; i++) {
      const cell = L.commandCells[i]
      const node = this.commands[i]
      node.hit.hitArea = new Rectangle(cell.x, cell.y, cell.w, cell.h)
      node.text.style.fontSize = cmdFont
      node.text.anchor.set(0.5, 0.5)
      node.text.x = cell.x + cell.w / 2
      node.text.y = cell.y + cell.h / 2
    }

    // 下パネル: 味方 HP/MP（右）
    panel(L.status, this.statsPanel)
    // 列（名前 / HP / MP / ゲージ）は味方全員で共通。列の左端（数値は右端）がそろう (#745)
    const party = this.engine.getState().party
    const cols = computeStatusColumns({
      x: L.status.x,
      width: L.status.w,
      maxHp: party.reduce((m, p) => Math.max(m, p.maxHp), 0),
      maxMp: party.reduce((m, p) => Math.max(m, p.maxMp), 0),
      compact: L.statusCompact,
      atb: this.atbBars.length > 0,
    })
    this.sideStatusColumns = cols
    for (let i = 0; i < this.statusTexts.length; i++) {
      const row = L.statusRows[i]
      const y = row.y + (row.h - SIDE_STATUS_FONT_SIZE) / 2
      this.statusTexts[i].x = cols.name.x
      this.statusTexts[i].y = y
      const place = (
        col: typeof cols.hp | null,
        label: PixiText,
        cur: PixiText,
        max: PixiText
      ): void => {
        label.x = col?.x ?? 0
        cur.x = col?.curRight ?? 0
        // 「/最大値」は「/」を現在値の右端に接して左寄せ（実フォントの桁幅の誤差で隙間があかない）
        max.x = col?.curRight ?? 0
        label.y = cur.y = max.y = y
      }
      place(cols.hp, this.statusHpLabels[i], this.statusHpTexts[i], this.statusHpMaxes[i])
      place(cols.mp, this.statusMpLabels[i], this.statusMpTexts[i], this.statusMpMaxes[i])
    }
    if (this.atbBars.length > 0 && cols.gauge) {
      // ATB ゲージは行の右端に短く置く（数文字ぶんの幅）。文字の列は ATB off と同じ処理で、ゲージのぶんだけ名前列が狭くなる
      const g = cols.gauge
      this.atbBarRects = L.statusRows.map((row) => ({
        x: g.x,
        y: row.y + (row.h - SIDE_STATUS_GAUGE_HEIGHT) / 2,
        w: g.w,
        h: SIDE_STATUS_GAUGE_HEIGHT,
      }))
      L.statusRows.forEach((row, i) => {
        const m = this.atbMarkers[i]
        if (!m) return
        m.x = row.x + ATB_MARKER_INSET
        m.y = row.y + (row.h - ATB_MARKER_FONT_SIZE) / 2
      })
      this.drawAtbBars()
    }
    this.sideLabelWidths = L.enemies.map((e) => e.label?.w ?? 0)
    if (this.presentation === 'ff') {
      this.updateMessageWindow()
      this.applyMotionFrame()
    }
  }

  /**
   * 枠の配置に使う立ち絵の縦横比。ポーズ差し替えで texture が変わっても枠の配置が動かないよう、
   * 1 枚絵（基本の絵）の比で固定する (#745)。未読み込み・色四角は undefined
   */
  private layoutAspect(v: EntityView): number | undefined {
    const tex = v.baseVisual?.texture ?? v.sprite?.texture
    return tex && tex.height > 0 ? tex.width / tex.height : undefined
  }

  /**
   * ポーズの絵の置き場所 (#745)。基本の絵を枠に収めた矩形 `baseRect` の縮尺（基本の絵 1px あたり何px か）を、
   * どのポーズでも同じに使い、足元（下端中央）を基本の絵に揃える。幅が違うポーズ（横広の slash など）も
   * 枠に収め直さず、はみ出しは許容する（クリップしない）。基本の絵そのものなら `baseRect` と同じ矩形を返す。
   */
  private poseRectOnBase(
    baseRect: { x: number; y: number; width: number; height: number },
    baseTex: Texture,
    tex: Texture
  ): { x: number; y: number; width: number; height: number } {
    if (tex === baseTex || baseTex.width <= 0 || baseTex.height <= 0) return baseRect
    const k = baseRect.width / baseTex.width
    const width = tex.width * k
    const height = tex.height * k
    return {
      x: baseRect.x + baseRect.width / 2 - width / 2,
      y: baseRect.y + baseRect.height - height,
      width,
      height,
    }
  }

  private placeEntityView(view: EntityView, slot: SpriteSlot | undefined): void {
    if (!slot) return
    view.slotRef = slot
    const size = slot.size
    // 味方 (#760) は縦長の枠（width < size）。acrylic は正方形 size の中央に置くので、container を左へ寄せて枠の中央に合わせる
    // 横長の敵 (#760) は枠の幅が高さより大きいので、正方形はその幅（長辺）にして下端を枠の下端に揃える
    const acrylic = !!(this.acrylicParams && view.acrylicBack && view.sprite)
    let box = acrylic ? Math.max(size, slot.width) : size
    // 味方の枠は固定の基準縦横比 (#813)。枠より横に広い絵は、アクリルの正方形ごと縮めて枠の幅に収める（足元中央は不変）
    // 縦長の絵（a<=1）は箱の幅いっぱいまで使えるので縮めない。a>1 のとき箱の幅は a でなく 1 を基準にする
    const isParty = this.partyViews.includes(view)
    if (acrylic && isParty && view.sprite) {
      const tex = view.baseVisual?.texture ?? view.sprite.texture
      const a = tex.height > 0 ? tex.width / tex.height : 0
      if (a > 0) box = Math.min(box, slot.width / Math.min(1, a))
    }
    view.baseX = acrylic ? slot.x - (box - slot.width) / 2 : slot.x
    view.baseY = acrylic ? slot.y + size - box : slot.y
    view.unit = size
    view.anchorX = slot.x + slot.width / 2
    // ダメージ数字の出る高さ: 既定は枠の上端から 35%。味方は配置後に、実際の絵の矩形の上端から 35% へ置き直す（下）
    view.anchorY = slot.y + size * 0.35
    view.container.position.set(view.baseX, view.baseY)
    const fb = computeFallbackRect(box)
    const fbX = acrylic ? fb.x : slot.width * (fb.x / size)
    const fbW = acrylic ? fb.w : slot.width * (fb.w / size)
    view.fallback.clear().rect(fbX, fb.y, fbW, fb.h).fill(view.color)
    if (view.sprite) {
      if (this.acrylicParams && view.acrylicBack) {
        this.placeAcrylic(view, box)
        if (isParty) view.anchorY = view.baseY + view.sprite.y + view.sprite.height * 0.35
      } else {
        // 縮尺は基本の絵を枠に収めたときのものを全ポーズで共通に使い、足元（下端中央）を基本の絵に揃える (#745)
        const baseTex = view.baseVisual?.texture ?? view.sprite.texture
        const fit = computeContainFitRect(baseTex.width, baseTex.height, slot.width, size)
        const r = this.poseRectOnBase(fit, baseTex, view.sprite.texture)
        view.sprite.position.set(r.x, r.y)
        view.sprite.width = r.width
        view.sprite.height = r.height
        if (isParty) view.anchorY = slot.y + fit.y + fit.height * 0.35
      }
      view.fallback.visible = false
    }
    if (view.label) {
      // ラベル位置は純粋関数が返す矩形（画面絶対）。縮尺・位置の追従は slot に含まれる。置けない枠では隠す
      view.label.visible = !!slot.label
      if (slot.label) {
        view.labelBaseX = slot.label.x + slot.label.w / 2
        view.labelBaseY = slot.label.y
        view.label.x = view.labelBaseX
        view.label.y = view.labelBaseY
      }
    }
  }

  /**
   * acrylic のスプライト 1 体を配置する (#737・#760)。幾何は純粋関数 computeAcrylicGeometry が正本で、
   * ここは結果を各パーツへ反映するだけ。
   * - スプライト: 幾何どおりの位置・大きさ。
   * - 台座・影: 共有テクスチャ（無ければ acrylicBack の Graphics）。台座の側面の厚みは幾何が下に予約済み。
   * - 板: スプライトと同じ倍率（作業解像度ぶんを掛けて）で、pad ぶん外へ広げて敷く。台座のスリットの高さ
   *   （computeSlitY）で水平に切る mask（板の兄弟 Graphics）を更新する。
   * - 地面の影: shadowLayer（画面基準）に、足元を基点とした変形（computeShadowTransform）で敷く。
   * スプライト本体と台座・影は slot 枠の内側に収まる。板は余白+線ぶん（pad）だけ枠の外へ広がる。
   * `size` は正方形の一辺（横長の敵は枠の長辺）。
   */
  private placeAcrylic(view: EntityView, size: number): void {
    const params = this.acrylicParams
    const sprite = view.sprite
    const back = view.acrylicBack
    if (!params || !sprite || !back) return
    // 幾何（台座・影・縮尺）は基本の絵で決め、ポーズの絵は同じ縮尺で足元を揃えて置く (#745)
    const baseTex = view.baseVisual?.texture ?? sprite.texture
    const g0 = computeAcrylicGeometry(baseTex.width, baseTex.height, size, params)
    const g = { ...g0, sprite: this.poseRectOnBase(g0.sprite, baseTex, sprite.texture) }
    sprite.position.set(g.sprite.x, g.sprite.y)
    sprite.width = g.sprite.width
    sprite.height = g.sprite.height
    back.clear()
    const baseSprite = view.acrylicBase
    if (baseSprite && view.acrylicBaseLayout) {
      // 透明アクリルの台座と柔らかい影 (#760): 高解像度の共有テクスチャを縮小して敷く。影の幅が幾何の影に一致する
      const L = view.acrylicBaseLayout
      const ref = g.shadow
      baseSprite.visible = !!(g.base && ref)
      if (g.base && ref) {
        const k = ref.rx / L.shadowRx
        baseSprite.scale.set(k)
        baseSprite.position.set(g.base.cx - L.cx * k, g.base.cy - L.cyTop * k)
      }
    } else {
      if (g.shadow) {
        back
          .ellipse(g.shadow.cx, g.shadow.cy, g.shadow.rx, g.shadow.ry)
          .fill({ color: 0x000000, alpha: params.shadowAlpha })
      }
      if (g.base) {
        back.ellipse(g.base.cx, g.base.cy, g.base.rx, g.base.ry).fill(ACRYLIC_BASE_COLOR)
      }
      if (g.highlight) {
        back
          .ellipse(g.highlight.cx, g.highlight.cy, g.highlight.rx, g.highlight.ry)
          .fill({ color: 0xffffff, alpha: params.highlightAlpha })
      }
    }
    const plate = view.acrylicPlate
    if (plate) {
      // 板はスプライトと同じ倍率で縮小する（縮小した解像度で作った板を mipmap 付きで拡縮）。外へ pad ぶん広がる
      const k = sprite.texture.width > 0 ? g.sprite.width / sprite.texture.width : 0
      const ks = k * view.acrylicPlateScale
      plate.scale.set(ks)
      plate.position.set(
        g.sprite.x - view.acrylicPlatePad * ks,
        g.sprite.y - view.acrylicPlatePad * ks
      )
      plate.visible = k > 0 && g.linePx > 0 && params.lineAlpha > 0
      // 板は台座に差し込まれているので、スリットの高さより下は見えない。スリットと同じ純粋関数の値で水平に切る (#760)。
      // スプライト本体の足元はクリップしない（mask は板だけ）
      const mask = (plate.mask ?? null) as Graphics | null
      if (mask) {
        const w = plate.texture.width * ks
        const fullH = plate.texture.height * ks
        // 台座が無い（hasBase=false）・縮尺 0 のときは切らない。mask は container 座標
        const clipY = g.base ? computeSlitY(g.base.cy, g.base.ry) : Infinity
        const h = ks > 0 ? Math.min(fullH, Math.max(0, clipY - plate.y)) : fullH
        mask.clear().rect(plate.x, plate.y, w, h).fill(0xffffff)
      }
    }
    const shadow = view.acrylicShadow
    if (shadow) {
      // 本体の影 (#760): 足元（スプライト下端の中央）を基点に、縦につぶして右へ傾ける。座標は shadowLayer（= 画面）基準
      const k = sprite.texture.width > 0 ? g.sprite.width / sprite.texture.width : 0
      const t = computeShadowTransform(params, k * view.acrylicPlateScale)
      shadow.scale.set(t.scaleX, t.scaleY)
      shadow.skew.x = t.skewX
      // 基準位置はモーションのずれを足す前の値（container.x は動いていることがある）。ずれは applyMotionFrame が足す (#745)
      view.shadowBaseX = view.baseX + g.sprite.x + g.sprite.width / 2
      view.shadowBaseY = view.baseY + g.sprite.y + g.sprite.height + g.liftPx
      shadow.position.set(view.shadowBaseX, view.shadowBaseY)
      shadow.visible = k > 0 && params.castAlpha > 0
    }
    // 画像のある枠だけ台座・影を出す（読み込み前・失敗時は色四角のまま）
    back.visible = true
  }

  /** サイドビューのテキスト・生死表示を更新する (#736) */
  private refreshSide(): void {
    const s = this.engine.getState()
    const ff = this.presentation === 'ff'
    for (let i = 0; i < this.enemyViews.length; i++) {
      const e0 = s.enemies[i]
      const view = this.enemyViews[i]
      if (!e0) continue
      // ff では、演出が命中の瞬間まで進むまで古い HP を見せる (#745)。生死の見た目（alpha）は applyMotionFrame が決める
      const e = ff ? { ...e0, hp: this.shownHp('enemy', i, e0.hp) } : e0
      if (!ff) {
        view.container.alpha = e.hp > 0 ? 1 : DEAD_ALPHA
        if (view.acrylicShadow) view.acrylicShadow.alpha = view.container.alpha
      }
      if (view.label) {
        // ff では applyMotionFrame が本体と同じ薄れを当てる
        if (!ff) view.label.alpha = e.hp > 0 ? 1 : DEAD_ALPHA
        // 純粋関数が返すラベル幅（1 列は領域幅まで・上限は一辺の SIDE_LABEL_MAX_WIDTH_RATIO 倍、
        // 多列は列ピッチ=スプライト一辺）を越える名前は省略して隣と重ねない
        // 縁取りは文字の両側にはみ出すので、そのぶん（左右 2 本）を最大幅から引く
        const w = Math.max(0, (this.sideLabelWidths[i] ?? 0) - SIDE_LABEL_STROKE_WIDTH * 2)
        view.label.text =
          `${fitLabel(e.name, w, SIDE_LABEL_FONT_SIZE)}\n` +
          fitHpLabel(e.hp, e.maxHp, w, SIDE_LABEL_FONT_SIZE)
      }
    }
    for (let i = 0; i < this.partyViews.length; i++) {
      const p = s.party[i]
      if (!p || ff) continue
      this.partyViews[i].container.alpha = p.hp > 0 ? 1 : DEAD_ALPHA
      const sh = this.partyViews[i].acrylicShadow
      if (sh) sh.alpha = this.partyViews[i].container.alpha
    }
    for (let i = 0; i < this.statusTexts.length; i++) {
      const p0 = s.party[i]
      if (!p0) continue
      const p = ff ? { ...p0, hp: this.shownHp('party', i, p0.hp) } : p0
      const t = this.statusTexts[i]
      const cols = this.sideStatusColumns
      const hpT = this.statusHpTexts[i]
      const mpT = this.statusMpTexts[i]
      // ATB: 今コマンドを出す番の味方は色を変え、左余白に別 Text の ▶ を出す（名前の文字列には混ぜない） (#205)
      const isActor = p.hp > 0 && i === this.actorIndex()
      if (this.atbMarkers[i]) this.atbMarkers[i].visible = isActor
      // 名前だけ省略して HP/MP は必ず見せる（列幅は layoutSide が最長の数値から決める）
      this.fitStatusName(t, p.name, cols?.name.w ?? Infinity)
      const lbl = cols?.showLabels ?? true
      const showMaxHp = cols?.showMaxHp ?? true
      this.statusHpLabels[i].text = lbl ? 'HP' : ''
      hpT.text = `${p.hp}`
      this.statusHpMaxes[i].text = showMaxHp ? `/${p.maxHp}` : ''
      // MP 列がない（狭い画面）ときは 3 つとも空にして隠す
      const hasMp = !!cols?.mp
      this.statusMpLabels[i].text = hasMp && lbl ? 'MP' : ''
      mpT.text = hasMp ? `${p.mp}` : ''
      this.statusMpMaxes[i].text = hasMp ? `/${p.maxMp}` : ''
      for (const n of [this.statusMpLabels[i], mpT, this.statusMpMaxes[i]]) n.visible = hasMp
      const fill = p.hp <= 0 ? 0x888888 : isActor ? ACTOR_COLOR : TEXT_COLOR
      for (const n of [this.statusHpLabels[i], hpT, this.statusHpMaxes[i]]) n.style.fill = fill
      for (const n of [this.statusMpLabels[i], mpT, this.statusMpMaxes[i]]) n.style.fill = fill
      t.style.fill = fill
    }
  }

  /**
   * 名前を列幅に収める。まず概算幅で詰め、そのあと実測の幅（Text.width）が列幅を超えるなら
   * 末尾をさらに詰め直す（英字など概算と実幅がずれる名前が HP 列に食い込まない）。
   * 実測できない環境（jsdom など）や NaN のときは概算のまま。
   */
  private fitStatusName(t: PixiText, name: string, maxWidth: number): void {
    let budget = maxWidth
    t.text = fitLabel(name, budget, SIDE_STATUS_FONT_SIZE)
    if (!Number.isFinite(maxWidth)) return
    // ff-blue の文字影（右下へずれる）ぶんも列に食い込ませない
    const shadow = this.windowStyle === 'ff-blue' ? FF_BLUE_TEXT_SHADOW.distance : 0
    for (let n = 0; n < 40 && budget > 0; n++) {
      let w = 0
      try {
        w = t.width
      } catch {
        return
      }
      if (!Number.isFinite(w) || w <= maxWidth - shadow + 0.5) return
      budget = Math.max(0, budget - Math.max(1, w - maxWidth + shadow))
      t.text = fitLabel(name, budget, SIDE_STATUS_FONT_SIZE)
    }
  }

  /** タイプ表示 (#755): tracker の表示分をログ行へ反映する */
  private updateLogTexts(): void {
    const tail = visibleBattleLogTail(this.logTracker, this.visibleLogLines)
    for (let i = 0; i < this.logLines.length; i++) {
      this.logLines[i].text = tail[i] ?? ''
    }
  }

  /** タイプ中だけ ticker を回し、終われば止める (#755) */
  private syncLogTicker(): void {
    if (this.destroyedFlag) return
    if (isBattleLogTyping(this.logTracker)) {
      if (!this.logTicker) {
        const ticker = new Ticker()
        ticker.add(() => {
          this.logTracker = tickBattleLog(this.logTracker, ticker.deltaMS, BATTLE_LOG_MS_PER_CHAR)
          this.updateLogTexts()
          if (!isBattleLogTyping(this.logTracker)) this.logTicker?.stop()
        })
        this.logTicker = ticker
      }
      if (!this.logTicker.started) this.logTicker.start()
    } else {
      this.logTicker?.stop()
    }
  }

  private disposeLogTicker(): void {
    this.logTicker?.destroy()
    this.logTicker = null
  }

  /** タイプ中なら全文を即時表示する。表示を進めたら true (#755) */
  private skipLogTyping(): boolean {
    if (this.logTypewriter !== 'on' || !isBattleLogTyping(this.logTracker)) return false
    this.logTracker = skipBattleLog(this.logTracker)
    this.updateLogTexts()
    this.syncLogTicker()
    return true
  }

  /** エンジン状態を読み取り、テキストを更新する */
  private refresh(): void {
    const s = this.engine.getState()
    if (this.presentation === 'ff') this.syncPresentation()
    if (this.layoutMode === 'side') this.refreshSide()
    const aliveEnemy: BattleEntity | undefined = s.enemies.find((e) => e.hp > 0) ?? s.enemies[0]
    if (aliveEnemy) {
      this.enemyNameText.text = aliveEnemy.name
      this.enemyHpText.text = `HP ${aliveEnemy.hp}/${aliveEnemy.maxHp}`
      this.enemyHpText.style.fill = aliveEnemy.hp > 0 ? HP_COLOR : 0x666666
    }
    const hero: BattleEntity | undefined = s.party[0]
    if (hero) {
      const isActor = hero.hp > 0 && this.actorIndex() === 0
      if (this.layoutMode === 'front' && this.atbMarkers[0]) this.atbMarkers[0].visible = isActor
      this.heroStatsText.text = `${hero.name}  HP ${hero.hp}/${hero.maxHp}  MP ${hero.mp}/${hero.maxMp}`
      this.heroStatsText.style.fill = hero.hp <= 0 ? 0x888888 : isActor ? ACTOR_COLOR : TEXT_COLOR
    }
    // ログ末尾 visibleLogLines 件（front は LOG_VISIBLE_LINES、side は layoutSide が決めた行数）
    if (this.presentation === 'ff') {
      // FF 式: ログ行は使わない（ダメージや「〇〇のこうげき！」を文で出さない）。窓は updateMessageWindow が決める
    } else if (this.logTypewriter === 'on') {
      this.logTracker = syncBattleLog(this.logTracker, s.log, s.logTotal)
      this.updateLogTexts()
      this.syncLogTicker()
    } else {
      const tail = s.log.slice(-this.visibleLogLines)
      for (let i = 0; i < this.logLines.length; i++) {
        this.logLines[i].text = tail[i] ?? ''
      }
    }
    // 暫定: コマンド入力不可なら見た目で示す（alpha 半分）
    // ATB (#205): にげるはゲージが溜まっていなくても（誰もコマンド待ちでなくても）いつでも選べる
    for (const cmd of this.commands) {
      const enabled = this.isCommandEnabled(cmd.id)
      cmd.hit.alpha = enabled ? 1 : 0.4
      cmd.text.alpha = enabled ? 1 : 0.4
      cmd.hit.eventMode = enabled ? 'static' : 'none'
    }
    this.atbSignature = this.computeAtbSignature()
    this.drawAtbBars()
    if (this.presentation === 'ff') {
      this.updateMessageWindow()
      this.applyMotionFrame()
    }
    this.syncMenu()
  }

  // ===== 候補窓 (#204) =====

  /** cross で呪文・アイテムが渡されているときだけ候補窓を有効にし、ATB の wait を「候補窓を開いている間だけ停止」にする */
  private buildMenu(): void {
    const m = this.opts.menu
    const hasData =
      !!m && ((m.items?.length ?? 0) > 0 || Object.values(m.spells ?? {}).some((l) => l.length > 0))
    this.menuEnabled = this.commandLayout === 'cross' && hasData
    if (!this.menuEnabled) {
      // 同じエンジンを使い回す作り直しで、前の画面の設定を持ち越さない
      this.engine.setAtbWaitScope('command')
      return
    }
    this.menuLayer = new BattleMenuLayer({
      makePanel: () => this.makePanel(),
      drawPanel: (c, x, y, w, h) => this.drawPanel(c, x, y, w, h),
      textStyle: () => this.themedStyle(TEXT_STYLE_COMMAND),
      onRowTap: (i) => {
        const ctx = this.menuContext()
        if (!ctx) return
        this.setMenuStack(setListCursor(this.menuStack, i, ctx))
        this.confirmMenu()
      },
      onTargetTap: (side: TargetSide, i: number) => {
        const ctx = this.menuContext()
        if (!ctx) return
        this.setMenuStack(setTargetCursor(this.menuStack, side, i, ctx))
        this.confirmMenu()
      },
      onScroll: (delta) => {
        const ctx = this.menuContext()
        if (ctx) this.setMenuStack(scrollList(this.menuStack, delta, ctx))
      },
      onCancelTap: () => this.cancelMenu(),
    })
    this.addChild(this.menuLayer)
    this.engine.setAtbWaitScope('menu')
  }

  private menuEntries(
    kind: MenuKind,
    actor: BattleEntity | undefined
  ): ReadonlyArray<BattleSpellEntry | BattleItemEntry> {
    if (kind === 'spell') return (actor && this.opts.menu?.spells?.[actor.id]) || []
    return this.opts.menu?.items ?? []
  }

  /** 窓の操作に使う局面。開いたときの味方（スタックが空なら今の番の味方）の一覧を引く。窓を作れない局面は null */
  private menuContext(kind?: MenuKind): MenuContext | null {
    if (!this.menuEnabled) return null
    const s = this.engine.getState()
    const open = this.menuStack[0]
    const k = open?.kind ?? kind
    if (!k) return null
    const actorIndex = open ? this.menuActorIndex : this.engine.getCurrentActorIndex()
    const actor = s.party[actorIndex]
    if (!actor) return null
    const entries = this.menuEntries(k, actor)
    return {
      rows: buildMenuRows(k, entries, actor),
      maxRows: this.menuGeometry ? listMaxRows(this.menuGeometry) : 1,
      entries,
      party: s.party,
      enemies: s.enemies,
      actorIndex,
    }
  }

  /** 「じゅもん」「どうぐ」で一覧の窓を開く。開けたら true（候補がない・窓を出せないときは false） */
  private openMenu(kind: MenuKind): boolean {
    if (this.menuStack.length > 0) return true
    const ctx = this.menuContext(kind)
    if (!ctx) return false
    const next = openList(this.menuStack, kind, ctx)
    if (next === this.menuStack) return false
    this.menuActorIndex = ctx.actorIndex
    this.setMenuStack(next)
    return true
  }

  private setMenuStack(stack: MenuStack): void {
    this.menuStack = stack
    // ATB の wait: 候補窓を開いている間だけ時間を止める（本家 FF5/6 どおり）
    this.engine.setAtbHold(stack.length > 0)
    this.updateMenuLayer()
  }

  private cancelMenu(): void {
    this.setMenuStack(cancelMenuWindow(this.menuStack))
  }

  private handleMenuKey(e: KeyboardEvent): void {
    const act = menuKeyAction(e.key)
    if (!act) return
    e.preventDefault()
    if (act.type === 'move') {
      const ctx = this.menuContext()
      if (ctx) this.setMenuStack(moveMenuCursor(this.menuStack, act.dir, ctx))
      return
    }
    if (e.repeat) return
    if (act.type === 'confirm') this.confirmMenu()
    else this.cancelMenu()
  }

  private confirmMenu(): void {
    if (this.isInputBlockedByPresentation() || this.engine.isOver()) return
    const ctx = this.menuContext()
    if (!ctx) return
    const r = confirmMenuWindow(this.menuStack, ctx)
    if (r.action) {
      this.setMenuStack(r.stack)
      this.executeMenuAction(r.action, ctx)
      return
    }
    if (r.blocked === 'disabled') {
      // グレーの行は選べない。MP 不足の呪文はエンジンの「MPが たりない！」（ログと吹き出し）で知らせる。窓は閉じない
      const w = this.menuStack[this.menuStack.length - 1]
      const entry = w?.type === 'list' ? ctx.entries[w.cursor] : undefined
      // MP が足りないときだけ（対象なしの呪文などは、エンジンに渡すと唱えてしまうので何もしない）
      const actor = this.engine.getState().party[ctx.actorIndex]
      if (w?.type === 'list' && w.kind === 'spell' && entry && actor) {
        if (actor.mp < (entry as BattleSpellEntry).mp) {
          this.engine.selectSpell(entry as BattleSpellEntry)
          this.refresh()
        }
      }
      return
    }
    this.setMenuStack(r.stack)
  }

  private executeMenuAction(action: MenuAction, ctx: MenuContext): void {
    const entry = ctx.entries[action.entryIndex]
    if (entry) {
      if (action.kind === 'spell') {
        this.engine.selectSpell(entry as BattleSpellEntry, action.targetId)
      } else {
        this.engine.selectItem(entry as BattleItemEntry, action.targetId)
      }
    }
    this.refresh()
    this.closeIfOver()
  }

  /**
   * 番が変わった・戦闘が終わったなど、窓を開いたままにできない局面では窓を閉じる。
   * 判定はエンジンの確定した状態で行う。ff 演出中は画面の HP 表示が演出に追いつくまで古いことがあるが
   * （hpOverride）、窓の開閉には影響せず、数字が遅れて更新されるだけ（既知の制約）
   */
  private syncMenu(): void {
    if (this.menuStack.length > 0) {
      const s = this.engine.getState()
      const actor = s.party[this.menuActorIndex]
      const valid =
        !this.engine.isOver() &&
        s.phase === 'party-input' &&
        !!actor &&
        actor.hp > 0 &&
        this.engine.getCurrentActorIndex() === this.menuActorIndex
      if (!valid) {
        this.menuStack = EMPTY_STACK
        this.engine.setAtbHold(false)
      }
    }
    this.updateMenuLayer()
  }

  private updateMenuLayer(): void {
    if (!this.menuLayer) return
    const ctx = this.menuStack.length > 0 ? this.menuContext() : null
    // 画面サイズ変更で見える行数が変わったら、先頭行・カーソルを窓に収め直す
    if (ctx) this.menuStack = refitList(this.menuStack, ctx)
    const view =
      ctx && this.menuGeometry ? buildMenuView(this.menuStack, ctx, this.menuGeometry) : []
    this.menuLayer.update(view, this.screenWidth, this.screenHeight)
    // 他の表示物（ログ行など）が後から足されても、窓は常に最前面
    this.addChild(this.menuLayer)
  }

  // ===== 演出 (#745) =====

  private entityKey(side: 'party' | 'enemy', index: number): string {
    return `${side}:${index}`
  }

  /** 演出が追いつくまで画面に出す HP。命中の瞬間より前は古い値（再生中でなければ確定値） */
  private shownHp(side: 'party' | 'enemy', index: number, current: number): number {
    return this.hpOverride.get(this.entityKey(side, index)) ?? current
  }

  /** ff の従来ターン制だけ、演出が終わるまで入力を塞ぐ。ATB は演出中も入力できる */
  private isInputBlockedByPresentation(): boolean {
    return this.isPresenting() && !this.engine.getState().atb
  }

  /** 再生すべきものが残っているか。従来ターン制では残っている間、次の行動・コマンド入力を待たせる（ATB は待たせない） */
  private isPresenting(): boolean {
    return this.presentation === 'ff' && isPlaybackBusy(this.playback)
  }

  /** エンジンが新しく積んだ行動を再生キューに取り込む。対象の HP は命中の瞬間まで古い値を見せる */
  private syncPresentation(): void {
    const s = this.engine.getState()
    const added = s.eventTotal - this.seenEventTotal
    if (added <= 0) return
    this.seenEventTotal = s.eventTotal
    const fresh = s.events.slice(Math.max(0, s.events.length - added))
    for (const ev of fresh) {
      for (const hit of ev.hits) {
        const key = this.entityKey(hit.target.side, hit.target.index)
        if (!this.hpOverride.has(key)) this.hpOverride.set(key, hit.hpBefore)
      }
    }
    this.playback = enqueueEvents(this.playback, fresh)
  }

  /**
   * 演出を dt ms 進める。命中の瞬間に HP 表示を確定値へ進め、ダメージ数字を出す。
   * 再生が空になったら古い HP の控えを捨てる（以降はエンジンの確定値）。
   */
  private advancePresentation(dt: number): void {
    const wasBusy = isPlaybackBusy(this.playback)
    if (!wasBusy && this.popups.length === 0) return
    const r = advancePlayback(this.playback, dt)
    this.playback = r.state
    let changed = false
    for (const fire of r.fires) {
      for (const hit of fire.event.hits) {
        this.hpOverride.set(this.entityKey(hit.target.side, hit.target.index), hit.hpAfter)
        this.spawnPopup(hit, fire.sinceHit)
      }
      changed = true
    }
    this.advancePopups(dt)
    if (!isPlaybackBusy(this.playback)) {
      if (this.hpOverride.size > 0) this.hpOverride.clear()
      if (wasBusy) changed = true // コマンドの有効・無効、生死の見た目を確定値で整え直す
    }
    if (changed) this.refresh()
    else {
      this.updateMessageWindow()
      this.applyMotionFrame()
    }
  }

  private viewOf(side: 'party' | 'enemy', index: number): EntityView | undefined {
    return (side === 'party' ? this.partyViews : this.enemyViews)[index]
  }

  /** 対象の位置にダメージ数字を出す（ダメージ白・回復緑・ミスは MISS）。命中から sinceHit ms 経っていたぶん進める */
  private spawnPopup(hit: BattleHit, sinceHit: number): void {
    const view = this.viewOf(hit.target.side, hit.target.index)
    if (!view || !this.popupLayer) return
    const text = new PixiText({
      text: popupText(hit),
      style: new TextStyle({
        fontFamily: "'Noto Sans JP', sans-serif",
        fontSize: popupFontSize(view.unit),
        fontWeight: 'bold',
        fill: POPUP_COLORS[hit.kind],
        stroke: { color: 0x000000, width: 4 },
      }),
    })
    text.anchor.set(0.5, 1)
    text.position.set(view.anchorX, view.anchorY)
    this.popupLayer.addChild(text)
    this.popups.push({
      text,
      elapsed: Math.max(0, sinceHit),
      side: hit.target.side,
      index: hit.target.index,
      x: view.anchorX,
      y: view.anchorY,
      unit: view.unit,
    })
    this.updatePopup(this.popups[this.popups.length - 1])
  }

  private updatePopup(p: DamagePopup): boolean {
    const s = sampleDamagePopup(p.elapsed)
    // redraw で枠が動いたら新しい座標へ移す
    const view = this.viewOf(p.side, p.index)
    if (view && view.unit > 0) {
      p.x = view.anchorX
      p.y = view.anchorY
      p.unit = view.unit
    }
    p.text.position.set(p.x, p.y + s.dy * p.unit)
    p.text.alpha = s.alpha
    return s.done
  }

  private advancePopups(dt: number): void {
    this.popups = this.popups.filter((p) => {
      p.elapsed += dt
      const done = this.updatePopup(p)
      if (done) p.text.destroy({ style: true })
      return !done
    })
  }

  /** FF 式メッセージ窓: 再生中の行動に名前（呪文・アイテム）があるときだけ、窓の中央に一度に全文で出す。通常攻撃は窓ごと出さない */
  private updateMessageWindow(): void {
    const m = this.messageText
    if (!m) return
    const word = messageWindowText(this.playback.active?.event.label)
    this.logPanel.visible = word !== null
    m.visible = word !== null
    if (word === null) return
    const r = this.messageRect
    m.text = fitLabel(word, Math.max(0, r.w - 24), LOG_FONT_SIZE)
    m.position.set(r.x + r.w / 2, r.y + r.h / 2)
  }

  /** 1 体の、いまの演出上の姿（前後のずれ・ポーズ・倒れの進み具合）を導く */
  private sampleEntity(side: 'party' | 'enemy', index: number): TargetSample & { forward: number } {
    const s = this.engine.getState()
    const ent = (side === 'party' ? s.party : s.enemies)[index]
    const hp = this.shownHp(side, index, ent?.hp ?? 0)
    // 戦闘が終わったとき、勝った側の生き残りは victory ポーズ（味方の勝ち=victory / 敵の勝ち=defeat）
    // とどめの演出が終わってから（再生中は他の味方が先に勝ちポーズにならない）
    const won =
      !isPlaybackBusy(this.playback) &&
      (side === 'party' ? s.phase === 'victory' : s.phase === 'defeat')
    let out: TargetSample & { forward: number } = {
      ...restingSample({ down: hp <= 0, victory: won && hp > 0 }),
      forward: 0,
    }
    const active = this.playback.active
    if (!active) return out
    const ev = active.event
    if (ev.actor.side === side && ev.actor.index === index) {
      const a = sampleActor(ev.kind, active.elapsed)
      out = { ...out, forward: a.forward, pose: out.downProgress > 0 ? out.pose : a.pose }
    }
    for (const hit of ev.hits) {
      if (hit.target.side !== side || hit.target.index !== index || hit.kind !== 'damage') continue
      const sinceHit = active.elapsed - eventTimeline(ev).hitAt
      if (sinceHit < 0) continue
      const t = sampleTarget('damage', sinceHit, hit.hpAfter <= 0)
      out = { ...out, recoil: t.recoil, pose: t.pose, downProgress: t.downProgress }
    }
    return out
  }

  /**
   * 全員のいまの姿を container・影・スプライトの絵に反映する。位置は placeEntityView が置いた基準位置にずれを足す
   * （アクスタの板・台座は container の子なので一緒に動く。地面の影は別層なので同じ横ずれを足す）。
   */
  private applyMotionFrame(): void {
    if (this.presentation !== 'ff') return
    const apply = (side: 'party' | 'enemy', views: EntityView[]) => {
      views.forEach((view, index) => {
        if (!view.slotRef) return
        const m = this.sampleEntity(side, index)
        // ポーズの絵に差し替える。無ければ 1 枚絵のまま（down は無ければ沈み込みで表す）
        const resolved = resolvePose(m.pose, view.poseVisuals)
        const vis = resolved?.value ?? view.baseVisual
        const hasDownVisual = m.pose === 'down' && resolved?.pose === 'down'
        if (vis && vis !== view.shownVisual) this.showVisual(view, vis)
        // 前（相手陣営）は味方が左・敵が右。のけぞりは逆向き
        const dir = side === 'party' ? -1 : 1
        // 横のずれは、動いた後の枠（板・台座のはみ出し込み）が画面端から余白を引いた範囲に収まるよう止める
        const slot = view.slotRef
        const pad = view.unit * MOTION_EXTENT_PAD
        const rawDx = (m.forward * dir - m.recoil * dir) * view.unit
        const dx = clampMotionDx(
          rawDx,
          slot.x - pad,
          slot.x + slot.width + pad,
          MOTION_SCREEN_MARGIN,
          this.screenWidth - MOTION_SCREEN_MARGIN
        )
        const dy = hasDownVisual ? 0 : m.downProgress * SINK_DISTANCE * view.unit
        view.container.position.set(view.baseX + dx, view.baseY + dy)
        // 倒れた絵があるなら味方は不透明のまま（敵は他と同じく薄くする）。無ければ沈みながら薄くする
        const fade = side === 'party' && hasDownVisual ? 0 : m.downProgress
        view.container.alpha = 1 - (1 - DEAD_ALPHA) * fade
        // 敵の名前・HP ラベルも本体の横ずれと薄れに追従させる (#745)
        if (view.label) {
          view.label.position.set(view.labelBaseX + dx, view.labelBaseY)
          view.label.alpha = view.container.alpha
        }
        const sh = view.acrylicShadow
        if (sh) {
          sh.position.set(view.shadowBaseX + dx, view.shadowBaseY)
          sh.alpha = view.container.alpha
        }
      })
    }
    apply('enemy', this.enemyViews)
    apply('party', this.partyViews)
  }

  /** スプライトの絵（と acrylic の板・影）を差し替えて、その絵で置き直す */
  private showVisual(view: EntityView, vis: PoseVisual): void {
    if (!view.sprite) return
    view.shownVisual = vis
    view.sprite.texture = vis.texture
    if (view.acrylicPlate && vis.plate) {
      view.acrylicPlate.texture = vis.plate.texture
      view.acrylicPlatePad = vis.plate.pad
      view.acrylicPlateScale = vis.plate.scale ?? 1
      if (view.acrylicShadow && vis.plate.shadow) {
        view.acrylicShadow.texture = vis.plate.shadow
        view.acrylicShadowFoot = vis.plate.foot ?? { x: 0, y: 0 }
        view.acrylicShadow.pivot.set(view.acrylicShadowFoot.x, view.acrylicShadowFoot.y)
      }
    }
    this.placeEntityView(view, view.slotRef ?? undefined)
  }

  /** ポーズ別の絵を読み込む。読めなかったポーズは無いものとして扱う（1 枚絵のまま） */
  private async loadPoseVisuals(
    view: EntityView,
    poses: NonNullable<BattleEntity['poses']>
  ): Promise<void> {
    // ポーズの画像は並列に読む。読めなかったポーズは無いものとして扱う
    await Promise.allSettled(
      (Object.entries(poses) as [BattlePose, string][]).map(async ([key, path]) => {
        try {
          const tex = (await Assets.load(
            resolveRpgImagePath(this.opts.assetBaseUrl, path)
          )) as Texture
          applyBattleTextureFilter(tex, !!this.opts.pixelArt)
          if (this.destroyedFlag || view.container.destroyed) return
          const plate = view.acrylicBack ? this.getAcrylicPlate(tex) : null
          view.poseVisuals[key] = { texture: tex, plate }
        } catch (e) {
          console.warn(`[BattleScreen] failed to load pose "${key}" "${path}":`, e)
        }
      })
    )
    if (this.destroyedFlag || view.container.destroyed) return
    this.applyMotionFrame()
  }
}
