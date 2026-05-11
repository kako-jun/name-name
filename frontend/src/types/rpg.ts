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
  /**
   * タイル座標 [y][x] ごとの壁高さ（1.0 = 標準、0.5 = 腰ほどの柵、2.0 = 二階建て等）。
   * 未指定（undefined）または該当セル未定義時は 1.0 扱い。
   * 壁でないタイル（GRASS/ROAD）の値は無視される。
   *
   * Issue #49 Phase 1 で追加。Phase 2 で Markdown 構文から読み込む予定。
   */
  wallHeights?: number[][]
  /**
   * タイル座標 [y][x] ごとの床高さ（0.0 = 地面標準、0.5 = 半段、1.0 = 1タイル分上、等）。
   * 未指定または該当セル未定義時は 0.0 扱い（従来挙動）。
   * プレイヤーがそのタイルに踏み込むとカメラ高さが自動で上昇する。
   *
   * Issue #84 で追加。
   */
  floorHeights?: number[][]
  /**
   * タイル座標 [y][x] ごとの天井高さ（1.0 = 標準、0.5 = 低天井トンネル、等）。
   * 未指定または該当セル未定義時は 1.0 扱い（従来挙動）。
   * ジャンプ時の頭ぶつけ判定に使う（視覚的なレンダリングは別 Issue）。
   *
   * Issue #87 で追加。
   */
  ceilingHeights?: number[][]
  /**
   * 確率エンカウントの分母 (#172)。`Math.random() < 1/N` で抽選。
   * 未指定 = エンカウントなし、`0` = 街・室内（明示的に発生しない）、`16` = 1/16 確率。
   */
  encounterRate?: number
  /**
   * エンカウント時の敵グループ候補。各要素は単体モンスター ID または `+` 連結
   * （`slime+ghost` で「スライム＋ゴースト同時」）。重み均等で抽選。
   */
  encounterGroups?: string[]
}

/**
 * NPC データ（UI / runtime 側）。
 *
 * `frontend/src/types.ts` の `NpcData`（parser / WASM 経由のスキーマ）と対応するが、
 * UI 側はエディタが 1 文字列として扱うため `message: string`（parser 側は `message: string[]`）。
 * 名前を分けてあるのは、フィールドを追加するときに parser 側 (NpcData) と UI 側 (UiNpcData)
 * の両方を更新する責務を grep / 補完上で見分けやすくするため (#103)。
 *
 * 命名は parser 側を WASM 経由スキーマの `NpcData` 据え置き、UI 側に `Ui` プレフィックスを
 * 付ける方針を採用。候補には `ParsedNpcData` / `NpcEdit` 等もあったが、parser 側は Rust の
 * `models::Npc` に対応する WASM 型でリネーム範囲が広くなるため、UI 側を派生扱いにした。
 *
 * 変換は `frontend/src/game/rpgProjectFromDoc.ts` の `rpgProjectFromDoc` /
 * `applyRpgProjectToDoc` が担う。
 */
export interface UiNpcData {
  id: string // ユニークID
  name: string // NPC名
  x: number // X座標（グリッド）
  y: number // Y座標（グリッド）
  message: string // 会話内容
  color: number // スプライトの色（16進数）
  sprite?: string // スプライトシートへの相対パス。未指定なら color の四角で描画
  frames?: number // 歩行アニメのフレーム数（方向あたり）。未指定なら 2
  direction?: 'up' | 'down' | 'left' | 'right' // アイドル時の向き。未指定なら down
  // 会話ダイアログに表示する顔画像（portrait）への相対パス。Issue #73 Phase 1 で追加。
  // 未指定なら DialogBox に顔枠が表示されず従来どおり名前＋本文のみ。
  portrait?: string
  /**
   * 表情差分マップ（#101 Phase 2）。
   * キーは表情名（例: "normal" / "sad" / "angry"）、値は portrait 画像への相対パス。
   * NPC の message 内に `[expression=sad]` と書くと DialogBox の portrait がこの値に切り替わる。
   * 未指定なら表情切替構文は動作せず `portrait` 固定 1 枚のまま。
   */
  expressions?: Record<string, string>
  /** 「はなす」時に再生するイベント名 (#187)。指定時は message の代わりにこのイベントを再生する。 */
  scene?: string
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
 * RPG イベント（コマンドキュー）の UI 側型 (#197)。
 * parser の RpgEvent / EventCommand と同期する。
 */
export interface UiRpgEvent {
  name: string
  commands: import('../types').EventCommand[]
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
  npcs: UiNpcData[] // NPCリスト
  events?: EventData[] // イベントリスト（オプション）
  /**
   * RPG イベント（コマンドキュー）リスト (#197)。
   * NPC の scene フィールドから参照される。
   */
  rpgEvents?: UiRpgEvent[]
  // プレイ時の表示モード。必須化済み。デフォルトは 'topdown' 相当。
  // （Doc の scene.view=Raycast から派生したときは 'raycast'）
  view: 'topdown' | 'raycast'
  /**
   * Document 全体から集めたマスターデータ (#174 / #172 / #173)。
   * モンスター ID をキーに引いて戦闘で使う。Document の任意のシーンに置かれた
   * `[モンスター ...]` ブロックがすべて集約される。
   */
  monsters?: Record<string, import('../types').MonsterDef>
  /** 同上、アイテム */
  items?: Record<string, import('../types').ItemDef>
  /** 同上、呪文 */
  spells?: Record<string, import('../types').SpellDef>
  /** 同上、パーティメンバー (#175) */
  party?: Record<string, import('../types').PartyMemberDef>
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
