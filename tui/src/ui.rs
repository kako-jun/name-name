//! ratatui による画面描画。左に画像プレースホルダ、右に相手（上）/自分（下）の2ウィンドウで
//! テキストを表示する。左右50/50・テキスト側はさらに上下50/50 に分割する GUI版
//! （`frontend/src/game/novelLayout.ts` の `computeSplitLayoutRegions` /
//! `splitTextRegionForDualWindow`）と同じジオメトリを踏襲する（#480）。GUI版の dual-window は
//! 常に borderless のため、こちらも罫線の枠は描かない。話者名ラベルも表示しない — 話者識別は
//! 「上下どちらの窓か」（位置）と `Config::color_name_for` の文字色で行う。

use std::str::FromStr;
use std::time::Instant;

use jiwa::{PulseHandle, Rgb};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::config::{Config, PlaceholderStyle};
use crate::playback::DisplayLine;
use crate::reveal;

/// 画面全体を左（画像プレースホルダ）50% / 右（テキスト、相手=上/自分=下にさらに50/50分割）に
/// 分割して描画する。最下段1行は進行状況（ゲーム名 + 会話位置/総数）専用の帯にする — 罫線の
/// title として表示していた情報を、枠を使わず最小限の形で残すためのもの（過剰な装飾はしない）。
///
/// `reveal` は現在の会話行のタイプライター表示状態（[`reveal::RevealState`]、`None` は行
/// そのものが無いケース）、`pulse` はページ送りインジケータ（reveal 完了後にのみ表示する）、
/// `now` はこのフレームの描画時刻（`reveal`/`pulse` の `snapshot`/`body_lines` に渡す基準時刻。
/// `RevealState::Done` はこれを無視する）。
#[allow(clippy::too_many_arguments)]
pub fn draw(
    frame: &mut Frame,
    config: &Config,
    line: Option<&DisplayLine>,
    position: usize,
    total: usize,
    is_at_end: bool,
    reveal: Option<&reveal::RevealState>,
    pulse: &PulseHandle,
    now: Instant,
) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(frame.area());

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(root[0]);

    draw_placeholder(frame, columns[0], config);
    draw_text_windows(frame, columns[1], config, line, reveal, pulse, now);
    draw_status_line(frame, root[1], config, position, total, is_at_end);
}

/// 左側: 画像プレースホルダ（罫線なし。中央にラベル文字列、または空欄）。
fn draw_placeholder(frame: &mut Frame, area: Rect, config: &Config) {
    let label = match config.placeholder.style {
        PlaceholderStyle::Blank => "",
        PlaceholderStyle::Label => config.placeholder.label.as_str(),
    };

    let paragraph = Paragraph::new(label).alignment(Alignment::Center);
    frame.render_widget(paragraph, area);
}

/// スプラッシュ画面: `config.splash.lines` に設定されたロゴ行を画面中央に表示する。
/// ロゴの内容はゲームごとに異なるため、このエンジン側は「中央寄せして表示する」
/// という汎用的な描画だけを担い、内容そのものは持たない（`Config::splash` 参照）。
pub fn draw_splash(frame: &mut Frame, config: &Config) {
    let area = frame.area();
    let block = Block::default()
        .borders(Borders::ALL)
        .title(config.game_name.as_str());
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let color = Color::from_str(&config.splash.color).unwrap_or(Color::White);
    let style = Style::default().fg(color);

    let mut lines: Vec<Line> = config
        .splash
        .lines
        .iter()
        .map(|text_line| Line::styled(text_line.clone(), style))
        .collect();
    lines.push(Line::raw(""));
    lines.push(Line::styled(
        "Enter / Space で開始",
        Style::default().add_modifier(Modifier::DIM),
    ));

    // 縦方向中央寄せ: ratatui の Paragraph は縦方向の中央寄せを持たないため、
    // ロゴ全体の高さから上マージンを計算して描画領域をずらす。
    let content_height = lines.len() as u16;
    let top_margin = inner.height.saturating_sub(content_height) / 2;
    let centered = Rect {
        x: inner.x,
        y: inner.y.saturating_add(top_margin),
        width: inner.width,
        height: inner.height.saturating_sub(top_margin),
    };

    let paragraph = Paragraph::new(Text::from(lines)).alignment(Alignment::Center);
    frame.render_widget(paragraph, centered);
}

