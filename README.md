# Preset Cards for SillyTavern

将 ST 原生的下拉式 Chat Completion 预设管理器重做为可视化卡片网格的第三方扩展，并为每个预设提供**主/派生 profile（Base / Delta）**两级配置快照系统。当前开发分支 `feature/profile-changelist`，提交范围 `93cf85d→6a1a435`。

## 功能特性

- **卡片网格预览**：每张卡片显示名称、来源与模型、描述、适用模型标签、采样参数（Temperature / Top P / Top K / Context / Tokens）与背景图；按「当前激活优先、其余按名称」排序。
- **搜索 / 多选批量删除**：实时按名称或描述过滤；多选模式（Multi-Select）批量删除预设。
- **主 profile（Base）**：保存当前预设全部 prompt 的开关状态快照（`enabled`），可附带每条的**值字段** `fields`（`{ identifier, enabled, fields? }`）。
- **派生 profile（Delta）**：只保存相对上级的差异（`changes`），支持嵌套派生（Delta 可再派 Delta），加载时递归解析父链叠加应用，带防环保护。
- **展开条目编辑开关**：点击 profile 展开条目列表，逐条切换 prompt 开关，改动实时写入预设实际值并同步 `prompt_order`。
- **system_prompt / marker 条目不显示开关与编辑入口**：这些条目的内容由 ST 管理，仅普通 prompt 可切换、可编辑。
- **点击条目编辑值**：编辑弹窗（`src/editModal.ts` 的 `openPromptEditPopup`）提供 Name、Role + Position（同一行）与全宽 Content 文本域；position 下拉仅 **Relative(0) / In-chat(1)**（与 ST 的 INJECTION_POSITION 一致）；marker 条目的内容框禁用。值差异写入 profile 的 `fields`。
- **prompt 顺序上移 / 下移**：仅**活动预设**的条目渲染按钮；写入目标策略感知（global→100001 / character→活动角色 id），重排 `prompt_order` 后保存并刷新活动预设；global 策略时显示全局警告，说明顺序作用于所有角色。
- **导入导出**：profile 导出弹窗三选项——「导出」（自包含旧格式，delta 附解析后的父快照 `Imported Parent`）、「包含关系链的导出」（`prompt_tree` 全链，根→目标，保留 id/baseId）、「取消」；完整预设导出刻意不进该弹窗（用 ST 自带 / 卡片级导出按钮）。导入识别 `prompt_tree`（按 root→leaf 重建、id 映射、内容相同的 base 自动复用、freshId 去重）与旧版 base / delta / v1 格式。
- **重置**：Delta 回退到上级（Base 或上层 Delta），Base 回退到隐藏的默认基准（`defaultSnapshot`，打开弹窗时自动回填）。
- **保存二选一**：展开编辑后的保存弹窗让用户选择「更新当前配置」或「新建为子配置（派生）」；delta 更新的差异基线用**父链解析**（`resolveParentStates`），未编辑的已存差异原样保留。
- **清除值变更**：一键删除该条目的 `fields` 并**完全撤销**——同时还原运行时值、同步活动预设、清除本次会话的编辑记录（`sessionEdits`）。
- **简洁模式（Concise Mode）**：压缩卡片；简洁模式下长按卡片弹出该预设的 profile 列表快速切换。
- **覆盖 / 派生 / 重命名 / 删除**：profile 支持覆盖为当前设置、派生、行内重命名与删除（删除带派生依赖的 Base 时会提示）。
- **元数据编辑**：描述、适用模型标签（渲染厂商 Logo）、背景图 URL，支持背景图 IndexedDB 缓存与一键清理。
- **中文界面**：读取 ST 全局语言设置自动切换中英文（内置中英词典，无需改动 ST 的 i18n）。

## 安装与构建

```bash
npm install        # 安装依赖
npm run build      # 生产构建，输出 dist/index.js（sourcemap 已禁用）
```

插件本体位于 `public/scripts/extensions/preset-cards/`（manifest 的 `js` 字段指向 `dist/index.js`，`hooks.activate` = `init`）。将整个插件目录放入 ST 的 `public/scripts/extensions/` 下，刷新并启动 ST 后即可在侧边栏看到 **Preset Cards** 入口（或使用 `/presetcards` 斜杠命令）。

