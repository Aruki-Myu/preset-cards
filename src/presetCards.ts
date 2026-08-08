import { getRequestHeaders } from '@sillytavern/script';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { oai_settings, openai_settings, openai_setting_names, promptManager, settingsToUpdate } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup, Popup } from '@sillytavern/scripts/popup';
import { t } from '@sillytavern/scripts/i18n';
import { download } from '@sillytavern/scripts/utils';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { AVAILABLE_MODELS, EXTENSION_NAME, LOGO_BASE } from './constants.js';
import { L } from './i18n.js';
import {
    isPromptBaseProfile,
    isPromptDeltaProfile,
    getProfile,
    newProfileId,
    readMeta,
    saveMeta,
    type Preset,
    type PromptBaseProfile,
    type PromptDeltaChange,
    type PromptDeltaProfile,
    type PromptFields,
    type PresetMeta,
} from './meta.js';
import {
    PROMPT_FIELD_WHITELIST,
    applyBaseProfile,
    applyEntryState,
    applyProfileToPreset,
    buildPromptSnapshot,
    buildPromptToggleSnapshot,
    capturePromptFields,
    filterFields,
    findPromptInPreset,
    mirrorFieldsToActivePreset,
    promptFieldsEqual,
    resolveParentStates,
    resolveProfilePrompts,
    reorderPromptOrder,
    snapshotToChanges,
} from './promptToggle.js';
import {
    buildProfileExportData,
    buildTreeExportData,
    chooseFromOptions,
    chooseProfileExportAction,
    chooseProfileSaveTarget,
    mergeImportedProfiles,
    warnV1ExcludedFromTreeExport,
} from './importExport.js';
import { buildPresetList, getCardsTemplateContext } from './presetList.js';
import { applyCachedBackgrounds, clearImageCache } from './cache.js';
import { openEditModal, openPromptEditPopup } from './editModal.js';

