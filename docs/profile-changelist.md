# Profile 主/派生机制设计

> 状态：设计稿，尚未实现
> 分支：`feature/profile-changelist`

## 1. 背景与目标

当前 preset-cards 的 profile 是**全量快照**：保存时 `structuredClone(preset)` 存入 `profiles[]`，加载时 `Object.assign(preset, profile.settings)` 全量覆盖。

问题：一个 Chat Completion 预设文件可达 1MB+，其中扩展（extensions）占 49%~73%、prompts 占 10%~27%、常规标量不到 1%。全量快照既浪费又臃肿，且加载时会把未改动字段一并覆盖。

目标：**主 profile 存全 prompts 开关清单（轻量）；派生 profile 只存相对主 profile 的差异（开关 + 值）**；加载时「主 + 子」叠加应用。不同 profile 字段集合可不同。

## 2. 实测数据（决定设计取向）

文件位于 `SillyTavern-plugin/preset/`，基线参考 `SillyTavern-src/default/content/presets/openai/Default.json`。

| 预设 | 文件大小 | A 标量 | B prompts | C order | A+B+C 合计 |
|---|---|---|---|---|---|
| 梦鲸思客V2-0602.json | 208,879 B | 1,387 B | 41,612 B | 4,589 B | 47,588 B (23%) |
| 【此间小镇HereBetween】1.6.json | 561,618 B | 1,386 B | 74,654 B | 5,862 B | 81,902 B (15%) |
| 8.3（2）【可待-从头越】 直出版.json | 1,098,470 B | 1,030 B | 436,191 B | 11,703 B | 448,924 B (41%) |

结论：
- A 标量 + C order 几乎免费（合计 3~13KB）。
- **prompts 是成本决定项**：梦鲸 42KB / 小镇 75KB 尚可，但 **8.3 达 436KB**（单条 content 有 144KB）。对这类预设，全量 profile ≈ preset 文件翻倍。
- **只存开关清单（identifier + enabled）永远便宜**：72~195 条约 3~9KB，与 prompts 内容体积无关。
- extensions（regex_scripts / tavern_helper / SPreset）**明确排除，不纳入 profile**——它们占文件 49%~73% 且是第三方插件域。

## 3. Profile 存储边界（已与用户确认）

- **主 profile**：记录当前预设**全部 prompts 的开关**，即 `{ identifier, enabled }[]`。不存值、不存扩展。
- **派生 profile**：相对主 profile 的**差异**，差异包括「开关差异」与「值差异」（可改某 prompt 的 enabled，也可改其 content 等值）。
- 加载派生 profile：**先应用主 profile 的全部开关，再叠加派生差异**（主 + 子叠加）。
- extensions 永不纳入。

## 4. 关键事实：开关真正生效在 prompt_order

ST 中 `prompts[].enabled` **不驱动 UI/运行时**：
- Prompt Manager 的 toggle 改的是 `prompt_order` 条目的 `enabled`（PromptManager.js:443-452）；
- 列表渲染与生成过滤读的也是 `prompt_order`（:1196-1199、:1664-1668）；
- `prompts[].enabled` 只是随文件保存的"默认值"。

因此：**要让开关生效，必须同时同步 `prompt_order`**（global 策略下即 `character_id === 100001` 那条的 `order[].enabled`）。

## 5. 数据结构（与 v1 全量快照并存）

```ts
// meta.ts
export interface PresetProfileV1 {              // 现有，不动
    id: string;
    name: string;
    settings: Record<string, any>;
    formatVersion?: 1;
}

export interface PromptBaseProfile {            // 主 profile
    formatVersion: 2;
    kind: 'prompt_base';
    id: string;
    name: string;
    prompts: { identifier: string; enabled: boolean }[];
}

export interface PromptDeltaProfile {           // 派生 profile
    formatVersion: 2;
    kind: 'prompt_delta';
    id: string;
    name: string;
    baseId: string;                             // 依赖的主 profile id
    changes: PromptDeltaChange[];
}

export type PresetProfile = PresetProfileV1 | PromptBaseProfile | PromptDeltaProfile;

export interface PromptDeltaChange {
    identifier: string;
    enabled?: boolean;                          // 开关差异
    fields?: Partial<PromptFields>;             // 值差异（content/role 等）
}
```

