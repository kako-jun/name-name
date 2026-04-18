use name_name_parser::emitter;
use name_name_parser::models::*;
use name_name_parser::parser;

const SAMPLE_MARKDOWN: &str = r#"---
engine: name-name
chapter: 1
title: "プロローグ"
hidden: false
default_bgm: amehure.ogg
---

## 1-1: はじまり

[背景: radius/BG_COMMON_GRAD_3.png]
[BGM: amehure.ogg]
[暗転解除]

**カコ** (suppin_1, 左):
ちくしょう……。
なんで！

[SE: se_maoudamashii_onepoint26.ogg]

こうなるんだよぅ……ッ！

**トモ** (laugh_1, 右):
あなたを信じることはできない……。
だって……
そんなの絶対おかしいよ！

**トモ** → angry_1:
くけけけけけけけけけ。

[背景: radius/BG_KAKO_1_2.png]

それでよい。

[退場: トモ]
[場面転換]
[背景: radius/BG_COMMON_GRAD_3.png]

**カコ** (suppin_1, 左):
私は……

[BGM: snowsnow.ogg]
[暗転]
"#;

#[test]
fn test_parse_sample() {
    let doc = parser::parse(SAMPLE_MARKDOWN);

    assert_eq!(doc.engine, "name-name");
    assert_eq!(doc.chapters.len(), 1);

    let chapter = &doc.chapters[0];
    assert_eq!(chapter.number, 1);
    assert_eq!(chapter.title, "プロローグ");
    assert_eq!(chapter.hidden, false);
    assert_eq!(chapter.default_bgm, Some("amehure.ogg".to_string()));
    assert_eq!(chapter.scenes.len(), 1);

    let scene = &chapter.scenes[0];
    assert_eq!(scene.id, "1-1");
    assert_eq!(scene.title, "はじまり");

    let events = &scene.events;

    // [背景: radius/BG_COMMON_GRAD_3.png]
    assert_eq!(
        events[0],
        Event::Background {
            path: "radius/BG_COMMON_GRAD_3.png".to_string()
        }
    );
    // [BGM: amehure.ogg]
    assert_eq!(
        events[1],
        Event::Bgm {
            path: Some("amehure.ogg".to_string()),
            action: BgmAction::Play
        }
    );
    // [暗転解除]
    assert_eq!(
        events[2],
        Event::Blackout {
            action: BlackoutAction::Off
        }
    );

    // **カコ** (suppin_1, 左): ちくしょう……。 / なんで！
    match &events[3] {
        Event::Dialog {
            character,
            expression,
            position,
            text,
        } => {
            assert_eq!(character, &Some("カコ".to_string()));
            assert_eq!(expression, &Some("suppin_1".to_string()));
            assert_eq!(position, &Some("左".to_string()));
            assert_eq!(
                text,
                &vec!["ちくしょう……。".to_string(), "なんで！".to_string()]
            );
        }
        other => panic!("Expected Dialog, got {:?}", other),
    }

    // [SE: ...]
    assert_eq!(
        events[4],
        Event::Se {
            path: "se_maoudamashii_onepoint26.ogg".to_string()
        }
    );

    // こうなるんだよぅ……ッ！ (continuation of カコ)
    match &events[5] {
        Event::Dialog {
            character,
            expression,
            position,
            text,
        } => {
            assert_eq!(character, &Some("カコ".to_string()));
            assert_eq!(expression, &Some("suppin_1".to_string()));
            assert_eq!(position, &Some("左".to_string()));
            assert_eq!(text, &vec!["こうなるんだよぅ……ッ！".to_string()]);
        }
        other => panic!("Expected Dialog continuation, got {:?}", other),
    }

    // **トモ** (laugh_1, 右): ...
    match &events[6] {
        Event::Dialog {
            character,
            expression,
            position,
            text,
        } => {
            assert_eq!(character, &Some("トモ".to_string()));
            assert_eq!(expression, &Some("laugh_1".to_string()));
            assert_eq!(position, &Some("右".to_string()));
            assert_eq!(
                text,
                &vec![
                    "あなたを信じることはできない……。".to_string(),
                    "だって……".to_string(),
                    "そんなの絶対おかしいよ！".to_string(),
                ]
            );
        }
        other => panic!("Expected Dialog, got {:?}", other),
    }

    // **トモ** → angry_1:
    assert_eq!(
        events[7],
        Event::ExpressionChange {
            character: "トモ".to_string(),
            expression: "angry_1".to_string(),
        }
    );

    // くけけけけけけけけけ。 (after expression change, uses トモ angry_1)
    match &events[8] {
        Event::Dialog {
            character,
            expression,
            position: _,
            text,
        } => {
            assert_eq!(character, &Some("トモ".to_string()));
            assert_eq!(expression, &Some("angry_1".to_string()));
            assert_eq!(text, &vec!["くけけけけけけけけけ。".to_string()]);
        }
        other => panic!("Expected Dialog after expression change, got {:?}", other),
    }

    // [背景: radius/BG_KAKO_1_2.png]
    assert_eq!(
        events[9],
        Event::Background {
            path: "radius/BG_KAKO_1_2.png".to_string()
        }
    );

    // それでよい。 (continuation of トモ)
    match &events[10] {
        Event::Dialog {
            character, text, ..
        } => {
            assert_eq!(character, &Some("トモ".to_string()));
            assert_eq!(text, &vec!["それでよい。".to_string()]);
        }
        other => panic!("Expected Dialog continuation, got {:?}", other),
    }

    // [退場: トモ]
    assert_eq!(
        events[11],
        Event::Exit {
            character: "トモ".to_string()
        }
    );
    // [場面転換]
    assert_eq!(events[12], Event::SceneTransition);
    // [背景: ...]
    assert_eq!(
        events[13],
        Event::Background {
            path: "radius/BG_COMMON_GRAD_3.png".to_string()
        }
    );

    // **カコ** (suppin_1, 左): 私は……
    match &events[14] {
        Event::Dialog {
            character, text, ..
        } => {
            assert_eq!(character, &Some("カコ".to_string()));
            assert_eq!(text, &vec!["私は……".to_string()]);
        }
        other => panic!("Expected Dialog, got {:?}", other),
    }

    // [BGM: snowsnow.ogg]
    assert_eq!(
        events[15],
        Event::Bgm {
            path: Some("snowsnow.ogg".to_string()),
            action: BgmAction::Play
        }
    );
    // [暗転]
    assert_eq!(
        events[16],
        Event::Blackout {
            action: BlackoutAction::On
        }
    );
}

