mod cli;
mod config;
mod image_fade;
mod image_render;
mod input;
mod playback;
mod reveal;
mod ui;

use std::time::{Duration, Instant};

use anyhow::Context;
use ratatui::backend::{Backend, CrosstermBackend};
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

    // タイプライター演出（`jiwa::RevealHandle`）とページ送りインジケータ（`jiwa::PulseHandle`）は
    // どちらも時間経過だけで見た目が変わるため、キー入力の有無に関わらず `REDRAW` 間隔で
    // 再描画するポーリング方式にする（#472）。この `next_action` は `run_screens` を通じて
    // `show_splash`/`event_loop` の両方へ渡り、スプラッシュ画面もこの間隔で再描画されるが、
    // 静的な画面なので実害はない。
    let result = run_screens(&mut terminal, config, playback, &mut || {
        input::poll_action(REDRAW)
    });

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

/// スプラッシュ（`config.splash` が設定されていれば）→ 本編ループ、の順に画面を進める。
/// スプラッシュ未設定（デフォルト）ならいきなり本編から始まる（後方互換）。
///
/// `next_action` はキー入力の取得元を差し替え可能にするための注入点。本番の `run` からは
/// `input::poll_action`（実端末を短いタイムアウト付きで読む）をそのまま渡すだけで従来通り
/// 動くが、テストからは固定の `Action` 列を返すクロージャを渡すことで、`TestBackend` +
/// 合成キー入力で状態遷移をユニットテストできる。
fn run_screens<B>(
    terminal: &mut Terminal<B>,
    config: &Config,
    playback: &mut Playback,
    next_action: &mut impl FnMut() -> anyhow::Result<Action>,
) -> anyhow::Result<()>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    if config.should_show_splash() {
        let advanced = show_splash(terminal, config, next_action)?;
        if !advanced {
            // スプラッシュ画面で終了操作（q/Esc）された場合は本編に進まず終える。
            return Ok(());
        }
    }
    event_loop(terminal, config, playback, next_action)
}

/// スプラッシュ画面を描画し、キー入力を1件待つ。`Action::Advance` で `Ok(true)`
/// （本編へ進む）、`Action::Quit` で `Ok(false)`（そのまま終了）を返す。
fn show_splash<B>(
    terminal: &mut Terminal<B>,
    config: &Config,
    next_action: &mut impl FnMut() -> anyhow::Result<Action>,
) -> anyhow::Result<bool>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    loop {
        terminal.draw(|frame| ui::draw_splash(frame, config))?;

        match next_action()? {
            Action::Advance => return Ok(true),
            Action::Quit => return Ok(false),
            Action::None => {}
        }
    }
}

