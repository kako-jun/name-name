/**
 * 旧実装との等価性 (#828 7b)。
 *
 * `OldScreenEffects` は分離前の `NovelRenderer` の画面効果まわり（origin/main f34bf9e4）をそのまま写した
 * 参照実装（oracle）。新しい `ScreenEffectsController` も共有の純粋関数（screenEffects.ts）もここでは使わず、
 * 旧コードの式・順序・タイマーの扱いを意図的に重複させている。同一入力（同じ操作列・同じ固定時刻）から
 * 1フレームごとに取った状態の列（stage 位置・各 Graphics の alpha/visible/描画命令・dialog alpha・暗転）が
 * 完全に一致することを見る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import { ScreenEffectsController } from './ScreenEffectsController'
import { TimeController } from './TimeController'
import { parseHexColor } from './novelLayout'

const W = 1280
const H = 720
const TICK = 1000 / 60

class MockG {
  alpha = 0
  visible = true
  log: string[] = []
  clear(): void {
    this.log.push('clear')
  }
  rect(...a: number[]): void {
    this.log.push(`rect:${a.join(',')}`)
  }
  fill(c: number): void {
    this.log.push(`fill:${c}`)
  }
}

// --- 旧実装の数式（screenEffects.ts を呼ばず写したもの） ---
const clampT = (elapsed: number, dur: number): number => {
  if (!Number.isFinite(dur) || dur <= 0) return 1
  if (!Number.isFinite(elapsed)) return 1
  if (elapsed <= 0) return 0
  return Math.min(1, elapsed / dur)
}
const oldFade = (elapsed: number, from: number, to: number, dur: number) => {
  const t = clampT(elapsed, dur)
  return { alpha: t >= 1 ? to : from + (to - from) * t, done: t >= 1 }
}
const oldShake = (elapsed: number, intensity: number, dur: number) => {
  const t = clampT(elapsed, dur)
  const i = Number.isFinite(intensity) ? intensity : 0
  const decay = 1 - t
  return {
    offsetX: Math.sin(elapsed * 0.05) * i * decay,
    offsetY: Math.cos(elapsed * 0.037) * i * decay * 0.6,
    done: t >= 1,
  }
}
const oldStrobe = (elapsed: number, peak: number, dur: number, count: number, pulse: number) => {
  if (count <= 1) {
    const t = clampT(elapsed, dur)
    return { alpha: peak * (1 - t), done: t >= 1 }
  }
  const total = pulse * (count - 1) + dur
  if (elapsed >= total) return { alpha: 0, done: true }
  const idx = Math.min(count - 1, Math.floor(elapsed / pulse))
  const t = clampT(elapsed - idx * pulse, dur)
  return { alpha: peak * (1 - t), done: false }
}

const SCRIM_ALPHA = 0.5
const RETREAT_MS = 220
const HOLD_MS = 500
const VIS_MS = 180

interface Probe {
  stage: { x: number; y: number }
  dialogAlpha: number
}

class OldScreenEffects {
  effectOverlay = new MockG()
  novelScrim = new MockG()
  blackout = false
  shakeTimer: number | null = null
  effectTimer: number | null = null
  scrimRetreatActive = false
  scrimRetreatTimer: number | null = null
  scrimVisibilityTimer: number | null = null
  constructor(
    private time: TimeController,
    private p: Probe,
    private novel: boolean
  ) {
    this.effectOverlay.visible = false
    this.novelScrim.visible = false
  }
  startShake(intensityPx: number, durationMs: number): void {
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    const shakeStartMs = performance.now()
    const intervalMs = 1000 / 60
    const tick = (): void => {
      const elapsed = performance.now() - shakeStartMs
      const { offsetX, offsetY, done } = oldShake(elapsed, intensityPx, durationMs)
      this.p.stage = { x: offsetX, y: offsetY }
      if (!done) {
        this.shakeTimer = this.time.setTimeout(tick, intervalMs)
      } else {
        this.p.stage = { x: 0, y: 0 }
        this.shakeTimer = null
      }
    }
    tick()
  }
  startFlash(
    colorHex: string,
    peakAlpha: number,
    durationMs: number,
    area: { x: number; y: number; w: number; h: number } | null,
    strobeCount: number,
    intervalMs: number | null
  ): void {
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    const color = parseHexColor(colorHex)
    const c = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
    const rect = area
      ? { x: c(area.x) * W, y: c(area.y) * H, width: c(area.w) * W, height: c(area.h) * H }
      : { x: 0, y: 0, width: W, height: H }
    const o = this.effectOverlay
    o.clear()
    o.rect(rect.x, rect.y, rect.width, rect.height)
    o.fill(color)
    o.alpha = peakAlpha
    o.visible = true
    const startMs = performance.now()
    const pulse = intervalMs ?? durationMs
    this.effectTimer = this.time.setInterval(() => {
      const elapsed = performance.now() - startMs
      const { alpha, done } = oldStrobe(elapsed, peakAlpha, durationMs, strobeCount, pulse)
      o.alpha = alpha
      if (done) {
        o.visible = false
        o.alpha = 0
        if (this.effectTimer) {
          this.time.clearInterval(this.effectTimer)
          this.effectTimer = null
        }
      }
    }, 1000 / 60)
  }
  startFade(colorHex: string, fromAlpha: number, toAlpha: number, durationMs: number): void {
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    const o = this.effectOverlay
    o.clear()
    o.rect(0, 0, W, H)
    o.fill(parseHexColor(colorHex))
    o.alpha = fromAlpha
    o.visible = true
    const startMs = performance.now()
    this.effectTimer = this.time.setInterval(() => {
      const elapsed = performance.now() - startMs
      const { alpha, done } = oldFade(elapsed, fromAlpha, toAlpha, durationMs)
      o.alpha = alpha
      if (done) {
        if (toAlpha <= 0) o.visible = false
        if (this.effectTimer) {
          this.time.clearInterval(this.effectTimer)
          this.effectTimer = null
        }
      }
    }, 1000 / 60)
  }
  startEndStoryBlackoutFade(durationMs: number, onComplete: () => void): void {
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    const o = this.effectOverlay
    o.clear()
    o.rect(0, 0, W, H)
    o.fill(0x000000)
    o.alpha = durationMs > 0 ? 0 : 1
    o.visible = true
    if (durationMs <= 0) {
      onComplete()
      return
    }
    const startMs = this.time.now()
    this.effectTimer = this.time.setInterval(() => {
      const elapsed = this.time.now() - startMs
      const { alpha, done } = oldFade(elapsed, 0, 1, durationMs)
      o.alpha = alpha
      if (done) {
        o.alpha = 1
        if (this.effectTimer) {
          this.time.clearInterval(this.effectTimer)
          this.effectTimer = null
        }
        onComplete()
      }
    }, 1000 / 60)
  }
  private cancelVis(): void {
    if (!this.scrimVisibilityTimer) return
    this.time.clearInterval(this.scrimVisibilityTimer)
    this.scrimVisibilityTimer = null
  }
  private immediate(visible: boolean, alpha: number): void {
    this.cancelVis()
    this.novelScrim.visible = visible
    this.novelScrim.alpha = alpha
  }
  updateNovelScrim(visibleForDialog: boolean): void {
    if (!this.novel) {
      this.immediate(false, 0)
      return
    }
    if (this.scrimRetreatActive) return
    this.cancelVis()
    const target = visibleForDialog ? SCRIM_ALPHA : 0
    const from = this.novelScrim.visible ? this.novelScrim.alpha : 0
    if (from === target) {
      this.novelScrim.visible = visibleForDialog
      this.novelScrim.alpha = target
      return
    }
    this.novelScrim.visible = true
    const startedAt = this.time.now()
    const tick = () => {
      const elapsed = this.time.now() - startedAt
      const { alpha, done } = oldFade(elapsed, from, target, VIS_MS)
      this.novelScrim.alpha = alpha
      if (!done) return
      this.novelScrim.alpha = target
      this.novelScrim.visible = visibleForDialog
      this.cancelVis()
    }
    tick()
    if (!this.scrimVisibilityTimer) {
      this.scrimVisibilityTimer = this.time.setInterval(tick, 1000 / 60)
    }
  }
  resetNovelScrimState(): void {
    this.cancelVis()
    if (this.scrimRetreatTimer) {
      this.time.clearInterval(this.scrimRetreatTimer)
      this.scrimRetreatTimer = null
    }
    this.scrimRetreatActive = false
    this.p.dialogAlpha = 1
    this.immediate(false, 0)
  }
  retreatNovelScrim(holdMs = HOLD_MS): void {
    if (!this.novel) return
    if (!this.novelScrim.visible || this.novelScrim.alpha <= 0) return
    this.cancelVis()
    if (this.scrimRetreatTimer) {
      this.time.clearInterval(this.scrimRetreatTimer)
      this.scrimRetreatTimer = null
    }
    this.scrimRetreatActive = true
    let phase: 0 | 1 | 2 = 0
    let phaseStart = performance.now()
    this.scrimRetreatTimer = this.time.setInterval(() => {
      const elapsed = performance.now() - phaseStart
      if (phase === 0) {
        const { alpha, done } = oldFade(elapsed, SCRIM_ALPHA, 0, RETREAT_MS)
        this.novelScrim.alpha = alpha
        this.p.dialogAlpha = 1 - (SCRIM_ALPHA - alpha) / SCRIM_ALPHA
        if (done) {
          this.novelScrim.alpha = 0
          this.p.dialogAlpha = 0
          phase = 1
          phaseStart = performance.now()
        }
      } else if (phase === 1) {
        if (elapsed >= holdMs) {
          phase = 2
          phaseStart = performance.now()
        }
      } else {
        const { alpha, done } = oldFade(elapsed, 0, SCRIM_ALPHA, RETREAT_MS)
        this.novelScrim.alpha = alpha
        this.p.dialogAlpha = alpha / SCRIM_ALPHA
        if (done) {
          this.novelScrim.alpha = SCRIM_ALPHA
          this.p.dialogAlpha = 1
          if (this.scrimRetreatTimer) {
            this.time.clearInterval(this.scrimRetreatTimer)
            this.scrimRetreatTimer = null
          }
          this.scrimRetreatActive = false
        }
      }
    }, 1000 / 60)
  }
  /** 旧 resetAndStartEvents の画面効果部（stage 位置は戻さない）。 */
  resetForSceneStart(): void {
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    this.effectOverlay.alpha = 0
    this.effectOverlay.visible = false
  }
  /** 旧 applyState / endStory の画面効果部（stage 位置も戻す）。 */
  resetForRestore(): void {
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    this.p.stage = { x: 0, y: 0 }
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    this.effectOverlay.alpha = 0
    this.effectOverlay.visible = false
  }
  destroyTimers(): void {
    if (this.shakeTimer) {
      this.time.clearTimeout(this.shakeTimer)
      this.shakeTimer = null
    }
    if (this.effectTimer) {
      this.time.clearInterval(this.effectTimer)
      this.effectTimer = null
    }
    if (this.scrimRetreatTimer) {
      this.time.clearInterval(this.scrimRetreatTimer)
      this.scrimRetreatTimer = null
    }
    this.cancelVis()
  }
}

