//! friday-1930 プロトタイプ最小マップのスモークテスト。
//!
//! `fixtures/friday1930-sample.md` は friday-1930 リポの `chapters/all.md` と
//! 同じ形式のサンプル（raycast + NPC 構成を検証するための代表例）。
//! name-name parser 側の破壊的変更で friday-1930 が壊れないかをここで検出する。
//!
//! fixture を更新したいときは: friday-1930 で chapters/all.md を更新したあと、
//! 同じ内容をここに同期する（ファイルコピー）。

use name_name_parser::models::{Event, SceneView};
use name_name_parser::parser;

const FRIDAY1930_SAMPLE: &str = include_str!("fixtures/friday1930-sample.md");

#[test]
fn friday1930_sample_parses_two_scenes() {
    let doc = parser::parse(FRIDAY1930_SAMPLE);
    assert_eq!(doc.engine, "name-name");
    assert_eq!(doc.chapters.len(), 1);
    let chapter = &doc.chapters[0];
    assert_eq!(chapter.number, 1);
    assert_eq!(chapter.scenes.len(), 2);
}

#[test]
fn friday1930_both_scenes_are_raycast() {
    let doc = parser::parse(FRIDAY1930_SAMPLE);
    for scene in &doc.chapters[0].scenes {
        assert_eq!(
            scene.view,
            SceneView::Raycast,
            "scene {:?} should be raycast",
            scene.id
        );
    }
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

    assert_eq!(jikido.color, 0xcc3333);
    assert!(!jikido.message.is_empty());
}
