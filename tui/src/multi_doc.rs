//! 起動時に `script_dir` 配下の全 `.md` ファイルを一括で読み込み、1つの `Document` へ
//! マージする（#496）。
//!
//! ## 背景
//!
//! TUI 版は従来 `tui-config.toml` の `entry_script` が指す単一の Markdown ファイルだけを
//! 読み込んでいた。gymnasia のようにハブ画面（`[選択]` で複数ルートへ分岐する）を経由する
//! 作品では、選択肢のジャンプ先シーンが別ファイルに定義されているため、単一ファイルだけの
//! 読み込みではジャンプが解決できない。
//!
//! GUI版はブラウザ環境前提の「missing scene resolver による遅延ロード」（
//! `docs/architecture.md` 「マルチMD再生と遅延ロード」節、#284/#314）でこれを解決しているが、
//! TUI はローカル CLI でファイル数も少ないため、**起動時に `script_dir` 配下の全 `.md` を
//! 一括 parse して1つの `Document` へマージする**シンプルな方式を採用する（kako-jun 確認済み、
//! Issue #496）。動的な追加ロードは対象外（起動時の一括ロードのみ）。
//!
//! ## `entry_script` の扱い
//!
//! `entry_script` は「どのファイルの最初のシーンから再生を始めるか」の指定として残す。
//! [`load_merged_document`] は `entry_script_path` が指すファイルを常にマージ順の先頭に置く
//! ことで実現する（`Playback::from_document` は `Document::chapters` を先頭から順に走査して
//! 再生位置0を決めるため、chapters の並び順を制御するだけで済み、`Playback` 側の変更は不要）。
//! ジャンプ解決（`Playback::select_current_choice`）は `scene_start`（シーンID→位置の
//! `HashMap`）がマージ後の `Document` 全体を対象に構築されるため、マージ順に関わらず
//! 全ファイル横断で機能する。
//!
//! ## シーンID重複時の扱い
//!
//! シーンIDは全 `.md` でグローバル一意が前提。重複した場合は**先勝ち**（マージ順で最初に
//! 出現したファイルの定義を採用）とし、`eprintln!` で警告する。GUI版 `findSceneById`
//! （`frontend/src/game/novelLayout.ts`、`Array.prototype.find` による先勝ち線形探索）と
//! 同じ規約を踏襲する。この関数は `main.rs` が alternate screen へ入る前（起動シーケンス
//! 冒頭）に呼ぶ想定のため、標準エラー出力がそのままユーザーの端末に見える
//! （`playback.rs` の `select_current_choice` が「alternate screen 中は警告を出さない」と
//! 割り切っているのとは別の経路）。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;
use name_name_parser::models::Document;

/// `dir` 配下の `.md` ファイルを再帰的に列挙する。OS のディレクトリ列挙順は不定なため、
/// 収集後にパス文字列で昇順ソートし、呼び出し側の結果を決定的にする。
/// シンボリックリンクの特別扱い・隠しファイル除外はしない（ゲームのスクリプトディレクトリに
/// そうした構成は無い前提、シンプルさ優先）。
pub fn collect_markdown_files(dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    visit_dir(dir, &mut files)
        .with_context(|| format!("script_dir の走査に失敗しました: {}", dir.display()))?;
    files.sort();
    Ok(files)
}

fn visit_dir(dir: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            visit_dir(&path, files)?;
        } else if path.extension().is_some_and(|ext| ext == "md") {
            files.push(path);
        }
    }
    Ok(())
}

/// [`merge_files`] / [`load_merged_document`] の戻り値。マージ後の `Document` に加えて、
/// `document.chapters[i]` が何番目の入力ファイル由来か（0始まり、マージ順＝`files` の並び順）を
/// `chapter_file_ids[i]` として持つ（`chapter_file_ids.len() == document.chapters.len()` が
/// 常に成立する）。ファイル境界をまたぐ暗黙の `advance()` を禁止する
/// `Playback::from_merged_document`（#496 追加スコープ）に渡すための補助データ。
/// `parser`/`Document` 自体は変更せず（GUI版と共有しているため）、`tui/` 側だけで完結させる
/// ためにこの補助データを別建てで返す設計を選んだ（詳細は `playback.rs` 冒頭のdocコメント参照）。
#[derive(Debug, Clone, PartialEq)]
pub struct MergedDocument {
    pub document: Document,
    pub chapter_file_ids: Vec<usize>,
}

