import { getRequestHeaders, saveSettingsDebounced } from '/script.js';
import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import {
    oai_settings,
    openai_settings,
    openai_setting_names,
    chat_completion_sources,
} from '/scripts/openai.js';
import { POPUP_TYPE, POPUP_RESULT, callGenericPopup, Popup } from '/scripts/popup.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { t } from '/scripts/i18n.js';
import { download } from '/scripts/utils.js';
import { settingsToUpdate } from '/scripts/openai.js';
import { eventSource, event_types } from '/scripts/events.js';

// ─────────────────────────────────────────
// Rust WASM Fast Preset Loading
// ─────────────────────────────────────────
import initWasm, { parse_settings_fast } from './wasm/rust_core.js';

let wasmInitialized = false;
try {
    await initWasm();
    wasmInitialized = true;
    console.log("preset-cards: Rust WASM core initialized successfully!");
} catch (e) {
    console.error("preset-cards: Failed to init WASM", e);
}

const originalFetch = window.fetch;
window.fetch = async (...args) => {
    const url = args[0];
    if (url === '/api/settings/get' && wasmInitialized) {
        console.time("WASM_Preset_Parsing");
        const response = await originalFetch(...args);
        const text = await response.text();
        try {
            const parsedObj = parse_settings_fast(text);
            console.timeEnd("WASM_Preset_Parsing");
            // Return a mocked Response
            const mockResponse = {
                ok: response.ok,
                status: response.status,
                headers: response.headers,
                json: async () => parsedObj,
                text: async () => text,
                clone: () => mockResponse
            };
            return mockResponse;
        } catch (e) {
            console.error("WASM Parsing failed, falling back to original", e);
            console.timeEnd("WASM_Preset_Parsing");
            return new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        }
    }
    return originalFetch(...args);
};

// Patch JSON.parse to be idempotent, since ST will call it on objects we already parsed
const originalJsonParse = JSON.parse;
JSON.parse = function(text, reviver) {
    if (typeof text === 'object' && text !== null) return text;
    return originalJsonParse(text, reviver);
};

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

let EXTENSION_NAME = 'preset-cards';
try {
    const url = new URL(import.meta.url);
    const match = url.pathname.match(/\/scripts\/extensions\/(.*?)\/index\.js/);
    if (match) EXTENSION_NAME = match[1];
} catch (e) {
    console.warn('preset-cards: could not determine extension path', e);
}

const EXTENSION_KEY = 'preset_cards';
const LOGO_BASE = `/scripts/extensions/${EXTENSION_NAME}/llm-logos/`;

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
    'Concise Mode': '简洁模式',
    'No configurations saved for this preset': '该预设没有配置快照',
    'Background Image URL': '背景图片链接',
    'e.g., https://example.com/bg.jpg': '例如：https://example.com/bg.jpg',
    'Clear Cache': '清理缓存',
    'Clear all cached background images?': '确定要清理所有已缓存的背景图片吗？',
    'Cache cleared successfully': '缓存清理成功',
    'Select modules to save in this snapshot:': '选择在此快照中保存的模块：',
    'Generation Settings (Temp, Top P, etc.)': '生成参数 (温度、Top P 等核心参数)',
    'Prompts & States (System Prompts, Positions, Toggles)': '提示词与条目状态 (内置提示词、条目位置与开关)',
    'Enter AAD (Additional Authenticated Data) for encryption:': '请输入加密用的密钥(AAD):',
    'Enter AAD (Additional Authenticated Data) for decryption:': '请输入解密用的密钥(AAD):',
    'Select import format:': '请选择导入的格式：',
    '.myu (Encrypted)': '.myu (加密格式)',
    '.json (Normal)': '.json (普通格式)',
    'Select export format:': '请选择导出的格式：',
    'Exported successfully. IMPORTANT: Please safely store the downloaded .pckey file. You cannot decrypt the preset without it!': '导出成功！请务必妥善保管好同时下载的 .pckey 密钥文件，并将其与 .myu 文件分开存放！如果没有此密钥，您将永远无法解密此预设！',
    'Encryption failed': '加密失败',
    'Do you want to use a custom pckey and only modify AAD?': '是否使用自定义pckey文件加密，仅修改验证密钥(AAD)？',
    'No, generate new': '否，生成全新密钥',
    'Please select the .pckey file to encrypt this preset:': '请选择要用于加密此预设的 .pckey 密钥文件：',
    'Exported encrypted preset with custom pckey.': '已使用自定义 pckey 导出加密预设。',
    'Decrypted and imported successfully': '解密并导入成功！',
    'Decryption failed. Check your AAD and key.': '解密失败，请检查您的 AAD 和密钥是否正确。',
    'Invalid .myu file': '无效的 .myu 文件',
};

