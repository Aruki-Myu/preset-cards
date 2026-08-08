# preset-cards 开发约定

SillyTavern 插件（TypeScript）。简体中文交流；Windows PowerShell 7；构建：`npm run typecheck`（必须零错误）+ `npm run build`（产出 dist/index.js）。

## 分支与产物

- 功能开发在独立分支（如 `feature/profile-changelist`、`feature/import-export`），完成并验证后推送。
- `dist/index.js` 由 vite 构建（sourcemap 已关闭），提交时随源码一并提交；`.gitattributes` 标记 dist 为 linguist-generated。
- `docs/` 目录已 gitignore，仅作本地设计记录，不提交。README.md 提交并维护。

## 领域背景（快速上手）

- profile 存于 `preset.extensions['preset_cards']`（`readMeta`/`saveMeta`，saveMeta POST 整预设到 /api/presets/save）。
- `PromptBaseProfile` = 全量开关快照（可带 `fields` 值差异）；`PromptDeltaProfile` = 相对父链的差异（`baseId` + `changes`，支持 delta 派 delta）。
- 运行时开关真值在 `prompt_order`（global 策略 character_id===100001）；`runtimeEnabledFor` 读取真值，所有开关应用须 `syncPromptOrder`。
- 值字段白名单：content / name / role / injection_position（depth/order 刻意不暴露）。
- system_prompt / marker 条目不显示编辑按钮与开关。
- 激活预设编辑时**不得触发 `#update_oai_preset`**（会用旧 oai_settings 覆盖内存编辑，R2）；保存后调 `refreshActivePresetUI`。
- `mirrorFieldsToActivePreset` 直接改 oai_settings.prompts 是必要的 ST workaround（R2 防御），保留。
- 全树导出 `prompt_tree`：收集全部 base/delta，DFS 根先序（保证 delta 祖先在前），保留原始 id/baseId；v1 不导出。

## 审查结论复核流程（必须执行）

任何 review / audit / 代码质量评审产出的结论，**不得照单全收**，必须先经过独立复核再决定执行：

1. review/audit subagent 产出的每个 claim（bug / 建议 / 风险）都可能是错的、过时的或不可达的。
2. 用**独立 verify subagent** 逐个验证：
   - 判定 `REAL`（真缺陷，值得修）/ `MARGINAL`（理论成立但实际不可达/可忽略）/ `FALSE`。
   - 必须给出 file:line 证据；能复现的场景尽量写临时 harness 复现。
   - 无法复现就明确说「无法复现」，不许猜测。
3. 只有 `REAL` 的才执行修复；`MARGINAL` 说明理由后可不做；`FALSE` 丢弃。
4. 复核还要检查审计是否**漏报**（如 idMap 不记 delta 导致的断链）。
5. 每次验证产出 verdict 表，逐项记录判定与证据，作为执行依据。

## 提交信息风格

中文，前缀如 `feat:` / `fix:` / `refactor:` / `style:` / `docs:` / `chore:`，简明描述改动。只在用户明确要求时提交/推送。
