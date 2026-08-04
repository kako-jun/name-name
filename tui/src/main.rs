mod cli;
mod config;
mod input;
mod playback;
mod ui;

use std::io::Stdout;

use anyhow::Context;
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

    let result = run_screens(&mut terminal, config, playback);

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

/// スプラッシュ（`config.splash` が設定されていれば）→ 本編ループ、の順に画面を進める。
/// スプラッシュ未設定（デフォルト）ならいきなり本編から始まる（後方互換）。
fn run_screens(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    config: &Config,
    playback: &mut Playback,
) -> anyhow::Result<()> {
    if config.should_show_splash() {
        let advanced = show_splash(terminal, config)?;
        if !advanced {
            // スプラッシュ画面で終了操作（q/Esc）された場合は本編に進まず終える。
            return Ok(());
        }
    }
    event_loop(terminal, config, playback)
}

/// スプラッシュ画面を描画し、キー入力を1件待つ。`Action::Advance` で `Ok(true)`
/// （本編へ進む）、`Action::Quit` で `Ok(false)`（そのまま終了）を返す。
fn show_splash(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    config: &Config,
) -> anyhow::Result<bool> {
    loop {
        terminal.draw(|frame| ui::draw_splash(frame, config))?;

        match input::next_action()? {
            Action::Advance => return Ok(true),
            Action::Quit => return Ok(false),
            Action::None => {}
        }
    }
}

/// 描画 → キー入力待ち → 再生状態更新、を1件終了(`Action::Quit`)まで繰り返す。
fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    config: &Config,
    playback: &mut Playback,
) -> anyhow::Result<()> {
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

        match input::next_action()? {
            Action::Advance => {
                playback.advance();
            }
            Action::Quit => break,
            Action::None => {}
        }
    }
    Ok(())
}
