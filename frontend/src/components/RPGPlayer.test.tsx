// #601 セルフレビュー must対応: SettingsOverlay に seekbarColor prop が追加され、未指定時の
// フォールバックが SeekBar の既定色 DEFAULT_BAR_FILL_COLOR（淡いティール #a8dadc）に変わった。
// RPGPlayer は SeekBar / seekbar_color の概念を持たないため、#601 以前は設定ポップアップの
// スライダーが常に Tailwind `accent-cyan-300`（v4 では oklch(86.5% 0.127 207.078)）固定だった
// 見た目が、無関係にサイレントで変わってしまっていた（RPGPlayer.tsx が seekbarColor を
// 渡していなかったのが原因）。
// このファイルは RPGPlayer 経由で設定ポップアップを開いたときのスライダー色が #601 の変更前後で
// 不変（accent-cyan-300 の実測値のまま）であることを実描画で機械的に固定する。
// 値の実測方法・根拠は RPGPlayer.tsx の RPG_SETTINGS_SLIDER_COLOR 定義コメントを参照。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import RPGPlayer from './RPGPlayer'

// RPGPlayer は PixiJS 依存の TopDownRenderer/RaycastRenderer を construct するため、
// jsdom では実 init できない（NovelPlayer 系テストと同じ事情）。init/load/destroy/
// applySettings を持つ最小スタブに差し替える。
// アロー関数は [[Construct]] を持たず `new` できないため、`function` 式で構築可能なモックにする。
vi.mock('../game/TopDownRenderer', () => ({
  TopDownRenderer: vi.fn().mockImplementation(function () {
    return {
      init: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      destroy: vi.fn(),
      applySettings: vi.fn(),
    }
  }),
}))
vi.mock('../game/RaycastRenderer', () => ({
  RaycastRenderer: vi.fn().mockImplementation(function () {
    return {
      init: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      destroy: vi.fn(),
      applySettings: vi.fn(),
    }
  }),
}))

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('RPGPlayer の設定ポップアップ スライダー色 (#601 セルフレビュー must対応・非回帰)', () => {
  it('⚙ボタンから設定を開くと、5つのスライダー全ての accentColor が #601 以前と同じ accent-cyan-300 実測値になる（RPGモードは seekbar_color 概念を持たないため見た目不変）', async () => {
    render(<RPGPlayer />)

    fireEvent.click(screen.getByRole('button', { name: '設定を開く' }))

    const dialog = await screen.findByRole('dialog', { name: '設定' })
    const inputs = Array.from(dialog.querySelectorAll('input[type="range"]'))
    expect(inputs).toHaveLength(5)
    inputs.forEach((input) => {
      expect((input as HTMLInputElement).style.accentColor).toBe('#53eafd')
    })
  })
})

// #639: :focus-visible の実ブラウザ挙動は jsdom で再現できないが、クラス文字列が DOM に
// 実際に載っていることは機械チェックできる。将来のリファクタでこのクラスが誤って落ちても
// 検知できるよう固定する。
describe('RPGPlayer focus-visible クラス付与 (#639)', () => {
  it('FV1: 設定ボタンに focus-visible: クラスが付与されている', () => {
    render(<RPGPlayer />)
    expect(screen.getByRole('button', { name: '設定を開く' }).className).toContain('focus-visible:')
  })
})
