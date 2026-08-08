import { t } from '@sillytavern/scripts/i18n';
import { SlashCommand } from '@sillytavern/scripts/slash-commands/SlashCommand';
import { SlashCommandParser } from '@sillytavern/scripts/slash-commands/SlashCommandParser';
import { openPresetCards } from './presetCards.js';

export function refresh(): void {
    location.reload();
}

export function init(): void {
    const buttonHtml = `
        <div id="preset_cards_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-grip extensionsMenuExtensionButton"></div>` +
        t`Preset Cards` +
        '</div>';
    $('#token_counter_wand_container').append(buttonHtml);
    $('#preset_cards_button').on('click', openPresetCards);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'presetcards',
        callback: async () => {
            await openPresetCards();
            return '';
        },
        helpString: 'Opens the preset cards view for Chat Completion presets.',
    }));
}