// ─────────────────────────────────────────
// Snapshot Modules Config
// ─────────────────────────────────────────
const SNAPSHOT_PROMPT_KEYS = new Set([
    'prompts', 'sysPrompt', 'userPrompt', 'jailbreak', 'impersonation_prompt', 'bias_string'
]);
const SNAPSHOT_IGNORED_KEYS = new Set([
    'name', 'extensions', 'openai_model', 'claude_model', 'openrouter_model',
    'ai21_model', 'google_model', 'vertexai_model', 'mistralai_model', 'custom_model',
    'cohere_model', 'perplexity_model', 'groq_model', 'chutes_model', 'deepseek_model',
    'aimlapi_model', 'xai_model', 'pollinations_model', 'moonshot_model', 'fireworks_model',
    'cometapi_model', 'azure_openai_model', 'zai_model', 'siliconflow_model', 'workers_ai_model',
    'minimax_model'
]);

// ─────────────────────────────────────────
// Caching / IndexedDB
// ─────────────────────────────────────────
const CACHE_DB_NAME = 'PresetCardsCache';
const CACHE_STORE_NAME = 'images';
let cacheDb = null;
const URL_CACHE = new Map();

function initCacheDb() {
    return new Promise((resolve) => {
        if (cacheDb) return resolve(cacheDb);
        const request = indexedDB.open(CACHE_DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
                db.createObjectStore(CACHE_STORE_NAME);
            }
        };
        request.onsuccess = (e) => {
            cacheDb = e.target.result;
            resolve(cacheDb);
        };
        request.onerror = () => {
            console.warn('preset-cards: Failed to open IndexedDB for caching.');
            resolve(null);
        };
    });
}

async function getCachedImageURL(url) {
    if (!url) return '';
    // Skip data URIs or local blob URIs
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;

    if (URL_CACHE.has(url)) return URL_CACHE.get(url);

    const promise = (async () => {
        const db = await initCacheDb();
        if (!db) return url;

        return new Promise((resolve) => {
            const tx = db.transaction(CACHE_STORE_NAME, 'readonly');
            const store = tx.objectStore(CACHE_STORE_NAME);
            const req = store.get(url);

            req.onsuccess = async () => {
                if (req.result) {
                    resolve(URL.createObjectURL(req.result));
                } else {
                    try {
                        const response = await fetch(url, { mode: 'cors' });
                        if (!response.ok) throw new Error('Network response was not ok');
                        const blob = await response.blob();

                        const writeTx = db.transaction(CACHE_STORE_NAME, 'readwrite');
                        writeTx.objectStore(CACHE_STORE_NAME).put(blob, url);

                        resolve(URL.createObjectURL(blob));
                    } catch (err) {
                        console.warn('preset-cards: CORS or network error caching image, falling back to original URL.', err);
                        resolve(url);
                    }
                }
            };
            req.onerror = () => resolve(url);
        });
    })();
    URL_CACHE.set(url, promise);
    return promise;
}

async function applyCachedBackgrounds(container) {
    const bgElements = container.find('.preset_card_bg_image').filter(function () {
        return $(this).data('bg-url') && !$(this).css('background-image').includes('url(');
    });

    const urlGroups = {};
    bgElements.each(function () {
        const url = $(this).data('bg-url');
        if (!urlGroups[url]) urlGroups[url] = [];
        urlGroups[url].push(this);
    });

    for (const [url, elements] of Object.entries(urlGroups)) {
        getCachedImageURL(url).then(cachedUrl => {
            elements.forEach(el => $(el).css('background-image', `url('${cachedUrl}')`));
        });
    }
}

async function clearImageCache() {
    URL_CACHE.clear();
    const db = await initCacheDb();
    if (!db) return;
    return new Promise((resolve) => {
        const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(CACHE_STORE_NAME);
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
    });
}

let _cachedLang = null;
function L(text) {
    if (_cachedLang === null) _cachedLang = localStorage.getItem('language') || 'en';
    return (_cachedLang.startsWith('zh') && LOCAL_DICT[text]) ? LOCAL_DICT[text] : text;
}

// ─────────────────────────────────────────
// WebCrypto AES-GCM Helpers
// ─────────────────────────────────────────
function generateHex(bytes) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 8192) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
    }
    return btoa(chunks.join(''));
}

