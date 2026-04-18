import { useEffect, useRef } from 'react'
import { RPGRenderer } from '../game/RPGRenderer'
import { sampleRpgData } from '../game/sampleRpgData'
import { RPGProject } from '../types/rpg'

interface RPGPlayerProps {
  gameData?: RPGProject
}

function RPGPlayer({ gameData }: RPGPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new RPGRenderer()
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
        console.error('[name-name] RPGRenderer の初期化に失敗:', err)
      })

    return () => {
      cancelled = true
      renderer.destroy()
    }
  }, [gameData])

  return (
    <div className="w-full h-full flex items-center justify-center">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
}

export default RPGPlayer
