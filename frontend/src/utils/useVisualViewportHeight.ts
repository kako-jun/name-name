import { useEffect, useState } from 'react'

function readVisualViewportHeight(): string {
  if (typeof window === 'undefined') return '100dvh'

  const height = window.visualViewport?.height
  if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
    return `${height}px`
  }

  return '100dvh'
}

/**
 * Android Chrome の下部 URL バーは layout viewport ではなく visual viewport を覆う。
 * PlayerScreen の外枠を実表示領域へ収めるため、resize/scroll の両方に追従する。
 */
export function useVisualViewportHeight(): string {
  const [height, setHeight] = useState(readVisualViewportHeight)

  useEffect(() => {
    const update = () => setHeight(readVisualViewportHeight())
    const visualViewport = window.visualViewport

    update()
    window.addEventListener('resize', update)
    visualViewport?.addEventListener('resize', update)
    visualViewport?.addEventListener('scroll', update)

    return () => {
      window.removeEventListener('resize', update)
      visualViewport?.removeEventListener('resize', update)
      visualViewport?.removeEventListener('scroll', update)
    }
  }, [])

  return height
}
