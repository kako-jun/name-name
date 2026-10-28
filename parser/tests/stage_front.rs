//! #705 舞台前面（`[舞台前面: path]` / `[舞台前面: なし]`）のパーサ・エミッタ境界テスト。
//! 現挙動を固定するもの（kv を受けず無視する等）は「仕様の固定」であり、変える場合は意図して直すこと。

use name_name_parser::emitter::emit;
use name_name_parser::models::*;
use name_name_parser::parser::parse;

const HEAD: &str = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n";

fn events(body: &str) -> Vec<Event> {
    let doc = parse(&format!("{HEAD}{body}\n"));
    doc.chapters[0].scenes[0].events.clone()
}

fn front(path: &str) -> Event {
    Event::StageFront {
        path: path.to_string(),
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
fn path_only() {
    assert_eq!(single("[舞台前面: 客席.png]"), front("客席.png"));
    assert_eq!(single("[舞台前面:客席.png]"), front("客席.png"));
}

#[test]
fn spaces_around_path_are_trimmed() {
    assert_eq!(
        single("[舞台前面:   hall/front.png  ]"),
        front("hall/front.png")
    );
}

#[test]
fn trailing_kv_is_ignored() {
    // kv は受けない。path の後ろは無視する。
    assert_eq!(
        single("[舞台前面: a.png, スケール=2, depth: 3]"),
        front("a.png")
    );
}

#[test]
fn exit_marker_is_stage_front_exit() {
    assert_eq!(single("[舞台前面: なし]"), Event::StageFrontExit);
    assert_eq!(single("[舞台前面:なし]"), Event::StageFrontExit);
    assert_eq!(single("[舞台前面: なし, 何か]"), Event::StageFrontExit);
}

#[test]
fn empty_path_is_dropped() {
    assert!(events("[舞台前面:]").is_empty());
    assert!(events("[舞台前面:   ]").is_empty());
    assert!(events("[舞台前面: , a.png]").is_empty());
}

#[test]
fn similar_names_are_not_stage_front() {
    // 「舞台前面」で始まる別名や、似た名前のタグは舞台前面にならない。
    for body in ["[舞台前面板: a.png]", "[舞台: a.png]", "[前面: a.png]"] {
        assert!(
            !events(body)
                .iter()
                .any(|e| matches!(e, Event::StageFront { .. } | Event::StageFrontExit)),
            "{body}"
        );
    }
}

#[test]
fn does_not_affect_other_directives() {
    let v = events("[壁: w.webp]\n[舞台前面: f.png]\n[大道具: p.png, depth: 1]");
    assert!(matches!(v[0], Event::Wall { .. }));
    assert_eq!(v[1], front("f.png"));
    assert!(matches!(v[2], Event::Prop { .. }));
}

#[test]
fn single_slot_is_resolved_at_runtime_parser_keeps_every_event() {
    // 後勝ち（置換）はランタイムの責務。パーサは全イベントをそのまま並べる。
    assert_eq!(
        events("[舞台前面: a.png]\n[舞台前面: b.png]"),
        vec![front("a.png"), front("b.png")]
    );
}

#[test]
fn emit_front_and_exit() {
    let out = emit_events(vec![front("客席.png")]);
    assert!(out.contains("[舞台前面: 客席.png]\n"), "{out}");
    let out = emit_events(vec![Event::StageFrontExit]);
    assert!(out.contains("[舞台前面: なし]\n"), "{out}");
}

#[test]
fn round_trip_is_stable() {
    for body in [
        "[舞台前面: 客席.png]",
        "[舞台前面: なし]",
        "[舞台前面: a.png]\n[舞台前面: b.png]\n[舞台前面: なし]",
        "[舞台前面: a.png, 無視される=1]",
    ] {
        let first = events(body);
        let text = emit_events(first.clone());
        let doc2 = parse(&text);
        assert_eq!(
            doc2.chapters[0].scenes[0].events, first,
            "{body}\n--emitted--\n{text}"
        );
        assert_eq!(emit(&doc2), text, "{body}");
    }
}

#[test]
fn trailing_kv_normalizes_to_path_only_on_emit() {
    let out = emit_events(events("[舞台前面: a.png, スケール=2]"));
    assert!(out.contains("[舞台前面: a.png]\n"), "{out}");
    assert!(!out.contains("スケール"));
}

#[test]
fn json_shape_and_old_json_compat() {
    let json = serde_json::to_value(front("a.png")).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "StageFront": { "path": "a.png" } })
    );
    let exit = serde_json::to_value(Event::StageFrontExit).unwrap();
    assert_eq!(exit, serde_json::json!("StageFrontExit"));
    let back: Event =
        serde_json::from_value(serde_json::json!({ "StageFront": { "path": "x.png" } })).unwrap();
    assert_eq!(back, front("x.png"));
    let back: Event = serde_json::from_value(serde_json::json!("StageFrontExit")).unwrap();
    assert_eq!(back, Event::StageFrontExit);
}

#[test]
fn old_documents_without_stage_front_are_unchanged() {
    // 旧 JSON（StageFront を含まない events）はそのまま読める。
    let doc = parse(&format!("{HEAD}[壁: a.png]\n"));
    let json = serde_json::to_string(&doc).unwrap();
    assert!(!json.contains("StageFront"));
    let back: Document = serde_json::from_str(&json).unwrap();
    assert_eq!(back, doc);
}
