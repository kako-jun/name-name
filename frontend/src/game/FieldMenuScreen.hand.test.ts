/**
 * フィールドメニューの手の縦位置 (#1188)。指の先が行の文字の縦中心に来る（枠の中心合わせに戻ると落ちる）。
 */
import { Container, Graphics, Text } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { HAND_FINGER_Y_RATIO } from './battleMenuLayout'
import { FieldMenuScreen } from './FieldMenuScreen'

function walk(n: Container, f: (c: Container) => void): void {
  for (const c of n.children) {
    f(c as Container)
    walk(c as Container, f)
  }
}

describe('FieldMenuScreen: 手の縦位置 (#1188)', () => {
  it.each([
    [1280, 720],
    [390, 844],
  ])('トップの手は、指の先が選択行の文字の縦中心に来る (%i x %i)', (width, height) => {
    const s = new FieldMenuScreen({ width, height, acrylic: false, onClose: () => {} })
    s.open({
      items: [
        { id: 'status', label: 'ステータス' },
        { id: 'item', label: 'どうぐ' },
      ],
      party: [],
      info: { place: 'p', gold: 0, playMs: 0, steps: 0 },
      slots: [null, null, null],
    })
    s.tick(10_000)
    const hands: Graphics[] = []
    let label: Text | undefined
    walk(s, (c) => {
      if (c instanceof Graphics && c.eventMode === 'none') hands.push(c)
      if (c instanceof Text && c.text === 'ステータス') label = c
    })
    expect(label).toBeDefined()
    expect(hands.length).toBe(1)
    const b = hands[0].getLocalBounds() // 黒い縁(1px)を含む
    const top = b.y + 1
    const h = b.height - 2
    expect(top + h * HAND_FINGER_Y_RATIO).toBeCloseTo(label!.y, 5)
  })
})
