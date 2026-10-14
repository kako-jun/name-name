import { describe, expect, it } from 'vitest'
import { exportProgressSignature, isSceneInExportRange, pickAutoChoice } from './videoExportPolicy'

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
        order
      )
    ).toBe('c')
  })
  it('範囲内の遷移先が無ければ null', () => {
    expect(pickAutoChoice([{ jump: 'e', locked: false }], 'a', 'c', order)).toBeNull()
    expect(pickAutoChoice([], 'a', 'c', order)).toBeNull()
    expect(pickAutoChoice([{ jump: 'b', locked: true }], 'a', 'c', order)).toBeNull()
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
