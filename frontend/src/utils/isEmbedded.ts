/**
 * このページが iframe に埋め込まれて表示されているかを返す (#392)。
 *
 * `window.self !== window.top` は、トップフレームで開かれていれば self===top で false、
 * iframe 内なら self!==top で true になる。参照比較（===）なので、埋め込み元が
 * cross-origin でも SecurityError を投げない（プロパティ値の読み取りではなく Window
 * 参照どうしの同一性判定のため）。
 *
 * name-name は Vite の CSR のみで SSR は無いが、テスト（jsdom）や将来の非ブラウザ実行を
 * 考慮して `typeof window` ガードを入れる。window が無い環境では埋め込みでないとみなす。
 *
 * テストで stub しやすいよう独立した純粋関数として置く。
 */
export function isEmbedded(): boolean {
  if (typeof window === 'undefined') return false
  // window.top が null（detached document 等、フレーム木から切り離された状態）のときは
  // 状況が不確実なので安全側＝非埋め込み（ヘッダを出す）に倒す。null ガードを外すと
  // `window.self !== null` が true になり detached を埋め込みと誤判定する。
  return window.top != null && window.self !== window.top
}
