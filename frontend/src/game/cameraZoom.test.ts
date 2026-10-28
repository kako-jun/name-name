/**
 * カメラズーム (#702) の純粋関数 `computeZoomPose` と `CameraZoomController`。
 * 時間は virtual モードの TimeController を `tick` で進めて決定論的に検証する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Container } from 'pixi.js'
import {
  CameraZoomController,
  DEFAULT_ZOOM_STRENGTH,
  IDENTITY_ZOOM_POSE,
  MAX_ZOOM_STRENGTH,
  MIN_ZOOM_STRENGTH,
  ZOOM_TWEEN_MS,
  computeZoomPose,
  resolveZoomStrength,
  type ZoomPose,
} from './cameraZoom'
import { TimeController } from './TimeController'

const W = 1000
const H = 500
const CENTER = { x: 500, y: 250 }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('computeZoomPose (#702)', () => {
  it('24: Novel / zoom null / focus null は identity', () => {
    expect(computeZoomPose('Novel', { target: 'A', strength: 2 }, CENTER, W, H)).toEqual(
      IDENTITY_ZOOM_POSE
    )
    expect(computeZoomPose('Theater', null, CENTER, W, H)).toEqual(IDENTITY_ZOOM_POSE)
    expect(computeZoomPose('Theater', { target: 'A', strength: 2 }, null, W, H)).toEqual(
      IDENTITY_ZOOM_POSE
    )
  })

  it('24: strength null/NaN/inf は既定 1.6、0.5 は 1、2 は 2、9 は 4', () => {
    const scaleOf = (strength: number | null) =>
      computeZoomPose('Theater', { target: 'A', strength }, CENTER, W, H).scale
    expect(scaleOf(null)).toBe(DEFAULT_ZOOM_STRENGTH)
    expect(DEFAULT_ZOOM_STRENGTH).toBe(1.6)
    expect(scaleOf(NaN)).toBe(1.6)
    expect(scaleOf(Infinity)).toBe(1.6)
    expect(scaleOf(-Infinity)).toBe(1.6)
    expect(scaleOf(0.5)).toBe(1)
    expect(scaleOf(2)).toBe(2)
    expect(scaleOf(9)).toBe(4)
  })

  it('24: 画面端のキャラに寄っても平行移動は [screen - screen*scale, 0] にクランプされる', () => {
    const left = computeZoomPose('Theater', { target: 'A', strength: 2 }, { x: 0, y: 0 }, W, H)
    expect(left).toEqual({ scale: 2, x: 0, y: 0 })
    const right = computeZoomPose('Theater', { target: 'A', strength: 2 }, { x: W, y: H }, W, H)
    expect(right).toEqual({ scale: 2, x: W - W * 2, y: H - H * 2 })
    // 画面外のフォーカスでも同じ
    const far = computeZoomPose(
      'Theater',
      { target: 'A', strength: 2 },
      { x: 99999, y: -99999 },
      W,
      H
    )
    expect(far).toEqual({ scale: 2, x: -W, y: 0 })
  })

  it('25: strength 境界 0.999→1, 1→1, 1.001→1.001, 3.999, 4, 4.001→4', () => {
    expect(MIN_ZOOM_STRENGTH).toBe(1)
    expect(MAX_ZOOM_STRENGTH).toBe(4)
    expect(resolveZoomStrength(0.999)).toBe(1)
    expect(resolveZoomStrength(1)).toBe(1)
    expect(resolveZoomStrength(1.001)).toBe(1.001)
    expect(resolveZoomStrength(3.999)).toBe(3.999)
    expect(resolveZoomStrength(4)).toBe(4)
    expect(resolveZoomStrength(4.001)).toBe(4)
    expect(resolveZoomStrength(undefined)).toBe(1.6)
  })

  it('26: 平行移動クランプ境界（scale 2、x 方向 250 / 750 の ±1px）', () => {
    const z = { target: 'A', strength: 2 }
    const x = (fx: number) => computeZoomPose('Theater', z, { x: fx, y: 250 }, W, H).x
    // 下端: 500 - fx*2 = 0 → fx = 250
    expect(x(250)).toBe(0)
    expect(x(251)).toBe(-2)
    expect(x(249)).toBe(0) // クランプ（素の値は +2）
    // 上端: 500 - fx*2 = -1000 → fx = 750
    expect(x(750)).toBe(-1000)
    expect(x(749)).toBe(-998)
    expect(x(751)).toBe(-1000) // クランプ（素の値は -1002）
  })

  it('26: screen 0x0 でも NaN にならない', () => {
    const p = computeZoomPose('Theater', { target: 'A', strength: 2 }, { x: 0, y: 0 }, 0, 0)
    expect(Number.isNaN(p.x)).toBe(false)
    expect(Number.isNaN(p.y)).toBe(false)
    expect(p.scale).toBe(2)
    // -0 を許容しつつ 0 と等価
    expect(p.x + 0).toBe(0)
    expect(p.y + 0).toBe(0)
  })

  it('27: IDENTITY_ZOOM_POSE を返しても呼び出し側の変更でプリセットが壊れない（参照共有の現挙動を固定）', () => {
    const snapshot = { ...IDENTITY_ZOOM_POSE }
    const a = computeZoomPose('Novel', null, null, W, H)
    expect(a).toEqual(snapshot)
    // 定数は identity のまま
    expect(IDENTITY_ZOOM_POSE).toEqual({ scale: 1, x: 0, y: 0 })
    // 実装はコントローラ内で current に代入するだけで破壊的変更をしない
    const h = makeHarness()
    h.ctrl.set('Theater', { target: 'A', strength: 2 }, true)
    h.ctrl.set('Novel', null, true)
    expect(IDENTITY_ZOOM_POSE).toEqual({ scale: 1, x: 0, y: 0 })
  })
})

// ---------------------------------------------------------------------------

interface FakeLayer {
  scale: { set: ReturnType<typeof vi.fn>; v: number }
  position: { set: ReturnType<typeof vi.fn>; x: number; y: number }
}

function fakeLayer(): FakeLayer {
  const layer: FakeLayer = {
    scale: {
      v: 1,
      set: vi.fn((v: number) => {
        layer.scale.v = v
      }),
    },
    position: {
      x: 0,
      y: 0,
      set: vi.fn((x: number, y: number) => {
        layer.position.x = x
        layer.position.y = y
      }),
    },
  }
  return layer
}

function makeHarness(opts: { screen?: { width: number; height: number } } = {}) {
  const time = new TimeController()
  time.setMode('virtual')
  const layers = [fakeLayer(), fakeLayer()]
  const charPoses: ZoomPose[] = []
  const focuses = new Map<string, { x: number; y: number }>()
  focuses.set('A', { x: 400, y: 250 })
  const ctrl = new CameraZoomController(
    {
      getLayers: () => layers as unknown as Container[],
      applyCharacterPose: (p) => charPoses.push(p),
      getFocus: (t) => focuses.get(t) ?? null,
      getScreenSize: () => opts.screen ?? { width: W, height: H },
    },
    time
  )
  return { time, layers, charPoses, focuses, ctrl }
}

const ZOOM_A = { target: 'A', strength: 2 }

describe('CameraZoomController (#702)', () => {
  it('28: snap は即時に最終ポーズが layers と立ち絵へ反映される', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, true)
    // focus (400,250), scale 2: x = 500 - 800 = -300, y = 250 - 500 = -250
    expect(h.ctrl.getPose()).toEqual({ scale: 2, x: -300, y: -250 })
    for (const l of h.layers) {
      expect(l.scale.v).toBe(2)
      expect([l.position.x, l.position.y]).toEqual([-300, -250])
    }
    expect(h.charPoses[h.charPoses.length - 1]).toEqual({ scale: 2, x: -300, y: -250 })
  })

  it('29: 補間は 0→最終で単調増加し、完了後は最終値（ticker は 16ms 刻み）', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, false)
    expect(h.ctrl.getPose().scale).toBe(1) // 0ms: まだ動いていない
    const samples: number[] = []
    for (const target of [32, 224, 320, 448]) {
      h.time.tick(target - h.time.now())
      samples.push(h.ctrl.getPose().scale)
    }
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThan(samples[i - 1])
    expect(samples[0]).toBeGreaterThan(1)
    // 448ms はまだ補間中（tick が 16 刻みなので 450ms ちょうどには tick が来ない）
    expect(samples[samples.length - 1]!).toBeLessThan(2)
    expect(samples[samples.length - 1]!).toBeGreaterThan(1.98)
    h.time.tick(16) // 464ms > 450ms
    expect(h.ctrl.getPose()).toEqual({ scale: 2, x: -300, y: -250 })
    h.time.tick(1000)
    expect(h.ctrl.getPose()).toEqual({ scale: 2, x: -300, y: -250 })
    expect(ZOOM_TWEEN_MS).toBe(450)
  })

  it('29: 経過がちょうど 450ms の tick で補間が完了し、全景復帰なら ticker が止まる（t>=1 境界）', () => {
    const h = makeHarness()
    // ズーム中の ticker（16ms 位相）を作ってから、位相をずらして全景復帰を set する。
    h.ctrl.set('Theater', ZOOM_A, true)
    h.time.tick(14)
    h.ctrl.set('Theater', null, false) // tweenStart = 14。tick は 16n なので 16*29=464 で経過 450ms ちょうど
    expect(h.time.getPendingTimerCount()).toBe(1)
    h.time.tick(464 - 14 - 16) // 448 まで: まだ補間中
    expect(h.time.getPendingTimerCount()).toBe(1)
    h.time.tick(16) // 464: 経過 450ms
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    expect(h.time.getPendingTimerCount()).toBe(0)
  })

  it('30: 全景復帰は補間完了後に ticker が止まる。ズーム中は止まらない', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, false)
    h.time.tick(2000)
    expect(h.time.getPendingTimerCount()).toBe(1) // ズーム中は追従のため常駐
    h.ctrl.set('Theater', null, false)
    expect(h.time.getPendingTimerCount()).toBe(1) // 戻り補間中
    h.time.tick(200)
    expect(h.time.getPendingTimerCount()).toBe(1)
    h.time.tick(400)
    expect(h.time.getPendingTimerCount()).toBe(0)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
  })

  it('30: 最初から全景のまま snap しても ticker は作られない', () => {
    const h = makeHarness()
    h.ctrl.set('Novel', null, true)
    expect(h.time.getPendingTimerCount()).toBe(0)
  })

  it('31: 歩行追従 — focus が動くとポーズが追従する', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, true)
    expect(h.ctrl.getPose().x).toBe(-300)
    h.focuses.set('A', { x: 600, y: 250 })
    h.time.tick(16)
    expect(h.ctrl.getPose().x).toBe(-700) // 500 - 1200
  })

  it('32: 後から登場したキャラへ追従する（最初は全景）', () => {
    const h = makeHarness()
    h.focuses.delete('A')
    h.ctrl.set('Theater', ZOOM_A, true)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    h.time.tick(160)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    h.focuses.set('A', { x: 400, y: 250 })
    h.time.tick(16)
    expect(h.ctrl.getPose()).toEqual({ scale: 2, x: -300, y: -250 })
  })

  it('33: 補間中の再 set は現在値から連続する（ジャンプしない）', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, false)
    h.time.tick(224)
    const mid = h.ctrl.getPose()
    expect(mid.scale).toBeGreaterThan(1)
    expect(mid.scale).toBeLessThan(2)
    h.ctrl.set('Theater', { target: 'A', strength: 3 }, false)
    h.time.tick(16)
    const next = h.ctrl.getPose()
    expect(Math.abs(next.scale - mid.scale)).toBeLessThan(0.3)
    expect(next.scale).toBeGreaterThan(mid.scale) // 3 へ向かっている
    h.time.tick(1000)
    expect(h.ctrl.getPose().scale).toBe(3)
  })

  it('34: 補間中の snap は最終ポーズへ即時に収束し、以降の tick で動かない', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, false)
    h.time.tick(100)
    h.ctrl.set('Theater', ZOOM_A, true)
    expect(h.ctrl.getPose()).toEqual({ scale: 2, x: -300, y: -250 })
    const calls = h.layers[0].scale.set.mock.calls.length
    h.time.tick(1000)
    expect(h.layers[0].scale.set.mock.calls.length).toBe(calls)
  })

  it('35: 同一ポーズの再 apply では scale.set / position.set が呼ばれない', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, true)
    const s = h.layers[0].scale.set.mock.calls.length
    const p = h.layers[0].position.set.mock.calls.length
    const c = h.charPoses.length
    h.time.tick(480) // 追従 tick が 30 回走る
    h.ctrl.set('Theater', ZOOM_A, true)
    expect(h.layers[0].scale.set.mock.calls.length).toBe(s)
    expect(h.layers[0].position.set.mock.calls.length).toBe(p)
    expect(h.charPoses.length).toBe(c)
  })

  describe('warnIfMissing', () => {
    it('36: 同一対象は 1 回のみ。対象変更で再度 1 回。対象在中と zoom null は 0 回', () => {
      const h = makeHarness()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // zoom null
      h.ctrl.set('Theater', null, false)
      h.ctrl.warnIfMissing()
      expect(warn).toHaveBeenCalledTimes(0)
      // 対象在中
      h.ctrl.set('Theater', ZOOM_A, false)
      h.ctrl.warnIfMissing()
      expect(warn).toHaveBeenCalledTimes(0)
      // 対象不在: 同じ対象 → 1 回のみ
      h.ctrl.set('Theater', { target: 'Ghost', strength: null }, false)
      h.ctrl.warnIfMissing()
      h.ctrl.warnIfMissing()
      h.ctrl.warnIfMissing()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('Ghost')
      // 対象変更: 再度 1 回（set で warnedTarget がリセットされるので合計 2）
      h.ctrl.set('Theater', { target: 'Ghost2', strength: null }, false)
      h.ctrl.warnIfMissing()
      h.ctrl.warnIfMissing()
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[1][0])).toContain('Ghost2')
    })

    it('37: set() で warnedTarget がリセットされる（同じ不在対象でも set し直すと再度警告する現挙動の固定）', () => {
      const h = makeHarness()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const z = { target: 'Ghost', strength: null }
      h.ctrl.set('Theater', z, false)
      h.ctrl.warnIfMissing()
      h.ctrl.warnIfMissing()
      expect(warn).toHaveBeenCalledTimes(1)
      h.ctrl.set('Theater', z, false)
      h.ctrl.warnIfMissing()
      expect(warn).toHaveBeenCalledTimes(2)
    })

    it('36: Novel では zoom があっても警告しない', () => {
      const h = makeHarness()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      h.ctrl.set('Novel', { target: 'Ghost', strength: null }, false)
      h.ctrl.warnIfMissing()
      expect(warn).toHaveBeenCalledTimes(0)
    })
  })

  it('38: 二重 set で ticker は 1 つ', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, false)
    h.ctrl.set('Theater', ZOOM_A, false)
    h.ctrl.set('Theater', { target: 'A', strength: 3 }, true)
    expect(h.time.getPendingTimerCount()).toBe(1)
  })

  it('39: dispose で ticker が止まり tick が走らない。dispose 後の set も例外にならない', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, false)
    h.ctrl.dispose()
    expect(h.time.getPendingTimerCount()).toBe(0)
    const calls = h.layers[0].scale.set.mock.calls.length
    h.time.tick(1000)
    expect(h.layers[0].scale.set.mock.calls.length).toBe(calls)
    expect(() => h.ctrl.set('Theater', ZOOM_A, true)).not.toThrow()
    expect(() => h.ctrl.dispose()).not.toThrow()
    expect(() => h.ctrl.dispose()).not.toThrow()
  })

  it('40: Novel では getZoom が null（zoom を渡しても）', () => {
    const h = makeHarness()
    h.ctrl.set('Novel', ZOOM_A, true)
    expect(h.ctrl.getZoom()).toBeNull()
    h.ctrl.set('Theater', ZOOM_A, true)
    expect(h.ctrl.getZoom()).toEqual(ZOOM_A)
  })

  it('41: Theater→Novel で identity へ戻る', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, true)
    h.ctrl.set('Novel', null, true)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    expect(h.layers[0].scale.v).toBe(1)
    expect([h.layers[0].position.x, h.layers[0].position.y]).toEqual([0, 0])
    expect(h.charPoses[h.charPoses.length - 1]).toEqual(IDENTITY_ZOOM_POSE)
    // Novel + zoom を渡す形でも identity
    h.ctrl.set('Theater', ZOOM_A, true)
    h.ctrl.set('Novel', ZOOM_A, true)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
  })
})
