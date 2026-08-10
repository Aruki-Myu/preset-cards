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
        this.showOverview = false;
        this.macroMode = false;
        this.mobileShowRight = false;
    }

    cloneState() {
        if (!promptManager || !promptManager.serviceSettings) return false;

        if (this.diffs && this.diffs.length > 0) {
            toastr.info('您还有未提交的更改');
            return true;
        }

        this.activeCharacter = promptManager.activeCharacter || { id: promptManager.configuration?.promptOrder?.dummyId || 100000 };
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
        this.showOverview = false;
        this.macroMode = false;
        this.mobileShowRight = false;
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
        const vars = [];
        let match;
        const setRegex = /\{\{setvar::(.*?)::([\s\S]*?)\}\}/g;
        while ((match = setRegex.exec(text)) !== null) {
            vars.push({ type: 'setvar', name: match[1].trim(), value: match[2].trim() });
        }
        const addRegex = /\{\{addvar::(.*?)::([\s\S]*?)\}\}/g;
        while ((match = addRegex.exec(text)) !== null) {
            vars.push({ type: 'addvar', name: match[1].trim(), value: match[2].trim() });
        }
        const getRegex = /\{\{getvar::([\s\S]*?)\}\}/g;
        while ((match = getRegex.exec(text)) !== null) {
            vars.push({ type: 'getvar', name: match[1].trim() });
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
                this.diffs.push({ type: 'added', id, desc: `新增条目: ${currP?.name || id}` });
                continue;
            }
            if (origO.enabled !== currO.enabled) {
                this.diffs.push({ type: 'toggle', id, desc: `${currO.enabled ? '启用' : '禁用'}条目: ${currP?.name || id}` });
            }
            if (origO.index !== currO.index) {
                this.diffs.push({ type: 'reorder', id, desc: `移动条目 "${currP?.name || id}" (位置 ${origO.index + 1} -> ${currO.index + 1})` });
            }
            if (JSON.stringify(origP) !== JSON.stringify(currP)) {
                this.diffs.push({ type: 'modify', id, desc: `修改条目内容或参数: ${currP?.name || id}` });
            }
        }

        for (const origOrder of this.originalState.promptOrder) {
            if (!currOrderMap.has(origOrder.identifier)) {
                const origP = origMap.get(origOrder.identifier);
                this.diffs.push({ type: 'delete', id: origOrder.identifier, desc: `移除条目: ${origP?.name || origOrder.identifier}` });
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
                            <button id="pc-btn-view-overview" class="pc-top-action-btn" title="全览所有提示词"><i class="fa-solid fa-eye"></i> 全览</button>
                            <button id="pc-btn-view-staged" class="pc-top-action-btn" title="View Staged Changes"><i class="fa-solid fa-list-check"></i> <span>(0)</span></button>
                            <button id="pc-btn-commit" class="pc-top-action-btn pc-btn-commit" title="Commit Changes"><i class="fa-solid fa-check"></i> 提交</button>
                            <button id="pc-btn-close" class="pc-top-action-btn" title="Close"><i class="fa-solid fa-times"></i></button>
                        </div>
                    </div>
                    <div class="pc-toolbar" style="display: flex; gap: 8px; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1)); align-items: center;">
                        <div style="flex: 1; position: relative;">
                            <input type="text" id="pc-search-input" class="pc-form-control" placeholder="搜索条目名称或内部提示词..." style="width: 100%; box-sizing: border-box; padding-left: 28px;" />
                            <i class="fa-solid fa-search" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); opacity: 0.4; font-size: 0.85rem; pointer-events: none;"></i>
                        </div>
                        <button id="pc-btn-create-prompt" class="pc-top-action-btn" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; font-weight: 600; white-space: nowrap; cursor: pointer; border-radius: 6px;" title="新建一个全新的提示词条目">
                            <i class="fa-solid fa-plus"></i> 新建条目
                        </button>
                        <button id="pc-btn-import-prompt" class="pc-top-action-btn" style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; font-weight: 600; white-space: nowrap; cursor: pointer; border-radius: 6px;" title="从提示词库中引入未在当前列表的条目">
                            <i class="fa-solid fa-folder-plus"></i> 引入条目
                        </button>
                    </div>
                    <div class="pc-prompt-list" id="pc-prompt-list"></div>
                </div>
                <div class="pc-right-pane">
                    <div class="pc-mobile-nav">
                        <button id="pc-btn-mobile-back" class="pc-top-action-btn" title="Back to prompt list"><i class="fa-solid fa-arrow-left"></i> 返回列表</button>
                    </div>
                    <div class="pc-diff-area" id="pc-diff-area"></div>
                    <div class="pc-overview-area" id="pc-overview-area" style="display:none; flex: 1; flex-direction: column;"></div>
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
        this.dialog.find('#pc-btn-view-overview').on('click', () => {
            this.editTargetId = null;
            this.showOverview = true;
            this.mobileShowRight = true;
            this.updateRightPane();
        });
        this.dialog.find('#pc-btn-view-staged').on('click', () => {
            this.editTargetId = null;
            this.showOverview = false;
            this.mobileShowRight = true;
            this.updateRightPane();
        });
        this.dialog.find('#pc-btn-mobile-back').on('click', () => {
            this.editTargetId = null;
            this.mobileShowRight = false;
            this.updateRightPane();
        });
        this.dialog.find('#pc-btn-create-prompt').on('click', () => this.createPrompt());
        this.dialog.find('#pc-btn-import-prompt').on('click', () => this.openImportModal());

        await callGenericPopup(this.dialog, POPUP_TYPE.TEXT, '', {
            transparent: true,
            large: true,
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
                } else if (v.type === 'addvar') {
                    if (orderItem.enabled) {
                        const varName = v.name;
                        const val = v.value;
                        if (globalVars[varName] !== undefined) {
                            const currNum = Number(globalVars[varName]);
                            const addNum = Number(val);
                            if (!isNaN(currNum) && !isNaN(addNum) && val !== '' && globalVars[varName] !== '') {
                                globalVars[varName] = String(currNum + addNum);
                            } else {
                                globalVars[varName] += val;
                            }
                        } else {
                            globalVars[varName] = val;
                        }
                    }
                    varHtmlElements.push(
                        `<span class="pc-var-badge pc-addvar-badge" data-type="addvar" data-varname="${escapeHtml(v.name)}" data-varvalue="${escapeHtml(v.value)}" title="${escapeHtml(v.value)}" style="cursor: pointer; font-size: 0.75rem; background: rgba(245, 158, 11, 0.2); color: #f59e0b; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-plus-square"></i> ${escapeHtml(v.name)}</span>`
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
                <div class="pc-card-index pc-drag-handle" title="按住此处拖动以排序">
                    <i class="fa-solid fa-grip-vertical pc-drag-handle-icon"></i>
                    <span>${String(currentIndex).padStart(2, '0')}</span>
                </div>
                <div class="pc-card-header">
                    <span class="pc-card-title">
                        <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px; max-width: 100%;">
                            <span class="pc-card-name">${escapeHtml(prompt.name)}</span>
                            ${setVarHtml}
                        </div>
                        <small class="pc-card-id" title="#${escapeHtml(prompt.identifier)}">#${escapeHtml(prompt.identifier)}</small>
                    </span>
                </div>
                <div class="pc-card-macros">${macroHtml}</div>
                <div class="pc-card-controls" style="display: flex; align-items: center; gap: 8px;">
                    <span class="pc-role-badge role-${prompt.role || 'system'}">${escapeHtml(prompt.role || 'system')}</span>
                    <button class="pc-btn-toggle" data-id="${prompt.identifier}" title="Toggle Prompt">${orderItem.enabled ? '<i class="fa-solid fa-toggle-on"></i> ' : '<i class="fa-solid fa-toggle-off"></i> '}</button>
                    <button class="pc-btn-remove" data-id="${prompt.identifier}" title="从当前列表中移除" style="background: rgba(239, 68, 68, 0.1); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.2); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            `;
            listEl.append(card);
        }

        // Initialize Sortable
        if (listEl.sortable('instance')) listEl.sortable('destroy');
        if (!isSearching) {
            listEl.sortable({
                delay: getSortableDelay(),
                handle: '.pc-drag-handle',
                items: '.pc-prompt-card',
                cancel: 'input, textarea, button, select, option, .pc-btn-toggle, .pc-btn-remove, .pc-var-badge, .pc-card-id',
                tolerance: 'pointer',
                revert: 150,
                start: (event, ui) => {
                    listEl.addClass('is-dragging');
                    ui.placeholder.height(ui.helper.outerHeight());
                    ui.placeholder.css('visibility', 'visible');
                    ui.placeholder.css('background', 'rgba(var(--SmartThemeQuoteColorRgb, 100, 180, 255), 0.1)');
                    ui.placeholder.css('border', '2px dashed var(--SmartThemeQuoteColor)');
                    ui.placeholder.css('border-radius', '6px');
                    ui.helper.css('box-shadow', '0 16px 32px rgba(0,0,0,0.4), 0 0 0 2px var(--SmartThemeQuoteColor)');
                    ui.helper.css('cursor', 'grabbing');
                },
                stop: (event, ui) => {
                    setTimeout(() => listEl.removeClass('is-dragging'), 50);
                    ui.item.css('box-shadow', '');
                    ui.item.css('cursor', '');
                },
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

        listEl.find('.pc-btn-remove').on('click', (e) => {
            e.stopPropagation();
            const id = $(e.currentTarget).data('id');
            const idx = this.transactionalState.promptOrder.findIndex(o => o.identifier === id);
            if (idx > -1) {
                const prompt = this.transactionalState.prompts.find(p => p.identifier === id);
                this.transactionalState.promptOrder.splice(idx, 1);

                const CORE_IDS = ['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'dialogueExamples', 'chatHistory', 'main'];
                const pIdx = this.transactionalState.prompts.findIndex(p => p.identifier === id);
                if (pIdx > -1 && !CORE_IDS.includes(id)) {
                    this.transactionalState.prompts.splice(pIdx, 1);
                }

                if (this.editTargetId === id) {
                    this.editTargetId = null;
                }
                this.updateListUI();
                this.updateRightPane();
                toastr.info(`已移除 "${prompt?.name || id}"，变动已记入待提交中`);
            }
        });

        const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        listEl.find('.pc-var-badge').on('click', (e) => {
            e.stopPropagation();
            const badge = $(e.currentTarget);
            const card = badge.closest('.pc-prompt-card');
            const id = card.data('id');
            const type = badge.data('type');
            const varName = badge.data('varname');
            const varValue = badge.data('varvalue');

            this.editTargetId = id;
            this.mobileShowRight = true;
            this.updateRightPane();

            const textarea = this.dialog.find('#pc-edit-content')[0];
            if (textarea) {
                const text = textarea.value;
                let regex;
                if (type === 'setvar' || type === 'addvar') {
                    regex = new RegExp(`(\\{\\{${type}::\\s*${escapeRegExp(String(varName))}\\s*::\\s*)(${escapeRegExp(String(varValue))})(\\s*\\}\\})`);
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
            this.showOverview = false;
            this.mobileShowRight = true;
            this.updateRightPane();
        });
    }

    updateRightPane() {
        this.computeDiffs();
        const layoutEl = this.dialog.find('.pc-layout');
        if (this.mobileShowRight) {
            layoutEl.addClass('pc-show-right');
        } else {
            layoutEl.removeClass('pc-show-right');
        }

        const diffEl = this.dialog.find('#pc-diff-area');
        const editEl = this.dialog.find('#pc-edit-area');
        const overviewEl = this.dialog.find('#pc-overview-area');
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
        if (this.showOverview) {
            diffEl.hide();
            editEl.hide();
            overviewEl.show();
            this.renderOverview();
        } else if (this.editTargetId) {
            diffEl.hide();
            overviewEl.hide();
            editEl.show();
            this.renderEditForm();
        } else {
            editEl.hide();
            overviewEl.hide();
            diffEl.show();
            this.renderDiffList();
        }
    }

    renderOverview() {
        const overviewEl = this.dialog.find('#pc-overview-area');
        const CORE_IDS = ['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'dialogueExamples'];

        let html = `
        <div class="pc-editor-header" style="margin-bottom: 12px; flex-shrink: 0; display: flex; justify-content: space-between; align-items: center;">
            <h3 style="margin: 0;">提示词全览</h3>
            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; color: var(--SmartThemeBodyColor); background: rgba(var(--SmartThemeQuoteColorRgb, 100, 180, 255), 0.1); padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(var(--SmartThemeQuoteColorRgb, 100, 180, 255), 0.3);">
                <input type="checkbox" id="pc-toggle-macro" ${this.macroMode ? 'checked' : ''} style="margin: 0;"> 宏解析模式
            </label>
        </div>
        <div class="pc-overview-content" style="display: flex; flex-direction: column; gap: 12px; padding-bottom: 20px; overflow-y: auto; flex: 1; padding-right: 8px;">`;

        let hasEnabled = false;
        const localVars = {}; // Holds vars for Macro Mode

        for (const orderItem of this.transactionalState.promptOrder) {
            if (!orderItem.enabled) continue;
            hasEnabled = true;

            const prompt = this.transactionalState.prompts.find(p => p.identifier === orderItem.identifier);
            if (!prompt) continue;

            const isCore = CORE_IDS.includes(prompt.identifier) || prompt.identifier === 'chatHistory';
            const roleColorMap = {
                system: 'var(--SmartThemeQuoteColor, #60a5fa)',
                user: 'var(--SmartThemeBodyColor, #34d399)',
                assistant: 'var(--SmartThemeQuoteColor, #a78bfa)'
            };
            const roleColor = roleColorMap[prompt.role] || 'var(--SmartThemeQuoteColor)';

            html += `<div class="pc-overview-item" data-id="${prompt.identifier}" style="background: rgba(var(--SmartThemeBodyColorRgb, 200, 200, 200), 0.04); border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; overflow: hidden; text-align: left; cursor: pointer; transition: all 0.2s ease;">
                <div style="background: rgba(var(--SmartThemeQuoteColorRgb, 100, 180, 255), 0.08); border-bottom: 1px solid rgba(var(--SmartThemeQuoteColorRgb, 100, 180, 255), 0.1); padding: 6px 12px; font-size: 0.85rem; font-weight: 700; color: var(--SmartThemeBodyColor); display: flex; justify-content: space-between; text-align: left;">
                    <span>${escapeHtml(prompt.name)}</span>
                    <span style="opacity: 0.8; font-weight: 600; text-transform: uppercase; font-size: 0.75rem; color: ${roleColor};">${escapeHtml(prompt.role || 'system')}</span>
                </div>
                <div style="padding: 12px; font-size: 0.9rem; white-space: pre-wrap; font-family: 'JetBrains Mono', 'Courier New', Courier, monospace; opacity: 0.9; color: var(--SmartThemeBodyColor); word-break: break-word;">`;

            if (isCore) {
                html += `<span style="color: var(--SmartThemeQuoteColor, #60a5fa); opacity: 0.8;">{{SillyTavern Prompt #${escapeHtml(prompt.identifier)}}}</span>`;
            } else {
                let text = prompt.content || prompt.prompt || '';
                if (this.macroMode) {
                    let escapedText = escapeHtml(text);
                    escapedText = escapedText.replace(/\{\{\/\/([\s\S]*?)\}\}|\{\{setvar::(.*?)::([\s\S]*?)\}\}|\{\{addvar::(.*?)::([\s\S]*?)\}\}|\{\{getvar::([\s\S]*?)\}\}/g, (match, commentGroup, setvarName, setvarVal, addvarName, addvarVal, getvarName) => {
                        if (commentGroup !== undefined) {
                            return ''; // Remove comment
                        } else if (setvarName !== undefined) {
                            localVars[setvarName.trim()] = setvarVal.trim();
                            return ''; // Remove setvar
                        } else if (addvarName !== undefined) {
                            const varName = addvarName.trim();
                            const val = addvarVal.trim();
                            if (localVars[varName] !== undefined) {
                                const currNum = Number(localVars[varName]);
                                const addNum = Number(val);
                                if (!isNaN(currNum) && !isNaN(addNum) && val !== '' && localVars[varName] !== '') {
                                    localVars[varName] = String(currNum + addNum);
                                } else {
                                    localVars[varName] += val;
                                }
                            } else {
                                localVars[varName] = val;
                            }
                            return ''; // Remove addvar
                        } else if (getvarName !== undefined) {
                            const varName = getvarName.trim();
                            const val = localVars[varName] !== undefined ? localVars[varName] : '';
                            return val ? `<span style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; padding: 0 4px; border-radius: 4px; border-bottom: 1px dashed rgba(59, 130, 246, 0.5);" title="变量已解析: ${varName}">${val}</span>` : '';
                        }
                        return match;
                    });
                    
                    // Process {{trim}} (remove macro and adjacent newlines)
                    escapedText = escapedText.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '');
                    html += escapedText;
                } else {
                    let escapedText = escapeHtml(text);
                    // Highlight setvar (green)
                    escapedText = escapedText.replace(/\{\{setvar::(.*?)::([\s\S]*?)\}\}/g, (match, name, val) => {
                        return `<span style="background: rgba(16, 185, 129, 0.2); color: #34d399; padding: 2px 4px; border-radius: 4px; font-weight: 600;">{{setvar::${name}::${val}}}</span>`;
                    });
                    // Highlight addvar (orange)
                    escapedText = escapedText.replace(/\{\{addvar::(.*?)::([\s\S]*?)\}\}/g, (match, name, val) => {
                        return `<span style="background: rgba(245, 158, 11, 0.2); color: #f59e0b; padding: 2px 4px; border-radius: 4px; font-weight: 600;">{{addvar::${name}::${val}}}</span>`;
                    });
                    // Highlight getvar (blue)
                    escapedText = escapedText.replace(/\{\{getvar::([\s\S]*?)\}\}/g, (match, name) => {
                        return `<span style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; padding: 2px 4px; border-radius: 4px; font-weight: 600;">{{getvar::${name}}}</span>`;
                    });
                    // Highlight trim (purple)
                    escapedText = escapedText.replace(/\{\{trim\}\}/g, (match) => {
                        return `<span style="background: rgba(168, 85, 247, 0.2); color: #c084fc; padding: 2px 4px; border-radius: 4px; font-weight: 600;">{{trim}}</span>`;
                    });
                    // Highlight comments (gray)
                    escapedText = escapedText.replace(/\{\{\/\/([\s\S]*?)\}\}/g, (match, content) => {
                        return `<span style="background: rgba(156, 163, 175, 0.2); color: #9ca3af; padding: 2px 4px; border-radius: 4px; font-style: italic;">{{//${content}}}</span>`;
                    });
                    // Highlight all other ST macros (teal/cyan)
                    escapedText = escapedText.replace(/\{\{(?!setvar|addvar|getvar|trim|\/\/)(.*?)\}\}/g, (match, macroContent) => {
                        return `<span style="background: rgba(20, 184, 166, 0.15); color: #14b8a6; padding: 2px 4px; border-radius: 4px; font-weight: 600;">{{${macroContent}}}</span>`;
                    });
                    html += escapedText;
                }
            }

            html += `</div></div>`;
        }

        if (!hasEnabled) {
            html += '<div style="opacity: 0.5; padding: 30px; text-align: center;">当前没有启用的提示词条目。</div>';
        }

        html += '</div>';
        overviewEl.html(html);

        overviewEl.find('.pc-overview-item').on('mouseenter', function () {
            $(this).css({
                'border-color': 'var(--SmartThemeQuoteColor)',
                'box-shadow': '0 4px 12px rgba(0,0,0,0.1)'
            });
        }).on('mouseleave', function () {
            $(this).css({
                'border-color': 'var(--SmartThemeBorderColor)',
                'box-shadow': 'none'
            });
        }).on('click', (e) => {
            const id = $(e.currentTarget).data('id');
            this.editTargetId = id;
            this.showOverview = false;
            this.updateRightPane();

            // Also select the corresponding item in the left list to sync UI
            this.dialog.find('.pc-prompt-card').removeClass('active');
            this.dialog.find(`.pc-prompt-card[data-id="${id}"]`).addClass('active');
        });

        overviewEl.find('#pc-toggle-macro').on('change', (e) => {
            this.macroMode = e.target.checked;
            this.renderOverview();
        });
    }

    renderDiffList() {
        const diffEl = this.dialog.find('#pc-diff-area');
        if (this.diffs.length === 0) {
            diffEl.html('<div style="opacity: 0.5; padding: 20px; text-align: center;">空空如也.</div>');
            return;
        }

        let html = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <h3 style="margin: 0;">待提交变动 (Staged Changes)</h3>
            <button id="pc-btn-undo-all" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; display: flex; align-items: center; gap: 6px; transition: all 0.2s ease;">
                <i class="fa-solid fa-rotate-left"></i> 撤销全部
            </button>
        </div>
        <ul class="pc-diff-list">`;
        
        for (const diff of this.diffs) {
            html += `<li class="pc-diff-item diff-${diff.type}">
                <span class="pc-diff-desc">${escapeHtml(diff.desc)}</span>
                <button class="pc-btn-undo" data-id="${diff.id}" data-type="${diff.type}"><i class="fa-solid fa-rotate-left"></i> 撤销</button>
            </li>`;
        }
        html += '</ul>';
        diffEl.html(html);

        diffEl.find('#pc-btn-undo-all').on('click', () => {
            this.transactionalState = {
                prompts: structuredClone(this.originalState.prompts),
                promptOrder: structuredClone(this.originalState.promptOrder),
            };
            this.updateListUI();
            this.updateRightPane();
            toastr.success('已撤销所有未提交的更改');
        });

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
                <h3>编辑: ${escapeHtml(prompt.name)}</h3>
            </div>
            ${(isCore || isHistory) ? '<div style="color: #ef4444; font-size: 0.8rem; margin-bottom: 12px; padding: 8px; background: rgba(239, 68, 68, 0.1); border-radius: 6px;"><i class="fa-solid fa-triangle-exclamation"></i> 此条目为系统关键设定，部分内容已被锁定以防破坏内部注入逻辑。</div>' : ''}
            <div class="pc-form-group">
                <label>名称</label>
                <input type="text" class="pc-form-control" id="pc-edit-name" value="${escapeHtml(prompt.name)}">
            </div>
            <div class="pc-form-group">
                <label>Role</label>
                <select class="pc-form-control" id="pc-edit-role" ${isHistory ? 'disabled' : ''}>
                    <option value="system" ${prompt.role === 'system' ? 'selected' : ''}>系统</option>
                    <option value="user" ${prompt.role === 'user' ? 'selected' : ''}>用户</option>
                    <option value="assistant" ${prompt.role === 'assistant' ? 'selected' : ''}>助手</option>
                </select>
            </div>
            <div class="pc-form-group">
                <label>位置</label>
                <select class="pc-form-control" id="pc-edit-inj-pos" ${isHistory ? 'disabled' : ''}>
                    <option value="0" ${prompt.injection_position === 0 ? 'selected' : ''}>相对</option>
                    <option value="1" ${prompt.injection_position === 1 ? 'selected' : ''}>插D</option>
                </select>
            </div>
            <div class="pc-form-group" id="pc-edit-inj-depth-grp" style="display: ${prompt.injection_position === 1 ? 'flex' : 'none'};">
                <label>注入深度</label>
                <input type="number" class="pc-form-control" id="pc-edit-inj-depth" value="${prompt.injection_depth ?? 4}" min="0" ${isHistory ? 'disabled' : ''}>
            </div>
            <div class="pc-form-group">
                <label>提示词</label>
                <textarea class="pc-form-control" id="pc-edit-content" rows="10" ${(isCore || isHistory) ? 'disabled' : ''}>${escapeHtml(prompt.content || prompt.prompt || '')}</textarea>
            </div>
            <div class="pc-editor-footer" style="display: flex; gap: 8px; justify-content: flex-start; margin-top: 16px;">
                <button class="pc-btn-icon pc-btn-icon-primary" id="pc-btn-save-edit" title="Save to Staging"><i class="fa-solid fa-save"></i> 保存</button>
                <button class="pc-btn-icon pc-btn-close-edit" title="Close Editor"><i class="fa-solid fa-times"></i> 关闭</button>
            </div>
        `);

        editEl.find('#pc-edit-inj-pos').on('change', function () {
            if ($(this).val() == '1') {
                editEl.find('#pc-edit-inj-depth-grp').show();
            } else {
                editEl.find('#pc-edit-inj-depth-grp').hide();
            }
        });

        editEl.find('.pc-btn-close-edit').on('click', () => {
            this.editTargetId = null;
            this.mobileShowRight = false;
            this.updateRightPane();
        });

        editEl.find('#pc-btn-save-edit').on('click', () => {
            prompt.name = editEl.find('#pc-edit-name').val();

            if (!isHistory) {
                prompt.role = editEl.find('#pc-edit-role').val();
                prompt.injection_position = Number(editEl.find('#pc-edit-inj-pos').val());
                if (prompt.injection_position === 1) {
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
            this.mobileShowRight = false;
            this.updateListUI();
            this.updateRightPane();
        });
    }

    async commitState() {
        if (this.diffs.length === 0) return;

        promptManager.serviceSettings.prompts = structuredClone(this.transactionalState.prompts);

        const targetChar = this.activeCharacter || promptManager.activeCharacter || { id: promptManager.configuration?.promptOrder?.dummyId || 100000 };
        const characterList = promptManager.serviceSettings.prompt_order.find(list => String(list.character_id) === String(targetChar.id));
        if (characterList) {
            characterList.order = structuredClone(this.transactionalState.promptOrder);
        } else {
            promptManager.addPromptOrderForCharacter(targetChar, this.transactionalState.promptOrder);
        }

        // Clean up references to deleted prompts across all prompt_order entries
        const validIds = new Set(this.transactionalState.prompts.map(p => p.identifier));
        for (const list of promptManager.serviceSettings.prompt_order) {
            if (Array.isArray(list.order)) {
                list.order = list.order.filter(o => validIds.has(o.identifier));
            }
        }

        saveSettingsDebounced();
        if ($('#update_oai_preset').length) {
            $('#update_oai_preset').trigger('click');
        }
        promptManager.render();
        toastr.success('PCManager: Changes committed.');

        this.diffs = [];
        this.mobileShowRight = false;
        this.cloneState();
        this.updateListUI();
        this.updateRightPane();
    }

    createPrompt() {
        const newId = 'pc_prompt_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        const newPrompt = {
            identifier: newId,
            name: '未命名条目',
            role: 'system',
            content: '',
            injection_position: 0
        };

        this.transactionalState.prompts.push(newPrompt);
        this.transactionalState.promptOrder.unshift({
            identifier: newId,
            enabled: true
        });

        this.editTargetId = newId;
        this.showOverview = false;
        this.mobileShowRight = true;
        this.updateListUI();
        this.updateRightPane();

        setTimeout(() => {
            const nameInput = this.dialog.find('#pc-edit-name');
            if (nameInput.length) {
                nameInput.focus().select();
            }
        }, 50);
    }

    async openImportModal() {
        const currentOrderIds = new Set(this.transactionalState.promptOrder.map(o => o.identifier));
        const availablePrompts = this.transactionalState.prompts.filter(p => !currentOrderIds.has(p.identifier));

        if (availablePrompts.length === 0) {
            toastr.info('提示词库中的所有条目均已在当前列表中');
            return;
        }

        const modalContent = document.createElement('div');
        modalContent.className = 'pc-import-modal';
        modalContent.style.padding = '8px';
        modalContent.style.maxHeight = '75vh';
        modalContent.style.overflowY = 'auto';

        let html = `
            <h3 style="margin-top:0; margin-bottom: 12px; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
                <i class="fa-solid fa-folder-plus" style="color: #60a5fa;"></i> 从提示词库放入列表
            </h3>
            <p style="font-size: 0.85rem; opacity: 0.7; margin-bottom: 16px;">选择下方尚未包含在当前角色配置中的条目，放入顶部或彻底删除：</p>
            <div class="pc-import-list" style="display: flex; flex-direction: column; gap: 8px;">
        `;

        for (const prompt of availablePrompts) {
            html += `
                <div class="pc-import-item" data-id="${prompt.identifier}">
                    <div class="pc-import-info">
                        <span class="pc-import-name">${escapeHtml(prompt.name)}</span>
                        <small class="pc-import-id" title="#${escapeHtml(prompt.identifier)} (${escapeHtml(prompt.role || 'system')})">#${escapeHtml(prompt.identifier)} (${escapeHtml(prompt.role || 'system')})</small>
                    </div>
                    <div class="pc-import-actions">
                        <button class="pc-btn-add-to-order" data-id="${prompt.identifier}" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; display: flex; align-items: center; gap: 6px; font-weight: 600;">
                            <i class="fa-solid fa-arrow-up-from-bracket"></i> 放入
                        </button>
                        <button class="pc-btn-delete-permanently" data-id="${prompt.identifier}" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; display: flex; align-items: center; gap: 6px; font-weight: 600;" title="彻底从提示词库中删除此条目">
                            <i class="fa-solid fa-trash"></i> 移除
                        </button>
                    </div>
                </div>
            `;
        }
        html += `</div>`;
        modalContent.innerHTML = html;

        const $modal = $(modalContent);

        const removeItemAndCheckEmpty = (btnElement) => {
            $(btnElement).closest('.pc-import-item').fadeOut(200, function () {
                $(this).remove();
                if ($modal.find('.pc-import-item').length === 0) {
                    const popupInstance = Popup.util?.popups?.find(p => p.dlg && p.dlg.contains($modal[0]));
                    if (popupInstance) popupInstance.complete(POPUP_RESULT.AFFIRMATIVE);
                }
            });
        };

        $modal.find('.pc-btn-add-to-order').on('click', (e) => {
            const id = $(e.currentTarget).data('id');
            const promptToAdd = availablePrompts.find(p => p.identifier === id);
            if (promptToAdd) {
                this.transactionalState.promptOrder.unshift({ identifier: id, enabled: true });
                this.updateListUI();
                this.updateRightPane();
                toastr.success(`已将 "${promptToAdd.name}" 放入最顶层`);
                removeItemAndCheckEmpty(e.currentTarget);
            }
        });

        $modal.find('.pc-btn-delete-permanently').on('click', (e) => {
            const id = $(e.currentTarget).data('id');
            const pIdx = this.transactionalState.prompts.findIndex(p => p.identifier === id);
            if (pIdx > -1) {
                const promptName = this.transactionalState.prompts[pIdx].name;
                this.transactionalState.prompts.splice(pIdx, 1);

                const oIdx = this.transactionalState.promptOrder.findIndex(o => o.identifier === id);
                if (oIdx > -1) {
                    this.transactionalState.promptOrder.splice(oIdx, 1);
                }

                if (this.editTargetId === id) {
                    this.editTargetId = null;
                }

                this.updateListUI();
                this.updateRightPane();
                toastr.success(`已彻底删除条目 "${promptName}"`);
                removeItemAndCheckEmpty(e.currentTarget);
            }
        });

        await callGenericPopup($modal, POPUP_TYPE.TEXT, '', {
            transparent: false,
            large: true,
            okButton: '完成',
            cancelButton: false,
            allowVerticalScrolling: true
        });
    }
}

const pcManagerCore = new PCManagerCore();

export async function openPCManager() {
    if (!pcManagerCore.cloneState()) return;
    pcManagerCore.isOpen = true;
    await pcManagerCore.renderUI();
}
