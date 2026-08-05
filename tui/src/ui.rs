//! ratatui による画面描画。左にイベント絵（quadrant block変換 + jiwaクロスフェード、
//! `image_fade`/`image_render`、#481。未指定時は従来の画像プレースホルダにフォールバック）、
//! 右に相手（上）/自分（下）の2ウィンドウでテキストを表示する。左右は50/50（GUI版
//! `frontend/src/game/novelLayout.ts` の
//! `computeSplitLayoutRegions` と同じ比率、#480）。テキスト側の上下分割も比率としては50/50
//! だが、GUI版の `splitTextRegionForDualWindow` が浮動小数点で分割するのに対し、TUI版は
//! 整数セル単位のため高さが奇数のとき端数が出る。GUI版と違いこの端数は self（自分＝
//! プレイヤー発言側）に寄せる（`draw_text_windows` 参照）— self が opponent より恒常的に
//! 損をする片側固定バイアスを避けるための意図的な差異（セルフレビュー修正）。GUI版の
//! dual-window は常に borderless のため、こちらも罫線の枠は描かない。話者名ラベルも表示しない
//! — 話者識別は「上下どちらの窓か」（位置）と `Config::color_name_for` の文字色で行う。

use std::str::FromStr;
use std::time::Instant;

use jiwa::{PulseHandle, Rgb};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::config::{Config, PlaceholderStyle};
use crate::image_fade::ImageFadeState;
use crate::image_render::{ImageCache, RenderedImage};
use crate::playback::DisplayLine;
use crate::reveal;

/// 画面全体を左（画像プレースホルダ）50% / 右（テキスト、相手=上/自分=下にさらに分割）に
/// 分割して描画する。テキスト側の上下分割は整数セルの端数を self（自分）側に寄せる
/// （`draw_text_windows` 参照。opponent が恒常的に得をする片側固定バイアスを避けるため）。
/// 最下段1行は進行状況（ゲーム名 + 会話位置/総数）専用の帯にする — 罫線の title として
/// 表示していた情報を、枠を使わず最小限の形で残すためのもの（過剰な装飾はしない）。
///
/// `reveal` は現在の会話行のタイプライター表示状態（[`reveal::RevealState`]、`None` は行
/// そのものが無いケース）、`pulse` はページ送りインジケータ（reveal 完了後にのみ表示する）、
/// `now` はこのフレームの描画時刻（`reveal`/`pulse` の `snapshot`/`body_lines` に渡す基準時刻。
/// `RevealState::Done` はこれを無視する）。`image_fade` は左側に描画するイベント絵の
/// クロスフェード状態（[`ImageFadeState`]、`None` は event_image を一切扱わない呼び出し元
/// 向けのフォールバック）、`image_cache` はそのデコード結果キャッシュ（#481）。
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
    image_fade: Option<&ImageFadeState>,
    image_cache: &mut ImageCache,
) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(1)])
        .split(frame.area());

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(root[0]);

    let placeholder_area = columns[0];
    let rendered_image = image_fade.and_then(|state| {
        state.snapshot(
            image_cache,
            config,
            placeholder_area.width,
            placeholder_area.height,
            now,
        )
    });
    draw_placeholder(frame, placeholder_area, config, rendered_image.as_ref());
    draw_text_windows(frame, columns[1], config, line, reveal, pulse, now);
    draw_status_line(frame, root[1], config, position, total, is_at_end);
}

/// 左側: イベント絵（`image` が `Some` のとき、quadrant block グリッドとして描画）、または
/// 従来の画像プレースホルダ（`image` が `None` のとき、罫線なし・中央にラベル文字列/空欄）
/// （#481）。`image` が `None` になるのは、event_image が一度も設定されていないゲーム/
/// シーンを再生している場合（後方互換のフォールバック）。
fn draw_placeholder(frame: &mut Frame, area: Rect, config: &Config, image: Option<&RenderedImage>) {
    if let Some(grid) = image {
        draw_image_grid(frame, area, grid);
        return;
    }

    let label = match config.placeholder.style {
        PlaceholderStyle::Blank => "",
        PlaceholderStyle::Label => config.placeholder.label.as_str(),
    };

    let paragraph = Paragraph::new(label).alignment(Alignment::Center);
    frame.render_widget(paragraph, area);
}

