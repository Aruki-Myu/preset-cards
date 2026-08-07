import type { Preset, PromptBaseProfile, PromptDeltaChange, PromptDeltaProfile } from './meta.js';

/**
 * 采集预设全部 prompts 的开关清单（identifier + enabled）。
 * 只过滤掉无 identifier 的条目，纯操作 preset 对象，不碰 UI。
 */
export function buildPromptToggleSnapshot(preset: Preset): { identifier: string; enabled: boolean }[] {
    if (!Array.isArray(preset.prompts)) return [];
    return preset.prompts
        .filter((p: any) => p && typeof p.identifier === 'string' && p.identifier)
        .map((p: any) => ({ identifier: p.identifier, enabled: !!p.enabled }));
}

/**
 * 按 identifier 回写 preset.prompts[].enabled，并同步 prompt_order。
 * 主 profile 只记录开关，不覆盖任何值字段。
 */
export function applyBaseProfile(preset: Preset, profile: PromptBaseProfile): void {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const byIdentifier = new Map<string, any>(
        prompts.filter((p: any) => p && typeof p.identifier === 'string' && p.identifier).map((p: any) => [p.identifier, p]),
    );

    const orderEntries: { identifier: string; enabled: boolean }[] = [];
    for (const entry of profile.prompts) {
        const prompt = byIdentifier.get(entry.identifier);
        if (!prompt) continue;
        prompt.enabled = entry.enabled;
        orderEntries.push({ identifier: entry.identifier, enabled: entry.enabled });
    }

    if (orderEntries.length > 0) {
        syncPromptOrder(preset, orderEntries);
    }
}

/**
 * 应用派生 profile：先应用主 profile 的全部开关，再叠加差异（enabled 覆盖 + fields 合并），
 * 同步 prompt_order。返回匹配计数与缺失 identifier 列表。
 */
export function applyDeltaProfile(
    preset: Preset,
    delta: PromptDeltaProfile,
    base: PromptBaseProfile | undefined,
): { matched: number; missing: string[] } {
    if (base) {
        applyBaseProfile(preset, base);
    }

    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const byIdentifier = new Map<string, any>(
        prompts.filter((p: any) => p && typeof p.identifier === 'string' && p.identifier).map((p: any) => [p.identifier, p]),
    );

    const orderEntries: { identifier: string; enabled: boolean }[] = [];
    const missing: string[] = [];
    let matched = 0;

    for (const change of delta.changes) {
        const prompt = byIdentifier.get(change.identifier);
        if (!prompt) {
            missing.push(change.identifier);
            continue;
        }

        if (change.enabled !== undefined) {
            prompt.enabled = change.enabled;
        }
        if (change.fields) {
            Object.assign(prompt, change.fields);
        }

        orderEntries.push({ identifier: change.identifier, enabled: !!prompt.enabled });
        matched++;
    }

    if (orderEntries.length > 0) {
        syncPromptOrder(preset, orderEntries);
    }

    return { matched, missing };
}

/**
 * 同步 preset.prompt_order 中 global 策略条目（character_id === 100001）的开关。
 * 对应条目的 order 数组按 identifier 设置 enabled，不存在则 push；全程用 ?. 守卫防缺失。
 */
export function syncPromptOrder(
    preset: Preset,
    entries: { identifier: string; enabled: boolean }[],
): void {
    const list = preset.prompt_order?.find((x: any) => x && String(x.character_id) === '100001');
    if (!list?.order) return;

    for (const entry of entries) {
        const existing = list.order.find((o: any) => o?.identifier === entry.identifier);
        if (existing) {
            existing.enabled = entry.enabled;
        } else {
            list.order.push({ identifier: entry.identifier, enabled: entry.enabled });
        }
    }
}

/**
 * 重新基于主 profile 生成派生差异：对 base 条目逐 identifier 与当前预设比较。
 * - enabled 不同 → 记录 enabled；
 * - 对 base 条目上存在的值字段做浅层比较，不同 → 记录 fields。
 * 只记有差异的条目，覆盖旧 changes。
 */
export function buildDeltaChanges(preset: Preset, base: PromptBaseProfile): PromptDeltaChange[] {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const byIdentifier = new Map<string, any>(
        prompts.filter((p: any) => p && typeof p.identifier === 'string' && p.identifier).map((p: any) => [p.identifier, p]),
    );

    const changes: PromptDeltaChange[] = [];

    for (const rawEntry of base.prompts) {
        const baseEntry = rawEntry as Record<string, any>;
        const prompt = byIdentifier.get(baseEntry.identifier);
        if (!prompt) continue;

        const change: PromptDeltaChange = { identifier: baseEntry.identifier };

        if (prompt.enabled !== baseEntry.enabled) {
            change.enabled = !!prompt.enabled;
        }

        const fields: Record<string, any> = {};
        for (const key of Object.keys(baseEntry)) {
            if (key === 'identifier' || key === 'enabled') continue;
            if (!Object.is(baseEntry[key], prompt[key])) {
                fields[key] = prompt[key];
            }
        }
        if (Object.keys(fields).length > 0) {
            change.fields = fields;
        }

        if (change.enabled !== undefined || change.fields) {
            changes.push(change);
        }
    }

    return changes;
}
