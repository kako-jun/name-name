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
    assert!(!chapter.hidden);
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
            path: "radius/BG_COMMON_GRAD_3.png".to_string(),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );
    // [BGM: amehure.ogg]
    assert_eq!(
        events[1],
        Event::Bgm {
            path: Some("amehure.ogg".to_string()),
            action: BgmAction::Play,
            fade_ms: None,
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
            ..
        } => {
            assert_eq!(character, &Some("カコ".to_string()));
            assert_eq!(expression, &Some("suppin_1".to_string()));
            assert_eq!(position, &Some("左".to_string()));
            assert_eq!(
                text,
                &vec!["ちくしょう⋯⋯。".to_string(), "なんで！".to_string()]
            );
        }
        other => panic!("Expected Dialog, got {other:?}"),
    }

    // [SE: ...]
    assert_eq!(
        events[4],
        Event::Se {
            path: "se_maoudamashii_onepoint26.ogg".to_string(),
            fade_ms: None,
        }
    );

    // こうなるんだよぅ……ッ！ (continuation of カコ)
    match &events[5] {
        Event::Dialog {
            character,
            expression,
            position,
            text,
            ..
        } => {
            assert_eq!(character, &Some("カコ".to_string()));
            assert_eq!(expression, &Some("suppin_1".to_string()));
            assert_eq!(position, &Some("左".to_string()));
            assert_eq!(text, &vec!["こうなるんだよぅ⋯⋯ッ！".to_string()]);
        }
        other => panic!("Expected Dialog continuation, got {other:?}"),
    }

    // **トモ** (laugh_1, 右): ...
    match &events[6] {
        Event::Dialog {
            character,
            expression,
            position,
            text,
            ..
        } => {
            assert_eq!(character, &Some("トモ".to_string()));
            assert_eq!(expression, &Some("laugh_1".to_string()));
            assert_eq!(position, &Some("右".to_string()));
            assert_eq!(
                text,
                &vec![
                    "あなたを信じることはできない⋯⋯。".to_string(),
                    "だって⋯⋯".to_string(),
                    "そんなの絶対おかしいよ！".to_string(),
                ]
            );
        }
        other => panic!("Expected Dialog, got {other:?}"),
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
            ..
        } => {
            assert_eq!(character, &Some("トモ".to_string()));
            assert_eq!(expression, &Some("angry_1".to_string()));
            assert_eq!(text, &vec!["くけけけけけけけけけ。".to_string()]);
        }
        other => panic!("Expected Dialog after expression change, got {other:?}"),
    }

    // [背景: radius/BG_KAKO_1_2.png]
    assert_eq!(
        events[9],
        Event::Background {
            path: "radius/BG_KAKO_1_2.png".to_string(),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: None,
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
        other => panic!("Expected Dialog continuation, got {other:?}"),
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
            path: "radius/BG_COMMON_GRAD_3.png".to_string(),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );

    // **カコ** (suppin_1, 左): 私は……
    match &events[14] {
        Event::Dialog {
            character, text, ..
        } => {
            assert_eq!(character, &Some("カコ".to_string()));
            assert_eq!(text, &vec!["私は⋯⋯".to_string()]);
        }
        other => panic!("Expected Dialog, got {other:?}"),
    }

    // [BGM: snowsnow.ogg]
    assert_eq!(
        events[15],
        Event::Bgm {
            path: Some("snowsnow.ogg".to_string()),
            action: BgmAction::Play,
            fade_ms: None,
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
        other => panic!("Expected Choice, got {other:?}"),
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
                other => panic!("Expected Dialog inside condition, got {other:?}"),
            }
        }
        other => panic!("Expected Condition, got {other:?}"),
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
        Event::Narration { text, .. } => {
            assert_eq!(
                text,
                &vec![
                    "静かな朝だった。".to_string(),
                    "誰もいない教室。".to_string()
                ]
            );
        }
        other => panic!("Expected Narration, got {other:?}"),
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
        other => panic!("Expected Dialog, got {other:?}"),
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
        other => panic!("Expected RpgMap, got {other:?}"),
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
        other => panic!("Expected Npc, got {other:?}"),
    }
    match &events[1] {
        Event::Npc(npc) => {
            assert_eq!(npc.name, "子ども");
            assert_eq!(npc.color, 0x00aaff);
        }
        other => panic!("Expected Npc, got {other:?}"),
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
        other => panic!("Expected PlayerStart, got {other:?}"),
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

[プレイヤー @0,0 向き={ja}]
"#
        );
        let doc = parser::parse(&input);
        match &doc.chapters[0].scenes[0].events[0] {
            Event::PlayerStart(p) => assert_eq!(p.direction, expected),
            other => panic!("Expected PlayerStart, got {other:?}"),
        }
    }
}

#[test]
fn test_rpg_direction_unknown_falls_back_to_down_with_warning() {
    // 未知の向き値は `Down` にフォールバック（既存挙動を維持）し、stderr に warning を出す。
    // ここでは挙動（=Down）のみを assert。warning 出力は副作用で、手動で stderr を読んで確認する。
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## m: map

[プレイヤー @0,0 向き=大きい]

[NPC a @1,1 色=#ff0000 向き=さいきょう]
hi
[/NPC]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    match &events[0] {
        Event::PlayerStart(p) => assert_eq!(p.direction, Direction::Down),
        other => panic!("Expected PlayerStart, got {other:?}"),
    }
    match &events[1] {
        Event::Npc(npc) => assert_eq!(npc.direction, Some(Direction::Down)),
        other => panic!("Expected Npc, got {other:?}"),
    }
}

#[test]
fn test_rpg_npc_message_preserves_leading_indent() {
    // Leading whitespace in NPC message must be preserved (e.g. for code snippets,
    // ASCII art, or poem-style indentation). Only trailing whitespace is trimmed.
    let input = "---\nengine: name-name\nchapter: 1\ntitle: \"RPG\"\n---\n\n## map: m\n\n[NPC elder @0,0 色=#ff0000]\n  インデント付きの台詞\n通常の台詞\n\t空白タブ\n[/NPC]\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    match &events[0] {
        Event::Npc(npc) => {
            assert_eq!(npc.message[0], "  インデント付きの台詞");
            assert_eq!(npc.message[1], "通常の台詞");
            assert_eq!(npc.message[2], "\t空白タブ");
        }
        other => panic!("Expected Npc, got {other:?}"),
    }

    // Round-trip must also preserve indentation.
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
    if let Event::Npc(npc2) = &doc2.chapters[0].scenes[0].events[0] {
        assert_eq!(npc2.message[0], "  インデント付きの台詞");
    }
}

#[test]
fn test_rpg_npc_explicit_id_round_trip() {
    // An explicit `id=...` in the NPC header must be preserved through
    // parse → emit → parse (so flag conditions can reference it stably).
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[NPC 長老 @5,3 色=#ff0000 id=village-elder]
こんにちは。
[/NPC]
"#;
    let doc = parser::parse(input);
    if let Event::Npc(npc) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(npc.id, "village-elder");
    } else {
        panic!("Expected Npc");
    }

    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("id=village-elder"),
        "emit must write explicit id that differs from auto-slug: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_rpg_npc_id_matching_slug_is_omitted_on_emit() {
    // If the explicit id happens to equal the slug of the name, the emitter
    // should omit `id=...` so the markup stays visually short.
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[NPC elder @0,0 色=#ff0000 id=elder]
hi
[/NPC]
"#;
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    assert!(
        !emitted.contains("id="),
        "emit should omit id= when it matches the slug: {emitted}"
    );
    // But round-trip must still yield the same id.
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_rpg_npc_explicit_id_collision_gets_suffix() {
    // If an NPC with the same explicit id is already present, the new one
    // gets a `-2` suffix (same behavior as the slug path).
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[NPC a @0,0 色=#ff0000 id=dup]
one
[/NPC]

[NPC b @1,1 色=#00ff00 id=dup]
two
[/NPC]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let (Event::Npc(n1), Event::Npc(n2)) = (&events[0], &events[1]) {
        assert_eq!(n1.id, "dup");
        assert_eq!(n2.id, "dup-2");
    } else {
        panic!("Expected two Npc events");
    }
}

#[test]
fn test_rpg_npc_sprite_and_frames() {
    // `sprite=` と `frames=` の双方向変換。未指定の既存 NPC は None のまま維持される。
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[NPC elder @5,3 色=#ff0000 sprite=elder.png frames=2]
hi
[/NPC]

[NPC kid @2,2 色=#00aaff sprite=kid.png]
hey
[/NPC]

[NPC plain @0,0 色=#888888]
default square
[/NPC]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 3);
    if let Event::Npc(n) = &events[0] {
        assert_eq!(n.sprite.as_deref(), Some("elder.png"));
        assert_eq!(n.frames, Some(2));
    } else {
        panic!("Expected Npc");
    }
    if let Event::Npc(n) = &events[1] {
        assert_eq!(n.sprite.as_deref(), Some("kid.png"));
        assert_eq!(n.frames, None, "frames absent when not specified");
    } else {
        panic!("Expected Npc");
    }
    if let Event::Npc(n) = &events[2] {
        assert_eq!(n.sprite, None);
        assert_eq!(n.frames, None);
    } else {
        panic!("Expected Npc");
    }

    // Round-trip
    let emitted = emitter::emit(&doc);
    assert!(emitted.contains("sprite=elder.png"));
    assert!(emitted.contains("frames=2"));
    // plain NPC should NOT gain sprite/frames after round-trip
    let plain_line = emitted
        .lines()
        .find(|l| l.contains("[NPC plain "))
        .expect("plain NPC header should exist");
    assert!(
        !plain_line.contains("sprite="),
        "plain NPC should not emit sprite=: {plain_line}"
    );
    assert!(
        !plain_line.contains("frames="),
        "plain NPC should not emit frames=: {plain_line}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_rpg_npc_direction_round_trip() {
    // `向き=` 属性の双方向変換。未指定の NPC は direction None のまま維持される。
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[NPC a @0,0 色=#ff0000 向き=左]
hi
[/NPC]

[NPC b @1,1 色=#00ff00 向き=右]
hey
[/NPC]

[NPC c @2,2 色=#0000ff 向き=上]
ho
[/NPC]

[NPC d @3,3 色=#ffff00]
default
[/NPC]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 4);
    if let Event::Npc(n) = &events[0] {
        assert_eq!(n.direction, Some(Direction::Left));
    }
    if let Event::Npc(n) = &events[1] {
        assert_eq!(n.direction, Some(Direction::Right));
    }
    if let Event::Npc(n) = &events[2] {
        assert_eq!(n.direction, Some(Direction::Up));
    }
    if let Event::Npc(n) = &events[3] {
        assert_eq!(n.direction, None);
    }

    // Round-trip: emit must include 向き= for specified NPCs, omit for default
    let emitted = emitter::emit(&doc);
    assert!(emitted.contains("向き=左"));
    assert!(emitted.contains("向き=右"));
    assert!(emitted.contains("向き=上"));
    let default_line = emitted
        .lines()
        .find(|l| l.contains("[NPC d "))
        .expect("default NPC header");
    assert!(
        !default_line.contains("向き="),
        "default NPC must not emit 向き=: {default_line}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_rpg_npc_invalid_frames_is_ignored() {
    // `frames=0` や非数値は無効扱い（None のまま）。NPC 自体はパースされる。
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[NPC a @0,0 色=#ff0000 frames=0]
hi
[/NPC]

[NPC b @1,1 色=#ff0000 frames=abc]
hi
[/NPC]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 2);
    if let Event::Npc(n) = &events[0] {
        assert_eq!(n.frames, None, "frames=0 is invalid");
    }
    if let Event::Npc(n) = &events[1] {
        assert_eq!(n.frames, None, "non-numeric frames is invalid");
    }
}

#[test]
fn test_rpg_npc_portrait_round_trip() {
    // Issue #73 Phase 1: `portrait=` 属性の双方向変換。
    // 未指定の NPC は portrait = None のまま維持される。
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[NPC elder @5,3 色=#ff0000 portrait=elder_portrait.png]
hi
[/NPC]

[NPC kid @2,2 色=#00aaff sprite=kid.png portrait=kid_portrait.png]
hey
[/NPC]

[NPC plain @0,0 色=#888888]
no portrait
[/NPC]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 3);
    if let Event::Npc(n) = &events[0] {
        assert_eq!(n.portrait.as_deref(), Some("elder_portrait.png"));
    } else {
        panic!("Expected Npc");
    }
    if let Event::Npc(n) = &events[1] {
        assert_eq!(n.portrait.as_deref(), Some("kid_portrait.png"));
        assert_eq!(n.sprite.as_deref(), Some("kid.png"));
    } else {
        panic!("Expected Npc");
    }
    if let Event::Npc(n) = &events[2] {
        assert_eq!(n.portrait, None, "portrait absent when not specified");
    } else {
        panic!("Expected Npc");
    }

    // Round-trip
    let emitted = emitter::emit(&doc);
    assert!(emitted.contains("portrait=elder_portrait.png"));
    assert!(emitted.contains("portrait=kid_portrait.png"));
    // plain NPC should NOT gain portrait after round-trip
    let plain_line = emitted
        .lines()
        .find(|l| l.contains("[NPC plain "))
        .expect("plain NPC header should exist");
    assert!(
        !plain_line.contains("portrait="),
        "plain NPC should not emit portrait=: {plain_line}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_rpg_map_dimension_mismatch_row_count_short() {
    // Declared 5x4, actual 2 rows: parser tolerantly pads to 4 with zero rows,
    // and a warning is emitted to stderr. The panic-free behavior is what we
    // assert here; the warning is a side-effect verified manually.
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## m: m

[マップ 5x4 タイル=32]
GGGGG
GRRRG
[/マップ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(map.width, 5);
        assert_eq!(map.height, 4);
        assert_eq!(map.tiles.len(), 4); // padded
        assert_eq!(map.tiles[2], vec![0, 0, 0, 0, 0]);
        assert_eq!(map.tiles[3], vec![0, 0, 0, 0, 0]);
    } else {
        panic!("Expected RpgMap");
    }
}

#[test]
fn test_rpg_map_dimension_mismatch_row_count_long() {
    // Declared 3x2, actual 4 rows: parser truncates to 2.
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## m: m

[マップ 3x2 タイル=32]
GGG
RRR
TTT
WWW
[/マップ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(map.tiles.len(), 2);
        assert_eq!(map.tiles[0], vec![0, 0, 0]);
        assert_eq!(map.tiles[1], vec![1, 1, 1]);
    } else {
        panic!("Expected RpgMap");
    }
}

#[test]
fn test_rpg_map_dimension_mismatch_column_short() {
    // Row is shorter than declared width: zero-padded to width.
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## m: m

[マップ 5x2 タイル=32]
GG
RRRRR
[/マップ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(map.tiles[0], vec![0, 0, 0, 0, 0]); // "GG" + pad
        assert_eq!(map.tiles[1], vec![1, 1, 1, 1, 1]);
    } else {
        panic!("Expected RpgMap");
    }
}

#[test]
fn test_rpg_map_dimension_mismatch_column_long() {
    // Row is longer than declared width: truncated to width.
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## m: m

[マップ 3x2 タイル=32]
GGGRRR
RRR
[/マップ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(map.tiles[0], vec![0, 0, 0]); // truncated from 6 chars
        assert_eq!(map.tiles[1], vec![1, 1, 1]);
    } else {
        panic!("Expected RpgMap");
    }
}

#[test]
fn test_emit_omits_hidden_false() {
    // hidden: false is the default; emitter should not write it.
    let doc = parser::parse("---\nengine: name-name\nchapter: 1\ntitle: \"t\"\n---\n\n## 1-1: s\n");
    let emitted = emitter::emit(&doc);
    assert!(
        !emitted.contains("hidden:"),
        "hidden: false should be omitted: {emitted}"
    );
    // Round-trip equivalence.
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_emit_keeps_hidden_true() {
    let input = r#"---
engine: name-name
chapter: 1
title: "t"
hidden: true
---

## 1-1: s
"#;
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("hidden: true"),
        "hidden: true must round-trip: {emitted}"
    );
}

#[test]
fn test_scene_view_raycast_round_trip() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map-village: 村の広場 [view=raycast]

[マップ 3x2 タイル=32]
TTT
T.T
[/マップ]
"#;
    let doc = parser::parse(input);
    let scene = &doc.chapters[0].scenes[0];
    assert_eq!(scene.id, "map-village");
    assert_eq!(scene.title, "村の広場");
    assert_eq!(scene.view, SceneView::Raycast);

    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("## map-village: 村の広場 [view=raycast]"),
        "emit must write [view=raycast] directive: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_scene_view_default_topdown_is_omitted_on_emit() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map-village: 村の広場

[マップ 3x2 タイル=32]
TTT
T.T
[/マップ]
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.chapters[0].scenes[0].view, SceneView::TopDown);
    let emitted = emitter::emit(&doc);
    assert!(
        !emitted.contains("[view="),
        "TopDown is default and must not be emitted: {emitted}"
    );
}

#[test]
fn test_scene_view_topdown_explicit_is_normalized() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map-village: 村 [view=topdown]
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.chapters[0].scenes[0].title, "村");
    assert_eq!(doc.chapters[0].scenes[0].view, SceneView::TopDown);
    // emit drops the explicit topdown
    let emitted = emitter::emit(&doc);
    assert!(!emitted.contains("[view="), "got: {emitted}");
}

#[test]
fn test_scene_view_unknown_falls_back_to_topdown() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map-village: 村 [view=bogus]
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.chapters[0].scenes[0].view, SceneView::TopDown);
}

/// タイトル自体が `]` で終わるケース（例: `## 1-1: テスト [重要]`）では
/// `[重要]` は `view=` プレフィックスを持たないため、タイトルの一部として
/// そのまま保持され、unknown view の warning も出ない。
#[test]
fn test_scene_title_ending_with_bracket_is_not_view() {
    let input = r#"---
engine: name-name
chapter: 1
title: "t"
---

## 1-1: テスト [重要]

**カコ** (suppin_1, 左):
hi
"#;
    let doc = parser::parse(input);
    let scene = &doc.chapters[0].scenes[0];
    // タイトルは `[重要]` を含めてそのまま保持される
    assert_eq!(scene.title, "テスト [重要]");
    // view は未指定なのでデフォルトの TopDown
    assert_eq!(scene.view, SceneView::TopDown);

    // round-trip: emit してもタイトルが壊れない
    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("## 1-1: テスト [重要]"),
        "title with trailing [重要] must be preserved: {emitted}"
    );
    // view=... 指定がないので [view=...] も emit されない
    assert!(
        !emitted.contains("[view="),
        "no view directive should be emitted: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

/// Issue #90: [マップ] の後ろに [壁高さ] ブロックを置くと、直前の RpgMap
/// に wall_heights として注入される。往復で値が保持される。
#[test]
fn test_rpg_map_with_wall_heights() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 3x2 タイル=32]
TTT
T.T
[/マップ]

[壁高さ]
1 2 1
1 1 1
[/壁高さ]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::RpgMap(map) => {
            assert_eq!(
                map.wall_heights.as_ref().expect("wall_heights present"),
                &vec![vec![1.0, 2.0, 1.0], vec![1.0, 1.0, 1.0]]
            );
            assert_eq!(map.floor_heights, None);
            assert_eq!(map.ceiling_heights, None);
        }
        other => panic!("Expected RpgMap, got {other:?}"),
    }
    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("[壁高さ]"),
        "emit must write [壁高さ]: {emitted}"
    );
    assert!(
        !emitted.contains("[床高さ]"),
        "missing floor block should not be emitted: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

/// 列数不揃いな高さブロックでも parser は受理して保持する。
/// 寸法整合は `validateMapHeights` 側で検証する責務であり、
/// parser は警告だけ出して値はそのまま `Vec<Vec<f64>>` に載せる。
#[test]
fn test_rpg_map_height_jagged_rows() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 3x2 タイル=32]
TTT
TGT
[/マップ]

[壁高さ]
1 2 3
4 5
[/壁高さ]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::RpgMap(map) => {
            // ジャグ配列でも Vec<Vec<f64>> としてそのまま保持される（破棄しない）。
            assert_eq!(
                map.wall_heights.as_ref().expect("wall_heights present"),
                &vec![vec![1.0, 2.0, 3.0], vec![4.0, 5.0]]
            );
            assert_eq!(map.floor_heights, None);
            assert_eq!(map.ceiling_heights, None);
        }
        other => panic!("Expected RpgMap, got {other:?}"),
    }
}

/// [マップ] + [壁高さ] + [床高さ] + [天井高さ] の 4 ブロックが揃った場合の往復。
#[test]
fn test_rpg_map_with_all_heights() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 3x2 タイル=32]
TTT
T.T
[/マップ]

[壁高さ]
1 2 1
1 1 1
[/壁高さ]

[床高さ]
0 0 0
0 0.5 0
[/床高さ]

[天井高さ]
1 1 1
1 2 1
[/天井高さ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(
            map.wall_heights.as_ref().unwrap(),
            &vec![vec![1.0, 2.0, 1.0], vec![1.0, 1.0, 1.0]]
        );
        assert_eq!(
            map.floor_heights.as_ref().unwrap(),
            &vec![vec![0.0, 0.0, 0.0], vec![0.0, 0.5, 0.0]]
        );
        assert_eq!(
            map.ceiling_heights.as_ref().unwrap(),
            &vec![vec![1.0, 1.0, 1.0], vec![1.0, 2.0, 1.0]]
        );
    } else {
        panic!("Expected RpgMap");
    }
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

/// 小数値（0.25, 1.5 など）も正確に往復する。
#[test]
fn test_rpg_map_heights_roundtrip_decimals() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 3x2 タイル=32]
TTT
T.T
[/マップ]

[床高さ]
0 0.25 0
1.5 0 0
[/床高さ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        let floor = map.floor_heights.as_ref().unwrap();
        assert_eq!(floor[0], vec![0.0, 0.25, 0.0]);
        assert_eq!(floor[1], vec![1.5, 0.0, 0.0]);
    } else {
        panic!("Expected RpgMap");
    }
    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("0.25"),
        "decimal 0.25 must survive emit: {emitted}"
    );
    assert!(
        emitted.contains("1.5"),
        "decimal 1.5 must survive emit: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

/// 高さブロックの記述順は [壁高さ]→[床高さ]→[天井高さ] を推奨するが、
/// parser は順不同で受理する（ここでは [天井高さ]→[床高さ]→[壁高さ] の順で書く）。
#[test]
fn test_rpg_map_heights_order_independent() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 3x2 タイル=32]
TTT
T.T
[/マップ]

[天井高さ]
1 1 1
1 2 1
[/天井高さ]

[床高さ]
0 0 0
0 0.5 0
[/床高さ]

[壁高さ]
1 2 1
1 1 1
[/壁高さ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(
            map.wall_heights.as_ref().unwrap(),
            &vec![vec![1.0, 2.0, 1.0], vec![1.0, 1.0, 1.0]]
        );
        assert_eq!(
            map.floor_heights.as_ref().unwrap(),
            &vec![vec![0.0, 0.0, 0.0], vec![0.0, 0.5, 0.0]]
        );
        assert_eq!(
            map.ceiling_heights.as_ref().unwrap(),
            &vec![vec![1.0, 1.0, 1.0], vec![1.0, 2.0, 1.0]]
        );
    } else {
        panic!("Expected RpgMap");
    }
    // 往復しても内容は同じ（emit は推奨順で出し直す）
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

/// Issue #90 レビュー指摘 #6-a: 空の高さブロック `[壁高さ]\n[/壁高さ]` は
/// `Some(vec![])` として保持せず、None のまま残す（空ブロックは警告を出して無視）。
#[test]
fn test_rpg_map_height_empty_block() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 3x2 タイル=32]
TTT
T.T
[/マップ]

[壁高さ]
[/壁高さ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(map.wall_heights, None);
    } else {
        panic!("Expected RpgMap");
    }
}