判别：`settings` 存在 → v1；`kind === 'prompt_base'` → 主；`kind === 'prompt_delta'` → 派生。三者可混存于 `profiles[]`。

## 6. 保存流程

1. 活动预设先 `#update_oai_preset` + 延时（参考 presetCards.ts:433-438，确保 `openai_settings[idx]` 是已保存态）。
2. **存主 profile**：`buildPromptToggleSnapshot(openai_settings[idx])` → `{ identifier, enabled }[]` 全量。
3. **派生**：从某主 profile 复制其 `prompts` 作为初始 → 生成新 `prompt_delta`，`changes` 初始为空（或基于当前状态与主 profile 的差异生成）。

## 7. 加载/应用流程

对现有「加载」处理器（presetCards.ts:464-492）按类型分支：

- **v1**：维持 `Object.assign(preset, profile.settings)`（现有行为，零迁移）。
- **主 profile**：按 identifier 回写 `prompts[].enabled`，同步 `prompt_order`。
- **派生 profile**：
  1. 找到 `baseId` 指向的主 profile，应用其全部开关；
  2. 叠加 `changes`（enabled 覆盖 + fields 合并）；
  3. 同步 `prompt_order`。

应用后：
- `saveMeta` 持久化（meta.ts:61-71 会连带写盘整个 preset body）；
- 若为活动预设，`$('#settings_preset_openai').trigger('change')` 让 ST 原生重载，并调用 `promptManager.render(false)` 刷新 Prompt Manager 列表（openai.js 已导出 `promptManager`）；
- 缺失 identifier（prompt 已被删）→ 跳过 + 汇总 toast。

## 8. UI 设计

- `cards.html`：
  - profile 区新增「保存主 profile」按钮；
  - 主 profile 行提供「派生」入口；
  - 三种 profile 行类型指示（图标/前缀：[Base] / [Delta] / 无）。
- `presetCards.ts`：保存 / 派生 / 加载 / 更新 / 导出 / 导入 / 简洁模式长按加载按类型分支。
- `presetList.ts`：`PresetCardModel.profiles` 类型改为 `PresetProfile[]`，模板上下文补类型指示。
- `style.css`：类型徽标样式（可复用 chip 样式）。

## 9. 边界情况

| 场景 | 处理 |
|---|---|
| `preset.prompts` 缺失/非数组 | 存空清单并提示；加载空操作 |
| identifier 在当前预设不存在 | 跳过 + 汇总 toast |
| 主 profile 被删，派生还引用它 | 加载时若 base 缺失 → 降级只应用 changes；UI 提示 |
| 派生「更新」 | 重新与 base 比较生成 changes（覆盖旧 changes） |
| 派生「覆盖为当前设置」 | 重新生成 changes 或转存为独立主 profile（待定） |
| 导出/导入 | 主导 `{kind,prompts}`，派生导 `{kind,baseId,changes}`；导入按 kind 识别 |
| 加载到已锁定活动预设 | 若后续做锁定：锁快照回写会覆盖 profile 应用结果（toast 提示） |

## 10. 待实现项

- [ ] `buildPromptToggleSnapshot(preset)` 主 profile 采集
- [ ] `applyBaseProfile(preset, profile)` + `applyDeltaProfile(preset, delta, base)`（含 prompt_order 同步）
- [ ] 保存 / 派生 / 加载 / 更新 / 导出 / 导入各 handler 分支
- [ ] UI：按钮、行类型指示、样式
- [ ] 简洁模式长按加载分支
- [ ] 派生 profile 的「值差异」编辑 UI（务实方案：优先复用 ST 原生 Prompt Manager 编辑 content，派生只记录差异；或提供简单编辑入口，见 §8 取舍）
