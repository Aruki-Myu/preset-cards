# 实施计划：prompt 内容编辑 + 顺序编辑 + R5 开关修复

> 状态：待执行（供后续按步骤委托实现）
> 分支：`feature/profile-changelist`
> 前置设计：`docs/profile-changelist.md`
> 行号均已按当前源码核实（实现前请再次确认）

## 1. 背景与目标（三个工作流）

- **工作流 A（主）**：点击 profile 展开列表中某条 prompt 条目，可编辑其 content / name / role / 注入位置等值，并把值差异随 profile（base 存绝对值、delta 存差异）保存与加载。
- **工作流 B**：在卡片内编辑 prompt 顺序（上移/下移或拖拽），走 ST 原生 `prompt_order` 持久化。
- **工作流 C（R5）**：修复默认预设常缺 `prompts[].enabled` 键、导致快照把全部 prompt 记成禁用的问题——改用 `prompt_order` 运行时真值。

三者合为一个 P0→P3 有序计划；P0/P1/P2 只做 A，P3 收口 B + C。

## 2. 优先级总览表

| 阶段 | 范围 | 工作流 | 交付物 |
|---|---|---|---|
| P0 数据层 | meta.ts / promptToggle.ts / presetList.ts | A | `PromptFields` 类型、capture/apply/resolve/值差异纯函数、`buildPromptSnapshot`、运行时真值 helper（先保持旧语义，P3-C 再翻转） |
| P1 UI | cards.html / presetCards.ts / style.css / constants+i18n | A | 编辑弹窗、条目编辑入口、保存流程带值差异、`refreshActivePresetUI` 修复（R3） |
| P2 加固 | promptToggle.ts / cards.html | A | R10 白名单过滤；可选「清除值变更」控件 |
| P3 顺序 + R5 | promptToggle.ts / st.d.ts / cards.html / presetCards.ts | B + C | 顺序编辑持久化；快照读取改运行时真值 |

## 3. 分步实施步骤（按依赖排序，标注工作流 A/B/C）

### P0 数据层（A）

**[A1] src/meta.ts — 类型扩展**
- 新增 `export interface PromptFields { content?: string; name?: string; role?: string; injection_position?: number; injection_depth?: number; injection_order?: number; }`（全部可选）。
- `PromptBaseProfile.prompts`（meta.ts:24）放宽为 `{ identifier: string; enabled: boolean; fields?: PromptFields }[]`。
- 保持 `formatVersion: 2` 不变；旧 profile 无 `fields` → `undefined`，走现有路径，向后兼容。
- `PromptDeltaChange.fields`（meta.ts:31）维持 `Record<string, any>`，非法键由 R10 白名单兜底。

**[A2] src/promptToggle.ts — 值捕获 / 回写原语**
- 新增 `export const PROMPT_FIELD_WHITELIST: (keyof PromptFields)[]`。
- 新增 `capturePromptFields(prompt): PromptFields` —— 只取白名单键，跳过 undefined。
- 新增 `applyFieldsToPreset(preset, identifier, fields): boolean` —— 按 identifier 找到 prompt 后 `Object.assign`；**不碰 prompt_order**（值编辑不影响开关）。
- 抽内部 helper `runtimeEnabledFor(prompt, preset)`，当前语义 = 现有 `!!p.enabled`（promptToggle.ts:26）；P3-C 只改这一处。

**[A3] src/promptToggle.ts — applyBaseProfile 支持 fields + resolveProfilePrompts**
- `applyBaseProfile`（promptToggle.ts:33-55）：enabled 回写后追加 `if (entry.fields) Object.assign(prompt, entry.fields)`（P2 再加白名单过滤）。
- 新增 `resolveProfilePrompts(profile, allProfiles, seen?): { identifier; enabled; fields? }[]`：
  - base → `structuredClone(profile.prompts)`（含 fields）；
  - delta → 复用 `resolveProfileStates` 的递归 + seen 防环骨架（promptToggle.ts:57-），聚合对象带 fields：父链解析后逐条叠加 `changes` —— enabled 覆盖 + `Object.assign(fields, change.fields)`；
  - `resolveProfileStates` 保持不变（presetList.ts:96 仍在用）。