function base64ToArrayBuffer(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function promptFileSelect(accept) {
    return new Promise(resolve => {
        const input = $(`<input type="file" accept="${accept}" style="display:none;">`);
        input.on('change', e => resolve(e.target.files[0]));
        input.trigger('click');
    });
}

const _enc = new TextEncoder();
const _dec = new TextDecoder();

async function encryptDataGCM(dataStr, hexKey, hexIv, aadStr) {
    const cryptoKey = await crypto.subtle.importKey('raw', hexToBytes(hexKey), { name: 'AES-GCM' }, false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: hexToBytes(hexIv), additionalData: _enc.encode(aadStr), tagLength: 128 },
        cryptoKey, _enc.encode(dataStr)
    );
    return arrayBufferToBase64(encrypted);
}

async function decryptDataGCM(base64Ciphertext, hexKey, hexIv, aadStr) {
    const cryptoKey = await crypto.subtle.importKey('raw', hexToBytes(hexKey), { name: 'AES-GCM' }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: hexToBytes(hexIv), additionalData: _enc.encode(aadStr), tagLength: 128 },
        cryptoKey, base64ToArrayBuffer(base64Ciphertext)
    );
    return _dec.decode(decrypted);
}

/**
 * Available model definitions.
 * `id` is stored in the preset, `logo` is the filename in llm-logos/, `label` is the display name.
 */
const AVAILABLE_MODELS = [
    { id: 'claude', label: 'Claude', logo: 'claude-color.png' },
    { id: 'gemini', label: 'Gemini', logo: 'gemini-color.png' },
    { id: 'chatgpt', label: 'ChatGPT', logo: 'chatgpt.png' },
    { id: 'deepseek', label: 'DeepSeek', logo: 'deepseek-color.png' },
    { id: 'chatglm', label: 'ChatGLM', logo: 'chatglm-color.png' },
    { id: 'grok', label: 'Grok', logo: 'grok.png' },
    { id: 'kimi', label: 'Kimi', logo: 'kimi-color.png' },
];

/** Map model id → full logo URL */
const AVAILABLE_MODELS_MAP = new Map(AVAILABLE_MODELS.map(m => [m.id, m]));

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
        bgImage: ext?.bgImage || '',
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
        bgImage: meta.bgImage || '',
    };

    // Also update oai_settings if this is the current preset
    if (oai_settings.preset_settings_openai === presetName) {
        if (!oai_settings.extensions) oai_settings.extensions = {};
        oai_settings.extensions[EXTENSION_KEY] = preset.extensions[EXTENSION_KEY];
    }

    // Serialize directly — avoids structuredClone + JSON.stringify double work
    const bodyStr = JSON.stringify({
        apiId: 'openai',
        name: presetName,
        preset: preset,
    });

    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: bodyStr,
    });

    if (!response.ok) {
        toastr.error(t`Failed to save preset metadata`);
        console.error('Failed to save preset metadata', response);
    }
}

// Per-preset debounced save — collapses rapid consecutive saves into one
const _saveMetaTimers = new Map();
function debouncedSaveMeta(presetName, presetIndex, meta, delay = 300) {
    return new Promise((resolve) => {
        if (_saveMetaTimers.has(presetName)) clearTimeout(_saveMetaTimers.get(presetName));
        _saveMetaTimers.set(presetName, setTimeout(async () => {
            _saveMetaTimers.delete(presetName);
            await saveMeta(presetName, presetIndex, meta);
            resolve();
        }, delay));
    });
}

/**
 * Wait for the native ST preset save to complete after triggering #update_oai_preset.
 * Uses a short polling approach instead of a blind 800ms wait.
 * Resolves as soon as fetch to /api/presets/save completes, or after 200ms max.
 */
function waitForPresetSave() {
    return new Promise((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };

        // Fallback timeout — never wait longer than 200ms
        const timer = setTimeout(done, 200);

        // Listen for the next fetch completion to the save endpoint
        const origFetch = window.fetch;
        window.fetch = function (...args) {
            const result = origFetch.apply(this, args);
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            if (url.includes('/api/presets/save')) {
                result.then(() => {
                    clearTimeout(timer);
                    // Restore immediately, tiny delay for ST to process response
                    setTimeout(done, 30);
                }).catch(() => { clearTimeout(timer); done(); });
                window.fetch = origFetch; // Restore after first intercept
            }
            return result;
        };
    });
}

/**
 * Build a single profile row HTML and append it to a card's profiles list.
 * Avoids full grid re-render when adding/importing a profile.
 */
