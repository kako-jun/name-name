export interface ScriptRow {
  id: number
  character: string
  text: string
  expression: string
}

export interface Cut {
  id: number
  character: string
  text: string
  expression: string
  // 将来的な拡張用
  notes?: string
  links?: number[] // 関連するカットのID
}

export interface Scene {
  id: number
  title: string
  cuts: Cut[]
}

export interface Chapter {
  id: number
  title: string
  scenes: Scene[]
}

export interface Viewport {
  x: number // パン位置 X
  y: number // パン位置 Y
  zoom: number // ズームレベル (0.1 ~ 5.0)
}

export type Mode = 'edit' | 'play'
