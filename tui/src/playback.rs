//! パース済み `Document` を、TUI で逐次表示するための一直線の再生位置に変換する。
//!
//! MVP スコープ: 会話文（Dialog / Narration）の逐次表示だけを対象にする。選択肢分岐・
//! フラグ管理・セーブ/ロードは対象外（`parser::models::Event` にそれらの型があっても扱わない）。
//! 背景・SE・BGM・立ち絵演出などその他のイベントは、今回は画面表示を変えないため読み飛ばす
//! （左側は常にプレースホルダ表示のみ）。

use name_name_parser::models::{Document, Event};

/// 画面に表示する1行分の内容（話者名 + 本文）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayLine {
    /// 話者名。`Narration` イベントの場合は `None`。
    pub speaker: Option<String>,
    /// 本文（複数行）。
    pub text: Vec<String>,
}

/// `Event` が画面に表示すべき会話行なら `DisplayLine` に変換する。
/// Dialog / Narration 以外（背景・SE・BGM 等）は `None`。
fn display_line_from_event(event: &Event) -> Option<DisplayLine> {
    match event {
        Event::Dialog {
            character, text, ..
        } => Some(DisplayLine {
            speaker: character.clone(),
            text: text.clone(),
        }),
        Event::Narration { text, .. } => Some(DisplayLine {
            speaker: None,
            text: text.clone(),
        }),
        _ => None,
    }
}

/// `Document` の chapters → scenes → events を順番どおりに走査し、会話行だけを再生する状態。
pub struct Playback {
    lines: Vec<DisplayLine>,
    index: usize,
}

impl Playback {
    /// `Document` から Dialog / Narration の行だけを抽出し、先頭に位置づけた再生状態を作る。
    pub fn from_document(doc: &Document) -> Self {
        let lines = doc
            .chapters
            .iter()
            .flat_map(|chapter| chapter.scenes.iter())
            .flat_map(|scene| scene.events.iter())
            .filter_map(display_line_from_event)
            .collect();
        Self { lines, index: 0 }
    }

    /// 現在位置の表示行。会話行が1件もない、または末尾を過ぎている場合は `None`。
    pub fn current(&self) -> Option<&DisplayLine> {
        self.lines.get(self.index)
    }

    /// 次の会話行へ進む。進めた場合は `true`、既に末尾にいた場合は `false`。
    pub fn advance(&mut self) -> bool {
        if self.index + 1 < self.lines.len() {
            self.index += 1;
            true
        } else {
            false
        }
    }

    /// 全会話行のうち何行目か（1始まり）。会話行が0件の場合は0。
    pub fn position(&self) -> usize {
        if self.lines.is_empty() {
            0
        } else {
            self.index + 1
        }
    }

    /// 会話行の総数。
    pub fn total(&self) -> usize {
        self.lines.len()
    }

