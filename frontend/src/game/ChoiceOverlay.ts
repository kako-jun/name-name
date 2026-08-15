/**
 * 選択肢UI (#146)
 *
 * PixiJS の Container 内にボタン（Graphics + Text）を縦並びで表示する。
 * ホバーでスケール拡大＋影、クリックで確定音＋選択コールバックを呼ぶ。
 *
 * 4 種類のスタイルバリエーション:
 *   - default:    現行ベースの濃紺＋淡い水色枠。動画用途で違和感なく使える落ち着き
 *   - soft:       パステルピンクの子供向け。柔らかい角丸＋太字
 *   - monochrome: 黒地白枠白文字のシリアス系。Noto Serif JP
 *   - pixel:      黒地＋白/暖色枠のドット絵系 (#562)。角丸なしの単純な直角矩形 (#569)
 *
 * pixi-filters への依存は避けるため、影は半透明黒の矩形を背面に重ねて表現する。
 *
 * キーボード操作 (#633 フェーズB): TitleScreenOverlay（#633 フェーズA）で確立した
 * Tab/Shift+Tab・ArrowUp/ArrowDown でのフォーカス移動・Enter/Space での確定・独立レイヤーの
 * `Graphics` 枠線による visible focus 表示というパターンを踏襲する。ChoiceOverlay 固有の事情
 * （可変個数・`[選択: 列=N]` グリッド配置 #508・条件付きロック #591・#339 スクロール可能リスト）
 * に合わせて拡張し、グリッド時は ArrowUp/ArrowDown が同じ列内、ArrowLeft/ArrowRight が同じ行内の
 * 移動になる。ロック済み選択肢はフォーカス移動の対象から除外する（TitleScreenOverlay の disabled
 * ボタン除外と同じ扱い）。フォーカスがビューポート外の行に移動したときはドラッグ/ホイールと同じ
 * `scrollOffset` を使ってスクロールし追従する（`handleKeyDown()` 参照）。
 */

import {
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text as PixiText,
  TextStyle,
  Ticker,
} from 'pixi.js'
import { ChoiceOption } from '../types'
import type { AudioManager } from './AudioManager'
import { hasOwn } from './ownProperty'
import type { DestroyOptions, FederatedPointerEvent, Texture } from 'pixi.js'
import {
  computeChoiceGridLayout,
  computeChoiceIconLayout,
  resolveAssetUrl,
  resolveChoiceIconKind,
} from './novelLayout'
import type { LayoutRect } from './novelLayout'

const BUTTON_WIDTH = 480
const BUTTON_HEIGHT = 52
const BUTTON_GAP = 16
/**
 * 選択肢アイコン (#598 追記3: 既読=完了 `assets/images/read-icon.webp` / 未読
 * `assets/images/unread-icon.webp`) の一辺サイズ (px)。どちらも同じサイズで描画する。
 * アイコン固有の設定（位置・複数アイコン等）はスコープ外 (#598 追記2) のため、
 * サイズも固定値のみを持つ。
 */
const ICON_SIZE = 18
/** アイコンとラベルテキストの縦ギャップ (px)。`computeChoiceIconLayout` に渡す。 */
const ICON_TEXT_GAP = 8
/**
 * アイコンを表示する回だけ使うボタン高さ (px)。通常の BUTTON_HEIGHT (52) だとアイコン+テキストの
 * 2段組みがボタン枠に収まらないため、実際にアイコン（既読=read-icon / 未読=unread-icon の
 * どちらか）が1つでも描画される show() 呼び出しでだけ `layoutButtonHeight` をこちらへ切り替える
 * （`layoutButtonWidth` が region 指定時だけ BUTTON_WIDTH から切り替わるのと同じ「必要な回だけ
 * 調整する」流儀）。read-icon.webp/unread-icon.webp が両方とも未配置のプロジェクトや、
 * その回に描画対象の行が無ければ BUTTON_HEIGHT のまま——見た目は一切変わらない。
 */
const BUTTON_HEIGHT_WITH_ICON = 68
const HOVER_SCALE = 1.05
const SHADOW_OFFSET = 4
const SHOW_FADE_MS = 240
const SHOW_STAGGER_MS = 18
const MAX_SHOW_STAGGER_MS = 260
const VIEWPORT_VERTICAL_MARGIN = 24
const TAP_MOVE_THRESHOLD_PX = 8
/**
 * split_layout (#442 self-review should-5) でテキスト領域に選択肢を収めるときの内側余白 (px)。
 * BUTTON_WIDTH (480px) はテキスト領域より広いことがある（例: 16:9 800x450 の左右分割は
 * 各領域幅400px）ため、region 指定時はボタン幅をこの余白を引いた領域幅にクランプする。
 * region 未指定（従来の全画面）のときは触れず、BUTTON_WIDTH のまま非破壊。
 */
const CHOICE_REGION_MARGIN_X = 24
/** クランプ後のボタン幅の下限 (px)。極端に狭い領域でもラベルが読めなくなるほど潰さない。 */
const CHOICE_REGION_MIN_BUTTON_WIDTH = 160
/**
 * グリッド配置 (#508) の列間ギャップ (px)。行間は既存の BUTTON_GAP をそのまま流用し、
 * 列間だけ独立の定数として持つ（現状は同値だが、将来グリッド専用に調整できるよう分けておく）。
 */
const GRID_COLUMN_GAP = BUTTON_GAP
/**
 * グリッド配置時、画面（または split_layout region）端からの安全マージン (px)。
 * CHOICE_REGION_MARGIN_X と同じ値だが、グリッドは region 未指定（全画面）でも列数に応じて
 * ボタン幅を画面幅へ収める必要があるため、region の有無に関わらず適用する。
 */
const GRID_HORIZONTAL_MARGIN = 24
/** キーボードフォーカスの visible focus 表示 (#633)。TitleScreenOverlay と同じ配色・太さで、
 *  マウス hover の bg 塗り替えとは独立した別レイヤーの枠線として描く。 */
const COLOR_FOCUS_RING = 0xfacc15 // yellow-400
const FOCUS_RING_WIDTH = 3
const FOCUS_RING_INSET = 4
/**
 * グリッドボタン幅は「利用可能幅に N 列（脚本 `[選択: 列=N]` の指定どおり）を必ず収める」
 * ことを最優先する（docs/spec/markdown-v0.1.md 参照: 「列数が増えるほどボタン幅は…自動的に
 * 狭くなる」）。fitWidth = 利用可能幅ちょうどに N 列を敷き詰めたときの1ボタン幅であり、
 * これが「収まる」ことを満たす唯一の値（これより広げると必ずはみ出す）。
 *
 * #508 実バグ: 当初は下限 100px でクランプしていたが、fitWidth がそれを下回る組み合わせ
 * （例: 800px 画面で列8・10択、split_layout 有効時の列5 など）で `N * 100px + gap` が
 * 利用可能幅を超えてはみ出していた。列数を自動で減らす案は「指定した N 列になる」という
 * 仕様の約束と矛盾するため採らず、下限クランプ自体を撤廃して fitWidth をそのまま使う
 * （列数が多いほどボタンは細くなるが、必ず利用可能幅に収まる）。
 */