/// Issue #90 レビュー指摘 #6-b: `[マップ]` より前に高さブロックが現れた場合、
/// 直前に RpgMap がないので破棄される。後続の `[マップ]` には注入されない。
#[test]
fn test_rpg_map_height_before_map() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[壁高さ]
1 1 1
1 1 1
[/壁高さ]

[マップ 3x2 タイル=32]
TTT
T.T
[/マップ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(map.wall_heights, None);
    } else {
        panic!("Expected RpgMap");
    }
}

/// Issue #90 レビュー指摘 #6-c + #11: 同じ種別の高さブロックが重複した場合、
/// 「最後勝ち」で上書きする（エディタで書き換えたとき後者が勝つ方が直感的）。
#[test]
fn test_rpg_map_height_duplicate_block() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 2x2 タイル=32]
TT
TT
[/マップ]

[壁高さ]
1 1
1 1
[/壁高さ]

[壁高さ]
2 2
2 2
[/壁高さ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        assert_eq!(
            map.wall_heights.as_ref().unwrap(),
            &vec![vec![2.0, 2.0], vec![2.0, 2.0]]
        );
    } else {
        panic!("Expected RpgMap");
    }
}

/// Issue #90 レビュー指摘 #6-d + #2: 数値でないトークンが 1 つでもあれば
/// その行を丸ごと破棄して警告を出す（silent drop 禁止）。他の行は採用される。
#[test]
fn test_rpg_map_height_non_numeric_token() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 4x2 タイル=32]
TTTT
TTTT
[/マップ]

[壁高さ]
1 2 abc 4
1 1 1 1
[/壁高さ]
"#;
    let doc = parser::parse(input);
    if let Event::RpgMap(map) = &doc.chapters[0].scenes[0].events[0] {
        // 1 行目 ("1 2 abc 4") は破棄され、2 行目 ("1 1 1 1") のみ採用される。
        assert_eq!(
            map.wall_heights.as_ref().unwrap(),
            &vec![vec![1.0, 1.0, 1.0, 1.0]]
        );
    } else {
        panic!("Expected RpgMap");
    }
}

/// Issue #90 レビュー指摘 #6-e + #4: 高さブロックは **直前の** RpgMap にしか
/// 紐付けない（`last_mut()` 方針）。`[マップ]→[プレイヤー]→[壁高さ]` では高さは破棄される。
#[test]
fn test_rpg_map_height_block_not_immediately_after_map() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 3x2 タイル=32]
TTT
T.T
[/マップ]

[プレイヤー @0,0 向き=下]

[壁高さ]
1 1 1
1 1 1
[/壁高さ]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::RpgMap(map) = &events[0] {
        assert_eq!(
            map.wall_heights, None,
            "直前が PlayerStart なので壁高さは破棄される"
        );
    } else {
        panic!("Expected RpgMap at [0]");
    }
    // PlayerStart は保持されている
    assert!(
        matches!(&events[1], Event::PlayerStart(_)),
        "PlayerStart should be preserved"
    );
}

/// Issue #90 レビュー指摘 #6-f + #1: `[/マップ]` 欠落時、次のブロック（`[壁高さ]`）
/// が突入したらマップ収集を break + 警告。その `[壁高さ]` は独立ブロックとして解釈され、
/// ただし直前が RpgMap であれば注入される（このケースは RpgMap が last なので注入される）。
#[test]
fn test_rpg_map_close_missing() {
    let input = r#"---
engine: name-name
chapter: 1
title: "RPG"
---

## map: m

[マップ 3x2 タイル=32]
TTT
TGT
[壁高さ]
1 1 1
1 1 1
[/壁高さ]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    // [/マップ] が無いまま [壁高さ] が来たため、マップは 2 行分収集されて RpgMap になる。
    // 続く [壁高さ] は独立ブロックとして解釈され、直前の RpgMap に注入される。
    assert_eq!(events.len(), 1, "RpgMap 一つだけ（高さは inject される）");
    if let Event::RpgMap(map) = &events[0] {
        assert_eq!(map.width, 3);
        assert_eq!(map.height, 2);
        assert_eq!(
            map.wall_heights.as_ref().unwrap(),
            &vec![vec![1.0, 1.0, 1.0], vec![1.0, 1.0, 1.0]]
        );
    } else {
        panic!("Expected RpgMap");
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

// ---- #143 画面効果: shake / flash / fade ----

#[test]
fn test_shake_default_params() {
    let input = r#"---
engine: name-name
chapter: 1
title: "効果テスト"
---

## s1: シェイク

[シェイク:]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Shake {
        intensity_px,
        duration_ms,
    } = &events[0]
    {
        assert_eq!(*intensity_px, 10);
        assert_eq!(*duration_ms, 500);
    } else {
        panic!("Expected Shake, got {:?}", events[0]);
    }
}

#[test]
fn test_shake_custom_params() {
    let input = r#"---
engine: name-name
chapter: 1
title: "効果テスト"
---

## s1: シェイク

[シェイク: intensity=20, duration=1000]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::Shake {
        intensity_px,
        duration_ms,
    } = &events[0]
    {
        assert_eq!(*intensity_px, 20);
        assert_eq!(*duration_ms, 1000);
    } else {
        panic!("Expected Shake, got {:?}", events[0]);
    }
}

#[test]
fn test_shake_ja_params() {
    let input = r#"---
engine: name-name
chapter: 1
title: "効果テスト"
---

## s1: シェイク

[シェイク: 強度=15, 時間=800]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::Shake {
        intensity_px,
        duration_ms,
    } = &events[0]
    {
        assert_eq!(*intensity_px, 15);
        assert_eq!(*duration_ms, 800);
    } else {
        panic!("Expected Shake, got {:?}", events[0]);
    }
}

#[test]
fn test_flash_default_params() {
    let input = r#"---
engine: name-name
chapter: 1
title: "効果テスト"
---

## s1: フラッシュ

[フラッシュ:]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::Flash {
        color,
        alpha,
        duration_ms,
    } = &events[0]
    {
        assert_eq!(color, "#ffffff");
        assert!((alpha - 0.8).abs() < 1e-5);
        assert_eq!(*duration_ms, 300);
    } else {
        panic!("Expected Flash, got {:?}", events[0]);
    }
}

#[test]
fn test_flash_custom_params() {
    let input = r#"---
engine: name-name
chapter: 1
title: "効果テスト"
---

## s1: フラッシュ

[フラッシュ: color=#ff0000, alpha=1.0, duration=200]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::Flash {
        color,
        alpha,
        duration_ms,
    } = &events[0]
    {
        assert_eq!(color, "#ff0000");
        assert!((alpha - 1.0).abs() < 1e-5);
        assert_eq!(*duration_ms, 200);
    } else {
        panic!("Expected Flash, got {:?}", events[0]);
    }
}

#[test]
fn test_fade_default_params() {
    let input = r#"---
engine: name-name
chapter: 1
title: "効果テスト"
---

## s1: フェード

[フェード:]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::Fade {
        target,
        color,
        from_alpha,
        to_alpha,
        duration_ms,
    } = &events[0]
    {
        assert_eq!(target, "all");
        assert_eq!(color, "#000000");
        assert!((from_alpha - 0.0).abs() < 1e-5);
        assert!((to_alpha - 1.0).abs() < 1e-5);
        assert_eq!(*duration_ms, 500);
    } else {
        panic!("Expected Fade, got {:?}", events[0]);
    }
}

#[test]
fn test_fade_custom_params() {
    let input = r#"---
engine: name-name
chapter: 1
title: "効果テスト"
---

## s1: フェード

[フェード: target=bg, color=#000000, from=1.0, to=0.0, duration=1500]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::Fade {
        target,
        color,
        from_alpha,
        to_alpha,
        duration_ms,
    } = &events[0]
    {
        assert_eq!(target, "bg");
        assert_eq!(color, "#000000");
        assert!((from_alpha - 1.0).abs() < 1e-5);
        assert!((to_alpha - 0.0).abs() < 1e-5);
        assert_eq!(*duration_ms, 1500);
    } else {
        panic!("Expected Fade, got {:?}", events[0]);
    }
}

#[test]
fn test_fade_ja_params() {
    let input = r#"---
engine: name-name
chapter: 1
title: "効果テスト"
---

## s1: フェード

[フェード: 対象=all, 色=#000000, 開始=0, 終了=1, 時間=600]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::Fade {
        target,
        color,
        from_alpha,
        to_alpha,
        duration_ms,
    } = &events[0]
    {
        assert_eq!(target, "all");
        assert_eq!(color, "#000000");
        assert!((from_alpha - 0.0).abs() < 1e-5);
        assert!((to_alpha - 1.0).abs() < 1e-5);
        assert_eq!(*duration_ms, 600);
    } else {
        panic!("Expected Fade, got {:?}", events[0]);
    }
}

#[test]
fn test_shake_flash_fade_roundtrip() {
    let input = r#"---
engine: name-name
chapter: 1
title: "効果テスト"
---

## s1: 全効果

[シェイク: intensity=20, duration=1000]
[フラッシュ: color=#ffffff, alpha=1.0, duration=200]
[フェード: target=all, color=#000000, from=0, to=1, duration=500]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 3);
    // emitter でシリアライズして再パースしても同じになること
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc2.chapters[0].scenes[0].events.len(), 3);
    assert_eq!(events[0], doc2.chapters[0].scenes[0].events[0]);
    assert_eq!(events[1], doc2.chapters[0].scenes[0].events[1]);
    assert_eq!(events[2], doc2.chapters[0].scenes[0].events[2]);
}

// ---- #268 [文字演出] グリフ単位の文字アニメ ----

#[test]
fn test_text_effect_preset_explode() {
    // プリセット (効果=爆発) + 間隔上書き。プリミティブ既定値は TS 側で展開するので
    // parser は effect/stagger を素直に持つだけ。bare 先頭値 (Title) を target にする。
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: 爆発

[タイトル: orber]
[文字演出: Title, 効果=爆発, 間隔=80]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 2);
    if let Event::TextEffect {
        target,
        effect,
        stagger_ms,
        ms_per_char,
        dy,
        ..
    } = &events[1]
    {
        assert_eq!(target, "Title");
        assert_eq!(*effect, Some(TextEffectPreset::Explode));
        assert_eq!(*stagger_ms, Some(80));
        // プリセット既定値 (dy 等) は parser では展開しない
        assert_eq!(*ms_per_char, None);
        assert_eq!(*dy, None);
    } else {
        panic!("expected TextEffect, got {:?}", events[1]);
    }
}

#[test]
fn test_text_effect_preset_typewriter_english_keys() {
    // 英語エイリアス (effect=typewriter, speed=) も受理する
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: タイプ

[文字演出: target=Title, effect=typewriter, speed=70]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::TextEffect {
        target,
        effect,
        ms_per_char,
        ..
    } = &events[0]
    {
        assert_eq!(target, "Title");
        assert_eq!(*effect, Some(TextEffectPreset::Typewriter));
        assert_eq!(*ms_per_char, Some(70));
    } else {
        panic!("expected TextEffect, got {:?}", events[0]);
    }
}

#[test]
fn test_text_effect_raw_primitives_with_overshoot() {
    // 上級者は素のプリミティブで書ける。easing=オーバーシュート を EaseOutBack に解釈する。
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: 素

[文字演出: Title, dy=+60, scale=0.5, 間隔=50, easing=オーバーシュート]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::TextEffect {
        target,
        effect,
        dy,
        scale,
        stagger_ms,
        easing,
        ..
    } = &events[0]
    {
        assert_eq!(target, "Title");
        assert_eq!(*effect, None);
        assert_eq!(dy.as_deref(), Some("+60"));
        assert_eq!(*scale, Some(0.5));
        assert_eq!(*stagger_ms, Some(50));
        assert_eq!(*easing, Some(Easing::EaseOutBack));
    } else {
        panic!("expected TextEffect, got {:?}", events[0]);
    }
}

#[test]
fn test_text_effect_missing_target_dropped() {
    // target 欠落時は directive を捨てる (Animate の作法に揃える)
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: 欠落

[文字演出: 効果=爆発, 間隔=80]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 0);
}

#[test]
fn test_text_effect_roundtrip() {
    // parse → emit → parse で同一になること（プリセット + 素プリミティブ + EaseOutBack）
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: roundtrip

[文字演出: Title, 効果=爆発, 間隔=80]
[文字演出: target=Title, dy=+60, scale=0.5, 間隔=50, easing=オーバーシュート]
[文字演出: Title, 効果=タイプ, 速度=70]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 3);
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    let events2 = &doc2.chapters[0].scenes[0].events;
    assert_eq!(events2.len(), 3);
    assert_eq!(events[0], events2[0]);
    assert_eq!(events[1], events2[1]);
    assert_eq!(events[2], events2[2]);
}

