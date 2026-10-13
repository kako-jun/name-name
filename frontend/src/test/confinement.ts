import type { NovelRenderer } from '../game/NovelRenderer'

/**
 * テスト用: confinement（在圏）一覧を直接設定する (#734)。
 *
 * 本番では confinement は新規開始の入場属性で、`startFrom({ sceneId, confinedSceneIds })` が
 * 解決できた時点で確定する（公開の setter は無い）。既存の「confinement 下の遷移」テストは、
 * 開始位置を変えずに一覧だけを仕込みたいので、private フィールドを直接設定する。
 * 入場属性としての確定そのものは `NovelRenderer.startFrom.test.ts` が `startFrom` 経由で検証する。
 */
export function confineForTest(renderer: NovelRenderer, ids: string[] | null): void {
  ;(renderer as unknown as { confinedSceneIds: string[] | null }).confinedSceneIds = ids
}
