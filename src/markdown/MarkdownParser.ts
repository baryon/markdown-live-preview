/**
 * Markdown Parser - wraps markdown-it with extensions
 */

// Use require for CommonJS compatibility
const MarkdownIt = require('markdown-it');
const markdownItEmoji = require('markdown-it-emoji');
const markdownItFootnote = require('markdown-it-footnote');
const markdownItSub = require('markdown-it-sub');
const markdownItSup = require('markdown-it-sup');
const markdownItTaskLists = require('markdown-it-task-lists');

// eslint-disable-next-line @typescript-eslint/no-require-imports
type MarkdownItType = ReturnType<typeof MarkdownIt>;

import { getFullConfig } from '../config/ConfigManager';
import type { MarkdownLivePreviewConfig } from '../types';

export interface MarkdownParserOptions {
  html?: boolean;
  xhtmlOut?: boolean;
  breaks?: boolean;
  langPrefix?: string;
  linkify?: boolean;
  typographer?: boolean;
  quotes?: string;
}

/**
 * Create and configure a markdown-it instance
 */
/**
 * Generate a URL-friendly slug from heading text.
 * Strips {attr} syntax, special characters, and normalizes whitespace.
 */
export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\{[^}]*\}/g, '') // Strip {attr} syntax
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') // Trim leading/trailing hyphens
    .trim();
}

export function createMarkdownParser(
  configOverrides?: Partial<MarkdownLivePreviewConfig>,
): MarkdownItType {
  const config = { ...getFullConfig(), ...configOverrides };

  const mdOptions: MarkdownParserOptions = {
    html: true,
    xhtmlOut: false,
    breaks: config.markdown.breakOnSingleNewLine,
    langPrefix: 'language-',
    linkify: config.markdown.enableLinkify,
    typographer: config.markdown.enableTypographer,
    quotes: '"\u201C\u201D\u2018\u2019"',
  };

  const md = new MarkdownIt(mdOptions);

  // Enable emoji plugin
  if (config.markdown.enableEmojiSyntax) {
    md.use(markdownItEmoji.full);
  }

  // Enable footnote plugin
  md.use(markdownItFootnote);

  // Enable subscript/superscript
  md.use(markdownItSub);
  md.use(markdownItSup);

  // Enable task lists
  md.use(markdownItTaskLists, {
    enabled: true,
    label: true,
    labelAfter: true,
  });

  // Wiki link support
  if (config.wikiLink.enabled) {
    enableWikiLinks(md, config);
  }

  // Custom fence renderer for diagram languages (mermaid, etc.)
  installDiagramFenceRenderer(md, config.codeChunk.enableScriptExecution);

  // Add data-line attributes for scroll sync
  md.core.ruler.push(
    'source_line_mapping',
    (state: {
      env?: Record<string, unknown>;
      tokens: Array<{
        map: [number, number] | null;
        nesting: number;
        attrSet: (name: string, value: string) => void;
      }>;
    }) => {
      const offset = (state.env?.lineOffset as number) || 0;
      for (const token of state.tokens) {
        if (token.map && token.nesting >= 0) {
          token.attrSet('data-line', String(token.map[0] + offset));
        }
      }
    },
  );

  // Add heading IDs and process {ignore=true} attributes
  md.core.ruler.push(
    'heading_ids',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (state: { tokens: any[] }) => {
      const slugCounts: Record<string, number> = {};

      for (let i = 0; i < state.tokens.length; i++) {
        const token = state.tokens[i];
        if (token.type !== 'heading_open') continue;

        // Collect text from the next inline token
        const inlineToken = state.tokens[i + 1];
        if (!inlineToken || inlineToken.type !== 'inline') continue;

        // Build full text from inline children
        let fullText = '';
        const children = inlineToken.children || [];
        for (const child of children) {
          if (child.type === 'text' || child.type === 'code_inline') {
            fullText += child.content;
          }
        }

        // Check for {ignore=true} in the raw text
        const hasIgnore = /\{[^}]*ignore\s*=\s*true[^}]*\}/.test(fullText);
        if (hasIgnore) {
          token.attrSet('data-toc-ignore', 'true');
        }

        // Strip {attr} syntax from inline children so it doesn't render
        for (const child of children) {
          if (child.type === 'text') {
            child.content = child.content
              .replace(/\s*\{[^}]*\}\s*/g, '')
              .trim();
          }
        }

        // Regenerate fullText after stripping
        fullText = '';
        for (const child of children) {
          if (child.type === 'text' || child.type === 'code_inline') {
            fullText += child.content;
          }
        }

        // Generate slug and handle duplicates
        let slug = generateSlug(fullText);
        if (!slug) slug = 'heading';
        if (slugCounts[slug] !== undefined) {
          slugCounts[slug]++;
          slug = `${slug}-${slugCounts[slug]}`;
        } else {
          slugCounts[slug] = 0;
        }

        token.attrSet('id', slug);
      }
    },
  );

  return md;
}

