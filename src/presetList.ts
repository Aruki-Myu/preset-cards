import { oai_settings, openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { AVAILABLE_MODELS, LOGO_BASE, MODEL_KEYS, SOURCE_LABELS, SOURCE_LOGO_MAP } from './constants.js';
import { isPromptBaseProfile, isPromptDeltaProfile, readMeta, type Preset, type PresetProfile, type PromptBaseProfile, type PromptDeltaProfile } from './meta.js';
import { resolveProfilePrompts } from './promptToggle.js';
import { L } from './i18n.js';

export interface ModelChip {
    label: string;
    logo: string;
}

/** profile 展开后展示的一个条目（prompt 名 + 开关状态）。 */
export interface ProfileEntryView {
    identifier: string;
    name: string;
    enabled: boolean;
    hasFields?: boolean;
    /** 是否本 profile 自身存有该条目的值差异（base 看 fields；delta 看自身 changes），可清除。 */
    clearable?: boolean;
    /** 是否允许编辑内容：仅普通 prompt（非 system_prompt / marker）可编辑。 */
    editable?: boolean;
}

/** 单张卡片的视图模型,喂给 cards.html 模板。 */
export interface PresetCardModel {
    name: string;
    index: number;
    isActive: boolean;
    temperature: string;
    topP: string;
    topK: string;
    contextTokens: number;
    maxTokens: number;
    streaming: boolean;
    sourceAndModel: string;
    logoPath: string;
    description: string;
    bgImage: string;
    modelChips: ModelChip[];
    profiles: PresetProfile[];
}

function truncate(str: string, max: number): string {
    if (!str) return '';
    return str.length > max ? '…' + str.slice(-(max - 1)) : str;
}

/**
 * Build the template-friendly preset list.
 */
export function buildPresetList(): PresetCardModel[] {
    const currentPresetName = oai_settings.preset_settings_openai;
    const presets: PresetCardModel[] = [];

    for (const [name, index] of Object.entries(openai_setting_names)) {
        const preset = openai_settings[index] as Preset | undefined;
        if (!preset) continue;

        const source = String(preset['chat_completion_source'] ?? '');
        const sourceLabel = SOURCE_LABELS[source] || '';
        const modelKey = MODEL_KEYS[source] || '';
        const modelName = modelKey ? truncate(String(preset[modelKey] ?? ''), 40) : '';

        // Source + model combined line
        let sourceAndModel = sourceLabel;
        if (modelName) sourceAndModel += ' · ' + modelName;

        // Logo: use source logo if available
        const logoPath = SOURCE_LOGO_MAP[source] || '';

        // Read custom metadata
        const meta = readMeta(preset);

        // Decorate each profile row with a type indicator so cards.html can render
        // [Base] / [Delta] badges, the derive button, and expandable entry list.
        const promptNames = new Map<string, string>();
        const promptLookup = new Map<string, any>();
        if (Array.isArray(preset.prompts)) {
            for (const p of preset.prompts) {
                if (p && typeof p.identifier === 'string' && p.identifier) {
                    promptLookup.set(p.identifier, p);
                    if (typeof p.name === 'string') {
                        promptNames.set(p.identifier, p.name);
                    }
                }
            }
        }

        type ProfileRow = PresetProfile & { isBase: boolean; isDelta: boolean; isV1: boolean; parentName: string; entries: ProfileEntryView[] };
        const profiles: PresetProfile[] = (Array.isArray(meta.profiles) ? meta.profiles : []).map((p) => {
            let entries: ProfileEntryView[] = [];
            let parentName = '';
            if (isPromptBaseProfile(p) || isPromptDeltaProfile(p)) {
                if (isPromptDeltaProfile(p)) {
                    const parent = (Array.isArray(meta.profiles) ? meta.profiles : [])
                        .find((b) => b.id === p.baseId);
                    if (parent) parentName = parent.name;
                }
                // 展示 = 递归解析 parent 链的完整开关 + 值字段（base 与 delta 统一走 resolveProfilePrompts）
                const resolved = resolveProfilePrompts(p, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
                entries = resolved.map((e) => {
                    const prompt = promptLookup.get(e.identifier);
                    const hasFields = !!e.fields && Object.keys(e.fields).length > 0;
                    return {
                        identifier: e.identifier,
                        name: e.fields?.name ?? promptNames.get(e.identifier) ?? e.identifier,
                        enabled: e.enabled,
                        hasFields,
                        // base 的 fields 即自身值变更；delta 需自身 changes 里有 fields（父链继承的不可由本 profile 清除）
                        clearable: isPromptDeltaProfile(p)
                            ? p.changes.some((c) => c.identifier === e.identifier && c.fields && Object.keys(c.fields).length > 0)
                            : hasFields,
                        // system_prompt / marker 条目不渲染编辑入口；预设中缺失的条目也无法编辑
                        editable: !!prompt && !prompt.system_prompt && !prompt.marker,
                    };
                });
            }
            const row: ProfileRow = {
                ...p,
                isBase: isPromptBaseProfile(p),
                isDelta: isPromptDeltaProfile(p),
                isV1: !isPromptBaseProfile(p) && !isPromptDeltaProfile(p),
                parentName,
                entries,
            };
            return row;
        });

        // Build model chips from metadata
        const modelChips = meta.models.map(mid => {
            const def = AVAILABLE_MODELS.find(m => m.id === mid);
            return def ? { label: def.label, logo: LOGO_BASE + def.logo } : { label: mid, logo: '' };
        });

        presets.push({
            name,
            index,
            isActive: name === currentPresetName,
            temperature: preset['temperature'] != null ? String(preset['temperature']) : '',
            topP: preset['top_p'] != null ? String(preset['top_p']) : '',
            topK: preset['top_k'] != null ? String(preset['top_k']) : '',
            contextTokens: Number(preset['openai_max_context'] || 0),
            maxTokens: Number(preset['openai_max_tokens'] || 0),
            streaming: !!preset['stream_openai'],
            sourceAndModel,
            logoPath,
            description: meta.description,
            bgImage: meta.bgImage,
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

export function getCardsTemplateContext() {
    return {
        presets: buildPresetList(),
        i18n: {
            searchPlaceholder: L('Search presets...'),
            multiSelect: L('Multi-Select'),
            batchDelete: L('Batch Delete'),
            importPreset: L('Import Preset'),
            conciseMode: L('Concise Mode'),
            clearCache: L('Clear Cache'),
            configurations: L('Configurations'),
            addBaseConfig: L('Save Base Profile'),
            loadConfig: L('Load configuration'),
            overwriteConfig: L('Overwrite with current settings'),
            exportConfig: L('Export configuration'),
            importConfig: L('Import configuration'),
            rename: L('Rename'),
            delete: L('Delete'),
            derive: L('Derive Profile'),
            resetProfile: L('Reset to parent'),
            derivedFrom: L('Derived from'),
            derived: L('Derived'),
            base: L('Base'),
            delta: L('Delta'),
            hasValueChanges: L('Has value changes'),
            noEntries: L('No entries'),
            toggleEntry: L('Toggle entry'),
            editPrompt: L('Edit prompt'),
            clearValueChange: L('Clear value changes'),
            saveChanges: L('Save changes'),
        }
    };
}
