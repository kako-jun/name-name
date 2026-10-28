//! #703 舞台の壁（`[壁: path]` / `[壁: なし]`）のパーサ・エミッタ境界テスト。
//! 現挙動を固定するもの（不正な kv の扱いなど）は「仕様の固定」であり、変える場合は意図して直すこと。

use name_name_parser::emitter::emit;
use name_name_parser::models::*;
use name_name_parser::parser::parse;

const HEAD: &str = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n";

fn events(body: &str) -> Vec<Event> {
    let doc = parse(&format!("{HEAD}{body}\n"));
    doc.chapters[0].scenes[0].events.clone()
}

fn wall(path: &str, loop_: bool, mute: bool) -> Event {
    Event::Wall {
        path: path.to_string(),
        loop_,
        mute,
    }
}

fn single(body: &str) -> Event {
    let v = events(body);
    assert_eq!(v.len(), 1, "event count for {body:?}: {v:?}");
    v.into_iter().next().unwrap()
}

fn emit_events(evs: Vec<Event>) -> String {
    let mut doc = parse(&format!("{HEAD}x\n"));
    doc.chapters[0].scenes[0].events = evs;
    emit(&doc)
}

#[test]
fn path_only_defaults_to_loop_and_mute() {
    assert_eq!(single("[壁: 光.webp]"), wall("光.webp", true, true));
    assert_eq!(single("[壁: 星空.webm]"), wall("星空.webm", true, true));
}

#[test]
fn spaces_around_path_are_trimmed() {
    assert_eq!(single("[壁:   光.webp  ]"), wall("光.webp", true, true));
}

#[test]
fn kv_japanese_and_english_aliases() {
    assert_eq!(
        single("[壁: a.webm, ループ=false, ミュート=false]"),
        wall("a.webm", false, false)
    );
    assert_eq!(
        single("[壁: a.webm, loop=false, mute=false]"),
        wall("a.webm", false, false)
    );
    assert_eq!(
        single("[壁: a.webm, ミュート=false]"),
        wall("a.webm", true, false)
    );
}

#[test]
fn kv_order_does_not_matter() {
    assert_eq!(
        single("[壁: a.webm, ミュート=false, ループ=false]"),
        wall("a.webm", false, false)
    );
}

#[test]
fn invalid_kv_values_keep_defaults() {
    // bool でない値・空値は既定（true）のまま。
    assert_eq!(
        single("[壁: a.webm, ループ=maybe, ミュート=]"),
        wall("a.webm", true, true)
    );
}

#[test]
fn unknown_keys_and_colon_form_are_ignored() {
    assert_eq!(
        single("[壁: a.webm, 位置=右, depth: 3, ループ: false]"),
        wall("a.webm", true, true)
    );
}

#[test]
fn later_kv_wins() {
    assert_eq!(
        single("[壁: a.webm, ループ=false, ループ=true]"),
        wall("a.webm", true, true)
    );
}

#[test]
fn bool_value_is_case_insensitive() {
    assert_eq!(
        single("[壁: a.webm, ループ=FALSE]"),
        wall("a.webm", false, true)
    );
}

#[test]
fn exit_marker_is_wall_exit() {
    assert_eq!(single("[壁: なし]"), Event::WallExit);
    assert_eq!(single("[壁:なし]"), Event::WallExit);
}

#[test]
fn exit_marker_with_kv_is_still_exit() {
    assert_eq!(single("[壁: なし, ループ=false]"), Event::WallExit);
}

#[test]
fn empty_path_is_dropped() {
    assert!(events("[壁:]").is_empty());
    assert!(events("[壁:   ]").is_empty());
    assert!(events("[壁: , ループ=false]").is_empty());
}

#[test]
fn similar_names_are_not_walls() {
    // 「壁」で始まる別名や「壁:」を含む本文は壁にならない。
    assert!(!events("[壁板: a.png]")
        .iter()
        .any(|e| matches!(e, Event::Wall { .. } | Event::WallExit)));
}

#[test]
fn does_not_affect_other_directives() {
    let v = events("[背景板: a.png, depth: 3]\n[壁: b.webp]\n[動画: c.webm]");
    assert!(matches!(v[0], Event::BackgroundBoard { .. }));
    assert_eq!(v[1], wall("b.webp", true, true));
    assert!(matches!(v[2], Event::Video { .. }));
}

#[test]
fn single_slot_is_resolved_at_runtime_parser_keeps_every_event() {
    let v = events("[壁: a.webp]\n[壁: b.webp]");
    assert_eq!(
        v,
        vec![wall("a.webp", true, true), wall("b.webp", true, true)]
    );
}

#[test]
fn emit_omits_default_kv() {
    let out = emit_events(vec![wall("光.webp", true, true)]);
    assert!(out.contains("[壁: 光.webp]\n"), "{out}");
    assert!(!out.contains("ループ"));
    assert!(!out.contains("ミュート"));
}

#[test]
fn emit_writes_only_non_default_kv() {
    let out = emit_events(vec![wall("a.webm", false, true)]);
    assert!(out.contains("[壁: a.webm, ループ=false]\n"), "{out}");
    let out = emit_events(vec![wall("a.webm", true, false)]);
    assert!(out.contains("[壁: a.webm, ミュート=false]\n"), "{out}");
    let out = emit_events(vec![wall("a.webm", false, false)]);
    assert!(
        out.contains("[壁: a.webm, ループ=false, ミュート=false]\n"),
        "{out}"
    );
}

#[test]
fn emit_exit() {
    let out = emit_events(vec![Event::WallExit]);
    assert!(out.contains("[壁: なし]\n"), "{out}");
}

#[test]
fn round_trip_is_stable() {
    for body in [
        "[壁: 光.webp]",
        "[壁: a.webm, ループ=false]",
        "[壁: a.webm, ミュート=false]",
        "[壁: a.webm, ループ=false, ミュート=false]",
        "[壁: なし]",
        "[壁: a.webp]\n[壁: b.webm, loop=false]\n[壁: なし]",
    ] {
        let first = events(body);
        let text = emit_events(first.clone());
        let doc2 = parse(&text);
        assert_eq!(
            doc2.chapters[0].scenes[0].events, first,
            "{body}\n--emitted--\n{text}"
        );
        // 2 周目の emit も同じ（正規化は冪等）。
        assert_eq!(emit(&doc2), text, "{body}");
    }
}

#[test]
fn explicit_default_kv_normalizes_to_no_output() {
    let first = events("[壁: a.webp, ループ=true, ミュート=true]");
    let out = emit_events(first);
    assert!(out.contains("[壁: a.webp]\n"), "{out}");
}

#[test]
fn json_omits_defaults_and_old_json_without_fields_loads_as_defaults() {
    let json = serde_json::to_value(wall("a.webp", true, true)).unwrap();
    assert_eq!(json, serde_json::json!({ "Wall": { "path": "a.webp" } }));
    let json = serde_json::to_value(wall("a.webm", false, false)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "Wall": { "path": "a.webm", "loop": false, "mute": false } })
    );
    let back: Event =
        serde_json::from_value(serde_json::json!({ "Wall": { "path": "x.webp" } })).unwrap();
    assert_eq!(back, wall("x.webp", true, true));
    let exit: Event = serde_json::from_value(serde_json::json!("WallExit")).unwrap();
    assert_eq!(exit, Event::WallExit);
}
