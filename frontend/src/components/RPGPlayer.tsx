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

/**
 * 設定ポップアップのスライダー accent-color (#601 セルフレビュー must対応)。
 *
 * #601 以前は SettingsOverlay の全呼び出しが Tailwind `accent-cyan-300`（このシアン色）に
 * 固定されていた。#601 で SettingsOverlay に `seekbarColor` prop が追加され、未指定時の
 * フォールバックが SeekBar の既定色 `DEFAULT_BAR_FILL_COLOR`（淡いティール `#a8dadc`）に
 * 変わったが、RPGPlayer は SeekBar / seekbar_color の概念自体を持たない
 * （RaycastRenderer.ts / TopDownRenderer.ts / RPGPlayer.tsx のどこにも `seekbar` の参照がない）。
 * このまま `seekbarColor` を渡さないと、Issue #601 のスコープ（Novel モードの
 * `seekbar_color` 連動）と無関係に RPG モードのスライダー色がサイレントに変わってしまう。
 *
 * 対応: SettingsOverlay 側の props/デフォルト値は変えず（Novel モードの `seekbar_color`
 * 未指定時のフォールバックは水色のまま据え置く）、RPGPlayer 側から旧来の実際の色を
 * `seekbarColor` として明示的に渡す方式を採用する。SettingsOverlay の呼び出し元ごとに
 * 「seekbar_color 概念を持たないモードは自分の既定色を明示する」責務を寄せることで、
 * RPGPlayer の見た目は #601 の変更前後で完全に不変になる（非回帰）。
 */
const RPG_SETTINGS_SLIDER_COLOR = '#67e8f9'

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
        seekbarColor={RPG_SETTINGS_SLIDER_COLOR}
      />
    </div>
  )
}

export default RPGPlayer
