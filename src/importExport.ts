import { POPUP_TYPE, callGenericPopup } from '@sillytavern/scripts/popup';
import { L } from './i18n.js';
import {
    getProfile,
    isPromptBaseProfile,
    isPromptDeltaProfile,
    newProfileId,
    type PresetMeta,
    type PresetProfile,
    type PromptBaseProfile,
    type PromptDeltaProfile,
} from './meta.js';
import { promptFieldsEqual, resolveProfileStates } from './promptToggle.js';

// Two-button choice popup: update current profile, or create a new subprofile (delta).
export function chooseProfileSaveTarget(): Promise<'update' | 'create' | null> {
    return chooseFromOptions(L('Save changes to'), [
        [L('Update current profile'), 'update'],
        [L('Create new subprofile'), 'create'],
    ]);
}

// 导出方式选择弹窗：单一导出 / 关系链导出 / 取消（完整预设导出直接用 ST 自带功能）
export function chooseProfileExportAction(): Promise<'profile' | 'tree' | null> {
    return chooseFromOptions(L('Export configuration'), [
        [L('Export'), 'profile'],
        [L('Export with branch chain'), 'tree'],
    ]);
}

// 通用选项弹窗：标题 + 若干操作按钮 + 取消，返回所选操作或 null
export async function chooseFromOptions<T extends string>(title: string, options: [label: string, value: T][]): Promise<T | null> {
    const container = $('<div class="preset_cards_save_choice"></div>');
    container.append($('<div class="preset_cards_save_choice_title"></div>').text(title));
    const buttons = $('<div class="preset_cards_save_choice_actions"></div>');
    for (const [label, value] of options) {
        buttons.append($('<button class="menu_button"></button>')
            .text(label)
            .on('click', function () { resolveChoice(value); }));
    }
    buttons.append($('<button class="menu_button"></button>')
        .text(L('Cancel'))
        .on('click', function () { resolveChoice(null); }));
    container.append(buttons);

    let resolver: (v: T | null) => void;
    const promise = new Promise<T | null>(r => { resolver = r; });

    function resolveChoice(v: T | null): void {
        $(container).closest('.popup').find('.popup-controls .menu_button').click();
        resolver(v);
    }

    // okButton: false 用 popup 内置的隐藏行为（TEXT 类型对 false 隐藏 OK 按钮），按钮仍在 DOM，
    // resolveChoice 里 .click() 仍能正常触发关闭
    callGenericPopup(container, POPUP_TYPE.TEXT, '', { okButton: false, cancelButton: '' });
    return promise;
}

// 单 profile 自包含导出（旧版格式）：base → prompt_base / delta → 附解析后父快照 / v1 → settings
export function buildProfileExportData(profile: PresetProfile, meta: PresetMeta): string {
    if (isPromptBaseProfile(profile)) {
        return JSON.stringify({
            kind: profile.kind,
            formatVersion: profile.formatVersion,
            prompts: profile.prompts,
        }, null, 4);
    }
    if (isPromptDeltaProfile(profile)) {
        // 导出自包含：附上解析后的完整 parent 状态快照，导入时可完整还原
        const parentStates = resolveProfileStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
        return JSON.stringify({
            kind: profile.kind,
            formatVersion: profile.formatVersion,
            baseId: profile.baseId,
            base: {
                name: 'Imported Parent',
                prompts: parentStates,
            },
            changes: profile.changes,
        }, null, 4);
    }
    return JSON.stringify(profile.settings, null, 4);
}

