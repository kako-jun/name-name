//! #973 台詞本文の行頭エスケープ。行頭候補 × 位置を総当たりして emit→parse の往復を検証する。

use name_name_parser::emitter::emit;
use name_name_parser::models::*;
use name_name_parser::parser::parse;

const HEAD: &str = "---\nengine: name-name\nchapter: 1\ntitle: \"test\"\n---\n\n## 1-1: t\n\n";

const CANDIDATES: &[&str] = &[
    "**",
    "**F5** で進む",
    "**a** → b:",
    "**a**: x",
    "[",
    "[/選択]",
    "[/条件]",
    "[条件: f",
    "[選択]",
    "[BGM: a]",
    "[笑]",
    "## 見出し",
    "## x",
    "> 引用",
    "> x",
    ">",
    "---",
    "\\",
    "\\**x",
    "\\\\x",
    "- 項目",
    "1. 番号",
    "##x",
    ">x",
    "----",
    "漢字《かんじ》です",
    "｜漢字《かんじ》",
    "＊＊強調＊＊",
    "［全角］",
    "＞全角",
    "ふつうの台詞",
];

fn dialog(ch: &str, text: &[&str]) -> Event {
    Event::Dialog {
        character: Some(ch.to_string()),
        expression: None,
        position: None,
        text: text.iter().map(|s| s.to_string()).collect(),
        voice_path: None,
        font_family: None,
        bubble_style: None,
        fit: false,
        depth: None,
    }
}

fn doc_with(events: Vec<Event>) -> Document {
    let mut doc = parse(&format!("{HEAD}x\n"));
    doc.chapters[0].scenes[0].events = events;
    doc
}

fn events_of(doc: &Document) -> Vec<Event> {
    doc.chapters[0].scenes[0].events.clone()
}

/// emit → parse して Dialog 列が一致し、他のイベントが増えず、emit が冪等であることを確認する。
fn assert_roundtrip(events: Vec<Event>, label: &str) {
    let doc = doc_with(events.clone());
    let md = emit(&doc);
    let back = parse(&md);
    let got = events_of(&back);
    assert_eq!(got, events, "{label}\n--- emitted ---\n{md}");
    assert_eq!(emit(&back), md, "emit 冪等でない: {label}");
}

#[test]
fn first_line_of_single_line_dialog() {
    for c in CANDIDATES {
        assert_roundtrip(vec![dialog("カコ", &[c])], &format!("1行目 {c:?}"));
    }
}

#[test]
fn second_line_of_multi_line_dialog() {
    for c in CANDIDATES {
        assert_roundtrip(
            vec![dialog("カコ", &["最初の行", c])],
            &format!("2行目 {c:?}"),
        );
        assert_roundtrip(vec![dialog("カコ", &[c, c])], &format!("両行 {c:?}"));
    }
}

#[test]
fn continuation_dialog_same_speaker() {
    for c in CANDIDATES {
        assert_roundtrip(
            vec![dialog("カコ", &["最初"]), dialog("カコ", &[c])],
            &format!("継続 {c:?}"),
        );
        assert_roundtrip(
            vec![dialog("カコ", &[c]), dialog("カコ", &[c, "あと"])],
            &format!("継続2 {c:?}"),
        );
    }
}

#[test]
fn no_warnings_on_escaped_bodies() {
    // 警告は stderr 出力のみで検査しづらいため、読み捨て(イベント消失)が無いことで代替する。
    for c in CANDIDATES {
        let evs = vec![dialog("カコ", &[c]), dialog("トモ", &["次"])];
        let md = emit(&doc_with(evs.clone()));
        assert_eq!(events_of(&parse(&md)), evs, "{c:?}");
    }
}

#[test]
fn hand_written_escape_is_stripped_once() {
    let md = format!("{HEAD}**カコ**:\n\\**F5** キーで進む\n\\\\x\n\\[笑]\n\\---\n");
    let evs = events_of(&parse(&md));
    assert_eq!(
        evs,
        vec![dialog("カコ", &["**F5** キーで進む", "\\x", "[笑]", "---"])]
    );
}

#[test]
fn non_dangerous_bodies_are_emitted_unchanged() {
    for c in [
        "ふつう",
        "##x",
        ">x",
        "----",
        "- 項目",
        "1. 番号",
        "漢字《かんじ》",
        "＊＊強調＊＊",
    ] {
        let md = emit(&doc_with(vec![dialog("カコ", &[c])]));
        assert!(md.contains(&format!(":\n{c}\n")), "{c:?}\n{md}");
    }
}
