//! SE 複数候補プールからのランダム抽出+シャッフル、およびランダム間隔の算出 (#672)。
//!
//! `[SE: p1,p2,..., 選択数=K, 間隔=min-max]` タグの実際の再生順序・タイミングを決める
//! ロジック本体。`audio::AudioPlayer`（rodio デバイス操作）や `main.rs`（再生トリガ検出）に
//! 直書きせずここに切り出すことで、実オーディオデバイスが無いCI環境でも決定的に
//! テストできる（doctrine 規律4「単一責務」）。GUI版 `selectAndShuffleSeFiles`/`randomGapMs`
//! （`frontend/src/game/seSelection.ts`）と同じロジック。
//!
//! ランダム選択・シャッフル順序はどこにも永続化しない——`playback::Playback::item_se` は
//! 選択前の生の記述（`playback::SeCue`）だけを保持し、実際の抽出は再生トリガのたびに
//! （`main.rs::play_new_se_cues`）新規に計算する（doctrine 規律3、ランダム性を永続構造に
//! 持ち込まない）。

use rand::seq::SliceRandom;
use rand::Rng;

/// `paths` から `count` 件を重複無しでランダム抽出し、シャッフル済みの順序で返す。
///
/// - `count` が `None` の場合は全件（K = `paths.len()`）を使う。
/// - `count` が `paths.len()` を超える場合は全件にクランプする。
/// - `count` が `Some(0)` の場合は空を返す（呼び出し側は「SE無し」として扱う）。
pub fn select_and_shuffle_se_files<R: Rng + ?Sized>(
    paths: &[String],
    count: Option<u32>,
    rng: &mut R,
) -> Vec<String> {
    if paths.is_empty() {
        return Vec::new();
    }
    let k = count
        .map(|c| c as usize)
        .unwrap_or(paths.len())
        .min(paths.len());
    let mut shuffled: Vec<String> = paths.to_vec();
    shuffled.shuffle(rng);
    shuffled.truncate(k);
    shuffled
}

/// `[min, max]`（ms、順不同）の範囲から一様ランダムな整数 ms を1つ返す。
/// `min`/`max` の大小が入れ替わっていても内部で正規化するため安全。
/// `min == max`（正規化後）の場合は `rng.gen_range` の空区間パニックを避けてその値を返す。
pub fn random_gap_ms<R: Rng + ?Sized>(min: u32, max: u32, rng: &mut R) -> u32 {
    let lo = min.min(max);
    let hi = min.max(max);
    if lo == hi {
        lo
    } else {
        rng.gen_range(lo..=hi)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::mock::StepRng;

    // StepRng(0, 1) は呼び出しのたびに単調増加する決定的な疑似乱数を返す
    // （実際の分布ではなく「壊れていないこと」の確認用、rand crate 標準の mock rng）。

    #[test]
    fn select_and_shuffle_returns_all_when_count_is_none() {
        let paths = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let mut rng = StepRng::new(0, 1);
        let selected = select_and_shuffle_se_files(&paths, None, &mut rng);
        assert_eq!(selected.len(), 3);
        // 中身は3件とも一致する（順序はシャッフルされうるので集合として比較）
        let mut sorted = selected.clone();
        sorted.sort();
        assert_eq!(
            sorted,
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn select_and_shuffle_clamps_count_larger_than_pool() {
        let paths = vec!["a".to_string(), "b".to_string()];
        let mut rng = StepRng::new(0, 1);
        let selected = select_and_shuffle_se_files(&paths, Some(10), &mut rng);
        assert_eq!(selected.len(), 2);
    }

    #[test]
    fn select_and_shuffle_extracts_k_without_duplicates() {
        let paths = vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "d".to_string(),
            "e".to_string(),
        ];
        let mut rng = StepRng::new(7, 3);
        let selected = select_and_shuffle_se_files(&paths, Some(3), &mut rng);
        assert_eq!(selected.len(), 3);
        let mut sorted = selected.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 3, "重複無しであること: {selected:?}");
        for p in &selected {
            assert!(paths.contains(p));
        }
    }

    #[test]
    fn select_and_shuffle_count_one_returns_single_element() {
        // count=Some(1) で要素数1を返す（既存テストには K=1 単体ケースの明示が無かった）
        let paths = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let mut rng = StepRng::new(0, 1);
        let selected = select_and_shuffle_se_files(&paths, Some(1), &mut rng);
        assert_eq!(selected.len(), 1);
        assert!(paths.contains(&selected[0]));
    }

    #[test]
    fn select_and_shuffle_single_element_pool_with_count_exceeding_pool_does_not_panic() {
        // N=1 の pool で count>N を渡してもパニックせず clamp されて1件返る
        let paths = vec!["only".to_string()];
        let mut rng = StepRng::new(0, 1);
        let selected = select_and_shuffle_se_files(&paths, Some(5), &mut rng);
        assert_eq!(selected, vec!["only".to_string()]);
    }

    #[test]
    fn select_and_shuffle_count_zero_returns_empty() {
        let paths = vec!["a".to_string(), "b".to_string()];
        let mut rng = StepRng::new(0, 1);
        let selected = select_and_shuffle_se_files(&paths, Some(0), &mut rng);
        assert!(selected.is_empty());
    }

    #[test]
    fn select_and_shuffle_empty_pool_returns_empty() {
        let paths: Vec<String> = Vec::new();
        let mut rng = StepRng::new(0, 1);
        let selected = select_and_shuffle_se_files(&paths, None, &mut rng);
        assert!(selected.is_empty());
    }

    #[test]
    fn random_gap_ms_stays_within_range() {
        let mut rng = StepRng::new(0, 0x1111_1111_1111_1111);
        for _ in 0..20 {
            let gap = random_gap_ms(50, 200, &mut rng);
            assert!((50..=200).contains(&gap), "gap={gap} out of range");
        }
    }

    #[test]
    fn random_gap_ms_normalizes_reversed_min_max() {
        let mut rng = StepRng::new(0, 1);
        let gap = random_gap_ms(200, 50, &mut rng);
        assert!((50..=200).contains(&gap));
    }

    #[test]
    fn random_gap_ms_equal_min_max_returns_that_value_without_panicking() {
        let mut rng = StepRng::new(0, 1);
        assert_eq!(random_gap_ms(100, 100, &mut rng), 100);
    }
}
