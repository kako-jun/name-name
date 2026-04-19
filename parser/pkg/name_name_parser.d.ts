/* tslint:disable */
/* eslint-disable */
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
     * 未指定の場合は RpgDialogBox に顔枠が表示されず従来どおり名前＋本文のみの表示になる。
     * Issue #73 Phase 1 で追加。VN 風の固定顔枠のみで、動的表情切替（Phase 2 / #101）は含まない。
     * parser は値を生文字列として透過する（パス存在や形式の検証はレンダラー側の責務）。
     * Markdown 属性は空白区切りのためパスに空白を含められない（引用記法は未対応）。
     */
    portrait?: string;
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

export type Event = { Dialog: { character: string | undefined; expression: string | undefined; position: string | undefined; text: string[] } } | { Narration: { text: string[] } } | { Background: { path: string } } | { Bgm: { path: string | undefined; action: BgmAction } } | { Se: { path: string } } | { Blackout: { action: BlackoutAction } } | "SceneTransition" | { Exit: { character: string } } | { Wait: { ms: number } } | { Choice: { options: ChoiceOption[] } } | { Flag: { name: string; value: FlagValue } } | { Condition: { flag: string; events: Event[] } } | { ExpressionChange: { character: string; expression: string } } | { RpgMap: RpgMapData } | { PlayerStart: PlayerStartData } | { Npc: NpcData };

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
