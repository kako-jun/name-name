/**
 * 敵の見えないグリッド (#839 段1): 純粋関数のみ。まだどこにも配線しない（既存の戦闘配置は不変）。
 *
 * 設計の正本は docs/design/enemy-formation.md §3.1〜3.6。
 * - 座標系: 列は左から 0,1,2,…（表記 A,B,C,…。左 = 奥・味方から遠い、右 = 手前）、行は上から 0,1,…（表記 1,2,…）
 * - セルの大きさ（`cell`）は、領域・列数・行数・ラベル帯・窓との重なり許容量だけで決まり、体数・種類に依らない
 * - 敵はサイズ区分 `w x h` のセルを占有し、絵はその占有矩形に足元中央で contain する
 */

import {
  SIDE_LABEL_GAP,
  SIDE_LABEL_HEIGHT,
  isLabelWidthReadable,
  normalizeEnemyWindowOverlap,
  type Rect,
  type SpriteSlot,
} from './battleLayout'

/** グリッドの列数・行数の範囲（設計書 §3.1） */
export const ENEMY_GRID_MAX_COLS = 12
export const ENEMY_GRID_MAX_ROWS = 4

export interface EnemyGridSize {
  cols: number
  rows: number
}

/** 敵のサイズ区分（占有するセルの幅 x 高さ。整数 1 以上） */
export interface EnemySize {
  w: number
  h: number
}

/** グリッド上のセル（0 始まり。左上） */
export interface GridCell {
  col: number
  row: number
}

const SIZE_PATTERN = /^(\d+)\s*[x×]\s*(\d+)$/

function parseWH(raw: string): [number, number] | null {
  // 全角の数字・x を半角へ。× (U+00D7) は NFKC で変わらないのでパターン側で受ける
  const m = SIZE_PATTERN.exec(raw.normalize('NFKC').trim().toLowerCase())
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  // 桁あふれ（Infinity）だけ弾く。巨大な値はグリッドでは上限へ丸め、サイズでは parseEnemySize が弾く
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return [a, b]
}

/**
 * サイズ区分 `2x1` / `1X2` / `２×２` を解釈する。幅・高さとも 1 以上の整数のみ有効。
 * 不正値は null（呼び出し側が警告して 1x1 にする）
 */
export function parseEnemySize(raw: string): EnemySize | null {
  const wh = parseWH(raw)
  if (!wh || !Number.isSafeInteger(wh[0]) || !Number.isSafeInteger(wh[1]) || wh[0] < 1 || wh[1] < 1)
    return null
  return { w: wh[0], h: wh[1] }
}

/**
 * `battle_enemy_grid` の値 `列数x行数` を解釈する。列 1〜12・行 1〜4 に丸める。
 * 書式が不正（数字でない・0 以下）なら null＝無効（従来方式）
 */
export function parseEnemyGrid(raw: string): EnemyGridSize | null {
  const wh = parseWH(raw)
  if (!wh || wh[0] < 1 || wh[1] < 1) return null
  return {
    cols: Math.min(ENEMY_GRID_MAX_COLS, wh[0]),
    rows: Math.min(ENEMY_GRID_MAX_ROWS, wh[1]),
  }
}

/** 配置指定 `C1`（列 = 英字、行 = 1 始まりの数字。大小無視）を 0 始まりのセルへ。不正は null */
export function parseCellRef(raw: string): GridCell | null {
  const m = /^([a-z])(\d+)$/.exec(raw.normalize('NFKC').trim().toLowerCase())
  if (!m) return null
  const row = Number(m[2])
  if (!Number.isSafeInteger(row) || row < 1) return null
  return { col: m[1].charCodeAt(0) - 97, row: row - 1 }
}

/** 配置する敵 1 体の入力。`at` があれば左上セルを固定（配置指定） */
export interface PlacementItem {
  w: number
  h: number
  at?: GridCell
}

export type PlacementErrorKind =
  /** サイズが不正（整数 1 以上でない）／グリッドより大きい */
  | 'invalid-size'
  /** 配置指定の占有矩形がグリッドの外にはみ出す */
  | 'out-of-range'
  /** 配置指定が、先に確定した他の敵と重なる */
  | 'overlap'
  /** 自動配置で空きが無い */
  | 'full'
  /** グリッド自体が不正（列数・行数が 1 以上の整数でない）。全敵がこのエラーになる */
  | 'invalid-grid'

