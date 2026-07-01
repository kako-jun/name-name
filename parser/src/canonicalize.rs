//! 本文（会話文・地の文）の表示用ダイグラフ正準化 (#340)。
//!
//! 原稿は打ちやすい ASCII / U+2026 で書き、読み込み後に中央字形へ置換する。中央字形
//! （`─`=U+2500 / `⋯`=U+22EF）は「上下中央に出る」ため見栄えで採用しているが、普段打つのが
//! 大変なため。自動置換してよいのは正当な literal 表示用途が存在しない書き方だけ（`--` / `…`）で、
//! `？`/`！`/空白/単独ハイフンは literal 用途があるので触らない（原稿側で正しく書く）。
//!
//! スコープ: Dialog / Narration の本文 text 行にだけ掛ける（`canonicalize_events`）。
//! frontmatter の `---`、見出し `##`、ディレクティブ引数・ID・アセットパス・話者名には触れない。

use crate::models::Event;

/// U+2500 BOX DRAWINGS LIGHT HORIZONTAL（余韻横棒の表示字形 `─`）。
pub const MIDLINE_RULE: char = '\u{2500}';
/// U+22EF MIDLINE HORIZONTAL ELLIPSIS（言いよどみの表示字形 `⋯`）。
pub const MIDLINE_ELLIPSIS: char = '\u{22EF}';

/// 本文 1 行を表示用ダイグラフに正準化する純粋関数 (#340)。
///
/// - `--`（ASCII U+002D ちょうど 2 連。前後にハイフンが無い＝`(?<!-)--(?!-)` 相当）→ `──`
///   （U+2500 × 2）。`---`（3 連以上）は markdown hr / 見出し下線と衝突するため不変。単独 `-`・
///   URL や語中のハイフンも不変（＝あらゆるハイフンの一括置換はしない）。
/// - `…`（U+2026、1 つでも連続でも）→ `⋯`（U+22EF、同数）。
///
/// 冪等: 出力に ASCII `--` / U+2026 は残らないため、二重適用は恒等（既存の `──`/`⋯⋯`
/// コーパスにも恒等）。JS 側 `canonicalizeBodyText`（frontend/src/game/textCanonical.ts）と
/// 同一挙動。
pub fn canonicalize_body_line(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\u{2026}' {
            // … → ⋯（1 文字ずつ・連続でも同数）。
            out.push(MIDLINE_ELLIPSIS);
            i += 1;
        } else if c == '-' {
            // ハイフンの連続長を数え、ちょうど 2 連のときだけ ── に置換する。
            // 1 連（単独）・3 連以上（markdown hr / 見出し下線）はそのまま温存する。
            let start = i;
            while i < chars.len() && chars[i] == '-' {
                i += 1;
            }
            if i - start == 2 {
                out.push(MIDLINE_RULE);
                out.push(MIDLINE_RULE);
            } else {
                for _ in start..i {
                    out.push('-');
                }
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Dialog / Narration の本文 text にだけ正準化を適用する再帰パス (#340)。
///
/// Condition の入れ子イベントにも再帰する（JS 側 `normalizeEvents` と対象範囲を揃える）。
/// マスタ定義・ディレクティブ引数・話者名・アセットパス・frontmatter には触れない
/// （それらは Dialog/Narration の text 以外のフィールド or 別イベントに載る）。
pub fn canonicalize_events(events: &mut [Event]) {
    for event in events.iter_mut() {
        match event {
            Event::Dialog { text, .. } | Event::Narration { text, .. } => {
                for line in text.iter_mut() {
                    *line = canonicalize_body_line(line);
                }
            }
            Event::Condition { events: inner, .. } => {
                canonicalize_events(inner);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_double_hyphen_becomes_midline_rule() {
        assert_eq!(
            canonicalize_body_line("待って--行かないで"),
            "待って──行かないで"
        );
        assert_eq!(canonicalize_body_line("--"), "──");
        assert_eq!(canonicalize_body_line("A--B。"), "A──B。");
    }

    #[test]
    fn triple_or_more_hyphen_is_unchanged() {
        // markdown hr / 見出し下線 / セパレータを壊さない。
        assert_eq!(canonicalize_body_line("---"), "---");
        assert_eq!(canonicalize_body_line("----"), "----");
        assert_eq!(canonicalize_body_line("A---B"), "A---B");
    }

    #[test]
    fn single_and_in_word_hyphen_unchanged() {
        assert_eq!(canonicalize_body_line("a-b"), "a-b");
        assert_eq!(canonicalize_body_line("part-time"), "part-time");
        assert_eq!(canonicalize_body_line("-"), "-");
    }

    #[test]
    fn ellipsis_u2026_becomes_u22ef_same_count() {
        assert_eq!(canonicalize_body_line("そう…"), "そう⋯");
        assert_eq!(canonicalize_body_line("ええと……"), "ええと⋯⋯");
        assert_eq!(canonicalize_body_line("……あと五分……"), "⋯⋯あと五分⋯⋯");
    }

    #[test]
    fn is_idempotent_on_already_canonical() {
        // 既存中央字コーパス（──/⋯⋯）に対して恒等。
        assert_eq!(
            canonicalize_body_line("待って──行かないで⋯⋯"),
            "待って──行かないで⋯⋯"
        );
        // 二重適用しても壊れない。
        let once = canonicalize_body_line("待って--行かないで……");
        assert_eq!(canonicalize_body_line(&once), once);
    }

    #[test]
    fn mixed_line() {
        assert_eq!(
            canonicalize_body_line("そうか--でも…もういい"),
            "そうか──でも⋯もういい"
        );
    }

    #[test]
    fn events_pass_touches_only_body_text_and_recurses_condition() {
        let mut events = vec![
            Event::Dialog {
                character: Some("カコ".to_string()),
                expression: None,
                position: None,
                text: vec!["待って--".to_string(), "行かないで…".to_string()],
                voice_path: None,
                font_family: None,
                fit: false,
            },
            Event::Narration {
                text: vec!["風が吹いた--".to_string()],
                voice_path: None,
                font_family: None,
            },
            Event::Condition {
                flag: "met".to_string(),
                events: vec![Event::Dialog {
                    character: None,
                    expression: None,
                    position: None,
                    text: vec!["また--会えたね".to_string()],
                    voice_path: None,
                    font_family: None,
                    fit: false,
                }],
            },
        ];
        canonicalize_events(&mut events);
        match &events[0] {
            Event::Dialog { text, .. } => {
                assert_eq!(
                    text,
                    &vec!["待って──".to_string(), "行かないで⋯".to_string()]
                );
            }
            other => panic!("expected Dialog, got {other:?}"),
        }
        match &events[1] {
            Event::Narration { text, .. } => assert_eq!(text, &vec!["風が吹いた──".to_string()]),
            other => panic!("expected Narration, got {other:?}"),
        }
        match &events[2] {
            Event::Condition { events: inner, .. } => match &inner[0] {
                Event::Dialog { text, .. } => {
                    assert_eq!(text, &vec!["また──会えたね".to_string()])
                }
                other => panic!("expected inner Dialog, got {other:?}"),
            },
            other => panic!("expected Condition, got {other:?}"),
        }
    }
}