function appendProfileRow(card, profile, i18n) {
    const list = card.find('.preset_card_profiles_list');
    const row = $(`<div class="preset_card_profile_row" data-profile-id="${profile.id}">
        <div class="preset_card_profile_name" title="${i18n?.loadConfig || 'Load configuration'}">${profile.name}</div>
        <div class="preset_card_profile_actions">
            <i class="fa-solid fa-file-export preset_card_profile_export" title="${i18n?.exportConfig || 'Export configuration'}"></i>
            <i class="fa-solid fa-floppy-disk preset_card_profile_update" title="${i18n?.overwriteConfig || 'Overwrite with current settings'}"></i>
            <i class="fa-solid fa-pencil preset_card_profile_edit" title="${i18n?.rename || 'Rename'}"></i>
            <i class="fa-solid fa-trash-can preset_card_profile_delete" title="${i18n?.delete || 'Delete'}"></i>
        </div>
    </div>`);
    list.append(row);
}

/**
 * Fast preset apply — bypasses ST's native per-element DOM trigger loop.
 *
 * ST's onSettingsPresetChange() does ~100 individual $(selector).val(value).trigger('input')
 * calls, each causing synchronous reflow. This function instead:
 * 1. Writes directly to oai_settings (memory-only)
 * 2. Batch-updates all DOM elements in a single requestAnimationFrame
 * 3. Only triggers essential global events (save, PromptManager refresh)
 *
 * Falls back to native path when bind_preset_to_connection is on (needs full UI trigger chain).
 *
 * @param {number} presetIndex  Index into openai_settings[]
 * @param {string} presetName   Human-readable preset name
 */
async function fastApplyPreset(presetIndex, presetName) {
    const preset = openai_settings[presetIndex];
    if (!preset) return;

    // Connection-bound presets need full native flow (source switching, model list rebuilds)
    if (oai_settings.bind_preset_to_connection) {
        $('#settings_preset_openai').val(presetIndex).trigger('change');
        return;
    }

    const presetNameBefore = oai_settings.preset_settings_openai;
    oai_settings.preset_settings_openai = presetName;

    // ── Phase 1: Emit BEFORE event for PromptManager migration ──
    // We pass the preset directly (no structuredClone — we only read, never mutate)
    await eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, {
        preset: preset,
        presetName: presetName,
        settingsToUpdate: settingsToUpdate,
        settings: oai_settings,
        savePreset: null, // migration-only, save handled separately
        presetNameBefore: presetNameBefore,
    });

    // ── Phase 2: Direct memory write — skip 100× jQuery .val().trigger() ──
    for (const [key, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
        if (isConnection) continue; // connection fields skipped (bind_preset_to_connection is off)
        if (key === 'extensions') {
            oai_settings.extensions = preset.extensions || {};
            continue;
        }
        if (preset[key] !== undefined) {
            oai_settings[settingName] = preset[key];
        }
    }

    // ── Phase 3: Batch DOM update in single animation frame ──
    requestAnimationFrame(() => {
        for (const [key, [selector, , isCheckbox]] of Object.entries(settingsToUpdate)) {
            if (!selector || selector === '' || selector === '#NULL_SELECTOR') continue;
            if (preset[key] === undefined) continue;

            const el = document.querySelector(selector);
            if (!el) continue;

            if (isCheckbox) {
                el.checked = !!preset[key];
            } else {
                el.value = preset[key];
            }

            // Sync range slider numeric counters (no event trigger needed)
            if (el.type === 'range' && el.id) {
                const counter = document.querySelector(`input[type="number"][data-for="${el.id}"]`);
                if (counter) counter.value = Number(preset[key]);
            }
        }

        // Update the native dropdown selection
        const selectEl = document.querySelector('#settings_preset_openai');
        if (selectEl) selectEl.value = String(presetIndex);
    });

    // ── Phase 4: Logit bias preset (lightweight) ──
    $('#openai_logit_bias_preset').trigger('change');

    // ── Phase 5: Essential global events ──
    saveSettingsDebounced();
    await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
    await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: presetName });
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

        // Build model chips from metadata
        const modelChips = meta.models.map(mid => {
            const def = AVAILABLE_MODELS_MAP.get(mid);
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
            bgImage: meta.bgImage,
            modelChips,
            profiles: meta.profiles,
        });
    }

    // Active first, then alphabetically
    presets.sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return presets;
}

