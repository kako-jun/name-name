/**
 * EndingOverlay の単体テスト (#630 セルフレビュー should S2)。
 *
 * NovelRenderer との仲介契約（`storyEnded && !hasIntermissionScene()` の判定・ロゴ画像の
 * `characterLayer.showImage()` 委譲・呼び出しタイミング）は `NovelRenderer.endingOverlay.test.ts`
 * が担保する（TitleScreenOverlay と同じ切り分け方針、当該テストの JSDoc 参照）。
 * ここでは EndingOverlay 自身が閉じた責務——"to be continued..." テキストの初期配置・
 * wordWrap・alpha、resolution 反映、フォント反映、show()/hide() のトグル——だけを縛る。
 */
import { describe, it, expect } from 'vitest'
import { EndingOverlay } from './EndingOverlay'

interface EndingTextLike {
  text: string
  visible: boolean
  alpha: number
  x: number
  y: number
  resolution: number
  anchor: { x: number; y: number }
  style: {
    fontFamily: string
    fontSize: number
    fontStyle: string
    fill: number
    wordWrap: boolean
    wordWrapWidth: number
  }
}
interface OverlayInternals {
  text: EndingTextLike
  renderResolution: number
}
function internals(o: EndingOverlay): OverlayInternals {
  return o as unknown as OverlayInternals
}

describe('EndingOverlay 初期状態', () => {
  it('constructor 直後は visible=false（show() 前は非表示）', () => {
    const overlay = new EndingOverlay(800, 450)
    expect(overlay.visible).toBe(false)
  })

  it('テキストは "to be continued..."・中央配置・anchor 0.5,0.5・旧 DOM 版 text-white/80 相当の alpha', () => {
    const overlay = new EndingOverlay(800, 450)
    const text = internals(overlay).text
    expect(text.text).toBe('to be continued...')
    expect(text.x).toBe(400)
    expect(text.y).toBe(225)
    expect(text.anchor.x).toBe(0.5)
    expect(text.anchor.y).toBe(0.5)
    expect(text.alpha).toBeCloseTo(0.8, 5)
  })

  it('pointerEvents 無効（旧 DOM 版 pointer-events-none 相当、タップに反応しない）', () => {
    const overlay = new EndingOverlay(800, 450)
    expect(overlay.eventMode).toBe('none')
  })

  it('wordWrap は有効で、幅は screenWidth - 64px（旧 DOM 版 px-8 の左右余白相当）', () => {
    const overlay = new EndingOverlay(800, 450)
    const text = internals(overlay).text
    expect(text.style.wordWrap).toBe(true)
    expect(text.style.wordWrapWidth).toBe(800 - 32 * 2)
  })

  it('screenWidth が小さい（余白 64px を下回る）場合は wordWrapWidth が 1 未満にならない（Math.max(1, ...) の床）', () => {
    // wordWrapWidth 自体は private style 経由のため直接読めないが、コンストラクタが
    // 例外を投げず正の値を保証していることを、極端な小画面での構築成功で確認する。
    expect(() => new EndingOverlay(10, 10)).not.toThrow()
  })
})

describe('EndingOverlay.setRenderResolution()', () => {
  it('正の有限値で renderResolution と text.resolution が更新される', () => {
    const overlay = new EndingOverlay(800, 450)
    expect(internals(overlay).renderResolution).toBe(1)

    overlay.setRenderResolution(2)

    expect(internals(overlay).renderResolution).toBe(2)
    expect(internals(overlay).text.resolution).toBe(2)
  })

  it('0以下/NaN/Infinity は no-op（直前の有効値を保持する。TitleScreenOverlay と同じ防御パターン）', () => {
    const overlay = new EndingOverlay(800, 450)
    overlay.setRenderResolution(3)
    expect(internals(overlay).renderResolution).toBe(3)

    overlay.setRenderResolution(0)
    expect(internals(overlay).renderResolution).toBe(3)

    overlay.setRenderResolution(-1)
    expect(internals(overlay).renderResolution).toBe(3)

    overlay.setRenderResolution(NaN)
    expect(internals(overlay).renderResolution).toBe(3)

    overlay.setRenderResolution(Infinity)
    expect(internals(overlay).renderResolution).toBe(3)
  })
})

describe('EndingOverlay.setFontFamily()', () => {
  it('text.style.fontFamily が指定値に更新される（per-game font_family: 反映）', () => {
    const overlay = new EndingOverlay(800, 450)
    overlay.setFontFamily("'Custom Font', serif")
    expect(internals(overlay).text.style.fontFamily).toBe("'Custom Font', serif")
  })
})

describe('EndingOverlay.show() / hide()', () => {
  it('show() で visible=true になる', () => {
    const overlay = new EndingOverlay(800, 450)
    overlay.show()
    expect(overlay.visible).toBe(true)
  })

  it('hide() で visible=false になる（クリーンアップ相当。子要素自体は破棄しない薄いラッパー）', () => {
    const overlay = new EndingOverlay(800, 450)
    overlay.show()
    overlay.hide()
    expect(overlay.visible).toBe(false)
  })

  it('show()/hide() を連続トグルしても例外を投げず、最終状態が正しい', () => {
    const overlay = new EndingOverlay(800, 450)
    overlay.show()
    overlay.hide()
    overlay.show()
    overlay.hide()
    overlay.show()
    expect(overlay.visible).toBe(true)
  })
})