export type ChoiceStyleName = 'default' | 'soft' | 'monochrome' | 'pixel'

interface ChoiceTheme {
  fillNormal: number
  fillHover: number
  fillRead: number
  fillReadHover: number
  /**
   * 条件付きロック (#591) の配色。`alreadyRead`（既読/未読の色分け）とは別の見た目にする
   * ため専用フィールドを持つ——ロックはホバー無し（クリック自体を受け付けない）なので
   * hover バリエーションは持たない。
   */
  fillLocked: number
  /**
   * 完了(クリア済み)視覚状態 (#594) の配色。`fillLocked` と並行するが意味が異なる——
   * こちらはクリック可能なまま見た目だけ暗くする（ろうそくの火が消えた後の状態）ため、
   * ロックほど強く沈めない中間的な暗さにする。ロックと同じくホバーバリエーションは
   * 持たない（クリック可能ではあるが、既読/未読同様ホバーで明るく戻さず一貫して暗いまま
   * にすることで「クリア済み」であることを常に視認できるようにする）。
   */
  fillCleared: number
  borderNormal: number
  borderHover: number
  borderRead: number
  borderReadHover: number
  borderLocked: number
  borderCleared: number
  borderWidth: number
  textColor: number
  textReadColor: number
  textLockedColor: number
  textClearedColor: number
  fontFamily: string
  fontWeight: 'normal' | 'bold'
  fontSize: number
  radius: number
  shadowColor: number
  shadowAlpha: number
}

interface ChoiceVisual {
  fill: number
  border: number
  text: number
}

const STYLE_THEMES: Record<ChoiceStyleName, ChoiceTheme> = {
  default: {
    fillNormal: 0x1a1a2e,
    fillHover: 0x16213e,
    fillRead: 0x2f3542,
    fillReadHover: 0x3d4658,
    // ロック中 (#591): read よりさらに暗く沈ませ、「まだ選べない」を read（既読/未読）とは
    // 別の見た目で示す。ホバー変化は無い（クリック自体を受け付けないため）。
    fillLocked: 0x121218,
    // 完了中 (#594、should対応): lockedの寒色(青黒)とは対照的に、火が消えた直後の
    // ろうそくを思わせる暖色寄りの暗い焦茶にして、暗さの近さに頼らず色相でも判別できるようにする。
    fillCleared: 0x241f16,
    borderNormal: 0xa8dadc,
    borderHover: 0xf1faee,
    borderRead: 0x9aa4b2,
    borderReadHover: 0xd1d5db,
    borderLocked: 0x555566,
    // 完了枠 (#594、should対応): 寒色のborderLockedと分かれるよう、燻んだ真鍮色(暖色)に寄せる。
    borderCleared: 0xa88f6e,
    borderWidth: 2,
    textColor: 0xf1faee,
    textReadColor: 0xcbd5e1,
    textLockedColor: 0x6b7280,
    textClearedColor: 0xb8a890,
    fontFamily: "'Noto Sans JP', sans-serif",
    fontWeight: 'bold',
    fontSize: 20,
    radius: 8,
    shadowColor: 0x000000,
    shadowAlpha: 0.45,
  },
  // 子供向けバリエーション。パステルピンクで丸み強め＋太字
  soft: {
    fillNormal: 0xffe5ec,
    fillHover: 0xffd1dc,
    fillRead: 0xe8e1f0,
    fillReadHover: 0xded5ec,
    fillLocked: 0xd8d3dc,
    // 完了中 (#594、should対応・luma逆転修正): lockedの寒色寄りラベンダーグレー(luma 213.5)
    // から離した暖色ベージュピンクにしつつ、locked より明確に明るくする(luma 225.0、diff +11.5)。
    // 「押せない」より「押せる」が暗く見えていた逆転を、色相分離を保ったまま解消する。
    fillCleared: 0xf2ddc9,
    borderNormal: 0xffb3c1,
    borderHover: 0xff8fa3,
    borderRead: 0xb8a8ca,
    borderReadHover: 0x9d8bb8,
    borderLocked: 0xb0a8b8,
    // 完了枠 (#594、should対応・luma逆転修正): borderLocked(luma 172.2)の寒色グレーから
    // 離れたテラコッタ寄りを保ちつつ、locked より明るくする(luma 184.1、diff +11.9)。
    borderCleared: 0xdbae91,
    borderWidth: 3,
    textColor: 0x5d2952,
    textReadColor: 0x5d536b,
    textLockedColor: 0x8b8394,
    // 完了文字 (#594、should対応・luma逆転修正): 文字色は視認性に直結するため特に重要。
    // textLocked(luma 135.3)の暖褐色トーンを保ちつつ明確に明るくする(luma 150.7、diff +15.4)。
    textClearedColor: 0xb08f7c,
    fontFamily: "'Noto Sans JP', sans-serif",
    fontWeight: 'bold',
    fontSize: 22,
    radius: 24,
    shadowColor: 0xff8fa3,
    shadowAlpha: 0.35,
  },
  // モノクロ＝シリアス系。明朝で可読性を上げる
  monochrome: {
    fillNormal: 0x000000,
    fillHover: 0x222222,
    fillRead: 0x2a2a2a,
    fillReadHover: 0x3a3a3a,
    fillLocked: 0x0a0a0a,
    // 完了中 (#594、should対応): 元々 locked より暗い値になっており「押せない」より暗いのは
    // 逆転していた。lockedより明るく、かつわずかに暖色を混ぜた炭色にして色相でも区別する
    // （モノクロ系のシリアストーンは保ちつつ、純粋なグレーではなくする）。
    fillCleared: 0x1a1512,
    borderNormal: 0xffffff,
    borderHover: 0xffffff,
    borderRead: 0x888888,
    borderReadHover: 0xbbbbbb,
    borderLocked: 0x555555,
    borderCleared: 0xb8a99a,
    borderWidth: 2,
    textColor: 0xffffff,
    textReadColor: 0xbdbdbd,
    textLockedColor: 0x666666,
    textClearedColor: 0xb8ac9c,
    fontFamily: "'Noto Serif JP', serif",
    fontWeight: 'normal',
    fontSize: 20,
    radius: 0,
    shadowColor: 0xffffff,
    shadowAlpha: 0.15,
  },
  // ドット絵系 (#562)。Gymnasia 向け: 青は端末/遠隔AIの識別色として予約されているため使わない。
  // 黒地＋白枠を基本に、ホバーはろうそくの灯りを思わせる薄黄〜橙のアクセントを付ける。
  // フォントはこのプレイヤー側で DotGothic16 を読み込んでいる箇所が無いため monospace にフォールバック
  // （docs/design 側の決定は 'DotGothic16, monospace'。読み込み箇所ができたら揃える）。
  // #569: ノッチ付きフレームを撤去し角丸なしの単純な直角矩形に変更。影も不要なため shadowAlpha=0。
  // borderWidth も default/monochrome と同じ 2 に揃える（追加要望）。
  pixel: {
    fillNormal: 0x000000,
    fillHover: 0x241800,
    fillRead: 0x1a1a1a,
    fillReadHover: 0x2a2416,
    fillLocked: 0x0d0d0d,
    // 完了中 (#594、should対応): 元々 locked より暗い値になっており「押せない」より暗いのは
    // 逆転していた。lockedより明るく、ホバーのろうそく色(0xffd280)を大きく暗く落とした
    // 燃え殻色にして、他themeと揃えて暖色側で区別する。
    fillCleared: 0x1f150a,
    borderNormal: 0xffffff,
    borderHover: 0xffd280,
    borderRead: 0x888888,
    borderReadHover: 0xd9a86c,
    borderLocked: 0x4a4a4a,
    borderCleared: 0xb89868,
    borderWidth: 2,
    textColor: 0xffffff,
    textReadColor: 0xc9c2b0,
    textLockedColor: 0x5a5a5a,
    textClearedColor: 0xbfa980,
    fontFamily: 'monospace',
    fontWeight: 'bold',
    fontSize: 20,
    radius: 0,
    shadowColor: 0xffd280,
    shadowAlpha: 0,
  },
}

