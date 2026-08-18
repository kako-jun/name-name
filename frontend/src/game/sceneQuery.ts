/**
 * URL クエリによる scene 起点指定のパーサ (#386)。
 *
 * `?scene=<sceneId>` を `PlayerScreen` が読み、対象 sceneId が属する script を
 * 事前解決・ロードしてから `NovelPlayer` に `initialSceneId` として渡す production 経路。
 * `debugQuery.ts` の `debug_scene`（flags/eventIndex/textIndex 対応・#652で本番ビルドでも
 * 常時有効化）とは別に、こちらは「特定シーンへの直接ディープリンク」用の最小限の入口として
 * 用意する（theo-hayami サイト設計「1セル1URL＝1遅延埋め込み」の前提）。両者の決定的な違いは
 * confinement（在圏、#386）の有無——`?scene=` は `confinedSceneIds` で対象ファイル外への
 * 遷移を終劇として扱うが、`debug_scene` は confinement なしで任意のシーンへ遷移できる
 * （gymnasia のような1ルートが複数ファイルに分割された構成の実機デバッグ用、#652）。
 *
 * 副作用なし・DOM 非依存の純粋関数。
 */

/**
 * URL の query string から `scene` パラメータ（sceneId）を取り出す。
 *
 * @param search `window.location.search`（先頭 `?` の有無どちらも可）
 * @returns sceneId 文字列。未指定/空文字なら null
 */
export function parseSceneQuery(search: string): string | null {
  const params = new URLSearchParams(search)
  const sceneId = params.get('scene')
  return sceneId !== null && sceneId !== '' ? sceneId : null
}
