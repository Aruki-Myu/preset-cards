import { getRequestHeaders } from '../../../script.js';
import { renderExtensionTemplateAsync } from '../../extensions.js';
import {
    oai_settings,
    openai_settings,
    openai_setting_names,
    chat_completion_sources,
} from '../../openai.js';
import { POPUP_TYPE, POPUP_RESULT, callGenericPopup, Popup } from '../../popup.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { t } from '../../i18n.js';
import { download } from '../../utils.js';
import { settingsToUpdate } from '../../openai.js';

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

const EXTENSION_KEY = 'preset_cards';
const LOGO_BASE = '/scripts/extensions/preset-cards/llm-logos/';

// ---- Localization ----
const LOCAL_DICT = {
    'Configurations': '配置快照',
    'Save current state as new configuration': '将当前状态保存为新配置',
    'Overwrite with current settings': '覆盖为当前设置',
    'Rename': '重命名',
    'Delete': '删除',
    'Load configuration': '加载该配置',
    'Configuration name:': '配置名称：',
    'e.g., GPT-4 Optimization': '例如：GPT-4 优化版',
    'Overwrite this configuration with current settings?': '是否用当前的设置覆盖此配置？',
    'Configuration updated': '配置已更新',
    'Saving current preset state...': '正在保存当前预设状态...',
    'Applicable Models': '适用模型',
    'Add a short description for this preset...': '为该预设添加一段简短的描述...',
    'Description': '描述',
    'Search presets...': '搜索预设...',
    'Multi-Select': '多选',
    'Batch Delete': '批量删除',
    'Import Preset': '导入预设',
    'Export configuration': '导出配置',
    'Import configuration': '导入配置',
    'Failed to parse configuration file': '无法解析配置文件',
};

function L(text) {
    const lang = localStorage.getItem('language') || 'en';
    if (lang.startsWith('zh') && LOCAL_DICT[text]) {
        return LOCAL_DICT[text];
    }
    return text;
}

/**
 * Available model definitions.
 * `id` is stored in the preset, `logo` is the filename in llm-logos/, `label` is the display name.
 */
const AVAILABLE_MODELS = [
    { id: 'claude',   label: 'Claude',   logo: 'claude-color.png'   },
    { id: 'gemini',   label: 'Gemini',   logo: 'gemini-color.png'   },
    { id: 'deepseek', label: 'DeepSeek', logo: 'deepseek-color.png' },
    { id: 'chatglm',  label: 'ChatGLM',  logo: 'chatglm-color.png'  },
    { id: 'grok',     label: 'Grok',     logo: 'grok.png'           },
    { id: 'kimi',     label: 'Kimi',     logo: 'kimi-color.png'     },
];

/** Map model id → full logo URL */
const MODEL_LOGO_MAP = Object.fromEntries(
    AVAILABLE_MODELS.map(m => [m.id, LOGO_BASE + m.logo]),
);

/** Friendly labels for chat completion sources */
const SOURCE_LABELS = {
    [chat_completion_sources.OPENAI]: 'OpenAI',
    [chat_completion_sources.CLAUDE]: 'Claude',
    [chat_completion_sources.OPENROUTER]: 'OpenRouter',
    [chat_completion_sources.AI21]: 'AI21',
    [chat_completion_sources.MAKERSUITE]: 'Google AI',
    [chat_completion_sources.VERTEXAI]: 'Vertex AI',
    [chat_completion_sources.MISTRALAI]: 'Mistral AI',
    [chat_completion_sources.CUSTOM]: 'Custom',
    [chat_completion_sources.COHERE]: 'Cohere',
    [chat_completion_sources.PERPLEXITY]: 'Perplexity',
    [chat_completion_sources.GROQ]: 'Groq',
    [chat_completion_sources.ELECTRONHUB]: 'ElectronHub',
    [chat_completion_sources.CHUTES]: 'Chutes',
    [chat_completion_sources.NANOGPT]: 'NanoGPT',
    [chat_completion_sources.DEEPSEEK]: 'DeepSeek',
    [chat_completion_sources.AIMLAPI]: 'AIML API',
    [chat_completion_sources.XAI]: 'xAI',
    [chat_completion_sources.POLLINATIONS]: 'Pollinations',
    [chat_completion_sources.MOONSHOT]: 'Moonshot',
    [chat_completion_sources.FIREWORKS]: 'Fireworks',
    [chat_completion_sources.COMETAPI]: 'CometAPI',
    [chat_completion_sources.AZURE_OPENAI]: 'Azure OpenAI',
    [chat_completion_sources.ZAI]: 'ZhipuAI',
    [chat_completion_sources.SILICONFLOW]: 'SiliconFlow',
    [chat_completion_sources.WORKERS_AI]: 'Workers AI',
    [chat_completion_sources.MINIMAX]: 'MiniMax',
};

