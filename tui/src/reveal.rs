//! `jiwa`（タイプライター演出）のオプション組み立てとスナップショット→ratatui変換、および
//! ページ送りインジケータの点滅判定をここに閉じ込める（#472、#495）。
//!
//! `jiwa::RevealHandle` はレンダラー非依存で `Rgb(u8, u8, u8)` を返すだけなので、ratatui の
//! `Color` / `Line` / `Span` への変換と、既存の `Config` 配色（話者ごとの色名文字列）から
//! `jiwa::RevealOpts` を組み立てる処理は tui 側の責務になる。kako-jun/type-globe の
//! `src/ui/quiz.rs`（RevealHandle 使用例）と同じ設計 — 記号・色はハードコードし、速度だけを
//! Config 化する — を踏襲する。
//!
//! ページ送りインジケータ（[`PAGE_INDICATOR_SYMBOL`]）は GUI版 `frontend/src/game/DialogBox.ts`
//! の `indicatorBlinkOn` と同じ「完全な on/off 切り替え」（[`blink_visible`]）で点滅する。
//! `jiwa::PulseHandle`（連続色補間の「呼吸」エフェクト専用設計、`PulseOpts::cyan_breath()` 等）
//! はこの用途には合わないため使わない（#495）。色はウィンドウ（自分側/相手側）ごとに
//! `Config::colors` の値を呼び出し側（`ui::draw_text_windows`）が固定して使う。

use std::str::FromStr;
use std::time::{Duration, Instant};

use jiwa::{RevealHandle, RevealOpts, RevealedGrapheme, Rgb};
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

/// タイプライター表示中の `jiwa::RevealHandle` を、アンカー時刻（開始時刻）を後から
/// 補正できる形で包む。`jiwa::RevealHandle`（v0.3時点）は `started_at` を private
/// フィールドとして持つのみでシフト用APIを持たないため、補正が必要になった時点で
/// 同じ `text`/`opts` を使って新しい `RevealHandle` を望みの `started_at` で作り直す
/// （[`Reveal::shift_anchor_forward`] 参照、セルフレビュー must対応）。
pub struct Reveal {
    handle: RevealHandle,
    text: String,
    opts: RevealOpts,
    started_at: Instant,
}

impl Reveal {
    fn new(text: String, opts: RevealOpts, started_at: Instant) -> Self {
        let handle = RevealHandle::start_at(&text, opts, started_at);
        Self {
            handle,
            text,
            opts,
            started_at,
        }
    }

    fn is_done(&self, now: Instant) -> bool {
        self.handle.is_done(now)
    }

    fn snapshot(&self, now: Instant) -> Vec<RevealedGrapheme> {
        self.handle.snapshot(now)
    }

    /// アンカー（`started_at`）を `by` ぶん前進させ、`text`/`opts` はそのままに
    /// `RevealHandle` を作り直す。オーバーレイ（バックログ/設定画面）を開いていた実時間
    /// だけ `started_at` を後ろへずらすことで、以後の `is_done`/`snapshot` が計算する
    /// 経過時間からオーバーレイ中の実時間経過を除外する（[`RevealState::shift_anchor_forward`]
    /// 参照）。
    fn shift_anchor_forward(&mut self, by: Duration) {
        self.started_at += by;
        self.handle = RevealHandle::start_at(&self.text, self.opts, self.started_at);
    }
}

/// 現在の会話行のタイプライター表示状態。
///
/// `Animating` は [`Reveal`]（`jiwa::RevealHandle` ラッパー）による時間経過ベースの表示中
/// （自然完了後も含む — `is_done` が `true` を返すだけで、ハンドル自体は差し替えない、
/// [`RevealState::shift_anchor_forward`] による明示的な補正を除く）。
/// `Done` はユーザーによる明示スキップ（[`skip_lines`]）後の状態で、[`join_text`] で
/// 組み立てた全文をあらかじめ色付き `Line` 列として構築済みのもの。`now` を一切使わず
/// 常に完了扱いになるため、`RevealHandle` の時刻計算（開始時刻を過去にずらす等）を経由する
/// 余地がない（#472 セルフレビュー: `Instant` 基準点付近での `checked_sub` underflow 対応）。
pub enum RevealState {
    Animating(Reveal),
    Done(Vec<Line<'static>>),
}

impl RevealState {
    /// 現在の表示が完了しているか。`Done` は定義上常に `true`（`now` に依存しない）。
    pub fn is_done(&self, now: Instant) -> bool {
        match self {
            RevealState::Animating(reveal) => reveal.is_done(now),
            RevealState::Done(_) => true,
        }
    }

