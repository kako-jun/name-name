/**
 * NovelRenderer の SeekBar 連携テスト (#350 D 群)。
 *
 * 検証対象（jsdom で観測可能なものだけ。実 EventSystem の DOM 先行発火 race は実ブラウザ任せ）:
 *  - 二重 advance 抑止: SeekBar の onSeek が立てる `suppressNextAdvance` を handleAdvance が
 *    1 回だけ消費して早期 return する（justSelectedChoice と同型のガード順）。
 *  - setExporting → seekBar.setExportSuppressed への伝播。
 *
 * 駆動方式（NovelRenderer.autoMode.test.ts と同形）:
 *  - `new NovelRenderer()` のみ（init は呼ばない＝PixiJS app は構築されるが canvas 化しない）。
 *  - private へは internals キャストでアクセスし、`advanceOrSkipTypewriter` を vi.spyOn で観測する
 *    （実 advance は走らせない）。
 *  - handleAdvance は suppress=false 経路で audioManager.ensureContext() を呼ぶが jsdom には
 *    AudioContext が無いため、その経路を通すテストでは ensureContext を no-op spy にする。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'

interface SeekAdvanceInternals {
  suppressNextAdvance: boolean
  justSelectedChoice: boolean
  handleAdvance: () => void
  advanceOrSkipTypewriter(): void
  audioManager: { ensureContext(): void }
  seekBar: { setExportSuppressed(suppressed: boolean): void }
}
function internals(r: NovelRenderer): SeekAdvanceInternals {
  return r as unknown as SeekAdvanceInternals
}

/** suppress=false 経路で AudioContext 不在で落ちないよう ensureContext を no-op にする。 */
function muteAudio(r: NovelRenderer) {
  vi.spyOn(internals(r).audioManager, 'ensureContext').mockImplementation(() => {})
}

/** advanceOrSkipTypewriter を spy で差し替える（実 advance/skip は走らせない）。 */
function spyAdvance(r: NovelRenderer) {
  return vi.spyOn(internals(r), 'advanceOrSkipTypewriter').mockImplementation(() => {})
}

describe('NovelRenderer SeekBar 二重 advance 抑止 (#350 D 群)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // D-1: 抑制フラグが立っていなければ通常どおり advance し、フラグは false のまま。
  it('D-1: suppressNextAdvance=false なら handleAdvance で advanceOrSkipTypewriter を 1 回呼ぶ', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    const adv = spyAdvance(r)
    expect(internals(r).suppressNextAdvance).toBe(false)
    internals(r).handleAdvance()
    expect(adv).toHaveBeenCalledTimes(1)
    expect(internals(r).suppressNextAdvance).toBe(false)
  })

  // D-2(核): 抑制フラグが立っていると advance せず、フラグを false に消費して早期 return する。
  it('D-2: suppressNextAdvance=true なら advance せずフラグを false に消費する', () => {
    const r = new NovelRenderer()
    const adv = spyAdvance(r)
    internals(r).suppressNextAdvance = true
    internals(r).handleAdvance()
    expect(adv).not.toHaveBeenCalled()
    expect(internals(r).suppressNextAdvance).toBe(false)
  })

  // D-3: 抑制は 1 回限り。消費後すぐもう一度 handleAdvance すると今度は通常どおり進む。
  it('D-3: 抑制消費後の 2 回目 handleAdvance は通常どおり advance する（1 回限定）', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    const adv = spyAdvance(r)
    internals(r).suppressNextAdvance = true
    internals(r).handleAdvance() // 1 回目: 抑制を消費して return
    expect(adv).not.toHaveBeenCalled()
    internals(r).handleAdvance() // 2 回目: 抑制は無いので進む
    expect(adv).toHaveBeenCalledTimes(1)
  })

  // D-4: justSelectedChoice ガードが先頭。両方立っていても choice ガードで return し、
  //      suppressNextAdvance は消費されず残る（ガード順の固定）。
  it('D-4: justSelectedChoice と suppress が両立すると choice ガードが先勝ちで suppress は残る', () => {
    const r = new NovelRenderer()
    const adv = spyAdvance(r)
    internals(r).justSelectedChoice = true
    internals(r).suppressNextAdvance = true
    internals(r).handleAdvance()
    expect(adv).not.toHaveBeenCalled()
    expect(internals(r).justSelectedChoice).toBe(false) // choice ガードが消費
    expect(internals(r).suppressNextAdvance).toBe(true) // 後段に届かず未消費で残る
  })

  // D-5: setExporting(true/false) が SeekBar.setExportSuppressed(true/false) へ伝播する。
  it('D-5: setExporting(true/false) が seekBar.setExportSuppressed(true/false) へ伝播する', () => {
    const r = new NovelRenderer()
    const spy = vi.spyOn(internals(r).seekBar, 'setExportSuppressed')
    r.setExporting(true)
    expect(spy).toHaveBeenNthCalledWith(1, true)
    r.setExporting(false)
    expect(spy).toHaveBeenNthCalledWith(2, false)
  })
})
