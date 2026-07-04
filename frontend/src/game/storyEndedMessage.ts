/**
 * 終劇（endStory＝そのセルを読み切って "to be continued..." に達した瞬間）を、
 * iframe 埋め込み時に親ウィンドウへ通知する postMessage のメッセージ本体を組み立てる (#395)。
 *
 * theo-hayami サイトは name-name を `<iframe>` 単独埋め込みし、各セル（`?scene=<sceneId>`）を
 * 終劇まで読ませる。既読は name-name 側の別オリジン localStorage に入るため親からは読めない。
 * そこで「このセルを読み終わった」という事実を親へ postMessage で通知し、theo-hayami が
 * 自前で記録する。本関数はメッセージの純粋な組み立てだけを担い、副作用（window.parent.postMessage）
 * や埋め込み判定（isEmbedded）・発火条件（ended の立ち上がり）は呼び出し側（NovelPlayer）に置く
 * （doctrine 規律6: 純粋計算を切り出してテスト可能にする）。
 *
 * メッセージ契約は theo-hayami #30 と共有・厳守。フィールドの追加・改名・値の変更をしない:
 *   - source:  'name-name' 固定。受信側が自分宛メッセージかを判別するための送信元タグ。
 *   - type:    'story-ended' 固定。イベント種別。
 *   - scene:   `?scene=` の値（そのセルの sceneId）。埋め込みディープリンク時は非 null だが、
 *              無くても「読み終わった」事実は送る価値があるため string|null を許容する。
 *   - project: 作品名（NovelPlayer の docKey ＝ PlayerScreen が渡す projectName）。
 */
export interface StoryEndedMessage {
  source: 'name-name'
  type: 'story-ended'
  scene: string | null
  project: string
}

/**
 * 終劇通知メッセージを組み立てる。純粋関数（引数のみに依存・副作用なし）。
 *
 * @param scene   読み終えたセルの sceneId（`?scene=` の値）。無いときは null。
 * @param project 作品名（docKey ＝ projectName）。
 */
export function buildStoryEndedMessage(scene: string | null, project: string): StoryEndedMessage {
  return {
    source: 'name-name',
    type: 'story-ended',
    scene,
    project,
  }
}
