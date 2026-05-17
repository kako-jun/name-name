/**
 * RPG レンダラー向けのタッチ入力ジェスチャ検出。
 *
 * pointer 系イベントを 1 か所で受け、以下の 2 種類に振り分ける:
 *
 * - **swipe**: pointerdown 〜 pointerup の移動量が `swipeMinDistance` 以上のとき、
 *   X 方向と Y 方向の絶対値が大きい方を主軸として up/down/left/right に分類する。
 * - **tap**: 移動量が `tapMaxDistance` 以下、かつ滞在時間が `tapMaxDuration` 以下。
 *
 * オンスクリーンの仮想パッドは Issue #178 で否定されているため、ここでは UI を一切
 * 描画しない。ジェスチャ判定だけを行い、結果はコールバックでレンダラー側に流す。
 *
 * マウスでも動くため、PC ブラウザでもクリック = タップ、ドラッグ = スワイプとして扱える。
 */

export type SwipeDirection = 'up' | 'down' | 'left' | 'right'

export interface TouchInputHandlers {
  onSwipe?: (direction: SwipeDirection) => void
  onTap?: (clientX: number, clientY: number) => void
}

export interface TouchInputOptions extends TouchInputHandlers {
  /** swipe と判定する最小移動量（px、デフォルト 30） */
  swipeMinDistance?: number
  /** tap と判定する最大移動量（px、デフォルト 12） */
  tapMaxDistance?: number
  /** tap と判定する最大滞在時間（ms、デフォルト 350） */
  tapMaxDuration?: number
}

const DEFAULT_SWIPE_MIN = 30
const DEFAULT_TAP_MAX_DIST = 12
const DEFAULT_TAP_MAX_DUR = 350
/**
 * Pixi オーバーレイ（メニュー項目など）を押した直後の pointerup は、canvas 全体向けの
 * 汎用 tap 判定から除外したい。さもないと「メニュー項目を押したつもり」が同時に
 * 「画面タップ」としても扱われ、show/hide や dialog close が二重発火する。
 *
 * 期限つきの単純な suppression に倒し、同一ジェスチャ中の pointerup だけ弾く。
 */
let suppressTapUntilMs = 0

interface ActivePointer {
  startX: number
  startY: number
  startTime: number
}

/** 次回の tap 判定を短時間だけ抑止する。Pixi の UI 項目 pointerdown から呼ぶ。 */
export function suppressNextTouchTap(durationMs = 250): void {
  suppressTapUntilMs = Math.max(suppressTapUntilMs, performance.now() + durationMs)
}

/**
 * ダイアログを開いた直後の handleTap close 系操作を弾くガード幅 (ms)。
 * - `DialogBox.isJustShown(guardMs)` 経由で時刻ベースの二次保険として使う
 * - `handleMenuSelect` 入口で `suppressNextTouchTap(guardMs)` の duration としても使う（一次防御）
 *
 * `suppressNextTouchTap` のデフォルト 250ms と `attachTouchInput` の `tapMaxDuration`
 * 350ms を覆えるように 400ms 取る。手動で suppressNextTouchTap が漏れても余裕を持って弾く。
 */
export const DIALOG_JUST_SHOWN_GUARD_MS = 400

/**
 * 指定 element に pointer 系のリスナーを取り付け、tap / swipe を検出する。
 *
 * @returns 取り外し用関数。
 */
export function attachTouchInput(element: HTMLElement, options: TouchInputOptions): () => void {
  const swipeMin = options.swipeMinDistance ?? DEFAULT_SWIPE_MIN
  const tapMaxDist = options.tapMaxDistance ?? DEFAULT_TAP_MAX_DIST
  const tapMaxDur = options.tapMaxDuration ?? DEFAULT_TAP_MAX_DUR

  // 1 本指 / 1 ボタンのみ追跡。複数同時タップはサポートしない（DQ 風 1 入力で十分）。
  let active: ActivePointer | null = null

  const onDown = (e: PointerEvent): void => {
    // primary pointer のみ拾う（マルチタッチ・ペン副ボタン等を弾く）
    if (!e.isPrimary) return
    active = {
      startX: e.clientX,
      startY: e.clientY,
      startTime: performance.now(),
    }
    // 画面スクロール抑止は下記 touch-action: none 側で完結させる。
    // pointerdown は passive listener で登録される処理系があり preventDefault が
    // 警告を出すケースがあるため、ここでは preventDefault を呼ばない。
  }

  const onUp = (e: PointerEvent): void => {
    if (!active) return
    const start = active
    active = null

    if (performance.now() <= suppressTapUntilMs) {
      return
    }

    const dx = e.clientX - start.startX
    const dy = e.clientY - start.startY
    const dist = Math.hypot(dx, dy)
    const duration = performance.now() - start.startTime

    if (dist <= tapMaxDist && duration <= tapMaxDur) {
      options.onTap?.(e.clientX, e.clientY)
      return
    }

    if (dist >= swipeMin) {
      const dir = classifySwipe(dx, dy)
      options.onSwipe?.(dir)
    }
    // それ以外（中途半端なドラッグ）は無視
  }

  const onCancel = (): void => {
    active = null
  }

  // touch-action: none を element に強制し、ブラウザのデフォルトジェスチャを抑制する。
  // 親側の CSS と二重指定になっても害はない。
  //
  // React StrictMode では init/destroy が二重発火するため、素直に previousTouchAction を
  // 保存すると 1 回目の attach で 'none' を保存して 2 回目の detach で 'none' に戻してしまう。
  // dataset に「自分が書き換える前の値」を一度だけ記録し、最後に detach されたとき復元する。
  const TOUCH_ACTION_KEY = 'nameNamePrevTouchAction'
  if (!(TOUCH_ACTION_KEY in element.dataset)) {
    element.dataset[TOUCH_ACTION_KEY] = element.style.touchAction
  }
  element.style.touchAction = 'none'

  element.addEventListener('pointerdown', onDown)
  element.addEventListener('pointerup', onUp)
  element.addEventListener('pointercancel', onCancel)
  element.addEventListener('pointerleave', onCancel)

  return () => {
    element.removeEventListener('pointerdown', onDown)
    element.removeEventListener('pointerup', onUp)
    element.removeEventListener('pointercancel', onCancel)
    element.removeEventListener('pointerleave', onCancel)
    const prev = element.dataset[TOUCH_ACTION_KEY]
    if (prev !== undefined) {
      element.style.touchAction = prev
      delete element.dataset[TOUCH_ACTION_KEY]
    }
  }
}

/**
 * 移動ベクトル (dx, dy) からスワイプ方向を決定する。
 * - 水平の絶対値が垂直以上 → left/right
 * - それ以外 → up/down
 *
 * Y 軸はスクリーン座標（下向き正）なので、up = dy が負方向。
 */
export function classifySwipe(dx: number, dy: number): SwipeDirection {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left'
  }
  return dy >= 0 ? 'down' : 'up'
}
