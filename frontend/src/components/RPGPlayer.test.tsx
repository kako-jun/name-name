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
import { sampleRpgData } from '../game/sampleRpgData'

// RPGPlayer は PixiJS 依存の TopDownRenderer/RaycastRenderer を construct するため、
// jsdom では実 init できない（NovelPlayer 系テストと同じ事情）。init/load/destroy/
// applySettings を持つ最小スタブに差し替える。
// アロー関数は [[Construct]] を持たず `new` できないため、`function` 式で構築可能なモックにする。
const topdownSetAssetBaseUrl = vi.fn()
const topdownSetDialogStyle = vi.fn()
const topdownInit = vi.fn().mockResolvedValue(undefined)
vi.mock('../game/TopDownRenderer', () => ({
  TopDownRenderer: vi.fn().mockImplementation(function () {
    return {
      init: topdownInit,
      load: vi.fn(),
      destroy: vi.fn(),
      applySettings: vi.fn(),
      setAssetBaseUrl: topdownSetAssetBaseUrl,
      setDialogStyle: topdownSetDialogStyle,
    }
  }),
}))
const raycastInstances: Array<{
  setInputSuspended: ReturnType<typeof vi.fn>
  setAssetBaseUrl: ReturnType<typeof vi.fn>
  setDialogStyle: ReturnType<typeof vi.fn>
  init: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}> = []
vi.mock('../game/RaycastRenderer', () => ({
  RaycastRenderer: vi.fn().mockImplementation(function () {
    const inst = {
      init: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      destroy: vi.fn(),
      applySettings: vi.fn(),
      setInputSuspended: vi.fn(),
      setAssetBaseUrl: vi.fn(),
      setDialogStyle: vi.fn(),
    }
    raycastInstances.push(inst)
    return inst
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

describe('RPGPlayer: 設定の開閉を renderer に伝える (#204)', () => {
  it('Ctrl+, で開くと setInputSuspended(true)、もう一度で false', () => {
    raycastInstances.length = 0
    render(<RPGPlayer view="raycast" />)
    const r = raycastInstances[0]
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    expect(r.setInputSuspended).toHaveBeenLastCalledWith(true)
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    expect(r.setInputSuspended).toHaveBeenLastCalledWith(false)
  })
})

describe('RPGPlayer: renderer の作り直しでも設定中の停止を引き継ぐ (#204)', () => {
  it('設定を開いたまま gameData が変わって renderer が作り直されると、init 後に setInputSuspended(true) が呼ばれる', async () => {
    raycastInstances.length = 0
    const { rerender } = render(<RPGPlayer view="raycast" />)
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    rerender(<RPGPlayer view="raycast" gameData={{ ...sampleRpgData }} />)
    await new Promise((r) => setTimeout(r, 0))
    const next = raycastInstances[raycastInstances.length - 1]
    expect(next).not.toBe(raycastInstances[0])
    expect(next.setInputSuspended).toHaveBeenCalledWith(true)
  })
})

describe('RPGPlayer: アセットのベース URL を renderer に渡す (#746)', () => {
  it('load() より前に setAssetBaseUrl(assetBaseUrl) が呼ばれる', async () => {
    raycastInstances.length = 0
    render(<RPGPlayer view="raycast" assetBaseUrl="/api/projects/g/assets/raw" />)
    await new Promise((r) => setTimeout(r, 0))
    const r = raycastInstances[0]
    expect(r.setAssetBaseUrl).toHaveBeenCalledWith('/api/projects/g/assets/raw')
    expect(r.setAssetBaseUrl.mock.invocationCallOrder[0]).toBeLessThan(
      r.load.mock.invocationCallOrder[0]
    )
  })

  it('assetBaseUrl 未指定なら setAssetBaseUrl(undefined) を渡す（従来どおり）', async () => {
    raycastInstances.length = 0
    render(<RPGPlayer view="raycast" />)
    await new Promise((r) => setTimeout(r, 0))
    expect(raycastInstances[0].setAssetBaseUrl).toHaveBeenCalledWith(undefined)
  })

  it('assetBaseUrl が変わると renderer を作り直し、新しいベースを load 前に渡す', async () => {
    raycastInstances.length = 0
    const { rerender } = render(<RPGPlayer view="raycast" assetBaseUrl="/api/a/assets/raw" />)
    await new Promise((r) => setTimeout(r, 0))
    rerender(<RPGPlayer view="raycast" assetBaseUrl="/api/b/assets/raw" />)
    await new Promise((r) => setTimeout(r, 0))
    expect(raycastInstances).toHaveLength(2)
    expect(raycastInstances[0].destroy).toHaveBeenCalled()
    const next = raycastInstances[1]
    expect(next.setAssetBaseUrl).toHaveBeenCalledWith('/api/b/assets/raw')
    expect(next.setAssetBaseUrl.mock.invocationCallOrder[0]).toBeLessThan(
      next.load.mock.invocationCallOrder[0]
    )
  })

  it('view=topdown でも setAssetBaseUrl が呼ばれる', async () => {
    topdownSetAssetBaseUrl.mockClear()
    render(<RPGPlayer assetBaseUrl="/api/projects/g/assets/raw" />)
    await new Promise((r) => setTimeout(r, 0))
    expect(topdownSetAssetBaseUrl).toHaveBeenCalledWith('/api/projects/g/assets/raw')
  })
})

// #840 3本目: frontmatter `dialog_style:` の値が、窓を作る init() より前に renderer へ渡る
describe('RPGPlayer の dialogStyle (#840)', () => {
  it('dialogStyle が adv → ff に変わると renderer を作り直し、新しい renderer に ff が渡る（窓は init で作るため）', () => {
    topdownSetDialogStyle.mockClear()
    const { rerender } = render(<RPGPlayer dialogStyle="adv" />)
    expect(topdownSetDialogStyle).toHaveBeenLastCalledWith('adv')
    const before = topdownSetDialogStyle.mock.calls.length
    rerender(<RPGPlayer dialogStyle="ff" />)
    expect(topdownSetDialogStyle.mock.calls.length).toBe(before + 1)
    expect(topdownSetDialogStyle).toHaveBeenLastCalledWith('ff')
  })
  it('TopDown: dialogStyle="ff" が init より前に setDialogStyle へ渡る', async () => {
    topdownSetDialogStyle.mockClear()
    topdownInit.mockClear()
    render(<RPGPlayer dialogStyle="ff" />)
    expect(topdownSetDialogStyle).toHaveBeenCalledWith('ff')
    expect(topdownSetDialogStyle.mock.invocationCallOrder[0]).toBeLessThan(
      topdownInit.mock.invocationCallOrder[0]
    )
  })
  it('Raycast: dialogStyle が setDialogStyle へ渡る（未指定は undefined）', () => {
    const before = raycastInstances.length
    render(<RPGPlayer view="raycast" dialogStyle="ff" />)
    expect(raycastInstances[before].setDialogStyle).toHaveBeenCalledWith('ff')
    render(<RPGPlayer view="raycast" />)
    expect(raycastInstances[before + 1].setDialogStyle).toHaveBeenCalledWith(undefined)
  })
})