// ---- #268 [文字演出] フェーズ1ギャップ: エイリアス / 異常系 / フィールド網羅 / emit 形 ----

#[test]
fn test_text_effect_explode_english_and_typewriter_japanese_aliases() {
    // 既存テストは爆発(日)・typewriter(英) のみ。残る組み合わせ
    // effect=explode(英) / 効果=タイプ(日) もプリセットに解決することを守る。
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: alias

[文字演出: target=Title, effect=explode]
[文字演出: Title, 効果=タイプ]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 2);
    match &events[0] {
        Event::TextEffect { effect, .. } => assert_eq!(*effect, Some(TextEffectPreset::Explode)),
        other => panic!("expected TextEffect, got {other:?}"),
    }
    match &events[1] {
        Event::TextEffect { effect, .. } => assert_eq!(*effect, Some(TextEffectPreset::Typewriter)),
        other => panic!("expected TextEffect, got {other:?}"),
    }
}

#[test]
fn test_text_effect_unknown_effect_is_silently_dropped_but_directive_kept() {
    // 未知プリセット名は effect=None に倒すが、target があれば directive 自体は生かす
    // （素のプリミティブとして解釈される余地を残す）。
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: unknown_effect

[文字演出: Title, 効果=きらきら]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::TextEffect { target, effect, .. } => {
            assert_eq!(target, "Title");
            assert_eq!(*effect, None); // 未知は silent skip
        }
        other => panic!("expected TextEffect, got {other:?}"),
    }
}

#[test]
fn test_text_effect_unknown_key_is_silently_skipped() {
    // 未知キーは無視し、既知キーだけ拾う。directive は壊れず残る。
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: unknown_key

[文字演出: Title, 効果=爆発, きらめき=999, 間隔=80]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::TextEffect {
            target,
            effect,
            stagger_ms,
            ..
        } => {
            assert_eq!(target, "Title");
            assert_eq!(*effect, Some(TextEffectPreset::Explode));
            assert_eq!(*stagger_ms, Some(80)); // 既知キーは未知キーに邪魔されず拾える
        }
        other => panic!("expected TextEffect, got {other:?}"),
    }
}

#[test]
fn test_text_effect_all_primitive_fields_parsed() {
    // 既存 raw テストは dy/scale/間隔/easing のみ。残る dx/rotation/alpha/duration/速度 を網羅する。
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: fields

[文字演出: Title, dx=-30, rotation=180, alpha=0.5, duration=600, speed=40]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::TextEffect {
            dx,
            rotation,
            alpha,
            duration_ms,
            ms_per_char,
            ..
        } => {
            assert_eq!(dx.as_deref(), Some("-30"));
            assert_eq!(rotation.as_deref(), Some("180"));
            assert_eq!(*alpha, Some(0.5));
            assert_eq!(*duration_ms, Some(600));
            assert_eq!(*ms_per_char, Some(40));
        }
        other => panic!("expected TextEffect, got {other:?}"),
    }
}

#[test]
fn test_text_effect_second_bare_value_ignored_target_stays_first() {
    // bare 値は先頭のみ target。2 つ目以降の bare 値は silent skip され、target は先頭のまま。
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: bare

[文字演出: Title, Foo, 効果=爆発]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::TextEffect { target, .. } => assert_eq!(target, "Title"),
        other => panic!("expected TextEffect, got {other:?}"),
    }
}

#[test]
fn test_text_effect_emit_uses_english_keywords() {
    // emit は effect=explode / easing=ease-out-back の英語キーワード形に正規化する
    // （round-trip 一致のため parse_easing が受理する綴りに揃える）。文字列形を直接守る。
    let input = r#"---
engine: name-name
chapter: 1
title: "文字演出"
---

## s1: emit

[文字演出: Title, 効果=爆発, easing=オーバーシュート]
"#;
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("effect=explode"),
        "emit should normalize 効果=爆発 to effect=explode, got:\n{emitted}"
    );
    assert!(
        emitted.contains("easing=ease-out-back"),
        "emit should normalize オーバーシュート to easing=ease-out-back, got:\n{emitted}"
    );
}

// ---- #271 [文字演出: 効果=タイプ] カーソル ----

#[test]
fn test_text_effect_cursor_japanese_keys() {
    // 日本語キー カーソル=on / 点滅 / カーソル色 をパースする。
    let input = r#"---
engine: name-name
chapter: 1
title: "カーソル"
---

## s1: cursor

[文字演出: Title, 効果=タイプ, 速度=70, カーソル=on, 点滅=600, カーソル色=#2b6cb0]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::TextEffect {
        target,
        effect,
        cursor,
        blink_ms,
        cursor_color,
        ..
    } = &events[0]
    {
        assert_eq!(target, "Title");
        assert_eq!(*effect, Some(TextEffectPreset::Typewriter));
        assert_eq!(*cursor, Some(true));
        assert_eq!(*blink_ms, Some(600));
        assert_eq!(cursor_color.as_deref(), Some("#2b6cb0"));
    } else {
        panic!("expected TextEffect, got {:?}", events[0]);
    }
}

#[test]
fn test_text_effect_cursor_english_keys_and_off() {
    // 英語キー cursor=off / blink / cursor_color を受理する。off は Some(false)。
    let input = r#"---
engine: name-name
chapter: 1
title: "カーソル"
---

## s1: cursor_en

[文字演出: target=Title, effect=typewriter, cursor=off, blink=400, cursor_color=#ffffff]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::TextEffect {
        cursor,
        blink_ms,
        cursor_color,
        ..
    } = &events[0]
    {
        assert_eq!(*cursor, Some(false));
        assert_eq!(*blink_ms, Some(400));
        assert_eq!(cursor_color.as_deref(), Some("#ffffff"));
    } else {
        panic!("expected TextEffect, got {:?}", events[0]);
    }
}

#[test]
fn test_text_effect_cursor_unset_when_not_specified() {
    // カーソル系を書かなければ全フィールド None（既存 directive と後方互換）。
    let input = r#"---
engine: name-name
chapter: 1
title: "カーソル"
---

## s1: no_cursor

[文字演出: Title, 効果=タイプ, 速度=70]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::TextEffect {
        cursor,
        blink_ms,
        cursor_color,
        ..
    } = &events[0]
    {
        assert_eq!(*cursor, None);
        assert_eq!(*blink_ms, None);
        assert_eq!(*cursor_color, None);
    } else {
        panic!("expected TextEffect, got {:?}", events[0]);
    }
}

#[test]
fn test_text_effect_cursor_roundtrip() {
    // parse → emit → parse でカーソル系が保たれる。emit は英語キー (cursor=on) に正規化。
    let input = r#"---
engine: name-name
chapter: 1
title: "カーソル"
---

## s1: roundtrip

[文字演出: Title, 効果=タイプ, 速度=70, カーソル=on, 点滅=600, カーソル色=#2b6cb0]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("cursor=on"),
        "emit should normalize カーソル=on to cursor=on, got:\n{emitted}"
    );
    let doc2 = parser::parse(&emitted);
    let events2 = &doc2.chapters[0].scenes[0].events;
    assert_eq!(events2.len(), 1);
    assert_eq!(events[0], events2[0]);
}

// ---- #270 [下線] 下線ビーム ----

#[test]
fn test_underline_bare_target_only() {
    // bare 先頭値 (Title) を target にする。色/太さ等は未指定 = None（既定値は TS 側）。
    let input = r#"---
engine: name-name
chapter: 1
title: "下線"
---

## s1: underline

[タイトル: orber]
[下線: Title]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 2);
    if let Event::Underline {
        target,
        color,
        thickness,
        duration_ms,
        offset,
        easing,
    } = &events[1]
    {
        assert_eq!(target, "Title");
        assert_eq!(*color, None);
        assert_eq!(*thickness, None);
        assert_eq!(*duration_ms, None);
        assert_eq!(*offset, None);
        assert_eq!(*easing, None);
    } else {
        panic!("expected Underline, got {:?}", events[1]);
    }
}

#[test]
fn test_underline_japanese_keys() {
    // 日本語キー 色/太さ/時間/余白 をパースする。
    let input = r#"---
engine: name-name
chapter: 1
title: "下線"
---

## s1: underline_ja

[下線: Title, 色=#1a4a7a, 太さ=3, 時間=700, 余白=8]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Underline {
        target,
        color,
        thickness,
        duration_ms,
        offset,
        ..
    } = &events[0]
    {
        assert_eq!(target, "Title");
        assert_eq!(color.as_deref(), Some("#1a4a7a"));
        assert_eq!(*thickness, Some(3));
        assert_eq!(*duration_ms, Some(700));
        assert_eq!(*offset, Some(8));
    } else {
        panic!("expected Underline, got {:?}", events[0]);
    }
}

#[test]
fn test_underline_english_alias_directive_and_keys() {
    // 英語ディレクティブ [underline:] と英語キー color/thickness/duration/offset/easing。
    let input = r#"---
engine: name-name
chapter: 1
title: "下線"
---

## s1: underline_en

[underline: target=Title, color=#222, thickness=5, duration=500, offset=10, easing=ease-out-back]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Underline {
        target,
        color,
        thickness,
        duration_ms,
        offset,
        easing,
    } = &events[0]
    {
        assert_eq!(target, "Title");
        assert_eq!(color.as_deref(), Some("#222"));
        assert_eq!(*thickness, Some(5));
        assert_eq!(*duration_ms, Some(500));
        assert_eq!(*offset, Some(10));
        assert_eq!(*easing, Some(Easing::EaseOutBack));
    } else {
        panic!("expected Underline, got {:?}", events[0]);
    }
}

#[test]
fn test_underline_missing_target_dropped() {
    // target 欠落時は directive を捨てる (Animate / TextEffect の作法に揃える)。
    let input = r#"---
engine: name-name
chapter: 1
title: "下線"
---

## s1: drop

[下線: 色=#1a4a7a, 太さ=3]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 0);
}

#[test]
fn test_underline_second_bare_value_ignored() {
    // bare 値は先頭のみ target。2 つ目以降の bare 値は silent skip。
    let input = r#"---
engine: name-name
chapter: 1
title: "下線"
---

## s1: bare

[下線: Title, Foo, 色=#1a4a7a]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::Underline { target, .. } => assert_eq!(target, "Title"),
        other => panic!("expected Underline, got {other:?}"),
    }
}

#[test]
fn test_underline_unknown_key_silently_skipped() {
    // 未知キーは無視し、既知キーだけ拾う。directive は壊れず残る。
    let input = r#"---
engine: name-name
chapter: 1
title: "下線"
---

## s1: unknown

[下線: Title, きらめき=999, 太さ=3]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::Underline {
            target, thickness, ..
        } => {
            assert_eq!(target, "Title");
            assert_eq!(*thickness, Some(3));
        }
        other => panic!("expected Underline, got {other:?}"),
    }
}

#[test]
fn test_underline_roundtrip() {
    // parse → emit → parse で同一になること。emit は英語キーに正規化する。
    let input = r#"---
engine: name-name
chapter: 1
title: "下線"
---

## s1: roundtrip

[下線: Title]
[下線: target=Title, 色=#1a4a7a, 太さ=3, 時間=700, 余白=8, easing=オーバーシュート]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 2);
    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("[下線: target=Title]"),
        "bare underline should emit target only, got:\n{emitted}"
    );
    assert!(
        emitted.contains("easing=ease-out-back"),
        "emit should normalize オーバーシュート to ease-out-back, got:\n{emitted}"
    );
    let doc2 = parser::parse(&emitted);
    let events2 = &doc2.chapters[0].scenes[0].events;
    assert_eq!(events2.len(), 2);
    assert_eq!(events[0], events2[0]);
    assert_eq!(events[1], events2[1]);
}

// ---- #144 per-line voice ----

