import { useEffect, useRef } from 'react'
import { Event, EventScene } from '../types'
import { NovelRenderer } from '../game/NovelRenderer'

interface NovelPlayerProps {
  events: Event[]
  scenes?: EventScene[]
  assetBaseUrl?: string
}

function NovelPlayer({ events, scenes, assetBaseUrl }: NovelPlayerProps) {
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