/**
 * Diagram languages rendered client-side in the browser.
 * Maps language name → CSS class used on the container div.
 */
const DIAGRAM_LANGUAGES: Record<string, string> = {
  'mermaid': 'mermaid',
  'wavedrom': 'wavedrom',
  'viz': 'graphviz',
  'dot': 'graphviz',
  'vega': 'vega',
  'vega-lite': 'vega-lite',
  'recharts': 'recharts',
};

/**
 * Kroki-supported diagram types.
 * Any code block with {kroki=true} whose language is in this set
 * will be rendered via the Kroki API.
 */
const KROKI_LANGUAGES = new Set([
  'ditaa',
  'blockdiag',
  'seqdiag',
  'actdiag',
  'nwdiag',
  'packetdiag',
  'rackdiag',
  'umlet',
  'graphviz',
  'dot',
  'plantuml',
  'svgbob',
  'nomnoml',
  'erd',
  'pikchr',
  'structurizr',
  'excalidraw',
  'wireviz',
  'd2',
  'dbml',
  'tikz',
  'bytefield',
]);

/**
 * Parse a fenced code block info string into language + attributes.
 * e.g. "mermaid {code_block=true}" → { language: "mermaid", attrs: { code_block: "true" } }
 *
 * Supports:
 * - key=value, key="quoted", key='quoted'
 * - Bare flags: `cmd` → cmd=true, `hide` → hide=true
 * - CSS class shorthand: `.line-numbers` → class=line-numbers
 * - Array values: `args=["-v", "--flag"]` (preserved as string)
 */
export function parseInfoString(info: string): {
  language: string;
  attrs: Record<string, string>;
} {
  const trimmed = info.trim();
  const attrs: Record<string, string> = {};

  // Match: language {key=value key2=value2 ...}
  const match = trimmed.match(/^(\S+?)(?:\s+\{(.+)\})?\s*$/);
  if (!match) {
    return { language: trimmed, attrs };
  }

  const language = match[1];
  const attrStr = match[2];

  if (attrStr) {
    let pos = 0;
    const str = attrStr.trim();

    while (pos < str.length) {
      // Skip whitespace
      while (pos < str.length && /\s/.test(str[pos])) pos++;
      if (pos >= str.length) break;

      // CSS class shorthand: .className
      if (str[pos] === '.') {
        pos++;
        let cls = '';
        while (pos < str.length && /[\w-]/.test(str[pos])) {
          cls += str[pos++];
        }
        if (cls) {
          attrs.class = attrs.class ? `${attrs.class} ${cls}` : cls;
        }
        continue;
      }

      // Read key
      let key = '';
      while (pos < str.length && /[\w_]/.test(str[pos])) {
        key += str[pos++];
      }

      if (!key) {
        pos++;
        continue;
      }

      // Skip whitespace
      while (pos < str.length && str[pos] === ' ') pos++;

      // Check for =
      if (pos < str.length && str[pos] === '=') {
        pos++; // skip =
        while (pos < str.length && str[pos] === ' ') pos++;

        let value = '';

        if (pos < str.length && str[pos] === '[') {
          // Array value: args=["-v", "--flag"]
          const start = pos;
          let depth = 0;
          while (pos < str.length) {
            if (str[pos] === '[') depth++;
            else if (str[pos] === ']') {
              depth--;
              if (depth === 0) {
                pos++;
                break;
              }
            }
            pos++;
          }
          value = str.substring(start, pos);
        } else if (pos < str.length && (str[pos] === '"' || str[pos] === "'")) {
          // Quoted value
          const quote = str[pos++];
          while (pos < str.length && str[pos] !== quote) {
            value += str[pos++];
          }
          if (pos < str.length) pos++; // skip closing quote
        } else {
          // Unquoted value
          while (pos < str.length && !/\s/.test(str[pos])) {
            value += str[pos++];
          }
        }

        attrs[key] = value;
      } else {
        // Bare flag: key → key=true
        attrs[key] = 'true';
      }
    }
  }

  return { language, attrs };
}

