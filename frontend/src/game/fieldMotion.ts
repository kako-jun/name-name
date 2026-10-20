/**
 * 一枚絵フィールドの「動く背景」(#864) の純粋関数。電車内の揺れと、窓の外の流れる景色に使う。DOM / PixiJS には触れない。
 * どちらも**描画だけ**の値で、足元・歩行マスク判定・移動速度には関与しない。
 */

/** 揺れ。上下に amplitudeY (背景ピクセル) だけ、periodMs で 1 往復する */
export interface ShakeConfig {
  amplitudeY: number
  periodMs: number
}

/** 経過 ms での上下のずれ (px)。0 のとき 0、四分の一周期で +amplitudeY。period が 0 以下・NaN なら 0 */
export function shakeOffset(shake: ShakeConfig, elapsedMs: number): number {
  if (!(shake.periodMs > 0) || !Number.isFinite(elapsedMs)) return 0
  return shake.amplitudeY * Math.sin((2 * Math.PI * elapsedMs) / shake.periodMs)
}

/**
 * 横に敷き詰めた景色の、経過 ms での位置 (px)。speed は 1 秒あたりの流れる量（正で右へ流れる）。
 * tileWidth で巻き戻し、常に 0 以上 tileWidth 未満を返す（負の speed でも）。tileWidth が 0 以下なら 0。
 */
export function scrollOffset(speed: number, elapsedMs: number, tileWidth: number): number {
  if (!(tileWidth > 0) || !Number.isFinite(elapsedMs) || !Number.isFinite(speed)) return 0
  const raw = (speed * elapsedMs) / 1000
  return ((raw % tileWidth) + tileWidth) % tileWidth
}
