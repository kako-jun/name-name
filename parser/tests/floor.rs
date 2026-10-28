//! #706 第2弾 床材質（`[床: path]` / `[床: path, 高さ=0.3]` / `[床: なし]`）のパーサ・エミッタ境界テスト。

use name_name_parser::emitter::emit;
use name_name_parser::models::*;
use name_name_parser::parser::parse;

const HEAD: &str = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n";

fn events(body: &str) -> Vec<Event> {
    let doc = parse(&format!("{HEAD}{body}\n"));
    doc.chapters[0].scenes[0].events.clone()
}

fn floor(path: &str, height: f32) -> Event {
    Event::Floor {
        path: path.to_string(),
        height,
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
fn path_only_uses_default_height() {
    assert_eq!(single("[床: wood.png]"), floor("wood.png", 0.25));
    assert_eq!(single("[床:wood.png]"), floor("wood.png", 0.25));
    assert_eq!(single("[床:   wood.png  ]"), floor("wood.png", 0.25));
}

#[test]
fn height_value_and_alias() {
    assert_eq!(single("[床: wood.png, 高さ=0.3]"), floor("wood.png", 0.3));
    assert_eq!(single("[床: wood.png, height=0.5]"), floor("wood.png", 0.5));
    assert_eq!(single("[床: wood.png, 高さ＝0.4]"), floor("wood.png", 0.4));
    assert_eq!(
        single("[床: wood.png, 高さ = 0.4 ]"),
        floor("wood.png", 0.4)
    );
}

#[test]
fn height_clamp_boundaries() {
    // 下限 0.05: 0.05-ε は 0.05 へ、ちょうどは据え置き
    assert_eq!(single("[床: a.png, 高さ=0.049]"), floor("a.png", 0.05));
    assert_eq!(single("[床: a.png, 高さ=0.0001]"), floor("a.png", 0.05));
    assert_eq!(single("[床: a.png, 高さ=0.05]"), floor("a.png", 0.05));
    assert_eq!(single("[床: a.png, 高さ=0.051]"), floor("a.png", 0.051));
    // 上限 1.0: ちょうどは据え置き、1.0+ε は 1.0 へ
    assert_eq!(single("[床: a.png, 高さ=1]"), floor("a.png", 1.0));
    assert_eq!(single("[床: a.png, 高さ=1.0]"), floor("a.png", 1.0));
    assert_eq!(single("[床: a.png, 高さ=1.001]"), floor("a.png", 1.0));
    assert_eq!(single("[床: a.png, 高さ=99]"), floor("a.png", 1.0));
}

#[test]
fn invalid_height_falls_back_to_default() {
    for kv in [
        "高さ=abc",
        "高さ=",
        "高さ=-1",
        "高さ=-0.3",
        "高さ=0",
        "高さ=0.0",
        "高さ=NaN",
        "高さ=inf",
        "高さ=-inf",
    ] {
        assert_eq!(
            single(&format!("[床: a.png, {kv}]")),
            floor("a.png", 0.25),
            "{kv}"
        );
    }
}

#[test]
fn height_last_valid_wins() {
    assert_eq!(
        single("[床: a.png, 高さ=0.6, 高さ=0.3]"),
        floor("a.png", 0.3)
    );
    // 後ろが不正なら無視され、直前の有効値が残る
    assert_eq!(single("[床: a.png, 高さ=0.6, 高さ=x]"), floor("a.png", 0.6));
    assert_eq!(
        single("[床: a.png, 高さ=0.6, 高さ=0, 高さ=-1]"),
        floor("a.png", 0.6)
    );
    // 日本語と英語 alias の混在でも最後の有効値
    assert_eq!(
        single("[床: a.png, 高さ=0.6, height=0.2]"),
        floor("a.png", 0.2)
    );
    // 未知キーは無視
    assert_eq!(single("[床: a.png, 無視=3, 高さ=0.4]"), floor("a.png", 0.4));
}

#[test]
fn exit_marker() {
    assert_eq!(single("[床: なし]"), Event::FloorExit);
    assert_eq!(single("[床:なし]"), Event::FloorExit);
    assert_eq!(single("[床: なし, 高さ=0.5]"), Event::FloorExit);
}

#[test]
fn empty_path_is_dropped() {
    assert!(events("[床: ]").is_empty());
    assert!(events("[床:]").is_empty());
    assert!(events("[床: , 高さ=0.5]").is_empty());
}

#[test]
fn similar_names_are_not_floor() {
    for body in ["[床板: a.png]", "[ゆか: a.png]", "[床面: a.png]"] {
        assert!(
            !events(body)
                .iter()
                .any(|e| matches!(e, Event::Floor { .. } | Event::FloorExit)),
            "{body}"
        );
    }
}

#[test]
fn does_not_affect_other_directives() {
    let v = events("[壁: w.webp]\n[床: f.png, 高さ=0.5]\n[舞台前面: s.png]");
    assert!(matches!(v[0], Event::Wall { .. }));
    assert_eq!(v[1], floor("f.png", 0.5));
    assert!(matches!(v[2], Event::StageFront { .. }));
}

#[test]
fn single_slot_is_resolved_at_runtime_parser_keeps_every_event() {
    assert_eq!(
        events("[床: a.png]\n[床: b.png, 高さ=0.5]\n[床: なし]"),
        vec![floor("a.png", 0.25), floor("b.png", 0.5), Event::FloorExit]
    );
}

#[test]
fn emit_omits_default_height() {
    let out = emit_events(vec![floor("wood.png", 0.25)]);
    assert!(out.contains("[床: wood.png]\n"), "{out}");
    let out = emit_events(vec![floor("wood.png", 0.3)]);
    assert!(out.contains("[床: wood.png, 高さ=0.3]\n"), "{out}");
    let out = emit_events(vec![Event::FloorExit]);
    assert!(out.contains("[床: なし]\n"), "{out}");
}

#[test]
fn round_trip_is_stable() {
    for body in [
        "[床: wood.png]",
        "[床: wood.png, 高さ=0.3]",
        "[床: wood.png, 高さ=0.05]",
        "[床: wood.png, 高さ=1]",
        "[床: なし]",
        "[床: a.png, height=0.5]\n[床: b.png]\n[床: なし]",
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
fn alias_and_clamp_normalize_on_emit() {
    let out = emit_events(events("[床: a.png, height=99]"));
    assert!(out.contains("[床: a.png, 高さ=1]\n"), "{out}");
    let out = emit_events(events("[床: a.png, 高さ=0.001]"));
    assert!(out.contains("[床: a.png, 高さ=0.05]\n"), "{out}");
}

#[test]
fn json_shape_and_old_json_compat() {
    let json = serde_json::to_value(floor("a.png", 0.25)).unwrap();
    assert_eq!(json, serde_json::json!({ "Floor": { "path": "a.png" } }));
    let json = serde_json::to_value(floor("a.png", 0.5)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "Floor": { "path": "a.png", "height": 0.5 } })
    );
    let exit = serde_json::to_value(Event::FloorExit).unwrap();
    assert_eq!(exit, serde_json::json!("FloorExit"));
    // height 省略の JSON は既定 0.25 として読める
    let back: Event =
        serde_json::from_value(serde_json::json!({ "Floor": { "path": "a.png" } })).unwrap();
    assert_eq!(back, floor("a.png", 0.25));
    let back: Event = serde_json::from_value(serde_json::json!("FloorExit")).unwrap();
    assert_eq!(back, Event::FloorExit);
}

#[test]
fn f32_height_serializes_with_f32_precision_loss() {
    // 0.3 は f32 では 0.30000001192...。JSON（f64）に載るとき広がるので、TS 側 normalize で丸める前提。
    let json = serde_json::to_value(floor("a.png", 0.3)).unwrap();
    let h = json["Floor"]["height"].as_f64().unwrap();
    assert_ne!(h, 0.3_f64);
    assert!((h - 0.3).abs() < 1e-6);
}

#[test]
fn old_documents_without_floor_are_unchanged() {
    let doc = parse(&format!("{HEAD}[壁: a.png]\n"));
    let json = serde_json::to_string(&doc).unwrap();
    assert!(!json.contains("Floor"));
    let back: Document = serde_json::from_str(&json).unwrap();
    assert_eq!(back, doc);
}
