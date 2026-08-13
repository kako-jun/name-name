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
use crate::playback::{Playback, SceneContinuation};

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
    /// 保存時点の BGM のパス（`Playback::current_bgm`、#579 セルフレビュー must対応）。
    /// 着地シーンより手前で宣言され着地シーン自身では再宣言されない「継承しているだけ」の
    /// 状態は、`jump_to_scene_id` で直接ジャンプするだけでは復元できない（実際にプレイヤーが
    /// 辿った中間シーンを再生しないため）——モジュール冒頭ドキュメント参照。旧バージョンの
    /// セーブファイル（このフィールドが無い状態で保存されたもの）を読んでも BGM 無しとして
    /// 扱えるよう既定値を許容する。
    #[serde(default)]
    current_bgm: Option<String>,
    /// 保存時点のイベント絵のパス（`Playback::current_event_image`）。`current_bgm` と同じ
    /// 理由・同じ後方互換方針。
    #[serde(default)]
    current_event_image: Option<String>,
    /// 保存時点の暗転状態（`Playback::is_blackout`）。`current_bgm` と同じ理由・同じ後方
    /// 互換方針（旧セーブファイルは暗転なし=`false`として扱う）。
    #[serde(default)]
    current_blackout: bool,
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
        current_bgm: playback.current_bgm().map(str::to_string),
        current_event_image: playback.current_event_image().map(str::to_string),
        current_blackout: playback.is_blackout(),
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
    // #579 セルフレビュー must対応: 単純な `jump_to_scene_id` は実際にプレイヤーが辿った
    // 中間シーンを再生しないため、着地シーンより手前で宣言され着地シーン自身では再宣言
    // されない「継承しているだけ」の状態（BGM/イベント絵/暗転）が復元時にサイレントに
    // 失われる。保存しておいた3値を `SceneContinuation` として明示的に渡すことで、
    // ジャンプ先シーンの item 構築時にこれらが正しく焼き付くようにする
    // （`Playback::jump_to_scene_id_with_continuation` doc comment参照）。
    playback.jump_to_scene_id_with_continuation(
        &data.scene_id,
        SceneContinuation {
            bgm: data.current_bgm,
            event_image: data.current_event_image,
            blackout: data.current_blackout,
        },
    )
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
            current_bgm: Some("chapter2.ogg".to_string()),
            current_event_image: Some("mid.webp".to_string()),
            current_blackout: true,
        };
        let json = serde_json::to_string(&data).unwrap();
        std::fs::write(&path, json).unwrap();

        let loaded = load(&path).expect("保存直後のファイルは読めるはず");
        assert_eq!(loaded.scene_id, "route1-scene3");
        assert!(loaded.flags.check("seen_intro"));
        assert_eq!(loaded.read_positions, vec![(0, 1, 42), (2, 0, 7)]);
        assert_eq!(loaded.current_bgm, Some("chapter2.ogg".to_string()));
        assert_eq!(loaded.current_event_image, Some("mid.webp".to_string()));
        assert!(loaded.current_blackout);
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
            current_bgm: None,
            current_event_image: None,
            current_blackout: false,
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

    /// 3シーン構成（"1-1" → Choice → "1-2"（BGM/イベント絵/暗転を宣言） → Choice →
    /// "1-3"（無宣言、"1-2"からの継承のみ））の原稿（#579 セルフレビュー must対応）。
    /// レビュアーが検証した再現方法と同じ形——`current_bgm`/`current_event_image`/
    /// `is_blackout` のいずれも "1-3" 自身は再宣言せず、"1-2" から継承しているだけの
    /// 状態を、自動クイックロードが正しく復元できるかを検証するための原稿。
    fn three_scene_source_with_continuation_state() -> &'static str {
        "---\nengine: name-name\n---\n\n\
         ## 1-1: 開始\n\n**A**:\n最初のセリフ\n\n\
         [選択]\n- 進む→1-2\n[/選択]\n\n\
         ## 1-2: 中間\n\n[BGM: chapter2.ogg]\n[イベント絵: mid.webp]\n[暗転]\n\n\
         **B**:\n中間のセリフ\n\n\
         [選択]\n- 進む→1-3\n[/選択]\n\n\
         ## 1-3: 終着\n\n**C**:\n宣言なしセリフ\n"
    }

    /// #579 セルフレビュー must対応の再現テスト。レビュアーが検証した再現方法
    /// （モジュール冒頭ドキュメント参照）をそのまま実行する: 実際に "1-1"→"1-2"
    /// （BGM/イベント絵/暗転を宣言）→"1-3"（無宣言）とプレイし、その状態を
    /// `save_quick` で保存、別の新規 `Playback` へ `restore_playback` で復元して、
    /// `current_bgm`/`current_event_image`/`is_blackout` の3値がいずれも
    /// サイレントに失われず正しく引き継がれることを確認する。
    #[test]
    fn save_quick_then_restore_carries_bgm_event_image_and_blackout_inherited_from_earlier_scene() {
        let path = temp_path("continuation-round-trip");
        let _guard = TempFile(path.clone());
        let document =
            name_name_parser::parser::parse(three_scene_source_with_continuation_state());

        let mut playback = Playback::from_document(&document);
        assert!(playback.jump_to_scene_id("1-2"));
        // "1-2"到達時点で実際にBGM/イベント絵/暗転が効いていることを前提として確認
        // （この前提が崩れていたら再現テストとして無意味なため）。
        assert_eq!(playback.current_bgm(), Some("chapter2.ogg"));
        assert_eq!(playback.current_event_image(), Some("mid.webp"));
        assert!(playback.is_blackout());

        assert!(playback.jump_to_scene_id("1-3"));
        // 実際にプレイして辿り着いた場合は"1-2"からの継承がそのまま効いているはず
        // （このPlaybackは"1-1"から生きたまま進んでいるため、レビュアー指摘の
        // 「サイレントに失われる」対象はこの後の保存→復元の方）。
        assert_eq!(playback.current_bgm(), Some("chapter2.ogg"));
        assert_eq!(playback.current_event_image(), Some("mid.webp"));
        assert!(playback.is_blackout());

        save_quick(&path, &playback, &HashSet::new());

        let mut restored_playback = Playback::from_document(&document);
        assert!(restore_playback(&mut restored_playback, &path));

        assert_eq!(restored_playback.current_scene_id(), "1-3");
        assert_eq!(
            restored_playback.current_bgm(),
            Some("chapter2.ogg"),
            "\"1-3\"自身は[BGM:]を再宣言していないため、修正前は復元後にNoneへ\
             サイレントに失われていたはず"
        );
        assert_eq!(
            restored_playback.current_event_image(),
            Some("mid.webp"),
            "\"1-3\"自身は[イベント絵:]を再宣言していないため、修正前は復元後にNoneへ\
             サイレントに失われていたはず"
        );
        assert!(
            restored_playback.is_blackout(),
            "\"1-3\"自身は[暗転解除]を宣言していないため、修正前は復元後にfalseへ\
             サイレントに失われていたはず"
        );
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
            current_bgm: None,
            current_event_image: None,
            current_blackout: false,
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
            current_bgm: None,
            current_event_image: None,
            current_blackout: false,
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

    /// #579: 「保存先」ドキュメントコメントの `quicksave_path` 同値クラス補完。
    /// `--config` に絶対パスを渡した場合も相対パスと同じロジック（`parent()`のディレクトリ
    /// 配下）になることを確認する（相対パスは
    /// `quicksave_path_uses_config_dir_when_config_path_given` が既にカバー済み）。
    #[test]
    fn quicksave_path_uses_config_dir_for_absolute_config_path() {
        let cli = Cli::parse(vec![
            "name-name-tui".to_string(),
            "--config".to_string(),
            "/opt/games/gymnasia/tui-config.toml".to_string(),
        ]);
        assert_eq!(
            quicksave_path(&cli),
            PathBuf::from("/opt/games/gymnasia/.name-name-tui-quicksave.json")
        );
    }

    /// #579 の状態遷移テーブル行C相当（正常系）の統合ラウンドトリップ。
    /// `save_quick_then_load_round_trips_scene_id_flags_and_read_positions`は
    /// `QuickSaveData`単体の往復（`Playback`を経由しない）、
    /// `restore_playback_applies_flags_and_jumps_to_saved_scene`は`restore_playback`単体
    /// （`read_positions`を見ない）と、それぞれ検証範囲が分かれていた。ここでは実際の
    /// `Playback`から`save_quick`で書き出し、`restore_playback`+`restore_read_positions`
    /// （`main.rs::event_loop`が起動時に実際に呼ぶのと同じ2関数）で読み戻すところまでを
    /// 1本のテストとして通し、scene_id・flags・read_positionsの3点すべてが実ファイル
    /// I/O経由で一致することを確認する。
    #[test]
    fn save_quick_then_restore_round_trips_scene_id_flags_and_read_positions_via_real_playback() {
        let path = temp_path("full-round-trip");
        let _guard = TempFile(path.clone());
        let document = name_name_parser::parser::parse(two_scene_source());

        let mut playback = Playback::from_document(&document);
        let mut flags = GameFlags::new();
        flags.set(
            "visited_1_2",
            name_name_parser::models::FlagValue::Bool(true),
        );
        playback.set_flags(flags);
        assert!(playback.jump_to_scene_id("1-2"));

        let read_positions: HashSet<(usize, usize, u64)> = HashSet::from([(0, 0, 1), (0, 1, 2)]);
        save_quick(&path, &playback, &read_positions);

        let mut restored_playback = Playback::from_document(&document);
        let playback_restored = restore_playback(&mut restored_playback, &path);
        // `main.rs::event_loop`と同じ「playback_restoredがtrueの時だけread_positionsも
        // 復元する」ガードをここでも踏襲する（デシジョンテーブル行D対策の配線をそのまま
        // なぞる）。
        let restored_read_positions = if playback_restored {
            restore_read_positions(Some(&path))
        } else {
            HashSet::new()
        };

        assert!(
            playback_restored,
            "保存直後の正常なファイルは復元に成功するはず"
        );
        assert_eq!(restored_playback.current_scene_id(), "1-2");
        assert!(restored_playback.flags().check("visited_1_2"));
        assert_eq!(restored_read_positions, read_positions);
    }

    /// #579 fail-soft: 書き込み先ディレクトリに書き込み権限が無い場合でも`save_quick`が
    /// パニックしないことを確認する（unix権限、`std::fs::set_permissions`で再現）。
    /// macOSのローカル開発機（非root実行）を前提とする——rootで実行するとディレクトリの
    /// 書き込み禁止が effectively 無視されるため、このテストの前提が崩れる。
    #[test]
    fn save_quick_does_not_panic_when_target_directory_is_read_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "name-name-tui-save-readonly-dir-{}",
            std::process::id()
        ));
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();

        struct ReadonlyDirGuard(PathBuf);
        impl Drop for ReadonlyDirGuard {
            fn drop(&mut self) {
                // remove_dir_allの前に書き込み権限を戻さないと自分自身の削除にも失敗する。
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = ReadonlyDirGuard(dir.clone());

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let path = dir.join("quicksave.json");

        let document = name_name_parser::parser::parse(two_scene_source());
        let playback = Playback::from_document(&document);

        // パニックしないこと自体がこのテストの主張。
        save_quick(&path, &playback, &HashSet::new());

        assert!(
            !path.exists(),
            "書き込み権限が無いディレクトリでは実際にファイルは作られないはず \
             (fail-softで握りつぶされた結果の確認)"
        );
    }

    /// #579 fail-soft: `flags`にNaN/Infinityを含めても`save_quick`がパニックしないことを
    /// 確認する。
    ///
    /// 発見（このテスト作成時に実測）: serde_jsonのf64シリアライズは、テスト観点設計時に
    /// 想定されていた「NaN/Infinityは`to_string`が`Err`を返す」ではなく、JSON仕様上
    /// 表現できないNaN/Infinityを黙って`null`として書き出す
    /// （`serde_json::ser::Serializer::serialize_f64`の既定実装、`Err`にはならない）。
    /// そのため`save_quick`内の`serde_json::to_string`が失敗して書き込みスキップ、という
    /// 経路には实際には入らない——書き込みは（`null`を含む形で）成功する。ただし
    /// 「パニックしない」というfail-softの目的そのものは変わらず達成されており、副作用と
    /// して書き込まれた`null`はf64として妥当でないため、次回の`load`（デシリアライズ）が
    /// 失敗し`None`にフォールバックする（下のアサーションで確認）——結果として
    /// fail-softの連鎖は「書き込み時」ではなく「次回読み込み時」に成立する。
    #[test]
    fn save_quick_with_nan_or_infinite_flag_value_does_not_panic() {
        let path = temp_path("nan-flag-value");
        let _guard = TempFile(path.clone());

        let document = name_name_parser::parser::parse(two_scene_source());
        let mut playback = Playback::from_document(&document);
        let mut flags = GameFlags::new();
        flags.set(
            "nan_flag",
            name_name_parser::models::FlagValue::Number(f64::NAN),
        );
        flags.set(
            "inf_flag",
            name_name_parser::models::FlagValue::Number(f64::INFINITY),
        );
        playback.set_flags(flags);

        // パニックしないこと自体がこのテストの主張。
        save_quick(&path, &playback, &HashSet::new());

        assert!(
            path.exists(),
            "NaN/Infinityはto_stringのErrにはならずnullとして書き込まれる \
             (このテストで実測した実際の挙動、doc comment参照)"
        );
        assert!(
            load(&path).is_none(),
            "書き込まれたnullはf64としてデシリアライズできないため、\
             次回の読み込み側がfail-softでNoneに落ちるはず"
        );
    }

    /// #579 fail-soft: セーブファイル自体は存在するが読み取り権限が無い場合、`load`が
    /// `None`を返し`restore_playback`が`false`で正常にフォールバックすることを確認する
    /// （`save_quick`側の書き込み権限テストと対の、読み込み側の権限テスト）。macOSの
    /// ローカル開発機（非root実行）を前提とする。
    #[test]
    fn restore_playback_returns_false_when_file_is_not_readable() {
        use std::os::unix::fs::PermissionsExt;

        let path = temp_path("restore-playback-unreadable");
        let document = name_name_parser::parser::parse(two_scene_source());

        struct PermissionRestoringGuard(PathBuf);
        impl Drop for PermissionRestoringGuard {
            fn drop(&mut self) {
                // remove_fileの前に読み取り権限を戻す(TempFileのDropより先に効かせる必要は
                // ないが、権限0のまま消せないOS/権限モデルもあるため念のため戻しておく)。
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o644));
            }
        }
        let _perm_guard = PermissionRestoringGuard(path.clone());
        let _guard = TempFile(path.clone());

        let mut flags = GameFlags::new();
        flags.set(
            "visited_1_2",
            name_name_parser::models::FlagValue::Bool(true),
        );
        let data = QuickSaveData {
            scene_id: "1-2".to_string(),
            flags,
            read_positions: vec![],
            current_bgm: None,
            current_event_image: None,
            current_blackout: false,
        };
        std::fs::write(&path, serde_json::to_string(&data).unwrap()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

        let mut playback = Playback::from_document(&document);

        assert!(
            !restore_playback(&mut playback, &path),
            "読み取り権限が無いファイルはload()が失敗しNoneを返しfalseへフォールバックするはず"
        );
        assert_eq!(
            playback.current_scene_id(),
            "1-1",
            "復元失敗時はplaybackが構築直後のまま変わらないはず"
        );
    }

    /// 3シーン構成: "1-1"（台詞→Flagで`set_flag`をtrueにする→2オプションのChoice、
    /// 一方は`set_flag`条件でロック解除済み、もう一方は未設定の`unset_flag`条件で
    /// ロックされたまま） → "1-2"/"1-3"（着地先、中身は使わない）。
    fn conditional_choice_source() -> &'static str {
        "---\nengine: name-name\n---\n\n## 1-1: 開始\n\n**A**:\n最初のセリフ\n\n\
         [フラグ: set_flag=true]\n\
         [選択]\n- 解除済み → 1-2 [条件: set_flag]\n- ロックされたまま → 1-3 [条件: unset_flag]\n[/選択]\n\n\
         ## 1-2: 通常\n\n**B**:\n通常ルート\n\n\
         ## 1-3: 特別\n\n**C**:\n特別ルート\n"
    }

    /// #591 テスト観点整理フェーズ 高優先3: ロック中の選択肢が表示された状態で
    /// quicksave → restore し、復元後に `Playback::current_choice_locked()` が保存前と
    /// 同じ配列を返すことを確認する。
    ///
    /// この自動クイックセーブはシーン単位の復元（`restore_playback` doc comment参照、
    /// シーンの先頭＝最初のテキストイベントまでしか復元しない）のため、保存前に選択肢へ
    /// 到達していたのと同じ回数だけ、復元後も明示的に `advance()` してChoiceへ再度到達する
    /// 必要がある——`restore_playback_applies_flags_and_jumps_to_saved_scene` 等の既存テストと
    /// 同じ制約に従う。
    #[test]
    fn save_quick_then_restore_preserves_current_choice_locked_state_across_round_trip() {
        let path = temp_path("choice-locked-round-trip");
        let _guard = TempFile(path.clone());
        let document = name_name_parser::parser::parse(conditional_choice_source());

        let mut playback = Playback::from_document(&document);
        assert!(playback.advance(), "台詞からChoiceへ進めるはず");
        let locked_before = playback.current_choice_locked();
        assert_eq!(
            locked_before,
            vec![false, true],
            "set_flag設定済み・unset_flag未設定という前提が崩れていたら\
             このテストは無意味なため先に確認しておく"
        );

        save_quick(&path, &playback, &HashSet::new());

        let mut restored_playback = Playback::from_document(&document);
        assert!(restore_playback(&mut restored_playback, &path));
        // restore_playback はシーンの先頭（台詞）まで戻すだけなので、Choiceへ再度到達するには
        // 保存前と同じ回数（1回）advance()する必要がある。
        assert!(
            restored_playback.advance(),
            "復元後も台詞からChoiceへ進めるはず"
        );

        assert_eq!(
            restored_playback.current_choice_locked(),
            locked_before,
            "復元後のcurrent_choice_locked()は保存前と同じ配列を返すはず \
             (set_flag/unset_flagのフラグ状態が正しく往復していれば一致するはず)"
        );
    }

    /// #579 i18n: 日本語のフラグ名・文字列値も破損せずセーブ/ロード往復できることを
    /// 確認する。`save_quick`は実ファイルへUTF-8のまま書き出す(serde_jsonは既定で
    /// 非ASCIIを`\uXXXX`へエスケープしない)ため、生ファイルの中身にも日本語がそのまま
    /// 残ることをあわせて確認する。
    #[test]
    fn save_quick_then_restore_playback_round_trips_japanese_flag_name_and_string_value() {
        let path = temp_path("i18n-flags");
        let _guard = TempFile(path.clone());
        let document = name_name_parser::parser::parse(two_scene_source());

        let mut playback = Playback::from_document(&document);
        let mut flags = GameFlags::new();
        flags.set(
            "読了フラグ",
            name_name_parser::models::FlagValue::String("見た".to_string()),
        );
        playback.set_flags(flags);
        assert!(playback.jump_to_scene_id("1-2"));

        save_quick(&path, &playback, &HashSet::new());

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("読了フラグ") && raw.contains("見た"),
            "serde_jsonは既定でUTF-8をそのまま書き出す(\\uXXXXへエスケープしない)ため、\
             保存ファイルに日本語がそのまま残るはず, raw was: {raw}"
        );

        let mut restored_playback = Playback::from_document(&document);
        assert!(restore_playback(&mut restored_playback, &path));
        assert!(
            restored_playback.flags().check("読了フラグ"),
            "日本語フラグ名でも復元後にcheck()で読めるはず"
        );
        assert!(
            format!("{:?}", restored_playback.flags()).contains("見た"),
            "文字列値の中身(見た)もそのまま復元されているはず \
             (check()は存在確認のみのため、Debug表示で内容そのものを確認する)"
        );
    }
}
