/**
 * Stage の単体テスト (#828 7c)。BackgroundController / ScreenEffectsController は実物を使い、
 * 立ち絵・大道具・背景板へのカメラ/輪郭の伝播（Host）だけ記録用のフェイクにする。
 *
 * 見るもの: 新規開始 / 進行 / 復元それぞれの reset・restore 後の状態、クロスフェード中の復元、
 * capture のフィールド集合、capture → restore の往復、cancelAllTimers 後にタイマーが残らないこと。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Container, Texture } from 'pixi.js'
import { Stage, type StageHost } from './Stage'
import { carryPolicyFor } from './sceneEntry'
import { TimeController } from './TimeController'
import type { PaperDollOutlineConfig } from './outlineFilter'
import type { CameraElevation, CameraMode, CameraOrientation } from '../types'

const TICK = 1000 / 60

interface BgInternals {
  textureCache: Map<string, Texture>
  bgEntries: Array<{ sprite: { alpha: number }; fadeAnimation: unknown }>
  bgLoadToken: number
  bgCrossfadeTimer: number | null
}

function setup() {
  const log: string[] = []
  const state = {
    stagePos: { x: 0, y: 0 },
    dialogAlpha: 1,
    cameraCalls: [] as Array<[CameraMode, CameraOrientation, CameraElevation | null]>,
    outlineCalls: [] as Array<PaperDollOutlineConfig | null>,
  }
  const host: StageHost = {
    getAssetBaseUrl: () => '/assets',
    isSkipMode: () => false,
    isInitialized: () => true,
    getScreenSize: () => ({ width: 1280, height: 720 }),
    getCrossfadeMs: () => 100,
    setStagePosition: (x, y) => {
      state.stagePos = { x, y }
      log.push(`stagePos:${x},${y}`)
    },
    isNovelStyle: () => true,
    setDialogAlpha: (a) => {
      state.dialogAlpha = a
    },
    setSeekBarBlackoutHidden: () => {},
    applyCamera: (m, o, e) => {
      state.cameraCalls.push([m, o, e])
      log.push(`camera:${m},${o},${e}`)
    },
    applyPaperDollOutline: (c) => {
      state.outlineCalls.push(c)
      log.push(`outline:${c ? c.color : 'null'}`)
    },
  }
  const time = new TimeController()
  time.setMode('virtual')
  const stage = new Stage(host, time)
  stage.attachBackground(new Container())
  stage.attachEffects(new Container())
  const bg = stage.background as unknown as BgInternals
  const cache = (path: string) => bg.textureCache.set(`/assets/images/${path}`, Texture.WHITE)
  cache('a.png')
  cache('b.png')
  const advance = (ms: number): void => {
    let left = ms
    while (left > 0) {
      const step = Math.min(left, TICK)
      vi.advanceTimersByTime(step)
      time.tick(step)
      left -= step
    }
  }
  return { stage, bg, state, time, log, advance }
}

/** 演出を一通り「進行中」にする: 背景 a・地色・暗転・Theater カメラ・輪郭。 */
function populate(s: ReturnType<typeof setup>) {
  s.stage.background.setBackground('a.png', null, 0.5, { instant: true })
  s.stage.background.setBackgroundColor('#123456')
  s.stage.effects.setBlackout(true)
  s.stage.setCamera('Theater', 'Stage', 'LookUp')
  s.stage.setPaperDollOutline({ color: '#abcdef', thickness: 3 })
  s.state.cameraCalls.length = 0
  s.state.outlineCalls.length = 0
  s.log.length = 0
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Stage.reset(policy) (#828 7c)', () => {
  it('新規開始(fresh): 背景・地色・輪郭を捨て、暗転とカメラを既定に戻し、立ち絵らへ伝える', () => {
    const s = setup()
    populate(s)
    s.stage.reset(carryPolicyFor('fresh'))
    expect(s.stage.capture()).toEqual({
      backgroundPath: null,
      backgroundColor: null,
      backgroundFade: null,
      backgroundBrightness: null,
      isBlackout: false,
      cameraMode: 'Novel',
      cameraOrientation: 'Audience',
      cameraElevation: null,
      paperDollOutline: null,
    })
    expect(s.state.cameraCalls).toEqual([['Novel', 'Audience', null]])
    expect(s.state.outlineCalls).toEqual([null])
    expect(s.bg.bgEntries).toHaveLength(0)
  })

  it('進行(progress): 背景・地色・輪郭は持ち越し、暗転とカメラだけ既定に戻る（輪郭は伝播もしない）', () => {
    const s = setup()
    populate(s)
    s.stage.reset(carryPolicyFor('progress'))
    expect(s.stage.capture()).toEqual({
      backgroundPath: 'a.png',
      backgroundColor: '#123456',
      backgroundFade: null,
      backgroundBrightness: 0.5,
      isBlackout: false,
      cameraMode: 'Novel',
      cameraOrientation: 'Audience',
      cameraElevation: null,
      paperDollOutline: { color: '#abcdef', thickness: 3 },
    })
    expect(s.state.cameraCalls).toEqual([['Novel', 'Audience', null]])
    expect(s.state.outlineCalls).toEqual([])
    expect(s.bg.bgEntries).toHaveLength(1)
  })

  it('復元(restore)の方針は fresh と同じく何も持ち越さない', () => {
    const s = setup()
    populate(s)
    s.stage.reset(carryPolicyFor('restore'))
    const c = s.stage.capture()
    expect(c.backgroundPath).toBeNull()
    expect(c.backgroundColor).toBeNull()
    expect(c.paperDollOutline).toBeNull()
    expect(c.cameraMode).toBe('Novel')
  })

  it('実行順: 画面効果の停止 → 背景 → 輪郭 → 暗転解除 → カメラ → スクリム退避リセット', () => {
    const s = setup()
    populate(s)
    const order: string[] = []
    const spy = (obj: object, name: string, label: string) => {
      const orig = (obj as Record<string, (...a: unknown[]) => unknown>)[name].bind(obj)
      vi.spyOn(obj as never, name as never).mockImplementation(((...a: unknown[]) => {
        order.push(label)
        return orig(...a)
      }) as never)
    }
    spy(s.stage.effects, 'reset', 'fx.reset')
    spy(s.stage.background, 'clearBackground', 'bg.clear')
    spy(s.stage.background, 'clearBackgroundColor', 'bg.clearColor')
    spy(s.stage.effects, 'setBlackout', 'fx.blackout')
    spy(s.stage.effects, 'resetNovelScrimState', 'fx.scrim')
    spy(s.stage, 'setPaperDollOutline', 'outline')
    spy(s.stage, 'setCamera', 'camera')
    s.stage.reset(carryPolicyFor('fresh'))
    expect(order).toEqual([
      'fx.reset',
      'bg.clear',
      'bg.clearColor',
      'outline',
      'fx.blackout',
      'camera',
      'fx.scrim',
    ])
  })

  it('持ち越し時だけロードトークンを単独で進める（cancelPendingLoad）。非持ち越しは clearBackground 経由で進む', () => {
    const s = setup()
    populate(s)
    const before = s.bg.bgLoadToken
    s.stage.reset(carryPolicyFor('progress'))
    expect(s.bg.bgLoadToken).toBe(before + 1)
    const cancel = vi.spyOn(s.stage.background, 'cancelPendingLoad')
    s.stage.reset(carryPolicyFor('fresh'))
    // clearBackground の内部（forgetBackground）で1回だけ。reset が単独で足してはいない。
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(s.bg.bgLoadToken).toBe(before + 2)
  })

  it('揺れ中の reset は タイマーとオーバーレイを止めるが stage 位置は戻さない（現状固定。#913）', () => {
    vi.useFakeTimers()
    const s = setup()
    s.stage.effects.startShake(30, 1000)
    s.advance(TICK * 3)
    expect(s.state.stagePos.x !== 0 || s.state.stagePos.y !== 0).toBe(true)
    const moved = { ...s.state.stagePos }
    s.log.length = 0
    s.stage.reset(carryPolicyFor('progress'))
    expect(s.log.filter((l) => l.startsWith('stagePos'))).toEqual([])
    expect(s.state.stagePos).toEqual(moved)
    expect(s.time.getPendingTimerCount()).toBe(0)
  })

  it('クロスフェード中の progress reset は畳んで最新の背景だけを不透明で残し、タイマーも止まる', () => {
    vi.useFakeTimers()
    const s = setup()
    s.stage.background.setBackground('a.png', null, null, { instant: true })
    s.stage.background.setBackground('b.png')
    expect(s.bg.bgEntries).toHaveLength(2)
    expect(s.bg.bgCrossfadeTimer).not.toBeNull()
    s.stage.reset(carryPolicyFor('progress'))
    expect(s.bg.bgEntries).toHaveLength(1)
    expect(s.bg.bgEntries[0].sprite.alpha).toBe(1)
    expect(s.bg.bgCrossfadeTimer).toBeNull()
    expect(s.stage.capture().backgroundPath).toBe('b.png')
  })
})

