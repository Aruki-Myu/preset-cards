# Profile 变更清单（Change List）设计

> 状态：设计稿，尚未实现
> 分支：`feature/profile-changelist`

## 1. 背景与目标

当前 preset-cards 的 profile 是**全量快照**：保存时 `structuredClone(preset)` 存入 `profiles[]`，加载时 `Object.assign(preset, profile.settings)` 全量覆盖。

问题：一个 Chat Completion 预设文件可达 1MB+，其中扩展（extensions）占 49%~73%、prompts 占 10%~27%、常规标量不到 1%。全量快照极浪费，且加载时会把未改动的字段也一并覆盖。

目标：把 profile 改为**变更清单**——只记录与基线有差异的设置项，每项含 id、开关、内容；加载时与目标预设合并。不同 profile 可有不同字段集合。

## 2. 实测数据（三个真实预设）

文件位于 `SillyTavern-plugin/preset/`，基线参考 `SillyTavern-src/default/content/presets/openai/Default.json`。

| 预设 | 文件大小 | 标量占比 | prompts | prompt_order | extensions |
|---|---|---|---|---|---|
| 梦鲸思客V2-0602.json | 208,879 B | <1% | 28,238 B (14%) | 4,589 B (2%) | 126,293 B (60%) |
| 【此间小镇HereBetween】1.6.json | 561,618 B | <1% | 57,441 B (10%) | 5,862 B (1%) | 411,133 B (73%) |
| 8.3（2）【可待-从头越】 直出版.json | 1,098,470 B | <1% | 292,750 B (27%) | 11,703 B (1%) | 540,812 B (49%) |

结论：**体积大头在 prompts 和 extensions**。变更清单必须按条目级做 diff，只改一个 temperature 的 profile 应只有几百字节。

## 3. Profile 存储边界（已与用户确认）

**profile 只存 A + B + C，不含 extensions（D 类）。**

三个预设**共有**的顶层键（39 个，不含 extensions）作为 profile 可覆盖的字段范围；其中 **15 个值有差异**（temperature、top_p、top_k、frequency_penalty、presence_penalty、reasoning_effort、squash_system_messages、continue_prefill、openai_max_tokens 等）。扩展（regex_scripts / tavern_helper / SPreset）不纳入 profile——它们是第三方插件的域，排除后 profile 保持轻量且聚焦预设核心配置。

### 类别划分

- **A 常规标量**：采样参数、上下文限制、生成开关、提示词模板文本、格式字符串。约 39 键（并集），15 键实际有差异。
- **B prompts**：72~195 条自定义 prompt，每条含 identifier/name/enabled/content/role/injection_* 等。
- **C prompt_order**：执行顺序数组（每条 identifier + enabled）。
- **D extensions**：regex_scripts、SPreset、tavern_helper —— **明确排除，不存**。

## 4. 条目结构（四类判别联合）

```ts
type ChangeEntry =
    | ScalarEntry
    | PromptEntry
    | PromptOrderEntry;
// 无 ExtensionEntry：extensions 不纳入 profile（见 §3）

interface ScalarEntry {
    kind: 'scalar';
    id: string;                       // 预设标量键，如 'temperature'
    value: string | number | boolean; // 新值
    previous?: string | number | boolean; // 基线旧值（UI 展示/撤销用，可选）
}

interface PromptEntry {
    kind: 'prompt';
    op: 'set' | 'add' | 'delete';
    id: string;                       // prompt.identifier
    enabled?: boolean;                // 开关
    fields?: Partial<PromptFields>;   // 被改动的字段子集；add 建议全量
    order?: number;                   // 在 prompts[] 中的下标（仅重排时）
}

interface PromptFields {
    name: string;
    content: string;
    role: string;
    system_prompt: boolean;
    marker: boolean;
    forbid_overrides: boolean;
    injection_position: number;       // 0 相对 / 1 绝对
    injection_depth: number;
    injection_order: number;
    injection_trigger: string[];
    attach_index: number;
    attach_role: string;
    attach_side: string;
    extension: boolean;
}

interface PromptOrderEntry {
    kind: 'prompt_order';
    op: 'set' | 'reorder';
    characterId: number;              // 默认 100001
    id?: string;                      // set 时：order 内 identifier
    enabled?: boolean;                // set 时：开关
    position?: number;                // set 时：在 order[] 中的新位置
    entries?: { id: string; enabled: boolean }[]; // reorder 时：完整新序列
}
```

