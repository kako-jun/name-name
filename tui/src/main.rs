mod cli;
mod config;
mod input;
mod playback;
mod reveal;
mod ui;

use std::io::Stdout;
use std::time::{Duration, Instant};

use anyhow::Context;
use jiwa::RevealHandle;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::Terminal;

use cli::Cli;
use config::Config;
use input::Action;
use playback::Playback;

/// 描画の再チェック間隔。タイプライター演出（`jiwa::RevealHandle`）はフレームごとの
/// `snapshot` で動くため、キー入力が無くてもこの間隔で再描画してアニメーションを進める
/// （kako-jun/type-globe の `quiz.rs` の `REDRAW` と同じ値）。
const REDRAW: Duration = Duration::from_millis(30);

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse(std::env::args());

    let config = match &cli.config_path {
        Some(path) => Config::load(path)
            .with_context(|| format!("config読み込みに失敗しました: {}", path.display()))?,
        None => Config::default(),
    };

    let script_path = cli
        .script_path
        .clone()
        .unwrap_or_else(|| config.entry_script_path());
    let source = std::fs::read_to_string(&script_path).with_context(|| {
        format!(
            "Markdown原稿の読み込みに失敗しました: {}",
            script_path.display()
        )
    })?;

    let document = name_name_parser::parser::parse(&source);
    let mut playback = Playback::from_document(&document);

    run(&config, &mut playback)
}

/// 端末を alternate screen + raw mode に切り替えて再生ループを回す。
/// ループを抜けたら（正常終了・エラーいずれの場合も）必ず端末状態を元に戻す。
/// ratatui/crossterm 内部などで予期しない panic が起きた場合も、デフォルトの
/// panic フックが呼ばれる前に端末状態を復元し、raw mode + alternate screen の
/// まま固まってユーザーが `reset` を打つ羽目になるのを防ぐ。
fn run(config: &Config, playback: &mut Playback) -> anyhow::Result<()> {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(
            std::io::stdout(),
            LeaveAlternateScreen,
            ratatui::crossterm::cursor::Show
        );
        default_hook(info);
    }));

    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = event_loop(&mut terminal, config, playback);

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

/// 描画 → 短いタイムアウト付きでキー入力を待つ → 再生状態更新、を1件終了
/// (`Action::Quit`)まで繰り返す。
///
/// MVP（#471）はキー入力をブロッキングで待っていたが、タイプライター演出
/// （`jiwa::RevealHandle`）とページ送りインジケータ（`jiwa::PulseHandle`）はどちらも
/// 時間経過だけで見た目が変わるため、キー入力の有無に関わらず `REDRAW` 間隔で再描画する
/// フレームベースのループに変更した（#472）。
fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    config: &Config,
    playback: &mut Playback,
) -> anyhow::Result<()> {
    let mut current_reveal: Option<RevealHandle> = playback
        .current()
        .map(|line| reveal::build_reveal(config, line, Instant::now()));
    // ページ送りインジケータは話者・テキストに依存しないグローバルな明滅なので、
    // 会話行が変わっても作り直さない（一度だけ開始する）。
    let pulse = reveal::build_pulse(Instant::now());

    loop {
        let now = Instant::now();
        terminal.draw(|frame| {
            ui::draw(
                frame,
                config,
                playback.current(),
                playback.position(),
                playback.total(),
                playback.is_at_end(),
                current_reveal.as_ref(),
                &pulse,
                now,
            )
        })?;

        match input::poll_action(REDRAW)? {
            Action::Advance => on_advance(playback, &mut current_reveal, config, Instant::now()),
            Action::Quit => break,
            Action::None => {}
        }
    }
    Ok(())
}

