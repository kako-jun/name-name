/**
 * world コンテナの描画順 (奥 → 手前)。順序を変えると前面レイヤー (#866) が主人公の手前に
 * 来なくなるため、main.ts はこの並びのまま addChild し、layers.test.ts で順序を固定する。
 */
export const WORLD_LAYER_ORDER = [
  'scroll',
  'background',
  'overlay',
  'player',
  'foreground',
  'marker',
] as const

export type WorldLayer = (typeof WORLD_LAYER_ORDER)[number]

/** 層名から描画順 (小さいほど奥) を返す */
export function layerIndex(layer: WorldLayer): number {
  return WORLD_LAYER_ORDER.indexOf(layer)
}

/** 層名→表示オブジェクトの対応を、描画順に並べ直した配列にする (addChild 用) */
export function orderedLayers<T>(layers: Record<WorldLayer, T>): T[] {
  return WORLD_LAYER_ORDER.map((name) => layers[name])
}
