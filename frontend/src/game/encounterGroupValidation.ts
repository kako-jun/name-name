/**
 * エンカウント群の「収まるか」検証 (#839 段5・設計書 enemy-formation.md §3.5)。
 *
 * `battle_enemy_grid` が有効なゲームだけ、読み込み時に全マップの全群を実際に配置してみる。
 * `*m..n` は最大数で展開し、各敵のサイズ（`MonsterDef.size`、無ければ 1x1）と群の配置指定 `@C1` で
 * `placeEnemies` に通す。収まらない群（範囲外・重なり・満杯・サイズ超過・不正グリッド）は
 * エラーとして一覧し、呼び出し側が抽選候補から外す（ゲームは開けなくしない）。
 *
 * 純粋関数のみ（console は触らない）。構文警告（`parseEncounterGroup` の warnings）や未知のモンスター id は
 * 既存の寛容さ（警告して飛ばす）に合わせ、ここでは群のエラーにしない。未知 id の敵は数えない。
 */

import type { MonsterDef } from '../types'
import { hasOwn } from './ownProperty'
import { parseEncounterGroup } from './enemyGroup'
import {
  placeEnemies,
  type EnemyGridSize,
  type PlacementErrorKind,
  type PlacementItem,
} from './enemyGrid'

/** 検証する群 1 つ。`mapId` はエラー表示用（シーン id など） */
export interface EncounterGroupInput {
  mapId: string
  /** 群の生文字列（`[エンカウント群: …]` の 1 項目。重み `:3` 込み） */
  spec: string
}

/** 収まらなかった敵 1 体 */
export interface EncounterGroupError {
  mapId: string
  /** 群の生文字列 */
  group: string
  monsterId: string
  /** 群の中でその敵が何体目か（その monsterId の 1 始まりの通し番号。`*m..n` は最大数で数える） */
  nth: number
  kind: PlacementErrorKind
  /** 日本語の理由 */
  reason: string
}

export interface EncounterGroupValidation {
  /** 入力と同じ並びの「収まるか」 */
  valid: boolean[]
  /** 収まった群だけ（入力の順序・文字列のまま） */
  validGroups: EncounterGroupInput[]
  /** 収まらなかった敵ごとのエラー（群の並び順 → 敵の並び順） */
  errors: EncounterGroupError[]
}

/** 0 始まりの列・行を `C1` 表記へ（列は A〜Z。範囲外の大きな値は数値表記にフォールバック） */
function cellLabel(col: number, row: number): string {
  const c = col >= 0 && col < 26 ? String.fromCharCode(65 + col) : `列${col}`
  return `${c}${row + 1}`
}

function reasonOf(kind: PlacementErrorKind, item: PlacementItem, grid: EnemyGridSize): string {
  switch (kind) {
    case 'invalid-size':
      return `サイズ ${item.w}x${item.h} が不正、またはグリッド ${grid.cols}x${grid.rows} より大きい`
    case 'out-of-range':
      return `配置指定 ${item.at ? cellLabel(item.at.col, item.at.row) : '?'} が範囲外（占有 ${item.w}x${item.h} がグリッド ${grid.cols}x${grid.rows} からはみ出す）`
    case 'overlap':
      return `配置指定 ${item.at ? cellLabel(item.at.col, item.at.row) : '?'} が他の敵と重なる`
    case 'full':
      return `自動配置の空きが無い（グリッド ${grid.cols}x${grid.rows} が満杯）`
    case 'invalid-grid':
      return `グリッド ${grid.cols}x${grid.rows} が不正`
  }
}

/** 群 1 つを検証する。収まらない敵のエラー（空なら収まる） */
function validateOne(
  input: EncounterGroupInput,
  grid: EnemyGridSize,
  masters: Record<string, MonsterDef>
): EncounterGroupError[] {
  const parsed = parseEncounterGroup(input.spec)
  const items: PlacementItem[] = []
  const meta: { monsterId: string; nth: number }[] = []
  const counts = new Map<string, number>()
  for (const it of parsed.items) {
    // 未知の id は rollEncounter が警告して飛ばす。ここでも数えない
    const def = hasOwn(masters, it.id) ? masters[it.id] : undefined
    if (!def) continue
    for (let i = 0; i < it.max; i++) {
      const nth = (counts.get(it.id) ?? 0) + 1
      counts.set(it.id, nth)
      items.push({
        w: def.size?.w ?? 1,
        h: def.size?.h ?? 1,
        ...(i === 0 && it.at ? { at: { col: it.at.col, row: it.at.row } } : {}),
      })
      meta.push({ monsterId: it.id, nth })
    }
  }
  const result = placeEnemies(grid, items)
  return result.errors.map((e) => ({
    mapId: input.mapId,
    group: input.spec,
    monsterId: meta[e.index].monsterId,
    nth: meta[e.index].nth,
    kind: e.kind,
    reason: reasonOf(e.kind, items[e.index], grid),
  }))
}

/** 全群を検証する。入力の順序は保つ */
export function validateEncounterGroups(input: {
  grid: EnemyGridSize
  masters: Record<string, MonsterDef>
  groups: readonly EncounterGroupInput[]
}): EncounterGroupValidation {
  const valid: boolean[] = []
  const errors: EncounterGroupError[] = []
  const validGroups: EncounterGroupInput[] = []
  for (const g of input.groups) {
    const errs = validateOne(g, input.grid, input.masters)
    valid.push(errs.length === 0)
    if (errs.length === 0) validGroups.push(g)
    else errors.push(...errs)
  }
  return { valid, validGroups, errors }
}

/** エラー 1 件の表示文（console / 画面の警告用） */
export function formatEncounterGroupError(e: EncounterGroupError): string {
  return `マップ '${e.mapId}' の群 "${e.group}": 敵 '${e.monsterId}' の ${e.nth} 体目が収まらない（${e.reason}）`
}

/** 無効化した群の要約 + 一覧（1 件以上のとき）。画面・console 共通の文面 */
export function formatEncounterGroupErrors(errors: readonly EncounterGroupError[]): string {
  const groups = new Set(errors.map((e) => `${e.mapId}\u0000${e.group}`)).size
  return [
    `敵グリッドに収まらない群を ${groups} 件無効化しました（抽選候補から除外）`,
    ...errors.map((e) => `- ${formatEncounterGroupError(e)}`),
  ].join('\n')
}
