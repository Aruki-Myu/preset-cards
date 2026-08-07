# Preset Cards for SillyTavern

> 这是 **Dev-TS** 分支：已从原生 JS 重构为 **TypeScript + Vite** 构建的 SillyTavern 第三方扩展。
> 功能说明与完整文档见 [`Preset-cards.md`](./Preset-cards.md)。

**Preset Cards** 将 ST 原生的下拉式预设管理器重做为可视化卡片网格，支持**子配置快照（Profiles）**、模型适配标签、搜索/多选批量删除、导入导出脱敏等，为经常切换模型或测试参数的玩家提供高效工作流。

## 特性

- 可视化卡片网格，支持实时搜索、多选批量删除
- 子配置快照系统（Profiles）：在单个预设下保存/一键加载多套参数状态
- 模型适配标签：勾选适用模型并渲染厂商 Logo
- 完整预设 / 单子配置导出导入，导出自动脱敏（剥离代理 URL、API Keys 等）
- 原生中英双语，跟随 ST 全局语言自动切换
- 兼容任意安装路径（`third-party` 深层目录、自定义文件夹名）

## 分支说明

| 分支 | 说明 |
|---|---|
| `main` | 上游原版（JS），保持与 upstream 同步 |
| `Dev-TS` | 本分支：TypeScript 重构，`dist/` 已提交，可直接安装 |

## 构建（仅开发者需要）

仓库中的 `dist/index.js` 已提交，普通用户把整个目录放入 `SillyTavern/data/.../third-party/`（或 ST 的 `public/scripts/extensions/third-party/`）即可使用，无需本地构建。

```bash
npm install        # 安装依赖
npm run build      # 生产构建 (输出 dist/index.js + sourcemap)
npm run watch      # 开发模式：监听 src/ 变更自动重建
npm run typecheck  # 仅做类型检查 (tsc --noEmit)
```

## 源码结构

```text
preset-cards/
├── manifest.json       # 扩展元数据（js 指向 dist/index.js，hooks.activate = init）
├── package.json        # 构建脚本与依赖 (Vite + TypeScript)
├── tsconfig.json       # TypeScript 编译配置
├── vite.config.ts      # Vite 构建配置 (@sillytavern/* 外部化解析)
├── src/                # TypeScript 源码
│   ├── index.ts        # 入口，导出 init() 钩子
│   ├── constants.ts    # 常量：扩展名/LOGO/本地化字典/模型与来源映射
│   ├── i18n.ts         # 本地化助手 L()
│   ├── cache.ts        # IndexedDB 背景图缓存
│   ├── meta.ts         # 预设元数据读写 (readMeta/saveMeta)
│   ├── presetList.ts   # 视图模型构建 (buildPresetList)
│   ├── editModal.ts    # 元数据编辑弹窗 (openEditModal)
│   ├── presetCards.ts  # 主弹窗逻辑 (openPresetCards)
│   ├── init.ts         # 侧栏按钮与 /presetcards 斜杠命令
│   ├── globals.d.ts    # 全局变量声明
│   └── types/st.d.ts   # SillyTavern 模块自包含类型声明
├── dist/               # 构建产物 (Vite 输出，提交进 git)
├── style.css           # UI 视觉样式
├── cards.html          # 预设卡片网格 Handlebars 模板
├── edit.html           # 元数据/模型标签编辑弹窗模板
├── Preset-cards.md     # 详细功能与实现文档
└── llm-logos/          # 各主流模型厂商的 Logo 文件
```

## 使用

- 侧边栏点击 **Preset Cards**（或运行 `/presetcards`）打开卡片视图
- 点卡片切换预设；悬停卡片显示导出 / 编辑 / 删除
- 卡片内 **Configurations** 区管理子配置快照（新增 / 加载 / 覆盖 / 重命名 / 删除 / 导出 / 导入）
- 工具栏支持搜索、简洁模式、多选批量删除、清理背景图缓存、导入预设
