# Preset Cards for SillyTavern

将 ST 原生的下拉式 Chat Completion 预设管理器重做为可视化卡片网格的第三方扩展，并为每个预设提供**主/派生 profile（Base / Delta）**两级配置快照系统。

## 功能特性

- **卡片网格预览**：每张卡片显示名称、来源与模型、描述、适用模型标签、采样参数（Temperature / Top P / Top K / Context / Tokens）与背景图；按「当前激活优先、其余按名称」排序。
- **搜索 / 多选批量删除**：实时按名称或描述过滤；多选模式（Multi-Select）批量删除预设。
- **主 profile（Base）**：保存当前预设全部 prompt 的开关状态快照（`enabled`），可附带值字段（`fields`）。
- **派生 profile（Delta）**：只保存相对上级的差异（`changes`），支持嵌套派生（Delta 可再派 Delta），加载时递归解析父链叠加应用，带防环保护。
- **展开条目编辑开关**：点击 profile 展开条目列表，逐条切换 prompt 开关，改动实时写入预设实际值并同步 `prompt_order`。
- **system_prompt / marker 条目不显示开关与编辑入口**：这些条目的内容由 ST 管理，仅普通 prompt 可切换、可编辑。
- **点击条目编辑值**：弹出编辑窗口修改 content / name / role / position（`injection_position`）；marker 条目的内容框禁用。值差异写入 profile 的 `fields`。
- **prompt 顺序上移 / 下移**：对活动预设的 `prompt_order` 重排（global 策略时显示全局提示，说明顺序作用于所有角色）。
- **导入导出**：导出 Base 为 `{kind, formatVersion, prompts}`；导出 Delta 为自包含 JSON（附解析后的完整父快照），导入时按内容复用已有主 profile，否则自动新建。整卡导出预设时自动脱敏（剥离代理 URL、API Keys 等连接字段）。
- **重置**：Delta 回退到上级（Base 或上层 Delta），Base 回退到隐藏的默认基准（`defaultSnapshot`，打开弹窗时自动回填）。
- **保存二选一**：展开编辑后的保存弹窗让用户选择「更新当前 profile」或「新建为子配置（派生）」，后者直接生成相对当前 profile 的差异。
- **简洁模式（Concise Mode）**：压缩卡片；简洁模式下长按卡片弹出该预设的 profile 列表快速切换。
- **覆盖 / 派生 / 重命名 / 删除**：profile 支持覆盖为当前设置、派生、行内重命名与删除（删除带派生依赖的 Base 时会提示）。
- **元数据编辑**：描述、适用模型标签（渲染厂商 Logo）、背景图 URL，支持背景图 IndexedDB 缓存与一键清理。
- **中文界面**：读取 ST 全局语言设置自动切换中英文（内置中英词典，无需改动 ST 的 i18n）。

## 安装与构建

```bash
npm install        # 安装依赖
npm run build      # 生产构建，输出 dist/index.js + sourcemap
```

插件本体位于 `public/scripts/extensions/preset-cards/`（manifest 的 `js` 字段指向 `dist/index.js`，`hooks.activate` = `init`）。将整个插件目录放入 ST 的 `public/scripts/extensions/` 下，刷新并启动 ST 后即可在侧边栏看到 **Preset Cards** 入口（或使用 `/presetcards` 斜杠命令）。

## 使用说明

1. **打开**：侧边栏点击 **Preset Cards**，或运行 `/presetcards`。
2. **新建主 profile**：卡片「Configurations」区点击 `+`，输入名称，保存当前全部 prompt 开关为 Base。
3. **新建派生 profile**：在某条 profile 上点击派生图标（fork），输入名称，得到一份相对上级的 Delta；此后可在其上编辑开关/值后再覆盖更新。
4. **编辑值**：展开 profile 后点击条目上的编辑图标，修改 content / name / role / position 后保存；改动只记录净差异。
5. **保存二选一**：编辑完点「保存修改」，选择「更新当前 profile」直接写回，或「新建为子配置」把当前状态保存为新的 Delta。
6. **清除值变更**：有值差异的条目显示清除按钮，一键删掉该条目的 `fields` 还原为上级/默认。
7. **重置**：点重置图标确认后，Delta 回退到父级、Base 回退到默认基准。
8. **顺序调整**：仅活动预设可上下移条目，调整 `prompt_order` 的顺序（不改变开关与 `prompts[]` 顺序）。

## 数据说明

- 所有扩展数据存于预设对象的 `extensions['preset_cards']`（描述、适用模型、背景图、profiles、隐藏默认基准），通过 ST 的 `/api/presets/save` 持久化。
- **Base（`formatVersion: 2`, `kind: 'prompt_base'`）**：`prompts[]` 为 `{ identifier, enabled, fields? }`，保存全量开关快照，`fields` 只含值差异。
- **Delta（`formatVersion: 2`, `kind: 'prompt_delta'`）**：`{ baseId, changes[] }`，`changes` 为 `{ identifier, enabled?, fields? }`，仅记录相对上级的差异，可嵌套。
- 另有旧版 v1 全量快照（`settings` 深拷贝）用于向后兼容，不可派生。
- 读取开关时以 `prompt_order` 的 global 条目（character_id=100001）为运行时真值，缺失时回退 `prompts[].enabled`，再缺失默认启用。

## 开发

| 命令 | 说明 |
|---|---|
| `npm run build` | 生产构建（Vite，输出到 `dist/`） |
| `npm run watch` | 开发模式，监听 `src/` 变更自动重建 |
| `npm run typecheck` | 仅做 TypeScript 类型检查（`tsc --noEmit`） |

源码入口为 `src/index.ts`（导出 `init` 钩子），核心逻辑见 `src/presetCards.ts`、`src/presetList.ts`、`src/meta.ts` 与 `src/promptToggle.ts`。
