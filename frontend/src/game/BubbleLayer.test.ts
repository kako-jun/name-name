import { describe, expect, it, vi } from 'vitest'
import { BubbleLayer, makeZigzagRectPoints, visibleTextForCharacterCount } from './BubbleLayer'
import { computeBubbleFrameSize, getBubblePresentation } from './bubblePresentation'

vi.mock('./FontLoader', () => ({ ensureFontLoaded: vi.fn(() => Promise.resolve()) }))

describe('BubbleLayer (#698)', () => {
  it('hide は既存の描画 child を破棄せず、再表示に必要なレイヤーを維持する', () => {
    const layer = new BubbleLayer(1000, 600)
    const childrenAtConstruction = layer.children.length
    layer.hide()
    expect(layer.visible).toBe(false)
    expect(layer.children).toHaveLength(childrenAtConstruction)
  })

  it('叫び枠は矩形ではなく、外側へ張り出す交互のギザギザ点列になる', () => {
    const points = makeZigzagRectPoints(10, 20, 120, 80, 10)
    expect(points.length).toBeGreaterThan(16)
    // 上辺の2点目は下方向へ、右辺の途中点は左方向へ張り出す。直線矩形にはない頂点列である。
    expect(points.slice(0, 4)).toEqual([10, 20, 20, 24.5])
    expect(points).toContain(125.5)
  })

  it('解決済みの本文フォントと typewriter の可視文字数を使う', async () => {
    const layer = new BubbleLayer(1000, 600, {
      // Pixi Text の実測結果だけを注入し、実際の style・枠配置・可視本文更新は BubbleLayer を通す。
      measureText: () => ({ width: 74, height: 37 }),
    })
    layer.show({
      style: '通常',
      text: '全文',
      visibleCharacterCount: 1,
      xRatio: 0.5,
      depth: 0,
      mode: 'Novel',
      orientation: 'Audience',
      elevation: null,
      fontFamily: "'Klee One', cursive",
      fontSize: 37,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(layer.visible).toBe(true)
    expect(layer.getVisibleText()).toBe('全')
    const textNode = layer.children[1] as unknown as {
      style: { fontFamily: string; fontSize: number }
    }
    expect(textNode.style.fontFamily).toBe("'Klee One', cursive")
    expect(textNode.style.fontSize).toBe(37)

    layer.setVisibleCharacterCount(2)
    expect(layer.getVisibleText()).toBe('全文')
  })

  it('ルビ記法を本文から除去せず、base の文字送り完了と同時にルビを表示する', async () => {
    const layer = new BubbleLayer(1000, 600, {
      measureText: () => ({ width: 120, height: 42 }),
    })
    layer.show({
      style: '通常',
      text: '漢字《かんじ》です',
      visibleCharacterCount: 0,
      xRatio: 0.5,
      depth: 0,
      mode: 'Novel',
      orientation: 'Audience',
      elevation: null,
      fontFamily: 'sans-serif',
      fontSize: 32,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const rubyContainer = layer.children[2] as unknown as {
      children: Array<{ text: string; visible: boolean }>
    }
    expect(rubyContainer.children).toHaveLength(1)
    expect(rubyContainer.children[0].text).toBe('かんじ')
    expect(rubyContainer.children[0].visible).toBe(false)

    // DialogBox が渡す plain typewriter の文字数に合わせ、base の途中では出さない。
    layer.setVisibleCharacterCount(1)
    expect(layer.getVisibleText()).toBe('漢')
    expect(rubyContainer.children[0].visible).toBe(false)

    layer.setVisibleCharacterCount(2)
    expect(layer.getVisibleText()).toBe('漢字')
    expect(rubyContainer.children[0].visible).toBe(true)
  })

  it('枠寸法は実測本文へスタイル固有の余白だけを加える', () => {
    expect(
      computeBubbleFrameSize({ width: 120, height: 40 }, getBubblePresentation('叫び'))
    ).toEqual({ width: 172, height: 76 })
  })

  it('吹き出し幅で折り返した本文とルビを、文字数だけで partial/full reveal する', async () => {
    const layer = new BubbleLayer(1000, 600, {
      measureText: () => ({ width: 180, height: 80 }),
      wordwrap: (text, width) => {
        // 通常吹き出しの本文幅。DialogBox の幅ではなく BubbleLayer が決める。
        expect(width).toBe(320)
        expect(text).toBe('前文漢字後文')
        return ['前文', '漢字後文']
      },
    })
    layer.show({
      style: '通常',
      text: '前文｜漢字《かんじ》後文',
      visibleCharacterCount: 3,
      xRatio: 0.5,
      depth: 0,
      mode: 'Novel',
      orientation: 'Audience',
      elevation: null,
      fontFamily: 'sans-serif',
      fontSize: 32,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 3 文字目の「漢」は吹き出し固有の改行後にあり、ルビは base 完了まで出ない。
    expect(layer.getVisibleText()).toBe('前文\n漢')
    const rubyContainer = layer.children[2] as unknown as {
      children: Array<{ text: string; visible: boolean; y: number }>
    }
    expect(rubyContainer.children[0]).toMatchObject({ text: 'かんじ', visible: false })
    // 2 行目に配置され、1 行目の基準位置のままにはならない。
    expect(rubyContainer.children[0].y).toBeGreaterThan(-40)

    layer.setVisibleCharacterCount(4)
    expect(layer.getVisibleText()).toBe('前文\n漢字')
    expect(rubyContainer.children[0].visible).toBe(true)

    layer.setVisibleCharacterCount(6)
    expect(layer.getVisibleText()).toBe('前文\n漢字後文')
  })

  it('挿入した改行は reveal 数に含めず、行末の文字と同時に表示する', () => {
    expect(visibleTextForCharacterCount('AB\nCDE', 2)).toBe('AB\n')
    expect(visibleTextForCharacterCount('AB\nCDE', 3)).toBe('AB\nC')
  })

  it('DialogBox と同じ UTF-16 substring で、サロゲートペアの途中もそのまま送る', () => {
    const text = 'A😀B'
    for (let offset = 0; offset <= text.length; offset += 1) {
      expect(visibleTextForCharacterCount(text, offset)).toBe(text.substring(0, offset))
    }
  })
})