**[A4] src/promptToggle.ts — 快照 + 值差异计算**
- 新增 `buildPromptSnapshot(preset, opts?: { includeFields?: Set<string> }): { identifier; enabled; fields? }[]` —— 过滤逻辑与 `buildPromptToggleSnapshot`（promptToggle.ts:22-27）共用，enabled 用 `runtimeEnabledFor`；`includeFields` 含某 identifier 时附带 `fields: capturePromptFields(prompt)`。
- 新增 `snapshotToChanges(snapshot, parentEntries, previousChanges)`：
  - `parentEntries` = `resolveProfilePrompts` 解析父链（含 fields）；
  - enabled 差异沿用 `statesToChanges`（promptToggle.ts:175-）逻辑；
  - fields 差异：逐条白名单字段，仅当 snapshot 值 ≠ 父链解析值才写入 `change.fields`；等于父值 → 不写（即清除）；
  - `previousChanges.fields` 对未编辑的 identifier 原样保留，对已编辑的 identifier 重建（覆盖旧差异）。
  - 保留 `statesToChanges` 供既有 enabled-only 调用点使用（presetCards.ts:663 / 685 / 744）。

**[A5] src/presetList.ts — 用 resolveProfilePrompts 构建条目**
- base 分支（presetList.ts:86-90）与 delta 分支（:96-107）统一改用 `resolveProfilePrompts`。
- 显示名优先级：resolved `fields.name` ?? `promptNames.get(identifier)` ?? identifier。
- `hasFields`：base 条目若有 fields 也置 true（目前只在 delta 分支 :106 判断）。

### P1 UI（A）

**[A6] cards.html — 条目编辑入口**
- 在 `.preset_card_profile_entry`（cards.html:109-116）内、name 之后加编辑图标按钮 `.preset_card_profile_entry_edit`（hover 铅笔），与 enabled toggle 分离；点击 `e.stopPropagation()`，避免误触开关/行级动作。
- 编辑按钮渲染条件：`prompt.system_prompt` 真值（system_prompt 条目）或 `prompt.marker` 真值（marker 条目）→ **不渲染编辑按钮**；仅普通 prompt 才有编辑入口。
- 模板 i18n 键加入 `getCardsTemplateContext()`（presetList.ts 末尾）i18n 映射。

**[A7] src/presetCards.ts — 编辑弹窗 + 点击处理 + 保存流程**
- 新增 `openPromptEditPopup(preset, identifier)`：
  - `callGenericPopup` 内嵌：role select、name input、content textarea、可选 injection 区（position/depth/order 数值框）；
  - system_prompt / marker 条目不渲染编辑按钮（见 A6），弹窗层兜底：marker prompt（`prompt.marker` 真值，同 ST PromptManager.js:575）→ content textarea disabled；
  - 初始值取 `preset.prompts[identifier]` 当前值；返回编辑后的 fields 或 null。
- 事件 `.preset_card_profile_entry_edit` 点击：
  - `Object.assign(preset.prompts[identifier], editedFields)`（插件既有保存路径的同一对象）；
  - 记录 `sessionEdits: Map<identifier, { initial, edited }>`；
  - `row.addClass('modified')` + 显示保存按钮；
  - 本地刷新条目名；**不立即 saveMeta**（与开关行为一致）。
- 保存按钮 handler（presetCards.ts:637-703）扩展：
  - `buildPromptSnapshot(preset, { includeFields: new Set(sessionEdits.keys()) })`；
  - update/base → enabled 全量合并；fields 仅对 edited ids：`capturePromptFields(prompt)` 与 `initial` 比较，无净变化 → 置 `undefined`（清除），否则写入；
  - update/delta → `snapshotToChanges(snapshot, resolveProfilePrompts(父链), profile.changes)`；
  - create → 基于被编辑 profile 的父链聚合 `snapshotToChanges` 生成新 delta；
  - **保存成功后调用 `refreshActivePresetUI(name)`**（修复 R3，见风险清单）；
  - 若为活动预设：**绝不调用 `#update_oai_preset`**（R2）。
