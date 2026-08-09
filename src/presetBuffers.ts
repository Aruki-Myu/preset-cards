// 会话级编辑缓冲（sessionEdits / pendingToggles）的键管理与应用。
// 纯数据操作：不接触 dialog/DOM；缓冲 Map 由调用方传入。

import type { Preset, PromptFields } from './meta.js';
import { applyEntryState, findPromptInPreset, filterFields, mirrorFieldsToActivePreset } from './promptToggle.js';

/** 一次值编辑的缓冲：编辑前字段 + 编辑后字段（累积目标值）。 */
export interface PromptEditBuffer {
    initial: PromptFields;
    edited: PromptFields;
}

// 缓冲键统一为 `${name.length}:${name}:${identifier}`：ST 的 prompt identifier（如 "0-user"）在几乎所有预设同名，
// 若只以 identifier 为键会跨预设污染（A 卡未保存的编辑被 B 卡保存时静默写入）。
// 长度前缀分隔：预设名含 ':'（如 "A:B"）时 name+':' 前缀会误命中其他卡的缓冲，故以 name.length 定界。
export function bufferPrefix(name: string): string {
    return `${name.length}:${name}:`;
}

export function bufferKey(name: string, identifier: string): string {
    return `${bufferPrefix(name)}${identifier}`;
}

// 只清当前 name 的缓冲条目：其他卡未保存的编辑保留。
export function clearBufferedForName(name: string, sessionEdits: Map<string, PromptEditBuffer>, pendingToggles: Map<string, boolean>): void {
    const prefix = bufferPrefix(name);
    for (const key of [...sessionEdits.keys()]) {
        if (key.startsWith(prefix)) sessionEdits.delete(key);
    }
    for (const key of [...pendingToggles.keys()]) {
        if (key.startsWith(prefix)) pendingToggles.delete(key);
    }
}

// 当前 name 的会话编辑过的 identifier 集合（供 buildPromptSnapshot includeFields 使用）。
export function editedIdentifiersForName(name: string, sessionEdits: Map<string, PromptEditBuffer>): Set<string> {
    const prefix = bufferPrefix(name);
    const ids = new Set<string>();
    for (const key of sessionEdits.keys()) {
        if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
    return ids;
}

// 把本次会话的开关/值编辑缓冲统一应用到 preset 真实值（prompts + prompt_order）。
// 先应用开关（applyEntryState 内部同步 prompt_order），再写值字段并镜像到活动预设；
// 缺失条目跳过并收集返回，由调用方决定是否提示。
export function applyBufferedEdits(preset: Preset, name: string, sessionEdits: Map<string, PromptEditBuffer>, pendingToggles: Map<string, boolean>): string[] {
    const missing: string[] = [];
    const seen = new Set<string>();
    const prefix = bufferPrefix(name);
    for (const [key, enabled] of pendingToggles) {
        if (!key.startsWith(prefix)) continue;
        const identifier = key.slice(prefix.length);
        if (!applyEntryState(preset, identifier, enabled)) {
            seen.add(identifier);
            missing.push(identifier);
        }
    }
    for (const [key, session] of sessionEdits) {
        if (!key.startsWith(prefix)) continue;
        const identifier = key.slice(prefix.length);
        const prompt = findPromptInPreset(preset, identifier);
        if (!prompt) {
            if (!seen.has(identifier)) {
                seen.add(identifier);
                missing.push(identifier);
            }
            continue;
        }
        Object.assign(prompt, filterFields(session.edited));
        mirrorFieldsToActivePreset(name, identifier, session.edited);
    }
    return missing;
}
