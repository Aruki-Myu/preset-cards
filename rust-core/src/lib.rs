use wasm_bindgen::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

// ─────────────────────────────────────────
// Layer 0: Original fast settings parser
// ─────────────────────────────────────────

#[wasm_bindgen]
pub fn parse_settings_fast(raw_json: &str) -> Result<JsValue, JsValue> {
    let mut root: Value = serde_json::from_str(raw_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse outer JSON: {}", e)))?;

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
                            if let Ok(parsed_item) = serde_json::from_str::<Value>(s) {
                                *item = parsed_item;
                            }
                        }
                    }
                }
            }
        }
    }

    serde_wasm_bindgen::to_value(&root)
        .map_err(|e| JsValue::from_str(&format!("Failed to convert to JS object: {}", e)))
}

// ─────────────────────────────────────────
// Shared: HTML escape
// ─────────────────────────────────────────

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#039;"),
            _ => out.push(c),
        }
    }
    out
}

// ─────────────────────────────────────────
// Layer 1: PromptManager list HTML builder
// ─────────────────────────────────────────

#[derive(Deserialize)]
struct PromptData {
    identifier: String,
    name: Option<String>,
    #[serde(default)]
    marker: bool,
    #[serde(default)]
    system_prompt: bool,
    role: Option<String>,
    #[serde(default)]
    injection_position: i32,
    #[serde(default)]
    injection_depth: i32,
    #[serde(default)]
    forbid_overrides: bool,
    #[serde(default)]
    enabled: bool,
}

#[derive(Deserialize)]
struct OrderEntry {
    identifier: String,
    #[serde(default)]
    enabled: bool,
}

#[derive(Deserialize)]
struct PmRenderConfig {
    prefix: String,
    #[serde(default)]
    overridden_prompts: Vec<String>,
    #[serde(default)]
    toggle_disabled: Vec<String>,
    #[serde(default)]
    warning_token_threshold: i64,
    #[serde(default)]
    danger_token_threshold: i64,
    #[serde(default)]
    token_budget: i64,
    #[serde(default)]
    token_usage: i64,
}

const FORCE_EDIT_PROMPTS: &[&str] = &[
    "charDescription", "charPersonality", "scenario",
    "personaDescription", "worldInfoBefore", "worldInfoAfter",
];

const FORCE_TOGGLE_PROMPTS: &[&str] = &[
    "charDescription", "charPersonality", "scenario",
    "personaDescription", "worldInfoBefore", "worldInfoAfter",
    "main", "chatHistory", "dialogueExamples",
];

const INJECTION_POSITION_ABSOLUTE: i32 = 1;

fn is_deletion_allowed(p: &PromptData) -> bool {
    !p.system_prompt
}

fn is_edit_allowed(p: &PromptData) -> bool {
    FORCE_EDIT_PROMPTS.contains(&p.identifier.as_str()) || !p.marker
}

fn is_toggle_allowed(p: &PromptData, toggle_disabled: &[String]) -> bool {
    if p.marker && !FORCE_TOGGLE_PROMPTS.contains(&p.identifier.as_str()) {
        return false;
    }
    !toggle_disabled.contains(&p.identifier)
}

