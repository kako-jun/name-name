import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Assets } from 'pixi.js'
import { Event, EventScene } from '../types'
import { NovelRenderer } from '../game/NovelRenderer'
import { type NovelGameState } from '../game/GameState'
import { parseDebugQuery } from '../game/debugQuery'
import { type Settings, loadSettings, makeDebouncedSaveSettings } from '../game/settings'
import {
  type AspectRatio,
  ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO,
  parseAspectRatio,
  isAutoAspectRatio,
  pickFluidAspectRatio,
} from '../game/constants'
import {
  computeDynamicRenderResolution,
  getIndicatorImageUrls,
  PLAYER_BUTTON_RIGHT_MARGIN_PX,
  PLAYER_BUTTON_SLOT_GAP_PX,
  resolveDevicePixelRatio,
} from '../game/novelLayout'
import { buildStoryEndedMessage } from '../game/storyEndedMessage'
import { isEmbedded } from '../utils/isEmbedded'
import SettingsOverlay from './SettingsOverlay'
import { DebugOverlay } from './DebugOverlay'

// デバッグ HUD の展開状態の永続化キー (#310)。既定は畳んだ状態（open=false）。
// 旧 DebugOverlay (#301) の collapsed 既定 true（= 展開していない）と同じ意味を引き継ぐ。
const LS_DEBUG_OPEN = 'nn.debugOverlay.open'

/** localStorage から「デバッグ HUD を開いているか」を安全に読む。例外/未保存は false（畳んだ状態）。 */
function readDebugOpen(): boolean {
  try {
    return localStorage.getItem(LS_DEBUG_OPEN) === '1'
  } catch {
    return false
  }
}

/** localStorage に展開状態を安全に書く。例外は握り潰す（永続化は best-effort）。 */
function writeDebugOpen(open: boolean): void {
  try {
    localStorage.setItem(LS_DEBUG_OPEN, open ? '1' : '0')
  } catch {
    // SSR/未対応/プライベートモード等。永続化できなくても UI 状態は React state で動く。
  }
}

interface NovelPlayerProps {
  events: Event[]
  scenes?: EventScene[]
  /**
   * シーンジャンプ解決専用の索引 (#284)。再生ストリームは `events` のまま（線形再生を
   * 維持）で、`→ シーンID` のジャンプ・セーブ復元・debug startFrom が **ファイル横断**
   * （複数 MD）で解決できるよう、全 MD の全シーンをここに渡す。
   *
   * `scenes`（= setScenes）との違い: `scenes` は再生ストリーム自体を `scenes[0]` だけに
   * 差し替えるため多シーンの線形自動進行が止まる。線形再生を残したいときは `events` に
   * flatten 済みイベント列を、`jumpSceneIndex` に全シーンを渡す（PlayerScreen の使い方）。
   * `scenes` が指定されている場合は従来どおり `scenes` 優先（後方互換）。
   */
  jumpSceneIndex?: EventScene[]
  /** 未ロード sceneId を必要時に追加解決する hook (#314)。 */
  onResolveMissingScene?: (sceneId: string) => Promise<EventScene[] | null>
  /**
   * production でも有効な起点シーン指定 (#386)。`?scene=<sceneId>` の解決結果を
   * 呼び出し側（PlayerScreen）が渡す。渡す時点で対象 sceneId は `jumpSceneIndex` に
   * 含まれている前提（クロスファイルの事前ロードは呼び出し側の責務）。
   * マウント時に一度だけ `renderer.startFrom({ sceneId: initialSceneId })` を呼ぶ。
   * 不正/未解決（jumpSceneIndex に無い）sceneId は startFrom 内で no-op になり、
   * 通常のエントリ再生（events）にフォールバックする。null/undefined で指定なし。
   */
  initialSceneId?: string | null
  /**
   * `?scene=` ディープリンク単独埋め込みの confinement（在圏）一覧 (#386)。
   * `initialSceneId` が属する script ファイル自身の sceneId 一覧を呼び出し側
   * （PlayerScreen）が渡す。渡された場合、その集合の外への choice ジャンプ
   * （hub や他ファイルへの「別の問いを聞く」等）は通常のシーン遷移にならず、
   * 終劇（"to be continued..." 表示）になる（NovelRenderer.jumpToScene 参照）。
   * null/undefined で制限なし（通常のハブ経由フロー、後方互換）。
   */
  confinedSceneIds?: string[] | null
  assetBaseUrl?: string
  /** 画面比率。"16:9" / "4:3" / "9:16"。デフォルト "16:9" (#136) */
  aspectRatio?: AspectRatio | string
  /** 選択肢スタイル名 `default` / `soft` / `monochrome` (#146)。
   *  frontmatter `choice_style:` から流す。null/undefined で default 扱い */
  choiceStyle?: string | null
  /** per-game デフォルトフォント (#147)。CSS の font-family 文字列。
   *  frontmatter `font_family:` から流す。null/undefined で runtime 既定 (Noto Sans JP) */
  fontFamily?: string | null
  /** per-game デフォルト本文フォントサイズ (px) (#283 補遺)。
   *  frontmatter `font_size:` から流す。null/undefined で runtime 既定 40 */
  fontSize?: number | null
  /** 会話の描画スタイル (#283)。`adv` / `novel` の対等 2 択。
   *  frontmatter `dialog_style:` から流す。null/undefined で adv 相当（未指定時フォールバック） */
  dialogStyle?: string | null
  /** 質問役（主人公）の話者名 (#286)。`dialog_style: novel` の左右配置に使う。
   *  frontmatter `protagonist:` から流す。null/undefined で従来配置（後方互換） */
  protagonist?: string | null
  /** 立ち絵の足元 Y 比率 (#308)。frontmatter `character_y_ratio:` から流す。
   *  null/undefined で runtime 既定 1.0（足が画面下端）。>1.0 で靴が画面外に切れる（ToHeart 式） */
  characterYRatio?: number | null
  /** 立ち絵の目標表示高さ比率 (#360)。frontmatter `character_height_ratio:` から流す。
   *  null/undefined で原寸 (scale=1)＝後方互換。0..1 で「画面高に対する立ち絵高さの割合」に自動スケール。 */
  characterHeightRatio?: number | null
  /** キャラごとの立ち絵目標表示高さ比率 override (#364)。frontmatter `character_height_ratios:` から流す。
   *  キーはキャラクター表示名。マップに無いキャラは characterHeightRatio へフォールバックする。
   *  null/undefined/空オブジェクトで override なし（後方互換）。 */
  characterHeightRatios?: Record<string, number> | null
  /** 立ち絵の元絵基準の一律スケール (#378)。frontmatter `character_scale:` から流す。
   *  null/undefined で未設定＝下位優先順位（characterHeightRatios > characterHeightRatio > 原寸 scale=1）へ
   *  フォールバック（後方互換）。character_height_ratio(#360) が画面基準で元絵の縦pxを割り消し身長差を潰すのに
   *  対し、character_scale は元絵基準（sprite.scale = 値）で元絵に焼き込んだ身長差をそのまま出す。 */
  characterScale?: number | null
  /** 立ち絵の新規表示・退場フェード時間 (ms)。frontmatter `character_fade_ms:` から流す。 */
  characterFadeMs?: number | null
  /** 背景クロスフェード・退場（終劇）フェード時間 (ms) (#407)。frontmatter `background_fade_ms:` から流す。
   *  null/undefined で runtime 既定 700ms（BACKGROUND_CROSSFADE_MS）＝後方互換。 */
  backgroundFadeMs?: number | null
  /** イベント絵の表示・退場フェード時間 (ms)。frontmatter `event_image_fade_ms:` から流す。
   *  個別 `フェード=` が無い `[イベント絵:]` / `[イベント絵終了]` に効く。 */
  eventImageFadeMs?: number | null
  /** 下地ベタ（ステージ最背面 bgGraphics）の既定色 (#409)。frontmatter `background_color:` から流す。
   *  最初の背景絵がこの色から `background_fade_ms` でフェードインする。null/undefined で黒（後方互換）。 */
  backgroundColor?: string | null
  /** SeekBar（シナリオスライダ）のフィル／つまみ色 (#440)。frontmatter `seekbar_color:` から流す。
   *  null/undefined/不正値で既定の水色 #a8dadc（後方互換）。トラック背景は据え置き。 */
  seekbarColor?: string | null
  /**
   * intermission.md 専用シーン (#404)。`assets/scripts/intermission.md` を取得・parse できた場合に
   * PlayerScreen が渡す flatten 済み Event 列。null/undefined/空配列は「未設定」＝endStory() は
   * 従来どおりフェードのみで終わり、下記 DOM 側 "to be continued..." 表示（フェーズ1）にフォールバック
   * する（完全後方互換・オプトイン）。
   */
  intermissionEvents?: Event[] | null
  /** intermission.md 自身の frontmatter `background_fade_ms:` の値 (#404)。物語本編の
   *  `backgroundFadeMs` とは独立（endStory() の消去フェードにだけ使う）。null/undefined は
   *  intermission 用既定（1400ms）にフォールバック。 */
  intermissionBackgroundFadeMs?: number | null
  /** intermission.md 自身の frontmatter `character_fade_ms:` の値 (#404)。物語本編の
   *  `characterFadeMs` とは独立（endStory() の立ち絵消去フェードにだけ使う）。 */
  intermissionCharacterFadeMs?: number | null
  /** intermission.md 自身の frontmatter `event_image_fade_ms:` の値。物語本編の
   *  `eventImageFadeMs` とは独立し、intermission タブロー内のイベント絵にだけ使う。 */
  intermissionEventImageFadeMs?: number | null
  /** Skip(S) ボタンを出すか (#310)。frontmatter `skip_enabled:` から流す。
   *  null/undefined/true で Skip(S) ボタンを描画する（既定・後方互換）。false で描画しない。
   *  skip-read-only ロジック（未読は解除）自体は不変。ボタンの有無だけを制御する。 */
  skipEnabled?: boolean | null
  /** デバッグ HUD（D ボタン）を出すか (#310)。
   *  /play では frontmatter `debug_enabled:` から流す（null/undefined/false で非表示・本番既定）。
   *  /edit は frontmatter 非依存で常時 true を渡す（編集者用）。 */
  debugEnabled?: boolean | null
  /** 話者交代 nudge（ぴょこ）を novel で発火させるか (#382)。frontmatter `speaker_nudge:` から流す。
   *  既定 false＝非発火（opt-in）。`true` で発火。null/undefined/false は非発火。
   *  標準はポーズ差し替え（theo-hayami 等）が話者合図を担うため nudge は不要。欲しい作品だけ true で opt-in する。 */
  speakerNudge?: boolean | null
  /** オート再生を最初から ON にするか (#436)。frontmatter `auto_play:` から流す。
   *  既定 false＝手送り（null/undefined/false で最初は手送り）。`true` で起動時からオート ON。
   *  llll-ll-media 等の動画用途では `auto_play: true` を明示する。 */
  autoPlay?: boolean | null
  /** 画面比率に応じて画像/テキストを左右・上下に分割配置する split_layout モード (#442)。
   *  frontmatter `split_layout:` から流す。既定 false＝従来どおり（画像全面 + テキストオーバーレイ）。
   *  dialog_style（adv/novel、テキスト送りの挙動）とは独立の軸で、両者は併用できる。 */
  splitLayout?: boolean | null
  /** 文単位の厳密改頁 (#448)。frontmatter `sentence_per_page:` から流す。既定 false＝従来どおり
   *  （novel は行数キャップで複数文が1ページに同居しうる／adv は markdown 行単位でページが決まる）。
   *  dialog_style（adv/novel）とは独立の軸で、true のときどちらのスタイルでも 1 ページ＝厳密に 1 文になる。 */
  sentencePerPage?: boolean | null
  /** テクスチャ拡大縮小フィルタを nearest-neighbor（ドット絵向け）にするか (#466)。
   *  frontmatter `pixel_art:` から流す。既定 false＝従来どおり linear（滑らか、theo-hayami 等の
   *  塗り絵向け）。true で立ち絵・イベント絵の拡大表示がブロック状のドットを保つ
   *  （Gymnasia の 128x128 ドット絵イベント絵向け）。 */
  pixelArt?: boolean | null
  /** DebugOverlay に出す renderer 外の読み込み診断 (#321)。 */
  debugInfo?: string[]
  /** 既読永続化キー（省略時はスキップ機能を無効化）(#140) */
  docKey?: string
  /**
   * true にするとゲーム開始直後にスキップモードを ON にする (#141)。
   * 「つづきから」で未読位置まで高速スキップするために使用する。
   * docKey が未設定の場合は無視される。
   */
  initialSkipMode?: boolean
  /** renderer 準備完了時に呼ばれるコールバック (#228 動画エクスポート用)。
   *  destroy 直前に null で呼ばれる。 */
  onRendererReady?: (renderer: NovelRenderer | null) => void
}