    /// 末尾（最後の会話行）に到達しているか。
    pub fn is_at_end(&self) -> bool {
        self.lines.is_empty() || self.index + 1 >= self.lines.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use name_name_parser::models::{BgmAction, Chapter, ChoiceOption, Scene, SceneView};
    use std::collections::HashMap;

    /// `Document` の非 chapters フィールドを全て無害な既定値で埋めるヘルパー。
    /// Document は Default を derive していないため、テストごとに20個のフィールドを
    /// 書き下ろすのを避けるためにここに1箇所だけ用意する。
    fn document_with_chapters(chapters: Vec<Chapter>) -> Document {
        Document {
            engine: "test".to_string(),
            aspect_ratio: "16:9".to_string(),
            choice_style: None,
            font_family: None,
            font_size: None,
            dialog_style: None,
            protagonist: None,
            character_y_ratio: None,
            character_height_ratio: None,
            character_height_ratios: HashMap::new(),
            character_scale: None,
            character_fade_ms: None,
            background_fade_ms: None,
            event_image_fade_ms: None,
            background_color: None,
            skip_enabled: None,
            debug_enabled: None,
            speaker_nudge: None,
            auto_play: None,
            seekbar_color: None,
            split_layout: None,
            sentence_per_page: None,
            pixel_art: None,
            chapters,
        }
    }

    fn chapter(number: u32, scenes: Vec<Scene>) -> Chapter {
        Chapter {
            number,
            title: "chapter".to_string(),
            hidden: false,
            default_bgm: None,
            scenes,
        }
    }

    fn scene(id: &str, events: Vec<Event>) -> Scene {
        Scene {
            id: id.to_string(),
            title: "scene".to_string(),
            view: SceneView::TopDown,
            events,
        }
    }

    fn dialog(character: Option<&str>, text: Vec<&str>) -> Event {
        Event::Dialog {
            character: character.map(|s| s.to_string()),
            expression: None,
            position: None,
            text: text.into_iter().map(|s| s.to_string()).collect(),
            voice_path: None,
            font_family: None,
            fit: false,
        }
    }

    fn narration(text: Vec<&str>) -> Event {
        Event::Narration {
            text: text.into_iter().map(|s| s.to_string()).collect(),
            voice_path: None,
            font_family: None,
        }
    }

    /// 単一チャプター・単一シーンに `events` を並べた `Document` を作る。
    fn doc_single_scene(events: Vec<Event>) -> Document {
        document_with_chapters(vec![chapter(1, vec![scene("1-1", events)])])
    }

    #[test]
    fn dialog_with_character_produces_correct_display_line() {
        let doc = doc_single_scene(vec![dialog(Some("カコ"), vec!["やあ"])]);
        let pb = Playback::from_document(&doc);
        let line = pb.current().expect("should have a line");
        assert_eq!(line.speaker.as_deref(), Some("カコ"));
        assert_eq!(line.text, vec!["やあ".to_string()]);
    }

    #[test]
    fn narration_only_has_none_speaker() {
        let doc = doc_single_scene(vec![narration(vec!["静かな朝だった。"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current().expect("line").speaker, None);
    }

    #[test]
    fn dialog_without_character_has_none_speaker() {
        let doc = doc_single_scene(vec![dialog(None, vec!["誰？"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current().expect("line").speaker, None);
    }

    #[test]
    fn empty_text_events_produce_empty_display_line_text() {
        let doc = doc_single_scene(vec![dialog(Some("カコ"), vec![]), narration(vec![])]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.total(), 2);
        assert_eq!(pb.current().expect("line").text, Vec::<String>::new());
        pb.advance();
        assert_eq!(pb.current().expect("line").text, Vec::<String>::new());
    }

    #[test]
    fn non_display_events_are_excluded_from_lines() {
        let doc = doc_single_scene(vec![
            Event::Background {
                path: "bg.png".to_string(),
                fade_top: None,
                fade_bottom: None,
                fade_left: None,
                fade_right: None,
                brightness: None,
            },
            Event::Bgm {
                path: Some("bgm.ogg".to_string()),
                action: BgmAction::Play,
                fade_ms: None,
            },
            Event::Se {
                path: "se.ogg".to_string(),
                fade_ms: None,
            },
            Event::Choice {
                options: vec![ChoiceOption {
                    text: "yes".to_string(),
                    jump: "1-2".to_string(),
                }],
            },
            dialog(Some("カコ"), vec!["こんにちは"]),
        ]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.total(), 1);
        assert_eq!(pb.current().expect("line").speaker.as_deref(), Some("カコ"));
    }

    #[test]
    fn zero_events_playback_has_no_current_and_is_at_end() {
        let doc = doc_single_scene(vec![]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current(), None);
        assert_eq!(pb.position(), 0);
        assert_eq!(pb.total(), 0);
        assert!(pb.is_at_end());
    }

    #[test]
    fn single_event_playback_position_and_end_state() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["hi"])]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.position(), 1);
        assert_eq!(pb.total(), 1);
        assert!(pb.is_at_end());
        assert!(!pb.advance());
        assert_eq!(pb.position(), 1);
    }

    #[test]
    fn advance_before_last_line_moves_forward() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.position(), 1);
        assert_eq!(pb.total(), 2);
        assert!(!pb.is_at_end());
        assert!(pb.advance());
        assert_eq!(pb.position(), 2);
    }

    #[test]
    fn advance_at_last_line_returns_false_and_stays() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        pb.advance(); // move to the last line (index 1)
        assert_eq!(pb.position(), 2);
        assert!(pb.is_at_end());
        assert!(!pb.advance());
        assert_eq!(pb.position(), 2);
    }

    #[test]
    fn advance_past_end_is_idempotent() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        pb.advance(); // to the last line
        assert!(!pb.advance()); // first call at end
        assert!(!pb.advance()); // second call, still false and unchanged
        assert_eq!(pb.position(), 2);
    }

    #[test]
    fn advance_through_three_lines_reaches_end_in_order() {
        let doc = doc_single_scene(vec![
            dialog(Some("A"), vec!["1"]),
            dialog(Some("B"), vec!["2"]),
            dialog(Some("C"), vec!["3"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert!(!pb.is_at_end());
        assert!(pb.advance());
        assert_eq!(pb.current().expect("line").speaker.as_deref(), Some("B"));
        assert!(!pb.is_at_end());
        assert!(pb.advance());
        assert_eq!(pb.current().expect("line").speaker.as_deref(), Some("C"));
        assert!(pb.is_at_end());
    }

    #[test]
    fn playback_preserves_order_across_chapters_and_scenes() {
        let ch1 = chapter(
            1,
            vec![
                scene("1-1", vec![dialog(Some("A"), vec!["ch1-scene1"])]),
                scene("1-2", vec![dialog(Some("B"), vec!["ch1-scene2"])]),
            ],
        );
        let ch2 = chapter(
            2,
            vec![scene("2-1", vec![dialog(Some("C"), vec!["ch2-scene1"])])],
        );
        let doc = document_with_chapters(vec![ch1, ch2]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(pb.total(), 3);
        assert_eq!(
            pb.current().expect("line").text,
            vec!["ch1-scene1".to_string()]
        );
        pb.advance();
        assert_eq!(
            pb.current().expect("line").text,
            vec!["ch1-scene2".to_string()]
        );
        pb.advance();
        assert_eq!(
            pb.current().expect("line").text,
            vec!["ch2-scene1".to_string()]
        );
    }

    #[test]
    fn zero_scenes_or_zero_events_do_not_affect_line_count() {
        let populated = chapter(
            1,
            vec![
                scene("empty-scene", vec![]),
                scene("real-scene", vec![dialog(Some("A"), vec!["hi"])]),
            ],
        );
        let empty_chapter = Chapter {
            number: 2,
            title: "empty".to_string(),
            hidden: false,
            default_bgm: None,
            scenes: vec![],
        };
        let doc = document_with_chapters(vec![populated, empty_chapter]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.total(), 1);
    }
}
