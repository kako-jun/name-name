/**
 * エンカウント群の書式 (#839 段2・設計書 enemy-formation.md §3.4)。
 *
 * 群は `[エンカウント群: g1, g2, …]` のカンマ区切り生文字列（Rust parser は透過）。
 * 群の中は `+` 連結で、各項と群全体に任意の修飾子を付けられる。
 *
 *   id@C1      配置（左上セルを列 C・行 1 に固定。個数が複数なら最初の 1 体）
 *   id*3       個数固定
 *   id*1..3    個数ランダム（`*0..n` も可。群全体が 0 体なら 1 回振り直す）
 *   ...:3      群の重み（末尾。整数 1 以上、既定 1）
 *
 * id は slug（空白・`@ * :` と全角の `＠＊：` を含まない）なので、既存の群文字列は 1 文字も変えずに同じ意味で解釈される。
 * 構文エラーの項は警告を返し、その項だけ捨てる。純粋関数のみ（乱数は引数）。
 */

import { ENEMY_GRID_MAX_COLS, ENEMY_GRID_MAX_ROWS, parseCellRef, type GridCell } from './enemyGrid'

/** 1 項あたりの個数の上限（敵グリッドの最大セル数 12×4 に合わせる） */
export const ENCOUNTER_ITEM_MAX_COUNT = ENEMY_GRID_MAX_COLS * ENEMY_GRID_MAX_ROWS

export interface EncounterGroupItem {
  id: string
  /** 個数の下限（固定個数のときは max と同じ） */
  min: number
  max: number
  /** `*m..n` の範囲指定が書かれていた（抽選で rng を 1 回消費する） */
  ranged: boolean
  /** 配置指定（最初の 1 体の左上セル。0 始まり） */
  at?: GridCell
}

export interface ParsedEncounterGroup {
  items: EncounterGroupItem[]
  /** 明示された重み。未指定は undefined（抽選時の既定は 1） */
  weight?: number
  /** 構文エラーの説明（捨てた項・無視した重み） */
  warnings: string[]
}

export interface ResolvedEnemy {
  id: string
  /** 配置指定（placeEnemies の PlacementItem.at に渡せる） */
  at?: GridCell
}

/** 修飾の開始記号（半角・全角）。id 本体はこれらを含まない */
const MODIFIER_START_RE = /[@*:＠＊：]/
/** 修飾部分（NFKC 正規化後）。個数 `*3` `*1..3` と配置 `@C1` */
const MODIFIER_RE = /^(?:\*(\d+)(?:\.\.(\d+))?)?(?:@(\S+))?$/
const UINT_RE = /^\d+$/

function parseItem(raw: string): EncounterGroupItem | string {
  const idx = raw.search(MODIFIER_START_RE)
  const id = idx < 0 ? raw : raw.slice(0, idx)
  if (!id || /\s/.test(id)) return `構文エラーの項を捨てた '${raw}'`
  // 全角の修飾記号・数字・セルだけ NFKC で受理する（id 本体は正規化しない）
  const mod = idx < 0 ? '' : raw.slice(idx).normalize('NFKC')
  const m = MODIFIER_RE.exec(mod)
  if (!m) return `構文エラーの項を捨てた '${raw}'`
  const [, a, b, cellRaw] = m
  let min = 1
  let max = 1
  let ranged = false
  if (a !== undefined) {
    min = Number(a)
    if (b !== undefined) {
      max = Number(b)
      ranged = true
    } else {
      max = min
    }
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || max < 1) {
      return `個数が不正な項を捨てた '${raw}'`
    }
    if (max > ENCOUNTER_ITEM_MAX_COUNT) {
      return `個数が上限 ${ENCOUNTER_ITEM_MAX_COUNT} を超える項を捨てた '${raw}'`
    }
  }
  const item: EncounterGroupItem = { id, min, max, ranged }
  if (cellRaw !== undefined) {
    const at = parseCellRef(cellRaw)
    if (!at) return `配置指定が不正な項を捨てた '${raw}'`
    item.at = at
  }
  return item
}

/** 群 1 つ分の生文字列を解釈する。例外は投げない */
export function parseEncounterGroup(spec: string): ParsedEncounterGroup {
  const warnings: string[] = []
  let body = spec
  let weight: number | undefined
  const colon = Math.max(spec.lastIndexOf(':'), spec.lastIndexOf('：'))
  if (colon >= 0) {
    const w = spec
      .slice(colon + 1)
      .normalize('NFKC')
      .trim()
    body = spec.slice(0, colon)
    const n = Number(w)
    if (UINT_RE.test(w) && Number.isSafeInteger(n) && n >= 1) weight = n
    else warnings.push(`群の重みが不正なため無視した ':${w}'`)
  }
  const items: EncounterGroupItem[] = []
  for (const part of body.split('+')) {
    const raw = part.trim()
    if (!raw) continue
    const r = parseItem(raw)
    if (typeof r === 'string') warnings.push(r)
    else items.push(r)
  }
  if (items.length === 0 && spec.trim() !== '') warnings.push(`有効な項が無い群 '${spec.trim()}'`)
  return { items, ...(weight !== undefined ? { weight } : {}), warnings }
}

/**
 * 重み付き抽選で群の添字を返す。
 * どの群にも重みが無ければ現行どおり `Math.floor(rng() * n)`（乱数消費 1 回で同一）。
 * あれば累積重み（未指定は 1）から rng() 1 回。
 */
export function pickGroupIndex(
  weights: ReadonlyArray<number | undefined>,
  rng: () => number
): number {
  const n = weights.length
  if (weights.every((w) => w === undefined)) return Math.floor(rng() * n)
  const ws = weights.map((w) => w ?? 1)
  const total = ws.reduce((a, b) => a + b, 0)
  const r = rng() * total
  let acc = 0
  for (let i = 0; i < n; i++) {
    acc += ws[i]
    if (r < acc) return i
  }
  return n - 1
}

function rollOnce(items: readonly EncounterGroupItem[], rng: () => number): ResolvedEnemy[] {
  const out: ResolvedEnemy[] = []
  for (const it of items) {
    const count = it.ranged ? it.min + Math.floor(rng() * (it.max - it.min + 1)) : it.min
    for (let i = 0; i < count; i++) {
      out.push(i === 0 && it.at ? { id: it.id, at: it.at } : { id: it.id })
    }
  }
  return out
}

/**
 * 群の個数を確定して敵のリストにする。範囲指定を書いた項ごとに rng() を 1 回消費する。
 * 全体が 0 体になったら 1 回だけ振り直す（2 回目は 0 のままでも返す）。
 */
export function resolveEncounterGroup(
  group: ParsedEncounterGroup,
  rng: () => number
): ResolvedEnemy[] {
  const first = rollOnce(group.items, rng)
  if (first.length > 0 || !group.items.some((i) => i.ranged)) return first
  return rollOnce(group.items, rng)
}
