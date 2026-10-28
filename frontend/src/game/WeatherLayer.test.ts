/**
 * WeatherLayer（雨・雪・桜吹雪 #706）の単体テスト。仮想時間の TimeController で時計を進め、
 * 決定論（同じ経過時間で同じ位置）・単一スロット置換・強さと粒数・reduced-motion・リーク（破棄）を検証する。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Graphics } from 'pixi.js'
import { TimeController } from './TimeController'
import { WeatherLayer } from './WeatherLayer'
import {
  WEATHER_BASE_COUNT,
  WEATHER_MAX_PARTICLES,
  computeWeatherParticle,
} from './weatherParticles'

const W = 450
const H = 800

// prefersReducedMotion() は最初の呼び出しで MediaQueryList を掴んで以後 .matches を読む。
const mq = { matches: false }
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => mq })
})
beforeEach(() => {
  mq.matches = false
})
afterEach(() => {
  vi.restoreAllMocks()
})

function make() {
  const time = new TimeController()
  time.setMode('virtual')
  const layer = new WeatherLayer(W, H, time)
  return { layer, time }
}

const positions = (layer: WeatherLayer) =>
  layer.getParticleGraphics().map((g) => [g.x, g.y, g.rotation] as const)

describe('WeatherLayer 基本', () => {
  it('初期状態は天候なし・粒なし・タイマーなし', () => {
    const { layer } = make()
    expect(layer.getState()).toBeNull()
    expect(layer.particleCount()).toBe(0)
    expect(layer.isRunning()).toBe(false)
    expect(layer.eventMode).toBe('none')
  })

  it('set() で状態は種類と強さだけ。強さ 1.0 の粒数は種類ごとの基準数', () => {
    for (const k of ['Rain', 'Snow', 'Sakura'] as const) {
      const { layer } = make()
      layer.set(k, 1)
      expect(layer.getState()).toEqual({ kind: k, intensity: 1 })
      expect(layer.particleCount()).toBe(WEATHER_BASE_COUNT[k])
      expect(layer.isRunning()).toBe(true)
      layer.clear()
    }
  })

  it('強さを変えると粒数が変わる（比例・上限クランプ・不正値は既定）', () => {
    const { layer } = make()
    layer.set('Snow', 1)
    const base = layer.particleCount()
    layer.set('Snow', 2)
    expect(layer.particleCount()).toBe(base * 2)
    layer.set('Snow', 0.5)
    expect(layer.particleCount()).toBe(Math.round(base / 2))
    layer.set('Snow', 99)
    expect(layer.getState()?.intensity).toBe(3)
    expect(layer.particleCount()).toBeLessThanOrEqual(WEATHER_MAX_PARTICLES)
    layer.set('Snow', NaN)
    expect(layer.getState()?.intensity).toBe(1)
    expect(layer.particleCount()).toBe(base)
  })

  it('粒は Graphics で、子は粒の入れ物だけ（レイヤー直下に余計なものがない）', () => {
    const { layer } = make()
    layer.set('Rain', 1)
    expect(layer.children).toHaveLength(1)
    expect(layer.getParticleGraphics().every((g) => g instanceof Graphics)).toBe(true)
  })
})

describe('WeatherLayer 動き（決定論）', () => {
  it('時間が進むと粒が動く（落下）', () => {
    const { layer, time } = make()
    layer.set('Rain', 1)
    const before = positions(layer)
    time.tick(100)
    const after = positions(layer)
    expect(after).not.toEqual(before)
  })

  it('各粒の位置は経過時間の純粋関数と一致する（set からの経過 ms）', () => {
    for (const k of ['Rain', 'Snow', 'Sakura'] as const) {
      const { layer, time } = make()
      time.tick(5000) // set 前に時間が進んでいても、起点は set 時点
      layer.set(k, 1)
      time.tick(800)
      const gs = layer.getParticleGraphics()
      // 16ms interval なので 800ms ちょうどの tick 時点（= 800 の倍数ではないが 16 の倍数）の経過で描かれる
      const elapsed = Math.floor(800 / 16) * 16
      for (const i of [0, 1, 7, gs.length - 1]) {
        const f = computeWeatherParticle(k, i, elapsed, W, H)
        expect(gs[i].x).toBeCloseTo(f.x, 6)
        expect(gs[i].y).toBeCloseTo(f.y, 6)
        expect(gs[i].rotation).toBeCloseTo(f.rotation, 6)
        expect(gs[i].alpha).toBe(f.alpha)
      }
      layer.clear()
    }
  })

  it('同じ入力・同じ経過時間なら別インスタンスでも同じフレーム（復元後の再現性）', () => {
    const a = make()
    const b = make()
    a.layer.set('Sakura', 1.5)
    b.time.tick(12345) // 起点がずれていても
    b.layer.set('Sakura', 1.5)
    a.time.tick(2000)
    b.time.tick(2000)
    expect(positions(b.layer)).toEqual(positions(a.layer))
  })

  it('Math.random を使わない', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random は使わない')
    })
    const { layer, time } = make()
    layer.set('Snow', 1)
    time.tick(500)
    expect(spy).not.toHaveBeenCalled()
  })

  it('毎フレーム Graphics を作り直さない（同じ Graphics を使い回す）', () => {
    const { layer, time } = make()
    layer.set('Rain', 1)
    const first = [...layer.getParticleGraphics()]
    time.tick(1000)
    const second = layer.getParticleGraphics()
    expect(second).toHaveLength(first.length)
    expect(second.every((g, i) => g === first[i])).toBe(true)
    expect(second.every((g) => !g.destroyed)).toBe(true)
  })
})

describe('WeatherLayer 単一スロット・復元', () => {
  it('新しい set() は前の天候を置換する（粒の種類が変わり、古い Graphics は破棄）', () => {
    const { layer } = make()
    layer.set('Rain', 1)
    const oldGs = [...layer.getParticleGraphics()]
    layer.set('Snow', 1)
    expect(layer.getState()).toEqual({ kind: 'Snow', intensity: 1 })
    expect(layer.particleCount()).toBe(WEATHER_BASE_COUNT.Snow)
    expect(oldGs.every((g) => g.destroyed)).toBe(true)
    // 蓄積しない: 子は箱 1 つ、粒は雪の分だけ
    expect(layer.children).toHaveLength(1)
  })

  it('同じ種類・強さで set() し直しても時計を戻さない（降り続ける）', () => {
    const { layer, time } = make()
    layer.set('Snow', 1)
    time.tick(3000)
    const before = positions(layer)
    layer.set('Snow', 1)
    expect(positions(layer)).toEqual(before)
  })

  it('強さだけ変えても時計は仕切り直す（経過 0 から）が、状態は新しい強さ', () => {
    const { layer, time } = make()
    layer.set('Snow', 1)
    time.tick(3000)
    layer.set('Snow', 2)
    const f = computeWeatherParticle('Snow', 0, 0, W, H)
    const g0 = layer.getParticleGraphics()[0]
    expect(g0.x).toBeCloseTo(f.x, 6)
    expect(g0.y).toBeCloseTo(f.y, 6)
  })

  it('restore(null) は clear と同じ。restore(state) は set と同じ', () => {
    const { layer } = make()
    layer.restore({ kind: 'Sakura', intensity: 2 })
    expect(layer.getState()).toEqual({ kind: 'Sakura', intensity: 2 })
    expect(layer.particleCount()).toBe(WEATHER_BASE_COUNT.Sakura * 2)
    layer.restore(null)
    expect(layer.getState()).toBeNull()
    expect(layer.particleCount()).toBe(0)
  })

  it('restore は同じ天候が降っていれば止めずに流し続ける', () => {
    const { layer, time } = make()
    layer.set('Rain', 1)
    time.tick(1000)
    const before = positions(layer)
    layer.restore({ kind: 'Rain', intensity: 1 })
    expect(positions(layer)).toEqual(before)
  })

  it('getState() はコピーを返す（外から書き換えても内部状態は変わらない）', () => {
    const { layer } = make()
    layer.set('Rain', 1)
    const s = layer.getState()!
    s.intensity = 3
    expect(layer.getState()?.intensity).toBe(1)
  })
})

describe('WeatherLayer クリア・破棄（リークしない）', () => {
  it('clear() でタイマーが止まり、粒が全部破棄され、状態が null になる', () => {
    const { layer, time } = make()
    layer.set('Rain', 1)
    const gs = [...layer.getParticleGraphics()]
    expect(time.getPendingTimerCount()).toBe(1)
    layer.clear()
    expect(time.getPendingTimerCount()).toBe(0)
    expect(layer.isRunning()).toBe(false)
    expect(layer.particleCount()).toBe(0)
    expect(gs.every((g) => g.destroyed)).toBe(true)
    expect(layer.getState()).toBeNull()
  })

  it('set → clear → set を繰り返してもタイマーは常に高々 1 つ', () => {
    const { layer, time } = make()
    for (let i = 0; i < 5; i++) {
      layer.set('Snow', 1)
      layer.set('Rain', 1 + i)
      expect(time.getPendingTimerCount()).toBe(1)
      layer.clear()
      expect(time.getPendingTimerCount()).toBe(0)
    }
  })

  it('強さを下げたとき余った粒の Graphics は破棄される', () => {
    const { layer } = make()
    layer.set('Rain', 2)
    const all = [...layer.getParticleGraphics()]
    layer.set('Rain', 1)
    const kept = new Set(layer.getParticleGraphics())
    const dropped = all.filter((g) => !kept.has(g))
    expect(dropped.length).toBe(all.length - kept.size)
    expect(dropped.length).toBeGreaterThan(0)
    expect(dropped.every((g) => g.destroyed)).toBe(true)
  })

  it('destroy() でもタイマーと粒を片付ける', () => {
    const { layer, time } = make()
    layer.set('Sakura', 1)
    layer.destroy()
    expect(layer.isRunning()).toBe(false)
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('restore を繰り返してもタイマーは高々 1 つ。clear 後は 0', () => {
    const { layer, time } = make()
    for (let i = 0; i < 4; i++) {
      layer.restore({ kind: 'Rain', intensity: 1 })
      layer.restore({ kind: 'Snow', intensity: 2 })
      expect(time.getPendingTimerCount()).toBe(1)
    }
    layer.restore(null)
    expect(time.getPendingTimerCount()).toBe(0)
  })

  it('clear 後の時間経過で何も起きない（例外もなし）', () => {
    const { layer, time } = make()
    layer.set('Rain', 1)
    layer.clear()
    expect(() => time.tick(1000)).not.toThrow()
  })
})

describe('WeatherLayer reduced-motion', () => {
  it('reduce のときは粒を表示しない（状態は宣言どおり保つ）', () => {
    mq.matches = true
    const { layer, time } = make()
    layer.set('Rain', 1)
    expect(layer.getState()).toEqual({ kind: 'Rain', intensity: 1 })
    expect(layer.isParticlesVisible()).toBe(false)
    time.tick(500)
    expect(layer.isParticlesVisible()).toBe(false)
  })

  it('reduce でないときは粒が見える', () => {
    const { layer } = make()
    layer.set('Rain', 1)
    expect(layer.isParticlesVisible()).toBe(true)
  })

  it('設定が途中で reduce→通常に戻ると降り始める。逆も同様', () => {
    const { layer, time } = make()
    mq.matches = true
    layer.set('Snow', 1)
    expect(layer.isParticlesVisible()).toBe(false)
    mq.matches = false
    time.tick(32)
    expect(layer.isParticlesVisible()).toBe(true)
    mq.matches = true
    time.tick(32)
    expect(layer.isParticlesVisible()).toBe(false)
  })

  it('reduce でも動画書き出し中は降らせる（作品として出力）', () => {
    mq.matches = true
    const { layer } = make()
    layer.set('Rain', 1)
    expect(layer.isParticlesVisible()).toBe(false)
    layer.setExporting(true)
    expect(layer.isParticlesVisible()).toBe(true)
    layer.setExporting(false)
    expect(layer.isParticlesVisible()).toBe(false)
  })

  it('reduced-motion の表示切替はレイヤー自身の visible（タイトル画面の隠し）と干渉しない', () => {
    mq.matches = true
    const { layer, time } = make()
    layer.visible = false // タイトル画面で隠された状態
    layer.set('Rain', 1)
    time.tick(100)
    expect(layer.visible).toBe(false)
    mq.matches = false
    time.tick(32)
    expect(layer.visible).toBe(false) // 勝手に戻さない
  })
})
