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

/// タイプライター演出（`jiwa::RevealHandle`）の速度設定（#472）。
/// kako-jun/jiwa の `RevealOpts` のうち、色（`fade_from`/`fade_to`）は既存の
/// `ColorConfig`（話者ごとの配色）から導出するため対象外。速度だけがゲームごとに
/// 変わりうる値としてここに外出しされる。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct TypewriterConfig {
    /// 1グラフェムごとの表示間隔（ミリ秒）。0 なら全文が一括で表示される
    /// （`jiwa::RevealOpts::char_interval` と同じ意味）。
    pub char_interval_ms: u64,
    /// 各グラフェムがフェードインするのに掛ける時間（ミリ秒）。0 なら即座に最終色で表示される
    /// （`jiwa::RevealOpts::fade_duration` と同じ意味）。
    pub fade_duration_ms: u64,
}

impl Default for TypewriterConfig {
    fn default() -> Self {
        // `jiwa::RevealOpts::soft_green()` と同じ値（45ms 間隔 / 320ms フェード）。
        // kako-jun/type-globe の `src/ui/quiz.rs` もこのプリセットをそのまま使っている。
        Self {
            char_interval_ms: 45,
            fade_duration_ms: 320,
        }
    }
}

/// 起動直後に表示するスプラッシュ画面の設定。
///
/// `enabled` が `false`（既定）または（`logo_image` が `None` かつ `lines` が空）の場合は
/// スプラッシュを表示せず、従来通りいきなり本編から始まる（後方互換）。ロゴの内容
/// （ASCII アート本体・画像ファイル）はゲームごとに異なるため、`tui` 本体には一切
/// 埋め込まず、この設定を通じて外部化する。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SplashConfig {
    /// スプラッシュ画面を表示するかどうか。
    pub enabled: bool,
    /// 画面中央に表示するロゴの行。1要素が1行に対応する。`logo_image` が `Some` の場合は
    /// 無視され、フルキャンバス画像表示モード（#530）が優先される。
    pub lines: Vec<String>,
    /// ロゴ行の文字色名（`ratatui::style::Color` の `FromStr` が解釈できる名前）。
    /// `logo_image` モードでは使わない（テキスト行が無いため）。
    pub color: String,
    /// スプラッシュをテキスト行の代わりに画像で表示する場合のファイルパス（#530）。
    /// `event_image.assets_dir` を基点とする相対パスとして解決される
    /// （[`Config::resolve_splash_logo_path`]、`DisplayLine::event_image` と同じ解決規則）。
    /// `None`（既定）なら従来どおり `lines` のテキストモードにフォールバックする
    /// （TOML未指定時・画像ロード失敗時のどちらも）。
    pub logo_image: Option<PathBuf>,
    /// フルキャンバス画像表示モードのスクロール（`Action::MoveUp`/`MoveDown`）を
    /// 目標位置へなめらかに追従させる ease-out アニメーションの所要時間（ミリ秒、
    /// kako-jun追加要望）。`event_image.crossfade_ms`（[`EventImageConfig::crossfade_ms`]）と
    /// 同じ「設定ファイルで所要時間msを指定できる」方式。0 にするとアニメーション無しの
    /// 即時ジャンプになる（[`crate::image_render::compute_scroll_ease_progress`] 参照）。
    pub scroll_ease_ms: u64,
}

impl Default for SplashConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            lines: Vec::new(),
            color: "white".to_string(),
            logo_image: None,
            scroll_ease_ms: 300,
        }
    }
}

/// イベント絵アセット関連の設定（quadrant block描画 + jiwaクロスフェード、#481）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct EventImageConfig {
    /// Markdown 原稿中の `[イベント絵: props/x.webp]` のような相対パスの基点ディレクトリ。
    /// gymnasia はリポジトリルート基準の `assets/images`。
    pub assets_dir: PathBuf,
    /// 画像切り替え（前の画像→次の画像。`None`⇄`Some` の出現/退場を含む）の
    /// クロスフェード所要時間 (ms)。GUI版 `NovelRenderer.EVENT_IMAGE_FADE_MS`
    /// （既定700ms）と揃え、TUI版の既定値もそれに合わせる。
    pub crossfade_ms: u64,
}

