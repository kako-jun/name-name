import { useEffect, useMemo, useRef, useState } from 'react'
import { Event, EventScene } from '../types'
import { NovelRenderer } from '../game/NovelRenderer'
import { type Settings, loadSettings, makeDebouncedSaveSettings } from '../game/settings'
import { type AspectRatio, ASPECT_RATIOS, parseAspectRatio } from '../game/constants'
import SettingsOverlay from './SettingsOverlay'

interface NovelPlayerProps {
  events: Event[]
  scenes?: EventScene[]
  assetBaseUrl?: string
  /** 画面比率。"16:9" / "4:3" / "9:16"。デフォルト "16:9" (#136) */
  aspectRatio?: AspectRatio | string
}

function NovelPlayer({
  events,
  scenes,
  assetBaseUrl,
  aspectRatio: aspectRatioProp,
}: NovelPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<NovelRenderer | null>(null)

  // 設定 (Issue #138): localStorage と同期。スライダー drag による書き込み連打は
  // debounce で吸収する (review #155 should-2)
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const debouncedSave = useMemo(() => makeDebouncedSaveSettings(300), [])

  // 有効な AspectRatio に正規化 (#136)
  const aspectRatio = parseAspectRatio(aspectRatioProp)
  const { width: gameWidth, height: gameHeight } = ASPECT_RATIOS[aspectRatio]

  // ライフサイクル管理: init + destroy
  useEffect(() => {
    if (!containerRef.current) return

    const renderer = new NovelRenderer({ aspectRatio })
    rendererRef.current = renderer

    let destroyed = false

    renderer.init(containerRef.current).then(() => {
      if (destroyed) {
        renderer.destroy()
        return
      }
      if (assetBaseUrl) {
        renderer.setAssetBaseUrl(assetBaseUrl)
      }
      // init 完了直後に現在の settings を反映 (#138)
      renderer.applySettings(settings)
      if (scenes && scenes.length > 0) {
        renderer.setScenes(scenes)
      } else {
        renderer.setEvents(events)
      }
    })

    return () => {
      destroyed = true
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

  return (
    <div className="relative w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
      <div
        ref={containerRef}
        className="rounded-xl shadow-2xl overflow-hidden"
        style={{
          // canvas が aspect-ratio に合わせて正しいサイズで表示されるよう制約 (#136)
          aspectRatio: `${gameWidth} / ${gameHeight}`,
          maxWidth: '100%',
          maxHeight: '100%',
        }}
      />
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
    </div>
  )
}

export default NovelPlayer
