import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import {
  NOVEL_SCRIM_ALPHA,
  NOVEL_SCRIM_HOLD_MS,
  NOVEL_SCRIM_RETREAT_MS,
  NOVEL_SCRIM_VISIBILITY_FADE_MS,
  ScreenEffectsController,
  type ScreenEffectsHost,
} from './ScreenEffectsController'
import { computeFlashAreaRect, computeShakeOffset } from './screenEffects'
import { parseHexColor, type LayoutRect } from './novelLayout'
import { TimeController } from './TimeController'

// ---- テスト用の最小 Graphics。alpha/visible と描画命令の履歴だけを持つ ----
class MockGraphics {
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

interface FxInternals {
  effectOverlay: MockGraphics | null
  novelScrim: MockGraphics | null
  shakeTimer: number | null
  effectTimer: number | null
  scrimRetreatActive: boolean
  scrimRetreatTimer: number | null
  scrimVisibilityTimer: number | null
}

const W = 1280
const H = 720
const TICK = 1000 / 60

function setup(opts: { novel?: boolean; mockGraphics?: boolean } = {}) {
  const state = {
    novel: opts.novel ?? true,
    stage: { x: 0, y: 0 },
    dialogAlpha: 1,
    seekHidden: [] as boolean[],
  }
  const host: ScreenEffectsHost = {
    getScreenSize: () => ({ width: W, height: H }),
    setStagePosition: (x, y) => {
      state.stage = { x, y }
    },
    isNovelStyle: () => state.novel,
    setDialogAlpha: (a) => {
      state.dialogAlpha = a
    },
    setSeekBarBlackoutHidden: (h) => {
      state.seekHidden.push(h)
    },
  }
  const time = new TimeController()
  time.setMode('virtual')
  const fx = new ScreenEffectsController(host, time)
  const inner = fx as unknown as FxInternals
  const stage = new Container()
  fx.attachTo(stage)
  if (opts.mockGraphics !== false) {
    // 実 Graphics は alpha/visible 以外の観測が難しいので、描画履歴を取れるフェイクへ差し替える。
    inner.effectOverlay = new MockGraphics()
    inner.novelScrim = new MockGraphics()
    inner.novelScrim.visible = false
  }
  /**
   * performance.now()（fake）と TimeController（virtual）を同じ ms だけ進める。1フレーム刻みで進める
   * （一括で進めると performance.now() だけ先に終端へ飛び、フェーズ遷移のある退避が畳まれてしまう）。
   */
  const advance = (ms: number): void => {
    let left = ms
    while (left > 0) {
      const step = Math.min(left, TICK)
      vi.advanceTimersByTime(step)
      time.tick(step)
      left -= step
    }
  }
  return { fx, inner, state, time, stage, advance }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ScreenEffectsController 組み立て・状態の出し入れ (#828 7b)', () => {
  it('attachTo は スクリム → 暗転 → 画面効果 の順に連続して積み、初期は全部消灯している', () => {
    vi.useFakeTimers()
    const { fx, stage, state } = setup({ mockGraphics: false })
    expect(stage.children.length).toBe(3)
    expect(stage.children[1]).toBe(fx.blackoutOverlay)
    const [scrim, black, effect] = stage.children as unknown as Array<{
      visible: boolean
      alpha: number
    }>
    expect(scrim.visible).toBe(false)
    expect(scrim.alpha).toBe(0)
    expect(black.visible).toBe(false)
    expect(effect.visible).toBe(false)
    expect(effect.alpha).toBe(0)
    // 暗転オフで SeekBar の可視ゲートも同期される
    expect(state.seekHidden).toEqual([false])
  })

  it('init 前（attachTo 前）は フラッシュ/フェード/スクリム系が例外なく no-op で、終劇フェードは即 onComplete', () => {
    const host: ScreenEffectsHost = {
      getScreenSize: () => ({ width: W, height: H }),
      setStagePosition: () => {},
      isNovelStyle: () => true,
      setDialogAlpha: () => {},
      setSeekBarBlackoutHidden: () => {},
    }
    const time = new TimeController()
    time.setMode('virtual')
    const fx = new ScreenEffectsController(host, time)
    fx.startFlash('#ffffff', 1, 100, null, 1, null)
    fx.startFade('all', '#000000', 0, 1, 100)
    fx.updateNovelScrim(true)
    fx.retreatNovelScrim()
    fx.resetNovelScrimState()
    fx.hideNovelScrim()
    fx.applyNovelScrimRegion({ x: 1, y: 2, width: 3, height: 4 })
    fx.resetNovelScrimRegion()
    fx.reset()
    expect(time.getPendingTimerCount()).toBe(0)
    const done = vi.fn()
    fx.startEndStoryBlackoutFade(500, done)
    expect(done).toHaveBeenCalledTimes(1)
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('暗転の capture / restore は isBlackout だけを出し入れし、SeekBar ゲートも同期する', () => {
    const { fx, state } = setup()
    expect(fx.capture()).toEqual({ isBlackout: false })
    fx.setBlackout(true)
    expect(fx.capture()).toEqual({ isBlackout: true })
    fx.restore({ isBlackout: false })
    expect(fx.capture()).toEqual({ isBlackout: false })
    fx.restore({ isBlackout: true })
    expect(fx.blackoutOverlay.visible).toBe(true)
    expect(state.seekHidden.slice(-3)).toEqual([true, false, true])
    // 揺れ・フラッシュ・フェード・スクリムは capture に含まれない
    expect(Object.keys(fx.capture())).toEqual(['isBlackout'])
  })
})

describe('ScreenEffectsController 揺れ・フラッシュ・フェード', () => {
  it('揺れは computeShakeOffset どおりに stage を動かし、終わると (0,0) に戻って timer が空になる', () => {
    vi.useFakeTimers()
    const { fx, inner, state, advance, time } = setup()
    fx.startShake(10, 200)
    // 開始直後（elapsed=0）の1フレーム目は同期で適用される
    expect(state.stage).toEqual({
      x: computeShakeOffset(0, 10, 200).offsetX,
      y: computeShakeOffset(0, 10, 200).offsetY,
    })
    expect(inner.shakeTimer).not.toBeNull()
    advance(TICK * 3)
    const e = performance.now()
    const o = computeShakeOffset(e, 10, 200)
    expect(state.stage.x).not.toBe(0)
    expect(o.done).toBe(false)
    advance(400)
    expect(state.stage).toEqual({ x: 0, y: 0 })
    expect(inner.shakeTimer).toBeNull()
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('揺れの再開始は前の揺れの timer を破棄する（二重駆動しない）', () => {
    vi.useFakeTimers()
    const { fx, advance, time } = setup()
    fx.startShake(10, 1000)
    advance(TICK * 2)
    fx.startShake(10, 1000)
    expect(time.getPendingTimerCount()).toBe(1)
  })

  it('フラッシュは終了で不可視・alpha 0 に戻り、timer が空になる。area は px 矩形に変換される', () => {
    vi.useFakeTimers()
    const { fx, inner, advance, time } = setup()
    fx.startFlash('#ff0000', 0.9, 200, { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1, null)
    const ov = inner.effectOverlay!
    const rect = computeFlashAreaRect({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, W, H)
    expect(ov.log).toEqual([
      'clear',
      `rect:${rect.x},${rect.y},${rect.width},${rect.height}`,
      `fill:${parseHexColor('#ff0000')}`,
    ])
    expect(ov.alpha).toBe(0.9)
    expect(ov.visible).toBe(true)
    advance(TICK * 4)
    // 減衰中: ピークより下がり、0 より上。経過に対し単調に下がる
    const mid = ov.alpha
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(0.9)
    advance(TICK * 2)
    expect(ov.alpha).toBeLessThan(mid)
    advance(500)
    expect(ov.visible).toBe(false)
    expect(ov.alpha).toBe(0)
    expect(inner.effectTimer).toBeNull()
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('フェードは toAlpha=0 のとき不可視に戻し、toAlpha>0 のときは残す', () => {
    vi.useFakeTimers()
    const a = setup()
    a.fx.startFade('all', '#000000', 1, 0, 100)
    expect(a.inner.effectOverlay!.alpha).toBe(1)
    a.advance(300)
    expect(a.inner.effectOverlay!.visible).toBe(false)
    expect(a.inner.effectOverlay!.alpha).toBe(0)
    expect(a.inner.effectTimer).toBeNull()

    const b = setup()
    b.fx.startFade('all', '#ffffff', 0, 0.6, 100)
    b.advance(300)
    expect(b.inner.effectOverlay!.visible).toBe(true)
    expect(b.inner.effectOverlay!.alpha).toBe(0.6)
    expect(b.inner.effectTimer).toBeNull()
  })

  it('duration 0 のフェードは最初の tick で toAlpha に確定する（即時化）', () => {
    vi.useFakeTimers()
    const { fx, inner, advance } = setup()
    fx.startFade('all', '#000000', 0, 1, 0)
    advance(TICK + 1)
    expect(inner.effectOverlay!.alpha).toBe(1)
    expect(inner.effectTimer).toBeNull()
  })

  it('フラッシュとフェードは effectTimer を共有し、後発が前の timer を止める', () => {
    vi.useFakeTimers()
    const { fx, advance, time, inner } = setup()
    fx.startFlash('#ffffff', 0.8, 1000, null, 5, 100)
    advance(TICK * 2)
    fx.startFade('all', '#000000', 0, 0.5, 1000)
    expect(time.getPendingTimerCount()).toBe(1)
    advance(2000)
    expect(inner.effectOverlay!.alpha).toBe(0.5)
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('フラッシュの連続発火・フェードの連続発火・終劇フェードの割り込みでも effect timer は常に1本', () => {
    vi.useFakeTimers()
    const { fx, advance, time } = setup()
    fx.startFlash('#ffffff', 0.8, 1000, null, 1, null)
    advance(TICK * 2)
    fx.startFlash('#ff0000', 0.8, 1000, null, 1, null)
    expect(time.getPendingTimerCount()).toBe(1)
    fx.startFade('all', '#000000', 0, 1, 1000)
    advance(TICK * 2)
    fx.startFade('all', '#000000', 1, 0, 1000)
    expect(time.getPendingTimerCount()).toBe(1)
    fx.startEndStoryBlackoutFade(1000, () => {})
    expect(time.getPendingTimerCount()).toBe(1)
  })

  it('終劇の黒フェードは 0→1 で補間し、完了で onComplete を1回だけ呼ぶ。duration 0 なら即 1 で完了', () => {
    vi.useFakeTimers()
    const a = setup()
    const done = vi.fn()
    a.fx.startEndStoryBlackoutFade(300, done)
    expect(a.inner.effectOverlay!.alpha).toBe(0)
    expect(a.inner.effectOverlay!.visible).toBe(true)
    expect(a.inner.effectOverlay!.log).toEqual(['clear', `rect:0,0,${W},${H}`, 'fill:0'])
    a.advance(TICK * 6)
    const midAlpha = a.inner.effectOverlay!.alpha
    expect(midAlpha).toBeGreaterThan(0)
    expect(midAlpha).toBeLessThan(1)
    expect(done).not.toHaveBeenCalled()
    a.advance(1000)
    expect(a.inner.effectOverlay!.alpha).toBe(1)
    expect(done).toHaveBeenCalledTimes(1)
    expect(a.inner.effectTimer).toBeNull()

    const b = setup()
    const done0 = vi.fn()
    b.fx.startEndStoryBlackoutFade(0, done0)
    expect(b.inner.effectOverlay!.alpha).toBe(1)
    expect(done0).toHaveBeenCalledTimes(1)
    expect(b.time.getPendingTimerCount()).toBe(0)
  })
})

describe('ScreenEffectsController reset / destroy の止め方', () => {
  it('reset は 揺れ・効果 timer を止めてオーバーレイを消すが、stage 位置は戻さない', () => {
    vi.useFakeTimers()
    const { fx, inner, state, advance, time } = setup()
    fx.startShake(20, 1000)
    fx.startFade('all', '#000000', 0, 1, 1000)
    advance(TICK * 3)
    const stageBefore = { ...state.stage }
    expect(stageBefore.x).not.toBe(0)
    fx.reset()
    expect(inner.shakeTimer).toBeNull()
    expect(inner.effectTimer).toBeNull()
    expect(inner.effectOverlay).toMatchObject({ alpha: 0, visible: false })
    expect(time.getPendingTimerCount()).toBe(0)
    expect(state.stage).toEqual(stageBefore)
    advance(2000)
    expect(state.stage).toEqual(stageBefore)
    fx.resetStagePosition()
    expect(state.stage).toEqual({ x: 0, y: 0 })
  })

  it('hideEffectOverlay は timer に触らずオーバーレイだけ消す', () => {
    vi.useFakeTimers()
    const { fx, inner, time } = setup()
    fx.startFade('all', '#000000', 0, 1, 1000)
    fx.hideEffectOverlay()
    expect(inner.effectOverlay).toMatchObject({ alpha: 0, visible: false })
    expect(inner.effectTimer).not.toBeNull()
    expect(time.getPendingTimerCount()).toBe(1)
  })

  it('stopAllTimers は 揺れ・効果・スクリム退避・スクリム通常フェード の全 timer を止める（destroy 後に残らない）', () => {
    vi.useFakeTimers()
    const { fx, inner, advance, time } = setup()
    fx.startShake(10, 5000)
    fx.startFlash('#ffffff', 1, 5000, null, 3, 100)
    // スクリム通常フェード
    fx.updateNovelScrim(true)
    expect(inner.scrimVisibilityTimer).not.toBeNull()
    advance(TICK * 20)
    // 退避を始めるには scrim が表示中でなければならない
    inner.novelScrim!.visible = true
    inner.novelScrim!.alpha = NOVEL_SCRIM_ALPHA
    fx.retreatNovelScrim()
    expect(inner.scrimRetreatTimer).not.toBeNull()
    expect(time.getPendingTimerCount()).toBeGreaterThanOrEqual(3)
    fx.stopAllTimers()
    expect(inner.shakeTimer).toBeNull()
    expect(inner.effectTimer).toBeNull()
    expect(inner.scrimRetreatTimer).toBeNull()
    expect(inner.scrimVisibilityTimer).toBeNull()
    expect(time.getPendingTimerCount()).toBe(0)
    const a = inner.effectOverlay!.alpha
    const s = inner.novelScrim!.alpha
    advance(5000)
    expect(inner.effectOverlay!.alpha).toBe(a)
    expect(inner.novelScrim!.alpha).toBe(s)
  })
})

describe('ScreenEffectsController stopAllTimers スクリム通常フェード単独', () => {
  it('通常フェード途中（退避なし）に stopAllTimers すると scrimVisibilityTimer が null で pending 0', () => {
    vi.useFakeTimers()
    const { fx, inner, advance, time } = setup()
    fx.updateNovelScrim(true)
    advance(TICK * 3) // フェード（180ms）の途中
    expect(inner.scrimVisibilityTimer).not.toBeNull()
    expect(time.getPendingTimerCount()).toBe(1)
    fx.stopAllTimers()
    expect(inner.scrimVisibilityTimer).toBeNull()
    expect(time.getPendingTimerCount()).toBe(0)
    const s = inner.novelScrim!.alpha
    advance(1000)
    expect(inner.novelScrim!.alpha).toBe(s)
  })
})

describe('ScreenEffectsController novel スクリム', () => {
  it('novel のセリフ表示で NOVEL_SCRIM_VISIBILITY_FADE_MS かけて 0→ALPHA、非表示で ALPHA→0 かつ消灯', () => {
    vi.useFakeTimers()
    const { fx, inner, advance } = setup()
    fx.updateNovelScrim(true)
    expect(inner.novelScrim).toMatchObject({ visible: true, alpha: 0 })
    advance(NOVEL_SCRIM_VISIBILITY_FADE_MS / 2)
    expect(inner.novelScrim!.alpha).toBeGreaterThan(0)
    expect(inner.novelScrim!.alpha).toBeLessThan(NOVEL_SCRIM_ALPHA)
    advance(NOVEL_SCRIM_VISIBILITY_FADE_MS)
    expect(inner.novelScrim).toMatchObject({ visible: true, alpha: NOVEL_SCRIM_ALPHA })
    expect(inner.scrimVisibilityTimer).toBeNull()
    fx.updateNovelScrim(false)
    advance(NOVEL_SCRIM_VISIBILITY_FADE_MS * 2)
    expect(inner.novelScrim).toMatchObject({ visible: false, alpha: 0 })
  })

  it('adv では updateNovelScrim が即時に消灯し、フェードを始めない', () => {
    vi.useFakeTimers()
    const { fx, inner, time } = setup({ novel: false })
    inner.novelScrim!.visible = true
    inner.novelScrim!.alpha = 0.4
    fx.updateNovelScrim(true)
    expect(inner.novelScrim).toMatchObject({ visible: false, alpha: 0 })
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('hideNovelScrim は表示中でも即時消灯し、進行中のフェード timer を止める', () => {
    vi.useFakeTimers()
    const { fx, inner, time } = setup()
    fx.updateNovelScrim(true)
    fx.hideNovelScrim()
    expect(inner.novelScrim).toMatchObject({ visible: false, alpha: 0 })
    expect(inner.scrimVisibilityTimer).toBeNull()
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('退避: 0 まで下げ → HOLD → 復帰。その間 dialog alpha も連動し、updateNovelScrim は触らない', () => {
    vi.useFakeTimers()
    const { fx, inner, state, advance } = setup()
    inner.novelScrim!.visible = true
    inner.novelScrim!.alpha = NOVEL_SCRIM_ALPHA
    fx.retreatNovelScrim()
    expect(fx.isScrimRetreatActive()).toBe(true)
    advance(NOVEL_SCRIM_RETREAT_MS / 2)
    expect(inner.novelScrim!.alpha).toBeLessThan(NOVEL_SCRIM_ALPHA)
    expect(state.dialogAlpha).toBeLessThan(1)
    // 退避中の updateNovelScrim は no-op（フェードが制御する）
    const before = inner.novelScrim!.alpha
    fx.updateNovelScrim(false)
    expect(inner.novelScrim!.alpha).toBe(before)
    expect(inner.scrimVisibilityTimer).toBeNull()
    advance(NOVEL_SCRIM_RETREAT_MS * 2 + TICK * 3)
    expect(inner.novelScrim!.alpha).toBe(0)
    expect(state.dialogAlpha).toBe(0)
    // HOLD 中は 0 のまま
    advance(100)
    expect(inner.novelScrim!.alpha).toBe(0)
    advance(NOVEL_SCRIM_HOLD_MS + NOVEL_SCRIM_RETREAT_MS * 2)
    expect(inner.novelScrim!.alpha).toBe(NOVEL_SCRIM_ALPHA)
    expect(state.dialogAlpha).toBe(1)
    expect(fx.isScrimRetreatActive()).toBe(false)
    expect(inner.scrimRetreatTimer).toBeNull()
  })

  it('退避しない条件: adv / スクリム未表示 / alpha 0 / 未生成', () => {
    vi.useFakeTimers()
    const adv = setup({ novel: false })
    adv.inner.novelScrim!.visible = true
    adv.inner.novelScrim!.alpha = NOVEL_SCRIM_ALPHA
    adv.fx.retreatNovelScrim()
    expect(adv.fx.isScrimRetreatActive()).toBe(false)

    const hidden = setup()
    hidden.fx.retreatNovelScrim()
    expect(hidden.fx.isScrimRetreatActive()).toBe(false)
    expect(hidden.time.getPendingTimerCount()).toBe(0)

    const zero = setup()
    zero.inner.novelScrim!.visible = true
    zero.inner.novelScrim!.alpha = 0
    zero.fx.retreatNovelScrim()
    expect(zero.fx.isScrimRetreatActive()).toBe(false)
  })

  it('退避の再入は前の退避 timer を破棄する（二重駆動しない）', () => {
    vi.useFakeTimers()
    const { fx, inner, time, advance } = setup()
    inner.novelScrim!.visible = true
    inner.novelScrim!.alpha = NOVEL_SCRIM_ALPHA
    fx.retreatNovelScrim()
    advance(TICK * 3)
    fx.retreatNovelScrim()
    expect(time.getPendingTimerCount()).toBe(1)
  })

  it('resetNovelScrimState は退避途中でも timer を止め、dialog alpha=1・スクリム消灯・退避フラグ解除に倒す', () => {
    vi.useFakeTimers()
    const { fx, inner, state, advance, time } = setup()
    inner.novelScrim!.visible = true
    inner.novelScrim!.alpha = NOVEL_SCRIM_ALPHA
    fx.retreatNovelScrim()
    advance(NOVEL_SCRIM_RETREAT_MS / 2)
    expect(state.dialogAlpha).toBeLessThan(1)
    fx.resetNovelScrimState()
    expect(fx.isScrimRetreatActive()).toBe(false)
    expect(state.dialogAlpha).toBe(1)
    expect(inner.novelScrim).toMatchObject({ visible: false, alpha: 0 })
    expect(time.getPendingTimerCount()).toBe(0)
    advance(5000)
    expect(inner.novelScrim).toMatchObject({ visible: false, alpha: 0 })
  })

  it('スクリム矩形: 領域指定で絞り、reset で画面全体に戻る', () => {
    vi.useFakeTimers()
    const { fx, inner } = setup()
    const region: LayoutRect = { x: 640, y: 0, width: 640, height: 720 }
    fx.applyNovelScrimRegion(region)
    expect(inner.novelScrim!.log).toEqual(['clear', 'rect:640,0,640,720', 'fill:0'])
    inner.novelScrim!.log = []
    fx.resetNovelScrimRegion()
    expect(inner.novelScrim!.log).toEqual(['clear', `rect:0,0,${W},${H}`, 'fill:0'])
  })
})
