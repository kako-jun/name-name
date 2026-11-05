//! friday-1930 本編 (`script.md`) のスモークテスト。
//!
//! friday-1930 リポの `script.md` を直接読む（コピーは持たない）。
//! name-name parser 側の破壊的変更で friday-1930 が壊れないかをここで検出する。
//!
//! 読み込み先:
//! - 環境変数 `FRIDAY1930_SCRIPT` があればそのパス（CI はこちらを必ず指定する）
//! - 未設定なら name-name リポルートから見た兄弟 `../friday-1930/script.md`
//!
//! 見つからない場合は常に panic する（黙って緑にしない）。
//!
//! スコープ: **ハッピーパスの構造検証のみ**。parser の異常系（空ファイル、
//! 不正な view 値、マップ寸法ミスマッチ等）は `integration_test.rs` 側で扱う。

use std::path::PathBuf;

use name_name_parser::models::{Document, Event, SceneView};
use name_name_parser::parser;

const SCRIPT_ENV: &str = "FRIDAY1930_SCRIPT";

/// friday-1930 本編 script.md を読んで parse する。見つからなければ panic。
fn load_friday1930() -> Document {
    let path = match std::env::var(SCRIPT_ENV) {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../friday-1930/script.md"),
    };
    let src = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "friday-1930 本編 ({}) を読めません: {e}。{SCRIPT_ENV} で script.md のパスを指定するか、\
             name-name の兄弟ディレクトリに kako-jun/friday-1930 を clone してください",
            path.display()
        )
    });
    parser::parse(&src)
}

#[test]
fn friday1930_parses_main_scenes() {
    let doc = load_friday1930();
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
    let doc = load_friday1930();
    let scenes = &doc.chapters[0].scenes;
    let view = |id: &str| scenes.iter().find(|s| s.id == id).expect(id).view;
    assert_eq!(view("opening"), SceneView::TopDown);
    assert_eq!(view("abel-town"), SceneView::Raycast);
    assert_eq!(view("ending"), SceneView::TopDown);
}

#[test]
fn friday1930_opening_has_novel_elements() {
    // ノベル要素（BGM・ナレーション・場面転換）が Event として抽出されることを担保する。
    let doc = load_friday1930();
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
    let narrator_dialogs = opening
        .events
        .iter()
        .filter(|e| matches!(e, Event::Dialog { character: Some(c), .. } if c == "ナレーター"))
        .count();
    assert_eq!(
        narrator_dialogs, 2,
        "opening should have 2 ナレーター dialogs"
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
    let doc = load_friday1930();
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

    let map = town
        .events
        .iter()
        .find_map(|e| match e {
            Event::RpgMap(m) => Some(m),
            _ => None,
        })
        .expect("RpgMap exists");
    assert_eq!(map.encounter_rate, Some(8));
    assert_eq!(
        map.encounter_groups,
        Some(vec![
            "slime".to_string(),
            "ghost".to_string(),
            "slime+ghost".to_string()
        ])
    );

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

#[test]
fn friday1930_data_scene_has_master_definitions() {
    let doc = load_friday1930();
    let data = doc.chapters[0]
        .scenes
        .iter()
        .find(|s| s.id == "data")
        .expect("data scene exists");

    let party: Vec<&str> = data
        .events
        .iter()
        .filter_map(|e| match e {
            Event::PartyMember(p) => Some(p.id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(party, vec!["hero"]);

    let monsters: Vec<&str> = data
        .events
        .iter()
        .filter_map(|e| match e {
            Event::Monster(m) => Some(m.id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(monsters, vec!["slime", "ghost"]);
}
