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

export type FlagValue =
  | { Bool: boolean }
  | { String: string }
  | { Number: number }

export type Event =
  | { Dialog: { character: string | null; expression: string | null; position: string | null; text: string[] } }
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

export interface EventScene {
  id: string
  title: string
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