describe('Stage.capture / restore (#828 7c)', () => {
  it('capture のフィールド集合はセーブ形式の演出フィールドと完全に一致する', () => {
    const s = setup()
    expect(Object.keys(s.stage.capture()).sort()).toEqual(
      [
        'backgroundBrightness',
        'backgroundColor',
        'backgroundFade',
        'backgroundPath',
        'cameraElevation',
        'cameraMode',
        'cameraOrientation',
        'isBlackout',
        'paperDollOutline',
      ].sort()
    )
  })

  it('capture → restore の往復で同じ状態に戻る（別の状態から）', () => {
    const s = setup()
    populate(s)
    const saved = s.stage.capture()
    s.stage.reset(carryPolicyFor('fresh'))
    s.stage.background.setBackground('b.png', null, null, { instant: true })
    expect(s.stage.capture()).not.toEqual(saved)
    s.stage.restore(saved)
    expect(s.stage.capture()).toEqual(saved)
  })

  it('restore はカメラ・輪郭を立ち絵らへ伝える（輪郭 → カメラ の順）', () => {
    const s = setup()
    populate(s)
    const saved = s.stage.capture()
    s.log.length = 0
    s.stage.restore(saved)
    const rest = s.log.filter((l) => l.startsWith('camera') || l.startsWith('outline'))
    expect(rest).toEqual(['outline:#abcdef', 'camera:Theater,Stage,LookUp'])
  })

  it('restore は進行中の揺れを止めて stage を原点へ戻し、スクリム退避もリセットする（reset と違い位置も戻す）', () => {
    vi.useFakeTimers()
    const s = setup()
    s.stage.effects.startShake(30, 1000)
    s.advance(TICK * 3)
    const saved = s.stage.capture()
    s.stage.restore(saved)
    expect(s.state.stagePos).toEqual({ x: 0, y: 0 })
    expect(s.time.getPendingTimerCount()).toBe(0)
    expect(s.state.dialogAlpha).toBe(1)
  })

  it('クロスフェード中の復元は旧 entry を残さず、復元先の背景を即時・不透明で表示する', () => {
    vi.useFakeTimers()
    const s = setup()
    s.stage.background.setBackground('a.png', null, null, { instant: true })
    const savedA = s.stage.capture()
    s.stage.background.setBackground('b.png')
    expect(s.bg.bgEntries).toHaveLength(2)
    s.stage.restore(savedA)
    expect(s.bg.bgEntries).toHaveLength(1)
    expect(s.bg.bgEntries[0].sprite.alpha).toBe(1)
    expect(s.bg.bgEntries[0].fadeAnimation).toBeNull()
    expect(s.bg.bgCrossfadeTimer).toBeNull()
    expect(s.stage.capture().backgroundPath).toBe('a.png')
    s.advance(1000)
    expect(s.bg.bgEntries).toHaveLength(1)
  })

  it('背景なし・暗転・Novel カメラの状態を復元すると、背景は消え暗転が付く', () => {
    const s = setup()
    populate(s)
    s.stage.restore({
      backgroundPath: null,
      backgroundColor: null,
      backgroundFade: null,
      backgroundBrightness: null,
      isBlackout: true,
      cameraMode: 'Novel',
      cameraOrientation: 'Audience',
      cameraElevation: null,
      paperDollOutline: null,
    })
    const c = s.stage.capture()
    expect(c.backgroundPath).toBeNull()
    expect(c.isBlackout).toBe(true)
    expect(c.paperDollOutline).toBeNull()
  })
})