/**
 * Escape HTML entities
 */
function escapeHtmlForFence(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Encode diagram source for Kroki GET API.
 * Kroki expects: deflate compress → base64url encode.
 */
function krokiEncode(str: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require('node:zlib');
  const compressed = zlib.deflateSync(Buffer.from(str, 'utf-8'));
  // base64url: replace + with -, / with _, strip trailing =
  return compressed
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a code block with line numbers for code_block=true / cmd=false fences
 */
function generateLineNumberedCodeBlock(
  content: string,
  language: string,
  dataLine?: string,
  includeContainer = true,
): string {
  const lines = content.split('\n');
  // Remove trailing empty line that fenced code blocks often have
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const langClass = language ? ` language-${escapeHtmlForFence(language)}` : '';
  const dlAttr = dataLine ? ` data-line="${dataLine}"` : '';
  const lineHtml = lines
    .map(
      (line, i) =>
        `<span class="code-line"><span class="line-number">${
          i + 1
        }</span><span class="line-content">${escapeHtmlForFence(
          line,
        )}</span></span>`,
    )
    .join('');
  const preBlock = `<pre class="code-block-with-line-numbers${langClass}"${dlAttr}><code>${lineHtml}</code></pre>`;

  if (!includeContainer) {
    return `${preBlock}\n`;
  }

  // Wrap in container with hover controls (Copy button)
  return (
    `<div class="code-block-container"${dlAttr}>` +
    `<div class="code-block-controls">` +
    `<button class="code-copy-btn" title="Copy code">Copy</button>` +
    `</div>` +
    preBlock +
    `</div>\n`
  );
}

/**
 * Install a custom fence renderer that handles diagram languages
 * by rendering them as special containers instead of plain <pre><code>.
 *
 * Supported:
 *  - mermaid       → <div class="mermaid">
 *  - wavedrom      → <div class="wavedrom"> (JSON stored in script tag)
 *  - viz / dot     → <div class="graphviz" data-engine="...">
 *  - vega          → <div class="vega">
 *  - vega-lite     → <div class="vega-lite">
 *  - {kroki=true}  → <img> via Kroki API
 *  - {code_block=true} / {cmd=false} → show source code only
 */
function installDiagramFenceRenderer(
  md: MarkdownItType,
  enableScriptExecution: boolean,
): void {
  const defaultFence =
    md.renderer.rules.fence ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((tokens: any[], idx: number, options: any, _env: any, self: any) =>
      self.renderToken(tokens, idx, options));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.renderer.rules.fence = (
    tokens: any[],
    idx: number,
    options: any,
    env: any,
    self: any,
  ) => {
    const token = tokens[idx];
    const info = token.info || '';
    const { language, attrs } = parseInfoString(info);
    const content = token.content;

    // Read data-line attribute set by source_line_mapping ruler
    const dataLine = token.attrGet ? token.attrGet('data-line') : null;
    const dlAttr = dataLine !== null ? ` data-line="${dataLine}"` : '';

    // Code chunk: {cmd=...} (not false) → render as interactive code chunk container
    if (attrs.cmd && attrs.cmd !== 'false') {
      // Track code chunk index via env to stay in sync with CodeChunkManager
      if (env._codeChunkIndex === undefined) env._codeChunkIndex = 0;
      const chunkId = attrs.id || `chunk-${env._codeChunkIndex}`;
      env._codeChunkIndex++;
      const cmdValue = attrs.cmd === 'true' ? language : attrs.cmd;
      const outputFormat = attrs.output || 'text';
      const hideSource = attrs.hide === 'true';
      const attrsJson = escapeHtmlForFence(JSON.stringify(attrs));

      let sourceHtml = '';
      if (!hideSource) {
        // Don't wrap in container since code-chunk already has controls
        sourceHtml = generateLineNumberedCodeBlock(
          content,
          language,
          dataLine ?? undefined,
          false, // don't include container
        );
      }

      // Build controls HTML - always include Copy button, conditionally include Run
      let controlsHtml = `<div class="code-chunk-controls">`;
      if (enableScriptExecution) {
        controlsHtml +=
          `<button class="code-chunk-run-btn" data-chunk-id="${escapeHtmlForFence(
            chunkId,
          )}">&#9654; Run</button>` +
          `<span class="code-chunk-status" data-chunk-id="${escapeHtmlForFence(
            chunkId,
          )}"></span>`;
      }
      controlsHtml += `<button class="code-copy-btn" title="Copy code">Copy</button>`;
      controlsHtml += `</div>`;

      return (
        `<div class="code-chunk" data-chunk-id="${escapeHtmlForFence(
          chunkId,
        )}" data-lang="${escapeHtmlForFence(
          language,
        )}" data-cmd="${escapeHtmlForFence(
          cmdValue,
        )}" data-attrs="${attrsJson}" data-output="${escapeHtmlForFence(
          outputFormat,
        )}"${dlAttr}>` +
        controlsHtml +
        `<div class="code-chunk-source">${sourceHtml}</div>` +
        `<div class="code-chunk-output" data-chunk-id="${escapeHtmlForFence(
          chunkId,
        )}"></div>` +
        `</div>\n`
      );
    }

    // {code_block=true} or {cmd=false} → render as plain code block with line numbers
    if (attrs.code_block === 'true' || attrs.cmd === 'false') {
      return generateLineNumberedCodeBlock(
        content,
        language,
        dataLine ?? undefined,
      );
    }

    // {kroki=true} → render via Kroki server
    if (attrs.kroki === 'true' && KROKI_LANGUAGES.has(language)) {
      const encoded = krokiEncode(content);
      const krokiUrl = `https://kroki.io/${encodeURIComponent(language)}/svg/${encoded}`;
      const krokiControls =
        `<div class="diagram-controls">` +
        `<button class="diagram-toggle-btn" title="Toggle controls">⋯</button>` +
        `<div class="diagram-controls-expanded">` +
        `<button class="diagram-copy-source-btn" title="Copy source code">Code</button>` +
        `<button class="diagram-copy-svg-btn" title="Copy as SVG">SVG</button>` +
        `<button class="diagram-copy-png-btn" title="Copy as PNG">PNG</button>` +
        `</div>` +
        `</div>`;
      return (
        `<div class="diagram-container kroki-container"${dlAttr}>` +
        krokiControls +
        `<div class="kroki-diagram" data-source="${escapeHtmlForFence(content)}" data-svg-url="${escapeHtmlForFence(krokiUrl)}">` +
        `<img src="${krokiUrl}" alt="${escapeHtmlForFence(language)} diagram" />` +
        `</div>` +
        `</div>\n`
      );
    }

    const diagramClass = DIAGRAM_LANGUAGES[language];
    if (diagramClass) {
      // Build diagram controls HTML
      const buildDiagramControls = (isMermaid: boolean): string => {
        let controls = `<div class="diagram-controls">`;
        // Toggle button (always visible)
        controls += `<button class="diagram-toggle-btn" title="Toggle controls">⋯</button>`;
        // Expandable buttons container
        controls += `<div class="diagram-controls-expanded">`;
        controls += `<button class="diagram-copy-source-btn" title="Copy source code">Code</button>`;
        controls += `<button class="diagram-copy-svg-btn" title="Copy as SVG">SVG</button>`;
        controls += `<button class="diagram-copy-png-btn" title="Copy as PNG">PNG</button>`;
        if (isMermaid) {
          controls += `<select class="diagram-theme-select" title="Mermaid theme">`;
          controls += `<optgroup label="Light">`;
          controls += `<option value="github-light">GitHub Light</option>`;
          controls += `<option value="solarized-light">Solarized Light</option>`;
          controls += `<option value="catppuccin-latte">Catppuccin Latte</option>`;
          controls += `<option value="nord-light">Nord Light</option>`;
          controls += `<option value="tokyo-night-light">Tokyo Night Light</option>`;
          controls += `<option value="zinc-light">Zinc Light</option>`;
          controls += `</optgroup>`;
          controls += `<optgroup label="Dark">`;
          controls += `<option value="github-dark">GitHub Dark</option>`;
          controls += `<option value="solarized-dark">Solarized Dark</option>`;
          controls += `<option value="catppuccin-mocha">Catppuccin Mocha</option>`;
          controls += `<option value="nord">Nord</option>`;
          controls += `<option value="tokyo-night">Tokyo Night</option>`;
          controls += `<option value="tokyo-night-storm">Tokyo Night Storm</option>`;
          controls += `<option value="zinc-dark">Zinc Dark</option>`;
          controls += `<option value="one-dark">One Dark</option>`;
          controls += `<option value="dracula">Dracula</option>`;
          controls += `</optgroup>`;
          controls += `</select>`;
          controls += `<button class="diagram-ascii-btn" title="Toggle ASCII mode">ASCII</button>`;
        }
        controls += `</div>`; // close diagram-controls-expanded
        controls += `</div>`;
        return controls;
      };

      // Mermaid: raw content inside div (mermaid.js parses it)
      if (diagramClass === 'mermaid') {
        const controls = buildDiagramControls(true);
        return (
          `<div class="diagram-container mermaid-container"${dlAttr}>` +
          controls +
          `<div class="mermaid" data-source="${escapeHtmlForFence(content)}">\n${content}</div>` +
          `</div>\n`
        );
      }

      // WaveDrom: content is JSON, stored in a <script> tag for WaveDrom
      if (diagramClass === 'wavedrom') {
        const id = `wavedrom-${idx}`;
        const controls = buildDiagramControls(false);
        return (
          `<div class="diagram-container wavedrom-container"${dlAttr}>` +
          controls +
          `<div class="wavedrom" id="${id}" data-source="${escapeHtmlForFence(content)}"><script type="WaveDrom">${content}</script></div>` +
          `</div>\n`
        );
      }

      // GraphViz (viz / dot): store source in a div, with optional engine attribute
      if (diagramClass === 'graphviz') {
        const engine = attrs.engine || 'dot';
        const controls = buildDiagramControls(false);
        return (
          `<div class="diagram-container graphviz-container"${dlAttr}>` +
          controls +
          `<div class="graphviz" data-engine="${escapeHtmlForFence(engine)}" data-source="${escapeHtmlForFence(content)}">${escapeHtmlForFence(content)}</div>` +
          `</div>\n`
        );
      }

      // Vega / Vega-Lite: store spec in a <script> tag inside a container
      if (diagramClass === 'vega' || diagramClass === 'vega-lite') {
        const id = `${diagramClass}-${idx}`;
        const controls = buildDiagramControls(false);
        return (
          `<div class="diagram-container ${diagramClass}-container"${dlAttr}>` +
          controls +
          `<div class="${diagramClass}" id="${id}" data-source="${escapeHtmlForFence(content)}"><script type="application/json">${content}</script></div>` +
          `</div>\n`
        );
      }

      // Recharts: React-based charting library, store source in script tag
      if (diagramClass === 'recharts') {
        const id = `recharts-${idx}`;
        const controls = buildDiagramControls(false);
        return (
          `<div class="diagram-container recharts-container"${dlAttr}>` +
          controls +
          `<div class="recharts" id="${id}">` +
          `<script type="text/recharts">${content}</script>` +
          `<div class="recharts-loading" style="padding:20px;text-align:center;color:#666;">` +
          `<span>📊 Loading Recharts...</span>` +
          `</div>` +
          `</div>` +
          `</div>\n`
        );
      }
    }

    // For non-diagram languages, render as code block with line numbers and copy button
    return generateLineNumberedCodeBlock(
      content,
      language,
      dataLine ?? undefined,
    );
  };
}

/**
 * Enable wiki link support in markdown-it
 */
function enableWikiLinks(
  md: MarkdownItType,
  config: MarkdownLivePreviewConfig,
): void {
  // Wiki link pattern: [[link]] or [[link|text]] or [[text|link]]
  const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

  md.core.ruler.push('wiki_link', (state) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'inline') {
        continue;
      }

      const inlineTokens = tokens[i].children;
      if (!inlineTokens) {
        continue;
      }

      for (let j = 0; j < inlineTokens.length; j++) {
        const token = inlineTokens[j];
        if (token.type !== 'text') {
          continue;
        }

        const content = token.content;
        const matches = [...content.matchAll(wikiLinkRegex)];

        if (matches.length === 0) {
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newTokens: any[] = [];
        let lastIndex = 0;

        for (const match of matches) {
          const [fullMatch, firstPart, secondPart] = match;
          const matchIndex = match.index!;

          // Add text before the match
          if (matchIndex > lastIndex) {
            const textToken = new state.Token('text', '', 0);
            textToken.content = content.slice(lastIndex, matchIndex);
            newTokens.push(textToken);
          }

          // Determine link and text based on GitHub style or Wikipedia style
          let linkTarget: string;
          let linkText: string;

          if (secondPart !== undefined) {
            if (config.wikiLink.useGitHubStylePipedLink) {
              // GitHub style: [[linkText|wikiLink]]
              linkText = firstPart.trim();
              linkTarget = secondPart.trim();
            } else {
              // Wikipedia style: [[wikiLink|linkText]]
              linkTarget = firstPart.trim();
              linkText = secondPart.trim();
            }
          } else {
            linkTarget = firstPart.trim();
            linkText = firstPart.trim();
          }

          // Add file extension if not present
          if (
            !linkTarget.includes('.') &&
            config.wikiLink.targetFileExtension
          ) {
            linkTarget += config.wikiLink.targetFileExtension;
          }

          // Apply case transformation
          linkTarget = applyCase(
            linkTarget,
            config.wikiLink.targetFileNameChangeCase,
          );

          // Create link tokens
          const linkOpenToken = new state.Token('link_open', 'a', 1);
          linkOpenToken.attrs = [['href', linkTarget]];
          linkOpenToken.attrSet('class', 'wiki-link');
          newTokens.push(linkOpenToken);

          const textToken = new state.Token('text', '', 0);
          textToken.content = linkText;
          newTokens.push(textToken);

          const linkCloseToken = new state.Token('link_close', 'a', -1);
          newTokens.push(linkCloseToken);

          lastIndex = matchIndex + fullMatch.length;
        }

        // Add remaining text
        if (lastIndex < content.length) {
          const textToken = new state.Token('text', '', 0);
          textToken.content = content.slice(lastIndex);
          newTokens.push(textToken);
        }

        // Replace the original token with new tokens
        if (newTokens.length > 0) {
          inlineTokens.splice(j, 1, ...newTokens);
          j += newTokens.length - 1;
        }
      }
    }
  });
}

