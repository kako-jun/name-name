/**
 * 旧実装との等価性 (#828 7c)。
 *
 * `OldRig` は Stage 導入前の `NovelRenderer`（origin/main ca0efe9c）の `resetAndStartEvents` / `applyState` /
 * `destroy` / `[カメラ:]` / `[紙人形輪郭:]` / `getSnapshot` のうち、演出（背景・画面効果・カメラ3つ組・紙人形輪郭）が
 * 触る呼び出しを、旧コードの順序のまま写した参照実装（oracle）。新しい `Stage` は一切呼ばない。
 * 同じ前状態から同じ操作を `OldRig` と `Stage` に行わせ、次を比べる。
 *  - 演出まわりの呼び出し列（コントローラのメソッド名と、立ち絵・大道具・背景板への伝播）の順序
 *  - 操作直後と、その後 1 フレームずつ進めた全フレームの最終状態（capture・背景 entry の alpha・stage 位置・
 *    ダイアログ alpha・保留タイマー数・ロードトークン）
 *
 * 範囲の限界: 旧 `resetAndStartEvents` / `applyState` は演出以外のレイヤー（動画・立ち絵・大道具・背景板の clear/restore、
 * BGM、カーソルなど）の呼び出しを間に挟んでいた。ここで比べるのは演出が所有するモジュールの呼び出しの相対順序だけで、
 * 他レイヤーとの相対順序は `NovelRenderer.stage.test.ts`（配線）と実 WebGL の画素比較が担う。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Container, Texture } from 'pixi.js'
import { BackgroundController } from './BackgroundController'
import { ScreenEffectsController } from './ScreenEffectsController'
import { Stage, type StageHost, type StageState } from './Stage'
import { carryPolicyFor, type CarryPolicy } from './sceneEntry'
import { TimeController } from './TimeController'
import type { PaperDollOutlineConfig } from './outlineFilter'
import type { CameraElevation, CameraMode, CameraOrientation } from '../types'

const TICK = 1000 / 60

interface World {
  log: string[]
  stagePos: { x: number; y: number }
  dialogAlpha: number
}

function makeHost(world: World) {
  return {
    getAssetBaseUrl: () => '/assets',
    isSkipMode: () => false,
    isInitialized: () => true,
    getScreenSize: () => ({ width: 1280, height: 720 }),
    getCrossfadeMs: () => 120,
    setStagePosition: (x: number, y: number) => {
      world.stagePos = { x, y }
    },
    isNovelStyle: () => true,
    setDialogAlpha: (a: number) => {
      world.dialogAlpha = a
    },
    setSeekBarBlackoutHidden: () => {},
  }
}

/** コントローラのメソッド呼び出しを（呼び出しはそのまま通して）world.log へ名前で記録する。 */
function trace(world: World, bg: BackgroundController, fx: ScreenEffectsController): void {
  const wrap = (obj: object, prefix: string, names: string[]) => {
    for (const n of names) {
      const orig = (obj as Record<string, (...a: unknown[]) => unknown>)[n].bind(obj)
      vi.spyOn(obj as never, n as never).mockImplementation(((...a: unknown[]) => {
        world.log.push(`${prefix}.${n}`)
        return orig(...a)
      }) as never)
    }
  }
  wrap(bg, 'bg', [
    'cancelPendingLoad',
    'finishBackgroundCrossfadeInstant',
    'clearBackground',
    'clearBackgroundColor',
    'restore',
    'releaseTextures',
    'clearBackgroundEntries',
    'forgetBackground',
  ])
  wrap(fx, 'fx', [
    'reset',
    'resetStagePosition',
    'resetNovelScrimState',
    'restore',
    'setBlackout',
    'stopAllTimers',
  ])
}

interface Rig {
  world: World
  time: TimeController
  bg: BackgroundController
  fx: ScreenEffectsController
  setCamera(m: CameraMode, o: CameraOrientation, e: CameraElevation | null): void
  setOutline(c: PaperDollOutlineConfig | null): void
  resetAndStartEvents(policy: CarryPolicy): void
  applyState(state: StageState): void
  destroyTimers(): void
  destroyRelease(): void
  snapshot(): StageState
}

