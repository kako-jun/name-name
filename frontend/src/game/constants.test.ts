import { describe, expect, it } from 'vitest'
import {
  ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO,
  GAME_HEIGHT,
  GAME_WIDTH,
  parseAspectRatio,
  isAutoAspectRatio,
  pickFluidAspectRatio,
} from './constants'
import { computeSplitLayoutRegions } from './novelLayout'

describe('ASPECT_RATIOS', () => {
  it('16:9 は 800×450', () => {
    expect(ASPECT_RATIOS['16:9']).toEqual({ width: 800, height: 450 })
  })

  it('4:3 は 800×600', () => {
    expect(ASPECT_RATIOS['4:3']).toEqual({ width: 800, height: 600 })
  })

  it('9:16 は 450×800', () => {
    expect(ASPECT_RATIOS['9:16']).toEqual({ width: 450, height: 800 })
  })

  it('2:1 は 900×450 (#444 split_layout 2窓モード用)', () => {
    expect(ASPECT_RATIOS['2:1']).toEqual({ width: 900, height: 450 })
  })

  it('1:2 は 450×900 (#444 split_layout 2窓モード用)', () => {
    expect(ASPECT_RATIOS['1:2']).toEqual({ width: 450, height: 900 })
  })
})

describe('DEFAULT_ASPECT_RATIO', () => {
  it('デフォルトは 16:9', () => {
    expect(DEFAULT_ASPECT_RATIO).toBe('16:9')
  })
})

describe('GAME_WIDTH / GAME_HEIGHT (後方互換エイリアス)', () => {
  it('GAME_WIDTH はデフォルト比率の width と一致する', () => {
    expect(GAME_WIDTH).toBe(ASPECT_RATIOS[DEFAULT_ASPECT_RATIO].width)
  })

  it('GAME_HEIGHT はデフォルト比率の height と一致する', () => {
    expect(GAME_HEIGHT).toBe(ASPECT_RATIOS[DEFAULT_ASPECT_RATIO].height)
  })

  it('GAME_WIDTH の具体的な値は 800', () => {
    expect(GAME_WIDTH).toBe(800)
  })

  it('GAME_HEIGHT の具体的な値は 450 (16:9 デフォルト)', () => {
    expect(GAME_HEIGHT).toBe(450)
  })
})

describe('parseAspectRatio', () => {
  it('有効な比率文字列をそのまま返す', () => {
    expect(parseAspectRatio('16:9')).toBe('16:9')
    expect(parseAspectRatio('4:3')).toBe('4:3')
    expect(parseAspectRatio('9:16')).toBe('9:16')
  })

  it('undefined はデフォルトにフォールバックする', () => {
    expect(parseAspectRatio(undefined)).toBe(DEFAULT_ASPECT_RATIO)
  })

  it('null はデフォルトにフォールバックする', () => {
    expect(parseAspectRatio(null)).toBe(DEFAULT_ASPECT_RATIO)
  })

  it('空文字はデフォルトにフォールバックする', () => {
    expect(parseAspectRatio('')).toBe(DEFAULT_ASPECT_RATIO)
  })

  it('未知の文字列はデフォルトにフォールバックする', () => {
    expect(parseAspectRatio('21:9')).toBe(DEFAULT_ASPECT_RATIO)
    expect(parseAspectRatio('1:1')).toBe(DEFAULT_ASPECT_RATIO)
    expect(parseAspectRatio('bad')).toBe(DEFAULT_ASPECT_RATIO)
  })

  it('"auto"（#442 fluid モード）は3値のいずれにも一致せずデフォルトにフォールバックする（isAutoAspectRatio が別途処理する分岐）', () => {
    expect(parseAspectRatio('auto')).toBe(DEFAULT_ASPECT_RATIO)
  })

  it('"2:1"/"1:2"（#444 で AspectRatio 型に追加された値）も3値専用のままデフォルトにフォールバックする（#444 の設計意図の回帰pin: AspectRatio 型拡張後も parseAspectRatio を介さず直接 ASPECT_RATIOS で解決すべき）', () => {
    expect(parseAspectRatio('2:1')).toBe(DEFAULT_ASPECT_RATIO)
    expect(parseAspectRatio('1:2')).toBe(DEFAULT_ASPECT_RATIO)
  })
})

