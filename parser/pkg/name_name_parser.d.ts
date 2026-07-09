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
    /**
     * 立ち絵の足元アンカー Y 比率 (#308)。`characterY = screenHeight * character_y_ratio`。
     * 内部定数 `CHARACTER_Y_RATIO`（runtime 既定 1.0）と 1:1 対応する per-game 設定。
     * 1.0 = 足が画面下端 / >1.0（例 1.05）= 足が下端より下＝靴が画面外に切れる（ToHeart 式）。
     * 足元位置をどこに置くかはゲームごとに違うため、グローバル定数でなく作品ごとに明示指定する。
     * 未指定の既存作品は壊さないため runtime 側で 1.0 にフォールバックする（後方互換）。
     * dialog_style: novel/adv 非依存（両モードで同じ足元）。font_size と同じ per-game 数値設定だが
     * 比率なので f64。空・非数値は None 扱い（runtime 既定 1.0 にフォールバック）。
     */
    character_y_ratio?: number;
    /**
     * 立ち絵の目標表示高さ比率 (#360)。sprite 高さ = screenHeight * character_height_ratio。未指定は原寸。
     * character_y_ratio(#308) と同じ per-game 数値設定で、立ち絵をゲームごとに拡大・縮小して
     * 画面高さに対する見た目の大きさを揃えるための比率。character_y_ratio が足元位置なのに対し、
     * こちらは表示サイズ。未指定の既存作品は原寸のままで後方互換（runtime 側でフォールバック）。
     * dialog_style: novel/adv 非依存。比率なので f64。空・非数値は None 扱い。
     */
    character_height_ratio?: number;
    /**
     * キャラごとの立ち絵目標表示高さ比率 override (#364)。
     * `character_height_ratio`（#360）はスクリプト単位の単一値のため、1つのスクリプトに登場する
     * 全キャラの表示高さがテクスチャの縦pxに関わらず同一値に強制収束してしまう（身長差が潰れる）。
     * #360 では「大半は override 不要」としてこの per-character 対応を先送りしたが、
     * theo-hayami の10人キャストのように身長差を意図的に持たせるケースで必要になったため追加。
     * キーはキャラクター表示名、値は character_height_ratio と同じ意味の比率。
     * このマップに該当キャラがいなければ character_height_ratio（スクリプト単位）にフォールバックし、
     * どちらにも該当しなければ原寸（scale=1）にフォールバックする。
     * frontmatter `character_height_ratios: theo:0.65,hue:0.68,...` の形式（expressions= と同じ
     * カンマ区切り key:value 書式）から流す。
     */
    character_height_ratios?: Map<string, number>;
    /**
     * 立ち絵の元絵基準の一律スケール (#378)。`sprite.scale = character_scale`（uniform、幅もアスペクト比で追従）。
     * `character_height_ratio`（#360）/`character_height_ratios`（#364）は**画面基準**で
     * 表示高さ = 値 × screenHeight となり、元絵の縦px（texH）を割り消すため、身長差を焼き込んだ
     * 立ち絵の身長差が潰れる。それに対し character_scale は**元絵基準**で 表示px = 値 × textureHeight。
     * 元絵に焼き込んだ縦px差（身長差）をそのまま画面に出す。
     * 優先順位（runtime 側）: フィット/fit(#294) → character_scale(#378) → character_height_ratios(#364)
     * → character_height_ratio(#360) → 原寸 scale=1。両方指定なら character_scale を採用。
     * 対象は立ち絵（show）のみ。範囲クランプ・非有限/非正の未設定扱いは runtime 側（CharacterLayer）。
     * 空・非数値は None 扱い（後方互換）。frontmatter `character_scale:` から流す。
     */
    character_scale?: number;
    /**
     * 立ち絵の新規表示・退場フェード時間（ms）。frontmatter `character_fade_ms:` から流す。
     * 未指定なら runtime 既定 700ms（後方互換）。作品ごとに ToHeart 式のじわっとした登場へ
     * 調整するための per-game 数値設定。空・非数値は None 扱い。
     */
    character_fade_ms?: number;
    /**
     * 背景クロスフェード・退場（終劇）フェード時間（ms）。frontmatter `background_fade_ms:` から流す。
     * 未指定なら runtime 既定 700ms（現行 `BACKGROUND_CROSSFADE_MS`＝後方互換）。`character_fade_ms`
     * と対称の per-game 数値設定で、背景の表示（イン）・切り替え（クロスフェード）・退場（アウト）を
     * 作品ごとにゆっくり／速くして余韻を調整する。空・非数値は None 扱い。
     */
    background_fade_ms?: number;
    /**
     * 下地ベタ（ステージ最背面の全面塗り＝`bgGraphics`）の既定色（`#rrggbb`）(#409)。
     * frontmatter `background_color:` から流す per-game 設定で、最初の背景絵がこの色から
     * `background_fade_ms` でフェードインする（未指定なら黒 `#000000`）。シーン単位の
     * `[背景色:]`（#273）の上書きとは別スロットで、上書きが無いときの戻り先＝地色になる。
     * 空文字は None 扱い（＝既定の黒）。文字列としてそのまま透過させる（色解決は runtime）。
     */
    background_color?: string;
    /**
     * Skip(S) ボタンを再生 UI に出すか (#310)。`true` = 出す（既定・後方互換）。
     * `false` で Skip(S) ボタンを描画しない（読み物として既読スキップを使わせたくない作品向け）。
     * skip-read-only ロジック（未読は解除）自体は変えない。ボタンの有無だけを制御する。
     * frontmatter `skip_enabled:` から流す。未指定なら None（runtime で true 扱い＝後方互換）。
     * `\"true\"` / `\"false\"` のみ受け、それ以外（空・非真偽値）は None（既定 true）にフォールバック。
     */
    skip_enabled?: boolean;
    /**
     * デバッグ HUD（D ボタン）を `/play`（PlayerScreen）に出すか (#310)。
     * `true` = 出す / 未指定・`false` = 出さない（本番非表示が既定）。
     * `/edit`（EditorScreen）は frontmatter に関係なく常時出す（編集者用＝別経路）ため、
     * この設定は再生専用画面の出し分けにのみ効く。
     * frontmatter `debug_enabled:` から流す。未指定なら None（runtime で false 扱い＝本番非表示）。
     * `\"true\"` / `\"false\"` のみ受け、それ以外は None（既定 false）にフォールバック。
     */
    debug_enabled?: boolean;
    /**
     * 話者交代 nudge（ぴょこ）を novel で発火させるか (#382)。`true` = 発火（opt-in）。
     * `false` / 未指定で話者交代時のポーズ変化（nudgePose）を発火させない（既定オフ）。
     * 標準は話者交代時のポーズ差し替え（#337 クロスフェード）が「今この人」の合図を担うため nudge は不要。
     * nudge は開発中の稀な合図で、欲しい作品だけ `speaker_nudge: true` で opt-in する（theo-hayami は未指定）。
     * #286 の nudge ロジック自体は変えない。novel かつ話者交代かつ非スキップの発火条件に AND するだけ。
     * frontmatter `speaker_nudge:` から流す。未指定なら None（runtime で false 扱い＝nudge は opt-in）。
     * `\"true\"` / `\"false\"` のみ受け、それ以外（空・非真偽値）は None（既定 false）にフォールバック。
     */
    speaker_nudge?: boolean;
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