export interface PlacementError {
  /** `items` の添字 */
  index: number
  kind: PlacementErrorKind
}

export interface PlacementResult {
  /** `items` と同じ並び。置けなかった敵は null */
  cells: (GridCell | null)[]
  /** 空なら全員が置けた */
  errors: PlacementError[]
}

function isValidDim(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 1
}

/**
 * 敵をグリッドへ配置する (§3.5)。
 * 1. 配置指定つきを `items` の順に確定（範囲外・重なりはエラー）
 * 2. 残りを `items` の順に、手前の列（右）から奥へ・各列は上から下の first-fit で置く
 *    （走査の基点は占有矩形の左上。幅 w の敵は列 `cols - w` から始める）
 * エラーの敵は置かずに続行する（呼び出し側が群を無効化する）。
 */
export function placeEnemies(
  grid: EnemyGridSize,
  items: readonly PlacementItem[]
): PlacementResult {
  const { cols, rows } = grid
  if (!isValidDim(cols) || !isValidDim(rows)) {
    return {
      cells: items.map(() => null),
      errors: items.map((_, index) => ({ index, kind: 'invalid-grid' as const })),
    }
  }
  const occupied: boolean[][] = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false)
  )
  const cells: (GridCell | null)[] = new Array<GridCell | null>(items.length).fill(null)
  const errors: PlacementError[] = []

  const isFree = (col: number, row: number, w: number, h: number): boolean => {
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) {
        if (occupied[r][c]) return false
      }
    }
    return true
  }
  const mark = (col: number, row: number, w: number, h: number): void => {
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) occupied[r][c] = true
    }
  }

  const valid: boolean[] = items.map((item, index) => {
    const ok = isValidDim(item.w) && isValidDim(item.h) && item.w <= cols && item.h <= rows
    if (!ok) errors.push({ index, kind: 'invalid-size' })
    return ok
  })

  // 1. 配置指定
  items.forEach((item, index) => {
    if (!valid[index] || !item.at) return
    const { col, row } = item.at
    if (
      !Number.isSafeInteger(col) ||
      !Number.isSafeInteger(row) ||
      col < 0 ||
      row < 0 ||
      col + item.w > cols ||
      row + item.h > rows
    ) {
      errors.push({ index, kind: 'out-of-range' })
      return
    }
    if (!isFree(col, row, item.w, item.h)) {
      errors.push({ index, kind: 'overlap' })
      return
    }
    mark(col, row, item.w, item.h)
    cells[index] = { col, row }
  })

  // 2. 自動配置
  items.forEach((item, index) => {
    if (!valid[index] || item.at) return
    for (let col = cols - item.w; col >= 0; col--) {
      for (let row = 0; row <= rows - item.h; row++) {
        if (isFree(col, row, item.w, item.h)) {
          mark(col, row, item.w, item.h)
          cells[index] = { col, row }
          return
        }
      }
    }
    errors.push({ index, kind: 'full' })
  })

  errors.sort((a, b) => a.index - b.index)
  return { cells, errors }
}

/** 配置済みの敵 1 体（`placeEnemies` の結果 + サイズ区分 + 表示倍率） */
export interface EnemyFootprint {
  col: number
  row: number
  w: number
  h: number
  /** 占有矩形の中での表示倍率（0.25〜1。省略 = 1）。範囲外は丸める */
  scale?: number
}

export interface EnemyGridLayoutOptions {
  /** 名前 + HP ラベルを足元に置くか（行ごとに帯を予約する） */
  withLabel: boolean
  /** 窓との重なり許容量 (#838。`normalizeEnemyWindowOverlap` で丸める。省略 = 既定) */
  windowOverlap?: number | null
}

export const ENEMY_SCALE_MIN = 0.25
export const ENEMY_SCALE_MAX = 1

/**
 * 敵 1 体ぶんの配置結果。`SpriteSlot` の形に `x,y,width,size` = 占有矩形を載せる。
 * `SpriteSlot.scale` は奥行き (#747) の縮尺なので、ここでは常に 1（モンスターの倍率は `displayScale`）
 */
export interface EnemyGridSlot extends SpriteSlot {
  /** 占有矩形（`x,y,width,size` と同じ。ラベル帯は含めない） */
  occupied: Rect
  /** 絵（contain 前の箱）: 占有矩形を `displayScale` で足元中央基準に縮めた矩形。絵はこの箱へ contain する */
  box: Rect
  /** モンスターの表示倍率（0.25〜1）。`box` の縮み率 */
  displayScale: number
}

