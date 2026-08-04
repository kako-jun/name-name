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
