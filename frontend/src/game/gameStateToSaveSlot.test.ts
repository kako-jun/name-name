/**
 * gameStateToSaveSlot（NovelGameState → SaveSlotData）のテスト (#822)。
 * 旧 `saveQuick` / `openSaveMenu`（origin/main）にあった手書きの写像を `referenceMap` として写し、
 * 突き合わせる。`saveSlotToGameState` との往復も確認する。
 */
import { describe, it, expect } from 'vitest'
import type { NovelGameState } from './GameState'
import type { SaveSlotData } from './SaveManager'
import { gameStateToSaveSlot, saveSlotToGameState } from './novelLayout'

function snap(over: Partial<NovelGameState> = {}): NovelGameState {
  return {
    sceneId: 'a',
    eventIndex: 3,
    textIndex: 1,
    sentenceIndex: 2,
    flags: { f: { Bool: true }, g: { String: 'x' } },
    backgroundPath: 'bg.png',
    backgroundColor: '#112233',
    backgroundFade: { top: 1, bottom: 2, left: 3, right: 4 },
    backgroundBrightness: 0.6,
    video: null,
    eventImage: null,
    backgroundBoards: [{ path: 'b.png', depth: 2 }],
    wall: { path: 'w.webm', loop: false, mute: true },
    stageFront: { path: 'f.png' },
    weather: { kind: 'Snow', intensity: 1.5 },
    floor: { path: 'floor.png', height: 0.4 },
    props: [{ path: 'p.png', depth: 1 }],
    spotlight: null,
    curtain: null,
    isBlackout: true,
    characters: [{ name: 'a', expression: 'x', position: 'Left', depth: 3 }],
    currentBgmPath: 'bgm.ogg',
    cameraMode: 'Theater',
    cameraOrientation: 'Stage',
    cameraElevation: 15,
    cameraZoom: null,
    paperDollOutline: null,
    storyEnded: false,
    ...over,
  } as NovelGameState
}

/** origin/main の saveQuick / openSaveMenu にあった SaveSlotData 組み立てをそのまま写したもの。 */
function referenceMap(
  snapshot: NovelGameState,
  slot: number,
  savedAt: string,
  sceneName: string | null
): SaveSlotData {
  return {
    slot,
    sceneId: snapshot.sceneId,
    eventIndex: snapshot.eventIndex,
    textIndex: snapshot.textIndex,
    sentenceIndex: snapshot.sentenceIndex,
    flags: snapshot.flags,
    backgroundPath: snapshot.backgroundPath,
    backgroundColor: snapshot.backgroundColor,
    backgroundFade: snapshot.backgroundFade,
    backgroundBrightness: snapshot.backgroundBrightness,
    video: snapshot.video,
    eventImage: snapshot.eventImage,
    backgroundBoards: snapshot.backgroundBoards,
    wall: snapshot.wall,
    stageFront: snapshot.stageFront,
    weather: snapshot.weather,
    floor: snapshot.floor,
    props: snapshot.props,
    spotlight: snapshot.spotlight,
    curtain: snapshot.curtain,
    isBlackout: snapshot.isBlackout,
    characters: snapshot.characters,
    currentBgmPath: snapshot.currentBgmPath,
    cameraMode: snapshot.cameraMode,
    cameraOrientation: snapshot.cameraOrientation,
    cameraElevation: snapshot.cameraElevation,
    cameraZoom: snapshot.cameraZoom,
    paperDollOutline: snapshot.paperDollOutline,
    savedAt,
    sceneName,
  }
}

describe('gameStateToSaveSlot (#822)', () => {
  it('旧写像と deep equal で、JSON のキー順まで一致する', () => {
    const at = '2026-10-15T00:00:00.000Z'
    for (const [slot, name] of [
      [-1, 'シーンA'],
      [0, null],
      [7, ''],
    ] as const) {
      const s = snap()
      const actual = gameStateToSaveSlot(s, { slot, savedAt: at, sceneName: name })
      const expected = referenceMap(s, slot, at, name)
      expect(actual).toEqual(expected)
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
    }
  })

  it('キー順を固定リテラルでも確認する(storyEnded を含まない)', () => {
    const actual = gameStateToSaveSlot(snap({ storyEnded: true }), {
      slot: -1,
      savedAt: 't',
      sceneName: null,
    })
    expect(Object.keys(actual)).toEqual([
      'slot',
      'sceneId',
      'eventIndex',
      'textIndex',
      'sentenceIndex',
      'flags',
      'backgroundPath',
      'backgroundColor',
      'backgroundFade',
      'backgroundBrightness',
      'video',
      'eventImage',
      'backgroundBoards',
      'wall',
      'stageFront',
      'weather',
      'floor',
      'props',
      'spotlight',
      'curtain',
      'isBlackout',
      'characters',
      'currentBgmPath',
      'cameraMode',
      'cameraOrientation',
      'cameraElevation',
      'cameraZoom',
      'paperDollOutline',
      'savedAt',
      'sceneName',
    ])
    expect('storyEnded' in actual).toBe(false)
  })

  it('saveSlotToGameState との往復で元に戻る(storyEnded は常に false になる)', () => {
    const s = snap()
    const data = gameStateToSaveSlot(s, { slot: 2, savedAt: 't', sceneName: 'x' })
    expect(saveSlotToGameState(data, s.backgroundFade)).toEqual(s)
    // storyEnded=true のスナップショットは保存で落ち、復元で false になる(#386)
    const ended = snap({ storyEnded: true })
    const back = saveSlotToGameState(
      gameStateToSaveSlot(ended, { slot: 2, savedAt: 't', sceneName: 'x' }),
      ended.backgroundFade
    )
    expect(back).toEqual({ ...ended, storyEnded: false })
  })

  it('meta の slot / savedAt / sceneName だけが meta 由来で、スナップショットの値は上書きされない', () => {
    const data = gameStateToSaveSlot(snap({ sceneId: null }), {
      slot: 9,
      savedAt: 'T',
      sceneName: 'N',
    })
    expect([data.slot, data.savedAt, data.sceneName, data.sceneId]).toEqual([9, 'T', 'N', null])
  })
})
