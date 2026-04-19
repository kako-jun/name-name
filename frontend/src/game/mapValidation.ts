import type { MapData } from '../types/rpg'

/** 高さグリッドの次元ミスマッチ種別 */
export type HeightGridField = 'wallHeights' | 'floorHeights' | 'ceilingHeights'

export interface HeightDimensionError {
  field: HeightGridField
  kind: 'row-count-mismatch' | 'col-count-mismatch'
  expected: number
  actual: number
  /** col-count-mismatch のときの該当行インデックス */
  rowIndex?: number
}

export interface MapValidationResult {
  /** エラーが 1 件も無ければ true */
  ok: boolean
  errors: HeightDimensionError[]
}

/**
 * MapData 内の wallHeights / floorHeights / ceilingHeights の次元が tiles と一致するかを検証する純粋関数。
 *
 * - grid が未指定の field はスキップ
 * - 行数ミスマッチは row-count-mismatch（expected=map.height, actual=grid.length）
 * - 任意の行で列数が map.width と異なれば col-count-mismatch を行ごとに 1 件発行
 * - 複数 field / 複数行のエラーは全て収集（early return しない）
 *
 * Issue #89。Markdown 構文（#90）・MapEditor（#91）・RaycastRenderer.load() 共通で使う。
 */
export function validateMapHeights(map: MapData): MapValidationResult {
  const errors: HeightDimensionError[] = []
  const grids: Array<{ field: HeightGridField; grid: number[][] | undefined }> = [
    { field: 'wallHeights', grid: map.wallHeights },
    { field: 'floorHeights', grid: map.floorHeights },
    { field: 'ceilingHeights', grid: map.ceilingHeights },
  ]
  for (const { field, grid } of grids) {
    if (!grid) continue
    if (grid.length !== map.height) {
      errors.push({
        field,
        kind: 'row-count-mismatch',
        expected: map.height,
        actual: grid.length,
      })
      // 行数が違っても、合致する行については列数チェックを続ける価値が薄いので
      // ここで当該 field の検証は打ち切る（col エラーでノイズを増やさない）
      continue
    }
    for (let y = 0; y < grid.length; y++) {
      if (grid[y].length !== map.width) {
        errors.push({
          field,
          kind: 'col-count-mismatch',
          expected: map.width,
          actual: grid[y].length,
          rowIndex: y,
        })
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 検証エラーを人間可読な 1 行メッセージに整形する。ログ出力・UI 表示共通で使う。
 */
export function formatHeightError(err: HeightDimensionError): string {
  if (err.kind === 'row-count-mismatch') {
    return `${err.field}: row count mismatch (expected ${err.expected}, got ${err.actual})`
  }
  return `${err.field}: col count mismatch at row ${err.rowIndex} (expected ${err.expected}, got ${err.actual})`
}
