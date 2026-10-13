/**
 * NovelPlayer のマウント時の初期入場を決める純粋ロジック (#734, ADR 0003 §5)。
 *
 * 初期入場は「試行の順序付きリスト」として `resolveInitialEntry` が返し、`runInitialEntry` が
 * 順に実行する。次の試行へ進むのは結果が `failed` か `null`（`quickLoad` でデータが無い・ゲートで
 * 弾かれた場合）のときだけ。`entered` / `ended` / `superseded` で打ち切る
 * （`superseded` は、より新しい入場がすでに始まっているので連鎖を続けない）。
 * React / PixiJS / DOM には依存しない（doctrine 規律4: 判定ロジックは純粋関数に出してテストする）。
 */
import type { FlagValue } from '../types'
import type { NovelGameState, StartFromOptions } from './GameState'
import type { DebugQueryResult } from './debugQuery'
import type { SceneEntryResult } from './sceneEntry'

/** 初期入場の1回の試行。 */
export type InitialEntryAttempt =
  /** fluid 再マウントのスナップショットへ復元する（debug 起点は再実行しない）。 */
  | { kind: 'snapshot'; snapshot: NovelGameState }
  /** `?debug_scene=`: 新規開始。debug は confinement なし (#652)。 */
  | { kind: 'debug-scene'; options: StartFromOptions }
  /** `?scene=`: 新規開始。confinement は呼び出し側が算出した一覧で置き換える。 */
  | { kind: 'scene-param'; sceneId: string; confinedSceneIds: string[] | null }
  /** 自動クイックロード（debug 指定も `?scene=` も無いときだけ）。 */
  | { kind: 'quick-load' }
  /** エントリ文書の先頭から。直前の試行が失敗していたら、その flags を保つ。 */
  | { kind: 'entry' }

export interface ResolveInitialEntryInput {
  /** fluid 再マウントで引き継ぐ直前の renderer のスナップショット。無ければ null。 */
  snapshot: NovelGameState | null
  /** `PlayerScreen` がタイトル画面の判定（`hasDebugStart`）に使うのと同じパース結果。 */
  debugQuery: DebugQueryResult
  /** `?scene=` の解決結果（`PlayerScreen` が渡す `initialSceneId`）。 */
  initialSceneId: string | null | undefined
  /** `?scene=` の confinement 一覧。 */
  confinedSceneIds: string[] | null | undefined
  /** 自動クイックロードの対象になるクイックセーブがあるか（docKey が無い場合は false）。 */
  hasQuickSave: boolean
}

/**
 * 初期入場の試行リストを決める。
 *
 * 1. スナップショット（fluid 再マウント）→ 復元。debug 起点・自動クイックロードは行わない
 *    （位置を debug 起点が上書きしない。不整合14）。失敗したらエントリ（flags は保つ）。
 * 2. `?debug_scene=` → 新規開始（confinement なし）
 * 3. `?scene=` → 新規開始（confinement あり）
 * 4. 自動クイックロード。`?debug_scene=` / `?debug_script=` / `?scene=` のどれも無いときだけ
 * 5. エントリ
 */
export function resolveInitialEntry(input: ResolveInitialEntryInput): InitialEntryAttempt[] {
  if (input.snapshot) {
    return [{ kind: 'snapshot', snapshot: input.snapshot }, { kind: 'entry' }]
  }
  const attempts: InitialEntryAttempt[] = []
  if (input.debugQuery && 'scene' in input.debugQuery) {
    attempts.push({ kind: 'debug-scene', options: input.debugQuery.scene })
  }
  if (input.initialSceneId) {
    attempts.push({
      kind: 'scene-param',
      sceneId: input.initialSceneId,
      confinedSceneIds: input.confinedSceneIds ?? null,
    })
  }
  if (input.debugQuery === null && !input.initialSceneId && input.hasQuickSave) {
    attempts.push({ kind: 'quick-load' })
  }
  attempts.push({ kind: 'entry' })
  return attempts
}

