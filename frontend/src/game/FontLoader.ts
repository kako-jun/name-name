/**
 * FontLoader (#147)
 *
 * Google Fonts CSS を `<link rel="stylesheet">` で `<head>` に動的に注入する。
 * font-family ごとに 1 度だけ注入し、二度目以降は既存の Promise を返す。
 *
 * 設計メモ:
 * - 当初は CSP に強い `<link>` 注入を採用（@import は CSP `style-src` の inline を要求するため避ける）
 * - 同じ family が連続して呼ばれた場合に Promise を共有（race / 多重 fetch 防止）
 * - 失敗時はキャッシュから除去して次回再試行できるようにする（一時的な 404 で永続的に詰まないため）
 * - document.fonts.ready の完了を待ち、PixiJS 側で TextStyle に反映した瞬間に正しいグリフが使われるようにする
 *
 * 想定の主要フォント（Issue #147 の範囲内）:
 *   - Noto Sans JP   (default 既定の代替も担う)
 *   - Klee One       (手書き風 / 子供向け)
 *   - Hina Mincho    (明朝)
 *   - Yusei Magic    (柔らかい教科書体)
 *
 * ただし family の名称は Google Fonts に存在するものなら何でも動的に通せる。
 * font-family が CSS の fallback 列を含む場合（例: `"Klee One, cursive"`）でも、
 * 先頭のフェイス名のみを抽出して Google Fonts API に投げる。
 */

/**
 * font-family 文字列から先頭のフェイス名（Google Fonts に問い合わせる名前）を抜き出す。
 *
 * 例:
 *   `'Klee One', cursive` → `Klee One`
 *   `Hina Mincho, serif`   → `Hina Mincho`
 *   `Noto Sans JP`         → `Noto Sans JP`
 *
 * 引用符・前後空白を剥がし、最初のカンマ手前を返す。空文字の場合は null。
 */
export function extractPrimaryFamily(family: string): string | null {
  const head = family.split(',')[0]?.trim() ?? ''
  // 単引用符 / 二重引用符を取り除く
  const unquoted = head.replace(/^['"]+|['"]+$/g, '').trim()
  return unquoted.length > 0 ? unquoted : null
}

/** 既にロード済 / ロード中の family → Promise マップ。test では resetFontLoaderCache() でクリア */
const loadCache: Map<string, Promise<void>> = new Map()

/** ensureFontLoaded のフック先（テスト用に差し替え可能）。デフォルトはブラウザ document */
let documentRef: Document | null = typeof document === 'undefined' ? null : document

/** テスト用: document を差し替える */
export function __setDocumentForTest(doc: Document | null): void {
  documentRef = doc
}

/** テスト用: キャッシュをクリアする */
export function resetFontLoaderCache(): void {
  loadCache.clear()
}

/**
 * 指定された CSS font-family をロードし、フォントが利用可能になったら resolve する。
 *
 * - 同じ family を 2 回以上呼んでも `<link>` は 1 個しか作られない
 * - SSR / 非ブラウザ環境（document が無い場合）は no-op で resolve する
 * - 失敗したらキャッシュから除去して次回再試行可能にする（一過性 404 で永続詰まりを防ぐ）
 * - document.fonts API があれば `document.fonts.ready` も待つ。
 *   無い場合（古い test 環境）は link.onload のみで完了とみなす
 */
export function ensureFontLoaded(family: string): Promise<void> {
  if (!documentRef) {
    // SSR / non-DOM 環境では no-op
    return Promise.resolve()
  }
  const primary = extractPrimaryFamily(family)
  if (!primary) {
    return Promise.resolve()
  }

  const cached = loadCache.get(primary)
  if (cached) return cached

  const promise = new Promise<void>((resolve, reject) => {
    if (!documentRef) {
      // 競合ガード（resetForTest 中に呼ばれた等）
      resolve()
      return
    }
    // Google Fonts API (CSS2) のクエリを組み立てる。空白は `+` に変換するのが慣例。
    const familyParam = primary.replace(/\s+/g, '+')
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(familyParam).replace(/%2B/g, '+')}&display=swap`

    const link = documentRef.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.setAttribute('data-name-name-font', primary)

    link.onload = () => {
      // document.fonts.ready が利用可能なら、フォント本体のロード完了まで待つ。
      // pixi が TextStyle 更新時に古いグリフでベイクするのを防ぐため。
      const docAny = documentRef as Document & {
        fonts?: { ready?: Promise<unknown> }
      }
      if (docAny.fonts?.ready) {
        docAny.fonts.ready.then(() => resolve()).catch(() => resolve())
      } else {
        resolve()
      }
    }
    link.onerror = (err) => {
      // 失敗したら次回再試行できるよう cache から除去
      loadCache.delete(primary)
      reject(err instanceof Error ? err : new Error(`font load failed: ${primary}`))
    }

    documentRef.head.appendChild(link)
  })
  loadCache.set(primary, promise)
  return promise
}
