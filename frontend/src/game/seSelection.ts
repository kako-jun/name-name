/**
 * SE 複数候補プールからのランダム抽出+シャッフル、およびランダム間隔の算出 (#672)。
 *
 * `[SE: p1,p2,..., 選択数=K, 間隔=min-max]` タグの実際の再生順序・タイミングを決める
 * ロジック本体。レンダラ本体（NovelRenderer）や AudioManager に直書きせず、ここに
 * 切り出すことで乱数源を差し替えてテスト可能にする（doctrine 規律4「単一責務」）。
 * TUI版 `select_and_shuffle_se_files`（`tui/src/se_selection.rs`）と同じロジック。
 *
 * ランダム選択・シャッフル順序はどこにも永続化しない（GameState/セーブデータに持ち込まない、
 * doctrine 規律3）。呼び出しのたびに新しく計算される一過性の値。
 */

/**
 * `paths` から `count` 件を重複無しでランダム抽出し、シャッフル済みの順序で返す。
 *
 * - `count` が `null`/`undefined` の場合は全件（K = paths.length）を使う。
 * - `count` が `paths.length` を超える場合は全件にクランプする。
 * - `count` が 0 以下の場合は空配列を返す（呼び出し側は「SE無し」として扱う）。
 * - `random` は `[0, 1)` の一様乱数を返す関数。既定は `Math.random`（テストでは差し替え可能）。
 */
export function selectAndShuffleSeFiles(
  paths: readonly string[],
  count: number | null | undefined,
  random: () => number = Math.random
): string[] {
  if (paths.length === 0) return []
  const k = Math.max(0, Math.min(count ?? paths.length, paths.length))
  if (k === 0) return []

  // Fisher-Yates シャッフル後に先頭 k 件を取る = 重複無しランダム抽出+シャッフル済み順序、
  // を1回の走査で同時に満たす標準的な実装。
  const shuffled = paths.slice()
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, k)
}

/**
 * `[min, max]`（ms、順不同）の範囲から一様ランダムな整数 ms を1つ返す。
 * `min`/`max` の大小が入れ替わっていても内部で正規化するため安全。
 */
export function randomGapMs(min: number, max: number, random: () => number = Math.random): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return Math.round(lo + random() * (hi - lo))
}
