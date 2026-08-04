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

/// 現在の会話行のタイプライター表示状態。
///
/// `Animating` は `jiwa::RevealHandle` による時間経過ベースの表示中（自然完了後も含む —
/// `RevealHandle::is_done` が `true` を返すだけで、ハンドル自体は差し替えない）。
/// `Done` はユーザーによる明示スキップ（[`skip_lines`]）後の状態で、[`join_text`] で
/// 組み立てた全文をあらかじめ色付き `Line` 列として構築済みのもの。`now` を一切使わず
/// 常に完了扱いになるため、`RevealHandle` の時刻計算（開始時刻を過去にずらす等）を経由する
/// 余地がない（#472 セルフレビュー: `Instant` 基準点付近での `checked_sub` underflow 対応）。
pub enum RevealState {
    Animating(RevealHandle),
    Done(Vec<Line<'static>>),
}

impl RevealState {
    /// 現在の表示が完了しているか。`Done` は定義上常に `true`（`now` に依存しない）。
    pub fn is_done(&self, now: Instant) -> bool {
        match self {
            RevealState::Animating(handle) => handle.is_done(now),
            RevealState::Done(_) => true,
        }
    }

    /// `now` 時点で描画すべき本文行。`Animating` は `RevealHandle::snapshot` から
    /// 都度組み立て、`Done` は事前構築済みの `Line` 列をそのまま複製して返す
    /// （こちらは `now` を読まない）。
    pub fn body_lines(&self, now: Instant) -> Vec<Line<'static>> {
        match self {
            RevealState::Animating(handle) => snapshot_to_lines(&handle.snapshot(now)),
            RevealState::Done(lines) => lines.clone(),
        }
    }
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

/// 表示中のタイプライターを即座に全文表示へスキップする。ブラウザ版 NovelRenderer の
/// `advanceOrSkipTypewriter`（タイプ中の1手目は全文表示へのスキップに専念し、次の行へは
/// 進めない「カノソ方式」）と同じ2手構成に揃える（#472）。
///
/// 以前は `RevealHandle::start_at` の開始時刻を十分過去にずらして `is_done(now) == true` を
/// 偽装していたが、`Instant` の基準点はプラットフォーム依存で未規定（Linux の
/// `CLOCK_MONOTONIC` はブート時刻近くを0とする実装が一般的）なため、システム稼働時間が
/// ずらし幅未満だと `checked_sub` が `None` を返し `unwrap_or(now)` で
/// 「スキップしたのに全文表示されない」バグが再発しうった（セルフレビュー指摘）。
/// 新実装は `RevealHandle` の時間計算を一切経由せず、[`join_text`] で組み立てた全文を
/// そのまま `fade_to` 色の `Line` 列として直接構築する。**`Instant` を引数に取らない
/// ことがそのまま「時刻計算に依存しない」ことの型上の保証になる。**
pub fn skip_lines(config: &Config, line: &DisplayLine) -> Vec<Line<'static>> {
    let opts = opts_for_line(config, line.speaker.as_deref());
    let Rgb(r, g, b) = opts.fade_to;
    let style = Style::default().fg(Color::Rgb(r, g, b));
    let text = join_text(line);
    // `join_text` が挟んだ `\n` で行を復元する。改行はASCIIバイトなので、マルチバイト
    // グラフェムを跨いで分割してしまう心配はない。
    text.split('\n')
        .map(|body_line| Line::styled(body_line.to_string(), style))
        .collect()
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

    /// `Line` の全スパンを連結してプレーンテキストに戻す（テストの比較用）。
    fn lines_to_text(lines: &[Line<'static>]) -> Vec<String> {
        lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect()
    }

    #[test]
    fn skip_lines_renders_full_text_in_a_single_line() {
        let config = Config::default();
        let l = line(Some("A"), vec!["a longer line of dialogue text"]);
        let lines = skip_lines(&config, &l);
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines_to_text(&lines),
            vec!["a longer line of dialogue text"]
        );
    }

    #[test]
    fn skip_lines_splits_multiline_body_into_separate_lines() {
        let config = Config::default();
        let l = line(None, vec!["a", "b"]);
        let lines = skip_lines(&config, &l);
        assert_eq!(lines_to_text(&lines), vec!["a", "b"]);
    }

    #[test]
    fn skip_lines_multiline_japanese_text() {
        let config = Config::default();
        let l = line(None, vec!["こんにちは、世界", "two行目 mixed"]);
        let lines = skip_lines(&config, &l);
        assert_eq!(
            lines_to_text(&lines),
            vec!["こんにちは、世界", "two行目 mixed"]
        );
    }

