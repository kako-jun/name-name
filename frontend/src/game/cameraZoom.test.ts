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
  ZOOM_MISSING_WARN_MS,
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

function makeHarness(opts: { screen?: { width: number; height: number }; split?: boolean } = {}) {
  const state = { split: opts.split ?? false, skip: false }
  // 立ち絵は舞台に居るがテクスチャ未読み込み（フォーカス無し）の対象。フォーカスがある対象も「居る」。
  const present = new Set<string>()
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
      isSplitLayoutActive: () => state.split,
      isSkipMode: () => state.skip,
      hasCharacter: (t) => present.has(t) || focuses.has(t),
    },
    time
  )
  return { time, layers, charPoses, focuses, present, ctrl, state }
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
    h.time.tick(ZOOM_TWEEN_MS + 50)
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

  describe('対象不在の警告（一定時間現れないときだけ）', () => {
    it('36: 現れないまま ZOOM_MISSING_WARN_MS 経つと 1 回だけ警告。対象在中・zoom null・Novel は 0 回', () => {
      const h = makeHarness()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      h.ctrl.set('Theater', null, false)
      h.ctrl.set('Theater', ZOOM_A, false)
      h.time.tick(ZOOM_MISSING_WARN_MS * 2)
      expect(warn).toHaveBeenCalledTimes(0)
      h.ctrl.set('Novel', { target: 'Ghost', strength: null }, false)
      h.time.tick(ZOOM_MISSING_WARN_MS * 2)
      expect(warn).toHaveBeenCalledTimes(0)
      h.ctrl.set('Theater', { target: 'Ghost', strength: null }, false)
      h.time.tick(ZOOM_MISSING_WARN_MS - 100)
      expect(warn).toHaveBeenCalledTimes(0)
      h.time.tick(ZOOM_MISSING_WARN_MS * 3)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('Ghost')
    })

    it('N4: ズームしてからキャラを登場させる書き方では警告しない（猶予内に現れる）', () => {
      const h = makeHarness()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      h.ctrl.set('Theater', { target: 'Late', strength: 2 }, false)
      h.time.tick(ZOOM_MISSING_WARN_MS - 200)
      h.focuses.set('Late', { x: 400, y: 250 })
      h.time.tick(ZOOM_MISSING_WARN_MS * 3)
      expect(warn).not.toHaveBeenCalled()
    })
  })

  describe('split_layout 併用 (M1)', () => {
    it('split 無し: 寄せた後に対象キャラが画面中心に来る（クランプが効かない範囲）', () => {
      const h = makeHarness()
      h.ctrl.set('Theater', ZOOM_A, true)
      const { scale, x, y } = h.ctrl.getPose()
      const f = h.focuses.get('A')!
      expect(f.x * scale + x).toBe(W / 2)
      expect(f.y * scale + y).toBe(H / 2)
    })

    it('split 有り: 常に全景のまま、警告は 1 回だけ', () => {
      const h = makeHarness({ split: true })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      h.ctrl.set('Theater', ZOOM_A, true)
      expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
      h.ctrl.set('Theater', ZOOM_A, false)
      h.time.tick(1000)
      expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('split_layout')
      // 宣言的な状態は保たれる（split が外れれば寄る）
      expect(h.ctrl.getZoom()).toEqual(ZOOM_A)
      h.state.split = false
      h.time.tick(1000)
      expect(h.ctrl.getPose().scale).toBe(2)
    })
  })

  describe('登場・退場の補間 (S3)', () => {
    it('登場: 後から現れたキャラへ現在のポーズ（全景）から補間して寄る（飛ばない）', () => {
      const h = makeHarness()
      h.ctrl.set('Theater', { target: 'Late', strength: 2 }, false)
      expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
      h.focuses.set('Late', { x: 400, y: 250 })
      h.time.tick(16) // 補間の起点
      h.time.tick(96)
      const mid = h.ctrl.getPose()
      expect(mid.scale).toBeGreaterThan(1)
      expect(mid.scale).toBeLessThan(2)
      h.time.tick(ZOOM_TWEEN_MS + 50)
      expect(h.ctrl.getPose().scale).toBe(2)
    })

    it('退場: 対象が消えたら現在のポーズから全景へ補間して戻る（飛ばない）', () => {
      const h = makeHarness()
      h.ctrl.set('Theater', ZOOM_A, true)
      expect(h.ctrl.getPose().scale).toBe(2)
      h.focuses.delete('A')
      h.time.tick(16) // 補間の起点
      h.time.tick(96)
      const mid = h.ctrl.getPose()
      expect(mid.scale).toBeGreaterThan(1)
      expect(mid.scale).toBeLessThan(2)
      h.time.tick(ZOOM_TWEEN_MS + 50)
      expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    })
  })

  // 注: 補間の有無は出力ポーズからは観測できない（同一ポーズ間の補間は見た目が変わらない）ため、
  // 開始時刻の取得（startTween が now() を読む）を spy する実装詳細に依存したテスト。
  it('N2: 開始ポーズと最終ポーズが同じなら補間（開始時刻の取得）を起こさず、全景のままなら ticker も残さない', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', null, false)
    expect(h.time.getPendingTimerCount()).toBe(0)
    h.ctrl.set('Theater', ZOOM_A, true)
    const now = vi.spyOn(h.time, 'now')
    h.ctrl.set('Theater', ZOOM_A, false) // 既に最終ポーズ: 補間を始めない（startTween は now() を読む）
    expect(now).not.toHaveBeenCalled()
    h.ctrl.set('Theater', null, false) // 最終ポーズが違えば補間を始める
    expect(now).toHaveBeenCalled()
  })

  it('S-1: スキップ中の登場・退場は補間せず tick 1 回で最終ポーズ', () => {
    const h = makeHarness()
    h.state.skip = true
    h.ctrl.set('Theater', { target: 'Late', strength: 2 }, true)
    h.focuses.set('Late', { x: 400, y: 250 })
    h.time.tick(16)
    expect(h.ctrl.getPose().scale).toBe(2)
    h.focuses.delete('Late')
    h.time.tick(16)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
  })

  it('タイトル画面: setSuppressed(title) で補間なしに全景、解除で補間なしに戻る。状態は保つ', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, true)
    h.ctrl.setSuppressed('title', true)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    h.time.tick(1000)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    expect(h.ctrl.getZoom()).toEqual(ZOOM_A)
    h.ctrl.setSuppressed('title', false)
    expect(h.ctrl.getPose().scale).toBe(2)
  })

  it('終劇とタイトルの抑制は独立: 片方を解除しても他方が立っている間は全景のまま', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, true)
    h.ctrl.setSuppressed('title', true)
    h.ctrl.setSuppressed('ending', true)
    h.ctrl.setSuppressed('title', false)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    h.ctrl.setSuppressed('ending', false)
    expect(h.ctrl.getPose().scale).toBe(2)
  })

  it('スナップ待ち: snap で set された「居るが未読み込み」の対象は、最初にフォーカスが得られた tick で補間せず最終ポーズ', () => {
    const h = makeHarness()
    h.present.add('Late')
    h.ctrl.set('Theater', { target: 'Late', strength: 2 }, true) // 復元・リセット・スキップ由来
    h.time.tick(160)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    h.focuses.set('Late', { x: 400, y: 250 })
    h.time.tick(16)
    expect(h.ctrl.getPose().scale).toBe(2) // 途中倍率を映さない
  })

  it('M1(i): 対象が未登場のまま snap で set し、その後に登場させると補間する（即ジャンプしない）', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', { target: 'Late', strength: 2 }, true) // 未登場（hasCharacter false）
    h.focuses.set('Late', { x: 400, y: 250 })
    h.time.tick(16)
    h.time.tick(96)
    const s = h.ctrl.getPose().scale
    expect(s).toBeGreaterThan(1)
    expect(s).toBeLessThan(2)
  })

  it('M1: スナップ待ちの最中に対象が破棄されたらフラグを下ろし、後の登場は補間する', () => {
    const h = makeHarness()
    h.present.add('Late')
    h.ctrl.set('Theater', { target: 'Late', strength: 2 }, true)
    h.time.tick(32)
    h.present.delete('Late') // 破棄
    h.time.tick(32)
    h.focuses.set('Late', { x: 400, y: 250 })
    h.time.tick(16)
    h.time.tick(96)
    const s = h.ctrl.getPose().scale
    expect(s).toBeGreaterThan(1)
    expect(s).toBeLessThan(2)
  })

  it('S3: snap 時に既にフォーカスがある対象は、フォーカスを失って再び得たとき補間する（スナップ待ちにならない）', () => {
    const h = makeHarness()
    h.present.add('A') // フォーカスだけ一時的に失う（例: テクスチャ差し替え）状況を再現
    h.ctrl.set('Theater', ZOOM_A, true) // フォーカスあり → スナップ待ちは立たない
    expect(h.ctrl.getPose().scale).toBe(2)
    const f = h.focuses.get('A')!
    h.focuses.delete('A')
    h.time.tick(16)
    h.time.tick(ZOOM_TWEEN_MS + 50)
    h.focuses.set('A', f)
    h.time.tick(16)
    h.time.tick(96)
    const s = h.ctrl.getPose().scale
    expect(s).toBeGreaterThan(1)
    expect(s).toBeLessThan(2)
  })

  it('スナップ待ちは 1 回で下りる: 退場後に再び現れたときは補間する', () => {
    const h = makeHarness()
    h.present.add('Late')
    h.ctrl.set('Theater', { target: 'Late', strength: 2 }, true)
    h.focuses.set('Late', { x: 400, y: 250 })
    h.time.tick(16)
    h.focuses.delete('Late')
    h.present.add('Late') // 意図的なモデル化: 舞台には居るがフォーカスだけ失う（テクスチャ差し替え等）
    h.time.tick(16)
    h.time.tick(ZOOM_TWEEN_MS + 50)
    h.focuses.set('Late', { x: 400, y: 250 })
    h.time.tick(16)
    h.time.tick(96)
    const s = h.ctrl.getPose().scale
    expect(s).toBeGreaterThan(1)
    expect(s).toBeLessThan(2)
  })

  it('通常再生（snap=false）で後から登場する対象は従来どおり補間する', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', { target: 'Late', strength: 2 }, false)
    h.focuses.set('Late', { x: 400, y: 250 })
    h.time.tick(16)
    h.time.tick(96)
    const s = h.ctrl.getPose().scale
    expect(s).toBeGreaterThan(1)
    expect(s).toBeLessThan(2)
  })

  it('S-A: 抑制中に ticker が回った後、tick を挟まず解除→リセットしても、次の通常 set は補間される（即ジャンプしない）', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, true)
    h.ctrl.setSuppressed('ending', true)
    h.time.tick(32) // 抑制中に ticker が回る
    h.ctrl.setSuppressed('ending', false)
    h.ctrl.set('Theater', null, true) // リセット（tick なし。ticker が止まる）
    h.ctrl.set('Theater', ZOOM_A, false)
    h.time.tick(16) // 補間の起点
    h.time.tick(96)
    const s = h.ctrl.getPose().scale
    expect(s).toBeGreaterThan(1)
    expect(s).toBeLessThan(2)
  })

  it('N-A: 無効状態が変わった tick にフォーカスが現れても補間せず即時に最終ポーズ', () => {
    const h = makeHarness()
    h.state.split = true
    h.ctrl.set('Theater', { target: 'Late', strength: 2 }, false) // スナップ待ちではない通常再生
    h.time.tick(16)
    h.state.split = false
    h.focuses.set('Late', { x: 400, y: 250 })
    h.time.tick(16)
    expect(h.ctrl.getPose().scale).toBe(2)
  })

  it('S2: split の変化を tick に拾わせた後、split が true のまま set で ticker を止め、split を戻して set すると補間する（set 側の同期）', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, true)
    h.state.split = true
    h.time.tick(32) // tick が無効状態の変化を拾う（wasDisabled = true）
    h.ctrl.set('Theater', null, true) // split は true のまま: ticker が止まる
    h.state.split = false
    h.ctrl.set('Theater', ZOOM_A, false) // wasDisabled が set で同期されていなければ誤検知する
    h.time.tick(16)
    h.time.tick(96)
    const s = h.ctrl.getPose().scale
    expect(s).toBeGreaterThan(1)
    expect(s).toBeLessThan(2)
  })

  it('N-1: 補間中に split が有効になると補間を打ち切って次の tick で全景へ即時切り替え', () => {
    const h = makeHarness()
    h.ctrl.set('Theater', ZOOM_A, true)
    h.ctrl.set('Theater', null, false) // 全景へ戻る補間（scale 2 → 1）
    h.time.tick(16)
    h.time.tick(96) // 補間の途中
    expect(h.ctrl.getPose().scale).toBeGreaterThan(1)
    expect(h.ctrl.getPose().scale).toBeLessThan(2)
    h.state.split = true
    h.time.tick(16)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
  })

  it('split_layout が途中から有効になっても警告は出ず、次の tick で補間なしに全景へ切り替わる', () => {
    const h = makeHarness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.ctrl.set('Theater', ZOOM_A, true)
    h.state.split = true
    h.time.tick(16)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
    expect(warn).not.toHaveBeenCalled()
  })

  it('N3: dispose 後の set は何もしない（ticker も作らない）', () => {
    const h = makeHarness()
    h.ctrl.dispose()
    h.ctrl.set('Theater', ZOOM_A, false)
    expect(h.ctrl.getZoom()).toBeNull()
    expect(h.time.getPendingTimerCount()).toBe(0)
    expect(h.ctrl.getPose()).toEqual(IDENTITY_ZOOM_POSE)
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
