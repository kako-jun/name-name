/* tslint:disable */
/* eslint-disable */
export interface Document {
    engine: string;
    chapters: Chapter[];
}

export type Event = { Dialog: { character: string | undefined; expression: string | undefined; position: string | undefined; text: string[] } } | { Narration: { text: string[] } } | { Background: { path: string } } | { Bgm: { path: string | undefined; action: BgmAction } } | { Se: { path: string } } | { Blackout: { action: BlackoutAction } } | "SceneTransition" | { Exit: { character: string } } | { Wait: { ms: number } } | { Choice: { options: ChoiceOption[] } } | { Flag: { name: string; value: FlagValue } } | { Condition: { flag: string; events: Event[] } } | { ExpressionChange: { character: string; expression: string } } | { RpgMap: RpgMapData } | { PlayerStart: PlayerStartData } | { Npc: NpcData };


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
