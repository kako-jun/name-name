/**
 * URL クエリによる scene 起点指定のパーサ (#386)。
 *
 * `?scene=<sceneId>` を `PlayerScreen` が読み、対象 sceneId が属する script を
 * 事前解決・ロードしてから `NovelPlayer` に `initialSceneId` として渡す production 経路。
 * `debugQuery.ts` の `debug_scene`（dev 専用・`import.meta.env.DEV` でのみ有効・
 * flags/eventIndex/textIndex 対応）とは別に、production ビルドでも常時有効な
 * 「特定シーンへの直接ディープリンク」用の最小限の入口として用意する
 * （theo-hayami サイト設計「1セル1URL＝1遅延埋め込み」の前提）。
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
