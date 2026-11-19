/** BattleMenuLayer の一覧窓の題名 (#1226): 上辺の線を切って、入った項目の名前を載せる。窓の rect は変えない */
import { describe, expect, it, vi } from 'vitest'
import 'pixi.js/events'
import { Container, Text as PixiText, TextStyle } from 'pixi.js'
import { BattleMenuLayer, type BattleMenuHost } from './BattleMenuLayer'
import type { MenuListView } from './battleMenuLayout'
import { PANEL_CORNER_RADIUS } from './windowTitle'

const view: MenuListView = {
  type: 'list',
  kind: 'spell',
  rect: { x: 20, y: 200, w: 220, h: 100 },
  rows: [],
  hand: null,
  moreAbove: false,
  moreBelow: false,
  scrollUp: null,
  scrollDown: null,
  active: true,
}

function texts(c: Container): PixiText[] {
  const out: PixiText[] = []
  for (const ch of c.children) {
    if (ch instanceof PixiText) out.push(ch)
    out.push(...texts(ch as Container))
  }
  return out
}

function host(
  drawPanel: BattleMenuHost['drawPanel'],
  title?: (k: string) => string
): BattleMenuHost {
  return {
    makePanel: () => new Container(),
    drawPanel,
    ...(title ? { listTitle: title } : {}),
    textStyle: () => new TextStyle(),
    onRowTap: () => {},
    onScroll: () => {},
    onTargetTap: () => {},
    onScopeTap: () => {},
    onCancelTap: () => {},
  }
}

describe('BattleMenuLayer: 一覧窓の題名 (#1226)', () => {
  it('題名があれば、窓の rect はそのまま上辺の線の切れ目を渡し、文字を線の高さに載せる', () => {
    const draw = vi.fn()
    const layer = new BattleMenuLayer(host(draw, () => 'じゅもん'))
    layer.update([view], 800, 450)
    const [, x, y, w, h, , gap] = draw.mock.calls[0]
    expect([x, y, w, h]).toEqual([20, 200, 220, 100])
    expect(gap.x0).toBeGreaterThanOrEqual(20 + PANEL_CORNER_RADIUS)
    expect(gap.x1).toBeLessThanOrEqual(20 + 220 - PANEL_CORNER_RADIUS)
    const t = texts(layer).find((x) => x.text === 'じゅもん')!
    expect(t.y).toBe(200)
    expect(t.x).toBeGreaterThan(gap.x0)
    expect(t.eventMode).toBe('none')
    layer.destroy({ children: true })
  })

  it('題名が無い（host が持たない・空）ときは切れ目も文字も無く、従来どおり', () => {
    for (const h of [host(vi.fn()), host(vi.fn(), () => '')]) {
      const layer = new BattleMenuLayer(h)
      layer.update([view], 800, 450)
      expect((h.drawPanel as ReturnType<typeof vi.fn>).mock.calls[0][6]).toBeNull()
      layer.destroy({ children: true })
    }
  })
})
