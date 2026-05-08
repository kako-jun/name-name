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
            path: "radius/BG_COMMON_GRAD_3.png".to_string()
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
                &vec!["ちくしょう……。".to_string(), "なんで！".to_string()]
            );
        }
        other => panic!("Expected Dialog, got {:?}", other),
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
            ..
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
            ..
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
        Event::Narration { text, .. } => {
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
        other => panic!("Expected PlayerStart, got {:?}", other),
    }
    match &events[1] {
        Event::Npc(npc) => assert_eq!(npc.direction, Some(Direction::Down)),
        other => panic!("Expected Npc, got {:?}", other),
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
        other => panic!("Expected Npc, got {:?}", other),
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
        "emit must write explicit id that differs from auto-slug: {}",
        emitted
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
        "emit should omit id= when it matches the slug: {}",
        emitted
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
        "plain NPC should not emit sprite=: {}",
        plain_line
    );
    assert!(
        !plain_line.contains("frames="),
        "plain NPC should not emit frames=: {}",
        plain_line
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
        "default NPC must not emit 向き=: {}",
        default_line
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
        "plain NPC should not emit portrait=: {}",
        plain_line
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
        "hidden: false should be omitted: {}",
        emitted
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
        "hidden: true must round-trip: {}",
        emitted
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
        "emit must write [view=raycast] directive: {}",
        emitted
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
        "TopDown is default and must not be emitted: {}",
        emitted
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
    assert!(!emitted.contains("[view="), "got: {}", emitted);
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
        "title with trailing [重要] must be preserved: {}",
        emitted
    );
    // view=... 指定がないので [view=...] も emit されない
    assert!(
        !emitted.contains("[view="),
        "no view directive should be emitted: {}",
        emitted
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
        other => panic!("Expected RpgMap, got {:?}", other),
    }
    let emitted = emitter::emit(&doc);
    assert!(
        emitted.contains("[壁高さ]"),
        "emit must write [壁高さ]: {}",
        emitted
    );
    assert!(
        !emitted.contains("[床高さ]"),
        "missing floor block should not be emitted: {}",
        emitted
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
        other => panic!("Expected RpgMap, got {:?}", other),
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
        "decimal 0.25 must survive emit: {}",
        emitted
    );
    assert!(
        emitted.contains("1.5"),
        "decimal 1.5 must survive emit: {}",
        emitted
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
        "emit 出力に choice_style が含まれること: {}",
        emitted
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
        "choice_style が None なら emit に含まれないこと: {}",
        emitted_none
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
        "emit 出力に font_family が含まれること: {}",
        emitted
    );
    assert!(
        emitted.contains("[フォント: Hina Mincho, serif]"),
        "per-line [フォント:] が emit されること: {}",
        emitted
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
        "font_family が None なら emit に含まれないこと: {}",
        emitted_none
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
        "emit には backslash escape を出さない: {}",
        emitted
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
