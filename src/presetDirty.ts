// 行级 dirty / modified 判定的纯判定与 DOM 刷新。
// 所有函数都以 row/dialog + 缓冲 Map 为参数，不依赖 presetCards 闭包。

import type { PromptEditBuffer } from './presetBuffers.js';
import { bufferKey } from './presetBuffers.js';
import { promptFieldsEqual } from './promptToggle.js';

// 重渲染后按当前缓冲恢复 dirty 高亮：保存/加载 profile/reset 已清缓冲，自然不恢复；
// 未清缓冲的路径（如「保存 base profile」后继续编辑）则按 bufferKey 逐条还原。
export function applyDirtyHighlights(dialog: JQuery<HTMLElement>, sessionEdits: Map<string, PromptEditBuffer>, pendingToggles: Map<string, boolean>): void {
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
function rowHasBufferedChanges(row: JQuery<HTMLElement>, sessionEdits: Map<string, PromptEditBuffer>, pendingToggles: Map<string, boolean>): boolean {
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
export function syncRowModified(row: JQuery<HTMLElement>, sessionEdits: Map<string, PromptEditBuffer>, pendingToggles: Map<string, boolean>): void {
    if (rowHasBufferedChanges(row, sessionEdits, pendingToggles)) {
        row.addClass('modified');
        row.find('.preset_card_profile_save_btn').removeClass('hidden');
    } else {
        row.removeClass('modified');
        row.find('.preset_card_profile_save_btn').addClass('hidden');
    }
}
