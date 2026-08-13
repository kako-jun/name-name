//! シーン切り替えごとの自動クイックセーブ・起動時の自動クイックロード（#579）。
//!
//! GUI版（`frontend/src/game/SaveManager.ts` の `quickSave`/`quickLoad`、#578）の TUI 版
//! 対応。GUI版と異なり複数スロットのメニュー式セーブ/ロードは作らない（Issue #579 本文の
//! 明示スコープ外）——単一のクイックセーブファイルのみを扱う。
//!
//! ## 保存先
//!
//! `--config` で指定された config ファイルと同じディレクトリに保存する（GUI版の
//! `docKey` 単位の名前空間化と同じ発想 — ゲームごとに config ファイルが分かれる前提と
//! 整合する）。`--config` 未指定（デフォルト設定使用）時はカレントディレクトリに保存する
//! （[`quicksave_path`] 参照）。ファイル名は config ファイルと衝突しない
//! `.name-name-tui-quicksave.json` 固定。
//!
//! ## fail-soft 方針
//!
//! 書き込み失敗（ディスクフル・権限エラー等）は握りつぶし、シーン進行を止めない
//! （[`save_quick`] 参照）。読み込み失敗（ファイルが無い・壊れている・保存済みシーンIDが
//! 現在の原稿に存在しない等）も同様に握りつぶし、通常起動へフォールバックする
//! （[`restore_playback`]/[`restore_read_positions`] 参照）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cli::Cli;
use crate::flags::GameFlags;
use crate::playback::Playback;

/// config ファイルと衝突しない自動クイックセーブファイル名。
const QUICKSAVE_FILE_NAME: &str = ".name-name-tui-quicksave.json";

/// クイックセーブファイルの中身。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct QuickSaveData {
    /// 保存時点の現在シーンID（`Playback::current_scene_id`）。読み込み時は
    /// `Playback::jump_to_scene_id` にそのまま渡す。
    scene_id: String,
    /// 保存時点のフラグ状態。
    flags: GameFlags,
    /// 保存時点の既読位置集合（`main.rs::event_loop` の `read_positions`）。
    /// 旧バージョンのセーブファイル（このフィールドが無い状態で保存されたもの）を
    /// 読んでも既読なしとして扱えるよう既定値を許容する。
    #[serde(default)]
    read_positions: Vec<(usize, usize, u64)>,
}

/// `cli.config_path` から自動クイックセーブファイルの保存先を決める。
///
/// `--config` 指定時はその config ファイルと同じディレクトリ、未指定時
/// （`Config::default()` 使用）はカレントディレクトリ。`--config` に拡張子無しの
/// ファイル名だけを指定した場合（`parent()` が空文字列を返す）もカレントディレクトリに
/// フォールバックする — どちらのカレントディレクトリ・フォールバックも `"./"` を
/// 前置せず `PathBuf::from(QUICKSAVE_FILE_NAME)` へ揃える（見た目上の表記だけの違いで、
/// 実際に指すファイルは同じ）。
pub fn quicksave_path(cli: &Cli) -> PathBuf {
    match &cli.config_path {
        Some(config_path) => match config_path.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => dir.join(QUICKSAVE_FILE_NAME),
            _ => PathBuf::from(QUICKSAVE_FILE_NAME),
        },
        None => PathBuf::from(QUICKSAVE_FILE_NAME),
    }
}

/// シーン切り替え直後に呼ぶ。現在の `playback`（シーンID・フラグ）と `read_positions`
/// を `path` へ丸ごと上書き保存する。書き込み失敗（シリアライズ失敗含む）は握りつぶし、
/// 戻り値も持たない — 呼び出し側（`main.rs::event_loop`）はセーブの成否に関わらず
/// シーン進行を続ける（モジュール doc comment の fail-soft 方針）。
pub fn save_quick(path: &Path, playback: &Playback, read_positions: &HashSet<(usize, usize, u64)>) {
    let data = QuickSaveData {
        scene_id: playback.current_scene_id().to_string(),
        flags: playback.flags().clone(),
        read_positions: read_positions.iter().copied().collect(),
    };
    let Ok(json) = serde_json::to_string(&data) else {
        return;
    };
    let _ = std::fs::write(path, json);
}

