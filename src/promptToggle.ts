import { promptManager } from '@sillytavern/scripts/openai';
import { isPromptBaseProfile, isPromptDeltaProfile } from './meta.js';
import type { Preset, PromptBaseProfile, PromptDeltaChange, PromptDeltaProfile, PromptFields } from './meta.js';

/** 允许写入预设的值字段白名单；capture/apply 只处理这些键（R10 白名单兜底）。 */
export const PROMPT_FIELD_WHITELIST: (keyof PromptFields)[] = [
    'content',
    'name',
    'role',
    'injection_position',
    'injection_depth',
    'injection_order',
];

/**
 * 采集单个 prompt 的值字段（仅白名单键，跳过 undefined）。
 * 纯读取，不修改 preset。
 */
export function capturePromptFields(prompt: Record<string, any> | undefined): PromptFields {
    const fields: PromptFields = {};
    if (!prompt) return fields;
    for (const key of PROMPT_FIELD_WHITELIST) {
        const value = prompt[key];
        if (value !== undefined) {
            fields[key] = value;
        }
    }
    return fields;
}

/** 只保留白名单键的值字段（R10：应用边界防御，丢弃导入/旧数据里的任意键）。 */
function filterFields(fields: Record<string, any> | undefined): PromptFields {
    const out: PromptFields = {};
    if (!fields) return out;
    for (const key of PROMPT_FIELD_WHITELIST) {
        if (fields[key] !== undefined) out[key] = fields[key];
    }
    return out;
}

/**
 * 按 identifier 回写值字段到 preset.prompts[]。
 * 不碰 prompt_order（值编辑不影响开关）。
 * 返回是否匹配到该 identifier。
 */
export function applyFieldsToPreset(preset: Preset, identifier: string, fields: PromptFields): boolean {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const prompt = prompts.find((p: any) => p && p.identifier === identifier);
    if (!prompt) return false;
    Object.assign(prompt, fields);
    return true;
}

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
 * 读取 prompt 的运行时真值：优先 prompt_order 中 global 条目（character_id === 100001）的 enabled，
 * 缺失时回退 prompts[].enabled，再缺失默认 true。
 * R5：修复默认预设常缺 prompts[].enabled 键、快照把全部 prompt 记成禁用的问题。
 * 只读，不改写入侧。
 */
function runtimeEnabledFor(prompt: { identifier: string; enabled?: boolean }, preset: Preset): boolean {
    const list = Array.isArray(preset.prompt_order)
        ? preset.prompt_order.find((x: any) => x && String(x.character_id) === '100001')
        : undefined;
    if (Array.isArray(list?.order)) {
        const order = list.order.find((o: any) => o && o.identifier === prompt.identifier);
        if (order && typeof order.enabled === 'boolean') {
            return order.enabled;
        }
    }
    return prompt.enabled ?? true;
}

/**
 * 采集预设全部 prompts 的开关清单（identifier + enabled）。
 * 只过滤掉无 identifier 的条目，纯操作 preset 对象，不碰 UI。
 */
export function buildPromptToggleSnapshot(preset: Preset): { identifier: string; enabled: boolean }[] {
    if (!Array.isArray(preset.prompts)) return [];
    return preset.prompts
        .filter((p: any) => p && typeof p.identifier === 'string' && p.identifier)
        .map((p: any) => ({ identifier: p.identifier, enabled: runtimeEnabledFor(p, preset) }));
}

/**
 * 按 identifier 回写 preset.prompts[].enabled 并同步 prompt_order；
 * 主 profile 若带 fields 则叠加值字段（仅 enabled 覆盖，值编辑不影响开关）。
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
        if (entry.fields) {
            Object.assign(prompt, filterFields(entry.fields));
        }
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
 * 递归解析一个 profile 的完整开关 + 值字段状态（含 fields）：
 * - base：直接返回 prompts（含 fields）；
 * - delta：先解析 parent（base 或上层 delta），再叠加 changes（enabled 覆盖 + fields 合并）。
 * 与 resolveProfileStates 共用递归 + seen 防环骨架，额外聚合 fields。
 */
