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
    /// `--new-game` が指定されたか（#622）。既存のクイックセーブを無視して、
    /// 必ず script_dir の entry_script 先頭（hubの10択画面）から新規開始する。
    /// `--config`/`--script` と異なり値を取らない単純なブールフラグ。
    pub new_game: bool,
    /// `--debug-scene <sceneId>` で指定された直接開始先の sceneId (#652)。デバッグ用シーンジャンプ。
    /// 通常の解放条件・ファイル境界を無視して直接開始する。未指定なら `None`
    /// （従来どおりの起動経路）。`main.rs` から `Playback::jump_to_scene_id` へ配線する。
    /// GUI版 `?debug_scene=` と対称（`frontend/src/game/debugQuery.ts` 参照）。
    pub scene: Option<String>,
    /// `--debug-unlock-all` が指定されたか（#652）。デバッグ用。選択肢の `[条件: flag]` ロックを
    /// 無視して全ての選択肢を選択可能にする。`--new-game` と同じ値を取らない単純な
    /// ブールフラグ。GUI版 `?debug_unlock_all=1` と対称（`NovelRenderer.setDebugUnlockAllChoices`）。
    pub unlock_all: bool,
}

impl Cli {
    /// `--config <path>` / `--script <path>` / `--new-game` / `--debug-scene <sceneId>` /
    /// `--debug-unlock-all` を解釈する。未知の引数は無視する。`--config`/`--script`/`--debug-scene` は
    /// 次のトークンを無条件に値として消費する（それが別のフラグであっても）。
    /// `--new-game`/`--debug-unlock-all` は値を取らない単純なブールフラグ（次のトークンは消費しない）。
    pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Self {
        let mut cli = Cli::default();
        let mut iter = args.into_iter();
        iter.next(); // argv[0] (実行ファイルパス) を読み捨てる
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--config" => cli.config_path = iter.next().map(PathBuf::from),
                "--script" => cli.script_path = iter.next().map(PathBuf::from),
                "--new-game" => cli.new_game = true,
                "--debug-scene" => cli.scene = iter.next(),
                "--debug-unlock-all" => cli.unlock_all = true,
                _ => {}
            }
        }
        cli
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Cli::parse` は argv[0] を読み捨てる実装のため、テストでも先頭にダミーの
    /// 実行ファイルパスを含めて渡す。
    fn parse(args: &[&str]) -> Cli {
        let mut full = vec!["name-name-tui".to_string()];
        full.extend(args.iter().map(|s| s.to_string()));
        Cli::parse(full)
    }

    #[test]
    fn parse_no_args_returns_none_for_both() {
        let cli = parse(&[]);
        assert_eq!(cli.config_path, None);
        assert_eq!(cli.script_path, None);
        assert!(!cli.new_game);
    }

    #[test]
    fn parse_config_only_sets_config_path() {
        let cli = parse(&["--config", "c.toml"]);
        assert_eq!(cli.config_path, Some(PathBuf::from("c.toml")));
        assert_eq!(cli.script_path, None);
    }

    #[test]
    fn parse_script_only_sets_script_path() {
        let cli = parse(&["--script", "s.md"]);
        assert_eq!(cli.config_path, None);
        assert_eq!(cli.script_path, Some(PathBuf::from("s.md")));
    }

    #[test]
    fn parse_config_and_script_sets_both() {
        let cli = parse(&["--config", "c.toml", "--script", "s.md"]);
        assert_eq!(cli.config_path, Some(PathBuf::from("c.toml")));
        assert_eq!(cli.script_path, Some(PathBuf::from("s.md")));
    }

    #[test]
    fn parse_config_flag_without_trailing_value_is_ignored() {
        let cli = parse(&["--config"]);
        assert_eq!(cli.config_path, None);
        assert_eq!(cli.script_path, None);
    }

    #[test]
    fn parse_config_flag_swallows_following_flag_as_its_value() {
        // Hidden trap: `--config` unconditionally consumes the very next token,
        // even if that token is itself a recognized flag like `--script`.
        let cli = parse(&["--config", "--script", "s.md"]);
        assert_eq!(cli.config_path, Some(PathBuf::from("--script")));
        assert_eq!(cli.script_path, None);
    }

    #[test]
    fn parse_repeated_config_flag_last_value_wins() {
        let cli = parse(&["--config", "a.toml", "--config", "b.toml"]);
        assert_eq!(cli.config_path, Some(PathBuf::from("b.toml")));
    }

    #[test]
    fn parse_unknown_flag_is_ignored_and_parsing_continues() {
        let cli = parse(&["--unknown", "x", "--config", "c.toml"]);
        assert_eq!(cli.config_path, Some(PathBuf::from("c.toml")));
    }

    #[test]
    fn parse_equals_syntax_is_not_supported_and_ignored() {
        let cli = parse(&["--config=c.toml"]);
        assert_eq!(cli.config_path, None);
        assert_eq!(cli.script_path, None);
    }

    #[test]
    fn parse_new_game_flag_alone_sets_new_game_true() {
        let cli = parse(&["--new-game"]);
        assert!(cli.new_game);
        assert_eq!(cli.config_path, None);
        assert_eq!(cli.script_path, None);
    }

    #[test]
    fn parse_without_new_game_flag_defaults_to_false() {
        let cli = parse(&["--config", "c.toml"]);
        assert!(!cli.new_game);
    }

    #[test]
    fn parse_new_game_flag_does_not_consume_following_token() {
        // `--new-game` は値を取らないブールフラグのため、直後のトークンは
        // 通常どおり次のループで解釈される（`--config`/`--script` の値消費の罠は無い）。
        let cli = parse(&["--new-game", "--config", "c.toml"]);
        assert!(cli.new_game);
        assert_eq!(cli.config_path, Some(PathBuf::from("c.toml")));
    }

    #[test]
    fn parse_new_game_combined_with_config_and_script_sets_all() {
        let cli = parse(&["--config", "c.toml", "--script", "s.md", "--new-game"]);
        assert!(cli.new_game);
        assert_eq!(cli.config_path, Some(PathBuf::from("c.toml")));
        assert_eq!(cli.script_path, Some(PathBuf::from("s.md")));
    }

    // ===== #652: --debug-scene / --debug-unlock-all =====

    #[test]
    fn parse_without_scene_or_unlock_all_defaults_to_none_and_false() {
        let cli = parse(&[]);
        assert_eq!(cli.scene, None);
        assert!(!cli.unlock_all);
    }

    #[test]
    fn parse_scene_sets_scene() {
        let cli = parse(&["--debug-scene", "1-2"]);
        assert_eq!(cli.scene, Some("1-2".to_string()));
    }

    #[test]
    fn parse_scene_flag_without_trailing_value_is_none() {
        let cli = parse(&["--debug-scene"]);
        assert_eq!(cli.scene, None);
    }

    #[test]
    fn parse_unlock_all_flag_alone_sets_unlock_all_true() {
        let cli = parse(&["--debug-unlock-all"]);
        assert!(cli.unlock_all);
        assert_eq!(cli.scene, None);
    }

    #[test]
    fn parse_unlock_all_flag_does_not_consume_following_token() {
        let cli = parse(&["--debug-unlock-all", "--debug-scene", "1-2"]);
        assert!(cli.unlock_all);
        assert_eq!(cli.scene, Some("1-2".to_string()));
    }

    #[test]
    fn parse_scene_and_unlock_all_combined_with_config_and_script_sets_all() {
        let cli = parse(&[
            "--config",
            "c.toml",
            "--script",
            "s.md",
            "--debug-scene",
            "1-2",
            "--debug-unlock-all",
        ]);
        assert_eq!(cli.config_path, Some(PathBuf::from("c.toml")));
        assert_eq!(cli.script_path, Some(PathBuf::from("s.md")));
        assert_eq!(cli.scene, Some("1-2".to_string()));
        assert!(cli.unlock_all);
    }
}
