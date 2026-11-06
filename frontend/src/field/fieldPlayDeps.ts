/**
 * `/play` のフィールド作品用の、deps の小さな純関数 (#1132, 親 #1096 S4b)。UI にも IO にも触らない。
 */

import type { EventDocument } from '../types'
import type { FieldSourceDoc } from './fieldNotation'

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 読み込み済みの md(path → doc)を `FieldSourceDoc[]` にする。path 昇順(コード単位・ロケール非依存)で決定的。
 * Map の挿入順(ロード完了の順)に依存させない
 */
export function docsOf(loadedDocs: ReadonlyMap<string, EventDocument>): FieldSourceDoc[] {
  return [...loadedDocs.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([path, doc]) => ({ path, doc }))
}

/** `?debug_tilt=off` のときだけ true(チルトシフトを切るデバッグ用。既存の `debug_*` 族と同じ「値が合うときだけ」の形) */
export function parseDebugTiltOff(search: string): boolean {
  return new URLSearchParams(search).get('debug_tilt') === 'off'
}
