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