#[test]
fn test_roundtrip() {
    let doc = parser::parse(SAMPLE_MARKDOWN);
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);

    // The documents should be structurally equal
    assert_eq!(doc, doc2);
}

#[test]
fn test_choice() {
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: 選択テスト

[選択]
- 信じる → 1-3
- 信じない → 1-4
[/選択]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::Choice { options } => {
            assert_eq!(options.len(), 2);
            assert_eq!(options[0].text, "信じる");
            assert_eq!(options[0].jump, "1-3");
            assert_eq!(options[1].text, "信じない");
            assert_eq!(options[1].jump, "1-4");
        }
        other => panic!("Expected Choice, got {:?}", other),
    }

    // Roundtrip
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_flag() {
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: フラグテスト

[フラグ: トモを信じた = true]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0],
        Event::Flag {
            name: "トモを信じた".to_string(),
            value: FlagValue::Bool(true),
        }
    );

    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_condition() {
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: 条件テスト

[条件: トモを信じた]
**カコ** (suppin_1, 左):
ありがとう。
[/条件]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::Condition {
            flag,
            events: inner,
        } => {
            assert_eq!(flag, "トモを信じた");
            assert_eq!(inner.len(), 1);
            match &inner[0] {
                Event::Dialog {
                    character, text, ..
                } => {
                    assert_eq!(character, &Some("カコ".to_string()));
                    assert_eq!(text, &vec!["ありがとう。".to_string()]);
                }
                other => panic!("Expected Dialog inside condition, got {:?}", other),
            }
        }
        other => panic!("Expected Condition, got {:?}", other),
    }
}

#[test]
fn test_narration() {
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: 地の文テスト

> 静かな朝だった。
> 誰もいない教室。
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::Narration { text } => {
            assert_eq!(
                text,
                &vec![
                    "静かな朝だった。".to_string(),
                    "誰もいない教室。".to_string()
                ]
            );
        }
        other => panic!("Expected Narration, got {:?}", other),
    }

    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_empty_scene() {
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: 空のシーン

## 1-2: 次のシーン

**カコ** (suppin_1, 左):
こんにちは。
"#;
    let doc = parser::parse(input);
    let scenes = &doc.chapters[0].scenes;
    assert_eq!(scenes.len(), 2);
    assert_eq!(scenes[0].id, "1-1");
    assert_eq!(scenes[0].events.len(), 0);
    assert_eq!(scenes[1].id, "1-2");
    assert_eq!(scenes[1].events.len(), 1);

    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_expression_change_without_text() {
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: 表情変更テスト

**トモ** (laugh_1, 右):
最初の台詞。

**トモ** → angry_1:

[暗転]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 3);
    match &events[0] {
        Event::Dialog {
            character, text, ..
        } => {
            assert_eq!(character, &Some("トモ".to_string()));
            assert_eq!(text, &vec!["最初の台詞。".to_string()]);
        }
        other => panic!("Expected Dialog, got {:?}", other),
    }
    assert_eq!(
        events[1],
        Event::ExpressionChange {
            character: "トモ".to_string(),
            expression: "angry_1".to_string(),
        }
    );
    assert_eq!(
        events[2],
        Event::Blackout {
            action: BlackoutAction::On
        }
    );
}

