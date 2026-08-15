// #639: :focus-visible の実ブラウザ挙動（マウスでは出ずキーボードでは出る）は jsdom で
// 再現できないが、クラス文字列が DOM に実際に載っていることは機械チェックできる。将来の
// リファクタでこのクラスが誤って落ちても検知できるよう、対象ボタンごとに1テストで縛る。
//
// DebugOverlay は rendererRef.current を参照するだけで PixiJS を構築しないため、
// NovelPlayer/RPGPlayer 系テストと違い renderer のモックは不要（rendererRef は
// { current: null } の最小オブジェクトで足りる）。
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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
