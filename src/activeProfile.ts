import { oai_settings, openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import { EXTENSION_KEY } from './constants.js';

const STORAGE_KEY = 'preset_cards.active_profile';

export interface ActiveProfileRef {
    presetName: string;
    profileId: string;
}

let current: ActiveProfileRef | undefined;

export function initActiveProfile(): void {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as ActiveProfileRef;
            if (parsed && typeof parsed.presetName === 'string' && typeof parsed.profileId === 'string') {
                current = parsed;
                return;
            }
        }
    } catch {
        // 本地存储不可解析时走迁移
    }

    // 迁移：旧版本把 activeProfileId 存在各预设的 extensions 里，此处从当前活动预设播种一次
    try {
        const activeName = oai_settings?.preset_settings_openai;
        if (typeof activeName === 'string' && activeName) {
            const idx = openai_setting_names?.[activeName];
            const preset = idx !== undefined ? openai_settings[idx] as { extensions?: Record<string, any> } : undefined;
            const legacyId = preset?.extensions?.[EXTENSION_KEY]?.activeProfileId;
            if (typeof legacyId === 'string') {
                current = { presetName: activeName, profileId: legacyId };
                localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
            }
        }
    } catch {
        current = undefined;
    }
}

export function getActiveProfile(): ActiveProfileRef | undefined {
    return current;
}

export function setActiveProfile(ref: ActiveProfileRef | undefined): void {
    current = ref;
    try {
        if (ref) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(ref));
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        // localStorage 不可用时仅内存态生效
    }
}
