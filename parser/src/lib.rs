pub mod emitter;
pub mod models;
pub mod parser;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn parse_markdown(input: &str) -> JsValue {
    let doc = parser::parse(input);
    serde_wasm_bindgen::to_value(&doc).unwrap()
}

#[wasm_bindgen]
pub fn emit_markdown(input: JsValue) -> String {
    let doc: models::Document = serde_wasm_bindgen::from_value(input).unwrap();
    emitter::emit(&doc)
}