// 导出完整分支树 prompt_tree：收集全部 base/delta，按 root→leaf（DFS）排序，
// 保证每个 delta 的 baseId 祖先在其前，保留原始 id/baseId 以便导入还原。
// targetId 记录用户点击导出时的 profile 原始 id（仅行级导出提供；头部整树导出不提供）。
export function buildTreeExportData(meta: PresetMeta, targetId?: string): string {
    const profiles = meta.profiles.filter(p => isPromptBaseProfile(p) || isPromptDeltaProfile(p)) as (PromptBaseProfile | PromptDeltaProfile)[];
    const childrenByParent = new Map<string, PromptDeltaProfile[]>();
    for (const p of profiles) {
        if (isPromptDeltaProfile(p)) {
            const list = childrenByParent.get(p.baseId) ?? [];
            list.push(p);
            childrenByParent.set(p.baseId, list);
        }
    }
    const ordered: (PromptBaseProfile | PromptDeltaProfile)[] = [];
    const visited = new Set<string>();
    const visit = (p: PromptBaseProfile | PromptDeltaProfile): void => {
        if (visited.has(p.id)) return;
        if (isPromptDeltaProfile(p)) {
            const parent = getProfile(meta, p.baseId);
            if (parent && (isPromptBaseProfile(parent) || isPromptDeltaProfile(parent))) visit(parent);
        }
        visited.add(p.id);
        ordered.push(p);
        for (const child of childrenByParent.get(p.id) ?? []) visit(child);
    };
    for (const p of profiles) {
        if (isPromptBaseProfile(p)) visit(p);
    }
    // 孤立 delta（baseId 无对应 base/delta）：随 root 树之后收尾
    for (const p of profiles) {
        if (!visited.has(p.id)) visit(p);
    }
    const exported = ordered.map(p => isPromptBaseProfile(p)
        ? { kind: p.kind, id: p.id, name: p.name, prompts: p.prompts }
        : { kind: p.kind, id: p.id, name: p.name, baseId: p.baseId, changes: p.changes });
    const payload = { kind: 'prompt_tree' as const, formatVersion: 2, profiles: exported, ...(targetId ? { targetId } : {}) };
    return JSON.stringify(payload, null, 4);
}

// 防御性提示：v1 快照无父链、不参与整树导出；仅提醒，不改变导出内容
export function warnV1ExcludedFromTreeExport(meta: PresetMeta): void {
    if (meta.profiles.some((p) => !isPromptBaseProfile(p) && !isPromptDeltaProfile(p))) {
        toastr.warning(L('Legacy v1 profiles are not included in the tree export'));
    }
}

/**
 * 解析导入的 profile 数据，返回并入导入条目后的新 profiles 数组与警告消息（idMap 去重 / base 复用 / freshId）。
 * 无 UI / 持久化副作用：不做文件读取 / 弹窗 / 持久化，不改动入参 existing；warning 由调用方 toast。
 * 注：经 L() 读 localStorage、newProfileId 含时间戳/随机数，非引用透明。
 */
