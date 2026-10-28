/**
 * Stage のカメラズーム (#702) 状態の保持・reset・restore・capture 往復。
 * Host は applyCamera の引数だけ記録するフェイク（背景・効果は実物を空コンテナで接続）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import { Stage, type StageHost, type StageState } from './Stage'
import { carryPolicyFor } from './sceneEntry'
import { TimeController } from './TimeController'
import type { CameraElevation, CameraMode, CameraOrientation, CameraZoom } from '../types'

type Call = [CameraMode, CameraOrientation, CameraElevation | null, CameraZoom | null, boolean]

function setup() {
  const calls: Call[] = []
  const host: StageHost = {
    getAssetBaseUrl: () => '/assets',
    isSkipMode: () => false,
    isInitialized: () => true,
    getScreenSize: () => ({ width: 1280, height: 720 }),
    getCrossfadeMs: () => 100,
    setStagePosition: () => {},
    isNovelStyle: () => true,
    setDialogAlpha: () => {},
    setSeekBarBlackoutHidden: () => {},
    applyCamera: (m, o, e, z, snap) => {
      calls.push([m, o, e, z, snap])
    },
    applyPaperDollOutline: () => {},
  }
  const time = new TimeController()
  time.setMode('virtual')
  const stage = new Stage(host, time)
  stage.attachBackground(new Container())
  stage.attachEffects(new Container())
  return { stage, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

const ZOOM: CameraZoom = { target: 'ミナ', strength: 1.5 }

describe('Stage カメラズーム (#702)', () => {
  it('42: Novel + zoom 有 → cameraZoom は null（Host にも null が渡る）', () => {
    const s = setup()
    s.stage.setCamera('Novel', 'Audience', null, ZOOM, false)
    expect(s.stage.cameraZoom).toBeNull()
    expect(s.calls[s.calls.length - 1]).toEqual(['Novel', 'Audience', null, null, false])
  })

  it('Theater + zoom 有 → 保持され、Host にそのまま渡る（snap も）', () => {
    const s = setup()
    s.stage.setCamera('Theater', 'Stage', 'LookUp', ZOOM, false)
    expect(s.stage.cameraZoom).toEqual(ZOOM)
    expect(s.calls[s.calls.length - 1]).toEqual(['Theater', 'Stage', 'LookUp', ZOOM, false])
  })

  it('43: 引数省略は従来と同一（zoom null・snap true）で、前のズームを持ち越さない', () => {
    const s = setup()
    s.stage.setCamera('Theater', 'Audience', null, ZOOM, false)
    s.stage.setCamera('Theater', 'Audience', null)
    expect(s.stage.cameraZoom).toBeNull()
    expect(s.calls[s.calls.length - 1]).toEqual(['Theater', 'Audience', null, null, true])
    expect(s.stage.cameraMode).toBe('Theater')
  })

  it('44: reset で cameraZoom は null、Host へは Novel・null・snap=true で伝わる', () => {
    const s = setup()
    s.stage.setCamera('Theater', 'Stage', 'LookUp', ZOOM, false)
    s.calls.length = 0
    s.stage.reset(carryPolicyFor('progress'))
    expect(s.stage.cameraZoom).toBeNull()
    expect(s.calls).toEqual([['Novel', 'Audience', null, null, true]])
  })

  const baseState = (over: Partial<StageState>): StageState => ({
    backgroundPath: null,
    backgroundColor: null,
    backgroundFade: null,
    backgroundBrightness: null,
    isBlackout: false,
    cameraMode: 'Theater',
    cameraOrientation: 'Audience',
    cameraElevation: null,
    cameraZoom: null,
    paperDollOutline: null,
    ...over,
  })

  it('45: restore — undefined は null、有はそのまま、常に snap=true', () => {
    const s = setup()
    s.stage.restore(baseState({ cameraZoom: undefined as unknown as StageState['cameraZoom'] }))
    expect(s.stage.cameraZoom).toBeNull()
    expect(s.calls[s.calls.length - 1]).toEqual(['Theater', 'Audience', null, null, true])

    s.stage.restore(baseState({ cameraZoom: ZOOM }))
    expect(s.stage.cameraZoom).toEqual(ZOOM)
    expect(s.calls[s.calls.length - 1]).toEqual(['Theater', 'Audience', null, ZOOM, true])

    // strength null も保持
    s.stage.restore(baseState({ cameraZoom: { target: 'ミナ', strength: null } }))
    expect(s.stage.cameraZoom).toEqual({ target: 'ミナ', strength: null })
  })

  it('45: restore で Novel のとき zoom があっても null に正規化される', () => {
    const s = setup()
    s.stage.restore(baseState({ cameraMode: 'Novel', cameraZoom: ZOOM }))
    expect(s.stage.cameraZoom).toBeNull()
  })

  it('46: capture → restore の往復で同じ状態に戻る', () => {
    const s = setup()
    s.stage.setCamera('Theater', 'Stage', 'LookDown', ZOOM, false)
    const snap = s.stage.capture()
    expect(snap.cameraZoom).toEqual(ZOOM)
    s.stage.setCamera('Novel', 'Audience', null, null, true)
    expect(s.stage.cameraZoom).toBeNull()
    s.stage.restore(snap)
    expect(s.stage.capture()).toEqual(snap)
    expect(s.stage.cameraZoom).toEqual(ZOOM)
  })

  it('capture が返す cameraZoom は Stage 内部状態の後続変更に影響されない（再 setCamera で別オブジェクト）', () => {
    const s = setup()
    s.stage.setCamera('Theater', 'Audience', null, ZOOM, false)
    const snap = s.stage.capture()
    s.stage.setCamera('Theater', 'Audience', null, { target: 'B', strength: 2 }, false)
    expect(snap.cameraZoom).toEqual(ZOOM)
  })
})