/// `script_dir` 配下の全 `.md` を一括 parse して1つの `Document` へマージする。
///
/// - `entry_script_path` が指すファイルを常にマージ順の先頭にする（`script_dir` の走査結果に
///   含まれていれば並べ替え、含まれていなければ先頭に追加する — `entry_script` に絶対パスや
///   `script_dir` 外を指す値が設定されているケースの後方互換、`Config::entry_script_path` 参照）。
/// - 残りのファイルはパス文字列の昇順で決定的に処理する。
/// - `script_dir` が存在しない、または `.md` が1件も見つからない場合は `Err`。
pub fn load_merged_document(
    script_dir: &Path,
    entry_script_path: &Path,
) -> anyhow::Result<MergedDocument> {
    let mut files = collect_markdown_files(script_dir)?;
    if files.is_empty() {
        anyhow::bail!(
            "script_dir 配下に .md ファイルが見つかりません: {}",
            script_dir.display()
        );
    }
    match files.iter().position(|f| f == entry_script_path) {
        Some(pos) => {
            let entry = files.remove(pos);
            files.insert(0, entry);
        }
        None => files.insert(0, entry_script_path.to_path_buf()),
    }
    merge_files(&files)
}

/// `files` の先頭から順に parse し、`Document::chapters` を連結する。先頭ファイル
/// （`load_merged_document` が並べた `entry_script_path`）の `chapters` 以外のフィールド
/// （`engine` / `aspect_ratio` 等）は、マージ後 `Document` のメタデータとしてそのまま採用する
/// （`Playback::from_document` は `chapters` しか見ないため、他フィールドの選び方に実害はない）。
/// `files` の中での位置（0始まり）をそのままファイル識別子として `chapter_file_ids` に積む
/// （`MergedDocument` 参照）。
fn merge_files(files: &[PathBuf]) -> anyhow::Result<MergedDocument> {
    let mut seen_scene_ids: HashMap<String, PathBuf> = HashMap::new();
    let mut merged: Option<Document> = None;
    let mut chapter_file_ids: Vec<usize> = Vec::new();

    for (file_id, path) in files.iter().enumerate() {
        let source = fs::read_to_string(path)
            .with_context(|| format!("Markdown原稿の読み込みに失敗しました: {}", path.display()))?;
        let doc = name_name_parser::parser::parse(&source);

        for chapter in &doc.chapters {
            for scene in &chapter.scenes {
                match seen_scene_ids.get(&scene.id) {
                    Some(first_path) => {
                        eprintln!(
                            "警告: シーンID '{}' が複数ファイルで重複しています。{} の定義を採用し、{} の定義は無視します。",
                            scene.id,
                            first_path.display(),
                            path.display()
                        );
                    }
                    None => {
                        seen_scene_ids.insert(scene.id.clone(), path.clone());
                    }
                }
            }
        }

        chapter_file_ids.extend(std::iter::repeat_n(file_id, doc.chapters.len()));

        match &mut merged {
            None => merged = Some(doc),
            Some(acc) => acc.chapters.extend(doc.chapters),
        }
    }

    let document = merged.context("マージ対象のMarkdownファイルがありません")?;
    Ok(MergedDocument {
        document,
        chapter_file_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// テスト専用: 一意な一時ディレクトリを作る（`image_render.rs` の
    /// `write_test_bytes_fixture` と同じ命名戦略: プロセスID・ナノ秒時刻・単調カウンタの
    /// 組み合わせでテスト実行のたびに衝突しないようにする）。
    fn make_temp_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "name-name-tui-test-multidoc-{}-{}-{unique}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        ));
        fs::create_dir_all(&dir).expect("should create temp dir");
        dir
    }

    fn write_md(dir: &Path, relative: &str, content: &str) -> PathBuf {
        let path = dir.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("should create parent dir");
        }
        fs::write(&path, content).expect("should write fixture md");
        path
    }

    const FRONTMATTER: &str = "---\nengine: name-name\n---\n\n";

    #[test]
    fn collect_markdown_files_finds_nested_md_files_only() {
        let dir = make_temp_dir();
        write_md(&dir, "a.md", "");
        write_md(&dir, "sub/b.md", "");
        write_md(&dir, "sub/deeper/c.md", "");
        write_md(&dir, "not-markdown.txt", "");

        let files = collect_markdown_files(&dir).expect("should collect");

        assert_eq!(files.len(), 3, "files was: {files:?}");
        assert!(files.iter().all(|f| f.extension().unwrap() == "md"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn collect_markdown_files_missing_dir_is_err() {
        let dir = std::env::temp_dir().join("name-name-tui-test-multidoc-does-not-exist-dir");
        let result = collect_markdown_files(&dir);
        assert!(result.is_err());
    }

    #[test]
    fn load_merged_document_resolves_cross_file_scene_jump() {
        let dir = make_temp_dir();
        let hub = write_md(
            &dir,
            "hub.md",
            &format!("{FRONTMATTER}## hub: 開始\n\n[選択]\n- ルート1へ→r01-start\n[/選択]\n"),
        );
        write_md(
            &dir,
            "route01/start.md",
            &format!("{FRONTMATTER}## r01-start: ルート1\n\n**A**:\nルート1の最初のセリフ\n"),
        );

        let doc = load_merged_document(&dir, &hub)
            .expect("should merge")
            .document;
        let mut pb = crate::playback::Playback::from_document(&doc);
        assert!(
            pb.select_current_choice(),
            "別ファイルに定義されたシーンへのjumpが成功するはず"
        );
        assert_eq!(
            pb.current_line().expect("jump先の台詞").text,
            vec!["ルート1の最初のセリフ".to_string()]
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_merged_document_duplicate_scene_id_first_file_wins() {
        let dir = make_temp_dir();
        let entry = write_md(
            &dir,
            "a-entry.md",
            &format!("{FRONTMATTER}## dup: 最初\n\n**A**:\nこちらが採用される\n"),
        );
        write_md(
            &dir,
            "b-other.md",
            &format!("{FRONTMATTER}## dup: 後発\n\n**B**:\nこちらは無視される\n"),
        );

        let doc = load_merged_document(&dir, &entry)
            .expect("should merge")
            .document;
        let pb = crate::playback::Playback::from_document(&doc);
        // entry ファイル（"dup" の最初の出現）が先頭 chapter として merge されるため、
        // Playback は entry の内容から始まる。
        assert_eq!(
            pb.current_line().expect("entryの台詞").text,
            vec!["こちらが採用される".to_string()]
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_merged_document_missing_script_dir_is_err() {
        let dir = std::env::temp_dir().join("name-name-tui-test-multidoc-missing-dir");
        let entry = dir.join("entry.md");
        let result = load_merged_document(&dir, &entry);
        assert!(result.is_err());
    }

    #[test]
    fn load_merged_document_empty_script_dir_is_err() {
        let dir = make_temp_dir();
        let entry = dir.join("entry.md");
        let result = load_merged_document(&dir, &entry);
        assert!(result.is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_merged_document_entry_file_content_appears_first_in_playback() {
        // 非-entry ファイルの方がパス文字列順で先に来る配置（"aaa-other.md" < "zzz-entry.md"）
        // でも、entry_script_path が指すファイルが常にマージ後 Document の先頭になる
        // （= Playback がそのファイルの最初のシーンから始まる）ことを確認する。
        let dir = make_temp_dir();
        write_md(
            &dir,
            "aaa-other.md",
            &format!("{FRONTMATTER}## other-scene: 他\n\n**X**:\n他ファイルの台詞\n"),
        );
        let entry = write_md(
            &dir,
            "zzz-entry.md",
            &format!("{FRONTMATTER}## entry-scene: 本命\n\n**Y**:\nエントリの台詞\n"),
        );

        let doc = load_merged_document(&dir, &entry)
            .expect("should merge")
            .document;
        let pb = crate::playback::Playback::from_document(&doc);
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["エントリの台詞".to_string()],
            "パス文字列順に関わらずentry_script指定ファイルが先頭になるはず"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn collect_markdown_files_returns_sorted_order_independent_of_creation_order() {
        // 作成順をあえて逆順（z→a→m）にし、収集結果が作成順ではなくパス文字列昇順で
        // 決定的に返ることを直接アサートする。
        let dir = make_temp_dir();
        let z = write_md(&dir, "z.md", "");
        let a = write_md(&dir, "a.md", "");
        let m = write_md(&dir, "m.md", "");

        let files = collect_markdown_files(&dir).expect("should collect");

        assert_eq!(
            files,
            vec![a, m, z],
            "作成順(z→a→m)に関わらずパス文字列昇順で返るはず"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_merged_document_duplicate_scene_id_between_two_non_entry_files_first_by_sort_order_wins(
    ) {
        // entry 自体は "dup" シーンを含まない。"dup" を定義する非entryファイル2つのうち、
        // パス文字列順で先に来る方（"b-dup.md" < "c-dup.md"）の定義が採用されることを確認する
        // （entry・非entry問わず、マージ順で最初に出現したファイルが勝つという規約の
        // 「両方とも非entry」パターンでの裏取り）。
        let dir = make_temp_dir();
        let entry = write_md(
            &dir,
            "entry.md",
            &format!("{FRONTMATTER}## start: 開始\n\n[選択]\n- 分岐へ→dup\n[/選択]\n"),
        );
        write_md(
            &dir,
            "b-dup.md",
            &format!("{FRONTMATTER}## dup: B定義\n\n**B**:\nBファイルの台詞\n"),
        );
        write_md(
            &dir,
            "c-dup.md",
            &format!("{FRONTMATTER}## dup: C定義\n\n**C**:\nCファイルの台詞\n"),
        );

        let doc = load_merged_document(&dir, &entry)
            .expect("should merge")
            .document;
        let mut pb = crate::playback::Playback::from_document(&doc);
        assert!(
            pb.select_current_choice(),
            "dup シーンへのjumpが成功するはず"
        );
        assert_eq!(
            pb.current_line().expect("dupシーンの台詞").text,
            vec!["Bファイルの台詞".to_string()],
            "非entryファイル間の重複はパス文字列で先に来るファイル(b-dup.md)の定義が採用されるはず"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_merged_document_single_file_equal_to_entry() {
        // script_dir 配下が entry 1件のみの最小構成。マージ処理を経ても、entry単体を
        // 直接 parse した Document と完全一致するはず（他ファイルとの統合ロジックが
        // 単一ファイルの内容を変質させないことの確認）。
        let dir = make_temp_dir();
        let source = format!("{FRONTMATTER}## only: 単独\n\n**A**:\n単独ファイルの台詞\n");
        let entry = write_md(&dir, "only.md", &source);

        let merged = load_merged_document(&dir, &entry).expect("should merge");
        let direct = name_name_parser::parser::parse(&source);

        assert_eq!(merged.document, direct);
        assert_eq!(
            merged.chapter_file_ids,
            vec![0; merged.document.chapters.len()],
            "単一ファイルなら全chapterのfile idは0のはず"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_merged_document_entry_outside_with_multiple_files_in_script_dir() {
        // entry_script_path が script_dir 外を指すケース（後方互換）に、script_dir 内に
        // 複数ファイルがある構成を組み合わせても、両方の内部ファイルの内容がマージされ、
        // それぞれへジャンプできることを確認する（既存の
        // `entry_script_outside_script_dir_is_still_included` は script_dir 内が1ファイルのみ）。
        let dir = make_temp_dir();
        let outside_dir = make_temp_dir();
        let entry = write_md(
            &outside_dir,
            "outside-entry.md",
            &format!(
                "{FRONTMATTER}## hub: 開始\n\n[選択]\n- 内部1へ→inside1\n- 内部2へ→inside2\n[/選択]\n"
            ),
        );
        write_md(
            &dir,
            "inside1.md",
            &format!("{FRONTMATTER}## inside1: 内部1\n\n**P**:\n内部1の台詞\n"),
        );
        write_md(
            &dir,
            "inside2.md",
            &format!("{FRONTMATTER}## inside2: 内部2\n\n**Q**:\n内部2の台詞\n"),
        );

        let doc = load_merged_document(&dir, &entry)
            .expect("should merge")
            .document;

        let mut pb_first = crate::playback::Playback::from_document(&doc);
        assert!(
            pb_first.select_current_choice(),
            "1番目の選択肢のjumpが成功するはず"
        );
        assert_eq!(
            pb_first.current_line().expect("内部1の台詞").text,
            vec!["内部1の台詞".to_string()]
        );

        let mut pb_second = crate::playback::Playback::from_document(&doc);
        pb_second.move_choice_cursor_down();
        assert!(
            pb_second.select_current_choice(),
            "2番目の選択肢のjumpが成功するはず"
        );
        assert_eq!(
            pb_second.current_line().expect("内部2の台詞").text,
            vec!["内部2の台詞".to_string()]
        );

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn load_merged_document_entry_script_path_does_not_exist_is_err() {
        // script_dir は実在し .md も1件あるが、entry_script_path が指すファイルは
        // script_dir 配下に存在しない（tui-config.toml の entry_script 設定ミス相当）。
        // 存在しないファイルを読み込もうとして Err になることを確認する。
        let dir = make_temp_dir();
        write_md(
            &dir,
            "actual.md",
            &format!("{FRONTMATTER}## a: A\n\n**A**:\nAの台詞\n"),
        );
        let missing_entry = dir.join("does-not-exist.md");

        let result = load_merged_document(&dir, &missing_entry);

        assert!(result.is_err());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(unix)]
    fn load_merged_document_unreadable_file_among_valid_files_is_err() {
        use std::os::unix::fs::PermissionsExt;

        let dir = make_temp_dir();
        let entry = write_md(
            &dir,
            "entry.md",
            &format!("{FRONTMATTER}## a: A\n\n**A**:\nAの台詞\n"),
        );
        let unreadable = write_md(
            &dir,
            "unreadable.md",
            &format!("{FRONTMATTER}## b: B\n\n**B**:\nBの台詞\n"),
        );
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000))
            .expect("should set permissions");

        // root（や owner の権限チェックを無視するファイルシステム）で実行されていると
        // パーミッション0でも読めてしまい、このテストの前提が崩れる。`nix`/`libc` 等を
        // 新規依存に追加して euid を判定する代わりに、実際に読めるかどうかを直接観測して
        // 判定する（読めてしまう＝このテストでは検証不能なので早期 pass 扱いでskipする）。
        let permission_enforced = fs::read(&unreadable).is_err();
        if !permission_enforced {
            fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o644)).ok();
            fs::remove_dir_all(&dir).ok();
            return;
        }

        let result = load_merged_document(&dir, &entry);

        assert!(result.is_err(), "権限0のファイルが混在するとErrになるはず");

        // ディレクトリ削除できるよう権限を戻してから後片付けする。
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o644)).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_merged_document_empty_md_file_does_not_break_merge() {
        // frontmatterもシーンも無い空 .md ファイルが混在していてもpanicせず正常にマージできる
        // ことを確認する（`parser::parse("")` は0シーンのChapterを返すだけで、マージ処理側で
        // 空ファイルを特別扱いする必要はないはず）。
        let dir = make_temp_dir();
        let entry = write_md(
            &dir,
            "entry.md",
            &format!("{FRONTMATTER}## a: A\n\n**A**:\n本編の台詞\n"),
        );
        write_md(&dir, "blank.md", "");

        let doc = load_merged_document(&dir, &entry)
            .expect("空.mdが混ざっていてもErrにならないはず")
            .document;
        let pb = crate::playback::Playback::from_document(&doc);
        assert_eq!(
            pb.current_line().expect("entryの台詞").text,
            vec!["本編の台詞".to_string()]
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_merged_document_hidden_dotfile_with_md_extension_is_included() {
        // `collect_markdown_files` の doc comment にある「隠しファイル除外はしない」という
        // 主張の裏取り。`.draft.md` のような隠しファイルもマージ対象に含まれ、jumpで
        // 到達できることを確認する。
        let dir = make_temp_dir();
        let entry = write_md(
            &dir,
            "entry.md",
            &format!("{FRONTMATTER}## hub: 開始\n\n[選択]\n- 下書きへ→draft-scene\n[/選択]\n"),
        );
        write_md(
            &dir,
            ".draft.md",
            &format!("{FRONTMATTER}## draft-scene: 下書き\n\n**D**:\n隠しファイルの台詞\n"),
        );

        let doc = load_merged_document(&dir, &entry)
            .expect("should merge")
            .document;
        let mut pb = crate::playback::Playback::from_document(&doc);
        assert!(
            pb.select_current_choice(),
            "隠しファイルに定義されたシーンへのjumpが成功するはず"
        );
        assert_eq!(
            pb.current_line().expect("隠しファイルの台詞").text,
            vec!["隠しファイルの台詞".to_string()]
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_merged_document_entry_script_outside_script_dir_is_still_included() {
        // `entry_script` に絶対パス等 script_dir 外を指す値が設定されている場合
        // （`Config::entry_script_path` の後方互換ケース）でも、そのファイルを先頭に
        // 追加してマージできることを確認する。
        let dir = make_temp_dir();
        let outside_dir = make_temp_dir();
        let entry = write_md(
            &outside_dir,
            "outside-entry.md",
            &format!("{FRONTMATTER}## outside-scene: 外部\n\n**Z**:\n外部ファイルの台詞\n"),
        );
        write_md(
            &dir,
            "inside.md",
            &format!("{FRONTMATTER}## inside-scene: 内部\n\n**W**:\n内部ファイルの台詞\n"),
        );

        let doc = load_merged_document(&dir, &entry)
            .expect("should merge")
            .document;
        let pb = crate::playback::Playback::from_document(&doc);
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["外部ファイルの台詞".to_string()]
        );

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside_dir).ok();
    }

    // ---- #496 追加スコープ: chapter_file_ids（ファイル境界の補助データ） ----

    #[test]
    fn merged_document_chapter_file_ids_track_originating_file_in_merge_order() {
        // `parser::parse` は1ファイルにつき常にちょうど1 chapter を返す（frontmatterの
        // `chapter:` は1ファイル1章の前提、`parser/src/parser.rs` 参照）。3ファイルを
        // マージした場合、chapter_file_ids はマージ順（entryが先頭、残りはパス文字列昇順）に
        // 沿った `[0, 1, 2]` になるはず — `Playback::from_merged_document` がこの対応を使って
        // itemごとの由来ファイルを決めるための土台。
        let dir = make_temp_dir();
        let entry = write_md(
            &dir,
            "a-entry.md",
            &format!("{FRONTMATTER}## e-1: エントリ\n\n**A**:\nエントリの台詞\n"),
        );
        write_md(
            &dir,
            "b-route.md",
            &format!("{FRONTMATTER}## r-1: ルート1\n\n**B**:\nルート1の台詞\n"),
        );
        write_md(
            &dir,
            "c-route.md",
            &format!("{FRONTMATTER}## r-2: ルート2\n\n**C**:\nルート2の台詞\n"),
        );

        let merged = load_merged_document(&dir, &entry).expect("should merge");

        assert_eq!(
            merged.chapter_file_ids.len(),
            merged.document.chapters.len(),
            "chapter_file_idsはchapter数と同じ長さのはず"
        );
        assert_eq!(
            merged.chapter_file_ids,
            vec![0, 1, 2],
            "entry→b-route→c-routeのマージ順にfile idが0,1,2と振られるはず"
        );

        fs::remove_dir_all(&dir).ok();
    }
}
