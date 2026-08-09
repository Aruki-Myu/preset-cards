// profile-editor 弹窗：pcmanager 式左右两栏的 prompt 级编辑界面。
// 弹窗内全部改动走会话缓冲（sessionEdits / pendingToggles），Commit 才统一落盘。
// 不触发 #update_oai_preset（R2），保存后由调用方 refreshActivePresetUI。

import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { oai_settings, openai_settings } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, Popup } from '@sillytavern/scripts/popup';
import { EXTENSION_NAME } from './constants.js';
import { L } from './i18n.js';
import {
    getProfile,
    isPromptBaseProfile,
    isPromptDeltaProfile,
    readMeta,
    saveMeta,
    type Preset,
    type PresetMeta,
    type PromptBaseProfile,
    type PromptDeltaChange,
    type PromptDeltaProfile,
    type PromptFields,
} from './meta.js';
import {
    PROMPT_FIELD_WHITELIST,
    buildPromptSnapshot,
    capturePromptFields,
    filterFields,
    findOrderList,
    findPromptInPreset,
    promptFieldsEqual,
    resolveParentStates,
    resolveProfilePrompts,
    resolvePromptOrderTarget,
    snapshotToChanges,
} from './promptToggle.js';
import {
    applyBufferedEdits,
    bufferKey,
    bufferPrefix,
    clearBufferedForName,
    editedIdentifiersForName,
    type PromptEditBuffer,
} from './presetBuffers.js';
import { mergeBaseSnapshot, recordDefaultOriginalFields } from './presetSnapshot.js';
import { buildDerivedProfile } from './profileActions.js';
import { chooseProfileSaveTarget } from './importExport.js';
import { buildProfileEntries, buildProfileOrderCtx, type ProfileEntryView, type ProfileOrderCtx } from './presetList.js';
import { buildPromptEditForm } from './editModal.js';

/** 弹窗依赖：缓冲 Map 与刷新回调由 presetCards 闭包注入。 */
export interface ProfileEditorDeps {
    sessionEdits: Map<string, PromptEditBuffer>;
    pendingToggles: Map<string, boolean>;
    refreshActivePresetUI: (presetName: string) => void;
    /** 保存后刷新卡片网格。 */
    onGridRefresh: () => Promise<void>;
}

/** 统一应用本会话的开关/值编辑缓冲并采集快照：缺失条目提示跳过。 */
export function applyBufferedAndSnapshot(
    preset: Preset,
    name: string,
    sessionEdits: Map<string, PromptEditBuffer>,
    pendingToggles: Map<string, boolean>,
): { identifier: string; enabled: boolean; fields?: PromptFields }[] {
    const missing = applyBufferedEdits(preset, name, sessionEdits, pendingToggles);
    if (missing.length > 0) {
        toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
    }
    return buildPromptSnapshot(preset, { includeFields: editedIdentifiersForName(name, sessionEdits) });
}

/** 「保存→更新」与「覆盖」共用的 base/delta 提交：按类型合并缓冲后的快照 → 持久化 → 成功提示。
 * missingParent 为 delta 父链缺失时的分歧路径：
 *   'full-changes'（保存→更新）：全量写成差异（含值字段）继续提交；
 *   'abort'（覆盖）：toast 提示并返回 false，调用方中止后续。
 * 仅处理 base/delta；成功时返回 true。 */
