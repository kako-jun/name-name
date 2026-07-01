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

/// 読ませる表示テキストにだけ正準化を適用する再帰パス (#340)。
///
/// 対象は「画面に本文的に出るテキスト」: Dialog / Narration の本文（複数行）、Choice の各
/// 選択肢ボタン本文、TitleShow / Label の表示文字列。Condition の入れ子イベントにも再帰する
/// （JS 側 `normalizeEvents` と対象範囲を揃える）。
///
/// 対象外（不変）: RPG マスタ（Monster/Item/Spell/PartyMember の name、Npc の name/message）・
/// 話者名・ディレクティブ引数・アセットパス・ID・frontmatter・見出し。これらは以下の match で
/// 分岐を持たず `_ => {}` に落ちるため、一切触れない（マスタ／ドメイン分離）。
pub fn canonicalize_events(events: &mut [Event]) {
    for event in events.iter_mut() {
        match event {
            // 本文（会話文・地の文）: 複数行 Vec<String>。
            Event::Dialog { text, .. } | Event::Narration { text, .. } => {
                for line in text.iter_mut() {
                    *line = canonicalize_body_line(line);
                }
            }
            // 選択肢の各ボタン本文（画面に出る本文的テキスト・#340）。
            Event::Choice { options } => {
                for option in options.iter_mut() {
                    option.text = canonicalize_body_line(&option.text);
                }
            }
            // タイトルカード / ラベルの表示文字列（単一 String・#340）。
            Event::TitleShow { text, .. } | Event::Label { text, .. } => {
                *text = canonicalize_body_line(text);
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
    fn choice_title_label_canonicalized_rpg_master_unchanged() {
        // 実 parse を通して、読ませる表示テキスト（Choice/TitleShow/Label）は正準化され、
        // RPG マスタ（Monster の name/id）は不変であることを縛る (#340)。
        let md = concat!(
            "---\nengine: name-name\nchapter: 1\ntitle: \"t\"\n---\n\n",
            "## data: マスター\n\n",
            "[モンスター boss--1]\n名前: 王--様\nHP: 10\nATK: 3\nDEF: 1\nAGI: 2\nEXP: 2\nGOLD: 1\n[/モンスター]\n\n",
            "## s1: シーン\n\n",
            "[タイトル: orber--now]\n\n",
            "[ラベル: kako--jun, 位置=中]\n\n",
            "[選択]\n- 行く--戻る → a\n- そう…だね → b\n[/選択]\n",
        );
        let doc = crate::parser::parse(md);
        let mut monster_name = None;
        let mut monster_id = None;
        let mut title_text = None;
        let mut label_text = None;
        let mut choice_texts: Vec<String> = Vec::new();
        for scene in &doc.chapters[0].scenes {
            for ev in &scene.events {
                match ev {
                    Event::Monster(m) => {
                        monster_name = Some(m.name.clone());
                        monster_id = Some(m.id.clone());
                    }
                    Event::TitleShow { text, .. } => title_text = Some(text.clone()),
                    Event::Label { text, .. } => label_text = Some(text.clone()),
                    Event::Choice { options } => {
                        for o in options {
                            choice_texts.push(o.text.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
        // 表示テキストは正準化される。
        assert_eq!(title_text.as_deref(), Some("orber──now"));
        assert_eq!(label_text.as_deref(), Some("kako──jun"));
        assert_eq!(
            choice_texts,
            vec!["行く──戻る".to_string(), "そう⋯だね".to_string()]
        );
        // RPG マスタ名・ID は不変（`_ => {}` に落ちるため触らない）。
        assert_eq!(monster_name.as_deref(), Some("王--様"));
        assert_eq!(monster_id.as_deref(), Some("boss--1"));
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
