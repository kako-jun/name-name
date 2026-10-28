//! #706 天候（`[天候: 雨|雪|桜|なし]`、任意で `強さ=`）のパーサ・エミッタ境界テスト。

use name_name_parser::emitter::emit;
use name_name_parser::models::*;
use name_name_parser::parser::parse;

const HEAD: &str = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n";

fn events(body: &str) -> Vec<Event> {
    let doc = parse(&format!("{HEAD}{body}\n"));
    doc.chapters[0].scenes[0].events.clone()
}

fn weather(kind: WeatherKind, intensity: f32) -> Event {
    Event::Weather { kind, intensity }
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
fn three_kinds_with_default_intensity() {
    assert_eq!(single("[天候: 雨]"), weather(WeatherKind::Rain, 1.0));
    assert_eq!(single("[天候: 雪]"), weather(WeatherKind::Snow, 1.0));
    assert_eq!(single("[天候: 桜]"), weather(WeatherKind::Sakura, 1.0));
    assert_eq!(single("[天候:雨]"), weather(WeatherKind::Rain, 1.0));
}

#[test]
fn english_and_long_aliases() {
    assert_eq!(single("[天候: rain]"), weather(WeatherKind::Rain, 1.0));
    assert_eq!(single("[天候: Snow]"), weather(WeatherKind::Snow, 1.0));
    assert_eq!(single("[天候: sakura]"), weather(WeatherKind::Sakura, 1.0));
    assert_eq!(single("[天候: 桜吹雪]"), weather(WeatherKind::Sakura, 1.0));
}

#[test]
fn intensity_value_and_alias() {
    assert_eq!(
        single("[天候: 雨, 強さ=1.5]"),
        weather(WeatherKind::Rain, 1.5)
    );
    assert_eq!(
        single("[天候: 雪, intensity=0.5]"),
        weather(WeatherKind::Snow, 0.5)
    );
    assert_eq!(
        single("[天候: 桜, 強さ＝2]"),
        weather(WeatherKind::Sakura, 2.0)
    );
}

#[test]
fn intensity_is_clamped() {
    assert_eq!(
        single("[天候: 雨, 強さ=99]"),
        weather(WeatherKind::Rain, 3.0)
    );
    assert_eq!(
        single("[天候: 雨, 強さ=0.01]"),
        weather(WeatherKind::Rain, 0.1)
    );
}

#[test]
fn invalid_intensity_falls_back_to_default() {
    for kv in [
        "強さ=abc",
        "強さ=",
        "強さ=-1",
        "強さ=0",
        "強さ=NaN",
        "強さ=inf",
    ] {
        assert_eq!(
            single(&format!("[天候: 雨, {kv}]")),
            weather(WeatherKind::Rain, 1.0),
            "{kv}"
        );
    }
}

#[test]
fn intensity_last_wins_and_order_independent_of_unknown_keys() {
    assert_eq!(
        single("[天候: 雨, 強さ=2, 強さ=0.5]"),
        weather(WeatherKind::Rain, 0.5)
    );
    // 後ろが不正なら無視され、直前の有効値が残る（最後の有効値が勝つ）
    assert_eq!(
        single("[天候: 雨, 強さ=2, 強さ=x]"),
        weather(WeatherKind::Rain, 2.0)
    );
    assert_eq!(
        single("[天候: 雨, 強さ=0.7, 強さ=bad, 強さ=-1]"),
        weather(WeatherKind::Rain, 0.7)
    );
    assert_eq!(
        single("[天候: 雨, 無視=3, 強さ=2]"),
        weather(WeatherKind::Rain, 2.0)
    );
}

#[test]
fn exit_marker() {
    assert_eq!(single("[天候: なし]"), Event::WeatherExit);
    assert_eq!(single("[天候:なし]"), Event::WeatherExit);
    assert_eq!(single("[天候: none]"), Event::WeatherExit);
    assert_eq!(single("[天候: なし, 強さ=2]"), Event::WeatherExit);
}

#[test]
fn unknown_or_empty_kind_is_dropped() {
    assert!(events("[天候: 霧]").is_empty());
    assert!(events("[天候: ]").is_empty());
    assert!(events("[天候:]").is_empty());
    assert!(events("[天候: , 強さ=2]").is_empty());
}

#[test]
fn similar_names_are_not_weather() {
    for body in ["[天気: 雨]", "[天候板: 雨]", "[天: 雨]"] {
        assert!(
            !events(body)
                .iter()
                .any(|e| matches!(e, Event::Weather { .. } | Event::WeatherExit)),
            "{body}"
        );
    }
}

#[test]
fn does_not_affect_other_directives() {
    let v = events("[壁: w.webp]\n[天候: 雨]\n[舞台前面: f.png]");
    assert!(matches!(v[0], Event::Wall { .. }));
    assert_eq!(v[1], weather(WeatherKind::Rain, 1.0));
    assert!(matches!(v[2], Event::StageFront { .. }));
}

#[test]
fn single_slot_is_resolved_at_runtime_parser_keeps_every_event() {
    assert_eq!(
        events("[天候: 雨]\n[天候: 雪]\n[天候: なし]"),
        vec![
            weather(WeatherKind::Rain, 1.0),
            weather(WeatherKind::Snow, 1.0),
            Event::WeatherExit
        ]
    );
}

#[test]
fn emit_omits_default_intensity() {
    let out = emit_events(vec![weather(WeatherKind::Rain, 1.0)]);
    assert!(out.contains("[天候: 雨]\n"), "{out}");
    let out = emit_events(vec![weather(WeatherKind::Snow, 1.5)]);
    assert!(out.contains("[天候: 雪, 強さ=1.5]\n"), "{out}");
    let out = emit_events(vec![weather(WeatherKind::Sakura, 0.5)]);
    assert!(out.contains("[天候: 桜, 強さ=0.5]\n"), "{out}");
    let out = emit_events(vec![Event::WeatherExit]);
    assert!(out.contains("[天候: なし]\n"), "{out}");
}

#[test]
fn round_trip_is_stable() {
    for body in [
        "[天候: 雨]",
        "[天候: 雪, 強さ=1.5]",
        "[天候: 桜, 強さ=0.1]",
        "[天候: 桜, 強さ=3]",
        "[天候: なし]",
        "[天候: rain, intensity=2]\n[天候: 雪]\n[天候: なし]",
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
    let out = emit_events(events("[天候: rain, intensity=99]"));
    assert!(out.contains("[天候: 雨, 強さ=3]\n"), "{out}");
}

#[test]
fn json_shape_and_old_json_compat() {
    let json = serde_json::to_value(weather(WeatherKind::Rain, 1.0)).unwrap();
    assert_eq!(json, serde_json::json!({ "Weather": { "kind": "Rain" } }));
    let json = serde_json::to_value(weather(WeatherKind::Sakura, 2.0)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "Weather": { "kind": "Sakura", "intensity": 2.0 } })
    );
    let exit = serde_json::to_value(Event::WeatherExit).unwrap();
    assert_eq!(exit, serde_json::json!("WeatherExit"));
    // intensity 省略の JSON は既定 1.0 として読める
    let back: Event =
        serde_json::from_value(serde_json::json!({ "Weather": { "kind": "Snow" } })).unwrap();
    assert_eq!(back, weather(WeatherKind::Snow, 1.0));
    let back: Event = serde_json::from_value(serde_json::json!("WeatherExit")).unwrap();
    assert_eq!(back, Event::WeatherExit);
}

#[test]
fn old_documents_without_weather_are_unchanged() {
    let doc = parse(&format!("{HEAD}[壁: a.png]\n"));
    let json = serde_json::to_string(&doc).unwrap();
    assert!(!json.contains("Weather"));
    let back: Document = serde_json::from_str(&json).unwrap();
    assert_eq!(back, doc);
}
