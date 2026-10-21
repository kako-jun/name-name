/**
 * 新規開始の位置指定から、共通コアに渡す最小の `NovelGameState` を組み立てる純粋関数 (#735 1/8, #822)。
 *
 * 演出状態はすべて初期値（背景なし・立ち絵なし・BGM なし・ノベルカメラ）。`NovelRenderer` の `this` に
 * 依存せず、`NovelRenderer` を import しない。
 */

import type { FlagValue } from '../types'
import type { NovelGameState } from './GameState'
import type { FreshPosition } from './sceneEntry'

export function buildFreshPositionState(
  sceneId: string,
  position: FreshPosition,
  flags: Record<string, FlagValue> | undefined
): NovelGameState {
  return {
    sceneId,
    eventIndex: position.eventIndex,
    textIndex: position.textIndex ?? 0,
    sentenceIndex: position.sentenceIndex ?? 0,
    flags: flags ?? {},
    backgroundPath: null,
    backgroundColor: null,
    // 元は `normalizeBackgroundFade(undefined)`（常に null）。PixiJS を間接参照する関数を避けて null を直書きする。
    backgroundFade: null,
    backgroundBrightness: null,
    video: null,
    eventImage: null,
    backgroundBoards: [],
    props: [],
    spotlight: null,
    curtain: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    cameraMode: 'Novel',
    cameraOrientation: 'Audience',
    cameraElevation: null,
    paperDollOutline: null,
    storyEnded: false,
    // 入場時 flags (#799)。指定した flags が展開の入場条件（これが無いと旧セーブ扱いの静的展開になる）。
    // 既存のキー順を保つため末尾に置く。
    entryFlags: flags ?? {},
  }
}