    /// `now` 時点で描画すべき本文行。`Animating` は `RevealHandle::snapshot` から
    /// 都度組み立て、`Done` は事前構築済みの `Line` 列をそのまま複製して返す
    /// （こちらは `now` を読まない）。
    pub fn body_lines(&self, now: Instant) -> Vec<Line<'static>> {
        match self {
            RevealState::Animating(reveal) => snapshot_to_lines(&reveal.snapshot(now)),
            RevealState::Done(lines) => lines.clone(),
        }
    }

    /// オーバーレイ（バックログ/設定画面）が開いていた実時間（`by`）ぶん、タイプライター
    /// 表示のアンカー時刻を前進させる。`main.rs` の `event_loop` がオーバーレイを閉じる
    /// 際に呼ぶ（must対応）。
    ///
    /// **背景**: `Overlay` のdoc comment（`main.rs`）は「オーバーレイ表示中はゲーム進行を
    /// 完全に凍結する」と書いているが、これは「オーバーレイが開いている間 `event_loop` が
    /// `current_reveal`/`image_fade` を一切更新しない（描画もしない）」という意味に過ぎず、
    /// `Reveal` 内部の `RevealHandle` が保持する `started_at`（`Instant`）は不変のまま
    /// 現実時間の経過を計算し続ける。オーバーレイを1.5秒開いてから閉じると、閉じた
    /// 直後の最初のフレームで `now - started_at` が「オーバーレイを開いていた1.5秒」を
    /// 丸ごと含んでしまい、オーバーレイを開く前には見えていなかった文字が閉じた瞬間に
    /// 一気に表示される（レビュアー実機再現: `char_interval_ms=1000` で表示途中に
    /// バックログを開閉すると1〜2文字余分に表示される）。
    ///
    /// **修正**: オーバーレイを閉じる際、開いていた実時間ぶん `started_at` を前進させる
    /// （`Reveal::shift_anchor_forward`）。これにより `now - started_at`（経過時間）から
    /// オーバーレイ中に経過した実時間が差し引かれ、閉じた直後の見た目はオーバーレイを
    /// 開く直前と完全に一致する。`Done`（スキップ済み・`now` を読まない）は元々この問題の
    /// 影響を受けないため no-op。
    pub fn shift_anchor_forward(&mut self, by: Duration) {
        if let RevealState::Animating(reveal) = self {
            reveal.shift_anchor_forward(by);
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

/// `now` を起点に新しいタイプライター表示（本文の Reveal）を開始する。戻り値の [`Reveal`]
/// はそのまま [`RevealState::Animating`] のペイロードとして使う。
pub fn build_reveal(config: &Config, line: &DisplayLine, now: Instant) -> Reveal {
    let text = join_text(line);
    let opts = opts_for_line(config, line.speaker.as_deref());
    Reveal::new(text, opts, now)
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

/// ページ送りインジケータの点滅周期（ミリ秒）。GUI版 `frontend/src/game/DialogBox.ts` の
/// `INDICATOR_BLINK_MS` と同じ値（#495）。
pub const PAGE_INDICATOR_BLINK_PERIOD_MS: u64 = 1000;

/// `started_at` を基準に `now` 時点でページ送りインジケータを表示すべきか（`true`）/
/// 非表示にすべきか（`false`）を返す純粋関数。GUI版の
/// `this.indicatorGlyph.visible = this.indicatorBlinkOn` と同じ、色の補間を挟まない
/// 完全な on/off 切り替えを表す（#495）。`elapsed_ms / period_ms` が偶数なら表示区間、
/// 奇数なら非表示区間になる。`now` が `started_at` より前（クロックの巻き戻り等の防御）でも
/// `saturating_duration_since` で経過時間を0にクランプし、必ず表示区間（`true`）から始まる。
///
/// `period_ms == 0` はゼロ除算になる未定義入力のため、常に表示区間（`true`）扱いにフォール
/// バックする（呼び出し元は常に定数 [`PAGE_INDICATOR_BLINK_PERIOD_MS`] を渡すため実運用では
/// 到達しないが、この関数は `pub` な純粋関数として任意の `period_ms` を受け取れる形をして
/// いるため、防御を省くとテストや将来の呼び出し元がここで panic しうる。テスト設計エージェント
/// 指摘）。
pub fn blink_visible(started_at: Instant, now: Instant, period_ms: u64) -> bool {
    if period_ms == 0 {
        return true;
    }
    let elapsed_ms = now.saturating_duration_since(started_at).as_millis() as u64;
    (elapsed_ms / period_ms).is_multiple_of(2)
}

/// ページ送りインジケータを表示すべきか（choice非表示 かつ 会話行あり かつ reveal完了）を
/// 判定する純粋関数。以前は `main.rs`（`event_loop`）と `ui.rs`（`draw_text_windows`）の
/// 両方にこの可視条件が手書きで複製されており、現時点では数学的に等価でも将来どちらか
/// 片方だけが変更されると黙って乖離するリスクがあった（セルフレビュー should 指摘、
/// #495 追加修正2）。両呼び出し元がこの関数を経由することで、可視条件の定義を1箇所に
/// 保つ。`reveal` が `None`（会話行そのものが無い等）の場合は reveal 完了として扱わない
/// （常に `false`）。
pub fn should_show_page_indicator(
    has_choice: bool,
    has_line: bool,
    reveal: Option<&RevealState>,
    now: Instant,
) -> bool {
    !has_choice && has_line && reveal.is_some_and(|r| r.is_done(now))
}

/// `show_page_indicator`（インジケータを表示すべきか＝reveal完了かつ選択肢非表示、呼び出し側
/// `main.rs`/`ui::draw_text_windows` が判定する）が直前フレーム（`was_shown`）は `false` で
/// 今フレームは `true` になった瞬間（非表示→表示への遷移）だけ、点滅の基準時刻を `now` に
/// リセットする。それ以外（表示が続いている・まだ非表示のまま・表示から非表示に戻った）は
/// `prev_started_at` をそのまま返す。
///
/// GUI版 `frontend/src/game/DialogBox.ts` の `applyIndicatorContainerVisibility`
/// （`newVisible && !this.indicator.visible` を比較し、非表示→表示の遷移でだけ
/// `indicatorBlinkElapsed = 0` / `indicatorBlinkOn = true` にリセットする、#447 self-review
/// must 対応）と同じ frame-comparison 方式を踏襲する（#495 追加修正）。
///
/// 当初の #495 実装は `indicator_started_at` を `event_loop` 開始時に一度だけ `Instant::now()`
/// で固定していた。しかし会話行（reveal）が完了する瞬間の壁時計時刻は会話ごとにバラバラ
/// なので、あるrevealの完了がたまたま非表示区間（奇数区間）に重なると、GUI版が #447 で
/// 潰したのと同じ事故（読み終えたのに▼が最大1秒近く見えない）がTUI側でも再現しうった
/// （テスト設計エージェント指摘）。`event_loop` がこの関数を毎フレーム呼び、reveal完了の
/// 瞬間に基準時刻をリセットすることで、どの会話行が・いつ完了しても、完了直後は必ず
/// 表示区間（ON）から点滅が始まる ——
///
/// **ただしこの関数単体では保証できないケースが1つある**（セルフレビュー指摘、#495
/// 追加修正2）。`char_interval_ms=0 && fade_duration_ms=0`（タイプライター演出を完全に
/// 無効化する設定）では、[`build_reveal`] が返す `RevealHandle` は生成された瞬間に既に
/// `is_done()==true` になる。この設定下で行Aの表示完了後（`was_shown=true`）に次の行Bへ
/// 進むと、行Bの reveal も生成された瞬間に既に完了しているため `show_page_indicator` は
/// `true→true` のまま一度も `false` を経由せず、この関数の「非表示→表示遷移」判定が
/// 発火しない。この関数はフレーム間の `show_page_indicator` の値の差分しか見ておらず、
/// 「会話行そのものが切り替わったか」を知らないため、これは原理的にこの関数だけでは
/// 検出できない。呼び出し側（`main.rs` の `event_loop`）が `playback.item_index()` の変化
/// （＝実際に新しい item へ進んだ。会話行だけを数える `position()` だと画像コマ item への
/// 遷移を取りこぼすため、#497 で `item_index()` に乗り換え済み）を検知して `was_shown` を
/// 強制的に `false` にリセットしてから次フレームでこの関数を呼ぶことで、GUI版
/// `NovelRenderer` が新しい行/ページが始まるたびに明示的に `setIndicatorVisible(false)` を
/// 呼んでからタイプライターを開始するのと同じ「行が変わったら一旦強制的に隠す」保証を
/// 得ている。
pub fn indicator_blink_started_at(
    was_shown: bool,
    show_page_indicator: bool,
    prev_started_at: Instant,
    now: Instant,
) -> Instant {
    if show_page_indicator && !was_shown {
        now
    } else {
        prev_started_at
    }
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
            event_image: None,
            event_image_effects: name_name_parser::models::AmbientEffects::default(),
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
    fn blink_visible_true_at_the_instant_it_starts() {
        let t = Instant::now();
        assert!(blink_visible(t, t, PAGE_INDICATOR_BLINK_PERIOD_MS));
    }

    #[test]
    fn blink_visible_true_just_before_first_period_ends() {
        let t = Instant::now();
        let now = t + Duration::from_millis(PAGE_INDICATOR_BLINK_PERIOD_MS - 1);
        assert!(blink_visible(t, now, PAGE_INDICATOR_BLINK_PERIOD_MS));
    }

    #[test]
    fn blink_visible_false_exactly_at_one_period_elapsed() {
        // elapsed == period: 1000/1000 = 1（奇数）→ 非表示区間の開始。
        let t = Instant::now();
        let now = t + Duration::from_millis(PAGE_INDICATOR_BLINK_PERIOD_MS);
        assert!(!blink_visible(t, now, PAGE_INDICATOR_BLINK_PERIOD_MS));
    }

    #[test]
    fn blink_visible_false_in_the_middle_of_the_second_period() {
        let t = Instant::now();
        let now = t + Duration::from_millis(PAGE_INDICATOR_BLINK_PERIOD_MS + 500);
        assert!(!blink_visible(t, now, PAGE_INDICATOR_BLINK_PERIOD_MS));
    }

    #[test]
    fn blink_visible_true_again_at_two_periods_elapsed() {
        // elapsed == 2*period: 2000/1000 = 2（偶数）→ 表示区間に戻る。
        let t = Instant::now();
        let now = t + Duration::from_millis(PAGE_INDICATOR_BLINK_PERIOD_MS * 2);
        assert!(blink_visible(t, now, PAGE_INDICATOR_BLINK_PERIOD_MS));
    }

    #[test]
    fn blink_visible_now_earlier_than_started_at_clamps_to_visible_without_panicking() {
        // `Instant` は負の経過時間を表現できないため、`now < started_at`（クロックの巻き戻り等
        // の防御）でも `saturating_duration_since` が0にクランプし、表示区間の扱いになる
        // ことを確認する（`checked_sub`/`unwrap_or` の underflow 対応と同じ設計方針、
        // `skip_lines` のコメント参照）。
        let t = Instant::now();
        let earlier = t.checked_sub(Duration::from_millis(1)).unwrap_or(t);
        assert!(blink_visible(t, earlier, PAGE_INDICATOR_BLINK_PERIOD_MS));
    }

    #[test]
    fn blink_visible_with_zero_period_ms_does_not_panic_and_stays_visible() {
        // `period_ms=0` は `elapsed_ms / period_ms` がゼロ除算になる未定義入力。呼び出し元は
        // 常に定数 `PAGE_INDICATOR_BLINK_PERIOD_MS`（非ゼロ）を渡すため実運用では起きないが、
        // `blink_visible` は `pub` な純粋関数なので任意の `period_ms` を受け取れてしまう —
        // ここでガードして常に表示区間（`true`）にフォールバックすることを固定する
        // （テスト設計エージェント指摘、観点1）。
        let t = Instant::now();
        let now = t + Duration::from_millis(500);
        assert!(blink_visible(t, now, 0));
    }

    #[test]
    fn should_show_page_indicator_true_when_no_choice_has_line_and_reveal_done() {
        let config = Config::default();
        let l = line(Some("A"), vec!["hello"]);
        let state = RevealState::Done(skip_lines(&config, &l));
        let now = Instant::now();
        assert!(should_show_page_indicator(false, true, Some(&state), now));
    }

    #[test]
    fn should_show_page_indicator_false_when_has_choice() {
        // 選択肢表示中は reveal が完了していてもインジケータの概念が無い。
        let config = Config::default();
        let l = line(Some("A"), vec!["hello"]);
        let state = RevealState::Done(skip_lines(&config, &l));
        let now = Instant::now();
        assert!(!should_show_page_indicator(true, true, Some(&state), now));
    }

    #[test]
    fn should_show_page_indicator_false_when_no_line() {
        let config = Config::default();
        let l = line(Some("A"), vec!["hello"]);
        let state = RevealState::Done(skip_lines(&config, &l));
        let now = Instant::now();
        assert!(!should_show_page_indicator(false, false, Some(&state), now));
    }

    #[test]
    fn should_show_page_indicator_false_when_reveal_is_none() {
        let now = Instant::now();
        assert!(!should_show_page_indicator(false, true, None, now));
    }

    #[test]
    fn should_show_page_indicator_false_when_reveal_not_done_yet() {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 1000;
        config.typewriter.fade_duration_ms = 0;
        let l = line(Some("A"), vec!["hello there"]);
        let now = Instant::now();
        let state = animating_state(&config, &l, now);
        assert!(!should_show_page_indicator(false, true, Some(&state), now));
    }

    /// テスト専用ヘルパー: `main.rs` の `tests::animating` と同じ役割
    /// （`Config`/`DisplayLine`/`now` から `RevealState::Animating` を組み立てる）。
    fn animating_state(config: &Config, l: &DisplayLine, now: Instant) -> RevealState {
        RevealState::Animating(build_reveal(config, l, now))
    }

    #[test]
    fn indicator_blink_started_at_resets_on_hidden_to_shown_transition() {
        // 非表示(false)→表示(true)への遷移だけがリセットの引き金になる（#495 追加修正）。
        let prev_started_at = Instant::now();
        let now = prev_started_at + Duration::from_millis(1234);
        let result = indicator_blink_started_at(false, true, prev_started_at, now);
        assert_eq!(
            result, now,
            "非表示→表示の遷移では基準時刻が now にリセットされるべき"
        );
    }

    #[test]
    fn indicator_blink_started_at_keeps_previous_value_while_still_shown() {
        // 表示が前フレームから続いている（true→true）場合はリセットしない。
        let prev_started_at = Instant::now();
        let now = prev_started_at + Duration::from_millis(500);
        let result = indicator_blink_started_at(true, true, prev_started_at, now);
        assert_eq!(
            result, prev_started_at,
            "表示が継続中は基準時刻を保持し続けるべき（毎フレームリセットすると点滅が止まる）"
        );
    }

    #[test]
    fn indicator_blink_started_at_keeps_previous_value_while_still_hidden() {
        // まだ非表示のまま（false→false、reveal未完了が続いている）場合もリセットしない。
        let prev_started_at = Instant::now();
        let now = prev_started_at + Duration::from_millis(500);
        let result = indicator_blink_started_at(false, false, prev_started_at, now);
        assert_eq!(result, prev_started_at);
    }

    #[test]
    fn indicator_blink_started_at_keeps_previous_value_on_shown_to_hidden_transition() {
        // 表示→非表示（次の会話行の reveal が新たに始まった等）はリセット対象ではない
        // （次に非表示→表示へ遷移した時点で改めてリセットされる）。
        let prev_started_at = Instant::now();
        let now = prev_started_at + Duration::from_millis(500);
        let result = indicator_blink_started_at(true, false, prev_started_at, now);
        assert_eq!(result, prev_started_at);
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
    fn opts_for_line_default_opponent_color_matches_gui_hex_exactly() {
        // config.colors.opponent の既定値 "#9ad4e8" が opts_for_line を経由して
        // typewriter のフェード色（fade_to）にそのまま伝播することを固定する
        // （#572 の主眼: GUI版 NovelRenderer.OPPONENT_TEXT_COLOR(0x9ad4e8) との厳密一致。
        // セルフレビュー should 指摘）。
        let config = Config::default();
        // player_speakers のデフォルトは ["主格"] なので "相手" は opponent 色になる。
        let opts = opts_for_line(&config, Some("相手"));
        // #9ad4e8 = R:154(0x9a), G:212(0xd4), B:232(0xe8)。
        assert_eq!(opts.fade_to, Rgb(154, 212, 232));
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
