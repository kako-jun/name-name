export interface Viewport {
  x: number // パン位置 X
  y: number // パン位置 Y
  zoom: number // ズームレベル (0.1 ~ 5.0)
}

export type Mode = 'edit' | 'play'

// --- name-name Event model (synced with parser/src/models.rs) ---

export type BgmAction = 'Play' | 'Stop'
export type BlackoutAction = 'On' | 'Off'

export interface ChoiceOption {
  text: string
  jump: string
}

export type FlagValue = { Bool: boolean } | { String: string } | { Number: number }

export type Direction = 'Up' | 'Down' | 'Left' | 'Right'

export interface RpgMapData {
  width: number
  height: number
  tile_size: number
  tiles: number[][]
  /** タイル座標 [y][x] ごとの壁高さ。未指定なら null（Issue #90） */
  wall_heights?: number[][] | null
  /** タイル座標 [y][x] ごとの床高さ。未指定なら null（Issue #90） */
  floor_heights?: number[][] | null
  /** タイル座標 [y][x] ごとの天井高さ。未指定なら null（Issue #90） */
  ceiling_heights?: number[][] | null
  /** 確率エンカウントの分母（DQ4 式、`Math.random() < 1/N`）。0 = 街・室内 (#172) */
  encounter_rate?: number | null
  /** エンカウント抽選の敵グループ候補。各要素は monster_id か `+` 連結 (#172) */
  encounter_groups?: string[] | null
}

/**
 * NPC データ（parser / WASM 経由のスキーマ）。
 *
 * UI / runtime 側は `frontend/src/types/rpg.ts` の `UiNpcData` に変換される。
 * 主な差分は `message` の表現（parser は行配列、UI は 1 文字列）と portrait など。
 * フィールドを追加するときは parser 側 (`NpcData`) と UI 側 (`UiNpcData`) と
 * 変換層 (`rpgProjectFromDoc` / `applyRpgProjectToDoc`) の 3 箇所を必ず揃える (#103)。
 */
export interface NpcData {
  id: string
  name: string
  x: number
  y: number
  color: number
  message: string[]
  /** スプライトシートへの相対パス。未指定なら色付き四角で描画される */
  sprite?: string
  /** 歩行アニメのフレーム数（方向あたり）。未指定ならレンダラーのデフォルト（2） */
  frames?: number
  /** NPC が向いている方向。未指定ならレンダラーのデフォルト（Down） */
  direction?: Direction
  /**
   * 会話ダイアログに表示する顔画像（portrait）への相対パス。
   * Issue #73 Phase 1 で追加。未指定なら RpgDialogBox に顔枠は出ず従来どおりの表示。
   * 動的表情切替は Phase 2 (#101) で別途対応。
   */
  portrait?: string
}

/** モンスター定義 (#174)。`[モンスター <id>] ... [/モンスター]` ブロックでパースされる */
export interface MonsterDef {
  id: string
  name: string
  /** 体力。未指定時のデフォルトは 1（即死扱いを避けるための最低値、#174 設計判断） */
  hp: number
  /** マナ。`#[serde(default)]` 由来で optional（未指定 = 0 扱い、parser/pkg の d.ts と整合） */
  mp?: number
  atk: number
  def: number
  agi: number
  exp: number
  gold: number
  sprite?: string
  /** 専用関数 ID。指定時はランタイム実装に委譲（汎用 + 専用 builtin の二層設計、#176） */
  builtin?: string
}

/** アイテム定義 (#174) */
export interface ItemDef {
  id: string
  name: string
  /** 種別（"回復" / "攻撃" / "武器" / "盾" / "鎧" / "兜" / "鍵" / "その他" 等） */
  kind: string
  price?: number
  /** 宣言的効果 DSL（"heal 30" 等）。`builtin` と排他 */
  effect?: string
  builtin?: string
}

/** 呪文定義 (#174) */
export interface SpellDef {
  id: string
  name: string
  mp: number
  /** 対象（"味方単体" / "敵単体" / "味方全体" / "敵全体" / "自分" / "マップ" 等） */
  target: string
  effect?: string
  builtin?: string
  /** 系統（"fire" / "ice" / "holy" / "breath" 等、耐性計算用） */
  school?: string
}

export interface PlayerStartData {
  x: number
  y: number
  direction: Direction
}

export type Event =
  | {
      Dialog: {
        character: string | null
        expression: string | null
        position: string | null
        text: string[]
        /** per-line voice ファイルパス (#144) */
        voice_path?: string | null
        /** per-line フォント上書き (#147)。CSS の font-family 文字列 */
        font_family?: string | null
      }
    }
  | {
      Narration: {
        text: string[]
        voice_path?: string | null
        /** per-line フォント上書き (#147) */
        font_family?: string | null
      }
    }
  | { Background: { path: string } }
  | {
      Bgm: {
        path: string | null
        action: BgmAction
        /** BGM フェード時間 ms (#145)。Play なら fade-in、Stop なら fade-out */
        fade_ms?: number | null
      }
    }
  | { Se: { path: string; /** SE fade-in 時間 ms (#145) */ fade_ms?: number | null } }
  | { Blackout: { action: BlackoutAction } }
  | 'SceneTransition'
  | { Exit: { character: string } }
  | { Wait: { ms: number } }
  | { Choice: { options: ChoiceOption[] } }
  | { Flag: { name: string; value: FlagValue } }
  | { Condition: { flag: string; events: Event[] } }
  | { ExpressionChange: { character: string; expression: string } }
  | { RpgMap: RpgMapData }
  | { PlayerStart: PlayerStartData }
  | { Npc: NpcData }
  | { Monster: MonsterDef }
  | { Item: ItemDef }
  | { Spell: SpellDef }
  | {
      Animate: {
        target: string
        dx?: string
        dy?: string
        rotation?: string
        scale?: number
        duration_ms: number
        easing?: Easing
      }
    }
  | { DialogBorderless: { borderless: boolean } }
  | { Shake: { intensity_px: number; duration_ms: number } }
  | { Flash: { color: string; alpha: number; duration_ms: number } }
  | {
      Fade: {
        target: string
        color: string
        from_alpha: number
        to_alpha: number
        duration_ms: number
      }
    }

export type Easing = 'Linear' | 'EaseIn' | 'EaseOut' | 'EaseInOut'

export type SceneView = 'TopDown' | 'Raycast'

export interface EventScene {
  id: string
  title: string
  view: SceneView
  events: Event[]
}

export interface EventChapter {
  number: number
  title: string
  hidden: boolean
  default_bgm: string | null
  scenes: EventScene[]
}

export interface EventDocument {
  engine: string
  /** 画面比率。省略時は "16:9" がデフォルト (Issue #136) */
  aspect_ratio?: string
  /** 選択肢スタイル名。`default` / `soft` / `monochrome` (#146)。
   *  null/undefined のときは runtime で `default` 扱い。 */
  choice_style?: string | null
  /** per-game デフォルトフォント (#147)。CSS の font-family 文字列。
   *  null/undefined のときは runtime 既定 (`'Noto Sans JP', sans-serif`) を使う。 */
  font_family?: string | null
  chapters: EventChapter[]
}

/** エディタでの編集位置を示す参照（章インデックス、シーンインデックス、イベントインデックス） */
export interface EventRef {
  chapterIdx: number
  sceneIdx: number
  eventIdx: number
}

export type EditableDialogField = 'character' | 'expression' | 'text'
export type EditableNarrationField = 'text'
