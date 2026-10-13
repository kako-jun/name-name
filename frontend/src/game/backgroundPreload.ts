import { Assets } from 'pixi.js'

/**
 * 画像の先読み (#782)。PixiJS の `Assets.backgroundLoad` の代わりに使う。
 *
 * `Assets.backgroundLoad` は「キューに積むだけ」で resolve する async 関数であり、実際のダウンロードは
 * 内部の BackgroundLoader._next() が `void this._next()` で投げっぱなしに行う。そこで 1 件でも 404 になると
 * `_loader.load()` の reject が誰にも catch されず **unhandled rejection（pageerror）** になる上、
 * `_isLoading` が true のまま残って以降の先読みも止まる。`backgroundLoad(...).catch()` はキュー追加の
 * 失敗しか拾えないため呼び出し側では防げない。
 *
 * webp→png 候補を両方先読みする構造上、片側の 404 は日常的に起こる（#376/#389）ので、ここで 1 件ずつ
 * `Assets.load` し失敗は握り潰して次へ進む。失敗した URL は表示時の `Assets.load`（候補フォールバック・
 * 全滅時 warn）が改めて扱う。
 *
 * 消化順は BackgroundLoader と同じ「末尾から pop（LIFO）」・並列度 1 のまま。呼び出し側
 * （preloadUpcomingAssets）が最も近い URL を配列末尾にして渡す前提 (#414)。
 */
const queue: string[] = []
// 先読みで失敗した URL。存在しない画像（片側だけ無い webp/png 候補など）を何度も再取得しない。
// 表示経路の Assets.load と瞬断リトライ (#389) には影響させない（先読み側だけの記録）。
const failed = new Set<string>()
let running = false

async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const url = queue.pop()
      if (url === undefined) break
      if (failed.has(url)) continue
      try {
        await Assets.load(url)
      } catch {
        // 先読み失敗は静かに次へ（途中候補の 404 は想定内）
        failed.add(url)
      }
    }
  } finally {
    running = false
  }
}

export function backgroundPreload(urls: string[]): void {
  for (const u of urls) {
    if (!failed.has(u)) queue.push(u)
  }
  void drain()
}

/**
 * 未消化のキューだけを捨てる。シーン入場（resetAndStartEvents）で呼び、前シーンの URL を
 * 読み続けないようにする。取得中の1件は完走させる。失敗済み記録は残す（同じ文書内で
 * 存在しない画像を再取得しないため）。
 */
export function clearBackgroundPreloadQueue(): void {
  queue.length = 0
}

/**
 * 未消化のキューと失敗済み記録の両方を捨てる。文書差し替え（loadEvents）と破棄（destroy）で
 * 呼ぶ。差し替えで資産が変わりうる（エディタで画像追加後は再試行させたい）ため失敗記録も消す。
 * 取得中の1件は完走させる。
 */
export function clearBackgroundPreload(): void {
  clearBackgroundPreloadQueue()
  failed.clear()
}
