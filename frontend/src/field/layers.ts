import type { Container } from 'pixi.js'

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
  'emotion',
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
  emotion: 25,
  marker: 30,
} as const satisfies Record<WorldLayer, number>

/**
 * 足元 y で決まる「主人公・同行者・NPC」共通の zIndex（#841）。主人公は WORLD_Z.player 固定。
 * それ以外は足元が主人公より下（y が大きい）なら手前 (player+0.5〜+0.9)、同じか上なら奥 (player-0.5〜-0.1)。
 * 同じ側の中では足元 y が大きいほど手前（シーンの高さに対する比で 0.4 の幅）。
 * 範囲は 9.5〜10.9 に収まり、前面レイヤー (20) より常に奥・背景/オーバーレイ (1〜2) より常に手前
 */
export function feetDepthZ(feetY: number, playerFeetY: number, sceneHeight: number): number {
  const t = sceneHeight > 0 ? Math.min(1, Math.max(0, feetY / sceneHeight)) : 0
  const base = feetY > playerFeetY ? WORLD_Z.player + 0.5 : WORLD_Z.player - 0.5
  return base + t * 0.4
}

/** 同行者の zIndex（足元 y の式。NPC と共通） */
export const companionZ = feetDepthZ

/** NPC の zIndex（足元 y の式。同行者と共通） */
export const npcZ = feetDepthZ

/**
 * 感情吹き出しの層を置く先 (#840)。通常は world 内（`WORLD_Z.emotion`）。
 * FF 風の会話窓は stage 直下で world の手前に出るため、窓を出している会話中だけ吹き出しを窓より前（stage の最前面）へ出す。
 * 非 ff の窓・会話していないときは world のまま（描画順は変えない）。
 */
export function emotionLayerHost(ffWindow: boolean, talking: boolean): 'world' | 'stage' {
  return ffWindow && talking ? 'stage' : 'world'
}

/**
 * 感情吹き出しの層を `emotionLayerHost` の置き先へ付け替え、stage 側の揺れ（y）を world に合わせる (#840)。
 * main.ts が毎フレーム呼ぶ。置き先（'world' | 'stage'）を返すので、検証用の `state()` はこれを出して配線を固定する。
 */
export function syncEmotionLayerHost(args: {
  ffWindow: boolean
  talking: boolean
  layer: Container
  world: Container
  top: Container
}): 'world' | 'stage' {
  const host = emotionLayerHost(args.ffWindow, args.talking)
  const target = host === 'stage' ? args.top : args.world
  if (args.layer.parent !== target) target.addChild(args.layer)
  args.top.y = args.world.y
  return host
}

/** 感情吹き出しの層がいま stage（窓の手前）にあるか world にあるか（検証用の読み取り） */
export function emotionHostOf(layer: Container, top: Container): 'world' | 'stage' {
  return layer.parent === top ? 'stage' : 'world'
}
