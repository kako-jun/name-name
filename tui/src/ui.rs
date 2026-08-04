//! ratatui による画面描画。左に画像プレースホルダ、右に話者名 + 本文を表示する
//! 左右セパレートレイアウト。

use std::str::FromStr;
use std::time::Instant;

use jiwa::{PulseHandle, RevealHandle, Rgb};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::config::{Config, PlaceholderStyle};
use crate::playback::DisplayLine;
use crate::reveal;

/// 画面全体を左（画像プレースホルダ）40% / 右（テキスト）60% に分割して描画する。
///
/// `reveal` は現在の会話行のタイプライター表示状態（`None` は行そのものが無いケース）、
/// `pulse` はページ送りインジケータ（reveal 完了後にのみ表示する）、`now` はこのフレームの
/// 描画時刻（`reveal`/`pulse` の `snapshot` に渡す基準時刻）。
#[allow(clippy::too_many_arguments)]
pub fn draw(
    frame: &mut Frame,
    config: &Config,
    line: Option<&DisplayLine>,
    position: usize,
    total: usize,
    is_at_end: bool,
    reveal: Option<&RevealHandle>,
    pulse: &PulseHandle,
    now: Instant,
) {
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(40), Constraint::Percentage(60)])
        .split(frame.area());

    draw_placeholder(frame, columns[0], config);
    draw_text(
        frame, columns[1], config, line, position, total, is_at_end, reveal, pulse, now,
    );
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
/// （`Config::color_name_for` に判定を委譲する）。本文は `reveal`（`jiwa::RevealHandle`）が
/// 与えられていればタイプライター表示のスナップショットから組み立て、reveal 完了後は
/// `pulse`（`jiwa::PulseHandle`）によるページ送りインジケータを行末に付け足す。`reveal` が
/// `None`（会話行そのものが無い等）の場合は従来どおりの静的表示にフォールバックする。
#[allow(clippy::too_many_arguments)]
fn draw_text(
    frame: &mut Frame,
    area: Rect,
    config: &Config,
    line: Option<&DisplayLine>,
    position: usize,
    total: usize,
    is_at_end: bool,
    reveal: Option<&RevealHandle>,
    pulse: &PulseHandle,
    now: Instant,
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
            match reveal {
                Some(handle) => {
                    let snapshot = handle.snapshot(now);
                    let mut body_lines = reveal::snapshot_to_lines(&snapshot);
                    if handle.is_done(now) {
                        append_page_indicator(&mut body_lines, pulse, now);
                    }
                    rendered.extend(body_lines);
                }
                None => {
                    for text_line in &line.text {
                        rendered.push(Line::styled(text_line.clone(), style));
                    }
                }
            }
            Text::from(rendered)
        }
    };

    let paragraph = Paragraph::new(text).block(block).wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

