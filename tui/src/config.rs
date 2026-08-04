//! ゲームごとに変わりうる値（データパス・レイアウト種別・配色）を外出しにするための型。
//!
//! tui 本体のロジック（playback / ui / input）にゲーム固有の文字列を直書きしないための境界。
//! デフォルト値は最初の適用対象である gymnasia の値
//! （gymnasia リポジトリの `docs/design/experience-system.md` の TUI Implementation Plan:
//! プレイヤー側=白、相手側=水色）をサンプルとして使うが、他のゲームは別の Config を
//! 用意すればよい。全ゲーム対応を前提にした
//! 過剰な抽象化はしない。

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// 左側（画像プレースホルダ）の表示方法。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceholderStyle {
    /// 罫線で囲った空き領域のみ表示する。
    Blank,
    /// 罫線で囲った領域の中央にラベル文字列（`label`）を表示する。
    #[default]
    Label,
}

/// 左側（画像プレースホルダ）の表示設定。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct PlaceholderConfig {
    pub style: PlaceholderStyle,
    /// `PlaceholderStyle::Label` のときに中央へ表示する文字列。
    pub label: String,
}

impl Default for PlaceholderConfig {
    fn default() -> Self {
        Self {
            style: PlaceholderStyle::default(),
            label: "[画像]".to_string(),
        }
    }
}

/// ダイアログテキストの文字色設定（色名は `ratatui::style::Color` の
/// `FromStr` 実装が解釈できる名前を想定。例: "white", "cyan", "gray"）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ColorConfig {
    /// プレイヤー側話者（`Config::player_speakers` に含まれる話者）の文字色。
    pub player: String,
    /// プレイヤー側以外の話者の文字色。
    pub opponent: String,
    /// 話者名を持たない Narration イベントの文字色。
    pub narration: String,
}

impl Default for ColorConfig {
    fn default() -> Self {
        Self {
            player: "white".to_string(),
            opponent: "cyan".to_string(),
            narration: "gray".to_string(),
        }
    }
}

/// 起動直後に表示するスプラッシュ画面の設定。
///
/// `enabled` が `false`（既定）または `lines` が空の場合はスプラッシュを表示せず、
/// 従来通りいきなり本編から始まる（後方互換）。ロゴの内容（ASCII アート本体）は
/// ゲームごとに異なるため、`tui` 本体には一切埋め込まず、この設定を通じて外部化する。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SplashConfig {
    /// スプラッシュ画面を表示するかどうか。
    pub enabled: bool,
    /// 画面中央に表示するロゴの行。1要素が1行に対応する。
    pub lines: Vec<String>,
    /// ロゴ行の文字色名（`ratatui::style::Color` の `FromStr` が解釈できる名前）。
    pub color: String,
}

impl Default for SplashConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            lines: Vec::new(),
            color: "white".to_string(),
        }
    }
}

/// ゲームごとに変わりうる値をまとめた設定。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Config {
    /// ゲーム名（画面タイトル等の表示用）。
    pub game_name: String,
    /// Markdown 原稿が置かれているディレクトリ（`entry_script` の基点）。
    pub script_dir: PathBuf,
    /// `script_dir` からの相対パスで指定する、起動時に読み込む Markdown ファイル。
    pub entry_script: PathBuf,
    pub placeholder: PlaceholderConfig,
    pub colors: ColorConfig,
    /// 起動直後に表示するスプラッシュ画面の設定。
    pub splash: SplashConfig,
    /// この話者名リストに含まれる話者は「プレイヤー側」として扱う（`colors.player` を適用）。
    /// 含まれない話者（Dialog の character）は「相手側」として扱う（`colors.opponent` を適用）。
    /// 話者名を持たない Narration は `colors.narration` を適用する。
    pub player_speakers: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            game_name: "gymnasia".to_string(),
            script_dir: PathBuf::from("docs/scripts/drafts"),
            entry_script: PathBuf::from("route01/01-terminal-light.md"),
            placeholder: PlaceholderConfig::default(),
            colors: ColorConfig::default(),
            splash: SplashConfig::default(),
            player_speakers: vec!["主格".to_string()],
        }
    }
}

impl Config {
    /// TOML 文字列から Config を読み込む。TOML に書かれていないフィールドは
    /// `Config::default()`（gymnasia サンプル値）で補われる。
    pub fn from_toml_str(input: &str) -> anyhow::Result<Config> {
        let config: Config = toml::from_str(input)?;
        Ok(config)
    }

