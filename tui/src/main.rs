mod cli;
mod config;
mod input;
mod playback;
mod ui;

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

    let result = run_screens(&mut terminal, config, playback, &mut || {
        input::next_action()
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
/// `input::next_action`（実端末をブロッキングで読む）をそのまま渡すだけで従来通り動くが、
/// テストからは固定の `Action` 列を返すクロージャを渡すことで、`TestBackend` +
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

/// 描画 → キー入力待ち → 再生状態更新、を1件終了(`Action::Quit`)まで繰り返す。
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
    loop {
        terminal.draw(|frame| {
            ui::draw(
                frame,
                config,
                playback.current(),
                playback.position(),
                playback.total(),
                playback.is_at_end(),
            )
        })?;

        match next_action()? {
            Action::Advance => {
                playback.advance();
            }
            Action::Quit => break,
            Action::None => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use std::cell::RefCell;

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
