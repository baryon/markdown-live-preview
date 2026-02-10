# Markdown Live Preview - 项目设计文档

## 项目概述

**项目名称**: Markdown Live Preview
**项目代号**: `vscode-markdown-live-preview`
**版本**: 1.0.0

一个全新的 VSCode Markdown 预览扩展，采用现代化架构和最佳实践，提供流畅的编辑与预览体验。

## 设计目标

1. **并排实时预览**: 默认左侧编辑、右侧预览，同步滚动
2. **最大化预览模式**: 支持一键切换预览最大化显示
3. **现代化渲染**: 使用 beautiful-mermaid 替代传统 mermaid 渲染
4. **精简依赖**: 移除 PlantUML 支持，专注核心功能
5. **VSCode 最佳实践**: 遵循官方扩展开发规范

## 架构设计

### 核心组件

```
┌─────────────────────────────────────────────────────────┐
│                    VSCode Extension                      │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │  Extension  │  │   Preview   │  │    Markdown     │ │
│  │   Manager   │──│   Provider  │──│     Engine      │ │
│  └─────────────┘  └─────────────┘  └─────────────────┘ │
│         │                │                  │           │
│         ▼                ▼                  ▼           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │   Config    │  │   Webview   │  │    Renderers    │ │
│  │   Manager   │  │   Handler   │  │   (Pluggable)   │ │
│  └─────────────┘  └─────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 目录结构

```
vscode-markdown-live-preview/
├── src/
│   ├── extension.ts              # 扩展入口
│   ├── preview/
│   │   ├── PreviewManager.ts     # 预览管理器
│   │   ├── PreviewPanel.ts       # 预览面板
│   │   ├── ScrollSync.ts         # 滚动同步
│   │   └── ViewModeManager.ts    # 视图模式管理
│   ├── markdown/
│   │   ├── MarkdownEngine.ts     # Markdown 引擎
│   │   ├── MarkdownParser.ts     # 解析器
│   │   └── renderers/
│   │       ├── MermaidRenderer.ts    # Mermaid 渲染
│   │       ├── KatexRenderer.ts      # 数学公式渲染
│   │       ├── CodeRenderer.ts       # 代码高亮
│   │       ├── VegaRenderer.ts       # Vega 图表
│   │       └── WavedromRenderer.ts   # 波形图
│   ├── config/
│   │   ├── ConfigManager.ts      # 配置管理
│   │   └── defaults.ts           # 默认配置
│   ├── utils/
│   │   ├── debounce.ts
│   │   ├── fileUtils.ts
│   │   └── uriUtils.ts
│   └── types/
│       └── index.ts              # 类型定义
├── webview/
│   ├── preview.html              # 预览模板
│   ├── preview.ts                # 预览脚本
│   ├── styles/
│   │   ├── base.css
│   │   ├── themes/               # 预览主题
│   │   └── code-themes/          # 代码主题
│   └── lib/                      # 前端依赖
├── media/                        # 图标和资源
├── package.json
├── tsconfig.json
└── README.md
```

## 功能规格

### 1. 预览模式

#### 1.1 并排预览模式 (默认)

- 左侧: Markdown 编辑器
- 右侧: 实时预览面板
- 双向滚动同步
- 光标位置同步高亮

#### 1.2 最大化预览模式

- 预览面板全屏显示
- 快捷键切换 (Cmd/Ctrl + Shift + M)
- 状态栏图标切换
- 支持临时最大化 (ESC 退出)

#### 1.3 单独预览模式

- 仅显示预览面板
- 适合演示场景

### 2. 支持的文件格式

| 扩展名    | 语言 ID   | 说明                  |
| --------- | --------- | --------------------- |
| .md       | markdown  | 标准 Markdown         |
| .markdown | markdown  | 标准 Markdown         |
| .mdx      | mdx       | MDX (JSX in Markdown) |
| .mdown    | markdown  | Markdown              |
| .mkdn     | markdown  | Markdown              |
| .mkd      | markdown  | Markdown              |
| .rmd      | rmarkdown | R Markdown            |
| .qmd      | quarto    | Quarto Markdown       |

### 3. 渲染能力

#### 3.1 Mermaid 图表 (使用 beautiful-mermaid)

```
支持的图表类型:
- Flowchart (流程图)
- Sequence (序列图)
- Class (类图)
- State (状态图)
- ER (实体关系图)

