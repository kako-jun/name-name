import { useEffect, useRef } from 'react'
import { Event } from '../types'
import { NovelRenderer } from '../game/NovelRenderer'

interface NovelPlayerProps {
  events: Event[]
  assetBaseUrl?: string
}

function NovelPlayer({ events, assetBaseUrl }: NovelPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<NovelRenderer | null>(null)

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
      renderer.setEvents(events)
    })

    return () => {
      destroyed = true
      renderer.destroy()
      rendererRef.current = null
    }
  }, [])

  // events が変わったらレンダラーに反映
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setEvents(events)
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