- `chooseProfileSaveTarget`（presetCards.ts:71-103）文案「Save modified switches to」→「Save changes to」（:73）。

**[A8] style.css + constants.ts / i18n.ts**
- style.css：`.preset_card_profile_entry_edit` 样式、hover 显示、hasFields 高亮（复用 :815-819 `#e6a23c`）。
- 新字符串入 `LOCAL_DICT`（constants.ts，中文）与 `getCardsTemplateContext()` i18n 映射（英文模板），`L()` 包装。

### P2 加固（A）

**[A9] R10 白名单防御**
- `applyDeltaProfile`（promptToggle.ts:106-150，`Object.assign` 在 :135）：assign 前按 `PROMPT_FIELD_WHITELIST` 过滤 `change.fields`。
- `applyBaseProfile`：同理过滤 `entry.fields`。导入/旧数据可能带任意键，防污染 preset。

**[A10]（可选）每条目「清除值变更」控件**
- 对有 fields 的条目提供清除按钮：base → 删 `entry.fields`；delta → 删该 `change.fields`；本地回写后标记 modified。

### P3 顺序编辑 + R5（B + C）

**[B1] src/types/st.d.ts — 放宽 promptManager 类型（:87）**
- 补 `configuration: { promptOrder: { strategy: 'global' | 'character' } }`、`saveServiceSettings(): Promise<void>`、`activeCharacter?: { id: number }`（`render` 已有）。

**[B2] src/promptToggle.ts — 策略感知写入目标**
- 新增 `resolvePromptOrderTarget(): number`：读 `promptManager.configuration.promptOrder.strategy`（openai.js:687-690）：
  - global → `100001`（现状默认）；
  - character → `promptManager.activeCharacter?.id`（由 PromptManager.js:1130-1144 维护）。
- 新增 `reorderPromptOrder(preset, identifier, delta)`：在目标 `prompt_order` 条目的 `.order` 数组内按 identifier 移动位置；**不动单条 enabled、不动 `prompts[]` 顺序**（与 `syncPromptOrder` 只追加缺失项到尾部一致）。
- `syncPromptOrder`（promptToggle.ts:153-，hardcode `'100001'` 在 :157）改用 `resolvePromptOrderTarget()`，并加 `Array.isArray(preset.prompt_order)` 守卫（旧对象格式兼容）。

**[B3] src/presetCards.ts + cards.html — 顺序编辑 UI**
- 条目加「上移 / 下移」按钮（最少实现，兼容触摸；拖拽可后续用 jQuery UI sortable 对齐 ST PromptManager.js:1919-1936）。
- 点击 → `reorderPromptOrder(preset, identifier, ±1)`。
- 持久化：活动预设走插件既有路径——mutate `openai_settings[idx].prompt_order` → `saveMeta` → `refreshActivePresetUI`（内部已含 `promptManager?.render?.(false)`，presetCards.ts:50-54）；或按 ST 原生方式直接写 `oai_settings.prompt_order` + `promptManager.saveServiceSettings()`（→ saveSettingsDebounced → POST /api/settings/save）+ `promptManager.render()`——需同时保持 `openai_settings[idx]` 与 `oai_settings` 一致（两者引用不同，见风险清单）。
- UI 明示：global 策略下该顺序作用于所有角色。

**[C1] src/promptToggle.ts — R5 运行时真值（只改 runtimeEnabledFor）**
- 优先级：`prompt_order` 中 `character_id === 100001` 条目 `order` 内对应 identifier 的 `.enabled` ?? `prompts[].enabled` ?? `true`。
- 同时作用于 `buildPromptToggleSnapshot` 与 `buildPromptSnapshot`（共用 helper）。
- **不改写入侧**（`applyBaseProfile` / `syncPromptOrder` 仍按 profile 条目原样写 enabled）——已存 base 加载时保留存储值，保持最小语义变化。
- 语义变化需在文档/CHANGELOG 明示：修复后新采集的快照（缺失 enabled 键的预设）由「全部 false」变为「运行时真值」；已存 base 不被改写，需用户重新「覆盖更新」才生效。

