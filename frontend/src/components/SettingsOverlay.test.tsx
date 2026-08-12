// Issue #548: 設定オーバーレイの並び順変更（テキスト速度 → オート進行ウェイト → BGM 音量 →
// SE 音量 → ボイス音量）は SliderRow の JSX 記述順を入れ替えただけで、ロジック・props・値は
// 変更なしのはずの変更。NovelPlayer.test.tsx は SettingsOverlay を vi.mock で丸ごとスタブ化して
// おり内部順序・結線は未検証だったため、このファイルで実描画による検証を追加する。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import SettingsOverlay from './SettingsOverlay'
import type { Settings } from '../game/settings'

// 取り違え（結線誤り）を検出できるよう、全項目に異なる値を与える。
const TEST_SETTINGS: Settings = {
  msPerChar: 25,
  autoWaitMs: 3000,
  bgmVolume: 0.65,
  seVolume: 0.75,
  voiceVolume: 0.85,
}

// 期待する新順序（#548 の変更本体: autoWaitMs が BGM より前に来る）
const LABELS_IN_ORDER = [
  'テキスト表示速度',
  'オート進行ウェイト',
  'BGM 音量',
  'SE 音量',
  'ボイス音量 (将来用)',
]

function renderOverlay(onChange = vi.fn()) {
  const utils = render(
    <SettingsOverlay open={true} onClose={vi.fn()} settings={TEST_SETTINGS} onChange={onChange} />
  )
  return { ...utils, onChange }
}

// 各 SliderRow は label > (div > span×2) + input で構成される。
// label 要素を DOM 出現順で取ると、そのまま SliderRow の描画順になる。
function getSliderLabels(container: HTMLElement): HTMLLabelElement[] {
  return Array.from(container.querySelectorAll('label'))
}

function sliderInput(label: HTMLLabelElement): HTMLInputElement {
  return label.querySelector('input[type="range"]') as HTMLInputElement
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SettingsOverlay 並び順・結線 (#548)', () => {
  it('TC1: 5項目のラベルが新順序（テキスト速度→オート進行ウェイト→BGM→SE→ボイス）でDOM出現する', () => {
    const { container } = renderOverlay()
    const labelTexts = getSliderLabels(container).map(
      (label) => label.querySelector('span')?.textContent
    )
    expect(labelTexts).toEqual(LABELS_IN_ORDER)
  })

  it('TC2: スライダー(input[type=range])がちょうど5個描画される（重複/欠落なし）', () => {
    renderOverlay()
    expect(screen.getAllByRole('slider')).toHaveLength(5)
  })

  it('TC3-1: 「テキスト表示速度」sliderはmsPerCharに結線され、変更時に他キーを巻き込まずonChangeされる', () => {
    const onChange = vi.fn()
    const { container } = renderOverlay(onChange)
    const input = sliderInput(getSliderLabels(container)[0])
    expect(input.value).toBe(String(TEST_SETTINGS.msPerChar))

    fireEvent.change(input, { target: { value: '50' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...TEST_SETTINGS, msPerChar: 50 })
  })

  it('TC3-2 (最重要): 「オート進行ウェイト」sliderはautoWaitMsに結線され、変更時に他キーを巻き込まずonChangeされる', () => {
    const onChange = vi.fn()
    const { container } = renderOverlay(onChange)
    const input = sliderInput(getSliderLabels(container)[1])
    expect(input.value).toBe(String(TEST_SETTINGS.autoWaitMs))

    fireEvent.change(input, { target: { value: '4000' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...TEST_SETTINGS, autoWaitMs: 4000 })
  })

  it('TC3-3: 「BGM 音量」sliderはbgmVolumeに結線され、変更時に他キーを巻き込まずonChangeされる', () => {
    const onChange = vi.fn()
    const { container } = renderOverlay(onChange)
    const input = sliderInput(getSliderLabels(container)[2])
    expect(input.value).toBe(String(TEST_SETTINGS.bgmVolume))

    fireEvent.change(input, { target: { value: '0.3' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...TEST_SETTINGS, bgmVolume: 0.3 })
  })

  it('TC3-4: 「SE 音量」sliderはseVolumeに結線され、変更時に他キーを巻き込まずonChangeされる', () => {
    const onChange = vi.fn()
    const { container } = renderOverlay(onChange)
    const input = sliderInput(getSliderLabels(container)[3])
    expect(input.value).toBe(String(TEST_SETTINGS.seVolume))

    fireEvent.change(input, { target: { value: '0.4' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...TEST_SETTINGS, seVolume: 0.4 })
  })

  it('TC3-5: 「ボイス音量」sliderはvoiceVolumeに結線され、変更時に他キーを巻き込まずonChangeされる', () => {
    const onChange = vi.fn()
    const { container } = renderOverlay(onChange)
    const input = sliderInput(getSliderLabels(container)[4])
    expect(input.value).toBe(String(TEST_SETTINGS.voiceVolume))

    fireEvent.change(input, { target: { value: '0.5' } })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...TEST_SETTINGS, voiceVolume: 0.5 })
  })

  it('TC4: 「オート進行ウェイト」のmin/max/stepが移動後も維持されている(500/8000/100)', () => {
    const { container } = renderOverlay()
    const input = sliderInput(getSliderLabels(container)[1])
    expect(input.min).toBe('500')
    expect(input.max).toBe('8000')
    expect(input.step).toBe('100')
  })

  it('TC5: レンダー・全スライダー操作を通してconsole.error/console.warnが一度も呼ばれない', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onChange = vi.fn()
    const { container } = renderOverlay(onChange)

    getSliderLabels(container).forEach((label) => {
      const input = sliderInput(label)
      fireEvent.change(input, { target: { value: input.value } })
    })

    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
