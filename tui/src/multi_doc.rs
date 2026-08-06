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
) -> anyhow::Result<Document> {
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
fn merge_files(files: &[PathBuf]) -> anyhow::Result<Document> {
    let mut seen_scene_ids: HashMap<String, PathBuf> = HashMap::new();
    let mut merged: Option<Document> = None;

    for path in files {
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

        match &mut merged {
            None => merged = Some(doc),
            Some(acc) => acc.chapters.extend(doc.chapters),
        }
    }

    merged.context("マージ対象のMarkdownファイルがありません")
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

        let doc = load_merged_document(&dir, &hub).expect("should merge");
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

        let doc = load_merged_document(&dir, &entry).expect("should merge");
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

        let doc = load_merged_document(&dir, &entry).expect("should merge");
        let pb = crate::playback::Playback::from_document(&doc);
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["エントリの台詞".to_string()],
            "パス文字列順に関わらずentry_script指定ファイルが先頭になるはず"
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

        let doc = load_merged_document(&dir, &entry).expect("should merge");
        let pb = crate::playback::Playback::from_document(&doc);
        assert_eq!(
            pb.current_line().expect("line").text,
            vec!["外部ファイルの台詞".to_string()]
        );

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&outside_dir).ok();
    }
}