特性:
- 15+ 内置主题
- 自定义主题支持
- 实时主题切换
- 高性能渲染 (100+ 图表 < 500ms)
```

#### 3.2 数学公式 (KaTeX)

- 行内公式: `$...$` 或 `\(...\)`
- 块级公式: `$$...$$` 或 `\[...\]`
- 支持自定义分隔符

#### 3.3 代码高亮 (Shiki)

- 支持 100+ 编程语言
- 与 VSCode 主题同步
- 行号显示
- 代码复制按钮

#### 3.4 Vega/Vega-Lite 可视化

- 数据驱动图表
- 交互式可视化
- 响应式设计

#### 3.5 WaveDrom 波形图

- 数字时序图
- 信号波形可视化

### 4. 滚动同步

```typescript
interface ScrollSyncConfig {
  enabled: boolean; // 是否启用
  mode: 'proportional' | 'anchor'; // 同步模式
  debounceMs: number; // 防抖延迟
}
```

**同步模式**:

- `proportional`: 按比例同步 (默认)
- `anchor`: 按锚点同步 (更精确)

### 5. 配置选项

```json
{
  "markdownLivePreview.preview.defaultViewMode": "side-by-side",
  "markdownLivePreview.preview.scrollSync": true,
  "markdownLivePreview.preview.scrollSyncMode": "proportional",
  "markdownLivePreview.preview.liveUpdate": true,
  "markdownLivePreview.preview.liveUpdateDebounceMs": 300,

  "markdownLivePreview.theme.preview": "github-light",
  "markdownLivePreview.theme.code": "auto",
  "markdownLivePreview.theme.mermaid": "default",
  "markdownLivePreview.theme.followEditorTheme": true,

  "markdownLivePreview.math.engine": "katex",
  "markdownLivePreview.math.inlineDelimiters": [
    ["$", "$"],
    ["\\(", "\\)"]
  ],
  "markdownLivePreview.math.blockDelimiters": [
    ["$$", "$$"],
    ["\\[", "\\]"]
  ],

  "markdownLivePreview.mermaid.enabled": true,
  "markdownLivePreview.mermaid.theme": "default",

  "markdownLivePreview.vega.enabled": true,
  "markdownLivePreview.wavedrom.enabled": true,

  "markdownLivePreview.fileExtensions": [
    ".md",
    ".markdown",
    ".mdx",
    ".mdown",
    ".mkdn",
    ".mkd",
    ".rmd",
    ".qmd"
  ]
}
```

## 技术选型

### 依赖

| 依赖              | 版本    | 用途             |
| ----------------- | ------- | ---------------- |
| beautiful-mermaid | ^1.x    | Mermaid 图表渲染 |
| markdown-it       | ^14.x   | Markdown 解析    |
| katex             | ^0.16.x | 数学公式渲染     |
| shiki             | ^1.x    | 代码高亮         |
| vega              | ^5.x    | 数据可视化       |
| vega-lite         | ^5.x    | 简化数据可视化   |
| vega-embed        | ^6.x    | Vega 嵌入        |
| wavedrom          | ^3.x    | 波形图           |

### 移除的依赖

| 依赖      | 原因                           |
| --------- | ------------------------------ |
| plantuml  | 需要 Java 环境，移除以简化部署 |
| mermaid   | 被 beautiful-mermaid 替代      |
| crossnote | 重新实现核心功能               |

## 命令和快捷键

| 命令                 | 快捷键 (Mac) | 快捷键 (Win/Linux) | 说明         |
| -------------------- | ------------ | ------------------ | ------------ |
| Open Preview to Side | Cmd+K V      | Ctrl+K V           | 打开并排预览 |
| Toggle Preview       | Cmd+Shift+V  | Ctrl+Shift+V       | 切换预览面板 |
| Maximize Preview     | Cmd+Shift+M  | Ctrl+Shift+M       | 最大化预览   |
| Toggle Scroll Sync   | -            | -                  | 切换滚动同步 |
| Refresh Preview      | Cmd+R        | Ctrl+R             | 刷新预览     |

## 上下文菜单

### 资源管理器上下文菜单

- "Open Preview" - 对 markdown 文件显示

### 编辑器标题菜单

- 预览图标按钮 - 对 markdown 文件显示

### 编辑器上下文菜单

- "Open Preview to Side" - 对 markdown 文件显示

## Webview 通信协议

### Extension → Webview

```typescript
interface UpdateContentMessage {
  type: 'updateContent';
  html: string;
  totalLineCount: number;
}

interface ScrollToLineMessage {
  type: 'scrollToLine';
  line: number;
  topRatio?: number;
}

interface UpdateThemeMessage {
  type: 'updateTheme';
  theme: string;
  codeTheme: string;
}

