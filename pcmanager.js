import { saveSettingsDebounced } from '/script.js';
import { promptManager } from '/scripts/openai.js';
import { POPUP_TYPE, callGenericPopup, POPUP_RESULT, Popup } from '/scripts/popup.js';
import { getSortableDelay, escapeHtml } from '/scripts/utils.js';

class PCManagerCore {
    constructor() {
        this.transactionalState = {
            prompts: [],
            promptOrder: [],
        };
        this.originalState = {
            prompts: [],
            promptOrder: [],
        };
        this.diffs = [];
        this.isOpen = false;
        this.dialog = null;
        this.activeCharacter = null;
        this.editTargetId = null;
    }

    cloneState() {
        if (!promptManager || !promptManager.serviceSettings) return false;

        if (this.diffs && this.diffs.length > 0) {
            toastr.info('您还有未提交的更改 (You have uncommitted changes)');
            return true;
        }

        this.activeCharacter = promptManager.activeCharacter;
        const livePrompts = promptManager.serviceSettings.prompts || [];
        const liveOrder = promptManager.getPromptOrderForCharacter(this.activeCharacter) || [];

        this.transactionalState = {
            prompts: structuredClone(livePrompts),
            promptOrder: structuredClone(liveOrder),
        };
        this.originalState = {
            prompts: structuredClone(livePrompts),
            promptOrder: structuredClone(liveOrder),
        };
        this.diffs = [];
        this.editTargetId = null;
        return true;
    }

    extractMacros(text) {
        if (!text) return [];
        const regex = /\{\{\/\/(.*?)\}\}/g;
        const macros = [];
        let match;
        while ((match = regex.exec(text)) !== null) {
            macros.push(match[1].trim());
        }
        return macros;
    }

