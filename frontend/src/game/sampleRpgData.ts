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

const tiles: number[][] = [
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
]

/**
 * Issue #49 Phase 1: タイルごとの壁高さ。
 *
 * - 水（WATER, row 5-6, col 9-10）は腰高（0.5）の「池の柵」として体験できるようにする
 * - 内側の小さな木立（row 4, col 5-6）を高い塔（1.5）にして目印にする
 * - 外周の角 4 箇所を 1.5 の塔、上辺の中央付近に 0.5 の低い柵を混ぜる
 * - それ以外の TREE は従来通り 1.0（非 TREE/WATER タイルの値は RaycastRenderer が無視する）
 */
const wallHeights: number[][] = tiles.map((row, y) =>
  row.map((t, x) => {
    if (t === TileType.WATER) return 0.5
    if (t !== TileType.TREE) return 0
    // 外周の四隅を塔
    const isCorner =
      (y === 0 && x === 0) ||
      (y === 0 && x === 15) ||
      (y === 11 && x === 0) ||
      (y === 11 && x === 15)
    if (isCorner) return 1.5
    // 上辺中央付近（col 6, 9）を低い柵
    if (y === 0 && (x === 6 || x === 9)) return 0.5
    // 内側の小さな木立 2 本（row 4, col 5-6）を塔
    if (y === 4 && (x === 5 || x === 6)) return 1.5
    return 1
  })
)

export const sampleRpgData: RPGProject = {
  name: 'サンプル村',
  version: '1.0.0',
  map: {
    width: 16,
    height: 12,
    tileSize: 32,
    tiles,
    wallHeights,
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