describe('Stage.cancelAllTimers / release (#828 7c)', () => {
  it('cancelAllTimers で 揺れ・フラッシュ・フェード・スクリム退避・背景クロスフェードのタイマーがすべて消える', () => {
    vi.useFakeTimers()
    const s = setup()
    s.stage.background.setBackground('a.png', null, null, { instant: true })
    s.stage.background.setBackground('b.png')
    s.stage.effects.startShake(10, 1000)
    s.stage.effects.startFlash('#ffffff', 1, 500, null, 1, null)
    s.stage.effects.updateNovelScrim(true)
    s.stage.effects.retreatNovelScrim()
    expect(s.time.getPendingTimerCount()).toBeGreaterThan(0)
    s.stage.cancelAllTimers()
    expect(s.time.getPendingTimerCount()).toBe(0)
    // 以後いくら進めても何も動かない
    const snap = s.stage.capture()
    s.advance(2000)
    expect(s.stage.capture()).toEqual(snap)
  })

  it('背景クロスフェードのタイマー単独でも cancelAllTimers が止める', () => {
    vi.useFakeTimers()
    const s = setup()
    s.stage.background.setBackground('a.png', null, null, { instant: true })
    s.stage.background.setBackground('b.png')
    expect(s.bg.bgCrossfadeTimer).not.toBeNull()
    s.stage.cancelAllTimers()
    expect(s.bg.bgCrossfadeTimer).toBeNull()
    expect(s.time.getPendingTimerCount()).toBe(0)
  })

  it('release は テクスチャ解放 → 背景 entry 全破棄 の順で、キャッシュと entries が空になる', () => {
    const s = setup()
    s.stage.background.setBackground('a.png', null, null, { instant: true })
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const order: string[] = []
    const rel = s.stage.background.releaseTextures.bind(s.stage.background)
    const clr = s.stage.background.clearBackgroundEntries.bind(s.stage.background)
    vi.spyOn(s.stage.background, 'releaseTextures').mockImplementation(() => {
      order.push('release')
      rel()
    })
    vi.spyOn(s.stage.background, 'clearBackgroundEntries').mockImplementation(() => {
      order.push('clear')
      clr()
    })
    s.stage.release()
    expect(order).toEqual(['release', 'clear'])
    expect(s.bg.bgEntries).toHaveLength(0)
    expect(s.bg.textureCache.size).toBe(0)
  })
})