/**
 * style 名からテーマを解決する (#146)。
 * 未指定 / 空文字 / 未知値はすべて `default` フォールバック。
 * 未知値のときのみ console.warn を出して typo に気付けるようにする
 * （null / undefined / "" / "default" は警告なし）。
 *
 * 単独 export しているのはユニットテスト用途。
 */
export function resolveStyle(name?: string | null): ChoiceTheme {
  if (!name || name === 'default') {
    return STYLE_THEMES.default
  }
  // own-property のみ見る (#368)。`in` 演算子は Object.prototype も辿ってしまい、脚本側の
  // 自由記述である name（frontmatter `choice_style:` の生文字列）が `constructor` 等と一致すると
  // `name in STYLE_THEMES` が誤って true になり、後続の `STYLE_THEMES[name]` が
  // ChoiceTheme ではなく Object コンストラクタ関数等を返してしまう。
  if (hasOwn(STYLE_THEMES, name)) {
    return STYLE_THEMES[name as ChoiceStyleName]
  }
  console.warn(
    `[name-name] choice_style "${name}" は未知のテーマです。default にフォールバックします。利用可能: ${Object.keys(
      STYLE_THEMES
    ).join(' / ')}`
  )
  return STYLE_THEMES.default
}

/**
 * ボタン1件の配色を決める。優先順位は `locked`（#591、条件付きロック） > `cleared`
 * （#594、完了=クリア済み視覚状態） > `alreadyRead`（既読/未読の色分け） > 通常。
 * 通常運用では `locked` と `cleared` が同時に真になることは無い想定だが、防御的に
 * `locked` を優先する。ロック中・完了中はどちらもホバーで色を変えない
 * （ロックはクリック自体を受け付けない `eventMode: 'none'` のため、完了はクリック可能
 * だが「クリア済み」であることを常に一貫した見た目で示すため）ので hover 引数を無視する。
 * すべて false のときだけ従来どおり alreadyRead/hover で分岐する（非破壊）。
 */
export function resolveChoiceVisual(
  theme: ChoiceTheme,
  alreadyRead: boolean,
  hover: boolean,
  locked = false,
  cleared = false
): ChoiceVisual {
  if (locked) {
    return {
      fill: theme.fillLocked,
      border: theme.borderLocked,
      text: theme.textLockedColor,
    }
  }
  if (cleared) {
    return {
      fill: theme.fillCleared,
      border: theme.borderCleared,
      text: theme.textClearedColor,
    }
  }
  if (alreadyRead) {
    return {
      fill: hover ? theme.fillReadHover : theme.fillRead,
      border: hover ? theme.borderReadHover : theme.borderRead,
      text: theme.textReadColor,
    }
  }
  return {
    fill: hover ? theme.fillHover : theme.fillNormal,
    border: hover ? theme.borderHover : theme.borderNormal,
    text: theme.textColor,
  }
}

/**
 * キーボードフォーカス移動対象の選択肢ボタン1件分 (#633)。`locked` はナビゲーション対象から
 * 除外する（TitleScreenOverlay の disabled ボタン除外と同じ扱い）。`row`/`col` は
 * `computeChoiceGridLayout` の結果をそのまま持ち、グリッド配置時の ArrowUp/ArrowDown（同じ列内
 * 移動）・ArrowLeft/ArrowRight（同じ行内移動）に使う（非グリッド時は col が常に 0、row が
 * 選択肢の index と同じ = `computeChoiceGridLayout` の契約どおり）。
 */
interface FocusableChoiceEntry {
  container: Container
  focusRing: Graphics
  locked: boolean
  row: number
  col: number
}

