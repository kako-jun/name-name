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
}
