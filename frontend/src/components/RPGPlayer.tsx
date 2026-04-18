import { useEffect, useRef } from 'react'
import { TopDownRenderer } from '../game/TopDownRenderer'
import { RaycastRenderer } from '../game/RaycastRenderer'
import { sampleRpgData } from '../game/sampleRpgData'
import { RPGProject } from '../types/rpg'

type RendererLike = {
  init(container: HTMLElement): Promise<void>
  load(gameData: RPGProject): void
  destroy(): void
}

interface RPGPlayerProps {
  gameData?: RPGProject
  view?: 'topdown' | 'raycast'
}

function RPGPlayer({ gameData, view = 'topdown' }: RPGPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer: RendererLike =
      view === 'raycast' ? new RaycastRenderer() : new TopDownRenderer()
    let cancelled = false

    renderer
      .init(container)
      .then(() => {
        if (cancelled) {
          renderer.destroy()
          return
        }
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
      renderer.destroy()
    }
  }, [gameData, view])

  return (
    <div className="w-full h-full flex items-center justify-center">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
}

export default RPGPlayer
