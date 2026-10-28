/**
 * ディレクティブ処理の共通型 (#829, #735 8/8)。
 *
 * `NovelRenderer.processDirective` から領域別ハンドラへ分けたときの「ハンドラが触ってよいもの」の最小ポート。
 * ハンドラは `(event, ctx) => void` で、ディスパッチ表のキー（イベント種）に 1 対 1 で結び付く（処理したかは戻り値でなく、表にキーがあるかで決まる）。
 * フロー制御系（Flag / Choice / Jump / Wait / WaitDisplayComplete）は再生状態
 * （カーソル・遷移・タイマー）を同時に触るため、ここには入れずレンダラに残す。
 *
 * `DirectiveContext` のトップレベルメンバーは 10 以内に固定する（`directives.test.ts` が検査）。
 * 追加するときは、まず既存のグループ（layers / env / hooks）に足せないか考え、本当に新しい領域のときだけ
 * トップレベルを増やす。
 */
import type { Event } from '../../types'
import type { AudioManager } from '../AudioManager'
import type { BackgroundBoardLayer } from '../BackgroundBoardLayer'
import type { CharacterLayer } from '../CharacterLayer'
import type { ChoiceOverlay } from '../ChoiceOverlay'
import type { CurtainLayer } from '../CurtainLayer'
import type { DialogBox } from '../DialogBox'
import type { EventImageLayer } from '../EventImageLayer'
import type { LightingLayer } from '../LightingLayer'
import type { PropLayer } from '../PropLayer'
import type { Stage } from '../Stage'
import type { TelopLayer } from '../TelopLayer'
import type { VideoLayer } from '../VideoLayer'
import type { EventImageTransition } from '../../types'

/** ステージ系ハンドラが触る演出レイヤー。必要なメソッドだけを `Pick` で切り出す。 */
export interface DirectiveLayers {
  readonly video: Pick<VideoLayer, 'show' | 'remove'>
  readonly backgroundBoard: Pick<BackgroundBoardLayer, 'add' | 'replace' | 'clear'>
  readonly prop: Pick<PropLayer, 'add' | 'replace' | 'clear'>
  readonly curtain: Pick<CurtainLayer, 'show' | 'raise' | 'clear'>
  readonly lighting: Pick<LightingLayer, 'set' | 'clear'>
  readonly eventImage: Pick<EventImageLayer, 'show' | 'remove'>
  readonly telop: Pick<TelopLayer, 'show'>
  readonly dialogBox: Pick<DialogBox, 'setBorderless' | 'hide'>
  readonly choiceOverlay: Pick<ChoiceOverlay, 'hide'>
}

/** レンダラの現在値の読み取り専用ビュー（getter で毎回最新を返す。ハンドラは書き換えない）。 */
export interface DirectiveEnv {
  readonly skipMode: boolean
  readonly initialized: boolean
  readonly assetBaseUrl: string
  /** 全画面イベント絵モード (#530)。 */
  readonly fullscreenImage: boolean
  readonly eventImageFadeMs: number
  readonly eventImageTransitionDefault: EventImageTransition
  readonly gameDefaultFontFamily: string | null
  readonly gameDefaultFontSize: number | null
  readonly runtimeDefaultFontFamily: string
  readonly runtimeDefaultFontSize: number
  readonly telopAccentColorNum: number
  /** `clearTelopLayer()` のたびに増える世代 (#679)。Telop のフォント待ち中の打ち切り判定に使う。 */
  readonly telopClearEpoch: number
}

/** ハンドラが呼んでよいレンダラ側の操作。いずれも状態を持たない手続き。 */
export interface DirectiveHooks {
  /** イベント絵の `back` に応じた背面レイヤーの可視性を宣言的に再計算する。 */
  applyEventImageVisibility(): void
  /** テロップを消し、`telopClearEpoch` を進める。 */
  clearTelopLayer(): void
  /** 幕の z-order を `characters_in_front` に合わせる (#697)。 */
  setCurtainZOrder(charactersInFront: boolean): void
  /** novel の役割配置 (#286) の xRatio。adv / protagonist 未指定は undefined。 */
  resolveNovelRoleXRatio(character: string | null): number | undefined
  /** 現在 BGM のパス（セーブ/スナップショット用）を記録する。 */
  setCurrentBgmPath(path: string | null): void
}

export interface DirectiveContext {
  readonly stage: Stage
  readonly audio: AudioManager
  readonly characters: CharacterLayer
  readonly layers: DirectiveLayers
  readonly env: DirectiveEnv
  readonly hooks: DirectiveHooks
}

/** 1 種のイベントを処理するハンドラ。`event` はディスパッチ表のキーに対応する種であることが保証される。 */
export type DirectiveHandler = (event: Event, ctx: DirectiveContext) => void

/** イベント種名（`SceneTransition` や `Bgm` など）からハンドラへの表。 */
export type DirectiveTable = Readonly<Record<string, DirectiveHandler>>

/** オブジェクト形のイベントのうち、キー `K` を持つ種だけに絞った型。 */
export type EventOf<K extends string> = Extract<Event, Record<K, unknown>>

/** オブジェクト形のイベントが取りうるキー（`{ Bgm: ... }` の `Bgm` など）の和。 */
export type EventKey =
  Exclude<Event, string> extends infer E ? (E extends unknown ? keyof E & string : never) : never

declare const handlerKey: unique symbol

/** `on<K>` が返す、どのキーのハンドラかを型に残したハンドラ。実行時には `DirectiveHandler` そのもの。 */
export type KeyedHandler<K extends string> = DirectiveHandler & { readonly [handlerKey]?: K }

/** オブジェクトイベント用の表。キー `K` の値は `on<K>` で作ったものに限る（`Shake: on<'Fade'>` は型エラー）。 */
export type ObjectDirectiveTable = { readonly [K in EventKey]?: KeyedHandler<K> }

/**
 * 型付きのハンドラを表の要素にする。`ObjectDirectiveTable` のキーと `K` が一致しないと、表への代入で型エラーになる。
 */
export function on<K extends string>(
  handler: (event: EventOf<K>, ctx: DirectiveContext) => void
): KeyedHandler<K> {
  return handler as unknown as KeyedHandler<K>
}
