/**
 * 敵の見えないグリッド (#839): 純粋関数のみ（段1）。段4で `computeSideBattleLayout` / `BattleScreen` に配線済み（`battle_enemy_grid` を書いたゲームだけ。未指定は従来の配置）。
 *
 * 設計の正本は docs/design/enemy-formation.md §3.1〜3.6。
 * - 座標系: 列は左から 0,1,2,…（表記 A,B,C,…。左 = 奥・味方から遠い、右 = 手前）、行は上から 0,1,…（表記 1,2,…）
 * - セルの大きさ（`cell`）は、領域・列数・行数・ラベル帯・窓との重なり許容量だけで決まり、体数・種類に依らない
 * - 敵はサイズ区分 `w x h` のセルを占有し、絵はその占有矩形に足元中央で contain する
 */

import {
  SIDE_LABEL_GAP,
  computeDepthScale,
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

/** グリッド上のセル（0 始まり。左上） */
export interface GridCell {
  col: number
  row: number
}

/** `列数x行数`（グリッド指定）の書式。敵のサイズ区分 `サイズ:` は Rust parser が解釈する */
const GRID_PATTERN = /^(\d+)\s*[x×]\s*(\d+)$/

function parseWH(raw: string): [number, number] | null {
  // 全角の数字・x を半角へ。× (U+00D7) は NFKC で変わらないのでパターン側で受ける
  const m = GRID_PATTERN.exec(raw.normalize('NFKC').trim().toLowerCase())
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  // 数字だけのパターンなので NaN にはならない。桁あふれ（Infinity）はグリッドでは上限へ丸める
  return [a, b]
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

/**
 * frontmatter `battle_enemy_grid` の値を正規化する (#839)。書式が不正・未指定は undefined＝無効（従来方式）。
 * 列 1〜12・行 1〜4 に丸める（`parseEnemyGrid`）
 */
export function normalizeEnemyGrid(raw: string | null | undefined): EnemyGridSize | undefined {
  if (typeof raw !== 'string') return undefined
  return parseEnemyGrid(raw) ?? undefined
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/

/**
 * frontmatter `battle_enemy_window_overlap` の値を正規化する (#839)。0〜0.5 に丸める。
 * 未指定・数値でない値は undefined＝既定（`normalizeEnemyWindowOverlap` が 0.25 にする）。
 * `Number('')` = 0 や `Number('0x10')` に化けないよう、素直な十進数だけを受ける
 */
export function normalizeEnemyWindowOverlapSetting(
  raw: string | null | undefined
): number | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.normalize('NFKC').trim()
  if (!PLAIN_NUMBER.test(t)) return undefined
  return normalizeEnemyWindowOverlap(Number(t))
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
  const gridW = gridValid ? cell * cols : 0
  const gridH = gridValid ? (cell + band) * rows : 0
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

/** `computeSideBattleLayout` / `applyDepthToGridSlots` が返す敵スロットが、グリッド由来（`box` などを持つ）か */
export function isEnemyGridSlot(slot: SpriteSlot | undefined | null): slot is EnemyGridSlot {
  return !!slot && 'occupied' in slot && 'box' in slot && 'displayScale' in slot
}

/**
 * 窓との重なり許容量を、延長ぶん `overlap * cell` が窓の高さ `windowHeight` を超えない範囲に絞る (#839 段4。設計書 §3.6 末尾)。
 * これで領域の上端を延ばしても `log.y + log.h - overlap * cell >= log.y`（窓の外＝画面上へ出ない）が保たれる。
 *
 * `cell` 自体が `overlap` に依る（`cell = min(cw, hn / (rows - overlap))`、`cw = region.w/cols`、`hn = region.h - rows*labelBand`）ので、
 * 延長量 `f(o) = o * cell(o) = min(o*cw, o*hn/(rows - o))` を `windowHeight` 以下にする最大の `o` を閉形式で解く:
 * `o*cw <= L` または `o*hn/(rows - o) <= L`（= `o <= L*rows/(hn + L)`）のどちらかを満たせばよい（min なので）。
 * `f` は `o` について単調増加なので、`o` を許容量の上限から落とした最大値がそのまま答え。
 * 領域が狭く `cell` が 0 になる（置けない）ときは、延長は意味を持たないので 0。
 */
export function clampEnemyWindowOverlap(
  region: Pick<Rect, 'w' | 'h'>,
  grid: EnemyGridSize,
  withLabel: boolean,
  overlap: number | null | undefined,
  windowHeight: number
): number {
  const o = normalizeEnemyWindowOverlap(overlap)
  const { cols, rows } = grid
  if (!isValidDim(cols) || !isValidDim(rows) || !(windowHeight > 0)) return 0
  const labelBand = withLabel ? SIDE_LABEL_GAP + SIDE_LABEL_HEIGHT : 0
  const cw = region.w / cols
  const hn = region.h - rows * labelBand
  if (!(cw > 0) || !(hn > 0)) return 0
  const L = windowHeight
  const limit = Math.max(L / cw, (L * rows) / (hn + L))
  return Math.max(0, Math.min(o, limit))
}

/**
 * 奥行き (#747) をグリッド由来の敵スロットに適用する。`applyDepthToSlots` と同じ規則（元の占有矩形の上端・水平中央を保って縮尺 `s` で縮める）を、
 * `occupied` / `box` にも同じ変換で適用し、ラベルも追従させる。`floor` は元の値のまま（描画順の基準）。
 * `window` を渡すと、縮めたあとの窓との重なりが `overlap * 縮んだ高さ` を超えないよう、元の占有矩形の内側で下へずらす。
 */
export function applyDepthToGridSlots(
  slots: readonly EnemyGridSlot[],
  frontFloor: number,
  horizonY: number,
  perspective: number,
  window?: { bottom: number; overlap: number }
): EnemyGridSlot[] {
  return slots.map((slot) => {
    const s = computeDepthScale(slot.floor, frontFloor, horizonY, perspective)
    if (s >= 1) return slot
    const cx = slot.x + slot.width / 2
    const top = slot.y
    const shrink = (r: Rect): Rect => ({
      x: cx + (r.x - cx) * s,
      y: top + (r.y - top) * s,
      w: r.w * s,
      h: r.h * s,
    })
    let occupied = shrink(slot.occupied)
    let box = shrink(slot.box)
    // 窓との重なり (#838): グリッドは縮める前の cell で上端を `overlap * cell` だけ窓の下へ延ばしている。上端固定で縮めると、
    // 縮んだ高さに対する重なりの比が許容量を超える（縮尺が小さいほど窓の下に丸ごと隠れる）。元の占有矩形の内側で、
    // 窓に入る量が `overlap * 縮んだ高さ` 以下になる位置まで下へずらす（元の下端は超えない＝非重複などの不変条件は保たれる）
    let dy = 0
    if (window) {
      const want = window.bottom - window.overlap * occupied.h - occupied.y
      const room = slot.occupied.y + slot.occupied.h - (occupied.y + occupied.h)
      dy = Math.max(0, Math.min(want, room))
      if (dy > 0) {
        occupied = { ...occupied, y: occupied.y + dy }
        box = { ...box, y: box.y + dy }
      }
    }
    const out: EnemyGridSlot = {
      x: occupied.x,
      y: occupied.y,
      width: occupied.w,
      size: occupied.h,
      floor: slot.floor,
      scale: s,
      displayScale: slot.displayScale,
      occupied,
      box,
    }
    if (slot.label) {
      const w = slot.label.w * s
      if (isLabelWidthReadable(w)) {
        out.label = {
          x: slot.label.x + (slot.label.w - w) / 2,
          y: out.y + out.size + SIDE_LABEL_GAP,
          w,
          h: slot.label.h,
        }
      }
    }
    return out
  })
}

/** 置けなかった敵のスロット（大きさ 0＝後段が描かない）。足元はグリッド下端 */
export function emptyEnemyGridSlot(x: number, floor: number): EnemyGridSlot {
  const zero: Rect = { x, y: floor, w: 0, h: 0 }
  return {
    x,
    y: floor,
    width: 0,
    size: 0,
    floor,
    scale: 1,
    displayScale: 1,
    occupied: zero,
    box: { ...zero },
  }
}
