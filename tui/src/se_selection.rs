//! SE 複数候補プールからのランダム抽出+シャッフル、ランダム間隔の算出、および
//! 生成中の SE シーケンスのキャンセル管理 (#672)。
//!
//! `[SE: p1,p2,..., 選択数=K, 間隔=min-max]` タグの実際の再生順序・タイミング・キャンセルを
//! 決めるロジック本体。`audio::AudioPlayer`（rodio デバイス操作）や `main.rs`（再生トリガ
//! 検出・シーン遷移検出）に直書きせずここに切り出すことで、実オーディオデバイスが無い
//! CI環境でも決定的にテストできる（doctrine 規律4「単一責務」）。GUI版
//! `selectAndShuffleSeFiles`/`randomGapMs`/`AudioManager` の `seSequenceGeneration`
//! （`frontend/src/game/seSelection.ts`/`AudioManager.ts`）と同じロジック。
//!
//! ランダム選択・シャッフル順序はどこにも永続化しない——`playback::Playback::item_se` は
//! 選択前の生の記述（`playback::SeCue`）だけを保持し、実際の抽出は再生トリガのたびに
//! （`main.rs::play_new_se_cues`）新規に計算する（doctrine 規律3、ランダム性を永続構造に
//! 持ち込まない）。
//!
//! `SeSequenceGeneration`（キャンセル管理）を `audio::AudioPlayer` の内部フィールドに直接
//! 持たせず（`Arc<AtomicU64>` を薄くラップするだけの型として）ここに切り出しているのは、
//! `AudioPlayer` 自体が実オーディオデバイス（`rodio::OutputStream`）を要求しCI環境では
//! 一切構築できない（`AudioPlayer::try_new` のdoc comment参照）ため——世代カウンタの
//! 増分・比較というキャンセル機構の中核ロジックだけは、デバイス非依存の状態機械として
//! 独立にテストできるようにする。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

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

/// `AudioPlayer::play_se_sequence` が gap 待機中に生成する背景スレッドをキャンセル可能に
/// する世代カウンタ (#672 フォローアップ)。
///
/// GUI版 `AudioManager.seSequenceGeneration`（`frontend/src/game/AudioManager.ts`）と同じ
/// generation-based cancellation。`clone()` すると同じ内部カウンタ（`Arc<AtomicU64>`）を
/// 共有するため、`AudioPlayer` 本体が持つインスタンスを `play_se_sequence` が spawn する
/// 各スレッドへ `clone()` して渡せば、`cancel()` の効果が全スレッドに届く。
///
/// - `snapshot()`: シーケンス開始時に現在の世代値を捕まえる。
/// - `is_current(snapshot)`: 捕まえた世代がまだ現行かどうかを調べる（gap 待機から
///   戻るたびに呼ぶチェックポイント）。`false` ならそのシーケンスは打ち切る。
/// - `cancel()`: 世代を1つ進める。**新しい `play_se_sequence` の開始そのものでは進めない**
///   ——進めてしまうと「同一フレームで連続発火した別の `[SE:]`」が既存の並行シーケンスを
///   巻き込んで誤って打ち切ってしまう（GUI版と同じ設計上の理由、`AudioManager.ts` の
///   `seSequenceGeneration` フィールド doc comment参照）。呼び出し元（`main.rs`）が
///   シーン遷移（選択肢ジャンプ含む、`playback.current_scene_idx()` の前後比較で検出）を
///   検知した時だけ呼ぶ。
#[derive(Debug, Clone, Default)]
pub struct SeSequenceGeneration(Arc<AtomicU64>);

impl SeSequenceGeneration {
    pub fn new() -> Self {
        Self(Arc::new(AtomicU64::new(0)))
    }

