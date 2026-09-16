/**
 * NovelRenderer Flash area/strobe/interval 配線統合テスト (#693)。
 *
 * alpha/矩形の計算式自体（境界値込み）は screenEffects.test.ts の computeFlashAreaRect /
 * computeStrobeFlashAlpha が純粋関数として精密に検証済み。ここでは NovelRenderer 側の配線
 * （processDirective → private startFlash → effectOverlay への反映）だけを検証する。
 *
 * `startFlash` は他の画面効果（Shake/Fade も同様）と同じく `performance.now()` を直接読んで
 * 経過時間を計算する（#143 由来の既存実装。`startEndStoryBlackoutFade` のような
 * `this.time.now()` 経由ではない）ため、virtual TimeController の tick() だけでは経過時間を
 * 進められない。時間経過を伴うテスト（ストロボ/割り込み）だけ `vi.useFakeTimers()` で
 * `performance.now()` を偽の壁時計として進めつつ、`TimeController` は virtual モードにして
 * `tick()` で同じ ms だけ仮想スケジューラを進める（NovelRenderer.tachieTiming.test.ts の
 * fake timers 手法と、PropLayer.test.ts 等の virtual TimeController 手法を組み合わせる）。
 *
 * `NovelRenderer.exitFade.test.ts` と同じ最小駆動: `new NovelRenderer()` のみで、
 * private `processDirective` を internals キャストで直接呼ぶ（setScenes/playScript は経由しない）。
 * effectOverlay は init() でしか実体生成されないため、NovelRenderer.confinement.test.ts と
 * 同じ流儀でモックを注入する。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { TimeController } from './TimeController'
import type { Event, FlashArea } from '../types'

interface EffectOverlayMock {
  alpha: number
  visible: boolean
  clear: () => void
  rect: (...args: unknown[]) => void
  fill: (...args: unknown[]) => void
}

interface RendererInternals {
  processDirective(event: Event): void
  effectOverlay: EffectOverlayMock | null
  screenWidth: number
  screenHeight: number
  time: TimeController
}

function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

function installEffectOverlay(r: NovelRenderer): EffectOverlayMock {
  const overlay: EffectOverlayMock = {
    alpha: 0,
    visible: false,
    clear: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
  }
  internals(r).effectOverlay = overlay
  return overlay
}

function flash(over: {
  color?: string
  alpha?: number
  duration_ms?: number
  area?: FlashArea
  strobe?: number
  interval_ms?: number
}): Event {
  return {
    Flash: {
      color: '#ffffff',
      alpha: 0.8,
      duration_ms: 300,
      strobe: 1,
      ...over,
    },
  } as Event
}

/**
 * `performance.now()`（fake timers）と TimeController（virtual モード）を同じ ms だけ
 * 同時に進める。前者は startFlash の経過時間計算、後者は effectTimer(setInterval) の
 * 発火タイミングを担う。両方を同期させないと片方だけ進んでも意味がない。
 */
function advanceBoth(time: TimeController, ms: number): void {
  vi.advanceTimersByTime(ms)
  time.tick(ms)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('NovelRenderer Flash area/strobe/interval 配線 (#693)', () => {
  it('後方互換: area 省略時は従来通り全画面 (0,0,screenWidth,screenHeight) にフラッシュする', () => {
    const r = new NovelRenderer()
    const overlay = installEffectOverlay(r)
    const { screenWidth, screenHeight } = internals(r)

    internals(r).processDirective(flash({ color: '#ff0000', alpha: 0.9, duration_ms: 200 }))

    expect(overlay.rect).toHaveBeenCalledWith(0, 0, screenWidth, screenHeight)
    expect(overlay.alpha).toBeCloseTo(0.9, 5)
    expect(overlay.visible).toBe(true)
  })

  it('area 指定時は computeFlashAreaRect で変換した px 矩形で effectOverlay.rect が呼ばれる', () => {
    const r = new NovelRenderer()
    const overlay = installEffectOverlay(r)
    const { screenWidth, screenHeight } = internals(r)

    internals(r).processDirective(flash({ area: { x: 0.2, y: 0.3, w: 0.3, h: 0.4 } }))

    expect(overlay.rect).toHaveBeenCalledWith(
      screenWidth * 0.2,
      screenHeight * 0.3,
      screenWidth * 0.3,
      screenHeight * 0.4
    )
  })

  it('strobe>1（interval<duration）は単発フラッシュと違い、減衰の谷の後にピーク付近へ戻る（複数パルスの証拠）', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    const overlay = installEffectOverlay(r)
    internals(r).time.setMode('virtual')
    const time = internals(r).time

    const peak = 0.8
    internals(r).processDirective(
      flash({ alpha: peak, duration_ms: 200, strobe: 3, interval_ms: 100 })
    )
    expect(overlay.alpha).toBeCloseTo(peak, 5) // 開始直後はピーク

    const FPS_TICK_MS = 1000 / 60
    const history: number[] = []
    for (let i = 0; i < 27; i++) {
      advanceBoth(time, FPS_TICK_MS)
      history.push(overlay.alpha)
    }

    // 単発フラッシュ（computeFlashAlpha）なら単調減少して 0 で止まるだけのはず。
    // strobe のパルス再開があれば、減衰の途中で前の値より明確に高い値へ戻る箇所が現れる
    // （interval(100ms) < duration(200ms) なので、完全に 0 まで減衰しきる前に次のパルスが
    // ピークへ戻る、screenEffects.ts の doc comment が明示する意図的な仕様）。
    const hasRise = history.some((v, i) => i > 0 && v > history[i - 1] + peak * 0.3)
    expect(hasRise).toBe(true)

    // 十分時間が経てば最終的に消灯する（3パルス完了後）。
    advanceBoth(time, 500)
    expect(overlay.visible).toBe(false)
    expect(overlay.alpha).toBe(0)
  })

  it('ストロボ実行中に新しい Flash が発火すると、effectTimer 共有により現在のシーケンスは即座に中断される（現状仕様の固定）', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    const overlay = installEffectOverlay(r)
    internals(r).time.setMode('virtual')
    const time = internals(r).time

    // 1つ目: 長いストロボ（10連, interval=50ms, duration=300ms → 数百ms は続くはず）。
    internals(r).processDirective(
      flash({ color: '#ff0000', alpha: 0.8, duration_ms: 300, strobe: 10, interval_ms: 50 })
    )
    advanceBoth(time, 60) // 1回目パルスの途中まで進める（まだ完了していない）

    // 2つ目（単発）が割り込む。
    internals(r).processDirective(
      flash({ color: '#00ff00', alpha: 0.5, duration_ms: 80, strobe: 1 })
    )
    // 割り込み直後は新しい Flash のピークに即座に置き換わる。
    expect(overlay.alpha).toBeCloseTo(0.5, 5)

    // 新しい Flash 自体の duration(80ms) を大きく超えて進めても、
    // 元の10連ストロボの残りパルスが復活してピークへ戻ることはない（完全に破棄されている）。
    advanceBoth(time, 1000)
    expect(overlay.visible).toBe(false)
    expect(overlay.alpha).toBe(0)
  })
})