/** Source → logo mapping (reuses the logos that match) */
const SOURCE_LOGO_MAP = {
    [chat_completion_sources.CLAUDE]: MODEL_LOGO_MAP['claude'],
    [chat_completion_sources.MAKERSUITE]: MODEL_LOGO_MAP['gemini'],
    [chat_completion_sources.VERTEXAI]: MODEL_LOGO_MAP['gemini'],
    [chat_completion_sources.DEEPSEEK]: MODEL_LOGO_MAP['deepseek'],
    [chat_completion_sources.ZAI]: MODEL_LOGO_MAP['chatglm'],
    [chat_completion_sources.XAI]: MODEL_LOGO_MAP['grok'],
    [chat_completion_sources.MOONSHOT]: MODEL_LOGO_MAP['kimi'],
};

/** Keys in the preset object that map to a model name for each source */
const MODEL_KEYS = {
    [chat_completion_sources.OPENAI]: 'openai_model',
    [chat_completion_sources.CLAUDE]: 'claude_model',
    [chat_completion_sources.OPENROUTER]: 'openrouter_model',
    [chat_completion_sources.AI21]: 'ai21_model',
    [chat_completion_sources.MAKERSUITE]: 'google_model',
    [chat_completion_sources.VERTEXAI]: 'vertexai_model',
    [chat_completion_sources.MISTRALAI]: 'mistralai_model',
    [chat_completion_sources.CUSTOM]: 'custom_model',
    [chat_completion_sources.COHERE]: 'cohere_model',
    [chat_completion_sources.PERPLEXITY]: 'perplexity_model',
    [chat_completion_sources.GROQ]: 'groq_model',
    [chat_completion_sources.ELECTRONHUB]: 'electronhub_model',
    [chat_completion_sources.CHUTES]: 'chutes_model',
    [chat_completion_sources.NANOGPT]: 'nanogpt_model',
    [chat_completion_sources.DEEPSEEK]: 'deepseek_model',
    [chat_completion_sources.AIMLAPI]: 'aimlapi_model',
    [chat_completion_sources.XAI]: 'xai_model',
    [chat_completion_sources.POLLINATIONS]: 'pollinations_model',
    [chat_completion_sources.MOONSHOT]: 'moonshot_model',
    [chat_completion_sources.FIREWORKS]: 'fireworks_model',
    [chat_completion_sources.COMETAPI]: 'cometapi_model',
    [chat_completion_sources.AZURE_OPENAI]: 'azure_openai_model',
    [chat_completion_sources.ZAI]: 'zai_model',
    [chat_completion_sources.SILICONFLOW]: 'siliconflow_model',
    [chat_completion_sources.WORKERS_AI]: 'workers_ai_model',
    [chat_completion_sources.MINIMAX]: 'minimax_model',
};

// ─────────────────────────────────────────
// Metadata helpers (read / write the extensions field of the preset JSON)
// ─────────────────────────────────────────

/**
 * Read the preset_cards metadata from a preset object.
 * @param {object} preset  raw preset from openai_settings[]
 * @returns {{ description: string, models: string[] }}
 */
