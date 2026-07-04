/**
 * `?scene=` ディープリンク単独埋め込みの confinement（在圏）判定 (#386)。
 *
 * theo-hayami サイト設計（theo-hayami #20）は「他ファイル（住人一覧・業一覧などの hub）への
 * 遷移は埋め込み内の choice ではなく、埋め込みの外側の HTML リンクで行う」ことを前提にしている。
 * `?scene=` 単独埋め込み起動時（`PlayerScreen` が対象 script ファイル自身の sceneId 一覧を
 * `NovelRenderer.setConfinedSceneIds` で渡したとき）だけ、その集合の外へのシーンジャンプを
 * `NovelRenderer.jumpToScene` の choke point で検出し、通常の scene 遷移ではなく終劇として
 * 扱う（`NovelRenderer.endStory`）。通常のハブ経由フロー（`/play/:projectName` 単体）では
 * confinedSceneIds が null のまま渡らないため、常に無制限（在圏）になる。
 *
 * 副作用なし・DOM 非依存の純粋関数。
 */

/**
 * sceneId が現在の confinement（在圏）内かどうかを判定する。
 *
 * @param sceneId 遷移先の sceneId
 * @param confinedSceneIds 在圏シーンID一覧。null なら「圏の制限なし」＝常に true
 *   （通常のハブ経由フロー・dev の debug_scene 等、production `?scene=` 以外はすべて null）
 * @returns 圏内（遷移してよい）なら true、圏外（終劇にすべき）なら false
 */
export function isSceneIdConfined(sceneId: string, confinedSceneIds: string[] | null): boolean {
  return confinedSceneIds === null || confinedSceneIds.includes(sceneId)
}