export class ChoiceOverlay extends Container {
  private onSelect: ((jump: string) => void) | null = null
  private onScrollableChange: ((scrollable: boolean) => void) | null = null
  private audioManager: AudioManager | null = null
  private renderResolution = 1
  private fadeTicker: Ticker | null = null
  private fadeElapsedMs = 0
  private contentContainer: Container | null = null
  private buttonContainers: Container[] = []
  private scrollOffset = 0
  private maxScroll = 0
  private viewportY = 0
  private dragPointerId: number | null = null
  private dragLastY = 0
  private pressPointerId: number | null = null
  private pressStartX = 0
  private pressStartY = 0
  // 直前にホバー音を鳴らしたボタン index。マウスがボタン境界をジリジリ動いて
  // pointerover が連続発火しても、別ボタンへ移動した時だけ再生するための記録 (#146 R1 S1)
  private lastHoverIdx: number | null = null
  /**
   * split_layout (#442 self-review should-5) のテキスト領域。null = 従来どおり画面全体中央寄せ。
   * `NovelRenderer.applySplitLayout()` から `computeSplitLayoutRegions(...).text` をそのまま
   * 渡す想定（DialogBox.setSplitLayoutRegion / CharacterLayer.setSplitLayoutRegion と同じ契約）。
   */
  private splitLayoutRegion: LayoutRect | null = null
  /**
   * 実際に描画するボタン幅 (px)。region 未指定時は BUTTON_WIDTH のまま、region 指定時は
   * `show()` が region 幅に収まるようクランプし直す（`drawButton` 等はこの値を参照する）。
   */
  private layoutButtonWidth = BUTTON_WIDTH
  /**
   * 実際に描画するボタン高さ (px) (#598)。既読(完了)アイコンを表示する回だけ
   * `BUTTON_HEIGHT_WITH_ICON` へ切り替える（`layoutButtonWidth` と対の、必要な回だけ
   * 調整する流儀）。`show()` の冒頭で毎回確定し直す。
   */
  private layoutButtonHeight = BUTTON_HEIGHT
  /**
   * 選択肢アイコン (#598 追記3: `assets/images/read-icon.webp` / `assets/images/unread-icon.webp`)
   * 取得用のベース URL。`NovelRenderer.setAssetBaseUrl` から他レイヤ
   * （DialogBox/VideoLayer/EventImageLayer）と同じタイミングで `setAssetBaseUrl()` 経由で
   * 伝播される。
   */
  private assetBaseUrl = ''
  /**
   * 先読み済みの既読(完了)アイコン Texture (`read-icon.webp`)。未取得（ロード中/未実行）or
   * 取得失敗（404等）の間は null のままで、対象の選択肢は従来どおり配色のみで描画される
   * （フォールバック、非破壊）。
   */
  private readIconTexture: Texture | null = null
  /**
   * 先読み済みの未読アイコン Texture (`unread-icon.webp`, #598 追記3)。読み込み方針は
   * `readIconTexture` と同じ（未取得/失敗時は null のままフォールバック）。
   */
  private unreadIconTexture: Texture | null = null
  /**
   * `setAssetBaseUrl` のたびに増分し、古い `Assets.load().then()` 解決を無効化するトークン。
   * read-icon/unread-icon の両方の読み込みで共有する。
   */
  private iconLoadToken = 0
  /** キーボードフォーカス移動用の選択肢一覧（show() ごとに作り直す。#633）。 */
  private choiceEntries: FocusableChoiceEntry[] = []
  /** choiceEntries 内のフォーカス中インデックス。-1 はフォーカス対象なし（全ロック等の異常系）。 */
  private focusedIndex = -1
  /** ArrowUp/Down・ArrowLeft/Right の意味をグリッド (#508) 時だけ「列内/行内移動」に切り替える。 */
  private choiceIsGrid = false
  /** activateFocusedButton() が jump を引くための、show() 呼び出し時点の選択肢一覧 (#633)。 */
  private currentOptions: ChoiceOption[] = []
  /** フォーカス枠の角丸半径を現在のスタイルテーマに揃えるため保持する (#633)。 */
  private currentTheme: ChoiceTheme = STYLE_THEMES.default
  /** scrollFocusedIntoView (#633) が参照する、現在のビューポート高さ (px)。非スクロール時は未使用。 */
  private viewportHeight = 0

  constructor(
    private screenWidth: number,
    private screenHeight: number
  ) {
    super()
    this.eventMode = 'static'
  }

  /**
   * クリック確定音／ホバー音を鳴らすために AudioManager を注入する (#146)。
   * 未注入のときは無音（テスト等で AudioManager を渡さない構成にも耐える）。
   */
  setAudioManager(audio: AudioManager | null): void {
    this.audioManager = audio
  }

  /**
   * 選択肢アイコン (#598 追記3) 取得用のベース URL を設定する。
   * `NovelRenderer.setAssetBaseUrl` から `DialogBox.setIndicatorAssetBaseUrl` /
   * `VideoLayer.setAssetBaseUrl` / `EventImageLayer.setAssetBaseUrl` と同じタイミングで
   * 伝播される想定。`assets/images/read-icon.webp`（既読/完了）と
   * `assets/images/unread-icon.webp`（未読）を `Assets.load()`（EventImageLayer と同じ
   * パターン）でそれぞれ独立に先読みし、成功すれば `readIconTexture`/`unreadIconTexture` に
   * 保持する。
   *
   * プロジェクトにどちらかの画像が無い（404）/ 読み込みに失敗した場合は catch で
   * 握りつぶし、対応する Texture フィールドは null のまま——`show()` はそちら側の
   * 表示対象の選択肢を従来どおり配色のみで描画する（#598 最終方針のフォールバック、
   * read/unread それぞれ独立に判定される）。
   *
   * url が変わっていなければ何もしない（同一プロジェクト内の再呼び出しで再フェッチしない）。
   */
  setAssetBaseUrl(url: string): void {
    if (this.assetBaseUrl === url) return
    this.assetBaseUrl = url
    this.readIconTexture = null
    this.unreadIconTexture = null
    const token = ++this.iconLoadToken
    if (!url) return
    const readIconUrl = resolveAssetUrl(url, 'images', 'read-icon.webp')
    Assets.load(readIconUrl)
      .then((texture: Texture) => {
        // setAssetBaseUrl が後から再度呼ばれていれば、この読み込みは無効（古い世代）。
        if (token !== this.iconLoadToken) return
        this.readIconTexture = texture
      })
      .catch(() => {
        // 404 等はフォールバック対象（doc comment 参照）。ここでは何もしない。
      })
    const unreadIconUrl = resolveAssetUrl(url, 'images', 'unread-icon.webp')
    Assets.load(unreadIconUrl)
      .then((texture: Texture) => {
        if (token !== this.iconLoadToken) return
        this.unreadIconTexture = texture
      })
      .catch(() => {
        // 404 等はフォールバック対象（doc comment 参照）。ここでは何もしない。
      })
  }

  /**
   * split_layout (#442 self-review should-5) のテキスト領域を設定・解除する。
   * `novelLayout.ts` の `computeSplitLayoutRegions(...).text` をそのまま渡す想定。
   * null で解除し、従来の全画面中央寄せジオメトリに戻す（DialogBox.setSplitLayoutRegion /
   * CharacterLayer.setSplitLayoutRegion と同じ null=後方互換の契約）。
   *
   * ChoiceOverlay は DialogBox と異なり常時表示のジオメトリを持たず、`show()` のたびに
   * ボタンを作り直すため、ここでは値を保持するだけで即時の再レイアウトはしない
   * （次の `show()` 呼び出しから反映される）。
   */
  setSplitLayoutRegion(region: LayoutRect | null): void {
    this.splitLayoutRegion = region
  }

  /** 現在の split_layout テキスト領域 (#442)。null = 従来どおり全画面。テスト・配線検証用。 */
  getSplitLayoutRegion(): LayoutRect | null {
    return this.splitLayoutRegion
  }

  /**
   * Pixi Text は既定 resolution=1 で canvas 化されるため、DPR 描画時に選択肢文字だけ
   * 低解像度に見える。Renderer の resolution を渡して、ボタン内 Text を同じ密度で描く。
   */
  setRenderResolution(resolution: number): void {
    if (!(resolution > 0) || !Number.isFinite(resolution)) return
    this.renderResolution = resolution
  }

  /**
   * スクロール可能な選択肢リスト（#339）の表示状態が変わるたびに呼ばれるコールバックを設定する。
   *
   * このリストは縦方向ドラッグ（`handleDragMove` の `deltaY`）で操作するため、呼び出し側
   * （NovelRenderer）は scrollable=true の間だけ canvas の touch-action を 'none' に戻す必要がある。
   * 'pan-y' のままだと、ブラウザがその縦ドラッグをネイティブスクロールとして横取りしてしまい
   * （`pointercancel` でジェスチャが中断される）、リストが操作できなくなる (#434)。
   *
   * ChoiceOverlay 自身は「ロック」という概念を持たず、自分がスクロール可能かどうか（`scrollable`
   * = `maxScroll > 0`）を知っているだけ。touch-action をどう扱うかは呼び出し側（NovelRenderer）の
   * 責務であり、その変換ロジックはここには持たない。
   */
  setOnScrollableChange(callback: (scrollable: boolean) => void): void {
    this.onScrollableChange = callback
  }

