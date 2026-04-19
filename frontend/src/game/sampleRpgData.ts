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
    // GRASS/ROAD は壁判定されない（isWallTile=false）ので wallHeights 値は実際には参照されないが、
    // 保険として 0 を入れておく（万が一参照されても drawHeight=0 で描画スキップ）
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

/**
 * Issue #84: タイルごとの床高さ。
 *
 * プレイヤーが踏み込むとカメラ高さが自動で上昇する。
 * Issue #88 Phase 2-7a で隣接タイル間の段差が垂直面として描画されるようになった。
 *
 * - 上側の横道（ROAD, row 2, col 6-7）に 0.25 の微妙な段差を置き、歩いていると視点がふわっと上がる体感を作る
 * - それ以外のタイルは 0（地面標準）
 *
 * 控えめな配置に留めているのは MVP スコープのため。極端な起伏は別途マップごとに設計する。
 */
const floorHeights: number[][] = tiles.map((row, y) =>
  row.map((t, x) => {
    // 上側の横道の中ほど（row 2, col 6-7）を一段上げる。歩いているとふわっと視点が上がる演出
    if (t === TileType.ROAD && y === 2 && (x === 6 || x === 7)) return 0.25
    // Issue #88 Phase 2-7a: 中央広場の階段（段差壁面が見える配置）
    // プレイヤー初期位置 (5,3)・direction='down'（+y 方向を向く）から前方に進むと階段が視界に入る。
    // col=4 が 0.25 段、col=5 が 0.5 段の 2 段階段。row 5-6 の 2 行分をまたぐ。
    if (t === TileType.GRASS && (y === 5 || y === 6) && x === 4) return 0.25
    if (t === TileType.GRASS && (y === 5 || y === 6) && x === 5) return 0.5
    // 右下の急段差（崖、段差壁が大きく見える）。初期位置から+y へ進み、さらに右 (+x) に逸れると視界に入る
    if (t === TileType.GRASS && (y === 8 || y === 9) && (x === 6 || x === 7)) return 1.0
    // その他は地面標準
    return 0
  })
)

/**
 * Issue #87: タイルごとの天井高さ。
 *
 * 低天井タイル（0.5）でジャンプすると頭をぶつけて跳ね返される体感を作る（MVP: 頭ぶつけ判定のみ、
 * 視覚的な天井レンダリングは別 Issue）。
 *
 * - 縦道の一部（ROAD, row 3, col 11）を低天井（0.5）にして「トンネル」のような挙動を作る
 * - それ以外のタイルは 1.0（標準天井、従来挙動）
 *
 * 控えめな配置に留めているのは MVP スコープのため。
 */
const ceilingHeights: number[][] = tiles.map((row, y) =>
  row.map((t, x) => {
    // 縦道（col 11）の一部に低天井を置く。ジャンプで頭をぶつけて即落下する体感
    if (t === TileType.ROAD && y === 3 && x === 11) return 0.5
    // その他は標準天井
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
    floorHeights,
    ceilingHeights,
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