/// quadrant block 変換済みのセル格子（[`RenderedImage`]）を、セルごとに fg/bg 付き `Span` の
/// `Paragraph` として描画する。`grid` の cols/rows は呼び出し側（`draw`）が `area` と同じ
/// 寸法で構築するが、万一のズレ（フレーム間の解像度取りこぼし等）に備え `area` の範囲へ
/// クランプし、範囲外アクセスで panic しないようにする。
fn draw_image_grid(frame: &mut Frame, area: Rect, grid: &RenderedImage) {
    let rows = grid.rows.min(area.height);
    let cols = grid.cols.min(area.width);
    let mut lines = Vec::with_capacity(rows as usize);
    for y in 0..rows {
        let mut spans = Vec::with_capacity(cols as usize);
        for x in 0..cols {
            let idx = y as usize * grid.cols as usize + x as usize;
            if let Some(cell) = grid.cells.get(idx) {
                let fg = Color::Rgb(cell.fg.0, cell.fg.1, cell.fg.2);
                let bg = Color::Rgb(cell.bg.0, cell.bg.1, cell.bg.2);
                spans.push(Span::styled(
                    cell.glyph.to_string(),
                    Style::default().fg(fg).bg(bg),
                ));
            }
        }
        lines.push(Line::from(spans));
    }
    let paragraph = Paragraph::new(Text::from(lines));
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

/// 右側をさらに上（相手）/下（自分）に分割し、現在の会話行の話者側のウィンドウにだけ
/// 本文を描画する（GUI版 `splitTextRegionForDualWindow`: 相手=上/自分=下、#480）。分割は
/// `Constraint::Length` で明示的に高さを計算し、opponent=`height / 2`（切り捨て）・
/// self=`height - opponent`（切り捨て分の端数を含む）とする — `Constraint::Percentage`
/// のペアだと ratatui は前者を切り上げ・後者を切り捨てるため、そのまま使うと self が
/// opponent より恒常的に1行少なくなる片側固定バイアスが生じる（セルフレビューで発見・修正）。
/// 話者が `config.player_speakers` に含まれる場合のみ「自分」（下窓）、それ以外（Narration の
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
    let opponent_height = area.height / 2; // 切り捨て
    let self_height = area.height - opponent_height; // 余りは self が受け取る（floor+余り=ceil相当）
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(opponent_height),
            Constraint::Length(self_height),
        ])
        .split(area);
    let opponent_area = rows[0];
    let self_area = rows[1];

    let Some(line) = line else {
        let paragraph = Paragraph::new("(会話行がありません)").wrap(Wrap { trim: false });
        render_wrapped_paragraph(frame, opponent_area, paragraph);
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
    render_wrapped_paragraph(frame, target_area, paragraph);
}

/// wrap 付き `Paragraph` を描画する際、危険な極小幅を避けるための下限セル数。
/// ratatui 0.30.2 / ratatui-widgets 0.3.2 は、半角/全角混在の文字列を `Wrap` 付き
/// `Paragraph` で描画する幅がちょうど2セルのとき、内部の折り返し計算がバッファ範囲外に
/// 書き込みpanicすることがある（`ratatui_widgets::paragraph::render_line` →
/// `Buffer::index_mut`）。実測では幅2セル・高さ2以上で複数の入力文字列
/// （例: フォールバック文言「(会話行がありません)」）について再現し、幅1セルおよび幅3セル
/// 以上では再現しなかった。依存クレート側の折り返し計算バグのためこちら側では直接修正
/// できず、危険な幅ではwrap描画そのものをスキップする防御的ガードとする。
const MIN_SAFE_TEXT_WRAP_WIDTH: u16 = 3;