export async function openPresetCards(): Promise<void> {
    // Backfill hidden default snapshots before rendering so reset always has a baseline
    await ensureDefaultSnapshots();

    let presets = buildPresetList();

    let isBatchMode = false;
    const batchSelectedCards = new Set<string>();
    let isConciseMode = localStorage.getItem('preset_cards_concise') === 'true';

    // 本次打开期间的值编辑记录：identifier → { 编辑前字段, 编辑后字段（累积目标值） }
    const sessionEdits = new Map<string, { initial: PromptFields; edited: PromptFields }>();

    // 本次打开期间的开关切换缓冲：identifier → 本次会话目标 enabled，仅记录被切换过的条目
    const pendingToggles = new Map<string, boolean>();

    // 缓冲键统一为 `${name.length}:${name}:${identifier}`：ST 的 prompt identifier（如 "0-user"）在几乎所有预设同名，
    // 若只以 identifier 为键会跨预设污染（A 卡未保存的编辑被 B 卡保存时静默写入）。
    // 长度前缀分隔：预设名含 ':'（如 "A:B"）时 name+':' 前缀会误命中其他卡的缓冲，故以 name.length 定界。
    function bufferPrefix(name: string): string {
        return `${name.length}:${name}:`;
    }
    function bufferKey(name: string, identifier: string): string {
        return `${bufferPrefix(name)}${identifier}`;
    }

    // 只清当前 name 的缓冲条目：其他卡未保存的编辑保留。
    function clearBufferedForName(name: string): void {
        const prefix = bufferPrefix(name);
        for (const key of [...sessionEdits.keys()]) {
            if (key.startsWith(prefix)) sessionEdits.delete(key);
        }
        for (const key of [...pendingToggles.keys()]) {
            if (key.startsWith(prefix)) pendingToggles.delete(key);
        }
    }

    // 当前 name 的会话编辑过的 identifier 集合（供 buildPromptSnapshot includeFields 使用）。
    function editedIdentifiersForName(name: string): Set<string> {
        const prefix = bufferPrefix(name);
        const ids = new Set<string>();
        for (const key of sessionEdits.keys()) {
            if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
        }
        return ids;
    }

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
    const dialog = $(html);

    if (isConciseMode) {
        dialog.addClass('preset_cards_concise_mode');
        dialog.find('#preset_cards_concise_btn').addClass('active');
    }

    // ---- Helpers ----
    function updateCount(visible: number, total: number): void {
        const el = dialog.find('#preset_cards_count');
        el.text(visible === total ? `${total} presets` : `${visible} / ${total}`);
    }

    // If the preset is currently active, reload it natively and refresh the Prompt Manager list.
    // promptManager may be absent in some ST builds, hence the optional chain.
    function refreshActivePresetUI(presetName: string): void {
        if (oai_settings.preset_settings_openai === presetName) {
            $('#settings_preset_openai').trigger('change');
            promptManager?.render?.(false);
        }
    }

    // 顺序移动后本地刷新上移/下移按钮的边界禁用态
    function updateEntryMoveButtons(el: JQuery<HTMLElement>): void {
        el.find('.preset_card_profile_entry_move_up')
            .toggleClass('disabled', el.prev('.preset_card_profile_entry').length === 0);
        el.find('.preset_card_profile_entry_move_down')
            .toggleClass('disabled', el.next('.preset_card_profile_entry').length === 0);
    }

    // Backfill a hidden default snapshot for presets that don't have one yet.
    // Called once when the dialog opens, so "reset" always has a baseline.
    async function ensureDefaultSnapshots(): Promise<void> {
        for (const [name, index] of Object.entries(openai_setting_names)) {
            const preset = openai_settings[index] as Preset | undefined;
            if (!preset) continue;
            const meta = readMeta(preset);
            if (meta.defaultSnapshot && meta.defaultSnapshot.length > 0) continue;
            meta.defaultSnapshot = buildPromptToggleSnapshot(preset);
            await saveMeta(name, index as number, meta);
        }
    }

    // 重渲染后按当前缓冲恢复 dirty 高亮：保存/加载 profile/reset 已清缓冲，自然不恢复；
    // 未清缓冲的路径（如「保存 base profile」后继续编辑）则按 bufferKey 逐条还原。
    function applyDirtyHighlights(): void {
        dialog.find('.preset_card_profile_entry').each(function () {
            const entry = $(this);
            const name = entry.closest('.preset_card').attr('data-preset-name') as string;
            const identifier = String(entry.data('identifier'));
            const key = bufferKey(name, identifier);
            if (sessionEdits.has(key) || pendingToggles.has(key)) {
                entry.addClass('dirty');
            }
        });
    }

    // 该行是否仍有未保存的净变化缓冲条目（toggle 目标或值编辑，net-zero 键已在 handler 中删除）。
    // 另含非缓冲待保存改动：clear 直接删 profile 持久 fields，以行级 has-pending-clear 标记记录，
    // 由本函数纳入判定，防止后续净零 toggle/edit 把保存按钮误藏、pending clear 静默丢失（#2）。
    function rowHasBufferedChanges(row: JQuery<HTMLElement>): boolean {
        if (row.data('has-pending-clear')) return true;
        const name = row.closest('.preset_card').attr('data-preset-name') as string;
        return row.find('.preset_card_profile_entry').toArray().some((el) => {
            const key = bufferKey(name, String($(el).data('identifier')));
            if (pendingToggles.has(key)) return true;
            const session = sessionEdits.get(key);
            return !!session && !promptFieldsEqual(session.edited, session.initial);
        });
    }

    // toggle/edit/clear 后统一刷新行的 modified 标记与保存按钮显隐（无净变化缓冲则收起）。
    // clear 直接删 profile 持久 fields 属非缓冲待保存改动：以行级 has-pending-clear 标记保留保存按钮，
    // 由 rowHasBufferedChanges 纳入判定；保存/重渲染重建行后标记清除。
    function syncRowModified(row: JQuery<HTMLElement>): void {
        if (rowHasBufferedChanges(row)) {
            row.addClass('modified');
            row.find('.preset_card_profile_save_btn').removeClass('hidden');
        } else {
            row.removeClass('modified');
            row.find('.preset_card_profile_save_btn').addClass('hidden');
        }
    }

    // 整卡列表重渲染并触发搜索过滤；applyBackgrounds 时重新应用背景图
    async function refreshGrid(opts?: { applyBackgrounds?: boolean }): Promise<void> {
        const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
        dialog.html($(newHtml).html());
        applyDirtyHighlights();
        if (opts?.applyBackgrounds) applyCachedBackgrounds(dialog);
        dialog.find('#preset_cards_search').trigger('input');
    }

    // 把当前开关/值快照合并进主 profile（「保存→更新」与「覆盖」共用）：
    // enabled 全量回写；fields 仅对本次会话编辑过且有净变化的条目写回，其余条目保留既有 fields，
    // 避免重建快照时丢失此前已保存的值编辑。
    function mergeBaseSnapshot(profile: PromptBaseProfile, snapshot: { identifier: string; enabled: boolean; fields?: PromptFields }[], name: string): void {
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

    // 把本次会话的开关/值编辑缓冲统一应用到 preset 真实值（prompts + prompt_order）。
    // 先应用开关（applyEntryState 内部同步 prompt_order），再写值字段并镜像到活动预设；
    // 缺失条目跳过并收集返回，由调用方决定是否提示。
    function applyBufferedEdits(preset: Preset, name: string): string[] {
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

    // 把本次编辑过的条目的原始值字段惰性写入 defaultSnapshot（已存在则不覆盖）。
    // 只在 base 保存路径调用：defaultSnapshot 可能尚不存在（首次打开才生成），此时跳过。
    function recordDefaultOriginalFields(meta: PresetMeta, name: string): void {
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
    function applyDefaultOriginalFields(preset: Preset, meta: PresetMeta): void {
        if (!Array.isArray(meta.defaultSnapshot)) return;
        for (const d of meta.defaultSnapshot) {
            if (!d.originalFields) continue;
            const prompt = findPromptInPreset(preset, d.identifier);
            if (prompt) Object.assign(prompt, filterFields(d.originalFields));
        }
    }

    // ---- Search ----
    dialog.on('input', '#preset_cards_search', function () {
        const q = String($(this).val()).toLowerCase().trim();
        let vis = 0;
        dialog.find('.preset_card').each(function () {
            const name = String($(this).data('preset-name')).toLowerCase();
            const desc = $(this).find('.preset_card_desc').text().toLowerCase();
            const match = !q || name.includes(q) || desc.includes(q);
            $(this).toggle(match);
            if (match) vis++;
        });
        const emptyEl = dialog.find('#preset_cards_empty');
        if (vis === 0 && emptyEl.length === 0) {
            dialog.find('#preset_cards_grid').append(
                `<div id="preset_cards_empty">${t`No presets found`}</div>`,
            );
        }
        dialog.find('#preset_cards_empty').toggle(vis === 0);
        updateCount(vis, presets.length);
    });

    // ---- Long press for Concise Mode Profiles ----
    let pressTimer: number | undefined;

    async function showConciseProfilesModal(card: JQuery<HTMLElement>): Promise<void> {
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;
        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);

        if (!meta.profiles || meta.profiles.length === 0) {
            toastr.info(L('No configurations saved for this preset'));
            return;
        }

        const container = $('<div class="preset_card_profiles_section" style="margin-top:0; padding:0; border:none; box-shadow:none; background:transparent;"></div>');
        const list = $('<div class="preset_card_profiles_list"></div>');

        meta.profiles.forEach(p => {
            const row = $(`<div class="preset_card_profile_row" data-profile-id="${p.id}" style="cursor:pointer; padding:10px 14px; margin-bottom:4px;">
                <div class="preset_card_profile_name" style="font-size:14px;">${p.name}</div>
            </div>`);

            row.on('click', async function () {
                const profile = getProfile(meta, row.data('profile-id'));
                if (!profile) return;

                applyProfileToPreset(preset, profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);

                await saveMeta(name, idx, meta);
                toastr.success(L('Configuration loaded'));

                refreshActivePresetUI(name);

                $(this).closest('.popup').find('.popup-controls .menu_button').click(); // close modal
            });

            list.append(row);
        });

        container.append(list);

        callGenericPopup(container, POPUP_TYPE.TEXT, '', {
            wide: false,
            large: false,
        });
    }

    dialog.on('mousedown touchstart', '.preset_card', function (e) {
        if (!isConciseMode || isBatchMode) return;
        if (e.type === 'mousedown' && (e as JQuery.MouseDownEvent).which !== 1) return; // Only left click

        const card = $(this);

        pressTimer = window.setTimeout(function () {
            card.data('long-pressed', true);
            showConciseProfilesModal(card);
        }, 600);
    });

    dialog.on('mousemove touchmove', '.preset_card', function () {
        clearTimeout(pressTimer);
    });

    dialog.on('mouseup touchend mouseleave', '.preset_card', function () {
        clearTimeout(pressTimer);
    });

    dialog.on('contextmenu', '.preset_card', function (e) {
        if (isConciseMode && !isBatchMode && $(this).data('long-pressed')) {
            e.preventDefault();
        }
    });

    // ---- Card click → switch preset or batch select ----
    dialog.on('click', '.preset_card', function (e) {
        // Ignore if long-pressed
        if ($(this).data('long-pressed')) {
            $(this).data('long-pressed', false);
            return;
        }

        // Ignore if clicking action buttons
        if ($(e.target as Element).closest('.preset_card_actions').length) return;

        // Ignore if clicking inside the profiles section (entries, names, blank row space)
        if ($(e.target as Element).closest('.preset_card_profiles_section').length) return;

        const name = $(this).attr('data-preset-name') as string;

        if (isBatchMode) {
            if (batchSelectedCards.has(name)) {
                batchSelectedCards.delete(name);
                $(this).removeClass('batch_selected');
            } else {
                batchSelectedCards.add(name);
                $(this).addClass('batch_selected');
            }
            return;
        }

        const idx = $(this).data('preset-index') as number;

        dialog.find('.preset_card').removeClass('selected');
        $(this).addClass('selected');

        $('#settings_preset_openai').val(idx).trigger('change');
        toastr.success(`${t`Switched to`} ${name}`);
    });

    // ---- Clear Cache button ----
    dialog.on('click', '#preset_cards_clear_cache_btn', async function () {
        const confirm = await callGenericPopup(L('Clear all cached background images?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        await clearImageCache();
        toastr.success(L('Cache cleared successfully'));

        await refreshGrid({ applyBackgrounds: true });
    });

    // ---- Edit button ----
    dialog.on('click', '.preset_card_edit_btn', function (e) {
        e.stopPropagation();
        const name = $(this).data('preset-name') as string;
        const idx = $(this).data('preset-index') as number;

        openEditModal(name, idx, async () => {
            // Refresh the card in-place
            const preset = openai_settings[idx] as Preset;
            const meta = readMeta(preset);
            const card = dialog.find(`.preset_card[data-preset-index="${idx}"]`);

            // Update description
            if (meta.description) {
                let descEl = card.find('.preset_card_desc');
                if (descEl.length === 0) {
                    card.find('.preset_card_body').prepend('<div class="preset_card_desc"></div>');
                    descEl = card.find('.preset_card_desc');
                }
                descEl.text(meta.description).attr('title', meta.description);
            } else {
                card.find('.preset_card_desc').remove();
            }

            // Update model chips
            const chipsEl = card.find('.preset_card_tags');
            chipsEl.empty();
            if (meta.models.length > 0) {
                if (chipsEl.length === 0) {
                    // Insert it before the profiles section so chips don't get buried.
                    const profilesEl = card.find('.preset_card_profiles_section');
                    if (profilesEl.length > 0) {
                        profilesEl.before('<div class="preset_card_tags"></div>');
                    } else {
                        card.find('.preset_card_body').append('<div class="preset_card_tags"></div>');
                    }
                }
                for (const mid of meta.models) {
                    const def = AVAILABLE_MODELS.find(m => m.id === mid);
                    const logoHtml = def ? `<img src="${LOGO_BASE + def.logo}" alt="" />` : '';
                    const label = def ? def.label : mid;
                    card.find('.preset_card_tags').append(
                        `<span class="preset_card_chip" title="${label}">${logoHtml}${label}</span>`,
                    );
                }
            } else {
                chipsEl.remove();
            }
        });
    });

    // 导出完整预设 JSON（剔除敏感字段与连接数据），卡片头部导出按钮专用。
    // 与配置区头部的「导出全部配置」(`${name}-tree.json`，整棵分支树) 区分。
    function exportPresetFile(name: string, idx: number): void {
        const preset = structuredClone(openai_settings[idx] as Preset);

        const sensitiveFields = [
            'reverse_proxy', 'proxy_password', 'custom_url',
            'custom_include_body', 'custom_exclude_body', 'custom_include_headers',
            'vertexai_region', 'vertexai_express_project_id',
            'azure_base_url', 'azure_deployment_name',
            'workers_ai_account_id',
        ];
        sensitiveFields.forEach(field => delete preset[field]);

        if (settingsToUpdate) {
            for (const [, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
                if (isConnection) { delete preset[settingName]; }
            }
        }

        download(JSON.stringify(preset, null, 4), `${name}.json`, 'application/json');
    }

    // ---- Export button (导出完整预设，剔除敏感字段) ----
    dialog.on('click', '.preset_card_export_btn', function (e) {
        e.stopPropagation();
        const name = $(this).attr('data-preset-name') as string;
        const idx = $(this).data('preset-index') as number;

        exportPresetFile(name, idx);
    });

    // ---- Delete button ----
    dialog.on('click', '.preset_card_delete_btn', async function (e) {
        e.stopPropagation();
        const nameToDelete = $(this).attr('data-preset-name') as string;

        const confirm = await callGenericPopup(t`Delete the preset? This action is irreversible and your current settings will be overwritten.`, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const value = openai_setting_names[nameToDelete];
        $(`#settings_preset_openai option[value="${value}"]`).remove();
        delete openai_setting_names[nameToDelete];

        if (oai_settings.preset_settings_openai === nameToDelete) {
            oai_settings.preset_settings_openai = null;
            if (Object.keys(openai_setting_names).length) {
                const newActiveName = Object.keys(openai_setting_names)[0];
                oai_settings.preset_settings_openai = newActiveName;
                const newValue = openai_setting_names[newActiveName];
                $(`#settings_preset_openai option[value="${newValue}"]`).prop('selected', true);
                $('#settings_preset_openai').trigger('change');
            }
        }

        const response = await fetch('/api/presets/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
        });

        if (!response.ok) {
            toastr.warning(t`Preset was not deleted from server`);
        } else {
            toastr.success(t`Preset deleted`);

            // Safely remove the card from the UI immediately
            dialog.find('.preset_card').filter(function () {
                return $(this).attr('data-preset-name') === nameToDelete;
            }).remove();

            // Re-evaluate counts and search
            presets = presets.filter(p => p.name !== nameToDelete);
            dialog.find('#preset_cards_search').trigger('input');

            // If the active preset changed (because the old one was deleted), update the selected styling
            dialog.find('.preset_card').removeClass('selected');
            const newActive = oai_settings.preset_settings_openai;
            if (newActive) {
                dialog.find('.preset_card').filter(function () {
                    return $(this).attr('data-preset-name') === newActive;
                }).addClass('selected');
            }

            // Emit the event LAST to avoid being interrupted by other listeners
            try {
                await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
            } catch (err) {
                console.error('Error emitting PRESET_DELETED', err);
            }
        }
    });

    // ---- Concise Mode toggle ----
    dialog.on('click', '#preset_cards_concise_btn', function () {
        isConciseMode = !isConciseMode;
        $(this).toggleClass('active', isConciseMode);
        dialog.toggleClass('preset_cards_concise_mode', isConciseMode);
        localStorage.setItem('preset_cards_concise', String(isConciseMode));
    });

    // ---- Multi-select toggle ----
    dialog.on('click', '#preset_cards_multiselect_btn', function () {
        isBatchMode = !isBatchMode;
        $(this).toggleClass('active', isBatchMode);
        dialog.toggleClass('preset_cards_batch_mode', isBatchMode);

        if (isBatchMode) {
            dialog.find('#preset_cards_batch_delete_btn').removeClass('hidden');
        } else {
            dialog.find('#preset_cards_batch_delete_btn').addClass('hidden');
            batchSelectedCards.clear();
            dialog.find('.preset_card').removeClass('batch_selected');
        }
    });

    // ---- Batch Delete button ----
    dialog.on('click', '#preset_cards_batch_delete_btn', async function () {
        if (batchSelectedCards.size === 0) {
            toastr.info(t`No presets selected`);
            return;
        }

        const confirm = await callGenericPopup(t`Delete ${batchSelectedCards.size} presets? This action is irreversible.`, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        let activeDeleted = false;
        let deletedCount = 0;

        for (const nameToDelete of batchSelectedCards) {
            const value = openai_setting_names[nameToDelete];
            if (value === undefined) continue;

            $(`#settings_preset_openai option[value="${value}"]`).remove();
            delete openai_setting_names[nameToDelete];

            if (oai_settings.preset_settings_openai === nameToDelete) {
                oai_settings.preset_settings_openai = null;
                activeDeleted = true;
            }

            const response = await fetch('/api/presets/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
            });

            if (response.ok) {
                deletedCount++;
                dialog.find('.preset_card').filter(function () {
                    return $(this).attr('data-preset-name') === nameToDelete;
                }).remove();
                presets = presets.filter(p => p.name !== nameToDelete);
                try {
                    await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
                } catch (err) {
                    console.error('Error emitting PRESET_DELETED for batch mode', err);
                }
            }
        }

        if (activeDeleted) {
            if (Object.keys(openai_setting_names).length) {
                const newActiveName = Object.keys(openai_setting_names)[0];
                oai_settings.preset_settings_openai = newActiveName;
                const newValue = openai_setting_names[newActiveName];
                $(`#settings_preset_openai option[value="${newValue}"]`).prop('selected', true);
                $('#settings_preset_openai').trigger('change');
            }

            dialog.find('.preset_card').removeClass('selected');
            const newActive = oai_settings.preset_settings_openai;
            if (newActive) {
                dialog.find('.preset_card').filter(function () {
                    return $(this).attr('data-preset-name') === newActive;
                }).addClass('selected');
            }
        }

        if (deletedCount > 0) {
            toastr.success(t`${deletedCount} presets deleted`);
            dialog.find('#preset_cards_search').trigger('input');
        }

        // Exit batch mode
        dialog.find('#preset_cards_multiselect_btn').trigger('click');
    });

    // ---- Profiles: Add Configuration (Save Base Profile) ----
    dialog.on('click', '.preset_card_add_profile_btn', async function (e) {
        e.stopPropagation();
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const profileName = await Popup.show.input(L('Base profile name:'), '');
        if (!profileName) return;

        let loadingToast: JQuery | null = null;
        if (oai_settings.preset_settings_openai === name) {
            loadingToast = toastr.info(L('Saving current preset state...'), '', { timeOut: 0, extendedTimeOut: 0 });
            $('#update_oai_preset').trigger('click');
            await new Promise<void>(r => setTimeout(r, 800));
            toastr.clear(loadingToast);
        }

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];

        // 新 base 快照须包含本会话缓冲的开关/值编辑：先统一应用缓冲再采集快照
        const missing = applyBufferedEdits(preset, name);
        if (missing.length > 0) {
            toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
        }

        profiles.push({
            formatVersion: 2,
            kind: 'prompt_base',
            id: newProfileId(),
            name: profileName,
            prompts: buildPromptToggleSnapshot(preset),
        });

        meta.profiles = profiles;
        await saveMeta(name, idx, meta);
        toastr.success(L('Base profile saved'));

        // Refresh UI
        await refreshGrid();
    });

    // ---- Profiles: Export All Configurations (导出整棵分支树) ----
    dialog.on('click', '.preset_card_export_all_btn', async function (e) {
        e.stopPropagation();
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const choice = await chooseFromOptions(L('Export configuration'), [[L('Export all configurations'), 'export']]);
        if (choice !== 'export') return;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        warnV1ExcludedFromTreeExport(meta);
        download(buildTreeExportData(meta), `${name}-tree.json`, 'application/json');
    });

    // ---- Profiles: Load Configuration (click = apply + expand) ----
    dialog.on('click', '.preset_card_profile_name', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        applyProfileToPreset(preset, profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[], { showMissingToast: true });

        if (isPromptBaseProfile(profile) || isPromptDeltaProfile(profile)) {
            // 主/派生 profile：保存到磁盘并同步运行态
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration loaded'));
            refreshActivePresetUI(name);
        } else {
            // v1 全量快照
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration loaded'));

            // If this is the active preset, trigger a native UI reload
            if (oai_settings.preset_settings_openai === name) {
                $('#settings_preset_openai').trigger('change');
            }
        }

        // 加载已整体覆盖 preset：本卡此前的未保存编辑已失去意义，清缓冲并收起保存按钮
        clearBufferedForName(name);
        card.find('.preset_card_profile_row').removeData('has-pending-clear');
        card.find('.preset_card_profile_row').removeClass('modified');
        card.find('.preset_card_profile_entry').removeClass('dirty');
        card.find('.preset_card_profile_save_btn').addClass('hidden');

        // Toggle expanded entry list (click again to collapse)
        row.toggleClass('expanded');
    });

    // ---- Profiles: Toggle entry switch (updates the preset's actual value) ----
    dialog.on('click', '.preset_card_profile_entry_toggle', function (e) {
        e.stopPropagation();
        const toggle = $(this);
        const on = toggle.hasClass('on');
        toggle.toggleClass('on', !on).toggleClass('off', on);
        toggle.html(on
            ? '<i class="fa-solid fa-toggle-off"></i>'
            : '<i class="fa-solid fa-toggle-on"></i>');

        // 只更新 UI 与缓冲：保存时才统一应用开关到 preset（prompts + prompt_order）
        const card = toggle.closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const row = toggle.closest('.preset_card_profile_row');
        const entry = toggle.closest('.preset_card_profile_entry');
        const identifier = String(entry.data('identifier'));
        const key = bufferKey(name, identifier);
        const target = !on;

        // 净零参照 = 目标行 profile 解析链下的 enabled（DOM 的 on/off 即此值）：仅当目标等于该
        // profile 原本的解析值才算「点回原样」（非活动 profile 同样成立，#1/#4），否则记录缓冲；
        // 拿不到解析值（profile 缺失/解析失败）时保守处理：不判净零，保留缓冲。
        const idx = card.data('preset-index') as number;
        const preset = openai_settings[idx] as Preset;
        const profileId = row.data('profile-id');
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        let resolvedEnabled: boolean | undefined;
        if (profile && (isPromptBaseProfile(profile) || isPromptDeltaProfile(profile))) {
            const resolved = resolveProfilePrompts(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
            resolvedEnabled = resolved.find((e) => e.identifier === identifier)?.enabled;
        }
        if (resolvedEnabled === target) {
            pendingToggles.delete(key);
        } else {
            pendingToggles.set(key, target);
        }

        // dirty = 该条仍存在任一未保存的净变化缓冲（与 applyDirtyHighlights 判定一致）
        if (!pendingToggles.has(key) && !sessionEdits.has(key)) {
            entry.removeClass('dirty');
        } else {
            entry.addClass('dirty');
        }

        // 统一刷新行的 modified 标记与保存按钮（本行已无净变化缓冲则收起）
        syncRowModified(row);
    });

    // ---- Profiles: Edit entry value fields (opens the prompt edit popup) ----
    dialog.on('click', '.preset_card_profile_entry_edit', async function (e) {
        e.stopPropagation();
        const entry = $(this).closest('.preset_card_profile_entry');
        const row = entry.closest('.preset_card_profile_row');
        const card = row.closest('.preset_card');
        const idx = card.data('preset-index') as number;
        const name = card.attr('data-preset-name') as string;
        const identifier = String(entry.data('identifier'));
        const preset = openai_settings[idx] as Preset;

        const prompt = findPromptInPreset(preset, identifier);
        if (!prompt) return;

        // 弹窗以「预设原值 + 已缓冲编辑」为基线预填/比对，多次编辑才能正确累积（不再即时写 prompt）
        const prevSession = sessionEdits.get(bufferKey(name, identifier));
        const current = prevSession
            ? { ...capturePromptFields(prompt), ...prevSession.edited }
            : undefined;
        const editedFields = await openPromptEditPopup(preset, identifier, current);
        if (!editedFields) return;

        // 累积式记录本次编辑：保存时统一应用；多次编辑保留第一次的初始值（reset 还原到首次编辑前）
        const key = bufferKey(name, identifier);
        const session = sessionEdits.get(key);
        const initial = session?.initial ?? capturePromptFields(prompt);
        const edited = { ...(session?.edited ?? {}), ...filterFields(editedFields) };

        // 改回原值（edited 与 initial 净相等）即无净变化 → 取消缓冲；否则保留。
        if (promptFieldsEqual(edited, initial)) {
            sessionEdits.delete(key);
        } else {
            sessionEdits.set(key, { initial, edited });
        }

        // dirty = 该条仍存在任一未保存的净变化缓冲（与 applyDirtyHighlights 判定一致）
        if (!pendingToggles.has(key) && !sessionEdits.has(key)) {
            entry.removeClass('dirty');
        } else {
            entry.addClass('dirty');
        }

        // 统一刷新行的 modified 标记与保存按钮（本行已无净变化缓冲则收起）
        syncRowModified(row);

        // 仅 UI：本地刷新条目名（值已缓冲，保存时才写入 preset 与运行态）
        const nameEl = entry.find('.preset_card_profile_entry_name');
        if (nameEl.length && typeof edited.name === 'string') {
            nameEl.text(edited.name).attr('title', identifier);
        }
    });

    // ---- Profiles: Clear entry value change (base → 删 entry.fields；delta → 删 change.fields) ----
    dialog.on('click', '.preset_card_profile_entry_clear', async function (e) {
        e.stopPropagation();
        const entry = $(this).closest('.preset_card_profile_entry');
        const row = entry.closest('.preset_card_profile_row');
        const card = row.closest('.preset_card');
        const idx = card.data('preset-index') as number;
        const profileId = row.data('profile-id');
        const identifier = String(entry.data('identifier'));
        const name = card.attr('data-preset-name') as string;
        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        if (isPromptBaseProfile(profile)) {
            const item = profile.prompts.find((p) => p.identifier === identifier);
            if (item) delete item.fields;
        } else if (isPromptDeltaProfile(profile)) {
            const change = profile.changes.find((c) => c.identifier === identifier);
            if (change) delete change.fields;
        } else {
            return;
        }

        // 本次会话编辑过该条：彻底撤销（full undo）——删 sessionEdits 记录（保存不再重捕获此条，
        // 否则快照会重新从运行时取回被清掉的 fields）、还原运行时值为会话记录的 initial，
        // 并同步到活动预设运行时，使 UI/运行时与存储一致。
        const session = sessionEdits.get(bufferKey(name, identifier));
        if (session) {
            sessionEdits.delete(bufferKey(name, identifier));
            const prompt = findPromptInPreset(preset, identifier);
            if (prompt) {
                // 清白名单键再写回初始值，去掉编辑新增的键（与编辑方向相反的完整还原）
                for (const key of PROMPT_FIELD_WHITELIST) {
                    if (!(key in session.initial)) delete prompt[key];
                }
                Object.assign(prompt, session.initial);
            }
            // 活动预设的运行时 oai_settings.prompts 同步还原（R2 镜像的对称操作）
            if (oai_settings.preset_settings_openai === card.attr('data-preset-name')) {
                const livePrompts = Array.isArray(oai_settings.prompts) ? oai_settings.prompts : [];
                const livePrompt = livePrompts.find((p: any) => p && p.identifier === identifier);
                if (livePrompt) {
                    for (const key of PROMPT_FIELD_WHITELIST) {
                        if (!(key in session.initial)) delete livePrompt[key];
                    }
                    Object.assign(livePrompt, filterFields(session.initial));
                }
            }
            // 本地刷新条目名，反映还原后的值
            const nameEl = entry.find('.preset_card_profile_entry_name');
            if (nameEl.length && typeof session.initial.name === 'string') {
                nameEl.text(session.initial.name).attr('title', identifier);
            }
        }

        // 记录行内存在非缓冲待保存 clear（防止后续净零 toggle/edit 的 syncRowModified 误藏保存按钮），
        // 再统一刷新行状态；保存/重渲染重建行时标记自然清除。
        row.data('has-pending-clear', true);
        syncRowModified(row);

        // 本地移除值变更标记与本按钮；下次保存（整卡重渲染）按最终 profile 数据呈现
        entry.removeClass('has_fields');
        // 缓冲清空后（值编辑与开关缓冲均无）该条不再是「会话未保存」状态，移除 dirty 高亮；
        // 若 toggle 缓冲仍在，则本条目属于「开/关待保存」，保留蓝色。
        const clearKey = bufferKey(name, identifier);
        if (!sessionEdits.has(clearKey) && !pendingToggles.has(clearKey)) {
            entry.removeClass('dirty');
        }
        entry.find('.preset_card_profile_entry_modified').remove();
        $(this).remove();
    });

    // ---- Profiles: Reorder prompt_order (only active preset renders these buttons) ----
    dialog.on('click', '.preset_card_profile_entry_move', async function (e) {
        e.stopPropagation();
        const btn = $(this);
        if (btn.hasClass('disabled')) return;

        const entry = btn.closest('.preset_card_profile_entry');
        const row = entry.closest('.preset_card_profile_row');
        const card = row.closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;
        const identifier = String(entry.data('identifier'));
        const preset = openai_settings[idx] as Preset;

        const delta = btn.hasClass('preset_card_profile_entry_move_up') ? -1 : 1;
        // 只重排 .order 数组：不动单条 enabled、不动 prompts[] 顺序
        if (!reorderPromptOrder(preset, identifier, delta)) return;

        // 插件既有持久化路径：mutate openai_settings[idx] → saveMeta（写预设文件）→ refreshActivePresetUI（同步 oai_settings + 刷新 Prompt Manager）
        await saveMeta(name, idx, readMeta(preset));
        refreshActivePresetUI(name);

        // 本地反馈：交换 DOM 条目位置并刷新边界禁用态
        const siblings = entry.parent().children('.preset_card_profile_entry');
        const target = delta === -1
            ? siblings.eq(siblings.index(entry) - 1)
            : siblings.eq(siblings.index(entry) + 1);
        if (target.length) {
            if (delta === -1) {
                entry.insertBefore(target);
            } else {
                entry.insertAfter(target);
            }
            updateEntryMoveButtons(entry);
            updateEntryMoveButtons(target);
        }
    });

    // ---- Profiles: Save expanded edits ----
    dialog.on('click', '.preset_card_profile_save_btn', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        // Ask: update current profile or create a new subprofile (delta)?
        const choice = await chooseProfileSaveTarget();
        if (!choice) return;

        // 保存时统一应用缓冲（先开关后值字段），快照随后才能反映本次编辑
        const missing = applyBufferedEdits(preset, name);
        if (missing.length > 0) {
            toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
        }

        // Collect current switch states + value fields for the edited entries
        const snapshot = buildPromptSnapshot(preset, { includeFields: editedIdentifiersForName(name) });

        if (choice === 'update') {
            if (isPromptBaseProfile(profile)) {
                // enabled 全量合并；fields 仅对本次编辑的条目（与编辑初值无净变化时清除），
                // 其余条目保留既有 fields（见 mergeBaseSnapshot）
                mergeBaseSnapshot(profile, snapshot, name);
                recordDefaultOriginalFields(meta, name);
            } else if (isPromptDeltaProfile(profile)) {
                // 基线用父链解析状态（不含本 delta 自身 changes），否则未编辑的已存差异与基线相等而被 diff 掉
                const parentEntries = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
                if (parentEntries.length > 0) {
                    profile.changes = snapshotToChanges(snapshot, parentEntries, profile.changes);
                } else {
                    // 父链缺失：全量写成差异（含值字段）
                    profile.changes = snapshot.map((s) => {
                        const change: PromptDeltaChange = { identifier: s.identifier, enabled: s.enabled };
                        if (s.fields) change.fields = s.fields;
                        return change;
                    });
                }
                recordDefaultOriginalFields(meta, name);
            } else {
                // v1: not editable via switches
                toastr.warning(L('This profile type cannot be edited with switches'));
                return;
            }
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration updated'));
        } else {
            // create a new delta subprofile derived from the edited profile (base or delta)
            if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) {
                toastr.warning(L('This profile type cannot be derived'));
                return;
            }
            const deltaName = await Popup.show.input(L('Derived profile name:'), '');
            if (!deltaName) return;

            const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
            const parentEntries = resolveProfilePrompts(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
            const changes = snapshotToChanges(snapshot, parentEntries, isPromptDeltaProfile(profile) ? profile.changes : []);
            profiles.push({
                formatVersion: 2,
                kind: 'prompt_delta',
                id: newProfileId(),
                name: deltaName,
                baseId: profile.id,
                changes,
            });
            meta.profiles = profiles;
            recordDefaultOriginalFields(meta, name);
            await saveMeta(name, idx, meta);
            toastr.success(L('Derived profile created'));
        }

        // 修复 R3：保存后刷新活动预设，否则 promptManager 列表与实际生效值不一致。
        // 注意：活动预设绝不触发 #update_oai_preset（R2），它会把 prompts 从 oai_settings 回写覆盖掉本次编辑。
        refreshActivePresetUI(name);

        // 本批编辑已消费，清空当前 name 的记录（其他卡的缓冲保留）
        clearBufferedForName(name);

        // Refresh UI
        await refreshGrid();
    });

    // ---- Profiles: Update Configuration ----
    dialog.on('click', '.preset_card_profile_update', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const confirm = await callGenericPopup(L('Overwrite this configuration with current settings?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        let loadingToast: JQuery | null = null;
        if (oai_settings.preset_settings_openai === name) {
            loadingToast = toastr.info(L('Saving current preset state...'), '', { timeOut: 0, extendedTimeOut: 0 });
            $('#update_oai_preset').trigger('click');
            await new Promise<void>(r => setTimeout(r, 800));
            toastr.clear(loadingToast);
        }

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        // 覆盖同样先统一应用缓冲，快照才能反映本次编辑
        const missing = applyBufferedEdits(preset, name);
        if (missing.length > 0) {
            toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
        }

        if (isPromptBaseProfile(profile)) {
            // 覆盖仅重同步 enabled 开关；fields 保留既有值（本次会话未编辑的条目不丢），
            // 本次会话编辑过的条目按与编辑初值是否有净变化决定保留/清除（与保存流程一致，见 mergeBaseSnapshot）
            const snapshot = buildPromptSnapshot(preset, { includeFields: editedIdentifiersForName(name) });
            mergeBaseSnapshot(profile, snapshot, name);
            recordDefaultOriginalFields(meta, name);

            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration updated'));
            refreshActivePresetUI(name);
        } else if (isPromptDeltaProfile(profile)) {
            // 派生 profile：基于解析后的 parent 状态重新生成差异（snapshotToChanges 保留既有 fields）
            const parentStates = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
            if (parentStates.length === 0) {
                toastr.warning(L('Base profile not found, cannot update derived configuration'));
                return;
            }
            profile.changes = snapshotToChanges(buildPromptSnapshot(preset, { includeFields: editedIdentifiersForName(name) }), parentStates, profile.changes);
            recordDefaultOriginalFields(meta, name);

            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration updated'));
            refreshActivePresetUI(name);
        } else {
            // v1 全量快照
            const snapshot = structuredClone(preset);
            delete snapshot.extensions; // Don't nest extensions
            profile.settings = snapshot;

            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration updated'));
        }

        // 覆盖已消费本批编辑：清空当前 name 的缓冲（其他卡的缓冲保留）并重渲染网格
        clearBufferedForName(name);
        await refreshGrid();
    });

    // ---- Profiles: Derive from Base ----
    dialog.on('click', '.preset_card_profile_derive', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const parent = getProfile(meta, profileId);
        if (!parent) return;

        if (!isPromptBaseProfile(parent) && !isPromptDeltaProfile(parent)) {
            toastr.warning(L('Cannot derive from a legacy profile'));
            return;
        }

        const deltaName = await Popup.show.input(L('Derived profile name:'), '');
        if (!deltaName) return;

        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
        profiles.push({
            formatVersion: 2,
            kind: 'prompt_delta',
            id: newProfileId(),
            name: deltaName,
            baseId: parent.id,
            changes: [], // 初始为空数组：与上级 profile 完全相同，后续通过「覆盖」更新差异
        });

        meta.profiles = profiles;
        await saveMeta(name, idx, meta);
        toastr.success(L('Derived profile created'));

        // Refresh UI
        await refreshGrid();
    });

    // ---- Profiles: Reset to parent (delta -> base; base -> hidden default) ----
    dialog.on('click', '.preset_card_profile_reset', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const confirm = await callGenericPopup(L('Reset this configuration to its parent?'), POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        if (isPromptDeltaProfile(profile)) {
            // 派生：回退到其上级（base 或上层 delta）；若无上级则回退到隐藏默认
            const parentStates = resolveParentStates(profile, meta.profiles as (PromptBaseProfile | PromptDeltaProfile)[]);
            if (parentStates.length > 0) {
                applyBaseProfile(preset, {
                    formatVersion: 2,
                    kind: 'prompt_base',
                    id: profile.baseId || 'parent',
                    name: 'Parent',
                    prompts: parentStates,
                });
                profile.changes = [];
            } else {
                if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                    toastr.warning(L('No default baseline available'));
                    return;
                }
                applyDefaultOriginalFields(preset, meta);
                const tmp: PromptBaseProfile = {
                    formatVersion: 2,
                    kind: 'prompt_base',
                    id: profile.baseId || 'default',
                    name: 'Default',
                    prompts: meta.defaultSnapshot,
                };
                applyBaseProfile(preset, tmp);
                profile.changes = [];
            }
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration reset'));
            refreshActivePresetUI(name);
            clearBufferedForName(name);
        } else if (isPromptBaseProfile(profile)) {
            // 主 profile：回退到隐藏默认基准
            if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                toastr.warning(L('No default baseline available'));
                return;
            }
            applyDefaultOriginalFields(preset, meta);
            // 只回写开关；originalFields 是 reset 专用元数据，不随 profile 持久化
            profile.prompts = structuredClone(meta.defaultSnapshot).map(({ identifier, enabled }) => ({ identifier, enabled }));
            const tmp: PromptBaseProfile = {
                formatVersion: 2,
                kind: 'prompt_base',
                id: profile.id,
                name: profile.name,
                prompts: meta.defaultSnapshot,
            };
            applyBaseProfile(preset, tmp);
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration reset'));
            refreshActivePresetUI(name);
            clearBufferedForName(name);
        } else {
            toastr.warning(L('This profile type cannot be reset'));
            return;
        }

        // Refresh UI
        await refreshGrid();
    });

    // ---- Profiles: Delete Configuration ----
    dialog.on('click', '.preset_card_profile_delete', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const preset = openai_settings[idx] as Preset;
        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);

        let confirmText = L('Delete this configuration?');
        if (profile && isPromptBaseProfile(profile)) {
            const dependents = meta.profiles.filter(p => isPromptDeltaProfile(p) && p.baseId === profile.id);
            if (dependents.length > 0) {
                confirmText += `\n${dependents.length} ${L('derived configuration(s) depend on this base and will only keep their changes after deletion')}`;
            }
        }

        const confirm = await callGenericPopup(confirmText, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        meta.profiles = (meta.profiles || []).filter(p => p.id !== String(profileId));
        await saveMeta(name, idx, meta);

        row.remove();
    });

    // ---- Profiles: Export Configuration ----
    dialog.on('click', '.preset_card_profile_export', async function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const idx = card.data('preset-index') as number;
        const preset = openai_settings[idx] as Preset;

        const meta = readMeta(preset);
        const profile = getProfile(meta, profileId);
        if (!profile) return;

        const choice = await chooseProfileExportAction();
        if (choice === 'tree') {
            // v1 快照无父链可导出，回退为单 profile 导出
            if (isPromptBaseProfile(profile) || isPromptDeltaProfile(profile)) {
                warnV1ExcludedFromTreeExport(meta);
                download(buildTreeExportData(meta, profile.id), `${profile.name}-tree.json`, 'application/json');
            } else {
                download(buildProfileExportData(profile, meta), `${profile.name}.json`, 'application/json');
            }
        } else if (choice === 'profile') {
            download(buildProfileExportData(profile, meta), `${profile.name}.json`, 'application/json');
        }
    });

    // ---- Profiles: Import Configuration ----
    dialog.on('click', '.preset_card_import_profile_btn', function (e) {
        e.stopPropagation();
        const card = $(this).closest('.preset_card');
        const name = card.attr('data-preset-name') as string;
        const idx = card.data('preset-index') as number;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (event) => {
            const file = (event.target as HTMLInputElement).files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                const parsed = JSON.parse(text) as Record<string, any>;
                // 不可信输入形状防御：JSON 文件必须是对象（v1 settings 快照或带 kind 的 profile）。
                // null / 原始值 / 数组视为畸形文件，走 catch 报错，避免把非对象塞进 settings 生成垃圾 v1 profile。
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    throw new Error('Imported configuration is not a JSON object');
                }

                let defaultName = file.name.replace(/\.json$/i, '');
                const profileName = await Popup.show.input(L('Configuration name:'), defaultName, defaultName);
                if (!profileName) return;

                const preset = openai_settings[idx] as Preset;
                const meta = readMeta(preset);
                const existing = Array.isArray(meta.profiles) ? meta.profiles : [];
                const { profiles, warnings } = mergeImportedProfiles(parsed, existing, profileName);
                for (const warning of warnings) {
                    toastr.warning(warning);
                }

                meta.profiles = profiles;
                await saveMeta(name, idx, meta);
                toastr.success(L('Configuration saved'));

                await refreshGrid({ applyBackgrounds: true });
            } catch (err) {
                console.error(err);
                toastr.error(L('Failed to parse configuration file'));
            }
        };
        input.click();
    });

    // ---- Profiles: Edit/Rename Configuration ----
    dialog.on('click', '.preset_card_profile_edit', function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const nameContainer = row.find('.preset_card_profile_name');

        // Prevent double click/edit
        if (nameContainer.length === 0) return;

        const currentName = nameContainer.text();

        const input = $('<input>', {
            type: 'text',
            class: 'preset_card_profile_edit_input',
            value: currentName
        });

        nameContainer.replaceWith(input);
        input.focus();

        input.on('blur keydown', async function (evt) {
            const key = (evt.originalEvent as KeyboardEvent | undefined)?.key ?? '';
            if (evt.type === 'keydown' && key !== 'Enter' && key !== 'Escape') return;
            evt.stopPropagation();

            const newName = (key === 'Escape') ? currentName : (input.val() as string).trim() || currentName;

            const newContainer = $('<div>', {
                class: 'preset_card_profile_name',
                title: 'Load configuration',
                text: newName
            });
            input.replaceWith(newContainer);

            if (newName !== currentName && key !== 'Escape') {
                const profileId = row.data('profile-id');
                const card = row.closest('.preset_card');
                const name = card.attr('data-preset-name') as string;
                const idx = card.data('preset-index') as number;

                const preset = openai_settings[idx] as Preset;
                const meta = readMeta(preset);
                const profile = getProfile(meta, profileId);
                if (profile) {
                    profile.name = newName;
                    await saveMeta(name, idx, meta);
                }
            }
        });
    });

    // ---- Import button ----
    dialog.on('click', '#preset_cards_import_btn', function () {
        $('#openai_preset_import_file').trigger('click');
        // Let SillyTavern's native import handler do the rest.
        // It will parse the file, save the preset, and switch to it.
        // We will just close the modal since a new preset was imported and the grid is now stale.
        dialog.closest('.popup').find('.popup-controls .menu_button').click();
    });

    updateCount(presets.length, presets.length);
    applyCachedBackgrounds(dialog);

    callGenericPopup(dialog, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}
