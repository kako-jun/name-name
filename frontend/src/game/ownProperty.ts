/**
 * own-property セーフルックアップの共通ヘルパー (#368)。
 *
 * `obj[key]` の素朴なブラケットアクセスは Object.prototype も辿ってしまう。key が脚本側の
 * 入力（キャラ名 / position トークン / expression 名 / spell.builtin id 等）由来で
 * `constructor` / `toString` / `valueOf` / `hasOwnProperty` 等の Object.prototype メンバー名と
 * 偶然一致すると、undefined ではなく関数オブジェクト等が返り、意図しないフォールバック漏れ・
 * 誤動作を起こす（#364 セルフレビューで発見・修正した prototype pollution 相当の不具合と同種）。
 *
 * このヘルパーで own-property の有無だけを判定してから読む。通常のキー（既知のトークン等）の
 * 挙動は変えず、Object.prototype と衝突する異常系だけを弾く。
 */
export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}
