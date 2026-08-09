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
    type PresetMeta,
    type PromptBaseProfile,
    type PromptDeltaChange,
    type PromptDeltaProfile,
    type PromptFields,
} from './meta.js';
import {
    PROMPT_FIELD_WHITELIST,
    applyBaseProfile,
    applyProfileToPreset,
    buildBaseSnapshotDiff,
    buildPromptSnapshot,
    capturePromptFields,
    filterFields,
    findPromptInPreset,
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
import { applyBufferedEdits, bufferKey, clearBufferedForName, editedIdentifiersForName, type PromptEditBuffer } from './presetBuffers.js';
import { applyDirtyHighlights, syncRowModified } from './presetDirty.js';
import { applyDefaultOriginalFields, lockDefaultSnapshot, mergeBaseSnapshot, recordDefaultOriginalFields } from './presetSnapshot.js';
import { buildDerivedProfile, collectDescendantProfileIds } from './profileActions.js';

export async function openPresetCards(): Promise<void> {
    let presets = buildPresetList();

    let isBatchMode = false;
    const batchSelectedCards = new Set<string>();
    let isConciseMode = localStorage.getItem('preset_cards_concise') === 'true';

    // 本次打开期间的值编辑记录：identifier → { 编辑前字段, 编辑后字段（累积目标值） }
    const sessionEdits = new Map<string, PromptEditBuffer>();

    // 本次打开期间的开关切换缓冲：identifier → 本次会话目标 enabled，仅记录被切换过的条目
    const pendingToggles = new Map<string, boolean>();

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

    // 整卡列表重渲染并触发搜索过滤；applyBackgrounds 时重新应用背景图
    async function refreshGrid(opts?: { applyBackgrounds?: boolean }): Promise<void> {
        const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
        dialog.html($(newHtml).html());
        applyDirtyHighlights(dialog, sessionEdits, pendingToggles);
        if (opts?.applyBackgrounds) applyCachedBackgrounds(dialog);
        dialog.find('#preset_cards_search').trigger('input');
    }

    // 保存/覆盖/派生前统一应用本会话的开关/值编辑缓冲并采集快照：缺失条目提示跳过。
    // 返回反映本次编辑后的开关+值字段快照（buildPromptSnapshot 的 includeFields 取当前 name 的编辑集合）。
    function applyBufferedAndSnapshot(
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

    // 「保存→更新」与「覆盖」共用的 base/delta 提交：按类型合并缓冲后的快照 → 持久化 → 成功提示。
    // missingParent 为 delta 父链缺失时的分歧路径：
    //   'full-changes'（保存→更新）：全量写成差异（含值字段）继续提交；
    //   'abort'（覆盖）：toast 提示并返回 false，调用方中止后续。
    // 仅处理 base/delta；v1 由调用方先行分支。成功时返回 true。
    async function commitBufferedEditsToProfile(
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

    // 活动预设被删后重选第一个剩余预设并触发原生下拉 change（无剩余时保持 null）。
    function reselectFirstPreset(): void {
        if (Object.keys(openai_setting_names).length) {
            const newActiveName = Object.keys(openai_setting_names)[0];
            oai_settings.preset_settings_openai = newActiveName;
            const newValue = openai_setting_names[newActiveName];
            $(`#settings_preset_openai option[value="${newValue}"]`).prop('selected', true);
            $('#settings_preset_openai').trigger('change');
        }
    }

    // 刷新卡片选中态：清空后按当前活动预设重新高亮对应卡片。
    function refreshActiveCardSelection(): void {
        dialog.find('.preset_card').removeClass('selected');
        const newActive = oai_settings.preset_settings_openai;
        if (newActive) {
            dialog.find('.preset_card').filter(function () {
                return $(this).attr('data-preset-name') === newActive;
            }).addClass('selected');
        }
    }

    // 删除单个 preset 的公共例程：移除下拉 option → 清 openai_setting_names → 活动预设置空/重选 →
    // 服务端删除 → 成功路径删卡 + presets filter + onBeforeEmit + emit PRESET_DELETED。
    // 返回服务端是否确认删除成功；value 缺失（防御：批删循环已提前跳过）返回 false 不提示。
    // activeHandling: 'immediate'（单删）活动预设被删时当场 reselectFirstPreset；
    //                 'deferred'（批删）只置空，重选由调用方在循环后统一执行。
    // onDeleted: 服务端确认成功后、UI 删卡前（单删：成功 toast）；
    // onBeforeEmit: 删卡与 presets filter 之后、emit 之前（单删：search 过滤 + 选中态刷新）。
    async function deletePresetByName(
        nameToDelete: string,
        opts: {
            activeHandling: 'immediate' | 'deferred';
            emitLog: string;
            onDeleted?: () => void;
            onBeforeEmit?: () => void;
        },
    ): Promise<boolean> {
        const value = openai_setting_names[nameToDelete];
        if (value === undefined) return false;

        $(`#settings_preset_openai option[value="${value}"]`).remove();
        delete openai_setting_names[nameToDelete];

        if (oai_settings.preset_settings_openai === nameToDelete) {
            oai_settings.preset_settings_openai = null;
            if (opts.activeHandling === 'immediate') {
                reselectFirstPreset();
            }
        }

        const response = await fetch('/api/presets/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: 'openai', name: nameToDelete }),
        });

        if (!response.ok) return false;

        opts.onDeleted?.();

        // Safely remove the card from the UI immediately
        dialog.find('.preset_card').filter(function () {
            return $(this).attr('data-preset-name') === nameToDelete;
        }).remove();

        // Re-evaluate counts and search
        presets = presets.filter(p => p.name !== nameToDelete);

        opts.onBeforeEmit?.();

        // Emit the event LAST to avoid being interrupted by other listeners
        try {
            await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', name: nameToDelete });
        } catch (err) {
            console.error(opts.emitLog, err);
        }

        return true;
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

        const deleted = await deletePresetByName(nameToDelete, {
            activeHandling: 'immediate',
            emitLog: 'Error emitting PRESET_DELETED',
            onDeleted: () => toastr.success(t`Preset deleted`),
            onBeforeEmit: () => {
                dialog.find('#preset_cards_search').trigger('input');
                refreshActiveCardSelection();
            },
        });

        if (!deleted) {
            toastr.warning(t`Preset was not deleted from server`);
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
            if (openai_setting_names[nameToDelete] === undefined) continue;
            const wasActive = oai_settings.preset_settings_openai === nameToDelete;
            const deleted = await deletePresetByName(nameToDelete, {
                activeHandling: 'deferred',
                emitLog: 'Error emitting PRESET_DELETED for batch mode',
            });
            if (deleted) deletedCount++;
            if (wasActive) activeDeleted = true;
        }

        if (activeDeleted) {
            reselectFirstPreset();
            refreshActiveCardSelection();
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

        // 首次对该预设 add base：先全量锁定默认基线（编辑前状态），幂等。reset 与 add base 基线 diff 都依赖它。
        await lockDefaultSnapshot(preset, name, idx);

        const meta = readMeta(preset);
        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];

        // 新 base 快照须包含本会话缓冲的开关/值编辑：先统一应用缓冲再采集快照
        const missing = applyBufferedEdits(preset, name, sessionEdits, pendingToggles);
        if (missing.length > 0) {
            toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
        }

        // 与锁定基线做差异：fields 只存与基线不同的字段（content 差异进 base，又避免全量 content 快照）
        profiles.push({
            formatVersion: 2,
            kind: 'prompt_base',
            id: newProfileId(),
            name: profileName,
            prompts: buildBaseSnapshotDiff(preset, meta.defaultSnapshot),
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
        clearBufferedForName(name, sessionEdits, pendingToggles);
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
        syncRowModified(row, sessionEdits, pendingToggles);
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
        syncRowModified(row, sessionEdits, pendingToggles);

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
        syncRowModified(row, sessionEdits, pendingToggles);

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
        const snapshot = applyBufferedAndSnapshot(preset, name, sessionEdits, pendingToggles);

        if (choice === 'update') {
            if (!isPromptBaseProfile(profile) && !isPromptDeltaProfile(profile)) {
                // v1: not editable via switches
                toastr.warning(L('This profile type cannot be edited with switches'));
                return;
            }
            await commitBufferedEditsToProfile(profile, snapshot, meta, name, idx, sessionEdits, 'full-changes');
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
            profiles.push(buildDerivedProfile(profile, deltaName, changes));
            meta.profiles = profiles;
            recordDefaultOriginalFields(meta, name, sessionEdits);
            await saveMeta(name, idx, meta);
            toastr.success(L('Derived profile created'));
        }

        // 修复 R3：保存后刷新活动预设，否则 promptManager 列表与实际生效值不一致。
        // 注意：活动预设绝不触发 #update_oai_preset（R2），它会把 prompts 从 oai_settings 回写覆盖掉本次编辑。
        refreshActivePresetUI(name);

        // 本批编辑已消费，清空当前 name 的记录（其他卡的缓冲保留）
        clearBufferedForName(name, sessionEdits, pendingToggles);

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
        const snapshot = applyBufferedAndSnapshot(preset, name, sessionEdits, pendingToggles);

        if (isPromptBaseProfile(profile) || isPromptDeltaProfile(profile)) {
            // base：enabled 全量合并 + 本次会话编辑条目的 fields（见 mergeBaseSnapshot）；
            // delta：基于解析后的 parent 状态重新生成差异（snapshotToChanges 保留既有 fields）；
            // 父链缺失（仅 delta）时 abort：toast 提示并中止，不落盘。
            const committed = await commitBufferedEditsToProfile(profile, snapshot, meta, name, idx, sessionEdits, 'abort');
            if (!committed) return;
            refreshActivePresetUI(name);
        } else {
            // v1 全量快照
            const v1Snapshot = structuredClone(preset);
            delete v1Snapshot.extensions; // Don't nest extensions
            profile.settings = v1Snapshot;

            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration updated'));
        }

        // 覆盖已消费本批编辑：清空当前 name 的缓冲（其他卡的缓冲保留）并重渲染网格
        clearBufferedForName(name, sessionEdits, pendingToggles);
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
        profiles.push(buildDerivedProfile(parent, deltaName));

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
            clearBufferedForName(name, sessionEdits, pendingToggles);
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
            clearBufferedForName(name, sessionEdits, pendingToggles);
        } else {
            toastr.warning(L('This profile type cannot be reset'));
            return;
        }

        // Refresh UI
        await refreshGrid();
    });

    // ---- Profiles: Delete Configuration ----
    // 级联删除：删除 profile 时，递归收集所有派生后代（delta 的 delta……），一并删除。
    // 弹窗确认时列出将被删除的全部子 node 名称（多行、含嵌套），确认后整棵子树移除。
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
        if (!profile) return;

        const descendantIds = collectDescendantProfileIds(meta, profileId);

        let confirmText = L('Delete this configuration?');
        if (descendantIds.length > 0) {
            const names = descendantIds
                .map((id) => getProfile(meta, id)?.name || id)
                .join(', ');
            confirmText += `\n${L('This will also delete the following derived configurations')}: ${names}`;
        }

        const confirm = await callGenericPopup(confirmText, POPUP_TYPE.CONFIRM);
        if (!confirm) return;

        const deleteIds = new Set([String(profileId), ...descendantIds]);
        meta.profiles = (meta.profiles || []).filter(p => !deleteIds.has(String(p.id)));
        await saveMeta(name, idx, meta);

        // 整棵子树可能跨多行，重建网格而非仅删当前行
        await refreshGrid();
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
                const { profiles, warnings } = mergeImportedProfiles(parsed, existing, profileName, meta.defaultSnapshot);
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
