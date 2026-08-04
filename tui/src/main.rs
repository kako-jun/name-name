mod cli;
mod config;
mod playback;

use anyhow::Context;
use cli::Cli;
use config::Config;
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
    let playback = Playback::from_document(&document);

    // TODO(#471): この println デバッグ出力は ratatui による実描画に置き換える。
    println!("game: {}", config.game_name);
    println!("script: {}", script_path.display());
    println!("lines: {}", playback.total());
    if let Some(line) = playback.current() {
        println!(
            "[{}/{}] {:?}: {:?}",
            playback.position(),
            playback.total(),
            line.speaker,
            line.text
        );
    }

    Ok(())
}
