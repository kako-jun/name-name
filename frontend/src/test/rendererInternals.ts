import type { Event, EventScene } from '../types'
import type { NovelGameState } from '../game/GameState'
import type { Deferred, SceneEntryResult } from '../game/sceneEntry'
import type { NovelRenderer } from '../game/NovelRenderer'
import type { SceneEntryController } from '../game/SceneEntryController'
import type { SaveController } from '../game/SaveController'
import type { BackgroundController } from '../game/BackgroundController'
import type { SaveManager } from '../game/SaveManager'

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
  saveQuick(origin: 'quick' | 'auto'): boolean
  preloadUpcomingAssets(): void
  scheduleAutoAdvance(): void
  scheduleSkipStep(): void
  isNovelStyle(): boolean
  showToast(msg: string): void
}

/**
 * セーブまわり (#827) のフィールド。狭い型で `saveManager` を宣言し直すテストが多いので基底には置かず、
 * 実物の型で触りたいテストが `internals<SaveInternals>(r)` で取る。
 */
export interface SaveInternals extends RendererInternals {
  saveManager: SaveManager
  autoSavePending: boolean
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
  exposeEntryFields(r)
  exposeSaveMembers(r)
  exposeBackgroundMembers(r)
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

/**
 * シーン入場まわりのフィールド (#826) は `SceneEntryController` へ移った。テストが従来どおり
 * `internals(r).confinedSceneIds` で読み書きできるよう、レンダラ上に `entry` の private フィールド
 * （`_` 付きの実体）へ委譲するアクセサを足す。書き込みは直接代入で、従来の `r.confinedSceneIds = ids` と同じ意味。
 */
const ENTRY_FIELDS = ['confinedSceneIds'] as const

function exposeEntryFields(r: NovelRenderer): void {
  const entryOf = (): Record<string, unknown> =>
    (r as unknown as { entry: Record<string, unknown> }).entry
  for (const name of ENTRY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(r, name)) continue
    // 実体のフィールド名が変わったとき、黙って undefined を読み書きしないよう即座に落とす。
    if (!(`_${name}` in entryOf())) {
      throw new Error(`SceneEntryController に _${name} が無い（rendererInternals の委譲先を直す）`)
    }
    Object.defineProperty(r, name, {
      configurable: true,
      enumerable: true,
      get: () => entryOf()[`_${name}`],
      set: (v: unknown) => {
        entryOf()[`_${name}`] = v
      },
    })
  }
}

/**
 * `NovelRenderer` が持つ `SceneEntryController` (#826)。入場の内部メソッド（`enter` / `startScene` 等）を
 * `vi.spyOn` で差し替えるテスト用。旧実装ではレンダラ自身の private メソッドだった。
 */
export function entryControllerOf(r: NovelRenderer): EntryControllerForTest {
  return (r as unknown as { entry: EntryControllerForTest }).entry
}

/** `entryControllerOf` の戻り値。公開メソッドに、spy で差し替える private の `startScene` を足した型。 */
export type EntryControllerForTest = Pick<
  SceneEntryController,
  'enter' | 'run' | 'jumpTo' | 'startFrom'
> & { startScene(...args: unknown[]): void }

/**
 * セーブまわり (#827) は `SaveController` へ移った。テストが従来どおり `internals(r).saveManager` /
 * `.autoSavePending` / `.openSaveMenu()` / `.saveQuick()` で触れるよう、レンダラ上に `save` の
 * メンバーへ委譲するアクセサ・メソッドを足す。移管後のアクセス経路はこの1か所に集約する。
 * 注意: `vi.spyOn(internals(r), 'saveQuick')` はレンダラ上の委譲だけを差し替え、コントローラ内部の呼び出し
 * （`flushAutoSave` → `saveQuick`）は差し替わらない。内部呼び出しを差し替えるときは `saveControllerOf(r)` を使う。
 */
const SAVE_FIELDS = ['saveManager', 'autoSavePending'] as const
const SAVE_METHODS = ['saveQuick', 'openSaveMenu', 'openLoadMenu'] as const

function exposeSaveMembers(r: NovelRenderer): void {
  const saveOf = (): Record<string, unknown> =>
    (r as unknown as { save: Record<string, unknown> }).save
  for (const name of SAVE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(r, name)) continue
    // 実体のフィールド名が変わったとき、黙って undefined を読み書きしないよう即座に落とす。
    if (!(name in saveOf())) {
      throw new Error(`SaveController に ${name} が無い（rendererInternals の委譲先を直す）`)
    }
    Object.defineProperty(r, name, {
      configurable: true,
      enumerable: true,
      get: () => saveOf()[name],
      set: (v: unknown) => {
        saveOf()[name] = v
      },
    })
  }
  for (const name of SAVE_METHODS) {
    if (Object.prototype.hasOwnProperty.call(r, name)) continue
    if (typeof saveOf()[name] !== 'function') {
      throw new Error(`SaveController に ${name}() が無い（rendererInternals の委譲先を直す）`)
    }
    Object.defineProperty(r, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (...args: unknown[]) => (saveOf()[name] as (...a: unknown[]) => unknown)(...args),
    })
  }
}

