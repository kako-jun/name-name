pub mod emitter;
pub mod models;
pub mod parser;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn parse_markdown(input: &str) -> Result<JsValue, JsValue> {
    let doc = parser::parse(input);
    serde_wasm_bindgen::to_value(&doc).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn emit_markdown(input: JsValue) -> Result<String, JsValue> {
    let doc: models::Document =
        serde_wasm_bindgen::from_value(input).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(emitter::emit(&doc))
}
