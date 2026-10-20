/**
 * world コンテナの描画順 (奥 → 手前)。順序を変えると前面レイヤー (#866) が主人公の手前に
 * 来なくなるため、main.ts はこの並びのまま addChild し、layers.test.ts で順序を固定する。
 */
export const WORLD_LAYER_ORDER = [
  'scroll',
  'background',
  'overlay',
  'companion',
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

/** 描画の重なり (zIndex)。同行者は主人公の後ろ・手前で入れ替わるため、層の既定値は主人公の z を挟む */
export const WORLD_Z = {
  scroll: 0,
  background: 1,
  overlay: 2,
  companion: 9,
  player: 10,
  foreground: 20,
  marker: 30,
} as const satisfies Record<WorldLayer, number>

/** 同行者の zIndex: 足元が主人公より下（y が大きい）なら手前 (player+1)、そうでなければ奥 (player-1) */
export function companionZ(companionFeetY: number, playerFeetY: number): number {
  return companionFeetY > playerFeetY ? WORLD_Z.player + 1 : WORLD_Z.player - 1
}