/// 描画 → 短いタイムアウト付きでキー入力を待つ → 再生状態更新、を1件終了
/// (`Action::Quit`)まで繰り返す。
///
/// MVP（#471）はキー入力をブロッキングで待っていたが、タイプライター演出
/// （`jiwa::RevealHandle`）とページ送りインジケータ（`jiwa::PulseHandle`）はどちらも
/// 時間経過だけで見た目が変わるため、キー入力の有無に関わらず一定間隔で再描画する
/// フレームベースのループに変更した（#472）。`Terminal<CrosstermBackend<Stdout>>` という
/// 具体型への結合は、`show_splash`/`run_screens` と同じ `Backend` ジェネリック化・
/// `next_action` 注入パターンで解消済み（#478 のリファクタをそのまま踏襲）。
fn event_loop<B>(
    terminal: &mut Terminal<B>,
    config: &Config,
    playback: &mut Playback,
    next_action: &mut impl FnMut() -> anyhow::Result<Action>,
) -> anyhow::Result<()>
where
    B: Backend,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    let mut current_reveal: Option<reveal::RevealState> = playback.current().map(|line| {
        reveal::RevealState::Animating(reveal::build_reveal(config, line, Instant::now()))
    });
    // ページ送りインジケータは話者・テキストに依存しないグローバルな明滅なので、
    // 会話行が変わっても作り直さない（一度だけ開始する）。
    let pulse = reveal::build_pulse(Instant::now());

    // イベント絵（`DisplayLine::event_image`）のデコード結果キャッシュとクロスフェード状態
    // （#481）。`image_fade` は開始時点の会話行が持つ event_image を「既にトランジション無しで
    // 表示され続けている」状態として初期化する（起動直後にフェードインさせない）。
    let mut image_cache = image_render::ImageCache::new();
    let mut image_fade = image_fade::ImageFadeState::settled(
        playback.current().and_then(|line| line.event_image.clone()),
    );

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
                Some(&image_fade),
                &mut image_cache,
            )
        })?;

        match next_action()? {
            Action::Advance => {
                let prev_position = playback.position();
                on_advance(playback, &mut current_reveal, config, Instant::now());
                // 会話行が実際に進んだ（＝スキップ操作ではなく次行へ移動した）ときだけ
                // event_image の変化を見てクロスフェードを開始する。skip_lines 経路
                // （on_advance がタイプライター表示を全文表示へ早送りしただけ）では
                // position は変わらないため、ここには到達しない。
                if playback.position() != prev_position {
                    let target = playback.current().and_then(|line| line.event_image.clone());
                    if image_fade.current_target() != target.as_deref() {
                        // `config.event_image.crossfade_ms`（グローバル値）を常に使う。
                        // `Event::EventImage`/`EventImageExit` が持つイベント個別の `fade_ms`
                        // 上書きは `playback.rs` の `Playback::from_document` で意図的に
                        // 読み捨てている（MVPスコープの簡略化、#481）。
                        image_fade = image_fade.transition_to(
                            target,
                            Duration::from_millis(config.event_image.crossfade_ms),
                            Instant::now(),
                        );
                    }
                }
            }
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
/// | 2 | 有り | 未完了 | 存在する/最終行 | `skip_lines` で即全文表示、`advance()` は呼ばない |
/// | 3 | 有り | 完了 | 存在する | `advance()` → 次行の `build_reveal` |
/// | 4 | 有り | 完了 | 最終行 | `advance()` → `current_reveal` は不変（no-op） |
fn on_advance(
    playback: &mut Playback,
    current_reveal: &mut Option<reveal::RevealState>,
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
            // 進めない」挙動（カノソ方式）。`skip_lines` は `RevealHandle` の時間計算を
            // 経由しない（#472 セルフレビュー対応）。
            *current_reveal = Some(reveal::RevealState::Done(reveal::skip_lines(config, line)));
        } else if playback.advance() {
            if let Some(next_line) = playback.current() {
                *current_reveal = Some(reveal::RevealState::Animating(reveal::build_reveal(
                    config, next_line, now,
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::DisplayLine;
    use ratatui::backend::TestBackend;
    use ratatui::style::Color;
    use std::cell::RefCell;

    fn dline(speaker: Option<&str>, text: &str) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: vec![text.to_string()],
            event_image: None,
        }
    }

    /// `dline` の event_image 指定版（#481 の event_loop 統合テスト用）。
    fn dline_with_image(
        speaker: Option<&str>,
        text: &str,
        event_image: Option<String>,
    ) -> DisplayLine {
        DisplayLine {
            speaker: speaker.map(|s| s.to_string()),
            text: vec![text.to_string()],
            event_image,
        }
    }

    /// `w`x`h` px の単色 RGBA バイト列を作る（テストフィクスチャ用）。
    fn solid_rgba(color: (u8, u8, u8), w: u32, h: u32) -> Vec<u8> {
        let mut buf = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            buf.extend_from_slice(&[color.0, color.1, color.2, 255]);
        }
        buf
    }

    /// 描画済みバッファのどこかのセルの背景色が `color` と一致するかを走査する。
    fn buffer_has_bg_color(buffer: &ratatui::buffer::Buffer, color: (u8, u8, u8)) -> bool {
        let area = buffer.area();
        (0..area.width).any(|x| {
            (0..area.height)
                .any(|y| buffer.cell((x, y)).unwrap().bg == Color::Rgb(color.0, color.1, color.2))
        })
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

    fn animating(
        config: &Config,
        dline: &crate::playback::DisplayLine,
        now: Instant,
    ) -> reveal::RevealState {
        reveal::RevealState::Animating(reveal::build_reveal(config, dline, now))
    }

    #[test]
    fn on_advance_incomplete_reveal_skips_without_advancing_position() {
        let config = slow_config();
        let mut playback = Playback::from_lines(vec![
            dline(Some("A"), "hello there"),
            dline(Some("B"), "next line"),
        ]);
        let now = Instant::now();
        let mut current_reveal = Some(animating(&config, playback.current().expect("line"), now));
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
        let mut current_reveal = Some(animating(&config, playback.current().expect("line"), now));
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
        let mut current_reveal = Some(animating(&config, playback.current().expect("line"), now));
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
        let mut current_reveal = Some(animating(&config, playback.current().expect("line"), t0));
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
        let lines = current_reveal.as_ref().unwrap().body_lines(t_call);
        assert_eq!(lines[0].spans.len(), "second".chars().count());
    }

    #[test]
    fn on_advance_no_current_line_is_noop() {
        let config = Config::default();
        let mut playback = Playback::from_lines(vec![]);
        let mut current_reveal: Option<reveal::RevealState> = None;
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
        let mut current_reveal = Some(animating(&config, playback.current().expect("line"), t0));

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
        let mut current_reveal = Some(animating(&config, playback.current().expect("line"), now));
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

    // ---- #481 follow-up: event_loop の event_image フェード開始判定（デシジョンテーブル） ----
    //
    // on_advance() 自体（position/reveal の遷移）は上のテスト群で既にカバーされているが、
    // 「position が実際に進んだ時だけ event_image の変化を見てフェードを開始する」という
    // event_loop 側のガード（本体の event_loop 内、on_advance 呼び出し直後のコメント参照）は
    // これまで自動テストで一度も検証されていなかった（手動tmux確認のみ）。

    #[test]
    fn event_loop_advance_crossing_into_new_event_image_switches_placeholder_to_that_image() {
        // デシジョンテーブル#2（None→Some(A)）の統合確認。crossfade_ms=0 にして、
        // トランジション開始直後の描画が実時間経過に依存せず即座に新ターゲットの色を
        // 表示するようにし、決定的なアサーションにする（`ImageFadeState::progress` は
        // duration=0 のとき常に1.0を返す）。
        let fixture_color = (123u8, 45u8, 67u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(fixture_color, 2, 2), 2, 2);
        let mut config = instant_config();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        config.event_image.crossfade_ms = 0;
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut playback = Playback::from_lines(vec![
            dline_with_image(Some("A"), "hello", None),
            dline_with_image(Some("B"), "world", Some(relative)),
        ]);

        let mut terminal = Terminal::new(TestBackend::new(10, 4)).unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Advance, Action::Quit]);

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert!(
            buffer_has_bg_color(terminal.backend().buffer(), fixture_color),
            "advancing into a line with a new event_image should switch the fade target to it"
        );
    }

    #[test]
    fn event_loop_advance_to_same_event_image_path_does_not_restart_fade_timer() {
        // デシジョンテーブル#4（Some(A)→Some(A)、同一パスが連続する行）の回帰ガード:
        // 無駄な再フェードトリガーの防止。crossfade_ms をテスト実行時間よりはるかに
        // 長い60秒にし、最初の None→A フェードがまだ進行中の状態を作る。もし2回目の
        // Advance(A→A、同一パス)が誤って transition_to を再度呼ぶと、from/to が
        // 両方Aになり(同一画像同士の補間は t に関わらず即座にAの色そのものになる、
        // `jiwa::lerp_u8` は a==b なら常に a を返すため)、本来まだ進行中で黒寄りの
        // はずのフェードが「完了して見える」という観測可能な差が出る。これを利用して
        // 再トリガーの有無を検出する。
        let fixture_color = (250u8, 10u8, 10u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(fixture_color, 2, 2), 2, 2);
        let mut config = instant_config();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        config.event_image.crossfade_ms = 60_000;
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut playback = Playback::from_lines(vec![
            dline_with_image(Some("A"), "one", None),
            dline_with_image(Some("B"), "two", Some(relative.clone())),
            dline_with_image(Some("C"), "three", Some(relative)),
        ]);

        let mut terminal = Terminal::new(TestBackend::new(10, 4)).unwrap();
        let (mut next_action, _remaining) =
            action_queue(vec![Action::Advance, Action::Advance, Action::Quit]);

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert!(
            !buffer_has_bg_color(terminal.backend().buffer(), fixture_color),
            "同一パスへの2回目のAdvanceでフェードが再トリガーされ、本来まだ進行中(60秒中の\
             数ms)のはずのフェードが完了して見えてしまっている(無駄な再トリガー、退行)"
        );
    }

    #[test]
    fn event_loop_skip_advance_on_incomplete_reveal_does_not_start_image_fade() {
        // タイプライタースキップ操作（reveal未完了時のAdvance）は position を進めない
        // （on_advance のデシジョンテーブル#2、上のテスト群で確認済み）。event_loop側は
        // それを受けて「position が実際に進んだ時だけ event_image の変化を見る」ガードを
        // 持つ（event_loop 内、on_advance 呼び出し直後のコメント参照）。スキップ操作
        // 単体では次行の event_image を先読みしてフェードを開始したりしないことを確認する。
        let fixture_color = (77u8, 88u8, 99u8);
        let fixture_path =
            crate::image_render::write_test_webp_fixture(&solid_rgba(fixture_color, 2, 2), 2, 2);
        let mut config = slow_config();
        config.event_image.assets_dir = fixture_path.parent().unwrap().to_path_buf();
        let relative = fixture_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let mut playback = Playback::from_lines(vec![
            dline_with_image(Some("A"), "hello there this is long enough text", None),
            dline_with_image(Some("B"), "next", Some(relative)),
        ]);

        let mut terminal = Terminal::new(TestBackend::new(10, 4)).unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Advance, Action::Quit]);

        event_loop(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        assert_eq!(
            playback.position(),
            1,
            "スキップではpositionが進んではいけない"
        );
        assert!(
            !buffer_has_bg_color(terminal.backend().buffer(), fixture_color),
            "スキップ操作(reveal未完了時のAdvance)だけでは次行のevent_imageへフェードが\
             開始されてはいけない"
        );
    }

    /// レンダリング済みバッファを1本の文字列に変換する（`ui.rs` のテストヘルパーと
    /// 同じ目的だが、全角文字の cell_width までは main.rs のテストでは問わないため
    /// 単純に symbol を連結するだけの簡略版で足りる）。
    fn buffer_text(terminal: &Terminal<TestBackend>) -> String {
        let buffer = terminal.backend().buffer();
        let area = buffer.area();
        let mut out = String::new();
        for y in 0..area.height {
            for x in 0..area.width {
                out.push_str(buffer.cell((x, y)).expect("in bounds").symbol());
            }
        }
        out
    }

    /// 固定の `Action` 列を順番に返すクロージャを作る。列を使い切った後は
    /// `Action::Quit` を返し続ける（テストが無限ループしないためのフォールバック）。
    /// `remaining` で消費後の残り件数を確認できるようにしておく
    /// （`show_splash_none_action_keeps_looping_and_redraws` が「途中で打ち切られず
    /// 全件を消費してからループを終える」ことを検証するために使う）。
    fn action_queue(
        actions: Vec<Action>,
    ) -> (
        impl FnMut() -> anyhow::Result<Action>,
        std::rc::Rc<RefCell<usize>>,
    ) {
        let remaining = std::rc::Rc::new(RefCell::new(actions.len()));
        let remaining_handle = remaining.clone();
        let mut iter = actions.into_iter();
        let closure = move || {
            let next = iter.next();
            *remaining.borrow_mut() = iter.len();
            Ok(next.unwrap_or(Action::Quit))
        };
        (closure, remaining_handle)
    }

    fn splash_config() -> Config {
        Config {
            splash: crate::config::SplashConfig {
                enabled: true,
                lines: vec!["田".to_string()],
                ..crate::config::SplashConfig::default()
            },
            ..Config::default()
        }
    }

    #[test]
    fn show_splash_advance_action_returns_true_without_entering_event_loop() {
        let config = splash_config();
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Advance]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();

        assert!(advanced);
    }

    #[test]
    fn show_splash_quit_action_returns_false() {
        let config = splash_config();
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let (mut next_action, _remaining) = action_queue(vec![Action::Quit]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();

        assert!(!advanced);
    }

    #[test]
    fn show_splash_none_action_keeps_looping_and_redraws() {
        let config = splash_config();
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let (mut next_action, remaining) = action_queue(vec![
            Action::None,
            Action::None,
            Action::None,
            Action::Advance,
        ]);

        let advanced = show_splash(&mut terminal, &config, &mut next_action).unwrap();

        assert!(advanced);
        // 4件（None x3 + Advance）を全て消費してから返ってきたことを確認する。
        // 先頭の Action::None だけでループを抜けてしまう実装退行があれば、
        // ここで remaining が 3 のまま残り失敗する。
        assert_eq!(*remaining.borrow(), 0);
    }

    #[test]
    fn run_screens_skips_splash_when_should_show_splash_is_false() {
        let config = Config::default(); // splash.enabled == false（既定）
        assert!(!config.should_show_splash());
        let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
        let document = name_name_parser::parser::parse("");
        let mut playback = Playback::from_document(&document);
        let (mut next_action, _remaining) = action_queue(vec![Action::Quit]);

        run_screens(&mut terminal, &config, &mut playback, &mut next_action).unwrap();

        // スプラッシュ用の「Enter / Space で開始」ヒントが一切描画されておらず、
        // event_loop 側の描画（位置表示 "0/0"）だけが出ていることを確認する。
        let text = buffer_text(&terminal);
        assert!(!text.contains("Enter"), "buffer was: {text}");
        assert!(text.contains("0/0"), "buffer was: {text}");
    }
}
