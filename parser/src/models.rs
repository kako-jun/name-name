use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

/// RPG イベントのコマンド単体 (#187 / #196)。
/// RpgEvent の commands に列挙され、EventRunner が順に実行する。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(tag = "type")]
pub enum EventCommand {
    /// NPC をタイル単位でアニメ移動させる。
    /// `[NPC移動: 長老 → @5,3 速度=1]`
    NpcMove {
        npc: String,
        x: u32,
        y: u32,
        /// タイル/秒。既定 3。
        #[serde(default = "default_npc_move_speed")]
        speed: u32,
        /// 移動後の向き。未指定なら移動方向に自動設定。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        direction: Option<Direction>,
    },
    /// 指定 ms 待機する。`[待機: 500]`
    Wait { ms: u32 },
    /// 台詞を表示する。既存 Dialog イベントに対応。
    Dialog {
        character: Option<String>,
        text: Vec<String>,
    },
    /// ナレーションを表示する。
    Narration { text: Vec<String> },
}

fn default_npc_move_speed() -> u32 {
    3
}

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
    /// 「はなす」時に再生するイベント名（#187）。
    /// 指定時は `message` の代わりにこのイベントを EventRunner で再生する。
    /// 未指定の場合は従来通り `message` を DialogBox に表示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene: Option<String>,
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
        /// 立ち絵の明示フィット指定 (#294)。話者行のオプションに `フィット` / `fit` を書くと true。
        /// `true` のときだけ「論理画面より大きい立ち絵を画面内に収める」旧 fit-down を適用する
        /// （大きい時だけ縮小・小さい時は原寸）。既定（`false`）は原寸（scale=1）で表示する。
        /// サイズや位置で自動分岐はしない（明示指定だけが縮小のトリガ）。novel/adv で分けない。
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        fit: bool,
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
        /// #250 端フェードマスク（px）— 各端から内側へのフェード帯の幅をスクリーン座標系の px で指定。
        /// 帯の最外端（画面端）で alpha=0（完全透明）、内側境界で alpha=1（不透明）。線形。
        /// `None` または 0 はフェードなし。端末キャプチャの余白隠し / 手紙風オーバーレイ用。
        /// Markdown 構文: `[背景: path, フェード上=40, フェード下=60, フェード左=0, フェード右=0]`
        /// 英語 alias: `fade_top` / `fade_bottom` / `fade_left` / `fade_right`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_top: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_bottom: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_left: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_right: Option<u32>,
        /// 背景の明るさ（brightness）。同一画像をシーン毎に減光して「暗いシーンは背景も暗くする」
        /// 演出に使う。`0.0`〜`1.0`（`1.0` = 原画のまま＝既定、`0.6` = 60% の明るさ＝暗め）。
        /// レンダラー側で背景スプライトの `tint = rgb(b*255, b*255, b*255)` として乗算適用する。
        /// `None`（未指定）は `1.0` 扱い＝原画のまま（後方互換: 既存背景は不変）。
        /// パーサーは `0.0..=1.0` にクランプし、`1.0` ちょうど・不正値・空は `None` に倒す
        /// （`tint=白` の原画と同義になるため round-trip でも kv を出さない）。
        /// Markdown 構文: `[背景: path, 明るさ=0.6]`。英語 alias: `brightness`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        brightness: Option<f32>,
    },
    /// 動画入力レイヤ (#252)。立ち絵/背景と同じ枠組みで動画ファイルをレイヤとして配置・再生する。
    /// 背景と同じく単一スロット意味論: 新しい `[動画:]` は前の動画を置換する。
    /// 音声トラックがある動画は既定でミックス再生する（`mute=true` で無音化）。
    /// Markdown 構文:
    /// `[動画: capture.webm, 位置=中央, スケール=1.0, ループ=true, ミュート=false, フェード上=40, フェード下=60]`
    /// 英語 alias: `position` / `scale` / `loop` / `mute` / `fade_top` 等。
    /// アセットパスは `assetBaseUrl + '/videos/' + path`。
    Video {
        path: String,
        /// 配置位置（`左` / `中央` / `右`、英語 alias `left` / `center` / `right`）。`None` は中央扱い。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<String>,
        /// 拡大率（f32）。`None` は cover-fit 相当（画面いっぱいに敷く）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scale: Option<f32>,
        /// ループ再生するか。`None`/`false` は 1 回再生。serde は予約語回避のため `loop` 名で出力。
        #[serde(rename = "loop", default, skip_serializing_if = "Option::is_none")]
        loop_: Option<bool>,
        /// 音声をミュートするか。`None`/`false` はミックス再生（音声トラックがあれば鳴る）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mute: Option<bool>,
        /// 端フェードマスク（px）— #250 の背景フェードと同義。`None`/0 はフェードなし。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_top: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_bottom: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_left: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade_right: Option<u32>,
    },
    /// 動画レイヤをクリアする (#252)。Markdown 構文: `[動画退場]`。
    VideoExit,
    /// 単色の地色 (#273)。背景画像 (`Background`) と同じ永続状態として扱う。
    /// `[背景色: #f5f0e8]` で画面全面を 1 色で塗る。NovelGameState に持たせ、
    /// snapshot / applyState / セーブ復元の全経路で復元可能（doctrine 規律3）。
    /// 色文字列は trim してそのまま保持する生 CSS hex（`#f5f0e8` 等）。
    /// ディレクティブ名は日本語 `背景色` のみ（`背景` と同じく EN エイリアスなし）。
    BackgroundColor {
        color: String,
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
    /// 手動改頁マーカー (#292 Phase 2)。本文中の単独行 `---` から生成される。
    ///
    /// `dialog_style: novel` で「自動改頁（文がページに収まる範囲で貪欲に詰める #283/#292）」の
    /// 上に乗る**人間が明示的に入れる強制ページ境界**。「もっと早く改頁したい」ときだけ書く。
    /// frontmatter 区切りの `---`（ファイル先頭ブロックのみ）とは別物で、本文（frontmatter
    /// 終了後）の単独 `---` 行だけがこれになる。
    ///
    /// 型表現の方針: text 配列に魔法の文字列を混ぜるのは脆い（doctrine 規律2「型を先に確定」）。
    /// 代わりに一級の unit variant にし、parser は本文 `---` でセリフ（Dialog/Narration）の
    /// text 蓄積を打ち切り、その間に `PageBreak` を挟む（＝Dialog を分割する）。各 text イベントは
    /// runtime 側で独立にページ分割される（`getNovelPages`）ため、イベントの切れ目がそのまま
    /// 強制ページ境界になり、`paginateSentencesByLines`（#283/#292）に手を入れず非回帰を保てる。
    /// emitter は単独 `---` 行に戻すので往復で保たれる。serde の unit variant は文字列
    /// `"PageBreak"` として表現され、TS 側は非テキストイベントとして単に読み飛ばす。
    /// adv（`dialog_style` 未指定/adv）では runtime が描画イベントを持たないため実害なく無視される。
    PageBreak,
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
    /// RPG イベント定義 (#187)。
    /// `[イベント <name>] ... [/イベント]` ブロックで書く。
    /// トリガーから scene 名で参照される。
    RpgEvent {
        name: String,
        commands: Vec<EventCommand>,
    },
    /// RPG トリガー定義 (#187)。
    /// タイル踏み込み: `[トリガー @x,y scene=xxx once=true]`
    /// マップ進入時: `[トリガー auto scene=xxx]`
    RpgTrigger {
        /// 踏み込みトリガーの座標。auto トリガーの場合は None。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<u32>,
        /// true のときマップ進入時に自動発火。x/y と排他。
        #[serde(default)]
        auto: bool,
        /// 実行するイベント名。
        scene: String,
        /// true のとき初回のみ発火（SaveManager でフラグ管理）。
        #[serde(default)]
        once: bool,
    },
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
    /// グリフ単位の文字アニメ (#268)。`[アニメ]` のグリフ単位版。
    ///
    /// 対象テキスト（CharacterLayer 上の identifier。例 "Title"）をグリフに分解し、
    /// 各グリフが「開始オフセット → 整列位置」へ stagger 付きで入る enter アニメ。
    /// 合成可能なプリミティブ（dx/dy/scale/rotation/alpha + 間隔/duration/easing）と、
    /// 名前付きプリセット（爆発/タイプ）の 2 層構成。
    ///
    /// プリセット → プリミティブ既定値の展開は **TS ランタイム側** で行う（単一責務）。
    /// parser は指定された値を素直に持たせるだけで、未指定は serde で skip する。
    /// fire-and-forget 方式: 開始と同時に次イベントへ進む（Animate と同じ）。
    /// 全タイミングは TimeController 駆動で決定論的（Math.random 不使用）。
    TextEffect {
        /// 効果をかける対象。CharacterLayer 上の identifier（例 "Title"）。
        target: String,
        /// 名前付きプリセット。未指定なら素のプリミティブのみ。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effect: Option<TextEffectPreset>,
        /// グリフ間の開始遅延 (ms)。グリフ i は `i * stagger_ms` 遅れて開始する。
        /// 日本語キー `間隔` / 英語 `stagger`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stagger_ms: Option<u32>,
        /// `効果=タイプ` の 1 文字あたり表示時間 (ms)。日本語キー `速度` / 英語 `speed`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ms_per_char: Option<u32>,
        /// 開始オフセット（最終整列位置を 0 とする相対開始値）。Animate と同じく相対/絶対を
        /// 区別するため文字列で持つ。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dx: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dy: Option<String>,
        /// 開始時の回転 (degrees)。最終整列位置を 0 とする相対開始値。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rotation: Option<String>,
        /// 開始時のスケール（最終は 1.0 = 等倍）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scale: Option<f32>,
        /// 開始時のアルファ（最終は 1.0 = 不透明）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alpha: Option<f32>,
        /// 各グリフのアニメ所要時間 (ms)。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u32>,
        /// イージング関数。未指定なら TS 側でプリセット既定 → Linear に倒す。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        easing: Option<Easing>,
        /// `効果=タイプ` 専用: タイプ末尾の点滅カーソルを出すか (#271)。
        /// 日本語キー `カーソル` / 英語 `cursor`（on/off）。`Some(true)` で表示。
        /// reveal 以外の効果では TS 側で無視される。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<bool>,
        /// カーソルの点滅周期 (ms)。半周期で表示/非表示が切り替わる (#271)。
        /// 日本語キー `点滅` / 英語 `blink`。未指定なら TS 側で既定 600ms。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blink_ms: Option<u32>,
        /// カーソル色 (CSS カラー文字列、例 "#2b6cb0") (#271)。
        /// 日本語キー `カーソル色` / 英語 `cursor_color`。未指定なら TS 側で文字色を流用。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor_color: Option<String>,
    },
    /// 下線ビーム (#270)。
    ///
    /// orber 宣伝動画の OP タイトルカード（opening.html の `drawLine` / scaleX 0→1）の
    /// 忠実再現。対象テキスト（CharacterLayer 上の identifier。例 "Title"）の
    /// レンダリング済み幅に自動フィットする横線を直下に置き、左から伸ばす。
    ///
    /// `[文字演出]` とは別系統の「図形プリミティブ」。グリフ効果ではなく線なので
    /// 独立ディレクティブとして新設した（kako-jun 承認）。
    /// プリセット既定値の展開は **TS ランタイム側** で行い、parser は値を素直に持つ。
    /// fire-and-forget 方式: 開始と同時に次イベントへ進む（Animate と同じ）。
    /// 全タイミングは TimeController 駆動で決定論的（Math.random 不使用）。
    /// ADR0002 準拠: 伸び途中の中間状態は持たず、復元/skip は伸び切った静止線に畳む。
    Underline {
        /// 下線をかける対象。CharacterLayer 上の identifier（例 "Title"）。
        target: String,
        /// 線の色 (CSS カラー文字列)。日本語キー `色` / 英語 `color`。未指定は TS 既定 `#1a4a7a`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        /// 線の太さ (px)。日本語キー `太さ` / 英語 `thickness`。未指定は TS 既定 3。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thickness: Option<u32>,
        /// 伸長アニメ所要 (ms)。日本語キー `時間` / 英語 `duration`。未指定は TS 既定 700。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u32>,
        /// テキスト下端からの距離 (px)。日本語キー `余白` / 英語 `offset`。
        /// 未指定なら TS 側で測定値から自動算出する。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<u32>,
        /// イージング関数。未指定なら TS 側で既定 EaseIn に倒す。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        easing: Option<Easing>,
    },
    /// 動画タイトル表示 (llll-ll-media 用、#TBD)。
    /// `[タイトル: TEXT]` で画面中央に Text オーバーレイを出す。
    /// `target=Title` で [アニメ] のターゲットになれるよう、CharacterLayer に
    /// 名前 "Title" の text-only キャラとして登録される。
    /// 既に Title が表示されているときは text を差し替える。空文字なら退場。
    TitleShow {
        text: String,
        /// font 指定。未指定なら chapter の font_family を使う。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        font_family: Option<String>,
        /// 初期位置 (右外 / 中央 / 左外 等)。未指定なら center。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<String>,
        /// タイトル文字色 (CSS カラー文字列、例 "#1a4a7a") (#273)。
        /// 未指定なら TS 側で白 (`CharacterLayer.TITLE_FILL`) にフォールバック。
        /// 色はグリフ演出 (爆発) とカーソルにも波及する（OP の "orber" を紺で爆発させる）。
        /// 日本語キー `色` / 英語 `color`（`Underline` の color と同形）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        /// 文字サイズ (px) (#275)。日本語キー `サイズ` / 英語 `size`。未指定は TS 既定 64
        /// （closing の tool-name は 56、opening は 64）。グリフ演出のグリフも同 size。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u32>,
        /// 横位置の比率 override (0..1 の float) (#275)。日本語/英語とも `x`。
        /// 指定時は `position` トークンより優先して xRatio に使う（テンプレ厳密配置用）。
        /// 範囲外・非数値は TS 側で無視してトークンにフォールバックする。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        /// 縦位置の比率 override (0..1 の float) (#275)。日本語/英語とも `y`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
    },
    /// 単独の色付きラベル (#274)。orber OP タイトルカードの肩書 / 名前のような、
    /// 立ち絵に紐付かない単独テキストを任意の 2D 位置に出す。
    /// `[ラベル: kako-jun, 色=#2b6cb0, 位置=中, サイズ=22, id=name]`。
    /// `[タイトル]`（TitleShow）と同様、CharacterLayer に id（既定 "Label"）名で登録される
    /// ため `[文字演出: id, …]` / `[下線: id, …]` / `[アニメ: target=id, …]` の対象になれる。
    /// 演出表示（render-only）であり `NovelGameState.characters` には漏らさない（doctrine 規律3）。
    Label {
        /// ラベル本文。
        text: String,
        /// 文字色 (CSS カラー文字列、例 "#7a9abf")。日本語キー `色` / 英語 `color`。
        /// 未指定なら TS 側で白にフォールバック。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        /// 2D 位置トークン（縦+横、例 "中上" / "左下" / "中"）。日本語キー `位置` / 英語 `position`。
        /// 解釈は TS 側の `resolveLayoutPosition` 純関数。未指定は中央。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<String>,
        /// 文字サイズ (px)。日本語キー `サイズ` / 英語 `size`。未指定は TS 既定 24。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u32>,
        /// 演出対象 identifier。日本語/英語とも `id`。未指定は TS 側で既定 "Label"。
        /// 複数ラベル共存のため id 指定を推奨（id ごとに別スロットになる）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// フォント上書き (CSS の font-family)。日本語キー `font` / `フォント` / 英語 `font_family`。
        /// 未指定は per-game 既定 → runtime 既定へフォールバック（TitleShow と同形）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        font_family: Option<String>,
        /// テキスト揃え (#275)。日本語キー `揃え`（`左`/`中央`/`右`）/ 英語 `align`（`left`/`center`/`right`）。
        /// 値は `left` / `center` / `right` に正規化して保持する。未指定は中央（現状維持）。
        /// 左揃え時はグリフ演出（タイプ等）のグリフがラベル左端から右へ並ぶ（ED の install-line 用）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        align: Option<String>,
        /// 隣接配置 (#275)。日本語キー `後ろ` / 英語 `after`。参照ラベル <id> の右端に
        /// このラベルの左端を接続する（同 y）。指定時このラベルは自動で左揃えになる。
        /// 参照が存在しない場合は通常配置にフォールバック（落ちない）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<String>,
        /// 横位置の比率 override (0..1 の float) (#275)。日本語/英語とも `x`。
        /// 指定時は `position` トークンより優先して xRatio に使う。範囲外・非数値は TS 側で無視。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        /// 縦位置の比率 override (0..1 の float) (#275)。日本語/英語とも `y`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
    },
    /// 単独の画像 (#274)。orber OP タイトルカードのアバターのような、立ち絵（show）に
    /// 紐付かない単独画像を任意の 2D 位置に出す。
    /// `[画像: avatar.png, 位置=上, 円形, サイズ=160, id=avatar]`。
    /// アセットパスは背景画像と同じく `assetBaseUrl + '/images/' + path`。
    /// `[タイトル]` と同様 CharacterLayer に id（既定 "Image"）名で登録され、`[アニメ]` 等の
    /// 対象になれる。render-only で `NovelGameState.characters` には漏らさない（doctrine 規律3）。
    Image {
        /// 画像の相対パス（`assets/images/` 起点）。
        path: String,
        /// 2D 位置トークン（縦+横）。日本語キー `位置` / 英語 `position`。未指定は中央。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<String>,
        /// 形状。`円形` / `circle` を値なしフラグでも `形状=円形` でも指定できる。
        /// 値は `円形` に正規化して保持する。未指定は矩形（マスクなし）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shape: Option<String>,
        /// 表示サイズ (px、論理座標)。日本語キー `サイズ` / 英語 `size`。
        /// 指定時はその幅にアスペクト維持でスケール。未指定はテクスチャ自然サイズ。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u32>,
        /// 演出対象 identifier。日本語/英語とも `id`。未指定は TS 側で既定 "Image"。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// 横位置の比率 override (0..1 の float) (#275)。日本語/英語とも `x`。
        /// 指定時は `position` トークンより優先して xRatio に使う。範囲外・非数値は TS 側で無視。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        /// 縦位置の比率 override (0..1 の float) (#275)。日本語/英語とも `y`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
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
    /// 一度行き過ぎてから戻る "ポップ" 系イージング (#268)。
    /// 標準的な easeOutBack（overshoot 係数 s=1.70158）。`[文字演出]` の `効果=爆発` 等で使う。
    /// Markdown キーワード: `オーバーシュート` / `EaseOutBack`。`[アニメ]` でも使える。
    EaseOutBack,
}

/// `[文字演出]` の名前付きプリセット (#268)。
///
/// プリセット → プリミティブ（dy/scale/alpha/間隔/duration/easing）の展開は
/// **TS ランタイム側** (`frontend/src/game/textEffect.ts`) で行い、既定値の正本も
/// そこに 1 箇所だけ置く。parser はどのプリセットが指定されたかを enum として記録するだけ。
/// 個別プリミティブ（dy= 等）は TextEffect の各フィールドで上書きできる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub enum TextEffectPreset {
    /// `効果=爆発` / `explode`。1 文字ずつ下から飛び出す explodeUp 相当。
    Explode,
    /// `効果=タイプ` / `typewriter`。typewriter.ts の reveal を再利用し 1 文字ずつ表示。
    Typewriter,
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
    /// per-game デフォルトの本文フォントサイズ (px) (#283 補遺)。
    /// 例: 9:16 ノベルでは小さめ (26)、16:9 ADV では大きめ (40)。
    /// 未指定は runtime 既定 40（font_family と同じく per-game 単位の上書き）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    /// 会話の描画スタイル (#283)。`adv` / `novel` の対等 2 択。
    /// `adv` = 下部 ADV 箱（話者名札あり）、`novel` = 全画面ノベル（ToHeart 式・名札なし・スクリム）。
    /// frontmatter `dialog_style:` から流す。デフォルト値という概念は持たせず、作品ごとに明示指定する。
    /// 未指定の既存作品は壊さないため runtime 側で `adv` にフォールバックするが、それは
    /// 「正規デフォルト」ではなく未指定時の挙動。空文字は None 扱い（choice_style と同じ規約）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog_style: Option<String>,
    /// 質問役（主人公）の話者名 (#286)。`dialog_style: novel` の左右配置に使う per-game 設定。
    /// 名札を出さない novel スタイルで、話者がこの名前と一致したら質問役＝左、それ以外（住人）は
    /// 回答役＝右に振る。未指定なら従来配置（position トークン）のままで後方互換。
    /// frontmatter `protagonist:` から流す。空文字は None 扱い（choice_style と同じ規約）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protagonist: Option<String>,
    /// 立ち絵の足元アンカー Y 比率 (#308)。`characterY = screenHeight * character_y_ratio`。
    /// 内部定数 `CHARACTER_Y_RATIO`（runtime 既定 1.0）と 1:1 対応する per-game 設定。
    /// 1.0 = 足が画面下端 / >1.0（例 1.05）= 足が下端より下＝靴が画面外に切れる（ToHeart 式）。
    /// 足元位置をどこに置くかはゲームごとに違うため、グローバル定数でなく作品ごとに明示指定する。
    /// 未指定の既存作品は壊さないため runtime 側で 1.0 にフォールバックする（後方互換）。
    /// dialog_style: novel/adv 非依存（両モードで同じ足元）。font_size と同じ per-game 数値設定だが
    /// 比率なので f64。空・非数値は None 扱い（runtime 既定 1.0 にフォールバック）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_y_ratio: Option<f64>,
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
