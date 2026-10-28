/**
 * シアターモードで立ち絵（板）が横へ移動している間の、板的な揺らぎ (#701) の純粋計算。
 *
 * 上手/下手の入退場 (#684) の歩行中だけ、板が足元を支点にゆらゆら傾く（`sprite.skew.x`）。
 * 静止中は揺れない。揺れの大きさは移動区間の始点・終点で 0 になる釣り鐘型の包絡（sin(πt)）に
 * 周期振動（sin(2π·elapsed/period)）を掛けたもので、移動の開始・終了で連続に 0 へ収束する
 * （最終ポーズに傾きが残らない）。
 *
 * ここは経過時間だけを入力にする純粋関数（`Math.random` も時計も使わない。ADR 0002）。
 * 時計は移動 tween と同じ `CharacterLayer` の `elapsedMs`（pixi Ticker の `deltaMS` 累計）で、
 * 揺れの値は NovelGameState（セーブ・スナップショット）に持たない。
 * 描画（`sprite.skew.x`）への配線は `CharacterLayer` 側。
 */

/** 傾き（skew.x）の最大振幅（ラジアン）。約 3.4°。紙の板がわずかに首を振る程度。 */
export const BOARD_SWAY_MAX_SKEW_RAD = 0.06

/** 揺れの 1 周期（ms）。歩行 1400ms の間に約 3.7 往復。 */
export const BOARD_SWAY_PERIOD_MS = 380

/** 揺らぎを有効にする条件。 */
export interface BoardSwayConditions {
  /** `[カメラ: シアター]` か。ノベルは常に揺らさない（後方互換）。 */
  isTheater: boolean
  /** 動画書き出し中か (#350)。書き出し（実時間駆動）では揺らさない。 */
  exporting: boolean
  /** OS の `prefers-reduced-motion: reduce` か。 */
  reducedMotion: boolean
}

/** 揺らぎを有効にしてよいか。シアターのみ、書き出し中・動きを減らす設定では無効。 */
export function isBoardSwayEnabled(c: BoardSwayConditions): boolean {
  return c.isTheater && !c.exporting && !c.reducedMotion
}

/**
 * 移動開始からの経過時間 `elapsedMs`（総移動時間 `durationMs`）での板の傾き（skew.x, ラジアン）。
 * 区間外（elapsed<=0 / >=duration）・不正入力は 0。常に ±BOARD_SWAY_MAX_SKEW_RAD の範囲。
 */
export function computeBoardSway(elapsedMs: number, durationMs: number): number {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0
  if (elapsedMs <= 0 || elapsedMs >= durationMs) return 0
  const envelope = Math.sin(Math.PI * (elapsedMs / durationMs))
  const wave = Math.sin((2 * Math.PI * elapsedMs) / BOARD_SWAY_PERIOD_MS)
  return BOARD_SWAY_MAX_SKEW_RAD * envelope * wave
}
