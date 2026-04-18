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
    },
    Narration {
        text: Vec<String>,
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
    pub chapters: Vec<Chapter>,
}