export type Event = { Dialog: { character: string | undefined; expression: string | undefined; position: string | undefined; text: string[]; voice_path?: string; font_family?: string; fit?: boolean } } | { Narration: { text: string[]; voice_path?: string; font_family?: string } } | { Background: { path: string; fade_top?: number; fade_bottom?: number; fade_left?: number; fade_right?: number; brightness?: number } } | { Video: { path: string; position?: string; scale?: number; loop?: boolean; mute?: boolean; fade_top?: number; fade_bottom?: number; fade_left?: number; fade_right?: number } } | "VideoExit" | { BackgroundColor: { color: string } } | { Bgm: { path: string | undefined; action: BgmAction; fade_ms?: number } } | { Se: { path: string; fade_ms?: number } } | { Blackout: { action: BlackoutAction } } | "SceneTransition" | "PageBreak" | { Exit: { character: string } } | { Enter: { character: string; expression?: string; position?: string; fit?: boolean } } | { Wait: { ms: number } } | { Choice: { options: ChoiceOption[] } } | { Flag: { name: string; value: FlagValue } } | { Condition: { flag: string; events: Event[] } } | { ExpressionChange: { character: string; expression: string } } | { RpgMap: RpgMapData } | { PlayerStart: PlayerStartData } | { Npc: NpcData } | { Monster: MonsterDef } | { Item: ItemDef } | { Spell: SpellDef } | { PartyMember: PartyMemberDef } | { RpgEvent: { name: string; commands: EventCommand[] } } | { RpgTrigger: { x?: number; y?: number; auto?: boolean; scene: string; once?: boolean } } | { Animate: { target: string; dx?: string; dy?: string; rotation?: string; scale?: number; duration_ms: number; easing?: Easing } } | { TextEffect: { target: string; effect?: TextEffectPreset; stagger_ms?: number; ms_per_char?: number; dx?: string; dy?: string; rotation?: string; scale?: number; alpha?: number; duration_ms?: number; easing?: Easing; cursor?: boolean; blink_ms?: number; cursor_color?: string } } | { Underline: { target: string; color?: string; thickness?: number; duration_ms?: number; offset?: number; easing?: Easing } } | { TitleShow: { text: string; font_family?: string; position?: string; color?: string; size?: number; x?: number; y?: number } } | { Label: { text: string; color?: string; position?: string; size?: number; id?: string; font_family?: string; align?: string; after?: string; x?: number; y?: number } } | { Image: { path: string; position?: string; shape?: string; size?: number; id?: string; x?: number; y?: number } } | { DialogBorderless: { borderless: boolean } } | { Shake: { intensity_px?: number; duration_ms?: number } } | { Flash: { color?: string; alpha?: number; duration_ms?: number } } | { Fade: { target?: string; color?: string; from_alpha?: number; to_alpha?: number; duration_ms?: number } };

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
