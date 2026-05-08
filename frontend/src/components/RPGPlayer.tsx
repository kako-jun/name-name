import { useEffect, useMemo, useRef, useState } from 'react'
import { TopDownRenderer } from '../game/TopDownRenderer'
import { RaycastRenderer } from '../game/RaycastRenderer'
import { sampleRpgData } from '../game/sampleRpgData'
import { RPGProject } from '../types/rpg'
import { type Settings, loadSettings, makeDebouncedSaveSettings } from '../game/settings'
import SettingsOverlay from './SettingsOverlay'

type RendererLike = {
  init(container: HTMLElement): Promise<void>
  load(gameData: RPGProject): void
  destroy(): void
  applySettings?(settings: { msPerChar: number; bgmVolume: number; seVolume: number }): void
}

interface RPGPlayerProps {
  gameData?: RPGProject
  view?: 'topdown' | 'raycast'
}

function RPGPlayer({ gameData, view = 'topdown' }: RPGPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<RendererLike | null>(null)

  // 設定 (Issue #138) — slider drag による書き込み連打は debounce で吸収 (review #155 should-2)
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const debouncedSave = useMemo(() => makeDebouncedSaveSettings(300), [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer: RendererLike =
      view === 'raycast' ? new RaycastRenderer() : new TopDownRenderer()
    rendererRef.current = renderer
    let cancelled = false

    renderer
      .init(container)
      .then(() => {
        if (cancelled) {
          renderer.destroy()
          return
        }
        renderer.applySettings?.(settings)
        renderer.load(gameData ?? sampleRpgData)
      })
      .catch((err) => {
        console.error(
          `[name-name] ${view === 'raycast' ? 'RaycastRenderer' : 'TopDownRenderer'} の初期化に失敗:`,
          err
        )
      })

    return () => {
      cancelled = true
      rendererRef.current = null
      renderer.destroy()
    }
  }, [gameData, view])

  // 設定変更を renderer に反映 + 永続化 (#138) — debounced
  useEffect(() => {
    rendererRef.current?.applySettings?.(settings)
    debouncedSave.save(settings)
  }, [settings, debouncedSave])

  // unmount 時に debounce 中の保存を flush
  useEffect(() => {
    return () => {
      debouncedSave.flush()
    }
  }, [debouncedSave])

  // Ctrl/Cmd + , で設定パネル開閉 (#138)
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

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <div ref={containerRef} className="w-full h-full" />
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-label="設定を開く"
        title="設定 (Ctrl/Cmd + ,)"
        className="absolute top-3 right-3 w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white text-lg z-10"
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

export default RPGPlayer