## 4. 风险与注意点清单

- **R2（活动预设禁 `#update_oai_preset`）**：openai.js:6766-6770 的 click handler → `saveOpenAIPreset`（openai.js:4493-4527）用 `oai_settings` 重建 presetBody 并 `Object.assign(openai_settings[value], presetBody)`（:4511），会把插件已写入的 prompts/prompt_order 覆盖回旧值。现有 add/update 流程在 presetCards.ts:511-516 / 718-723 用「触发 + 800ms 延时」规避；新内容编辑流程直接 `saveMeta` 写 `openai_settings[idx]`，不再走该路径。
- **R3（现开关保存不刷新活动预设）**：保存按钮 handler（presetCards.ts:637-703）结尾只有模板重渲染、无 `refreshActivePresetUI`；对比 update 流程（:736/:748）有。P1 必须在保存后补上。
- **R6（marker/system_prompt 条目不编辑）**：`prompt.marker` 或 `prompt.system_prompt` 真值 → 不渲染编辑按钮（入口层直接隐藏，A6）；弹窗层保留 marker content disabled 兜底（ST 同规则，PromptManager.js:575/1376）。
- **R10（白名单过滤）**：见 [A9]，防导入数据污染。
- **顺序编辑的策略确认**：写入前必须读 `promptManager.configuration.promptOrder.strategy`（openai.js:687-690）；当前默认 global。**character 策略坑**：新角色无 order 条目时 ST 会写入默认顺序（PromptManager.js:1140），插件按 100001 写的数据对单个角色「看似消失」——character 策略下必须写 `activeCharacter.id`。
- **旧 prompt_order 格式兼容**：旧版为对象映射 `{character_id: {order}}` 而非数组；`syncPromptOrder`（:157）与快照查找用 `.find`，遇到对象会抛 TypeError（`undefined is not a function`），需 `Array.isArray` 守卫。任务原述「被 .find 静默跳过」——实际为**会抛错**，实现时按防御处理。
- **`oai_settings` 与 `openai_settings[idx]` 引用不同**：切预设时 ST 用 `structuredClone`（openai.js:4904），两份 `prompt_order` 各自独立；改动后必须让两边一致（`refreshActivePresetUI` 或直接同步 `oai_settings`）。
- **`promptManager` 可为 null / 低版本缺字段**：st.d.ts:87 当前仅声明 `render`；B 需加宽类型并全程 `?.` 守卫。
- **formatVersion 2 不变**：新字段全可选，旧 profile / 旧 ST 兼容，不破坏现有 profile。
- **R5 语义变化**：见 [C1]，属于有意的快照读取语义修正，需明示。

## 5. 验证方式

```bash
npm run typecheck && npm run build
```

手动 QA 清单：
- 编辑条目内容 → 保存到 base → 刷新卡片；重新加载 profile 后 `prompts[].content` 正确、其余值未变。
- 编辑后改回初值 → 保存 → fields 被清除（不再有值变更标记）。
- delta：编辑内容 → 保存 → `changes` 只含差异字段；父链值不受影响。
- 活动预设编辑内容保存后：Prompt Manager 列表与实际生效值一致（`refreshActivePresetUI` 生效），且未触发 `#update_oai_preset` 抹掉内容（R2/R3 双验证）。
- marker / system_prompt 条目不显示编辑按钮；弹窗内 marker content 仍 disabled。
- 顺序上移/下移 → Prompt Manager 列表顺序一致、各条 enabled 保持不变；global 策略提示文案可见。
- 从未动过的默认预设：新建 base → 重新加载后不应把所有 prompt 变禁用（R5）。
- 旧对象格式 `prompt_order` 不抛错、开关/顺序操作安全跳过。
- `npm run typecheck` 无错误。
