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
 * - `url` が非 null: プレイヤー画面向け。画像の存在を fetch で確認してから
 *   設定する（title.png と同じ assets/raw 経路のため 404 になり得る —
 *   favicon.png を未配置のプロジェクトはデフォルトのまま、壊れたアイコンは
 *   出さない）。
 *
 * アンマウント時・url 変更時のクリーンアップで必ずデフォルトへ戻す。
 * PlayerScreen の intermission.md 取得（#404）と同じ cancelled フラグ
 * パターンで、遅れて解決した fetch が古い画面の favicon を誤って設定する
 * のを防ぐ。
 */
export function useFavicon(url: string | null): void {
  useEffect(() => {
    if (!url) {
      setFavicon(null)
      return
    }

    let cancelled = false
    fetch(url)
      .then((res) => {
        if (!cancelled) setFavicon(res.ok ? url : null)
      })
      .catch(() => {
        if (!cancelled) setFavicon(null)
      })

    return () => {
      cancelled = true
      setFavicon(null)
    }
  }, [url])
}