impl Default for EventImageConfig {
    fn default() -> Self {
        Self {
            assets_dir: PathBuf::from("assets/images"),
            crossfade_ms: 700,
        }
    }
}

/// テキスト速度調整UI（#503）がプレイ中に選べる `char_interval_ms` の上限・刻み幅。
/// GUI版 `SettingsOverlay.tsx` の msPerChar スライダー（min=0, max=200, step=5）と同じ値を
/// 採用し、TUI/GUI間で体感速度のレンジ感を揃える。GUI版 `clampSettings`
/// （`frontend/src/game/settings.ts`）の実際の許容上限は500だが、それはスライダーの外側
/// （手入力やlocalStorage改変）を想定した保険的な上限で、UI上で選べる範囲はスライダーの
/// min/maxである0..200。TUIの設定画面もキー操作で選べる範囲として同じ0..200を採用する。
/// 下限（0 = 瞬間表示）は明示定数を持たない — `char_interval_ms: u64` の自然な下限が既に
/// 0であり、速くする方向の調整（`saturating_sub`）はそれ以上下がりようがないため、
/// `TEXT_SPEED_MIN_MS: u64 = 0` を定義しても常に no-op になり clippy
/// `unnecessary_min_or_max` に指摘される（実際に踏んで削除した、#503）。
pub const TEXT_SPEED_MAX_MS: u64 = 200;
pub const TEXT_SPEED_STEP_MS: u64 = 5;

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
    pub typewriter: TypewriterConfig,
    /// イベント絵アセットの基点ディレクトリ・クロスフェード時間（#481）。
    pub event_image: EventImageConfig,
    /// adv 表示を文単位（`splitIntoSentences` 相当）で改頁するか（#486）。既定 `false` は
    /// 従来どおり markdown 行単位の一括表示（非破壊）。GUI版 frontmatter `sentence_per_page:`
    /// とは別軸 — TUI は原稿の per-game frontmatter を読まず、`tui-config.toml` 側のこの
    /// フィールドで独立に制御する（`dialog_style` を TUI が常に adv 固定で運用しているのと
    /// 同じ「TUI は自前の Config で制御する」設計）。
    pub sentence_per_page: bool,
    /// オートモード（#498）で、現在行のタイプライター表示が完了してから次行へ自動的に
    /// 進むまでの待機時間 (ms)。GUI版 `NovelRenderer.autoWaitMs`/`settings.autoWaitMs` の
    /// 既定値（2500ms）と揃える。
    pub auto_wait_ms: u64,
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
            typewriter: TypewriterConfig::default(),
            event_image: EventImageConfig::default(),
            sentence_per_page: false,
            auto_wait_ms: 2500,
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

    /// スプラッシュ画面を表示すべきか（`enabled` かつ、画像ロゴ（`logo_image`）が
    /// 設定されているかロゴ行が1行以上ある場合、#530）。
    pub fn should_show_splash(&self) -> bool {
        self.splash.enabled && (self.splash.logo_image.is_some() || !self.splash.lines.is_empty())
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

    /// Markdown 原稿中の画像相対パス（`DisplayLine::event_image`、例: `props/x.webp`）を
    /// `event_image.assets_dir` と結合し、実ファイルパスへ解決する（#481）。
    ///
    /// `relative` が `..`（親ディレクトリ参照）や絶対パス（`/` 始まり、Windows の
    /// プレフィックス等）を含む場合は `assets_dir` の外を指しうるため `None` を返す
    /// （呼び出し側 [`crate::image_fade`] はデコード失敗と同様にプレースホルダへ
    /// フォールバックする）。原稿は基本的に信頼できる作者が書くものだが、
    /// `assets_dir` に閉じ込める意図の関数として最低限のガードを持たせる。
    pub fn resolve_image_path(&self, relative: &str) -> Option<PathBuf> {
        let is_safe = Path::new(relative)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)));
        if !is_safe {
            return None;
        }
        Some(self.event_image.assets_dir.join(relative))
    }

    /// `splash.logo_image`（`Some` の場合）を実ファイルパスへ解決する（#530）。
    /// `event_image.assets_dir` を基点にする点・親ディレクトリ参照/絶対パスを拒む点は
    /// [`Config::resolve_image_path`] と同じ（内部でそのまま再利用する）。`logo_image` が
    /// `None`、または安全でないパスの場合は `None` を返す — 呼び出し側（`ui::draw_splash`）
    /// はテキストモード（`splash.lines`）へフォールバックする。
    pub fn resolve_splash_logo_path(&self) -> Option<PathBuf> {
        let logo_image = self.splash.logo_image.as_ref()?;
        self.resolve_image_path(&logo_image.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_speed_range_matches_gui_slider_bounds() {
        // GUI版 `SettingsOverlay.tsx` の msPerChar スライダー（min=0, max=200, step=5）と
        // 同じ値であることを固定する（#503。下限0は `TypewriterConfig::char_interval_ms`
        // の型（u64）が自然に持つ下限のため専用定数を持たない、上のdoc comment参照）。
        assert_eq!(TEXT_SPEED_MAX_MS, 200);
        assert_eq!(TEXT_SPEED_STEP_MS, 5);
    }

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
        assert_eq!(config.typewriter.char_interval_ms, 45);
        assert_eq!(config.typewriter.fade_duration_ms, 320);
        assert_eq!(
            config.event_image.assets_dir,
            PathBuf::from("assets/images")
        );
        assert_eq!(config.event_image.crossfade_ms, 700);
        assert!(!config.sentence_per_page);
        assert_eq!(config.auto_wait_ms, 2500);
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
    fn from_toml_str_partial_typewriter_override_keeps_rest_default() {
        let toml = "[typewriter]\nchar_interval_ms = 10\n";
        let config = Config::from_toml_str(toml).expect("should parse");
        assert_eq!(config.typewriter.char_interval_ms, 10);
        assert_eq!(
            config.typewriter.fade_duration_ms,
            Config::default().typewriter.fade_duration_ms
        );
    }

    #[test]
    fn from_toml_str_partial_event_image_override_keeps_rest_default() {
        let toml = "[event_image]\ncrossfade_ms = 250\n";
        let config = Config::from_toml_str(toml).expect("should parse");
        assert_eq!(config.event_image.crossfade_ms, 250);
        assert_eq!(
            config.event_image.assets_dir,
            Config::default().event_image.assets_dir
        );
    }

    #[test]
    fn resolve_image_path_joins_assets_dir_and_relative_path() {
        let config = Config {
            event_image: EventImageConfig {
                assets_dir: PathBuf::from("assets/images"),
                ..EventImageConfig::default()
            },
            ..Config::default()
        };
        assert_eq!(
            config.resolve_image_path("props/candle.webp"),
            Some(PathBuf::from("assets/images/props/candle.webp"))
        );
    }

    #[test]
    fn resolve_image_path_rejects_parent_dir_traversal() {
        let config = Config {
            event_image: EventImageConfig {
                assets_dir: PathBuf::from("assets/images"),
                ..EventImageConfig::default()
            },
            ..Config::default()
        };
        assert_eq!(config.resolve_image_path("../../secret.txt"), None);
    }

    #[test]
    fn resolve_image_path_rejects_absolute_path() {
        let config = Config {
            event_image: EventImageConfig {
                assets_dir: PathBuf::from("assets/images"),
                ..EventImageConfig::default()
            },
            ..Config::default()
        };
        assert_eq!(config.resolve_image_path("/etc/passwd"), None);
    }

    #[test]
    fn from_toml_str_sentence_per_page_true_at_top_level() {
        // 既存フィールド（game_name 等）と同じ階層（サブテーブルなし）で読める（#486）。
        let toml = "sentence_per_page = true\n";
        let config = Config::from_toml_str(toml).expect("should parse");
        assert!(config.sentence_per_page);
        assert_eq!(config.game_name, Config::default().game_name);
    }

    #[test]
    fn from_toml_str_sentence_per_page_absent_defaults_to_false() {
        let config = Config::from_toml_str("").expect("empty toml should parse");
        assert!(!config.sentence_per_page);
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

    #[test]
    fn should_show_splash_true_when_lines_contains_only_empty_string() {
        // 要素数1件（空文字列のみ）は「lines が空」ではないため true になる。
        // `should_show_splash` は要素数のみ見て中身の文字数までは判定しない仕様。
        let config = Config {
            splash: SplashConfig {
                enabled: true,
                lines: vec!["".to_string()],
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert!(config.should_show_splash());
    }

    #[test]
    fn from_toml_str_splash_color_missing_defaults_to_white() {
        let toml = "[splash]\nenabled = true\nlines = [\"田\"]\n";
        let config = Config::from_toml_str(toml).expect("should parse");
        assert_eq!(config.splash.color, SplashConfig::default().color);
    }

    #[test]
    fn from_toml_str_splash_lines_type_mismatch_is_err() {
        let toml = "[splash]\nlines = [1, 2, 3]\n";
        let result = Config::from_toml_str(toml);
        assert!(result.is_err());
    }

    // ---- フルキャンバス画像表示モード（#530）----

    #[test]
    fn splash_config_default_logo_image_is_none() {
        assert_eq!(SplashConfig::default().logo_image, None);
    }

    #[test]
    fn splash_config_default_scroll_ease_ms_is_300() {
        assert_eq!(SplashConfig::default().scroll_ease_ms, 300);
    }

    #[test]
    fn should_show_splash_true_when_logo_image_set_even_if_lines_empty() {
        let config = Config {
            splash: SplashConfig {
                enabled: true,
                lines: vec![],
                logo_image: Some(PathBuf::from("logo.webp")),
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert!(config.should_show_splash());
    }

    #[test]
    fn should_show_splash_true_when_both_logo_image_and_lines_present() {
        let config = Config {
            splash: SplashConfig {
                enabled: true,
                lines: vec!["田".to_string()],
                logo_image: Some(PathBuf::from("logo.webp")),
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert!(config.should_show_splash());
    }

    #[test]
    fn should_show_splash_false_when_disabled_even_with_logo_image_set() {
        let config = Config {
            splash: SplashConfig {
                enabled: false,
                logo_image: Some(PathBuf::from("logo.webp")),
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert!(!config.should_show_splash());
    }

    #[test]
    fn resolve_splash_logo_path_none_when_logo_image_not_set() {
        let config = Config {
            splash: SplashConfig {
                logo_image: None,
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert_eq!(config.resolve_splash_logo_path(), None);
    }

    #[test]
    fn resolve_splash_logo_path_joins_assets_dir_and_relative_path() {
        let config = Config {
            event_image: EventImageConfig {
                assets_dir: PathBuf::from("assets/images"),
                ..EventImageConfig::default()
            },
            splash: SplashConfig {
                logo_image: Some(PathBuf::from("props/logo.webp")),
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert_eq!(
            config.resolve_splash_logo_path(),
            Some(PathBuf::from("assets/images/props/logo.webp"))
        );
    }

    #[test]
    fn resolve_splash_logo_path_rejects_parent_dir_traversal() {
        let config = Config {
            event_image: EventImageConfig {
                assets_dir: PathBuf::from("assets/images"),
                ..EventImageConfig::default()
            },
            splash: SplashConfig {
                logo_image: Some(PathBuf::from("../../secret.webp")),
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert_eq!(config.resolve_splash_logo_path(), None);
    }

    #[test]
    fn resolve_splash_logo_path_rejects_absolute_path() {
        let config = Config {
            event_image: EventImageConfig {
                assets_dir: PathBuf::from("assets/images"),
                ..EventImageConfig::default()
            },
            splash: SplashConfig {
                logo_image: Some(PathBuf::from("/etc/passwd")),
                ..SplashConfig::default()
            },
            ..Config::default()
        };
        assert_eq!(config.resolve_splash_logo_path(), None);
    }

    #[test]
    fn from_toml_str_partial_splash_logo_image_override_keeps_rest_default() {
        let toml = "[splash]\nlogo_image = \"x.webp\"\nscroll_ease_ms = 100\n";
        let config = Config::from_toml_str(toml).expect("should parse");
        assert_eq!(config.splash.logo_image, Some(PathBuf::from("x.webp")));
        assert_eq!(config.splash.scroll_ease_ms, 100);
        assert_eq!(config.splash.enabled, SplashConfig::default().enabled);
        assert_eq!(config.splash.lines, SplashConfig::default().lines);
        assert_eq!(config.splash.color, SplashConfig::default().color);
    }
}
