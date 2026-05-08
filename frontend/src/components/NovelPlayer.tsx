import { useEffect, useRef, useState } from 'react'
import { Event, EventScene } from '../types'
import { NovelRenderer } from '../game/NovelRenderer'
import { type Settings, loadSettings, saveSettings } from '../game/settings'
import SettingsOverlay from './SettingsOverlay'

interface NovelPlayerProps {
  events: Event[]
  scenes?: EventScene[]
  assetBaseUrl?: string
}

function NovelPlayer({ events, scenes, assetBaseUrl }: NovelPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<NovelRenderer | null>(null)

  // 設定 (Issue #138): localStorage と同期
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ライフサイクル管理: init + destroy
  useEffect(() => {
    if (!containerRef.current) return

    const renderer = new NovelRenderer()
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
    saveSettings(settings)
  }, [settings])

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
        style={{ maxWidth: '100%', maxHeight: '100%' }}
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
