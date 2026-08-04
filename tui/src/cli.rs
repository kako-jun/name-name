//! コマンドライン引数の解釈。config / 再生対象 Markdown の指定方法をここに閉じ込め、
//! main.rs はワイヤリングのみに専念する。

use std::path::PathBuf;

/// `name-name-tui` のコマンドライン引数。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cli {
    /// 読み込む config TOML ファイルへのパス。未指定なら `Config::default()` を使う。
    pub config_path: Option<PathBuf>,
    /// 再生する Markdown ファイルへの直接パス。指定した場合、config の
    /// `script_dir` + `entry_script` より優先する（手元にサンプル脚本がない場合や
    /// 動作確認用に、任意の Markdown ファイルを直接指定できるようにするため）。
    pub script_path: Option<PathBuf>,
}

impl Cli {
    /// `--config <path>` / `--script <path>` を解釈する。未知の引数は無視する。
    pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Self {
        let mut cli = Cli::default();
        let mut iter = args.into_iter();
        iter.next(); // argv[0] (実行ファイルパス) を読み捨てる
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--config" => cli.config_path = iter.next().map(PathBuf::from),
                "--script" => cli.script_path = iter.next().map(PathBuf::from),
                _ => {}
            }
        }
        cli
    }
}