/// 起動時、`Playback` 構築直後（`skip_leading_empty_scenes` より前）に呼ぶ。`path` に
/// 保存済みのクイックセーブがあれば、そのフラグ・シーン位置を `playback` へ復元する。
///
/// 保存済みシーンIDが現在の原稿に実在すると [`Playback::has_scene_id`] で確認できてから
/// 初めて [`Playback::set_flags`] でフラグを上書きし、続けて [`Playback::jump_to_scene_id`]
/// でジャンプする。この順序（存在確認 → フラグ上書き → ジャンプ）には2つの理由がある:
///
/// 1. フラグを**先に**復元する必要がある — ジャンプ先シーンの item 構築
///    （`build_scene_items`）はその時点の `self.flags` を見て `Event::Condition` を
///    評価するため、フラグを先に復元しておかないとジャンプ先の内容（ひいては
///    `stable_item_key` のコンテンツハッシュ）が保存時点と食い違う。
/// 2. だが `set_flags` は無条件に成功する（＝一度呼ぶとロールバックしない）ため、
///    シーンIDが存在しないと分かった**後**に呼ぶと「フラグだけ復元されて位置は
///    構築直後のまま」という中途半端な状態が残ってしまう。先に `has_scene_id` で
///    存在確認しておけば、それ以降の `jump_to_scene_id` は同じ `scene_index_by_id`
///    を見る以上ここで失敗しない。
///
/// ファイルが無い・壊れている・保存済みシーンIDが現在の原稿に見つからない、のいずれの
/// 場合も何もせず `false` を返す（構築直後のまま、通常起動にフォールバックする）。
pub fn restore_playback(playback: &mut Playback, path: &Path) -> bool {
    let Some(data) = load(path) else {
        return false;
    };
    if !playback.has_scene_id(&data.scene_id) {
        return false;
    }
    playback.set_flags(data.flags);
    playback.jump_to_scene_id(&data.scene_id)
}

/// 起動時、`event_loop` の `read_positions` 初期値として呼ぶ。`path` が `None`
/// （`--config` 未指定時でもカレントディレクトリを見る `quicksave_path` の性質上、
/// 主に `Config::quicksave_path` が未設定なテスト用の `Config` から呼ばれた場合)
/// または読み込み失敗時は空集合（既読なしの通常起動と同じ）を返す。
///
/// [`restore_playback`] とは別の関数呼び出しのまま残している（ファイルを2回読むことに
/// なるが、起動時1回きりの小さな JSON ファイルであり無視できるコスト）。ただし
/// 呼び出しそのものは無条件ではない——`event_loop` は `restore_playback` の戻り値
/// （`main()` から `playback_restored: bool` 引数として渡ってくる、#579 追加修正）が
/// `true` の時だけこの関数を呼ぶ。`restore_playback` が `false`（保存済みscene_idが
/// 現在の原稿に存在しない等）を返した場合、`playback` は構築直後の初期状態のまま
/// 止まる設計（`has_scene_id` によるアトミック性）のため、`read_positions` だけ独立に
/// 復元すると「`playback` は初期状態なのに `read_positions` だけ古い値が残る」という
/// 非対称な不整合が生じる。`event_loop` 側がその判定を持つ設計にした理由は
/// `main.rs::event_loop` の `read_positions` 初期化コメント参照。
pub fn restore_read_positions(path: Option<&Path>) -> HashSet<(usize, usize, u64)> {
    let Some(path) = path else {
        return HashSet::new();
    };
    load(path)
        .map(|data| data.read_positions.into_iter().collect())
        .unwrap_or_default()
}

