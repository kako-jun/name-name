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

/// 行頭に空白（半角・全角・タブ）がある危険な行。parser は trim してから判定するので、
/// emitter も trim 後で判定して `\\` + trim 後の本文で出す。空白は落ちる（仕様）が、
/// 消えない・別構文に化けない・emit が冪等であることを確認する。
const WS_CASES: &[(&str, &str)] = &[
    (" [笑]", "[笑]"),
    ("　**x", "**x"),
    ("　**F5** で進む", "**F5** で進む"),
    ("--- ", "---"),
    (">　", ">"),
    ("\t[BGM: a]", "[BGM: a]"),
    (" > 引用", "> 引用"),
    (" \\x", "\\x"),
];

fn assert_trimmed_roundtrip(events: Vec<Event>, expected: Vec<Event>, label: &str) {
    let doc = doc_with(events);
    let md = emit(&doc);
    let back = parse(&md);
    assert_eq!(events_of(&back), expected, "{label}\n--- emitted ---\n{md}");
    assert_eq!(emit(&back), md, "emit 冪等でない: {label}");
}

#[test]
fn leading_whitespace_dangerous_lines_do_not_vanish_or_change_syntax() {
    for (src, kept) in WS_CASES {
        assert_trimmed_roundtrip(
            vec![dialog("カコ", &[src])],
            vec![dialog("カコ", &[kept])],
            &format!("1行目 {src:?}"),
        );
        assert_trimmed_roundtrip(
            vec![dialog("カコ", &["前", src])],
            vec![dialog("カコ", &["前", kept])],
            &format!("2行目 {src:?}"),
        );
        assert_trimmed_roundtrip(
            vec![dialog("カコ", &["前"]), dialog("カコ", &[src])],
            vec![dialog("カコ", &["前"]), dialog("カコ", &[kept])],
            &format!("継続 {src:?}"),
        );
    }
}

#[test]
fn narration_body_is_not_escaped() {
    let nar = Event::Narration {
        text: vec!["**x".into(), "[笑]".into(), "\\x".into()],
        voice_path: None,
        font_family: None,
        bubble_style: None,
    };
    let md = emit(&doc_with(vec![nar]));
    assert!(md.contains("> **x\n> [笑]\n> \\x\n"), "{md}");
    assert!(!md.contains("\\["), "{md}");
}

/// 本文が `## `（末尾に空白）のとき、trim で `##` になるため 1 回目の emit→parse で `##` に
/// 変わり、emit は 2 回目で初めて安定する（空白のみ・末尾空白は落ちる仕様の範囲）。
#[test]
fn heading_with_trailing_space_is_known_non_idempotent() {
    let md = emit(&doc_with(vec![dialog("カコ", &["## "])]));
    let back = parse(&md);
    assert_eq!(events_of(&back), vec![dialog("カコ", &["##"])]);
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
