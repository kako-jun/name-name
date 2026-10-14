import { describe, expect, it } from 'vitest'
import {
  computeStallLimitMs,
  createChoiceMemory,
  markChoiceSelected,
  recordChoice,
  exportProgressSignature,
  isSceneInExportRange,
  pickAutoChoice,
} from './videoExportPolicy'

const order = ['a', 'b', 'c', 'd', 'e']

describe('isSceneInExportRange (#780)', () => {
  it('開始・終了の両端と間は範囲内、外は範囲外', () => {
    expect(isSceneInExportRange('b', 'b', 'd', order)).toBe(true)
    expect(isSceneInExportRange('c', 'b', 'd', order)).toBe(true)
    expect(isSceneInExportRange('d', 'b', 'd', order)).toBe(true)
    expect(isSceneInExportRange('a', 'b', 'd', order)).toBe(false)
    expect(isSceneInExportRange('e', 'b', 'd', order)).toBe(false)
  })
  it('開始=終了なら、そのシーンだけが範囲内', () => {
    expect(isSceneInExportRange('c', 'c', 'c', order)).toBe(true)
    expect(isSceneInExportRange('b', 'c', 'c', order)).toBe(false)
  })
  it('終了が開始より前に並んでいても間を範囲とする', () => {
    expect(isSceneInExportRange('c', 'd', 'b', order)).toBe(true)
    expect(isSceneInExportRange('e', 'd', 'b', order)).toBe(false)
  })
  it('一覧に無いシーンは範囲外（開始・終了が一覧に無いときも false）', () => {
    expect(isSceneInExportRange('zzz', 'a', 'e', order)).toBe(false)
    expect(isSceneInExportRange('b', 'zzz', 'e', order)).toBe(false)
    expect(isSceneInExportRange('b', 'a', 'e', [])).toBe(false)
  })
})

describe('pickAutoChoice (#780)', () => {
  it('範囲内の先頭を返す。範囲外・ロック中は飛ばす', () => {
    expect(
      pickAutoChoice(
        [
          { jump: 'e', locked: false },
          { jump: 'b', locked: true },
          { jump: 'c', locked: false },
          { jump: 'd', locked: false },
        ],
        'b',
        'd',
        order,
        createChoiceMemory(),
        'k'
      )
    ).toBe('c')
  })
  it('範囲内の遷移先が無ければ null', () => {
    expect(
      pickAutoChoice([{ jump: 'e', locked: false }], 'a', 'c', order, createChoiceMemory(), 'k')
    ).toBeNull()
    expect(pickAutoChoice([], 'a', 'c', order, createChoiceMemory(), 'k')).toBeNull()
    expect(
      pickAutoChoice([{ jump: 'b', locked: true }], 'a', 'c', order, createChoiceMemory(), 'k')
    ).toBeNull()
  })
})

describe('exportProgressSignature (#780)', () => {
  it('位置が同じなら同じ署名、1つでも違えば別', () => {
    const p = { sceneId: 'a', eventIndex: 1, textIndex: 2, sentenceIndex: 3 }
    expect(exportProgressSignature(p)).toBe(exportProgressSignature({ ...p }))
    expect(exportProgressSignature({ ...p, sentenceIndex: 4 })).not.toBe(exportProgressSignature(p))
    expect(exportProgressSignature({ ...p, sceneId: null })).not.toBe(exportProgressSignature(p))
  })
})

describe('pickAutoChoice: 選択済みの辺 (#780)', () => {
  const opts = [
    { jump: 'b', locked: false },
    { jump: 'c', locked: false },
  ]
  it('この位置で選び済みの辺は飛ばし、未選択の範囲内の先頭を返す', () => {
    const m = createChoiceMemory()
    markChoiceSelected(m, 'a:1', 'b')
    expect(pickAutoChoice(opts, 'a', 'c', order, m, 'a:1')).toBe('c')
    expect(pickAutoChoice(opts, 'a', 'c', order, createChoiceMemory(), 'a:1')).toBe('b')
  })
  it('別の位置の選択肢なら、同じ遷移先でも未選択の辺として扱う', () => {
    const m = createChoiceMemory()
    markChoiceSelected(m, 'a:1', 'b')
    expect(pickAutoChoice(opts, 'a', 'c', order, m, 'a:2')).toBe('b')
  })
  it('範囲内の辺がすべて選び済みで、先に未選択の辺も無ければ null', () => {
    const m = createChoiceMemory()
    markChoiceSelected(m, 'a:1', 'b')
    markChoiceSelected(m, 'a:1', 'c')
    expect(pickAutoChoice(opts, 'a', 'c', order, m, 'a:1')).toBeNull()
  })
  it('選び済みの辺でも、先に未選択の範囲内の辺があれば選ぶ（サブメニュー構成）', () => {
    // h[m] → m[x, y]。m:1 で x を選んで h に戻った状態
    const o = ['h', 'm', 'x', 'y']
    const m = createChoiceMemory()
    recordChoice(m, 'h:1', 'h', [{ jump: 'm', locked: false }])
    recordChoice(m, 'm:1', 'm', [
      { jump: 'x', locked: false },
      { jump: 'y', locked: false },
    ])
    markChoiceSelected(m, 'h:1', 'm')
    markChoiceSelected(m, 'm:1', 'x')
    expect(pickAutoChoice([{ jump: 'm', locked: false }], 'h', 'y', o, m, 'h:1')).toBe('m')
    markChoiceSelected(m, 'm:1', 'y')
    expect(pickAutoChoice([{ jump: 'm', locked: false }], 'h', 'y', o, m, 'h:1')).toBeNull()
  })
  it('見た選択肢が循環していても無限再帰しない', () => {
    const m = createChoiceMemory()
    recordChoice(m, 'a:1', 'a', [{ jump: 'b', locked: false }])
    recordChoice(m, 'b:1', 'b', [{ jump: 'a', locked: false }])
    markChoiceSelected(m, 'a:1', 'b')
    markChoiceSelected(m, 'b:1', 'a')
    expect(pickAutoChoice([{ jump: 'b', locked: false }], 'a', 'b', order, m, 'a:1')).toBeNull()
  })
})

describe('computeStallLimitMs (#780)', () => {
  it('待機中は待機時間を加え、待機中でなければ基本の長さ', () => {
    expect(computeStallLimitMs(60_000, null)).toBe(60_000)
    expect(computeStallLimitMs(60_000, 80_000)).toBe(140_000)
    expect(computeStallLimitMs(60_000, 0)).toBe(60_000)
  })
})