// ---------------------------------------------------------------------------------------------
// 旧実装（参照）。Stage を使わず、旧 NovelRenderer の演出部分の呼び出し順をそのまま写している。
// ---------------------------------------------------------------------------------------------
function makeOldRig(): Rig {
  const world: World = { log: [], stagePos: { x: 0, y: 0 }, dialogAlpha: 1 }
  const time = new TimeController()
  time.setMode('virtual')
  const host = makeHost(world)
  const bg = new BackgroundController(host, time)
  const fx = new ScreenEffectsController(host, time)
  bg.attachTo(new Container())
  fx.attachTo(new Container())
  trace(world, bg, fx)
  // 旧 NovelRenderer のフィールド
  let cameraMode: CameraMode = 'Novel'
  let cameraOrientation: CameraOrientation = 'Audience'
  let cameraElevation: CameraElevation | null = null
  let paperDollOutline: PaperDollOutlineConfig | null = null

  // 旧: 背景板 → 大道具 → 立ち絵 の順に setCamera（processDirective / resetAndStartEvents / applyState 共通の並び）
  const syncCameraToLayers = () => {
    world.log.push(`camera.bb:${cameraMode},${cameraOrientation},${cameraElevation}`)
    world.log.push(`camera.prop:${cameraMode},${cameraOrientation},${cameraElevation}`)
    world.log.push(`camera.char:${cameraMode},${cameraOrientation},${cameraElevation}`)
  }
  // 旧: 立ち絵 → 大道具 の順に setPaperDollOutline
  const syncOutlineToLayers = () => {
    world.log.push(`outline.char:${paperDollOutline ? paperDollOutline.color : null}`)
    world.log.push(`outline.prop:${paperDollOutline ? paperDollOutline.color : null}`)
  }
  return {
    world,
    time,
    bg,
    fx,
    setCamera(m, o, e) {
      // 旧 processDirective の CameraMode 分岐
      cameraMode = m
      cameraOrientation = o
      cameraElevation = e
      syncCameraToLayers()
    },
    setOutline(c) {
      // 旧 processDirective の PaperDollOutline 分岐
      paperDollOutline = c
      syncOutlineToLayers()
    },
    resetAndStartEvents(options) {
      // --- 旧 resetAndStartEvents の演出部分（出現順どおり） ---
      fx.reset()
      if (options.preserveBackgroundForTransition) {
        bg.cancelPendingLoad()
        bg.finishBackgroundCrossfadeInstant()
      } else {
        bg.clearBackground()
        bg.clearBackgroundColor()
      }
      if (!options.preserveBackgroundForTransition) {
        paperDollOutline = null
        syncOutlineToLayers()
      }
      fx.setBlackout(false)
      cameraMode = 'Novel'
      cameraOrientation = 'Audience'
      cameraElevation = null
      syncCameraToLayers()
      fx.resetNovelScrimState()
    },
    applyState(state) {
      // --- 旧 applyState の演出部分（出現順どおり） ---
      fx.reset()
      fx.resetStagePosition()
      fx.resetNovelScrimState()
      bg.restore(state)
      fx.restore(state)
      cameraMode = state.cameraMode
      cameraOrientation = state.cameraOrientation
      cameraElevation = state.cameraElevation
      paperDollOutline = state.paperDollOutline
      syncOutlineToLayers()
      syncCameraToLayers()
    },
    destroyTimers() {
      // 旧 destroy: fx.stopAllTimers()
      fx.stopAllTimers()
    },
    destroyRelease() {
      // 旧 destroy の後半: releaseTextures → clearBackgroundEntries
      bg.releaseTextures()
      bg.clearBackgroundEntries()
    },
    snapshot() {
      // 旧 getSnapshot の演出部分
      return {
        ...bg.capture(),
        ...fx.capture(),
        cameraMode,
        cameraOrientation,
        cameraElevation,
        paperDollOutline,
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// 新実装
// ---------------------------------------------------------------------------------------------
function makeNewRig(): Rig {
  const world: World = { log: [], stagePos: { x: 0, y: 0 }, dialogAlpha: 1 }
  const time = new TimeController()
  time.setMode('virtual')
  const host: StageHost = {
    ...makeHost(world),
    applyCamera: (m, o, e) => {
      world.log.push(`camera.bb:${m},${o},${e}`)
      world.log.push(`camera.prop:${m},${o},${e}`)
      world.log.push(`camera.char:${m},${o},${e}`)
    },
    applyPaperDollOutline: (c) => {
      world.log.push(`outline.char:${c ? c.color : null}`)
      world.log.push(`outline.prop:${c ? c.color : null}`)
    },
  }
  const stage = new Stage(host, time)
  stage.attachBackground(new Container())
  stage.attachEffects(new Container())
  trace(world, stage.background, stage.effects)
  return {
    world,
    time,
    bg: stage.background,
    fx: stage.effects,
    setCamera: (m, o, e) => stage.setCamera(m, o, e),
    setOutline: (c) => stage.setPaperDollOutline(c),
    resetAndStartEvents: (p) => stage.reset(p),
    applyState: (s) => stage.restore(s),
    destroyTimers: () => stage.cancelAllTimers(),
    destroyRelease: () => stage.release(),
    snapshot: () => stage.capture(),
  }
}

// ---------------------------------------------------------------------------------------------
// 比較の道具
// ---------------------------------------------------------------------------------------------
interface BgInternals {
  textureCache: Map<string, Texture>
  bgEntries: Array<{ sprite: { alpha: number; destroyed: boolean } }>
  bgLoadToken: number
  bgCrossfadeTimer: number | null
}
const inner = (rig: Rig) => rig.bg as unknown as BgInternals

function observe(rig: Rig) {
  return {
    snapshot: rig.snapshot(),
    entries: inner(rig).bgEntries.map((e) => Math.round(e.sprite.alpha * 1e6) / 1e6),
    token: inner(rig).bgLoadToken,
    crossfadeTimer: inner(rig).bgCrossfadeTimer !== null,
    stagePos: { ...rig.world.stagePos },
    dialogAlpha: rig.world.dialogAlpha,
    pending: rig.time.getPendingTimerCount(),
    cacheSize: inner(rig).textureCache.size,
  }
}

type Prepare = (rig: Rig, advance: (ms: number) => void) => void

/** 新旧を同時に作り、同じ前状態を与えてから、各フレームで状態を比べる。 */
function compare(
  prepare: Prepare,
  op: (rig: Rig) => void,
  options: { dropNewOnly?: string[] } = {}
) {
  vi.useFakeTimers()
  vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
  const oldRig = makeOldRig()
  const newRig = makeNewRig()
  const rigs = [oldRig, newRig]
  const advance = (ms: number): void => {
    let left = ms
    while (left > 0) {
      const step = Math.min(left, TICK)
      vi.advanceTimersByTime(step)
      for (const r of rigs) r.time.tick(step)
      left -= step
    }
  }
  for (const r of rigs) {
    const m = inner(r).textureCache
    m.set('/assets/images/a.png', Texture.WHITE)
    m.set('/assets/images/b.png', Texture.WHITE)
  }
  // 前状態は新旧で同じ手順（コントローラ直接＋rig のカメラ/輪郭口）。ここでの呼び出しは比較対象外。
  // 時刻を揃えるため、prepare の中の advance は呼び出しを記録するだけにし、全 rig の準備が済んでから
  // 先頭 rig 分だけをまとめて実行する（prepare は「操作を並べたあとに advance」の形で書く）。
  const prepAdvances: number[] = []
  for (const r of rigs) {
    prepare(r, (ms) => prepAdvances.push(ms))
  }
  const half = prepAdvances.length / 2
  for (const ms of prepAdvances.slice(0, half)) advance(ms)
  for (const r of rigs) r.world.log.length = 0

  // 操作
  for (const r of rigs) op(r)
  const oldLog = oldRig.world.log.slice()
  const dropNewOnly = new Set(options.dropNewOnly ?? [])
  const newLog = newRig.world.log.filter((l) => !dropNewOnly.has(l))
  expect(newLog).toEqual(oldLog)
  expect(observe(newRig)).toEqual(observe(oldRig))
  // 以後 1 フレームずつ 400ms 進め、毎フレーム同じ状態であること
  for (let f = 0; f < 24; f++) {
    advance(TICK)
    expect(observe(newRig)).toEqual(observe(oldRig))
  }
  return { oldRig, newRig, oldLog }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** 前状態の組み立て。prepare は 2 rig に対して呼ばれるので、時間を進める操作は advance 経由で列にする。 */
const settled: Prepare = (rig) => {
  rig.bg.setBackground('a.png', null, 0.5, { instant: true })
  rig.bg.setBackgroundColor('#123456')
  rig.fx.setBlackout(true)
  rig.setCamera('Theater', 'Stage', 'LookUp')
  rig.setOutline({ color: '#abcdef', thickness: 3 })
}

const inFlight: Prepare = (rig, advance) => {
  rig.bg.setBackground('a.png', null, null, { instant: true })
  rig.bg.setBackground('b.png') // クロスフェード開始
  rig.fx.startShake(24, 800)
  rig.fx.startFlash('#ff0000', 0.8, 400, null, 1, null)
  rig.fx.updateNovelScrim(true)
  rig.fx.retreatNovelScrim()
  rig.setCamera('Theater', 'Audience', 'LookDown')
  rig.setOutline({ color: '#00ff00', thickness: 1 })
  advance(TICK * 5)
}

const empty: Prepare = () => {}

const SAVED: StageState = {
  backgroundPath: 'b.png',
  backgroundColor: '#445566',
  backgroundFade: null,
  backgroundBrightness: 0.25,
  isBlackout: true,
  cameraMode: 'Theater',
  cameraOrientation: 'Stage',
  cameraElevation: 'LookDown',
  paperDollOutline: { color: '#010203', thickness: 5 },
}
const SAVED_PLAIN: StageState = {
  backgroundPath: null,
  backgroundColor: null,
  backgroundFade: null,
  backgroundBrightness: null,
  isBlackout: false,
  cameraMode: 'Novel',
  cameraOrientation: 'Audience',
  cameraElevation: null,
  paperDollOutline: null,
}

describe('Stage × 旧実装の等価性 (#828 7c)', () => {
  const policies: Array<[string, CarryPolicy]> = [
    ['進行(progress)', carryPolicyFor('progress')],
    ['新規開始(fresh)', carryPolicyFor('fresh')],
    ['復元(restore)の方針', carryPolicyFor('restore')],
  ]
  const prepares: Array<[string, Prepare]> = [
    ['確定済みの演出', settled],
    ['クロスフェード・揺れ・フラッシュ・スクリム退避の最中', inFlight],
    ['何も無い状態', empty],
  ]

  for (const [pn, policy] of policies) {
    for (const [sn, prep] of prepares) {
      it(`resetAndStartEvents 相当: ${pn} × ${sn}`, () => {
        const { oldLog } = compare(prep, (r) => r.resetAndStartEvents(policy))
        // oracle の呼び出し列が空でない（比較が空振りしていない）こと
        expect(oldLog.length).toBeGreaterThan(5)
        expect(oldLog[0]).toBe('fx.reset')
      })
    }
  }

  for (const [sn, prep] of prepares) {
    for (const [name, saved] of [
      ['背景・暗転・Theater カメラ・輪郭あり', SAVED],
      ['何も無い', SAVED_PLAIN],
    ] as const) {
      it(`applyState 相当: ${name} を復元 × 前状態 ${sn}`, () => {
        const { oldLog } = compare(prep, (r) => r.applyState(saved))
        expect(oldLog.slice(0, 3)).toEqual([
          'fx.reset',
          'fx.resetStagePosition',
          'fx.resetNovelScrimState',
        ])
      })
    }
  }

  for (const [sn, prep] of prepares) {
    it(`destroy 相当: タイマー停止 → 解放 × ${sn}`, () => {
      // 新実装の cancelAllTimers は背景クロスフェードのタイマーも止める（bg.cancelTimers）。旧 destroy は
      // fx.stopAllTimers だけで、背景のタイマーは後段の clearBackgroundEntries が止めていた。同一の同期区間内なので
      // 観測できる差はなく、最終状態（保留タイマー 0・entries 空）が一致することで担保する。
      compare(
        prep,
        (r) => {
          r.destroyTimers()
          r.destroyRelease()
        },
        { dropNewOnly: [] }
      )
    })
  }

  it('[カメラ:] / [紙人形輪郭:] のディレクティブ相当は旧実装と同じ伝播順（背景板→大道具→立ち絵 / 立ち絵→大道具）', () => {
    compare(empty, (r) => {
      r.setCamera('Theater', 'Stage', 'LookUp')
      r.setOutline({ color: '#fff', thickness: 2 })
      r.setCamera('Novel', 'Audience', null)
      r.setOutline(null)
    })
  })

  it('getSnapshot の演出部分は旧実装と同じキーと値（セーブ形式不変）', () => {
    const { oldRig, newRig } = compare(settled, () => {})
    expect(Object.keys(newRig.snapshot()).sort()).toEqual(Object.keys(oldRig.snapshot()).sort())
    expect(newRig.snapshot()).toEqual(oldRig.snapshot())
  })

  it('連鎖: 進行 reset → 復元 → fresh reset → 解放 でも毎フレーム同じ', () => {
    compare(inFlight, (r) => {
      r.resetAndStartEvents(carryPolicyFor('progress'))
      r.applyState(SAVED)
      r.resetAndStartEvents(carryPolicyFor('fresh'))
      r.destroyTimers()
      r.destroyRelease()
    })
  })

  it('揺れ中の resetAndStartEvents は旧実装と同じく stage 位置を戻さない（#913 の現状）', () => {
    const { oldRig, newRig } = compare(
      (rig, advance) => {
        rig.fx.startShake(30, 1000)
        advance(TICK * 4)
      },
      (r) => r.resetAndStartEvents(carryPolicyFor('progress'))
    )
    expect(oldRig.world.log).not.toContain('fx.resetStagePosition')
    expect(newRig.world.log).not.toContain('fx.resetStagePosition')
  })
})