function NovelPlayer({
  events,
  scenes,
  jumpSceneIndex,
  onResolveMissingScene,
  initialSceneId,
  confinedSceneIds,
  assetBaseUrl,
  aspectRatio: aspectRatioProp,
  choiceStyle,
  fontFamily,
  fontSize,
  dialogStyle,
  protagonist,
  characterYRatio,
  characterHeightRatio,
  characterHeightRatios,
  characterScale,
  characterFadeMs,
  backgroundFadeMs,
  eventImageFadeMs,
  backgroundColor,
  seekbarColor,
  intermissionEvents,
  intermissionBackgroundFadeMs,
  intermissionCharacterFadeMs,
  intermissionEventImageFadeMs,
  skipEnabled,
  debugEnabled,
  speakerNudge,
  autoPlay,
  splitLayout,
  sentencePerPage,
  pixelArt,
  debugInfo,
  docKey,
  initialSkipMode = false,
  onRendererReady,
}: NovelPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<NovelRenderer | null>(null)
  // fluid aspect ratio (#442) 用: ルート要素（常に w-full h-full）の実サイズを測る ref。
  // aspect_ratio: auto のときだけ ResizeObserver で監視する（非 auto では未使用）。
  const fluidRootRef = useRef<HTMLDivElement>(null)
  // fluid 再マウント (#460) 用: 向きカテゴリ変化で renderer が作り直される直前に
  // 旧 renderer.getSnapshot() を保持し、新 renderer の初期化直後に restoreSnapshot で
  // 読み進め位置を引き継ぐ。初回マウント・非 fluid・向きカテゴリ不変（再マウント自体が
  // 起きない）では常に null のまま＝従来どおり initialSceneId ベースの起動になる。
  const pendingSnapshotRef = useRef<NovelGameState | null>(null)

  // 設定 (Issue #138): localStorage と同期。スライダー drag による書き込み連打は
  // debounce で吸収する (review #155 should-2)
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // オートモード ON/OFF (#139)
  // 既定は OFF＝手送り (#436)。frontmatter `auto_play: true` で起動時から ON にできる
  // （llll-ll-media 等の動画用途）。起動後は UI のオートトグルで随時切り替える。
  const [autoMode, setAutoMode] = useState(autoPlay ?? false)
  // スキップモード ON/OFF (#140)
  const [skipMode, setSkipMode] = useState(false)
  // クイックセーブ/ロード完了通知 toast (#142)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debouncedSave = useMemo(() => makeDebouncedSaveSettings(300), [])

  // シナリオスライダ(SeekBar)操作中フラグ (#350)。renderer の onSeekActiveChange で同期し、
  // active の間は下部丸ボタン行(S/A/⚙/D)をフェード退避させてスライダと重ならないようにする。
  // 演出/UI の transient 状態なので GameState には持たない（ADR 0002・renderer 側も transient）。
  const [seekActive, setSeekActive] = useState(false)

  // 終劇状態 (#386)。renderer の onStoryEndedChange で同期する（GameState 上の宣言的フラグ
  // NovelGameState.storyEnded のミラー）。true の間だけ「to be continued...」を表示する。
  const [storyEnded, setStoryEnded] = useState(false)

  // intermission.md 専用シーンが使われたか (#404)。storyEnded が true に立ち上がった瞬間の
  // renderer.hasIntermissionScene() を1回だけスナップショットする（true の間ずっと再評価しない）。
  // 理由: intermissionEvents prop は PlayerScreen の非同期取得結果で、endStory() 発火より後に
  // 遅れて届く可能性がある。ライブに rendererRef.current?.hasIntermissionScene() を毎レンダー
  // 参照すると、「DOM フォールバック表示済みの直後に intermission が届いて表示だけ消える」
  // （PixiJS タブローは endStory() の時点で未設定だったため描かれない）事故になる。
  // true 固定タイミングは onStoryEndedChangeCallback と同じ（#386 契約と同じ「1遷移1回」）。
  const [usedIntermissionScene, setUsedIntermissionScene] = useState(false)

  // 終劇表示中に左上へ出す埋め込み元プロジェクトロゴの読み込み失敗フラグ (#404)。
  // TitleOverlay の imageFailed と同じ onError パターン。ロゴが無い/失敗したプロジェクトでは
  // テキストへのフォールバックはせず、単に出さない（Issue 方針）。
  const [storyEndedLogoFailed, setStoryEndedLogoFailed] = useState(false)

  // デバッグ HUD の展開状態 (#310)。右下ボタン列の「D」ボタンで開閉する。
  // 既定は畳んだ状態（#301 の collapsed 既定 true を引き継ぐ＝open 既定 false）。
  // 状態は localStorage（旧 DebugOverlay と同じキー意味）に best-effort で永続化する。
  const [debugOpen, setDebugOpen] = useState<boolean>(() => readDebugOpen())

  // フルスクリーン最大化トグル (#468)。per-game opt-in ではなくエンジン標準機能として
  // 全ゲーム共通で提供する。対象要素は fluidRootRef（letterbox 込みのゲーム画面全体。
  // PlayerScreen のヘッダ等は含まない＝「ゲーム画面自体」の最大化）。
  // 実際に画面がフルスクリーンかどうかは document.fullscreenElement が正で、ここは
  // その追従用ミラー（ボタンのアイコン/aria-pressed 表示にだけ使う）。
  const [isFullscreen, setIsFullscreen] = useState(false)

  // fluid aspect ratio (#442): frontmatter `aspect_ratio: auto` のときは固定比率にロックせず、
  // ルート要素（w-full h-full＝実ビューポート追従）の実測サイズの向きから '16:9'/'9:16' を
  // 都度選ぶ。既存の 3 値（16:9/4:3/9:16）を明示指定した作品は isFluid=false のまま非破壊。
  const isFluid = isAutoAspectRatio(aspectRatioProp)
  // 初期値は window サイズからの概算（SSR安全に typeof window で分岐）。マウント後すぐ下の
  // ResizeObserver がルート要素の実測値で補正する（向きカテゴリが違えば 1 回だけ再マウントする）。
  const [fluidRatio, setFluidRatio] = useState<AspectRatio>(() => {
    if (!isFluid || typeof window === 'undefined') return DEFAULT_ASPECT_RATIO
    return pickFluidAspectRatio(window.innerWidth, window.innerHeight, splitLayout ?? false)
  })
  // 有効な AspectRatio に正規化。fluid のときは向き追従の fluidRatio を使う。
  const aspectRatio = isFluid ? fluidRatio : parseAspectRatio(aspectRatioProp)
  const { width: gameWidth, height: gameHeight } = ASPECT_RATIOS[aspectRatio]
  // fluid のときだけ、向きカテゴリが変わったら renderer を再マウントするためのキー (#442)。
  // 非 fluid では常に null（値が変わらないので後述のマウント effect の deps は従来どおり
  // 「初回のみ実行」のまま＝既存ゲームは非破壊）。
  const fluidRemountKey = isFluid ? fluidRatio : null

  // fluid モード専用: ルート要素の実サイズを ResizeObserver で監視し、向きカテゴリ
  // （横長/正方形 vs 縦長）が変わったときだけ fluidRatio を更新する (#442)。同カテゴリ内の
  // ピクセル単位の変化（デスクトップでウィンドウ幅を少し変える等）では state を更新しない
  // ＝再マウントしない（renderer の再マウントは PixiJS シーン全体を作り直すコストがあるため、
  // 見た目の「箱の形」が変わる瞬間だけに限定する）。非 fluid では何もしない（早期 return）＝
  // 完全非破壊。
  //
  // #442 self-review should-3: 初期 fluidRatio は window サイズからの概算で、実コンテナ
  // （例: PlayerScreen ではヘッダー分だけ狭い main 領域）とは形が食い違うことがある。
  // 素の useEffect（passive effect）で ResizeObserver を貼るだけだと、初回コールバックが
  // 届いた時点で既に「誤った初期値」で renderer 生成 effect が走った後になり得るため、
  // 直後にもう1回 renderer を作り直す（PixiJS シーン全体を破棄＋再構築する）無駄なコストが
  // 発生し得る。ここでは useLayoutEffect にして、mount 直後・renderer 生成 useEffect（passive
  // effect）が走るより必ず前に `getBoundingClientRect()` で実寸を同期測定し、必要なら
  // fluidRatio をその場で補正する。React は layout effect 内の state 更新を「次の passive
  // effect フェーズに入る前」に同期的に反映するため、renderer 生成 effect が初回に走る時点
  // では既に補正済みの値を見る＝初回の無駄な作り直しが起きない（PixiJS レンダラーは1個目から
  // 正しい aspectRatio で作られる）。
  // 見送った代替案: 「ResizeObserver の初回コールバックが届くまで renderer 生成を待つ」設計
  // （非同期にする）も検討したが、ResizeObserver 非対応環境（極端に古いブラウザ・jsdom 等）で
  // fluidRatio が永久に未確定のままになり renderer が一切作られない退行リスクがあり、
  // 「マウント時に1度だけレンダラーを生成する」という既存の設計方針と衝突して複雑化するため
  // 見送った。今回の同期測定方式は non-fluid の既存 useEffect 構造・依存配列を一切変えず、
  // getBoundingClientRect() が 0 を返す環境（jsdom 等）では単に補正をスキップして
  // 従来どおり window ベースの概算のまま進む（非破壊フォールバック）。
  useLayoutEffect(() => {
    if (!isFluid) return
    const root = fluidRootRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      const measured = pickFluidAspectRatio(rect.width, rect.height, splitLayout ?? false)
      setFluidRatio((prev) => (prev === measured ? prev : measured))
    }
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width <= 0 || height <= 0) return
      const next = pickFluidAspectRatio(width, height, splitLayout ?? false)
      setFluidRatio((prev) => (prev === next ? prev : next))
    })
    observer.observe(root)
    return () => observer.disconnect()
    // splitLayout は #442 と同じ設計で「construct 時に固定」の値として扱う（動的変更は
    // 向きカテゴリ変化と同じ再マウント経路に乗らない）。isFluid のみを deps にする既存方針を
    // 踏襲し、値は closure 経由でそのまま使う（react-hooks/exhaustive-deps はこのプロジェクトでは未設定）。
  }, [isFluid])

  // 実表示サイズに応じた canvas 解像度の動的追従 (#446)。containerRef（letterbox 内接矩形。
  // canvas 要素はこの箱いっぱいに CSS で引き伸ばされる — 下の gameBoxStyle 定義箇所参照）の
  // 実測 CSS 表示サイズを ResizeObserver で監視し、devicePixelRatio に加えて
  // 「実表示幅 / 論理幅(gameWidth)」の引き伸ばし倍率もレンダラ解像度へ反映する
  // （computeDynamicRenderResolution、novelLayout.ts）。
  //
  // 上の fluidRootRef 用 ResizeObserver（#442）とは目的が異なる別の観測: あちらは fluid
  // （aspect_ratio: auto）時のみ・向きカテゴリ（横長/縦長）が変わったときだけ発火して
  // renderer を再マウントする粗い監視。こちらは fluid/非fluid 問わず常時、実表示サイズの
  // 連続的な変化（ウィンドウリサイズ・最大化等）を追い、既存 renderer のレンダラ解像度だけを
  // setRenderResolution() で更新する（screenWidth/Height・PixiJS シーン自体は変えない）。
  // isFluid の条件分岐に依存しないため、Gymnasia 以外の非 fluid ゲーム（theo-hayami/attama 等）
  // でも同じく動作する。
  //
  // 初回マウント時の適用は上の renderer 生成 effect（`renderer.init(...).then(...)`内）が
  // 担当する（app.renderer が確実に存在するタイミングで同期測定して1回適用する）。ここでの
  // 初回同期測定（下の getBoundingClientRect）は fluidRootRef effect と同じパターンを踏襲した
  // 保険（renderer 未初期化ならレンダラ側の no-op ガードで単に何もしない）。
  //
  // ドラッグリサイズ中の連打で毎フレーム renderer.resize() が走ると重いため debounce する。
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const apply = (displayWidth: number) => {
      const renderer = rendererRef.current
      if (!renderer) return
      // 動画書き出し中 (#228/#279) は VideoExporter が意図的にレンダラ解像度を上げている。
      // この自動追従で上書きすると書き出し品質が下がるため、書き出し中は何もしない
      // （書き出し終了は VideoExporter の cleanup が prevResolution へ確実に復元する設計。
      // 復元後にサイズが変わっていれば次のリサイズで本 effect が改めて追従する）。
      if (renderer.isExporting()) return
      const dpr = resolveDevicePixelRatio()
      renderer.setRenderResolution(
        computeDynamicRenderResolution(displayWidth, gameWidth, gameHeight, dpr)
      )
    }

    const scheduleApply = (displayWidth: number) => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => apply(displayWidth), 200)
    }

    // 初回同期測定（fluidRootRef effect と同じパターン、#442 参照）。debounce せず即適用する。
    const rect = container.getBoundingClientRect()
    if (rect.width > 0) {
      apply(rect.width)
    }

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width } = entry.contentRect
      if (width <= 0) return
      scheduleApply(width)
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
    // gameWidth/gameHeight はアスペクト比が変わると変化する（fluid の向きカテゴリ変化・非fluid の
    // aspectRatio prop 変化）。変化のたびに effect を張り直し、closure 内の gameWidth/gameHeight を
    // 常に現在の論理サイズに保つ（rendererRef 経由なので再マウント有無に関わらず現在の renderer を
    // 常に指す。上の fluidRemountKey 再マウント effect とは独立）。gameHeight も deps に含めるのは、
    // `16:9`(800×450)→`4:3`(800×600) のように gameWidth は不変でも gameHeight だけが変わる
    // 組み合わせ（ASPECT_RATIOS 参照）で closure 内の gameHeight が stale にならないようにするため
    // （#446 再レビュー question対応でクランプ計算に gameHeight を使うようになったのに伴う追従）。
  }, [gameWidth, gameHeight])

  // インジケータ画像の先読み (#413)。assetBaseUrl が分かった時点で、renderer の生成/初期化
  // （下の init effect の `renderer.init(...).then(...)`）を待たずにインジケータ画像（next/pageturn
  // 計8枚）の Assets.load() を fire-and-forget で開始する。renderer/DialogBox の状態には
  // 一切触れない独立した effect なので、renderer 生成前でも安全（rendererRef を参照しない）。
  // PixiJS の Assets.load() は同一 URL の in-flight/解決済み Promise をキャッシュ共有するため、
  // ここが早く走るほど、後段の DialogBox.loadIndicatorFrames（renderer.init() 完了後に発火）が
  // 同じ URL を要求したときには既に解決済み/解決間近になり、初回表示時に一瞬 ▼ フォールバックが
  // 挟まる事故（#413 本題）を防げる。失敗（404 等）は DialogBox 側の本読み込みが別途拾うので、
  // ここでは黙って握りつぶす。
  useEffect(() => {
    if (!assetBaseUrl) return
    const urls = (['next', 'pageturn'] as const).flatMap((kind) =>
      getIndicatorImageUrls(assetBaseUrl, kind)
    )
    Promise.all(urls.map((url) => Assets.load(url))).catch(() => {})
  }, [assetBaseUrl])

  // ライフサイクル管理: init + destroy
  // aspectRatio（非 fluid）が変わる場合はコンポーネントを再マウントすること
  // （依存配列は fluidRemountKey のみ：レンダラーは基本マウント時に1度だけ生成する設計。
  // fluid（aspect_ratio: auto）のときだけ、向きカテゴリが変わるたびに fluidRemountKey が
  // 変化して自動的に再マウントする (#442)。非 fluid では fluidRemountKey は常に null で
  // 不変のため、この effect は従来どおり「初回のみ実行」＝既存ゲームは非破壊。）
  useEffect(() => {
    if (!containerRef.current) return

    const renderer = new NovelRenderer({ aspectRatio })
    rendererRef.current = renderer
    // デバッグ用に window へ露出 (production でも軽量なので残す)
    ;(window as unknown as { __renderer?: NovelRenderer }).__renderer = renderer

    let destroyed = false

    renderer.init(containerRef.current).then(() => {
      if (destroyed) {
        renderer.destroy()
        return
      }
      // 実表示サイズに応じた初期解像度 (#446)。canvas は containerRef いっぱいに CSS で
      // 引き伸ばされるため、devicePixelRatio だけでなく実測 CSS 幅と論理幅(gameWidth)の
      // 引き伸ばし倍率もレンダラ解像度へ反映する。ここでは app.init() 完了直後（＝
      // renderer.app.renderer が確実に存在するタイミング）に同期測定して1回適用する。
      // 以降のサイズ変化（ウィンドウリサイズ・最大化等）は下の常設 ResizeObserver effect
      // （containerRef 監視、fluid/非fluid 共通、#446）が引き継いで追従する。
      renderer.setRenderResolution(
        computeDynamicRenderResolution(
          containerRef.current?.getBoundingClientRect().width ?? 0,
          gameWidth,
          gameHeight,
          resolveDevicePixelRatio()
        )
      )
      if (assetBaseUrl) {
        renderer.setAssetBaseUrl(assetBaseUrl)
      }
      renderer.setMissingSceneResolver?.(onResolveMissingScene ?? null)
      // `?scene=` ディープリンク単独埋め込みの confinement (#386)。setEvents/setJumpSceneIndex/
      // startFrom より前に設定し、以降のどの choice ジャンプも圏外判定の対象にする。
      renderer.setConfinedSceneIds(confinedSceneIds ?? null)
      // renderer が手動操作で autoMode を OFF にしたとき React state を同期 (#139)
      renderer.setOnAutoModeChange((on) => setAutoMode(on))
      // renderer が未読到達で skipMode を OFF にしたとき React state を同期 (#140)
      renderer.setOnSkipModeChange((on) => setSkipMode(on))
      // スライダ操作中（active）は下部丸ボタン行をフェード退避させる (#350)
      renderer.setOnSeekActiveChange((active) => setSeekActive(active))
      // 終劇状態が変化したら "to be continued..." の表示を同期する (#386)。
      // さらに終劇（ended の true 立ち上がり）に達した瞬間、iframe 埋め込み時のみ
      // 親ウィンドウへ「このセルを読み終わった」を postMessage で通知する (#395)。
      // 埋め込み側（theo-hayami）は name-name の別オリジン既読 localStorage を読めないため、
      // ここで完読を通知して自前で記録させる。false（終劇解除＝復元/巻き戻し）や standalone
      // （非埋め込み）では送らない。endStory() 側が二重発火を弾くので true は 1 遷移 1 回だけ届く。
      // メッセージ組み立ては純粋関数 buildStoryEndedMessage に切り出し（doctrine 規律6）、
      // 発火（副作用）だけここで行う。契約は theo-hayami #30 と共有・厳守。
      // 送信先 origin は '*'（埋め込み側を name-name は知らない。機微情報なし＝受信側で origin 検証する前提）。
      // once-only の前提: この「true は 1 遷移 1 回」は endStory() の二重発火ガードに加え、
      // storyEnded が seekable history / セーブに載らない（#386 が意図的に除外）ことに依存する。
      // 将来 storyEnded を復元対象に含める変更を入れると applyState(true) 経由で goBack/seekTo/
      // ロードのたびに再発火するので、その際はここのガードを見直すこと。
      // initialSceneId/docKey は空 deps init effect 内で mount 時にキャプチャする。埋め込み経路では
      // ?scene=/project が変わる＝iframe 再読み込み＝再マウントなので stale にならない。
      renderer.setOnStoryEndedChange((ended) => {
        setStoryEnded(ended)
        // #404: intermission.md 専用シーンが使われたかを ended の立ち上がり時点でスナップショット
        // する（DOM "to be continued..." 表示との排他はこの値で判定する。上の宣言コメント参照）。
        setUsedIntermissionScene(ended && renderer.hasIntermissionScene())
        if (ended && isEmbedded()) {
          const message = buildStoryEndedMessage(initialSceneId ?? null, docKey ?? '')
          window.parent.postMessage(message, '*')
        }
      })
      if (docKey) {
        renderer.setDocKey(docKey)
      }
      // 選択肢スタイル (#146)
      renderer.setChoiceStyle(choiceStyle ?? null)
      // per-game フォント (#147)
      renderer.setFontFamily(fontFamily ?? null)
      // per-game 本文フォントサイズ (#283 補遺)。setDialogStyle/setEvents より前に設定し、
      // 初回の novel 改頁が正しい本文サイズ（行高）で計算されるようにする。
      renderer.setFontSize(fontSize ?? null)
      // 会話の描画スタイル (#283)。setEvents/setScenes より前に設定し、初回描画から
      // novel スタイル（名札 OFF・スクリム・改頁）を反映させる。
      renderer.setDialogStyle(dialogStyle ?? null)
      // 質問役（主人公）の話者名 (#286)。setEvents/setScenes より前に設定し、初回の
      // novel 立ち絵配置（質問役=左 / 回答役=右）が正しい役割で決まるようにする。
      renderer.setProtagonist(protagonist ?? null)
      // 話者交代 nudge の発火可否 (#382)。既定 false＝非発火（opt-in）。true でのみ発火、null/undefined/false は非発火。
      renderer.setSpeakerNudge(speakerNudge ?? null)
      // 画面比率に応じた画像/テキストの左右・上下分割配置 (#442)。dialog_style とは独立の軸。
      // setEvents/setScenes（＝最初の立ち絵 show）より前に設定し、初回描画から領域確定済みにする。
      renderer.setSplitLayout(splitLayout ?? null)
      // 文単位の厳密改頁 (#448)。dialog_style とは独立の軸。setEvents/setScenes（＝初回改頁計算）
      // より前に設定し、初回描画から「1 ページ=1 文」が反映済みになるようにする。
      renderer.setSentencePerPage(sentencePerPage ?? null)
      // テクスチャ拡大縮小フィルタ (#466)。dialog_style/splitLayout とは独立の軸。
      // setEvents/setScenes（＝最初のテクスチャロード）より前に設定し、初回表示から
      // 立ち絵・イベント絵ともに nearest/linear が確定済みになるようにする。
      renderer.setPixelArt(pixelArt ?? null)
      // 立ち絵の足元 Y 比率 (#308)。setEvents/setScenes（＝最初の立ち絵 show）より前に設定し、
      // 初回描画から per-game の足元位置（全身 / 靴を切る）で立つようにする。
      renderer.setCharacterYRatio(characterYRatio ?? null)
      // 立ち絵の目標表示高さ比率 (#360)。setEvents/setScenes（＝最初の立ち絵 show）より前に設定し、
      // 初回描画から per-game の目標高さで立ち絵をスケールする（高解像度立ち絵の巨大化を吸収）。
      renderer.setCharacterHeightRatio(characterHeightRatio ?? null)
      // キャラごとの立ち絵目標表示高さ比率 override (#364)。characterHeightRatio と同じく
      // setEvents/setScenes（＝最初の立ち絵 show）より前に設定し、初回描画から per-character の
      // 目標高さでスケールする（身長差のあるキャストで共通 ratio が身長差を潰すのを防ぐ）。
      renderer.setCharacterHeightRatios(characterHeightRatios ?? null)
      // 立ち絵の元絵基準スケール (#378)。setEvents/setScenes（＝最初の立ち絵 show）より前に設定し、
      // 初回描画から fit(#294) の次（height_ratio より優先）で元絵基準の一律スケールを適用する
      // （元絵に焼き込んだ身長差をそのまま出す）。未指定なら下位優先順位へフォールバック（後方互換）。
      renderer.setCharacterScale(characterScale ?? null)
      // 立ち絵フェード時間。初回 show より前に設定し、ToHeart 式のじわっとした登場を作品単位で調整する。
      renderer.setCharacterFadeMs(characterFadeMs ?? null)
      // 背景フェード時間 (#407)。初回背景表示より前に設定し、背景の表示（イン）・切り替え・退場（アウト）を
      // 作品単位で調整する（未指定なら既定 700ms＝BACKGROUND_CROSSFADE_MS で非回帰）。
      renderer.setBackgroundFadeMs(backgroundFadeMs ?? null)
      // イベント絵フェード時間。個別 `フェード=` が無いイベント絵の表示・退場に使う。
      renderer.setEventImageFadeMs(eventImageFadeMs ?? null)
      // 下地ベタの既定色 (#409)。初回背景表示より前に設定し、最初の背景絵がこの地色から
      // フェードインするようにする（未指定なら黒で非回帰）。setBackgroundFadeMs と対称の per-game 設定。
      renderer.setDefaultBackgroundColor(backgroundColor ?? null)
      // SeekBar のフィル／つまみ色 (#440)。setDefaultBackgroundColor と対称の per-game 設定。
      // 未指定/不正値なら既定の水色にフォールバック（後方互換）。
      renderer.setSeekBarColor(seekbarColor ?? null)
      // intermission.md 専用シーン (#404)。PlayerScreen が非同期取得するため、マウント時点では
      // まだ未解決（null）のことが多いが、後段の setEvents/startFrom より前に一度呼んでおく
      // （解決後は下の intermissionEvents 変化 effect が反映する）。
      renderer.setIntermissionScene(intermissionEvents ?? null, {
        backgroundFadeMs: intermissionBackgroundFadeMs ?? null,
        characterFadeMs: intermissionCharacterFadeMs ?? null,
        eventImageFadeMs: intermissionEventImageFadeMs ?? null,
      })
      // 主人公セリフの本文色 (#305) は renderer 既定 #FFF0D8 のまま使う。frontmatter での
      // 色上書きは未実装のため、ここでは設定しない（renderer フィールド初期値が効く）。
      // init 完了直後に現在の settings を反映 (#138)
      renderer.applySettings(settings)
      // 再生ストリームの確定 (#284):
      //   - scenes 指定（後方互換）: setScenes で scenes[0] から再生 + allScenes 索引化
      //   - それ以外: events を線形再生（多シーン自動進行を維持）。jumpSceneIndex が
      //     あればジャンプ解決索引だけを別建てで設定する（再生ストリームは置換しない）。
      // どちらの経路でも debug_scene/debug_script は allScenes が埋まった後に発火させる。
      if (scenes && scenes.length > 0) {
        renderer.setScenes(scenes)
      } else {
        // ジャンプ索引を先に設定してから線形再生を流す。
        // （startFrom/playScript が allScenes を必要とするため events より前に置く）
        if (jumpSceneIndex && jumpSceneIndex.length > 0) {
          renderer.setJumpSceneIndex(jumpSceneIndex)
        }
        renderer.setEvents(events)
      }
      // fluid 再マウント (#460): 直前 renderer から引き継いだスナップショットがあれば
      // restoreSnapshot で読み進め位置（背景/立ち絵/BGM 込み）を復元する。setEvents/setScenes
      // 直後（allScenes 構築済み）のこのタイミングでのみ呼べる。この経路を通った場合、下の
      // initialSceneId ベースの startFrom は行わない（二重に位置決めしない）。
      const pendingSnapshot = pendingSnapshotRef.current
      pendingSnapshotRef.current = null
      if (pendingSnapshot) {
        renderer.restoreSnapshot(pendingSnapshot)
      } else if (initialSceneId) {
        // production でも有効な起点シーン指定 (#386)。sceneId が属する script の事前ロードは
        // PlayerScreen 側の責務（呼び出し時点で jumpSceneIndex に反映済みの前提）。ここでは
        // 既存の startFrom(#220) をそのまま呼ぶだけで、renderer 側に新規ロジックは持ち込まない。
        // 不正/未解決 sceneId は startFrom 内で no-op（現行どおりエントリ再生にフォールバック）。
        renderer.startFrom({ sceneId: initialSceneId })
      }

      // URL クエリによるデバッグ起点指定 (#220 Phase 3)。
      // DEV ビルドでのみ有効。production ではこのブロックごと tree-shake される。
      // debug_scene は sceneId 前提。scenes / jumpSceneIndex のどちらの索引でも解決する。
      // initialSceneId(#386) より後に評価するため、dev では debug_scene が指定時に優先される
      // （デバッグ目的の上書きを production 経路より優先させる）。
      if (import.meta.env.DEV) {
        const debug = parseDebugQuery(window.location.search)
        if (debug && 'script' in debug) {
          void renderer.playScript(debug.script)
        } else if (debug && 'scene' in debug) {
          renderer.startFrom(debug.scene)
        }
      }
      onRendererReady?.(renderer)
    })

    return () => {
      destroyed = true
      onRendererReady?.(null)
      // fluid 再マウント (#460): 破棄前に現在位置のスナップショットを保持し、次の renderer
      // 初期化時に restoreSnapshot で引き継ぐ。getSnapshot() は init() 未完了でも安全に呼べる
      // （constructor で作られる値オブジェクトの読み出しのみで this.app には触れない）が、
      // その状態では sceneId が null（＝setEvents/setScenes すら走っていない）ため意味のある
      // スナップショットにならない。
      // #460 セルフレビュー should S1: sceneId が null のときは pendingSnapshotRef を上書きしない
      // （直前に有効な値が入っていればそれを保持し続ける）。pendingSnapshotRef は単一の共有 ref
      // なので、無条件上書きだと短時間の二重連続 remount（gen0→gen1(init 未完了)→gen2）で
      // gen1 の cleanup が「まだ何も進行していない空スナップショット」で gen0 の有効な
      // スナップショットを消してしまい、gen2 が結局位置ロストする事故になる。
      const snapshot = renderer.getSnapshot()
      if (snapshot.sceneId !== null) {
        pendingSnapshotRef.current = snapshot
      }
      renderer.destroy()
      rendererRef.current = null
    }
  }, [fluidRemountKey])

  // 設定変更を renderer に反映 + localStorage に保存 (#138)
  useEffect(() => {
    rendererRef.current?.applySettings(settings)
    debouncedSave.save(settings)
  }, [settings, debouncedSave])

  // unmount 時に debounce 中の保存を flush する（取りこぼし防止）
  useEffect(() => {
    return () => {
      debouncedSave.flush()
    }
  }, [debouncedSave])

  // docKey が変化したときに renderer に反映 (#140): 同じコンポーネントが再利用される場合の考慮
  useEffect(() => {
    if (docKey) {
      rendererRef.current?.setDocKey(docKey)
    }
  }, [docKey])

  // docKey が変化したら終劇ロゴの読み込み失敗フラグをリセットする (#404): 同じコンポーネント
  // インスタンスが別プロジェクトに再利用された場合、前のプロジェクトでの読み込み失敗が
  // 新プロジェクトのロゴ表示を誤って抑止しないようにする。
  useEffect(() => {
    setStoryEndedLogoFailed(false)
  }, [docKey])

  // choiceStyle が変化したときに renderer に反映 (#146)
  useEffect(() => {
    rendererRef.current?.setChoiceStyle(choiceStyle ?? null)
  }, [choiceStyle])

  // fontFamily が変化したときに renderer に反映 (#147)
  useEffect(() => {
    rendererRef.current?.setFontFamily(fontFamily ?? null)
  }, [fontFamily])

  // fontSize が変化したときに renderer に反映 (#283 補遺)
  useEffect(() => {
    rendererRef.current?.setFontSize(fontSize ?? null)
  }, [fontSize])

  // dialogStyle が変化したときに renderer に反映 (#283)
  useEffect(() => {
    rendererRef.current?.setDialogStyle(dialogStyle ?? null)
  }, [dialogStyle])

  // protagonist が変化したときに renderer に反映 (#286)
  useEffect(() => {
    rendererRef.current?.setProtagonist(protagonist ?? null)
  }, [protagonist])

  // speakerNudge が変化したときに renderer に反映 (#382)
  useEffect(() => {
    rendererRef.current?.setSpeakerNudge(speakerNudge ?? null)
  }, [speakerNudge])

  // splitLayout が変化したときに renderer に反映 (#442)
  useEffect(() => {
    rendererRef.current?.setSplitLayout(splitLayout ?? null)
  }, [splitLayout])

  // sentencePerPage が変化したときに renderer に反映 (#448)
  useEffect(() => {
    rendererRef.current?.setSentencePerPage(sentencePerPage ?? null)
  }, [sentencePerPage])

  // pixelArt が変化したときに renderer に反映 (#466)
  useEffect(() => {
    rendererRef.current?.setPixelArt(pixelArt ?? null)
  }, [pixelArt])

  // characterYRatio が変化したときに renderer に反映 (#308)
  useEffect(() => {
    rendererRef.current?.setCharacterYRatio(characterYRatio ?? null)
  }, [characterYRatio])

  // characterHeightRatio が変化したときに renderer に反映 (#360)
  useEffect(() => {
    rendererRef.current?.setCharacterHeightRatio(characterHeightRatio ?? null)
  }, [characterHeightRatio])

  // characterHeightRatios が変化したときに renderer に反映 (#364)
  useEffect(() => {
    rendererRef.current?.setCharacterHeightRatios(characterHeightRatios ?? null)
  }, [characterHeightRatios])

  // characterScale が変化したときに renderer に反映 (#378)
  useEffect(() => {
    rendererRef.current?.setCharacterScale(characterScale ?? null)
  }, [characterScale])

  useEffect(() => {
    rendererRef.current?.setCharacterFadeMs(characterFadeMs ?? null)
  }, [characterFadeMs])

  // backgroundFadeMs が変化したときに renderer に反映 (#407)
  useEffect(() => {
    rendererRef.current?.setBackgroundFadeMs(backgroundFadeMs ?? null)
  }, [backgroundFadeMs])

  useEffect(() => {
    rendererRef.current?.setEventImageFadeMs(eventImageFadeMs ?? null)
  }, [eventImageFadeMs])

  // backgroundColor（下地ベタの既定色）が変化したときに renderer に反映 (#409)
  useEffect(() => {
    rendererRef.current?.setDefaultBackgroundColor(backgroundColor ?? null)
  }, [backgroundColor])

  // seekbarColor（SeekBar のフィル／つまみ色）が変化したときに renderer に反映 (#440)
  useEffect(() => {
    rendererRef.current?.setSeekBarColor(seekbarColor ?? null)
  }, [seekbarColor])

  // intermission.md 専用シーン (#404)。PlayerScreen の非同期取得（assets/raw 経由）は
  // マウント後に解決することが多いため、init effect（マウント時1回）だけでは反映できない。
  // 値が届き次第 renderer に反映する。
  useEffect(() => {
    rendererRef.current?.setIntermissionScene(intermissionEvents ?? null, {
      backgroundFadeMs: intermissionBackgroundFadeMs ?? null,
      characterFadeMs: intermissionCharacterFadeMs ?? null,
      eventImageFadeMs: intermissionEventImageFadeMs ?? null,
    })
  }, [
    intermissionEvents,
    intermissionBackgroundFadeMs,
    intermissionCharacterFadeMs,
    intermissionEventImageFadeMs,
  ])

  // 設定パネルの開閉ショートカット (#138): Ctrl/Cmd + , で開く
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setSettingsOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  // フルスクリーン状態の追従 (#468)。ブラウザの Esc キー・OS 側操作等、ボタン以外の経路で
  // フルスクリーンが解除/開始されるケースもあるため、document の 'fullscreenchange' を正として
  // 都度ミラーする（自前 state を先行させない）。
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === fluidRootRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // フルスクリーン最大化トグルの押下ハンドラ (#468)。対象は fluidRootRef（ゲーム画面自体）。
  // 非対応ブラウザ（requestFullscreen が無い）・拒否（Promise reject）・iframe 埋め込みで
  // Permissions Policy によりブロックされる場合（同期 throw のことがある）のいずれも例外を
  // 握りつぶし、通常表示のまま何も起きない（完了条件: 非対応/拒否時のフォールバック）。
  //
  // 分岐条件は `document.fullscreenElement === el`（自分自身がフルスクリーン中か）で判定する。
  // 上の isFullscreen state と同じ厳密比較にすることで、ホストページの別ウィジェット等
  // 「別要素が既にフルスクリーン中」のケースを「自分がフルスクリーン中」と誤認しない。
  // 誤認すると、ボタンの見た目は「フルスクリーンにする」なのに実際には他要素の
  // exitFullscreen() を呼んでしまい、意図と逆の副作用（他要素のフルスクリーン解除）が起きる。
  const handleFullscreenToggle = useCallback(() => {
    const el = fluidRootRef.current
    if (!el) return
    try {
      if (document.fullscreenElement === el) {
        const result = document.exitFullscreen()
        result?.catch(() => {})
      } else if (el.requestFullscreen) {
        const result = el.requestFullscreen()
        result?.catch(() => {})
      }
    } catch {
      // 非対応/拒否は握りつぶす（フォールバックは「何もしない」＝通常表示のまま）
    }
  }, [])

  // letterbox/pillarbox の黒帯（canvas 外）タップで進行する (#467)。fluidRootRef 直下の
  // 黒帯部分（canvas を内接させる containerRef の外側）には canvas 自身の pointerdown
  // リスナーが届かないため、fluidRootRef 側にも同じ「進める」処理を持たせる。
  // `e.target === e.currentTarget` で「fluidRootRef 自身への直接タップ」だけに絞り込む
  // （canvas・ボタン等の子要素タップはそれぞれ自前のリスナーで処理済みなので、ここで拾うと
  // 二重発火する。バブリングで来た子要素タップは target が子要素のままなので弾かれる）。
  const handleOutsideCanvasPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    rendererRef.current?.handleOutsideCanvasTap()
  }, [])

  // クイックセーブ/ロード 通知 toast を表示するヘルパー (#142)
  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 2000)
  }, [])

  // F5: クイックセーブ / F8: クイックロード (#142)
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'F5') {
        e.preventDefault()
        const ok = rendererRef.current?.quickSave() ?? false
        showToast(ok ? 'クイックセーブしました' : 'この場面ではセーブできません')
      } else if (e.key === 'F8') {
        e.preventDefault()
        const ok = rendererRef.current?.quickLoad() ?? false
        showToast(ok ? 'クイックロードしました' : 'クイックセーブデータがありません')
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [showToast])

  // unmount 時に toast タイマーをクリア
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  // assetBaseUrl が変わったらレンダラーに反映
  useEffect(() => {
    if (rendererRef.current && assetBaseUrl) {
      rendererRef.current.setAssetBaseUrl(assetBaseUrl)
    }
  }, [assetBaseUrl])

  // events / scenes / jumpSceneIndex が変わったらレンダラーに反映 (#284)
  useEffect(() => {
    if (!rendererRef.current) return
    if (scenes && scenes.length > 0) {
      rendererRef.current.setScenes(scenes)
    } else {
      // ジャンプ索引を先に更新してから線形再生を流す（init と同順）。
      if (jumpSceneIndex && jumpSceneIndex.length > 0) {
        rendererRef.current.setJumpSceneIndex(jumpSceneIndex)
      }
      rendererRef.current.setEvents(events)
    }
  }, [events, scenes, jumpSceneIndex])

  useEffect(() => {
    rendererRef.current?.setMissingSceneResolver?.(onResolveMissingScene ?? null)
  }, [onResolveMissingScene])

  // 「つづきから」: 初回イベントセット後に一度だけスキップモードを ON にする (#141)
  // initialSkipMode が false の間は早期 return するため ref はセットされない。
  // initialSkipMode が true になった初回のみ ref をセットして発動し、以降の events 更新では再発動しない。
  const initialSkipAppliedRef = useRef(false)
  useEffect(() => {
    if (!initialSkipMode || !docKey) return
    if (initialSkipAppliedRef.current) return
    initialSkipAppliedRef.current = true
    rendererRef.current?.setSkipMode(true)
    setSkipMode(true)
  }, [events, scenes, initialSkipMode, docKey])

  // オートモード変更を renderer に反映 (#139)
  useEffect(() => {
    rendererRef.current?.setAutoMode(autoMode)
  }, [autoMode])

  // スキップモード変更を renderer に反映 (#140)
  useEffect(() => {
    rendererRef.current?.setSkipMode(skipMode)
  }, [skipMode])

  const handleAutoToggle = () => {
    setAutoMode((v) => !v)
  }

  const handleSkipToggle = () => {
    setSkipMode((v) => !v)
  }

  // デバッグ HUD の D ボタン: 押すと展開・再押しで畳む。状態は localStorage に永続化 (#310)。
  const handleDebugToggle = () => {
    setDebugOpen((v) => {
      const next = !v
      writeDebugOpen(next)
      return next
    })
  }

  // デバッグ HUD のパネル内 × ボタン: 常に閉じるだけ。全体化中で D ボタンが裏に回り
  // 再押下で畳めなくなる問題への主対応 (#438)。トグルではなく閉じる専用。
  const handleDebugClose = () => {
    setDebugOpen(false)
    writeDebugOpen(false)
  }

  // デバッグ HUD（D ボタン + パネル）を出すか (#310)。
  // /play は debug_enabled（frontmatter）、/edit は常時 true（EditorScreen が渡す）。
  const debugAvailable = debugEnabled === true
  // Skip(S) ボタンを描画するか (#310)。未指定/true で出す（既定・後方互換）、false で出さない。
  const showSkipButton = skipEnabled !== false

  // 右下ボタン列のレイアウト (#310)。右端から ⚙→A→S→D の順に 44px 間隔で左へ並べる。
  // 条件付きで消える S / D があっても隙間が空かないよう、実際に出るボタンだけを右から
  // 詰めてスロット番号を採番し、`right = 12 + slot*44`(px) で位置を導出する（特例分岐を作らない）。
  // #350: SeekBar(novelLayout) と同じ定数を参照し、片方を変えてももう片方が揃うようにする
  // （ボタン中央高さ＝つまみ中心高さの一致を定数で担保。期待値の二重定義を避ける）。
  const SLOT_GAP_PX = PLAYER_BUTTON_SLOT_GAP_PX // ボタン幅 36px(w-9) + 余白 8px
  const SLOT_BASE_PX = PLAYER_BUTTON_RIGHT_MARGIN_PX // 右端マージン（旧 right-3 = 0.75rem）
  const slotRight = (slot: number): string => `${SLOT_BASE_PX + slot * SLOT_GAP_PX}px`
  // 採番順 = 右から（settings が slot 0）。出るボタンだけを push して詰める。
  const buttonOrder: Array<'settings' | 'auto' | 'skip' | 'debug'> = ['settings', 'auto']
  if (showSkipButton) buttonOrder.push('skip')
  if (debugAvailable) buttonOrder.push('debug')
  const slotOf = (id: 'settings' | 'auto' | 'skip' | 'debug'): number => buttonOrder.indexOf(id)

  // ゲーム描画箱（letterbox/pillarbox 後の内接矩形）の寸法 (#350)。canvas ラッパと下部ボタン行の
  // 両方に同じ寸法を当て、**ボタンをキャンバス箱に重ねる**ことで、丸ボタンの下端基準＝キャンバス下端と
  // 一致させる。これをしないとボタンは root（画面）下端基準になり、レターボックスがある端末で
  // 「画面下端」と「キャンバス下端」がズレ、キャンバス内のスライダと丸ボタンの上下中心が合わない。
  const gameBoxStyle: CSSProperties = {
    aspectRatio: `${gameWidth} / ${gameHeight}`,
    width: `min(100cqw, calc(100cqh * ${gameWidth} / ${gameHeight}))`,
    height: `min(100cqh, calc(100cqw * ${gameHeight} / ${gameWidth}))`,
  }

  return (
    <div
      ref={fluidRootRef}
      className="relative w-full h-full flex items-center justify-center bg-black"
      style={{ containerType: 'size' }}
      // letterbox/pillarbox の黒帯タップで進行する (#467)。canvas 自身の pointerdown
      // リスナーが届かない黒帯部分（このコンポーネント直下・canvas の外側）だけを拾う。
      onPointerDown={handleOutsideCanvasPointerDown}
    >
      {/* デバッグ HUD パネル (#310): D ボタンの展開状態に追従。debug_enabled(/play) or
          editor のときだけ出す。閉じている/無効のときは何も描かない（D ボタンが唯一の入口）。 */}
      {debugAvailable && (
        <DebugOverlay
          rendererRef={rendererRef}
          open={debugOpen}
          debugInfo={debugInfo}
          onClose={handleDebugClose}
        />
      )}
      {/* 親 (bg-black, container-type: size) を基準に letterbox/pillarbox する内接矩形。
          ゲーム比率を維持して親に内接させる（縦長スマホは上下に黒帯、横長は左右に黒帯）。
          寸法は gameBoxStyle に集約し、下部ボタン行と共有する (#350)。 */}
      <div
        ref={containerRef}
        className="overflow-hidden [&>canvas]:block [&>canvas]:w-full [&>canvas]:h-full"
        style={gameBoxStyle}
      />
      {/* フルスクリーン最大化トグル (#468)。エンジン標準機能として全ゲーム共通で右上寄りに置く
          （右下の ⚙→A→S→D 列とは別位置）。押すたびに fluidRootRef 全体（ゲーム画面自体。
          PlayerScreen のヘッダ等は含まない）をブラウザのフルスクリーン表示に出し入れする。
          アイコンの向き（外向き矢印=通常表示中→押すと最大化 / 内向き矢印=最大化中→押すと解除）
          で現在の状態を示す。 */}
      <button
        type="button"
        onClick={handleFullscreenToggle}
        aria-label={isFullscreen ? 'フルスクリーンを解除する' : 'フルスクリーンで表示する'}
        aria-pressed={isFullscreen}
        title="フルスクリーン"
        className="absolute top-3 right-3 z-10 w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {isFullscreen ? (
            // 内向き矢印（縮小 = フルスクリーン解除）
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"
            />
          ) : (
            // 外向き矢印（拡大 = フルスクリーン化）
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
            />
          )}
        </svg>
      </button>
      {/* 操作ボタン列 (#310): クリッカー/ダイアログ送り/シークバーと干渉しない右下隅に集約。
          右端から ⚙→A→S→D の順に並べ、消えるボタンがあっても詰めて隙間を作らない。
          #350: スライダ操作中(seekActive)はこの行ごと opacity でフェード退避し、pointer-events も
          切ってスライダのタップを邪魔しない。ラッパ自身は inset-0 + pointer-events-none で canvas の
          クリック（ダイアログ送り）を透過し、子ボタンだけ pointer-events-auto で拾う。キーボード
          ショートカット(Ctrl/⌘+, / F5 / F8)は window レベル listener なのでフェードの影響を受けない。
          a11y(#350): active 時は inert を付け、フェード退避中の子ボタンをフォーカス不能＋a11y ツリー外
          ＋ポインタ不能に一括で落とす（aria-hidden サブツリー内に focusable が残る問題を解消）。
          React 18 の型には inert が無いので属性スプレッドで付与し、見た目のフェードは opacity に残す。 */}
      <div
        {...(seekActive ? { inert: '' } : {})}
        aria-hidden={seekActive}
        // #350: inset-0 + m-auto + gameBoxStyle で **キャンバス箱とぴったり重ねる**（root 全体でなく）。
        // これで丸ボタンの bottom-3 がキャンバス下端基準になり、レターボックス端末でもキャンバス内の
        // スライダと丸ボタンの上下中心が一致する。pointer-events-none で canvas のクリックは透過。
        className={`absolute inset-0 m-auto pointer-events-none transition-opacity duration-200 ${
          seekActive
            ? 'opacity-0 [&_button]:pointer-events-none'
            : 'opacity-100 [&_button]:pointer-events-auto'
        }`}
        style={gameBoxStyle}
      >
        {/* スキップボタン (#140): docKey がある場合のみ有効。skip_enabled=false で非表示 (#310) */}
        {showSkipButton && (
          <button
            type="button"
            onClick={handleSkipToggle}
            // #404 セルフレビュー S1: 終劇後は setSkipMode() 自体が renderer 側で no-op になるが、
            // ボタンも押せない見た目に揃える（根本ガードの上乗せ UX。防御の主体は renderer 側）。
            disabled={!docKey || storyEnded}
            aria-label={skipMode ? 'スキップモードをオフにする' : 'スキップモードをオンにする'}
            title="スキップ（既読のみ）"
            style={{ right: slotRight(slotOf('skip')) }}
            className={`absolute bottom-3 w-9 h-9 flex items-center justify-center rounded-full text-sm font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              skipMode
                ? 'bg-green-500/80 hover:bg-green-500 text-white'
                : 'bg-black/50 hover:bg-black/70 text-white/80 hover:text-white'
            }`}
          >
            S
          </button>
        )}
        {/* オートモードボタン (#139) */}
        <button
          type="button"
          onClick={handleAutoToggle}
          aria-label={autoMode ? 'オートモードをオフにする' : 'オートモードをオンにする'}
          title="オートモード (A)"
          style={{ right: slotRight(slotOf('auto')) }}
          className={`absolute bottom-3 w-9 h-9 flex items-center justify-center rounded-full text-sm font-bold transition-colors ${
            autoMode
              ? 'bg-blue-500/80 hover:bg-blue-500 text-white'
              : 'bg-black/50 hover:bg-black/70 text-white/80 hover:text-white'
          }`}
        >
          A
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="設定を開く"
          title="設定 (Ctrl/Cmd + ,)"
          style={{ right: slotRight(slotOf('settings')) }}
          className="absolute bottom-3 w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white text-lg"
        >
          ⚙
        </button>
        {/* デバッグ HUD トグル「D」ボタン (#310): debug_enabled(/play) or editor のときだけ出す。
            押すと DebugOverlay パネルを展開・再押しで畳む（既定は畳んだ状態）。 */}
        {debugAvailable && (
          <button
            type="button"
            onClick={handleDebugToggle}
            aria-label={debugOpen ? 'デバッグ情報を閉じる' : 'デバッグ情報を開く'}
            aria-pressed={debugOpen}
            title="デバッグ (D)"
            style={{ right: slotRight(slotOf('debug')) }}
            className={`absolute bottom-3 w-9 h-9 flex items-center justify-center rounded-full text-sm font-bold transition-colors ${
              debugOpen
                ? 'bg-cyan-500/80 hover:bg-cyan-500 text-white'
                : 'bg-black/50 hover:bg-black/70 text-white/80 hover:text-white'
            }`}
          >
            D
          </button>
        )}
      </div>
      {/* 終劇表示 (#386, #404): confinement 外への choice ジャンプで NovelRenderer.endStory() が
          発火した後に出す "to be continued..." 表示。#404 で「文字が小さすぎる」不満を解消する
          ため、右下の控えめな配置から画面中央寄せ・大きめの文字に変更した。話者名・選択肢UIとの
          区別のため斜体は維持しつつ、視認性を上げるため text-white/60 → /80 に上げている。
          背景/立ち絵のフェードアウト自体は NovelRenderer 側（PixiJS）が行い、これはその後に
          重ねる DOM 側の文字。pointer-events-none: タップしても何も起きない（advance は
          storyEnded で no-op のため二重の安全策だが、見た目のヒットテストにも参加させない）。
          intermission.md 専用シーン (#404) が使われた場合はこの DOM 表示を出さない
          （PixiJS 側のタブローに一本化し、二重表示を避ける。usedIntermissionScene 参照）。 */}
      {storyEnded && !usedIntermissionScene && (
        <div className="absolute inset-0 m-auto pointer-events-none" style={gameBoxStyle}>
          {/* 埋め込み元プロジェクトのロゴ (#404): TitleOverlay と同じ title.png 規約
              (`${assetBaseUrl}/images/title.png`) を流用する。TitleOverlay の imageFailed と
              同様 onError で読み込み失敗を検知するが、こちらはテキストへのフォールバックは
              せず、ロゴが無ければ単に出さない（Issue 方針。confinement 元が不明な場合に
              誤ったテキストを出さないため）。 */}
          {assetBaseUrl && !storyEndedLogoFailed && (
            <img
              src={`${assetBaseUrl}/images/title.png`}
              alt=""
              onError={() => setStoryEndedLogoFailed(true)}
              className="absolute top-3 left-3 max-w-[20%] max-h-16 object-contain select-none"
            />
          )}
          <p
            className="absolute inset-0 flex items-center justify-center text-center px-8 text-white/80 text-3xl italic select-none"
            style={{
              fontFamily: fontFamily || undefined,
            }}
          >
            to be continued...
          </p>
        </div>
      )}
      <SettingsOverlay
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
      />
      {/* クイックセーブ/ロード通知 toast (#142) */}
      {toast !== null && (
        <div
          role="status"
          aria-live="polite"
          className="absolute bottom-10 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/70 text-white text-sm font-medium pointer-events-none select-none"
        >
          {toast}
        </div>
      )}
    </div>
  )
}

export default NovelPlayer