describe('isAutoAspectRatio (#442)', () => {
  it('"auto" は true（fluid モード判定）', () => {
    expect(isAutoAspectRatio('auto')).toBe(true)
  })

  it('固定3値のいずれも false', () => {
    expect(isAutoAspectRatio('16:9')).toBe(false)
    expect(isAutoAspectRatio('4:3')).toBe(false)
    expect(isAutoAspectRatio('9:16')).toBe(false)
  })

  it('空文字は false', () => {
    expect(isAutoAspectRatio('')).toBe(false)
  })

  it('undefined は false', () => {
    expect(isAutoAspectRatio(undefined)).toBe(false)
  })

  it('null は false', () => {
    expect(isAutoAspectRatio(null)).toBe(false)
  })

  it('"AUTO"（大文字）は false（大文字小文字を区別する厳密一致）', () => {
    expect(isAutoAspectRatio('AUTO')).toBe(false)
  })

  it('"auto "（末尾空白混入）は false（trim しない厳密一致）', () => {
    expect(isAutoAspectRatio('auto ')).toBe(false)
  })
})

describe('pickFluidAspectRatio (#442)', () => {
  it('横長（width > height）は 16:9', () => {
    expect(pickFluidAspectRatio(1920, 1080)).toBe('16:9')
  })

  it('縦長（width < height）は 9:16', () => {
    expect(pickFluidAspectRatio(1080, 1920)).toBe('9:16')
  })

  it('正方形（width === height）は横長側の 16:9 に倒す', () => {
    expect(pickFluidAspectRatio(800, 800)).toBe('16:9')
  })

  it('境界: width が height より 1px 大きい (801,800) は 16:9', () => {
    expect(pickFluidAspectRatio(801, 800)).toBe('16:9')
  })

  it('境界: width が height より 1px 小さい (800,801) は 9:16', () => {
    expect(pickFluidAspectRatio(800, 801)).toBe('9:16')
  })

  it('極小 1x1 は正方形と同じく横長側の 16:9 に倒す', () => {
    expect(pickFluidAspectRatio(1, 1)).toBe('16:9')
  })

  it('splitLayout=true: 横長は 2:1 (#444)', () => {
    expect(pickFluidAspectRatio(1920, 1080, true)).toBe('2:1')
  })

  it('splitLayout=true: 縦長は 1:2 (#444)', () => {
    expect(pickFluidAspectRatio(1080, 1920, true)).toBe('1:2')
  })

  it('splitLayout=true: 正方形は横長側の 2:1 に倒す（#444、既存の「正方形は横長側」規約を継承）', () => {
    expect(pickFluidAspectRatio(800, 800, true)).toBe('2:1')
  })

  it('splitLayout=true 境界: width が height より 1px 大きい (801,800) は 2:1 (#444)', () => {
    expect(pickFluidAspectRatio(801, 800, true)).toBe('2:1')
  })

  it('splitLayout=true 境界: width が height より 1px 小さい (800,801) は 1:2 (#444)', () => {
    expect(pickFluidAspectRatio(800, 801, true)).toBe('1:2')
  })

  it('後方互換: 第3引数(splitLayout)を省略しても従来どおり 16:9/9:16 を返す (#444 signature 拡張の回帰pin)', () => {
    expect(pickFluidAspectRatio(1920, 1080)).toBe('16:9')
    expect(pickFluidAspectRatio(1080, 1920)).toBe('9:16')
  })

  it('splitLayout=false を明示指定しても従来どおり 16:9 のまま（#444、非破壊）', () => {
    expect(pickFluidAspectRatio(1920, 1080, false)).toBe('16:9')
  })
})

// #442: pickFluidAspectRatio（fluid aspect_ratio: auto の離散比率選択）と
// computeSplitLayoutRegions（split_layout の画像/テキスト領域分割）は、同じ `>=` 規約
// （正方形は横長側）で境界を揃えている必要がある——揃っていないと「キャンバスの実形」と
// 「split_layout の領域分割」が矛盾する（docs/architecture.md #442 参照）。
// pickFluidAspectRatio(W,H)==='16:9' ⟺ computeSplitLayoutRegions(W,H).orientation==='landscape'
// が成立することを、境界を含む複数の (W,H) 組で 1 テストにまとめて往復確認する。
describe('pickFluidAspectRatio と computeSplitLayoutRegions の境界一致 (#442)', () => {
  it('横長/縦長の判定が両関数で常に同じ側に倒れる（境界 ±1・正方形・極小値を含む）', () => {
    const cases: Array<[number, number]> = [
      [800, 800], // 正方形 → 両方とも横長側
      [799, 800], // 縦長 → 両方とも縦長側
      [800, 799], // 横長 → 両方とも横長側
      [1, 1], // 極小正方形 → 両方とも横長側
    ]
    for (const [w, h] of cases) {
      const isLandscapeByRatio = pickFluidAspectRatio(w, h) === '16:9'
      const isLandscapeByRegions = computeSplitLayoutRegions(w, h).orientation === 'landscape'
      expect(isLandscapeByRatio).toBe(isLandscapeByRegions)
    }
  })
})
