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
}

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
      }
    }
  | { Narration: { text: string[] } }
  | { Background: { path: string } }
  | { Bgm: { path: string | null; action: BgmAction } }
  | { Se: { path: string } }
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
