/**
 * `<link rel="icon">` を動的に設定/削除する (kako-jun/name-name#552)。
 *
 * document.title のプロジェクトごとの切り替え（App.tsx の各 `*Wrapper`
 * コンポーネント）と同じ発想で、favicon もプロジェクトごとに切り替える。
 * 既存タグがあれば再利用（href だけ書き換え）、無ければ新規作成する。
 * url が null のときは既存タグを削除し、ブラウザ既定（無指定）に戻す。
 *
 * DOM 操作のみを担う純粋関数。存在確認（onerror 判定）は呼び出し側
 * （useFavicon.ts）の責務とし、ここでは行わない。設定/再利用した
 * `<link>` 要素を返すのは、呼び出し側がそこに onerror を
 * アタッチできるようにするため（url が null で削除しただけのときは null）。
 */
export function setFavicon(url: string | null): HTMLLinkElement | null {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!url) {
    existing?.remove()
    return null
  }
  const link = existing ?? document.createElement('link')
  link.rel = 'icon'
  link.href = url
  if (!existing) document.head.appendChild(link)
  return link
}
