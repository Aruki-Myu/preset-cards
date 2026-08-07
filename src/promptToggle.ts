import { isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import type { Preset, PromptBaseProfile, PromptDeltaChange, PromptDeltaProfile } from './meta.js';

/**
 * 单条开关应用到预设实际值：改 prompts[].enabled 并同步 prompt_order。
 * 返回是否匹配到该 identifier。
 */
export function applyEntryState(preset: Preset, identifier: string, enabled: boolean): boolean {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const prompt = prompts.find((p: any) => p && p.identifier === identifier);
    if (!prompt) return false;

    prompt.enabled = enabled;
    syncPromptOrder(preset, [{ identifier, enabled }]);
    return true;
}

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
 * 递归解析一个 profile 的完整开关状态：
 * - base：直接返回 prompts；
 * - delta：先解析 parent（base 或上层 delta），再叠加 changes（enabled 覆盖）。
 */
export function resolveProfileStates(
    profile: PromptBaseProfile | PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    seen: Set<string> = new Set(),
): { identifier: string; enabled: boolean }[] {
    if (!profile || seen.has(profile.id)) return []; // 防环
    seen.add(profile.id);

    if (isPromptBaseProfile(profile)) {
        return structuredClone(profile.prompts);
    }

    // 非 delta（如 v1 全量快照或未知类型）无父链可解析，安全返回空，绝不抛错
    if (!isPromptDeltaProfile(profile)) {
        return [];
    }

    const parent = allProfiles.find((p) => p.id === profile.baseId);
    const states = parent
        ? resolveProfileStates(parent, allProfiles, seen)
        : [];

    const map = new Map(states.map((s) => [s.identifier, s.enabled]));
    for (const change of profile.changes) {
        if (change.enabled !== undefined) {
            map.set(change.identifier, change.enabled);
        }
    }

    return [...map.entries()].map(([identifier, enabled]) => ({ identifier, enabled }));
}

/**
 * 解析 delta 的直接父 profile（按 baseId 查找，递归走完父链）的有效开关状态。
 * 父缺失或为 v1 快照（无法作为差异基线）时返回空数组。
 */
export function resolveParentStates(
    profile: PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
): { identifier: string; enabled: boolean }[] {
    const parent = allProfiles.find((p) => p.id === profile.baseId);
    if (!parent) return [];
    return resolveProfileStates(parent, allProfiles);
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
 * 从完整开关状态列表生成派生差异：与 parent 的开关状态逐条对比 enabled。
 * parent 可为 base 或上层 delta（用其解析后的完整状态）。
 * 保留传入的已有差异（fields），仅更新 enabled 不同的条目。
 */
export function statesToChanges(
    states: { identifier: string; enabled: boolean }[],
    parentStates: { identifier: string; enabled: boolean }[],
    previousChanges: PromptDeltaChange[] = [],
): PromptDeltaChange[] {
    const baseEnabled = new Map(parentStates.map((p) => [p.identifier, p.enabled]));
    const previousFields = new Map(
        previousChanges.filter((c) => c.fields).map((c) => [c.identifier, c.fields]),
    );

    const changes: PromptDeltaChange[] = [];
    for (const state of states) {
        const baseValue = baseEnabled.get(state.identifier);
        const enabledDiff = baseValue !== undefined && baseValue !== state.enabled;
        const fields = previousFields.get(state.identifier);
        if (enabledDiff || fields) {
            const change: PromptDeltaChange = { identifier: state.identifier };
            if (enabledDiff) change.enabled = state.enabled;
            if (fields) change.fields = fields;
            changes.push(change);
        }
    }

    return changes;
}