export async function commitBufferedEditsToProfile(
    profile: PromptBaseProfile | PromptDeltaProfile,
    snapshot: { identifier: string; enabled: boolean; fields?: PromptFields }[],
    meta: PresetMeta,
    name: string,
    idx: number,
    sessionEdits: Map<string, PromptEditBuffer>,
    missingParent: 'full-changes' | 'abort',
): Promise<boolean> {
    if (isPromptBaseProfile(profile)) {
        // enabled 全量合并；fields 仅对本次编辑的条目（与编辑初值无净变化时清除），
        // 其余条目保留既有 fields（见 mergeBaseSnapshot）
        mergeBaseSnapshot(profile, snapshot, name, sessionEdits);
        recordDefaultOriginalFields(meta, name, sessionEdits);
    } else {
        // 基线用父链解析状态（不含本 delta 自身 changes），否则未编辑的已存差异与基线相等而被 diff 掉
        const parentEntries = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
        if (parentEntries.length > 0) {
            profile.changes = snapshotToChanges(snapshot, parentEntries, profile.changes);
        } else if (missingParent === 'full-changes') {
            // 父链缺失：全量写成差异（含值字段）
            profile.changes = snapshot.map((s) => {
                const change: PromptDeltaChange = { identifier: s.identifier, enabled: s.enabled };
                if (s.fields) change.fields = s.fields;
                return change;
            });
        } else {
            toastr.warning(L('Base profile not found, cannot update derived configuration'));
            return false;
        }
        recordDefaultOriginalFields(meta, name, sessionEdits);
    }

    await saveMeta(name, idx, meta);
    toastr.success(L('Configuration updated'));
    return true;
}

/** 右栏 staged diff 的一条记录。 */
interface StagedFieldChange {
    label: string;
    from: string;
    to: string;
}

interface StagedItem {
    identifier: string;
    key: string;
    label: string;
    toggle?: { original: boolean; target: boolean };
    fields: StagedFieldChange[];
}

function fmtValue(v: unknown): string {
    return v === undefined || v === null ? '' : String(v);
}

