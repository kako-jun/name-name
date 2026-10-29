//! #704 第2弾 回転舞台（`[舞台回転]` / `[舞台回転: 時間=900]`）のパーサ・エミッタ境界テスト。

use name_name_parser::emitter::emit;
use name_name_parser::models::*;
use name_name_parser::parser::parse;

const HEAD: &str = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n";

fn events(body: &str) -> Vec<Event> {
    let doc = parse(&format!("{HEAD}{body}\n"));
    doc.chapters[0].scenes[0].events.clone()
}

fn turn(ms: Option<u32>) -> Event {
    Event::StageTurn { duration_ms: ms }
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
fn bare_and_colon_without_duration_use_default() {
    assert_eq!(single("[舞台回転]"), turn(None));
    assert_eq!(single("[舞台回転:]"), turn(None));
    assert_eq!(single("[舞台回転: ]"), turn(None));
}

#[test]
fn duration_value_and_alias() {
    assert_eq!(single("[舞台回転: 時間=900]"), turn(Some(900)));
    assert_eq!(single("[舞台回転:時間=900]"), turn(Some(900)));
    assert_eq!(single("[舞台回転: duration=1200]"), turn(Some(1200)));
    assert_eq!(single("[舞台回転: 時間＝450]"), turn(Some(450)));
    assert_eq!(single("[舞台回転: 時間 = 450 ]"), turn(Some(450)));
    // 第1弾の `時間: N`（コロン）と同じ書き方も受ける。
    assert_eq!(single("[舞台回転: 時間: 700]"), turn(Some(700)));
}

#[test]
fn duration_clamp_boundaries() {
    assert_eq!(single("[舞台回転: 時間=0]"), turn(Some(0)));
    assert_eq!(single("[舞台回転: 時間=1]"), turn(Some(1)));
    assert_eq!(single("[舞台回転: 時間=5000]"), turn(Some(5000)));
    assert_eq!(single("[舞台回転: 時間=5001]"), turn(Some(5000)));
    assert_eq!(single("[舞台回転: 時間=99999999]"), turn(Some(5000)));
    // u32 / u64 を超える値も上限へクランプする（panic しない）。
    assert_eq!(single("[舞台回転: 時間=99999999999]"), turn(Some(5000)));
    assert_eq!(single("[舞台回転: 時間=99999999999999]"), turn(Some(5000)));
    assert_eq!(
        single("[舞台回転: 時間=99999999999999999999999999]"),
        turn(Some(5000))
    );
    assert_eq!(
        single("[舞台回転: 時間=+99999999999999999999999999]"),
        turn(Some(5000))
    );
    // 先頭の + は第1弾の `時間:`（u32 の parse）と同じく受理する。
    assert_eq!(single("[舞台回転: 時間=+900]"), turn(Some(900)));
    assert_eq!(single("[舞台回転: 時間=+]"), turn(None));
}

#[test]
fn invalid_duration_falls_back_to_default() {
    for body in [
        "[舞台回転: 時間=abc]",
        "[舞台回転: 時間=]",
        "[舞台回転: 時間=-1]",
        "[舞台回転: 時間=1.5]",
        "[舞台回転: 時間]",
        "[舞台回転: 速さ=900]",
        "[舞台回転: 900]",
    ] {
        assert_eq!(single(body), turn(None), "{body}");
    }
}

#[test]
fn last_valid_duration_wins_and_invalid_does_not_break_previous() {
    assert_eq!(single("[舞台回転: 時間=100, 時間=200]"), turn(Some(200)));
    assert_eq!(single("[舞台回転: 時間=100, 時間=abc]"), turn(Some(100)));
    assert_eq!(
        single("[舞台回転: 時間=100, duration=300]"),
        turn(Some(300))
    );
}

#[test]
fn similar_names_are_not_stage_turn() {
    for body in ["[舞台回転する]", "[舞台回転2]", "[舞台]"] {
        let v = events(body);
        assert!(
            v.iter().all(|e| !matches!(e, Event::StageTurn { .. })),
            "{body}: {v:?}"
        );
    }
}

#[test]
fn order_is_preserved_and_back_directives_stay_separate_events() {
    let v = events("[壁: a.png]\n[舞台回転]\n[壁: b.png]\n[床: c.png]\n[舞台回転: 時間=300]\n[大道具: d.png]\n\n**A** (x, 左):\nhi");
    let kinds: Vec<&str> = v
        .iter()
        .map(|e| match e {
            Event::Wall { .. } => "wall",
            Event::StageTurn { .. } => "turn",
            Event::Floor { .. } => "floor",
            Event::Prop { .. } => "prop",
            Event::Dialog { .. } => "dialog",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        ["wall", "turn", "wall", "floor", "turn", "prop", "dialog"]
    );
    assert_eq!(v[1], turn(None));
    assert_eq!(v[4], turn(Some(300)));
}

#[test]
fn emit_omits_default_duration() {
    let out = emit_events(vec![turn(None)]);
    assert!(out.contains("[舞台回転]\n"), "{out}");
    assert!(!out.contains("時間"), "{out}");
    let out = emit_events(vec![turn(Some(900))]);
    assert!(out.contains("[舞台回転: 時間=900]\n"), "{out}");
    let out = emit_events(vec![turn(Some(0))]);
    assert!(out.contains("[舞台回転: 時間=0]\n"), "{out}");
}

#[test]
fn round_trip_is_stable() {
    let src = "[壁: a.png]\n[舞台回転: 時間=900]\n[壁: b.png]\n[背景板: c.png, depth: 2]\n[床: なし]\n[舞台回転]\n[大道具: d.png]\n";
    let first = events(src);
    let text = emit_events(first.clone());
    let second = {
        let doc = parse(&text);
        doc.chapters[0].scenes[0].events.clone()
    };
    assert_eq!(first, second);
    assert_eq!(text, emit_events(second));
}

#[test]
fn alias_and_clamp_normalize_on_emit() {
    let out = emit_events(events("[舞台回転: duration=99999]"));
    assert!(out.contains("[舞台回転: 時間=5000]\n"), "{out}");
}

#[test]
fn json_shape_and_old_json_compat() {
    let json = serde_json::to_string(&turn(None)).unwrap();
    assert_eq!(json, r#"{"StageTurn":{}}"#);
    let json = serde_json::to_string(&turn(Some(900))).unwrap();
    assert_eq!(json, r#"{"StageTurn":{"duration_ms":900}}"#);
    let back: Event = serde_json::from_str(r#"{"StageTurn":{}}"#).unwrap();
    assert_eq!(back, turn(None));
    let back: Event = serde_json::from_str(r#"{"StageTurn":{"duration_ms":900}}"#).unwrap();
    assert_eq!(back, turn(Some(900)));
}

#[test]
fn old_documents_without_stage_turn_are_unchanged() {
    let v = events("[壁: a.png]\n[床: b.png]");
    assert_eq!(v.len(), 2);
    assert!(v.iter().all(|e| !matches!(e, Event::StageTurn { .. })));
}
