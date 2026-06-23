/* tslint:disable */
/* eslint-disable */
/**
 * RPG イベントのコマンド単体 (#187 / #196)。
 * RpgEvent の commands に列挙され、EventRunner が順に実行する。
 */
export type EventCommand = { type: "NpcMove"; npc: string; x: number; y: number; speed?: number; direction?: Direction } | { type: "Wait"; ms: number } | { type: "Dialog"; character: string | undefined; text: string[] } | { type: "Narration"; text: string[] };

/**
 * `[文字演出]` の名前付きプリセット (#268)。
 *
 * プリセット → プリミティブ（dy/scale/alpha/間隔/duration/easing）の展開は
 * **TS ランタイム側** (`frontend/src/game/textEffect.ts`) で行い、既定値の正本も
 * そこに 1 箇所だけ置く。parser はどのプリセットが指定されたかを enum として記録するだけ。
 * 個別プリミティブ（dy= 等）は TextEffect の各フィールドで上書きできる。
 */
export type TextEffectPreset = "Explode" | "Typewriter";

/**
 * アイテム定義 (#174)。
 */
export interface ItemDef {
    id: string;
    name: string;
    /**
     * 種別（\"回復\" / \"攻撃\" / \"武器\" / \"盾\" / \"鎧\" / \"兜\" / \"鍵\" / \"その他\" 等）。
     * runtime が文字列を解釈する。parser は値を透過するだけ。
     */
    kind: string;
    price?: number;
    /**
     * 宣言的効果 DSL（\"heal 30\" / \"damage 8..14 type=fire\" 等）。`builtin` と排他。
     */
    effect?: string;
    /**
     * 専用関数 ID（\"world_tree_drop\" / \"wing_of_chimera\" 等）。`effect` と排他。
     */
    builtin?: string;
}

/**
 * パーティメンバーの呪文習得スロット (#175)
 */
export interface PartyLearns {
    level: number;
    spell: string;
}

/**
 * パーティメンバー定義 (#175)。
 *
 * `[パーティ <id>]` ブロックで定義。プレイヤー側の戦闘エンティティ初期値を持つ。
 * レベルアップ後の状態はセーブデータ側で管理する想定で、ここは「Lv1 開始時」の値。
 */
export interface PartyMemberDef {
    id: string;
    name: string;
    /**
     * 立ち絵 / 戦闘スプライト相対パス
     */
    sprite?: string;
    /**
     * 初期レベル（既定 1）
     */
    level?: number;
    hp: number;
    mp?: number;
    atk: number;
    /**
     * `def` は Rust 予約語のため Rust 側は `def_value`、JSON / TS 側は `def` で透過する。
     */
    def: number;
    agi: number;
    /**
     * レベルアップで習得する呪文（順不同）。`{ level: 4, spell: \"ホイミ\" }` 形式。
     * Phase 1 ではデータとして保持するだけ、ランタイム評価は #175 follow-up。
     */
    learns?: PartyLearns[];
}

/**
 * モンスター定義 (#174)。
 *
 * 各章の `## data: マスター` シーン内に `[モンスター <id>] ... [/モンスター]` で書く。
 * 効果（特殊行動）が単純な式で書ききれない場合は `builtin: <slug>` でランタイム実装に委譲する。
 * 詳細は kako-jun と合意した「汎用関数 + 専用 builtin」二層設計を参照（#176）。
 */
export interface MonsterDef {
    id: string;
    name: string;
    hp: number;
    mp?: number;
    atk: number;
    /**
     * `def` は Rust 予約語のため Rust 側は `def_value`、JSON / TS 側は `def` で透過する。
     */
    def: number;
    agi: number;
    exp: number;
    gold: number;
    /**
     * スプライトシートへの相対パス（`monsters/slime.png` 等）。未指定なら色塗り四角。
     */
    sprite?: string;
    /**
     * 専用関数 ID（\"darkness_breath\" 等）。指定時は通常攻撃以外の挙動が当該関数で完結する。
     */
    builtin?: string;
}

/**
 * 呪文定義 (#174)。
 */
export interface SpellDef {
    id: string;
    name: string;
    mp: number;
    /**
     * 対象（\"味方単体\" / \"敵単体\" / \"味方全体\" / \"敵全体\" / \"自分\" / \"マップ\" 等）。
     */
    target: string;
    /**
     * 宣言的効果 DSL（\"heal 15..25\" / \"damage 30..50 type=ice\" 等）。`builtin` と排他。
     */
    effect?: string;
    /**
     * 専用関数 ID（\"zaraki\" / \"ruula\" / \"rariho\" 等）。
     */
    builtin?: string;
    /**
     * 系統（\"fire\" / \"ice\" / \"holy\" / \"breath\" 等、耐性計算用）。
     */
    school?: string;
}

export interface Chapter {
    number: number;
    title: string;
    hidden: boolean;
    default_bgm: string | undefined;
    scenes: Scene[];
}

export interface ChoiceOption {
    text: string;
    jump: string;
}