interface UpdateConfigMessage {
  type: 'updateConfig';
  config: Partial<PreviewConfig>;
}
```

### Webview → Extension

```typescript
interface RevealLineMessage {
  type: 'revealLine';
  line: number;
}

interface OpenLinkMessage {
  type: 'openLink';
  href: string;
}

interface CopyCodeMessage {
  type: 'copyCode';
  code: string;
}

interface ReadyMessage {
  type: 'ready';
  systemColorScheme: 'light' | 'dark';
}
```

## 主题系统

### 预览主题（每个主题包含明/暗两种配色）

- github — 经典 GitHub 风格
- obsidian — Obsidian 笔记风格（紫色调）
- vue — Vue.js 文档风格（绿色调）
- lark — 飞书文档风格（蓝色调）
- smartblue — 鲜明蓝色调
- medium — Medium 阅读体验（衬线字体）
- gothic — 极简优雅
- dracula — 流行深色（紫/青色调）
- nord — 北极蓝色调
- one-dark — Atom 编辑器深色
- tokyo-night — 柔和紫/蓝色调
- monokai — 经典编辑器深色
- solarized — Solarized 精确配色

### 代码主题

- auto (跟随编辑器)
- github-light
- github-dark
- one-dark-pro
- dracula
- monokai
- solarized-light
- solarized-dark

### Mermaid 主题 (beautiful-mermaid)

- default
- forest
- dark
- neutral
- 自定义 (通过 CSS 变量)

## 性能优化

1. **虚拟化渲染**: 大文档只渲染可视区域
2. **增量更新**: 只更新变化的部分
3. **Web Worker**: 后台解析 Markdown
4. **防抖处理**: 编辑时防抖更新预览
5. **懒加载**: 按需加载渲染器

## 实现计划

### Phase 1: 基础架构 (Week 1-2)

- [ ] 项目初始化和配置
- [ ] Extension 入口和激活逻辑
- [ ] 基础 Markdown 解析
- [ ] 简单 Webview 预览

### Phase 2: 核心功能 (Week 3-4)

- [ ] 并排预览布局
- [ ] 滚动同步实现
- [ ] 实时更新逻辑
- [ ] 配置系统

### Phase 3: 渲染器集成 (Week 5-6)

- [ ] beautiful-mermaid 集成
- [ ] KaTeX 集成
- [ ] Shiki 代码高亮
- [ ] Vega/WaveDrom 集成

### Phase 4: 高级功能 (Week 7-8)

- [ ] 最大化预览模式
- [ ] 主题系统
- [ ] 自定义 CSS 支持
- [ ] 导出功能

### Phase 5: 优化和测试 (Week 9-10)

- [ ] 性能优化
- [ ] E2E 测试
- [ ] 文档编写
- [ ] 发布准备

## API 参考

### PreviewManager

```typescript
class PreviewManager {
  // 打开预览
  openPreview(uri: vscode.Uri, options?: PreviewOptions): Promise<void>;

  // 关闭预览
  closePreview(uri: vscode.Uri): void;

  // 刷新预览
  refreshPreview(uri: vscode.Uri): void;

  // 最大化预览
  maximizePreview(uri: vscode.Uri): void;

  // 恢复并排模式
  restoreSideBySide(uri: vscode.Uri): void;

  // 切换滚动同步
  toggleScrollSync(): void;
}
```

### MarkdownEngine

```typescript
class MarkdownEngine {
  // 解析 Markdown
  parse(content: string, options?: ParseOptions): Promise<string>;

  // 注册渲染器
  registerRenderer(name: string, renderer: Renderer): void;

  // 移除渲染器
  unregisterRenderer(name: string): void;
}
```

## 与原项目的差异

| 功能     | 原项目 (markdown-preview-enhanced) | 新项目 (markdown-live-preview) |
| -------- | ---------------------------------- | ------------------------------ |
| Mermaid  | mermaid.js                         | beautiful-mermaid              |
| PlantUML | 支持                               | 不支持                         |
| 默认布局 | 单独预览                           | 并排预览                       |
| 滚动同步 | 部分支持                           | 完整支持                       |
| 主题     | crossnote 主题                     | 独立主题系统                   |
| 代码高亮 | prism.js                           | shiki                          |
| 核心引擎 | crossnote                          | 独立实现                       |

## 兼容性

- VSCode: ^1.85.0
- Node.js: ^18.0.0
- 浏览器 (Web 版): Chrome/Edge 120+, Firefox 120+, Safari 17+

## 许可证

MIT License
