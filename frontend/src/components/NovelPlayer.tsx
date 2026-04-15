import { useEffect, useRef } from 'react'
import { Event } from '../types'
import { NovelRenderer } from '../game/NovelRenderer'

interface NovelPlayerProps {
  events: Event[]
}

function NovelPlayer({ events }: NovelPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<NovelRenderer | null>(null)

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
      renderer.setEvents(events)
    })

    return () => {
      destroyed = true
      renderer.destroy()
      rendererRef.current = null
    }
  }, [events])

  return (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
      <div
        ref={containerRef}
        className="rounded-xl shadow-2xl overflow-hidden"
        style={{ maxWidth: '100%', maxHeight: '100%' }}
      />
    </div>
  )
}

export default NovelPlayer