export function resolveProfilePrompts(
    profile: PromptBaseProfile | PromptDeltaProfile,
    allProfiles: (PromptBaseProfile | PromptDeltaProfile)[],
    seen: Set<string> = new Set(),
): { identifier: string; enabled: boolean; fields?: PromptFields }[] {
    if (!profile || seen.has(profile.id)) return [];
    seen.add(profile.id);

    if (isPromptBaseProfile(profile)) {
        return structuredClone(profile.prompts);
    }

    // 非 delta（如 v1 全量快照或未知类型）无父链可解析，安全返回空，绝不抛错
    if (!isPromptDeltaProfile(profile)) {
        return [];
    }

    const parent = allProfiles.find((p) => p.id === profile.baseId);
    const entries = parent ? resolveProfilePrompts(parent, allProfiles, seen) : [];

    const map = new Map<string, { identifier: string; enabled: boolean; fields?: PromptFields }>();
    for (const entry of entries) {
        map.set(entry.identifier, {
            identifier: entry.identifier,
            enabled: entry.enabled,
            fields: entry.fields ? { ...entry.fields } : undefined,
        });
    }

    for (const change of profile.changes) {
        const existing = map.get(change.identifier);
        if (existing) {
            if (change.enabled !== undefined) {
                existing.enabled = change.enabled;
            }
            if (change.fields) {
                existing.fields = Object.assign({}, existing.fields, change.fields);
            }
        } else if (change.enabled !== undefined) {
            map.set(change.identifier, {
                identifier: change.identifier,
                enabled: change.enabled,
                fields: change.fields ? { ...change.fields } : undefined,
            });
        }
    }

    return [...map.values()];
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
            Object.assign(prompt, filterFields(change.fields));
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
 * 读取 prompt_order 的写入目标角色 id（策略感知）：
 * - global（默认）→ 100001（ST dummyId，作用于所有角色）；
 * - character → promptManager.activeCharacter.id（ST PromptManager.js:1130-1144 维护；
 *   新角色无 order 条目时 ST 会写默认顺序，按 100001 写的数据对该角色「看似消失」）。
 * promptManager 缺失 / 目标角色缺失时回退 100001，绝不抛错。
 */
export function resolvePromptOrderTarget(): number {
    const strategy = promptManager?.configuration?.promptOrder?.strategy;
    if (strategy === 'character') {
        return promptManager?.activeCharacter?.id ?? 100001;
    }
    return 100001;
}

/**
 * 同步 preset.prompt_order 中目标策略条目（global → 100001 / character → 活动角色 id）的开关。
 * 对应条目的 order 数组按 identifier 设置 enabled，不存在则 push；全程用 ?. 守卫防缺失。
 * Array.isArray 守卫兼容旧对象格式 {character_id: {order}}（否则 .find 会抛 TypeError）。
 */
export function syncPromptOrder(
    preset: Preset,
    entries: { identifier: string; enabled: boolean }[],
): void {
    if (!Array.isArray(preset.prompt_order)) return;
    const list = preset.prompt_order.find((x: any) => x && String(x.character_id) === String(resolvePromptOrderTarget()));
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
 * 在目标 prompt_order 条目的 .order 数组内按 identifier 移动位置（delta = -1 上移 / +1 下移）。
 * 只重排 .order，绝不动单条 enabled、绝不动 prompts[] 顺序。
 * 旧对象格式 / 缺目标条目 / 越界时安全返回 false。
 */
export function reorderPromptOrder(preset: Preset, identifier: string, delta: -1 | 1): boolean {
    if (!Array.isArray(preset.prompt_order)) return false;
    const list = preset.prompt_order.find((x: any) => x && String(x.character_id) === String(resolvePromptOrderTarget()));
    if (!list || !Array.isArray(list.order)) return false;
    const order = list.order as { identifier: string }[];

    const index = order.findIndex((o: any) => o && o.identifier === identifier);
    if (index === -1) return false;
    const newIndex = index + delta;
    if (newIndex < 0 || newIndex >= order.length) return false;

    const [moved] = order.splice(index, 1);
    order.splice(newIndex, 0, moved);
    return true;
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

/**
 * 采集预设全部 prompts 的开关 + 可选值字段快照。
 * 过滤逻辑与 buildPromptToggleSnapshot 共用；enabled 用 runtimeEnabledFor。
 * includeFields 含某 identifier 时附带 fields: capturePromptFields(prompt)。
 */
export function buildPromptSnapshot(
    preset: Preset,
    opts?: { includeFields?: Set<string> },
): { identifier: string; enabled: boolean; fields?: PromptFields }[] {
    if (!Array.isArray(preset.prompts)) return [];
    return preset.prompts
        .filter((p: any) => p && typeof p.identifier === 'string' && p.identifier)
        .map((p: any) => {
            const entry: { identifier: string; enabled: boolean; fields?: PromptFields } = {
                identifier: p.identifier,
                enabled: runtimeEnabledFor(p, preset),
            };
            if (opts?.includeFields?.has(p.identifier)) {
                entry.fields = capturePromptFields(p);
            }
            return entry;
        });
}

/**
 * 从快照生成派生差异（含值差异）：
 * - enabled：与 parent 解析后的完整状态逐条对比（同 statesToChanges 逻辑）；
 * - fields：逐条白名单字段，仅当快照值 ≠ 父链解析值才写入；等于父值 → 不写（即清除）；
 * - previousChanges.fields 对未编辑的 identifier 原样保留，已编辑的 identifier 重建（覆盖旧差异）。
 */
export function snapshotToChanges(
    snapshot: { identifier: string; enabled: boolean; fields?: PromptFields }[],
    parentEntries: { identifier: string; enabled: boolean; fields?: PromptFields }[],
    previousChanges: PromptDeltaChange[] = [],
): PromptDeltaChange[] {
    const baseEnabled = new Map(parentEntries.map((p) => [p.identifier, p.enabled]));
    const baseFields = new Map(parentEntries.map((p) => [p.identifier, p.fields]));
    const previousFields = new Map(
        previousChanges.filter((c) => c.fields).map((c) => [c.identifier, c.fields]),
    );

    const changes: PromptDeltaChange[] = [];
    for (const state of snapshot) {
        const baseValue = baseEnabled.get(state.identifier);
        const enabledDiff = baseValue !== undefined && baseValue !== state.enabled;

        const base = baseFields.get(state.identifier);
        let fieldDiff: PromptFields | undefined;
        if (state.fields) {
            const diff: Record<string, any> = {};
            let hasDiff = false;
            for (const key of PROMPT_FIELD_WHITELIST) {
                const snapValue = state.fields[key];
                const baseValueField = base?.[key];
                if (snapValue !== undefined && snapValue !== baseValueField) {
                    diff[key] = snapValue;
                    hasDiff = true;
                }
            }
            if (hasDiff) fieldDiff = diff;
        }
        const fields = state.fields !== undefined ? fieldDiff : previousFields.get(state.identifier);

        if (enabledDiff || fields) {
            const change: PromptDeltaChange = { identifier: state.identifier };
            if (enabledDiff) change.enabled = state.enabled;
            if (fields) change.fields = fields;
            changes.push(change);
        }
    }

    return changes;
}