export interface Document {
    engine: string;
    /**
     * 画面比率。\"16:9\" / \"4:3\" / \"9:16\"。未指定時は \"16:9\"。
     */
    aspect_ratio?: string;
    /**
     * 選択肢スタイル名 (#146)。`default` / `soft` / `monochrome` を想定。
     * 未指定時は `None`（runtime で `default` 扱い）。
     * frontmatter `choice_style: soft` で per-game 切替可能。
     */
    choice_style?: string;
    /**
     * per-game デフォルトフォント (#147)。CSS の font-family 文字列を生で受け取る。
     * 例: \"Klee One, cursive\" / \"Hina Mincho, serif\"。
     * 未指定時は runtime 既定 (`\'Noto Sans JP\', sans-serif`)。
     * 個別行で上書きしたい場合は [フォント: ...] ディレクティブで Dialog/Narration 直前に指定。
     */
    font_family?: string;
    /**
     * per-game デフォルトの本文フォントサイズ (px) (#283 補遺)。
     * 例: 9:16 ノベルでは小さめ (26)、16:9 ADV では大きめ (40)。
     * 未指定は runtime 既定 40（font_family と同じく per-game 単位の上書き）。
     */
    font_size?: number;
    /**
     * 会話の描画スタイル (#283)。`adv` / `novel` の対等 2 択。
     * `adv` = 下部 ADV 箱（話者名札あり）、`novel` = 全画面ノベル（ToHeart 式・名札なし・スクリム）。
     * frontmatter `dialog_style:` から流す。デフォルト値という概念は持たせず、作品ごとに明示指定する。
     * 未指定の既存作品は壊さないため runtime 側で `adv` にフォールバックするが、それは
     * 「正規デフォルト」ではなく未指定時の挙動。空文字は None 扱い（choice_style と同じ規約）。
     */
    dialog_style?: string;
    /**
     * 質問役（主人公）の話者名 (#286)。`dialog_style: novel` の左右配置に使う per-game 設定。
     * 名札を出さない novel スタイルで、話者がこの名前と一致したら質問役＝左、それ以外（住人）は
     * 回答役＝右に振る。未指定なら従来配置（position トークン）のままで後方互換。
     * frontmatter `protagonist:` から流す。空文字は None 扱い（choice_style と同じ規約）。
     */
    protagonist?: string;
    chapters: Chapter[];
}

export interface NpcData {
    id: string;
    name: string;
    x: number;
    y: number;
    color: number;
    message: string[];
    /**
     * スプライトシートへの相対パス（例: `character.png`）。
     * 未指定の場合は従来どおり色付き四角で描画される。
     * parser は値を生文字列として透過する（パス存在や形式の検証はレンダラー側の責務）。
     * Markdown 属性は空白区切りのためパスに空白を含められない（引用記法は未対応）。
     */
    sprite?: string;
    /**
     * 歩行アニメーションのフレーム数（方向あたり）。
     * ドラクエ式の 2 フレーム（足踏み）が標準。未指定の場合はレンダラー側のデフォルト（= 2）を使う。
     * parser は `>= 1` の整数を受理するだけ（上限チェックなし）。
     * 実用上の妥当範囲 1〜4 はレンダラー側で clamp する想定。
     */
    frames?: number;
    /**
     * NPC が向いている方向。`向き=下` のように指定する。
     * 未指定の場合はレンダラーのデフォルト（= `Down`）で描画される。
     * 自律移動は未対応のためアイドル中はこの向きのまま。将来の「話しかけ時にプレイヤーを向く」拡張はレンダラー側で上書きする想定。
     */
    direction?: Direction;
    /**
     * 会話ダイアログに表示する顔画像（portrait）への相対パス（例: `elder_portrait.png`）。
     * 未指定の場合は DialogBox に顔枠が表示されず従来どおり名前＋本文のみの表示になる。
     * Issue #73 Phase 1 で追加。VN 風の固定顔枠のみで、動的表情切替（Phase 2 / #101）は別フィールド。
     * parser は値を生文字列として透過する（パス存在や形式の検証はレンダラー側の責務）。
     * Markdown 属性は空白区切りのためパスに空白を含められない（引用記法は未対応）。
     */
    portrait?: string;
    /**
     * 表情差分マップ（#101 Phase 2）。
     * キーは表情名（例: \"normal\" / \"sad\" / \"angry\"）、値は portrait 画像への相対パス。
     * Markdown 属性は `expressions=normal:normal.png,sad:sad.png` の形式で指定する。
     * NPC の message 内の `[expression=sad]` で実行時に portrait が切り替わる。
     */
    expressions?: Map<string, string>;
    /**
     * 「はなす」時に再生するイベント名（#187）。
     * 指定時は `message` の代わりにこのイベントを EventRunner で再生する。
     * 未指定の場合は従来通り `message` を DialogBox に表示。
     */
    scene?: string;
}

export interface PlayerStartData {
    x: number;
    y: number;
    direction: Direction;
}

