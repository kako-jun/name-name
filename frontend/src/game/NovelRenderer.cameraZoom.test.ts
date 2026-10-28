/**
 * NovelRenderer × カメラズーム (#702) の配線・セーブ/復元・シーク・スキップ。
 *
 * 対象キャラの位置は characterLayer.getCurrentPosition をスタブして与える（実画像を読まない）。
 * 時間は renderer の TimeController を virtual にして `tick` で進める。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { NovelGameState } from './GameState'
import type { SaveSlotData } from './SaveManager'
import { gameStateToSaveSlot, saveSlotToGameState } from './novelLayout'
import {
  IDENTITY_ZOOM_POSE,
  ZOOM_MISSING_WARN_MS,
  ZOOM_TWEEN_MS,
  type CameraZoomController,
} from './cameraZoom'
import { internals, internalsOf } from '../test/rendererInternals'
import type { Stage } from './Stage'
import type { TimeController } from './TimeController'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function cam(mode: 'Theater' | 'Novel', extra: Record<string, unknown> = {}): Event {
  return { CameraMode: { mode, ...extra } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface Priv {
  stage: Stage
  cameraZoom: CameraZoomController
  time: TimeController
  characterLayer: {
    getCurrentPosition(n: string): { x: number; y: number } | null
    scale: { x: number }
    position: { x: number; y: number }
  }
  skipMode: boolean
}

function make(
  events: Event[] = [narration('one')],
  focus: { x: number; y: number } | null = { x: 100, y: 100 }
) {
  const r = new NovelRenderer()
  r.setScenes([scene('a', events), scene('b', [narration('next')])])
  const p = internalsOf<Priv>(r)
  // time は共有インスタンス。前のテストの追従 ticker を持ち越さないよう一度 live に戻して仮想時刻をリセットする。
  p.time.setMode('live')
  p.time.setMode('virtual')
  vi.spyOn(p.characterLayer, 'getCurrentPosition').mockImplementation(() => focus)
  return { r, p }
}

afterEach(() => {
  vi.restoreAllMocks()
})

const ZOOM_EVT = { zoom: 'ミナ', zoom_strength: 2 }

describe('stageDirectives [カメラ:] ズーム (#702)', () => {
  it('47/48: Theater+zoom 有: skipMode true→snap true / false→false。strength undefined → null', () => {
    const { r, p } = make()
    const spy = vi.spyOn(p.stage, 'setCamera')
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    p.skipMode = true
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    p.skipMode = false
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ' }))
    expect(spy.mock.calls).toEqual([
      ['Theater', 'Audience', null, { target: 'ミナ', strength: 2 }, false],
      ['Theater', 'Audience', null, { target: 'ミナ', strength: 2 }, true],
      ['Theater', 'Audience', null, { target: 'ミナ', strength: null }, false],
    ])
  })

  it('47: zoom None/undefined/空文字 → null。Novel 直接構築 → Stage は null に正規化', () => {
    const { r, p } = make()
    const spy = vi.spyOn(p.stage, 'setCamera')
    internals(r).processDirective(cam('Theater', { zoom: null }))
    internals(r).processDirective(cam('Theater'))
    internals(r).processDirective(cam('Theater', { zoom: '' }))
    expect(spy.mock.calls.map((c) => c[3])).toEqual([null, null, null])
    internals(r).processDirective(cam('Novel', ZOOM_EVT))
    expect(p.stage.cameraZoom).toBeNull()
  })

  it('49: ズームの後に [カメラ: シアター] で全景に戻る（持ち越さない）', () => {
    const { r, p } = make()
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    expect(p.stage.cameraZoom).toEqual({ target: 'ミナ', strength: 2 })
    internals(r).processDirective(cam('Theater'))
    expect(p.stage.cameraZoom).toBeNull()
    expect(r.getSnapshot().cameraZoom).toBeNull()
  })

  it('50: 対象キャラが現れないままなら一定時間後に警告 1 回（直後は出ない）', () => {
    const { r, p } = make([narration('one')], null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    p.time.tick(100)
    expect(warn).not.toHaveBeenCalled()
    p.time.tick(ZOOM_MISSING_WARN_MS * 2)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('ミナ'))).toHaveLength(1)
  })

  it('51: 正常ズーム（対象在中）では console.error / warn が 0', () => {
    const { r, p } = make()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    p.time.tick(1000)
    internals(r).processDirective(cam('Theater'))
    p.time.tick(1000)
    expect(err).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('補間: 通常再生では最終ポーズへ ZOOM_TWEEN_MS かけて到達し、立ち絵レイヤーにも反映される', () => {
    const { r, p } = make([narration('one')], { x: 100, y: 100 })
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    expect(p.cameraZoom.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    p.time.tick(2000)
    const pose = p.cameraZoom.getPose()
    expect(pose.scale).toBe(2)
    expect(p.characterLayer.scale.x).toBe(2)
    expect(p.characterLayer.position.x).toBe(pose.x)
  })

  it('M1: split_layout 有効中はズームしても全景のまま（警告 1 回）、状態は保つ', () => {
    const { r, p } = make()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(
      p.characterLayer as unknown as {
        setSplitLayoutRegion(v: { x: number; y: number; width: number; height: number }): void
      }
    ).setSplitLayoutRegion({ x: 0, y: 0, width: 400, height: 600 })
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    p.time.tick(2000)
    expect(p.cameraZoom.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    expect(p.stage.cameraZoom).toEqual({ target: 'ミナ', strength: 2 })
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('split_layout'))).toHaveLength(1)
  })

  it('57: スキップ中の [カメラ:] は即時スナップ（tick を進める前に最終ポーズ）', () => {
    const { r, p } = make()
    p.skipMode = true
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    expect(p.cameraZoom.getPose().scale).toBe(2)
    expect(p.characterLayer.scale.x).toBe(2)
  })
})

describe('destroy (#702)', () => {
  it('ズーム中に destroy するとズーム追従 ticker も止まる（タイマーが残らない）', () => {
    const { r, p } = make()
    const h = p as unknown as {
      appInitialized: boolean
      app: { destroy: (...a: unknown[]) => void; canvas: unknown }
    }
    h.appInitialized = true
    Object.defineProperty(h.app, 'canvas', {
      configurable: true,
      value: { removeEventListener: () => {} },
    })
    h.app.destroy = () => {}
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    const before = p.time.getPendingTimerCount()
    const dispose = vi.spyOn(p.cameraZoom, 'dispose')
    r.destroy()
    expect(dispose).toHaveBeenCalledTimes(1)
    // ズーム追従の ticker（interval 1 本）が消えている（他の保留タイマーとは独立に減る）
    expect(p.time.getPendingTimerCount()).toBeLessThan(before)
  })
})

describe('復元・シーク・リセット (#702)', () => {
  function zoomed(): { snap: NovelGameState } {
    const { r } = make([narration('one')])
    internals(r).processDirective(cam('Theater', ZOOM_EVT))
    return { snap: r.getSnapshot() }
  }

  it('55: 復元（applyState）は補間なしで最終ポーズ', () => {
    const { snap } = zoomed()
    expect(snap.cameraZoom).toEqual({ target: 'ミナ', strength: 2 })
    const { r, p } = make([narration('one')])
    internals(r).applyState(snap)
    expect(p.cameraZoom.getPose().scale).toBe(2) // tick 前
    expect(p.characterLayer.scale.x).toBe(2)
    expect(p.stage.cameraZoom).toEqual({ target: 'ミナ', strength: 2 })
  })

  it('55: 復元の最終ポーズは立ち絵の復元後に確定する（対象キャラの実在に依存、再スナップの順序）', () => {
    const { snap } = zoomed()
    const withChar: NovelGameState = {
      ...snap,
      characters: [{ name: 'ミナ', expression: 'x', position: 'Left', depth: 0 }],
    }
    const { r, p } = make([narration('one')])
    // 立ち絵が実在する間だけ位置が引ける（stage.restore 時点では未復元＝全景に倒れる順序を再現）
    const present = new Set<string>()
    vi.spyOn(p.characterLayer, 'clear' as never).mockImplementation((() =>
      present.clear()) as never)
    vi.spyOn(p.characterLayer, 'show' as never).mockImplementation(((name: string) => {
      present.add(name)
    }) as never)
    vi.spyOn(p.characterLayer, 'getCurrentPosition').mockImplementation((n: string) =>
      present.has(n) ? { x: 100, y: 100 } : null
    )
    internals(r).applyState(withChar)
    expect(p.cameraZoom.getPose().scale).toBe(2) // tick 前に寄っている
    expect(p.characterLayer.scale.x).toBe(2)
  })

  it('55: 復元時に対象キャラが未登場でも例外・warn なし（全景のまま）', () => {
    const { snap } = zoomed()
    const { r, p } = make([narration('one')], null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => internals(r).applyState(snap)).not.toThrow()
    expect(p.cameraZoom.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    expect(warn).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
    // その後キャラが現れたら追従する
    vi.spyOn(p.characterLayer, 'getCurrentPosition').mockImplementation(() => ({ x: 100, y: 100 }))
    p.time.tick(16)
    p.time.tick(ZOOM_TWEEN_MS + 50)
    expect(p.cameraZoom.getPose().scale).toBe(2)
  })

  it('56: シークでズーム区間へ跳ぶと最終ポーズ、戻ると全景', async () => {
    const { r, p } = make([
      narration('one'),
      cam('Theater', ZOOM_EVT),
      narration('two'),
      cam('Theater'),
      narration('three'),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }, { type: 'advance' }])
    // history: [one(全景), two(ズーム中), three(全景)]
    const zooms = internals(r).history.map((h) => h.cameraZoom)
    expect(zooms).toEqual([null, { target: 'ミナ', strength: 2 }, null])
    r.seekTo(1)
    expect(p.stage.cameraZoom).toEqual({ target: 'ミナ', strength: 2 })
    expect(p.cameraZoom.getPose().scale).toBe(2) // 補間なし
    r.seekTo(0)
    expect(p.stage.cameraZoom).toBeNull()
    expect(p.cameraZoom.getPose()).toEqual(IDENTITY_ZOOM_POSE)
  })

  it('58: 場面転換 reset で全景に戻る', async () => {
    const { r, p } = make([narration('one'), cam('Theater', ZOOM_EVT), narration('two')])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(p.stage.cameraZoom).not.toBeNull()
    await r.jumpToScene('b')
    expect(p.stage.cameraZoom).toBeNull()
    expect(r.getSnapshot().cameraZoom).toBeNull()
    expect(p.cameraZoom.getPose()).toEqual(IDENTITY_ZOOM_POSE)
  })
})

describe('セーブ形式 (#702)', () => {
  const base = (): NovelGameState => {
    const { r } = make([narration('one')])
    return r.getSnapshot()
  }

  it('52: saveSlotToGameState — 旧セーブ(undefined)→null、null→null、往復一致、strength null 保持', () => {
    const slot = gameStateToSaveSlot(base(), { slot: 1, savedAt: 't', sceneName: null })
    const legacy: SaveSlotData = { ...slot }
    delete (legacy as Partial<SaveSlotData>).cameraZoom
    expect(saveSlotToGameState(legacy, null).cameraZoom).toBeNull()
    expect(saveSlotToGameState({ ...slot, cameraZoom: null }, null).cameraZoom).toBeNull()
    for (const z of [
      { target: 'ミナ', strength: 1.5 },
      { target: 'ミナ', strength: null },
    ]) {
      expect(saveSlotToGameState({ ...slot, cameraZoom: z }, null).cameraZoom).toEqual(z)
    }
  })

  it('53: gameStateToSaveSlot → JSON → saveSlotToGameState の往復', () => {
    const s = { ...base(), cameraMode: 'Theater', cameraZoom: { target: 'ミナ', strength: null } }
    const slot = gameStateToSaveSlot(s as NovelGameState, { slot: 2, savedAt: 't', sceneName: 'x' })
    const back = saveSlotToGameState(JSON.parse(JSON.stringify(slot)) as SaveSlotData, null)
    expect(back.cameraZoom).toEqual({ target: 'ミナ', strength: null })
    expect(back.cameraMode).toBe('Theater')
  })

  it('59: 旧セーブ読込でも向き・仰角が壊れない', () => {
    const s = {
      ...base(),
      cameraMode: 'Theater',
      cameraOrientation: 'Stage',
      cameraElevation: 'LookUp',
    } as NovelGameState
    const slot = gameStateToSaveSlot(s, { slot: 3, savedAt: 't', sceneName: null })
    const legacy = JSON.parse(JSON.stringify(slot)) as Record<string, unknown>
    delete legacy.cameraZoom
    const back = saveSlotToGameState(legacy as unknown as SaveSlotData, null)
    expect(back.cameraMode).toBe('Theater')
    expect(back.cameraOrientation).toBe('Stage')
    expect(back.cameraElevation).toBe('LookUp')
    expect(back.cameraZoom).toBeNull()
  })
})
