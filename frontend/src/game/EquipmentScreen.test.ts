/**
 * EquipmentScreen.ts (#207) のユニットテスト。
 *
 * Pixi 依存部分（show/hide / Container 描画）はブラウザ環境で動作確認するため、
 * ここでは純粋関数 computeEquipmentLayout と SLOT_LABEL_JA、UI が依存する
 * getEquippableItems 経由のフィルタを検証する。
 */
import { describe, expect, it } from 'vitest'
import type { ItemDef } from '../types'
import { getEquippableItems } from './equipmentState'
import { computeEquipmentLayout, SLOT_LABEL_JA } from './EquipmentScreen'

describe('SLOT_LABEL_JA', () => {
  it('4 スロットすべてに日本語ラベルが付く', () => {
    expect(SLOT_LABEL_JA.weapon).toBe('武器')
    expect(SLOT_LABEL_JA.armor).toBe('防具')
    expect(SLOT_LABEL_JA.shield).toBe('盾')
    expect(SLOT_LABEL_JA.helmet).toBe('兜')
  })
})

describe('computeEquipmentLayout', () => {
  it('800x450 でパネルが中央に配置される', () => {
    const layout = computeEquipmentLayout(800, 450)
    // パネル幅 480、画面 800 → 中央配置で x = (800 - 480) / 2 = 160
    expect(layout.panel.x).toBe(160)
    expect(layout.panel.width).toBe(480)
    expect(layout.panel.height).toBeGreaterThan(0)
    // y も中央
    const expectedY = Math.floor((450 - layout.panel.height) / 2)
    expect(layout.panel.y).toBe(expectedY)
  })

  it('画面が狭いと panel 幅が縮む', () => {
    const layout = computeEquipmentLayout(320, 568)
    // 320 - margin*2 = 256 だが、min 280 でクランプされる
    expect(layout.panel.width).toBe(280)
  })

  it('画面が広くても panel 幅は 480 にキャップ', () => {
    const layout = computeEquipmentLayout(1920, 1080)
    expect(layout.panel.width).toBe(480)
  })

  it('rows は 4 要素で y 座標が単調増加', () => {
    const layout = computeEquipmentLayout(800, 450)
    expect(layout.rows).toHaveLength(4)
    for (let i = 1; i < layout.rows.length; i++) {
      expect(layout.rows[i].y).toBeGreaterThan(layout.rows[i - 1].y)
    }
    // 各 row の x 関係: labelX < valueX < buttonX
    for (const row of layout.rows) {
      expect(row.labelX).toBeLessThan(row.valueX)
      expect(row.valueX).toBeLessThan(row.buttonX)
    }
  })

  it('closeButton はパネル右下に配置', () => {
    const layout = computeEquipmentLayout(800, 450)
    expect(layout.closeButton.x + layout.closeButton.width).toBeLessThanOrEqual(
      layout.panel.x + layout.panel.width
    )
    expect(layout.closeButton.y + layout.closeButton.height).toBeLessThanOrEqual(
      layout.panel.y + layout.panel.height
    )
  })

  it('popup はパネル内に収まる', () => {
    const layout = computeEquipmentLayout(800, 450)
    expect(layout.popup.x).toBeGreaterThanOrEqual(layout.panel.x)
    expect(layout.popup.x + layout.popup.width).toBeLessThanOrEqual(
      layout.panel.x + layout.panel.width
    )
  })
})

describe('装備候補フィルタ（UI が依存する getEquippableItems の挙動確認）', () => {
  const items: Record<string, ItemDef> = {
    copper_sword: {
      id: 'copper_sword',
      name: 'どうのつるぎ',
      kind: '武器',
      equip_slot: 'weapon',
      atk_bonus: 8,
      equippable_by: ['hero'],
    },
    iron_sword: {
      id: 'iron_sword',
      name: 'てつのつるぎ',
      kind: '武器',
      equip_slot: 'weapon',
      atk_bonus: 14,
    },
    cloth_armor: {
      id: 'cloth_armor',
      name: 'ぬののふく',
      kind: '防具',
      equip_slot: 'armor',
      def_bonus: 4,
    },
    やくそう: {
      id: 'やくそう',
      name: 'やくそう',
      kind: '回復',
      effect: 'heal 30',
    },
  }

  it('hero は copper_sword と iron_sword を装備可', () => {
    const list = getEquippableItems('hero', 'weapon', items)
    expect(list.map((i) => i.id).sort()).toEqual(['copper_sword', 'iron_sword'])
  })

  it('prince は iron_sword だけ（copper_sword は hero 限定）', () => {
    const list = getEquippableItems('prince', 'weapon', items)
    expect(list.map((i) => i.id)).toEqual(['iron_sword'])
  })

  it('armor スロットには cloth_armor だけ', () => {
    const list = getEquippableItems('hero', 'armor', items)
    expect(list.map((i) => i.id)).toEqual(['cloth_armor'])
  })

  it('やくそう（equip_slot 無し）は装備候補に出ない', () => {
    const list = getEquippableItems('hero', 'weapon', items)
    expect(list.map((i) => i.id)).not.toContain('やくそう')
  })
})