  /**
   * 選択肢を表示する。
   *
   * @param options 表示する選択肢
   * @param onSelect 確定時のコールバック
   * @param style   `default` / `soft` / `monochrome` / `pixel`。未指定 or 不明値は `default` 扱い
   * @param columns グリッド配置の列数 (#508)。`[選択: 列=N]` の N。未指定 or 1 以下は
   *                従来どおりの縦一列表示（完全に非破壊）。2 以上でボタンを
   *                `i % columns` 列目・`i / columns` 行目に並べるグリッドになる。
   * @param locked  条件付きロック (#591)。`options` と同じ長さ・同じ並びの真偽配列
   *                （`NovelRenderer` が `option.condition` と `gameState.checkFlag` から
   *                作って渡す）。`true` の位置のボタンは非活性の見た目になり、クリック/
   *                ホバーを一切受け付けない。未指定 or 短ければ、残りは false（ロックなし、
   *                非破壊）として扱う。
   * @param cleared 完了(クリア済み)視覚状態 (#594)。`options` と同じ長さ・同じ並びの真偽配列
   *                （`NovelRenderer` が `option.cleared` と `gameState.checkFlag` から
   *                作って渡す）。`true` の位置のボタンは専用の暗い配色になるが、`locked` と
   *                異なりクリック/ホバーは通常どおり受け付ける（選択可能）。`locked` が
   *                同時に `true` の位置ではロックの見た目が優先される。未指定 or 短ければ、
   *                残りは false（完了なし、非破壊）として扱う。
   *
   *                アイコン (#598 追記3 / #604 訂正) は `cleared` のみで決まり、`locked` は
   *                一切影響しない（配色の優先順位 locked > cleared > alreadyRead とは別軸で
   *                判定する。`resolveChoiceIconKind`、`alreadyRead` は無関係）: `cleared` の
   *                位置は `setAssetBaseUrl()` で `read-icon.webp` の先読みに成功していれば
   *                テキストの上に表示する。`!cleared` の位置は `unread-icon.webp` の先読みに
   *                成功していれば同様に表示する（いずれも未取得/失敗時は配色のみのフォール
   *                バック）。ロック中でも `cleared` の値に応じてどちらかのアイコンが出る。
   */
  show(
    options: ChoiceOption[],
    onSelect: (jump: string) => void,
    style?: string | null,
    readJumps?: ReadonlySet<string>,
    columns?: number | null,
    locked?: readonly boolean[],
    cleared?: readonly boolean[]
  ): void {
    if (options.length === 0) return
    this.onSelect = onSelect
    this.currentOptions = options
    this.stopFadeTicker()
    // 連続呼び出しで子オブジェクトが滞留しないよう明示 destroy する (#146 R1 S3)
    for (const child of this.removeChildren()) {
      child.destroy({ children: true })
    }
    this.lastHoverIdx = null
    this.choiceEntries = []
    this.focusedIndex = -1
    this.resetScrollState()
    // セーブデータからのロード直後など、最初のユーザー入力が選択肢クリックになる
    // ケースで AudioContext が未初期化のまま playSelectTone が無音になるのを防ぐ。
    // pointerdown 時点でも resume できるが、show 時にも保険で叩いておく (#146 R1 S2)
    this.audioManager?.ensureContext()

    const theme = resolveStyle(style)
    this.currentTheme = theme

    // split_layout (#442 self-review should-5): region 指定時はテキスト領域だけに収める。
    // 未指定（従来）は画面全体のまま非破壊（areaX/areaY=0, areaWidth/Height=画面全体)。
    const region = this.splitLayoutRegion
    const areaX = region?.x ?? 0
    const areaY = region?.y ?? 0
    const areaWidth = region?.width ?? this.screenWidth
    const areaHeight = region?.height ?? this.screenHeight
    // グリッド配置 (#508)。列/行の割付・fitWidth 計算・中央寄せ開始 X は純粋関数
    // computeChoiceGridLayout (novelLayout.ts) に集約する (dev-doctrine 規約4)。
    // columns が未指定 or 1 以下なら isGrid=false のまま従来の縦一列レイアウトを一切変更しない。
    const gridLayout = computeChoiceGridLayout(
      columns,
      options.length,
      { x: areaX, y: areaY, width: areaWidth, height: areaHeight },
      BUTTON_WIDTH,
      GRID_COLUMN_GAP,
      GRID_HORIZONTAL_MARGIN
    )
    const isGrid = gridLayout.isGrid
    this.choiceIsGrid = isGrid
    const rows = gridLayout.rows

    // BUTTON_WIDTH (480px) は分割後のテキスト領域や多列グリッドでは広すぎることがあるため、
    // region 指定時 or グリッド時は利用可能幅にクランプする。どちらでもない（従来の縦一列・
    // 全画面）ときは BUTTON_WIDTH のまま、既存コードと完全に同じ式で触らない。
    if (isGrid) {
      this.layoutButtonWidth = gridLayout.buttonWidth
    } else {
      this.layoutButtonWidth = region
        ? Math.max(
            CHOICE_REGION_MIN_BUTTON_WIDTH,
            Math.min(BUTTON_WIDTH, areaWidth - CHOICE_REGION_MARGIN_X * 2)
          )
        : BUTTON_WIDTH
    }

    // 選択肢アイコン (#598 追記3 / #604 訂正)。行ごとに resolveChoiceIconKind で「本来どちらの
    // アイコンを見せるべきか」（cleared→read / !cleared→unread。locked は無関係）を求め、
    // 対応するテクスチャが setAssetBaseUrl() で先読み済みなら「実際に表示する」行として数える。
    // 1行でも表示対象があれば、アイコン用に嵩上げしたボタン高さを使う。
    // ロック中の行もアイコン表示対象になる（#604: ロックは「読むことすらできない」だけで
    // 「未読でない」わけではない。ロック中の選択肢も当然未読/既読どちらかのアイコンを持つ）。
    // アイコンが一切描画されない回（read-icon.webp/unread-icon.webp が両方とも未配置等）は
    // BUTTON_HEIGHT のまま——見た目は一切変わらない（layoutButtonWidth と同じ流儀）。
    const willShowIcon = options.some((_, i) => {
      const kind = resolveChoiceIconKind(cleared?.[i] ?? false)
      return kind === 'read' ? this.readIconTexture !== null : this.unreadIconTexture !== null
    })
    this.layoutButtonHeight = willShowIcon ? BUTTON_HEIGHT_WITH_ICON : BUTTON_HEIGHT

    const totalHeight = rows * this.layoutButtonHeight + (rows - 1) * BUTTON_GAP
    const maxViewportHeight = Math.max(
      this.layoutButtonHeight,
      areaHeight - VIEWPORT_VERTICAL_MARGIN * 2
    )
    const viewportHeight = Math.min(totalHeight, maxViewportHeight)
    this.viewportHeight = viewportHeight
    this.maxScroll = Math.max(0, totalHeight - viewportHeight)
    const scrollable = this.maxScroll > 0
    // touch-action の scroll-lock 通知 (#434)。詳細は setOnScrollableChange 参照。
    this.onScrollableChange?.(scrollable)
    const startY = areaY + (areaHeight - totalHeight) / 2

    if (scrollable) {
      this.viewportY = areaY + (areaHeight - viewportHeight) / 2
      this.hitArea = new Rectangle(areaX, this.viewportY, areaWidth, viewportHeight)
      const contentContainer = new Container()
      this.contentContainer = contentContainer
      const mask = new Graphics()
      mask.rect(areaX, this.viewportY, areaWidth, viewportHeight)
      mask.fill(0xffffff)
      // PixiJS v8 ではオブジェクトを `.mask` に割り当てた時点で通常描画から自動的に
      // 除外される。ここで renderable=false を付けるとステンシルにマスク形状が書き込まれず、
      // クリップ領域が空になって選択肢が一切描画されなくなる (#339 regression)。
      this.addChild(mask)
      contentContainer.mask = mask
      this.on('pointerdown', this.handleDragStart)
      this.on('pointermove', this.handleDragMove)
      this.on('pointerup', this.handleDragEnd)
      this.on('pointerupoutside', this.handleDragEnd)
      this.on('pointercancel', this.handleDragEnd)
    }

    options.forEach((option, i) => {
      const alreadyRead = readJumps?.has(option.jump) ?? false
      // 条件付きロック (#591)。locked が未指定/短ければ false（ロックなし、非破壊）。
      const isLocked = locked?.[i] ?? false
      // 完了(クリア済み)視覚状態 (#594)。cleared が未指定/短ければ false（完了なし、非破壊）。
      const isCleared = cleared?.[i] ?? false
      const normalVisual = resolveChoiceVisual(theme, alreadyRead, false, isLocked, isCleared)
      const textStyle = new TextStyle({
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize,
        fill: normalVisual.text,
        fontWeight: theme.fontWeight,
      })
      const buttonContainer = new Container()
      // ロック中はクリック/ホバーを一切受け付けない（`eventMode: 'none'` はヒットテスト
      // 自体から除外される——PixiJS v8 の仕様どおり、下の pointerover/pointerdown 等の
      // リスナーは登録されるが発火し得ない）。カーソルも 'pointer' に変えず選択可能に
      // 見せない。
      buttonContainer.eventMode = isLocked ? 'none' : 'static'
      buttonContainer.cursor = isLocked ? 'default' : 'pointer'
      buttonContainer.alpha = 0

      // pivot を中央に置いて scale 拡大時にボタン中心が動かないようにする
      buttonContainer.pivot.set(this.layoutButtonWidth / 2, this.layoutButtonHeight / 2)

      // 影レイヤ（pixi-filters 依存回避のため半透明矩形で代用）
      const shadow = new Graphics()
      this.drawFrame(shadow, theme, SHADOW_OFFSET, SHADOW_OFFSET)
      shadow.fill({ color: theme.shadowColor, alpha: theme.shadowAlpha })
      buttonContainer.addChild(shadow)

      const bg = new Graphics()
      this.drawButton(bg, theme, normalVisual.fill, normalVisual.border)
      buttonContainer.addChild(bg)

      // ロック中はダイム配色 (fillLocked/borderLocked/textLockedColor) と
      // eventMode: 'none' のみで「選べない」を表す（旧🔒絵文字連結は撤去）。
      //
      // 選択肢アイコン (#598 追記3 / #604 訂正)。「ロック」「既読/完了」は独立した2軸だが、
      // アイコンの出し分けは cleared のみで決まる（resolveChoiceIconKind、alreadyRead は
      // 無関係）。cleared → read-icon。!cleared → unread-icon（alreadyRead の真偽に関わらず）。
      // ロック中かどうかはアイコン種別に一切影響しない（#604: ロック中・未読なら unread-icon、
      // ロック中・既読なら read-icon が出る。配色のみ isLocked で別途ダイムする）。対応する
      // テクスチャの先読みに成功している場合だけ、テキストの上にアイコンを描く。
      const iconKind = resolveChoiceIconKind(isCleared)
      const iconTexture = iconKind === 'read' ? this.readIconTexture : this.unreadIconTexture
      const showIcon = iconTexture !== null
      const iconLayout = computeChoiceIconLayout(
        this.layoutButtonHeight,
        showIcon,
        ICON_SIZE,
        ICON_TEXT_GAP
      )

      if (showIcon && iconTexture) {
        const icon = new Sprite(iconTexture)
        icon.width = ICON_SIZE
        icon.height = ICON_SIZE
        icon.anchor.set(0.5, 0.5)
        icon.x = this.layoutButtonWidth / 2
        icon.y = iconLayout.iconY
        buttonContainer.addChild(icon)
      }

      const label = new PixiText({
        text: option.text,
        style: textStyle,
        resolution: this.renderResolution,
        roundPixels: true,
      })
      label.x = this.layoutButtonWidth / 2
      label.y = iconLayout.textY
      label.anchor.set(0.5, 0.5)
      buttonContainer.addChild(label)

      // グリッド (#508) の列・行・中心 X は computeChoiceGridLayout の結果をそのまま使う。
      // 非グリッド (isGrid=false) では row は常に i になるため、下の y 式は
      // 従来の縦一列と完全に同じ結果になる。
      const { row, col, x: buttonCenterX } = gridLayout.positions[i]

      // キーボード focus 表示専用の枠線レイヤー (#633)。label/icon より上に重ねるが外周の
      // stroke のみでラベル文字は隠さない。マウス hover の bg 塗り替え（下記）とは完全に
      // 独立した仕組みで、show() 直後は未描画（clear() 済み = 何も見えない）。
      const focusRing = new Graphics()
      buttonContainer.addChild(focusRing)
      this.choiceEntries.push({
        container: buttonContainer,
        focusRing,
        locked: isLocked,
        row,
        col,
      })

      // pivot を中央に動かしたため、ボタン中心を所定位置（region 指定時はその中心）に置く
      buttonContainer.x = buttonCenterX
      buttonContainer.y = scrollable
        ? row * (this.layoutButtonHeight + BUTTON_GAP) + this.layoutButtonHeight / 2
        : startY + row * (this.layoutButtonHeight + BUTTON_GAP) + this.layoutButtonHeight / 2

      buttonContainer.on('pointerover', () => {
        const hoverVisual = resolveChoiceVisual(theme, alreadyRead, true, isLocked, isCleared)
        bg.clear()
        this.drawButton(bg, theme, hoverVisual.fill, hoverVisual.border)
        buttonContainer.scale.set(HOVER_SCALE)
        // 同一ボタンで pointerover が連発しても再生しない (#146 R1 S1)
        if (this.lastHoverIdx !== i) {
          this.audioManager?.playHoverTone()
          this.lastHoverIdx = i
        }
      })

      buttonContainer.on('pointerout', () => {
        bg.clear()
        this.drawButton(bg, theme, normalVisual.fill, normalVisual.border)
        buttonContainer.scale.set(1)
        if (this.lastHoverIdx === i) {
          this.lastHoverIdx = null
        }
      })

      const selectChoice = (e: FederatedPointerEvent) => {
        // 多重防御 (#591): eventMode='none' で通常は発火し得ないが、`draw_choice_grid` の
        // columns クランプと同じ思想で呼び出し経路に依らず確定を拒否する。
        if (isLocked) return
        e.stopPropagation()
        this.audioManager?.ensureContext()
        this.audioManager?.playSelectTone()
        this.onSelect?.(option.jump)
      }
      buttonContainer.on('pointerdown', (e) => {
        this.pressPointerId = e.pointerId
        this.pressStartX = e.global.x
        this.pressStartY = e.global.y
        if (scrollable) {
          this.handleDragStart(e)
        }
        e.stopPropagation()
      })
      buttonContainer.on('pointerup', (e) => {
        if (this.pressPointerId !== e.pointerId) return
        const dx = e.global.x - this.pressStartX
        const dy = e.global.y - this.pressStartY
        if (scrollable) {
          this.handleDragEnd(e)
        }
        this.clearChoicePress()
        if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD_PX) return
        selectChoice(e)
      })
      buttonContainer.on('pointerupoutside', (e) => {
        if (this.pressPointerId === e.pointerId) {
          if (scrollable) {
            this.handleDragEnd(e)
          }
          this.clearChoicePress()
        }
      })
      buttonContainer.on('pointercancel', (e) => {
        if (this.pressPointerId === e.pointerId) {
          if (scrollable) {
            this.handleDragEnd(e)
          }
          this.clearChoicePress()
        }
      })

      if (this.contentContainer) {
        this.contentContainer.addChild(buttonContainer)
      } else {
        this.addChild(buttonContainer)
      }
      this.buttonContainers.push(buttonContainer)
    })
    if (scrollable && this.contentContainer) {
      this.addChild(this.contentContainer)
      this.applyScrollOffset()
    }

