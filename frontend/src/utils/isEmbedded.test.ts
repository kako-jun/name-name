// isEmbedded() 本体（window.self !== window.top の iframe 埋め込み判定）の単体テスト (#392)。
//
// PlayerScreen.test.tsx など呼び出し側は isEmbedded を vi.mock で差し替えるため、本体の
// 実ロジック（比較演算子・null ガード）はそこではゼロカバレッジになる。演算子反転や
// ガード削除でも呼び出し側テストは赤くならないので、切り出した純粋関数の境界値は
// ここで本体を実行して固定する。**このファイルでは isEmbedded を mock しない。**
import { afterEach, describe, expect, it } from 'vitest'
import { isEmbedded } from './isEmbedded'

describe('isEmbedded (#392)', () => {
  // jsdom の window.top は own・configurable なデータプロパティ。各枝で差し替えるので
  // 元の記述子を退避し、テストごとに復元してリークを防ぐ。
  const originalTop = Object.getOwnPropertyDescriptor(window, 'top')

  afterEach(() => {
    if (originalTop) {
      Object.defineProperty(window, 'top', originalTop)
    }
  })

  it('トップフレーム（self===top）では非埋め込み＝false を返す', () => {
    // jsdom 既定は self===top（単独ウィンドウ）
    expect(window.self === window.top).toBe(true)
    expect(isEmbedded()).toBe(false)
  })

  it('window.top が self と異なる（iframe 相当）とき埋め込み＝true を返す', () => {
    Object.defineProperty(window, 'top', { value: {}, configurable: true })
    // 前提: self !== top（別 Window 参照）になっている
    expect(window.self === window.top).toBe(false)
    expect(isEmbedded()).toBe(true)
  })

  it('window.top が null（detached document 等）のとき安全側＝false を返す（null ガード）', () => {
    Object.defineProperty(window, 'top', { value: null, configurable: true })
    // ガードが無いと self !== null が true になり埋め込みと誤判定するので false を固定する
    expect(window.top).toBeNull()
    expect(isEmbedded()).toBe(false)
  })
})