#[test]
fn test_voice_injected_into_dialog() {
    let input = r#"---
engine: name-name
chapter: 1
title: "ボイステスト"
---

## s1: ボイス

[ボイス: voice/line01.mp3]
**カコ** (suppin_1, 左):
こんにちは。
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Dialog {
        voice_path, text, ..
    } = &events[0]
    {
        assert_eq!(voice_path.as_deref(), Some("voice/line01.mp3"));
        assert_eq!(text, &vec!["こんにちは。".to_string()]);
    } else {
        panic!("Expected Dialog, got {:?}", events[0]);
    }
}

#[test]
fn test_voice_injected_into_narration() {
    let input = r#"---
engine: name-name
chapter: 1
title: "ボイステスト"
---

## s1: ボイス

[ボイス: voice/narr01.mp3]
> 静かな朝だった。
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Narration {
        voice_path, text, ..
    } = &events[0]
    {
        assert_eq!(voice_path.as_deref(), Some("voice/narr01.mp3"));
        assert_eq!(text, &vec!["静かな朝だった。".to_string()]);
    } else {
        panic!("Expected Narration, got {:?}", events[0]);
    }
}

#[test]
fn test_voice_not_set_without_directive() {
    let input = r#"---
engine: name-name
chapter: 1
title: "ボイステスト"
---

## s1: ボイスなし

**カコ**:
おはよう。
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::Dialog { voice_path, .. } = &events[0] {
        assert!(voice_path.is_none());
    } else {
        panic!("Expected Dialog");
    }
}

#[test]
fn test_voice_roundtrip() {
    let input = r#"---
engine: name-name
chapter: 1
title: "ボイステスト"
---

## s1: ボイス

[ボイス: voice/line01.mp3]
**カコ**:
こんにちは。

[ボイス: voice/narr01.mp3]
> 静かな朝だった。
"#;
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    let events1 = &doc.chapters[0].scenes[0].events;
    let events2 = &doc2.chapters[0].scenes[0].events;
    assert_eq!(events1.len(), events2.len());
    // voice_path が roundtrip で保持されること
    if let Event::Dialog { voice_path, .. } = &events1[0] {
        assert_eq!(voice_path.as_deref(), Some("voice/line01.mp3"));
    }
    if let Event::Narration { voice_path, .. } = &events1[1] {
        assert_eq!(voice_path.as_deref(), Some("voice/narr01.mp3"));
    }
    assert_eq!(events1[0], events2[0]);
    assert_eq!(events1[1], events2[1]);
}

#[test]
fn test_voice_dropped_when_non_text_directive_intervenes() {
    // [ボイス:] の後に非テキストディレクティブが挟まると pending_voice_path はクリアされ、
    // その後の Dialog/Narration には voice が注入されないこと (#144)
    let input = "## s: テスト\n\n[ボイス: wrong.mp3]\n[背景: bg01.png]\n**カコ**:\nこんにちは。\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    // Background + Dialog の 2 イベント
    assert_eq!(events.len(), 2);
    if let Event::Dialog { voice_path, .. } = &events[1] {
        assert_eq!(
            *voice_path, None,
            "非テキストを越えて voice が注入されてはいけない"
        );
    } else {
        panic!("Expected Dialog, got {:?}", events[1]);
    }
}

#[test]
fn test_bgm_play_with_fade_in() {
    // [BGM: path, フェード=500] で fade-in 時間が parse される (#145)
    let input = "## s: テスト\n\n[BGM: bgm/main.ogg, フェード=500]\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0],
        Event::Bgm {
            path: Some("bgm/main.ogg".to_string()),
            action: BgmAction::Play,
            fade_ms: Some(500),
        }
    );
}

#[test]
fn test_bgm_play_with_fade_alias_ascii() {
    // 英語 alias `fade=N` も受理する (#145)
    let input = "## s: テスト\n\n[BGM: bgm/main.ogg, fade=750]\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(
        events[0],
        Event::Bgm {
            path: Some("bgm/main.ogg".to_string()),
            action: BgmAction::Play,
            fade_ms: Some(750),
        }
    );
}

#[test]
fn test_bgm_stop_bare_number() {
    // [BGM停止: 2000] — bare 数字を fade-out ms とみなす (#145)
    let input = "## s: テスト\n\n[BGM停止: 2000]\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0],
        Event::Bgm {
            path: None,
            action: BgmAction::Stop,
            fade_ms: Some(2000),
        }
    );
}

#[test]
fn test_bgm_stop_with_fade_kv() {
    // [BGM停止: フェード=2000] — 明示 kv (#145)
    let input = "## s: テスト\n\n[BGM停止: フェード=2000]\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(
        events[0],
        Event::Bgm {
            path: None,
            action: BgmAction::Stop,
            fade_ms: Some(2000),
        }
    );
}

#[test]
fn test_bgm_stop_no_args_keeps_default() {
    // [BGM停止] (引数なし) は fade_ms = None で後方互換 (#145)
    let input = "## s: テスト\n\n[BGM停止]\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(
        events[0],
        Event::Bgm {
            path: None,
            action: BgmAction::Stop,
            fade_ms: None,
        }
    );
}

#[test]
fn test_se_with_fade_in() {
    // [SE: path, フェード=200] で fade-in 時間が parse される (#145)
    let input = "## s: テスト\n\n[SE: se/door.ogg, フェード=200]\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0],
        Event::Se {
            path: "se/door.ogg".to_string(),
            fade_ms: Some(200),
        }
    );
}

#[test]
fn test_audio_fade_round_trip() {
    // emit → parse で fade_ms が保持される (#145)
    let input = r#"---
engine: name-name
chapter: 1
title: "fade"
---

## s: テスト

[BGM: bgm/main.ogg, フェード=500]
[SE: se/door.ogg, フェード=200]
[BGM停止: フェード=2000]
"#;
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 3);
    assert!(matches!(
        &events[0],
        Event::Bgm {
            fade_ms: Some(500),
            action: BgmAction::Play,
            ..
        }
    ));
    assert!(matches!(
        &events[1],
        Event::Se {
            fade_ms: Some(200),
            ..
        }
    ));
    assert!(matches!(
        &events[2],
        Event::Bgm {
            fade_ms: Some(2000),
            action: BgmAction::Stop,
            path: None,
        }
    ));
}

#[test]
fn test_audio_fade_invalid_values_silently_skipped() {
    // 不正な fade 値は silent skip され fade_ms: None のまま (#145)
    // - フェード=abc (parse 失敗)
    // - フェード= (空文字)
    // - 不明=100 (未知のキー)
    // - 前後空白の許容
    let input = r#"## s: テスト

[BGM: bgm/a.ogg, フェード=abc]
[BGM: bgm/b.ogg, フェード=]
[BGM: bgm/c.ogg, 不明=100]
[BGM: bgm/d.ogg,    フェード   =   500   ]
[BGM停止: -100]
[BGM停止:]
[SE: se/x.ogg, フェード=xyz]
"#;
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 7);
    // 1. フェード=abc → None
    assert!(matches!(&events[0], Event::Bgm { fade_ms: None, .. }));
    // 2. フェード= (空) → None
    assert!(matches!(&events[1], Event::Bgm { fade_ms: None, .. }));
    // 3. 未知のキー → None
    assert!(matches!(&events[2], Event::Bgm { fade_ms: None, .. }));
    // 4. 前後空白でも parse 成功
    assert!(matches!(
        &events[3],
        Event::Bgm {
            fade_ms: Some(500),
            ..
        }
    ));
    // 5. 負数 (u32 で弾かれる) → None で BGM停止 既定挙動
    assert!(matches!(
        &events[4],
        Event::Bgm {
            action: BgmAction::Stop,
            fade_ms: None,
            ..
        }
    ));
    // 6. 引数空 → None
    assert!(matches!(
        &events[5],
        Event::Bgm {
            action: BgmAction::Stop,
            fade_ms: None,
            ..
        }
    ));
    // 7. SE 不正値 → None
    assert!(matches!(&events[6], Event::Se { fade_ms: None, .. }));
}

#[test]
fn test_bgm_play_bare_number_is_not_fade() {
    // Play 系では path との曖昧さを避けるため bare 数字を fade_ms として受理しない (#145)
    // `[BGM: x.ogg, 500]` の "500" は kv ではないので silent skip され fade_ms: None
    let input = "## s: テスト\n\n[BGM: bgm/a.ogg, 500]\n[SE: se/x.ogg, 300]\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 2);
    assert!(matches!(&events[0], Event::Bgm { fade_ms: None, .. }));
    assert!(matches!(&events[1], Event::Se { fade_ms: None, .. }));
}

#[test]
fn test_document_choice_style_parses_from_frontmatter() {
    // frontmatter `choice_style: soft` が Some("soft") で parse されること (#146)
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
choice_style: soft
---

## 1-1: シーン

ナレーションです。
"#;
    let doc = parser::parse(input);
    assert_eq!(
        doc.choice_style.as_deref(),
        Some("soft"),
        "frontmatter の choice_style が parse されること"
    );

    // 引用符付きでも同じく読めること
    let input_quoted = r#"---
engine: name-name
chapter: 1
title: "テスト"
choice_style: "monochrome"
---

## 1-1: シーン

ナレーションです。
"#;
    let doc_quoted = parser::parse(input_quoted);
    assert_eq!(doc_quoted.choice_style.as_deref(), Some("monochrome"));

    // 未指定なら None
    let input_none = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレーションです。
"#;
    let doc_none = parser::parse(input_none);
    assert_eq!(doc_none.choice_style, None);
}

#[test]
fn test_document_choice_style_round_trip() {
    // parse → emit → parse で choice_style が保持されること (#146)
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
choice_style: soft
---

## 1-1: シーン

ナレーションです。
"#;
    let doc1 = parser::parse(input);
    let emitted = emitter::emit(&doc1);
    assert!(
        emitted.contains("choice_style:"),
        "emit 出力に choice_style が含まれること: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc1.choice_style, doc2.choice_style);
    assert_eq!(doc2.choice_style.as_deref(), Some("soft"));

    // None の場合は emit に出ないこと
    let mut doc_none = doc1.clone();
    doc_none.choice_style = None;
    let emitted_none = emitter::emit(&doc_none);
    assert!(
        !emitted_none.contains("choice_style:"),
        "choice_style が None なら emit に含まれないこと: {emitted_none}"
    );
}

#[test]
fn test_document_choice_style_edge_cases() {
    // 空文字 → None (#146 R1 N3)
    let input_empty = r#"---
engine: name-name
chapter: 1
title: "テスト"
choice_style:
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input_empty);
    assert_eq!(
        doc.choice_style, None,
        "choice_style が空なら None として parse される"
    );

    // 未知値 → Some("foo") で透過（runtime 側でフォールバック判定する設計）
    let input_unknown = r#"---
engine: name-name
chapter: 1
title: "テスト"
choice_style: foo
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input_unknown);
    assert_eq!(
        doc.choice_style.as_deref(),
        Some("foo"),
        "未知値も生文字列で透過する（runtime 側で default フォールバック）"
    );

    // クォート付き + 前後空白
    let input_quoted = r#"---
engine: name-name
chapter: 1
title: "テスト"
choice_style:   "monochrome"
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input_quoted);
    assert_eq!(
        doc.choice_style.as_deref(),
        Some("monochrome"),
        "前後空白とクォートを剥がして parse される"
    );
}

// --- #283: dialog_style (adv / novel の対等 2 択) ---

#[test]
fn test_document_dialog_style_parses_from_frontmatter() {
    // frontmatter `dialog_style: novel` が Some("novel") で parse されること (#283)
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
dialog_style: novel
---

## 1-1: シーン

ナレーションです。
"#;
    let doc = parser::parse(input);
    assert_eq!(
        doc.dialog_style.as_deref(),
        Some("novel"),
        "frontmatter の dialog_style が parse されること"
    );

    // 未指定なら None（runtime で adv フォールバック）
    let input_none = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc_none = parser::parse(input_none);
    assert_eq!(doc_none.dialog_style, None);
}

#[test]
fn test_document_dialog_style_round_trip() {
    // parse → emit → parse で dialog_style が保持されること (#283)
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
dialog_style: novel
---

## 1-1: シーン

ナレーションです。
"#;
    let doc1 = parser::parse(input);
    let emitted = emitter::emit(&doc1);
    assert!(
        emitted.contains("dialog_style:"),
        "emit 出力に dialog_style が含まれること: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc1.dialog_style, doc2.dialog_style);
    assert_eq!(doc2.dialog_style.as_deref(), Some("novel"));

    // None なら emit に出ないこと（adv / novel に「正規デフォルト」が無いので Some のときだけ出す）
    let mut doc_none = doc1.clone();
    doc_none.dialog_style = None;
    let emitted_none = emitter::emit(&doc_none);
    assert!(
        !emitted_none.contains("dialog_style:"),
        "dialog_style が None なら emit に含まれないこと: {emitted_none}"
    );
}

#[test]
fn test_document_dialog_style_edge_cases() {
    // 空文字 → None（choice_style と同じ規約）
    let input_empty = r#"---
engine: name-name
chapter: 1
title: "テスト"
dialog_style:
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input_empty);
    assert_eq!(
        doc.dialog_style, None,
        "dialog_style が空なら None として parse される"
    );

    // adv も生文字列で透過すること（adv / novel は対等）
    let input_adv = r#"---
engine: name-name
chapter: 1
title: "テスト"
dialog_style: "adv"
---

## 1-1: シーン

ナレ。
"#;
    let doc_adv = parser::parse(input_adv);
    assert_eq!(
        doc_adv.dialog_style.as_deref(),
        Some("adv"),
        "adv も明示指定はクォートを剥がして透過する"
    );
}

// #283 設計32: 未知値の透過
#[test]
fn test_document_dialog_style_unknown_value_passes_through() {
    // 未知値（adv / novel 以外）も parser はバリデーションせず生文字列で透過する
    // （choice_style と同じ流儀。runtime 側で未知値を adv にフォールバックする）。
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
dialog_style: toheart
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(
        doc.dialog_style.as_deref(),
        Some("toheart"),
        "parser は未知の dialog_style 値もバリデーションせず Some(生文字列) で透過する"
    );
}

// #283 設計33: adv 明示の round-trip で emit に出る
#[test]
fn test_document_dialog_style_adv_round_trip_emits_explicitly() {
    // adv を明示指定 → emit に `dialog_style: "adv"` が出る（None だけが省略され、
    // 明示 adv は黙殺されない）。round-trip で adv 指定が保持される。
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
dialog_style: "adv"
---

## 1-1: シーン

ナレ。
"#;
    let doc1 = parser::parse(input);
    let emitted = emitter::emit(&doc1);
    assert!(
        emitted.contains("dialog_style: \"adv\""),
        "adv 明示指定は emit に dialog_style: \"adv\" として出ること: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc2.dialog_style.as_deref(), Some("adv"));
}

// --- #286: protagonist (novel スタイルの左右配置に使う質問役の話者名) ---

#[test]
fn test_document_protagonist_parses_from_frontmatter() {
    // frontmatter `protagonist: せお` が Some("せお") で parse されること (#286)
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
dialog_style: novel
protagonist: せお
---

## 1-1: シーン

ナレーションです。
"#;
    let doc = parser::parse(input);
    assert_eq!(
        doc.protagonist.as_deref(),
        Some("せお"),
        "frontmatter の protagonist が parse されること"
    );
    // 他 frontmatter（dialog_style）と共存できること
    assert_eq!(doc.dialog_style.as_deref(), Some("novel"));

    // 未指定なら None（従来配置 = 後方互換）
    let input_none = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc_none = parser::parse(input_none);
    assert_eq!(doc_none.protagonist, None);
}

#[test]
fn test_document_protagonist_round_trip() {
    // parse → emit → parse で protagonist が保持されること (#286)
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
dialog_style: novel
protagonist: せお
---

## 1-1: シーン

ナレーションです。
"#;
    let doc1 = parser::parse(input);
    let emitted = emitter::emit(&doc1);
    assert!(
        emitted.contains("protagonist:"),
        "emit 出力に protagonist が含まれること: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc1.protagonist, doc2.protagonist);
    assert_eq!(doc2.protagonist.as_deref(), Some("せお"));
    // dialog_style と共存して round-trip で両方残ること
    assert_eq!(doc2.dialog_style.as_deref(), Some("novel"));

    // None なら emit に出ないこと（dialog_style と同じ Some のときだけ出す流儀）
    let mut doc_none = doc1.clone();
    doc_none.protagonist = None;
    let emitted_none = emitter::emit(&doc_none);
    assert!(
        !emitted_none.contains("protagonist:"),
        "protagonist が None なら emit に含まれないこと: {emitted_none}"
    );
}

#[test]
fn test_document_protagonist_empty_is_none() {
    // 空文字 → None（choice_style / dialog_style と同じ規約）
    let input_empty = r#"---
engine: name-name
chapter: 1
title: "テスト"
protagonist:
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input_empty);
    assert_eq!(
        doc.protagonist, None,
        "protagonist が空なら None として parse される"
    );
}

#[test]
fn test_voice_overwritten_by_later_directive() {
    // [ボイス:] が連続した場合、後者で前者を上書きし最後のものが注入されること (#144)
    let input =
        "## s: テスト\n\n[ボイス: first.mp3]\n[ボイス: second.mp3]\n**カコ**:\nこんにちは。\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Dialog { voice_path, .. } = &events[0] {
        assert_eq!(
            voice_path.as_deref(),
            Some("second.mp3"),
            "後から指定した voice が優先されること"
        );
    } else {
        panic!("Expected Dialog, got {:?}", events[0]);
    }
}

