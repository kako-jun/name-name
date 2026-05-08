/* @ts-self-types="./name_name_parser.d.ts" */
import * as wasm from "./name_name_parser_bg.wasm";
import { __wbg_set_wasm } from "./name_name_parser_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    emit_markdown, parse_markdown
} from "./name_name_parser_bg.js";