    /// `skip_lines` は `Instant` を一切引数に取らない。以前の `skip_reveal` は
    /// `now: Instant` を受け取り `started_at` を過去にずらすアンカー計算をしていたため、
    /// システム稼働時間が短い環境（起動直後の `Instant` 基準点付近）で `checked_sub` が
    /// `None` を返し `unwrap_or(now)` にフォールバックして「スキップしたのに全文表示
    /// されない」バグを再発しうった（セルフレビュー指摘）。新実装は `join_text` の結果を
    /// そのまま `Line` に変換するだけで時刻を一切読まないため、この関数のシグネチャに
    /// `Instant` が登場しないこと自体が「いつ呼んでも（起動直後でも）結果が変わらない」
    /// ことの型上の証明になる。このテストは通常の `Instant::now()` 経由の呼び出しでも
    /// 常に全文が表示されることを確認する（設計保証はシグネチャで担保、これは回帰ガード）。
    #[test]
    fn skip_lines_result_does_not_depend_on_when_it_is_called() {
        let config = Config::default();
        let l = line(Some("A"), vec!["hello"]);
        let lines_a = skip_lines(&config, &l);
        std::thread::sleep(Duration::from_millis(5));
        let lines_b = skip_lines(&config, &l);
        assert_eq!(lines_to_text(&lines_a), lines_to_text(&lines_b));
    }

    #[test]
    fn reveal_state_done_is_always_done_regardless_of_now() {
        let config = Config::default();
        let l = line(Some("A"), vec!["hello"]);
        let state = RevealState::Done(skip_lines(&config, &l));
        let now = Instant::now();
        assert!(state.is_done(now));
        // 遠い未来時刻を渡してもアンカー計算が絡まないので常に true のまま。
        assert!(state.is_done(now + Duration::from_secs(999_999)));
    }

    #[test]
    fn reveal_state_done_body_lines_ignore_now() {
        let config = Config::default();
        let l = line(Some("A"), vec!["hello", "world"]);
        let state = RevealState::Done(skip_lines(&config, &l));
        let t1 = Instant::now();
        let t2 = t1 + Duration::from_secs(3600);
        assert_eq!(
            lines_to_text(&state.body_lines(t1)),
            lines_to_text(&state.body_lines(t2))
        );
    }

    #[test]
    fn reveal_state_animating_delegates_is_done_to_handle() {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 1000;
        config.typewriter.fade_duration_ms = 0;
        let l = line(Some("A"), vec!["hello there"]);
        let now = Instant::now();
        let state = RevealState::Animating(build_reveal(&config, &l, now));
        assert!(!state.is_done(now));
    }

    #[test]
    fn snapshot_to_lines_splits_on_newline_grapheme() {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 0;
        config.typewriter.fade_duration_ms = 0;
        let l = line(None, vec!["a", "b"]);
        let now = Instant::now();
        let handle = build_reveal(&config, &l, now);
        assert!(handle.is_done(now));
        let snap = handle.snapshot(now);
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

    #[test]
    fn opts_for_line_invalid_color_name_falls_back_to_white() {
        let mut config = Config::default();
        config.colors.opponent = "not-a-real-color".to_string();
        // player_speakers のデフォルトは ["主格"] なので "相手" は opponent 色になる。
        let opts = opts_for_line(&config, Some("相手"));
        assert_eq!(opts.fade_to, Rgb(255, 255, 255));
    }

    #[test]
    fn color_to_rgb_covers_all_named_variants() {
        assert_eq!(color_to_rgb(Color::Black), Rgb(0, 0, 0));
        assert_eq!(color_to_rgb(Color::Red), Rgb(205, 49, 49));
        assert_eq!(color_to_rgb(Color::Green), Rgb(13, 188, 121));
        assert_eq!(color_to_rgb(Color::Yellow), Rgb(229, 229, 16));
        assert_eq!(color_to_rgb(Color::Blue), Rgb(36, 114, 200));
        assert_eq!(color_to_rgb(Color::Magenta), Rgb(188, 63, 188));
        assert_eq!(color_to_rgb(Color::Cyan), Rgb(17, 168, 205));
        assert_eq!(color_to_rgb(Color::Gray), Rgb(229, 229, 229));
        assert_eq!(color_to_rgb(Color::DarkGray), Rgb(102, 102, 102));
        assert_eq!(color_to_rgb(Color::LightRed), Rgb(241, 76, 76));
        assert_eq!(color_to_rgb(Color::LightGreen), Rgb(35, 209, 139));
        assert_eq!(color_to_rgb(Color::LightYellow), Rgb(245, 245, 67));
        assert_eq!(color_to_rgb(Color::LightBlue), Rgb(59, 142, 234));
        assert_eq!(color_to_rgb(Color::LightMagenta), Rgb(214, 112, 214));
        assert_eq!(color_to_rgb(Color::LightCyan), Rgb(41, 184, 219));
        assert_eq!(color_to_rgb(Color::White), Rgb(255, 255, 255));
        // Config が使わない想定のバリアント（フォールバック分岐）。
        assert_eq!(color_to_rgb(Color::Indexed(5)), Rgb(255, 255, 255));
        assert_eq!(color_to_rgb(Color::Reset), Rgb(255, 255, 255));
    }

    #[test]
    fn snapshot_to_lines_multiline_japanese_text() {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 0;
        config.typewriter.fade_duration_ms = 0;
        let l = line(None, vec!["こんにちは、世界", "two行目 mixed"]);
        let now = Instant::now();
        let handle = build_reveal(&config, &l, now);
        assert!(handle.is_done(now));
        let snap = handle.snapshot(now);
        let lines = snapshot_to_lines(&snap);
        assert_eq!(lines.len(), 2);
        let first: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        let second: String = lines[1].spans.iter().map(|s| s.content.as_ref()).collect();
        assert_eq!(first, "こんにちは、世界");
        assert_eq!(second, "two行目 mixed");
    }
}
