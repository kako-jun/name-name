use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum BgmAction {
    Play,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum BlackoutAction {
    On,
    Off,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct ChoiceOption {
    pub text: String,
    pub jump: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum FlagValue {
    Bool(bool),
    String(String),
    Number(f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct RpgMapData {
    pub width: u32,
    pub height: u32,
    pub tile_size: u32,
    pub tiles: Vec<Vec<u8>>,
    /// タイル座標 [y][x] ごとの壁高さ（1.0 = 標準、0.5 = 半壁、2.0 = 二階建て等）。
    /// 未指定時は None。ランタイム fallback は 1.0。
    /// Issue #90 で Markdown `[壁高さ]` ブロックから読み込み可能にした。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_heights: Option<Vec<Vec<f64>>>,
    /// タイル座標 [y][x] ごとの床高さ（0.0 = 地面標準、0.5 = 半段、1.0 = 1タイル分上）。
    /// 未指定時は None。ランタイム fallback は 0.0。
    /// Issue #90 で Markdown `[床高さ]` ブロックから読み込み可能にした。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floor_heights: Option<Vec<Vec<f64>>>,
    /// タイル座標 [y][x] ごとの天井高さ（1.0 = 標準、0.5 = 低天井トンネル等）。
    /// 未指定時は None。ランタイム fallback は 1.0。
    /// Issue #90 で Markdown `[天井高さ]` ブロックから読み込み可能にした。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ceiling_heights: Option<Vec<Vec<f64>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct NpcData {
    pub id: String,
    pub name: String,
    pub x: u32,
    pub y: u32,
    pub color: u32,
    pub message: Vec<String>,
    /// スプライトシートへの相対パス（例: `character.png`）。
    /// 未指定の場合は従来どおり色付き四角で描画される。
    /// parser は値を生文字列として透過する（パス存在や形式の検証はレンダラー側の責務）。
    /// Markdown 属性は空白区切りのためパスに空白を含められない（引用記法は未対応）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sprite: Option<String>,
    /// 歩行アニメーションのフレーム数（方向あたり）。
    /// ドラクエ式の 2 フレーム（足踏み）が標準。未指定の場合はレンダラー側のデフォルト（= 2）を使う。
    /// parser は `>= 1` の整数を受理するだけ（上限チェックなし）。
    /// 実用上の妥当範囲 1〜4 はレンダラー側で clamp する想定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frames: Option<u32>,
    /// NPC が向いている方向。`向き=下` のように指定する。
    /// 未指定の場合はレンダラーのデフォルト（= `Down`）で描画される。
    /// 自律移動は未対応のためアイドル中はこの向きのまま。将来の「話しかけ時にプレイヤーを向く」拡張はレンダラー側で上書きする想定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
    /// 会話ダイアログに表示する顔画像（portrait）への相対パス（例: `elder_portrait.png`）。
    /// 未指定の場合は RpgDialogBox に顔枠が表示されず従来どおり名前＋本文のみの表示になる。
    /// Issue #73 Phase 1 で追加。VN 風の固定顔枠のみで、動的表情切替（Phase 2 / #101）は含まない。
    /// parser は値を生文字列として透過する（パス存在や形式の検証はレンダラー側の責務）。
    /// Markdown 属性は空白区切りのためパスに空白を含められない（引用記法は未対応）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portrait: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct PlayerStartData {
    pub x: u32,
    pub y: u32,
    pub direction: Direction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum Event {
    Dialog {
        character: Option<String>,
        expression: Option<String>,
        position: Option<String>,
        text: Vec<String>,
        /// per-line voice ファイルへの相対パス (#144)。
        /// `[ボイス: voice/line01.mp3]` ディレクティブで直後の Dialog/Narration に注入される。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voice_path: Option<String>,
    },
    Narration {
        text: Vec<String>,
        /// per-line voice ファイルへの相対パス (#144)。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voice_path: Option<String>,
    },
    Background {
        path: String,
    },
    Bgm {
        path: Option<String>,
        action: BgmAction,
    },
    Se {
        path: String,
    },
    Blackout {
        action: BlackoutAction,
    },
    SceneTransition,
    Exit {
        character: String,
    },
    Wait {
        ms: u32,
    },
    Choice {
        options: Vec<ChoiceOption>,
    },
    Flag {
        name: String,
        value: FlagValue,
    },
    Condition {
        flag: String,
        events: Vec<Event>,
    },
    ExpressionChange {
        character: String,
        expression: String,
    },
    RpgMap(RpgMapData),
    PlayerStart(PlayerStartData),
    Npc(NpcData),
    /// 立ち絵 / オブジェクトのアニメーション (#134)。
    ///
    /// 子供向け動画用途で「車が回転しながら横移動」「寿司が空から降ってくる」等の
    /// 表現を可能にする。target は表示中のキャラ名 (CharacterLayer 上の identifier)。
    /// fire-and-forget 方式: animation 開始と同時に次イベントへ進める。
    /// 動画 export 時の決定論的な再生は別 Issue で対応。
    Animate {
        /// アニメさせる対象。立ち絵の character 名 (例: "ナレーター", "車")
        target: String,
        /// X 軸の移動量 (px)。先頭 + / - で相対、なし or 数値のみで絶対座標。None で変更なし。
        /// 文字列で持つのは "+500" / "-200" / "400" のように相対/絶対を区別するため。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dx: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dy: Option<String>,
        /// 回転量 (degrees)。+ で相対加算、なしで絶対 (現在 = 0 起点)。None で変更なし。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rotation: Option<String>,
        /// スケール (1.0 = 等倍)。None で変更なし。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scale: Option<f32>,
        /// アニメ全体の所要時間 (ms)。
        duration_ms: u32,
        /// イージング関数。未指定は Linear。
        #[serde(default)]
        easing: Easing,
    },
    /// 文字ウィンドウ枠の ON/OFF を切り替える (#135)。
    ///
    /// `[枠なし]` で枠なしナレ風モードを ON、`[枠あり]` で元に戻す。
    /// per-game デフォルトは NovelRenderer 側の config で設定し、
    /// このイベントで per-scene 上書きできる。
    DialogBorderless {
        /// true = 枠なし、false = 枠あり
        borderless: bool,
    },
    /// 画面シェイク演出 (#143)。
    ///
    /// `[シェイク: intensity=10, duration=500]`
    /// intensity: 揺れ幅 px（デフォルト 10）、duration: 継続時間 ms（デフォルト 500）。
    /// 決定論的再現のため sin 波ベースで進捗率から位置を計算する。
    Shake {
        /// 揺れ幅 px
        #[serde(default = "default_shake_intensity")]
        intensity_px: u32,
        /// 継続時間 ms
        #[serde(default = "default_effect_duration")]
        duration_ms: u32,
    },
    /// フラッシュ演出 (#143)。
    ///
    /// `[フラッシュ: color=#ffffff, alpha=0.8, duration=300]`
    /// 指定色のオーバーレイを瞬時に表示し、duration かけてアルファ 0 へ fade out する。
    Flash {
        /// 色コード（例: "#ffffff"）
        #[serde(default = "default_flash_color")]
        color: String,
        /// ピーク時の不透明度 0.0〜1.0
        #[serde(default = "default_flash_alpha")]
        alpha: f32,
        /// フェードアウト時間 ms
        #[serde(default = "default_effect_duration")]
        duration_ms: u32,
    },
    /// フェード演出 (#143)。
    ///
    /// `[フェード: target=all, color=#000000, from=0, to=1, duration=500]`
    /// target: "bg"（背景のみ）または "all"（全画面）。
    /// from/to: アルファ値 0.0〜1.0。指定色のオーバーレイを from→to に補間する。
    Fade {
        /// "bg" or "all"
        #[serde(default = "default_fade_target")]
        target: String,
        /// 色コード（例: "#000000"）
        #[serde(default = "default_fade_color")]
        color: String,
        /// 開始アルファ 0.0〜1.0
        #[serde(default)]
        from_alpha: f32,
        /// 終了アルファ 0.0〜1.0
        #[serde(default = "default_fade_to_alpha")]
        to_alpha: f32,
        /// 継続時間 ms
        #[serde(default = "default_effect_duration")]
        duration_ms: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum Easing {
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum SceneView {
    #[default]
    TopDown,
    Raycast,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct Scene {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub view: SceneView,
    pub events: Vec<Event>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct Chapter {
    pub number: u32,
    pub title: String,
    pub hidden: bool,
    pub default_bgm: Option<String>,
    pub scenes: Vec<Scene>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct Document {
    pub engine: String,
    /// 画面比率。"16:9" / "4:3" / "9:16"。未指定時は "16:9"。
    #[serde(default = "default_aspect_ratio")]
    pub aspect_ratio: String,
    pub chapters: Vec<Chapter>,
}

fn default_aspect_ratio() -> String {
    "16:9".to_string()
}

fn default_shake_intensity() -> u32 {
    10
}

fn default_effect_duration() -> u32 {
    500
}

fn default_flash_color() -> String {
    "#ffffff".to_string()
}

fn default_flash_alpha() -> f32 {
    0.8
}

fn default_fade_target() -> String {
    "all".to_string()
}

fn default_fade_color() -> String {
    "#000000".to_string()
}

fn default_fade_to_alpha() -> f32 {
    1.0
}