/**
 * `NovelRenderer` が持つ `SaveController` (#827)。内部メソッド（`saveQuick`）を `vi.spyOn` で差し替える
 * テスト用。旧実装ではレンダラ自身の private メソッドだった。
 */
export function saveControllerOf(r: NovelRenderer): SaveControllerForTest {
  return (r as unknown as { save: SaveControllerForTest }).save
}

/** `saveControllerOf` の戻り値。公開メソッドに、spy で差し替える private の `saveQuick` を足した型。 */
export type SaveControllerForTest = SaveController & {
  saveQuick(origin: 'quick' | 'auto'): boolean
}

/**
 * 背景まわり (#828 7a) は `BackgroundController` へ移った。テストが従来どおり
 * `internals(r).bgEntries` / `.setBackground()` 等で読み書きできるよう、レンダラ上に `background` の
 * メンバーへ委譲するアクセサ・メソッドを足す。移管後のアクセス経路はこの1か所に集約する。
 * 注意: メソッドの委譲は呼び出しのたびにコントローラを引くので、`vi.spyOn(backgroundControllerOf(r), ...)` は効く。
 * 一方 `vi.spyOn(internals(r), 'xxx')` はレンダラ上の委譲だけを差し替え、コントローラ内部の呼び出しは
 * 差し替わらない。内部呼び出し（`setBackground` → `showLoadedBackground` 等）を差し替えるときは
 * `backgroundControllerOf(r)` を使う。
 * 旧名との対応: `bgGraphics` → `graphics`、`bgContainer` → `container`（それ以外はコントローラ内でも同名）。
 */
const BACKGROUND_FIELDS: Record<string, string> = {
  bgEntries: 'bgEntries',
  bgMaskSprite: 'bgMaskSprite',
  bgCrossfadeTimer: 'bgCrossfadeTimer',
  bgLoadToken: 'bgLoadToken',
  pendingBackgroundLoadToken: 'pendingBackgroundLoadToken',
  pendingBackgroundLoad: 'pendingBackgroundLoad',
  textureCache: 'textureCache',
  currentBackgroundPath: 'currentBackgroundPath',
  currentBackgroundColor: 'currentBackgroundColor',
  currentBackgroundFade: 'currentBackgroundFade',
  currentBackgroundBrightness: 'currentBackgroundBrightness',
  defaultBackgroundColor: 'defaultBackgroundColor',
  bgGraphics: 'graphics',
  bgContainer: 'container',
}
const BACKGROUND_METHODS = [
  'setBackground',
  'showLoadedBackground',
  'clearBackground',
  'setBackgroundColor',
  'clearBackgroundColor',
  'defaultBackgroundColorNum',
  'updateBackgroundFadeFrame',
  'fadeOutBackgroundEntries',
  'finishBackgroundCrossfadeInstant',
  'hasActiveBackgroundFade',
  'hasPendingBackgroundLoad',
  'applyBrightnessTint',
] as const

function exposeBackgroundMembers(r: NovelRenderer): void {
  const bgOf = (): Record<string, unknown> =>
    (r as unknown as { background: Record<string, unknown> }).background
  for (const [name, target] of Object.entries(BACKGROUND_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(r, name)) continue
    // 実体のフィールド名が変わったとき、黙って undefined を読み書きしないよう即座に落とす。
    if (!(target in bgOf())) {
      throw new Error(
        `BackgroundController に ${target} が無い（rendererInternals の委譲先を直す）`
      )
    }
    Object.defineProperty(r, name, {
      configurable: true,
      enumerable: true,
      get: () => bgOf()[target],
      set: (v: unknown) => {
        bgOf()[target] = v
      },
    })
  }
  for (const name of BACKGROUND_METHODS) {
    if (Object.prototype.hasOwnProperty.call(r, name)) continue
    if (typeof bgOf()[name] !== 'function') {
      throw new Error(
        `BackgroundController に ${name}() が無い（rendererInternals の委譲先を直す）`
      )
    }
    Object.defineProperty(r, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (...args: unknown[]) =>
        (bgOf()[name] as (...a: unknown[]) => unknown).apply(bgOf(), args),
    })
  }
}

/**
 * `NovelRenderer` が持つ `BackgroundController` (#828 7a)。内部メソッド（`showLoadedBackground` 等）を
 * `vi.spyOn` で差し替えるテスト用。旧実装ではレンダラ自身の private メソッドだった。
 */
export function backgroundControllerOf(r: NovelRenderer): BackgroundControllerForTest {
  return (r as unknown as { background: BackgroundControllerForTest }).background
}

/** `backgroundControllerOf` の戻り値。公開メソッドに、spy で差し替える private の `showLoadedBackground` を足した型。 */
export type BackgroundControllerForTest = BackgroundController & {
  showLoadedBackground(...args: unknown[]): void
}