export function mergeImportedProfiles(
    parsed: Record<string, any>,
    existing: PresetProfile[],
    profileName: string,
): { profiles: PresetProfile[]; warnings: string[] } {
    const profiles = [...existing];
    const warnings: string[] = [];
    // 同一毫秒内生成多个 id 可能重复：对既有 id 及本批已生成 id 去重
    const usedIds = new Set(profiles.map((p) => p.id));
    const freshId = (): string => {
        let id = newProfileId();
        while (usedIds.has(id)) id = newProfileId();
        usedIds.add(id);
        return id;
    };
    const newId = freshId();

    if (parsed && parsed.kind === 'prompt_tree' && Array.isArray(parsed.profiles)) {
        // 完整分支链导入：oldId → 实际 id 映射（base 与 delta 都记录，保证嵌套 delta 的 baseId 可解析），按 root→leaf 顺序重建
        const idMap = new Map<string, string>();
        const targetId = typeof parsed.targetId === 'string' ? parsed.targetId : undefined;
        let unresolved = false;
        for (const entry of parsed.profiles) {
            if (!entry) continue;
            if (entry.kind === 'prompt_base' && Array.isArray(entry.prompts)) {
                // 内容完全相同的现有 base 复用（含 fields 白名单一致）；否则新建并保留导出名称
                const existing = profiles.find((b): b is PromptBaseProfile =>
                    isPromptBaseProfile(b) && b.name === (entry.name || profileName)
                    && b.prompts.length === entry.prompts.length
                    && b.prompts.every((e, i) => e.identifier === entry.prompts[i].identifier
                        && e.enabled === entry.prompts[i].enabled
                        && promptFieldsEqual(e.fields ?? {}, entry.prompts[i].fields ?? {})));
                if (existing) {
                    if (entry.id !== undefined) idMap.set(String(entry.id), existing.id);
                } else {
                    const baseNewId = freshId();
                    profiles.push({
                        formatVersion: 2,
                        kind: 'prompt_base',
                        id: baseNewId,
                        name: entry.name || profileName,
                        prompts: entry.prompts,
                    });
                    if (entry.id !== undefined) idMap.set(String(entry.id), baseNewId);
                }
            } else if (entry.kind === 'prompt_delta' && Array.isArray(entry.changes)) {
                // 目标 profile（原始 id 匹配 targetId）用弹窗输入名；无 targetId 时回退旧行为（DFS 末元素）；base 不消费弹窗名
                const isTarget = targetId !== undefined
                    ? entry.id !== undefined && String(entry.id) === targetId
                    : entry === parsed.profiles[parsed.profiles.length - 1];
                const rawBaseId = typeof entry.baseId === 'string' ? entry.baseId : '';
                const resolvedBaseId = rawBaseId ? idMap.get(rawBaseId) : undefined;
                if (rawBaseId && !resolvedBaseId) unresolved = true;
                const deltaNewId = freshId();
                if (entry.id !== undefined) idMap.set(String(entry.id), deltaNewId);
                profiles.push({
                    formatVersion: 2,
                    kind: 'prompt_delta',
                    id: deltaNewId,
                    name: isTarget ? profileName : (entry.name || profileName),
                    baseId: resolvedBaseId || rawBaseId,
                    changes: entry.changes,
                });
            }
        }
        if (unresolved) {
            warnings.push(L('Base profile not found for this imported derived configuration'));
        }
    } else if (parsed && parsed.kind === 'prompt_base' && Array.isArray(parsed.prompts)) {
        profiles.push({
            formatVersion: 2,
            kind: 'prompt_base',
            id: newId,
            name: profileName,
            prompts: parsed.prompts,
        });
    } else if (parsed && parsed.kind === 'prompt_delta' && Array.isArray(parsed.changes)) {
        // 若文件带 base 快照：先复用（内容相同）或新建 main，再挂 delta
        let baseId = '';
        const importedBase = parsed.base as { name?: string; prompts?: { identifier: string; enabled: boolean }[] } | undefined;
        if (importedBase && Array.isArray(importedBase.prompts)) {
            const existing = profiles.find((b): b is PromptBaseProfile =>
                isPromptBaseProfile(b) && b.name === (importedBase.name || profileName)
                && b.prompts.length === importedBase.prompts!.length
                && b.prompts.every((e, i) => e.identifier === importedBase.prompts![i].identifier && e.enabled === importedBase.prompts![i].enabled));
            if (existing) {
                baseId = existing.id;
            } else {
                const baseIdNew = freshId();
                profiles.push({
                    formatVersion: 2,
                    kind: 'prompt_base',
                    id: baseIdNew,
                    name: importedBase.name || profileName,
                    prompts: importedBase.prompts,
                });
                baseId = baseIdNew;
            }
        } else {
            baseId = typeof parsed.baseId === 'string' ? parsed.baseId : '';
        }

        profiles.push({
            formatVersion: 2,
            kind: 'prompt_delta',
            id: newId,
            name: profileName,
            baseId: baseId,
            changes: parsed.changes,
        });

        const baseExists = profiles.some(b => isPromptBaseProfile(b) && b.id === baseId);
        if (baseId && !baseExists) {
            warnings.push(L('Base profile not found for this imported derived configuration'));
        }
    } else {
        profiles.push({
            id: newId,
            name: profileName,
            settings: parsed
        });
    }

    return { profiles, warnings };
}
