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

/**
 * own-property セーフ代入の共通ヘルパー (#370)。
 *
 * `obj[key] = value` の素朴な代入は Object.prototype のアクセサ（`__proto__`）と衝突しうる。
 * key が脚本データ由来の自由文字列（マスターID / フラグ名 / DSL の state 名等）で、たまたま
 * `"__proto__"` と一致すると、obj 自身に書き込まれるはずの値が obj の own-property にならず、
 * 代わりに `Object.prototype.__proto__` の setter が起動して obj 自身の [[Prototype]] が
 * 書き換わってしまう（prototype pollution。読み取り側の同種問題は #368 の `hasOwn()` 参照）。
 *
 * `Object.defineProperty` で常に obj 自身の own data property として定義することで、key が
 * `"__proto__"` であっても通常のキーと同じように格納・列挙・後から読み取り可能になる。
 * 通常のキー（`"__proto__"` 以外）の挙動・descriptor 属性は変えない。
 */
export function safeAssign<T>(obj: Partial<Record<string, T>>, key: string, value: T): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * source の own enumerable property を全て target へ safeAssign 経由でコピーする (#370)。
 *
 * `Object.assign(target, source)` は内部で target に対し通常の `[[Set]]` を使うため、source が
 * safeAssign 済みで `"__proto__"` を own property として持っていても、target 側でコピーする際に
 * 改めて prototype pollution を起こしうる（target が `"__proto__"` を own property として
 * 持っていなければ、target の [[Prototype]] が書き換わってしまう）。ここでは必ず
 * `Object.defineProperty` ベースの safeAssign 経由でコピーする。
 */
export function safeAssignAll<T>(
  target: Partial<Record<string, T>>,
  source: Partial<Record<string, T>>
): void {
  for (const key of Object.keys(source)) {
    safeAssign(target, key, source[key] as T)
  }
}