// --- #147: フォント切替 (per-game / per-line) ---

#[test]
fn test_document_font_family_parses_from_frontmatter() {
    // frontmatter `font_family:` が Some(...) で parse されること (#147)
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
font_family: "Klee One, cursive"
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(
        doc.font_family.as_deref(),
        Some("Klee One, cursive"),
        "frontmatter の font_family が parse されること"
    );

    // 引用符なしでも読めること（カンマ・空白を含む値もそのまま透過）
    let input_unquoted = r#"---
engine: name-name
chapter: 1
title: "テスト"
font_family: Hina Mincho, serif
---

## 1-1: シーン

ナレ。
"#;
    let doc_unquoted = parser::parse(input_unquoted);
    assert_eq!(
        doc_unquoted.font_family.as_deref(),
        Some("Hina Mincho, serif")
    );

    // 未指定なら None
    let input_none = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc_none = parser::parse(input_none);
    assert_eq!(doc_none.font_family, None);

    // 空文字なら None（choice_style と同じ規約）
    let input_empty = r#"---
engine: name-name
chapter: 1
title: "テスト"
font_family:
---

## 1-1: シーン

ナレ。
"#;
    let doc_empty = parser::parse(input_empty);
    assert_eq!(doc_empty.font_family, None);
}

#[test]
fn test_dialog_font_directive_inject_pending() {
    // [フォント: family] が次の Dialog/Narration の font_family に注入されること (#147)
    let dialog_input = "## s: テスト\n\n[フォント: Klee One, cursive]\n**カコ**:\nこんにちは。\n";
    let doc = parser::parse(dialog_input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Dialog {
        font_family, text, ..
    } = &events[0]
    {
        assert_eq!(font_family.as_deref(), Some("Klee One, cursive"));
        assert_eq!(text, &vec!["こんにちは。".to_string()]);
    } else {
        panic!("Expected Dialog, got {:?}", events[0]);
    }

    // Narration にも注入されること
    let narration_input = "## s: テスト\n\n[フォント: Hina Mincho, serif]\n> 静かな朝。\n";
    let doc = parser::parse(narration_input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Narration { font_family, .. } = &events[0] {
        assert_eq!(font_family.as_deref(), Some("Hina Mincho, serif"));
    } else {
        panic!("Expected Narration, got {:?}", events[0]);
    }

    // [フォント:] なしの場合は None
    let bare_input = "## s: テスト\n\n**カコ**:\nふつう。\n";
    let doc = parser::parse(bare_input);
    let events = &doc.chapters[0].scenes[0].events;
    if let Event::Dialog { font_family, .. } = &events[0] {
        assert!(font_family.is_none(), "directive なしなら None");
    } else {
        panic!("Expected Dialog");
    }
}

#[test]
fn test_dialog_font_round_trip() {
    // parse → emit → parse で font_family（per-game / per-line）が両方保持されること (#147)
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
font_family: "Klee One, cursive"
---

## 1-1: シーン

[フォント: Hina Mincho, serif]
**カコ**:
こんにちは。

[フォント: Yusei Magic, sans-serif]
> 静かな朝だった。
"#;
    let doc1 = parser::parse(input);
    let emitted = emitter::emit(&doc1);
    assert!(
        emitted.contains("font_family:"),
        "emit 出力に font_family が含まれること: {emitted}"
    );
    assert!(
        emitted.contains("[フォント: Hina Mincho, serif]"),
        "per-line [フォント:] が emit されること: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc1, doc2, "round-trip で完全一致すること");
    assert_eq!(doc2.font_family.as_deref(), Some("Klee One, cursive"));

    // None の場合は emit に出ないこと
    let mut doc_none = doc1.clone();
    doc_none.font_family = None;
    let emitted_none = emitter::emit(&doc_none);
    assert!(
        !emitted_none.contains("font_family:"),
        "font_family が None なら emit に含まれないこと: {emitted_none}"
    );
}

#[test]
fn test_font_directive_is_overwritten_by_later() {
    // [フォント:] が連続した場合、後者で前者を上書きし最後のものが注入されること (#147)
    let input =
        "## s: テスト\n\n[フォント: First, sans-serif]\n[フォント: Second, serif]\n**カコ**:\nこんにちは。\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Dialog { font_family, .. } = &events[0] {
        assert_eq!(
            font_family.as_deref(),
            Some("Second, serif"),
            "後から指定した font が優先されること"
        );
    } else {
        panic!("Expected Dialog, got {:?}", events[0]);
    }
}

#[test]
fn test_font_dropped_when_non_text_directive_intervenes() {
    // [フォント:] の後に非テキストディレクティブが挟まると pending_font_family はクリアされ、
    // その後の Dialog/Narration には font が注入されないこと (#147 voice と同じ動作)
    let input = "## s: テスト\n\n[フォント: wrong, sans-serif]\n[背景: bg01.png]\n**カコ**:\nこんにちは。\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 2); // Background + Dialog
    if let Event::Dialog { font_family, .. } = &events[1] {
        assert!(
            font_family.is_none(),
            "非テキストを越えて font が注入されてはいけない"
        );
    } else {
        panic!("Expected Dialog, got {:?}", events[1]);
    }
}

#[test]
fn test_font_release_clears_pending() {
    // [フォント解除] で pending がクリアされ、次の Dialog は base に戻ること (#147)
    let input =
        "## s: テスト\n\n[フォント: Klee One, cursive]\n[フォント解除]\n**カコ**:\nこんにちは。\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Dialog { font_family, .. } = &events[0] {
        assert!(
            font_family.is_none(),
            "[フォント解除] の後の Dialog には font が注入されないこと"
        );
    } else {
        panic!("Expected Dialog, got {:?}", events[0]);
    }
}

#[test]
fn test_font_directive_empty_value_is_ignored() {
    // [フォント:   ] のように空白のみの値は pending に空文字を残さない (#147 R1 M2)。
    // 直後の Dialog は font_family: None のままで base に戻る。
    let input = "## s: テスト\n\n[フォント:   ]\n**カコ**:\nこんにちは。\n";
    let doc = parser::parse(input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 1);
    if let Event::Dialog { font_family, .. } = &events[0] {
        assert!(
            font_family.is_none(),
            "空 [フォント:] は pending に空文字を残さず、Dialog の font_family は None"
        );
    } else {
        panic!("Expected Dialog, got {:?}", events[0]);
    }
}

#[test]
fn test_font_family_emit_strips_inner_quotes_to_protect_round_trip() {
    // family 名に `"` が含まれた場合、emit 時に取り除いて round-trip で壊れないようにする (#147 R1 N2)。
    // 実用上は `"` を含む font-family 名は存在しないため影響なし。
    let mut doc = Document {
        engine: "name-name".to_string(),
        aspect_ratio: "16:9".to_string(),
        choice_style: None,
        font_family: Some(r#"My "Quoted" Font, sans-serif"#.to_string()),
        font_size: None,
        dialog_style: None,
        protagonist: None,
        character_y_ratio: None,
        character_fade_ms: None,
        skip_enabled: None,
        debug_enabled: None,
        chapters: vec![Chapter {
            number: 1,
            title: "tmp".to_string(),
            hidden: false,
            default_bgm: None,
            scenes: vec![Scene {
                id: "s".to_string(),
                title: "テスト".to_string(),
                view: SceneView::default(),
                events: vec![],
            }],
        }],
    };
    let emitted = emitter::emit(&doc);
    assert!(
        !emitted.contains("\\\""),
        "emit には backslash escape を出さない: {emitted}"
    );
    let doc2 = parser::parse(&emitted);
    // sanitized 後の family と一致
    assert_eq!(
        doc2.font_family.as_deref(),
        Some("My Quoted Font, sans-serif")
    );

    // 反対側もチェック: None なら emit に含まれないこと
    doc.font_family = None;
    let emitted_none = emitter::emit(&doc);
    assert!(
        !emitted_none.contains("font_family:"),
        "font_family が None なら emit に出ない"
    );
}

#[test]
fn test_document_font_size_parses_from_frontmatter() {
    // frontmatter `font_size:` が Some(u32) で parse されること (#283 補遺)。
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
font_size: 26
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(
        doc.font_size,
        Some(26),
        "frontmatter の font_size が数値で parse されること"
    );

    // 未指定なら None（runtime 既定 40 にフォールバック）
    let input_none = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc_none = parser::parse(input_none);
    assert_eq!(doc_none.font_size, None);

    // 空文字なら None（font_family と同じ規約）
    let input_empty = r#"---
engine: name-name
chapter: 1
title: "テスト"
font_size:
---

## 1-1: シーン

ナレ。
"#;
    let doc_empty = parser::parse(input_empty);
    assert_eq!(doc_empty.font_size, None);

    // 非数値なら None（parse 失敗を握りつぶす）
    let input_bad = r#"---
engine: name-name
chapter: 1
title: "テスト"
font_size: large
---

## 1-1: シーン

ナレ。
"#;
    let doc_bad = parser::parse(input_bad);
    assert_eq!(doc_bad.font_size, None);

    // 空引用（`font_size: ""`）でも None（#286 follow-up nit / PR #289 独立レビュー）。
    // unquote("\"\"") は空文字を返し、空文字の parse::<u32>() が失敗して None に倒れる。
    // バレ empty（`font_size:`）とは別経路（quote 剥がし後に空になる）なので明示的に固定する。
    let input_empty_quote = r#"---
engine: name-name
chapter: 1
title: "テスト"
font_size: ""
---

## 1-1: シーン

ナレ。
"#;
    let doc_empty_quote = parser::parse(input_empty_quote);
    assert_eq!(
        doc_empty_quote.font_size, None,
        "font_size: \"\" は unquote 後に空文字となり parse 失敗で None になること"
    );

    // None なら emit に font_size 行が出ないこと（既存規約の再確認 / 空引用入力の往復）。
    let emitted_empty_quote = emitter::emit(&doc_empty_quote);
    assert!(
        !emitted_empty_quote.contains("font_size:"),
        "font_size が None なら emit に出ない（空引用入力でも）: {emitted_empty_quote}"
    );
}

#[test]
fn test_font_size_round_trip_with_other_frontmatter() {
    // parse → emit → parse で font_size が保持され、他フィールドと共存すること (#283 補遺)。
    let input = r#"---
engine: name-name
aspect_ratio: "9:16"
font_family: "Hina Mincho, serif"
font_size: 26
dialog_style: "novel"
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.font_size, Some(26));

    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("font_size: 26"),
        "emit 出力に font_size が含まれること（quote なしの数値）: {emitted}"
    );

    let doc2 = parser::parse(&emitted);
    assert_eq!(
        doc2.font_size,
        Some(26),
        "round-trip で font_size が保持される"
    );
    // 共存フィールドも壊れていないこと
    assert_eq!(doc2.aspect_ratio, "9:16");
    assert_eq!(doc2.font_family.as_deref(), Some("Hina Mincho, serif"));
    assert_eq!(doc2.dialog_style.as_deref(), Some("novel"));

    // None なら emit に含まれないこと
    let mut doc_none = doc;
    doc_none.font_size = None;
    let emitted_none = emitter::emit(&doc_none);
    assert!(
        !emitted_none.contains("font_size:"),
        "font_size が None なら emit に出ない: {emitted_none}"
    );
}

#[test]
fn test_document_character_y_ratio_parses_from_frontmatter() {
    // frontmatter `character_y_ratio:` が Some(f64) で parse されること (#308)。
    // 値は parser では生のまま透過し、範囲クランプは runtime（CharacterLayer）で行う。

    // R-1: 正常な数値は Some(1.05)。
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
character_y_ratio: 1.05
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(
        doc.character_y_ratio,
        Some(1.05),
        "frontmatter の character_y_ratio が数値で parse されること"
    );

    // R-2: 未指定なら None（runtime 既定 1.0 にフォールバック）。
    let input_none = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc_none = parser::parse(input_none);
    assert_eq!(doc_none.character_y_ratio, None);

    // R-3: 空文字（`character_y_ratio:`）なら None（font_size と同じ規約）。
    let input_empty = r#"---
engine: name-name
chapter: 1
title: "テスト"
character_y_ratio:
---

## 1-1: シーン

ナレ。
"#;
    let doc_empty = parser::parse(input_empty);
    assert_eq!(doc_empty.character_y_ratio, None);

    // R-4: 空引用（`character_y_ratio: ""`）でも None（unquote 後に空で parse 失敗）。
    let input_empty_quote = r#"---
engine: name-name
chapter: 1
title: "テスト"
character_y_ratio: ""
---

## 1-1: シーン

ナレ。
"#;
    let doc_empty_quote = parser::parse(input_empty_quote);
    assert_eq!(
        doc_empty_quote.character_y_ratio, None,
        "character_y_ratio: \"\" は unquote 後に空文字となり parse 失敗で None になること"
    );

    // R-5: 非数値（`character_y_ratio: tall`）なら None（parse 失敗を握りつぶす）。
    let input_bad = r#"---
engine: name-name
chapter: 1
title: "テスト"
character_y_ratio: tall
---

## 1-1: シーン

ナレ。
"#;
    let doc_bad = parser::parse(input_bad);
    assert_eq!(doc_bad.character_y_ratio, None);
}

#[test]
fn test_character_y_ratio_round_trip_with_other_frontmatter() {
    // R-6: parse → emit → parse で character_y_ratio が保持され、他フィールドと共存すること (#308)。
    let input = r#"---
engine: name-name
aspect_ratio: "9:16"
font_family: "Hina Mincho, serif"
font_size: 26
dialog_style: "novel"
character_y_ratio: 1.05
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.character_y_ratio, Some(1.05));

    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("character_y_ratio: 1.05"),
        "emit 出力に character_y_ratio が含まれること（quote なしの数値）: {emitted}"
    );

    let doc2 = parser::parse(&emitted);
    assert_eq!(
        doc2.character_y_ratio,
        Some(1.05),
        "round-trip で character_y_ratio が保持される"
    );
    // 共存フィールドも壊れていないこと。
    assert_eq!(doc2.aspect_ratio, "9:16");
    assert_eq!(doc2.font_family.as_deref(), Some("Hina Mincho, serif"));
    assert_eq!(doc2.font_size, Some(26));
    assert_eq!(doc2.dialog_style.as_deref(), Some("novel"));
}

#[test]
fn test_character_y_ratio_integer_round_trips_as_float() {
    // R-7: 整数値 `1` は Some(1.0) で parse され、emit → 再 parse でも Some(1.0) を保つこと (#308)。
    //   Rust の f64 Display は 1.0 → "1" なので emit 行は `character_y_ratio: 1` になり、
    //   再 parse で "1".parse::<f64>() = Some(1.0) に戻る（整数表記でも比率は f64 として一貫する）。
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
character_y_ratio: 1
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.character_y_ratio, Some(1.0));

    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(
        doc2.character_y_ratio,
        Some(1.0),
        "整数 1 は round-trip で Some(1.0) を保つ"
    );
}

