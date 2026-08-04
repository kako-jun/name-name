//! ratatui による画面描画。左に画像プレースホルダ、右に話者名 + 本文を表示する
//! 左右セパレートレイアウト。

use std::str::FromStr;

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Text};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::config::{Config, PlaceholderStyle};
use crate::playback::DisplayLine;

/// 画面全体を左（画像プレースホルダ）40% / 右（テキスト）60% に分割して描画する。
pub fn draw(
    frame: &mut Frame,
    config: &Config,
    line: Option<&DisplayLine>,
    position: usize,
    total: usize,
    is_at_end: bool,
) {
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(40), Constraint::Percentage(60)])
        .split(frame.area());

    draw_placeholder(frame, columns[0], config);
    draw_text(frame, columns[1], config, line, position, total, is_at_end);
}

/// 左側: 画像プレースホルダ（罫線で囲った空き領域、または中央にラベル文字列）。
fn draw_placeholder(frame: &mut Frame, area: Rect, config: &Config) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(config.game_name.as_str());

    let label = match config.placeholder.style {
        PlaceholderStyle::Blank => "",
        PlaceholderStyle::Label => config.placeholder.label.as_str(),
    };

    let paragraph = Paragraph::new(label)
        .block(block)
        .alignment(Alignment::Center);
    frame.render_widget(paragraph, area);
}

/// 右側: 話者名 + 本文。話者がプレイヤー側かどうかで文字色を出し分ける
/// （`Config::color_name_for` に判定を委譲する）。
fn draw_text(
    frame: &mut Frame,
    area: Rect,
    config: &Config,
    line: Option<&DisplayLine>,
    position: usize,
    total: usize,
    is_at_end: bool,
) {
    let title = if is_at_end {
        format!("{position}/{total} (END)")
    } else {
        format!("{position}/{total}")
    };
    let block = Block::default().borders(Borders::ALL).title(title);

    let text = match line {
        None => Text::from("(会話行がありません)"),
        Some(line) => {
            let color_name = config.color_name_for(line.speaker.as_deref());
            let color = Color::from_str(color_name).unwrap_or(Color::White);
            let style = Style::default().fg(color);

            let mut rendered = Vec::new();
            if let Some(speaker) = &line.speaker {
                rendered.push(Line::styled(
                    speaker.clone(),
                    style.add_modifier(Modifier::BOLD),
                ));
            }
            for text_line in &line.text {
                rendered.push(Line::styled(text_line.clone(), style));
            }
            Text::from(rendered)
        }
    };

    let paragraph = Paragraph::new(text).block(block).wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}
