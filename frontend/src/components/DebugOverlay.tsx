import { useEffect, useRef, useState } from 'react'
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
  audioWarning: string | null
  characters: Array<{
    name: string
    expression: string
    position: string
    x: number
    y: number
    scale: number
  }>
}

// localStorage キー（折りたたみ・非表示の永続化）。SSR/未対応環境では握り潰す (#301)。
const LS_COLLAPSED = 'nn.debugOverlay.collapsed'
const LS_HIDDEN = 'nn.debugOverlay.hidden'

/** localStorage から boolean を安全に読む。例外（SSR/未対応/プライベートモード）は fallback。 */
function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return fallback
    return v === '1'
  } catch {
    return fallback
  }
}

/** localStorage に boolean を安全に書く。例外は握り潰す（永続化は best-effort）。 */
function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // SSR/未対応/プライベートモード等。永続化できなくても UI 状態は React state で動く。
  }
}

/**
 * 画面右下に固定で出る開発用 HUD。NovelRenderer の状態を 200ms ごとにポーリングする。
 * 不要なら NovelPlayer.tsx の import を外す。
 *
 * UX (#301):
 *  - 狭幅レスポンシブ: width は min(460px, calc(100vw - 16px)) でスマホでも左が画面外に出ない。
 *  - copy フィードバック: コピー成功で「copied ✓」へ ~1.5s 変化。
 *  - 折りたたみ（▾/▸）と非表示（×）。状態は localStorage に記憶。既定は折りたたみ。
 *    × で非表示のときも小さな「debug」ピルを残して再展開できる（完全に消すと戻せないため）。
 *  - ポーリングは折りたたみ/非表示中は止める（負荷減）。
 */
export function DebugOverlay({
  rendererRef,
}: {
  rendererRef: React.MutableRefObject<NovelRenderer | null>
}) {
  const [state, setState] = useState<DebugState | null>(null)
  // 既定は折りたたみ（collapsed=true）で邪魔にしない (#301)。
  const [collapsed, setCollapsed] = useState<boolean>(() => readBool(LS_COLLAPSED, true))
  const [hidden, setHidden] = useState<boolean>(() => readBool(LS_HIDDEN, false))
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 折りたたみ/非表示中はポーリングを止める（state を更新する必要がないため・負荷減 #301）。
  const polling = !collapsed && !hidden
  useEffect(() => {
    if (!polling) return
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
  }, [rendererRef, polling])

  // copy フィードバックの setTimeout は unmount/再コピーで clear する。
  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  const persistCollapsed = (next: boolean): void => {
    setCollapsed(next)
    writeBool(LS_COLLAPSED, next)
  }
  const persistHidden = (next: boolean): void => {
    setHidden(next)
    writeBool(LS_HIDDEN, next)
  }

  // 非表示時は小さな「debug」ピルだけ残す（完全に消すと戻せないため #301）。
  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => persistHidden(false)}
        title="デバッグHUDを再表示"
        style={{
          position: 'fixed',
          right: 8,
          bottom: 8,
          zIndex: 9999,
          background: 'rgba(0,0,0,0.78)',
          color: '#67e8f9',
          border: '1px solid #2a3140',
          borderRadius: 4,
          cursor: 'pointer',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 10,
          padding: '2px 8px',
          pointerEvents: 'auto',
        }}
      >
        debug
      </button>
    )
  }

  const buildText = (): string => {
    if (!state) return 'debug'
    const lines = [
      'debug',
      `scene: ${state.sceneId ?? '(none)'}`,
      `event: ${state.eventIndex + 1} / ${state.eventCount} [${state.eventKind}]`,
      ...(state.eventText ? [`↳ ${state.eventText}`] : []),
      `auto: ${state.autoMode ? 'ON' : 'off'} / wait: ${state.waitingForWait ? 'YES' : '-'} / choice: ${state.waitingForChoice ? 'YES' : '-'}`,
      `font: ${state.currentResolvedFontFamily ?? '(default)'}`,
      ...(state.audioWarning ? [`⚠ ${state.audioWarning}`] : []),
      `characters (${state.characters.length}):`,
      ...state.characters.map(
        (c) =>
          `・${c.name} [${c.position}] expr=${c.expression.split('/').pop()} x=${c.x.toFixed(0)} y=${c.y.toFixed(0)} s=${c.scale.toFixed(2)}`
      ),
    ]
    return lines.join('\n')
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildText())
      // 成功フィードバック: 「copied ✓」へ ~1.5s 変えてから戻す。再コピーでタイマーを張り直す。
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.warn('[DebugOverlay] copy failed', err)
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 8,
        bottom: 8,
        zIndex: 9999,
        // 狭幅レスポンシブ: スマホ幅で左が画面外に出ないよう viewport に内接させる (#301)。
        width: 'min(460px, calc(100vw - 16px))',
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
        // pointerEvents: 'auto' でクリック/選択を許可 (テキストコピー用 #301)
        pointerEvents: 'auto',
        userSelect: 'text',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          onClick={() => persistCollapsed(!collapsed)}
          title={collapsed ? '展開' : '折りたたみ'}
          style={{
            background: 'transparent',
            color: '#67e8f9',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            padding: 0,
            lineHeight: 1,
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <div style={{ color: '#67e8f9', fontWeight: 700, flex: 1 }}>debug</div>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            background: copied ? 'rgba(134, 239, 172, 0.18)' : 'rgba(103, 232, 249, 0.15)',
            color: copied ? '#86efac' : '#67e8f9',
            border: '1px solid #2a3140',
            borderRadius: 3,
            cursor: 'pointer',
            fontSize: 10,
            padding: '2px 6px',
          }}
        >
          {copied ? 'copied ✓' : 'copy'}
        </button>
        <button
          type="button"
          onClick={() => persistHidden(true)}
          title="非表示（debug ピルから再表示）"
          style={{
            background: 'transparent',
            color: '#94a3b8',
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      {!collapsed &&
        (state ? (
          <>
            <div>scene: {state.sceneId ?? '(none)'}</div>
            <div>
              event: {state.eventIndex + 1} / {state.eventCount} [{state.eventKind}]
            </div>
            {state.eventText && <div style={{ color: '#86efac' }}>↳ {state.eventText}</div>}
            <div>
              auto: {state.autoMode ? 'ON' : 'off'} / wait: {state.waitingForWait ? 'YES' : '-'} /
              choice: {state.waitingForChoice ? 'YES' : '-'}
            </div>
            <div>font: {state.currentResolvedFontFamily ?? '(default)'}</div>
            {state.audioWarning && (
              <div style={{ color: '#fb7185', marginTop: 4 }}>⚠ {state.audioWarning}</div>
            )}
            <div style={{ color: '#fde68a', marginTop: 4 }}>
              characters ({state.characters.length}):
            </div>
            {state.characters.map((c) => (
              <div key={c.name}>
                ・{c.name} [{c.position}] expr={c.expression.split('/').pop()} x={c.x.toFixed(0)} y=
                {c.y.toFixed(0)} s={c.scale.toFixed(2)}
              </div>
            ))}
          </>
        ) : (
          <div style={{ color: '#94a3b8' }}>(initializing…)</div>
        ))}
    </div>
  )
}
