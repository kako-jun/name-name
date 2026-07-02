/**
 * NPC 会話ダイアログ用ヘルパー (#101 Phase 2)。
 *
 * NPC の message 内に `[expression=sad]` を書くと、expressions マップから
 * 対応する portrait パスを解決して DialogBox に渡すことができる。
 *
 * 構文:
 *   [expression=表情名]   — その時点から指定の表情に切り替える
 *
 * 現在の実装: message 内で最初に現れた `[expression=...]` だけを見て
 * 初期表情を決定する（非グローバル regex で exec）。
 * message 先頭でない箇所に書いても有効になる点に注意。
 * 複数ページ・途中切替は将来の拡張で対応予定。
 */

import type { UiNpcData } from '../types/rpg'
import { hasOwn } from './ownProperty'

/** `[expression=xxx]` にマッチする正規表現（非グローバル: exec が安全） */
const EXPRESSION_RE = /\[expression=([^\]]+)\]/

/**
 * NPC の message + expressions マップから、ダイアログ表示時に使う portrait パスを解決する。
 *
 * - message 内に `[expression=sad]` があり、`expressions['sad']` に値があればそれを返す
 * - なければ `npc.portrait` をそのまま返す
 * - expressions も portrait も未指定なら `undefined`
 *
 * Note: `expressions` が空オブジェクト `{}` の場合は `portrait` にフォールバックする。
 */
export function resolveNpcPortrait(npc: UiNpcData): string | undefined {
  if (npc.expressions && Object.keys(npc.expressions).length > 0) {
    const m = EXPRESSION_RE.exec(npc.message)
    if (m) {
      const expr = m[1].trim()
      // own-property のみ見る (#368)。素朴な `npc.expressions[expr]` は Object.prototype も辿って
      // しまい、message 側が自由記述の `expr` が `constructor` 等と一致すると `if (path)` の
      // 真偽判定を通過して関数オブジェクトを portrait パスとして返してしまう。
      if (hasOwn(npc.expressions, expr)) {
        const path = npc.expressions[expr]
        if (path) return path
      }
    }
  }
  return npc.portrait
}

/**
 * NPC の message から `[expression=xxx]` ディレクティブを除去した表示用テキストを返す。
 *
 * ディレクティブ行の直後の改行も合わせて除去する。
 * 全体の `.trim()` は行わない（本文前後の意図的な空白を保持するため）。
 * 将来複数ページ対応時はページ境界での除去が必要になる。
 */
export function stripExpressionDirectives(message: string): string {
  return message.replace(/\[expression=[^\]]*\]\n?/g, '')
}