export interface RpgMapData {
    width: number;
    height: number;
    tile_size: number;
    tiles: number[][];
    /**
     * タイル座標 [y][x] ごとの壁高さ（1.0 = 標準、0.5 = 半壁、2.0 = 二階建て等）。
     * 未指定時は None。ランタイム fallback は 1.0。
     * Issue #90 で Markdown `[壁高さ]` ブロックから読み込み可能にした。
     */
    wall_heights?: number[][];
    /**
     * タイル座標 [y][x] ごとの床高さ（0.0 = 地面標準、0.5 = 半段、1.0 = 1タイル分上）。
     * 未指定時は None。ランタイム fallback は 0.0。
     * Issue #90 で Markdown `[床高さ]` ブロックから読み込み可能にした。
     */
    floor_heights?: number[][];
    /**
     * タイル座標 [y][x] ごとの天井高さ（1.0 = 標準、0.5 = 低天井トンネル等）。
     * 未指定時は None。ランタイム fallback は 1.0。
     * Issue #90 で Markdown `[天井高さ]` ブロックから読み込み可能にした。
     */
    ceiling_heights?: number[][];
    /**
     * 確率エンカウントの分母（DQ4 式、`Math.random() < 1/N`）。
     * `[エンカウント率: 1/16]` または `[エンカウント率: 16]` で指定。
     * `0` は「絶対にエンカウントしない安全マップ」（街・室内向け）。未指定 = エンカウントなし。
     * Issue #172 で追加。
     */
    encounter_rate?: number;
    /**
     * エンカウント時に抽選される敵グループ名のリスト（重み均等）。
     * `[エンカウント群: slime, ghost, slime+skeleton]` で指定。
     * 各要素は単体モンスター ID または `+` 連結の複合（同時出現）。
     * 未指定の場合 encounter_rate が設定されていてもエンカウントしない。
     * Issue #172 で追加。
     */
    encounter_groups?: string[];
}

export interface Scene {
    id: string;
    title: string;
    view?: SceneView;
    events: Event[];
}

export type BgmAction = "Play" | "Stop";

export type BlackoutAction = "On" | "Off";

export type Direction = "Up" | "Down" | "Left" | "Right";

export type Easing = "Linear" | "EaseIn" | "EaseOut" | "EaseInOut" | "EaseOutBack";

export type Event = { Dialog: { character: string | undefined; expression: string | undefined; position: string | undefined; text: string[]; voice_path?: string; font_family?: string; fit?: boolean } } | { Narration: { text: string[]; voice_path?: string; font_family?: string } } | { Background: { path: string; fade_top?: number; fade_bottom?: number; fade_left?: number; fade_right?: number; brightness?: number } } | { Video: { path: string; position?: string; scale?: number; loop?: boolean; mute?: boolean; fade_top?: number; fade_bottom?: number; fade_left?: number; fade_right?: number } } | "VideoExit" | { BackgroundColor: { color: string } } | { Bgm: { path: string | undefined; action: BgmAction; fade_ms?: number } } | { Se: { path: string; fade_ms?: number } } | { Blackout: { action: BlackoutAction } } | "SceneTransition" | "PageBreak" | { Exit: { character: string } } | { Wait: { ms: number } } | { Choice: { options: ChoiceOption[] } } | { Flag: { name: string; value: FlagValue } } | { Condition: { flag: string; events: Event[] } } | { ExpressionChange: { character: string; expression: string } } | { RpgMap: RpgMapData } | { PlayerStart: PlayerStartData } | { Npc: NpcData } | { Monster: MonsterDef } | { Item: ItemDef } | { Spell: SpellDef } | { PartyMember: PartyMemberDef } | { RpgEvent: { name: string; commands: EventCommand[] } } | { RpgTrigger: { x?: number; y?: number; auto?: boolean; scene: string; once?: boolean } } | { Animate: { target: string; dx?: string; dy?: string; rotation?: string; scale?: number; duration_ms: number; easing?: Easing } } | { TextEffect: { target: string; effect?: TextEffectPreset; stagger_ms?: number; ms_per_char?: number; dx?: string; dy?: string; rotation?: string; scale?: number; alpha?: number; duration_ms?: number; easing?: Easing; cursor?: boolean; blink_ms?: number; cursor_color?: string } } | { Underline: { target: string; color?: string; thickness?: number; duration_ms?: number; offset?: number; easing?: Easing } } | { TitleShow: { text: string; font_family?: string; position?: string; color?: string; size?: number; x?: number; y?: number } } | { Label: { text: string; color?: string; position?: string; size?: number; id?: string; font_family?: string; align?: string; after?: string; x?: number; y?: number } } | { Image: { path: string; position?: string; shape?: string; size?: number; id?: string; x?: number; y?: number } } | { DialogBorderless: { borderless: boolean } } | { Shake: { intensity_px?: number; duration_ms?: number } } | { Flash: { color?: string; alpha?: number; duration_ms?: number } } | { Fade: { target?: string; color?: string; from_alpha?: number; to_alpha?: number; duration_ms?: number } };

export type FlagValue = { Bool: boolean } | { String: string } | { Number: number };

export type SceneView = "TopDown" | "Raycast";


export function emit_markdown(input: any): string;

export function parse_markdown(input: string): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly emit_markdown: (a: any) => [number, number, number, number];
    readonly parse_markdown: (a: number, b: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
