import { describe, expect, it } from 'vitest'
import { computeCameraProjection } from './cameraProjection'
import { computeBubbleLayout, getBubblePresentation, type BubbleStyle } from './bubblePresentation'

const styles: BubbleStyle[] = ['通常', '静か', '叫び', '内心', 'ナレーション']

describe('bubble presentation (#698)', () => {
  it('5種すべてが固有の形状・線種・配色を持つ', () => {
    const presentations = styles.map(getBubblePresentation)
    expect(
      new Set(presentations.map((item) => `${item.shape}/${item.linePattern}/${item.fill}`)).size
    ).toBe(styles.length)
    expect(getBubblePresentation('叫び')).toMatchObject({ shape: 'zigzag', linePattern: 'solid' })
    expect(getBubblePresentation('静か')).toMatchObject({ shape: 'cloud', linePattern: 'dotted' })
    expect(getBubblePresentation('内心')).toMatchObject({ shape: 'cloud', linePattern: 'dashed' })
    expect(getBubblePresentation('静か')).not.toEqual(getBubblePresentation('内心'))
  })

  it('Dialog は話者の x 座標、ナレーションは上方中央に配置する', () => {
    const dialog = computeBubbleLayout({
      style: '通常',
      screenWidth: 1000,
      screenHeight: 600,
      xRatio: 0.8,
      depth: 0,
      mode: 'Novel',
      orientation: 'Audience',
      elevation: null,
    })
    const narration = computeBubbleLayout({
      ...{
        style: 'ナレーション' as const,
        screenWidth: 1000,
        screenHeight: 600,
        xRatio: 0.1,
        depth: 50,
        mode: 'Theater' as const,
        orientation: 'Stage' as const,
        elevation: 'LookDown' as const,
      },
    })
    expect(dialog).toMatchObject({ x: 800, y: 192, scale: 1 })
    expect(narration).toEqual({ x: 500, y: 120, scale: 1, verticalOffset: 0 })
  })

  it('Novel は identity、Theater の Dialog は既存カメラ射影に一致する', () => {
    const base = {
      style: '通常' as const,
      screenWidth: 1000,
      screenHeight: 600,
      xRatio: 0.25,
      depth: 8,
      orientation: 'Audience' as const,
      elevation: 'LookUp' as const,
    }
    expect(computeBubbleLayout({ ...base, mode: 'Novel' })).toEqual({
      x: 250,
      y: 192,
      scale: 1,
      verticalOffset: 0,
    })
    const expected = computeCameraProjection(
      'Theater',
      base.orientation,
      base.elevation,
      base.depth
    )
    expect(computeBubbleLayout({ ...base, mode: 'Theater' })).toEqual({
      x: 250,
      y: 192 + expected.verticalOffset,
      ...expected,
    })
  })
})
