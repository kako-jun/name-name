import { describe, expect, it } from 'vitest'
import { BattleContain, type ContainTargets } from './battleContain'

function setup(vw = 1280, vh = 720) {
  const canvas = document.createElement('canvas')
  canvas.style.width = '1920px'
  canvas.style.height = '1080px'
  let vp = { w: vw, h: vh }
  const listeners = new Set<() => void>()
  const t: ContainTargets = {
    body: document.body,
    canvas,
    viewport: () => vp,
    onResize: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  const c = new BattleContain(t)
  return {
    c,
    canvas,
    listeners,
    resize(w: number, h: number) {
      vp = { w, h }
      for (const l of [...listeners]) l()
    },
  }
}
const hasClass = (): boolean => document.body.classList.contains('battle-contain')

describe('BattleContain (sit-by-me#52)', () => {
  it.each([
    ['3:2', 1200, 800, 1200, 675],
    ['16:9', 1280, 720, 1280, 720],
    ['19.5:9', 1170, 540, 960, 540],
    ['20:9', 1200, 540, 960, 540],
  ])('%s: enter で class と contain の px 寸法（16:9・viewport に収まる）', (_n, vw, vh, w, h) => {
    const { c, canvas } = setup(vw, vh)
    c.enter({ w: 1920, h: 1080 })
    expect(hasClass()).toBe(true)
    expect(parseFloat(canvas.style.width)).toBeCloseTo(w, 6)
    expect(parseFloat(canvas.style.height)).toBeCloseTo(h, 6)
    expect(canvas.style.getPropertyPriority('width')).toBe('important')
    c.leave()
  })

  it('leave で class・購読・寸法を元に戻す', () => {
    const { c, canvas, listeners } = setup()
    c.enter({ w: 1920, h: 1080 })
    expect(listeners.size).toBe(1)
    c.leave()
    expect(hasClass()).toBe(false)
    expect(listeners.size).toBe(0)
    expect(canvas.style.width).toBe('1920px')
    expect(canvas.style.height).toBe('1080px')
    expect(canvas.style.getPropertyPriority('width')).toBe('')
    expect(c.active).toBe(false)
  })

  it('viewport が変わったら contain し直す', () => {
    const { c, canvas, resize } = setup(1280, 720)
    c.enter({ w: 1920, h: 1080 })
    resize(1200, 540)
    expect(parseFloat(canvas.style.width)).toBeCloseTo(960, 6)
    c.leave()
  })

  it('enter(null)（論理サイズ未指定）は何も付けず、付いていれば外す', () => {
    const { c, canvas } = setup()
    c.enter(null)
    expect(hasClass()).toBe(false)
    expect(canvas.style.width).toBe('1920px')
    c.enter({ w: 1920, h: 1080 })
    c.enter(null)
    expect(hasClass()).toBe(false)
    expect(canvas.style.width).toBe('1920px')
  })

  it('enter を重ねても購読は 1 つ・leave は冪等・dispose でも外れる', () => {
    const { c, listeners } = setup()
    c.enter({ w: 1920, h: 1080 })
    c.enter({ w: 1920, h: 1080 })
    expect(listeners.size).toBe(1)
    c.dispose()
    c.leave()
    expect(hasClass()).toBe(false)
    expect(listeners.size).toBe(0)
  })
})
