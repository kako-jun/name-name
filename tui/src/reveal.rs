//! `jiwa`（タイプライター演出 + ページ送りインジケータ）のオプション組み立てと
//! スナップショット→ratatui変換をここに閉じ込める（#472）。
//!
//! `jiwa::RevealHandle` / `jiwa::PulseHandle` はレンダラー非依存で `Rgb(u8, u8, u8)` を
//! 返すだけなので、ratatui の `Color` / `Line` / `Span` への変換と、既存の `Config` 配色
//! （話者ごとの色名文字列）から `jiwa::RevealOpts` を組み立てる処理は tui 側の責務になる。
//! kako-jun/type-globe の `src/ui/quiz.rs`（RevealHandle 使用例）/ `src/ui/listen.rs`
//! （PulseHandle 使用例）と同じ設計 — 記号・色はハードコードし、速度だけを Config 化する —
//! を踏襲する。

use std::str::FromStr;
use std::time::{Duration, Instant};

use jiwa::{PulseHandle, PulseOpts, RevealHandle, RevealOpts, RevealedGrapheme, Rgb};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};

use crate::config::Config;
use crate::playback::DisplayLine;

/// ページ送りインジケータの記号。type-globe の `listen.rs` が `"♪"` をハードコードしているのに
/// 倣い、記号・色は Config 化せず固定する（速度だけを Config 化する、という設計方針）。
pub const PAGE_INDICATOR_SYMBOL: &str = "▼";

/// リビール未着手のグラフェムが持つ開始色。`jiwa::RevealOpts::soft_green()` プリセットと同じ
/// 「暗いグレーから話者色へ」というトーンを踏襲する（話者ごとに変える必要性が薄いため固定）。
const FADE_FROM: Rgb = Rgb(60, 60, 60);

/// `line` の本文（複数行）を単一のリビール対象文字列にする。行区切りは `\n` を挟む。
/// [`snapshot_to_lines`] はこの `\n` グラフェムを行区切りとして解釈し直す。
fn join_text(line: &DisplayLine) -> String {
    line.text.join("\n")
}

/// 話者色（`Config::color_name_for`）を fade_to、速度を `Config.typewriter` から取った
/// `RevealOpts` を組み立てる。
fn opts_for_line(config: &Config, speaker: Option<&str>) -> RevealOpts {
    let color_name = config.color_name_for(speaker);
    let fade_to = Color::from_str(color_name)
        .map(color_to_rgb)
        .unwrap_or(Rgb(255, 255, 255));
    RevealOpts {
        char_interval: Duration::from_millis(config.typewriter.char_interval_ms),
        fade_duration: Duration::from_millis(config.typewriter.fade_duration_ms),
        fade_from: FADE_FROM,
        fade_to,
    }
}

/// `now` を起点に新しいタイプライター表示（本文の Reveal）を開始する。
pub fn build_reveal(config: &Config, line: &DisplayLine, now: Instant) -> RevealHandle {
    let text = join_text(line);
    let opts = opts_for_line(config, line.speaker.as_deref());
    RevealHandle::start_at(&text, opts, now)
}

/// ページ送りインジケータ（▼ の明滅）を開始する。話者やテキストに依存しない単一の
/// グローバルインジケータなので、会話行が変わっても作り直す必要はない
/// （呼び出し側は `event_loop` の開始時に一度だけ呼べばよい）。
pub fn build_pulse(now: Instant) -> PulseHandle {
    PulseHandle::start_at(PAGE_INDICATOR_SYMBOL, PulseOpts::cyan_breath(), now)
}

/// `RevealHandle::snapshot` の出力を ratatui の `Line` 列に変換する。`\n` グラフェムは
/// 行区切りとして消費し（画面には出さない）、他のグラフェムはそれぞれ現在のフェード色を
/// 持つ `Span` になる。空スナップショット（本文0文字、またはまだ何も見えていない）は
/// 空の `Vec` を返す。
pub fn snapshot_to_lines(snapshot: &[RevealedGrapheme]) -> Vec<Line<'static>> {
    if snapshot.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut current: Vec<Span<'static>> = Vec::new();
    for g in snapshot {
        if g.text == "\n" {
            lines.push(Line::from(std::mem::take(&mut current)));
            continue;
        }
        let Rgb(r, gr, b) = g.color;
        current.push(Span::styled(
            g.text.clone(),
            Style::default().fg(Color::Rgb(r, gr, b)),
        ));
    }
    lines.push(Line::from(current));
    lines
}