export interface EnemyGridLayout {
  /** セル一辺。領域・列数・行数・ラベル帯・窓重なりだけで決まる（体数・種類・縦横比に依らない）。置けないほど狭いと 0 */
  cell: number
  /** グリッド全体の矩形（ラベル帯込み。上端は窓重なり許容ぶん `region.y` より上へ延びうる） */
  grid: Rect
  /** `footprints` と同じ並び */
  slots: EnemyGridSlot[]
}

function clampScale(raw: number | undefined): number {
  if (raw === undefined || Number.isNaN(raw)) return ENEMY_SCALE_MAX
  return Math.min(ENEMY_SCALE_MAX, Math.max(ENEMY_SCALE_MIN, raw))
}

/**
 * 敵グリッドの配置を求める (§3.2, §3.6)。
 *
 * ```
 * labelBand = withLabel ? SIDE_LABEL_GAP + SIDE_LABEL_HEIGHT : 0
 * cell      = min(regionW / cols, (regionH - rows*labelBand) / (rows - overlap))
 * ```
 * グリッドは領域の横中央・縦は下端に置き、最上行は `overlap * cell` だけ領域の上へ延びる（窓の下へ入ってよい量）。
 * 占有矩形は幅 `w*cell`・高さ `h*cell`、最下行の `cell` の下端に揃える（同じ行の 1x1 と足元が合う）。
 * `floor` は占有矩形の下端、ラベルはその直下（占有幅まで）。
 */
export function computeEnemyGridLayout(
  region: Rect,
  grid: EnemyGridSize,
  footprints: readonly EnemyFootprint[],
  options: EnemyGridLayoutOptions
): EnemyGridLayout {
  const { cols, rows } = grid
  // 前提: 列数・行数は 1 以上の整数。不正なら cell 0（何も置かない）
  const gridValid = isValidDim(cols) && isValidDim(rows)
  const overlap = normalizeEnemyWindowOverlap(options.windowOverlap)
  const labelBand = options.withLabel ? SIDE_LABEL_GAP + SIDE_LABEL_HEIGHT : 0

  const byWidth = region.w / cols
  const byHeight = (region.h - rows * labelBand) / (rows - overlap)
  const raw = gridValid ? Math.min(byWidth, byHeight) : 0
  const cell = Number.isFinite(raw) && raw > 0 ? raw : 0

  // 置けないほど狭いときはラベル帯も取らない（グリッド全体が 0）
  const band = cell > 0 ? labelBand : 0
  const gridW = cell * cols
  const gridH = (cell + band) * rows
  const gridRect: Rect = {
    x: region.x + (region.w - gridW) / 2,
    y: region.y + region.h - gridH,
    w: gridW,
    h: gridH,
  }

  const slots = footprints.map((fp): EnemyGridSlot => {
    const lastRowBottom = gridRect.y + (fp.row + fp.h - 1) * (cell + band) + cell
    const width = fp.w * cell
    const size = fp.h * cell
    const x = gridRect.x + fp.col * cell
    const y = lastRowBottom - size
    const floor = lastRowBottom
    const s = clampScale(fp.scale)
    const box: Rect = {
      x: x + (width * (1 - s)) / 2,
      y: floor - size * s,
      w: width * s,
      h: size * s,
    }
    const slot: EnemyGridSlot = {
      x,
      y,
      size,
      width,
      floor,
      scale: 1,
      displayScale: s,
      occupied: { x, y, w: width, h: size },
      box,
    }
    if (options.withLabel && cell > 0 && isLabelWidthReadable(width)) {
      slot.label = { x, y: floor + SIDE_LABEL_GAP, w: width, h: SIDE_LABEL_HEIGHT }
    }
    return slot
  })

  return { cell, grid: gridRect, slots }
}

/** 描画順（奥 → 手前）の添字並び。`floor` 昇順、同じ `floor` は列の昇順（左 = 奥が先）。元の並びは変えない */
export function enemyDrawOrder(slots: readonly Pick<SpriteSlot, 'floor' | 'x'>[]): number[] {
  return slots
    .map((_, i) => i)
    .sort((a, b) => slots[a].floor - slots[b].floor || slots[a].x - slots[b].x || a - b)
}