function cssEscape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function openProfileEditorPopup(
    deps: ProfileEditorDeps,
    name: string,
    idx: number,
    profileId: string,
): Promise<void> {
    const { sessionEdits, pendingToggles } = deps;
    const prefix = bufferPrefix(name);

    let dialog: JQuery<HTMLElement> = $('<div id="preset_profile_editor" class="pc-manager-container"></div>');
    let searchQuery = '';
    let editTargetId: string | null = null;
    let mobileShowRight = false;
    let popup: Popup;

    // 读取当前预设/元数据/profile 解析后的展示条目（每次调用取最新内存态，clear 等直接改内存对象）
    const currentCtx = (): { preset: Preset; meta: PresetMeta; profile: PromptBaseProfile | PromptDeltaProfile; entries: ProfileEntryView[]; orderCtx: ProfileOrderCtx } | undefined => {
        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile || (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile))) return undefined;
        const isActive = oai_settings.preset_settings_openai === name;
        const orderCtx = buildProfileOrderCtx(preset, isActive);
        return { preset, meta, profile, entries: buildProfileEntries(profile, meta, preset, orderCtx), orderCtx };
    };

    const FIELD_LABELS: Record<string, string> = {
        content: L('Content'),
        name: L('Name'),
        role: L('Role'),
        injection_position: L('Position'),
        injection_depth: L('Injection Depth'),
    };

    // ---- Staged diff（当前未提交的缓冲改动：开关切换 / 值修改） ----
    function stagedItems(): StagedItem[] {
        const ctx = currentCtx();
        if (!ctx) return [];
        const nameById = new Map(ctx.entries.map((e) => [e.identifier, e.name]));
        const enabledById = new Map(ctx.entries.map((e) => [e.identifier, e.enabled]));

        const keys = new Set<string>();
        for (const k of pendingToggles.keys()) if (k.startsWith(prefix)) keys.add(k);
        for (const k of sessionEdits.keys()) if (k.startsWith(prefix)) keys.add(k);

        const items: StagedItem[] = [];
        for (const key of keys) {
            const identifier = key.slice(prefix.length);
            const item: StagedItem = { identifier, key, label: nameById.get(identifier) ?? identifier, fields: [] };
            const toggleTarget = pendingToggles.get(key);
            if (toggleTarget !== undefined) {
                item.toggle = { original: enabledById.get(identifier) ?? true, target: toggleTarget };
            }
            const session = sessionEdits.get(key);
            if (session) {
                for (const field of PROMPT_FIELD_WHITELIST) {
                    if (session.initial[field] !== session.edited[field]) {
                        item.fields.push({
                            label: FIELD_LABELS[field] ?? field,
                            from: fmtValue(session.initial[field]),
                            to: fmtValue(session.edited[field]),
                        });
                    }
                }
            }
            items.push(item);
        }
        items.sort((a, b) => a.identifier.localeCompare(b.identifier));
        return items;
    }

    // ---- 渲染 ----
    async function renderDialog(): Promise<void> {
        const ctx = currentCtx();
        if (!ctx) return;
        const items = stagedItems();
        const isDelta = isPromptDeltaProfile(ctx.profile);
        const parentName = isDelta
            ? (ctx.meta.profiles.find((p) => p.id === (ctx.profile as PromptDeltaProfile).baseId)?.name ?? '')
            : '';

        const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'profile-editor', {
            presetName: name,
            profileName: ctx.profile.name,
            isBase: isPromptBaseProfile(ctx.profile),
            isDelta,
            parentName,
            entries: ctx.entries,
            stagedCount: items.length,
            canCommit: items.length > 0,
            i18n: {
                base: L('Base'),
                delta: L('Delta'),
                derivedFrom: L('Derived from'),
                viewStaged: L('View Staged'),
                commit: L('Commit'),
                close: L('Close'),
                backToList: L('Back to list'),
                searchPrompts: L('Search prompts...'),
                dragHandle: L('Drag to reorder'),
                clearValueChange: L('Clear value changes'),
                toggleEntry: L('Toggle entry'),
                noEntries: L('No entries'),
                noSearchResults: L('No prompts found'),
            },
        });

        const newDialog = $(html);
        // 模板根节点是 #preset_profile_editor：取其子节点填入 dialog，保持 dialog 元素身份稳定
        //（delegated 事件绑定不丢，id/样式仍作用于 dialog 本身）
        const children = newDialog.children().toArray();
        dialog.empty().append(children);

        applyBufferOverlay();
        applySearch();
        renderRightPane();
        setupSortable();
        refreshCounts();
    }

    // 把缓冲状态叠加到已渲染的条目列表（开关目标 / 编辑后的名字 / dirty 高亮）
    function applyBufferOverlay(): void {
        dialog.find('.pc-prompt-card').each(function () {
            const entry = $(this);
            const identifier = String(entry.data('identifier'));
            const key = bufferKey(name, identifier);
            const toggleTarget = pendingToggles.get(key);
            const session = sessionEdits.get(key);

            const toggle = entry.find('.pc-btn-toggle');
            if (toggle.length && toggleTarget !== undefined) {
                toggle.toggleClass('on', toggleTarget).toggleClass('off', !toggleTarget);
                toggle.html(toggleTarget
                    ? '<i class="fa-solid fa-toggle-on"></i> On'
                    : '<i class="fa-solid fa-toggle-off"></i> Off');
                entry.toggleClass('disabled', !toggleTarget);
            }
            if (session?.edited.name !== undefined) {
                entry.find('.pc-card-name').text(session.edited.name).attr('title', identifier);
            }
            if (sessionEdits.has(key) || pendingToggles.has(key)) {
                entry.addClass('dirty');
            }
        });
    }

    function applySearch(): void {
        const ctx = currentCtx();
        const q = searchQuery.toLowerCase().trim();
        const contentById = new Map((ctx?.entries ?? []).map((e) => [e.identifier, (e.content ?? '').toLowerCase()]));
        let visible = 0;
        dialog.find('.pc-prompt-card').each(function () {
            const identifier = String($(this).data('identifier'));
            const name = $(this).find('.pc-card-name').text().toLowerCase();
            const match = !q || name.includes(q) || (contentById.get(identifier) ?? '').includes(q) || identifier.toLowerCase().includes(q);
            $(this).toggle(match);
            if (match) visible++;
        });
        dialog.find('#pc-prompt-empty-search').toggle(visible === 0 && q.length > 0);
    }

    function renderStagedPane(): void {
        const diffArea = dialog.find('#pc-diff-area');
        diffArea.empty();
        const items = stagedItems();
        if (items.length === 0) {
            diffArea.append($('<div class="pc-diff-empty"></div>').text(L('No staged changes')));
            return;
        }
        diffArea.append($('<h3 class="pc-diff-title"></h3>').text(L('Staged Changes')));
        const list = $('<ul class="pc-diff-list"></ul>');
        for (const item of items) {
            if (item.toggle) {
                list.append($('<li class="pc-diff-item diff-toggle"></li>')
                    .append($('<span class="pc-diff-desc"></span>').text(`${L('Switch')}: ${item.toggle.original ? L('On') : L('Off')} → ${item.toggle.target ? L('On') : L('Off')}`))
                    .append(buildUndoBtn(item.key, item.identifier)));
            }
            for (const f of item.fields) {
                list.append($('<li class="pc-diff-item diff-modify"></li>')
                    .append($('<span class="pc-diff-desc"></span>').text(`${item.label}: ${f.from || '∅'} → ${f.to || '∅'}`))
                    .append(buildUndoBtn(item.key, item.identifier)));
            }
        }
        diffArea.append(list);
    }

    function buildUndoBtn(key: string, identifier: string): JQuery<HTMLElement> {
        const undo = $('<button class="pc-btn-undo"></button>')
            .append($('<i class="fa-solid fa-rotate-left"></i>'))
            .append(' ' + L('Undo'));
        undo.on('click', () => undoStaged(key, identifier));
        return undo;
    }

    // 右栏路由：有编辑目标 → 内联编辑表单；否则 staged diff。
    // 手机端（≤768px）默认右栏隐藏，mobileShowRight 时加 .pc-show-right 让右栏全宽覆盖列表。
    function renderRightPane(): void {
        dialog.find('.pc-layout').toggleClass('pc-show-right', mobileShowRight);
        const diffArea = dialog.find('#pc-diff-area');
        const editArea = dialog.find('#pc-edit-area');
        if (editTargetId) {
            const ctx = currentCtx();
            const view = ctx?.entries.find((e) => e.identifier === editTargetId);
            if (ctx && view?.editable) {
                editArea.empty().append(buildInlineEdit(ctx.preset, editTargetId));
                editArea.show();
                diffArea.hide();
                return;
            }
            // 条目不可编辑（system_prompt / marker / 缺失）→ 回退 staged 视图
            editTargetId = null;
            mobileShowRight = false;
        }
        editArea.hide();
        diffArea.show();
        renderStagedPane();
    }

    // 内联编辑表单（PC 右栏 / 手机全宽覆盖）：复用 editModal 的表单构造，保存写会话缓冲
    function buildInlineEdit(preset: Preset, identifier: string): JQuery<HTMLElement> {
        const prompt = findPromptInPreset(preset, identifier);
        const wrap = $('<div class="pc-edit-form"></div>');
        if (!prompt) {
            wrap.append($('<div class="pc-diff-empty"></div>').text(L('No entries')));
            return wrap;
        }

        const header = $('<div class="pc-editor-header"></div>');
        header.append($('<h3></h3>').text(prompt.name ?? identifier));
        const actions = $('<div class="pc-editor-actions"></div>');

        const prevSession = sessionEdits.get(bufferKey(name, identifier));
        const current = prevSession ? { ...capturePromptFields(prompt), ...prevSession.edited } : undefined;
        const form = buildPromptEditForm(preset, identifier, current);

        const saveBtn = $('<button class="pc-btn-icon pc-btn-icon-primary" title="' + L('Save') + '"></button>')
            .append($('<i class="fa-solid fa-save"></i>'))
            .append(' ' + L('Save'));
        const cancelBtn = $('<button class="pc-btn-icon" title="' + L('Cancel') + '"></button>')
            .append($('<i class="fa-solid fa-times"></i>'))
            .append(' ' + L('Cancel'));

        saveBtn.on('click', () => {
            const editedFields = form.collectFields();
            if (editedFields) {
                const key = bufferKey(name, identifier);
                const session = sessionEdits.get(key);
                const initial = session?.initial ?? capturePromptFields(prompt);
                const edited = { ...(session?.edited ?? {}), ...filterFields(editedFields) };
                if (promptFieldsEqual(edited, initial)) {
                    sessionEdits.delete(key);
                } else {
                    sessionEdits.set(key, { initial, edited });
                }
            }
            editTargetId = null;
            mobileShowRight = false;
            refreshEntryRow(identifier);
            refreshCounts();
            renderRightPane();
        });
        cancelBtn.on('click', () => {
            editTargetId = null;
            mobileShowRight = false;
            renderRightPane();
        });

        actions.append(saveBtn).append(cancelBtn);
        header.append(actions);
        wrap.append(header);
        wrap.append(form.container);
        return wrap;
    }

    // 局部刷新单条 entry（名字/开关/dirty/clear 可见性）
    function refreshEntryRow(identifier: string): void {
        const row = dialog.find(`.pc-prompt-card[data-identifier="${cssEscape(identifier)}"]`);
        if (row.length === 0) return;
        const ctx = currentCtx();
        const view = ctx?.entries.find((e) => e.identifier === identifier);
        const key = bufferKey(name, identifier);
        const toggleTarget = pendingToggles.get(key);
        const session = sessionEdits.get(key);
        const enabled = toggleTarget ?? view?.enabled ?? true;
        const displayName = session?.edited.name ?? view?.name ?? identifier;

        row.find('.pc-card-name').text(displayName).attr('title', identifier);

        const toggle = row.find('.pc-btn-toggle');
        if (toggle.length) {
            toggle.toggleClass('on', enabled).toggleClass('off', !enabled);
            toggle.html(enabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off');
        }

        const clearBtn = row.find('.pc-card-clear');
        const shouldHaveClear = !!view?.clearable;
        if (shouldHaveClear && clearBtn.length === 0) {
            const btn = $('<button class="pc-card-clear" title="' + L('Clear value changes') + '"><i class="fa-solid fa-eraser"></i></button>');
            const toggleEl = row.find('.pc-btn-toggle');
            if (toggleEl.length) btn.insertBefore(toggleEl);
            else row.append(btn);
        } else if (!shouldHaveClear) {
            clearBtn.remove();
        }

        row.toggleClass('disabled', !enabled);
        row.toggleClass('dirty', sessionEdits.has(key) || pendingToggles.has(key));
        row.toggleClass('persistent', !!view?.hasPersistentDiff);
    }

    // Undo 某条缓冲：撤销 toggle 目标 + 还原值编辑（镜像 clear 的 full undo）
    function undoStaged(key: string, identifier: string): void {
        pendingToggles.delete(key);
        const session = sessionEdits.get(key);
        if (session) {
            sessionEdits.delete(key);
            const preset = openai_settings[idx] as Preset;
            const prompt = findPromptInPreset(preset, identifier);
            if (prompt) {
                for (const f of PROMPT_FIELD_WHITELIST) {
                    if (!(f in session.initial)) delete prompt[f];
                }
                Object.assign(prompt, session.initial);
            }
            if (oai_settings.preset_settings_openai === name) {
                const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
                const livePrompt = livePrompts.find((p: any) => p && p.identifier === identifier);
                if (livePrompt) {
                    for (const f of PROMPT_FIELD_WHITELIST) {
                        if (!(f in session.initial)) delete livePrompt[f];
                    }
                    Object.assign(livePrompt, filterFields(session.initial));
                }
            }
        }
        refreshEntryRow(identifier);
        refreshCounts();
        renderRightPane();
    }

    // 拖拽排序：仅活动预设可拖；拖拽后立即落盘（不进 diff）
    function setupSortable(): void {
        const listEl = dialog.find('.pc-prompt-list');
        if (!listEl.length) return;
        if (listEl.data('ui-sortable')) listEl.sortable('destroy');
        const isActive = oai_settings.preset_settings_openai === name;
        if (!isActive || searchQuery) return;
        listEl.sortable({
            axis: 'y',
            handle: '.pc-drag-handle',
            items: '.pc-prompt-card',
            placeholder: 'pc-sortable-placeholder',
            start: () => listEl.addClass('sorting'),
            stop: () => listEl.removeClass('sorting'),
            update: () => { void onReorder(listEl); },
        });
    }

    async function onReorder(listEl: JQuery<HTMLElement>): Promise<void> {
        const preset = openai_settings[idx] as Preset;
        const orderList = findOrderList(preset, resolvePromptOrderTarget());
        if (!orderList || !Array.isArray(orderList.order)) return;

        const domIds = listEl.find('.pc-prompt-card').map(function () {
            return String($(this).data('identifier'));
        }).get();
        const order = orderList.order as { identifier: string }[];
        const inDom = new Set(domIds);
        const newOrder = [
            ...domIds.map((id) => order.find((o) => o.identifier === id)).filter((o): o is { identifier: string } => !!o),
            ...order.filter((o) => !inDom.has(o.identifier)),
        ];
        if (newOrder.length === order.length && newOrder.every((o, i) => o.identifier === order[i].identifier)) return;

        orderList.order = newOrder;
        await saveMeta(name, idx, readMeta(preset));
        deps.refreshActivePresetUI(name);
    }

    function refreshCounts(): void {
        const n = stagedItems().length;
        dialog.find('#pc-btn-view-staged span').text(`(${n})`);
        const commitBtn = dialog.find('#pc-btn-commit');
        commitBtn.prop('disabled', n === 0);
        commitBtn.toggleClass('disabled', n === 0);
    }

    // ---- 事件（delegated，重渲染 innerHTML 后仍然有效） ----
    dialog.on('click', '.pc-prompt-card', function (e) {
        if ($(e.target).closest('.pc-drag-handle, .pc-card-clear, .pc-btn-toggle, button').length) return;
        const identifier = String($(this).data('identifier'));
        const ctx = currentCtx();
        const view = ctx?.entries.find((x) => x.identifier === identifier);
        if (!view?.editable) return; // system_prompt / marker 不渲染编辑
        editTargetId = identifier;
        mobileShowRight = true;
        renderRightPane();
    });

    dialog.on('click', '.pc-btn-toggle', function (e) {
        e.stopPropagation();
        const toggle = $(this);
        const entry = toggle.closest('.pc-prompt-card');
        const identifier = String(entry.data('identifier'));
        const key = bufferKey(name, identifier);
        const on = toggle.hasClass('on');
        const target = !on;

        // 净零参照 = 目标 profile 解析链下的 enabled：目标等于解析值 → 删缓冲，否则记录
        const ctx = currentCtx();
        let resolvedEnabled: boolean | undefined;
        if (ctx) {
            const resolved = resolveProfilePrompts(ctx.profile, ctx.meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], new Set());
            resolvedEnabled = resolved.find((x) => x.identifier === identifier)?.enabled;
        }
        if (resolvedEnabled === target) {
            pendingToggles.delete(key);
        } else {
            pendingToggles.set(key, target);
        }

        refreshEntryRow(identifier);
        refreshCounts();
        renderRightPane();
    });

    dialog.on('click', '.pc-card-clear', function (e) {
        e.stopPropagation();
        const entry = $(this).closest('.pc-prompt-card');
        const identifier = String(entry.data('identifier'));
        const key = bufferKey(name, identifier);
        const ctx = currentCtx();
        if (!ctx) return;
        const preset = openai_settings[idx] as Preset;

        if (isPromptBaseProfile(ctx.profile)) {
            const item = ctx.profile.prompts.find((p) => p.identifier === identifier);
            if (item) delete item.fields;
        } else if (isPromptDeltaProfile(ctx.profile)) {
            const change = ctx.profile.changes.find((c) => c.identifier === identifier);
            if (change) delete change.fields;
        } else {
            return;
        }

        // 撤销会话值缓冲（full undo）：还原运行时至会话初始值并镜像活动预设
        const session = sessionEdits.get(key);
        if (session) {
            sessionEdits.delete(key);
            const prompt = findPromptInPreset(preset, identifier);
            if (prompt) {
                for (const f of PROMPT_FIELD_WHITELIST) {
                    if (!(f in session.initial)) delete prompt[f];
                }
                Object.assign(prompt, session.initial);
            }
            if (oai_settings.preset_settings_openai === name) {
                const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
                const livePrompt = livePrompts.find((p: any) => p && p.identifier === identifier);
                if (livePrompt) {
                    for (const f of PROMPT_FIELD_WHITELIST) {
                        if (!(f in session.initial)) delete livePrompt[f];
                    }
                    Object.assign(livePrompt, filterFields(session.initial));
                }
            }
        }

        renderRightPane();
        refreshEntryRow(identifier);
        refreshCounts();
    });

    dialog.on('click', '#pc-btn-view-staged', function () {
        editTargetId = null;
        mobileShowRight = true;
        renderRightPane();
    });

    // 手机端「返回列表」
    dialog.on('click', '#pc-btn-mobile-back', function () {
        editTargetId = null;
        mobileShowRight = false;
        renderRightPane();
    });

    dialog.on('click', '#pc-btn-commit', async function () {
        const ctx = currentCtx();
        if (!ctx) return;
        if (stagedItems().length === 0) return;

        const choice = await chooseProfileSaveTarget();
        if (!choice) return;

        const preset = openai_settings[idx] as Preset;
        const snapshot = applyBufferedAndSnapshot(preset, name, sessionEdits, pendingToggles);

        if (choice === 'update') {
            if (!isPromptBaseProfile(ctx.profile) && !isPromptDeltaProfile(ctx.profile)) {
                toastr.warning(L('This profile type cannot be edited with switches'));
                return;
            }
            const ok = await commitBufferedEditsToProfile(ctx.profile, snapshot, ctx.meta, name, idx, sessionEdits, 'full-changes');
            if (!ok) return;
        } else {
            if (!isPromptBaseProfile(ctx.profile) && !isPromptDeltaProfile(ctx.profile)) {
                toastr.warning(L('This profile type cannot be derived'));
                return;
            }
            const deltaName = await Popup.show.input(L('Derived profile name:'), '');
            if (!deltaName) return;

            const profiles = Array.isArray(ctx.meta.profiles) ? ctx.meta.profiles : [];
            const parentEntries = resolveProfilePrompts(ctx.profile, ctx.meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], new Set());
            const changes = snapshotToChanges(snapshot, parentEntries, isPromptDeltaProfile(ctx.profile) ? ctx.profile.changes : []);
            profiles.push(buildDerivedProfile(ctx.profile, deltaName, changes));
            ctx.meta.profiles = profiles;
            recordDefaultOriginalFields(ctx.meta, name, sessionEdits);
            await saveMeta(name, idx, ctx.meta);
            toastr.success(L('Derived profile created'));
        }

        deps.refreshActivePresetUI(name);

        // 本批编辑已消费，清空当前 name 的记录（其他卡的缓冲保留）
        clearBufferedForName(name, sessionEdits, pendingToggles);
        editTargetId = null;
        mobileShowRight = false;

        // 重渲染弹窗（diff 清空）+ 刷新卡片网格
        await renderDialog();
        await deps.onGridRefresh();
    });

    dialog.on('click', '#pc-btn-close', function () {
        popup.completeCancelled();
    });

    dialog.on('input', '#pc-search-input', function () {
        searchQuery = String($(this).val() ?? '');
        applySearch();
        setupSortable(); // 搜索中禁用拖拽
    });

    // ---- 打开弹窗 ----
    await renderDialog();

    popup = new Popup(dialog, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        transparent: true,
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    await popup.show();

    // 关闭时有未提交改动 → 提示（缓冲保留，可再打开弹窗继续）
    if (stagedItems().length > 0) {
        toastr.info(L('You have uncommitted changes'));
    }
}