## 使用说明

1. **打开**：侧边栏点击 **Preset Cards**，或运行 `/presetcards`。
2. **新建主 profile**：卡片「配置快照」区点击 `+`，输入名称，保存当前全部 prompt 开关为 Base。
3. **新建派生 profile**：在某条 profile 上点击派生图标（fork），输入名称，得到一份相对上级的 Delta；此后可在其上编辑开关/值后再覆盖更新。
4. **编辑值**：展开 profile 后点击条目上的编辑图标，修改 content / name / role / position 后保存；改动只记录净差异。
5. **保存二选一**：编辑完点「保存修改」，选择「更新当前配置」直接写回，或「新建为子配置」把当前状态保存为新的 Delta。
6. **清除值变更**：有值差异的条目显示清除按钮，一键撤销该条目的值编辑（含本次会话记录与运行时值）。
7. **重置**：点重置图标确认后，Delta 回退到父级、Base 回退到默认基准。
8. **顺序调整**：仅活动预设可上下移条目，调整 `prompt_order` 的顺序（不改变开关与 `prompts[]` 顺序）。

## 数据说明

- 所有扩展数据存于预设对象的 `extensions['preset_cards']`（描述、适用模型、背景图、profiles、隐藏默认基准），通过 ST 的 `/api/presets/save` 持久化。
- **Base（`formatVersion: 2`, `kind: 'prompt_base'`）**：`prompts[]` 为 `{ identifier, enabled, fields? }`，保存全量开关快照，`fields` 只含值差异。
- **Delta（`formatVersion: 2`, `kind: 'prompt_delta'`）**：`{ baseId, changes[] }`，`changes` 为 `{ identifier, enabled?, fields? }`，仅记录相对上级的差异，可嵌套。
- **值字段白名单**：`content / name / role / injection_position`（`PROMPT_FIELD_WHITELIST`）；`injection_depth / order` 排除，避免加载 profile 时用旧快照覆盖用户后续调整的注入值。
- 另有旧版 v1 全量快照（`settings` 深拷贝）用于向后兼容，不可派生。
- 读取开关时以 `prompt_order` 的 global 条目（character_id=100001）为运行时真值，缺失时回退 `prompts[].enabled`，再缺失默认启用。

## 与 ST 集成的已知注意点

- `prompt_order` **按预设存储**：切换到**没有** `prompt_order` 键的预设时，ST 会继承上一个预设的顺序（仅在 key 存在时才复制）。
- 「以当前设置覆盖」会把这类继承来的顺序**永久写进**该预设的 profile——该风险已记录在案，尚未在代码中缓解。

## 开发

| 命令 | 说明 |
|---|---|
| `npm run build` | 生产构建（Vite，sourcemap 关闭，输出 `dist/index.js`） |
| `npm run watch` | 开发模式，监听 `src/` 变更自动重建（`--mode development`） |
| `npm run typecheck` | 仅做 TypeScript 类型检查（`tsc --noEmit`） |

源码入口为 `src/index.ts`（重导出 `src/init.ts` 的 `init` 钩子），核心逻辑见 `src/presetCards.ts`、`src/presetList.ts`、`src/meta.ts`、`src/promptToggle.ts`，编辑弹窗见 `src/editModal.ts`，中英词典见 `src/constants.ts`。`docs/` 目录有意加入 `.gitignore`，设计文档不随仓库跟踪。

## 最近变更（分支 `feature/profile-changelist`，93cf85d→6a1a435）

- profile 导出改为三选项弹窗，新增 `prompt_tree` 全链导出/导入（idMap 重建、base 内容复用、freshId 去重）。
- delta「更新当前配置」的保存基线改父链解析（`resolveParentStates`），未编辑的已存差异不再丢失。
- 「清除值变更」升级为完全撤销（含本次会话编辑记录与运行时值回滚）。
- 编辑弹窗迁入 `src/editModal.ts`，Role + Position 同行，内容框 190px（桌面）/ 150px（移动端）。
- 构建关闭 sourcemap，仅输出 `dist/index.js`。
