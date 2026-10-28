/**
 * 舞台レイヤーの可視性ルール (#982)。
 *
 * 舞台のレイヤー（背景・背景板・大道具・立ち絵・イベント絵 ほか）が「いま見えるべきか」を決める入力は2つ:
 *  - タイトル画面を表示中か（`titleActive`）。シナリオは TitleOverlay の裏で最初の text event まで進行しており、
 *    `titleScreenOverlay` より手前に積まれたレイヤーはタイトルに重なって見えてしまうため隠す。
 *  - イベント絵の背面隠し（`hideBack` = `eventImageLayer.shouldHideBackLayer()`）。
 * この関数が全レイヤーの最終決定を1か所で行う。`showTitleScreen`/`hideTitleScreen`/`applyEventImageVisibility` は
 * 個別の `x.visible = ...` を持たず、どれもここの結果を適用するだけにする（二重管理しない）。
 *
 * レイヤーの新設時はここに1行足す。足し忘れは `NovelRenderer.stageLayerVisibility.test.ts` が
 * stage の addChild 順を走査して検出する。
 */

/** 可視性を決める対象レイヤーのキー。 */
export type StageLayerKey =
  | 'background'
  | 'wall'
  | 'backgroundBoard'
  | 'video'
  | 'floor'
  | 'character'
  | 'lighting'
  | 'prop'
  | 'curtain'
  | 'eventImage'
  | 'stageFront'
  | 'weather'
  | 'bubble'
  | 'telop'

/**
 * タイトル表示中に隠す手段。
 *  - 'visible': `visible` を落とす（レイヤー自身は他に visible を触らない）
 *  - 'renderable': `renderable` を落とす（レイヤー自身が show()/hide() で visible を管理しているため、
 *    その状態を壊さず描画だけ止める。吹き出し・テロップ）
 *  - 'children': レイヤー内のタイトルロゴ以外の子だけ `renderable` を落とす（立ち絵レイヤーはタイトルロゴを
 *    載せるため、レイヤーごと隠せない）
 *  - 'none': タイトル中も隠さない（`titleScreenOverlay` より奥で、不透明背景の下に入るもの）
 */
export type TitleHideMode = 'visible' | 'renderable' | 'children' | 'none'

export interface StageLayerRule {
  /** イベント絵の背面隠し（`back=Hide`）の対象か。 */
  readonly backStack: boolean
  readonly title: TitleHideMode
}

export const STAGE_LAYER_RULES: Readonly<Record<StageLayerKey, StageLayerRule>> = {
  // --- titleScreenOverlay より奥（不透明背景の下）。タイトル中も隠す必要がない ---
  background: { backStack: true, title: 'none' },
  wall: { backStack: true, title: 'none' },
  backgroundBoard: { backStack: true, title: 'none' },
  video: { backStack: true, title: 'none' },
  // 床は overlay より奥だが、タイトル中は舞台の絵を一切見せない方針で隠す (#706 第2弾)
  floor: { backStack: true, title: 'visible' },
  // --- titleScreenOverlay より手前 ---
  character: { backStack: true, title: 'children' },
  lighting: { backStack: true, title: 'visible' },
  prop: { backStack: true, title: 'visible' },
  curtain: { backStack: true, title: 'visible' },
  eventImage: { backStack: false, title: 'visible' },
  stageFront: { backStack: false, title: 'visible' },
  weather: { backStack: false, title: 'visible' },
  bubble: { backStack: false, title: 'renderable' },
  telop: { backStack: false, title: 'renderable' },
}

export interface StageLayerState {
  /** `visible` に書く値（'renderable'/'children' のレイヤーでは、背面隠しだけを反映した値）。 */
  readonly visible: boolean
  /** タイトル表示により描画を止めるか（'renderable'/'children' のレイヤーで使う）。 */
  readonly titleSuppressed: boolean
}

export function computeStageLayerState(
  key: StageLayerKey,
  input: { titleActive: boolean; hideBack: boolean }
): StageLayerState {
  const rule = STAGE_LAYER_RULES[key]
  const backHidden = rule.backStack && input.hideBack
  const titleHides = input.titleActive && rule.title !== 'none'
  return {
    visible: !backHidden && !(titleHides && rule.title === 'visible'),
    titleSuppressed: titleHides && (rule.title === 'renderable' || rule.title === 'children'),
  }
}
