import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Event, EventScene } from '../types'
import { NovelRenderer } from '../game/NovelRenderer'
import { parseDebugQuery } from '../game/debugQuery'
import { type Settings, loadSettings, makeDebouncedSaveSettings } from '../game/settings'
import { type AspectRatio, ASPECT_RATIOS, parseAspectRatio } from '../game/constants'
import { PLAYER_BUTTON_RIGHT_MARGIN_PX, PLAYER_BUTTON_SLOT_GAP_PX } from '../game/novelLayout'
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
  /** Skip(S) ボタンを出すか (#310)。frontmatter `skip_enabled:` から流す。
   *  null/undefined/true で Skip(S) ボタンを描画する（既定・後方互換）。false で描画しない。
   *  skip-read-only ロジック（未読は解除）自体は不変。ボタンの有無だけを制御する。 */
  skipEnabled?: boolean | null
  /** デバッグ HUD（D ボタン）を出すか (#310)。
   *  /play では frontmatter `debug_enabled:` から流す（null/undefined/false で非表示・本番既定）。
   *  /edit は frontmatter 非依存で常時 true を渡す（編集者用）。 */
  debugEnabled?: boolean | null
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
  skipEnabled,
  debugEnabled,
  debugInfo,
  docKey,
  initialSkipMode = false,
  onRendererReady,
}: NovelPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<NovelRenderer | null>(null)

  // 設定 (Issue #138): localStorage と同期。スライダー drag による書き込み連打は
  // debounce で吸収する (review #155 should-2)
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // オートモード ON/OFF (#139)
  // llll-ll-media 等の動画用途では起動時 ON が正解。ノベルゲーで止まりたい場合は
  // UI のオートトグルで切る運用（後で frontmatter `auto_play: false` を追加する）
  const [autoMode, setAutoMode] = useState(true)
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

  // デバッグ HUD の展開状態 (#310)。右下ボタン列の「D」ボタンで開閉する。
  // 既定は畳んだ状態（#301 の collapsed 既定 true を引き継ぐ＝open 既定 false）。
  // 状態は localStorage（旧 DebugOverlay と同じキー意味）に best-effort で永続化する。
  const [debugOpen, setDebugOpen] = useState<boolean>(() => readDebugOpen())

  // 有効な AspectRatio に正規化
  const aspectRatio = parseAspectRatio(aspectRatioProp)
  const { width: gameWidth, height: gameHeight } = ASPECT_RATIOS[aspectRatio]

  // ライフサイクル管理: init + destroy
  // aspectRatio が変わる場合はコンポーネントを再マウントすること
  // （依存配列は空：レンダラーはマウント時に1度だけ生成する設計）
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
      if (assetBaseUrl) {
        renderer.setAssetBaseUrl(assetBaseUrl)
      }
      renderer.setMissingSceneResolver?.(onResolveMissingScene ?? null)
      // renderer が手動操作で autoMode を OFF にしたとき React state を同期 (#139)
      renderer.setOnAutoModeChange((on) => setAutoMode(on))
      // renderer が未読到達で skipMode を OFF にしたとき React state を同期 (#140)
      renderer.setOnSkipModeChange((on) => setSkipMode(on))
      // スライダ操作中（active）は下部丸ボタン行をフェード退避させる (#350)
      renderer.setOnSeekActiveChange((active) => setSeekActive(active))
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
      // 主人公セリフの本文色 (#305) は renderer 既定 #FFF6E6 のまま使う。frontmatter での
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
      // URL クエリによるデバッグ起点指定 (#220 Phase 3)。
      // DEV ビルドでのみ有効。production ではこのブロックごと tree-shake される。
      // debug_scene は sceneId 前提。scenes / jumpSceneIndex のどちらの索引でも解決する。
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
      renderer.destroy()
      rendererRef.current = null
    }
  }, [])

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
      className="relative w-full h-full flex items-center justify-center bg-black"
      style={{ containerType: 'size' }}
    >
      {/* デバッグ HUD パネル (#310): D ボタンの展開状態に追従。debug_enabled(/play) or
          editor のときだけ出す。閉じている/無効のときは何も描かない（D ボタンが唯一の入口）。 */}
      {debugAvailable && (
        <DebugOverlay rendererRef={rendererRef} open={debugOpen} debugInfo={debugInfo} />
      )}
      {/* 親 (bg-black, container-type: size) を基準に letterbox/pillarbox する内接矩形。
          ゲーム比率を維持して親に内接させる（縦長スマホは上下に黒帯、横長は左右に黒帯）。
          寸法は gameBoxStyle に集約し、下部ボタン行と共有する (#350)。 */}
      <div
        ref={containerRef}
        className="overflow-hidden [&>canvas]:block [&>canvas]:w-full [&>canvas]:h-full"
        style={gameBoxStyle}
      />
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
            disabled={!docKey}
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