/// 右側をさらに上（相手）/下（自分）50/50 に分割し、現在の会話行の話者側のウィンドウにだけ
/// 本文を描画する（GUI版 `splitTextRegionForDualWindow`: 相手=上/自分=下、#480）。話者が
/// `config.player_speakers` に含まれる場合のみ「自分」（下窓）、それ以外（Narration の
/// 話者不明を含む — GUI版 `resolveDualWindowIsSelf` が話者不明を相手側に倒すのと同じ規則）は
/// 「相手」（上窓）に描く。話者側でない方の窓は空のまま（前回発言のログ表示はスコープ外）。
///
/// 本文は `reveal`（[`reveal::RevealState`]）が与えられていれば `RevealState::body_lines` から
/// 組み立て（`Animating` はタイプライター表示のスナップショット、`Done` はスキップ済みの全文）、
/// reveal 完了後は `pulse`（`jiwa::PulseHandle`）によるページ送りインジケータを行末に付け足す。
/// `reveal` が `None`（会話行そのものが無い等）の場合は従来どおりの静的表示にフォールバックする。
fn draw_text_windows(
    frame: &mut Frame,
    area: Rect,
    config: &Config,
    line: Option<&DisplayLine>,
    reveal: Option<&reveal::RevealState>,
    pulse: &PulseHandle,
    now: Instant,
) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);
    let opponent_area = rows[0];
    let self_area = rows[1];

    let Some(line) = line else {
        let paragraph = Paragraph::new("(会話行がありません)").wrap(Wrap { trim: false });
        frame.render_widget(paragraph, opponent_area);
        return;
    };

    let is_self_speaker = line
        .speaker
        .as_deref()
        .is_some_and(|speaker| config.is_player_speaker(speaker));
    let target_area = if is_self_speaker {
        self_area
    } else {
        opponent_area
    };

    let color_name = config.color_name_for(line.speaker.as_deref());
    let color = Color::from_str(color_name).unwrap_or(Color::White);
    let style = Style::default().fg(color);

    let mut rendered = Vec::new();
    match reveal {
        Some(state) => {
            let mut body_lines = state.body_lines(now);
            if state.is_done(now) {
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

    let paragraph = Paragraph::new(Text::from(rendered)).wrap(Wrap { trim: false });
    frame.render_widget(paragraph, target_area);
}

/// 画面最下段1行: ゲーム名 + 会話位置/総数（+ 終端マーカー）。枠の title として表示していた
/// 情報を、枠なし化後もユーザーが状況を把握できるよう右寄せの単なる1行テキストとして残す
/// （罫線・背景等の装飾は付けない）。
fn draw_status_line(
    frame: &mut Frame,
    area: Rect,
    config: &Config,
    position: usize,
    total: usize,
    is_at_end: bool,
) {
    let status = if is_at_end {
        format!("{} — {position}/{total} (END)", config.game_name)
    } else {
        format!("{} — {position}/{total}", config.game_name)
    };
    let paragraph = Paragraph::new(status)
        .style(Style::default().add_modifier(Modifier::DIM))
        .alignment(Alignment::Right);
    frame.render_widget(paragraph, area);
}

/// reveal 完了後の入力待ちを示すページ送りインジケータ（既定では ▼）を、本文の最終行の
/// 末尾に付け足す。本文行が1つも無い（空の会話行）場合は、インジケータだけの行を追加する。
/// 表示中（未 reveal）にはこの関数を呼ばない — 呼び出し側（`draw_text_windows`）が
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
    fn status_line_shows_end_marker_when_at_end() {
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
    fn status_line_omits_end_marker_when_not_at_end() {
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
        // 左右 Percentage(50/50)・テキスト側の上下 Percentage(50/50) がいずれも
        // width/height=1 (50% が 0 に丸まる) で panic しないことを確認する。
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
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
        let reveal = reveal::RevealState::Animating(reveal::build_reveal(&config, &line, now));
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
        let typing_reveal =
            reveal::RevealState::Animating(reveal::build_reveal(&typing_config, &line, now));
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
        let done_reveal =
            reveal::RevealState::Animating(reveal::build_reveal(&done_config, &line, now));
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

    /// バッファを行ごとのテキストに変換する（`buffer_text` の行分割版）。
    /// ページ送りインジケータがどの行に付いているかを確認するテストで使う。
    fn buffer_rows(buffer: &Buffer) -> Vec<String> {
        let area = buffer.area();
        (0..area.height)
            .map(|y| {
                let mut row = String::new();
                let mut x = 0u16;
                while x < area.width {
                    let symbol = buffer.cell((x, y)).expect("in bounds").symbol();
                    row.push_str(symbol);
                    x += symbol.cell_width().max(1);
                }
                row
            })
            .collect()
    }

    #[test]
    fn draw_empty_text_dialog_with_done_reveal_shows_only_indicator() {
        let config = Config::default();
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec![],
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
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
        assert!(
            text.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "buffer was: {text}"
        );
    }

    #[test]
    fn page_indicator_attaches_to_last_line_of_multiline_body() {
        let config = Config::default();
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["first line".to_string(), "second line".to_string()],
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let pulse = reveal::build_pulse(now);
        let mut terminal = Terminal::new(TestBackend::new(60, 10)).unwrap();
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
        let rows = buffer_rows(terminal.backend().buffer());
        let indicator_row = rows
            .iter()
            .find(|r| r.contains(reveal::PAGE_INDICATOR_SYMBOL));
        assert!(indicator_row.is_some(), "rows were: {rows:?}");
        assert!(
            indicator_row.unwrap().contains("second line"),
            "indicator should be attached to the last body line, rows were: {rows:?}"
        );
        let first_line_row = rows
            .iter()
            .find(|r| r.contains("first line"))
            .expect("first line should be rendered");
        assert!(
            !first_line_row.contains(reveal::PAGE_INDICATOR_SYMBOL),
            "indicator must not appear on a non-last line, rows were: {rows:?}"
        );
    }

    #[test]
    fn draw_does_not_panic_at_height_one() {
        let config = Config::default();
        let line = DisplayLine {
            speaker: Some("A".to_string()),
            text: vec!["hi".to_string()],
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let pulse = reveal::build_pulse(now);
        let mut terminal = Terminal::new(TestBackend::new(40, 1)).unwrap();
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
    fn draw_splash_renders_configured_logo_lines() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田田田".to_string(), "回回回".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        terminal.draw(|f| draw_splash(f, &config)).unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("田田田"), "buffer was: {text}");
        assert!(text.contains("回回回"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_renders_continue_hint() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        terminal.draw(|f| draw_splash(f, &config)).unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("Enter"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_shows_game_name_as_title() {
        let mut config = Config::default();
        config.game_name = "テストゲーム".to_string();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        terminal.draw(|f| draw_splash(f, &config)).unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("テストゲーム"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_extremely_small_terminal_does_not_panic() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田田田田田田田田田田".to_string(); 20];
        let mut terminal = Terminal::new(TestBackend::new(1, 1)).unwrap();
        terminal.draw(|f| draw_splash(f, &config)).unwrap();
    }

    #[test]
    fn draw_splash_invalid_color_name_falls_back_to_white_without_panic() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        config.splash.color = "not-a-real-color".to_string();
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        terminal.draw(|f| draw_splash(f, &config)).unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("田"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_content_fits_exactly_shows_hint() {
        // ロゴ1行 + 空行1行 + ヒント1行 = content_height 3。
        // Borders::ALL は上下1セルずつ占有するため、area.height=5 のとき
        // inner.height もちょうど3になり、余白ゼロで全行が収まる境界。
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 5)).unwrap();
        terminal.draw(|f| draw_splash(f, &config)).unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("Enter"), "buffer was: {text}");
    }

    #[test]
    fn draw_splash_content_overflows_by_one_line_does_not_panic() {
        // 上のテストから area.height を1減らし、inner.height が content_height より
        // 1行分小さい状態（ヒント行が収まりきらない）を作る。ratatui の Paragraph は
        // wrap 未指定でも収まらない行を静かに切り詰めるだけで panic しないことの確認。
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["田".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 4)).unwrap();
        terminal.draw(|f| draw_splash(f, &config)).unwrap();
    }

    #[test]
    fn draw_splash_mixed_width_line_renders_without_panic() {
        let mut config = Config::default();
        config.splash.enabled = true;
        config.splash.lines = vec!["AB田C".to_string()];
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        terminal.draw(|f| draw_splash(f, &config)).unwrap();
        let text = buffer_text(terminal.backend().buffer());
        assert!(text.contains("AB田C"), "buffer was: {text}");
    }

    // ---- #480: 画面分割(50/50・プレイヤー/相手ウィンドウ分離・枠なし)のテスト ----
    //
    // ratatui 0.30.2 の `Layout::split` は `Constraint::Percentage(50)/Percentage(50)` を
    // 奇数サイズに適用したとき前者(左/上)が切り上げ・後者(右/下)が切り捨てになる（cargo test
    // で `Layout::split` の戻り値を直接ダンプして実測・確認済み）。この非対称は `draw()` の
    // 2段の分割（左右 columns、テキスト側 rows）双方に効き、特にテキスト側 rows split は
    // ステータス行を引いた残り高さに対して掛かるため、端末高さが偶数のとき self(下/自分)窓が
    // opponent(上/相手)窓より恒常的に1行少なくなる（H=2 では self が高さ0で消える）。
    // これはバグ修正ではなく、現状の挙動を固定する characterization test。

    /// テスト用に `DisplayLine` を組み立てる（19本のテストケースで多用するための局所ヘルパー）。
    fn dialog_line(speaker: Option<&str>, text: Vec<&str>) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: text.into_iter().map(|s| s.to_string()).collect(),
        }
    }

    /// `draw()` を指定サイズの `TestBackend` に1回描画し、結果バッファを返す簡易ヘルパー。
    /// `position`/`total`/`is_at_end` はレイアウト・話者振り分けの検証には無関係なので固定値
    /// （タイムスタンプに依存する `reveal::RevealState::Animating` の状態遷移テストは、この
    /// ヘルパーを使わず既存テストと同じ手書きスタイルで `now` を共有する）。
    fn render(
        config: &Config,
        line: Option<&DisplayLine>,
        reveal: Option<&reveal::RevealState>,
        width: u16,
        height: u16,
    ) -> Buffer {
        let now = Instant::now();
        let pulse = reveal::build_pulse(now);
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|f| draw(f, config, line, 1, 1, false, reveal, &pulse, now))
            .unwrap();
        terminal.backend().buffer().clone()
    }

    /// バッファの1行を、x座標の範囲を絞ってテキスト化する（`buffer_rows` の列範囲限定版）。
    /// 左側プレースホルダ列と右側テキスト列は同じ行(y)を共有するため、「テキスト側の窓が
    /// 空かどうか」を見るテストは行全体ではなく列範囲を絞って判定する必要がある
    /// （プレースホルダ列の内容が行頭に混ざって誤判定になるのを避ける）。
    fn buffer_rows_in_x_range(buffer: &Buffer, x_start: u16, x_end: u16) -> Vec<String> {
        let area = buffer.area();
        (0..area.height)
            .map(|y| {
                let mut row = String::new();
                let mut x = x_start;
                while x < x_end {
                    let symbol = buffer.cell((x, y)).expect("in bounds").symbol();
                    row.push_str(symbol);
                    x += symbol.cell_width().max(1);
                }
                row
            })
            .collect()
    }

    /// 指定した行 (y) のテキスト列（x_start以降）の中で最初に非空白文字が現れるセルの
    /// 前景色を返す。話者識別が文字色（`Config::color_name_for`）で行われることを検証する
    /// テストで使う。左側プレースホルダ列を除外するため x_start を指定する。
    fn first_colored_cell_in_row(buffer: &Buffer, y: u16, x_start: u16) -> Option<Color> {
        let area = buffer.area();
        (x_start..area.width).find_map(|x| {
            let cell = buffer.cell((x, y)).expect("in bounds");
            if cell.symbol() == " " {
                None
            } else {
                Some(cell.fg)
            }
        })
    }

    // -- A. 話者振り分け --

    #[test]
    fn player_speaker_text_renders_in_bottom_half_of_screen() {
        // H=11(奇数) → root[0].height=10(偶数) → テキスト側 rows split はちょうど半分
        // (opponent=5行/self=5行) になる、行位置の判定がぶれない対称ケースを選んでいる。
        let config = Config {
            player_speakers: vec!["Player".to_string()],
            ..Config::default()
        };
        let line = dialog_line(Some("Player"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 11);
        let rows = buffer_rows(&buffer);
        assert!(
            rows[5..10].iter().any(|r| r.contains("hello")),
            "player speaker text should render in the bottom half, rows were: {rows:?}"
        );
        assert!(
            !rows[0..5].iter().any(|r| r.contains("hello")),
            "player speaker text must not leak into the top half, rows were: {rows:?}"
        );
    }

    #[test]
    fn opponent_speaker_text_renders_in_top_half_of_screen() {
        let config = Config::default(); // player_speakers = ["主格"]
        let line = dialog_line(Some("相手"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 11);
        let rows = buffer_rows(&buffer);
        assert!(
            rows[0..5].iter().any(|r| r.contains("hello")),
            "unmatched speaker text should render in the top half, rows were: {rows:?}"
        );
        assert!(
            !rows[5..10].iter().any(|r| r.contains("hello")),
            "unmatched speaker text must not leak into the bottom half, rows were: {rows:?}"
        );
    }

    #[test]
    fn narration_none_speaker_renders_in_top_half_with_narration_color() {
        let config = Config::default();
        let line = dialog_line(None, vec!["ナレーション"]);
        let buffer = render(&config, Some(&line), None, 40, 11);
        let rows = buffer_rows(&buffer);
        let hit_row = rows[0..5].iter().position(|r| r.contains("ナレーション"));
        assert!(
            hit_row.is_some(),
            "narration text should render in the top half, rows were: {rows:?}"
        );
        assert!(
            !rows[5..10].iter().any(|r| r.contains("ナレーション")),
            "narration text must not leak into the bottom half, rows were: {rows:?}"
        );
        let y = hit_row.unwrap() as u16;
        // 左側プレースホルダ列(x<20)を避け、テキスト列(x>=20)だけを見る。
        let color = first_colored_cell_in_row(&buffer, y, 20)
            .expect("a colored cell should exist on the narration row");
        assert_eq!(
            color,
            Color::Gray,
            "None(Narration) speaker should use colors.narration (default: gray)"
        );
    }

    #[test]
    fn player_speaker_leaves_opponent_top_window_completely_blank() {
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 11);
        // テキスト列(x>=20)だけを見る。左側プレースホルダ列は話者に関わらず常に何か描画する
        // ため、行全体で判定すると誤検知する。
        let rows = buffer_rows_in_x_range(&buffer, 20, 40);
        assert!(
            rows[0..5].iter().all(|r| r.trim().is_empty()),
            "opponent(top) text window must be entirely blank while the player speaks, rows were: {rows:?}"
        );
    }

    #[test]
    fn opponent_speaker_leaves_self_bottom_window_completely_blank() {
        let config = Config::default();
        let line = dialog_line(Some("相手"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 11);
        let rows = buffer_rows_in_x_range(&buffer, 20, 40);
        assert!(
            rows[5..10].iter().all(|r| r.trim().is_empty()),
            "self(bottom) text window must be entirely blank while an opponent speaks, rows were: {rows:?}"
        );
    }

    // -- B. 同値分割 --

    #[test]
    fn empty_player_speakers_list_routes_all_named_speakers_to_top_window() {
        // player_speakers を空にすると、デフォルトなら player 側になる名前（"主格"）も
        // 相手(上)側に落ちる（`Config::is_player_speaker` は空リストで常に false を返す）。
        let config = Config {
            player_speakers: vec![],
            ..Config::default()
        };
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 11);
        let rows = buffer_rows(&buffer);
        assert!(
            rows[0..5].iter().any(|r| r.contains("hello")),
            "with an empty player_speakers list, even the default player name should go to the top window, rows were: {rows:?}"
        );
        assert!(
            !rows[5..10].iter().any(|r| r.contains("hello")),
            "rows were: {rows:?}"
        );
    }

    // -- C. 境界値 --

    #[test]
    fn even_terminal_height_makes_self_window_one_row_shorter_than_opponent() {
        // H=4(偶数) → root[0].height=3(ステータス行1を引いた残り) → テキスト側 rows split は
        // 3の奇数丸めで opponent(上)=2行・self(下)=1行の非対称になる。Rect を直接覗く代わりに、
        // 2行の本文を与えたとき何行まで収まるかで高さを実測する。
        let config = Config::default();
        let text = vec!["line1", "line2"];

        let opponent_line = dialog_line(Some("相手"), text.clone());
        let opponent_buffer = render(&config, Some(&opponent_line), None, 40, 4);
        let opponent_text = buffer_text(&opponent_buffer);
        assert!(
            opponent_text.contains("line1"),
            "buffer was: {opponent_text}"
        );
        assert!(
            opponent_text.contains("line2"),
            "opponent window (height 2) should fit both lines, buffer was: {opponent_text}"
        );

        let self_line = dialog_line(Some("主格"), text);
        let self_buffer = render(&config, Some(&self_line), None, 40, 4);
        let self_text = buffer_text(&self_buffer);
        assert!(self_text.contains("line1"), "buffer was: {self_text}");
        assert!(
            !self_text.contains("line2"),
            "self window (height 1) should clip the second line, buffer was: {self_text}"
        );
    }

    #[test]
    fn terminal_height_two_collapses_self_window_to_zero_height() {
        // H=2 → root[0].height=1 → テキスト側 rows split(1) は opponent=1/self=0 になり、
        // プレイヤー発言(self窓)は実質どこにも描画されなくなる。
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 2);
        let text = buffer_text(&buffer);
        assert!(
            !text.contains("hello"),
            "self window has height 0 at H=2, player text must not render anywhere, buffer was: {text}"
        );
    }

    #[test]
    fn odd_terminal_height_splits_text_area_evenly() {
        // H=3(奇数) → root[0].height=2(偶数) → テキスト側 rows split はちょうど半分に割れ、
        // opponent(上)=1行・self(下)=1行の対称になる。H=4 の非対称（1つ上のテスト）と対を成す
        // 対比ケース。
        let config = Config::default();
        let text = vec!["line1", "line2"];

        let opponent_line = dialog_line(Some("相手"), text.clone());
        let opponent_buffer = render(&config, Some(&opponent_line), None, 40, 3);
        let opponent_text = buffer_text(&opponent_buffer);
        assert!(
            opponent_text.contains("line1"),
            "buffer was: {opponent_text}"
        );
        assert!(
            !opponent_text.contains("line2"),
            "opponent window should also be height 1 at H=3 (symmetric with self), buffer was: {opponent_text}"
        );

        let self_line = dialog_line(Some("主格"), text);
        let self_buffer = render(&config, Some(&self_line), None, 40, 3);
        let self_text = buffer_text(&self_buffer);
        assert!(self_text.contains("line1"), "buffer was: {self_text}");
        assert!(
            !self_text.contains("line2"),
            "self window should be height 1 at H=3, buffer was: {self_text}"
        );
    }

    #[test]
    fn terminal_height_one_shows_status_line_only_no_body_content() {
        // H=1 → root[0].height=0 → プレースホルダもテキストも描画領域が消え、
        // 最下段のステータス行だけが残る。
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 1);
        let text = buffer_text(&buffer);
        assert!(
            text.contains(&config.game_name),
            "status line should still render, buffer was: {text}"
        );
        assert!(
            !text.contains("hello"),
            "body content must not render when height=1, buffer was: {text}"
        );
    }

    #[test]
    fn odd_terminal_width_gives_placeholder_column_the_extra_cell() {
        // W=7(奇数) → 左右 Percentage(50/50) は左(プレースホルダ)=ceil(7/2)=4・
        // 右(テキスト)=floor(7/2)=3 に丸まる。テキスト側に単一ASCII文字を描画させ、
        // その先頭セルの x 座標がその境界(x=4)と一致することで実測する。
        //
        // フォールバック文言「(会話行がありません)」は全角文字を含み、この幅では
        // ratatui 側の Paragraph 折り返し処理がバッファ範囲外書き込みで panic する
        // （`ratatui_widgets::paragraph::render_line` → `Buffer::index_mut` の既存バグ、
        // #480 の分割ロジックとは無関係）ため、境界計測にはこの経路を使わない。
        let config = Config::default();
        let line = dialog_line(Some("A"), vec!["Y"]); // "A" は player_speakers 非該当=opponent(上)
        let buffer = render(&config, Some(&line), None, 7, 10);
        let area = buffer.area();
        let mut leftmost_y_x = None;
        'outer: for y in 0..area.height {
            for x in 0..area.width {
                if buffer.cell((x, y)).expect("in bounds").symbol() == "Y" {
                    leftmost_y_x = Some(x);
                    break 'outer;
                }
            }
        }
        let x = leftmost_y_x.expect("text should render somewhere");
        assert_eq!(
            x, 4,
            "text column should start at x=4 (ceil(7/2)) when width=7 splits 50/50; found at x={x}"
        );
    }

    // -- D. null/空/未設定 --

    #[test]
    fn no_display_line_renders_placeholder_message_in_top_window_only() {
        let config = Config::default();
        let buffer = render(&config, None, None, 40, 11);
        let rows = buffer_rows(&buffer);
        assert!(
            rows[0..5].iter().any(|r| r.contains("会話行がありません")),
            "fallback message should render in the top window, rows were: {rows:?}"
        );
        let text_rows = buffer_rows_in_x_range(&buffer, 20, 40);
        assert!(
            text_rows[5..10].iter().all(|r| r.trim().is_empty()),
            "self(bottom) text window should stay blank when there is no display line, rows were: {text_rows:?}"
        );
    }

    #[test]
    fn empty_text_vec_with_player_speaker_shows_indicator_only_in_bottom_window() {
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec![]);
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let buffer = render(&config, Some(&line), Some(&reveal), 40, 11);
        let rows = buffer_rows(&buffer);
        assert!(
            rows[5..10]
                .iter()
                .any(|r| r.contains(reveal::PAGE_INDICATOR_SYMBOL)),
            "page indicator should render in the bottom window for an empty player line, rows were: {rows:?}"
        );
        let text_rows = buffer_rows_in_x_range(&buffer, 20, 40);
        assert!(
            text_rows[0..5].iter().all(|r| r.trim().is_empty()),
            "opponent(top) text window should stay blank, rows were: {text_rows:?}"
        );
    }

    // -- E. 状態遷移 --

    #[test]
    fn player_speaker_typewriter_reveal_shows_partial_text_in_bottom_window() {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 1000; // 十分長い間隔で確実に「一部だけ表示」を作る
        config.typewriter.fade_duration_ms = 0;
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let now = Instant::now();
        let reveal = reveal::RevealState::Animating(reveal::build_reveal(&config, &line, now));
        let pulse = reveal::build_pulse(now);
        let mut terminal = Terminal::new(TestBackend::new(40, 11)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    Some(&line),
                    1,
                    1,
                    false,
                    Some(&reveal),
                    &pulse,
                    now,
                )
            })
            .unwrap();
        let rows = buffer_rows(terminal.backend().buffer());
        assert!(
            rows[5..10].iter().any(|r| r.contains('h')),
            "the first revealed grapheme should render in the bottom window, rows were: {rows:?}"
        );
        assert!(
            !rows[5..10].iter().any(|r| r.contains("hello")),
            "text should still be partial (typewriter in progress), rows were: {rows:?}"
        );
        assert!(
            !rows[0..5].iter().any(|r| r.contains('h')),
            "typewriter text must not leak into the top window, rows were: {rows:?}"
        );
    }

    #[test]
    fn player_speaker_page_indicator_appears_only_after_done_in_bottom_window() {
        let line = dialog_line(Some("主格"), vec!["hello"]);
        let now = Instant::now();

        // 表示中（未完了）は下窓にもインジケータは出ない。
        let mut typing_config = Config::default();
        typing_config.typewriter.char_interval_ms = 1000;
        typing_config.typewriter.fade_duration_ms = 0;
        let typing_reveal =
            reveal::RevealState::Animating(reveal::build_reveal(&typing_config, &line, now));
        let typing_pulse = reveal::build_pulse(now);
        let mut typing_terminal = Terminal::new(TestBackend::new(40, 11)).unwrap();
        typing_terminal
            .draw(|f| {
                draw(
                    f,
                    &typing_config,
                    Some(&line),
                    1,
                    1,
                    false,
                    Some(&typing_reveal),
                    &typing_pulse,
                    now,
                )
            })
            .unwrap();
        let typing_rows = buffer_rows(typing_terminal.backend().buffer());
        assert!(
            !typing_rows
                .iter()
                .any(|r| r.contains(reveal::PAGE_INDICATOR_SYMBOL)),
            "rows were: {typing_rows:?}"
        );

        // 完了後は下窓(self)にのみインジケータが出る。
        let mut done_config = Config::default();
        done_config.typewriter.char_interval_ms = 0;
        done_config.typewriter.fade_duration_ms = 0;
        let done_reveal =
            reveal::RevealState::Animating(reveal::build_reveal(&done_config, &line, now));
        let done_pulse = reveal::build_pulse(now);
        let mut done_terminal = Terminal::new(TestBackend::new(40, 11)).unwrap();
        done_terminal
            .draw(|f| {
                draw(
                    f,
                    &done_config,
                    Some(&line),
                    1,
                    1,
                    false,
                    Some(&done_reveal),
                    &done_pulse,
                    now,
                )
            })
            .unwrap();
        let done_rows = buffer_rows(done_terminal.backend().buffer());
        assert!(
            done_rows[5..10]
                .iter()
                .any(|r| r.contains(reveal::PAGE_INDICATOR_SYMBOL)),
            "rows were: {done_rows:?}"
        );
        assert!(
            !done_rows[0..5]
                .iter()
                .any(|r| r.contains(reveal::PAGE_INDICATOR_SYMBOL)),
            "rows were: {done_rows:?}"
        );
    }

    // -- F. i18n/文字種混在 --

    #[test]
    fn long_single_line_wraps_within_half_height_window_without_bleeding_into_other_window() {
        let config = Config::default();
        let long_text = "a".repeat(45); // テキスト列幅20 → opponent窓(高さ5)内に折り返される
        let line = dialog_line(Some("相手"), vec![long_text.as_str()]);
        let buffer = render(&config, Some(&line), None, 40, 11);
        let rows = buffer_rows(&buffer);
        let opponent_as: usize = rows[0..5].iter().map(|r| r.matches('a').count()).sum();
        let self_as: usize = rows[5..10].iter().map(|r| r.matches('a').count()).sum();
        assert_eq!(
            opponent_as, 45,
            "all wrapped characters should land in the opponent(top) window, rows were: {rows:?}"
        );
        assert_eq!(
            self_as, 0,
            "wrapped continuation must not bleed into the self(bottom) window, rows were: {rows:?}"
        );
    }

    #[test]
    fn fullwidth_speaker_name_matches_player_list_exactly_routes_to_bottom() {
        // Config::default() の player_speakers は実運用の gymnasia 設定値である全角 "主格"。
        // config.rs 側の文字列一致の単体テストとは別に、描画パイプライン全体を通しても
        // このデフォルト値がそのまま下窓にルーティングされることを確認する。
        let config = Config::default();
        let line = dialog_line(Some("主格"), vec!["台詞"]);
        let buffer = render(&config, Some(&line), None, 40, 11);
        let rows = buffer_rows(&buffer);
        assert!(
            rows[5..10].iter().any(|r| r.contains("台詞")),
            "rows were: {rows:?}"
        );
        assert!(
            !rows[0..5].iter().any(|r| r.contains("台詞")),
            "rows were: {rows:?}"
        );
    }

    // -- G. 退行防止（過去の事故パターンの固定化） --

    #[test]
    fn dual_window_output_never_contains_border_line_characters() {
        // #480 で Borders::ALL を撤去した（枠なし化）。box-drawing 文字が復活していないことを
        // 固定する退行防止テスト。
        let config = Config::default();
        let line = dialog_line(Some("A"), vec!["hi"]);
        let buffer = render(&config, Some(&line), None, 40, 10);
        let text = buffer_text(&buffer);
        for border_char in ['│', '─', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼']
        {
            assert!(
                !text.contains(border_char),
                "border character {border_char:?} must not appear, buffer was: {text}"
            );
        }
    }

    #[test]
    fn dual_window_output_never_contains_speaker_name_label() {
        // #480 で話者名ラベル行の描画を撤去した。話者識別は窓の位置と文字色のみで行う設計を
        // 固定する退行防止テスト。
        let config = Config::default();
        let line = dialog_line(Some("すぴーかー"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 10);
        let text = buffer_text(&buffer);
        assert!(
            text.contains("hello"),
            "body text should still render, buffer was: {text}"
        );
        assert!(
            !text.contains("すぴーかー"),
            "speaker name must not appear as a separate label, buffer was: {text}"
        );
    }
}
