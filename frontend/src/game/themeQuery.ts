/**
 * URL クエリによるプレイヤー見た目テーマのパーサ (#394)。
 *
 * `?theme=light` を `PlayerScreen` が読み、ロード画面（ルート背景・ローディング文字色・
 * ヘッダ配色）を light/dark で切り替える production 経路。ノベルゲーム本体（PixiJS
 * キャンバス）は常に黒 `0x000000` が自然なので、プレイヤーの見た目デフォルトは **黒（dark）**
 * とし、ローディングも黒地・明色文字で「黒→黒」で継ぎ目なくキャンバスへ繋ぐ。例外として
 * theo-hayami のような **ライトな埋め込み先** だけが `?theme=light` を明示して白いロード
 * 画面を要求する。
 *
 * `debugQuery.ts` の debug 系（dev 専用・`import.meta.env.DEV` でのみ有効）とは別系統で、
 * production ビルドでも常時有効。App の darkMode（エディタ UI 用トグル）とも独立しており、
 * プレイヤーの見た目は本パラメータ（既定 dark）だけで決まる。
 *
 * 副作用なし・DOM 非依存の純粋関数。
 */

/** プレイヤーの見た目テーマ。既定は 'dark'（キャンバスの黒に継ぎ目なく繋ぐため）。 */
export type PlayerTheme = 'light' | 'dark'

/**
 * URL の query string から `theme` パラメータを取り出す。
 *
 * `?theme=light` のときだけ 'light' を返す。それ以外（未指定・`?theme=dark`・未知値・
 * 空文字）はすべて既定の 'dark' に倒す。
 *
 * @param search `window.location.search`（先頭 `?` の有無どちらも可）
 * @returns 'light'（明示指定時のみ）または 'dark'（既定）
 */
export function parseThemeQuery(search: string): PlayerTheme {
  const params = new URLSearchParams(search)
  return params.get('theme') === 'light' ? 'light' : 'dark'
}
