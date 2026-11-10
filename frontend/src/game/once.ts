/**
 * 関数を「最初の 1 回だけ」実行する薄いラッパー (#1073)。2 回目以降の呼び出しは何もしない。
 * 結果を待つ Promise の resolve を、正常終了の経路と例外の経路の両方から呼びうる場面で二重呼び出しを構造的に防ぐ
 */
export function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let called = false
  return (...args: A): void => {
    if (called) return
    called = true
    fn(...args)
  }
}
