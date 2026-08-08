import { openai_settings } from '@sillytavern/scripts/openai';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '@sillytavern/scripts/popup';
import { t } from '@sillytavern/scripts/i18n';
import { AVAILABLE_MODELS, EXTENSION_NAME, LOGO_BASE } from './constants.js';
import { readMeta, saveMeta, type Preset, type PromptFields } from './meta.js';
import { findPromptInPreset } from './promptToggle.js';
import { L } from './i18n.js';

/**
 * Open the edit modal for a preset.
 * @param onSaved  callback after saving so the card grid can refresh
 */
export async function openEditModal(presetName: string, presetIndex: number, onSaved?: () => void): Promise<void> {
    const preset = openai_settings[presetIndex] as Preset | undefined;
    if (!preset) return;

    const meta = readMeta(preset);

    // Build available models with selection state
    const availableModels = AVAILABLE_MODELS.map(m => ({
        ...m,
        logo: LOGO_BASE + m.logo,
        selected: meta.models.includes(m.id),
    }));

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'edit', {
        presetName,
        description: meta.description,
        bgImage: meta.bgImage,
        availableModels,
        i18n: {
            descTitle: L('Description'),
            descPlaceholder: L('Add a short description for this preset...'),
            modelsTitle: L('Applicable Models'),
            bgImageTitle: L('Background Image URL'),
            bgImagePlaceholder: L('e.g., https://example.com/bg.jpg'),
        }
    });

    const dialog = $(html);

    // Toggle model chips
    dialog.find('.preset_edit_model_option').on('click', function () {
        $(this).toggleClass('active');
    });

    const result = await callGenericPopup(dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        allowVerticalScrolling: true,
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    // Collect values
    const newDesc = dialog.find('#preset_edit_desc').val()?.toString().trim() || '';
    const newBgImage = dialog.find('#preset_edit_bg_image').val()?.toString().trim() || '';
    const newModels = dialog.find('.preset_edit_model_option.active').map(function () {
        return $(this).data('model-id') as string;
    }).get();

    await saveMeta(presetName, presetIndex, { description: newDesc, models: newModels, bgImage: newBgImage, profiles: meta.profiles, defaultSnapshot: meta.defaultSnapshot });
    toastr.success(t`Preset updated`);
    if (onSaved) onSaved();
}

// 打开单个 prompt 的值编辑弹窗，返回编辑后的字段（仅含变化项）；未变化 / 取消返回 null。
export async function openPromptEditPopup(preset: Preset, identifier: string): Promise<PromptFields | null> {
    const prompt = findPromptInPreset(preset, identifier);
    if (!prompt) return null;

    const isMarker = !!prompt.marker;

    const container = $('<div class="preset_cards_prompt_edit_form"></div>');
    container.append($('<div class="preset_cards_prompt_edit_title"></div>').text(L('Edit prompt')));

    if (isMarker) {
        container.append($('<div class="preset_cards_prompt_edit_marker_notice"></div>')
            .text(L('This is a marker prompt. Its content is managed by SillyTavern and cannot be edited here.')));
    }

    const nameWrap = $('<div class="preset_edit_field"></div>');
    nameWrap.append($('<label></label>').text(L('Name')));
    const nameInput = $('<input type="text">').val(prompt.name ?? '');
    nameWrap.append(nameInput);

    // 位置与角色：两个窄控件并排一行，窄屏自动换行
    const rowWrap = $('<div class="preset_cards_prompt_edit_row"></div>');

    const roleWrap = $('<div class="preset_edit_field"></div>');
    roleWrap.append($('<label></label>').text(L('Role')));
    const roleSelect = $('<select class="text_pole"></select>');
    for (const [value, label] of [['system', L('System')], ['user', L('User')], ['assistant', L('AI Assistant')]] as [string, string][]) {
        const option = $('<option></option>').attr('value', value).text(label);
        if (value === (prompt.role ?? 'system')) option.attr('selected', 'selected');
        roleSelect.append(option);
    }
    roleWrap.append(roleSelect);

    const positionWrap = $('<div class="preset_edit_field"></div>');
    positionWrap.append($('<label></label>').text(L('Position')));
    const positionSelect = $('<select class="text_pole"></select>');
    // 与 ST INJECTION_POSITION 一致（PromptManager.js:37-40）：0=Relative, 1=In-chat
    for (const [value, label] of [['0', L('Relative')], ['1', L('In-chat')]] as [string, string][]) {
        const option = $('<option></option>').attr('value', value).text(label);
        if (value === String(prompt.injection_position ?? 0)) option.attr('selected', 'selected');
        positionSelect.append(option);
    }
    positionWrap.append(positionSelect);

    rowWrap.append(roleWrap);
    rowWrap.append(positionWrap);

    const contentWrap = $('<div class="preset_edit_field"></div>');
    contentWrap.append($('<label></label>').text(L('Content')));
    const contentInput = $('<textarea></textarea>').val(prompt.content ?? '');
    if (isMarker) {
        contentInput.prop('disabled', true);
    }
    contentWrap.append(contentInput);

    container.append(nameWrap);
    container.append(rowWrap);
    container.append(contentWrap);

    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        allowVerticalScrolling: true,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    // 只返回与当前值不同的字段，避免把默认值写进 profile
    const fields: PromptFields = {};
    const role = String(roleSelect.val() ?? 'system');
    const name = String(nameInput.val() ?? '');
    const content = String(contentInput.val() ?? '');
    const position = Number(positionSelect.val() ?? 0);

    if (role !== (prompt.role ?? 'system')) fields.role = role;
    if (name !== (prompt.name ?? '')) fields.name = name;
    if (!isMarker && content !== (prompt.content ?? '')) fields.content = content;
    if (position !== (prompt.injection_position ?? 0)) fields.injection_position = position;

    return Object.keys(fields).length > 0 ? fields : null;
}
