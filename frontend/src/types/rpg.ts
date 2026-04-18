// RPGプロジェクトのデータ型定義

/**
 * タイルの種類
 */
export enum TileType {
  GRASS = 0, // 草地（通行可能）
  ROAD = 1, // 道（通行可能）
  TREE = 2, // 木（通行不可）
  WATER = 3, // 水（通行不可）
}

/**
 * マップデータ
 */
export interface MapData {
  width: number // マップの幅（グリッド数）
  height: number // マップの高さ（グリッド数）
  tileSize: number // 1タイルのピクセルサイズ
  tiles: number[][] // タイルデータ（2次元配列）
}

/**
 * NPCデータ
 */
export interface NPCData {
  id: string // ユニークID
  name: string // NPC名
  x: number // X座標（グリッド）
  y: number // Y座標（グリッド）
  message: string // 会話内容
  color: number // スプライトの色（16進数）
}

/**
 * プレイヤー初期データ
 */
export interface PlayerData {
  x: number // 初期X座標（グリッド）
  y: number // 初期Y座標（グリッド）
  direction: 'up' | 'down' | 'left' | 'right' // 初期の向き
}

/**
 * イベントデータ（将来的な拡張用）
 */
export interface EventData {
  id: string // ユニークID
  name: string // イベント名
  triggerType: 'talk' | 'step' | 'auto' // トリガータイプ
  x?: number // トリガー位置X（stepの場合）
  y?: number // トリガー位置Y（stepの場合）
  condition?: string // 発動条件（式）
  actions: EventAction[] // アクションリスト
}

/**
 * イベントアクション
 */
export interface EventAction {
  type: 'message' | 'teleport' | 'flag' // アクションタイプ
  params: Record<string, unknown> // パラメータ
}

/**
 * RPGプロジェクトデータ
 */
export interface RPGProject {
  name: string // プロジェクト名
  version: string // データバージョン
  map: MapData // マップデータ
  player: PlayerData // プレイヤー初期データ
  npcs: NPCData[] // NPCリスト
  events?: EventData[] // イベントリスト（オプション）
  // プレイ時の表示モード。必須化済み。デフォルトは 'topdown' 相当。
  // （Doc の scene.view=Raycast から派生したときは 'raycast'）
  view: 'topdown' | 'raycast'
}

/**
 * タイルの CSS 色定数（MapEditor・NPCEditor・RPGScene で共有）
 */
export const TILE_COLORS = {
  [TileType.GRASS]: '#2d5016',
  [TileType.ROAD]: '#8b7355',
  [TileType.TREE]: '#1a3a1a',
  [TileType.WATER]: '#4169e1',
} as const

/**
 * タイルの PixiJS 用数値色定数（TopDownRenderer で使用）
 */
export const TILE_COLORS_HEX = {
  [TileType.GRASS]: 0x2d5016,
  [TileType.ROAD]: 0x8b7355,
  [TileType.TREE]: 0x1a3a1a,
  [TileType.WATER]: 0x4169e1,
} as const