    extractVars(text) {
        if (!text) return [];
        const regex = /\{\{setvar::(.*?)::([\s\S]*?)\}\}|\{\{getvar::([\s\S]*?)\}\}/g;
        const vars = [];
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (match[1] !== undefined) {
                vars.push({ type: 'setvar', name: match[1].trim(), value: match[2].trim() });
            } else if (match[3] !== undefined) {
                vars.push({ type: 'getvar', name: match[3].trim() });
            }
        }
        return vars;
    }

    computeDiffs() {
        this.diffs = [];
        const origMap = new Map(this.originalState.prompts.map(p => [p.identifier, p]));
        const currMap = new Map(this.transactionalState.prompts.map(p => [p.identifier, p]));
        const origOrderMap = new Map(this.originalState.promptOrder.map((o, i) => [o.identifier, { index: i, enabled: o.enabled }]));
        const currOrderMap = new Map(this.transactionalState.promptOrder.map((o, i) => [o.identifier, { index: i, enabled: o.enabled }]));

        for (const orderItem of this.transactionalState.promptOrder) {
            const id = orderItem.identifier;
            const origO = origOrderMap.get(id);
            const currO = currOrderMap.get(id);
            const origP = origMap.get(id);
            const currP = currMap.get(id);

            if (!origO || !origP) {
                this.diffs.push({ type: 'added', id, desc: `Added prompt: ${currP?.name || id}` });
                continue;
            }
            if (origO.enabled !== currO.enabled) {
                this.diffs.push({ type: 'toggle', id, desc: `${currO.enabled ? 'Enabled' : 'Disabled'}: ${currP.name}` });
            }
            if (origO.index !== currO.index) {
                this.diffs.push({ type: 'reorder', id, desc: `Moved ${currP.name} from pos ${origO.index + 1} to ${currO.index + 1}` });
            }
            if (JSON.stringify(origP) !== JSON.stringify(currP)) {
                this.diffs.push({ type: 'modify', id, desc: `Modified parameters of: ${currP.name}` });
            }
        }

        for (const origOrder of this.originalState.promptOrder) {
            if (!currOrderMap.has(origOrder.identifier)) {
                const origP = origMap.get(origOrder.identifier);
                this.diffs.push({ type: 'delete', id: origOrder.identifier, desc: `Deleted prompt: ${origP?.name || origOrder.identifier}` });
            }
        }
    }

    async renderUI() {
        const container = document.createElement('div');
        container.className = 'pc-manager-container';
        container.innerHTML = `
            <div class="pc-layout">
                <div class="pc-left-pane">
                    <div class="pc-header">
                        <h2>PCManager <span style="font-size: 0.8rem; font-weight: normal; color: gray;">Transactional Mode</span></h2>
                        <div class="pc-header-controls">
                            <button id="pc-btn-view-staged" class="pc-top-action-btn" title="View Staged Changes"><i class="fa-solid fa-list-check"></i> <span>(0)</span></button>
                            <button id="pc-btn-commit" class="pc-top-action-btn pc-btn-commit" title="Commit Changes"><i class="fa-solid fa-check"></i> Commit</button>
                            <button id="pc-btn-close" class="pc-top-action-btn" title="Close"><i class="fa-solid fa-times"></i></button>
                        </div>
                    </div>
                    <div class="pc-search-bar" style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1));">
                        <input type="text" id="pc-search-input" class="pc-form-control" placeholder="Search prompts by name or content..." style="width: 100%; box-sizing: border-box;" />
                    </div>
                    <div class="pc-prompt-list" id="pc-prompt-list"></div>
                </div>
                <div class="pc-right-pane">
                    <div class="pc-diff-area" id="pc-diff-area"></div>
                    <div class="pc-edit-area" id="pc-edit-area" style="display:none;"></div>
                </div>
            </div>
        `;
        this.dialog = $(container);
        this.updateListUI();
        this.updateRightPane();

        this.dialog.find('#pc-search-input').on('input', () => {
            this.updateListUI();
        });

        this.dialog.find('#pc-btn-commit').on('click', () => this.commitState());
        this.dialog.find('#pc-btn-close').on('click', () => {
            const popupInstance = Popup.util?.popups?.find(p => p.dlg && p.dlg.contains(this.dialog[0]));
            if (popupInstance) {
                popupInstance.complete(POPUP_RESULT.CANCELLED);
            } else {
                this.dialog.closest('.popup').find('.popup-controls .cancel').trigger('click');
            }
        });
        this.dialog.find('#pc-btn-view-staged').on('click', () => {
            this.editTargetId = null;
            this.updateRightPane();
        });

        await callGenericPopup(this.dialog, POPUP_TYPE.TEXT, '', {
            transparent: true,
            okButton: false,
            allowVerticalScrolling: true,
            onClose: () => { this.isOpen = false; }
        });
    }

    updateListUI() {
        const listEl = this.dialog.find('#pc-prompt-list');
        const searchTerm = this.dialog.find('#pc-search-input').val()?.toLowerCase() || '';
        const isSearching = searchTerm.length > 0;
        listEl.empty();

        const globalVars = {};
        let itemIndex = 1;

        for (const orderItem of this.transactionalState.promptOrder) {
            const prompt = this.transactionalState.prompts.find(p => p.identifier === orderItem.identifier);
            if (!prompt) {
                itemIndex++;
                continue;
            }

            const currentIndex = itemIndex++;

            if (isSearching) {
                const nameMatch = prompt.name?.toLowerCase().includes(searchTerm);
                const contentMatch = (prompt.content || prompt.prompt || '').toLowerCase().includes(searchTerm);
                if (!nameMatch && !contentMatch) continue;
            }

            const macros = this.extractMacros(prompt.content || prompt.prompt || '');
            const macroHtml = macros.map(m => {
                const displayStr = m.length > 20 ? m.substring(0, 20) + '...' : m;
                return `<span class="pc-macro-badge" title="${escapeHtml(m)}"><i class="fa-solid fa-comment-dots"></i> ${escapeHtml(displayStr)}</span>`;
            }).join('');

            const vars = this.extractVars(prompt.content || prompt.prompt || '');
            let varHtmlElements = [];

            for (const v of vars) {
                if (v.type === 'setvar') {
                    if (orderItem.enabled) {
                        globalVars[v.name] = v.value;
                    }
                    varHtmlElements.push(
                        `<span class="pc-var-badge pc-setvar-badge" data-type="setvar" data-varname="${escapeHtml(v.name)}" data-varvalue="${escapeHtml(v.value)}" title="${escapeHtml(v.value)}" style="cursor: pointer; font-size: 0.75rem; background: rgba(16, 185, 129, 0.2); color: #34d399; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-cube"></i> ${escapeHtml(v.name)}</span>`
                    );
                } else if (v.type === 'getvar') {
                    const currentValue = globalVars[v.name];
                    const isUnset = currentValue === undefined;
                    const displayValue = isUnset ? 'Unset' : currentValue;
                    const bgClass = isUnset ? 'rgba(239, 68, 68, 0.2)' : 'rgba(59, 130, 246, 0.2)';
                    const textClass = isUnset ? '#f87171' : '#60a5fa';

                    varHtmlElements.push(
                        `<span class="pc-var-badge pc-getvar-badge" data-type="getvar" data-varname="${escapeHtml(v.name)}" title="${escapeHtml(displayValue)}" style="cursor: pointer; font-size: 0.75rem; background: ${bgClass}; color: ${textClass}; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-cube"></i> ${escapeHtml(v.name)}</span>`
                    );
                }
            }
            const setVarHtml = varHtmlElements.join('');

            const card = document.createElement('div');
            card.className = `pc-prompt-card ${orderItem.enabled ? '' : 'disabled'}`;
            card.dataset.id = prompt.identifier;
            card.innerHTML = `
                <div class="pc-card-index" style="font-family: 'JetBrains Mono', 'Courier New', Courier, monospace; font-size: 1.2rem; font-weight: 800; color: var(--SmartThemeBodyColor); opacity: 0.15; min-width: 32px; text-align: center; margin-right: 4px; pointer-events: none; user-select: none;">${String(currentIndex).padStart(2, '0')}</div>
                <div class="pc-card-header">
                    <span class="pc-card-title">
                        <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px; max-width: 100%;">
                            <span class="pc-card-name" style="flex-shrink: 0;">${escapeHtml(prompt.name)}</span>
                            ${setVarHtml}
                        </div>
                        <small class="pc-card-id">#${escapeHtml(prompt.identifier)}</small>
                    </span>
                    <span class="pc-role-badge role-${prompt.role || 'system'}">${escapeHtml(prompt.role || 'system')}</span>
                </div>
                <div class="pc-card-macros">${macroHtml}</div>
                <div class="pc-card-controls">
                    <button class="pc-btn-toggle" data-id="${prompt.identifier}" title="Toggle Prompt">${orderItem.enabled ? '<i class="fa-solid fa-toggle-on"></i> On' : '<i class="fa-solid fa-toggle-off"></i> Off'}</button>
                </div>
            `;
            listEl.append(card);
        }

        // Initialize Sortable
        if (listEl.sortable('instance')) listEl.sortable('destroy');
        if (!isSearching) {
            listEl.sortable({
                delay: getSortableDelay(),
                animation: 150,
                ghostClass: 'pc-sortable-ghost',
                dragClass: 'pc-sortable-drag',
                start: () => listEl.addClass('is-dragging'),
                stop: () => setTimeout(() => listEl.removeClass('is-dragging'), 50),
                onStart: () => listEl.addClass('is-dragging'),
                onEnd: () => setTimeout(() => listEl.removeClass('is-dragging'), 50),
                update: (event, ui) => {
                    const newOrderIds = listEl.sortable('toArray', { attribute: 'data-id' });
                    this.transactionalState.promptOrder = newOrderIds.map(id => {
                        return this.transactionalState.promptOrder.find(o => o.identifier === id);
                    }).filter(Boolean);
                    this.updateRightPane();
                }
            });
        }

        // Event Listeners
        listEl.find('.pc-btn-toggle').on('click', (e) => {
            e.stopPropagation();
            const id = $(e.currentTarget).data('id');
            const item = this.transactionalState.promptOrder.find(o => o.identifier === id);
            if (item) {
                item.enabled = !item.enabled;
                this.updateListUI();
                this.updateRightPane();
            }
        });

        listEl.find('.pc-var-badge').on('click', (e) => {
            e.stopPropagation();
            const badge = $(e.currentTarget);
            const card = badge.closest('.pc-prompt-card');
            const id = card.data('id');
            const type = badge.data('type');
            const varName = badge.data('varname');
            const varValue = badge.data('varvalue');

            this.editTargetId = id;
            this.updateRightPane();

            const textarea = this.dialog.find('#pc-edit-content')[0];
            if (textarea) {
                const text = textarea.value;
                const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                let regex;
                if (type === 'setvar') {
                    regex = new RegExp(`(\\{\\{setvar::\\s*${escapeRegExp(String(varName))}\\s*::\\s*)(${escapeRegExp(String(varValue))})(\\s*\\}\\})`);
                } else {
                    regex = new RegExp(`(\\{\\{getvar::\\s*)(${escapeRegExp(String(varName))})(\\s*\\}\\})`);
                }

                const match = regex.exec(text);
                if (match) {
                    const valueStartIndex = match.index + match[1].length;
                    const valueEndIndex = valueStartIndex + match[2].length;
                    textarea.focus();
                    textarea.setSelectionRange(valueStartIndex, valueEndIndex);
                }
            }
        });

        listEl.find('.pc-prompt-card').on('click', (e) => {
            if (listEl.hasClass('is-dragging')) return;
            this.editTargetId = $(e.currentTarget).data('id');
            this.updateRightPane();
        });
    }

    updateRightPane() {
        this.computeDiffs();
        const diffEl = this.dialog.find('#pc-diff-area');
        const editEl = this.dialog.find('#pc-edit-area');
        const commitBtn = this.dialog.find('#pc-btn-commit');
        const stagedBtn = this.dialog.find('#pc-btn-view-staged span');

        // Update Commit Button
        if (this.diffs.length === 0) {
            commitBtn.prop('disabled', true);
            stagedBtn.text('(0)');
        } else {
            commitBtn.prop('disabled', false);
            stagedBtn.text(`(${this.diffs.length})`);
        }

        // View Router
        if (this.editTargetId) {
            diffEl.hide();
            editEl.show();
            this.renderEditForm();
        } else {
            editEl.hide();
            diffEl.show();
            this.renderDiffList();
        }
    }

    renderDiffList() {
        const diffEl = this.dialog.find('#pc-diff-area');
        if (this.diffs.length === 0) {
            diffEl.html('<div style="opacity: 0.5; padding: 20px; text-align: center;">No staged changes.</div>');
            return;
        }

        let html = '<h3>Staged Changes</h3><ul class="pc-diff-list">';
        for (const diff of this.diffs) {
            html += `<li class="pc-diff-item diff-${diff.type}">
                <span class="pc-diff-desc">${escapeHtml(diff.desc)}</span>
                <button class="pc-btn-undo" data-id="${diff.id}" data-type="${diff.type}"><i class="fa-solid fa-rotate-left"></i> Undo</button>
            </li>`;
        }
        html += '</ul>';
        diffEl.html(html);

        diffEl.find('.pc-btn-undo').on('click', (e) => {
            const id = $(e.currentTarget).data('id');
            const type = $(e.currentTarget).data('type');
            this.undoChange(id, type);
        });
    }

    undoChange(id, type) {
        const origP = this.originalState.prompts.find(p => p.identifier === id);
        const origO = this.originalState.promptOrder.find(o => o.identifier === id);

        if (type === 'modify' || type === 'added' || type === 'delete') {
            const tIdx = this.transactionalState.prompts.findIndex(p => p.identifier === id);
            if (origP) {
                if (tIdx > -1) this.transactionalState.prompts[tIdx] = structuredClone(origP);
                else this.transactionalState.prompts.push(structuredClone(origP));
            } else if (tIdx > -1) {
                this.transactionalState.prompts.splice(tIdx, 1); // Was added, now revert (delete)
            }
        }

        if (type === 'reorder' || type === 'toggle' || type === 'added' || type === 'delete') {
            const currList = this.transactionalState.promptOrder;
            if (origO) {
                // Restore original index and enabled state
                const currIdx = currList.findIndex(o => o.identifier === id);
                if (currIdx > -1) currList.splice(currIdx, 1);
                const origIdx = this.originalState.promptOrder.findIndex(o => o.identifier === id);
                currList.splice(origIdx, 0, structuredClone(origO));
            } else {
                const currIdx = currList.findIndex(o => o.identifier === id);
                if (currIdx > -1) currList.splice(currIdx, 1);
            }
        }

        this.updateListUI();
        this.updateRightPane();
    }

    renderEditForm() {
        const editEl = this.dialog.find('#pc-edit-area');
        const prompt = this.transactionalState.prompts.find(p => p.identifier === this.editTargetId);

        if (!prompt) {
            this.editTargetId = null;
            this.updateRightPane();
            return;
        }

        const CORE_IDS = ['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'dialogueExamples'];
        const isCore = CORE_IDS.includes(prompt.identifier);
        const isHistory = prompt.identifier === 'chatHistory';

        editEl.html(`
            <div class="pc-editor-header">
                <h3>Editing: ${escapeHtml(prompt.name)}</h3>
            </div>
            ${(isCore || isHistory) ? '<div style="color: #ef4444; font-size: 0.8rem; margin-bottom: 12px; padding: 8px; background: rgba(239, 68, 68, 0.1); border-radius: 6px;"><i class="fa-solid fa-triangle-exclamation"></i> 此条目为系统关键设定，部分内容已被锁定以防破坏内部注入逻辑。</div>' : ''}
            <div class="pc-form-group">
                <label>Name</label>
                <input type="text" class="pc-form-control" id="pc-edit-name" value="${escapeHtml(prompt.name)}">
            </div>
            <div class="pc-form-group">
                <label>Role</label>
                <select class="pc-form-control" id="pc-edit-role" ${isHistory ? 'disabled' : ''}>
                    <option value="system" ${prompt.role === 'system' ? 'selected' : ''}>System</option>
                    <option value="user" ${prompt.role === 'user' ? 'selected' : ''}>User</option>
                    <option value="assistant" ${prompt.role === 'assistant' ? 'selected' : ''}>Assistant</option>
                </select>
            </div>
            <div class="pc-form-group">
                <label>Injection Position</label>
                <select class="pc-form-control" id="pc-edit-inj-pos" ${isHistory ? 'disabled' : ''}>
                    <option value="0" ${prompt.injection_position === 0 ? 'selected' : ''}>Before Main Prompt</option>
                    <option value="1" ${prompt.injection_position === 1 ? 'selected' : ''}>After Main Prompt</option>
                    <option value="2" ${prompt.injection_position === 2 ? 'selected' : ''}>In Chat (Absolute Depth)</option>
                </select>
            </div>
            <div class="pc-form-group" id="pc-edit-inj-depth-grp" style="display: ${prompt.injection_position === 2 ? 'flex' : 'none'};">
                <label>Injection Depth (@)</label>
                <input type="number" class="pc-form-control" id="pc-edit-inj-depth" value="${prompt.injection_depth ?? 4}" min="0" ${isHistory ? 'disabled' : ''}>
            </div>
            <div class="pc-form-group">
                <label>Prompt Text (Supports Macros)</label>
                <textarea class="pc-form-control" id="pc-edit-content" rows="10" ${(isCore || isHistory) ? 'disabled' : ''}>${escapeHtml(prompt.content || prompt.prompt || '')}</textarea>
            </div>
            <div class="pc-editor-footer" style="display: flex; gap: 8px; justify-content: flex-start; margin-top: 16px;">
                <button class="pc-btn-icon pc-btn-icon-primary" id="pc-btn-save-edit" title="Save to Staging"><i class="fa-solid fa-save"></i> 保存</button>
                <button class="pc-btn-icon pc-btn-close-edit" title="Close Editor"><i class="fa-solid fa-times"></i> 关闭</button>
            </div>
        `);

        editEl.find('#pc-edit-inj-pos').on('change', function () {
            if ($(this).val() == '2') {
                editEl.find('#pc-edit-inj-depth-grp').show();
            } else {
                editEl.find('#pc-edit-inj-depth-grp').hide();
            }
        });

        editEl.find('.pc-btn-close-edit').on('click', () => {
            this.editTargetId = null;
            this.updateRightPane();
        });

        editEl.find('#pc-btn-save-edit').on('click', () => {
            prompt.name = editEl.find('#pc-edit-name').val();

            if (!isHistory) {
                prompt.role = editEl.find('#pc-edit-role').val();
                prompt.injection_position = Number(editEl.find('#pc-edit-inj-pos').val());
                if (prompt.injection_position === 2) {
                    prompt.injection_depth = Number(editEl.find('#pc-edit-inj-depth').val());
                } else {
                    delete prompt.injection_depth;
                }
            }

            if (!isCore && !isHistory) {
                const text = editEl.find('#pc-edit-content').val();
                if (prompt.prompt !== undefined) prompt.prompt = text;
                else prompt.content = text;
            }

            this.editTargetId = null;
            this.updateListUI();
            this.updateRightPane();
        });
    }

    async commitState() {
        if (this.diffs.length === 0) return;

        promptManager.serviceSettings.prompts = structuredClone(this.transactionalState.prompts);

        const characterList = promptManager.serviceSettings.prompt_order.find(list => String(list.character_id) === String(this.activeCharacter?.id));
        if (characterList) {
            characterList.order = structuredClone(this.transactionalState.promptOrder);
        } else {
            promptManager.addPromptOrderForCharacter(this.activeCharacter, this.transactionalState.promptOrder);
        }

        saveSettingsDebounced();
        promptManager.render();
        toastr.success('PCManager: Changes committed.');

        this.diffs = [];
        this.cloneState();
        this.updateListUI();
        this.updateRightPane();
    }
}

const pcManagerCore = new PCManagerCore();

export async function openPCManager() {
    if (!pcManagerCore.cloneState()) return;
    pcManagerCore.isOpen = true;
    await pcManagerCore.renderUI();
}
