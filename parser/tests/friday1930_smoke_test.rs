//! friday-1930 本編 (`script.md`) のスモークテスト。
//!
//! friday-1930 リポの `script.md` を直接読む（コピーは持たない）。
//! name-name parser 側の破壊的変更で friday-1930 が壊れないかをここで検出する。
//!
//! 読み込み先:
//! - 環境変数 `FRIDAY1930_SCRIPT` があればそのパス（CI はこちらを必ず指定する）
//! - 未設定なら name-name リポルートから見た兄弟 `../friday-1930/script.md`
//!
//! 見つからない場合:
//! - `FRIDAY1930_SCRIPT` 指定済み → 指定ミスなので panic（黙って緑にしない）
//! - 未指定 → 明示メッセージを eprintln してスキップ（ローカルで兄弟が無い場合）
//!
//! スコープ: **ハッピーパスの構造検証のみ**。parser の異常系（空ファイル、
//! 不正な view 値、マップ寸法ミスマッチ等）は `integration_test.rs` 側で扱う。

use std::path::PathBuf;

use name_name_parser::models::{Document, Event, SceneView};
use name_name_parser::parser;

const SCRIPT_ENV: &str = "FRIDAY1930_SCRIPT";

/// friday-1930 本編 script.md を読んで parse する。スキップ時は None。
fn load_friday1930() -> Option<Document> {
    let (path, explicit) = match std::env::var(SCRIPT_ENV) {
        Ok(p) if !p.is_empty() => (PathBuf::from(p), true),
        _ => (
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../friday-1930/script.md"),
            false,
        ),
    };
    match std::fs::read_to_string(&path) {
        Ok(src) => Some(parser::parse(&src)),
        Err(e) if explicit => panic!(
            "{SCRIPT_ENV}={} を読めません: {e}（指定ミスか checkout 漏れ）",
            path.display()
        ),
        Err(_) => {
            eprintln!(
                "SKIP: friday-1930 本編が見つからないためスキップ ({})。{SCRIPT_ENV} で script.md のパスを指定すると実行されます",
                path.display()
            );
            None
        }
    }
}

#[test]
fn friday1930_parses_main_scenes() {
    let Some(doc) = load_friday1930() else { return };
    assert_eq!(doc.engine, "name-name");
    assert_eq!(doc.chapters.len(), 1);
    let chapter = &doc.chapters[0];
    assert_eq!(chapter.number, 1);
    let ids: Vec<&str> = chapter.scenes.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["data", "opening", "abel-town", "ending"]);
}

#[test]
fn friday1930_view_is_mixed() {
    // opening / ending はノベル（view 指定なし → TopDown デフォルト）、
    // abel-town は Raycast。
    let Some(doc) = load_friday1930() else { return };
    let scenes = &doc.chapters[0].scenes;
    let view = |id: &str| scenes.iter().find(|s| s.id == id).expect(id).view;
    assert_eq!(view("opening"), SceneView::TopDown);
    assert_eq!(view("abel-town"), SceneView::Raycast);
    assert_eq!(view("ending"), SceneView::TopDown);
}

#[test]
fn friday1930_opening_has_novel_elements() {
    // ノベル要素（BGM・ナレーション・場面転換）が Event として抽出されることを担保する。
    let Some(doc) = load_friday1930() else { return };
    let opening = doc.chapters[0]
        .scenes
        .iter()
        .find(|s| s.id == "opening")
        .expect("opening scene exists");

    assert!(
        opening
            .events
            .iter()
            .any(|e| matches!(e, Event::Bgm { .. })),
        "opening should contain Bgm event"
    );
    assert!(
        opening
            .events
            .iter()
            .any(|e| matches!(e, Event::Narration { .. })),
        "opening should contain Narration event"
    );
    assert!(
        opening
            .events
            .iter()
            .any(|e| matches!(e, Event::SceneTransition)),
        "opening should end with SceneTransition"
    );
}

#[test]
fn friday1930_town_has_two_npcs_and_map() {
    let Some(doc) = load_friday1930() else { return };
    let town = doc.chapters[0]
        .scenes
        .iter()
        .find(|s| s.id == "abel-town")
        .expect("abel-town scene exists");

    let map_count = town
        .events
        .iter()
        .filter(|e| matches!(e, Event::RpgMap(_)))
        .count();
    assert_eq!(map_count, 1);

    let player_count = town
        .events
        .iter()
        .filter(|e| matches!(e, Event::PlayerStart(_)))
        .count();
    assert_eq!(player_count, 1);

    // NPC は Markdown 出現順で events に push される仕様（parser.rs）。
    // 順序が変わった場合は parser の変更意図とテスト期待を両方見直す。
    let npcs: Vec<(String, u32)> = town
        .events
        .iter()
        .filter_map(|e| match e {
            Event::Npc(npc) => Some((npc.name.clone(), npc.color)),
            _ => None,
        })
        .collect();
    assert_eq!(
        npcs,
        vec![
            ("ガイド".to_string(), 0x88ccff),
            ("旅人".to_string(), 0xffcc88),
        ]
    );
}
