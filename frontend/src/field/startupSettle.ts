/**
 * フィールド起動時の並列読み込み (#1219) の結果の扱い。PixiJS / DOM に依存しない純関数。
 * 並列に読み始めても、失敗の見え方は直列だった従来と同じにする: 呼び出し側が並べた「従来の読み込み順」で最初に失敗したものを投げる
 * （時間順で最初ではない）。描画器の初期化が済んでいる（成功している）のに起動が失敗したときは、描画器を破棄させる
 */
export type StartupSettle =
  | { failed: false }
  | { failed: true; reason: unknown; destroyApp: boolean }

/**
 * `ordered` は従来の読み込み順に並べた結果、`app` は描画器の初期化の結果（`ordered` の最後に続く扱いで、失敗順は最後）。
 * 失敗が無ければ `{ failed: false }`
 */
export function settleStartup(
  ordered: readonly PromiseSettledResult<unknown>[],
  app: PromiseSettledResult<unknown>
): StartupSettle {
  for (const r of [...ordered, app]) {
    if (r.status === 'rejected')
      return { failed: true, reason: r.reason, destroyApp: app.status === 'fulfilled' }
  }
  return { failed: false }
}
