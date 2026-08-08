// 自包含的 SillyTavern 模块声明 —— 只覆盖 preset-cards 实际用到的 API。
// 仓库克隆到任何位置都能通过类型检查,无需指向本地 ST 源码树。

declare module '@sillytavern/script' {
    export function getRequestHeaders(options?: { omitContentType?: boolean }): Record<string, string>;
}

declare module '@sillytavern/scripts/extensions' {
    export function renderExtensionTemplateAsync(
        extensionName: string,
        templateId: string,
        templateData?: Record<string, any>,
        sanitize?: boolean,
        localize?: boolean,
    ): Promise<string>;
}

declare module '@sillytavern/scripts/i18n' {
    export function t(strings: TemplateStringsArray, ...values: unknown[]): string;
}

declare module '@sillytavern/scripts/utils' {
    export function download(content: string | Blob, filename: string, contentType?: string): void;
}

declare module '@sillytavern/scripts/events' {
    export const event_types: {
        PRESET_DELETED: string;
        [key: string]: string;
    };
    export const eventSource: {
        emit(event: string, ...args: unknown[]): Promise<boolean>;
        [key: string]: unknown;
    };
}

declare module '@sillytavern/scripts/slash-commands/SlashCommand' {
    export class SlashCommand {
        static fromProps(props: {
            name: string;
            callback: (...args: unknown[]) => Promise<unknown> | unknown;
            helpString?: string;
            [key: string]: unknown;
        }): SlashCommand;
    }
}

declare module '@sillytavern/scripts/slash-commands/SlashCommandParser' {
    export class SlashCommandParser {
        static addCommandObject(command: unknown): void;
    }
}

declare module '@sillytavern/scripts/popup' {
    export const POPUP_TYPE: {
        TEXT: string;
        CONFIRM: string;
        [key: string]: string;
    };
    export const POPUP_RESULT: {
        AFFIRMATIVE: string;
        NEGATIVE: string;
        [key: string]: string;
    };
    export function callGenericPopup(
        content: JQuery<HTMLElement> | string,
        type: string,
        inputValue?: string,
        popupOptions?: Record<string, any>,
    ): Promise<string | null>;
    export class Popup {
        static show: Record<string, (...args: any[]) => Promise<any>>;
    }
}

declare module '@sillytavern/scripts/openai' {
    /** 每一项: [selector, setting_name, is_checkbox, is_connection] */
    export const settingsToUpdate: Record<string, [string, string, boolean, boolean]>;
    export const chat_completion_sources: Record<string, string>;
    export let openai_setting_names: Record<string, number>;
    export let openai_settings: Record<string, unknown>[];
    export const oai_settings: {
        preset_settings_openai: string | null;
        extensions?: Record<string, unknown>;
        [key: string]: unknown;
    };
}
