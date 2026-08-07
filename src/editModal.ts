import { openai_settings } from '@sillytavern/scripts/openai';
import { renderExtensionTemplateAsync } from '@sillytavern/scripts/extensions';
import { POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '@sillytavern/scripts/popup';
import { t } from '@sillytavern/scripts/i18n';
import { AVAILABLE_MODELS, EXTENSION_NAME, LOGO_BASE } from './constants.js';
import { readMeta, saveMeta, type Preset } from './meta.js';
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
