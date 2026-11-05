import { computeDynamicRenderResolution } from '../game/novelLayout'

/** フィールドの描画解像度の実用上限 (#53)。DPR 3 は表示が小さい端末が多く、効果に対してバッファが過大になる */
export const FIELD_MAX_RESOLUTION = 2

/**
 * フィールドの Pixi `resolution`（#53）。`devicePixelRatio` を 1〜`FIELD_MAX_RESOLUTION` に収め、
 * さらに裏バッファの長辺が GPU のテクスチャ上限 (`MAX_RENDER_BACKBUFFER_DIMENSION_PX`) を超えないよう
 * `computeDynamicRenderResolution`（ノベル側と同じ流儀）で頭打ちにする。
 * 不正な DPR（0・負・NaN・Infinity・undefined）は 1。論理サイズが不正なら上限の計算は省く。
 */
export function fieldRenderResolution(
  devicePixelRatio: number | undefined,
  logicalWidth: number,
  logicalHeight: number
): number {
  const dpr =
    typeof devicePixelRatio === 'number' &&
    Number.isFinite(devicePixelRatio) &&
    devicePixelRatio > 0
      ? devicePixelRatio
      : 1
  return computeDynamicRenderResolution(
    logicalWidth,
    logicalWidth,
    logicalHeight,
    Math.min(dpr, FIELD_MAX_RESOLUTION)
  )
}