    /// TOML ファイルパスから Config を読み込む。
    pub fn load(path: &Path) -> anyhow::Result<Config> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            anyhow::anyhow!(
                "config ファイルの読み込みに失敗しました: {} ({e})",
                path.display()
            )
        })?;
        Self::from_toml_str(&content)
    }

    /// 起動時に読み込む Markdown ファイルの実パス（`script_dir` + `entry_script`）。
    pub fn entry_script_path(&self) -> PathBuf {
        self.script_dir.join(&self.entry_script)
    }

    /// 話者名がプレイヤー側かどうかを判定する。
    pub fn is_player_speaker(&self, speaker: &str) -> bool {
        self.player_speakers.iter().any(|s| s == speaker)
    }

    /// スプラッシュ画面を表示すべきか（`enabled` かつロゴ行が1行以上ある場合）。
    pub fn should_show_splash(&self) -> bool {
        self.splash.enabled && !self.splash.lines.is_empty()
    }

    /// 話者（Dialog の character）から適用すべき文字色名を返す。
    /// `speaker` が `None`（Narration）の場合は `colors.narration` を返す。
    pub fn color_name_for(&self, speaker: Option<&str>) -> &str {
        match speaker {
            None => &self.colors.narration,
            Some(name) if self.is_player_speaker(name) => &self.colors.player,
            Some(_) => &self.colors.opponent,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_default_matches_gymnasia_values() {
        let config = Config::default();
        assert_eq!(config.game_name, "gymnasia");
        assert_eq!(config.script_dir, PathBuf::from("docs/scripts/drafts"));
        assert_eq!(
            config.entry_script,
            PathBuf::from("route01/01-terminal-light.md")
        );
        assert_eq!(config.placeholder.style, PlaceholderStyle::Label);
        assert_eq!(config.placeholder.label, "[画像]");
        assert_eq!(config.colors.player, "white");
        assert_eq!(config.colors.opponent, "cyan");
        assert_eq!(config.colors.narration, "gray");
        assert!(!config.splash.enabled);
        assert!(config.splash.lines.is_empty());
        assert_eq!(config.splash.color, "white");
        assert_eq!(config.player_speakers, vec!["主格".to_string()]);
    }

    #[test]
    fn from_toml_str_empty_equals_default() {
        let config = Config::from_toml_str("").expect("empty toml should parse");
        assert_eq!(config, Config::default());
    }

    #[test]
    fn from_toml_str_partial_color_override_keeps_rest_default() {
        let toml = "[colors]\nplayer = \"red\"\n";
        let config = Config::from_toml_str(toml).expect("should parse");
        assert_eq!(config.colors.player, "red");
        assert_eq!(config.colors.opponent, Config::default().colors.opponent);
        assert_eq!(config.colors.narration, Config::default().colors.narration);
        assert_eq!(config.game_name, Config::default().game_name);
        assert_eq!(config.player_speakers, Config::default().player_speakers);
    }

    #[test]
    fn from_toml_str_invalid_toml_is_err() {
        let result = Config::from_toml_str("this is not = = valid toml [[[");
        assert!(result.is_err());
    }

    #[test]
    fn load_missing_path_is_err_and_message_contains_path() {
        let path = Path::new("tui/tests/fixtures/does-not-exist.toml");
        let err = Config::load(path).expect_err("missing file should error");
        assert!(
            err.to_string().contains("does-not-exist.toml"),
            "error message should mention the path: {err}"
        );
    }

    #[test]
    fn entry_script_path_joins_relative() {
        let config = Config {
            script_dir: PathBuf::from("scripts"),
            entry_script: PathBuf::from("intro.md"),
            ..Config::default()
        };
        assert_eq!(
            config.entry_script_path(),
            PathBuf::from("scripts/intro.md")
        );
    }

    #[test]
    fn entry_script_path_absolute_entry_script_ignores_script_dir() {
        let config = Config {
            script_dir: PathBuf::from("scripts"),
            entry_script: PathBuf::from("/abs/intro.md"),
            ..Config::default()
        };
        assert_eq!(config.entry_script_path(), PathBuf::from("/abs/intro.md"));
    }

    #[test]
    fn entry_script_path_empty_script_dir_returns_entry_script_only() {
        let config = Config {
            script_dir: PathBuf::new(),
            entry_script: PathBuf::from("intro.md"),
            ..Config::default()
        };
        assert_eq!(config.entry_script_path(), PathBuf::from("intro.md"));
    }

    #[test]
    fn is_player_speaker_true_when_name_in_list() {
        let config = Config {
            player_speakers: vec!["A".to_string()],
            ..Config::default()
        };
        assert!(config.is_player_speaker("A"));
    }

    #[test]
    fn is_player_speaker_false_when_name_not_in_list() {
        let config = Config {
            player_speakers: vec!["B".to_string()],
            ..Config::default()
        };
        assert!(!config.is_player_speaker("A"));
    }

    #[test]
    fn is_player_speaker_false_when_list_empty() {
        let config = Config {
            player_speakers: vec![],
            ..Config::default()
        };
        assert!(!config.is_player_speaker("A"));
    }

    #[test]
    fn is_player_speaker_false_for_case_mismatch() {
        let config = Config {
            player_speakers: vec!["a".to_string()],
            ..Config::default()
        };
        assert!(!config.is_player_speaker("A"));
    }

    #[test]
    fn is_player_speaker_false_for_trailing_whitespace_mismatch() {
        let config = Config {
            player_speakers: vec!["主格".to_string()],
            ..Config::default()
        };
        assert!(!config.is_player_speaker("主格 "));
    }

    #[test]
    fn is_player_speaker_false_for_fullwidth_halfwidth_mismatch() {
        let config = Config {
            player_speakers: vec!["A".to_string()],
            ..Config::default()
        };
        // U+FF21 (fullwidth A) must not match halfwidth "A".
        assert!(!config.is_player_speaker("Ａ"));
    }

    #[test]
    fn color_name_for_none_returns_narration_color() {
        let config = Config::default();
        assert_eq!(config.color_name_for(None), config.colors.narration);
    }

    #[test]
    fn color_name_for_player_speaker_returns_player_color() {
        let config = Config {
            player_speakers: vec!["A".to_string()],
            ..Config::default()
        };
        assert_eq!(config.color_name_for(Some("A")), config.colors.player);
    }

    #[test]
    fn color_name_for_non_player_speaker_returns_opponent_color() {
        let config = Config {
            player_speakers: vec!["B".to_string()],
            ..Config::default()
        };
        assert_eq!(config.color_name_for(Some("A")), config.colors.opponent);
    }

    #[test]
    fn color_name_for_case_mismatch_returns_opponent_color() {
        let config = Config {
            player_speakers: vec!["a".to_string()],
            ..Config::default()
        };
        assert_eq!(config.color_name_for(Some("A")), config.colors.opponent);
    }

    #[test]
    fn color_name_for_trailing_whitespace_mismatch_returns_opponent_color() {
        let config = Config {
            player_speakers: vec!["主格".to_string()],
            ..Config::default()
        };
        assert_eq!(config.color_name_for(Some("主格 ")), config.colors.opponent);
    }

    #[test]
    fn color_name_for_empty_string_speaker_matching_empty_in_list_returns_player_color() {
        let config = Config {
            player_speakers: vec!["".to_string()],
            ..Config::default()
        };
        assert_eq!(config.color_name_for(Some("")), config.colors.player);
    }

    #[test]
    fn splash_disabled_by_default_from_empty_toml() {
        let config = Config::from_toml_str("").expect("empty toml should parse");
        assert!(!config.should_show_splash());
    }

    #[test]
    fn splash_from_toml_with_lines_parses() {
        let toml =
            "[splash]\nenabled = true\nlines = [\"田田田\", \"回回回\"]\ncolor = \"yellow\"\n";
        let config = Config::from_toml_str(toml).expect("should parse");
        assert_eq!(config.splash.lines, vec!["田田田", "回回回"]);
        assert_eq!(config.splash.color, "yellow");
        assert!(config.should_show_splash());
    }

    #[test]
    fn should_show_splash_false_when_enabled_but_no_lines() {
        let config = Config {
            splash: SplashConfig {
                enabled: true,
                lines: vec![],
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert!(!config.should_show_splash());
    }

    #[test]
    fn should_show_splash_false_when_lines_present_but_disabled() {
        let config = Config {
            splash: SplashConfig {
                enabled: false,
                lines: vec!["田".to_string()],
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert!(!config.should_show_splash());
    }

    #[test]
    fn should_show_splash_true_when_enabled_and_lines_present() {
        let config = Config {
            splash: SplashConfig {
                enabled: true,
                lines: vec!["田".to_string()],
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert!(config.should_show_splash());
    }
}
