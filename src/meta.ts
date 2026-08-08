import { getRequestHeaders } from '@sillytavern/script';
import { t } from '@sillytavern/scripts/i18n';
import { openai_settings, oai_settings } from '@sillytavern/scripts/openai';
import { EXTENSION_KEY } from './constants.js';

/** 预设对象的最小结构;其余字段是 ST 的任意设置,保持宽松。 */
export type Preset = Record<string, any> & {
    extensions?: Record<string, any>;
};

export interface PresetProfile {
    id: string;
    name: string;
    settings: Record<string, any>;
}

export interface PresetMeta {
    description: string;
    models: string[];
    profiles: PresetProfile[];
    bgImage: string;
}

/**
 * Read the preset_cards metadata from a preset object.
 */
export function readMeta(preset: Preset | undefined): PresetMeta {
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
 */
export async function saveMeta(presetName: string, presetIndex: number, meta: PresetMeta): Promise<void> {
    const preset = openai_settings[presetIndex] as Preset | undefined;
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
