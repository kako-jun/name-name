//! パース済み `Document` を、TUI で逐次表示するための一直線の再生位置に変換する。
//!
//! MVP スコープ: 会話文（Dialog / Narration）の逐次表示だけを対象にする。選択肢分岐・
//! フラグ管理・セーブ/ロードは対象外（`parser::models::Event` にそれらの型があっても扱わない）。
//! 背景・SE・BGM・立ち絵演出などその他のイベントは、今回も画面表示を変えないため読み飛ばす。
//! ただし `Event::EventImage` / `EventImageExit` だけは例外で、各 `DisplayLine` に
//! `event_image`（その時点で表示されているべきイベント絵の相対パス）として反映する（#481）。
//! 左側は `event_image` が `None` のときのみ従来どおりプレースホルダ表示になる。

use name_name_parser::models::{Document, Event};

/// 画面に表示する1行分の内容（話者名 + 本文 + その時点のイベント絵）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayLine {
    /// 話者名。`Narration` イベントの場合は `None`。
    pub speaker: Option<String>,
    /// 本文（複数行）。
    pub text: Vec<String>,
    /// この会話行の時点で表示されているべきイベント絵の相対パス
    /// （`Event::EventImage { path, .. }` の `path`。`config.event_image.assets_dir` からの
    /// 相対パス）。直前に `Event::EventImage` があれば `Some`、`Event::EventImageExit` で
    /// クリアされていれば（または一度も出ていなければ）`None`。`Event::Choice` 等その他の
    /// イベント種別はこの値に影響しない（#482 スコープの Choice を含め今回も対象外）。
    pub event_image: Option<String>,
}

/// ルビ記法（`｜` / `《...》`）を除去し、ベーステキストのみを残す。
///
/// parser はルビ記法をスキーマ化せず、Dialog/Narration の `text` に生 markdown の
/// まま透過する設計（`docs/spec/markdown-v0.1.md`）。frontend は描画直前に
/// `parseRubyText()` でルビを上下二段表示にするが、tui はターミナル上でその表示が
/// 非現実的なため、ベーステキストのみを残す形で除去する。
///
/// - `｜`（U+FF5C、ルビの明示的な開始境界マーカー）は単純に除去する
/// - `《...》`（U+300A/U+300B）は開き括弧から閉じ括弧までを中身ごと丸ごと除去する
///   （例: `漢字《かんじ》` → `漢字`）
/// - 対応する `》` が見つからない不正な `《`（閉じ忘れ）は、`《` 以降の文字を
///   全て捨てて終了する（panic・無限ループしない）
/// - ネストした `《`（`《《a》b》` のような不正な記法）は非対応・未定義動作。
///   panic・無限ループはしないが、内側の `》` で読み飛ばしが終わり外側の `》` が
///   除去されずリテラルとして出力に残る（例: `《《a》b》` → `b》`）
fn strip_ruby_markup(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '｜' => {}
            '《' => {
                // 対応する '》' まで読み飛ばす。見つからなければ末尾まで捨てて終了。
                for inner in chars.by_ref() {
                    if inner == '》' {
                        break;
                    }
                }
            }
            _ => result.push(c),
        }
    }
    result
}