/** `runInitialEntry` が使う renderer の入場 API（テストで差し替えられるよう最小の形にする）。 */
export interface InitialEntryRenderer {
  restoreSnapshot(snapshot: NovelGameState): Promise<SceneEntryResult>
  startFrom(options: StartFromOptions): Promise<SceneEntryResult>
  quickLoad(origin: 'auto'): Promise<SceneEntryResult | null>
  /** クイックセーブの flags（データが無ければ null）。ロード失敗時にエントリへ引き継ぐ。 */
  getQuickSaveFlags(): Record<string, FlagValue> | null
}

export interface InitialEntryOutcome {
  /** 最後に実行した試行の結果。 */
  final: SceneEntryResult
  /** 実行した試行とその結果（`quickLoad` のデータ無し・ゲートは null）。 */
  steps: Array<{ attempt: InitialEntryAttempt; result: SceneEntryResult | null }>
  /**
   * 自動セーブ（シーン切替ごとのクイックセーブ）を配線してよいか。
   * 自動クイックロードが通信失敗（resolver-error）で倒れたときは、一時的な失敗で正しいセーブを
   * エントリ冒頭の位置で上書きしないよう、そのセッションでは配線しない。
   * 原稿が変わってセーブのシーンが消えた（not-found）場合は、もう戻れないセーブなので配線する。
   */
  autoSave: boolean
}

/** 試行リストを順に実行する。 */
export async function runInitialEntry(
  renderer: InitialEntryRenderer,
  attempts: readonly InitialEntryAttempt[]
): Promise<InitialEntryOutcome> {
  const steps: InitialEntryOutcome['steps'] = []
  let carriedFlags: Record<string, FlagValue> | null = null
  let autoSave = true
  let final: SceneEntryResult = { status: 'failed', reason: 'not-found' }

  for (const attempt of attempts) {
    let result: SceneEntryResult | null
    switch (attempt.kind) {
      case 'snapshot':
        result = await renderer.restoreSnapshot(attempt.snapshot)
        if (result.status === 'failed') carriedFlags = attempt.snapshot.flags
        break
      case 'debug-scene':
        result = await renderer.startFrom({ ...attempt.options, confinedSceneIds: null })
        break
      case 'scene-param':
        result = await renderer.startFrom({
          sceneId: attempt.sceneId,
          confinedSceneIds: attempt.confinedSceneIds,
        })
        break
      case 'quick-load':
        result = await renderer.quickLoad('auto')
        if (result === null || result.status === 'failed') {
          carriedFlags = renderer.getQuickSaveFlags()
        }
        if (result?.status === 'failed' && result.reason === 'resolver-error') autoSave = false
        break
      case 'entry':
        result = await renderer.startFrom(carriedFlags ? { flags: carriedFlags } : {})
        break
    }
    steps.push({ attempt, result })
    if (result !== null) final = result
    if (result !== null && result.status !== 'failed') break
  }
  return { final, steps, autoSave }
}

/** HUD（デバッグ表示）へ通知する初期入場の結果。 */
export interface InitialEntryReport {
  /** `?debug_scene=` を試したときの結果。試していなければ null。 */
  debugScene: { sceneId: string; entered: boolean } | null
}

export function summarizeInitialEntry(outcome: InitialEntryOutcome): InitialEntryReport {
  const step = outcome.steps.find((s) => s.attempt.kind === 'debug-scene')
  if (!step || step.attempt.kind !== 'debug-scene') return { debugScene: null }
  return {
    debugScene: {
      sceneId: step.attempt.options.sceneId ?? '',
      entered: step.result?.status === 'entered',
    },
  }
}

/**
 * `?debug_script=` の `playScript` を実行してよいか。初期入場が debug 起点（またはエントリ）で入場
 * できた（`entered`）ときだけ実行する。fluid 再マウントのスナップショットを試した場合は、復元した位置の上で
 * スクリプトを再生しない（debug 起点を再実行しない。不整合14）。入場できなかった・置き換えられた場合も実行しない。
 */
export function shouldRunDebugScript(outcome: InitialEntryOutcome): boolean {
  if (outcome.steps.some((s) => s.attempt.kind === 'snapshot')) return false
  return outcome.final.status === 'entered'
}
