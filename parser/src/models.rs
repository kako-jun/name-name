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
    /// 確率エンカウントの分母（DQ4 式、`Math.random() < 1/N`）。
    /// `[エンカウント率: 1/16]` または `[エンカウント率: 16]` で指定。
    /// `0` は「絶対にエンカウントしない安全マップ」（街・室内向け）。未指定 = エンカウントなし。
    /// Issue #172 で追加。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encounter_rate: Option<u32>,
    /// エンカウント時に抽選される敵グループ名のリスト（重み均等）。
    /// `[エンカウント群: slime, ghost, slime+skeleton]` で指定。
    /// 各要素は単体モンスター ID または `+` 連結の複合（同時出現）。
    /// 未指定の場合 encounter_rate が設定されていてもエンカウントしない。
    /// Issue #172 で追加。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encounter_groups: Option<Vec<String>>,
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
    /// 未指定の場合は DialogBox に顔枠が表示されず従来どおり名前＋本文のみの表示になる。
    /// Issue #73 Phase 1 で追加。VN 風の固定顔枠のみで、動的表情切替（Phase 2 / #101）は別フィールド。
    /// parser は値を生文字列として透過する（パス存在や形式の検証はレンダラー側の責務）。
    /// Markdown 属性は空白区切りのためパスに空白を含められない（引用記法は未対応）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portrait: Option<String>,
    /// 表情差分マップ（#101 Phase 2）。
    /// キーは表情名（例: "normal" / "sad" / "angry"）、値は portrait 画像への相対パス。
    /// Markdown 属性は `expressions=normal:normal.png,sad:sad.png` の形式で指定する。
    /// NPC の message 内の `[expression=sad]` で実行時に portrait が切り替わる。
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub expressions: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct PlayerStartData {
    pub x: u32,
    pub y: u32,
    pub direction: Direction,
}

/// モンスター定義 (#174)。
///
/// 各章の `## data: マスター` シーン内に `[モンスター <id>] ... [/モンスター]` で書く。
/// 効果（特殊行動）が単純な式で書ききれない場合は `builtin: <slug>` でランタイム実装に委譲する。
/// 詳細は kako-jun と合意した「汎用関数 + 専用 builtin」二層設計を参照（#176）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct MonsterDef {
    pub id: String,
    pub name: String,
    pub hp: u32,
    #[serde(default)]
    pub mp: u32,
    pub atk: u32,
    /// `def` は Rust 予約語のため Rust 側は `def_value`、JSON / TS 側は `def` で透過する。
    #[serde(rename = "def")]
    pub def_value: u32,
    pub agi: u32,
    pub exp: u32,
    pub gold: u32,
    /// スプライトシートへの相対パス（`monsters/slime.png` 等）。未指定なら色塗り四角。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sprite: Option<String>,
    /// 専用関数 ID（"darkness_breath" 等）。指定時は通常攻撃以外の挙動が当該関数で完結する。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<String>,
}

/// アイテム定義 (#174)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct ItemDef {
    pub id: String,
    pub name: String,
    /// 種別（"回復" / "攻撃" / "武器" / "盾" / "鎧" / "兜" / "鍵" / "その他" 等）。
    /// runtime が文字列を解釈する。parser は値を透過するだけ。
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<u32>,
    /// 宣言的効果 DSL（"heal 30" / "damage 8..14 type=fire" 等）。`builtin` と排他。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<String>,
    /// 専用関数 ID（"world_tree_drop" / "wing_of_chimera" 等）。`effect` と排他。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<String>,
}

/// パーティメンバー定義 (#175)。
///
/// `[パーティ <id>]` ブロックで定義。プレイヤー側の戦闘エンティティ初期値を持つ。
/// レベルアップ後の状態はセーブデータ側で管理する想定で、ここは「Lv1 開始時」の値。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct PartyMemberDef {
    pub id: String,
    pub name: String,
    /// 立ち絵 / 戦闘スプライト相対パス
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sprite: Option<String>,
    /// 初期レベル（既定 1）
    #[serde(default = "default_level")]
    pub level: u32,
    pub hp: u32,
    #[serde(default)]
    pub mp: u32,
    pub atk: u32,
    /// `def` は Rust 予約語のため Rust 側は `def_value`、JSON / TS 側は `def` で透過する。
    #[serde(rename = "def")]
    pub def_value: u32,
    pub agi: u32,
    /// レベルアップで習得する呪文（順不同）。`{ level: 4, spell: "ホイミ" }` 形式。
    /// Phase 1 ではデータとして保持するだけ、ランタイム評価は #175 follow-up。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub learns: Option<Vec<PartyLearns>>,
}

