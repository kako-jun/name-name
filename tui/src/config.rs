//! ゲームごとに変わりうる値（データパス・レイアウト種別・配色）を外出しにするための型。
//!
//! tui 本体のロジック（playback / ui / input）にゲーム固有の文字列を直書きしないための境界。
//! デフォルト値は最初の適用対象である gymnasia の値
//! （`docs/design/experience-system.md` の TUI Implementation Plan: プレイヤー側=白、相手側=水色）を
//! サンプルとして使うが、他のゲームは別の Config を用意すればよい。全ゲーム対応を前提にした
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