#[test]
fn test_character_y_ratio_none_omits_emit_line() {
    // R-8: character_y_ratio が None なら emit に `character_y_ratio:` 行が出ないこと (#308)。
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.character_y_ratio, None);

    let emitted = emitter::emit(&doc);
    assert!(
        !emitted.contains("character_y_ratio:"),
        "character_y_ratio が None なら emit に出ない: {emitted}"
    );
}

#[test]
fn test_character_y_ratio_passes_through_special_values_without_clamping() {
    // R-9: 責務分界 (#308)。parser は範囲クランプ・非有限の neutralize を一切しない。
    //   `nan` → Some(NaN)（is_nan）/ `inf` → Some(inf)（is_infinite）/ `-0.5` → Some(-0.5)。
    //   安全側フォールバック（NaN/Inf → 1.0、範囲外 → [0,2] クランプ）は runtime（CharacterLayer）の
    //   責務。parser がここで丸めると一元所有が崩れるため、生の数値を透過する設計を固定する。

    // nan → Some(NaN)。
    let input_nan = r#"---
engine: name-name
chapter: 1
title: "テスト"
character_y_ratio: nan
---

## 1-1: シーン

ナレ。
"#;
    let doc_nan = parser::parse(input_nan);
    let v_nan = doc_nan
        .character_y_ratio
        .expect("nan は Some(NaN) で parse される（parser はクランプしない）");
    assert!(v_nan.is_nan(), "character_y_ratio: nan は NaN を透過する");

    // inf → Some(inf)。
    let input_inf = r#"---
engine: name-name
chapter: 1
title: "テスト"
character_y_ratio: inf
---

## 1-1: シーン

ナレ。
"#;
    let doc_inf = parser::parse(input_inf);
    let v_inf = doc_inf
        .character_y_ratio
        .expect("inf は Some(inf) で parse される（parser はクランプしない）");
    assert!(
        v_inf.is_infinite(),
        "character_y_ratio: inf は Infinity を透過する"
    );

    // -0.5 → Some(-0.5)（範囲外でも parser は透過する）。
    let input_neg = r#"---
engine: name-name
chapter: 1
title: "テスト"
character_y_ratio: -0.5
---

## 1-1: シーン

ナレ。
"#;
    let doc_neg = parser::parse(input_neg);
    assert_eq!(
        doc_neg.character_y_ratio,
        Some(-0.5),
        "character_y_ratio: -0.5 は範囲外でも parser がクランプせず透過する"
    );
}

// --- #310: skip_enabled / debug_enabled (再生 UI ボタンの per-game 出し分け) ---
//
// frontmatter `skip_enabled:` / `debug_enabled:` を Option<bool> で透過する。
// `parse_bool_kv` 再利用で `true`/`false`（大文字小文字無視）のみ受理し、空・不正値・
// coerce 系（yes/1/on）は None（runtime 既定: skip=true / debug=false にフォールバック）。
// parser は private な parse_bool_kv を直接公開しないため、parse() 経由で doc フィールドを縛る。

/// `skip_enabled: <value>` だけを frontmatter に持つ最小ドキュメントを組み立てる。
fn skip_enabled_doc(value: &str) -> String {
    format!(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\nskip_enabled:{value}\n---\n\n## 1-1: シーン\n\nナレ。\n"
    )
}

#[test]
fn test_document_skip_enabled_parses_true_false() {
    // DT3-1: `true` → Some(true) / `false` → Some(false)（厳格な真偽の素直な往復）。
    let doc_true = parser::parse(&skip_enabled_doc(" true"));
    assert_eq!(
        doc_true.skip_enabled,
        Some(true),
        "skip_enabled: true は Some(true)"
    );

    let doc_false = parser::parse(&skip_enabled_doc(" false"));
    assert_eq!(
        doc_false.skip_enabled,
        Some(false),
        "skip_enabled: false は Some(false)"
    );
}

#[test]
fn test_document_skip_enabled_is_case_insensitive() {
    // DT3-2: `TRUE` / `False` → 大文字小文字を無視して Some に倒す（parse_bool_kv の to_ascii_lowercase）。
    let doc_upper = parser::parse(&skip_enabled_doc(" TRUE"));
    assert_eq!(
        doc_upper.skip_enabled,
        Some(true),
        "skip_enabled: TRUE は大文字無視で Some(true)"
    );

    let doc_mixed = parser::parse(&skip_enabled_doc(" False"));
    assert_eq!(
        doc_mixed.skip_enabled,
        Some(false),
        "skip_enabled: False は大文字小文字無視で Some(false)"
    );
}

#[test]
fn test_document_skip_enabled_unspecified_is_none() {
    // DT3-3: frontmatter にキーが無ければ None（runtime 既定 true=出すにフォールバック）。
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(
        doc.skip_enabled, None,
        "skip_enabled 未指定は None（既定 true にフォールバック）"
    );
}

#[test]
fn test_document_skip_enabled_empty_is_none() {
    // DT3-4: 空 `skip_enabled:`（値なし）・空引用 `""` はどちらも None
    //   （parse_bool_kv が trim 後の空文字を弾く。character_y_ratio の空文字規約と同じ向き）。
    let doc_empty = parser::parse(&skip_enabled_doc(""));
    assert_eq!(doc_empty.skip_enabled, None, "空 skip_enabled: は None");

    let doc_empty_quote = parser::parse(&skip_enabled_doc(" \"\""));
    assert_eq!(
        doc_empty_quote.skip_enabled, None,
        "skip_enabled: \"\" は unquote 後に空文字となり None"
    );
}

#[test]
fn test_document_skip_enabled_does_not_coerce_truthy_values() {
    // DT3-5（重要）: `yes` / `1` / `on` は coerce せず None に倒す（厳格＝true/false 以外は無効）。
    //   YAML 緩い真偽（yes/on/1）を受けると frontmatter の意味が曖昧になるため、parse_bool_kv は
    //   `true`/`false` だけを真偽として扱い、それ以外は「未指定」と同じ None にする。
    for truthy in ["yes", "1", "on"] {
        let doc = parser::parse(&skip_enabled_doc(&format!(" {truthy}")));
        assert_eq!(
            doc.skip_enabled, None,
            "skip_enabled: {truthy} は coerce されず None（厳格）"
        );
    }
}

#[test]
fn test_document_skip_enabled_garbage_is_none() {
    // DT3-6: 完全に無関係なゴミ文字列も None（parse 失敗を握りつぶす）。
    let doc = parser::parse(&skip_enabled_doc(" maybe-later"));
    assert_eq!(
        doc.skip_enabled, None,
        "skip_enabled: maybe-later（garbage）は None"
    );
}

#[test]
fn test_document_debug_enabled_parses_true_false() {
    // DT3-debug: debug_enabled も skip_enabled と同型（parse_bool_kv 共有）。最低 1 本で
    //   `true`→Some(true) / `false`→Some(false) / 未指定→None / 緩い真偽 `1`→None を縛る。
    let make = |value: &str| {
        format!(
            "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\ndebug_enabled:{value}\n---\n\n## 1-1: シーン\n\nナレ。\n"
        )
    };

    let doc_true = parser::parse(&make(" true"));
    assert_eq!(
        doc_true.debug_enabled,
        Some(true),
        "debug_enabled: true は Some(true)"
    );

    let doc_false = parser::parse(&make(" false"));
    assert_eq!(
        doc_false.debug_enabled,
        Some(false),
        "debug_enabled: false は Some(false)"
    );

    // 未指定は None（runtime 既定 false=出さないにフォールバック）。
    let input_none = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    assert_eq!(
        parser::parse(input_none).debug_enabled,
        None,
        "debug_enabled 未指定は None（既定 false にフォールバック）"
    );

    // `1`（緩い真偽）は coerce されず None。
    assert_eq!(
        parser::parse(&make(" 1")).debug_enabled,
        None,
        "debug_enabled: 1 は coerce されず None（厳格）"
    );
}

#[test]
fn test_skip_enabled_false_round_trips() {
    // E1: skip_enabled: false → emit に `skip_enabled: false` を含み、再 parse で Some(false)。
    //   E5 も兼ねる: falsy（false）でも Some なら emit から消えないこと（skip_serializing は None だけ）。
    let doc = parser::parse(&skip_enabled_doc(" false"));
    assert_eq!(doc.skip_enabled, Some(false));

    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("skip_enabled: false"),
        "emit に `skip_enabled: false` が含まれること（false を落とさない）: {emitted}"
    );

    let doc2 = parser::parse(&emitted);
    assert_eq!(
        doc2.skip_enabled,
        Some(false),
        "round-trip で skip_enabled: false が保持される"
    );
}

#[test]
fn test_debug_enabled_true_round_trips() {
    // E2: debug_enabled: true → emit に `debug_enabled: true` を含み、再 parse で Some(true)。
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
debug_enabled: true
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.debug_enabled, Some(true));

    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("debug_enabled: true"),
        "emit に `debug_enabled: true` が含まれること: {emitted}"
    );

    let doc2 = parser::parse(&emitted);
    assert_eq!(
        doc2.debug_enabled,
        Some(true),
        "round-trip で debug_enabled: true が保持される"
    );
}

#[test]
fn test_skip_and_debug_enabled_none_omit_emit_lines() {
    // E3: 両方 None なら emit にどちらのキーも出ない（skip_serializing_if = Option::is_none）。
    let input = r#"---
engine: name-name
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.skip_enabled, None);
    assert_eq!(doc.debug_enabled, None);

    let emitted = emitter::emit(&doc);
    assert!(
        !emitted.contains("skip_enabled:"),
        "skip_enabled が None なら emit に出ない: {emitted}"
    );
    assert!(
        !emitted.contains("debug_enabled:"),
        "debug_enabled が None なら emit に出ない: {emitted}"
    );
}

#[test]
fn test_skip_debug_enabled_round_trip_with_other_frontmatter() {
    // E4: skip_enabled / debug_enabled / character_y_ratio / dialog_style / aspect_ratio を
    //   1 ドキュメントに同居させ、parse → emit → parse で全フィールドが保持されること。
    let input = r#"---
engine: name-name
aspect_ratio: "9:16"
dialog_style: "novel"
character_y_ratio: 1.05
character_fade_ms: 700
skip_enabled: false
debug_enabled: true
chapter: 1
title: "テスト"
---

## 1-1: シーン

ナレ。
"#;
    let doc = parser::parse(input);
    assert_eq!(doc.skip_enabled, Some(false));
    assert_eq!(doc.debug_enabled, Some(true));
    assert_eq!(doc.character_fade_ms, Some(700));

    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);

    // 真偽 2 フィールドが保持される。
    assert_eq!(
        doc2.skip_enabled,
        Some(false),
        "skip_enabled が round-trip で保持される"
    );
    assert_eq!(
        doc2.debug_enabled,
        Some(true),
        "debug_enabled が round-trip で保持される"
    );
    // 共存フィールドも壊れていないこと。
    assert_eq!(doc2.aspect_ratio, "9:16");
    assert_eq!(doc2.dialog_style.as_deref(), Some("novel"));
    assert_eq!(doc2.character_y_ratio, Some(1.05));
    assert_eq!(doc2.character_fade_ms, Some(700));
    // ドキュメント全体が安定（parse → emit → parse が冪等）。
    assert_eq!(doc, doc2, "全 frontmatter 共存の round-trip が安定する");
}

#[test]
fn test_ruby_markup_passthrough_in_dialog_text() {
    // ルビ記法 (#148) は parser/Rust 側ではスキーマを拡張せず、
    // Dialog/Narration の text フィールドに生 markdown のまま透過する設計。
    // frontend が描画直前に parseRubyText でランに分解する。
    // ここでは「《》/｜ を含む text 行が壊れずに parse される」ことを確認する。
    let markdown = r#"---
engine: name-name
chapter: 1
title: "ルビテスト"
hidden: false
---

## 1-1: ルビ確認

**子供** (suppin_1, 左):
これは漢字《かんじ》です。
｜美少女《びしょうじょ》戦士。

> ナレーター《narrator》は語る。
"#;

    let doc = parser::parse(markdown);
    let events = &doc.chapters[0].scenes[0].events;

    // Dialog: 2 行のテキストにそれぞれ《》/｜ がそのまま残る
    let dialog_text = match &events[0] {
        Event::Dialog { text, .. } => text.clone(),
        other => panic!("Dialog を期待したが {other:?}"),
    };
    assert_eq!(dialog_text.len(), 2);
    assert_eq!(dialog_text[0], "これは漢字《かんじ》です。");
    assert_eq!(dialog_text[1], "｜美少女《びしょうじょ》戦士。");

    // Narration も同様に透過される
    let narration_text = match &events[1] {
        Event::Narration { text, .. } => text.clone(),
        other => panic!("Narration を期待したが {other:?}"),
    };
    assert_eq!(
        narration_text,
        vec!["ナレーター《narrator》は語る。".to_string()]
    );

    // round-trip: emit してパースし直しても保持されること
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    let dialog_text2 = match &doc2.chapters[0].scenes[0].events[0] {
        Event::Dialog { text, .. } => text.clone(),
        _ => panic!("Dialog を期待"),
    };
    assert_eq!(dialog_text2, dialog_text);
}

// ============================================================================
// #250 背景の端フェードマスク (フェード上/下/左/右) のパーサー / エミッターテスト
// ============================================================================

/// `[背景: ...]` 1 行だけを含む最小ドキュメントをパースし、最初の Event を取り出すヘルパ。
fn parse_single_background(directive_line: &str) -> Event {
    let input = format!(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n{directive_line}\n"
    );
    let doc = parser::parse(&input);
    doc.chapters[0].scenes[0].events[0].clone()
}

#[test]
fn test_bgfade_all_four_edges_specified() {
    // 観点1: 4 端すべて指定 → 全 Some 正値
    let event = parse_single_background(
        "[背景: bg.png, フェード上=40, フェード下=60, フェード左=10, フェード右=10]",
    );
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: Some(40),
            fade_bottom: Some(60),
            fade_left: Some(10),
            fade_right: Some(10),
            brightness: None,
        }
    );
}

#[test]
fn test_bgfade_only_one_edge_others_none() {
    // 観点2: 片端のみ → top=Some、他は None
    let event = parse_single_background("[背景: bg.png, フェード上=40]");
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: Some(40),
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );
}

#[test]
fn test_bgfade_zero_is_treated_as_none() {
    // 観点3: 値=0 は無効 → None（フェードなし）
    let event = parse_single_background("[背景: bg.png, フェード上=0, フェード下=0]");
    match event {
        Event::Background {
            fade_top,
            fade_bottom,
            ..
        } => {
            assert_eq!(fade_top, None);
            assert_eq!(fade_bottom, None);
        }
        other => panic!("Background を期待したが {other:?}"),
    }
}

#[test]
fn test_bgfade_non_integer_values_are_none() {
    // 観点4: 負 / 小数 / 非数文字列はパース不能 → None
    let event =
        parse_single_background("[背景: bg.png, フェード上=-5, フェード下=3.5, フェード左=abc]");
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );
}

#[test]
fn test_bgfade_no_kv_is_backward_compatible() {
    // 観点5: kv 無し → 全 None（後方互換）
    let event = parse_single_background("[背景: bg.png]");
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );
}

#[test]
fn test_bgfade_u32_max_accepted_overflow_rejected() {
    // 観点6: u32 max は Some、max 超は parse 不能 → None
    let event =
        parse_single_background("[背景: bg.png, フェード上=4294967295, フェード下=4294967296]");
    match event {
        Event::Background {
            fade_top,
            fade_bottom,
            ..
        } => {
            assert_eq!(fade_top, Some(4294967295));
            assert_eq!(fade_bottom, None);
        }
        other => panic!("Background を期待したが {other:?}"),
    }
}

#[test]
fn test_bgfade_english_alias_equals_japanese() {
    // 観点7: 英語 alias は日本語指定と同一 Event
    let en = parse_single_background(
        "[背景: bg.png, fade_top=40, fade_bottom=60, fade_left=10, fade_right=20]",
    );
    let ja = parse_single_background(
        "[背景: bg.png, フェード上=40, フェード下=60, フェード左=10, フェード右=20]",
    );
    assert_eq!(en, ja);
}

#[test]
fn test_bgfade_mixed_japanese_and_english_keys() {
    // 観点8: 日英混在 → 両方反映される
    let event = parse_single_background("[背景: bg.png, フェード上=40, fade_bottom=60]");
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: Some(40),
            fade_bottom: Some(60),
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );
}