function readMeta(preset) {
    const ext = preset?.extensions?.[EXTENSION_KEY];
    return {
        description: ext?.description || '',
        models: Array.isArray(ext?.models) ? ext.models : [],
        profiles: Array.isArray(ext?.profiles) ? ext.profiles : [],
    };
}

/**
 * Persist metadata into the preset's extensions field and save to disk.
 * @param {string} presetName
 * @param {number} presetIndex
 * @param {{ description: string, models: string[] }} meta
 */
async function saveMeta(presetName, presetIndex, meta) {
    const preset = openai_settings[presetIndex];
    if (!preset) return;

    // Ensure extensions object exists
    if (!preset.extensions) preset.extensions = {};
    preset.extensions[EXTENSION_KEY] = {
        description: meta.description || '',
        models: meta.models || [],
        profiles: meta.profiles || [],
    };

    // Also update oai_settings if this is the current preset
    if (oai_settings.preset_settings_openai === presetName) {
        if (!oai_settings.extensions) oai_settings.extensions = {};
        oai_settings.extensions[EXTENSION_KEY] = preset.extensions[EXTENSION_KEY];
    }

    // Build the preset body from the actual preset object (not from oai_settings,
    // which reflects the *currently active* preset — possibly a different one).
    const presetBody = structuredClone(preset);

    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: presetName,
            preset: presetBody,
        }),
    });

    if (!response.ok) {
        toastr.error(t`Failed to save preset metadata`);
        console.error('Failed to save preset metadata', response);
    }
}

// ─────────────────────────────────────────
// Build view-model
// ─────────────────────────────────────────

function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? '…' + str.slice(-(max - 1)) : str;
}

/**
 * Build the template-friendly preset list.
 */
function buildPresetList() {
    const currentPresetName = oai_settings.preset_settings_openai;
    const presets = [];

    for (const [name, index] of Object.entries(openai_setting_names)) {
        const preset = openai_settings[index];
        if (!preset) continue;

        const source = preset.chat_completion_source || '';
        const sourceLabel = SOURCE_LABELS[source] || '';
        const modelKey = MODEL_KEYS[source] || '';
        const modelName = modelKey ? truncate(preset[modelKey] || '', 40) : '';

        // Source + model combined line
        let sourceAndModel = sourceLabel;
        if (modelName) sourceAndModel += ' · ' + modelName;

        // Logo: use source logo if available
        const logoPath = SOURCE_LOGO_MAP[source] || '';

        // Read custom metadata
        const meta = readMeta(preset);
        
        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];

        // Build model chips from metadata
        const modelChips = meta.models.map(mid => {
            const def = AVAILABLE_MODELS.find(m => m.id === mid);
            return def ? { label: def.label, logo: LOGO_BASE + def.logo } : { label: mid, logo: '' };
        });

        presets.push({
            name,
            index,
            isActive: name === currentPresetName,
            temperature: preset.temperature != null ? String(preset.temperature) : '',
            topP: preset.top_p != null ? String(preset.top_p) : '',
            topK: preset.top_k != null ? String(preset.top_k) : '',
            contextTokens: preset.openai_max_context || 0,
            maxTokens: preset.openai_max_tokens || 0,
            streaming: !!preset.stream_openai,
            sourceAndModel,
            logoPath,
            description: meta.description,
            modelChips,
            profiles,
        });
    }

    // Active first, then alphabetically
    presets.sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return presets;
}

function getCardsTemplateContext() {
    return {
        presets: buildPresetList(),
        i18n: {
            searchPlaceholder: L('Search presets...'),
            multiSelect: L('Multi-Select'),
            batchDelete: L('Batch Delete'),
            importPreset: L('Import Preset'),
            configurations: L('Configurations'),
            addConfig: L('Save current state as new configuration'),
            loadConfig: L('Load configuration'),
            overwriteConfig: L('Overwrite with current settings'),
            exportConfig: L('Export configuration'),
            importConfig: L('Import configuration'),
            rename: L('Rename'),
            delete: L('Delete'),
        }
    };
}