    // 有効な最初の選択肢へフォーカスをリセットする（#633、TitleScreenOverlay と同じ流儀）。
    // focusedIndex を一旦 -1 に固定してから setFocusedIndex() を呼ぶことで、choiceEntries が
    // 総入れ替えされた（Graphics インスタンスが変わった）にもかかわらず「インデックス値が
    // たまたま前回と同じだから」という理由で早期 return され新しい focusRing に描画し損ねる
    // 事故を避ける。
    this.focusedIndex = -1
    const firstFocusableIndex = this.choiceEntries.findIndex((e) => !e.locked)
    this.setFocusedIndex(firstFocusableIndex)

    this.visible = true
    this.alpha = 1
    this.startFadeIn()
  }

  /**
   * ChoiceOverlay 表示中のキーボード操作 (#633)。呼び出し元（NovelRenderer.handleKeyDown）が
   * `waitingForChoice` の間、window keydown を丸ごとここへ委譲する。戻り値 true = このキー入力を
   * 処理済み（呼び出し元は他のゲーム内ショートカットを一切発火させない）。
   *
   * TitleScreenOverlay.handleKeyDown（#633 フェーズA）と同じ Tab/Enter/Space パターンを踏襲しつつ、
   * ChoiceOverlay 固有の事情（可変個数・グリッド配置 #508・ロック #591）に合わせて拡張する:
   *   - Tab/Shift+Tab: 全選択肢を通したフラットな順序でフォーカス移動（ロック済みはスキップ、循環）。
   *   - ArrowUp/ArrowDown: 縦一列時は Tab と同じフラット移動。グリッド時は同じ列内だけを移動する。
   *   - ArrowLeft/ArrowRight: グリッド時のみ同じ行内を移動する。縦一列時は意味が無いため false を
   *     返し未処理のまま呼び出し元に委ねる（advance()/goBack() 側で waitingForChoice ガード済み
   *     のため no-op になるだけで、誤発火はしない）。
   *   - Enter/Space: フォーカス中の選択肢を確定する（ロック済みなら何もしない）。
   */
  handleKeyDown(key: string, shiftKey = false): boolean {
    switch (key) {
      case 'Tab':
        this.moveFocus(shiftKey ? -1 : 1)
        return true
      case 'ArrowDown':
        if (this.choiceIsGrid) {
          this.moveFocusInColumn(1)
        } else {
          this.moveFocus(1)
        }
        return true
      case 'ArrowUp':
        if (this.choiceIsGrid) {
          this.moveFocusInColumn(-1)
        } else {
          this.moveFocus(-1)
        }
        return true
      case 'ArrowRight':
        if (!this.choiceIsGrid) return false
        this.moveFocusInRow(1)
        return true
      case 'ArrowLeft':
        if (!this.choiceIsGrid) return false
        this.moveFocusInRow(-1)
        return true
      case 'Enter':
      case ' ':
        this.activateFocusedButton()
        return true
      default:
        return false
    }
  }

  private activateFocusedButton(): void {
    const entry = this.choiceEntries[this.focusedIndex]
    const option = this.currentOptions[this.focusedIndex]
    if (!entry || entry.locked || !option) return
    this.audioManager?.ensureContext()
    this.audioManager?.playSelectTone()
    this.onSelect?.(option.jump)
  }

  /** ロック済みをスキップしつつ、末尾↔先頭で循環してフォーカスを1つ移動する（非グリッド/Tab共通）。 */
  private moveFocus(direction: 1 | -1): void {
    const indices = this.choiceEntries.reduce<number[]>((acc, entry, i) => {
      if (!entry.locked) acc.push(i)
      return acc
    }, [])
    this.stepFocus(indices, direction)
  }

  /** グリッド配置 (#508) 時、フォーカス中の選択肢と同じ列 (col) の中だけで上下に移動する。 */
  private moveFocusInColumn(direction: 1 | -1): void {
    const col = this.choiceEntries[this.focusedIndex]?.col ?? 0
    const indices = this.choiceEntries
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => !entry.locked && entry.col === col)
      .sort((a, b) => a.entry.row - b.entry.row)
      .map(({ i }) => i)
    this.stepFocus(indices, direction)
  }

  /** グリッド配置 (#508) 時、フォーカス中の選択肢と同じ行 (row) の中だけで左右に移動する。 */
  private moveFocusInRow(direction: 1 | -1): void {
    const row = this.choiceEntries[this.focusedIndex]?.row ?? 0
    const indices = this.choiceEntries
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => !entry.locked && entry.row === row)
      .sort((a, b) => a.entry.col - b.entry.col)
      .map(({ i }) => i)
    this.stepFocus(indices, direction)
  }

  /**
   * `indices`（すでにロック済み除外・目的の軸で整列済み）の中で、現在のフォーカス位置から
   * 1つ循環移動する。moveFocus/moveFocusInColumn/moveFocusInRow の共通処理 (#633)。
   */
  private stepFocus(indices: number[], direction: 1 | -1): void {
    if (indices.length === 0) return
    const currentPos = indices.indexOf(this.focusedIndex)
    const basePos = currentPos === -1 ? 0 : currentPos
    const nextPos = (basePos + direction + indices.length) % indices.length
    this.setFocusedIndex(indices[nextPos])
  }

  private setFocusedIndex(index: number): void {
    if (index === this.focusedIndex) return
    const prev = this.choiceEntries[this.focusedIndex]
    if (prev) prev.focusRing.clear()
    this.focusedIndex = index
    const next = this.choiceEntries[this.focusedIndex]
    if (next) {
      this.drawFocusRing(next.focusRing)
      this.scrollFocusedIntoView(next.row)
    }
  }

  private drawFocusRing(g: Graphics): void {
    g.clear()
    g.roundRect(
      -FOCUS_RING_INSET,
      -FOCUS_RING_INSET,
      this.layoutButtonWidth + FOCUS_RING_INSET * 2,
      this.layoutButtonHeight + FOCUS_RING_INSET * 2,
      this.currentTheme.radius + FOCUS_RING_INSET
    )
    g.stroke({ color: COLOR_FOCUS_RING, width: FOCUS_RING_WIDTH })
  }

  /**
   * スクロール可能なリスト（#339）で、キーボードフォーカスが移動した選択肢の行がビューポート外に
   * あれば、その行が見える位置まで `scrollOffset` を動かす（#633）。マウスドラッグ/ホイール
   * （`scrollBy`）と同じ `scrollOffset`/`applyScrollOffset` を経由するため、以後のドラッグ操作とも
   * 状態が整合する。
   */
  private scrollFocusedIntoView(row: number): void {
    if (this.maxScroll <= 0) return
    const rowHeight = this.layoutButtonHeight + BUTTON_GAP
    const top = row * rowHeight
    const bottom = top + this.layoutButtonHeight
    let next = this.scrollOffset
    if (top < this.scrollOffset) {
      next = top
    } else if (bottom > this.scrollOffset + this.viewportHeight) {
      next = bottom - this.viewportHeight
    }
    next = Math.max(0, Math.min(this.maxScroll, next))
    if (next !== this.scrollOffset) {
      this.scrollOffset = next
      this.applyScrollOffset()
    }
  }

  /**
   * 選択肢を非表示にする。
   * 子の Container / Graphics / Text は明示的に destroy してリスナーと
   * GPU リソースを解放する (#146 R1 S3)。
   */
  hide(): void {
    this.stopFadeTicker()
    this.visible = false
    this.alpha = 1
    for (const child of this.removeChildren()) {
      child.destroy({ children: true })
    }
    this.onSelect = null
    this.lastHoverIdx = null
    this.choiceEntries = []
    this.focusedIndex = -1
    this.currentOptions = []
    this.resetScrollState()
    // 非表示になった時点でスクロール可能状態ではなくなるので、無条件で scroll-lock を解除する (#434)。
    this.onScrollableChange?.(false)
  }

  override destroy(options?: DestroyOptions): void {
    this.stopFadeTicker()
    super.destroy(options)
  }

  /**
   * ボタン（または影）の輪郭パスを `g` に積む。fill()/stroke() は呼び出し側の責務。
   * offsetX/offsetY は影レイヤの SHADOW_OFFSET ずらしと、通常ボタンの (0, 0) 起点の
   * 両方に対応するための引数。pixel テーマは radius=0 のため、これで単純な直角矩形になる (#569)。
   */
  private drawFrame(g: Graphics, theme: ChoiceTheme, offsetX: number, offsetY: number): void {
    g.roundRect(offsetX, offsetY, this.layoutButtonWidth, this.layoutButtonHeight, theme.radius)
  }

  private drawButton(
    g: Graphics,
    theme: ChoiceTheme,
    fillColor: number,
    borderColor: number
  ): void {
    this.drawFrame(g, theme, 0, 0)
    g.fill(fillColor)
    g.stroke({ color: borderColor, width: theme.borderWidth })
  }

  private startFadeIn(): void {
    this.fadeElapsedMs = 0
    const ticker = new Ticker()
    ticker.add(() => {
      this.fadeElapsedMs += ticker.deltaMS
      let allDone = true
      this.buttonContainers.forEach((button, i) => {
        const delayMs = Math.min(i * SHOW_STAGGER_MS, MAX_SHOW_STAGGER_MS)
        const t = Math.min(1, Math.max(0, (this.fadeElapsedMs - delayMs) / SHOW_FADE_MS))
        button.alpha = t
        if (t < 1) allDone = false
      })
      if (allDone) {
        this.stopFadeTicker()
      }
    })
    ticker.start()
    this.fadeTicker = ticker
  }

  private stopFadeTicker(): void {
    if (!this.fadeTicker) return
    this.fadeTicker.stop()
    this.fadeTicker.destroy()
    this.fadeTicker = null
  }

  handleWheel(deltaY: number): boolean {
    return this.scrollBy(deltaY)
  }

  private scrollBy(deltaY: number): boolean {
    if (this.maxScroll <= 0) return false
    const before = this.scrollOffset
    this.scrollOffset = Math.max(0, Math.min(this.maxScroll, this.scrollOffset + deltaY))
    this.applyScrollOffset()
    return this.scrollOffset !== before
  }

  private applyScrollOffset(): void {
    if (!this.contentContainer) return
    this.contentContainer.y = this.viewportY - this.scrollOffset
  }

  private handleDragStart = (e: FederatedPointerEvent): void => {
    if (this.maxScroll <= 0) return
    this.dragPointerId = e.pointerId
    this.dragLastY = e.global.y
  }

  private handleDragMove = (e: FederatedPointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return
    const y = e.global.y
    const delta = this.dragLastY - y
    this.dragLastY = y
    if (this.scrollBy(delta)) {
      e.stopPropagation()
    }
  }

  private handleDragEnd = (e: FederatedPointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return
    this.dragPointerId = null
  }

  private clearChoicePress(): void {
    this.pressPointerId = null
    this.pressStartX = 0
    this.pressStartY = 0
  }

  private resetScrollState(): void {
    this.off('pointerdown', this.handleDragStart)
    this.off('pointermove', this.handleDragMove)
    this.off('pointerup', this.handleDragEnd)
    this.off('pointerupoutside', this.handleDragEnd)
    this.off('pointercancel', this.handleDragEnd)
    this.contentContainer = null
    this.buttonContainers = []
    this.scrollOffset = 0
    this.maxScroll = 0
    this.viewportY = 0
    this.viewportHeight = 0
    this.dragPointerId = null
    this.dragLastY = 0
    this.clearChoicePress()
    this.hitArea = null
  }
}
