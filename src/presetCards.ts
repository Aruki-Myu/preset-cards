import { getRequestHeaders } from '@sillytavern/script';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { oai_settings, openai_settings, openai_setting_names, settingsToUpdate, promptManager } from '@sillytavern/scripts/openai';
import { POPUP_TYPE, callGenericPopup, Popup } from '@sillytavern/scripts/popup';
import { t } from '@sillytavern/scripts/i18n';
import { download } from '@sillytavern/scripts/utils';
import { eventSource, event_types } from '@sillytavern/scripts/events';
import { AVAILABLE_MODELS, EXTENSION_NAME, LOGO_BASE } from './constants.js';
import { L } from './i18n.js';
import {
    isPromptBaseProfile,
    isPromptDeltaProfile,
    readMeta,
    saveMeta,
    type Preset,
    type PromptBaseProfile,
} from './meta.js';
import { applyBaseProfile, applyDeltaProfile, applyEntryState, buildDeltaChanges, buildPromptToggleSnapshot, statesToChanges } from './promptToggle.js';
import { buildPresetList, getCardsTemplateContext } from './presetList.js';
import { applyCachedBackgrounds, clearImageCache } from './cache.js';
import { openEditModal } from './editModal.js';

export async function openPresetCards(): Promise<void> {
    // Backfill hidden default snapshots before rendering so reset always has a baseline
    await ensureDefaultSnapshots();

    let presets = buildPresetList();

    let isBatchMode = false;
    const batchSelectedCards = new Set<string>();
    let isConciseMode = localStorage.getItem('preset_cards_concise') === 'true';

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

    // Two-button choice popup: update current profile, or create a new subprofile (delta).
    async function chooseProfileSaveTarget(): Promise<'update' | 'create' | null> {
        const container = $('<div class="preset_cards_save_choice"></div>');
        container.append($('<div class="preset_cards_save_choice_title"></div>').text(L('Save modified switches to')));
        const buttons = $('<div class="preset_cards_save_choice_actions"></div>');
        buttons.append($('<button class="menu_button"></button>')
            .text(L('Update current profile'))
            .on('click', function () { resolveChoice('update'); }));
        buttons.append($('<button class="menu_button"></button>')
            .text(L('Create new subprofile'))
            .on('click', function () { resolveChoice('create'); }));
        container.append(buttons);

        let resolver: (v: 'update' | 'create' | null) => void;
        const promise = new Promise<'update' | 'create' | null>(r => { resolver = r; });

        function resolveChoice(v: 'update' | 'create' | null): void {
            $(container).closest('.popup').find('.popup-controls .menu_button').click();
            resolver(v);
        }

        callGenericPopup(container, POPUP_TYPE.TEXT, '', { okButton: '', cancelButton: '' });
        return promise;
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
                const profile = meta.profiles.find(pr => pr.id === String(row.data('profile-id')));
                if (!profile) return;

                if (isPromptBaseProfile(profile)) {
                    applyBaseProfile(preset, profile);
                } else if (isPromptDeltaProfile(profile)) {
                    const base = meta.profiles.find((b): b is PromptBaseProfile =>
                        isPromptBaseProfile(b) && b.id === profile.baseId);
                    if (!base) {
                        toastr.warning(L('Base profile not found, applying changes only'));
                    }
                    applyDeltaProfile(preset, profile, base);
                } else {
                    const ext = preset.extensions;
                    Object.assign(preset, profile.settings);
                    preset.extensions = ext;
                }

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

        const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
        dialog.html($(newHtml).html());
        applyCachedBackgrounds(dialog);
        dialog.find('#preset_cards_search').trigger('input');
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

    // ---- Export button ----
    dialog.on('click', '.preset_card_export_btn', function (e) {
        e.stopPropagation();
        const name = $(this).attr('data-preset-name') as string;
        const idx = $(this).data('preset-index') as number;
        const preset = structuredClone(openai_settings[idx] as Preset);

        // Remove sensitive fields
        const sensitiveFields = [
            'reverse_proxy',
            'proxy_password',
            'custom_url',
            'custom_include_body',
            'custom_exclude_body',
            'custom_include_headers',
            'vertexai_region',
            'vertexai_express_project_id',
            'azure_base_url',
            'azure_deployment_name',
            'workers_ai_account_id',
        ];

        sensitiveFields.forEach(field => delete preset[field]);

        // Remove connection data
        if (settingsToUpdate) {
            for (const [, [, settingName, , isConnection]] of Object.entries(settingsToUpdate)) {
                if (isConnection) {
                    delete preset[settingName];
                }
            }
        }

        const data = JSON.stringify(preset, null, 4);
        download(data, `${name}.json`, 'application/json');
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

        profiles.push({
            formatVersion: 2,
            kind: 'prompt_base',
            id: Date.now().toString() + Math.floor(Math.random() * 1000),
            name: profileName,
            prompts: buildPromptToggleSnapshot(preset),
        });

        meta.profiles = profiles;
        await saveMeta(name, idx, meta);
        toastr.success(L('Base profile saved'));

        // Refresh UI
        const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
        dialog.html($(newHtml).html());
        dialog.find('#preset_cards_search').trigger('input');
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
        const profile = meta.profiles.find(p => p.id === String(profileId));
        if (!profile) return;

        if (isPromptBaseProfile(profile)) {
            // 主 profile：只回写 prompts 开关并同步 prompt_order
            applyBaseProfile(preset, profile);

            // Save to disk so changes persist
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration loaded'));
            refreshActivePresetUI(name);
        } else if (isPromptDeltaProfile(profile)) {
            // 派生 profile：主 + 子叠加应用
            const base = meta.profiles.find((b): b is PromptBaseProfile =>
                isPromptBaseProfile(b) && b.id === profile.baseId);
            if (!base) {
                toastr.warning(L('Base profile not found, applying changes only'));
            }
            const { missing } = applyDeltaProfile(preset, profile, base);
            if (missing.length > 0) {
                toastr.warning(`${L('Missing prompts skipped')}: ${missing.join(', ')}`);
            }

            // Save to disk so changes persist
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration loaded'));
            refreshActivePresetUI(name);
        } else {
            // v1 全量快照：合并 settings，保留 extensions
            const ext = preset.extensions;
            Object.assign(preset, profile.settings);
            preset.extensions = ext;

            // Save to disk so changes persist
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration loaded'));

            // If this is the active preset, trigger a native UI reload
            if (oai_settings.preset_settings_openai === name) {
                $('#settings_preset_openai').trigger('change');
            }
        }

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

        // Apply to the preset's real value (prompts + prompt_order) for robustness
        const row = toggle.closest('.preset_card_profile_row');
        const entry = toggle.closest('.preset_card_profile_entry');
        const card = row.closest('.preset_card');
        const idx = card.data('preset-index') as number;
        const identifier = String(entry.data('identifier'));
        const preset = openai_settings[idx] as Preset;
        if (!applyEntryState(preset, identifier, !on)) {
            // Not found in the current preset; revert the visual toggle
            toggle.toggleClass('on', on).toggleClass('off', !on);
            toggle.html(on
                ? '<i class="fa-solid fa-toggle-on"></i>'
                : '<i class="fa-solid fa-toggle-off"></i>');
            return;
        }

        // Mark the row as modified so the save button shows up
        row.addClass('modified');
        row.find('.preset_card_profile_save_btn').removeClass('hidden');
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
        const profile = meta.profiles.find(p => p.id === String(profileId));
        if (!profile) return;

        // Collect current switch states from the preset's actual value
        const states = buildPromptToggleSnapshot(preset);

        // Ask: update current profile or create a new subprofile (delta)?
        const choice = await chooseProfileSaveTarget();
        if (!choice) return;

        if (choice === 'update') {
            if (isPromptBaseProfile(profile)) {
                profile.prompts = states;
            } else if (isPromptDeltaProfile(profile)) {
                const base = meta.profiles.find((b): b is PromptBaseProfile =>
                    isPromptBaseProfile(b) && b.id === profile.baseId);
                if (base) {
                    profile.changes = statesToChanges(states, base, profile.changes);
                } else {
                    profile.changes = states.map(s => ({ identifier: s.identifier, enabled: s.enabled }));
                }
            } else {
                // v1: not editable via switches
                toastr.warning(L('This profile type cannot be edited with switches'));
                return;
            }
            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration updated'));
        } else {
            // create a new delta subprofile
            const base = isPromptBaseProfile(profile)
                ? profile
                : (isPromptDeltaProfile(profile)
                    ? meta.profiles.find((b): b is PromptBaseProfile => isPromptBaseProfile(b) && b.id === profile.baseId)
                    : undefined);
            if (!base) {
                toastr.warning(L('Base profile not found, cannot create derived configuration'));
                return;
            }
            const deltaName = await Popup.show.input(L('Derived profile name:'), '');
            if (!deltaName) return;

            const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
            const changes = statesToChanges(states, base, isPromptDeltaProfile(profile) ? profile.changes : []);
            profiles.push({
                formatVersion: 2,
                kind: 'prompt_delta',
                id: Date.now().toString() + Math.floor(Math.random() * 1000),
                name: deltaName,
                baseId: base.id,
                changes,
            });
            meta.profiles = profiles;
            await saveMeta(name, idx, meta);
            toastr.success(L('Derived profile created'));
        }

        // Refresh UI
        const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
        dialog.html($(newHtml).html());
        dialog.find('#preset_cards_search').trigger('input');
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
        const profile = meta.profiles.find(p => p.id === String(profileId));
        if (!profile) return;

        if (isPromptBaseProfile(profile)) {
            // 主 profile：重新采集开关清单覆盖
            profile.prompts = buildPromptToggleSnapshot(preset);

            await saveMeta(name, idx, meta);
            toastr.success(L('Configuration updated'));
            refreshActivePresetUI(name);
        } else if (isPromptDeltaProfile(profile)) {
            // 派生 profile：重新基于主 profile 生成差异
            const base = meta.profiles.find((b): b is PromptBaseProfile =>
                isPromptBaseProfile(b) && b.id === profile.baseId);
            if (!base) {
                toastr.warning(L('Base profile not found, cannot update derived configuration'));
                return;
            }
            profile.changes = buildDeltaChanges(preset, base);

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
        const base = meta.profiles.find((b): b is PromptBaseProfile =>
            isPromptBaseProfile(b) && b.id === String(profileId));
        if (!base) return;

        const deltaName = await Popup.show.input(L('Derived profile name:'), '');
        if (!deltaName) return;

        const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
        profiles.push({
            formatVersion: 2,
            kind: 'prompt_delta',
            id: Date.now().toString() + Math.floor(Math.random() * 1000),
            name: deltaName,
            baseId: base.id,
            changes: [], // 初始为空数组：与主 profile 完全相同，后续通过「覆盖」更新差异
        });

        meta.profiles = profiles;
        await saveMeta(name, idx, meta);
        toastr.success(L('Derived profile created'));

        // Refresh UI
        const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
        dialog.html($(newHtml).html());
        dialog.find('#preset_cards_search').trigger('input');
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
        const profile = meta.profiles.find(p => p.id === String(profileId));
        if (!profile) return;

        if (isPromptDeltaProfile(profile)) {
            // 派生：回退到其父（main profile）；若无父则回退到隐藏默认
            const base = meta.profiles.find((b): b is PromptBaseProfile =>
                isPromptBaseProfile(b) && b.id === profile.baseId);
            if (base) {
                applyBaseProfile(preset, base);
                profile.changes = [];
            } else {
                if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                    toastr.warning(L('No default baseline available'));
                    return;
                }
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
        } else if (isPromptBaseProfile(profile)) {
            // 主 profile：回退到隐藏默认基准
            if (!meta.defaultSnapshot || meta.defaultSnapshot.length === 0) {
                toastr.warning(L('No default baseline available'));
                return;
            }
            profile.prompts = structuredClone(meta.defaultSnapshot);
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
        } else {
            toastr.warning(L('This profile type cannot be reset'));
            return;
        }

        // Refresh UI
        const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
        dialog.html($(newHtml).html());
        dialog.find('#preset_cards_search').trigger('input');
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
        const profile = meta.profiles.find(p => p.id === String(profileId));

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
    dialog.on('click', '.preset_card_profile_export', function (e) {
        e.stopPropagation();
        const row = $(this).closest('.preset_card_profile_row');
        const profileId = row.data('profile-id');
        const card = $(this).closest('.preset_card');
        const preset = openai_settings[card.data('preset-index') as number] as Preset;

        const meta = readMeta(preset);
        const profile = meta.profiles.find(p => p.id === String(profileId));
        if (!profile) return;

        let data: string;
        if (isPromptBaseProfile(profile)) {
            data = JSON.stringify({
                kind: profile.kind,
                formatVersion: profile.formatVersion,
                prompts: profile.prompts,
            }, null, 4);
        } else if (isPromptDeltaProfile(profile)) {
            data = JSON.stringify({
                kind: profile.kind,
                formatVersion: profile.formatVersion,
                baseId: profile.baseId,
                changes: profile.changes,
            }, null, 4);
        } else {
            data = JSON.stringify(profile.settings, null, 4);
        }
        download(data, `${profile.name}.json`, 'application/json');
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

                let defaultName = file.name.replace(/\.json$/i, '');
                const profileName = await Popup.show.input(L('Configuration name:'), defaultName, defaultName);
                if (!profileName) return;

                const preset = openai_settings[idx] as Preset;
                const meta = readMeta(preset);
                const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];
                const newId = Date.now().toString() + Math.floor(Math.random() * 1000);

                if (parsed && parsed.kind === 'prompt_base' && Array.isArray(parsed.prompts)) {
                    profiles.push({
                        formatVersion: 2,
                        kind: 'prompt_base',
                        id: newId,
                        name: profileName,
                        prompts: parsed.prompts,
                    });
                } else if (parsed && parsed.kind === 'prompt_delta' && Array.isArray(parsed.changes)) {
                    const baseId = typeof parsed.baseId === 'string' ? parsed.baseId : '';
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
                        toastr.warning(L('Base profile not found for this imported derived configuration'));
                    }
                } else {
                    profiles.push({
                        id: newId,
                        name: profileName,
                        settings: parsed
                    });
                }

                meta.profiles = profiles;
                await saveMeta(name, idx, meta);
                toastr.success(L('Configuration saved'));

                const newHtml = await renderExtensionTemplateAsync(EXTENSION_NAME, 'cards', getCardsTemplateContext());
                dialog.html($(newHtml).html());
                applyCachedBackgrounds(dialog);
                dialog.find('#preset_cards_search').trigger('input');
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
                const profile = meta.profiles.find(p => p.id === String(profileId));
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