/// ratatui の名前付き `Color` を jiwa の `Rgb` に変換する。標準 ANSI 16 色相当の近似値
/// （一般的なダークテーマ端末の配色に準拠）。`Config` の色設定は文字列（例: "white",
/// "cyan"）で保持されているため、`RevealOpts` の `fade_to` に渡す前にここで一度変換する。
fn color_to_rgb(color: Color) -> Rgb {
    match color {
        Color::Rgb(r, g, b) => Rgb(r, g, b),
        Color::Black => Rgb(0, 0, 0),
        Color::Red => Rgb(205, 49, 49),
        Color::Green => Rgb(13, 188, 121),
        Color::Yellow => Rgb(229, 229, 16),
        Color::Blue => Rgb(36, 114, 200),
        Color::Magenta => Rgb(188, 63, 188),
        Color::Cyan => Rgb(17, 168, 205),
        Color::Gray => Rgb(229, 229, 229),
        Color::DarkGray => Rgb(102, 102, 102),
        Color::LightRed => Rgb(241, 76, 76),
        Color::LightGreen => Rgb(35, 209, 139),
        Color::LightYellow => Rgb(245, 245, 67),
        Color::LightBlue => Rgb(59, 142, 234),
        Color::LightMagenta => Rgb(214, 112, 214),
        Color::LightCyan => Rgb(41, 184, 219),
        Color::White => Rgb(255, 255, 255),
        // Reset / Indexed(_) など、既存 Config が使わない想定のバリアントは白へフォールバックする。
        _ => Rgb(255, 255, 255),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(speaker: Option<&str>, text: Vec<&str>) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: text.into_iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn join_text_joins_multiple_lines_with_newline() {
        let l = line(None, vec!["a", "b"]);
        assert_eq!(join_text(&l), "a\nb");
    }

    #[test]
    fn join_text_empty_vec_is_empty_string() {
        let l = line(None, vec![]);
        assert_eq!(join_text(&l), "");
    }

    #[test]
    fn build_reveal_first_grapheme_visible_immediately() {
        let config = Config::default();
        let l = line(Some("A"), vec!["hi"]);
        let now = Instant::now();
        let handle = build_reveal(&config, &l, now);
        let snap = handle.snapshot(now);
        assert!(!snap.is_empty());
        assert_eq!(snap[0].text, "h");
    }

    #[test]
    fn build_reveal_not_done_immediately_for_multi_char_text() {
        let config = Config::default();
        let l = line(Some("A"), vec!["hello there"]);
        let now = Instant::now();
        let handle = build_reveal(&config, &l, now);
        assert!(!handle.is_done(now));
    }

    #[test]
    fn snapshot_to_lines_splits_on_newline_grapheme() {
        let snap = vec![
            RevealedGrapheme {
                text: "a".to_string(),
                color: Rgb(0, 0, 0),
                progress: 1.0,
            },
            RevealedGrapheme {
                text: "\n".to_string(),
                color: Rgb(0, 0, 0),
                progress: 1.0,
            },
            RevealedGrapheme {
                text: "b".to_string(),
                color: Rgb(0, 0, 0),
                progress: 1.0,
            },
        ];
        let lines = snapshot_to_lines(&snap);
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn snapshot_to_lines_empty_snapshot_is_empty_vec() {
        assert!(snapshot_to_lines(&[]).is_empty());
    }

    #[test]
    fn color_to_rgb_maps_named_colors() {
        assert_eq!(color_to_rgb(Color::White), Rgb(255, 255, 255));
        assert_eq!(color_to_rgb(Color::Rgb(1, 2, 3)), Rgb(1, 2, 3));
    }

    #[test]
    fn build_pulse_starts_with_page_indicator_symbol() {
        let now = Instant::now();
        let pulse = build_pulse(now);
        assert_eq!(pulse.snapshot(now).text, PAGE_INDICATOR_SYMBOL);
    }
}
