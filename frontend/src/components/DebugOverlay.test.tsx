// #639: :focus-visible の実ブラウザ挙動（マウスでは出ずキーボードでは出る）は jsdom で
// 再現できないが、クラス文字列が DOM に実際に載っていることは機械チェックできる。将来の
// リファクタでこのクラスが誤って落ちても検知できるよう、対象ボタンごとに1テストで縛る。
//
// DebugOverlay は rendererRef.current を参照するだけで PixiJS を構築しないため、
// NovelPlayer/RPGPlayer 系テストと違い renderer のモックは不要（rendererRef は
// { current: null } の最小オブジェクトで足りる）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { DebugOverlay } from './DebugOverlay'
import type { NovelRenderer } from '../game/NovelRenderer'

const emptyRendererRef: MutableRefObject<NovelRenderer | null> = { current: null }

describe('DebugOverlay focus-visible クラス付与 (#639)', () => {
  it('FV1: copy ボタンに focus-visible: クラスが付与されている', () => {
    render(<DebugOverlay rendererRef={emptyRendererRef} open={true} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: 'copy' }).className).toContain('focus-visible:')
  })

  it('FV2: × (閉じる) ボタンに focus-visible: クラスが付与されている', () => {
    render(<DebugOverlay rendererRef={emptyRendererRef} open={true} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: 'デバッグパネルを閉じる' }).className).toContain(
      'focus-visible:'
    )
  })
})

describe('DebugOverlay jump 表示 (#733)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // DebugOverlay は 200ms ポーリングで state を取るので、fake timers で 1 周進める。
  const renderPolled = (ref: MutableRefObject<NovelRenderer | null>) => {
    vi.useFakeTimers()
    render(<DebugOverlay rendererRef={ref} open={true} onClose={() => {}} />)
    act(() => {
      vi.advanceTimersByTime(250)
    })
  }

  const makeRef = (jumpState?: 'idle' | 'pending' | 'stalled') =>
    ({
      current: {
        getDebugState: () => ({
          eventIndex: 0,
          eventCount: 1,
          eventKind: 'Jump',
          eventText: undefined,
          autoMode: false,
          waitingForChoice: false,
          waitingForWait: false,
          ...(jumpState ? { jumpState } : {}),
          currentResolvedFontFamily: null,
          sceneId: 'a',
          audioWarning: null,
          characters: [],
        }),
      },
    }) as unknown as MutableRefObject<NovelRenderer | null>

  it('JD1: jumpState が stalled のとき "jump: stalled" が表示される', () => {
    renderPolled(makeRef('stalled'))
    expect(screen.getByText(/jump: stalled/)).toBeTruthy()
  })

  it('JD2: jumpState 未指定なら "jump: idle"（[待機] の wait 表示とは別行内の独立項目）', () => {
    renderPolled(makeRef())
    expect(screen.getByText(/jump: idle/)).toBeTruthy()
  })
})