#[test]
fn test_rpg_map_only() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map-village: 村

[マップ 5x3 タイル=32]
GGGGG
GRRRG
GGGGG
[/マップ]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::RpgMap(map) => {
            assert_eq!(map.width, 5);
            assert_eq!(map.height, 3);
            assert_eq!(map.tile_size, 32);
            assert_eq!(map.tiles.len(), 3);
            assert_eq!(map.tiles[0], vec![0, 0, 0, 0, 0]);
            assert_eq!(map.tiles[1], vec![0, 1, 1, 1, 0]);
            assert_eq!(map.tiles[2], vec![0, 0, 0, 0, 0]);
        }
        other => panic!("Expected RpgMap, got {:?}", other),
    }

    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_rpg_npc_block() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map-village: 村

[NPC 長老 @5,3 色=#ff0000]
こんにちは、旅人さん。
村へようこそ。
[/NPC]

[NPC 子ども @7,5 色=#00aaff]
ねえねえ遊ぼうよ！
[/NPC]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 2);
    match &events[0] {
        Event::Npc(npc) => {
            assert_eq!(npc.name, "長老");
            assert_eq!(npc.x, 5);
            assert_eq!(npc.y, 3);
            assert_eq!(npc.color, 0xff0000);
            assert_eq!(
                npc.message,
                vec![
                    "こんにちは、旅人さん。".to_string(),
                    "村へようこそ。".to_string(),
                ]
            );
        }
        other => panic!("Expected Npc, got {:?}", other),
    }
    match &events[1] {
        Event::Npc(npc) => {
            assert_eq!(npc.name, "子ども");
            assert_eq!(npc.color, 0x00aaff);
        }
        other => panic!("Expected Npc, got {:?}", other),
    }

    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_rpg_player_start() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map-village: 村

[プレイヤー @10,7 向き=下]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::PlayerStart(p) => {
            assert_eq!(p.x, 10);
            assert_eq!(p.y, 7);
            assert_eq!(p.direction, Direction::Down);
        }
        other => panic!("Expected PlayerStart, got {:?}", other),
    }

    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_rpg_full_scene_with_novel_mixed() {
    // RPG elements and novel Dialog in the same scene
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map-village: 村の広場

[マップ 4x3 タイル=32]
TTTT
T..T
TTTT
[/マップ]

[プレイヤー @1,1 向き=下]

[NPC 長老 @2,1 色=#ff0000]
こんにちは。
[/NPC]

**カコ** (suppin_1, 左):
この村に着いたみたいね。
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    // RpgMap, PlayerStart, Npc, Dialog
    assert_eq!(events.len(), 4);
    assert!(matches!(events[0], Event::RpgMap(_)));
    assert!(matches!(events[1], Event::PlayerStart(_)));
    assert!(matches!(events[2], Event::Npc(_)));
    assert!(matches!(events[3], Event::Dialog { .. }));

    // Map should have grass (from .) in middle
    if let Event::RpgMap(map) = &events[0] {
        assert_eq!(map.tiles[0], vec![2, 2, 2, 2]);
        assert_eq!(map.tiles[1], vec![2, 0, 0, 2]);
    }

    // NPC id should be generated from name (non-ASCII → npc1)
    if let Event::Npc(npc) = &events[2] {
        assert_eq!(npc.name, "長老");
        assert!(!npc.id.is_empty());
    }

    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_rpg_direction_variants() {
    let cases = vec![
        ("上", Direction::Up),
        ("下", Direction::Down),
        ("左", Direction::Left),
        ("右", Direction::Right),
    ];
    for (ja, expected) in cases {
        let input = format!(
            r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## m: map

[プレイヤー @0,0 向き={}]
"#,
            ja
        );
        let doc = parser::parse(&input);
        match &doc.chapters[0].scenes[0].events[0] {
            Event::PlayerStart(p) => assert_eq!(p.direction, expected),
            other => panic!("Expected PlayerStart, got {:?}", other),
        }
    }
}

#[test]
fn test_no_front_matter() {
    let input = r#"## 1-1: テスト

**カコ** (suppin_1, 左):
こんにちは。
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.engine, "name-name");
    assert_eq!(doc.chapters[0].number, 1);
    assert_eq!(doc.chapters[0].title, "");
    assert_eq!(doc.chapters[0].scenes.len(), 1);
    assert_eq!(doc.chapters[0].scenes[0].events.len(), 1);
}