## 5. Diff 策略

### 5.1 基线选择

**以父预设自身的已保存态为基线**（生成 profile 时的 `openai_settings[idx]`，先触发 `#update_oai_preset` 同步视为已保存态）。

理由：
- UUID prompt 条目（60~178 条/预设）和所有扩展在 ST 默认预设中不存在，若以 ST 默认为基线，它们全部算"有修改"→ 必须全量存储 → 体积目标落空。
- profile 语义就是"这个预设的变体"：父预设自身是最准确、最小的 diff 参照。
- ST 默认值的角色降级为：① 定义"哪些键是可设置项"（settingsToUpdate / default_settings 键集）；② 可选提供"重置回默认"操作。

### 5.2 比较规则

- 数值按数值比较（`1` ≡ `1.0`，解决类型漂移）；
- 字符串按全等（content 等不得 trim）；
- 数组按序列全等（placement、injection_trigger、order 序列）；
- 双方都缺失的字段视为相等；`undefined` ≡ 缺失；
- 连接凭据键永远排除（复用 constants.ts 的排除清单）。

### 5.3 各类 diff

- **标量**：对并集键逐个比较，不同则产出 `ScalarEntry`。
- **prompts**：按 identifier 建 map。双侧都有 → `set`（只存差异字段子集，仅改开关则只带 enabled）；仅当前 → `add`（全量）；仅基线 → `delete`。
- **prompt_order**：按 characterId 分组。顺序序列变了 → `reorder`（完整新序列）；仅 enabled/位置变 → 逐条 `set`。

### 5.4 无法可靠 diff 的项

- 用户自定义 UUID prompt / 第三方条目：不是"无法 diff"，而是"基线里没有"——用父预设基线后天然是"双侧都有"或"仅基线"，diff 可靠；只有新增条目走 `add`（需存全量，不可避免的最小值）。
- 含可变内容的字段（如 sourcemap URL）：以精确串全等为准，不做语义级 diff。

## 6. 加载合并语义

以目标预设对象为起点，按顺序应用 changes：

| 条目 | 覆盖 | 删除 | 追加 | 重排 |
|---|---|---|---|---|
| scalar | `preset[id] = value` | — | — | — |
| prompt | `set`：按 id 合并 fields+enabled+order | `delete`：从 prompts 过滤 + 从 prompt_order 移除 | `add`：push 完整 prompt | order 移动下标 |
| prompt_order | `set`：设 enabled/position；缺失则 push | 由 reorder 序列隐式删除 | reorder 中新增追加 | reorder：整体替换 order 序列 |

关键不变式：
1. `preset.extensions['preset-cards']` 永不参与 diff、永不被覆盖（避免递归自引用）。
2. 应用不"重置"基线里没提到的字段——这正是变更清单的语义。
3. 应用后沿用现有 `saveMeta` 持久化；若为当前激活预设触发 `#settings_preset_openai` change。
4. 缺失字段应用策略：`set` 只写 fields 里显式给的字段，不补基线不存在的字段。

## 7. 兼容性与迁移

- **检测**：`profile.formatVersion === 2 && Array.isArray(profile.changes)` → v2；`profile.settings` 存在 → v1 快照。
- **共存**：`profiles[]` 允许混存 v1/v2。加载分支：v1 保持现有 `Object.assign` 行为；v2 走 §6 应用器。
- **迁移**：v1 profile 被"更新/覆盖"时原地转换为 v2（baseline=当前已保存态，changes=diff(快照, baseline)）。v1→v2 应用结果等价，属无损转换。

## 8. 待实现项（Not Implemented）

- [ ] `diff(baseline, current)` 纯函数
- [ ] `applyChanges(preset, changes)` 应用器
- [ ] 保存 profile 时的字段勾选 UI（可复用 constants.ts 的 PROFILE_FIELD_GROUPS）
- [ ] v1/v2 检测与迁移
- [ ] 陈旧基线指纹检测（可选：WebCrypto 哈希，加载时提示预设已被修改）
