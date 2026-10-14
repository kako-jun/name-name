import type { Event, EventScene } from '../types'
import type { NovelGameState } from '../game/GameState'
import type { Deferred, SceneEntryResult } from '../game/sceneEntry'
import type { NovelRenderer } from '../game/NovelRenderer'

/**
 * テスト用: `NovelRenderer` の private フィールド・メソッドを読み書きするための型付きアクセサ (#735 1/8, #822)。
 *
 * 各 `NovelRenderer.*.test.ts` が個別に持っていた `function internals(r)`（`as unknown as {...}`）を
 * ここに集約する。private の置き場や名前が変わる分割 PR（#735）では、この1か所を直せばよい。
 *
 * - ここには複数のテストが共通して触る素朴な型のフィールド・メソッドだけを置く。
 * - モックに差し替える `dialogBox` / `characterLayer` / `app` のように、テストごとに必要な形が違うものは
 *   各テストが `interface Local extends RendererInternals { ... }` で足し、`internals<Local>(r)` で取る。
 *   型が一致しない（`unknown` など）もの、1ファイルでしか触らないものも同様に各テスト側に残す。
 * - 確定済みの confinement を仕込む `confineForTest` は `./confinement.ts`。
 */
export interface RendererInternals {
  // ライフサイクル
  initialized: boolean
  appInitialized: boolean
  // 再生カーソル
  rawEvents: Event[]
  entryRawEvents: Event[]
  resolvedEvents: Event[]
  eventIndex: number
  textIndex: number
  sentenceIndex: number
  history: NovelGameState[]
  currentSceneId: string | null
  displayEventCount: number
  playbackStarted: boolean
  allScenes: EventScene[]
  pendingMissingScenes: Map<string, Promise<EventScene[] | null>>
  confinedSceneIds: string[] | null
  readSceneProgress: Set<string>
  // 遷移ゲート
  waitingForChoice: boolean
  waitingForWait: boolean
  justSelectedChoice: boolean
  jumpState: 'idle' | 'pending' | 'stalled'
  pendingEntry: { promise: Promise<SceneEntryResult>; sceneId: string | null } | null
  jumpDeferred: Deferred<SceneEntryResult> | null
  consecutiveJumps: number
  storyEnded: boolean
  skipMode: boolean
  autoMode: boolean
  // タイマー
  waitTimer: number | null
  intermissionTimer: number | null
  waitDisplayCompleteTimer: number | null
  // 演出状態
  currentBgmPath: string | null
  currentBackgroundPath: string | null
  // メソッド
  render(): void
  advance(): void
  applyState(state: NovelGameState): void
  processDirective(event: Event): void
  openSaveMenu(): void
  openLoadMenu(): void
  preloadUpcomingAssets(): void
  scheduleAutoAdvance(): void
  scheduleSkipStep(): void
  isNovelStyle(): boolean
  showToast(msg: string): void
}

/**
 * `NovelRenderer` を private 込みの型で見る。型引数で、そのテストが追加で触る形を足せる。
 */
export function internals<T extends RendererInternals = RendererInternals>(r: NovelRenderer): T {
  return internalsOf<T>(r)
}

/**
 * `internals` と同じだが、型引数に `RendererInternals` の制約を課さない。テスト専用の簡易な型
 * （`{ eventIndex: number }` など）で必要なフィールドだけを触るときに使う。
 */
export function internalsOf<T>(r: NovelRenderer): T {
  exposeSceneIndexFields(r)
  exposeCursorFields(r)
  exposeTransitionFields(r)
  return r as unknown as T
}

/**
 * シーン索引まわりのフィールド (#823) は `SceneIndex` へ移った。テストが従来どおり
 * `internals(r).allScenes` 等で読み書きできるよう、レンダラ上に `sceneIndex` の private フィールドへ
 * 委譲するアクセサを足す。移管後のアクセス経路はこの1か所に集約する。
 */
const SCENE_INDEX_FIELDS = ['allScenes', 'entryRawEvents', 'pendingMissingScenes'] as const

function exposeSceneIndexFields(r: NovelRenderer): void {
  const indexOf = (): Record<string, unknown> =>
    (r as unknown as { sceneIndex: Record<string, unknown> }).sceneIndex
  for (const name of SCENE_INDEX_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(r, name)) continue
    Object.defineProperty(r, name, {
      configurable: true,
      enumerable: true,
      get: () => indexOf()[name],
      set: (v: unknown) => {
        indexOf()[name] = v
      },
    })
  }
}

/**
 * 再生カーソルまわりのフィールド (#824) は `PlaybackCursor` へ移った。テストが従来どおり
 * `internals(r).eventIndex` 等で読み書きできるよう、レンダラ上に `cursor` の private フィールド
 * （`_` 付きの実体）へ委譲するアクセサを足す。書き込みはメソッドを経由しない直接代入（派生値の
 * 同期や無効化は行わない）で、従来の `r.eventIndex = n` と同じ意味。移管後のアクセス経路はこの1か所に集約する。
 */
const CURSOR_FIELDS = [
  'rawEvents',
  'resolvedEvents',
  'eventIndex',
  'textIndex',
  'sentenceIndex',
  'displayEventCount',
  'novelPagesCache',
  'advSentencePagesCache',
  'history',
  'currentSceneId',
  'playbackStarted',
] as const

function exposeCursorFields(r: NovelRenderer): void {
  const cursorOf = (): Record<string, unknown> =>
    (r as unknown as { cursor: Record<string, unknown> }).cursor
  for (const name of CURSOR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(r, name)) continue
    // 実体のフィールド名が変わったとき、黙って undefined を読み書きしないよう即座に落とす。
    if (!(`_${name}` in cursorOf())) {
      throw new Error(`PlaybackCursor に _${name} が無い（rendererInternals の委譲先を直す）`)
    }
    Object.defineProperty(r, name, {
      configurable: true,
      enumerable: true,
      get: () => cursorOf()[`_${name}`],
      set: (v: unknown) => {
        cursorOf()[`_${name}`] = v
      },
    })
  }
}

/**
 * 遷移ゲートと Jump 予約まわりのフィールド (#825) は `TransitionState` へ移った。テストが従来どおり
 * `internals(r).jumpState` 等で読み書きできるよう、レンダラ上に `transition` の private フィールド
 * （`_` 付きの実体）へ委譲するアクセサを足す。書き込みはメソッドを経由しない直接代入（タイマーや
 * deferred の整合は取らない）で、従来の `r.jumpState = 'pending'` と同じ意味。
 */
const TRANSITION_FIELDS = [
  'waitingForChoice',
  'waitingForWait',
  'justSelectedChoice',
  'suppressNextAdvance',
  'jumpState',
  'jumpTimer',
  'jumpDeferred',
  'consecutiveJumps',
  'pendingEntry',
  'transitionGeneration',
] as const

function exposeTransitionFields(r: NovelRenderer): void {
  const stateOf = (): Record<string, unknown> =>
    (r as unknown as { transition: Record<string, unknown> }).transition
  for (const name of TRANSITION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(r, name)) continue
    // 実体のフィールド名が変わったとき、黙って undefined を読み書きしないよう即座に落とす。
    if (!(`_${name}` in stateOf())) {
      throw new Error(`TransitionState に _${name} が無い（rendererInternals の委譲先を直す）`)
    }
    Object.defineProperty(r, name, {
      configurable: true,
      enumerable: true,
      get: () => stateOf()[`_${name}`],
      set: (v: unknown) => {
        stateOf()[`_${name}`] = v
      },
    })
  }
}
