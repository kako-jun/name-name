import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Event, EventScene } from '../types'
import { NovelRenderer } from '../game/NovelRenderer'
import { type Settings, loadSettings, makeDebouncedSaveSettings } from '../game/settings'
import { type AspectRatio, ASPECT_RATIOS, parseAspectRatio } from '../game/constants'
import SettingsOverlay from './SettingsOverlay'
import { DebugOverlay } from './DebugOverlay'

interface NovelPlayerProps {
  events: Event[]
  scenes?: EventScene[]
  assetBaseUrl?: string
  /** 画面比率。"16:9" / "4:3" / "9:16"。デフォルト "16:9" (#136) */
  aspectRatio?: AspectRatio | string
  /** 選択肢スタイル名 `default` / `soft` / `monochrome` (#146)。
   *  frontmatter `choice_style:` から流す。null/undefined で default 扱い */
  choiceStyle?: string | null
  /** per-game デフォルトフォント (#147)。CSS の font-family 文字列。
   *  frontmatter `font_family:` から流す。null/undefined で runtime 既定 (Noto Sans JP) */
  fontFamily?: string | null
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
  assetBaseUrl,
  aspectRatio: aspectRatioProp,
  choiceStyle,
  fontFamily,
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
      // renderer が手動操作で autoMode を OFF にしたとき React state を同期 (#139)
      renderer.setOnAutoModeChange((on) => setAutoMode(on))
      // renderer が未読到達で skipMode を OFF にしたとき React state を同期 (#140)
      renderer.setOnSkipModeChange((on) => setSkipMode(on))
      if (docKey) {
        renderer.setDocKey(docKey)
      }
      // 選択肢スタイル (#146)
      renderer.setChoiceStyle(choiceStyle ?? null)
      // per-game フォント (#147)
      renderer.setFontFamily(fontFamily ?? null)
      // init 完了直後に現在の settings を反映 (#138)
      renderer.applySettings(settings)
      if (scenes && scenes.length > 0) {
        renderer.setScenes(scenes)
      } else {
        renderer.setEvents(events)
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

  // events / scenes が変わったらレンダラーに反映
  useEffect(() => {
    if (!rendererRef.current) return
    if (scenes && scenes.length > 0) {
      rendererRef.current.setScenes(scenes)
    } else {
      rendererRef.current.setEvents(events)
    }
  }, [events, scenes])

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

  return (
    <div
      className="relative w-full h-full flex items-center justify-center bg-black"
      style={{ containerType: 'size' }}
    >
      <DebugOverlay rendererRef={rendererRef} />
      <div
        ref={containerRef}
        className="overflow-hidden [&>canvas]:block [&>canvas]:w-full [&>canvas]:h-full"
        style={{
          // 親 (bg-black, container-type: size) を基準に letterbox/pillarbox する。
          // ゲーム比率を維持したまま親に内接するサイズを container query 単位で計算する。
          // 縦長スマホでは上下に黒帯、横長デスクトップでは左右に黒帯が出る。
          //
          // width / height の min/calc だけで内接矩形は決まる（aspect-ratio は冗長）が、
          // cq 単位が解釈されない極端なフォールバック環境（古いブラウザ、CSS 計算前の
          // 一瞬等）でも比率を保てるようセーフティネットとして aspect-ratio を併記。
          aspectRatio: `${gameWidth} / ${gameHeight}`,
          width: `min(100cqw, calc(100cqh * ${gameWidth} / ${gameHeight}))`,
          height: `min(100cqh, calc(100cqw * ${gameHeight} / ${gameWidth}))`,
        }}
      />
      {/* スキップボタン (#140): docKey がある場合のみ有効 */}
      <button
        type="button"
        onClick={handleSkipToggle}
        disabled={!docKey}
        aria-label={skipMode ? 'スキップモードをオフにする' : 'スキップモードをオンにする'}
        title="スキップ（既読のみ）"
        className={`absolute top-3 right-[6.25rem] w-9 h-9 flex items-center justify-center rounded-full text-sm font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
          skipMode
            ? 'bg-green-500/80 hover:bg-green-500 text-white'
            : 'bg-black/50 hover:bg-black/70 text-white/80 hover:text-white'
        }`}
      >
        S
      </button>
      {/* オートモードボタン (#139) */}
      <button
        type="button"
        onClick={handleAutoToggle}
        aria-label={autoMode ? 'オートモードをオフにする' : 'オートモードをオンにする'}
        title="オートモード (A)"
        className={`absolute top-3 right-14 w-9 h-9 flex items-center justify-center rounded-full text-sm font-bold transition-colors ${
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
        className="absolute top-3 right-3 w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white text-lg"
      >
        ⚙
      </button>
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