/// `Action::Advance` 受信時の意思決定（デシジョンテーブル、#472）。
/// `Terminal<CrosstermBackend<Stdout>>` という具体型に結合していた `event_loop` から、
/// `playback` / `current_reveal` / `config` / `now` だけを引数に取る純粋関数として切り出し、
/// `TestBackend` 無しでもユニットテストできるようにした。挙動は元の `event_loop` 内の分岐と
/// 同じ（切り出しに伴う `Instant::now()` の呼び出し回数の違いを除く）。
///
/// | # | 現在行 | reveal状態 | 次の行 | 動作 |
/// |---|---|---|---|---|
/// | 1 | 無し | ― | ― | 何もしない |
/// | 2 | 有り | 未完了 | 存在する/最終行 | `skip_reveal` で即全文表示、`advance()` は呼ばない |
/// | 3 | 有り | 完了 | 存在する | `advance()` → 次行の `build_reveal` |
/// | 4 | 有り | 完了 | 最終行 | `advance()` → `current_reveal` は不変（no-op） |
fn on_advance(
    playback: &mut Playback,
    current_reveal: &mut Option<RevealHandle>,
    config: &Config,
    now: Instant,
) {
    if let Some(line) = playback.current() {
        let reveal_done = current_reveal
            .as_ref()
            .map(|r| r.is_done(now))
            .unwrap_or(true);
        if !reveal_done {
            // ブラウザ版 NovelRenderer の advanceOrSkipTypewriter と同じ
            // 「表示中の1手目は全文表示へのスキップに専念し、次の行へは
            // 進めない」挙動（カノソ方式）。
            *current_reveal = Some(reveal::skip_reveal(config, line, now));
        } else if playback.advance() {
            if let Some(next_line) = playback.current() {
                *current_reveal = Some(reveal::build_reveal(config, next_line, now));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::DisplayLine;

    fn dline(speaker: Option<&str>, text: &str) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: vec![text.to_string()],
        }
    }

    /// reveal が即座には完了しない速度設定（境界確認に使う）。
    fn slow_config() -> Config {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 1000;
        config.typewriter.fade_duration_ms = 0;
        config
    }

    /// reveal が構築と同時に完了する速度設定（「完了済み」の分岐確認に使う）。
    fn instant_config() -> Config {
        let mut config = Config::default();
        config.typewriter.char_interval_ms = 0;
        config.typewriter.fade_duration_ms = 0;
        config
    }

    #[test]
    fn on_advance_incomplete_reveal_skips_without_advancing_position() {
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "hello there"),
            dline(Some("B"), "next line"),
        ]);
        let now = Instant::now();
        let mut current_reveal = Some(reveal::build_reveal(
            &config,
            playback.current().expect("line"),
            now,
        ));
        assert!(!current_reveal.as_ref().unwrap().is_done(now));

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert_eq!(playback.position(), 1, "スキップでは位置が進んではいけない");
        assert!(current_reveal.as_ref().unwrap().is_done(now));
    }

    #[test]
    fn on_advance_incomplete_reveal_at_last_line_skips_without_advancing_position() {
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![dline(Some("A"), "only line here")]);
        let now = Instant::now();
        let mut current_reveal = Some(reveal::build_reveal(
            &config,
            playback.current().expect("line"),
            now,
        ));
        assert!(!current_reveal.as_ref().unwrap().is_done(now));

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert_eq!(playback.position(), 1);
        assert!(playback.is_at_end());
        assert!(current_reveal.as_ref().unwrap().is_done(now));
    }

    #[test]
    fn on_advance_complete_reveal_with_next_line_advances_and_starts_new_reveal() {
        let config = instant_config();
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "first"), dline(Some("B"), "second")]);
        let now = Instant::now();
        let mut current_reveal = Some(reveal::build_reveal(
            &config,
            playback.current().expect("line"),
            now,
        ));
        assert!(current_reveal.as_ref().unwrap().is_done(now));

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert_eq!(playback.position(), 2);
        assert_eq!(
            playback.current().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert!(current_reveal.is_some());
    }

    #[test]
    fn on_advance_complete_reveal_at_last_line_is_noop() {
        let config = slow_config();
        let mut playback =
            Playback::from_lines(vec![dline(Some("A"), "first"), dline(Some("B"), "second")]);
        playback.advance(); // 最終行へ
        let t0 = Instant::now();
        let mut current_reveal = Some(reveal::build_reveal(
            &config,
            playback.current().expect("line"),
            t0,
        ));
        // "second" は6グラフェム、char_interval=1000ms・fade=0ms なので
        // t0 + 5000ms で完了する。
        let t_call = t0 + Duration::from_millis(5000);
        assert!(current_reveal.as_ref().unwrap().is_done(t_call));

        on_advance(&mut playback, &mut current_reveal, &config, t_call);

        assert_eq!(playback.position(), 2);
        assert!(playback.is_at_end());
        // no-op であれば current_reveal は t0 起点のまま = t_call 時点で全文表示済み。
        // もし（バグで）t_call を起点に作り直されていたら、最初の1グラフェムしか
        // 見えないはず（char_interval=1000msなので）。
        let snap = current_reveal.as_ref().unwrap().snapshot(t_call);
        assert_eq!(snap.len(), "second".chars().count());
    }

    #[test]
    fn on_advance_no_current_line_is_noop() {
        let config = Config::default();
        let mut playback = Playback::from_lines(vec![]);
        let mut current_reveal: Option<RevealHandle> = None;
        let now = Instant::now();

        on_advance(&mut playback, &mut current_reveal, &config, now);

        assert_eq!(playback.position(), 0);
        assert!(current_reveal.is_none());
    }

    #[test]
    fn on_advance_full_lifecycle_across_two_lines() {
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "hello there"),
            dline(Some("B"), "second line"),
        ]);
        let t0 = Instant::now();
        let mut current_reveal = Some(reveal::build_reveal(
            &config,
            playback.current().expect("line"),
            t0,
        ));

        // 1行目: reveal中
        assert!(!current_reveal.as_ref().unwrap().is_done(t0));

        // Advance(skip): 全文表示、位置は変わらない
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert_eq!(playback.position(), 1);
        assert!(current_reveal.as_ref().unwrap().is_done(t0));

        // Advance(進行): 完了済みなので2行目へ進む
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert_eq!(playback.position(), 2);
        assert_eq!(
            playback.current().expect("line").speaker.as_deref(),
            Some("B")
        );
        assert!(!current_reveal.as_ref().unwrap().is_done(t0)); // 2行目 reveal中

        // Advance(skip): 2行目を全文表示
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert!(current_reveal.as_ref().unwrap().is_done(t0));

        // Advance(最終行no-op): 位置は変わらない
        on_advance(&mut playback, &mut current_reveal, &config, t0);
        assert_eq!(playback.position(), 2);
        assert!(playback.is_at_end());
    }

    #[test]
    fn on_advance_single_call_never_advances_more_than_one_state() {
        let config = instant_config();
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "one"),
            dline(Some("B"), "two"),
            dline(Some("C"), "three"),
        ]);
        let now = Instant::now();
        let mut current_reveal = Some(reveal::build_reveal(
            &config,
            playback.current().expect("line"),
            now,
        ));
        assert_eq!(playback.position(), 1);

        on_advance(&mut playback, &mut current_reveal, &config, now);
        assert_eq!(
            playback.position(),
            2,
            "1回のAdvanceで2行以上進んではいけない"
        );

        on_advance(&mut playback, &mut current_reveal, &config, now);
        assert_eq!(
            playback.position(),
            3,
            "1回のAdvanceで2行以上進んではいけない"
        );
    }
}
