import { useEffect } from 'react'
import { setFavicon } from './favicon'

/**
 * プロジェクトごとの favicon (`assets/images/favicon.png`) を切り替える
 * (kako-jun/name-name#552)。
 *
 * document.title の更新パターン（App.tsx の各 `*Wrapper` コンポーネントが
 * useEffect で document.title を書き換える）を踏襲し、favicon も画面遷移の
 * たびに useEffect で設定する。
 *
 * - `url` が null: 「特定ゲームの文脈にいない」画面（プロジェクト一覧・
 *   エディタ・アセット管理）向け。存在確認はせず、常にデフォルト（favicon
 *   リンクなし）に戻す。
 * - `url` が非 null: プレイヤー画面向け。`<link>` の href を直接設定し、
 *   ブラウザ自身の読み込みに `onerror` を張って存在確認する（title.png と
 *   同じ assets/raw 経路のため 404 になり得る — favicon.png を未配置の
 *   プロジェクトはデフォルトのまま、壊れたアイコンは出さない）。事前に
 *   fetch で存在確認してから href を設定すると同じ画像を二重に取得して
 *   しまうため、TitleOverlay.tsx の `<img onError>` と同じ単一フェッチの
 *   パターン（要素自身のロードイベントで成否判定）を踏襲する。
 *
 * アンマウント時・url 変更時のクリーンアップで必ずデフォルトへ戻す。
 * PlayerScreen の intermission.md 取得（#404）と同じ cancelled フラグ
 * パターンで、遅れて発火した onerror が古い画面の favicon を誤って設定する
 * のを防ぐ（cleanup で onerror を先に外すため二重の保険だが、イベント発火
 * タイミングに依存しない安全側の実装として維持する）。
 */
export function useFavicon(url: string | null): void {
  useEffect(() => {
    if (!url) {
      setFavicon(null)
      return
    }

    let cancelled = false
    const link = setFavicon(url)
    if (link) {
      link.onerror = () => {
        if (!cancelled) setFavicon(null)
      }
    }

    return () => {
      cancelled = true
      if (link) link.onerror = null
      setFavicon(null)
    }
  }, [url])
}
