// defaultSnapshot（隐藏默认基准）的生成、合并与应用。
// 纯数据操作 + ST openai 全局；不接触 dialog/DOM。

import { openai_settings, openai_setting_names } from '@sillytavern/scripts/openai';
import type { Preset, PresetMeta, PromptBaseProfile, PromptFields } from './meta.js';
import { readMeta, saveMeta } from './meta.js';
import type { PromptEditBuffer } from './presetBuffers.js';
import { bufferKey, bufferPrefix } from './presetBuffers.js';
import { buildPromptToggleSnapshot, findPromptInPreset, filterFields, promptFieldsEqual } from './promptToggle.js';

// Backfill a hidden default snapshot for presets that don't have one yet.
// Called once when the dialog opens, so "reset" always has a baseline.
export async function ensureDefaultSnapshots(): Promise<void> {
    for (const [name, index] of Object.entries(openai_setting_names)) {
        const preset = openai_settings[index] as Preset | undefined;
        if (!preset) continue;
        const meta = readMeta(preset);
        if (meta.defaultSnapshot && meta.defaultSnapshot.length > 0) continue;
        meta.defaultSnapshot = buildPromptToggleSnapshot(preset);
        await saveMeta(name, index as number, meta);
    }
}

// 把当前开关/值快照合并进主 profile（「保存→更新」与「覆盖」共用）：
// enabled 全量回写；fields 仅对本次会话编辑过且有净变化的条目写回，其余条目保留既有 fields，
// 避免重建快照时丢失此前已保存的值编辑。
export function mergeBaseSnapshot(profile: PromptBaseProfile, snapshot: { identifier: string; enabled: boolean; fields?: PromptFields }[], name: string, sessionEdits: Map<string, PromptEditBuffer>): void {
    const previousPrompts = profile.prompts;
    profile.prompts = snapshot.map((s) => {
        const entry: { identifier: string; enabled: boolean; fields?: PromptFields } = {
            identifier: s.identifier,
            enabled: s.enabled,
        };
        const session = sessionEdits.get(bufferKey(name, s.identifier));
        if (session && s.fields && !promptFieldsEqual(s.fields, session.initial)) {
            entry.fields = s.fields;
        } else if (!session) {
            const prior = previousPrompts.find((p) => p.identifier === s.identifier)?.fields;
            if (prior) entry.fields = prior;
        }
        return entry;
    });
}

// 把本次编辑过的条目的原始值字段惰性写入 defaultSnapshot（已存在则不覆盖）。
// 只在 base 保存路径调用：defaultSnapshot 可能尚不存在（首次打开才生成），此时跳过。
export function recordDefaultOriginalFields(meta: PresetMeta, name: string, sessionEdits: Map<string, PromptEditBuffer>): void {
    if (!Array.isArray(meta.defaultSnapshot)) return;
    const prefix = bufferPrefix(name);
    for (const [key, session] of sessionEdits) {
        if (!key.startsWith(prefix)) continue;
        const identifier = key.slice(prefix.length);
        const entry = meta.defaultSnapshot.find((d) => d.identifier === identifier);
        if (!entry || entry.originalFields) continue;
        entry.originalFields = { ...filterFields(session.initial) };
    }
}

// 把 defaultSnapshot 记录的原始值字段应用回 preset（reset 到默认时还原首次编辑前的值）。
export function applyDefaultOriginalFields(preset: Preset, meta: PresetMeta): void {
    if (!Array.isArray(meta.defaultSnapshot)) return;
    for (const d of meta.defaultSnapshot) {
        if (!d.originalFields) continue;
        const prompt = findPromptInPreset(preset, d.identifier);
        if (prompt) Object.assign(prompt, filterFields(d.originalFields));
    }
}