/** 操作列。新旧どちらにも同じ呼び出しを流せるよう、共通のインタフェースで書く。 */
interface Ops {
  startShake(i: number, d: number): void
  startFlash(
    c: string,
    p: number,
    d: number,
    a: { x: number; y: number; w: number; h: number } | null,
    n: number,
    iv: number | null
  ): void
  startFade(c: string, f: number, t: number, d: number): void
  endFade(d: number): void
  setScrim(v: boolean): void
  retreat(): void
  resetScrim(): void
  resetSceneStart(): void
  resetRestore(): void
  destroyTimers(): void
  forceScrim(visible: boolean, alpha: number): void
  setBlackout(v: boolean): void
}

type Step = { at: number; run: (o: Ops) => void }

const SCENARIOS: Record<string, { novel: boolean; steps: Step[]; endMs: number }> = {
  'shake→再shake→完了': {
    novel: true,
    endMs: 900,
    steps: [
      { at: 0, run: (o) => o.startShake(12, 400) },
      { at: 100, run: (o) => o.startShake(8, 300) },
    ],
  },
  'flash 単発 area 付き': {
    novel: true,
    endMs: 700,
    steps: [
      {
        at: 0,
        run: (o) => o.startFlash('#ff8800', 0.9, 300, { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, 1, null),
      },
    ],
  },
  'flash ストロボ→fade 割り込み': {
    novel: true,
    endMs: 1500,
    steps: [
      { at: 0, run: (o) => o.startFlash('#ffffff', 0.8, 200, null, 4, 120) },
      { at: 250, run: (o) => o.startFade('#000000', 0.2, 0.7, 400) },
    ],
  },
  'fade to 0 / duration 0': {
    novel: true,
    endMs: 900,
    steps: [
      { at: 0, run: (o) => o.startFade('#112233', 1, 0, 300) },
      { at: 500, run: (o) => o.startFade('#ffffff', 0, 1, 0) },
    ],
  },
  終劇の黒フェード: {
    novel: true,
    endMs: 900,
    steps: [{ at: 50, run: (o) => o.endFade(400) }],
  },
  '終劇の黒フェード duration 0': {
    novel: true,
    endMs: 100,
    steps: [{ at: 0, run: (o) => o.endFade(0) }],
  },
  'scrim 表示→非表示（通常フェード）': {
    novel: true,
    endMs: 1200,
    steps: [
      { at: 0, run: (o) => o.setScrim(true) },
      { at: 100, run: (o) => o.setScrim(false) },
      { at: 600, run: (o) => o.setScrim(true) },
    ],
  },
  'scrim 退避→復帰（途中の update は無視）': {
    novel: true,
    endMs: 1800,
    steps: [
      { at: 0, run: (o) => o.forceScrim(true, SCRIM_ALPHA) },
      { at: 16, run: (o) => o.retreat() },
      { at: 300, run: (o) => o.setScrim(false) },
    ],
  },
  'scrim 退避→途中で reset': {
    novel: true,
    endMs: 1000,
    steps: [
      { at: 0, run: (o) => o.forceScrim(true, SCRIM_ALPHA) },
      { at: 16, run: (o) => o.retreat() },
      { at: 150, run: (o) => o.resetScrim() },
    ],
  },
  'adv では scrim が即消灯・退避しない': {
    novel: false,
    endMs: 300,
    steps: [
      { at: 0, run: (o) => o.forceScrim(true, 0.4) },
      { at: 16, run: (o) => o.retreat() },
      { at: 32, run: (o) => o.setScrim(true) },
    ],
  },
  '揺れ+fade 中に resetSceneStart（stage は戻さない）': {
    novel: true,
    endMs: 700,
    steps: [
      { at: 0, run: (o) => o.startShake(20, 1000) },
      { at: 0, run: (o) => o.startFade('#000000', 0, 1, 1000) },
      { at: 120, run: (o) => o.resetSceneStart() },
    ],
  },
  '揺れ+flash 中に resetRestore（stage も戻す）': {
    novel: true,
    endMs: 700,
    steps: [
      { at: 0, run: (o) => o.startShake(20, 1000) },
      { at: 0, run: (o) => o.startFlash('#ff0000', 1, 1000, null, 3, 100) },
      { at: 120, run: (o) => o.resetRestore() },
    ],
  },
  '全 timer 稼働中に destroyTimers': {
    novel: true,
    endMs: 700,
    steps: [
      { at: 0, run: (o) => o.startShake(20, 1000) },
      { at: 0, run: (o) => o.startFlash('#ff0000', 1, 1000, null, 3, 100) },
      { at: 0, run: (o) => o.forceScrim(true, SCRIM_ALPHA) },
      { at: 16, run: (o) => o.retreat() },
      { at: 150, run: (o) => o.destroyTimers() },
    ],
  },
  'scrim 通常フェード途中（退避なし）に destroyTimers': {
    novel: true,
    endMs: 400,
    steps: [
      { at: 0, run: (o) => o.setScrim(true) },
      { at: 50, run: (o) => o.destroyTimers() },
    ],
  },
  '暗転 on/off': {
    novel: true,
    endMs: 100,
    steps: [
      { at: 0, run: (o) => o.setBlackout(true) },
      { at: 50, run: (o) => o.setBlackout(false) },
    ],
  },
}

type Frame = unknown

function runNew(name: string): Frame[] {
  const sc = SCENARIOS[name]
  vi.useFakeTimers()
  const probe: Probe = { stage: { x: 0, y: 0 }, dialogAlpha: 1 }
  const seek: boolean[] = []
  const time = new TimeController()
  time.setMode('virtual')
  const fx = new ScreenEffectsController(
    {
      getScreenSize: () => ({ width: W, height: H }),
      setStagePosition: (x, y) => {
        probe.stage = { x, y }
      },
      isNovelStyle: () => sc.novel,
      setDialogAlpha: (a) => {
        probe.dialogAlpha = a
      },
      setSeekBarBlackoutHidden: (h) => seek.push(h),
    },
    time
  )
  fx.attachTo(new Container())
  const inner = fx as unknown as { effectOverlay: MockG; novelScrim: MockG }
  inner.effectOverlay = new MockG()
  inner.effectOverlay.visible = false
  inner.novelScrim = new MockG()
  inner.novelScrim.visible = false
  const ops: Ops = {
    startShake: (i, d) => fx.startShake(i, d),
    startFlash: (c, p, d, a, n, iv) => fx.startFlash(c, p, d, a, n, iv),
    startFade: (c, f, t, d) => fx.startFade('all', c, f, t, d),
    endFade: (d) => fx.startEndStoryBlackoutFade(d, () => frames.push('end-story-complete')),
    setScrim: (v) => fx.updateNovelScrim(v),
    retreat: () => fx.retreatNovelScrim(),
    resetScrim: () => fx.resetNovelScrimState(),
    resetSceneStart: () => fx.reset(),
    resetRestore: () => {
      fx.reset()
      fx.resetStagePosition()
    },
    destroyTimers: () => fx.stopAllTimers(),
    forceScrim: (v, a) => {
      inner.novelScrim.visible = v
      inner.novelScrim.alpha = a
    },
    setBlackout: (v) => fx.setBlackout(v),
  }
  const frames: Frame[] = []
  const snap = (): Frame => ({
    stage: probe.stage,
    dialog: probe.dialogAlpha,
    fx: [inner.effectOverlay.alpha, inner.effectOverlay.visible, inner.effectOverlay.log.join('|')],
    scrim: [inner.novelScrim.alpha, inner.novelScrim.visible],
    black: fx.capture().isBlackout,
    seek: seek.join(','),
    pending: time.getPendingTimerCount(),
  })
  drive(
    sc,
    ops,
    (ms) => {
      vi.advanceTimersByTime(ms)
      time.tick(ms)
    },
    () => frames.push(snap())
  )
  return frames
}

function runOld(name: string): Frame[] {
  const sc = SCENARIOS[name]
  vi.useFakeTimers()
  const probe: Probe = { stage: { x: 0, y: 0 }, dialogAlpha: 1 }
  const time = new TimeController()
  time.setMode('virtual')
  const old = new OldScreenEffects(time, probe, sc.novel)
  let blackout = false
  const seek: boolean[] = [false] // attachTo 時の setBlackout(false)
  const frames: Frame[] = []
  const ops: Ops = {
    startShake: (i, d) => old.startShake(i, d),
    startFlash: (c, p, d, a, n, iv) => old.startFlash(c, p, d, a, n, iv),
    startFade: (c, f, t, d) => old.startFade(c, f, t, d),
    endFade: (d) => old.startEndStoryBlackoutFade(d, () => frames.push('end-story-complete')),
    setScrim: (v) => old.updateNovelScrim(v),
    retreat: () => old.retreatNovelScrim(),
    resetScrim: () => old.resetNovelScrimState(),
    resetSceneStart: () => old.resetForSceneStart(),
    resetRestore: () => old.resetForRestore(),
    destroyTimers: () => old.destroyTimers(),
    forceScrim: (v, a) => {
      old.novelScrim.visible = v
      old.novelScrim.alpha = a
    },
    setBlackout: (v) => {
      blackout = v
      seek.push(v)
    },
  }
  const snap = (): Frame => ({
    stage: probe.stage,
    dialog: probe.dialogAlpha,
    fx: [old.effectOverlay.alpha, old.effectOverlay.visible, old.effectOverlay.log.join('|')],
    scrim: [old.novelScrim.alpha, old.novelScrim.visible],
    black: blackout,
    seek: seek.join(','),
    pending: time.getPendingTimerCount(),
  })
  drive(
    sc,
    ops,
    (ms) => {
      vi.advanceTimersByTime(ms)
      time.tick(ms)
    },
    () => frames.push(snap())
  )
  return frames
}

/** 1フレーム（1/60 秒）刻みで進め、各フレームの前に「その時刻の操作」を流し、フレームごとに状態を取る。 */
function drive(
  sc: { steps: Step[]; endMs: number },
  ops: Ops,
  advance: (ms: number) => void,
  snap: () => void
): void {
  let t = 0
  const pending = [...sc.steps].sort((a, b) => a.at - b.at)
  while (t <= sc.endMs) {
    while (pending.length > 0 && pending[0].at <= t) pending.shift()!.run(ops)
    snap()
    advance(TICK)
    t += TICK
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ScreenEffectsController は分離前の実装と同一入力で同一状態列になる (#828 7b)', () => {
  for (const name of Object.keys(SCENARIOS)) {
    it(name, () => {
      const oldFrames = runOld(name)
      vi.useRealTimers()
      const newFrames = runNew(name)
      expect(newFrames.length).toBeGreaterThan(5)
      expect(newFrames).toEqual(oldFrames)
    })
  }

  it('比較器の陽性対照: 参照側のタイミング定数を少しずらすと不一致になる', () => {
    const oldFrames = runOld('scrim 退避→復帰（途中の update は無視）')
    vi.useRealTimers()
    const newFrames = runNew('scrim 退避→復帰（途中の update は無視）')
    expect(newFrames).toEqual(oldFrames)
    // 末尾の1フレームの dialog alpha をずらしただけで toEqual が落ちること
    const tampered = structuredClone(oldFrames) as Array<{ dialog: number }>
    tampered[tampered.length - 1].dialog += 0.001
    expect(newFrames).not.toEqual(tampered)
  })
})
