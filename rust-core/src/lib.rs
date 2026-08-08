use wasm_bindgen::prelude::*;
use serde_json::Value;

#[wasm_bindgen]
pub fn parse_settings_fast(raw_json: &str) -> Result<JsValue, JsValue> {
    // Parse the entire response into a dynamic JSON value.
    let mut root: Value = serde_json::from_str(raw_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse outer JSON: {}", e)))?;

    // The keys that contain double-escaped JSON strings.
    let target_keys = [
        "koboldai_settings",
        "novelai_settings",
        "openai_settings",
        "textgenerationwebui_presets",
    ];

    if let Some(obj) = root.as_object_mut() {
        for key in target_keys.iter() {
            if let Some(val) = obj.get_mut(*key) {
                if let Some(arr) = val.as_array_mut() {
                    for item in arr.iter_mut() {
                        if let Some(s) = item.as_str() {
                            // Only parse if it's a string. It shouldn't fail if already an object, 
                            // but in this case the backend sends strings.
                            if let Ok(parsed_item) = serde_json::from_str::<Value>(s) {
                                *item = parsed_item;
                            }
                        }
                    }
                }
            }
        }
    }

    // Convert the unified, unwrapped JSON object tree to a JavaScript value
    serde_wasm_bindgen::to_value(&root)
        .map_err(|e| JsValue::from_str(&format!("Failed to convert to JS object: {}", e)))
}
