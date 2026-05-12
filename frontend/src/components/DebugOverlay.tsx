import { useEffect, useState } from 'react'
import type { NovelRenderer } from '../game/NovelRenderer'

interface DebugState {
  eventIndex: number
  eventCount: number
  eventKind: string
  eventText?: string
  autoMode: boolean
  waitingForChoice: boolean
  waitingForWait: boolean
  currentResolvedFontFamily: string | null
  sceneId: string | null
  characters: Array<{
    name: string
    expression: string
    position: string
    x: number
    y: number
    scale: number
  }>
}

/**
 * 画面右下に固定で出る開発用 HUD。NovelRenderer の状態を 200ms ごとにポーリングする。
 * 不要なら NovelPlayer.tsx の import を外す。
 */
export function DebugOverlay({
  rendererRef,
}: {
  rendererRef: React.MutableRefObject<NovelRenderer | null>
}) {
  const [state, setState] = useState<DebugState | null>(null)

  useEffect(() => {
    const id = setInterval(() => {
      const r = rendererRef.current
      if (!r) return
      try {
        setState(r.getDebugState())
      } catch {
        // 初期化中などは silent skip
      }
    }, 200)
    return () => clearInterval(id)
  }, [rendererRef])

  if (!state) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 8,
        bottom: 8,
        zIndex: 9999,
        width: 460,
        maxHeight: '60vh',
        overflow: 'auto',
        padding: '8px 10px',
        background: 'rgba(0,0,0,0.78)',
        color: '#e6f1ff',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        lineHeight: 1.35,
        border: '1px solid #2a3140',
        borderRadius: 4,
        pointerEvents: 'none',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      <div style={{ color: '#67e8f9', fontWeight: 700 }}>debug</div>
      <div>scene: {state.sceneId ?? '(none)'}</div>
      <div>
        event: {state.eventIndex + 1} / {state.eventCount} [{state.eventKind}]
      </div>
      {state.eventText && <div style={{ color: '#86efac' }}>↳ {state.eventText}</div>}
      <div>
        auto: {state.autoMode ? 'ON' : 'off'} / wait: {state.waitingForWait ? 'YES' : '-'} / choice:{' '}
        {state.waitingForChoice ? 'YES' : '-'}
      </div>
      <div>font: {state.currentResolvedFontFamily ?? '(default)'}</div>
      <div style={{ color: '#fde68a', marginTop: 4 }}>characters ({state.characters.length}):</div>
      {state.characters.map((c) => (
        <div key={c.name}>
          ・{c.name} [{c.position}] expr={c.expression.split('/').pop()} x={c.x.toFixed(0)} y=
          {c.y.toFixed(0)} s={c.scale.toFixed(2)}
        </div>
      ))}
    </div>
  )
}