#[wasm_bindgen]
pub fn build_prompt_manager_list_html(
    prompts_json: &str,
    prompt_order_json: &str,
    token_counts_json: &str,
    config_json: &str,
) -> Result<String, JsValue> {
    let prompts: Vec<PromptData> = serde_json::from_str(prompts_json)
        .map_err(|e| JsValue::from_str(&format!("prompts parse error: {}", e)))?;
    let prompt_order: Vec<OrderEntry> = serde_json::from_str(prompt_order_json)
        .map_err(|e| JsValue::from_str(&format!("prompt_order parse error: {}", e)))?;
    let token_counts: HashMap<String, i64> = serde_json::from_str(token_counts_json)
        .map_err(|e| JsValue::from_str(&format!("token_counts parse error: {}", e)))?;
    let config: PmRenderConfig = serde_json::from_str(config_json)
        .map_err(|e| JsValue::from_str(&format!("config parse error: {}", e)))?;

    // Build HashMap for O(1) prompt lookup by identifier
    let prompt_map: HashMap<&str, &PromptData> = prompts.iter()
        .map(|p| (p.identifier.as_str(), p))
        .collect();

    let overridden_set: std::collections::HashSet<&str> = config.overridden_prompts.iter()
        .map(|s| s.as_str())
        .collect();

    let prefix = &config.prefix;

    // Pre-allocate large buffer
    let mut html = String::with_capacity(prompt_order.len() * 512 + 256);

    // List header
    html.push_str(&format!(
        r#"<li class="{}prompt_manager_list_head"><span data-i18n="Name">Name</span><span></span><span class="prompt_manager_prompt_tokens" data-i18n="Tokens;prompt_manager_tokens">Tokens</span></li><li class="{}prompt_manager_list_separator"><hr></li>"#,
        prefix, prefix
    ));

    for entry in &prompt_order {
        let prompt = match prompt_map.get(entry.identifier.as_str()) {
            Some(p) => p,
            None => continue,
        };

        let name = prompt.name.as_deref().unwrap_or("");
        let encoded_name = escape_html(name);
        let role = prompt.role.as_deref().unwrap_or("");

        let enabled_class = if entry.enabled { "" } else { &format!("{}prompt_manager_prompt_disabled", prefix) };
        let draggable_class = format!("{}prompt_manager_prompt_draggable", prefix);
        let marker_class = if prompt.marker { format!("{}prompt_manager_marker", prefix) } else { String::new() };

        let is_marker = prompt.marker && prompt.injection_position != INJECTION_POSITION_ABSOLUTE;
        let is_system = !prompt.marker && prompt.system_prompt && prompt.injection_position != INJECTION_POSITION_ABSOLUTE && !prompt.forbid_overrides;
        let is_important = !prompt.marker && prompt.system_prompt && prompt.injection_position != INJECTION_POSITION_ABSOLUTE && prompt.forbid_overrides;
        let is_user = !prompt.marker && !prompt.system_prompt && prompt.injection_position != INJECTION_POSITION_ABSOLUTE;
        let is_injection = prompt.injection_position == INJECTION_POSITION_ABSOLUTE;
        let is_overridden = overridden_set.contains(prompt.identifier.as_str());

        let important_class = if is_important { format!("{}prompt_manager_important", prefix) } else { String::new() };

        let tokens = token_counts.get(&prompt.identifier).copied().unwrap_or(0);
        let calc_tokens = if tokens > 0 { tokens.to_string() } else { "-".to_string() };

        // Warning classes for chatHistory
        let (warning_class, warning_title) = if config.token_usage > (config.token_budget * 4 / 5) && prompt.identifier == "chatHistory" {
            if tokens <= config.danger_token_threshold {
                ("fa-solid tooltip fa-triangle-exclamation text_danger", "Very little of your chat history is being sent, consider deactivating some other prompts.")
            } else if tokens <= config.warning_token_threshold {
                ("fa-solid tooltip fa-triangle-exclamation text_warning", "Only a few messages worth chat history are being sent.")
            } else {
                ("", "")
            }
        } else {
            ("", "")
        };

        // Detach button
        let detach_html = if is_deletion_allowed(prompt) {
            r#"<span title="Remove" class="prompt-manager-detach-action caution fa-solid fa-chain-broken fa-xs"></span>"#
        } else {
            r#"<span class="fa-solid"></span>"#
        };

        // Edit button
        let edit_html = if is_edit_allowed(prompt) {
            r#"<span title="edit" class="prompt-manager-edit-action fa-solid fa-pencil fa-xs"></span>"#
        } else {
            r#"<span class="fa-solid"></span>"#
        };

        // Toggle button
        let toggle_html = if is_toggle_allowed(prompt, &config.toggle_disabled) {
            if entry.enabled {
                r#"<span class="prompt-manager-toggle-action fa-solid fa-toggle-on"></span>"#
            } else {
                r#"<span class="prompt-manager-toggle-action fa-solid fa-toggle-off"></span>"#
            }
        } else {
            r#"<span class="fa-solid"></span>"#
        };

        // Role icon
        let (role_icon, role_title) = match role {
            "assistant" => ("fa-robot", "Prompt will be sent as Assistant"),
            "user" => ("fa-user", "Prompt will be sent as User"),
            _ => ("", ""),
        };
        let icon_lookup = if role == "system" && (prompt.marker || prompt.system_prompt) { "" } else { role };
        let (final_role_icon, final_role_title) = if icon_lookup == "assistant" || icon_lookup == "user" {
            (role_icon, role_title)
        } else {
            ("", "")
        };

        // Build list item
        html.push_str(&format!(
            r#"<li class="{prefix}prompt_manager_prompt {draggable} {enabled} {marker} {important}" data-pm-identifier="{id}">"#,
            prefix = prefix,
            draggable = draggable_class,
            enabled = enabled_class,
            marker = marker_class,
            important = important_class,
            id = escape_html(&prompt.identifier),
        ));

        html.push_str(r#"<span class="drag-handle">☰</span>"#);

        html.push_str(&format!(
            r#"<span class="{prefix}prompt_manager_prompt_name" data-pm-name="{name}">"#,
            prefix = prefix, name = encoded_name,
        ));

        if is_marker { html.push_str(r#"<span class="fa-fw fa-solid fa-thumb-tack" title="Marker"></span>"#); }
        if is_system { html.push_str(r#"<span class="fa-fw fa-solid fa-square-poll-horizontal" title="Global Prompt"></span>"#); }
        if is_important { html.push_str(r#"<span class="fa-fw fa-solid fa-star" title="Important Prompt"></span>"#); }
        if is_user { html.push_str(r#"<span class="fa-fw fa-solid fa-asterisk" title="Preset Prompt"></span>"#); }
        if is_injection { html.push_str(r#"<span class="fa-fw fa-solid fa-syringe" title="In-Chat Injection"></span>"#); }

        // isPromptInspectionAllowed always returns true
        html.push_str(&format!(
            r#"<a title="{name}" class="prompt-manager-inspect-action">{name}</a>"#,
            name = encoded_name,
        ));

        if !final_role_icon.is_empty() {
            html.push_str(&format!(
                r#"<span data-role="{role}" class="fa-xs fa-solid {icon}" title="{title}"></span>"#,
                role = escape_html(role), icon = final_role_icon, title = final_role_title,
            ));
        }

        if is_injection {
            html.push_str(&format!(
                r#"<small class="prompt-manager-injection-depth">@ {}</small>"#,
                escape_html(&prompt.injection_depth.to_string()),
            ));
        }

        if is_overridden {
            html.push_str(r#"<small class="fa-solid fa-address-card prompt-manager-overridden" title="Pulled from a character card"></small>"#);
        }

        html.push_str("</span>"); // close prompt_name span

        html.push_str(&format!(
            r#"<span><span class="prompt_manager_prompt_controls">{}{}{}</span></span>"#,
            detach_html, edit_html, toggle_html,
        ));

        html.push_str(&format!(
            r#"<span class="prompt_manager_prompt_tokens" data-pm-tokens="{tokens}"><span class="{wc}" title="{wt}"> </span>{tokens}</span>"#,
            tokens = calc_tokens, wc = warning_class, wt = warning_title,
        ));

        html.push_str("</li>");
    }

    Ok(html)
}

// ─────────────────────────────────────────
// Layer 2: Preset cards HTML builder
// ─────────────────────────────────────────

#[derive(Deserialize)]
struct PresetCard {
    name: String,
    index: i32,
    #[serde(rename = "isActive", default)]
    is_active: bool,
    #[serde(default)]
    temperature: String,
    #[serde(rename = "topP", default)]
    top_p: String,
    #[serde(rename = "topK", default)]
    top_k: String,
    #[serde(rename = "contextTokens", default)]
    context_tokens: i64,
    #[serde(rename = "maxTokens", default)]
    max_tokens: i64,
    #[serde(default)]
    streaming: bool,
    #[serde(rename = "sourceAndModel", default)]
    source_and_model: String,
    #[serde(rename = "logoPath", default)]
    logo_path: String,
    #[serde(default)]
    description: String,
    #[serde(rename = "bgImage", default)]
    bg_image: String,
    #[serde(rename = "modelChips", default)]
    model_chips: Vec<ModelChip>,
    #[serde(default)]
    profiles: Vec<Profile>,
}

#[derive(Deserialize)]
struct ModelChip {
    label: String,
    #[serde(default)]
    logo: String,
}

#[derive(Deserialize)]
struct Profile {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct I18nStrings {
    #[serde(rename = "searchPlaceholder", default)]
    search_placeholder: String,
    #[serde(rename = "multiSelect", default)]
    multi_select: String,
    #[serde(rename = "batchDelete", default)]
    batch_delete: String,
    #[serde(rename = "importPreset", default)]
    import_preset: String,
    #[serde(rename = "conciseMode", default)]
    concise_mode: String,
    #[serde(rename = "clearCache", default)]
    clear_cache: String,
    #[serde(default)]
    configurations: String,
    #[serde(rename = "addConfig", default)]
    add_config: String,
    #[serde(rename = "loadConfig", default)]
    load_config: String,
    #[serde(rename = "overwriteConfig", default)]
    overwrite_config: String,
    #[serde(rename = "exportConfig", default)]
    export_config: String,
    #[serde(rename = "importConfig", default)]
    import_config: String,
    #[serde(default)]
    rename: String,
    #[serde(default)]
    delete: String,
}

#[wasm_bindgen]
pub fn build_preset_cards_html(
    presets_json: &str,
    i18n_json: &str,
) -> Result<String, JsValue> {
    let presets: Vec<PresetCard> = serde_json::from_str(presets_json)
        .map_err(|e| JsValue::from_str(&format!("presets parse error: {}", e)))?;
    let i18n: I18nStrings = serde_json::from_str(i18n_json)
        .map_err(|e| JsValue::from_str(&format!("i18n parse error: {}", e)))?;

    let mut html = String::with_capacity(presets.len() * 1024 + 512);

    // Container + toolbar
    html.push_str(&format!(
        r#"<div id="preset_cards_container"><div id="preset_cards_toolbar"><div id="preset_cards_search_wrapper"><i class="fa-solid fa-magnifying-glass search_icon"></i><input type="text" id="preset_cards_search" placeholder="{}" /></div><div class="preset_cards_toolbar_actions"><span id="preset_cards_count"></span><button id="preset_cards_clear_cache_btn" class="menu_button" title="{}"><i class="fa-solid fa-broom"></i></button><button id="preset_cards_concise_btn" class="menu_button" title="{}"><i class="fa-solid fa-compress"></i></button><button id="preset_cards_multiselect_btn" class="menu_button" title="{}"><i class="fa-solid fa-list-check"></i></button><button id="preset_cards_batch_delete_btn" class="menu_button hidden" title="{}"><i class="fa-solid fa-trash-can"></i></button><button id="preset_cards_import_btn" class="menu_button" title="{}"><i class="fa-solid fa-file-import"></i></button></div></div><div id="preset_cards_grid">"#,
        escape_html(&i18n.search_placeholder),
        escape_html(&i18n.clear_cache),
        escape_html(&i18n.concise_mode),
        escape_html(&i18n.multi_select),
        escape_html(&i18n.batch_delete),
        escape_html(&i18n.import_preset),
    ));

    for p in &presets {
        let active_class = if p.is_active { " selected" } else { "" };
        let bg_class = if !p.bg_image.is_empty() { " has_bg" } else { "" };
        let esc_name = escape_html(&p.name);

        html.push_str(&format!(
            r#"<div class="preset_card{active}{bg}" data-preset-name="{name}" data-preset-index="{idx}">"#,
            active = active_class, bg = bg_class, name = esc_name, idx = p.index,
        ));

        // Background image
        if !p.bg_image.is_empty() {
            html.push_str(&format!(
                r#"<div class="preset_card_bg_image" data-bg-url="{}"></div>"#,
                escape_html(&p.bg_image),
            ));
        }

        // Header
        html.push_str(r#"<div class="preset_card_header"><div class="batch_selection_indicator"><i class="fa-solid fa-check"></i></div><div class="preset_card_logo_wrap">"#);

        if !p.logo_path.is_empty() {
            html.push_str(&format!(r#"<img src="{}" alt="" />"#, escape_html(&p.logo_path)));
        } else {
            html.push_str(r#"<span class="logo_placeholder fa-solid fa-microchip"></span>"#);
        }

        html.push_str(&format!(
            r#"</div><div class="preset_card_title_area"><span class="preset_card_name" title="{name}">{name}</span>"#,
            name = esc_name,
        ));

        if !p.source_and_model.is_empty() {
            html.push_str(&format!(
                r#"<span class="preset_card_source_line" title="{s}">{s}</span>"#,
                s = escape_html(&p.source_and_model),
            ));
        }

        html.push_str(&format!(
            r#"</div><span class="preset_card_active_badge" data-i18n="Active">Active</span><div class="preset_card_actions"><button class="preset_card_export_btn menu_button" title="Export" data-preset-name="{name}" data-preset-index="{idx}"><i class="fa-solid fa-file-export"></i></button><button class="preset_card_edit_btn menu_button" title="Edit" data-preset-name="{name}" data-preset-index="{idx}"><i class="fa-solid fa-pen-to-square"></i></button><button class="preset_card_delete_btn menu_button" title="Delete" data-preset-name="{name}" data-preset-index="{idx}"><i class="fa-solid fa-trash-can"></i></button></div></div>"#,
            name = esc_name, idx = p.index,
        ));

        // Body
        html.push_str(r#"<div class="preset_card_body">"#);

        if !p.description.is_empty() {
            let esc_desc = escape_html(&p.description);
            html.push_str(&format!(
                r#"<div class="preset_card_desc" title="{d}">{d}</div>"#,
                d = esc_desc,
            ));
        }

        if !p.model_chips.is_empty() {
            html.push_str(r#"<div class="preset_card_tags">"#);
            for chip in &p.model_chips {
                let esc_label = escape_html(&chip.label);
                html.push_str(&format!(r#"<span class="preset_card_chip" title="{}">"#, esc_label));
                if !chip.logo.is_empty() {
                    html.push_str(&format!(r#"<img src="{}" alt="">"#, escape_html(&chip.logo)));
                }
                html.push_str(&format!("{}</span>", esc_label));
            }
            html.push_str("</div>");
        }

        // Profiles section
        html.push_str(&format!(
            r#"<div class="preset_card_profiles_section"><div class="preset_card_profiles_header"><span class="profiles_title">{configs}</span><div><button class="preset_card_import_profile_btn menu_button" title="{import_config}"><i class="fa-solid fa-file-import"></i></button><button class="preset_card_add_profile_btn menu_button" title="{add_config}"><i class="fa-solid fa-plus"></i></button></div></div><div class="preset_card_profiles_list">"#,
            configs = escape_html(&i18n.configurations),
            import_config = escape_html(&i18n.import_config),
            add_config = escape_html(&i18n.add_config),
        ));

        for profile in &p.profiles {
            html.push_str(&format!(
                r#"<div class="preset_card_profile_row" data-profile-id="{}"><div class="preset_card_profile_name" title="{load}">{pname}</div><div class="preset_card_profile_actions"><i class="fa-solid fa-file-export preset_card_profile_export" title="{export}"></i><i class="fa-solid fa-floppy-disk preset_card_profile_update" title="{overwrite}"></i><i class="fa-solid fa-pencil preset_card_profile_edit" title="{rename}"></i><i class="fa-solid fa-trash-can preset_card_profile_delete" title="{delete}"></i></div></div>"#,
                escape_html(&profile.id),
                load = escape_html(&i18n.load_config),
                pname = escape_html(&profile.name),
                export = escape_html(&i18n.export_config),
                overwrite = escape_html(&i18n.overwrite_config),
                rename = escape_html(&i18n.rename),
                delete = escape_html(&i18n.delete),
            ));
        }

        html.push_str("</div></div>"); // close profiles_list + profiles_section
        html.push_str("</div>"); // close body

        // Footer
        html.push_str(r#"<div class="preset_card_footer">"#);

        if !p.temperature.is_empty() {
            html.push_str(&format!(
                r#"<span class="preset_card_tag" title="Temperature"><span class="tag_label">T</span><span class="tag_value">{}</span></span>"#,
                escape_html(&p.temperature),
            ));
        }
        if !p.top_p.is_empty() {
            html.push_str(&format!(
                r#"<span class="preset_card_tag" title="Top P"><span class="tag_label">P</span><span class="tag_value">{}</span></span>"#,
                escape_html(&p.top_p),
            ));
        }
        if !p.top_k.is_empty() {
            html.push_str(&format!(
                r#"<span class="preset_card_tag" title="Top K"><span class="tag_label">K</span><span class="tag_value">{}</span></span>"#,
                escape_html(&p.top_k),
            ));
        }
        if p.context_tokens > 0 {
            html.push_str(&format!(
                r#"<span class="preset_card_tag" title="Context"><span class="tag_label">Ctx</span><span class="tag_value">{}</span></span>"#,
                p.context_tokens,
            ));
        }
        if p.max_tokens > 0 {
            html.push_str(&format!(
                r#"<span class="preset_card_tag" title="Max Tokens (Response)"><span class="tag_label">Tok</span><span class="tag_value">{}</span></span>"#,
                p.max_tokens,
            ));
        }
        if p.streaming {
            html.push_str(r#"<span class="preset_card_tag" title="Streaming"><span class="tag_value">Stream</span></span>"#);
        }

        html.push_str("</div>"); // close footer
        html.push_str("</div>"); // close card
    }

    html.push_str("</div></div>"); // close grid + container

    Ok(html)
}