/// パーティメンバーの呪文習得スロット (#175)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct PartyLearns {
    pub level: u32,
    pub spell: String,
}

fn default_level() -> u32 {
    1
}

/// 呪文定義 (#174)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct SpellDef {
    pub id: String,
    pub name: String,
    pub mp: u32,
    /// 対象（"味方単体" / "敵単体" / "味方全体" / "敵全体" / "自分" / "マップ" 等）。
    pub target: String,
    /// 宣言的効果 DSL（"heal 15..25" / "damage 30..50 type=ice" 等）。`builtin` と排他。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<String>,
    /// 専用関数 ID（"zaraki" / "ruula" / "rariho" 等）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<String>,
    /// 系統（"fire" / "ice" / "holy" / "breath" 等、耐性計算用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub school: Option<String>,
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
        /// per-line フォント上書き (#147)。CSS の font-family 文字列。
        /// `[フォント: Klee One, cursive]` ディレクティブで直後の Dialog/Narration に注入される。
        /// 未指定の場合は Document.font_family（per-game 既定）→ runtime 既定の順でフォールバック。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        font_family: Option<String>,
    },
    Narration {
        text: Vec<String>,
        /// per-line voice ファイルへの相対パス (#144)。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voice_path: Option<String>,
        /// per-line フォント上書き (#147)。詳細は Dialog::font_family を参照。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        font_family: Option<String>,
    },
    Background {
        path: String,
    },
    Bgm {
        path: Option<String>,
        action: BgmAction,
        /// BGM フェード時間 ms (#145)。
        /// `Play` のときは fade-in、`Stop` のときは fade-out 時間。
        /// `None` の場合: Play は fade-in なし（即時フル音量）、Stop はランタイム実装依存のフォールバック値
        /// （現在の AudioManager 既定値は 1000ms）。
        /// Markdown 構文: `[BGM: path, フェード=500]` / `[BGM停止: 2000]` / `[BGM停止: フェード=2000]`
        /// emit 時は `[BGM停止: 2000]` も `[BGM停止: フェード=2000]` の形式に正規化される。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_ms: Option<u32>,
    },
    Se {
        path: String,
        /// SE fade-in 時間 ms (#145)。
        /// `None` なら fade-in なし（従来通り即時再生）。
        /// Markdown 構文: `[SE: path, フェード=200]`
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_ms: Option<u32>,
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
    /// モンスター定義 (#174)。`[モンスター <id>] ... [/モンスター]` ブロックで書く。
    /// シナリオシーンからは ID 参照（`[エンカウント群: slime, ghost]` 等）で利用する。
    Monster(MonsterDef),
    /// アイテム定義 (#174)。`[アイテム <id>] ... [/アイテム]` ブロックで書く。
    Item(ItemDef),
    /// 呪文定義 (#174)。`[呪文 <id>] ... [/呪文]` ブロックで書く。
    Spell(SpellDef),
    /// パーティメンバー定義 (#175)。`[パーティ <id>] ... [/パーティ]` ブロックで書く。
    PartyMember(PartyMemberDef),
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
    /// 選択肢スタイル名 (#146)。`default` / `soft` / `monochrome` を想定。
    /// 未指定時は `None`（runtime で `default` 扱い）。
    /// frontmatter `choice_style: soft` で per-game 切替可能。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice_style: Option<String>,
    /// per-game デフォルトフォント (#147)。CSS の font-family 文字列を生で受け取る。
    /// 例: "Klee One, cursive" / "Hina Mincho, serif"。
    /// 未指定時は runtime 既定 (`'Noto Sans JP', sans-serif`)。
    /// 個別行で上書きしたい場合は [フォント: ...] ディレクティブで Dialog/Narration 直前に指定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
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