/**
 * Apply case transformation to a string
 */
function applyCase(str: string, caseType: string): string {
  switch (caseType) {
    case 'camelCase':
      return str
        .replace(/[_-\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
        .replace(/^(.)/, (c) => c.toLowerCase());
    case 'pascalCase':
      return str
        .replace(/[_-\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
        .replace(/^(.)/, (c) => c.toUpperCase());
    case 'kebabCase':
      return str
        .replace(/[_\s]+/g, '-')
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase();
    case 'snakeCase':
      return str
        .replace(/[-\s]+/g, '_')
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toLowerCase();
    case 'constantCase':
      return str
        .replace(/[-\s]+/g, '_')
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toUpperCase();
    case 'lowerCase':
      return str.toLowerCase();
    case 'upperCase':
      return str.toUpperCase();
    default:
      return str;
  }
}

export class MarkdownParser {
  private md: MarkdownItType;
  private config: MarkdownLivePreviewConfig;

  constructor(configOverrides?: Partial<MarkdownLivePreviewConfig>) {
    this.config = { ...getFullConfig(), ...configOverrides };
    this.md = createMarkdownParser(this.config);
  }

  /**
   * Render markdown to HTML
   */
  render(markdown: string, env?: Record<string, unknown>): string {
    return this.md.render(markdown, env || {});
  }

  /**
   * Render markdown inline (no paragraph wrapping)
   */
  renderInline(markdown: string): string {
    return this.md.renderInline(markdown);
  }

  /**
   * Get the markdown-it instance for advanced customization
   */
  getMarkdownIt(): MarkdownItType {
    return this.md;
  }

  /**
   * Update configuration
   */
  updateConfig(configOverrides: Partial<MarkdownLivePreviewConfig>): void {
    this.config = { ...this.config, ...configOverrides };
    this.md = createMarkdownParser(this.config);
  }
}
