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
  exposeSceneIndexFields(r)
  return r as unknown as T
}

/**
 * シーン索引まわりのフィールド (#823) は `SceneIndex` へ移った。テストが従来どおり
 * `internals(r).allScenes` 等で読み書きできるよう、レンダラ上に `sceneIndex` の private フィールドへ
 * 委譲するアクセサを足す。移管後のアクセス経路はこの1か所に集約する。
 */
const SCENE_INDEX_FIELDS = ['allScenes', 'entryRawEvents', 'pendingMissingScenes'] as const

function exposeSceneIndexFields(r: NovelRenderer): void {
  const index = (r as unknown as { sceneIndex: Record<string, unknown> }).sceneIndex
  for (const name of SCENE_INDEX_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(r, name)) continue
    Object.defineProperty(r, name, {
      configurable: true,
      get: () => index[name],
      set: (v) => {
        index[name] = v
      },
    })
  }
}