// ─────────────────────────────────────────
// Edit modal
// ─────────────────────────────────────────

/**
 * Open the edit modal for a preset.
 * @param {string} presetName
 * @param {number} presetIndex
 * @param {Function} onSaved  callback after saving so the card grid can refresh
 */
async function openEditModal(presetName, presetIndex, onSaved) {
    const preset = openai_settings[presetIndex];
    if (!preset) return;

    const meta = readMeta(preset);

    // Build available models with selection state
    const availableModels = AVAILABLE_MODELS.map(m => ({
        ...m,
        logo: LOGO_BASE + m.logo,
        selected: meta.models.includes(m.id),
    }));

    const html = await renderExtensionTemplateAsync('preset-cards', 'edit', {
        presetName,
        description: meta.description,
        availableModels,
        i18n: {
            descTitle: L('Description'),
            descPlaceholder: L('Add a short description for this preset...'),
            modelsTitle: L('Applicable Models'),
        }
    });

    const dialog = $(html);

    // Toggle model chips
    dialog.find('.preset_edit_model_option').on('click', function () {
        $(this).toggleClass('active');
    });

    const result = await callGenericPopup(dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    // Collect values
    const newDesc = dialog.find('#preset_edit_desc').val()?.toString().trim() || '';
    const newModels = dialog.find('.preset_edit_model_option.active').map(function () {
        return $(this).data('model-id');
    }).get();

    await saveMeta(presetName, presetIndex, { description: newDesc, models: newModels });
    toastr.success(t`Preset updated`);
    if (onSaved) onSaved();
}

// ─────────────────────────────────────────
// Main popup
// ─────────────────────────────────────────

async function openPresetCards() {
    let presets = buildPresetList();
    
    let isBatchMode = false;
    let batchSelectedCards = new Set();

    const html = await renderExtensionTemplateAsync('preset-cards', 'cards', getCardsTemplateContext());
    const dialog = $(html);

    // ---- Helpers ----
    function updateCount(visible, total) {
        const el = dialog.find('#preset_cards_count');
        el.text(visible === total ? `${total} presets` : `${visible} / ${total}`);
    }

    // ---- Search ----
    dialog.on('input', '#preset_cards_search', function () {
        const q = $(this).val().toString().toLowerCase().trim();
        let vis = 0;
        dialog.find('.preset_card').each(function () {
            const name = $(this).data('preset-name').toString().toLowerCase();
            const desc = $(this).find('.preset_card_desc').text().toLowerCase();
            const match = !q || name.includes(q) || desc.includes(q);
            $(this).toggle(match);
            if (match) vis++;
        });
        let emptyEl = dialog.find('#preset_cards_empty');
        if (vis === 0 && emptyEl.length === 0) {
            dialog.find('#preset_cards_grid').append(
                `<div id="preset_cards_empty">${t`No presets found`}</div>`,
            );
        }
        dialog.find('#preset_cards_empty').toggle(vis === 0);
        updateCount(vis, presets.length);
    });

    // ---- Card click → switch preset or batch select ----
    dialog.on('click', '.preset_card', function (e) {
        // Ignore if clicking action buttons
        if ($(e.target).closest('.preset_card_actions').length) return;

        const name = $(this).attr('data-preset-name');
        
        if (isBatchMode) {
            if (batchSelectedCards.has(name)) {
                batchSelectedCards.delete(name);
                $(this).removeClass('batch_selected');
            } else {
                batchSelectedCards.add(name);
                $(this).addClass('batch_selected');
            }
            return;
        }

        const idx = $(this).data('preset-index');

        dialog.find('.preset_card').removeClass('selected');
        $(this).addClass('selected');

        $('#settings_preset_openai').val(idx).trigger('change');
        toastr.success(`${t`Switched to`} ${name}`);
    });

    // ---- Edit button ----
    dialog.on('click', '.preset_card_edit_btn', function (e) {
        e.stopPropagation();
        const name = $(this).data('preset-name');
        const idx = $(this).data('preset-index');

        openEditModal(name, idx, async () => {
            // Refresh the card in-place
            const preset = openai_settings[idx];
            const meta = readMeta(preset);
            const card = dialog.find(`.preset_card[data-preset-index="${idx}"]`);

            // Update description
            if (meta.description) {
                let descEl = card.find('.preset_card_desc');
                if (descEl.length === 0) {
                    card.find('.preset_card_body').prepend('<div class="preset_card_desc"></div>');
                    descEl = card.find('.preset_card_desc');
                }
                descEl.text(meta.description).attr('title', meta.description);
            } else {
                card.find('.preset_card_desc').remove();
            }

            // Update model chips
            const chipsEl = card.find('.preset_card_tags');
            chipsEl.empty();
            if (meta.models.length > 0) {
                if (chipsEl.length === 0) {
                    // Note: it should be inserted before the profiles section, but appending to body works if profiles aren't there. 
                    // Actually, let's insert it before .preset_card_profiles_section
                    const profilesEl = card.find('.preset_card_profiles_section');
                    if (profilesEl.length > 0) {
                        profilesEl.before('<div class="preset_card_tags"></div>');
                    } else {
                        card.find('.preset_card_body').append('<div class="preset_card_tags"></div>');
                    }
                }
                for (const mid of meta.models) {
                    const def = AVAILABLE_MODELS.find(m => m.id === mid);
                    const logoHtml = def ? `<img src="${LOGO_BASE + def.logo}" alt="" />` : '';
                    const label = def ? def.label : mid;
                    card.find('.preset_card_tags').append(
                        `<span class="preset_card_chip" title="${label}">${logoHtml}${label}</span>`,
                    );
                }
            } else {
                chipsEl.remove();
            }
        });
    });

    // ---- Export button ----
    dialog.on('click', '.preset_card_export_btn', function (e) {
        e.stopPropagation();
        const name = $(this).attr('data-preset-name');
        const idx = $(this).data('preset-index');
        const preset = structuredClone(openai_settings[idx]);
        
        // Remove sensitive fields
        const sensitiveFields = [
            'reverse_proxy',
            'proxy_password',
            'custom_url',
            'custom_include_body',
            'custom_exclude_body',
            'custom_include_headers',
            'vertexai_region',
            'vertexai_express_project_id',
            'azure_base_url',
            'azure_deployment_name',
            'workers_ai_account_id',
        ];
        
        sensitiveFields.forEach(field => delete preset[field]);

        // Remove connection data
        if (settingsToUpdate) {
            for (const [, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
                if (isConnection) {
                    delete preset[settingName];
                }
            }
        }

        const data = JSON.stringify(preset, null, 4);
        download(data, `${name}.json`, 'application/json');
    });

    // ---- Delete button ----
    dialog.on('click', '.preset_card_delete_btn', async function (e) {
        e.stopPropagation();
        const nameToDelete = $(this).attr('data-preset-name');
        
        const confirm = await callGenericPopup(t`Delete the preset? This action is irreversible and your current settings will be overwritten.`, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const value = openai_setting_names[nameToDelete];
        $(`#settings_preset_openai option[value="${value}"]`).remove();
        delete openai_setting_names[nameToDelete];
        
        if (oai_settings.preset_settings_openai === nameToDelete) {
            oai_settings.preset_settings_openai = null;
            if (Object.keys(openai_setting_names).length) {
                oai_settings.preset_settings_openai = Object.keys(openai_setting_names)[0];
                const newValue = openai_setting_names[oai_settings.preset_settings_openai];
                $(`#settings_preset_openai option[value="${newValue}"]`).prop('selected', true);
                $('#settings_preset_openai').trigger('change');
            }
        }

        const response = await fetch('/api/presets/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
        });

        if (!response.ok) {
            toastr.warning(t`Preset was not deleted from server`);
        } else {
            toastr.success(t`Preset deleted`);
            
            // Safely remove the card from the UI immediately
            dialog.find('.preset_card').filter(function () {
                return $(this).attr('data-preset-name') === nameToDelete;
            }).remove();
            
            // Re-evaluate counts and search
            presets = presets.filter(p => p.name !== nameToDelete);
            dialog.find('#preset_cards_search').trigger('input');
            
            // If the active preset changed (because the old one was deleted), update the selected styling
            dialog.find('.preset_card').removeClass('selected');
            const newActive = oai_settings.preset_settings_openai;
            if (newActive) {
                dialog.find('.preset_card').filter(function () {
                    return $(this).attr('data-preset-name') === newActive;
                }).addClass('selected');
            }
            
            // Emit the event LAST to avoid being interrupted by other listeners
            try {
                await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
            } catch (err) {
                console.error('Error emitting PRESET_DELETED', err);
            }
        }
    });

    // ---- Multi-select toggle ----
    dialog.on('click', '#preset_cards_multiselect_btn', function () {
        isBatchMode = !isBatchMode;
        $(this).toggleClass('active', isBatchMode);
        dialog.toggleClass('preset_cards_batch_mode', isBatchMode);
        
        if (isBatchMode) {
            dialog.find('#preset_cards_batch_delete_btn').removeClass('hidden');
        } else {
            dialog.find('#preset_cards_batch_delete_btn').addClass('hidden');
            batchSelectedCards.clear();
            dialog.find('.preset_card').removeClass('batch_selected');
        }
    });

    // ---- Batch Delete button ----
    dialog.on('click', '#preset_cards_batch_delete_btn', async function () {
        if (batchSelectedCards.size === 0) {
            toastr.info(t`No presets selected`);
            return;
        }

        const confirm = await callGenericPopup(t`Delete ${batchSelectedCards.size} presets? This action is irreversible.`, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        let activeDeleted = false;
        let deletedCount = 0;

        for (const nameToDelete of batchSelectedCards) {
            const value = openai_setting_names[nameToDelete];
            if (value === undefined) continue;

            $(`#settings_preset_openai option[value="${value}"]`).remove();
            delete openai_setting_names[nameToDelete];
            
            if (oai_settings.preset_settings_openai === nameToDelete) {
                oai_settings.preset_settings_openai = null;
                activeDeleted = true;
            }

            const response = await fetch('/api/presets/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
            });

            if (response.ok) {
                deletedCount++;
                dialog.find('.preset_card').filter(function () {
                    return $(this).attr('data-preset-name') === nameToDelete;
                }).remove();
                presets = presets.filter(p => p.name !== nameToDelete);
                try {
                    await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
                } catch (err) {
                    console.error('Error emitting PRESET_DELETED for batch mode', err);
                }
            }
        }

        if (activeDeleted) {
            if (Object.keys(openai_setting_names).length) {
                oai_settings.preset_settings_openai = Object.keys(openai_setting_names)[0];
                const newValue = openai_setting_names[oai_settings.preset_settings_openai];
                $(`#settings_preset_openai option[value="${newValue}"]`).prop('selected', true);
                $('#settings_preset_openai').trigger('change');
            }
            
            dialog.find('.preset_card').removeClass('selected');
            const newActive = oai_settings.preset_settings_openai;
            if (newActive) {
                dialog.find('.preset_card').filter(function () {
                    return $(this).attr('data-preset-name') === newActive;
                }).addClass('selected');
            }
        }

        if (deletedCount > 0) {
            toastr.success(t`${deletedCount} presets deleted`);
            dialog.find('#preset_cards_search').trigger('input');
        }
        
        // Exit batch mode
        dialog.find('#preset_cards_multiselect_btn').trigger('click');
    });

    // ---- Profiles: Add Configuration ----
    dialog.on('click', '.preset_card_add_profile_btn', async function (e) {
        e.stopPropagation();
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name');
        const idx = card.data('preset-index');
        
        const profileName = await Popup.show.input(L('Configuration name:'), L('e.g., GPT-4 Optimization'));
        if (!profileName) return;

        let loadingToast = null;
        if (oai_settings.preset_settings_openai === name) {
            loadingToast = toastr.info(L('Saving current preset state...'), '', { timeOut: 0, extendedTimeOut: 0 });
            $('#update_oai_preset').trigger('click');
            await new Promise(r => setTimeout(r, 800));
            toastr.clear(loadingToast);
        }

        const preset = openai_settings[idx];
        const meta = readMeta(preset);
        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
        
        // Snapshot the current preset settings
        const snapshot = structuredClone(preset);
        delete snapshot.extensions; // Don't nest extensions
        
        profiles.push({
            id: Date.now().toString() + Math.floor(Math.random() * 1000),
            name: profileName,
            settings: snapshot
        });
        
        meta.profiles = profiles;
        await saveMeta(name, idx, meta);
        toastr.success(L('Configuration saved'));
        
        // Refresh UI
        const newHtml = await renderExtensionTemplateAsync('preset-cards', 'cards', { presets: buildPresetList() });
        dialog.html($(newHtml).html());
        dialog.find('#preset_cards_search').trigger('input');
    });

    // ---- Profiles: Load Configuration ----
    dialog.on('click', '.preset_card_profile_name', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name');
        const idx = card.data('preset-index');
        
        const preset = openai_settings[idx];
        const meta = readMeta(preset);
        const profile = meta.profiles.find(p => p.id === String(profileId));
        if (!profile) return;
        
        // Merge profile settings into the preset, while preserving extensions
        const ext = preset.extensions;
        Object.assign(preset, profile.settings);
        preset.extensions = ext;
        
        // Save to disk so changes persist
        await saveMeta(name, idx, meta);
        
        toastr.success(L('Configuration loaded'));
        
        // If this is the active preset, trigger a native UI reload
        if (oai_settings.preset_settings_openai === name) {
            $('#settings_preset_openai').trigger('change');
        }
    });

    // ---- Profiles: Update Configuration ----
    dialog.on('click', '.preset_card_profile_update', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name');
        const idx = card.data('preset-index');
        
        const confirm = await callGenericPopup(L('Overwrite this configuration with current settings?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        let loadingToast = null;
        if (oai_settings.preset_settings_openai === name) {
            loadingToast = toastr.info(L('Saving current preset state...'), '', { timeOut: 0, extendedTimeOut: 0 });
            $('#update_oai_preset').trigger('click');
            await new Promise(r => setTimeout(r, 800));
            toastr.clear(loadingToast);
        }

        const preset = openai_settings[idx];
        const meta = readMeta(preset);
        const profile = meta.profiles.find(p => p.id === String(profileId));
        if (!profile) return;

        // Snapshot the current preset settings
        const snapshot = structuredClone(preset);
        delete snapshot.extensions; // Don't nest extensions
        
        profile.settings = snapshot;
        
        await saveMeta(name, idx, meta);
        toastr.success(L('Configuration updated'));
    });

    // ---- Profiles: Delete Configuration ----
    dialog.on('click', '.preset_card_profile_delete', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name');
        const idx = card.data('preset-index');
        
        const preset = openai_settings[idx];
        const meta = readMeta(preset);
        
        const confirm = await callGenericPopup(L('Delete this configuration?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        meta.profiles = (meta.profiles || []).filter(p => p.id !== String(profileId));
        await saveMeta(name, idx, meta);
        
        row.remove();
    });

    // ---- Profiles: Export Configuration ----
    dialog.on('click', '.preset_card_profile_export', function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const preset = openai_settings[card.data('preset-index')];
        
        const meta = readMeta(preset);
        const profile = meta.profiles.find(p => p.id === String(profileId));
        if (!profile) return;
        
        const data = JSON.stringify(profile.settings, null, 4);
        download(data, `${profile.name}.json`, 'application/json');
    });

    // ---- Profiles: Import Configuration ----
    dialog.on('click', '.preset_card_import_profile_btn', function (e) {
        e.stopPropagation();
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name');
        const idx = card.data('preset-index');
        
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            
            try {
                const text = await file.text();
                const settings = JSON.parse(text);
                
                let defaultName = file.name.replace(/\.json$/i, '');
                const profileName = await Popup.show.input(L('Configuration name:'), defaultName, defaultName);
                if (!profileName) return;
                
                const preset = openai_settings[idx];
                const meta = readMeta(preset);
                const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
                
                profiles.push({
                    id: Date.now().toString() + Math.floor(Math.random() * 1000),
                    name: profileName,
                    settings: settings
                });
                
                meta.profiles = profiles;
                await saveMeta(name, idx, meta);
                toastr.success(L('Configuration saved'));
                
                const newHtml = await renderExtensionTemplateAsync('preset-cards', 'cards', getCardsTemplateContext());
                dialog.html($(newHtml).html());
                dialog.find('#preset_cards_search').trigger('input');
            } catch (err) {
                console.error(err);
                toastr.error(L('Failed to parse configuration file'));
            }
        };
        input.click();
    });

    // ---- Profiles: Edit/Rename Configuration ----
    dialog.on('click', '.preset_card_profile_edit', function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const nameContainer = row.find('.preset_card_profile_name');
        
        // Prevent double click/edit
        if (nameContainer.length === 0) return; 
        
        const currentName = nameContainer.text();
        
        const input = $('<input>', {
            type: 'text',
            class: 'preset_card_profile_edit_input',
            value: currentName
        });
        
        nameContainer.replaceWith(input);
        input.focus();
        
        input.on('blur keydown', async function (evt) {
            if (evt.type === 'keydown' && evt.key !== 'Enter' && evt.key !== 'Escape') return;
            evt.stopPropagation();
            
            const newName = (evt.key === 'Escape') ? currentName : input.val().trim() || currentName;
            
            const newContainer = $('<div>', {
                class: 'preset_card_profile_name',
                title: 'Load configuration',
                text: newName
            });
            input.replaceWith(newContainer);
            
            if (newName !== currentName && evt.key !== 'Escape') {
                const profileId = row.data('profile-id');
                const card = row.closest('.preset_card');
                const name = card.attr('data-preset-name');
                const idx = card.data('preset-index');
                
                const preset = openai_settings[idx];
                const meta = readMeta(preset);
                const profile = meta.profiles.find(p => p.id === String(profileId));
                if (profile) {
                    profile.name = newName;
                    await saveMeta(name, idx, meta);
                }
            }
        });
    });

    // ---- Import button ----
    dialog.on('click', '#preset_cards_import_btn', function () {
        $('#openai_preset_import_file').trigger('click');
        // Let SillyTavern's native import handler do the rest.
        // It will parse the file, save the preset, and switch to it.
        // We will just close the modal since a new preset was imported and the grid is now stale.
        dialog.closest('.popup').find('.popup-controls .menu_button').click();
    });

    updateCount(presets.length, presets.length);

    callGenericPopup(dialog, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}

// ─────────────────────────────────────────
// Init
// ─────────────────────────────────────────

export function init() {
    const buttonHtml = `
        <div id="preset_cards_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-grip extensionsMenuExtensionButton"></div>` +
            t`Preset Cards` +
        '</div>';
    $('#token_counter_wand_container').append(buttonHtml);
    $('#preset_cards_button').on('click', openPresetCards);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'presetcards',
        callback: async () => {
            await openPresetCards();
            return '';
        },
        helpString: 'Opens the preset cards view for Chat Completion presets.',
    }));
}