fn load(path: &Path) -> Option<QuickSaveData> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        // #559/#537 等、既存のテストがOSの一時ディレクトリを使っていない（このリポジトリの
        // テストは主にメモリ上の `Playback`/`Config` だけで完結する設計）ため直接の前例は
        // 無いが、実ファイルI/Oを検証する以上テスト間で衝突しない一意なパスが必要。
        // プロセスIDとテスト名を組み合わせて衝突を避ける。
        std::env::temp_dir().join(format!(
            "name-name-tui-save-test-{}-{}.json",
            std::process::id(),
            name
        ))
    }

    struct TempFile(PathBuf);
    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn quicksave_path_uses_config_dir_when_config_path_given() {
        let cli = Cli::parse(vec![
            "name-name-tui".to_string(),
            "--config".to_string(),
            "games/gymnasia/tui-config.toml".to_string(),
        ]);
        assert_eq!(
            quicksave_path(&cli),
            PathBuf::from("games/gymnasia/.name-name-tui-quicksave.json")
        );
    }

    #[test]
    fn quicksave_path_falls_back_to_current_dir_without_config_path() {
        let cli = Cli::parse(vec!["name-name-tui".to_string()]);
        assert_eq!(
            quicksave_path(&cli),
            PathBuf::from(".name-name-tui-quicksave.json")
        );
    }

    #[test]
    fn quicksave_path_falls_back_to_current_dir_for_bare_filename() {
        let cli = Cli::parse(vec![
            "name-name-tui".to_string(),
            "--config".to_string(),
            "tui-config.toml".to_string(),
        ]);
        assert_eq!(
            quicksave_path(&cli),
            PathBuf::from(".name-name-tui-quicksave.json")
        );
    }

    #[test]
    fn save_quick_then_load_round_trips_scene_id_flags_and_read_positions() {
        let path = temp_path("round-trip");
        let _guard = TempFile(path.clone());

        let mut playback_flags = GameFlags::new();
        playback_flags.set(
            "seen_intro",
            name_name_parser::models::FlagValue::Bool(true),
        );

        // `Playback` を直接構築するには Document が要るため、ここでは
        // `QuickSaveData` の往復（シリアライズ→デシリアライズ）だけを検証する。
        // `restore_playback`/`save_quick` の `Playback` 連携は
        // `playback.rs::tests::jump_to_scene_id_*`（ジャンプ本体）と
        // `main.rs` 側の統合テストの組み合わせで間接的にカバーされる。
        let data = QuickSaveData {
            scene_id: "route1-scene3".to_string(),
            flags: playback_flags,
            read_positions: vec![(0, 1, 42), (2, 0, 7)],
        };
        let json = serde_json::to_string(&data).unwrap();
        std::fs::write(&path, json).unwrap();

        let loaded = load(&path).expect("保存直後のファイルは読めるはず");
        assert_eq!(loaded.scene_id, "route1-scene3");
        assert!(loaded.flags.check("seen_intro"));
        assert_eq!(loaded.read_positions, vec![(0, 1, 42), (2, 0, 7)]);
    }

    #[test]
    fn load_returns_none_for_missing_file() {
        let path = temp_path("missing");
        assert!(load(&path).is_none());
    }

    #[test]
    fn load_returns_none_for_corrupt_json() {
        let path = temp_path("corrupt");
        let _guard = TempFile(path.clone());
        std::fs::write(&path, "not valid json").unwrap();

        assert!(load(&path).is_none());
    }

    #[test]
    fn restore_read_positions_returns_empty_set_when_path_is_none() {
        assert_eq!(restore_read_positions(None), HashSet::new());
    }

    #[test]
    fn restore_read_positions_returns_empty_set_when_file_missing() {
        let path = temp_path("read-positions-missing");
        assert_eq!(restore_read_positions(Some(&path)), HashSet::new());
    }

    #[test]
    fn restore_read_positions_loads_saved_set() {
        let path = temp_path("read-positions-loaded");
        let _guard = TempFile(path.clone());
        let data = QuickSaveData {
            scene_id: "s".to_string(),
            flags: GameFlags::new(),
            read_positions: vec![(1, 2, 3)],
        };
        std::fs::write(&path, serde_json::to_string(&data).unwrap()).unwrap();

        let restored = restore_read_positions(Some(&path));
        assert_eq!(restored, HashSet::from([(1, 2, 3)]));
    }

    /// 2シーン構成（"1-1" → Choice → "1-2"）の原稿。`restore_playback` の
    /// 「フラグ上書き→ジャンプ」を実際の `Playback`/`Document` を通して検証する
    /// （`QuickSaveData` の往復だけを見ている `save_quick_then_load_round_trips_*` とは
    /// 別に、`Playback::has_scene_id`/`jump_to_scene_id` との結線そのものを確認する）。
    fn two_scene_source() -> &'static str {
        "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\n最初のセリフ\n\n\
         [選択]\n- 進む→1-2\n[/選択]\n\n## 1-2: 次\n\n**B**:\n次のセリフ\n"
    }

    #[test]
    fn restore_playback_applies_flags_and_jumps_to_saved_scene() {
        let path = temp_path("restore-playback");
        let _guard = TempFile(path.clone());
        let document = name_name_parser::parser::parse(two_scene_source());

        let mut flags = GameFlags::new();
        flags.set(
            "visited_1_2",
            name_name_parser::models::FlagValue::Bool(true),
        );
        let data = QuickSaveData {
            scene_id: "1-2".to_string(),
            flags,
            read_positions: vec![],
        };
        std::fs::write(&path, serde_json::to_string(&data).unwrap()).unwrap();

        let mut playback = Playback::from_document(&document);
        assert_eq!(playback.current_scene_id(), "1-1");

        assert!(restore_playback(&mut playback, &path));

        assert_eq!(playback.current_scene_id(), "1-2");
        assert!(playback.flags().check("visited_1_2"));
        assert_eq!(
            playback
                .current_line()
                .expect("復元後の会話行")
                .speaker
                .as_deref(),
            Some("B")
        );
    }

    #[test]
    fn restore_playback_does_not_touch_flags_when_saved_scene_id_is_stale() {
        // 原稿が変わって保存済みシーンIDが消えたケース（`has_scene_id` ガードの本体）。
        let path = temp_path("restore-playback-stale-scene");
        let _guard = TempFile(path.clone());
        let document = name_name_parser::parser::parse(
            "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\n最初のセリフ\n",
        );

        let mut flags = GameFlags::new();
        flags.set(
            "should_not_apply",
            name_name_parser::models::FlagValue::Bool(true),
        );
        let data = QuickSaveData {
            scene_id: "does-not-exist".to_string(),
            flags,
            read_positions: vec![],
        };
        std::fs::write(&path, serde_json::to_string(&data).unwrap()).unwrap();

        let mut playback = Playback::from_document(&document);

        assert!(!restore_playback(&mut playback, &path));

        assert!(
            !playback.flags().check("should_not_apply"),
            "存在しないシーンIDなら復元全体を諦め、flagsも上書きされないはず（中途半端な適用の防止）"
        );
        assert_eq!(playback.current_scene_id(), "1-1");
    }

    #[test]
    fn restore_playback_returns_false_when_file_missing() {
        let path = temp_path("restore-playback-missing");
        let document = name_name_parser::parser::parse(two_scene_source());
        let mut playback = Playback::from_document(&document);

        assert!(!restore_playback(&mut playback, &path));
        assert_eq!(playback.current_scene_id(), "1-1");
    }
}
