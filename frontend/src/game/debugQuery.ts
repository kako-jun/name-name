/**
 * URL クエリによるデバッグ起点指定のパーサ (#220 Phase 3、#652で本番ビルドでも有効化)。
 *
 * NovelPlayer から常時呼ばれ、URL の query string を playScript() / startFrom() の引数に
 * 変換する。副作用なし・DOM 非依存の純粋関数で、テスト容易性のためにパースロジックを
 * ここに隔離する（レンダラ／component に直書きしない）。
 *
 * #652: 以前は `import.meta.env.DEV` ガード付きで dev ビルド限定だったが、gymnasia の
 * ような1ルートが複数ファイルに分割された構成の実機デバッグのため、本番ビルドでも
 * 動作するようにした（`NovelPlayer.tsx` 側のガードを撤去。ここのパーサ自体は変更不要）。
 * kako-jun確定の設計方針: 「知らなければ踏まない URL パラメータ」自体が十分な隠蔽であり、
 * 追加の有効化条件・認証は不要（#652）。
 *
 * 仕様:
 * - `?debug_script=advance,advance,choice:1-1` → { script: Step[] }（優先）
 * - `?debug_scene=1-2&debug_flags=saw_characters:true` → { scene: StartFromOptions }
 * - どちらも無ければ null
 * - `?debug_unlock_all=1` は上記とは独立（`parseDebugUnlockAll` 参照、#652）
 */

import type { Step, StartFromOptions } from './GameState'
import type { FlagValue } from '../types'
import { safeAssign } from './ownProperty'

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
    // #370: key が "__proto__" でも own-property として書く（prototype pollution 回避）
    safeAssign(flags, key, toFlagValue(val))
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

/**
 * `?debug_unlock_all=1` の有無をパースする (#652)。
 *
 * デバッグ用の全選択肢ロック解除フラグ。`debug_scene`/`debug_script`/`debug_flags` とは
 * 独立して評価される——`debug_flags` で個別に `xxx_cleared:true` を積めば同じ効果を得られる
 * ケースもあるが、gymnasia のように未知/大量のルートフラグを扱う実機デバッグでは、
 * どのフラグが必要かを事前に把握せずに全ルートを強制解放できる本パラメータの方が使い勝手が
 * 良いため用意した。
 *
 * `parseThemeQuery`（`themeQuery.ts`）と同じ厳密一致方式——値が `'1'` のときだけ true。
 * それ以外（未指定・`'0'`・空文字・他の値）はすべて false に倒す（`?debug_unlock_all=0` を
 * URL に残したまま無効化したいケースを誤って有効化しないため、パラメータの有無だけでは
 * 判定しない）。
 *
 * @param search `window.location.search`（先頭 `?` の有無どちらも可）
 * @returns `debug_unlock_all=1` が指定されていれば true、それ以外は false
 */
export function parseDebugUnlockAll(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.get('debug_unlock_all') === '1'
}
