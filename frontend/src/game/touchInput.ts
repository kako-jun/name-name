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

interface ActivePointer {
  startX: number
  startY: number
  startTime: number
}

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
    // 画面スクロール抑止（タッチデバイスでスワイプが scroll に化けるのを防ぐ）
    if (e.pointerType === 'touch') e.preventDefault()
  }

  const onUp = (e: PointerEvent): void => {
    if (!active) return
    const start = active
    active = null

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
  const previousTouchAction = element.style.touchAction
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
    element.style.touchAction = previousTouchAction
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
