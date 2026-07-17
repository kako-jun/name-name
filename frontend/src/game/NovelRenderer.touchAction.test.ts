/**
 * NovelRenderer の private `setCanvasTouchAction` の init 未完了ガードテスト (#434)。
 *
 * バグ: 修正前は `const canvas = this.app?.canvas as HTMLCanvasElement | undefined` としていたが、
 * `this.app` は constructor で必ず `new Application()` が入り non-null なので `?.` は
 * `this.app` の nullish しかガードしない。pixi.js v8 の `Application.canvas` getter は
 * `init()` 完了前（`this.renderer` が undefined の間）にアクセスすると
 * `TypeError: Cannot read properties of undefined (reading 'canvas')` を投げる。
 * doc コメントは「canvas 未初期化時は no-op」と明言しており、実装がそれを満たしていなかった。
 *
 * 修正: 既存の `appInitialized` フラグ（init() 完了後に true）をガードに使う。
 *
 * 駆動方式（既存 NovelRenderer.*.test.ts と同形）:
 *   `new NovelRenderer()` → init を呼ばない状態で private メソッドを直接呼ぶ。
 *   private アクセスは NovelRenderer.autoMode.test.ts と同じ「呼び出すメソッドだけを列挙した
 *   インターフェースへの as unknown as キャスト」を用いる。
 *   実際に touch-action が 'pan-y'/'none' に反映されるかは実 WebGL コンテキストを要する
 *   init() 経由の配線であり、jsdom では検証不能なため対象外（実機 golden path に委ねる）。
 */
import { describe, it, expect } from 'vitest'
import { NovelRenderer } from './NovelRenderer'

interface TouchActionInternals {
  setCanvasTouchAction(value: string): void
}

function internals(r: NovelRenderer): TouchActionInternals {
  return r as unknown as TouchActionInternals
}

describe('NovelRenderer#setCanvasTouchAction', () => {
  it('init() 未実行の状態で呼んでも例外を投げない（修正後の回帰防止）', () => {
    const renderer = new NovelRenderer()

    expect(() => internals(renderer).setCanvasTouchAction('none')).not.toThrow()
  })
})
