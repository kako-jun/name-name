/**
 * ディレクティブのディスパッチ (#829, #735 8/8)。
 *
 * 領域別の 3 表（ステージ / 立ち絵 / オーディオ）を 1 枚の表に結合し、`dispatchDirective` がイベント種で引く。
 * 表に無い種（`Dialog` / `Narration` などのテキスト、`Flag` / `Choice` / `Jump` / `Wait` / `WaitDisplayComplete`
 * のフロー制御、未知のイベント）は何もせず `false` を返す。フロー制御系はレンダラが続けて処理する。
 *
 * 新しいディレクティブの置き場は docs/architecture.md の「新しいディレクティブをどこに足すか」を参照。
 */
import type { Event } from '../../types'
import { audioDirectives } from './audioDirectives'
import { characterDirectives } from './characterDirectives'
import { stageDirectives, stageSignalDirectives } from './stageDirectives'
import type { DirectiveContext, DirectiveHandler, DirectiveTable } from './types'

export type {
  DirectiveContext,
  DirectiveEnv,
  DirectiveHandler,
  DirectiveHooks,
  DirectiveLayers,
  DirectiveTable,
} from './types'

function mergeTables(...tables: DirectiveTable[]): Map<string, DirectiveHandler> {
  const merged = new Map<string, DirectiveHandler>()
  for (const table of tables) {
    for (const [key, handler] of Object.entries(table)) {
      if (merged.has(key)) throw new Error(`ディレクティブ表のキーが重複しています: ${key}`)
      merged.set(key, handler)
    }
  }
  return merged
}

/** オブジェクトイベント（`{ Key: ... }`）の結合済みディスパッチ表。テストが内容を検査する。 */
export const directiveTable: ReadonlyMap<string, DirectiveHandler> = mergeTables(
  stageDirectives,
  characterDirectives,
  audioDirectives
)

/** 文字列イベント（`'SceneTransition'` など引数なしの合図）のディスパッチ表。 */
export const signalDirectiveTable: ReadonlyMap<string, DirectiveHandler> =
  mergeTables(stageSignalDirectives)

/** 表にある種なら処理して true、無ければ何もせず false。 */
export function dispatchDirective(event: Event, ctx: DirectiveContext): boolean {
  if (typeof event === 'string') {
    const handler = signalDirectiveTable.get(event)
    if (!handler) return false
    handler(event, ctx)
    return true
  }
  if (event === null || typeof event !== 'object') return false
  for (const key of Object.keys(event)) {
    const handler = directiveTable.get(key)
    if (handler) {
      handler(event, ctx)
      return true
    }
  }
  return false
}
