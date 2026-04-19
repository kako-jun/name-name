// MapEditor の高さ編集タブ（Issue #91）で使う純粋関数群。
//
// wallHeights / floorHeights / ceilingHeights を width x height の 2 次元配列で扱う
// ユーティリティ。MapData 型の 3 フィールドを一貫した API で操作するために
// HeightField 型でディスパッチする。

export type HeightField = 'wallHeights' | 'floorHeights' | 'ceilingHeights'

/**
 * すべての HeightField を並び順つきで列挙する定数。
 * MapEditor / HeightGrid で loop するときに共有する。
 */
export const HEIGHT_FIELDS: readonly HeightField[] = [
  'wallHeights',
  'floorHeights',
  'ceilingHeights',
] as const

/**
 * HeightField ごとの日本語ラベル（UI 表示・レイヤ on/off のテキスト）。
 */
export const HEIGHT_FIELD_LABELS: Record<HeightField, string> = {
  wallHeights: '壁',
  floorHeights: '床',
  ceilingHeights: '天井',
}

/**
 * 浮動小数比較の許容誤差（1e-9）。
 * プリセット値の一致判定（HeightPalette）や「ほぼ 0」検出で使う。
 * formatHeightLabel は別途 toFixed(4) で丸めるため、許容誤差は 1e-4 相当で表示される。
 */
export const HEIGHT_EPSILON = 1e-9

/**
 * 各 HeightField の fallback（未指定時の既定値）。
 * RaycastRenderer 側の解釈（resolveWall/Floor/CeilingHeight）と一致させること。
 */
export const HEIGHT_FALLBACKS: Record<HeightField, number> = {
  wallHeights: 1.0,
  floorHeights: 0.0,
  ceilingHeights: 1.0,
}

/**
 * パレットに並べるプリセット値。
 * 床は 0.25 刻みで、壁・天井は 0.5 刻み。
 */
export const HEIGHT_PRESETS: Record<HeightField, readonly number[]> = {
  wallHeights: [0, 0.5, 1, 1.5, 2],
  floorHeights: [0, 0.25, 0.5, 0.75, 1],
  ceilingHeights: [0, 0.5, 1, 1.5, 2],
}

/**
 * fallback 値で width x height の配列を初期化する。
 * 既存 grid がある場合はそれを使わず、必ず新しい配列を返す。
 */
export function ensureHeightGrid(field: HeightField, width: number, height: number): number[][] {
  const fallback = HEIGHT_FALLBACKS[field]
  const grid: number[][] = []
  for (let y = 0; y < height; y++) {
    const row: number[] = []
    for (let x = 0; x < width; x++) {
      row.push(fallback)
    }
    grid.push(row)
  }
  return grid
}

/**
 * 既存 grid を width x height にリサイズする。
 * 拡大した部分は fallback、縮小時は超過部分を捨てる。
 * 既存の値はできるだけ保持する。
 */
export function resizeHeightGrid(
  field: HeightField,
  grid: number[][],
  width: number,
  height: number
): number[][] {
  const fallback = HEIGHT_FALLBACKS[field]
  const result: number[][] = []
  for (let y = 0; y < height; y++) {
    const row: number[] = []
    const existingRow = grid[y]
    for (let x = 0; x < width; x++) {
      if (existingRow !== undefined && existingRow[x] !== undefined) {
        row.push(existingRow[x])
      } else {
        row.push(fallback)
      }
    }
    result.push(row)
  }
  return result
}

/**
 * 特定セルに値を塗る。
 * grid が undefined なら ensureHeightGrid で初期化してから塗る。
 * (x, y) が範囲外なら元の grid を返す（throw しない）。
 */
export function paintHeightCell(
  field: HeightField,
  grid: number[][] | undefined,
  width: number,
  height: number,
  x: number,
  y: number,
  value: number
): number[][] {
  const base = grid === undefined ? ensureHeightGrid(field, width, height) : grid

  if (x < 0 || y < 0 || x >= width || y >= height) {
    // 範囲外: もとの grid を返す（ただし undefined なら初期化済みのものを返す）
    return base
  }

  return base.map((row, rowIndex) =>
    rowIndex === y ? row.map((cell, colIndex) => (colIndex === x ? value : cell)) : row
  )
}

/**
 * 高さ値から HSL 背景色を算出する。
 * value === 0 は薄グレー（空 = 通行可 / 段差なしの視覚的区別）。
 * それ以外は field 別の色相 + 値が大きいほど暗い L 値。
 */
export function heightToBackgroundColor(field: HeightField, value: number): string {
  if (value === 0) {
    return '#e5e7eb'
  }

  const hue =
    field === 'wallHeights' ? 200 : field === 'floorHeights' ? 30 : /* ceilingHeights */ 280
  const saturation = field === 'wallHeights' ? 60 : field === 'floorHeights' ? 50 : 40
  // 負数（clamp 漏れ）で L が 90 を超えないよう両側で clamp する
  const lightness = Math.max(20, Math.min(90, 90 - value * 30))

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

/**
 * 数値ラベルの文字色を決める。
 * 薄グレー背景（value === 0）のときは濃グレー、それ以外は白。
 * text-shadow と組み合わせて視認性を確保する。
 */
export function heightToLabelColor(field: HeightField, value: number): string {
  // field は将来の拡張余地として受け取るが、現状は value === 0 のみで分岐する
  void field
  if (value === 0) {
    return '#374151'
  }
  return '#ffffff'
}

/**
 * 数値フォーマット: 整数なら小数なしで、小数があればそのまま。
 * - 1.0 → "1"
 * - 0.25 → "0.25"
 * - 1.5 → "1.5"
 * - 0 → "0"
 */
export function formatHeightLabel(value: number): string {
  if (Number.isInteger(value)) {
    return value.toString()
  }
  // 末尾の不要なゼロを削る（小数点以下 4 桁で丸める）
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}