/// [`MIN_SAFE_TEXT_WRAP_WIDTH`] 未満の極小幅では、ratatui内部のpanicを避けるため
/// `Paragraph` の描画自体をスキップする（何も描かない）。それ以外は通常どおり描画する。
fn render_wrapped_paragraph(frame: &mut Frame, area: Rect, paragraph: Paragraph<'_>) {
    if area.width < MIN_SAFE_TEXT_WRAP_WIDTH {
        return;
    }
    frame.render_widget(paragraph, area);
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

    /// `w`x`h` px の単色 RGBA バイト列を作る（テストフィクスチャ用）。
    fn solid_rgba(color: (u8, u8, u8), w: u32, h: u32) -> Vec<u8> {
        let mut buf = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            buf.extend_from_slice(&[color.0, color.1, color.2, 255]);
        }
        buf
    }

    /// `cols`x`rows`セル全域が確実に非空白グリフ('▞', fg=白/bg=黒)になるRGBA画像を
    /// WebPフィクスチャとして書き出す。各セル分の2x2サブピクセルが黒/白の対角パターン
    /// （UL/LR=黒, UR/LL=白）を繰り返す構成で、`image_render::quadrant_cell_from_subpixels`
    /// のテスト（`quadrant_cell_full_block_when_all_subpixels_are_maximally_different`）と
    /// 同じ入力パターンになるようにしている。
    fn diagonal_pattern_webp_fixture(cols: u16, rows: u16) -> std::path::PathBuf {
        let sub_w = cols as u32 * 2;
        let sub_h = rows as u32 * 2;
        let mut rgba = Vec::with_capacity((sub_w * sub_h * 4) as usize);
        for y in 0..sub_h {
            for x in 0..sub_w {
                let is_black = (x % 2) == (y % 2);
                let px = if is_black {
                    [0u8, 0, 0, 255]
                } else {
                    [255u8, 255, 255, 255]
                };
                rgba.extend_from_slice(&px);
            }
        }
        crate::image_render::write_test_webp_fixture(&rgba, sub_w, sub_h)
    }

    /// `image_fade` テスト用に `Config::event_image.assets_dir` をフィクスチャの置き場所へ
    /// 向け、`DisplayLine::event_image` と同じ形（ファイル名のみ）の相対パスを返す。
    fn config_and_relative_path_for(fixture_path: &std::path::Path) -> (Config, String) {
        let mut config = Config::default();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (config, relative)
    }

    // ---- #481 follow-up: draw() に Some(&ImageFadeState) を渡す統合テスト ----
    //
    // 既存テストは全て image_fade=None で呼んでおり、draw_image_grid が実際に呼ばれる
    // 経路（左カラムに quadrant block 文字が描かれる）は自動テストで一度も検証されて
    // いなかった（image_fade.rs/image_render.rs の純粋関数テストのみ）。以下はその穴を
    // 埋める、実在パスを resolve した `Some(&ImageFadeState)` 経由の統合テスト。

    #[test]
    fn draw_with_resolved_image_fade_renders_quadrant_glyphs_not_placeholder() {
        let fixture_path = diagonal_pattern_webp_fixture(5, 3);
        let (mut config, relative) = config_and_relative_path_for(&fixture_path);
        config.placeholder.label = "[画像]".to_string();
        let image_fade = ImageFadeState::settled(Some(relative));

        let mut terminal = Terminal::new(TestBackend::new(10, 4)).unwrap();
        let now = Instant::now();
        let pulse = reveal::build_pulse(now);
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    0,
                    0,
                    true,
                    None,
                    &pulse,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        // placeholder_area = columns[0] = 幅ceil(10/2)=5 x 高さ(4-1)=3。フィクスチャは
        // 全セルが対角パターンの '▞'（fg=白、bg=黒）になるよう作られている。
        for y in 0..3u16 {
            for x in 0..5u16 {
                let cell = buffer.cell((x, y)).expect("in bounds");
                assert_eq!(
                    cell.symbol(),
                    "▞",
                    "cell ({x},{y}) should carry the quadrant glyph, not a placeholder blank"
                );
                assert_eq!(cell.fg, Color::Rgb(255, 255, 255));
                assert_eq!(cell.bg, Color::Rgb(0, 0, 0));
            }
        }
        let text = buffer_text(buffer);
        assert!(
            !text.contains("[画像]"),
            "should not fall back to the placeholder label, buffer was: {text}"
        );
    }

    #[test]
    fn draw_with_resolved_image_fade_at_extremely_small_placeholder_area_does_not_panic() {
        let fixture_path = diagonal_pattern_webp_fixture(1, 1);
        let (config, relative) = config_and_relative_path_for(&fixture_path);
        let image_fade = ImageFadeState::settled(Some(relative));

        for (w, h) in [(1u16, 1u16), (2, 1), (1, 2), (2, 2), (1, 3)] {
            let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
            let now = Instant::now();
            let pulse = reveal::build_pulse(now);
            let mut image_cache = ImageCache::new();
            terminal
                .draw(|f| {
                    draw(
                        f,
                        &config,
                        None,
                        0,
                        0,
                        true,
                        None,
                        &pulse,
                        now,
                        Some(&image_fade),
                        &mut image_cache,
                    )
                })
                .unwrap();
        }
    }

    #[test]
    fn draw_with_one_pixel_source_image_upsampled_to_larger_grid_gives_every_cell_that_color() {
        let color = (123u8, 45u8, 67u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(color, 1, 1), 1, 1);
        let (config, relative) = config_and_relative_path_for(&fixture_path);
        let image_fade = ImageFadeState::settled(Some(relative));

        let mut terminal = Terminal::new(TestBackend::new(20, 6)).unwrap();
        let now = Instant::now();
        let pulse = reveal::build_pulse(now);
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    0,
                    0,
                    true,
                    None,
                    &pulse,
                    now,
                    Some(&image_fade),
                    &mut image_cache,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        // placeholder_area = 幅ceil(20/2)=10 x 高さ(6-1)=5 = 50セル。1x1画像相当のRGBA
        // データを大きいグリッドへ展開しても、範囲外アクセスでpanicしたり色が壊れたり
        // せず、全セルが唯一のソース画素の色をそのまま持つことを確認する。
        for y in 0..5u16 {
            for x in 0..10u16 {
                let cell = buffer.cell((x, y)).expect("in bounds");
                assert_eq!(
                    cell.bg,
                    Color::Rgb(color.0, color.1, color.2),
                    "cell ({x},{y}) should carry the single source pixel's color"
                );
            }
        }
    }

    #[test]
    fn placeholder_label_style_renders_label_text() {
        let mut config = Config::default();
        config.placeholder.style = PlaceholderStyle::Label;
        config.placeholder.label = "[画像]".to_string();
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        let now = Instant::now();
        let pulse = reveal::build_pulse(now);
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    0,
                    0,
                    true,
                    None,
                    &pulse,
                    now,
                    None,
                    &mut image_cache,
                )
            })
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
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    0,
                    0,
                    true,
                    None,
                    &pulse,
                    now,
                    None,
                    &mut image_cache,
                )
            })
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
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    1,
                    1,
                    true,
                    None,
                    &pulse,
                    now,
                    None,
                    &mut image_cache,
                )
            })
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
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    1,
                    2,
                    false,
                    None,
                    &pulse,
                    now,
                    None,
                    &mut image_cache,
                )
            })
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
        let mut image_cache = ImageCache::new();
        terminal
            .draw(|f| {
                draw(
                    f,
                    &config,
                    None,
                    0,
                    0,
                    true,
                    None,
                    &pulse,
                    now,
                    None,
                    &mut image_cache,
                )
            })
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
            event_image: None,
        };
        let now = Instant::now();
        // reveal 完了済み(=ページ送りインジケータも同時に描画される)状態でも、
        // 左右 Percentage(50/50)・テキスト側の上下 Length(height/2 と余り) がいずれも
        // width/height=1 (0 セルに丸まる) で panic しないことを確認する。
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let pulse = reveal::build_pulse(now);
        let mut image_cache = ImageCache::new();
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
                    None,
                    &mut image_cache,
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
            event_image: None,
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Animating(reveal::build_reveal(&config, &line, now));
        let pulse = reveal::build_pulse(now);
        let mut image_cache = ImageCache::new();
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
                    None,
                    &mut image_cache,
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
            event_image: None,
        };
        let now = Instant::now();

        // 表示中（char_interval を長くして確実に未完了にする）はインジケータが出ない。
        let mut typing_config = Config::default();
        typing_config.typewriter.char_interval_ms = 1000;
        typing_config.typewriter.fade_duration_ms = 0;
        let typing_reveal =
            reveal::RevealState::Animating(reveal::build_reveal(&typing_config, &line, now));
        let typing_pulse = reveal::build_pulse(now);
        let mut typing_image_cache = ImageCache::new();
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
                    None,
                    &mut typing_image_cache,
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
        let mut done_image_cache = ImageCache::new();
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
                    None,
                    &mut done_image_cache,
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
            event_image: None,
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let pulse = reveal::build_pulse(now);
        let mut image_cache = ImageCache::new();
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
                    None,
                    &mut image_cache,
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
            event_image: None,
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let pulse = reveal::build_pulse(now);
        let mut image_cache = ImageCache::new();
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
                    None,
                    &mut image_cache,
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
            event_image: None,
        };
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let pulse = reveal::build_pulse(now);
        let mut image_cache = ImageCache::new();
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
                    None,
                    &mut image_cache,
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
    // で `Layout::split` の戻り値を直接ダンプして実測・確認済み）。左右 columns（画像
    // プレースホルダ/テキスト）の分割はこの丸めをそのまま使っている（対称性を要求しない分割
    // のため問題ない。W=7 で左が1セル余分に取る例は下記
    // `odd_terminal_width_gives_placeholder_column_the_extra_cell` 参照）。
    //
    // 一方、テキスト側の上下分割（相手=上/自分=下）は `Constraint::Percentage` ではなく
    // `Constraint::Length` で明示的に高さを計算しており（`draw_text_windows` 内、
    // opponent=`height/2`切り捨て・self=`height-opponent`）、self が余りの1行を必ず受け取る。
    // これは self が opponent より恒常的に1行少なくなる片側固定バイアスをセルフレビューで
    // 発見し修正した結果であり、以下のテストは修正後の挙動（self が優先される）を固定する。

    /// テスト用に `DisplayLine` を組み立てる（複数のテストで多用するための局所ヘルパー）。
    fn dialog_line(speaker: Option<&str>, text: Vec<&str>) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: text.into_iter().map(|s| s.to_string()).collect(),
            event_image: None,
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
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|f| {
                draw(
                    f,
                    config,
                    line,
                    1,
                    1,
                    false,
                    reveal,
                    &pulse,
                    now,
                    None,
                    &mut image_cache,
                )
            })
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
    fn even_terminal_height_gives_self_window_the_extra_row() {
        // H=4(偶数) → root[0].height=3(ステータス行1を引いた残り) → テキスト側 rows split は
        // opponent=floor(3/2)=1行・self=3-1=2行になり、self(下/自分)側が余りの1行を受け取る
        // （self が損をしないよう明示的な高さ計算にした、セルフレビュー修正）。Rect を直接
        // 覗く代わりに、2行の本文を与えたとき何行まで収まるかで高さを実測する。
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
            !opponent_text.contains("line2"),
            "opponent window (height 1) should clip the second line, buffer was: {opponent_text}"
        );

        let self_line = dialog_line(Some("主格"), text);
        let self_buffer = render(&config, Some(&self_line), None, 40, 4);
        let self_text = buffer_text(&self_buffer);
        assert!(self_text.contains("line1"), "buffer was: {self_text}");
        assert!(
            self_text.contains("line2"),
            "self window (height 2) should fit both lines, buffer was: {self_text}"
        );
    }

    #[test]
    fn terminal_height_two_collapses_opponent_window_to_zero_height() {
        // H=2 → root[0].height=1 → テキスト側 rows split は opponent=floor(1/2)=0・
        // self=1-0=1 になり、self が優先されるため、相手発言(opponent窓)が実質どこにも
        // 描画されなくなる（旧実装では逆に self 側が消えていた。セルフレビュー修正）。
        let config = Config::default();
        let line = dialog_line(Some("相手"), vec!["hello"]);
        let buffer = render(&config, Some(&line), None, 40, 2);
        let text = buffer_text(&buffer);
        assert!(
            !text.contains("hello"),
            "opponent window has height 0 at H=2, opponent text must not render anywhere, buffer was: {text}"
        );
    }

    #[test]
    fn odd_terminal_height_splits_text_area_evenly() {
        // H=3(奇数) → root[0].height=2(偶数) → テキスト側 rows split はちょうど半分に割れ、
        // opponent(上)=1行・self(下)=1行の対称になる。H=4 で self が余りの1行を受け取る
        // ケース（1つ上のテスト）と対を成す対比ケース。
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
        // フォールバック文言「(会話行がありません)」は全角文字を含み、テキスト側の幅が
        // ちょうど2セル（W=5相当）になる条件では ratatui 側の Paragraph 折り返し処理が
        // バッファ範囲外書き込みで panic することを実測で確認した（既知の依存クレート側
        // バグ、`render_wrapped_paragraph` の極小幅ガードで回避している。回帰テストは
        // `narrow_terminal_with_no_display_line_does_not_panic_on_fullwidth_fallback_message`
        // 参照）。そのガードにより W=5（テキスト側幅2）ではそもそも何も描画されなくなる
        // ため、この境界計測（x座標の実測）にはガードの影響を受けない W=7 と単一ASCII文字
        // を使う。
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

    #[test]
    fn narrow_terminal_with_no_display_line_does_not_panic_on_fullwidth_fallback_message() {
        // W=4/5・H=4以上は、左右 Percentage(50/50) 分割によりテキスト側ウィンドウ幅がちょうど
        // 2セルになる。全角文字を含むフォールバック文言「(会話行がありません)」をその幅で
        // wrap 描画しようとすると、ratatui 内部
        // （`ratatui_widgets::paragraph::render_line` → `Buffer::index_mut`）で
        // バッファ範囲外書き込みpanicすることを実測で確認した（幅1セル・幅3セル以上では
        // 再現しない）。`render_wrapped_paragraph` の極小幅ガード（3セル未満はwrap描画を
        // スキップ）でこの経路を回避できていることを固定する回帰テスト。
        let config = Config::default();
        for (w, h) in [(4u16, 4u16), (5, 4), (4, 5), (5, 6)] {
            let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
            let now = Instant::now();
            let pulse = reveal::build_pulse(now);
            let mut image_cache = ImageCache::new();
            terminal
                .draw(|f| {
                    draw(
                        f,
                        &config,
                        None,
                        0,
                        0,
                        true,
                        None,
                        &pulse,
                        now,
                        None,
                        &mut image_cache,
                    )
                })
                .unwrap();
        }
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
        let mut image_cache = ImageCache::new();
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
                    None,
                    &mut image_cache,
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
        let mut typing_image_cache = ImageCache::new();
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
                    None,
                    &mut typing_image_cache,
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
        let mut done_image_cache = ImageCache::new();
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
                    None,
                    &mut done_image_cache,
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
    fn draw_with_resolved_image_fade_keeps_480_text_column_start_x_unchanged() {
        // #480の50/50レイアウト（左=画像プレースホルダ、右=テキスト）が、#481で
        // image_fade に実在パスを渡すようになった後も変わっていないことを確認する。
        // `odd_terminal_width_gives_placeholder_column_the_extra_cell` と同じ W=7 境界
        // (左=ceil(7/2)=4, 右=floor(7/2)=3) を流用し、右カラムの先頭xが x=4 で
        // 変わらないことを実測する（あちらは image_fade=None のケースだった）。
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba((10, 20, 30), 2, 2), 2, 2);
        let (config, relative) = config_and_relative_path_for(&fixture_path);
        let image_fade = ImageFadeState::settled(Some(relative));

        let line = dialog_line(Some("A"), vec!["Y"]); // "A" は player_speakers 非該当=opponent(上)
        let now = Instant::now();
        let reveal = reveal::RevealState::Done(reveal::skip_lines(&config, &line));
        let pulse = reveal::build_pulse(now);
        let mut image_cache = ImageCache::new();
        let mut terminal = Terminal::new(TestBackend::new(7, 10)).unwrap();
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
                    Some(&image_fade),
                    &mut image_cache,
                )
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
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
            "text column should still start at x=4 (ceil(7/2)) with a resolved image_fade present; found at x={x}"
        );
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