    /// 現在の世代値のスナップショットを取る（シーケンス開始時に1回）。
    pub fn snapshot(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    /// `snapshot` で捕まえた世代がまだ現行（＝ `cancel()` されていない）かどうかを返す。
    pub fn is_current(&self, snapshot: u64) -> bool {
        self.0.load(Ordering::SeqCst) == snapshot
    }

    /// 世代を1つ進める。実行中の全 `play_se_sequence` ループが次のチェックポイントで
    /// 打ち切られる（`is_current` が `false` を返すようになる）。
    pub fn cancel(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
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

    // ---- #672 フォローアップ: SeSequenceGeneration（TUI版 cancel_se_sequence の中核）----
    //
    // `AudioPlayer` 自体は実オーディオデバイスを要求しCI環境では構築できない
    // （`AudioPlayer::try_new` のdoc comment参照）ため、キャンセル機構の中核（世代の
    // 増分・比較）だけをここで直接検証する。GUI版 `AudioManager.test.ts` の
    // テスト34（cancelSeSequence が待機中の再生をキャンセルする）/34b（並行する別シーケンスは
    // 巻き込まない）に対応する。

    #[test]
    fn se_sequence_generation_new_snapshot_is_current_before_any_cancel() {
        // cancel() 前は snapshot() で捕まえた世代がそのまま現行であること（自明だが、
        // is_current の返り値の意味を固定する基準ケース）。
        let gen = SeSequenceGeneration::new();
        let snap = gen.snapshot();
        assert!(gen.is_current(snap));
    }

    #[test]
    fn se_sequence_generation_cancel_invalidates_snapshot_taken_before_it() {
        // cancel() の後は、それより前に取った snapshot は現行でなくなる
        // （GUI版テスト34: 待機中のgap後の再生がキャンセルされる、に対応）。
        let gen = SeSequenceGeneration::new();
        let snap = gen.snapshot();
        gen.cancel();
        assert!(!gen.is_current(snap));
    }

    #[test]
    fn se_sequence_generation_snapshot_taken_after_cancel_is_unaffected() {
        // cancel() の後に新しく取った snapshot は、その cancel() の影響を受けない
        // （＝ cancel 後に始まった新しいシーケンスは通常どおり最後まで再生できる）。
        let gen = SeSequenceGeneration::new();
        gen.cancel();
        let snap = gen.snapshot();
        assert!(gen.is_current(snap));
    }

    #[test]
    fn se_sequence_generation_cancel_invalidates_two_concurrent_snapshots_at_once() {
        // 2つの並行 play_se_sequence 呼び出しが同じ世代を捕まえている状態で cancel() を
        // 1回呼ぶと、両方とも同時に無効化される（GUI版テスト34相当・複数シーケンス版:
        // 「2シーケンスが同時にgap待機中にcancelSeSequence()を1回呼んで両方止まる」）。
        let gen = SeSequenceGeneration::new();
        let snap_a = gen.snapshot();
        let snap_b = gen.snapshot();
        assert!(gen.is_current(snap_a));
        assert!(gen.is_current(snap_b));

        gen.cancel();

        assert!(
            !gen.is_current(snap_a),
            "先発シーケンスもキャンセルされるはず"
        );
        assert!(
            !gen.is_current(snap_b),
            "後発シーケンスもキャンセルされるはず"
        );
    }

    #[test]
    fn se_sequence_generation_starting_new_snapshot_does_not_invalidate_existing_one() {
        // snapshot() を新たに取る（＝新しい [SE:] シーケンスが発火する）だけでは、
        // 既存の（先発の）snapshot は無効化されない——cancel() が明示的に呼ばれた時だけ
        // 無効化される（GUI版テスト34b: 並行して発火した別のplaySeSequenceはcancelSeSequence()
        // の影響を受けない、の裏返し。世代がplaySeSequence自身の開始では増分されないことの
        // 直接確認）。
        let gen = SeSequenceGeneration::new();
        let snap_a = gen.snapshot();
        let _snap_b = gen.snapshot();
        assert!(
            gen.is_current(snap_a),
            "後発シーケンスの開始だけでは先発は無効化されない"
        );
    }

    #[test]
    fn se_sequence_generation_clone_shares_the_same_underlying_counter() {
        // play_se_sequence が spawn するスレッドへは clone() して渡す設計のため、
        // clone 後も同じ世代カウンタを共有していること（独立カウンタになっていないこと）
        // を確認する。ここが壊れると cancel() がスレッド側に届かなくなる。
        let gen = SeSequenceGeneration::new();
        let cloned = gen.clone();
        let snap = cloned.snapshot();

        gen.cancel();

        assert!(
            !cloned.is_current(snap),
            "cloneは同じカウンタを共有するはず"
        );
    }
}
