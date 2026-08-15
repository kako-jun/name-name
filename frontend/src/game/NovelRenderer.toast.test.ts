/**
 * NovelRenderer.showToast() の単体テスト (#630)。
 *
 * DOM 版 NovelPlayer.tsx の F5/F8（クイックセーブ/ロード）通知 toast を PixiJS 化した際の、
 * NovelRenderer 側のタイマー管理契約を縛る（ToastOverlay 自身のテキスト/背景描画は対象外）:
 *   - showToast(message) で toastOverlay が表示される
 *   - 2秒後に自動的に非表示になる
 *   - 連続呼び出し時は既存タイマーをクリアして再スタートする（早く消えたり多重に消えたりしない）
 *
 * 駆動方式（NovelRenderer.titleScreen.test.ts と同形）: `new NovelRenderer()` のみ。
 * タイマーは決定論的に検証するため TimeController を virtual モードに切り替えて tick() で進める。
 */
import { describe, expect, it } from 'vitest'
import { NovelRenderer } from './NovelRenderer'

interface ToastInternals {
  toastOverlay: { visible: boolean }
}
function internals(r: NovelRenderer): ToastInternals {
  return r as unknown as ToastInternals
}

describe('NovelRenderer.showToast() (#630)', () => {
  it('1: showToast(message) を呼ぶと toastOverlay が表示される', () => {
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')

    r.showToast('クイックセーブしました')

    expect(internals(r).toastOverlay.visible).toBe(true)
  })

  it('2: 2000ms 経過すると toastOverlay が自動的に非表示になる', () => {
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')

    r.showToast('クイックセーブしました')
    r.getTimeController().tick(2000)

    expect(internals(r).toastOverlay.visible).toBe(false)
  })

  it('3: 2000ms 未満では非表示にならない（境界値）', () => {
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')

    r.showToast('クイックセーブしました')
    r.getTimeController().tick(1999)

    expect(internals(r).toastOverlay.visible).toBe(true)
  })

  it('4: 連続呼び出しは既存タイマーをクリアして再スタートする（1回目のタイマーで消えない）', () => {
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')

    r.showToast('クイックセーブしました')
    r.getTimeController().tick(1500)
    r.showToast('クイックロードしました') // 再スタート: ここから改めて2000ms

    r.getTimeController().tick(1500) // 1回目起点からは3000ms経過だが、2回目起点からはまだ1500ms
    expect(internals(r).toastOverlay.visible).toBe(true)

    r.getTimeController().tick(500) // 2回目起点から2000ms経過
    expect(internals(r).toastOverlay.visible).toBe(false)
  })
})