function getCardsTemplateContext(cachedPresets) {
    return {
        presets: cachedPresets || buildPresetList(),
        i18n: {
            searchPlaceholder: L('Search presets...'),
            multiSelect: L('Multi-Select'),
            batchDelete: L('Batch Delete'),
            importPreset: L('Import Preset'),
            conciseMode: L('Concise Mode'),
            clearCache: L('Clear Cache'),
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

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'edit', {
        presetName,
        description: meta.description,
        bgImage: meta.bgImage,
        availableModels,
        i18n: {
            descTitle: L('Description'),
            descPlaceholder: L('Add a short description for this preset...'),
            modelsTitle: L('Applicable Models'),
            bgImageTitle: L('Background Image URL'),
            bgImagePlaceholder: L('e.g., https://example.com/bg.jpg'),
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
    const newBgImage = dialog.find('#preset_edit_bg_image').val()?.toString().trim() || '';
    const newModels = dialog.find('.preset_edit_model_option.active').map(function () {
        return $(this).data('model-id');
    }).get();

    await saveMeta(presetName, presetIndex, { description: newDesc, models: newModels, bgImage: newBgImage, profiles: meta.profiles });
    toastr.success(t`Preset updated`);
    if (onSaved) onSaved();
}

// ─────────────────────────────────────────
// Sensitive field stripping (used by export)
// ─────────────────────────────────────────

const SENSITIVE_FIELDS = [
    'reverse_proxy', 'proxy_password', 'custom_url',
    'custom_include_body', 'custom_exclude_body', 'custom_include_headers',
    'vertexai_region', 'vertexai_express_project_id',
    'azure_base_url', 'azure_deployment_name', 'workers_ai_account_id',
];

function stripSensitiveFields(preset) {
    for (const field of SENSITIVE_FIELDS) delete preset[field];
    if (settingsToUpdate) {
        for (const [, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
            if (isConnection) delete preset[settingName];
        }
    }
}

// ─────────────────────────────────────────
// Main popup
// ─────────────────────────────────────────

async function openPresetCards() {
    let presets = buildPresetList();

    let isBatchMode = false;
    let batchSelectedCards = new Set();
    let isConciseMode = localStorage.getItem('preset_cards_concise') === 'true';

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext(presets));
    const dialog = $(html);

    if (isConciseMode) {
        dialog.addClass('preset_cards_concise_mode');
        dialog.find('#preset_cards_concise_btn').addClass('active');
    }

    // ---- Helpers ----
    function updateCount(visible, total) {
        const el = dialog.find('#preset_cards_count');
        el.text(visible === total ? `${total} presets` : `${visible} / ${total}`);
    }

    // ---- Search (debounced + pre-cached text) ----
    const _searchCache = new Map();
    dialog.find('.preset_card').each(function () {
        const el = $(this);
        const name = el.data('preset-name').toString().toLowerCase();
        const desc = el.find('.preset_card_desc').text().toLowerCase();
        _searchCache.set(this, { name, desc });
    });

    let _searchTimer = null;
    dialog.on('input', '#preset_cards_search', function () {
        if (_searchTimer) clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => {
            const q = $(this).val().toString().toLowerCase().trim();
            let vis = 0;
            const cards = dialog.find('.preset_card');
            cards.each(function () {
                const cached = _searchCache.get(this);
                const name = cached ? cached.name : $(this).data('preset-name').toString().toLowerCase();
                const desc = cached ? cached.desc : '';
                const match = !q || name.includes(q) || desc.includes(q);
                this.style.display = match ? '' : 'none'; // Direct style instead of jQuery .toggle()
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
        }, 150);
    });

    // ---- Long press for Concise Mode Profiles ----
    let pressTimer;
    let isDragging = false;
    let startX = 0;
    let startY = 0;

    async function showConciseProfilesModal(card) {
        const name = card.attr('data-preset-name');
        const idx = card.data('preset-index');
        const preset = openai_settings[idx];
        const meta = readMeta(preset);

        if (!meta.profiles || meta.profiles.length === 0) {
            toastr.info(L('No configurations saved for this preset'));
            return;
        }

        const container = $('<div class="preset_card_profiles_section" style="margin-top:0; padding:0; border:none; box-shadow:none; background:transparent;"></div>');
        const list = $('<div class="preset_card_profiles_list"></div>');

        meta.profiles.forEach(p => {
            const row = $(`<div class="preset_card_profile_row" data-profile-id="${p.id}" style="cursor:pointer; padding:10px 14px; margin-bottom:4px;">
                <div class="preset_card_profile_name" style="font-size:14px;">${p.name}</div>
            </div>`);

            row.on('click', async function () {
                const ext = preset.extensions;
                Object.assign(preset, p.settings);
                preset.extensions = ext;

                // No saveMeta needed — profile list unchanged
                toastr.success(L('Configuration loaded'));

                if (oai_settings.preset_settings_openai === name) {
                    fastApplyPreset(idx, name);
                }

                $(this).closest('.popup').find('.popup-controls .menu_button').click(); // close modal
            });

            list.append(row);
        });

        container.append(list);

        callGenericPopup(container, POPUP_TYPE.TEXT, '', {
            wide: false,
            large: false,
        });
    }

    dialog.on('mousedown touchstart', '.preset_card', function (e) {
        if (!isConciseMode || isBatchMode) return;
        if (e.type === 'mousedown' && e.which !== 1) return; // Only left click

        const touch = e.type === 'touchstart' ? e.originalEvent.touches[0] || e.originalEvent.changedTouches[0] : e;
        startX = touch.pageX;
        startY = touch.pageY;

        isDragging = false;
        const card = $(this);

        pressTimer = window.setTimeout(function () {
            card.data('long-pressed', true);
            showConciseProfilesModal(card);
        }, 600);
    });

    dialog.on('mousemove touchmove', '.preset_card', function (e) {
        const touch = e.type === 'touchmove' ? e.originalEvent.touches[0] || e.originalEvent.changedTouches[0] : e;
        const currentX = touch.pageX;
        const currentY = touch.pageY;

        if (Math.abs(currentX - startX) > 10 || Math.abs(currentY - startY) > 10) {
            isDragging = true;
            clearTimeout(pressTimer);
        }
    });

    dialog.on('mouseup touchend touchcancel mouseleave', '.preset_card', function () {
        clearTimeout(pressTimer);
    });

    dialog.on('contextmenu', '.preset_card', function (e) {
        if (isConciseMode && !isBatchMode && $(this).data('long-pressed')) {
            e.preventDefault();
        }
    });

    // ---- Card click → switch preset or batch select ----
    dialog.on('click', '.preset_card', function (e) {
        // Ignore if long-pressed
        if ($(this).data('long-pressed')) {
            $(this).data('long-pressed', false);
            return;
        }

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

        fastApplyPreset(idx, name);
        toastr.success(`${t`Switched to`} ${name}`);
    });

    // ---- Clear Cache button ----
    dialog.on('click', '#preset_cards_clear_cache_btn', async function () {
        const confirm = await callGenericPopup(L('Clear all cached background images?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        await clearImageCache();
        toastr.success(L('Cache cleared successfully'));

        // Clear inline bg styles instead of full re-render
        dialog.find('.preset_card_bg_image').css('background-image', '');
        applyCachedBackgrounds(dialog);
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
                    const def = AVAILABLE_MODELS_MAP.get(mid);
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
    dialog.on('click', '.preset_card_export_btn', async function (e) {
        e.stopPropagation();

        const exportType = await callGenericPopup(
            L('Select export format:'),
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: L('.myu (Encrypted)'), cancelButton: L('.json (Normal)') }
        );

        if (exportType === POPUP_RESULT.CANCEL) return;
        const isEncrypted = (exportType === POPUP_RESULT.AFFIRMATIVE);

        const name = $(this).attr('data-preset-name');
        const idx = $(this).data('preset-index');
        const preset = structuredClone(openai_settings[idx]);

        // Remove sensitive fields
        stripSensitiveFields(preset);

        const dataStr = JSON.stringify(preset, null, 4);

        if (!isEncrypted) {
            download(dataStr, `${name}.json`, 'application/json');
            return;
        }

        let hexKey = null;
        let hexIv = null;
        let generateNew = true;

        if (localStorage.getItem('preset_cards_has_encrypted')) {
            const useCustom = await callGenericPopup(
                L('Do you want to use a custom pckey and only modify AAD?'),
                POPUP_TYPE.CONFIRM,
                '',
                { okButton: L('Yes'), cancelButton: L('No, generate new') }
            );

            if (useCustom === POPUP_RESULT.CANCEL) return;

            if (useCustom === POPUP_RESULT.AFFIRMATIVE) {
                generateNew = false;
                toastr.info(L('Please select the .pckey file to encrypt this preset:'));

                const pckeyFile = await promptFileSelect('.pckey');
                if (!pckeyFile) return;

                try {
                    const keyArr = JSON.parse(atob(await readFileAsText(pckeyFile)));
                    hexKey = keyArr[0];
                    hexIv = keyArr[1];
                } catch (e) {
                    console.error(e);
                    toastr.error(L('Invalid .pckey file'));
                    return;
                }
            }
        }

        const aadStr = await Popup.show.input(L('Enter AAD (Additional Authenticated Data) for encryption:'), '');
        if (aadStr === null) return; // Cancelled

        try {
            if (generateNew) {
                hexKey = generateHex(32);
                hexIv = generateHex(12);
            }

            const base64Ciphertext = await encryptDataGCM(dataStr, hexKey, hexIv, aadStr);

            download(base64Ciphertext, `${name}.myu`, 'text/plain');

            if (generateNew) {
                const pckeyPayload = btoa(JSON.stringify([hexKey, hexIv]));
                download(pckeyPayload, `${name}.pckey`, 'text/plain');
                localStorage.setItem('preset_cards_has_encrypted', 'true');

                await callGenericPopup(
                    L('Exported successfully. IMPORTANT: Please safely store the downloaded .pckey file. You cannot decrypt the preset without it!'),
                    POPUP_TYPE.TEXT
                );
            } else {
                toastr.success(L('Exported encrypted preset with custom pckey.'));
            }
        } catch (err) {
            console.error('Encryption failed', err);
            toastr.error(L('Encryption failed'));
        }
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

    // ---- Concise Mode toggle ----
    dialog.on('click', '#preset_cards_concise_btn', function () {
        isConciseMode = !isConciseMode;
        $(this).toggleClass('active', isConciseMode);
        dialog.toggleClass('preset_cards_concise_mode', isConciseMode);
        localStorage.setItem('preset_cards_concise', isConciseMode);
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

        const nameInput = $('<input type="text" class="text_pole" style="margin-bottom:15px;">');
        nameInput.attr('placeholder', L('e.g., GPT-4 Optimization'));
        const genCheck = $('<input type="checkbox" checked>');
        const promptCheck = $('<input type="checkbox" checked>');

        const container = $('<div style="display:flex;flex-direction:column;gap:5px;text-align:left;"></div>');
        container.append($('<label>').html(`<b>${L('Configuration name:')}</b>`));
        container.append(nameInput);
        container.append($('<label style="margin-top:5px;margin-bottom:5px;">').html(`<b>${L('Select modules to save in this snapshot:')}</b>`));
        container.append($('<label>').css({ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }).append(genCheck).append(L('Generation Settings (Temp, Top P, etc.)')));
        container.append($('<label>').css({ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }).append(promptCheck).append(L('Prompts & States (System Prompts, Positions, Toggles)')));

        const confirm = await callGenericPopup(container, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const profileName = nameInput.val().trim();
        if (!profileName) return;

        const saveGen = genCheck.prop('checked');
        const savePrompt = promptCheck.prop('checked');

        // Smart wait: trigger native save and wait for completion (not fixed 800ms)
        if (oai_settings.preset_settings_openai === name) {
            const savePromise = waitForPresetSave();
            $('#update_oai_preset').trigger('click');
            await savePromise;
        }

        const preset = openai_settings[idx];
        const meta = readMeta(preset);
        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];

        // Snapshot the current preset settings based on selected modules
        const snapshot = {};
        for (const key of Object.keys(preset)) {
            if (SNAPSHOT_IGNORED_KEYS.has(key)) continue;

            const isPromptKey = SNAPSHOT_PROMPT_KEYS.has(key);
            if (isPromptKey && savePrompt) {
                snapshot[key] = structuredClone(preset[key]);
            } else if (!isPromptKey && saveGen) {
                snapshot[key] = structuredClone(preset[key]);
            }
        }

        const newProfile = {
            id: Date.now().toString() + Math.floor(Math.random() * 1000),
            name: profileName,
            settings: snapshot
        };
        profiles.push(newProfile);

        meta.profiles = profiles;
        await saveMeta(name, idx, meta);
        toastr.success(L('Configuration saved'));

        // Local DOM append instead of full re-render
        const i18nCtx = getCardsTemplateContext().i18n;
        appendProfileRow(card, newProfile, i18nCtx);
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

        // No saveMeta needed — profile list unchanged
        toastr.success(L('Configuration loaded'));

        // Fast-apply to UI (skips ST native per-element trigger loop)
        if (oai_settings.preset_settings_openai === name) {
            fastApplyPreset(idx, name);
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

        const genCheck = $('<input type="checkbox" checked>');
        const promptCheck = $('<input type="checkbox" checked>');

        const container = $('<div style="display:flex;flex-direction:column;gap:5px;text-align:left;"></div>');
        container.append($('<label style="margin-bottom:10px;">').html(`<b>${L('Overwrite this configuration with current settings?')}</b>`));
        container.append($('<label style="margin-bottom:5px;">').html(`<b>${L('Select modules to save in this snapshot:')}</b>`));
        container.append($('<label>').css({ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }).append(genCheck).append(L('Generation Settings (Temp, Top P, etc.)')));
        container.append($('<label>').css({ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }).append(promptCheck).append(L('Prompts & States (System Prompts, Positions, Toggles)')));

        const confirm = await callGenericPopup(container, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const saveGen = genCheck.prop('checked');
        const savePrompt = promptCheck.prop('checked');

        // Smart wait: trigger native save and wait for completion (not fixed 800ms)
        if (oai_settings.preset_settings_openai === name) {
            const savePromise = waitForPresetSave();
            $('#update_oai_preset').trigger('click');
            await savePromise;
        }

        const preset = openai_settings[idx];
        const meta = readMeta(preset);
        const profile = meta.profiles.find(p => p.id === String(profileId));
        if (!profile) return;

        // Snapshot the current preset settings based on selected modules
        const snapshot = {};
        for (const key of Object.keys(preset)) {
            if (SNAPSHOT_IGNORED_KEYS.has(key)) continue;

            const isPromptKey = SNAPSHOT_PROMPT_KEYS.has(key);
            if (isPromptKey && savePrompt) {
                snapshot[key] = structuredClone(preset[key]);
            } else if (!isPromptKey && saveGen) {
                snapshot[key] = structuredClone(preset[key]);
            }
        }

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

                const newProfile = {
                    id: Date.now().toString() + Math.floor(Math.random() * 1000),
                    name: profileName,
                    settings: settings
                };
                profiles.push(newProfile);

                meta.profiles = profiles;
                await saveMeta(name, idx, meta);
                toastr.success(L('Configuration saved'));

                // Local DOM append instead of full re-render
                const i18nCtx = getCardsTemplateContext().i18n;
                appendProfileRow(card, newProfile, i18nCtx);
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
                    // Debounced save — rapid renames won't spam the server
                    debouncedSaveMeta(name, idx, meta);
                }
            }
        });
    });

    // ---- Import button ----
    dialog.on('click', '#preset_cards_import_btn', async function () {
        const importType = await callGenericPopup(
            L('Select import format:'),
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: L('.myu (Encrypted)'), cancelButton: L('.json (Normal)') }
        );

        if (importType === POPUP_RESULT.AFFIRMATIVE) {
            try {
                const myuFile = await promptFileSelect('.myu');
                if (!myuFile) return;

                const ciphertext = (await readFileAsText(myuFile)).trim();
                if (!ciphertext) throw new Error('Empty .myu file');

                toastr.info(L('Please select the .pckey file to decrypt this preset:'));
                const pckeyFile = await promptFileSelect('.pckey');
                if (!pckeyFile) return;

                const keyArr = JSON.parse(atob(await readFileAsText(pckeyFile)));
                const [hexKey, hexIv] = keyArr;

                const aadStr = await Popup.show.input(L('Enter AAD (Additional Authenticated Data) for decryption:'), '');
                if (aadStr === null) return;

                const importedPreset = JSON.parse(await decryptDataGCM(ciphertext, hexKey, hexIv, aadStr));

                const existingNames = new Set(Object.keys(openai_setting_names));
                let newName = myuFile.name.replace('.myu', '');
                let checkName = newName;
                let counter = 1;
                while (existingNames.has(checkName)) {
                    checkName = `${newName} (${counter++})`;
                }
                importedPreset.name = checkName;

                const response = await fetch('/api/presets/save', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ apiId: 'openai', name: checkName, preset: importedPreset }),
                });
                if (!response.ok) throw new Error('Server save failed');

                toastr.success(L('Decrypted and imported successfully'));
                setTimeout(() => location.reload(), 1500);
            } catch (err) {
                console.error(err);
                const msg = err.name === 'OperationError'
                    ? L('Decryption failed. Check your AAD and key.')
                    : L('Invalid .myu file');
                toastr.error(msg);
            }
        } else if (importType === POPUP_RESULT.NEGATIVE) {
            $('#openai_preset_import_file').trigger('click');
            dialog.closest('.popup').find('.popup-controls .menu_button').click();
        }
    });

    updateCount(presets.length, presets.length);
    applyCachedBackgrounds(dialog);

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

export function refresh() {
    location.reload();
}
