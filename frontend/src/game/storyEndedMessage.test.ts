/**
 * buildStoryEndedMessage(scene, project) のテスト (#395)。
 *
 * `sceneQuery.test.ts` / `debugQuery.test.ts` と同じ流儀（副作用なし・DOM 非依存の純粋関数に
 * 引数を渡し、戻り値を直接突き合わせる）で、観点ごとに 1 テストにする。
 *
 * この関数は「入力（scene, project）→ 固定形状の 4 フィールド」の写像だけを担う純粋関数なので、
 * 主目的は **契約リグレッションの固定**（source/type の値・フィールド名・欠落・値変更を許さない）。
 * 契約は theo-hayami #30 と共有し、埋め込み側（親ウィンドウ）が受信して既読を記録する。
 *
 * 観点の適用/非適用:
 *   - 適用: 契約 4 フィールド完全一致 / scene の null 許容（唯一の意味ある境界）/
 *           source・type のリテラル固定（別 project・scene でも不変）/ 空 project の通過。
 *   - 非適用（この関数の責務外なので書かない）:
 *       * i18n・特殊文字   … scene/project は不透明な文字列として素通しするだけ（変換しない）。
 *       * 権限・認可        … 純粋計算に権限概念が無い。
 *       * 日付・時刻        … タイムスタンプを持たない契約。
 *       * race・並行        … 引数だけに依存し共有状態・非同期を持たない。
 *       * 発火条件・埋め込み判定・postMessage 副作用 … 呼び出し側（NovelPlayer）の責務。
 *         → NovelPlayer.test.tsx の #395 グループが担保する。
 */
import { describe, it, expect } from 'vitest'
import { buildStoryEndedMessage, type StoryEndedMessage } from './storyEndedMessage'

// 契約リテラル（theo-hayami #30 と共有）。ここを唯一の真実として全アサーションで参照し、
// 値の改名・変更が起きたら本ファイルが赤くなるようにする。
const SOURCE = 'name-name' as const
const TYPE = 'story-ended' as const

describe('buildStoryEndedMessage (#395)', () => {
  // ===== A. 契約 4 フィールド完全一致（主目的＝契約リグレッション固定） =====

  it('1: (scene, project) を渡すと契約 4 フィールドが完全一致する（toEqual で余剰・欠落も弾く）', () => {
    const message: StoryEndedMessage = buildStoryEndedMessage('aristo-ai', 'theo-hayami')
    expect(message).toEqual({
      source: SOURCE,
      type: TYPE,
      scene: 'aristo-ai',
      project: 'theo-hayami',
    })
  })

  // ===== B. scene の null 許容（この関数の唯一の意味ある境界） =====

  it('2: scene=null を許容し scene:null をそのまま載せる（ディープリンク無し完読でも通知する）', () => {
    expect(buildStoryEndedMessage(null, 'theo-hayami')).toEqual({
      source: SOURCE,
      type: TYPE,
      scene: null,
      project: 'theo-hayami',
    })
  })

  // ===== C. source / type のリテラル固定（別 project・scene でも不変） =====

  it('3: 別の project / scene でも source は "name-name" 固定', () => {
    expect(buildStoryEndedMessage('s1', 'other-project').source).toBe(SOURCE)
  })

  it('4: 別の project / scene でも type は "story-ended" 固定', () => {
    expect(buildStoryEndedMessage('s1', 'other-project').type).toBe(TYPE)
  })

  // ===== D. 空 project の通過（送信側で弾かない＝そのまま載せる） =====

  it('5: 空 project "" も通し project:"" を載せる（docKey 未設定でも完読は通知する）', () => {
    expect(buildStoryEndedMessage('s1', '')).toEqual({
      source: SOURCE,
      type: TYPE,
      scene: 's1',
      project: '',
    })
  })
})
