[English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md)

# Markdown Live Preview

A modern VS Code extension for previewing Markdown — built for the AI era, where documents are generated first and read second.

> Preview-first. Because in the age of AI, you read more Markdown than you write.

## Why This Extension

AI tools like Claude, ChatGPT, and Copilot generate Markdown at scale — technical docs, reports, slide decks, research notes. The bottleneck is no longer writing; it's reviewing and presenting what was written. Markdown Live Preview is designed around this reality: open a file, see it rendered, navigate it, present it.

This project is a ground-up rewrite inspired by [Markdown Preview Enhanced](https://shd101wyy.github.io/markdown-preview-enhanced). We kept the ideas that matter — diagrams, math, TOC, presentations, code execution — and rebuilt the rendering engine for speed and simplicity.

## Features

### Three View Modes

Switch between modes from the editor title bar, command palette, or right-click menu:

| Mode | Shortcut | Description |
|------|----------|-------------|
| **Preview** | <kbd>Cmd+Shift+V</kbd> | Full-window rendered preview |
| **Side-by-Side** | <kbd>Cmd+K V</kbd> | Editor + preview with scroll sync |
| **Edit** | — | Editor only |

Default open mode is configurable: `edit`, `preview`, or `side-by-side`.

### Diagrams

#### Mermaid — Powered by [Beautiful Mermaid](https://agents.craft.do/mermaid)

Render flowcharts, sequence diagrams, Gantt charts, and more with curated visual themes:

````markdown
```mermaid
graph LR
    A[Markdown] --> B[Preview]
    B --> C[Present]
```
````

15 built-in mermaid themes: `github-light`, `github-dark`, `tokyo-night`, `catppuccin-mocha`, `dracula`, `nord`, `solarized-light`, and more. An ASCII rendering mode is also available for terminal-friendly output.

#### Kroki — 20+ Diagram Languages

Use `{kroki=true}` to render diagrams via the [Kroki](https://kroki.io) API:

````markdown
```plantuml {kroki=true}
Alice -> Bob: Hello
Bob --> Alice: Hi
```
````

Supported languages: PlantUML, GraphViz/DOT, D2, Ditaa, BlockDiag, Mermaid, Nomnoml, Pikchr, Excalidraw, SVGBob, Structurizr, ERD, DBML, TikZ, WireViz, and more.

#### Also Built-in

- **WaveDrom** — digital timing diagrams
- **Viz/DOT** — GraphViz diagrams (client-side)
- **Vega / Vega-Lite** — data visualizations

### Math

KaTeX (default) or MathJax for rendering LaTeX math expressions:

```markdown
Inline: $E = mc^2$

Block:
$$
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
$$
```

Delimiters are customizable. Both `$...$` / `$$...$$` and `\(...\)` / `\[...\]` are supported out of the box.

### Presentations — Marp

Write slide decks in Markdown with [Marp](https://marp.app). Add `marp: true` to front matter and use `---` to separate slides:

```markdown
---
marp: true
theme: default
paginate: true
---

# Slide 1

Content here

---

# Slide 2

More content
```

Front matter keys `slideshow` and `presentation` are also recognized for compatibility.

The preview includes a **Play** button for fullscreen presentation mode with keyboard and mouse navigation.

### Table of Contents

#### Inline TOC

Write `[TOC]` anywhere in your document to insert a rendered table of contents:

```markdown
[TOC]

## Introduction
## Getting Started
## API Reference
```

#### Sidebar TOC

A collapsible sidebar TOC is available via the preview context menu. Toggle with <kbd>Esc</kbd>.

#### TOC Configuration

Control depth and ordering via front matter:

```yaml
---
toc:
  depth_from: 2
  depth_to: 4
  ordered: true
---
```

Exclude headings from the TOC:

```markdown
## Internal Notes {ignore=true}
```

### File Imports

Import external files with `@import`:

```markdown
@import "diagram.mermaid"
@import "data.csv"
@import "styles.css"
@import "photo.png" {width=300}
@import "chapter2.md"
@import "code.py" {code_block=true}
```

Supported: Markdown, images (jpg/png/svg/gif/webp/bmp), CSV (rendered as tables), CSS/LESS, JavaScript, HTML, Mermaid, and any text file (as code blocks). Options include `line_begin`, `line_end`, `hide`, `width`, `height`, and more.

### Code Chunks

Execute code blocks directly in the preview (opt-in, disabled by default for security):

````markdown
```python {cmd=true}
import math
print(f"Pi = {math.pi:.10f}")
```
````

30+ languages supported including Python, JavaScript/TypeScript, Go, Rust, C/C++, Ruby, Bash, R, and LaTeX. Features include:

- Piped stdin, command-line arguments
- Output as text, HTML, Markdown, or PNG
- Python matplotlib support with inline image rendering
- LaTeX compilation with configurable engines (pdflatex/xelatex/lualatex)
- Chunk continuation and cross-referencing via `id` and `continue`

### Syntax Highlighting

[Shiki](https://shiki.matsu.io)-based syntax highlighting with 12 themes: `github-dark`, `github-light`, `monokai`, `one-dark-pro`, `dracula`, `nord`, `material-theme-darker`, `solarized-dark`, `vitesse-dark`, and more. Set to `auto` to match the preview theme.

### Preview Themes

16 preview themes: `github-light`, `github-dark`, `one-dark`, `one-light`, `solarized-dark`, `solarized-light`, `atom-dark`, `atom-light`, `atom-material`, `gothic`, `medium`, `monokai`, `newsprint`, `night`, `vue`, and `none`.

Color scheme can follow the selected theme, the system setting, or the editor's light/dark mode.

### Additional Features

- **Wiki Links** — `[[page]]` and `[[page|display text]]` syntax with configurable case transformation
- **Emoji** — `:smile:` syntax via markdown-it-emoji
- **Footnotes** — `[^1]` reference-style footnotes
- **Subscript / Superscript** — `H~2~O` and `x^2^`
- **Task Lists** — `- [x] Done` checkboxes
- **Linkify** — auto-detect URLs
- **Scroll Sync** — bidirectional scroll synchronization between editor and preview
- **Live Update** — real-time preview with configurable debounce
- **Front Matter** — render as table, code block, or hide
- **Custom CSS** — apply your own styles to the preview
- **Image Helper** — paste and manage images
- **Zen Mode** — hide UI elements in preview until hover

## Supported File Types

`.md`, `.markdown`, `.mdown`, `.mkdn`, `.mkd`, `.rmd`, `.qmd`, `.mdx`

## Keyboard Shortcuts

> <kbd>Cmd</kbd> on macOS, <kbd>Ctrl</kbd> on Windows/Linux.

| Shortcut | Action |
|----------|--------|
| <kbd>Cmd+K V</kbd> | Open preview to the side |
| <kbd>Cmd+Shift+V</kbd> | Open preview |
| <kbd>Ctrl+Shift+S</kbd> | Sync preview / Sync source |
| <kbd>Shift+Enter</kbd> | Run code chunk |
| <kbd>Cmd+Shift+Enter</kbd> | Run all code chunks |
| <kbd>Esc</kbd> | Toggle sidebar TOC |

## Configuration

All settings are under the `markdown-live-preview` namespace. Key options:

| Setting | Default | Description |
|---------|---------|-------------|
| `markdownOpenMode` | `side-by-side` | Default mode when opening Markdown files |
| `previewTheme` | `github-light.css` | Preview theme |
| `codeBlockTheme` | `auto` | Syntax highlighting theme |
| `mermaidTheme` | `github-light` | Mermaid diagram theme |
| `mathRenderingOption` | `KaTeX` | Math rendering engine |
| `scrollSync` | `true` | Bidirectional scroll sync |
| `liveUpdate` | `true` | Real-time preview updates |
| `breakOnSingleNewLine` | `true` | GFM-style line breaks |
| `enableScriptExecution` | `false` | Code chunk execution |
| `enableWikiLinkSyntax` | `true` | Wiki link support |
| `enableEmojiSyntax` | `true` | Emoji support |

See the full settings list in VS Code: **Settings > Extensions > Markdown Live Preview**.

## Acknowledgments

This project draws heavily from the ideas and design of [Markdown Preview Enhanced](https://shd101wyy.github.io/markdown-preview-enhanced) by Yiyi Wang. Mermaid diagrams are rendered using the [Beautiful Mermaid](https://agents.craft.do/mermaid) service. Presentation support is powered by [Marp](https://marp.app).

## Contributing

We welcome contributions — with one rule: **all code submissions must be AI-generated.** We believe AI-assisted development produces higher-quality, more consistent code. Use tools like Claude, ChatGPT, Copilot, or any AI coding assistant to write your contributions. Human-written code will not be accepted.

## License

[MIT](LICENSE.md)