describe('Stage の更新口 (#828 7c)', () => {
  it('setCamera は 3つ組を保持して Host へ伝え、getter で読める', () => {
    const s = setup()
    s.stage.setCamera('Theater', 'Stage', 'LookDown')
    expect([s.stage.cameraMode, s.stage.cameraOrientation, s.stage.cameraElevation]).toEqual([
      'Theater',
      'Stage',
      'LookDown',
    ])
    expect(s.state.cameraCalls).toEqual([['Theater', 'Stage', 'LookDown']])
  })

  it('setPaperDollOutline は保持して Host へ伝える。null で解除', () => {
    const s = setup()
    s.stage.setPaperDollOutline({ color: '#fff', thickness: 2 })
    expect(s.stage.paperDollOutline).toEqual({ color: '#fff', thickness: 2 })
    s.stage.setPaperDollOutline(null)
    expect(s.stage.paperDollOutline).toBeNull()
    expect(s.state.outlineCalls).toEqual([{ color: '#fff', thickness: 2 }, null])
  })

  it('attachBackground / attachEffects は z 順（背景: 下地→画像、効果: スクリム→暗転→効果）で積む', () => {
    const s = setup()
    const a = new Container()
    const b = new Container()
    s.stage.attachBackground(a)
    s.stage.attachEffects(b)
    expect(a.children).toEqual([s.stage.background.graphics, s.stage.background.container])
    expect(b.children).toHaveLength(3)
    expect(b.children[1]).toBe(s.stage.effects.blackoutOverlay)
  })
})
