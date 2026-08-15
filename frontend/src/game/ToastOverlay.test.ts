/**
 * ToastOverlay の単体テスト (#630 セルフレビュー should S2)。
 *
 * NovelRenderer との仲介契約（`showToast()` の 2秒自動消去タイマー・連続呼び出し時の
 * タイマー再スタート）は `NovelRenderer.toast.test.ts` が担保する（EndingOverlay/
 * TitleScreenOverlay と同じ切り分け方針）。ここでは ToastOverlay 自身が閉じた責務——
 * メッセージ描画・背景（角丸半透明黒）の再計算・下端からの配置・resolution 反映・
 * show()/hide() のトグル——だけを縛る。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Graphics } from 'pixi.js'
import { ToastOverlay } from './ToastOverlay'

interface ToastTextLike {
  text: string
  resolution: number
  anchor: { x: number; y: number }
  width: number
  height: number
}
interface OverlayInternals {
  text: ToastTextLike
  renderResolution: number
  bg: unknown
}
function internals(o: ToastOverlay): OverlayInternals {
  return o as unknown as OverlayInternals
}

describe('ToastOverlay 初期状態', () => {
  it('constructor 直後は visible=false（show() 前は非表示）', () => {
    const overlay = new ToastOverlay(800, 450)
    expect(overlay.visible).toBe(false)
  })

  it('pointerEvents 無効（旧 DOM 版 pointer-events-none 相当、タップに反応しない）', () => {
    const overlay = new ToastOverlay(800, 450)
    expect(overlay.eventMode).toBe('none')
  })

  it('テキストの anchor は 0.5,0.5（中央基準の位置決め）', () => {
    const overlay = new ToastOverlay(800, 450)
    const text = internals(overlay).text
    expect(text.anchor.x).toBe(0.5)
    expect(text.anchor.y).toBe(0.5)
  })
})

describe('ToastOverlay.show(message)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('show(message) で visible=true になり、text.text に message が反映される', () => {
    const overlay = new ToastOverlay(800, 450)
    overlay.show('クイックセーブしました')
    expect(overlay.visible).toBe(true)
    expect(internals(overlay).text.text).toBe('クイックセーブしました')
  })

  it('show(message) は画面下端基準に配置される（旧 DOM 版 bottom-10=40px 相当のオフセット）', () => {
    const overlay = new ToastOverlay(800, 450)
    overlay.show('メッセージ')
    // x は画面中央固定。
    expect(overlay.x).toBe(400)
    // y は画面下端から TOAST_BOTTOM_OFFSET(40) 分と背景高さの半分だけ上に来る
    // （screenHeight - 40 - height/2）。text.height はテスト環境の近似フォールバックに従うため、
    // 「画面下半分に収まる」という緩い不変条件だけを確認する（厳密なフォント計測は環境依存）。
    expect(overlay.y).toBeLessThan(450)
    expect(overlay.y).toBeGreaterThan(225)
  })

  it('背景（角丸半透明黒）が message ごとに再描画される（Graphics.roundRect が毎回呼ばれる）', () => {
    const roundRectSpy = vi.spyOn(Graphics.prototype, 'roundRect')
    const overlay = new ToastOverlay(800, 450)

    overlay.show('1回目')
    expect(roundRectSpy).toHaveBeenCalledTimes(1)

    overlay.show('2回目のもっと長いメッセージ')
    expect(roundRectSpy).toHaveBeenCalledTimes(2)
  })

  it('連続 show() でメッセージが上書きされる（直前の表示内容を引きずらない）', () => {
    const overlay = new ToastOverlay(800, 450)
    overlay.show('最初のメッセージ')
    expect(internals(overlay).text.text).toBe('最初のメッセージ')

    overlay.show('次のメッセージ')
    expect(internals(overlay).text.text).toBe('次のメッセージ')
  })
})

describe('ToastOverlay.setRenderResolution()', () => {
  it('正の有限値で renderResolution と text.resolution が更新される', () => {
    const overlay = new ToastOverlay(800, 450)
    expect(internals(overlay).renderResolution).toBe(1)

    overlay.setRenderResolution(2)

    expect(internals(overlay).renderResolution).toBe(2)
    expect(internals(overlay).text.resolution).toBe(2)
  })

  it('0以下/NaN/Infinity は no-op（直前の有効値を保持する。TitleScreenOverlay/EndingOverlay と同じ防御パターン）', () => {
    const overlay = new ToastOverlay(800, 450)
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

describe('ToastOverlay.hide()', () => {
  it('hide() で visible=false になる（クリーンアップ相当。子要素自体は破棄しない薄いラッパー）', () => {
    const overlay = new ToastOverlay(800, 450)
    overlay.show('メッセージ')
    overlay.hide()
    expect(overlay.visible).toBe(false)
  })

  it('show()/hide() を連続トグルしても例外を投げず、最終状態が正しい', () => {
    const overlay = new ToastOverlay(800, 450)
    overlay.show('a')
    overlay.hide()
    overlay.show('b')
    overlay.hide()
    overlay.show('c')
    expect(overlay.visible).toBe(true)
    expect(internals(overlay).text.text).toBe('c')
  })
})