/// reveal 完了後の入力待ちを示すページ送りインジケータ（既定では ▼）を、本文の最終行の
/// 末尾に付け足す。本文行が1つも無い（空の会話行）場合は、インジケータだけの行を追加する。
/// 表示中（未 reveal）にはこの関数を呼ばない — 呼び出し側（`draw_text`）が
/// `handle.is_done(now)` で既にガードしている。
fn append_page_indicator(lines: &mut Vec<Line<'static>>, pulse: &PulseHandle, now: Instant) {
    let frame = pulse.snapshot(now);
    let Rgb(r, g, b) = frame.color;
    let span = Span::styled(
        format!(" {}", frame.text),
        Style::default().fg(Color::Rgb(r, g, b)),
    );
    match lines.last_mut() {
        Some(last) => last.spans.push(span),
        None => lines.push(Line::from(vec![span])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::{Buffer, CellWidth};
    use ratatui::Terminal;

    /// レンダリング済みバッファを行ごとのテキストに変換する。
    /// 全角文字（幅2セル）の次のセルは、直前のグラフェムを表示するために予約された
    /// 空セルであり内容を持たないため、`cell_width()` を見て読み飛ばす
    /// （そのまま連結すると「[画像]」が「[画 像 ]」のように空白混じりになってしまう）。
    fn buffer_text(buffer: &Buffer) -> String {
        let area = buffer.area();
        let mut out = String::new();
        for y in 0..area.height {
            let mut x = 0u16;
            while x < area.width {
                let symbol = buffer.cell((x, y)).expect("in bounds").symbol();
                out.push_str(symbol);
                x += symbol.cell_width().max(1);
            }
        }
        out
    }

    #[test]
    fn placeholder_label_style_renders_label_text() {
        let mut config = Config::default();
        config.placeholder.style = PlaceholderStyle::Label;
        config.placeholder.label = "[画像]".to_string();
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        let now = Instant::now();
        let pulse = reveal::build_pulse(now);
        terminal
            .draw(|f| draw(f, &config, None, 0, 0, true, None, &pulse, now))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("[画像]"), "buffer was: {text}");
    }

    #[test]
    fn placeholder_blank_style_renders_no_label_text() {
        let mut config = Config::default();
        config.placeholder.style = PlaceholderStyle::Blank;
        config.placeholder.label = "[画像]".to_string();
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        let now = Instant::now();
        let pulse = reveal::build_pulse(now);
        terminal
            .draw(|f| draw(f, &config, None, 0, 0, true, None, &pulse, now))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(!text.contains("[画像]"), "buffer was: {text}");
    }

    #[test]
    fn title_shows_end_marker_when_at_end() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        let now = Instant::now();
        let pulse = reveal::build_pulse(now);
        terminal
            .draw(|f| draw(f, &config, None, 1, 1, true, None, &pulse, now))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("(END)"), "buffer was: {text}");
    }

    #[test]
    fn title_omits_end_marker_when_not_at_end() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        let now = Instant::now();
        let pulse = reveal::build_pulse(now);
        terminal
            .draw(|f| draw(f, &config, None, 1, 2, false, None, &pulse, now))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(!text.contains("(END)"), "buffer was: {text}");
    }

    #[test]
    fn no_line_shows_placeholder_message() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        let now = Instant::now();
        let pulse = reveal::build_pulse(now);
        terminal
            .draw(|f| draw(f, &config, None, 0, 0, true, None, &pulse, now))
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("会話行がありません"), "buffer was: {text}");
    }

    #[test]
    fn extremely_narrow_terminal_does_not_panic() {
        let config = Config::default();
        let mut terminal = Terminal::new(TestBackend::new(1, 3)).unwrap();
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["hi".to_string()],
        };
        let now = Instant::now();
        // reveal 完了済み(=ページ送りインジケータも同時に描画される)状態でも、
        // Layout::Percentage(40/60) が width=1 (40% が 0 に丸まる) で panic しないことを確認する。
        let reveal = reveal::skip_reveal(&config, &line, now);
        let pulse = reveal::build_pulse(now);
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    1,
                    1,
                    true,
                    Some(&reveal),
                    &pulse,
                    now,
                )
            })
            .unwrap();
    }

    #[test]
    fn typewriter_reveal_shows_only_visible_graphemes_before_done() {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 1000; // 十分長い間隔で確実に「一部だけ表示」を作る
        config.typewriter.fade_duration_ms = 0;
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["hello".to_string()],
        };
        let now = Instant::now();
        let reveal = reveal::build_reveal(&config, &line, now);
        let pulse = reveal::build_pulse(now);
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    1,
                    1,
                    true,
                    Some(&reveal),
                    &pulse,
                    now,
                )
            })
            .unwrap();
        let text = buffer_text(terminal.backend().buffer());
        // t=0 では最初の1グラフェムしか見えない (jiwa::RevealHandle の仕様)。
        assert!(text.contains('h'), "buffer was: {text}");
        assert!(!text.contains("hello"), "buffer was: {text}");
    }

    #[test]
    fn page_indicator_is_absent_while_typing_and_present_once_done() {
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["hello".to_string()],
        };
        let now = Instant::now();

        // 表示中（char_interval を長くして確実に未完了にする）はインジケータが出ない。
        let mut typing_config = Config::default();
        typing_config.typewriter.char_interval_ms = 1000;
        typing_config.typewriter.fade_duration_ms = 0;
        let typing_reveal = reveal::build_reveal(&typing_config, &line, now);
        let typing_pulse = reveal::build_pulse(now);
        let mut typing_terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        typing_terminal
            .draw(|f| {
                draw(
                    f,
                    &typing_config,
                    Some(&line),
                    1,
                    1,
                    true,
                    Some(&typing_reveal),
                    &typing_pulse,
                    now,
                )
            })
            .unwrap();
        let typing_text = buffer_text(typing_terminal.backend().buffer());
        assert!(
            !typing_text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "buffer was: {typing_text}"
        );

        // char_interval=0 かつ fade_duration=0 は t=0 から即座に is_done() なので、
        // インジケータ側の「完了後だけ出す」挙動をスキップ機能無しで検証できる。
        let mut done_config = Config::default();
        done_config.typewriter.char_interval_ms = 0;
        done_config.typewriter.fade_duration_ms = 0;
        let done_reveal = reveal::build_reveal(&done_config, &line, now);
        let done_pulse = reveal::build_pulse(now);
        let mut done_terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        done_terminal
            .draw(|f| {
                draw(
                    f,
                    &done_config,
                    Some(&line),
                    1,
                    1,
                    true,
                    Some(&done_reveal),
                    &done_pulse,
                    now,
                )
            })
            .unwrap();
        let done_text = buffer_text(done_terminal.backend().buffer());
        assert!(
            done_text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "buffer was: {done_text}"
        );
    }
}
