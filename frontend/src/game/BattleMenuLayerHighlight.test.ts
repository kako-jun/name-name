/** BattleMenuLayer の敵名ウィンドウの行の帯 (#1189): 帯はタップを受けず、下の行の当たり判定へ通す */
import { describe, expect, it, vi } from 'vitest'
// Container に eventMode / isInteractive を足す（実アプリでは Application がイベントシステムを登録する）
import 'pixi.js/events'
import { Container, EventBoundary, Graphics, TextStyle } from 'pixi.js'
import { BattleMenuLayer, type BattleMenuHost } from './BattleMenuLayer'
import type { MenuTargetView } from './battleMenuLayout'

function host(onTargetTap: BattleMenuHost['onTargetTap']): BattleMenuHost {
  return {
    makePanel: () => new Container(),
    drawPanel: () => {},
    textStyle: () => new TextStyle(),
    onRowTap: () => {},
    onScroll: () => {},
    onTargetTap,
    onScopeTap: () => {},
    onCancelTap: () => {},
  }
}

describe('BattleMenuLayer: 敵名ウィンドウの行の帯 (#1189)', () => {
  const row = { x: 300, y: 370, w: 150, h: 20 }
  const view: MenuTargetView = {
    type: 'target',
    hands: [],
    hits: [{ side: 'enemy', index: 2, rect: row }],
    highlights: [row],
  }

  it('帯は eventMode none の Graphics で、帯の上のタップは行の当たり判定（その敵）に届く', () => {
    const tap = vi.fn()
    const layer = new BattleMenuLayer(host(tap))
    layer.update([view], 800, 450)
    const bands: Graphics[] = []
    const walk = (c: Container): void => {
      for (const ch of c.children) {
        if (ch instanceof Graphics && ch.eventMode === 'none') bands.push(ch)
        walk(ch as Container)
      }
    }
    walk(layer)
    expect(bands.length).toBeGreaterThan(0)
    const x = row.x + row.w / 2
    const y = row.y + row.h / 2
    const hit = new EventBoundary(layer).hitTest(x, y)
    expect(hit).not.toBeNull()
    expect(hit).not.toBeInstanceOf(Graphics)
    hit!.emit('pointertap', {} as never)
    expect(tap).toHaveBeenCalledWith('enemy', 2)
    layer.destroy({ children: true })
  })

  it('帯が無い view（off）では帯を描かない', () => {
    const layer = new BattleMenuLayer(host(() => {}))
    const { highlights: _omit, ...plain } = view
    void _omit
    layer.update([plain], 800, 450)
    const found: Graphics[] = []
    const walk = (c: Container): void => {
      for (const ch of c.children) {
        if (ch instanceof Graphics && ch.eventMode === 'none') found.push(ch)
        walk(ch as Container)
      }
    }
    walk(layer)
    expect(found).toHaveLength(0)
    layer.destroy({ children: true })
  })
})
