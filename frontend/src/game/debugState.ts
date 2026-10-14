/**
 * `NovelRenderer.getDebugState()` の整形部 (#735 1/8, #822)。
 *
 * 開発時の HUD（`DebugOverlay`）向けに、レンダラの実行状態を1つのオブジェクトへまとめる純粋関数。
 * レンダラの `this`（resolvedEvents / characterLayer / audioManager など）の読み取りは呼び出し側が行い、
 * ここは受け取った値の組み立てだけを担う。`NovelRenderer` を import しない。
 */

import type { Event } from '../types'
import { describeEventForDebug } from './novelLayout'

export interface DebugCharacterState {
  name: string
  expression: string
  position: string
  depth: number
  x: number
  y: number
  scale: number
}

export interface DebugState {
  eventIndex: number
  eventCount: number
  eventKind: string
  eventText?: string
  autoMode: boolean
  waitingForChoice: boolean
  waitingForWait: boolean
  jumpState: 'idle' | 'pending' | 'stalled'
  currentResolvedFontFamily: string | null
  sceneId: string | null
  audioWarning: string | null
  characters: DebugCharacterState[]
}

export interface DebugStateInputs {
  resolvedEvents: readonly Event[]
  eventIndex: number
  autoMode: boolean
  waitingForChoice: boolean
  waitingForWait: boolean
  jumpState: 'idle' | 'pending' | 'stalled'
  currentResolvedFontFamily: string | null
  /** 再生位置のシーン ID（`getPlayheadSceneId()`）。未確定は undefined/null。 */
  sceneId: string | null | undefined
  audioWarning: string | null
  /** `CharacterLayer.getCharacterStates()` の結果（スナップショット対象の立ち絵）。 */
  characterStates: ReadonlyArray<{
    name: string
    expression: string
    position: string
    depth: number
  }>
  /** 立ち絵名から sprite の座標・倍率を引く。見つからなければ undefined（-1 で埋める）。 */
  spriteGeometry: (name: string) => { x: number; y: number; scale: number } | undefined
}

export function buildDebugState(inputs: DebugStateInputs): DebugState {
  const current = inputs.resolvedEvents[inputs.eventIndex]
  // イベントから debug HUD 用の {kind, text} を取り出す純粋計算は
  // novelLayout.describeEventForDebug に集約 (#260)。
  const { kind, text } = describeEventForDebug(current)
  const characters = inputs.characterStates.map((s) => {
    const geometry = inputs.spriteGeometry(s.name)
    return {
      name: s.name,
      expression: s.expression,
      position: s.position,
      depth: s.depth,
      x: geometry?.x ?? -1,
      y: geometry?.y ?? -1,
      scale: geometry?.scale ?? -1,
    }
  })
  return {
    eventIndex: inputs.eventIndex,
    eventCount: inputs.resolvedEvents.length,
    eventKind: kind,
    eventText: text,
    autoMode: inputs.autoMode,
    waitingForChoice: inputs.waitingForChoice,
    waitingForWait: inputs.waitingForWait,
    jumpState: inputs.jumpState,
    currentResolvedFontFamily: inputs.currentResolvedFontFamily,
    sceneId: inputs.sceneId ?? null,
    audioWarning: inputs.audioWarning,
    characters,
  }
}
