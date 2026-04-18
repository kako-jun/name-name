//! friday-1930 プロトタイプ最小マップのスモークテスト。
//!
//! `fixtures/friday1930-sample.md` は friday-1930 リポの `chapters/all.md` と
//! 同じ形式のサンプル（raycast + NPC 構成を検証するための代表例）。
//! name-name parser 側の破壊的変更で friday-1930 が壊れないかをここで検出する。
//!
//! fixture を更新したいときは: friday-1930 で chapters/all.md を更新したあと、
//! 同じ内容をここに同期する（ファイルコピー）。
//!
//! スコープ: **ハッピーパスの構造検証のみ**。parser の異常系（空ファイル、
//! 不正な view 値、マップ寸法ミスマッチ等）は `integration_test.rs` 側で扱う。

use name_name_parser::models::{Event, SceneView};
use name_name_parser::parser;

const FRIDAY1930_SAMPLE: &str = include_str!("fixtures/friday1930-sample.md");

#[test]
fn friday1930_sample_parses_three_scenes() {
    let doc = parser::parse(FRIDAY1930_SAMPLE);
    assert_eq!(doc.engine, "name-name");
    assert_eq!(doc.chapters.len(), 1);
    let chapter = &doc.chapters[0];
    assert_eq!(chapter.number, 1);
    assert_eq!(chapter.scenes.len(), 3);
    assert_eq!(chapter.scenes[0].id, "prologue-morning");
    assert_eq!(chapter.scenes[1].id, "abel-village");
    assert_eq!(chapter.scenes[2].id, "dungeon-north");
}

#[test]
fn friday1930_view_is_mixed() {
    // プロローグはノベル（view 指定なし → TopDown デフォルト）、
    // RPG 2シーンは Raycast。
    let doc = parser::parse(FRIDAY1930_SAMPLE);
    assert_eq!(doc.chapters[0].scenes[0].view, SceneView::TopDown);
    assert_eq!(doc.chapters[0].scenes[1].view, SceneView::Raycast);
    assert_eq!(doc.chapters[0].scenes[2].view, SceneView::Raycast);
}

#[test]
fn friday1930_prologue_has_novel_elements() {
    // ノベル要素（ダイアログ・ナレーション・背景・BGM・暗転解除・SE・退場・場面転換）
    // が parser を通って Event として抽出されることを担保する。
    let doc = parser::parse(FRIDAY1930_SAMPLE);
    let prologue = &doc.chapters[0].scenes[0];

    let has_background = prologue
        .events
        .iter()
        .any(|e| matches!(e, Event::Background { .. }));
    assert!(has_background, "prologue should contain Background event");

    let has_bgm = prologue
        .events
        .iter()
        .any(|e| matches!(e, Event::Bgm { .. }));
    assert!(has_bgm, "prologue should contain Bgm event");

    let has_narration = prologue
        .events
        .iter()
        .any(|e| matches!(e, Event::Narration { .. }));
    assert!(has_narration, "prologue should contain Narration event");

    let dialog_count = prologue
        .events
        .iter()
        .filter(|e| matches!(e, Event::Dialog { .. }))
        .count();
    assert!(dialog_count >= 3, "prologue should have multiple Dialog events");

    let has_se = prologue.events.iter().any(|e| matches!(e, Event::Se { .. }));
    assert!(has_se, "prologue should contain Se event");

    let has_exit = prologue
        .events
        .iter()
        .any(|e| matches!(e, Event::Exit { .. }));
    assert!(has_exit, "prologue should contain Exit event");

    let has_scene_transition = prologue
        .events
        .iter()
        .any(|e| matches!(e, Event::SceneTransition));
    assert!(
        has_scene_transition,
        "prologue should end with SceneTransition"
    );
}

#[test]
fn friday1930_village_has_four_npcs_and_map() {
    let doc = parser::parse(FRIDAY1930_SAMPLE);
    let village = doc
        .chapters[0]
        .scenes
        .iter()
        .find(|s| s.id == "abel-village")
        .expect("abel-village scene exists");

    let map_count = village
        .events
        .iter()
        .filter(|e| matches!(e, Event::RpgMap(_)))
        .count();
    assert_eq!(map_count, 1);

    let player_count = village
        .events
        .iter()
        .filter(|e| matches!(e, Event::PlayerStart(_)))
        .count();
    assert_eq!(player_count, 1);

    // NPC は Markdown 出現順で events に push される仕様（parser.rs）。
    // 順序が変わった場合は parser の変更意図とテスト期待を両方見直す。
    let npc_names: Vec<String> = village
        .events
        .iter()
        .filter_map(|e| match e {
            Event::Npc(npc) => Some(npc.name.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        npc_names,
        vec![
            "デイジー".to_string(),
            "キートン".to_string(),
            "モコッチ".to_string(),
            "ティアラ".to_string(),
        ]
    );
}

#[test]
fn friday1930_dungeon_has_jikido() {
    let doc = parser::parse(FRIDAY1930_SAMPLE);
    let dungeon = doc
        .chapters[0]
        .scenes
        .iter()
        .find(|s| s.id == "dungeon-north")
        .expect("dungeon-north scene exists");

    let jikido = dungeon
        .events
        .iter()
        .find_map(|e| match e {
            Event::Npc(npc) if npc.name == "ジキド" => Some(npc),
            _ => None,
        })
        .expect("ジキド NPC exists in dungeon-north");

    assert_eq!(jikido.color, 0xcc3333); // fixture 側の `色=#cc3333` と対応
    assert!(!jikido.message.is_empty());
}