#[test]
fn test_bgfade_unknown_key_silently_skipped() {
    // 観点9: 未知キーは silent skip、path 正常・全 None
    let event = parse_single_background("[背景: bg.png, フェード斜め=40]");
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );
}

#[test]
fn test_bgfade_empty_kv_elements_skipped() {
    // 観点10: 連続カンマ / 末尾カンマの空要素は skip し、有効分だけ反映
    let event = parse_single_background("[背景: bg.png, , フェード上=40, , フェード下=60,]");
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: Some(40),
            fade_bottom: Some(60),
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );
}

#[test]
fn test_bgfade_kv_without_equals_skipped() {
    // 観点11: `=` を含まない kv 片は skip される
    let event = parse_single_background("[背景: bg.png, フェード上, フェード下=60]");
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: None,
            fade_bottom: Some(60),
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );
}

#[test]
fn test_bgfade_path_is_trimmed() {
    // 観点12: path 前後のスペースは trim される
    let event = parse_single_background("[背景:   bg.png  , フェード上=40]");
    match event {
        Event::Background { path, .. } => assert_eq!(path, "bg.png"),
        other => panic!("Background を期待したが {other:?}"),
    }
}

#[test]
fn test_bgfade_duplicate_key_last_wins() {
    // 観点13: 同一キー重複は「後勝ち」（実装は split(',') を順に代入するため）
    let event = parse_single_background("[背景: bg.png, フェード上=40, フェード上=99]");
    match event {
        Event::Background { fade_top, .. } => assert_eq!(fade_top, Some(99)),
        other => panic!("Background を期待したが {other:?}"),
    }
}

#[test]
fn test_bgfade_emit_outputs_in_top_bottom_left_right_order() {
    // 観点14: emit は入力の kv 順に関わらず 上→下→左→右 の順で出力する
    let doc = parser::parse(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png, フェード右=20, フェード左=10, フェード下=60, フェード上=40]\n",
    );
    let emitted = emitter::emit(&doc);
    assert!(emitted
        .contains("[背景: bg.png, フェード上=40, フェード下=60, フェード左=10, フェード右=20]"));
}

#[test]
fn test_bgfade_emit_normalizes_english_alias_to_japanese() {
    // 観点15: 英語 alias 入力でも emit は日本語キーに正規化する
    let doc = parser::parse(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png, fade_top=40, fade_left=10]\n",
    );
    let emitted = emitter::emit(&doc);
    assert!(emitted.contains("フェード上=40"));
    assert!(emitted.contains("フェード左=10"));
    assert!(!emitted.contains("fade_top"));
    assert!(!emitted.contains("fade_left"));
}

#[test]
fn test_bgfade_emit_omits_none_edges() {
    // 観点16: None の端は emit 出力に現れない
    let doc = parser::parse(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png, フェード上=40]\n",
    );
    let emitted = emitter::emit(&doc);
    assert!(emitted.contains("[背景: bg.png, フェード上=40]"));
    assert!(!emitted.contains("フェード下"));
    assert!(!emitted.contains("フェード左"));
    assert!(!emitted.contains("フェード右"));
}

#[test]
fn test_bgfade_emit_all_none_has_no_kv() {
    // 観点17: 全 None → emit は kv 無しの `[背景: path]`
    let doc = parser::parse(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png]\n",
    );
    let emitted = emitter::emit(&doc);
    assert!(emitted.contains("[背景: bg.png]"));
    assert!(!emitted.contains("フェード"));
}

#[test]
fn test_bgfade_roundtrip_all_edges() {
    // 観点18: 4 端指定 → emit → parse で一致する
    let input =
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png, フェード上=40, フェード下=60, フェード左=10, フェード右=20]\n";
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
}

#[test]
fn test_bgfade_roundtrip_english_alias_preserves_values() {
    // 観点19: 英語 alias → emit(日本語化) → parse で値が一致する
    let input =
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png, fade_top=40, fade_bottom=60, fade_left=10, fade_right=20]\n";
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(
        doc2.chapters[0].scenes[0].events[0],
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: Some(40),
            fade_bottom: Some(60),
            fade_left: Some(10),
            fade_right: Some(20),
            brightness: None,
        }
    );
}

#[test]
fn test_bgfade_roundtrip_none_no_regression() {
    // 観点20: fade が全 None の背景でも round-trip が回帰しない
    let input =
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png]\n";
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
    assert_eq!(
        doc2.chapters[0].scenes[0].events[0],
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: None,
        }
    );
}

// ============================================================================
// 背景の明るさ (brightness / 明るさ) のパーサー / エミッターテスト
// 同一画像をシーン毎に減光する持続プロパティ。レンダラー側で tint 乗算する。
// ============================================================================

#[test]
fn test_bgbrightness_specified_is_some() {
    // 観点1: 明るさ=0.6 → Some(0.6)、fade は全 None
    let event = parse_single_background("[背景: bg.png, 明るさ=0.6]");
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: Some(0.6),
        }
    );
}

#[test]
fn test_bgbrightness_omitted_is_none() {
    // 観点2: 明るさ未指定 → None（＝原画のまま＝後方互換）
    let event = parse_single_background("[背景: bg.png]");
    match event {
        Event::Background { brightness, .. } => assert_eq!(brightness, None),
        other => panic!("Background を期待したが {other:?}"),
    }
}

#[test]
fn test_bgbrightness_one_is_none() {
    // 観点3: 明るさ=1.0（原画と同義）→ None（tint=白 と区別がないため kv を出さない）
    let event = parse_single_background("[背景: bg.png, 明るさ=1.0]");
    match event {
        Event::Background { brightness, .. } => assert_eq!(brightness, None),
        other => panic!("Background を期待したが {other:?}"),
    }
}

#[test]
fn test_bgbrightness_zero_is_some_zero() {
    // 観点4: 明るさ=0.0（真っ黒）は有効値 → Some(0.0)。fade の 0=None とは非対称。
    let event = parse_single_background("[背景: bg.png, 明るさ=0]");
    match event {
        Event::Background { brightness, .. } => assert_eq!(brightness, Some(0.0)),
        other => panic!("Background を期待したが {other:?}"),
    }
}

#[test]
fn test_bgbrightness_out_of_range_clamped() {
    // 観点5: 範囲外は 0.0..=1.0 にクランプ。負値は 0.0、1.0 超は 1.0→None（原画）に倒れる。
    let neg = parse_single_background("[背景: bg.png, 明るさ=-0.5]");
    match neg {
        Event::Background { brightness, .. } => assert_eq!(brightness, Some(0.0)),
        other => panic!("Background を期待したが {other:?}"),
    }
    let over = parse_single_background("[背景: bg.png, 明るさ=1.5]");
    match over {
        Event::Background { brightness, .. } => assert_eq!(brightness, None),
        other => panic!("Background を期待したが {other:?}"),
    }
}

#[test]
fn test_bgbrightness_non_numeric_and_empty_are_none() {
    // 観点6: 非数値 / 空 / 非有限は None（指定なし）
    for line in [
        "[背景: bg.png, 明るさ=abc]",
        "[背景: bg.png, 明るさ=]",
        "[背景: bg.png, 明るさ=NaN]",
        "[背景: bg.png, 明るさ=inf]",
    ] {
        let event = parse_single_background(line);
        match event {
            Event::Background { brightness, .. } => {
                assert_eq!(brightness, None, "入力 {line} は None になるべき")
            }
            other => panic!("Background を期待したが {other:?}"),
        }
    }
}

#[test]
fn test_bgbrightness_english_alias_equals_japanese() {
    // 観点7: 英語 alias `brightness` は日本語 `明るさ` と同一 Event
    let en = parse_single_background("[背景: bg.png, brightness=0.6]");
    let ja = parse_single_background("[背景: bg.png, 明るさ=0.6]");
    assert_eq!(en, ja);
}

#[test]
fn test_bgbrightness_coexists_with_fade() {
    // 観点8: フェード端と明るさは独立に共存する
    let event = parse_single_background("[背景: bg.png, フェード上=40, 明るさ=0.6]");
    assert_eq!(
        event,
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: Some(40),
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: Some(0.6),
        }
    );
}

#[test]
fn test_bgbrightness_emit_after_fades() {
    // 観点9: emit は フェード上→下→左→右→明るさ の順、日本語キーで出力する
    let doc = parser::parse(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png, 明るさ=0.6, フェード上=40]\n",
    );
    let emitted = emitter::emit(&doc);
    assert!(emitted.contains("[背景: bg.png, フェード上=40, 明るさ=0.6]"));
}

#[test]
fn test_bgbrightness_emit_normalizes_english_alias_to_japanese() {
    // 観点10: 英語 alias 入力でも emit は日本語キー `明るさ` に正規化する
    let doc = parser::parse(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png, brightness=0.6]\n",
    );
    let emitted = emitter::emit(&doc);
    assert!(emitted.contains("明るさ=0.6"));
    assert!(!emitted.contains("brightness"));
}

#[test]
fn test_bgbrightness_emit_omits_when_none() {
    // 観点11: 未指定（None）の背景は emit に明るさ kv が現れない（後方互換）
    let doc = parser::parse(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png]\n",
    );
    let emitted = emitter::emit(&doc);
    assert!(emitted.contains("[背景: bg.png]"));
    assert!(!emitted.contains("明るさ"));
}

#[test]
fn test_bgbrightness_roundtrip() {
    // 観点12: 明るさ指定 → emit → parse で一致する
    let input =
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png, フェード上=40, 明るさ=0.6]\n";
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
    assert_eq!(
        doc2.chapters[0].scenes[0].events[0],
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: Some(40),
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: Some(0.6),
        }
    );
}

#[test]
fn test_bgbrightness_roundtrip_zero() {
    // 観点13: 明るさ=0（真っ黒）も round-trip で保持される
    let input =
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 背景テスト\n\n[背景: bg.png, 明るさ=0]\n";
    let doc = parser::parse(input);
    let emitted = emitter::emit(&doc);
    let doc2 = parser::parse(&emitted);
    assert_eq!(doc, doc2);
    assert_eq!(
        doc2.chapters[0].scenes[0].events[0],
        Event::Background {
            path: "bg.png".to_string(),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
            brightness: Some(0.0),
        }
    );
}

// ============================================================================
// #252 動画入力レイヤ ([動画: ...] / [動画退場]) のパーサー / エミッターテスト
// ============================================================================

/// `[動画: ...]` 1 行だけを含む最小ドキュメントをパースし、最初の Event を取り出すヘルパ。
fn parse_single_video(directive_line: &str) -> Event {
    let input = format!(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 動画テスト\n\n{directive_line}\n"
    );
    let doc = parser::parse(&input);
    doc.chapters[0].scenes[0].events[0].clone()
}

#[test]
fn test_video_full_kv() {
    // 観点1: 全 kv 指定 → 全フィールドが反映される
    let event = parse_single_video(
        "[動画: capture.webm, 位置=中央, スケール=1.0, ループ=true, ミュート=false, フェード上=40, フェード下=60, フェード左=10, フェード右=10]",
    );
    assert_eq!(
        event,
        Event::Video {
            path: "capture.webm".to_string(),
            position: Some("中央".to_string()),
            scale: Some(1.0),
            loop_: Some(true),
            mute: Some(false),
            fade_top: Some(40),
            fade_bottom: Some(60),
            fade_left: Some(10),
            fade_right: Some(10),
        }
    );
}

#[test]
fn test_video_path_only_is_all_none() {
    // 観点2: path のみ → 他は全 None（既定: 中央 / cover-fit / 非ループ / ミックス）
    let event = parse_single_video("[動画: capture.webm]");
    assert_eq!(
        event,
        Event::Video {
            path: "capture.webm".to_string(),
            position: None,
            scale: None,
            loop_: None,
            mute: None,
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
        }
    );
}

#[test]
fn test_video_english_alias_equals_japanese() {
    // 観点3: 英語 alias は日本語指定と同一 Event
    let en = parse_single_video(
        "[動画: c.webm, position=右, scale=2.0, loop=true, mute=true, fade_top=5, fade_bottom=6, fade_left=7, fade_right=8]",
    );
    let ja = parse_single_video(
        "[動画: c.webm, 位置=右, スケール=2.0, ループ=true, ミュート=true, フェード上=5, フェード下=6, フェード左=7, フェード右=8]",
    );
    assert_eq!(en, ja);
}

#[test]
fn test_video_invalid_values_are_none() {
    // 観点4: 不正値の扱い — フェード 0/非数値は None、bool 非 true/false は None、scale 非数値は None
    let event =
        parse_single_video("[動画: c.webm, スケール=abc, ループ=yes, ミュート=1, フェード上=0]");
    assert_eq!(
        event,
        Event::Video {
            path: "c.webm".to_string(),
            position: None,
            scale: None,
            loop_: None,
            mute: None,
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
        }
    );
}

#[test]
fn test_video_exit_parsed() {
    // 観点5: [動画退場] → VideoExit
    let event = parse_single_video("[動画退場]");
    assert_eq!(event, Event::VideoExit);
}

#[test]
fn test_video_roundtrip_normalized_order() {
    // 観点6: emit は 位置→スケール→ループ→ミュート→フェード上/下/左/右 の順、日本語キーに正規化。
    // 英語 alias + 順序バラバラで与え、parse → emit が正規化形になることを確認する（round-trip 安定）。
    let input = format!(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 動画テスト\n\n{}\n",
        "[動画: capture.webm, fade_right=10, loop=true, position=中央, fade_top=40, mute=false, scale=1.5]"
    );
    let doc = parser::parse(&input);
    let md = emitter::emit(&doc);
    assert!(
        md.contains("[動画: capture.webm, 位置=中央, スケール=1.5, ループ=true, ミュート=false, フェード上=40, フェード右=10]"),
        "emit 結果:\n{md}"
    );
    // re-parse して同一 Event に戻ることを確認
    let reparsed = parser::parse(&md);
    assert_eq!(
        reparsed.chapters[0].scenes[0].events[0],
        doc.chapters[0].scenes[0].events[0]
    );
    assert_eq!(
        doc.chapters[0].scenes[0].events[0],
        Event::Video {
            path: "capture.webm".to_string(),
            position: Some("中央".to_string()),
            scale: Some(1.5),
            loop_: Some(true),
            mute: Some(false),
            fade_top: Some(40),
            fade_bottom: None,
            fade_left: None,
            fade_right: Some(10),
        }
    );
}

#[test]
fn test_video_exit_roundtrip() {
    // 観点7: [動画退場] の emit / re-parse round-trip
    let input = "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 動画テスト\n\n[動画退場]\n";
    let doc = parser::parse(input);
    let md = emitter::emit(&doc);
    assert!(md.contains("[動画退場]"), "emit 結果:\n{md}");
    let reparsed = parser::parse(&md);
    assert_eq!(reparsed.chapters[0].scenes[0].events[0], Event::VideoExit);
}

// --- #252 既存7件の不足を埋める追加ケース ---------------------------------

#[test]
fn test_video_path_is_trimmed() {
    // 観点8: path 前後の空白は trim される
    let event = parse_single_video("[動画:   capture.webm   ]");
    match event {
        Event::Video { path, .. } => assert_eq!(path, "capture.webm"),
        other => panic!("Video を期待したが {other:?}"),
    }
}

#[test]
fn test_video_unknown_key_and_malformed_kv_are_skipped() {
    // 観点9: 未知キー・空 kv 要素・`=` なし要素は silent skip され、既知キーだけ反映される
    let event = parse_single_video("[動画: c.webm, なぞ=99, , 位置のみ, スケール=1.0, =値だけ]");
    assert_eq!(
        event,
        Event::Video {
            path: "c.webm".to_string(),
            position: None,
            scale: Some(1.0),
            loop_: None,
            mute: None,
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
        }
    );
}

#[test]
fn test_video_bool_false_is_retained_not_dropped() {
    // 観点10: ループ=false / ミュート=false は None ではなく Some(false) として保持される
    let event = parse_single_video("[動画: c.webm, ループ=false, ミュート=false]");
    assert_eq!(
        event,
        Event::Video {
            path: "c.webm".to_string(),
            position: None,
            scale: None,
            loop_: Some(false),
            mute: Some(false),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
        }
    );
}

