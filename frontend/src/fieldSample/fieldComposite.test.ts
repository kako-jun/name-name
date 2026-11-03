import { describe, expect, it } from 'vitest'
import { Container } from 'pixi.js'
import { TiltShiftFilter } from '../game/TiltShiftFilter'
import { buildFieldComposite } from './fieldComposite'

describe('buildFieldComposite (#885)', () => {
  it('enabled=false ではフィルタ無し・filterArea も付かない。world は子', () => {
    const world = new Container()
    const { composite, syncArea } = buildFieldComposite(world, false, { width: 640, height: 480 })
    syncArea()
    expect(composite.filters).toBeFalsy()
    expect(composite.children).toContain(world)
    expect(composite.filterArea).toBeFalsy()
  })
  it('enabled=true では TiltShiftFilter が付き、world は子', () => {
    const world = new Container()
    const { composite } = buildFieldComposite(world, true, { width: 640, height: 480 })
    const filters = composite.filters as unknown[]
    expect(filters).toHaveLength(1)
    expect(filters[0]).toBeInstanceOf(TiltShiftFilter)
    expect(composite.children).toContain(world)
  })
  it('filterArea は画面と一致し、world.y を動かしても不変。画面サイズ変更は syncArea で追従', () => {
    const world = new Container()
    const screen = { width: 640, height: 480 }
    const { composite, syncArea } = buildFieldComposite(world, true, screen)
    const area = () => composite.filterArea!
    expect([area().x, area().y, area().width, area().height]).toEqual([0, 0, 640, 480])
    world.y = 12
    syncArea()
    expect([area().x, area().y, area().width, area().height]).toEqual([0, 0, 640, 480])
    screen.width = 800
    screen.height = 600
    syncArea()
    expect([area().x, area().y, area().width, area().height]).toEqual([0, 0, 800, 600])
  })
})
