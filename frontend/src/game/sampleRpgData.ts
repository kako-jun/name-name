/**
 * RPG プレイヤーのサンプルデータ
 *
 * データ永続化（Issue #34）前でも RPG が動作確認できるよう、
 * 16x12 の小さなマップと NPC 2人を提供する。
 */

import { RPGProject, TileType } from '../types/rpg'

const G = TileType.GRASS
const R = TileType.ROAD
const T = TileType.TREE
const W = TileType.WATER

export const sampleRpgData: RPGProject = {
  name: 'サンプル村',
  version: '1.0.0',
  map: {
    width: 16,
    height: 12,
    tileSize: 32,
    tiles: [
      [T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T],
      [T, G, G, G, G, G, G, G, G, G, G, G, G, G, G, T],
      [T, G, G, R, R, R, R, R, R, R, R, R, G, G, G, T],
      [T, G, G, R, G, G, G, G, G, G, G, R, G, G, G, T],
      [T, G, G, R, G, T, T, G, G, G, G, R, G, G, G, T],
      [T, G, G, R, G, G, G, G, G, W, W, R, G, G, G, T],
      [T, G, G, R, G, G, G, G, G, W, W, R, G, G, G, T],
      [T, G, G, R, R, R, R, R, R, R, R, R, G, G, G, T],
      [T, G, G, G, G, G, G, G, G, G, G, G, G, T, G, T],
      [T, G, G, G, T, G, G, G, G, G, G, G, G, T, G, T],
      [T, G, G, G, G, G, G, G, G, G, G, G, G, G, G, T],
      [T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T],
    ],
  },
  player: {
    x: 5,
    y: 3,
    direction: 'down',
  },
  npcs: [
    {
      id: 'npc-elder',
      name: '長老',
      x: 7,
      y: 3,
      message: 'ようこそ、この村へ。\n矢印キーかWASDで移動できるぞ。',
      color: 0xffcc00,
      sprite: '__demo',
      frames: 2,
      direction: 'left',
    },
    {
      id: 'npc-child',
      name: '子ども',
      x: 5,
      y: 6,
      message: 'ねえねえ、EnterやSpaceで話しかけられるんだよ！',
      color: 0xff66cc,
      sprite: '__demo',
      frames: 2,
      direction: 'up',
    },
  ],
  view: 'topdown',
}
