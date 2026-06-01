/**
 * URL クエリによるデバッグ起点指定のパーサ (#220 Phase 3)。
 *
 * `import.meta.env.DEV` 時に NovelPlayer から呼ばれ、URL の query string を
 * playScript() / startFrom() の引数に変換する。副作用なし・DOM 非依存の純粋関数で、
 * テスト容易性のためにパースロジックをここに隔離する（レンダラ／component に直書きしない）。
 *
 * 仕様:
 * - `?debug_script=advance,advance,choice:1-1` → { script: Step[] }（優先）
 * - `?debug_scene=1-2&debug_flags=saw_characters:true` → { scene: StartFromOptions }
 * - どちらも無ければ null
 */

import type { Step, StartFromOptions } from './GameState'
import type { FlagValue } from '../types'

/** parseDebugQuery の戻り値。script 指定 / scene 指定 / 該当なし(null) の三択。 */
export type DebugQueryResult = { script: Step[] } | { scene: StartFromOptions } | null

/**
 * 文字列値を FlagValue に変換する。
 * - "true" / "false" → Bool
 * - 数値文字列 → Number
 * - それ以外 → String
 */
function toFlagValue(raw: string): FlagValue {
  if (raw === 'true') return { Bool: true }
  if (raw === 'false') return { Bool: false }
  // 空文字は数値変換すると 0 になってしまうため除外し、String 扱いにする
  if (raw !== '' && !Number.isNaN(Number(raw))) return { Number: Number(raw) }
  return { String: raw }
}

/**
 * `debug_script` の値（カンマ区切りトークン列）を Step[] にパースする。
 * 不正トークンはスキップして堅牢に処理する。
 *
 * - `advance` → { type: 'advance' }
 * - `choice:<jump>` → { type: 'choice', jump: <jump> }
 * - `wait:<ms>` → { type: 'wait', ms: Number(<ms>) }（数値にならない場合はスキップ）
 */
function parseScript(value: string): Step[] {
  const steps: Step[] = []
  for (const rawToken of value.split(',')) {
    const token = rawToken.trim()
    if (token === '') continue

    if (token === 'advance') {
      steps.push({ type: 'advance' })
      continue
    }

    const sep = token.indexOf(':')
    if (sep === -1) continue // 引数を伴わない未知トークンはスキップ

    const kind = token.slice(0, sep)
    const arg = token.slice(sep + 1)

    if (kind === 'choice') {
      if (arg === '') continue
      steps.push({ type: 'choice', jump: arg })
    } else if (kind === 'wait') {
      const ms = Number(arg)
      if (Number.isNaN(ms)) continue
      steps.push({ type: 'wait', ms })
    }
    // 未知の kind はスキップ
  }
  return steps
}

/**
 * `debug_flags` の値（`key:val,key2:val2`）を Record<string, FlagValue> にパースする。
 * 不正トークン（key 無し等）はスキップする。
 */
function parseFlags(value: string): Record<string, FlagValue> {
  const flags: Record<string, FlagValue> = {}
  for (const rawPair of value.split(',')) {
    const pair = rawPair.trim()
    if (pair === '') continue
    const sep = pair.indexOf(':')
    if (sep === -1) continue // val 無しはスキップ
    const key = pair.slice(0, sep).trim()
    if (key === '') continue
    const val = pair.slice(sep + 1)
    flags[key] = toFlagValue(val)
  }
  return flags
}

/**
 * URL の query string をデバッグ起点指定にパースする。
 *
 * @param search `window.location.search`（先頭 `?` の有無どちらも可）
 * @returns debug_script があれば { script }（優先）、無く debug_scene があれば { scene }、
 *          どちらも無ければ null
 */
export function parseDebugQuery(search: string): DebugQueryResult {
  const params = new URLSearchParams(search)

  // debug_script を優先。ただし空・全トークン無効で Step が0件なら
  // debug_scene へフォールスルーする（空 script が有効な scene を握りつぶさないため）
  const scriptParam = params.get('debug_script')
  if (scriptParam !== null) {
    const script = parseScript(scriptParam)
    if (script.length > 0) return { script }
  }

  const sceneId = params.get('debug_scene')
  if (sceneId !== null && sceneId !== '') {
    const scene: StartFromOptions = { sceneId }

    const flagsParam = params.get('debug_flags')
    if (flagsParam !== null) {
      scene.flags = parseFlags(flagsParam)
    }

    const eventIndexParam = params.get('debug_eventIndex')
    if (eventIndexParam !== null) {
      const n = Number(eventIndexParam)
      if (!Number.isNaN(n)) scene.eventIndex = n
    }

    const textIndexParam = params.get('debug_textIndex')
    if (textIndexParam !== null) {
      const n = Number(textIndexParam)
      if (!Number.isNaN(n)) scene.textIndex = n
    }

    return { scene }
  }

  return null
}