/// `Event` が画面に表示すべき会話行なら `DisplayLine` に変換する。
/// Dialog / Narration 以外（背景・SE・BGM・EventImage 等）は `None`。
/// `event_image` は常に `None` で返す — 呼び出し側（`Playback::from_document`）が
/// 直前までの `Event::EventImage`/`EventImageExit` 走査状態を見て上書きする。
fn display_line_from_event(event: &Event) -> Option<DisplayLine> {
    match event {
        Event::Dialog {
            character, text, ..
        } => Some(DisplayLine {
            speaker: character.clone(),
            text: text.iter().map(|line| strip_ruby_markup(line)).collect(),
            event_image: None,
        }),
        Event::Narration { text, .. } => Some(DisplayLine {
            speaker: None,
            text: text.iter().map(|line| strip_ruby_markup(line)).collect(),
            event_image: None,
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
    /// 走査中、直近の `Event::EventImage`（表示開始）/ `EventImageExit`（退場）を
    /// `current_event_image` として追跡し、各 `DisplayLine` にその時点の値を刻む（#481）。
    /// チャプター/シーン境界をまたいでも状態は引き継がれる（`Document` 全体を単一の
    /// 時系列として走査するため）。Choice 等それ以外のイベントはこの状態に影響しない。
    pub fn from_document(doc: &Document) -> Self {
        let mut lines = Vec::new();
        let mut current_event_image: Option<String> = None;
        for event in doc
            .chapters
            .iter()
            .flat_map(|chapter| chapter.scenes.iter())
            .flat_map(|scene| scene.events.iter())
        {
            match event {
                // `path` の `..` は `back`（表示位置）と `fade_ms`（イベント個別のフェード時間
                // 上書き）を意図的に捨てている。`fade_ms` は TUI 側では常に
                // `config.event_image.crossfade_ms`（グローバル値、`main.rs` の `event_loop`
                // 参照）しか使わない簡略化（MVPスコープ、#481）。GUI版のようなイベント単位の
                // フェード時間上書きは今回の対象外。
                Event::EventImage { path, .. } => {
                    current_event_image = Some(path.clone());
                }
                Event::EventImageExit { .. } => {
                    current_event_image = None;
                }
                _ => {
                    if let Some(mut line) = display_line_from_event(event) {
                        line.event_image = current_event_image.clone();
                        lines.push(line);
                    }
                }
            }
        }
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

    /// テスト専用: 会話行リストから直接 `Playback` を組み立てる。`main.rs` の
    /// `on_advance` テストなどで、`Document`（20個のフィールドを埋める必要がある）経由の
    /// 冗長なフィクスチャ構築を避けるために使う（#472）。
    #[cfg(test)]
    pub(crate) fn from_lines(lines: Vec<DisplayLine>) -> Self {
        Self { lines, index: 0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use name_name_parser::models::{BgmAction, Chapter, ChoiceOption, Scene, SceneView};
    use std::collections::HashMap;

    #[test]
    fn strip_ruby_markup_removes_basic_ruby() {
        assert_eq!(strip_ruby_markup("漢字《かんじ》です"), "漢字です");
    }

    #[test]
    fn strip_ruby_markup_removes_explicit_boundary_marker() {
        assert_eq!(
            strip_ruby_markup("｜美少女《びしょうじょ》が微笑む"),
            "美少女が微笑む"
        );
    }

    #[test]
    fn strip_ruby_markup_leaves_plain_text_unchanged() {
        assert_eq!(strip_ruby_markup("こんにちは"), "こんにちは");
    }

    #[test]
    fn strip_ruby_markup_removes_lone_pipes_without_ruby_body() {
        assert_eq!(strip_ruby_markup("｜A｜B"), "AB");
    }

    #[test]
    fn strip_ruby_markup_removes_multiple_rubies_in_one_line() {
        assert_eq!(
            strip_ruby_markup("今日《きょう》は良い天気《てんき》だ"),
            "今日は良い天気だ"
        );
    }

    #[test]
    fn strip_ruby_markup_unclosed_bracket_discards_rest_without_panicking() {
        assert_eq!(strip_ruby_markup("これは《閉じられない"), "これは");
    }

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

    fn event_image(path: &str) -> Event {
        Event::EventImage {
            path: path.to_string(),
            back: name_name_parser::models::EventImageBack::default(),
            fade_ms: None,
        }
    }

    fn event_image_exit() -> Event {
        Event::EventImageExit { fade_ms: None }
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

    // ---- #481: EventImage / EventImageExit の event_image 追跡 ----

    #[test]
    fn lines_before_any_event_image_have_none() {
        let doc = doc_single_scene(vec![dialog(Some("A"), vec!["前"])]);
        let pb = Playback::from_document(&doc);
        assert_eq!(pb.current().expect("line").event_image, None);
    }

    #[test]
    fn dialog_after_event_image_carries_its_path() {
        let doc = doc_single_scene(vec![
            event_image("props/candle.webp"),
            dialog(Some("A"), vec!["後"]),
        ]);
        let pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current().expect("line").event_image.as_deref(),
            Some("props/candle.webp")
        );
    }

    #[test]
    fn event_image_exit_clears_path_for_subsequent_lines() {
        let doc = doc_single_scene(vec![
            event_image("props/candle.webp"),
            dialog(Some("A"), vec!["表示中"]),
            event_image_exit(),
            dialog(Some("A"), vec!["退場後"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current().expect("line").event_image.as_deref(),
            Some("props/candle.webp")
        );
        pb.advance();
        assert_eq!(pb.current().expect("line").event_image, None);
    }

    #[test]
    fn later_event_image_replaces_the_previous_one() {
        let doc = doc_single_scene(vec![
            event_image("props/a.webp"),
            dialog(Some("A"), vec!["1"]),
            event_image("props/b.webp"),
            dialog(Some("A"), vec!["2"]),
        ]);
        let mut pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current().expect("line").event_image.as_deref(),
            Some("props/a.webp")
        );
        pb.advance();
        assert_eq!(
            pb.current().expect("line").event_image.as_deref(),
            Some("props/b.webp")
        );
    }

    #[test]
    fn event_image_state_persists_across_scene_and_chapter_boundaries() {
        let ch1 = chapter(
            1,
            vec![scene(
                "1-1",
                vec![
                    event_image("props/candle.webp"),
                    dialog(Some("A"), vec!["ch1"]),
                ],
            )],
        );
        let ch2 = chapter(2, vec![scene("2-1", vec![dialog(Some("B"), vec!["ch2"])])]);
        let doc = document_with_chapters(vec![ch1, ch2]);
        let mut pb = Playback::from_document(&doc);
        pb.advance();
        assert_eq!(
            pb.current().expect("line").event_image.as_deref(),
            Some("props/candle.webp"),
            "イベント絵の状態はチャプター境界をまたいでも引き継がれる"
        );
    }

    #[test]
    fn choice_event_does_not_affect_event_image_state() {
        let doc = doc_single_scene(vec![
            event_image("props/candle.webp"),
            Event::Choice {
                options: vec![ChoiceOption {
                    text: "yes".to_string(),
                    jump: "1-2".to_string(),
                }],
            },
            dialog(Some("A"), vec!["後"]),
        ]);
        let pb = Playback::from_document(&doc);
        assert_eq!(
            pb.current().expect("line").event_image.as_deref(),
            Some("props/candle.webp"),
            "Choiceはevent_image状態を変更しない（#482スコープ外）"
        );
    }
}
