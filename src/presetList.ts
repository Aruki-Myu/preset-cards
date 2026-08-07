import { oai_settings, openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { AVAILABLE_MODELS, LOGO_BASE, MODEL_KEYS, SOURCE_LABELS, SOURCE_LOGO_MAP } from './constants.js';
import { isPromptBaseProfile, isPromptDeltaProfile, readMeta, type Preset, type PresetProfile, type PromptBaseProfile, type PromptDeltaChange } from './meta.js';
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
        if (Array.isArray(preset.prompts)) {
            for (const p of preset.prompts) {
                if (p && typeof p.identifier === 'string' && p.identifier && typeof p.name === 'string') {
                    promptNames.set(p.identifier, p.name);
                }
            }
        }

        type ProfileRow = PresetProfile & { isBase: boolean; isDelta: boolean; isV1: boolean; entries: ProfileEntryView[] };
        const profiles: PresetProfile[] = (Array.isArray(meta.profiles) ? meta.profiles : []).map((p) => {
            let entries: ProfileEntryView[] = [];
            if (isPromptBaseProfile(p)) {
                entries = p.prompts.map((e) => ({
                    identifier: e.identifier,
                    name: promptNames.get(e.identifier) || e.identifier,
                    enabled: e.enabled,
                }));
            } else if (isPromptDeltaProfile(p)) {
                // 派生：展示 = 继承 base 的全部条目 + changes 叠加（enable 覆盖）
                const base = (Array.isArray(meta.profiles) ? meta.profiles : [])
                    .find((b): b is PromptBaseProfile => isPromptBaseProfile(b) && b.id === p.baseId);
                const baseMap = new Map<string, boolean>();
                if (base) {
                    for (const e of base.prompts) baseMap.set(e.identifier, e.enabled);
                }
                const changeMap = new Map<string, PromptDeltaChange>();
                for (const c of p.changes) changeMap.set(c.identifier, c);
                const ids = [...baseMap.keys()];
                for (const c of p.changes) if (!ids.includes(c.identifier)) ids.push(c.identifier);
                entries = ids.map((id) => {
                    const change = changeMap.get(id);
                    const enabled = change?.enabled !== undefined ? change.enabled : baseMap.get(id) ?? true;
                    return {
                        identifier: id,
                        name: promptNames.get(id) || id,
                        enabled,
                        hasFields: !!change?.fields && Object.keys(change.fields).length > 0,
                    };
                });
            }
            const row: ProfileRow = {
                ...p,
                isBase: isPromptBaseProfile(p),
                isDelta: isPromptDeltaProfile(p),
                isV1: !isPromptBaseProfile(p) && !isPromptDeltaProfile(p),
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
            base: L('Base'),
            delta: L('Delta'),
            hasValueChanges: L('Has value changes'),
            noEntries: L('No entries'),
            toggleEntry: L('Toggle entry'),
            saveChanges: L('Save changes'),
        }
    };
}