#[test]
fn test_video_bool_english_false_and_case_insensitive() {
    // 観点11: 英語 alias loop=False（大文字混在）も bool として解釈される
    let event = parse_single_video("[動画: c.webm, loop=False, mute=TRUE]");
    assert_eq!(
        event,
        Event::Video {
            path: "c.webm".to_string(),
            position: None,
            scale: None,
            loop_: Some(false),
            mute: Some(true),
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
        }
    );
}

#[test]
fn test_video_scale_rejects_non_finite_and_keeps_fraction() {
    // 観点12: scale は有限の小数を採用、Infinity/NaN は None
    let frac = parse_single_video("[動画: c.webm, スケール=1.5]");
    match frac {
        Event::Video { scale, .. } => assert_eq!(scale, Some(1.5)),
        other => panic!("Video を期待したが {other:?}"),
    }
    let inf = parse_single_video("[動画: c.webm, スケール=inf]");
    match inf {
        Event::Video { scale, .. } => assert_eq!(scale, None),
        other => panic!("Video を期待したが {other:?}"),
    }
    let nan = parse_single_video("[動画: c.webm, スケール=NaN]");
    match nan {
        Event::Video { scale, .. } => assert_eq!(scale, None),
        other => panic!("Video を期待したが {other:?}"),
    }
}

#[test]
fn test_video_fade_non_numeric_is_none() {
    // 観点13: フェードに非数値（abc）を渡すと None（#250 と同じ規則。既存は =0 のみ検証）
    let event = parse_single_video("[動画: c.webm, フェード上=abc, フェード下=-5]");
    assert_eq!(
        event,
        Event::Video {
            path: "c.webm".to_string(),
            position: None,
            scale: None,
            loop_: None,
            mute: None,
            fade_top: None,
            fade_bottom: None,
            fade_left: None,
            fade_right: None,
        }
    );
}

#[test]
fn test_video_all_none_emits_path_only() {
    // 観点14: 全フィールド None の Video は kv なしの `[動画: path]` に emit される
    let doc = parser::parse(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 動画テスト\n\n[動画: capture.webm]\n",
    );
    let md = emitter::emit(&doc);
    assert!(
        md.contains("[動画: capture.webm]\n"),
        "kv なしで emit されるべき:\n{md}"
    );
    assert!(
        !md.contains("[動画: capture.webm,"),
        "kv が付いてはいけない:\n{md}"
    );
}

#[test]
fn test_video_only_partial_fade_roundtrip() {
    // 観点15: 一部のフェードのみ指定 → 指定したものだけ emit され、round-trip で安定する
    let doc = parser::parse(
        "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: 動画テスト\n\n[動画: c.webm, フェード下=60]\n",
    );
    let md = emitter::emit(&doc);
    assert!(
        md.contains("[動画: c.webm, フェード下=60]\n"),
        "フェード下だけが emit されるべき:\n{md}"
    );
    let reparsed = parser::parse(&md);
    assert_eq!(
        reparsed.chapters[0].scenes[0].events[0],
        doc.chapters[0].scenes[0].events[0]
    );
}

// =====================================================================================
// #294: 立ち絵の明示フィット指定 `フィット` / `fit`。
//   話者行オプションに `フィット` を書いたときだけ Dialog.fit=true（既定 false）。
//   サイズ・位置では自動分岐しない。フロント側はこの fit を見て旧 fit-down を適用する。
// =====================================================================================
fn first_dialog_fit(doc: &Document) -> bool {
    match &doc.chapters[0].scenes[0].events[0] {
        Event::Dialog { fit, .. } => *fit,
        other => panic!("Expected Dialog, got {other:?}"),
    }
}

const FIT_HEADER: &str =
    "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: テスト\n\n";

#[test]
fn test_fit_default_false() {
    let input = format!("{FIT_HEADER}**カコ** (suppin_1, 左):\nこんにちは。\n");
    assert!(
        !first_dialog_fit(&parser::parse(&input)),
        "fit 未指定は false"
    );
}

#[test]
fn test_fit_japanese_token() {
    // 表情・位置に続けて `フィット` を置く。
    let input = format!("{FIT_HEADER}**カコ** (suppin_1, 左, フィット):\nこんにちは。\n");
    let doc = parser::parse(&input);
    assert!(first_dialog_fit(&doc), "フィット トークンで fit=true");
    match &doc.chapters[0].scenes[0].events[0] {
        Event::Dialog {
            expression,
            position,
            ..
        } => {
            // フィット を抜いても expression / position の位置取りが保たれる。
            assert_eq!(expression, &Some("suppin_1".to_string()));
            assert_eq!(position, &Some("左".to_string()));
        }
        other => panic!("Expected Dialog, got {other:?}"),
    }
}

#[test]
fn test_fit_token_position_does_not_shift_expr_pos() {
    // 契約: `フィット` / `fit` トークンは「オプションの末尾に書く」前提だが、
    // 実装は positional 解釈の前に fit トークンを全位置から除外する。そのため
    // 先頭・中間に書いても残る positional トークンの順序は崩れず、expression=先頭 /
    // position=2 番目 の割り当ては保たれる。emitter は常に fit を末尾へ出すので
    // round-trip は安全。ここでは「どこに書いても expr/pos がずれない」現挙動を固定する。
    let cases = [
        // (脚本のオプション部, 期待 expression, 期待 position)
        ("フィット, suppin_1, 左", "suppin_1", "左"), // 先頭
        ("suppin_1, フィット, 左", "suppin_1", "左"), // 中間
        ("suppin_1, 左, フィット", "suppin_1", "左"), // 末尾（規約どおり）
    ];
    for (attrs, want_expr, want_pos) in cases {
        let input = format!("{FIT_HEADER}**カコ** ({attrs}):\nこんにちは。\n");
        let doc = parser::parse(&input);
        assert!(first_dialog_fit(&doc), "`{attrs}` で fit=true");
        match &doc.chapters[0].scenes[0].events[0] {
            Event::Dialog {
                expression,
                position,
                ..
            } => {
                assert_eq!(
                    expression,
                    &Some(want_expr.to_string()),
                    "`{attrs}`: expression は fit の位置に依らない"
                );
                assert_eq!(
                    position,
                    &Some(want_pos.to_string()),
                    "`{attrs}`: position は fit の位置に依らない"
                );
            }
            other => panic!("Expected Dialog, got {other:?}"),
        }
    }
}

#[test]
fn test_fit_english_alias_and_kv() {
    // 英語エイリアス `fit`、および `fit=true` / `fit=false`。
    let on = format!("{FIT_HEADER}**カコ** (suppin_1, fit):\nやあ。\n");
    assert!(first_dialog_fit(&parser::parse(&on)), "fit 単独で true");
    let kv_on = format!("{FIT_HEADER}**カコ** (suppin_1, fit=true):\nやあ。\n");
    assert!(first_dialog_fit(&parser::parse(&kv_on)), "fit=true で true");
    let kv_off = format!("{FIT_HEADER}**カコ** (suppin_1, fit=false):\nやあ。\n");
    assert!(
        !first_dialog_fit(&parser::parse(&kv_off)),
        "fit=false で false"
    );
}

#[test]
fn test_fit_only_no_expression() {
    // `フィット` だけ（表情・位置なし）。fit=true、expr/pos は None。
    let input = format!("{FIT_HEADER}**カコ** (フィット):\nやあ。\n");
    let doc = parser::parse(&input);
    match &doc.chapters[0].scenes[0].events[0] {
        Event::Dialog {
            fit,
            expression,
            position,
            ..
        } => {
            assert!(*fit);
            assert_eq!(expression, &None);
            assert_eq!(position, &None);
        }
        other => panic!("Expected Dialog, got {other:?}"),
    }
}

#[test]
fn test_fit_inherited_by_continuation() {
    // 話者行の fit は、空行を挟まない継続行 Dialog にも引き継がれる。
    let input = format!("{FIT_HEADER}**カコ** (suppin_1, 左, フィット):\n一行目。\n\n二行目。\n");
    let doc = parser::parse(&input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 2, "話者行 Dialog + 継続行 Dialog");
    for (i, e) in events.iter().enumerate() {
        match e {
            Event::Dialog { fit, .. } => assert!(*fit, "events[{i}] は fit=true を継承する"),
            other => panic!("Expected Dialog, got {other:?}"),
        }
    }
}

#[test]
fn test_fit_roundtrip() {
    // フィット あり / なし の両方を含む脚本が round-trip で構造的に等しい。
    let input = format!(
        "{FIT_HEADER}**カコ** (suppin_1, 左, フィット):\n大きい立ち絵。\n\n\
         **トモ** (laugh_1, 右):\n普通の立ち絵。\n\n\
         **カコ** (フィット):\n表情なしフィット。\n"
    );
    let doc = parser::parse(&input);
    let emitted = emitter::emit(&doc);
    // emit に フィット トークンが現れる。
    assert!(
        emitted.contains("フィット"),
        "emit に フィット が出る:\n{emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(
        doc, doc2,
        "fit を含む round-trip が構造的に等しい\n{emitted}"
    );
}

// ===== 手動改頁 `---` (#292 Phase 2) =====
//
// 本文中の単独行 `---` を改頁センチネル（Event::PageBreak）として扱う。frontmatter 区切りの
// `---`（先頭ブロックのみ）とは区別する。`---` を挟んだ同一話者のセリフは話者名を再掲しない
// 継続行として扱い（1 つのセリフを 2 ページに割る意味論）、往復で `---` が保たれる。

/// 本文 `---` から既定 HEADER（FIT_HEADER と同じ構造）を組み立てるための前置き。
const PB_HEADER: &str =
    "---\nengine: name-name\nchapter: 1\ntitle: \"テスト\"\n---\n\n## 1-1: テスト\n\n";

#[test]
fn pagebreak_body_dash_becomes_marker() {
    // 話者セリフの途中（空行を挟まず）に置いた単独 `---` は PageBreak になり、
    // セリフを 2 つの Dialog に割る。継続側は話者名を再掲しないので character/位置を継承する。
    let input = format!("{PB_HEADER}**カコ** (suppin_1, 左):\n最初の文。\n---\n続きの文。\n");
    let doc = parser::parse(&input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(
        events.len(),
        3,
        "Dialog + PageBreak + Dialog の 3 イベント: {events:?}"
    );
    match &events[0] {
        Event::Dialog {
            character,
            position,
            text,
            ..
        } => {
            assert_eq!(character.as_deref(), Some("カコ"));
            assert_eq!(position.as_deref(), Some("左"));
            assert_eq!(text, &vec!["最初の文。".to_string()]);
        }
        other => panic!("events[0] は Dialog のはず: {other:?}"),
    }
    assert_eq!(events[1], Event::PageBreak, "events[1] は PageBreak");
    match &events[2] {
        Event::Dialog {
            character,
            position,
            expression,
            text,
            ..
        } => {
            assert_eq!(character.as_deref(), Some("カコ"), "継続行は同一話者を継承");
            assert_eq!(position.as_deref(), Some("左"), "位置も継承");
            assert_eq!(expression.as_deref(), Some("suppin_1"), "表情も継承");
            assert_eq!(text, &vec!["続きの文。".to_string()]);
        }
        other => panic!("events[2] は Dialog のはず: {other:?}"),
    }
}

#[test]
fn pagebreak_frontmatter_dash_is_not_marker() {
    // frontmatter 区切りの `---`（先頭ブロックの開始/終了）は従来どおりで PageBreak にならない。
    let input = format!("{PB_HEADER}**カコ** (左):\n本文だけ。\n");
    let doc = parser::parse(&input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(
        events.len(),
        1,
        "frontmatter の --- は PageBreak を生まない"
    );
    assert!(
        !events.iter().any(|e| matches!(e, Event::PageBreak)),
        "PageBreak は 1 つも無い: {events:?}"
    );
    // frontmatter 自体は従来どおりパースされる（エンジン・タイトル等が壊れていない）。
    assert_eq!(doc.engine, "name-name");
    assert_eq!(doc.chapters[0].title, "テスト");
}

#[test]
fn pagebreak_with_blank_lines_around_dash() {
    // `---` の前後に空行がある書き方（より一般的）でも PageBreak になり、
    // 同一話者の継続として 2 Dialog に割れる。
    let input = format!("{PB_HEADER}**カコ** (左):\n最初の文。\n\n---\n\n続きの文。\n");
    let doc = parser::parse(&input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(events.len(), 3, "Dialog + PageBreak + Dialog: {events:?}");
    assert_eq!(events[1], Event::PageBreak);
}

#[test]
fn pagebreak_between_narration_blocks() {
    // ナレーション間の `---` も PageBreak になる（次の `>` ブロックが新ページになる）。
    let input = format!("{PB_HEADER}> 一つ目のナレーション。\n---\n> 二つ目のナレーション。\n");
    let doc = parser::parse(&input);
    let events = &doc.chapters[0].scenes[0].events;
    assert_eq!(
        events.len(),
        3,
        "Narration + PageBreak + Narration: {events:?}"
    );
    assert!(matches!(events[0], Event::Narration { .. }));
    assert_eq!(events[1], Event::PageBreak);
    assert!(matches!(events[2], Event::Narration { .. }));
}

#[test]
fn pagebreak_roundtrip_stable() {
    // parse → emit → parse が構造的に等しい（往復で `---` が保たれる）。
    let input = format!(
        "{PB_HEADER}**カコ** (suppin_1, 左):\n最初の文。\n---\n続きの文。\n\n\
         **トモ** (laugh_1, 右):\n別の話者。\n"
    );
    let doc1 = parser::parse(&input);
    let emitted = emitter::emit(&doc1);
    assert!(
        emitted.contains("\n---\n"),
        "emit に単独 --- 行が出る:\n{emitted}"
    );
    let doc2 = parser::parse(&emitted);
    assert_eq!(
        doc1, doc2,
        "PageBreak を含む round-trip が等しい:\n{emitted}"
    );
}

#[test]
fn pagebreak_roundtrip_does_not_duplicate_speaker() {
    // `---` で割られた同一話者の継続セリフは emit で話者名を再掲しない
    // （needs_speaker_line が PageBreak を透過する）。話者行 `**カコ**` は 1 度だけ。
    let input = format!("{PB_HEADER}**カコ** (左):\n最初の文。\n---\n続きの文。\n");
    let doc = parser::parse(&input);
    let emitted = emitter::emit(&doc);
    let speaker_count = emitted.matches("**カコ**").count();
    assert_eq!(
        speaker_count, 1,
        "話者名 **カコ** は 1 度だけ（継続行で再掲しない）:\n{emitted}"
    );
}

#[test]
fn pagebreak_consecutive_dashes() {
    // 連続する `---`（空ページ相当）も全て PageBreak になり、round-trip で保たれる。
    let input = format!("{PB_HEADER}**カコ** (左):\nA。\n---\n---\nB。\n");
    let doc1 = parser::parse(&input);
    let events = &doc1.chapters[0].scenes[0].events;
    let pb_count = events
        .iter()
        .filter(|e| matches!(e, Event::PageBreak))
        .count();
    assert_eq!(pb_count, 2, "PageBreak が 2 つ: {events:?}");
    let emitted = emitter::emit(&doc1);
    let doc2 = parser::parse(&emitted);
    assert_eq!(
        doc1, doc2,
        "連続 PageBreak の round-trip が等しい:\n{emitted}"
    );
}

#[test]
fn pagebreak_absent_is_unchanged() {
    // `---` を含まない脚本は PageBreak を一切生まず、従来と完全に同じ（非回帰）。
    let input = format!(
        "{PB_HEADER}**カコ** (suppin_1, 左):\n一行目。\n二行目。\n\n\
         **トモ** (laugh_1, 右):\nやあ。\n"
    );
    let doc = parser::parse(&input);
    let events = &doc.chapters[0].scenes[0].events;
    assert!(
        !events.iter().any(|e| matches!(e, Event::PageBreak)),
        "--- が無ければ PageBreak は生まれない: {events:?}"
    );
    // 往復も従来どおり安定。
    let doc2 = parser::parse(&emitter::emit(&doc));
    assert_eq!(doc, doc2, "--- 無しの round-trip は不変");
}
