/**
 * Main Markdown Engine - combines all renderers
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import { getFullConfig } from '../config/ConfigManager';
import {
  FrontMatterRenderingOption,
  type MarkdownLivePreviewConfig,
  MathRenderingOption,
  type RendererOptions,
} from '../types';
import { generateSlug, MarkdownParser } from './MarkdownParser';
import { MdxProcessor } from './MdxProcessor';
import { type CodeRenderer, getCodeRenderer } from './renderers/CodeRenderer';
import { getKatexRenderer, KatexRenderer } from './renderers/KatexRenderer';

// Marp Core for native Marp rendering (may not be available in web extension)
let MarpClass:
  | (new (
      opts?: Record<string, unknown>,
    ) => {
      render: (md: string) => {
        html: string;
        css: string;
        comments: string[][];
      };
    })
  | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  MarpClass = require('@marp-team/marp-core').Marp;
} catch {
  // Marp Core not available (e.g., web extension)
}

export interface RenderOptions extends RendererOptions {
  vscodePreviewPanel?: vscode.WebviewPanel;
}

export interface HTMLTemplateOptions {
  inputString: string;
  config?: {
    sourceUri?: string;
    cursorLine?: number;
    isVSCode?: boolean;
    scrollSync?: boolean;
  };
  contentSecurityPolicy?: string;
  vscodePreviewPanel?: vscode.WebviewPanel;
  isVSCodeWebExtension?: boolean;
}

export class MarkdownEngine {
  private parser: MarkdownParser;
  private codeRenderer: CodeRenderer;
  private katexRenderer: KatexRenderer;
  private config: MarkdownLivePreviewConfig;
  private caches: Map<string, unknown> = new Map();
  public isPreviewInPresentationMode = false;

  constructor(configOverrides?: Partial<MarkdownLivePreviewConfig>) {
    this.config = { ...getFullConfig(), ...configOverrides };
    this.parser = new MarkdownParser(this.config);
    this.codeRenderer = getCodeRenderer();
    this.katexRenderer = getKatexRenderer();
  }

  /**
   * Parse markdown and return HTML with metadata
   */
  async parseMD(
    markdown: string,
    options?: RenderOptions,
  ): Promise<{
    html: string;
    tocHTML: string;
    frontMatterForTOC: string;
    JSAndCssFiles: string[];
    yamlConfig: Record<string, unknown>;
  }> {
    // Extract front matter
    const { frontMatter, content } = this.extractFrontMatter(markdown);

    // Calculate front matter line offset for scroll sync
    let lineOffset = 0;
    if (frontMatter) {
      const fmMatch = markdown.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
      if (fmMatch) {
        lineOffset = fmMatch[0].split('\n').length - 1;
      }
    }

    // Process @import directives
    let processedContent = content;
    if (options?.sourceUri) {
      try {
        const sourcePath = vscode.Uri.parse(options.sourceUri).fsPath;
        processedContent = await this.processImports(content, sourcePath);
      } catch (error) {
        console.warn('Failed to process @import directives:', error);
      }
    }

    // Process MDX content (JSX expressions, exports, styled blocks) for .mdx files
    if (options?.sourceUri) {
      try {
        const ext = path
          .extname(vscode.Uri.parse(options.sourceUri).fsPath)
          .toLowerCase();
        if (ext === '.mdx') {
          const mdxProcessor = new MdxProcessor();
          const mdxResult = mdxProcessor.process(processedContent);
          processedContent = mdxResult.content;
        }
      } catch (error) {
        console.warn('Failed to process MDX content:', error);
      }
    }

    // Render markdown to HTML
    // (Mermaid blocks are handled by the custom fence renderer in MarkdownParser)
    let html = this.parser.render(processedContent, { lineOffset });

    // Resolve relative image paths to data URIs for webview compatibility
    if (options?.sourceUri) {
      try {
        const sourcePath = vscode.Uri.parse(options.sourceUri).fsPath;
        html = this.resolveImagePaths(html, path.dirname(sourcePath));
      } catch (error) {
        console.warn('Failed to resolve image paths:', error);
      }
    }

    // Process Obsidian-style callouts
    html = this.processCallouts(html);

    // Process math expressions
    html = this.katexRenderer.processMathInContent(html);

    // Process code blocks with syntax highlighting
    html = await this.processCodeBlocks(html);

    // Generate TOC HTML
    const tocHTML = this.generateTOC(markdown, frontMatter);

    // Generate front matter HTML for TOC sidebar panel
    const frontMatterForTOC = this.generateFrontMatterForTOC(frontMatter);

    // Replace [TOC] placeholder in rendered HTML
    // Note: <p> may have attributes like data-line from source_line_mapping
    html = html.replace(
      /<p[^>]*>\[TOC\]<\/p>/gi,
      tocHTML ? `<div class="table-of-contents">${tocHTML}</div>` : '',
    );

    // Render front matter if needed
    const frontMatterHTML = this.renderFrontMatter(frontMatter);
    if (frontMatterHTML) {
      html = frontMatterHTML + html;
    }

    // Determine required JS/CSS files
    const JSAndCssFiles: string[] = [];

    // Add KaTeX CSS if math is enabled
    if (this.config.math.renderingOption !== 'None') {
      JSAndCssFiles.push(KatexRenderer.getCssUrl());
    }

    // Check for presentation mode (marp, slideshow, or presentation)
    const yamlConfig = frontMatter || {};
    this.isPreviewInPresentationMode =
      !!yamlConfig.marp || !!yamlConfig.slideshow || !!yamlConfig.presentation;

    return {
      html,
      tocHTML,
      frontMatterForTOC,
      JSAndCssFiles,
      yamlConfig: {
        ...yamlConfig,
        isPresentationMode: this.isPreviewInPresentationMode,
      },
    };
  }

  /**
   * Generate HTML template for preview
   */
  async generateHTMLTemplateForPreview(
    options: HTMLTemplateOptions,
  ): Promise<string> {
    const { inputString, config: templateConfig } = options;

    // Detect presentation mode from front matter
    if (this.isPresentationMarkdown(inputString)) {
      this.isPreviewInPresentationMode = true;

      // .mdx presentations use Reveal.js (supports JSX, MDX expressions, diagrams)
      const sourceExt = templateConfig?.sourceUri
        ? path
            .extname(vscode.Uri.parse(templateConfig.sourceUri).fsPath)
            .toLowerCase()
        : '';
      if (sourceExt === '.mdx') {
        return this.generateRevealTemplate(inputString, templateConfig);
      }

      // .md presentations use Marp (backward-compatible)
      if (MarpClass) {
        return this.generateMarpTemplate(inputString, templateConfig);
      }
    }

    // Parse the markdown
    const { html, tocHTML, frontMatterForTOC, yamlConfig } = await this.parseMD(
      inputString,
      {
        sourceUri: templateConfig?.sourceUri,
      },
    );

    // Get theme CSS
    const themeCSS = this.getThemeCSS();

    // Sidebar TOC: always hidden by default, toggled via context menu
    const hasTOC = tocHTML.length > 0 || frontMatterForTOC.length > 0;

    // Generate the HTML template
    const template = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' https: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https:;">
  <title>Markdown Preview</title>
  ${this.config.math.renderingOption === MathRenderingOption.MathJax
    ? `<script id="MathJax-script" async src="${this.config.math.mathjaxV3ScriptSrc}"></script>`
    : `<link rel="stylesheet" href="${KatexRenderer.getCssUrl()}">`}
  <style>
    ${themeCSS}
    ${KatexRenderer.getCss()}
    ${this.getBaseCSS()}
  </style>
</head>
<body class="vscode-body ${yamlConfig.class || ''}" data-theme="system" data-preview-theme="${this.config.preview.theme || 'github'}" data-has-toc="${hasTOC}">
  ${this.config.preview.showPageToolbar ? `<div id="page-toolbar" class="page-toolbar">
    <button class="page-toolbar-toggle" title="Page tools">&#x22EF;</button>
    <div class="page-toolbar-expanded">
      <button class="page-tool-btn" data-action="toggle-toc-sidebar" id="pt-toc-btn" title="TOC Sidebar">TOC</button>
      <div class="page-tool-sep"></div>
      <button class="page-tool-btn" data-action="copy-page" title="Copy Page">Copy</button>
      <button class="page-tool-btn" data-action="copy-for-lark" title="Copy for Lark (飞书)">Lark</button>
      <div class="page-tool-sep"></div>
      <button class="page-tool-btn" data-action="side-by-side" title="Side by Side">SbS</button>
      <button class="page-tool-btn" data-action="edit-source" title="Edit Source">Edit</button>
      <button class="page-tool-btn" data-action="refresh-preview" title="Refresh">Refresh</button>
    </div>
  </div>` : ''}
  <div id="toc-container" class="hidden">
    <button id="toc-close-btn" class="toc-close-btn" title="Close">&times;</button>
    <div id="toc-content">
      ${frontMatterForTOC}
      ${tocHTML}
    </div>
  </div>
  <div id="preview-root">
    <div id="preview-content">
      ${html}
    </div>
  </div>
  ${this.generateDiagramScripts()}
  <script>
    (function() {
      const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
      // Expose for context menu script
      window._vscodeApi = vscode;
      window._sourceUri = '${templateConfig?.sourceUri || ''}';

      // Notify VS Code that the webview is ready
      if (vscode) {
        const sourceUri = '${templateConfig?.sourceUri || ''}';
        const systemColorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

        vscode.postMessage({
          command: 'webviewFinishLoading',
          args: [{ uri: sourceUri, systemColorScheme }]
        });
      }

      // Handle messages from VS Code
      window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
          case 'updateHtml':
            document.getElementById('preview-content').innerHTML = message.html;
            // Update sidebar TOC content
            if (message.tocHTML !== undefined) {
              var tocContent = document.getElementById('toc-content');
              var tocContainer = document.getElementById('toc-container');
              if (tocContent && tocContainer) {
                var fmHTML = message.frontMatterForTOC || '';
                tocContent.innerHTML = fmHTML + message.tocHTML;
                var hasToc = message.tocHTML.length > 0 || fmHTML.length > 0;
                document.body.setAttribute('data-has-toc', String(hasToc));
                // If TOC became empty, hide the sidebar
                if (!hasToc) {
                  tocContainer.classList.add('hidden');
                  document.body.classList.remove('toc-visible');
                }
              }
            }
            if (window.renderAllDiagrams) {
              window.renderAllDiagrams();
            }
            // Initialize diagram hover controls for new content
            if (window._initDiagramControls) {
              window._initDiagramControls();
            }
            // Re-initialize page toolbar state
            if (window._updatePageToolbar) {
              window._updatePageToolbar();
            }
            break;
          case 'changeTextEditorSelection':
            // Scroll sync handling (fraction-based)
            if (message.scrollFraction !== undefined) {
              scrollToFraction(message.scrollFraction);
            }
            break;
          case 'codeChunkRunning': {
            var cid = message.chunkId;
            var controlsEl = document.querySelector('.code-chunk[data-chunk-id="' + cid + '"] .code-chunk-controls');
            if (controlsEl) controlsEl.classList.add('running');
            var statusEl = document.querySelector('.code-chunk-status[data-chunk-id="' + cid + '"]');
            if (statusEl) {
              statusEl.className = 'code-chunk-status running';
            }
            var btn = document.querySelector('.code-chunk-run-btn[data-chunk-id="' + cid + '"]');
            if (btn) btn.disabled = true;
            break;
          }
          case 'codeChunkResult': {
            var cid2 = message.chunkId;
            var controlsEl2 = document.querySelector('.code-chunk[data-chunk-id="' + cid2 + '"] .code-chunk-controls');
            if (controlsEl2) controlsEl2.classList.remove('running');
            var outputEl = document.querySelector('.code-chunk-output[data-chunk-id="' + cid2 + '"]');
            if (outputEl) {
              outputEl.innerHTML = message.html || '';
            }
            var statusEl2 = document.querySelector('.code-chunk-status[data-chunk-id="' + cid2 + '"]');
            if (statusEl2) {
              statusEl2.className = 'code-chunk-status ' + (message.status || 'idle');
            }
            var btn2 = document.querySelector('.code-chunk-run-btn[data-chunk-id="' + cid2 + '"]');
            if (btn2) btn2.disabled = false;
            break;
          }
          case 'executeBrowserJs': {
            try {
              var targetEl = message.element ? document.getElementById(message.element) : null;
              if (!targetEl && message.element) {
                targetEl = document.createElement('div');
                targetEl.id = message.element;
                var chunkOut = document.querySelector('.code-chunk-output[data-chunk-id="' + message.chunkId + '"]');
                if (chunkOut) chunkOut.appendChild(targetEl);
              }
              var fn = new Function('element', 'require', message.code);
              var result = fn(targetEl, function() { return null; });
              if (vscode) {
                vscode.postMessage({
                  command: 'runCodeChunkBrowserJs',
                  args: [{ chunkId: message.chunkId, result: String(result || '') }]
                });
              }
            } catch (jsErr) {
              var errOut = document.querySelector('.code-chunk-output[data-chunk-id="' + message.chunkId + '"]');
              if (errOut) {
                errOut.innerHTML = '<pre class="code-chunk-error">' + String(jsErr) + '</pre>';
              }
            }
            break;
          }
        }
      });

      // Scroll sync: fraction-based (percentage sync between editor and preview)
      var _suppressScrollSync = false;
      var _lastScrollFraction = -1;

      // Scroll preview to a given fraction (0.0 = top, 1.0 = bottom)
      function scrollToFraction(fraction) {
        // Avoid redundant syncs
        if (Math.abs(fraction - _lastScrollFraction) < 0.005) return;
        _lastScrollFraction = fraction;

        var scrollMax = document.documentElement.scrollHeight - window.innerHeight;
        if (scrollMax <= 0) return;

        var targetY = fraction * scrollMax;
        var drift = Math.abs(window.scrollY - targetY);
        if (drift < window.innerHeight * 0.05) return; // close enough

        _suppressScrollSync = true;
        window.scrollTo({ top: targetY, behavior: 'smooth' });
        setTimeout(function() { _suppressScrollSync = false; }, 600);
      }

      // Report scroll position to VS Code as fraction (user-initiated scrolls only)
      var scrollTimeout = null;
      document.addEventListener('scroll', function() {
        if (_suppressScrollSync) return;
        if (scrollTimeout) {
          clearTimeout(scrollTimeout);
        }
        scrollTimeout = setTimeout(function() {
          if (_suppressScrollSync) return;
          if (vscode) {
            var scrollMax = document.documentElement.scrollHeight - window.innerHeight;
            var scrollFraction = scrollMax > 0 ? window.scrollY / scrollMax : 0;

            vscode.postMessage({
              command: 'revealLine',
              args: ['${templateConfig?.sourceUri || ''}', scrollFraction]
            });
          }
        }, 300);
      });

      // Handle link clicks
      document.addEventListener('click', (event) => {
        const target = event.target.closest('a');
        if (!target) return;
        const rawHref = target.getAttribute('href');
        if (!rawHref) return;
        event.preventDefault();

        // Anchor-only links: scroll within the preview
        if (rawHref.startsWith('#')) {
          const id = rawHref.slice(1);
          const el = document.getElementById(id) || document.querySelector('[name="' + id + '"]');
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }

        if (vscode) {
          vscode.postMessage({
            command: 'clickTagA',
            args: [{
              uri: '${templateConfig?.sourceUri || ''}',
              href: rawHref,
              scheme: 'file'
            }]
          });
        }
      });

      // Handle code chunk run button clicks
      document.addEventListener('click', (event) => {
        var btn = event.target.closest('.code-chunk-run-btn');
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        var chunkId = btn.getAttribute('data-chunk-id');
        if (chunkId && vscode) {
          vscode.postMessage({
            command: 'runCodeChunk',
            args: ['${templateConfig?.sourceUri || ''}', chunkId]
          });
        }
      });

      // Handle checkbox clicks
      document.addEventListener('change', (event) => {
        const target = event.target;
        if (target.type === 'checkbox' && target.closest('.task-list-item')) {
          const dataLine = target.closest('[data-line]')?.getAttribute('data-line');
          if (dataLine && vscode) {
            vscode.postMessage({
              command: 'clickTaskListCheckbox',
              args: ['${templateConfig?.sourceUri || ''}', dataLine]
            });
          }
        }
      });

      // ===== Hover control panel handlers =====

      // Toast notification helper
      function showToast(msg) {
        var toast = document.getElementById('ctx-toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(function() { toast.classList.remove('show'); }, 1500);
      }

      // Extract code text from a pre element (skip line numbers)
      function extractCodeTextFromPre(preEl) {
        var codeEl = preEl.querySelector('code');
        if (!codeEl) return preEl.textContent;
        var lines = codeEl.querySelectorAll('.line, .code-line');
        if (lines.length > 0) {
          return Array.from(lines).map(function(line) {
            var content = line.querySelector('.line-content');
            if (content) return content.textContent;
            var clone = line.cloneNode(true);
            var ln = clone.querySelector('.line-number');
            if (ln) ln.remove();
            return clone.textContent;
          }).join('\\n');
        }
        return codeEl.textContent;
      }

      // SVG to PNG conversion helper
      function svgToPngBlob(svgEl, callback) {
        var svgStr = new XMLSerializer().serializeToString(svgEl);
        var canvas = document.createElement('canvas');
        var img = new Image();
        img.onload = function() {
          canvas.width = img.naturalWidth * 2;
          canvas.height = img.naturalHeight * 2;
          var c = canvas.getContext('2d');
          c.scale(2, 2);
          c.drawImage(img, 0, 0);
          canvas.toBlob(function(blob) { callback(blob); }, 'image/png');
        };
        img.onerror = function() { callback(null); };
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
      }

      // Convert img element to PNG blob (for Kroki diagrams)
      function imgToPngBlob(imgEl, callback) {
        var canvas = document.createElement('canvas');
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function() {
          canvas.width = img.naturalWidth * 2;
          canvas.height = img.naturalHeight * 2;
          var c = canvas.getContext('2d');
          c.scale(2, 2);
          c.drawImage(img, 0, 0);
          canvas.toBlob(function(blob) { callback(blob); }, 'image/png');
        };
        img.onerror = function() { callback(null); };
        img.src = imgEl.src;
      }

      // Fetch URL via extension host (bypasses webview CORS restrictions)
      var _fetchCallbacks = {};
      var _fetchIdCounter = 0;

      function fetchViaExtension(url, callback) {
        if (!vscode) {
          callback(null, 'VSCode API not available');
          return;
        }
        var requestId = 'fetch_' + (++_fetchIdCounter);
        _fetchCallbacks[requestId] = callback;
        vscode.postMessage({ command: 'fetchUrl', args: [requestId, url] });
      }

      // Handle fetch response from extension host
      window.addEventListener('message', function(ev) {
        if (ev.data && ev.data.command === 'fetchUrlResponse') {
          var cb = _fetchCallbacks[ev.data.requestId];
          if (cb) {
            delete _fetchCallbacks[ev.data.requestId];
            if (ev.data.success) {
              cb(ev.data.content, null);
            } else {
              cb(null, ev.data.error);
            }
          }
        }
      });

      // Handle hover control button clicks
      document.addEventListener('click', function(e) {
        var target = e.target;

        // Copy code from code block container
        if (target.matches('.code-block-container .code-copy-btn')) {
          var container = target.closest('.code-block-container');
          var pre = container.querySelector('pre');
          if (pre) {
            var text = extractCodeTextFromPre(pre);
            navigator.clipboard.writeText(text).then(function() {
              showToast('Copied code');
            });
          }
          return;
        }

        // Copy code from code chunk
        if (target.matches('.code-chunk .code-copy-btn')) {
          var chunk = target.closest('.code-chunk');
          var pre = chunk.querySelector('.code-chunk-source pre');
          if (pre) {
            var text = extractCodeTextFromPre(pre);
            navigator.clipboard.writeText(text).then(function() {
              showToast('Copied code');
            });
          }
          return;
        }

        // Toggle diagram controls expand/collapse
        if (target.matches('.diagram-toggle-btn')) {
          var controls = target.closest('.diagram-controls');
          if (controls) {
            controls.classList.toggle('expanded');
          }
          return;
        }

        // Copy diagram source
        if (target.matches('.diagram-copy-source-btn')) {
          var container = target.closest('.diagram-container');
          var diagram = container.querySelector('.mermaid, .graphviz, .wavedrom, .vega, .vega-lite, .recharts, .kroki-diagram');
          if (diagram) {
            var source = diagram.getAttribute('data-source') || diagram.textContent;
            navigator.clipboard.writeText(source).then(function() {
              showToast('Copied diagram source');
            });
          }
          return;
        }

        // Copy SVG
        if (target.matches('.diagram-copy-svg-btn')) {
          var container = target.closest('.diagram-container');
          var svg = container.querySelector('svg') || container.querySelector('.vega-embed svg');
          var krokiDiagram = container.querySelector('.kroki-diagram');

          if (svg) {
            var svgStr = new XMLSerializer().serializeToString(svg);
            navigator.clipboard.write([new ClipboardItem({
              'text/plain': new Blob([svgStr], { type: 'text/plain' })
            })]).then(function() { showToast('Copied SVG'); });
          } else if (krokiDiagram && krokiDiagram.getAttribute('data-svg-url')) {
            // For Kroki, fetch SVG via extension host (bypasses CORS)
            var svgUrl = krokiDiagram.getAttribute('data-svg-url');
            fetchViaExtension(svgUrl, function(content, error) {
              if (content) {
                navigator.clipboard.write([new ClipboardItem({
                  'text/plain': new Blob([content], { type: 'text/plain' })
                })]).then(function() { showToast('Copied SVG'); });
              } else {
                console.error('Fetch error:', error);
                showToast('Failed to fetch SVG');
              }
            });
          } else {
            showToast('No SVG found');
          }
          return;
        }

        // Copy PNG
        if (target.matches('.diagram-copy-png-btn')) {
          var container = target.closest('.diagram-container');
          // Look for SVG (including inside vega-embed container)
          var svg = container.querySelector('svg') || container.querySelector('.vega-embed svg');
          var img = container.querySelector('img');
          var diagramEl = container.querySelector('.mermaid, .graphviz, .wavedrom, .vega, .vega-lite, .recharts, .kroki-diagram');

          if (svg) {
            svgToPngBlob(svg, function(blob) {
              if (blob) {
                navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                  .then(function() { showToast('Copied PNG'); });
              } else {
                showToast('Failed to create PNG');
              }
            });
          } else if (container.querySelector('.kroki-diagram')) {
            // For Kroki diagrams, fetch SVG via extension and convert to PNG
            var krokiEl = container.querySelector('.kroki-diagram');
            var svgUrl = krokiEl.getAttribute('data-svg-url');
            if (svgUrl) {
              fetchViaExtension(svgUrl, function(svgContent, error) {
                if (svgContent) {
                  // Parse SVG and convert to PNG
                  var tempDiv = document.createElement('div');
                  tempDiv.innerHTML = svgContent;
                  var svgEl = tempDiv.querySelector('svg');
                  if (svgEl) {
                    svgToPngBlob(svgEl, function(blob) {
                      if (blob) {
                        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                          .then(function() { showToast('Copied PNG'); });
                      } else {
                        showToast('Failed to create PNG');
                      }
                    });
                  } else {
                    showToast('Failed to parse SVG');
                  }
                } else {
                  console.error('Fetch error:', error);
                  showToast('Failed to fetch image');
                }
              });
            } else {
              showToast('No SVG URL found');
            }
          } else if (diagramEl && typeof html2canvas !== 'undefined') {
            // Fallback: use html2canvas for any diagram
            html2canvas(diagramEl, { backgroundColor: null, scale: 2 }).then(function(canvas) {
              canvas.toBlob(function(blob) {
                if (blob) {
                  navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                    .then(function() { showToast('Copied PNG'); });
                } else {
                  showToast('Failed to create PNG');
                }
              }, 'image/png');
            }).catch(function(err) {
              console.error('html2canvas error:', err);
              showToast('Failed to capture diagram');
            });
          } else {
            showToast('No image found');
          }
          return;
        }

        // ASCII toggle (Mermaid only)
        if (target.matches('.diagram-ascii-btn')) {
          window._mermaidAsciiMode = !window._mermaidAsciiMode;
          // Update all ASCII buttons to reflect state
          document.querySelectorAll('.diagram-ascii-btn').forEach(function(btn) {
            btn.classList.toggle('active', window._mermaidAsciiMode);
          });
          if (window.rerenderDiagramsForTheme) {
            window.rerenderDiagramsForTheme();
          }
          if (vscode) {
            vscode.postMessage({ command: 'setMermaidAsciiMode', args: [window._mermaidAsciiMode] });
          }
          return;
        }

        // Toggle math controls expand/collapse
        if (target.matches('.math-toggle-btn')) {
          var controls = target.closest('.math-controls');
          if (controls) {
            controls.classList.toggle('expanded');
          }
          return;
        }

        // Copy math LaTeX source
        if (target.matches('.math-copy-source-btn')) {
          var container = target.closest('.math-container');
          var mathBlock = container.querySelector('.math-block');
          if (mathBlock) {
            var source = mathBlock.getAttribute('data-source') || '';
            // Decode HTML entities
            var textarea = document.createElement('textarea');
            textarea.innerHTML = source;
            source = textarea.value;
            navigator.clipboard.writeText(source).then(function() {
              showToast('Copied LaTeX');
            });
          }
          return;
        }

        // Copy math as PNG
        if (target.matches('.math-copy-png-btn')) {
          var container = target.closest('.math-container');
          var mathBlock = container.querySelector('.math-block');
          if (mathBlock) {
            // KaTeX renders to HTML with spans, we need to convert to image
            html2canvas(mathBlock, { backgroundColor: null, scale: 2 }).then(function(canvas) {
              canvas.toBlob(function(blob) {
                if (blob) {
                  navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                    .then(function() { showToast('Copied PNG'); });
                } else {
                  showToast('Failed to create PNG');
                }
              }, 'image/png');
            }).catch(function(err) {
              console.error('html2canvas error:', err);
              showToast('Failed to capture math');
            });
          }
          return;
        }
      });

      // Handle diagram theme select changes
      document.addEventListener('change', function(e) {
        if (e.target.matches('.diagram-theme-select')) {
          var newTheme = e.target.value;
          window._mermaidThemeKey = newTheme;
          // Sync all theme selects
          document.querySelectorAll('.diagram-theme-select').forEach(function(sel) {
            sel.value = newTheme;
          });
          if (window.rerenderDiagramsForTheme) {
            window.rerenderDiagramsForTheme();
          }
          if (vscode) {
            vscode.postMessage({ command: 'setMermaidTheme', args: [newTheme] });
          }
        }
      });

      // Initialize theme selects and ASCII buttons on load
      function initDiagramControls() {
        var currentTheme = window._mermaidThemeKey || 'github-light';
        document.querySelectorAll('.diagram-theme-select').forEach(function(sel) {
          sel.value = currentTheme;
        });
        document.querySelectorAll('.diagram-ascii-btn').forEach(function(btn) {
          btn.classList.toggle('active', window._mermaidAsciiMode);
        });
      }
      // Run on load and after content updates
      initDiagramControls();
      window._initDiagramControls = initDiagramControls;

      // Collapse diagram/math controls when mouse leaves the container
      document.addEventListener('mouseleave', function(e) {
        if (e.target && e.target.matches) {
          if (e.target.matches('.diagram-container')) {
            var controls = e.target.querySelector('.diagram-controls');
            if (controls) {
              controls.classList.remove('expanded');
            }
          }
          if (e.target.matches('.math-container')) {
            var mathControls = e.target.querySelector('.math-controls');
            if (mathControls) {
              mathControls.classList.remove('expanded');
            }
          }
        }
      }, true);
    })();
  </script>
  <script>
    // Toggle sidebar TOC (called from context menu or ESC key)
    window._toggleTocSidebar = function() {
      var toc = document.getElementById('toc-container');
      if (!toc) return;
      toc.classList.toggle('hidden');
      document.body.classList.toggle('toc-visible');
    };
    var tocCloseBtn = document.getElementById('toc-close-btn');
    if (tocCloseBtn) {
      tocCloseBtn.addEventListener('click', function() {
        window._toggleTocSidebar();
      });
    }
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (document.body.getAttribute('data-has-toc') === 'true') {
          window._toggleTocSidebar();
        }
      }
    });
  </script>
  <script>
  (function() {
    var toolbar = document.getElementById('page-toolbar');
    if (!toolbar) return;
    var toggleBtn = toolbar.querySelector('.page-toolbar-toggle');
    var vscode = window._vscodeApi;

    // --- Show toolbar only when at top of page ---
    function updateToolbarVisibility() {
      toolbar.style.display = window.scrollY <= 50 ? '' : 'none';
    }
    updateToolbarVisibility();
    document.addEventListener('scroll', updateToolbarVisibility);

    // --- Toggle expand/collapse ---
    toggleBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      toolbar.classList.toggle('expanded');
    });
    // Click outside to collapse
    document.addEventListener('click', function(e) {
      if (!toolbar.contains(e.target)) {
        toolbar.classList.remove('expanded');
      }
    });

    function updateToolbarState() {
      // TOC button active state
      var tocBtn = document.getElementById('pt-toc-btn');
      if (tocBtn) {
        var tocContainer = document.getElementById('toc-container');
        var tocVisible = tocContainer && !tocContainer.classList.contains('hidden');
        tocBtn.classList.toggle('active', !!tocVisible);
        var hasToc = document.body.getAttribute('data-has-toc') === 'true';
        tocBtn.style.display = hasToc ? '' : 'none';
      }
    }

    updateToolbarState();

    // --- Handle button clicks ---
    toolbar.addEventListener('click', function(e) {
      var btn = e.target.closest('.page-tool-btn');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      switch (action) {
        case 'toggle-toc-sidebar':
          if (window._toggleTocSidebar) {
            window._toggleTocSidebar();
            updateToolbarState();
          }
          break;
        case 'copy-page':
          var range = document.createRange();
          var cpContent = document.getElementById('preview-content');
          if (cpContent) {
            range.selectNodeContents(cpContent);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('copy');
            sel.removeAllRanges();
            if (window._showToast) window._showToast('Copied page');
          }
          break;
        case 'copy-for-lark':
          if (window._copyForLark) window._copyForLark();
          break;
        case 'side-by-side':
          if (vscode && window._sourceUri) {
            vscode.postMessage({ command: 'openSideBySide', args: [window._sourceUri] });
          }
          break;
        case 'edit-source':
          if (vscode && window._sourceUri) {
            vscode.postMessage({ command: 'editSource', args: [window._sourceUri] });
          }
          break;
        case 'refresh-preview':
          if (vscode && window._sourceUri) {
            vscode.postMessage({ command: 'refreshPreview', args: [window._sourceUri] });
          }
          break;
      }
    });

    // Expose for updateHtml re-init
    window._updatePageToolbar = function() {
      updateToolbarState();
    };
  })();
  </script>
  ${this.generateContextMenuScripts()}
</body>
</html>`;

    return template;
  }

  private static readonly IMAGE_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.gif',
    '.png',
    '.apng',
    '.svg',
    '.bmp',
    '.webp',
  ]);

  private static readonly MARKDOWN_EXTENSIONS = new Set([
    '.md',
    '.markdown',
    '.mdown',
  ]);

  /**
   * Parse attribute string like `key=value key2="value2"` into a record.
   */
  private parseImportAttrs(
    attrStr: string | undefined,
  ): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (!attrStr) return attrs;
    const attrRegex = /(\w+)=(?:"([^"]*)"|(\S+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(attrStr)) !== null) {
      attrs[m[1]] = m[2] ?? m[3];
    }
    return attrs;
  }

  /**
   * Determine the language identifier from a file extension (without dot).
   */
  private extToLanguage(ext: string): string {
    const map: Record<string, string> = {
      js: 'javascript',
      ts: 'typescript',
      py: 'python',
      rb: 'ruby',
      sh: 'bash',
      yml: 'yaml',
      rs: 'rust',
      kt: 'kotlin',
    };
    return map[ext] || ext;
  }

  /**
   * Process `@import "file"` directives in markdown content.
   *
   * Resolves paths relative to the source file, reads the imported file,
   * and replaces each directive with the appropriate rendered content
   * based on the file extension.
   */
  private async processImports(
    content: string,
    sourceFilePath: string,
    importedPaths?: Set<string>,
  ): Promise<string> {
    const visited = importedPaths ?? new Set<string>();
    visited.add(sourceFilePath);

    const sourceDir = path.dirname(sourceFilePath);
    const lines = content.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      // Reset regex state for per-line matching
      const lineRegex = /^@import\s+"([^"]+)"(?:\s+\{([^}]*)\})?\s*$/;
      const match = line.match(lineRegex);
      if (!match) {
        result.push(line);
        continue;
      }

      const importPath = match[1];
      const attrs = this.parseImportAttrs(match[2]);
      const resolvedPath = path.resolve(sourceDir, importPath);
      const ext = path.extname(resolvedPath).toLowerCase();

      // Circular import guard
      if (visited.has(resolvedPath)) {
        result.push(
          `<!-- @import warning: circular import detected for "${importPath}" -->`,
        );
        continue;
      }

      // Read the file
      let fileContent: string;
      try {
        fileContent = fs.readFileSync(resolvedPath, 'utf-8');
      } catch {
        result.push(
          `<div class="import-error" style="color: #c00; padding: 8px; border: 1px solid #c00; border-radius: 4px; margin: 8px 0; font-family: monospace; font-size: 12px;">@import error: file not found: ${this.escapeHtml(
            importPath,
          )}</div>`,
        );
        continue;
      }

      // Apply line_begin / line_end slicing
      if (attrs.line_begin || attrs.line_end) {
        const fileLines = fileContent.split('\n');
        const begin = attrs.line_begin ? parseInt(attrs.line_begin, 10) - 1 : 0;
        const end = attrs.line_end
          ? parseInt(attrs.line_end, 10)
          : fileLines.length;
        fileContent = fileLines.slice(Math.max(0, begin), end).join('\n');
      }

      // hide=true → suppress output entirely
      if (attrs.hide === 'true') {
        // For CSS/JS: still include but hidden (side-effect import)
        if (ext === '.css' || ext === '.less') {
          result.push(`<style>${fileContent}</style>`);
        } else if (ext === '.js' || ext === '.javascript') {
          result.push(`<script>${fileContent}</script>`);
        }
        // For everything else, just skip
        continue;
      }

      // code_block=true → force fenced code block rendering
      if (attrs.code_block === 'true') {
        const lang = ext.replace('.', '');
        result.push(`\`\`\`${this.extToLanguage(lang)}`);
        result.push(fileContent);
        result.push('```');
        continue;
      }

      // Render based on file extension
      if (MarkdownEngine.IMAGE_EXTENSIONS.has(ext)) {
        // Image: embed as data URI so it works in VS Code webview
        // (relative paths don't resolve correctly in webview context)
        const mimeTypes: Record<string, string> = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.apng': 'image/apng',
          '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp',
          '.webp': 'image/webp',
        };
        const mime = mimeTypes[ext] || 'application/octet-stream';
        let src: string;
        if (ext === '.svg') {
          // SVG: use text content as data URI
          const svgContent = fs.readFileSync(resolvedPath, 'utf-8');
          src = `data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}`;
        } else {
          // Binary image: read as base64
          const imageBuffer = fs.readFileSync(resolvedPath);
          src = `data:${mime};base64,${imageBuffer.toString('base64')}`;
        }
        const imgAttrs: string[] = [`src="${src}"`];
        for (const key of ['width', 'height', 'title', 'alt']) {
          if (attrs[key]) {
            imgAttrs.push(`${key}="${this.escapeHtml(attrs[key])}"`);
          }
        }
        result.push(`<img ${imgAttrs.join(' ')}>`);
      } else if (MarkdownEngine.MARKDOWN_EXTENSIONS.has(ext)) {
        // Markdown: recursively process imports then inline
        const processed = await this.processImports(
          fileContent,
          resolvedPath,
          new Set(visited),
        );
        result.push(processed);
      } else if (ext === '.mermaid') {
        result.push('```mermaid');
        result.push(fileContent);
        result.push('```');
      } else if (ext === '.csv') {
        // CSV → markdown table
        result.push(this.csvToMarkdownTable(fileContent));
      } else if (ext === '.css' || ext === '.less') {
        result.push(`<style>${fileContent}</style>`);
      } else if (ext === '.js' || ext === '.javascript') {
        result.push(`<script>${fileContent}</script>`);
      } else if (ext === '.html' || ext === '.htm') {
        result.push(fileContent);
      } else {
        // Other text files → fenced code block
        const lang = ext.replace('.', '');
        result.push(`\`\`\`${this.extToLanguage(lang)}`);
        result.push(fileContent);
        result.push('```');
      }
    }

    return result.join('\n');
  }

  /**
   * Convert CSV content to a markdown table.
   */
  private csvToMarkdownTable(csv: string): string {
    const lines = csv.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return '';

    const parseRow = (row: string): string[] => {
      const cells: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === '"') {
          if (inQuotes && row[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === ',' && !inQuotes) {
          cells.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      cells.push(current.trim());
      return cells;
    };

    const rows = lines.map(parseRow);
    const header = rows[0];
    const separator = header.map(() => '---');
    const mdRows = [header, separator, ...rows.slice(1)];
    return mdRows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  }

  /**
   * Extract front matter from markdown
   */
  private extractFrontMatter(content: string): {
    frontMatter: Record<string, unknown> | null;
    content: string;
  } {
    const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
    const match = content.match(frontMatterRegex);

    if (!match) {
      return { frontMatter: null, content };
    }

    try {
      const frontMatter = yaml.parse(match[1]) as Record<string, unknown>;
      return {
        frontMatter,
        content: content.substring(match[0].length),
      };
    } catch (error) {
      console.warn('Failed to parse front matter:', error);
      return { frontMatter: null, content };
    }
  }

  /**
   * Render front matter as HTML
   */
  private renderFrontMatter(
    frontMatter: Record<string, unknown> | null,
  ): string {
    if (
      !frontMatter ||
      this.config.markdown.frontMatterRenderingOption ===
        FrontMatterRenderingOption.none
    ) {
      return '';
    }

    if (
      this.config.markdown.frontMatterRenderingOption ===
      FrontMatterRenderingOption.table
    ) {
      let html = '<table class="front-matter-table"><tbody>';
      for (const [key, value] of Object.entries(frontMatter)) {
        const displayValue =
          typeof value === 'object' ? JSON.stringify(value) : String(value);
        html += `<tr><th>${this.escapeHtml(key)}</th><td>${this.escapeHtml(
          displayValue,
        )}</td></tr>`;
      }
      html += '</tbody></table>';
      return html;
    }

    if (
      this.config.markdown.frontMatterRenderingOption ===
      FrontMatterRenderingOption.codeBlock
    ) {
      const yamlStr = yaml.stringify(frontMatter);
      return `<pre class="front-matter-code"><code class="language-yaml">${this.escapeHtml(
        yamlStr,
      )}</code></pre>`;
    }

    return '';
  }

  /**
   * Generate front matter HTML for the TOC sidebar panel
   */
  private generateFrontMatterForTOC(
    frontMatter: Record<string, unknown> | null,
  ): string {
    if (!frontMatter || Object.keys(frontMatter).length === 0) return '';

    let html = '<div class="toc-front-matter">';
    html += '<div class="toc-fm-title">Front Matter</div>';
    html += '<dl class="toc-fm-list">';

    for (const [key, value] of Object.entries(frontMatter)) {
      html += `<dt>${this.escapeHtml(key)}</dt>`;
      const strValue =
        typeof value === 'object' ? JSON.stringify(value) : String(value);

      const MAX_LEN = 80;
      const lines = strValue.split('\n');
      if (lines.length > 3 || strValue.length > MAX_LEN) {
        const preview = lines.slice(0, 2).join('\n').substring(0, MAX_LEN);
        const lineCount = lines.length;
        html += `<dd class="toc-fm-truncated" title="${this.escapeHtml(strValue)}">${this.escapeHtml(preview)}... <span class="toc-fm-hint">(${lineCount} lines)</span></dd>`;
      } else {
        html += `<dd>${this.escapeHtml(strValue)}</dd>`;
      }
    }

    html += '</dl></div>';
    return html;
  }

  /**
   * Process code blocks with syntax highlighting
   */
  private async processCodeBlocks(html: string): Promise<string> {
    const codeBlockRegex =
      /<pre([^>]*)><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g;
    const matches = [...html.matchAll(codeBlockRegex)];

    for (const match of matches) {
      const [fullMatch, preAttrs, language, code] = match;
      const decodedCode = this.unescapeHtml(code);
      const highlightedCode = await this.codeRenderer.highlight(
        decodedCode,
        language,
      );

      // Extract data-line from original <pre> attrs and inject into Shiki output
      const dataLineMatch = preAttrs.match(/data-line="([^"]*)"/);
      let finalCode = highlightedCode;
      if (dataLineMatch) {
        finalCode = finalCode.replace(
          /^<pre /,
          `<pre data-line="${dataLineMatch[1]}" `,
        );
      }

      html = html.replace(fullMatch, finalCode);
    }

    return html;
  }

  /**
   * Generate table of contents HTML
   */
  private generateTOC(
    markdown: string,
    frontMatter?: Record<string, unknown> | null,
  ): string {
    // Read TOC config from front matter
    const tocConfig = (frontMatter?.toc as Record<string, unknown>) || {};
    const depthFrom = (tocConfig.depth_from as number) || 1;
    const depthTo = (tocConfig.depth_to as number) || 6;
    const ordered = !!tocConfig.ordered;

    // Collect fragment-only link anchors: [text](#anchor) → map link text → anchor
    const linkAnchors = new Map<string, string>();
    const linkRegex = /\[([^\]]+)\]\(#([^)]+)\)/g;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(markdown)) !== null) {
      linkAnchors.set(linkMatch[1].trim().toLowerCase(), linkMatch[2]);
    }

    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    const headings: Array<{ level: number; text: string; id: string }> = [];
    const slugCounts: Record<string, number> = {};
    let match: RegExpExecArray | null;

    while ((match = headingRegex.exec(markdown)) !== null) {
      const level = match[1].length;
      const rawText = match[2].trim();

      // Skip headings with {ignore=true}
      if (/\{[^}]*ignore\s*=\s*true[^}]*\}/.test(rawText)) {
        continue;
      }

      // Filter by depth range
      if (level < depthFrom || level > depthTo) {
        continue;
      }

      // Extract custom ID from {#custom-id} syntax
      const customIdMatch = rawText.match(/\{[^}]*#([a-zA-Z0-9_-]+)[^}]*\}/);
      const customId = customIdMatch ? customIdMatch[1] : null;

      // Strip {attr} syntax for display text
      const text = rawText.replace(/\s*\{[^}]*\}\s*/g, '').trim();

      // Priority: {#custom-id} > link anchor reference > auto slug
      const linkedAnchor = linkAnchors.get(text.toLowerCase());
      let slug = customId || linkedAnchor || generateSlug(rawText);
      if (!slug) slug = 'heading';
      if (slugCounts[slug] !== undefined) {
        slugCounts[slug]++;
        slug = `${slug}-${slugCounts[slug]}`;
      } else {
        slugCounts[slug] = 0;
      }

      headings.push({ level, text, id: slug });
    }

    if (headings.length === 0) {
      return '';
    }

    const listTag = ordered ? 'ol' : 'ul';
    let html = `<${listTag} class="toc">`;
    let prevLevel = 0;

    for (const heading of headings) {
      if (heading.level > prevLevel) {
        for (let i = prevLevel; i < heading.level; i++) {
          html += `<${listTag}>`;
        }
      } else if (heading.level < prevLevel) {
        for (let i = heading.level; i < prevLevel; i++) {
          html += `</li></${listTag}>`;
        }
      } else if (prevLevel > 0) {
        html += '</li>';
      }

      html += `<li><a href="#${heading.id}">${this.escapeHtml(
        heading.text,
      )}</a>`;
      prevLevel = heading.level;
    }

    for (let i = 0; i < prevLevel; i++) {
      html += `</li></${listTag}>`;
    }

    return html;
  }

  /**
   * Detect whether the markdown is a presentation
   * (`marp: true`, `slideshow`, or `presentation` in front matter).
   */
  private isPresentationMarkdown(markdown: string): boolean {
    const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return false;
    const fm = fmMatch[1];
    return (
      /^marp\s*:\s*true\s*$/m.test(fm) ||
      /^slideshow\s*:/m.test(fm) ||
      /^presentation\s*:/m.test(fm)
    );
  }

  /**
   * Split markdown into slides for Reveal.js presentation.
   * Splits on `---` (horizontal rule) while protecting fenced code blocks.
   * Parses `<!-- .slide: key="value" -->` directives into section attributes.
   */
  private splitMarkdownIntoSlides(markdown: string): {
    frontMatter: Record<string, unknown> | null;
    slides: Array<{ content: string; directives: string }>;
  } {
    const { frontMatter, content } = this.extractFrontMatter(markdown);

    // Protect fenced code blocks from being split by ---
    const codeBlockPlaceholders: string[] = [];
    const protectedContent = content.replace(
      /^(`{3,})[^\n]*\n[\s\S]*?\n\1\s*$/gm,
      (match) => {
        const idx = codeBlockPlaceholders.length;
        codeBlockPlaceholders.push(match);
        return `%%CODE_BLOCK_${idx}%%`;
      },
    );

    // Split by --- on its own line
    const rawSlides = protectedContent.split(/^---\s*$/m);

    // Restore code blocks and parse directives
    const slides: Array<{ content: string; directives: string }> = [];
    for (const raw of rawSlides) {
      let slideContent = raw;
      // Restore placeholders
      for (let i = 0; i < codeBlockPlaceholders.length; i++) {
        slideContent = slideContent.replace(
          `%%CODE_BLOCK_${i}%%`,
          codeBlockPlaceholders[i],
        );
      }

      slideContent = slideContent.trim();
      if (!slideContent) continue;

      // Parse <!-- .slide: key="value" key2=value2 --> directives
      let directives = '';
      slideContent = slideContent.replace(
        /<!--\s*\.slide:\s*([\s\S]*?)\s*-->/g,
        (_match, attrs: string) => {
          // Convert key="value" and key=value pairs to HTML attributes
          directives = attrs
            .replace(/(\w[\w-]*)=(?:"([^"]*)"|(\S+))/g, '$1="$2$3"')
            .trim();
          return '';
        },
      );

      slides.push({ content: slideContent.trim(), directives });
    }

    return { frontMatter, slides };
  }

  /**
   * Generate a Reveal.js presentation template for .mdx files.
   * Each slide is processed independently through the full MDX pipeline:
   * imports → MDX → markdown-it → image paths → callouts → KaTeX → Shiki.
   */
  private async generateRevealTemplate(
    markdown: string,
    templateConfig?: HTMLTemplateOptions['config'],
  ): Promise<string> {
    const jsdelivr = this.config.misc.jsdelivrCdnHost || 'cdn.jsdelivr.net';
    const { frontMatter, slides } = this.splitMarkdownIntoSlides(markdown);

    // Valid Reveal.js 5.x theme names
    const validRevealThemes = new Set([
      'beige', 'black', 'blood', 'dracula', 'league',
      'moon', 'night', 'serif', 'simple', 'sky',
      'solarized', 'white',
    ]);

    // Read presentation config from front matter
    const fm = frontMatter || {};
    const requestedTheme =
      (fm.theme as string) ||
      this.config.theme.revealjs.replace(/\.css$/, '') ||
      'white';
    // Validate theme — fall back to 'white' if not a valid Reveal.js theme
    const revealTheme = validRevealThemes.has(requestedTheme)
      ? requestedTheme
      : 'white';
    const transition = (fm.transition as string) || 'slide';
    const controls = fm.controls !== false;
    const progress = fm.progress !== false;
    const center = fm.center !== false;
    const slideNumber = !!fm.slideNumber;

    // Get source file path for import resolution and image paths
    const sourceUri = templateConfig?.sourceUri || '';
    let sourceFilePath = '';
    let sourceDir = '';
    if (sourceUri) {
      try {
        sourceFilePath = vscode.Uri.parse(sourceUri).fsPath;
        sourceDir = path.dirname(sourceFilePath);
      } catch {
        // ignore
      }
    }

    // Process each slide through the full pipeline
    const slideHtmlParts: string[] = [];
    for (const slide of slides) {
      let slideContent = slide.content;

      // 1. Process @import directives
      if (sourceFilePath) {
        try {
          slideContent = await this.processImports(
            slideContent,
            sourceFilePath,
          );
        } catch {
          // continue with unprocessed content
        }
      }

      // 2. Process MDX content (JSX expressions, exports)
      try {
        const mdxProcessor = new MdxProcessor();
        const mdxResult = mdxProcessor.process(slideContent);
        slideContent = mdxResult.content;
      } catch {
        // continue with unprocessed content
      }

      // 3. Render markdown to HTML via markdown-it
      let slideHtml = this.parser.render(slideContent);

      // 4. Resolve image paths to data URIs
      if (sourceDir) {
        try {
          slideHtml = this.resolveImagePaths(slideHtml, sourceDir);
        } catch {
          // continue
        }
      }

      // 5. Process Obsidian-style callouts
      slideHtml = this.processCallouts(slideHtml);

      // 6. Process KaTeX math
      slideHtml = this.katexRenderer.processMathInContent(slideHtml);

      // 7. Process code blocks with Shiki syntax highlighting
      slideHtml = await this.processCodeBlocks(slideHtml);

      // 8. Store recharts/vega source in data-source for Reveal.js compatibility.
      // Reveal.js re-processes slide DOM during init, which clears <script> textContent.
      // The data-source attribute survives DOM manipulation.
      slideHtml = slideHtml.replace(
        /<div class="recharts"([^>]*)>\s*<script type="text\/recharts">([\s\S]*?)<\/script>/g,
        (_match, attrs: string, source: string) => {
          const escaped = this.escapeHtml(source);
          return `<div class="recharts"${attrs} data-source="${escaped}"><script type="text/recharts">${source}</script>`;
        },
      );

      // Build <section> with optional directives
      const sectionAttrs = slide.directives
        ? ` ${slide.directives}`
        : '';
      slideHtmlParts.push(
        `        <section${sectionAttrs}>\n${slideHtml}\n        </section>`,
      );
    }

    const slidesHtml = slideHtmlParts.join('\n');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' https: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https:;">
  <title>Reveal.js Presentation</title>
  <link rel="stylesheet" href="https://${jsdelivr}/npm/reveal.js@5/dist/reset.css">
  <link rel="stylesheet" href="https://${jsdelivr}/npm/reveal.js@5/dist/reveal.css">
  <link rel="stylesheet" href="https://${jsdelivr}/npm/reveal.js@5/dist/theme/${revealTheme}.css">
  <link rel="stylesheet" href="${KatexRenderer.getCssUrl()}">
  <style>
    ${KatexRenderer.getCss()}

    /* ══════════════════════════════════════
       Card mode (default) — slides as cards
       ══════════════════════════════════════ */
    body {
      margin: 0;
      padding: 0;
      background: #f0f0f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      body:not(.play-mode) { background: #1e1e1e; }
    }

    /* In card mode, disable Reveal.js layout — show slides as stacked cards */
    body:not(.play-mode) .reveal {
      position: static;
      width: auto;
      height: auto;
      overflow: visible;
    }
    body:not(.play-mode) .reveal .slides {
      position: static;
      width: auto;
      height: auto;
      overflow: visible;
      pointer-events: auto;
      perspective: none;
      display: block;
    }
    body:not(.play-mode) .reveal .slides section {
      position: static !important;
      display: block !important;
      width: 800px;
      min-height: 450px;
      margin: 24px auto;
      padding: 48px 56px;
      box-sizing: border-box;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      transform: none !important;
      opacity: 1 !important;
      visibility: visible !important;
      left: auto !important;
      top: auto !important;
    }
    @media (prefers-color-scheme: dark) {
      body:not(.play-mode) .reveal .slides section {
        background: #2d2d2d;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      }
    }
    /* Hide Reveal.js chrome in card mode */
    body:not(.play-mode) .reveal .controls,
    body:not(.play-mode) .reveal .progress,
    body:not(.play-mode) .reveal .slide-number,
    body:not(.play-mode) .reveal .backgrounds {
      display: none !important;
    }
    /* Play button */
    #play-btn {
      position: fixed;
      top: 12px;
      right: 16px;
      z-index: 1000;
      background: rgba(0,0,0,0.55);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 13px;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    #play-btn:hover { opacity: 1; }
    body.play-mode #play-btn { display: none; }

    /* Navigation bar in play mode */
    #play-nav {
      display: none;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1001;
      height: 40px;
      background: rgba(0,0,0,0.35);
      align-items: center;
      justify-content: center;
      gap: 20px;
      padding: 0 16px;
      opacity: 0;
      transition: opacity 0.25s;
    }
    body.play-mode #play-nav { display: flex; }
    body.play-mode.nav-visible #play-nav { opacity: 1; }
    #play-nav button {
      background: none;
      border: none;
      color: rgba(255,255,255,0.7);
      font-size: 16px;
      padding: 4px 10px;
      cursor: pointer;
      transition: color 0.15s;
    }
    #play-nav button:hover { color: #fff; }
    #play-nav button#nav-exit { font-size: 13px; }
    #play-nav .slide-indicator {
      color: rgba(255,255,255,0.6);
      font: 13px/1 sans-serif;
      min-width: 60px;
      text-align: center;
      user-select: none;
    }

    /* ══════════════════════════════════════════
       Play mode — Reveal.js fullscreen
       Reveal.js theme CSS handles all styling.
       Only override custom elements here.
       ══════════════════════════════════════════ */
    body.play-mode {
      overflow: hidden;
    }
    body.play-mode .reveal {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
    }
    /* Don't uppercase headings (Reveal.js white theme default) */
    body.play-mode .reveal section {
      text-align: left;
    }
    body.play-mode .reveal section h1,
    body.play-mode .reveal section h2,
    body.play-mode .reveal section h3,
    body.play-mode .reveal section h4 {
      text-transform: none;
    }
    /* Hide Reveal.js built-in controls — we use our own nav bar */
    body.play-mode .reveal .controls {
      display: none !important;
    }
    /* Custom element overrides for play mode */
    body.play-mode .reveal .diagram-controls,
    body.play-mode .reveal .math-controls,
    body.play-mode .reveal .code-copy-btn,
    body.play-mode .reveal .code-block-container .code-header {
      display: none !important;
    }
    body.play-mode .reveal section .diagram-container {
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: visible;
      margin: 0.4em 0;
    }
    body.play-mode .reveal section .mermaid svg,
    body.play-mode .reveal section .graphviz svg,
    body.play-mode .reveal section .vega svg,
    body.play-mode .reveal section .vega-lite svg {
      max-width: 90%;
      max-height: 50vh;
      height: auto;
    }
    body.play-mode .reveal section .recharts {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      margin: 0.4em auto;
    }
    body.play-mode .reveal section .recharts .recharts-wrapper {
      overflow: visible !important;
      margin: 0 auto;
    }
    body.play-mode .reveal section .recharts svg.recharts-surface {
      overflow: visible;
    }
    body.play-mode .reveal section img {
      max-height: 55vh;
    }
    body.play-mode .reveal section pre {
      box-shadow: none;
    }
    body.play-mode .reveal section blockquote {
      box-shadow: none;
    }
    body.play-mode .reveal section .callout {
      text-align: left;
    }

    /* ═══════════════════════════════════
       Card mode — Content styling
       (Does NOT apply in play mode)
       ═══════════════════════════════════ */

    /* Typography */
    body:not(.play-mode) .reveal section h1 {
      font-size: 1.6em;
      margin: 0 0 0.3em 0;
      line-height: 1.2;
    }
    body:not(.play-mode) .reveal section h2 {
      font-size: 1.1em;
      margin: 0.4em 0 0.2em 0;
      line-height: 1.3;
      opacity: 0.7;
    }
    body:not(.play-mode) .reveal section h3 {
      font-size: 0.95em;
      margin: 0.3em 0 0.15em 0;
    }
    body:not(.play-mode) .reveal section p {
      font-size: 0.7em;
      line-height: 1.6;
      margin: 0.2em 0;
    }

    /* Lists */
    body:not(.play-mode) .reveal section ul,
    body:not(.play-mode) .reveal section ol {
      font-size: 0.7em;
      line-height: 1.7;
      margin: 0.2em 0;
      padding-left: 1.3em;
    }
    body:not(.play-mode) .reveal section ul ul,
    body:not(.play-mode) .reveal section ol ol {
      font-size: 1em;
      margin: 0;
    }
    body:not(.play-mode) .reveal section li {
      margin-bottom: 0.1em;
    }

    /* Tables */
    body:not(.play-mode) .reveal section table {
      font-size: 0.6em;
      border-collapse: collapse;
      width: auto;
      margin: 0.4em auto;
    }
    body:not(.play-mode) .reveal section table th {
      background: #f0f0f0;
      font-weight: 600;
      padding: 6px 14px;
      border: 1px solid #ddd;
    }
    body:not(.play-mode) .reveal section table td {
      padding: 5px 14px;
      border: 1px solid #ddd;
    }
    body:not(.play-mode) .reveal section table tr:nth-child(even) {
      background: #fafafa;
    }
    @media (prefers-color-scheme: dark) {
      body:not(.play-mode) .reveal section table th { background: #3a3a3a; border-color: #555; }
      body:not(.play-mode) .reveal section table td { border-color: #555; }
      body:not(.play-mode) .reveal section table tr:nth-child(even) { background: #333; }
    }

    /* Code */
    body:not(.play-mode) .reveal section pre {
      width: 100%;
      box-shadow: none;
      font-size: 0.5em;
      border-radius: 6px;
      margin: 0.3em 0;
    }
    body:not(.play-mode) .reveal section pre code {
      max-height: 400px;
      padding: 14px;
      line-height: 1.5;
    }
    body:not(.play-mode) .reveal section code {
      font-size: 0.88em;
    }

    /* Blockquotes & callouts */
    body:not(.play-mode) .reveal section blockquote {
      font-size: 0.7em;
      width: 90%;
      padding: 10px 18px;
      margin: 0.3em auto;
      border-left: 4px solid #ccc;
      background: rgba(0,0,0,0.03);
      box-shadow: none;
    }
    body:not(.play-mode) .reveal section .callout {
      text-align: left;
      font-size: 0.65em;
      border-radius: 6px;
    }

    /* Images */
    body:not(.play-mode) .reveal section img {
      max-width: 75%;
      max-height: 45vh;
      border-radius: 6px;
      margin: 0.2em auto;
      display: block;
    }

    /* KaTeX */
    body:not(.play-mode) .reveal section .katex-display {
      margin: 0.3em 0;
      font-size: 0.8em;
    }

    /* Diagrams */
    body:not(.play-mode) .reveal section .diagram-container {
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: visible;
      margin: 0.2em 0;
    }
    body:not(.play-mode) .reveal section .mermaid svg,
    body:not(.play-mode) .reveal section .graphviz svg,
    body:not(.play-mode) .reveal section .vega svg,
    body:not(.play-mode) .reveal section .vega-lite svg {
      max-width: 100%;
      max-height: 50vh;
      height: auto;
    }
    body:not(.play-mode) .reveal section .recharts {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      margin: 0.2em auto;
    }
    body:not(.play-mode) .reveal section .recharts .recharts-wrapper {
      overflow: visible !important;
      margin: 0 auto;
    }
    body:not(.play-mode) .reveal section .recharts svg.recharts-surface {
      overflow: visible;
    }
    body:not(.play-mode) .reveal .slides section {
      overflow: visible;
    }

    /* Hide controls in card mode */
    body:not(.play-mode) .reveal .diagram-controls,
    body:not(.play-mode) .reveal .math-controls,
    body:not(.play-mode) .reveal .code-copy-btn,
    body:not(.play-mode) .reveal .code-block-container .code-header {
      display: none !important;
    }
  </style>
</head>
<body>
  <button id="play-btn" title="Play presentation">&#9654; Play</button>
  <div id="play-nav">
    <button id="nav-exit" title="Exit (Esc)">&#10005;</button>
    <button id="nav-prev" title="Previous slide">&#9664;</button>
    <span class="slide-indicator" id="slide-counter"></span>
    <button id="nav-next" title="Next slide">&#9654;</button>
  </div>
  <div class="reveal">
    <div class="slides">
${slidesHtml}
    </div>
  </div>
  ${this.generateDiagramScripts()}
  <script src="https://${jsdelivr}/npm/reveal.js@5/dist/reveal.js"></script>
  <script src="https://${jsdelivr}/npm/reveal.js@5/plugin/notes/notes.js"></script>
  <script>
    (function() {
      // VS Code API
      var vscode = null;
      try { vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null; } catch(e) {}
      window._vscodeApi = vscode;
      window._sourceUri = '${sourceUri}';

      if (vscode) {
        var sc = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        vscode.postMessage({ command: 'webviewFinishLoading', args: [{ uri: window._sourceUri, systemColorScheme: sc }] });
      }
      window.addEventListener('message', function(ev) {
        if (ev.data.command === 'refreshPreview' && vscode)
          vscode.postMessage({ command: 'refreshPreview', args: [window._sourceUri] });
      });

      var revealReady = false;
      var currentSlide = 0;
      var counter = document.getElementById('slide-counter');
      var sections = document.querySelectorAll('.reveal .slides > section');
      var totalSlides = sections.length;

      function enterPlay() {
        if (!totalSlides) return;
        document.body.classList.add('play-mode');

        if (!revealReady) {
          Reveal.initialize({
            controls: false,
            progress: ${progress},
            center: ${center},
            slideNumber: ${slideNumber},
            transition: '${transition}',
            embedded: false,
            plugins: [typeof RevealNotes !== 'undefined' ? RevealNotes : null].filter(Boolean)
          }).then(function() {
            revealReady = true;
            Reveal.slide(0);
            updateCounter();
            // Render diagrams
            if (window.renderAllDiagrams) window.renderAllDiagrams();

            Reveal.on('slidechanged', function(ev) {
              currentSlide = ev.indexh || 0;
              updateCounter();
              if (window.renderAllDiagrams) window.renderAllDiagrams();
            });
          });
        } else {
          Reveal.slide(currentSlide);
          Reveal.layout();
          updateCounter();
        }
      }

      function exitPlay() {
        document.body.classList.remove('play-mode');
      }

      function updateCounter() {
        if (counter) counter.textContent = (currentSlide + 1) + ' / ' + totalSlides;
      }

      function isPlaying() { return document.body.classList.contains('play-mode'); }

      document.getElementById('play-btn').addEventListener('click', enterPlay);
      document.getElementById('nav-prev').addEventListener('click', function() {
        if (revealReady) Reveal.prev();
      });
      document.getElementById('nav-next').addEventListener('click', function() {
        if (revealReady) Reveal.next();
      });
      document.getElementById('nav-exit').addEventListener('click', exitPlay);

      // Auto-hide nav bar
      var navTimer;
      document.addEventListener('mousemove', function() {
        if (!isPlaying()) return;
        document.body.classList.add('nav-visible');
        clearTimeout(navTimer);
        navTimer = setTimeout(function() { document.body.classList.remove('nav-visible'); }, 2000);
      });

      // Keyboard navigation
      document.addEventListener('keydown', function(e) {
        if (!isPlaying()) return;
        switch (e.key) {
          case 'Escape':       exitPlay(); break;
          case 'ArrowRight':
          case 'ArrowDown':
          case ' ':
          case 'PageDown':     e.preventDefault(); if (revealReady) Reveal.next(); break;
          case 'ArrowLeft':
          case 'ArrowUp':
          case 'PageUp':       e.preventDefault(); if (revealReady) Reveal.prev(); break;
          case 'Home':         e.preventDefault(); if (revealReady) Reveal.slide(0); break;
          case 'End':          e.preventDefault(); if (revealReady) Reveal.slide(totalSlides - 1); break;
        }
      });

      // Render diagrams in card mode on load
      window.addEventListener('load', function() {
        if (window.renderAllDiagrams) window.renderAllDiagrams();
      });
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Convert ```recharts fenced code blocks to raw HTML divs.
   * Used for Marp pre-processing since Marp bypasses the markdown-it pipeline.
   * Returns { content, hasRecharts }.
   */
  private preprocessRechartsBlocks(markdown: string): {
    content: string;
    hasRecharts: boolean;
  } {
    let counter = 0;
    const processed = markdown.replace(
      /^```recharts\s*\n([\s\S]*?)^```\s*$/gm,
      (_match, chartContent: string) => {
        const id = `recharts-${counter++}`;
        return (
          `<div class="recharts" id="${id}">` +
          `<script type="text/recharts">${chartContent}</script>` +
          `<div class="recharts-loading" style="padding:20px;text-align:center;color:#666;">` +
          `<span>Loading Recharts...</span>` +
          `</div>` +
          `</div>`
        );
      },
    );
    return { content: processed, hasRecharts: counter > 0 };
  }

  /**
   * Render a Marp presentation using @marp-team/marp-core.
   * Marp Core handles all directives (theme, paginate, headingDivider, style,
   * backgroundColor, etc.) natively via its own markdown-it pipeline.
   */
  private generateMarpTemplate(
    markdown: string,
    templateConfig?: HTMLTemplateOptions['config'],
  ): string {
    const jsdelivr = this.config.misc.jsdelivrCdnHost || 'cdn.jsdelivr.net';

    // Ensure `marp: true` is in front matter so Marp Core activates slide mode.
    // For `slideshow:` or `presentation:` documents, inject it.
    let marpInput = markdown;
    const fmMatch = markdown.match(/^(---\s*\n)([\s\S]*?)(\n---)/);
    if (fmMatch && !/^marp\s*:\s*true\s*$/m.test(fmMatch[2])) {
      marpInput =
        fmMatch[1] +
        'marp: true\n' +
        fmMatch[2] +
        fmMatch[3] +
        markdown.substring(fmMatch[0].length);
    }

    // Pre-process recharts blocks to raw HTML before Marp rendering.
    // Marp has html:true so raw HTML divs pass through to slides.
    const { content: rechartsProcessed, hasRecharts } =
      this.preprocessRechartsBlocks(marpInput);
    marpInput = rechartsProcessed;

    const marp = new MarpClass!({
      html: true,
      math: 'katex',
      minifyCSS: false,
      script: false,
      slug: true,
    });

    const { html, css } = marp.render(marpInput);

    // Conditional recharts CSS
    const rechartsCSS = hasRecharts
      ? `
    /* Recharts containers */
    .recharts {
      display: flex;
      justify-content: center;
      min-height: 100px;
      background: #f9f9f9;
      border: 1px dashed #ddd;
      border-radius: 4px;
    }
    .recharts[data-rendered="true"] {
      background: transparent;
      border: none;
    }
    .recharts svg {
      max-width: 100%;
      height: auto;
    }`
      : '';

    // Conditional recharts CDN scripts
    const rechartsCDN = hasRecharts
      ? `
  <!-- React, ReactDOM, react-is for Recharts v3 -->
  <script src="https://${jsdelivr}/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://${jsdelivr}/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://${jsdelivr}/npm/react-is@18/umd/react-is.production.min.js"></script>
  <!-- Recharts v3 -->
  <script src="https://${jsdelivr}/npm/recharts@3/umd/Recharts.js"></script>`
      : '';

    // Conditional recharts render script
    const rechartsScript = hasRecharts
      ? `
    // --- Recharts rendering ---
    window.renderRecharts = function() {
      var elements = document.querySelectorAll('.recharts:not([data-rendered])');
      if (elements.length === 0) return;
      var errors = [];
      if (typeof React === 'undefined') errors.push('React not loaded');
      if (typeof ReactDOM === 'undefined') errors.push('ReactDOM not loaded');
      if (typeof Recharts === 'undefined') errors.push('Recharts not loaded');
      if (errors.length > 0) {
        elements.forEach(function(el) {
          el.innerHTML = '<div style="color:#c00;padding:12px;background:#fff0f0;border:1px solid #fcc;border-radius:4px;font-size:12px;"><strong>Recharts Error:</strong><br>' + errors.join('<br>') + '<br><br><em>Scripts may still be loading. Try refreshing.</em></div>';
          el.setAttribute('data-rendered', 'true');
        });
        return;
      }
      var RC = Recharts;
      document.querySelectorAll('.recharts:not([data-rendered])').forEach(function(el) {
        try {
          var scriptEl = el.querySelector('script[type="text/recharts"]');
          var source = scriptEl ? scriptEl.textContent : '';
          if (!source || !source.trim()) {
            el.innerHTML = '<div style="color:#999;padding:16px;text-align:center;">No chart data</div>';
            el.setAttribute('data-rendered', 'true');
            return;
          }
          el.setAttribute('data-source', source);
          if (scriptEl) scriptEl.style.display = 'none';
          var loadingEl = el.querySelector('.recharts-loading');
          if (loadingEl) loadingEl.style.display = 'none';
          var chartType = '';
          var typeMatch = source.match(/^\\s*<(LineChart|BarChart|PieChart|AreaChart|ComposedChart|ScatterChart|RadarChart)/);
          if (typeMatch) {
            chartType = typeMatch[1];
          } else {
            el.innerHTML = '<div style="color:#c00;padding:8px;">Unknown chart type</div>';
            el.setAttribute('data-rendered', 'true');
            return;
          }
          var width = 500, height = 300;
          var sizeMatch = source.match(/width=\\{(\\d+)\\}/);
          if (sizeMatch) width = parseInt(sizeMatch[1]);
          sizeMatch = source.match(/height=\\{(\\d+)\\}/);
          if (sizeMatch) height = parseInt(sizeMatch[1]);
          var data = [];
          var dataStart = source.indexOf('data={[');
          if (dataStart !== -1) {
            var bracketCount = 0;
            var dataEnd = dataStart + 7;
            for (var i = dataStart + 6; i < source.length; i++) {
              if (source[i] === '[' || source[i] === '{') bracketCount++;
              if (source[i] === ']' || source[i] === '}') bracketCount--;
              if (bracketCount === 0) { dataEnd = i + 1; break; }
            }
            var dataStr = source.substring(dataStart + 6, dataEnd);
            try { data = (new Function('return ' + dataStr))(); } catch(e) { console.warn('Data parse error:', e); }
          }
          var children = [];
          if (source.indexOf('<CartesianGrid') !== -1) {
            var dashMatch = source.match(/strokeDasharray="([^"]+)"/);
            children.push(React.createElement(RC.CartesianGrid, { key: 'grid', strokeDasharray: dashMatch ? dashMatch[1] : '3 3' }));
          }
          if (source.indexOf('<XAxis') !== -1) {
            var xKeyMatch = source.match(/<XAxis[^>]*dataKey="([^"]+)"/);
            children.push(React.createElement(RC.XAxis, { key: 'xaxis', dataKey: xKeyMatch ? xKeyMatch[1] : undefined }));
          }
          if (source.indexOf('<YAxis') !== -1) {
            children.push(React.createElement(RC.YAxis, { key: 'yaxis' }));
          }
          if (source.indexOf('<Tooltip') !== -1) {
            children.push(React.createElement(RC.Tooltip, { key: 'tooltip' }));
          }
          if (source.indexOf('<Legend') !== -1) {
            children.push(React.createElement(RC.Legend, { key: 'legend' }));
          }
          var lineMatches = source.match(/<Line[^/]*\\/>/g) || [];
          lineMatches.forEach(function(lineStr, idx) {
            var typeM = lineStr.match(/type="([^"]+)"/);
            var keyM = lineStr.match(/dataKey="([^"]+)"/);
            var strokeM = lineStr.match(/stroke="([^"]+)"/);
            if (keyM) {
              children.push(React.createElement(RC.Line, { key: 'line-' + idx, type: typeM ? typeM[1] : 'monotone', dataKey: keyM[1], stroke: strokeM ? strokeM[1] : '#8884d8' }));
            }
          });
          var barMatches = source.match(/<Bar[^/]*\\/>/g) || [];
          barMatches.forEach(function(barStr, idx) {
            var keyM = barStr.match(/dataKey="([^"]+)"/);
            var fillM = barStr.match(/fill="([^"]+)"/);
            if (keyM) {
              children.push(React.createElement(RC.Bar, { key: 'bar-' + idx, dataKey: keyM[1], fill: fillM ? fillM[1] : '#8884d8' }));
            }
          });
          var areaMatches = source.match(/<Area[^/]*\\/>/g) || [];
          areaMatches.forEach(function(areaStr, idx) {
            var typeM = areaStr.match(/type="([^"]+)"/);
            var keyM = areaStr.match(/dataKey="([^"]+)"/);
            var stackM = areaStr.match(/stackId="([^"]+)"/);
            var strokeM = areaStr.match(/stroke="([^"]+)"/);
            var fillM = areaStr.match(/fill="([^"]+)"/);
            if (keyM) {
              children.push(React.createElement(RC.Area, { key: 'area-' + idx, type: typeM ? typeM[1] : 'monotone', dataKey: keyM[1], stackId: stackM ? stackM[1] : undefined, stroke: strokeM ? strokeM[1] : '#8884d8', fill: fillM ? fillM[1] : '#8884d8' }));
            }
          });
          if (chartType === 'PieChart') {
            var pieMatch = source.match(/<Pie[\\s\\n][\\s\\S]*?(?=\\/>|>)/);
            if (pieMatch) {
              var pieStr = pieMatch[0];
              var pieData = [];
              var pieSection = source.substring(source.indexOf('<Pie'));
              var pdStart = pieSection.indexOf('data={[');
              if (pdStart !== -1) {
                var pdBracket = 0;
                var pdEnd = pdStart + 7;
                for (var pj = pdStart + 6; pj < pieSection.length; pj++) {
                  if (pieSection[pj] === '[' || pieSection[pj] === '{') pdBracket++;
                  if (pieSection[pj] === ']' || pieSection[pj] === '}') pdBracket--;
                  if (pdBracket === 0) { pdEnd = pj + 1; break; }
                }
                var pieDataStr = pieSection.substring(pdStart + 6, pdEnd);
                try { pieData = (new Function('return ' + pieDataStr))(); } catch(e) { console.warn('Pie data parse error:', e); }
              }
              var cxM = pieStr.match(/cx="([^"]+)"/);
              var cyM = pieStr.match(/cy="([^"]+)"/);
              var orM = pieStr.match(/outerRadius=\\{?(\\d+)\\}?/);
              var fillM = pieStr.match(/fill="([^"]+)"/);
              var dkM = pieStr.match(/dataKey="([^"]+)"/);
              var hasLabel = pieStr.indexOf('label') !== -1;
              children.push(React.createElement(RC.Pie, { key: 'pie', data: pieData, cx: cxM ? cxM[1] : '50%', cy: cyM ? cyM[1] : '50%', outerRadius: orM ? parseInt(orM[1]) : 80, fill: fillM ? fillM[1] : '#8884d8', dataKey: dkM ? dkM[1] : 'value', label: hasLabel }));
            }
          }
          var ChartComp = RC[chartType];
          if (!ChartComp) {
            el.innerHTML = '<div style="color:#c00;padding:8px;">Chart component not found: ' + chartType + '</div>';
            el.setAttribute('data-rendered', 'true');
            return;
          }
          var chartProps = { width: width, height: height };
          if (chartType !== 'PieChart') { chartProps.data = data; }
          var chartElement = React.createElement(ChartComp, chartProps, children);
          var renderTarget = document.createElement('div');
          el.innerHTML = '';
          el.appendChild(renderTarget);
          try {
            if (ReactDOM.createRoot) {
              var root = ReactDOM.createRoot(renderTarget);
              root.render(chartElement);
            } else {
              ReactDOM.render(chartElement, renderTarget);
            }
          } catch(renderErr) {
            el.innerHTML = '<div style="color:#c00;padding:8px;border:1px solid #c00;border-radius:4px;font-size:12px;">React render error: ' + (renderErr.message || renderErr) + '</div>';
          }
          el.setAttribute('data-rendered', 'true');
        } catch(e) {
          console.error('Recharts error:', e);
          el.innerHTML = '<div style="color:#c00;padding:8px;border:1px solid #c00;border-radius:4px;font-size:12px;">Recharts error: ' + (e.message || e) + '</div>';
          el.setAttribute('data-rendered', 'true');
        }
      });
    };
    // Render recharts with retry pattern for async script loading
    window.addEventListener('load', function() { window.renderRecharts(); });
    setTimeout(function() { window.renderRecharts(); }, 1500);
    setTimeout(function() { window.renderRecharts(); }, 3000);
    setTimeout(function() { window.renderRecharts(); }, 5000);`
      : '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' https: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https:;">
  <title>Marp Presentation</title>
  <style>
    ${css}

    /* ── Card mode (default) ── */
    body {
      margin: 0;
      padding: 0;
      background: #f5f5f5;
    }
    .marpit > svg[data-marpit-svg] {
      display: block;
      margin: 20px auto;
      box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
    }
    @media (prefers-color-scheme: dark) {
      body:not(.play-mode) { background: #1e1e1e; }
    }

    /* Play button */
    #marp-play-btn {
      position: fixed;
      top: 12px;
      right: 16px;
      z-index: 1000;
      background: rgba(0,0,0,0.55);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 13px;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    #marp-play-btn:hover { opacity: 1; }

    /* ── Play mode ── */
    body.play-mode {
      background: #000;
      overflow: hidden;
    }
    body.play-mode .marpit {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
    }
    body.play-mode .marpit > svg[data-marpit-svg] {
      display: none;
      margin: 0;
      box-shadow: none;
      position: absolute;
      inset: 0;
      width: 100% !important;
      height: 100% !important;
    }
    body.play-mode .marpit > svg[data-marpit-svg].active-slide {
      display: block;
    }
    body.play-mode #marp-play-btn { display: none; }

    /* Navigation bar in play mode */
    #play-nav {
      display: none;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1001;
      height: 40px;
      background: rgba(0,0,0,0.35);
      align-items: center;
      justify-content: center;
      gap: 20px;
      padding: 0 16px;
      opacity: 0;
      transition: opacity 0.25s;
    }
    body.play-mode #play-nav { display: flex; }
    body.play-mode.nav-visible #play-nav { opacity: 1; }
    #play-nav button {
      background: none;
      border: none;
      color: rgba(255,255,255,0.7);
      font-size: 16px;
      padding: 4px 10px;
      cursor: pointer;
      transition: color 0.15s;
    }
    #play-nav button:hover { color: #fff; }
    #play-nav button#nav-exit { font-size: 13px; }
    #play-nav .slide-indicator {
      color: rgba(255,255,255,0.6);
      font: 13px/1 sans-serif;
      min-width: 60px;
      text-align: center;
      user-select: none;
    }
    ${rechartsCSS}
  </style>
</head>
<body>
  <button id="marp-play-btn" title="Play presentation">&#9654; Play</button>
  <div id="play-nav">
    <button id="nav-exit" title="Exit (Esc)">&#10005;</button>
    <button id="nav-prev" title="Previous slide">&#9664;</button>
    <span class="slide-indicator" id="slide-counter"></span>
    <button id="nav-next" title="Next slide">&#9654;</button>
  </div>
  ${html}
  <script src="https://${jsdelivr}/npm/@marp-team/marp-core/lib/browser.js"></script>${rechartsCDN}
  <script>
    (function() {
      // VS Code API
      var vscode = null;
      try { vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null; } catch(e) {}
      window._vscodeApi = vscode;
      window._sourceUri = '${templateConfig?.sourceUri || ''}';

      if (vscode) {
        var sc = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        vscode.postMessage({ command: 'webviewFinishLoading', args: [{ uri: window._sourceUri, systemColorScheme: sc }] });
      }
      window.addEventListener('message', function(ev) {
        if (ev.data.command === 'refreshPreview' && vscode)
          vscode.postMessage({ command: 'refreshPreview', args: [window._sourceUri] });
      });

      // ── Play mode ──
      var slides = Array.from(document.querySelectorAll('.marpit > svg[data-marpit-svg]'));
      var current = 0;
      var counter = document.getElementById('slide-counter');

      function showSlide(n) {
        current = Math.max(0, Math.min(n, slides.length - 1));
        slides.forEach(function(s, i) {
          s.classList.toggle('active-slide', i === current);
        });
        counter.textContent = (current + 1) + ' / ' + slides.length;
      }

      function enterPlay() {
        if (!slides.length) return;
        document.body.classList.add('play-mode');
        showSlide(0);
      }

      function exitPlay() {
        document.body.classList.remove('play-mode');
        slides.forEach(function(s) { s.classList.remove('active-slide'); });
      }

      function isPlaying() { return document.body.classList.contains('play-mode'); }

      document.getElementById('marp-play-btn').addEventListener('click', enterPlay);
      document.getElementById('nav-prev').addEventListener('click', function() { showSlide(current - 1); });
      document.getElementById('nav-next').addEventListener('click', function() { showSlide(current + 1); });
      document.getElementById('nav-exit').addEventListener('click', exitPlay);

      // Show nav briefly on mouse move then auto-hide
      var navTimer;
      document.addEventListener('mousemove', function() {
        if (!isPlaying()) return;
        document.body.classList.add('nav-visible');
        clearTimeout(navTimer);
        navTimer = setTimeout(function() { document.body.classList.remove('nav-visible'); }, 2000);
      });

      document.addEventListener('keydown', function(e) {
        if (!isPlaying()) return;
        switch (e.key) {
          case 'Escape':       exitPlay(); break;
          case 'ArrowRight':
          case 'ArrowDown':
          case ' ':
          case 'PageDown':     e.preventDefault(); showSlide(current + 1); break;
          case 'ArrowLeft':
          case 'ArrowUp':
          case 'PageUp':       e.preventDefault(); showSlide(current - 1); break;
          case 'Home':         e.preventDefault(); showSlide(0); break;
          case 'End':          e.preventDefault(); showSlide(slides.length - 1); break;
        }
      });
      ${rechartsScript}
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Get base CSS for the preview
   */
  private getBaseCSS(): string {
    return `
      body {
        font-family: var(--font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif);
        line-height: 1.6;
        padding: 12px 20px 20px;
        max-width: 900px;
        margin: 0 auto;
        background-color: var(--bg);
        color: var(--fg);
        transition: background-color 0.2s, color 0.2s;
      }
      #preview-content > :first-child {
        margin-top: 0;
      }
      a { color: var(--link); }
      img {
        max-width: 100%;
        height: auto;
      }
      pre {
        overflow-x: auto;
        padding: 1em;
        border-radius: 6px;
        background-color: var(--pre-bg);
        border: 1px solid var(--border);
      }
      code {
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        background-color: var(--code-bg);
        padding: 0.2em 0.4em;
        border-radius: 3px;
        font-size: 0.9em;
      }
      pre code {
        background: none;
        padding: 0;
        border-radius: 0;
        font-size: inherit;
      }
      blockquote {
        border-left: 4px solid var(--blockquote-border);
        background-color: var(--blockquote-bg);
        margin-left: 0;
        padding: 0.5em 1em;
        color: var(--blockquote-fg);
      }
      mark {
        background-color: var(--mark-bg);
        color: var(--mark-fg);
        padding: 0.1em 0.2em;
        border-radius: 2px;
      }
      /* Obsidian-style callouts */
      .callout {
        border-left-width: 4px;
        border-left-style: solid;
        border-radius: 4px;
        padding: 0.5em 1em;
        margin: 1em 0;
      }
      .callout-title {
        display: flex;
        align-items: center;
        gap: 0.4em;
        font-weight: 600;
      }
      .callout-icon {
        font-style: normal;
      }
      .callout-note, .callout-info { border-left-color: #448aff; background-color: rgba(68,138,255,0.1); }
      .callout-tip, .callout-success { border-left-color: #00c853; background-color: rgba(0,200,83,0.1); }
      .callout-warning, .callout-caution { border-left-color: #ff9100; background-color: rgba(255,145,0,0.1); }
      .callout-important, .callout-danger, .callout-failure { border-left-color: #ff5252; background-color: rgba(255,82,82,0.1); }
      .callout-question { border-left-color: #ffab00; background-color: rgba(255,171,0,0.1); }
      .callout-bug { border-left-color: #d50000; background-color: rgba(213,0,0,0.1); }
      .callout-example { border-left-color: #7c4dff; background-color: rgba(124,77,255,0.1); }
      .callout-quote, .callout-abstract { border-left-color: #9e9e9e; background-color: rgba(158,158,158,0.1); }
      .callout-todo { border-left-color: #448aff; background-color: rgba(68,138,255,0.1); }
      table {
        border-collapse: collapse;
        width: 100%;
        margin: 1em 0;
      }
      th, td {
        border: 1px solid var(--border);
        padding: 8px;
        text-align: left;
      }
      th {
        background-color: var(--th-bg);
      }
      hr {
        border: none;
        border-top: 1px solid var(--border);
      }
      .task-list-item {
        list-style-type: none;
      }
      .task-list-item input[type="checkbox"] {
        margin-right: 0.5em;
      }
      .front-matter-table {
        margin-bottom: 1em;
        font-size: 0.9em;
      }
      .front-matter-code {
        margin-bottom: 1em;
        background-color: var(--bg-secondary);
      }
      /* Sidebar TOC */
      #toc-container {
        position: fixed;
        left: 0;
        top: 0;
        width: 260px;
        height: 100vh;
        overflow-y: auto;
        background: var(--bg-secondary);
        border-right: 1px solid var(--border);
        padding: 16px;
        z-index: 100;
        font-size: 0.85em;
        transition: transform 0.2s;
        box-sizing: border-box;
      }
      #toc-container.hidden {
        transform: translateX(-100%);
      }
      .toc-close-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 22px;
        height: 22px;
        padding: 0;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--fg-muted);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .toc-close-btn:hover {
        background: var(--bg-tertiary);
        color: var(--fg);
      }
      body.toc-visible #preview-root {
        margin-left: 276px;
      }

      /* Inline [TOC] */
      .table-of-contents {
        background: var(--bg-secondary);
        padding: 1em;
        border-radius: 4px;
        margin: 1em 0;
      }
      .table-of-contents ul,
      .table-of-contents ol {
        list-style-type: none;
        padding-left: 1em;
      }
      .table-of-contents a {
        text-decoration: none;
        color: inherit;
      }
      .table-of-contents a:hover {
        text-decoration: underline;
      }

      .toc {
        background-color: var(--bg-secondary);
        padding: 1em;
        border-radius: 4px;
        margin-bottom: 1em;
      }
      .toc ul, .toc ol {
        list-style-type: none;
        padding-left: 1em;
      }
      .toc a {
        text-decoration: none;
        color: inherit;
      }
      .toc a:hover {
        text-decoration: underline;
      }

      /* TOC Panel Front Matter */
      .toc-front-matter {
        margin-bottom: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--border);
        font-size: 0.9em;
      }
      .toc-fm-title {
        font-weight: 600;
        margin-bottom: 6px;
        color: var(--text-secondary, #888);
        font-size: 0.85em;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .toc-fm-list {
        margin: 0;
      }
      .toc-fm-list dt {
        font-weight: 600;
        color: var(--text-primary);
        margin-top: 4px;
        font-size: 0.9em;
      }
      .toc-fm-list dd {
        margin-left: 0;
        padding-left: 8px;
        color: var(--text-secondary, #888);
        font-size: 0.85em;
        word-break: break-word;
        white-space: pre-wrap;
      }
      .toc-fm-truncated {
        cursor: help;
      }
      .toc-fm-hint {
        opacity: 0.6;
        font-style: italic;
      }

      /* Mermaid ASCII rendering */
      .mermaid-ascii {
        font-family: 'Cascadia Code', 'Fira Code', 'SF Mono', 'Menlo', 'Consolas', monospace;
        font-size: 13px;
        line-height: 1.4;
        padding: 16px;
        overflow-x: auto;
        white-space: pre;
        margin: 0;
      }

      /* Diagram containers */
      .mermaid, .wavedrom, .graphviz, .vega, .vega-lite, .kroki-diagram, .recharts {
        text-align: center;
        margin: 1em 0;
      }
      .mermaid svg, .graphviz svg, .wavedrom svg {
        max-width: 100%;
        height: auto;
      }
      .recharts {
        display: flex;
        justify-content: center;
        min-height: 100px;
        background: #f9f9f9;
        border: 1px dashed #ddd;
        border-radius: 4px;
      }
      .recharts[data-rendered="true"] {
        background: transparent;
        border: none;
      }
      .recharts svg {
        max-width: 100%;
        height: auto;
      }
      .kroki-diagram img {
        max-width: 100%;
        height: auto;
      }

      /* Dark mode filter for diagrams without native dark theme support */
      .diagram-invert-dark svg,
      .diagram-invert-dark img {
        filter: invert(0.88) hue-rotate(180deg);
      }

      /* Line numbers for code blocks */
      pre[data-line-numbers] {
        padding-left: 0;
      }
      pre[data-line-numbers] code {
        display: block;
      }
      pre[data-line-numbers] .line {
        display: inline-block;
        width: 100%;
      }
      pre[data-line-numbers] .line-number,
      pre.code-block-with-line-numbers .line-number {
        display: inline-block;
        width: 3em;
        padding-right: 1em;
        text-align: right;
        color: var(--fg-muted);
        opacity: 0.6;
        user-select: none;
        -webkit-user-select: none;
        box-sizing: border-box;
      }
      pre.code-block-with-line-numbers {
        padding-left: 0;
      }
      pre.code-block-with-line-numbers code {
        display: block;
      }
      pre.code-block-with-line-numbers .code-line {
        display: block;
      }
      pre.code-block-with-line-numbers .line-content {
        display: inline;
      }

      /* Code chunk containers */
      .code-chunk {
        position: relative;
        border: 1px solid var(--border);
        border-radius: 6px;
        margin: 1em 0;
        overflow: hidden;
      }
      .code-chunk-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        position: absolute;
        top: 0;
        right: 0;
        z-index: 1;
        opacity: 0;
        transition: opacity 0.15s ease;
        pointer-events: none;
      }
      .code-chunk:hover .code-chunk-controls,
      .code-chunk-controls.running {
        opacity: 1;
        pointer-events: auto;
      }
      .code-chunk-run-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 10px;
        font-size: 12px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--bg);
        color: var(--fg);
        cursor: pointer;
        font-family: inherit;
      }
      .code-chunk-run-btn:hover {
        background: var(--bg-secondary);
      }
      .code-chunk-run-btn:active {
        background: var(--bg-tertiary);
      }
      .code-chunk-status {
        font-size: 12px;
        color: var(--fg-muted);
      }
      .code-chunk-status.running::after {
        content: 'Running...';
        animation: code-chunk-pulse 1.5s ease-in-out infinite;
      }
      .code-chunk-status.success {
        color: #28a745;
      }
      .code-chunk-status.success::after {
        content: 'Done';
      }
      .code-chunk-status.error {
        color: #d73a49;
      }
      .code-chunk-status.error::after {
        content: 'Error';
      }
      @keyframes code-chunk-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      .code-chunk-source {
        margin: 0;
      }
      .code-chunk-source pre {
        margin: 0;
        border: none;
        border-radius: 0;
      }
      .code-chunk-output {
        border-top: 1px solid var(--border);
      }
      .code-chunk-output:empty {
        display: none;
        border-top: none;
      }
      .code-chunk-output-text {
        margin: 0;
        padding: 0.8em 1em;
        background: var(--bg-secondary);
        font-size: 0.9em;
        border: none;
        border-radius: 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .code-chunk-error {
        margin: 0;
        padding: 0.8em 1em;
        background: var(--bg-secondary);
        color: #d73a49;
        font-size: 0.9em;
        border: none;
        border-radius: 0;
        white-space: pre-wrap;
      }
      .code-chunk-matplotlib,
      .code-chunk-output-png {
        max-width: 100%;
        height: auto;
        display: block;
        margin: 0.5em auto;
      }
      .code-chunk-output-markdown {
        padding: 0.5em 1em;
      }

      /* ===== Code block hover controls ===== */
      .code-block-container {
        position: relative;
        margin: 1em 0;
      }
      .code-block-container pre {
        margin: 0;
      }
      .code-block-controls {
        position: absolute;
        top: 4px;
        right: 4px;
        z-index: 10;
        opacity: 0;
        transition: opacity 0.15s ease;
        pointer-events: none;
        display: flex;
        gap: 4px;
      }
      .code-block-container:hover .code-block-controls {
        opacity: 1;
        pointer-events: auto;
      }

      /* ===== Diagram hover controls ===== */
      .diagram-container {
        position: relative;
        margin: 1em 0;
      }
      .diagram-controls {
        position: absolute;
        top: 4px;
        right: 4px;
        z-index: 10;
        opacity: 0;
        transition: opacity 0.15s ease;
        pointer-events: none;
        display: flex;
        align-items: center;
        gap: 4px;
        background: var(--bg);
        padding: 4px 6px;
        border-radius: 4px;
        box-shadow: 0 1px 4px var(--shadow);
        border: 1px solid var(--border);
      }
      .diagram-container:hover .diagram-controls {
        opacity: 1;
        pointer-events: auto;
      }
      /* Toggle button - always visible when controls are visible */
      .diagram-toggle-btn {
        padding: 2px 6px;
        font-size: 14px;
        line-height: 1;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--fg-muted);
        cursor: pointer;
        font-family: inherit;
        transition: background 0.1s, color 0.1s;
      }
      .diagram-toggle-btn:hover {
        background: var(--bg-secondary);
        color: var(--fg);
      }
      .diagram-controls.expanded .diagram-toggle-btn {
        display: none;
      }
      /* Expanded buttons container - hidden by default */
      .diagram-controls-expanded {
        display: none;
        gap: 4px;
        align-items: center;
      }
      .diagram-controls.expanded .diagram-controls-expanded {
        display: flex;
      }

      /* ===== Shared control button styles ===== */
      .code-copy-btn,
      .diagram-copy-source-btn,
      .diagram-copy-svg-btn,
      .diagram-copy-png-btn,
      .diagram-ascii-btn {
        padding: 2px 8px;
        font-size: 11px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--bg);
        color: var(--fg);
        cursor: pointer;
        font-family: inherit;
        transition: background 0.1s;
      }
      .code-copy-btn:hover,
      .diagram-copy-source-btn:hover,
      .diagram-copy-svg-btn:hover,
      .diagram-copy-png-btn:hover,
      .diagram-ascii-btn:hover {
        background: var(--bg-secondary);
      }
      .code-copy-btn:active,
      .diagram-copy-source-btn:active,
      .diagram-copy-svg-btn:active,
      .diagram-copy-png-btn:active,
      .diagram-ascii-btn:active {
        background: var(--bg-tertiary);
      }
      .diagram-ascii-btn.active {
        background: var(--link);
        color: #fff;
        border-color: var(--link);
      }
      .diagram-theme-select {
        padding: 2px 4px;
        font-size: 11px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--bg);
        color: var(--fg);
        cursor: pointer;
        font-family: inherit;
      }
      .diagram-theme-select:focus {
        outline: 1px solid var(--link);
        outline-offset: 1px;
      }

      /* Page toolbar */
      .page-toolbar {
        position: fixed;
        top: 8px;
        right: 8px;
        z-index: 99;
        display: flex;
        align-items: center;
        gap: 4px;
        background: var(--bg);
        padding: 4px 6px;
        border-radius: 4px;
        box-shadow: 0 1px 4px var(--shadow);
        border: 1px solid var(--border);
      }
      .page-toolbar-toggle {
        padding: 2px 6px;
        font-size: 16px;
        line-height: 1;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--fg-muted);
        cursor: pointer;
        font-family: inherit;
        transition: background 0.1s, color 0.1s;
      }
      .page-toolbar-toggle:hover {
        background: var(--bg-secondary);
        color: var(--fg);
      }
      .page-toolbar-expanded {
        display: none;
        gap: 4px;
        align-items: center;
      }
      .page-toolbar.expanded .page-toolbar-toggle {
        display: none;
      }
      .page-toolbar.expanded .page-toolbar-expanded {
        display: flex;
      }
      .page-tool-btn {
        padding: 2px 8px;
        font-size: 11px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--bg);
        color: var(--fg);
        cursor: pointer;
        font-family: inherit;
        transition: background 0.1s;
        white-space: nowrap;
      }
      .page-tool-btn:hover {
        background: var(--bg-secondary);
      }
      .page-tool-btn:active {
        background: var(--bg-tertiary);
      }
      .page-tool-btn.active {
        background: var(--link);
        color: #fff;
        border-color: var(--link);
      }
      .page-tool-sep {
        width: 1px;
        height: 16px;
        background: var(--border);
        margin: 0 2px;
      }
    `;
  }

  /**
   * Generate all diagram library scripts (Mermaid, WaveDrom, Viz.js, Vega).
   */
  private generateDiagramScripts(): string {
    const mermaidTheme = this.config.mermaid.theme || 'github-light';
    const jsdelivr = this.config.misc.jsdelivrCdnHost || 'cdn.jsdelivr.net';

    // Map beautiful-mermaid theme to vanilla mermaid theme
    const darkThemes = /dark|night|storm|mocha|dracula|one-dark/;
    const vanillaMermaidTheme = darkThemes.test(mermaidTheme)
      ? 'dark'
      : 'default';

    return `
<!-- WaveDrom -->
<script src="https://${jsdelivr}/npm/wavedrom@3/wavedrom.min.js"></script>
<script src="https://${jsdelivr}/npm/wavedrom@3/skins/default.js"></script>

<!-- Viz.js (GraphViz) -->
<script src="https://${jsdelivr}/npm/@viz-js/viz@3/lib/viz-standalone.js"></script>

<!-- js-yaml for YAML-format Vega specs -->
<script src="https://${jsdelivr}/npm/js-yaml@4/dist/js-yaml.min.js"></script>
<!-- Vega / Vega-Lite / Vega-Embed (explicit UMD builds) -->
<script src="https://${jsdelivr}/npm/vega@5/build/vega.min.js"></script>
<script src="https://${jsdelivr}/npm/vega-lite@5/build/vega-lite.min.js"></script>
<script src="https://${jsdelivr}/npm/vega-embed@6/build/vega-embed.min.js"></script>

<!-- React, ReactDOM, react-is for Recharts v3 -->
<script src="https://${jsdelivr}/npm/react@18/umd/react.production.min.js"></script>
<script src="https://${jsdelivr}/npm/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://${jsdelivr}/npm/react-is@18/umd/react-is.production.min.js"></script>
<!-- Recharts v3 -->
<script src="https://${jsdelivr}/npm/recharts@3/umd/Recharts.js"></script>

<!-- html2canvas for math/element to PNG -->
<script src="https://${jsdelivr}/npm/html2canvas@1/dist/html2canvas.min.js"></script>

<!-- Beautiful Mermaid (primary) -->
<script src="https://${jsdelivr}/npm/beautiful-mermaid/dist/beautiful-mermaid.browser.global.js"></script>
<!-- Vanilla Mermaid (fallback for unsupported diagram types) -->
<script src="https://${jsdelivr}/npm/mermaid@11/dist/mermaid.min.js"></script>

<script>
// Initialize vanilla mermaid for fallback (don't auto-render)
if (typeof mermaid !== 'undefined') {
  mermaid.initialize({ startOnLoad: false, theme: '${vanillaMermaidTheme}', securityLevel: 'loose' });
}

// Normalize vanilla mermaid syntax for beautiful-mermaid compatibility:
// 1. Strip trailing semicolons (optional statement terminators that beautiful-mermaid rejects)
// 2. Add spaces around compact edge operators in flowcharts only (A-->B → A --> B)
//    Skip this for sequence/state/class/ER diagrams where -->> ->> etc. are distinct operators.
window._normalizeMermaidSource = function(src) {
  var lines = src.split('\\n');
  // Detect diagram type from first non-empty line
  var header = '';
  for (var h = 0; h < lines.length; h++) {
    if (lines[h].trim()) { header = lines[h].trim().toLowerCase(); break; }
  }
  var isFlowchart = /^(graph|flowchart)\\b/.test(header);

  return lines.map(function(line) {
    // Strip trailing semicolons (applies to all diagram types)
    line = line.replace(/;\\s*$/, '');
    // Only normalize compact edge operators for flowcharts
    if (isFlowchart) {
      // Step 1: space before arrow when preceded by non-space
      line = line.replace(/(\\S)(-->|---|==>|-\\.->)/g, '$1 $2');
      // Step 2: space after arrow when followed by non-space (but not | for labels)
      line = line.replace(/(-->|---|==>|-\\.->)([^\\s|])/g, '$1 $2');
    }
    return line;
  }).join('\\n');
};

// Resolve current effective dark/light mode
window._isDarkTheme = function() {
  var t = document.body.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

// Current mermaid theme key (mutable for runtime switching)
window._mermaidThemeKey = '${mermaidTheme}';

// Current mermaid ASCII mode (mutable for runtime toggling)
window._mermaidAsciiMode = ${this.config.mermaid.asciiMode};

// Pick beautiful-mermaid theme based on current dark/light
window._getBmTheme = function() {
  if (typeof beautifulMermaid === 'undefined') return null;
  var isDark = window._isDarkTheme();
  var lightKey = window._mermaidThemeKey || '${mermaidTheme}';
  // Map config theme to dark/light variant
  var darkMap = {
    'github-light': 'github-dark',
    'github-dark': 'github-dark',
    'solarized-light': 'solarized-dark',
    'solarized-dark': 'solarized-dark',
    'catppuccin-latte': 'catppuccin-mocha',
    'catppuccin-mocha': 'catppuccin-mocha',
    'nord-light': 'nord',
    'nord': 'nord',
    'tokyo-night-light': 'tokyo-night',
    'tokyo-night': 'tokyo-night',
    'tokyo-night-storm': 'tokyo-night-storm',
    'zinc-light': 'zinc-dark',
    'zinc-dark': 'zinc-dark',
    'one-dark': 'one-dark',
    'dracula': 'dracula'
  };
  var lightMap = {
    'github-dark': 'github-light',
    'github-light': 'github-light',
    'solarized-dark': 'solarized-light',
    'solarized-light': 'solarized-light',
    'catppuccin-mocha': 'catppuccin-latte',
    'catppuccin-latte': 'catppuccin-latte',
    'nord': 'nord-light',
    'nord-light': 'nord-light',
    'tokyo-night': 'tokyo-night-light',
    'tokyo-night-light': 'tokyo-night-light',
    'tokyo-night-storm': 'tokyo-night-light',
    'zinc-dark': 'zinc-light',
    'zinc-light': 'zinc-light',
    'one-dark': 'github-light',
    'dracula': 'github-light'
  };
  var key = isDark ? (darkMap[lightKey] || 'github-dark') : (lightMap[lightKey] || 'github-light');
  return beautifulMermaid.THEMES[key] || beautifulMermaid.THEMES[isDark ? 'github-dark' : 'github-light'];
};

window.renderMermaid = async function() {
  if (typeof beautifulMermaid === 'undefined' && typeof mermaid === 'undefined') return;
  var bmTheme = window._getBmTheme();
  var isDark = window._isDarkTheme();
  // Update vanilla mermaid theme
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: false, theme: isDark ? 'dark' : 'default', securityLevel: 'loose' });
  }
  var els = document.querySelectorAll('.mermaid:not([data-rendered])');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    try {
      var source = el.getAttribute('data-source') || el.textContent;
      if (!source || !source.trim()) continue;
      el.setAttribute('data-source', source);
      var normalized = window._normalizeMermaidSource(source.trim());
      // Try ASCII mode first if enabled
      if (window._mermaidAsciiMode && typeof beautifulMermaid !== 'undefined'
          && typeof beautifulMermaid.renderMermaidAscii === 'function') {
        try {
          var asciiResult = beautifulMermaid.renderMermaidAscii(normalized, { useAscii: false });
          var pre = document.createElement('pre');
          pre.className = 'mermaid-ascii';
          pre.textContent = asciiResult;
          el.innerHTML = '';
          el.appendChild(pre);
          el.setAttribute('data-rendered', 'true');
          continue;
        } catch(_) { /* fall through to SVG */ }
      }
      // Try beautiful-mermaid first
      if (bmTheme) {
        try {
          var svg = await beautifulMermaid.renderMermaid(normalized, bmTheme);
          el.innerHTML = svg;
          el.setAttribute('data-rendered', 'true');
          continue;   // success → next element
        } catch(_) { /* fall through to vanilla mermaid */ }
      }
      // Fallback: vanilla mermaid
      if (typeof mermaid !== 'undefined') {
        var id = 'mermaid-fallback-' + Date.now() + '-' + i;
        var result = await mermaid.render(id, source.trim());
        el.innerHTML = result.svg;
        el.setAttribute('data-rendered', 'true');
      }
    } catch(e) { console.warn('Mermaid render error:', e); }
  }
};
window.renderMermaid();
</script>

<script>
// --- WaveDrom rendering ---
window.renderWaveDrom = function() {
  if (typeof WaveDrom === 'undefined') return;
  var wdIndex = 0;
  document.querySelectorAll('.wavedrom').forEach(function(el) {
    if (el.getAttribute('data-rendered')) return;
    try {
      var script = el.querySelector('script[type="WaveDrom"]');
      if (!script) return;
      var json = eval('(' + script.textContent + ')');
      // WaveDrom@3 API: RenderWaveForm(index, source, outputIdPrefix, notFirstSignal)
      // It renders into document.getElementById(outputIdPrefix + index)
      var prefix = 'WaveDrom_Display_';
      var svgContainer = document.createElement('div');
      svgContainer.id = prefix + wdIndex;
      el.appendChild(svgContainer);
      WaveDrom.RenderWaveForm(wdIndex, json, prefix, wdIndex > 0);
      wdIndex++;
      el.setAttribute('data-rendered', 'true');
      script.style.display = 'none';
    } catch(e) { console.warn('WaveDrom render error:', e); }
  });
};

// --- GraphViz rendering ---
window.renderGraphViz = function() {
  if (typeof Viz === 'undefined') return;
  document.querySelectorAll('.graphviz:not([data-rendered])').forEach(function(el) {
    try {
      var engine = el.getAttribute('data-engine') || 'dot';
      // Preserve source for re-rendering on theme change
      var source = el.getAttribute('data-source') || el.textContent;
      el.setAttribute('data-source', source);
      Viz.instance().then(function(viz) {
        var svg = viz.renderSVGElement(source, { engine: engine });
        el.textContent = '';
        el.appendChild(svg);
        el.setAttribute('data-rendered', 'true');
      });
    } catch(e) { console.warn('GraphViz render error:', e); }
  });
};

// --- Vega / Vega-Lite rendering ---
window.renderVega = function() {
  if (typeof vegaEmbed === 'undefined') {
    console.warn('vegaEmbed not loaded yet');
    return;
  }
  var isDark = window._isDarkTheme ? window._isDarkTheme() : false;
  var embedOpts = { actions: false };
  if (isDark) { embedOpts.theme = 'dark'; }
  ['vega', 'vega-lite'].forEach(function(cls) {
    document.querySelectorAll('div.' + cls + ':not([data-rendered])').forEach(function(el) {
      try {
        var script = el.querySelector('script[type="application/json"]');
        if (!script) return;
        var specText = script.textContent.trim();
        var spec;
        // Try JSON first, then YAML
        try { spec = JSON.parse(specText); }
        catch(_) {
          if (typeof jsyaml !== 'undefined') { spec = jsyaml.load(specText); }
          else {
            console.warn('Vega: cannot parse spec as JSON and js-yaml is not loaded');
            return;
          }
        }
        // Remove previous render container if re-rendering
        var oldContainer = el.querySelector('.vega-embed');
        if (oldContainer) oldContainer.remove();
        var container = document.createElement('div');
        el.appendChild(container);
        vegaEmbed(container, spec, embedOpts).then(function() {
          el.setAttribute('data-rendered', 'true');
          script.style.display = 'none';
        }).catch(function(err) {
          console.warn('vegaEmbed error:', err);
          container.innerHTML = '<div style="color:#c00;padding:8px;border:1px solid #c00;border-radius:4px;margin:8px 0;font-family:monospace;font-size:12px;">Vega render error: ' + (err.message || err) + '</div>';
          el.setAttribute('data-rendered', 'true');
          script.style.display = 'none';
        });
      } catch(e) { console.warn('Vega render error:', e); }
    });
  });
};

// --- Recharts rendering ---
window.renderRecharts = function() {
  var elements = document.querySelectorAll('.recharts:not([data-rendered])');
  if (elements.length === 0) return;

  // Check dependencies and show errors visually
  var errors = [];
  if (typeof React === 'undefined') errors.push('React not loaded');
  if (typeof ReactDOM === 'undefined') errors.push('ReactDOM not loaded');
  if (typeof Recharts === 'undefined') errors.push('Recharts not loaded');

  if (errors.length > 0) {
    elements.forEach(function(el) {
      el.innerHTML = '<div style="color:#c00;padding:12px;background:#fff0f0;border:1px solid #fcc;border-radius:4px;font-size:12px;">' +
        '<strong>Recharts Error:</strong><br>' + errors.join('<br>') +
        '<br><br><em>Scripts may still be loading. Try refreshing.</em></div>';
      el.setAttribute('data-rendered', 'true');
    });
    return;
  }

  var RC = Recharts;

  document.querySelectorAll('.recharts:not([data-rendered])').forEach(function(el) {
    try {
      // Get source from script tag or data-source attribute (Reveal.js fallback)
      var scriptEl = el.querySelector('script[type="text/recharts"]');
      var source = scriptEl ? scriptEl.textContent : '';
      if ((!source || !source.trim()) && el.hasAttribute('data-source')) {
        source = el.getAttribute('data-source') || '';
      }
      if (!source || !source.trim()) {
        el.innerHTML = '<div style="color:#999;padding:16px;text-align:center;">No chart data</div>';
        el.setAttribute('data-rendered', 'true');
        return;
      }
      // Store source as data attribute for copy functionality
      el.setAttribute('data-source', source);
      // Hide the script tag and loading message
      if (scriptEl) scriptEl.style.display = 'none';
      var loadingEl = el.querySelector('.recharts-loading');
      if (loadingEl) loadingEl.style.display = 'none';

      // Parse the JSX-like source to extract chart configuration
      var chartType = '';
      var typeMatch = source.match(/^\\s*<(LineChart|BarChart|PieChart|AreaChart|ComposedChart|ScatterChart|RadarChart)/);
      if (typeMatch) {
        chartType = typeMatch[1];
      } else {
        el.innerHTML = '<div style="color:#c00;padding:8px;">Unknown chart type</div>';
        el.setAttribute('data-rendered', 'true');
        return;
      }

      // Extract width and height
      var width = 500, height = 300;
      var sizeMatch = source.match(/width=\\{(\\d+)\\}/);
      if (sizeMatch) width = parseInt(sizeMatch[1]);
      sizeMatch = source.match(/height=\\{(\\d+)\\}/);
      if (sizeMatch) height = parseInt(sizeMatch[1]);

      // Extract data - find the data={[...]} pattern
      var data = [];
      var dataStart = source.indexOf('data={[');
      if (dataStart !== -1) {
        var bracketCount = 0;
        var dataEnd = dataStart + 7; // start at '[' (after 'data={[')
        // Start counting from '[' position
        for (var i = dataStart + 6; i < source.length; i++) {
          if (source[i] === '[' || source[i] === '{') bracketCount++;
          if (source[i] === ']' || source[i] === '}') bracketCount--;
          if (bracketCount === 0) {
            dataEnd = i + 1;
            break;
          }
        }
        // Extract just the array part: [...]
        var dataStr = source.substring(dataStart + 6, dataEnd);
        try {
          data = (new Function('return ' + dataStr))();
        } catch(e) {
          console.warn('Data parse error:', e, 'dataStr:', dataStr);
        }
      }

      // Build children array
      var children = [];

      // CartesianGrid
      if (source.indexOf('<CartesianGrid') !== -1) {
        var dashMatch = source.match(/strokeDasharray="([^"]+)"/);
        children.push(React.createElement(RC.CartesianGrid, {
          key: 'grid',
          strokeDasharray: dashMatch ? dashMatch[1] : '3 3'
        }));
      }

      // XAxis
      if (source.indexOf('<XAxis') !== -1) {
        var xKeyMatch = source.match(/<XAxis[^>]*dataKey="([^"]+)"/);
        children.push(React.createElement(RC.XAxis, {
          key: 'xaxis',
          dataKey: xKeyMatch ? xKeyMatch[1] : undefined
        }));
      }

      // YAxis
      if (source.indexOf('<YAxis') !== -1) {
        children.push(React.createElement(RC.YAxis, { key: 'yaxis' }));
      }

      // Tooltip
      if (source.indexOf('<Tooltip') !== -1) {
        children.push(React.createElement(RC.Tooltip, { key: 'tooltip' }));
      }

      // Legend
      if (source.indexOf('<Legend') !== -1) {
        children.push(React.createElement(RC.Legend, { key: 'legend' }));
      }

      // Line elements - handle different attribute orders
      var lineMatches = source.match(/<Line[^/]*\\/>/g) || [];
      lineMatches.forEach(function(lineStr, idx) {
        var typeM = lineStr.match(/type="([^"]+)"/);
        var keyM = lineStr.match(/dataKey="([^"]+)"/);
        var strokeM = lineStr.match(/stroke="([^"]+)"/);
        if (keyM) {
          children.push(React.createElement(RC.Line, {
            key: 'line-' + idx,
            type: typeM ? typeM[1] : 'monotone',
            dataKey: keyM[1],
            stroke: strokeM ? strokeM[1] : '#8884d8'
          }));
        }
      });

      // Bar elements
      var barMatches = source.match(/<Bar[^/]*\\/>/g) || [];
      barMatches.forEach(function(barStr, idx) {
        var keyM = barStr.match(/dataKey="([^"]+)"/);
        var fillM = barStr.match(/fill="([^"]+)"/);
        if (keyM) {
          children.push(React.createElement(RC.Bar, {
            key: 'bar-' + idx,
            dataKey: keyM[1],
            fill: fillM ? fillM[1] : '#8884d8'
          }));
        }
      });

      // Area elements
      var areaMatches = source.match(/<Area[^/]*\\/>/g) || [];
      areaMatches.forEach(function(areaStr, idx) {
        var typeM = areaStr.match(/type="([^"]+)"/);
        var keyM = areaStr.match(/dataKey="([^"]+)"/);
        var stackM = areaStr.match(/stackId="([^"]+)"/);
        var strokeM = areaStr.match(/stroke="([^"]+)"/);
        var fillM = areaStr.match(/fill="([^"]+)"/);
        if (keyM) {
          children.push(React.createElement(RC.Area, {
            key: 'area-' + idx,
            type: typeM ? typeM[1] : 'monotone',
            dataKey: keyM[1],
            stackId: stackM ? stackM[1] : undefined,
            stroke: strokeM ? strokeM[1] : '#8884d8',
            fill: fillM ? fillM[1] : '#8884d8'
          }));
        }
      });

      // Pie element (for PieChart)
      if (chartType === 'PieChart') {
        var pieMatch = source.match(/<Pie[\\s\\n][\\s\\S]*?(?=\\/>|>)/);
        if (pieMatch) {
          var pieStr = pieMatch[0];
          // Extract pie data
          var pieData = [];
          var pieDataStart = pieStr.indexOf('data={[');
          if (pieDataStart !== -1) {
            var pBracketCount = 0;
            var pDataEnd = pieDataStart + 6;
            for (var pi = pDataEnd; pi < pieStr.length + 100 && pi < source.length; pi++) {
              var ch = source[source.indexOf(pieStr) + pi - (pieDataStart - pieStr.indexOf('data={['))];
              if (!ch) break;
              if (ch === '[' || ch === '{') pBracketCount++;
              if (ch === ']' || ch === '}') pBracketCount--;
              if (pBracketCount === 0) {
                pDataEnd = pi + 1;
                break;
              }
            }
            // Re-extract from source around Pie
            var pieSection = source.substring(source.indexOf('<Pie'));
            var pdStart = pieSection.indexOf('data={[');
            if (pdStart !== -1) {
              var pdBracket = 0;
              var pdEnd = pdStart + 7;
              // Start counting from '[' position
              for (var pj = pdStart + 6; pj < pieSection.length; pj++) {
                if (pieSection[pj] === '[' || pieSection[pj] === '{') pdBracket++;
                if (pieSection[pj] === ']' || pieSection[pj] === '}') pdBracket--;
                if (pdBracket === 0) { pdEnd = pj + 1; break; }
              }
              // Extract just the array part: [...]
              var pieDataStr = pieSection.substring(pdStart + 6, pdEnd);
              try {
                pieData = (new Function('return ' + pieDataStr))();
              } catch(e) {
                console.warn('Pie data parse error:', e);
              }
            }
          }

          var cxM = pieStr.match(/cx="([^"]+)"/);
          var cyM = pieStr.match(/cy="([^"]+)"/);
          var orM = pieStr.match(/outerRadius=\\{?(\\d+)\\}?/);
          var fillM = pieStr.match(/fill="([^"]+)"/);
          var dkM = pieStr.match(/dataKey="([^"]+)"/);
          var hasLabel = pieStr.indexOf('label') !== -1;

          children.push(React.createElement(RC.Pie, {
            key: 'pie',
            data: pieData,
            cx: cxM ? cxM[1] : '50%',
            cy: cyM ? cyM[1] : '50%',
            outerRadius: orM ? parseInt(orM[1]) : 80,
            fill: fillM ? fillM[1] : '#8884d8',
            dataKey: dkM ? dkM[1] : 'value',
            label: hasLabel
          }));
        }
      }

      // Create chart component
      var ChartComp = RC[chartType];
      if (!ChartComp) {
        el.innerHTML = '<div style="color:#c00;padding:8px;">Chart component not found: ' + chartType + '</div>';
        el.setAttribute('data-rendered', 'true');
        return;
      }

      var chartProps = { width: width, height: height };
      if (chartType !== 'PieChart') {
        chartProps.data = data;
      }

      // Debug info
      console.log('Recharts rendering:', chartType, 'data:', data, 'children:', children.length);

      var chartElement = React.createElement(ChartComp, chartProps, children);

      // Create a wrapper div for React to render into
      var renderTarget = document.createElement('div');
      el.innerHTML = '';
      el.appendChild(renderTarget);

      // Render using React 18 API
      try {
        if (ReactDOM.createRoot) {
          var root = ReactDOM.createRoot(renderTarget);
          root.render(chartElement);
        } else {
          ReactDOM.render(chartElement, renderTarget);
        }
      } catch(renderErr) {
        el.innerHTML = '<div style="color:#c00;padding:8px;border:1px solid #c00;border-radius:4px;font-size:12px;">React render error: ' + (renderErr.message || renderErr) + '</div>';
      }

      el.setAttribute('data-rendered', 'true');
    } catch(e) {
      console.error('Recharts error:', e);
      el.innerHTML = '<div style="color:#c00;padding:8px;border:1px solid #c00;border-radius:4px;font-size:12px;">Recharts error: ' + (e.message || e) + '<br><br>Debug: chartType=' + (typeof chartType !== 'undefined' ? chartType : 'undefined') + ', dataLength=' + (typeof data !== 'undefined' ? data.length : 'undefined') + '</div>';
      el.setAttribute('data-rendered', 'true');
    }
  });
};

// --- Render all diagrams ---
window.renderAllDiagrams = function() {
  // Reset rendered state to support re-rendering after content/theme updates
  document.querySelectorAll('.mermaid[data-rendered]').forEach(function(el) {
    el.removeAttribute('data-rendered');
  });
  document.querySelectorAll('.graphviz[data-rendered]').forEach(function(el) {
    el.removeAttribute('data-rendered');
  });
  document.querySelectorAll('.recharts[data-rendered]').forEach(function(el) {
    el.removeAttribute('data-rendered');
  });
  if (window.renderMermaid) window.renderMermaid();
  window.renderWaveDrom();
  window.renderGraphViz();
  window.renderVega();
  window.renderRecharts();
  if (window._applyDiagramDarkFilter) window._applyDiagramDarkFilter();
};

// Re-render diagrams that support theme switching
window.rerenderDiagramsForTheme = function() {
  // Mermaid: re-render with dark/light beautiful-mermaid theme
  document.querySelectorAll('.mermaid[data-rendered]').forEach(function(el) {
    el.removeAttribute('data-rendered');
  });
  if (window.renderMermaid) window.renderMermaid();

  // Vega/Vega-Lite: re-render with dark/light theme option
  document.querySelectorAll('div.vega[data-rendered], div.vega-lite[data-rendered]').forEach(function(el) {
    el.removeAttribute('data-rendered');
  });
  window.renderVega();

  // WaveDrom/GraphViz/Kroki: toggle CSS filter (no native dark support)
  var isDark = window._isDarkTheme ? window._isDarkTheme() : false;
  document.querySelectorAll('.wavedrom, .graphviz, .kroki-diagram').forEach(function(el) {
    el.classList.toggle('diagram-invert-dark', isDark);
  });
};

// Apply dark filter to diagrams without native dark support
window._applyDiagramDarkFilter = function() {
  var isDark = window._isDarkTheme ? window._isDarkTheme() : false;
  document.querySelectorAll('.wavedrom, .graphviz, .kroki-diagram').forEach(function(el) {
    el.classList.toggle('diagram-invert-dark', isDark);
  });
};

// Initial render for non-mermaid diagrams (mermaid renders via its own script block)
// Use window.onload to ensure all external scripts (vega, wavedrom, viz.js, recharts) are loaded
window.addEventListener('load', function() {
  window.renderWaveDrom();
  window.renderGraphViz();
  window.renderVega();
  window.renderRecharts();
  window._applyDiagramDarkFilter();
});
// Also retry after a delay in case load event already fired or scripts are slow
setTimeout(function() {
  window.renderWaveDrom();
  window.renderGraphViz();
  window.renderVega();
  window.renderRecharts();
  window._applyDiagramDarkFilter();
}, 1500);

// Recharts needs extra time to load (React + ReactDOM + Recharts)
setTimeout(function() {
  window.renderRecharts();
}, 3000);

// Final retry
setTimeout(function() {
  window.renderRecharts();
}, 5000);
</script>`;
  }

  /**
   * Generate context menu HTML, CSS, and JS for the preview.
   */
  private generateContextMenuScripts(): string {
    return `
<!-- Context Menu -->
<div id="ctx-menu" class="ctx-menu" style="display:none;">
  <div class="ctx-group ctx-diagram">
    <div class="ctx-item" data-action="copy-diagram-source">Copy Diagram Source</div>
    <div class="ctx-item" data-action="copy-svg">Copy as SVG</div>
    <div class="ctx-item" data-action="copy-png">Copy as PNG</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="download-svg">Download SVG</div>
    <div class="ctx-item" data-action="download-png">Download PNG</div>
  </div>
  <div class="ctx-group ctx-code">
    <div class="ctx-item" data-action="copy-code">Copy Code</div>
    <div class="ctx-item ctx-run-online" data-action="run-online">Run Online</div>
  </div>
  <div class="ctx-group ctx-text">
    <div class="ctx-item" data-action="copy-text">Copy</div>
    <div class="ctx-item" data-action="select-all">Select All</div>
  </div>
  <div class="ctx-sep ctx-sep-before-page"></div>
  <div class="ctx-group ctx-page">
    <div class="ctx-item" data-action="refresh-preview">Refresh Preview</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="edit-source">Edit Source</div>
    <div class="ctx-item" data-action="side-by-side">Side by Side</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="copy-page">Copy Page</div>
    <div class="ctx-item" data-action="copy-for-lark">Copy for Lark (飞书)</div>
    <div class="ctx-item" data-action="save-html">Save as HTML</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item ctx-has-sub" data-action="preview-theme-switch">Preview Theme &#9656;
      <div class="ctx-submenu" id="ctx-preview-theme-sub"></div>
    </div>
    <div class="ctx-item ctx-has-sub" data-action="theme-switch">Color Scheme &#9656;
      <div class="ctx-submenu" id="ctx-theme-sub"></div>
    </div>
    <div class="ctx-item ctx-has-sub" data-action="mermaid-theme-switch">Mermaid Theme &#9656;
      <div class="ctx-submenu" id="ctx-mermaid-theme-sub"></div>
    </div>
    <div class="ctx-item" data-action="toggle-mermaid-ascii" id="ctx-mermaid-ascii-toggle">ASCII Diagrams</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="toggle-toc-sidebar" id="ctx-toc-sidebar-toggle">TOC Sidebar</div>
  </div>
</div>
<style>
.ctx-menu {
  position: fixed;
  z-index: 10000;
  min-width: 160px;
  background: rgba(246,246,246,0.95);
  border: 0.5px solid rgba(0,0,0,0.2);
  border-radius: 5px;
  box-shadow: 0 3px 12px rgba(0,0,0,0.18);
  padding: 3px 4px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 12.5px;
  color: #222;
  user-select: none;
  -webkit-user-select: none;
}
.ctx-item {
  padding: 3px 16px 3px 6px;
  border-radius: 3px;
  cursor: default;
  white-space: nowrap;
  position: relative;
  line-height: 1.35;
}
.ctx-item:hover {
  background: #0058d0;
  color: #fff;
}
.ctx-sep {
  height: 1px;
  background: rgba(0,0,0,0.12);
  margin: 3px 0;
}
.ctx-has-sub {
  padding-right: 20px;
}
.ctx-submenu {
  display: none;
  position: fixed;
  min-width: 140px;
  background: rgba(246,246,246,0.95);
  border: 0.5px solid rgba(0,0,0,0.2);
  border-radius: 5px;
  box-shadow: 0 3px 12px rgba(0,0,0,0.18);
  padding: 3px 4px;
  color: #222;
  z-index: 10001;
}
/* submenu visibility controlled by JS mouseenter/mouseleave */
.ctx-submenu .ctx-item {
  padding: 3px 6px;
  color: inherit;
}
/* Dark theme — explicit dark or vscode-dark */
[data-theme="dark"] .ctx-menu,
[data-theme="dark"] .ctx-submenu,
body.vscode-dark .ctx-menu,
body.vscode-dark .ctx-submenu {
  background: rgba(40,40,40,0.9);
  border-color: rgba(255,255,255,0.12);
  color: #ddd;
  box-shadow: 0 3px 12px rgba(0,0,0,0.4);
}
[data-theme="dark"] .ctx-item:hover,
body.vscode-dark .ctx-item:hover {
  background: #0058d0;
  color: #fff;
}
[data-theme="dark"] .ctx-sep,
body.vscode-dark .ctx-sep {
  background: rgba(255,255,255,0.1);
}
/* Dark theme — system follow */
@media (prefers-color-scheme: dark) {
  [data-theme="system"] .ctx-menu,
  [data-theme="system"] .ctx-submenu {
    background: rgba(40,40,40,0.9);
    border-color: rgba(255,255,255,0.12);
    color: #ddd;
    box-shadow: 0 3px 12px rgba(0,0,0,0.4);
  }
  [data-theme="system"] .ctx-item:hover {
    background: #0058d0;
    color: #fff;
  }
  [data-theme="system"] .ctx-sep {
    background: rgba(255,255,255,0.1);
  }
}
/* High contrast */
body.vscode-high-contrast .ctx-menu,
body.vscode-high-contrast .ctx-submenu {
  background: #000;
  border-color: #6fc3df;
  color: #fff;
}
body.vscode-high-contrast .ctx-item:hover {
  background: #6fc3df;
  color: #000;
}
body.vscode-high-contrast .ctx-sep {
  background: #6fc3df;
}
/* Hide Copy when no text selected */
.ctx-menu:not([data-has-selection="true"]) .ctx-text .ctx-item[data-action="copy-text"] { display: none; }
/* Hidden groups by default — JS sets data-target to show relevant ones */
.ctx-menu:not([data-target="diagram"]) .ctx-diagram { display: none; }
.ctx-menu:not([data-target="code"]) .ctx-code { display: none; }
.ctx-menu:not([data-target="diagram"]):not([data-target="code"]) .ctx-sep-before-page { display: none; }
/* Toast notification */
.ctx-toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.75);
  color: #fff;
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 13px;
  z-index: 10001;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
}
.ctx-toast.show { opacity: 1; }
</style>
<div id="ctx-toast" class="ctx-toast"></div>
<script>
(function() {
  var menu = document.getElementById('ctx-menu');
  var toast = document.getElementById('ctx-toast');
  var currentTarget = null; // { type, el, lang }
  var vscode = null;
  try { vscode = acquireVsCodeApi ? acquireVsCodeApi() : null; } catch(e) {}
  // If vscode was already acquired in the main script block, try to reuse
  // acquireVsCodeApi can only be called once — the main block already called it,
  // so we use a shared reference via window
  // Patch: store vscode api globally in main script block, reuse here
  if (!vscode && window._vscodeApi) vscode = window._vscodeApi;

  // --- Toast ---
  var toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { toast.classList.remove('show'); }, 1500);
  }

  // --- Target detection ---
  var diagramClasses = ['mermaid', 'wavedrom', 'graphviz', 'vega', 'vega-lite', 'kroki-diagram'];
  function findContextTarget(el) {
    var node = el;
    while (node && node !== document.body) {
      for (var i = 0; i < diagramClasses.length; i++) {
        if (node.classList && node.classList.contains(diagramClasses[i])) {
          return { type: 'diagram', el: node };
        }
      }
      if (node.tagName === 'PRE' && node.querySelector('code')) {
        var codeEl = node.querySelector('code');
        var lang = '';
        // Try data-lang on <pre> (Shiki output)
        if (node.getAttribute('data-lang')) {
          lang = node.getAttribute('data-lang');
        }
        // Try language-xxx class on <code> (markdown-it output)
        if (!lang && codeEl.className) {
          var m = codeEl.className.match(/language-(\\w+)/);
          if (m) lang = m[1];
        }
        // Try language-xxx class on <pre> (fallback renderer)
        if (!lang && node.className) {
          var m2 = node.className.match(/language-(\\w+)/);
          if (m2) lang = m2[1];
        }
        return { type: 'code', el: node, lang: lang };
      }
      node = node.parentElement;
    }
    return { type: 'page', el: document.body };
  }

  // --- Playground URL map ---
  var playgrounds = {
    javascript: { url: 'https://jsfiddle.net', encode: false },
    js:         { url: 'https://jsfiddle.net', encode: false },
    typescript: { url: 'https://www.typescriptlang.org/play', encode: false },
    ts:         { url: 'https://www.typescriptlang.org/play', encode: false },
    python:     { url: 'https://www.online-python.com', encode: false },
    py:         { url: 'https://www.online-python.com', encode: false },
    go:         { url: 'https://go.dev/play', encode: false },
    rust:       { url: 'https://play.rust-lang.org', encode: true,
                  buildUrl: function(code) {
                    return 'https://play.rust-lang.org/?version=stable&mode=debug&edition=2021&code=' + encodeURIComponent(code);
                  } }
  };

  // --- Show / hide menu ---
  function showContextMenu(x, y, target) {
    currentTarget = target;
    menu.setAttribute('data-target', target.type);

    // Detect text selection for copy menu item
    var selection = window.getSelection();
    var hasSelection = selection && selection.toString().trim().length > 0;
    menu.setAttribute('data-has-selection', hasSelection ? 'true' : 'false');

    // Show/hide "Run Online" based on language support
    var runItem = menu.querySelector('.ctx-run-online');
    if (runItem) {
      runItem.style.display = (target.type === 'code' && playgrounds[target.lang]) ? '' : 'none';
    }

    // Populate theme submenus
    populatePreviewThemeSubmenu();
    populateThemeSubmenu();
    populateMermaidThemeSubmenu();

    // Update ASCII Diagrams toggle label
    var asciiToggle = document.getElementById('ctx-mermaid-ascii-toggle');
    if (asciiToggle) {
      asciiToggle.textContent = (window._mermaidAsciiMode ? '✓ ' : '   ') + 'ASCII Diagrams';
    }

    // Update TOC Sidebar toggle label and visibility
    var tocToggle = document.getElementById('ctx-toc-sidebar-toggle');
    if (tocToggle) {
      var hasToc = document.body.getAttribute('data-has-toc') === 'true';
      var tocContainer = document.getElementById('toc-container');
      var tocVisible = tocContainer && !tocContainer.classList.contains('hidden');
      tocToggle.textContent = (tocVisible ? '✓ ' : '   ') + 'TOC Sidebar';
      tocToggle.style.display = hasToc ? '' : 'none';
    }

    menu.style.display = 'block';

    // Position with overflow prevention
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    if (x + mw > vw) x = vw - mw - 4;
    if (y + mh > vh) y = vh - mh - 4;
    if (x < 0) x = 4;
    if (y < 0) y = 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function hideMenu() {
    menu.style.display = 'none';
    // Also hide any open submenus
    var subs = menu.querySelectorAll('.ctx-submenu');
    for (var s = 0; s < subs.length; s++) {
      subs[s].style.display = 'none';
    }
    currentTarget = null;
  }

  // --- Preview Theme submenu ---
  var previewThemeOptions = [
    { group: 'Light', themes: [
      { value: 'github', label: 'GitHub' },
      { value: 'obsidian', label: 'Obsidian' },
      { value: 'vue', label: 'Vue' },
      { value: 'lark', label: 'Lark (飞书)' },
      { value: 'smartblue', label: 'Smartblue' },
      { value: 'medium', label: 'Medium' },
      { value: 'gothic', label: 'Gothic' }
    ]},
    { group: 'Dark', themes: [
      { value: 'dracula', label: 'Dracula' },
      { value: 'nord', label: 'Nord' },
      { value: 'one-dark', label: 'One Dark' },
      { value: 'tokyo-night', label: 'Tokyo Night' },
      { value: 'monokai', label: 'Monokai' },
      { value: 'solarized', label: 'Solarized' }
    ]}
  ];
  function populatePreviewThemeSubmenu() {
    var sub = document.getElementById('ctx-preview-theme-sub');
    if (!sub) return;
    sub.innerHTML = '';
    var current = document.body.getAttribute('data-preview-theme') || 'github';
    for (var g = 0; g < previewThemeOptions.length; g++) {
      var group = previewThemeOptions[g];
      if (g > 0) {
        var sep = document.createElement('div');
        sep.className = 'ctx-sep';
        sub.appendChild(sep);
      }
      var header = document.createElement('div');
      header.className = 'ctx-item';
      header.style.fontWeight = 'bold';
      header.style.cursor = 'default';
      header.style.pointerEvents = 'none';
      header.style.opacity = '0.6';
      header.style.fontSize = '11px';
      header.textContent = group.group;
      sub.appendChild(header);
      for (var t = 0; t < group.themes.length; t++) {
        var opt = group.themes[t];
        var item = document.createElement('div');
        item.className = 'ctx-item';
        item.setAttribute('data-action', 'set-preview-theme');
        item.setAttribute('data-preview-theme', opt.value);
        item.textContent = (opt.value === current ? '✓ ' : '   ') + opt.label;
        sub.appendChild(item);
      }
    }
  }

  // --- Color Scheme submenu ---
  var themeOptions = [
    { value: 'system', label: 'System (Auto)' },
    { value: 'light',  label: 'Light' },
    { value: 'dark',   label: 'Dark' }
  ];
  function populateThemeSubmenu() {
    var sub = document.getElementById('ctx-theme-sub');
    if (!sub) return;
    sub.innerHTML = '';
    var current = document.body.getAttribute('data-theme') || 'system';
    for (var i = 0; i < themeOptions.length; i++) {
      var opt = themeOptions[i];
      var item = document.createElement('div');
      item.className = 'ctx-item';
      item.setAttribute('data-action', 'set-theme');
      item.setAttribute('data-theme', opt.value);
      item.textContent = (opt.value === current ? '✓ ' : '   ') + opt.label;
      sub.appendChild(item);
    }
  }

  // --- Mermaid Theme submenu ---
  var mermaidThemeOptions = [
    { group: 'Light', themes: [
      { value: 'github-light', label: 'GitHub Light' },
      { value: 'solarized-light', label: 'Solarized Light' },
      { value: 'catppuccin-latte', label: 'Catppuccin Latte' },
      { value: 'nord-light', label: 'Nord Light' },
      { value: 'tokyo-night-light', label: 'Tokyo Night Light' },
      { value: 'zinc-light', label: 'Zinc Light' }
    ]},
    { group: 'Dark', themes: [
      { value: 'github-dark', label: 'GitHub Dark' },
      { value: 'solarized-dark', label: 'Solarized Dark' },
      { value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
      { value: 'nord', label: 'Nord' },
      { value: 'tokyo-night', label: 'Tokyo Night' },
      { value: 'tokyo-night-storm', label: 'Tokyo Night Storm' },
      { value: 'zinc-dark', label: 'Zinc Dark' },
      { value: 'one-dark', label: 'One Dark' },
      { value: 'dracula', label: 'Dracula' }
    ]}
  ];
  function populateMermaidThemeSubmenu() {
    var sub = document.getElementById('ctx-mermaid-theme-sub');
    if (!sub) return;
    sub.innerHTML = '';
    var current = window._mermaidThemeKey || '';
    for (var g = 0; g < mermaidThemeOptions.length; g++) {
      var group = mermaidThemeOptions[g];
      if (g > 0) {
        var sep = document.createElement('div');
        sep.className = 'ctx-sep';
        sub.appendChild(sep);
      }
      var header = document.createElement('div');
      header.className = 'ctx-item';
      header.style.fontWeight = 'bold';
      header.style.cursor = 'default';
      header.style.pointerEvents = 'none';
      header.style.opacity = '0.6';
      header.style.fontSize = '11px';
      header.textContent = group.group;
      sub.appendChild(header);
      for (var t = 0; t < group.themes.length; t++) {
        var opt = group.themes[t];
        var item = document.createElement('div');
        item.className = 'ctx-item';
        item.setAttribute('data-action', 'set-mermaid-theme');
        item.setAttribute('data-mermaid-theme', opt.value);
        item.textContent = (opt.value === current ? '✓ ' : '   ') + opt.label;
        sub.appendChild(item);
      }
    }
  }

  // --- Submenu positioning ---
  // Position submenu to avoid viewport overflow
  var subParents = menu.querySelectorAll('.ctx-has-sub');
  for (var sp = 0; sp < subParents.length; sp++) {
    (function(parent) {
      var hideTimer = null;
      function showSub() {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        var sub = parent.querySelector('.ctx-submenu');
        if (!sub) return;
        // Temporarily show to measure
        sub.style.visibility = 'hidden';
        sub.style.display = 'block';
        var parentRect = parent.getBoundingClientRect();
        var sw = sub.offsetWidth;
        var sh = sub.offsetHeight;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        // Default: right side of parent item
        var left = parentRect.right + 2;
        var top = parentRect.top;
        // If overflows right, show on left side
        if (left + sw > vw) {
          left = parentRect.left - sw - 2;
        }
        // If overflows bottom, shift up
        if (top + sh > vh) {
          top = vh - sh - 4;
        }
        if (left < 0) left = 4;
        if (top < 0) top = 4;
        sub.style.left = left + 'px';
        sub.style.top = top + 'px';
        sub.style.visibility = '';
      }
      function hideSub() {
        hideTimer = setTimeout(function() {
          var sub = parent.querySelector('.ctx-submenu');
          if (sub) sub.style.display = 'none';
        }, 100);
      }
      parent.addEventListener('mouseenter', showSub);
      parent.addEventListener('mouseleave', hideSub);
      // Keep submenu open when hovering over the submenu itself
      var sub = parent.querySelector('.ctx-submenu');
      if (sub) {
        sub.addEventListener('mouseenter', function() {
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        });
        sub.addEventListener('mouseleave', hideSub);
      }
    })(subParents[sp]);
  }

  // --- Event listeners ---
  document.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    var target = findContextTarget(e.target);
    showContextMenu(e.clientX, e.clientY, target);
  });

  document.addEventListener('click', function(e) {
    if (!menu.contains(e.target)) {
      hideMenu();
    }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hideMenu();
  });

  document.addEventListener('scroll', function() { hideMenu(); }, true);

  // --- Menu item click handler ---
  menu.addEventListener('click', function(e) {
    var item = e.target.closest('.ctx-item');
    if (!item) return;
    var action = item.getAttribute('data-action');
    if (!action || action === 'preview-theme-switch' || action === 'theme-switch' || action === 'mermaid-theme-switch') return; // submenu parent, ignore

    handleAction(action, item);
    hideMenu();
  });

  // --- Action handlers ---
  function handleAction(action, item) {
    if (!currentTarget) return;
    var el = currentTarget.el;

    switch (action) {
      // --- Text actions ---
      case 'copy-text':
        document.execCommand('copy');
        showToast('Copied');
        break;

      case 'select-all':
        var saRange = document.createRange();
        var saContent = document.getElementById('preview-content');
        if (saContent) {
          saRange.selectNodeContents(saContent);
          var saSel = window.getSelection();
          saSel.removeAllRanges();
          saSel.addRange(saRange);
        }
        break;

      // --- Diagram actions ---
      case 'copy-diagram-source':
        var src = el.getAttribute('data-source') || el.textContent;
        navigator.clipboard.writeText(src).then(function() { showToast('Copied diagram source'); });
        break;

      case 'copy-svg':
        var svg = el.querySelector('svg');
        if (!svg) { showToast('No SVG found'); return; }
        var svgStr = new XMLSerializer().serializeToString(svg);
        navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([svgStr], { type: 'text/plain' })
        })]).then(function() { showToast('Copied SVG'); });
        break;

      case 'copy-png':
        var svgEl = el.querySelector('svg');
        if (!svgEl) { showToast('No SVG found'); return; }
        svgToPngBlob(svgEl, function(blob) {
          if (!blob) { showToast('Failed to create PNG'); return; }
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            .then(function() { showToast('Copied PNG'); });
        });
        break;

      case 'download-svg':
        var dlSvg = el.querySelector('svg');
        if (!dlSvg) return;
        var dlSvgStr = new XMLSerializer().serializeToString(dlSvg);
        if (vscode) {
          vscode.postMessage({ command: 'downloadFile', args: ['diagram.svg', dlSvgStr, 'text'] });
        }
        break;

      case 'download-png':
        var dlSvgEl = el.querySelector('svg');
        if (!dlSvgEl) return;
        svgToPngBlob(dlSvgEl, function(blob) {
          if (!blob) return;
          var reader = new FileReader();
          reader.onload = function() {
            // Send base64 data to extension host for saving
            var base64 = reader.result.split(',')[1];
            if (vscode) {
              vscode.postMessage({ command: 'downloadFile', args: ['diagram.png', base64, 'base64'] });
            }
          };
          reader.readAsDataURL(blob);
        });
        break;

      // --- Code actions ---
      case 'copy-code':
        var codeText = extractCodeText(el);
        navigator.clipboard.writeText(codeText).then(function() { showToast('Copied code'); });
        break;

      case 'run-online':
        var lang = currentTarget.lang;
        var pg = playgrounds[lang];
        if (pg && vscode) {
          var codeForRun = extractCodeText(el);
          var pgUrl = pg.url;
          // Build URL with code if supported, otherwise copy to clipboard
          if (pg.encode && pg.buildUrl && codeForRun) {
            pgUrl = pg.buildUrl(codeForRun);
            vscode.postMessage({ command: 'openExternal', args: [pgUrl] });
          } else {
            // Copy code to clipboard, then open playground
            navigator.clipboard.writeText(codeForRun).then(function() {
              showToast('Code copied — paste into the playground');
              vscode.postMessage({ command: 'openExternal', args: [pgUrl] });
            });
          }
        }
        break;

      // --- Editor actions ---
      case 'refresh-preview':
        if (vscode && window._sourceUri) {
          vscode.postMessage({
            command: 'refreshPreview',
            args: [window._sourceUri]
          });
        }
        break;

      case 'edit-source':
        if (vscode && window._sourceUri) {
          vscode.postMessage({
            command: 'editSource',
            args: [window._sourceUri]
          });
        }
        break;

      case 'side-by-side':
        if (vscode && window._sourceUri) {
          vscode.postMessage({
            command: 'openSideBySide',
            args: [window._sourceUri]
          });
        }
        break;

      // --- Page actions ---
      case 'copy-page':
        var range = document.createRange();
        var content = document.getElementById('preview-content');
        if (content) {
          range.selectNodeContents(content);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('copy');
          sel.removeAllRanges();
          showToast('Copied page');
        }
        break;

      case 'copy-for-lark':
        copyForLark();
        break;

      case 'save-html':
        if (vscode) {
          vscode.postMessage({
            command: 'saveAsHtml',
            args: [document.documentElement.outerHTML]
          });
        }
        break;

      case 'set-preview-theme':
        var newPreviewTheme = item.getAttribute('data-preview-theme');
        if (newPreviewTheme) {
          document.body.setAttribute('data-preview-theme', newPreviewTheme);
          // Persist to VS Code settings
          if (vscode && window._sourceUri) {
            vscode.postMessage({ command: 'setPreviewTheme', args: [window._sourceUri, newPreviewTheme] });
          }
        }
        break;

      case 'set-theme':
        var theme = item.getAttribute('data-theme');
        if (theme) {
          document.body.setAttribute('data-theme', theme);
          // Also update context menu styling to match
          updateContextMenuThemeClass(theme);
          // Re-render diagrams with new theme (mermaid, graphviz)
          if (window.rerenderDiagramsForTheme) {
            window.rerenderDiagramsForTheme();
          }
        }
        break;

      case 'set-mermaid-theme':
        var newMermaidTheme = item.getAttribute('data-mermaid-theme');
        if (newMermaidTheme) {
          window._mermaidThemeKey = newMermaidTheme;
          if (window.rerenderDiagramsForTheme) {
            window.rerenderDiagramsForTheme();
          }
          // Persist to VS Code settings
          if (vscode) {
            vscode.postMessage({ command: 'setMermaidTheme', args: [newMermaidTheme] });
          }
        }
        break;

      case 'toggle-mermaid-ascii':
        window._mermaidAsciiMode = !window._mermaidAsciiMode;
        if (window.rerenderDiagramsForTheme) {
          window.rerenderDiagramsForTheme();
        }
        if (vscode) {
          vscode.postMessage({ command: 'setMermaidAsciiMode', args: [window._mermaidAsciiMode] });
        }
        break;

      case 'toggle-toc-sidebar':
        if (window._toggleTocSidebar) {
          window._toggleTocSidebar();
        }
        break;
    }
  }

  // --- Helpers ---

  // Copy content optimized for Lark/Feishu paste
  async function copyForLark() {
    var content = document.getElementById('preview-content');
    if (!content) return;

    // Clone content for processing
    var clone = content.cloneNode(true);

    // 1. Remove hover control panels
    clone.querySelectorAll('.code-block-controls, .diagram-controls, .code-chunk-controls').forEach(function(el) {
      el.remove();
    });

    // 2. Convert diagrams (SVG) to PNG images for better Lark compatibility
    var diagramContainers = clone.querySelectorAll('.diagram-container');
    var conversionPromises = [];

    diagramContainers.forEach(function(container) {
      var svg = container.querySelector('svg');
      if (svg) {
        var promise = new Promise(function(resolve) {
          svgToPngDataUrl(svg, function(dataUrl) {
            if (dataUrl) {
              // Replace diagram with img
              var img = document.createElement('img');
              img.src = dataUrl;
              img.style.maxWidth = '100%';
              img.alt = 'diagram';
              // Keep only the image, remove controls
              container.innerHTML = '';
              container.appendChild(img);
            }
            resolve();
          });
        });
        conversionPromises.push(promise);
      }
    });

    // 3. Process code blocks - convert to simple pre with proper formatting
    clone.querySelectorAll('.code-block-container').forEach(function(container) {
      var pre = container.querySelector('pre');
      if (pre) {
        // Extract plain text code
        var codeText = extractCodeText(pre);
        // Create a simple pre element that Lark handles well
        var newPre = document.createElement('pre');
        newPre.style.cssText = 'background:#f5f5f5;padding:12px;border-radius:4px;font-family:monospace;font-size:13px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;';
        newPre.textContent = codeText;
        container.parentNode.replaceChild(newPre, container);
      }
    });

    // 4. Process code chunks similarly
    clone.querySelectorAll('.code-chunk').forEach(function(chunk) {
      var pre = chunk.querySelector('.code-chunk-source pre');
      if (pre) {
        var codeText = extractCodeText(pre);
        var newPre = document.createElement('pre');
        newPre.style.cssText = 'background:#f5f5f5;padding:12px;border-radius:4px;font-family:monospace;font-size:13px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;';
        newPre.textContent = codeText;

        // Also include output if any
        var output = chunk.querySelector('.code-chunk-output');
        var wrapper = document.createElement('div');
        wrapper.appendChild(newPre);
        if (output && output.innerHTML.trim()) {
          var outputDiv = document.createElement('div');
          outputDiv.style.cssText = 'background:#fafafa;padding:8px;border:1px solid #eee;margin-top:-1px;border-radius:0 0 4px 4px;';
          outputDiv.innerHTML = output.innerHTML;
          wrapper.appendChild(outputDiv);
        }
        chunk.parentNode.replaceChild(wrapper, chunk);
      }
    });

    // 5. Clean up Shiki code blocks (syntax highlighted)
    clone.querySelectorAll('pre.shiki').forEach(function(pre) {
      var codeText = extractCodeText(pre);
      var newPre = document.createElement('pre');
      newPre.style.cssText = 'background:#f5f5f5;padding:12px;border-radius:4px;font-family:monospace;font-size:13px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;';
      newPre.textContent = codeText;
      pre.parentNode.replaceChild(newPre, pre);
    });

    // 6. Process tables - add inline styles for Lark
    clone.querySelectorAll('table').forEach(function(table) {
      table.style.cssText = 'border-collapse:collapse;width:100%;margin:1em 0;';
      table.querySelectorAll('th, td').forEach(function(cell) {
        cell.style.cssText = 'border:1px solid #ddd;padding:8px;text-align:left;';
      });
      table.querySelectorAll('th').forEach(function(th) {
        th.style.backgroundColor = '#f5f5f5';
        th.style.fontWeight = 'bold';
      });
    });

    // 7. Process blockquotes
    clone.querySelectorAll('blockquote').forEach(function(bq) {
      bq.style.cssText = 'border-left:4px solid #ddd;margin:1em 0;padding:0.5em 1em;color:#666;background:#f9f9f9;';
    });

    // 8. Process images - ensure they have proper styling
    clone.querySelectorAll('img').forEach(function(img) {
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
    });

    // 9. Process math formulas - keep as-is or convert to image
    // KaTeX rendered formulas should paste reasonably well

    // 10. Process task lists
    clone.querySelectorAll('.task-list-item').forEach(function(item) {
      var checkbox = item.querySelector('input[type="checkbox"]');
      if (checkbox) {
        var span = document.createElement('span');
        span.textContent = checkbox.checked ? '☑ ' : '☐ ';
        checkbox.parentNode.replaceChild(span, checkbox);
      }
    });

    // Wait for all SVG→PNG conversions
    await Promise.all(conversionPromises);

    // Create a temporary container for copying
    var tempDiv = document.createElement('div');
    tempDiv.style.cssText = 'position:fixed;left:-9999px;top:0;';
    tempDiv.innerHTML = clone.innerHTML;
    document.body.appendChild(tempDiv);

    // Select and copy
    var range = document.createRange();
    range.selectNodeContents(tempDiv);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // Copy as both HTML and plain text for best compatibility
    try {
      // Try using clipboard API with multiple formats
      var htmlContent = tempDiv.innerHTML;
      var textContent = tempDiv.innerText;

      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([htmlContent], { type: 'text/html' }),
          'text/plain': new Blob([textContent], { type: 'text/plain' })
        })
      ]);
      showToast('已复制，可粘贴到飞书');
    } catch (err) {
      // Fallback to execCommand
      document.execCommand('copy');
      showToast('已复制，可粘贴到飞书');
    }

    sel.removeAllRanges();
    document.body.removeChild(tempDiv);
  }

  // Convert SVG to PNG data URL
  function svgToPngDataUrl(svgEl, callback) {
    var svgStr = new XMLSerializer().serializeToString(svgEl);
    var canvas = document.createElement('canvas');
    var img = new Image();
    img.onload = function() {
      canvas.width = img.naturalWidth * 2;
      canvas.height = img.naturalHeight * 2;
      var c = canvas.getContext('2d');
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.scale(2, 2);
      c.drawImage(img, 0, 0);
      callback(canvas.toDataURL('image/png'));
    };
    img.onerror = function() { callback(null); };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
  }

  function svgToPngBlob(svgEl, callback) {
    var svgStr = new XMLSerializer().serializeToString(svgEl);
    var canvas = document.createElement('canvas');
    var img = new Image();
    img.onload = function() {
      canvas.width = img.naturalWidth * 2;
      canvas.height = img.naturalHeight * 2;
      var c = canvas.getContext('2d');
      c.scale(2, 2);
      c.drawImage(img, 0, 0);
      canvas.toBlob(function(blob) { callback(blob); }, 'image/png');
    };
    img.onerror = function() { callback(null); };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
  }

  function downloadFile(name, type, content) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function updateContextMenuThemeClass(theme) {
    // Toggle vscode-dark class to match chosen theme so context menu adapts
    var isDark = theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('vscode-dark', isDark);
    document.body.classList.toggle('vscode-light', !isDark);
  }

  // Listen for OS theme changes when in system mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
    if (document.body.getAttribute('data-theme') === 'system') {
      updateContextMenuThemeClass('system');
      // Re-render diagrams for new system theme
      if (window.rerenderDiagramsForTheme) {
        window.rerenderDiagramsForTheme();
      }
    }
  });

  function extractCodeText(preEl) {
    var codeEl = preEl.querySelector('code');
    if (!codeEl) return preEl.textContent;
    // Try line-based extraction (skip line numbers)
    var lines = codeEl.querySelectorAll('.line, .code-line');
    if (lines.length > 0) {
      return Array.from(lines).map(function(line) {
        var content = line.querySelector('.line-content');
        if (content) return content.textContent;
        var clone = line.cloneNode(true);
        var ln = clone.querySelector('.line-number');
        if (ln) ln.remove();
        return clone.textContent;
      }).join('\\n');
    }
    return codeEl.textContent;
  }
  // Expose for page toolbar
  window._showToast = showToast;
  window._copyForLark = copyForLark;
})();
</script>`;
  }

  /**
   * Get theme-specific CSS with multiple preview themes.
   * Each theme defines CSS custom properties for both light and dark modes.
   * Theme is selected via data-preview-theme attribute on body.
   * Light/dark switching uses data-theme attribute (system/light/dark).
   */
  private getThemeCSS(): string {
    interface ThemeColors {
      bg: string; fg: string; fgMuted: string; border: string;
      bgSecondary: string; bgTertiary: string; link: string;
      codeBg: string; preBg: string;
      blockquoteBorder: string; blockquoteBg: string; blockquoteFg: string;
      thBg: string; shadow: string; markBg: string; markFg: string;
      fontFamily?: string;
    }

    const themes: Record<string, { light: ThemeColors; dark: ThemeColors }> = {
      // ── GitHub ─────────────────────────────────────────────
      github: {
        light: {
          bg: '#ffffff', fg: '#24292e', fgMuted: '#586069', border: '#e1e4e8',
          bgSecondary: '#f6f8fa', bgTertiary: '#eaecef', link: '#0366d6',
          codeBg: '#f6f8fa', preBg: '#f6f8fa',
          blockquoteBorder: '#dfe2e5', blockquoteBg: '#f6f8fa', blockquoteFg: '#6a737d',
          thBg: '#f6f8fa', shadow: 'rgba(0,0,0,0.06)', markBg: '#fff3aa', markFg: '#24292e',
        },
        dark: {
          bg: '#0d1117', fg: '#c9d1d9', fgMuted: '#8b949e', border: '#30363d',
          bgSecondary: '#161b22', bgTertiary: '#21262d', link: '#58a6ff',
          codeBg: '#161b22', preBg: '#161b22',
          blockquoteBorder: '#3b434b', blockquoteBg: '#161b22', blockquoteFg: '#8b949e',
          thBg: '#161b22', shadow: 'rgba(0,0,0,0.3)', markBg: '#5c4b00', markFg: '#e6d9a8',
        },
      },
      // ── Obsidian ───────────────────────────────────────────
      obsidian: {
        light: {
          bg: '#ffffff', fg: '#2e3338', fgMuted: '#6c7680', border: '#e3e3e3',
          bgSecondary: '#f3f3f3', bgTertiary: '#e8e8e8', link: '#705dcf',
          codeBg: '#f3f3f3', preBg: '#f3f3f3',
          blockquoteBorder: '#705dcf', blockquoteBg: '#f8f5ff', blockquoteFg: '#6c7680',
          thBg: '#f3f3f3', shadow: 'rgba(0,0,0,0.05)', markBg: '#fff3aa', markFg: '#2e3338',
        },
        dark: {
          bg: '#1e1e1e', fg: '#dcddde', fgMuted: '#999999', border: '#363636',
          bgSecondary: '#262626', bgTertiary: '#303030', link: '#a78bfa',
          codeBg: '#262626', preBg: '#262626',
          blockquoteBorder: '#a78bfa', blockquoteBg: '#2a2640', blockquoteFg: '#999999',
          thBg: '#303030', shadow: 'rgba(0,0,0,0.3)', markBg: '#5c4b00', markFg: '#dcddde',
        },
      },
      // ── Vue ────────────────────────────────────────────────
      vue: {
        light: {
          bg: '#ffffff', fg: '#2c3e50', fgMuted: '#7f8c8d', border: '#eaecef',
          bgSecondary: '#f3f5f7', bgTertiary: '#e8ecef', link: '#42b983',
          codeBg: '#f3f5f7', preBg: '#f3f5f7',
          blockquoteBorder: '#42b983', blockquoteBg: '#f0faf5', blockquoteFg: '#7f8c8d',
          thBg: '#f3f5f7', shadow: 'rgba(0,0,0,0.05)', markBg: '#ffffb8', markFg: '#2c3e50',
        },
        dark: {
          bg: '#1e1e20', fg: '#d4d4d4', fgMuted: '#858585', border: '#3e3e42',
          bgSecondary: '#252526', bgTertiary: '#2d2d30', link: '#42d392',
          codeBg: '#252526', preBg: '#252526',
          blockquoteBorder: '#42b983', blockquoteBg: '#1e2a22', blockquoteFg: '#858585',
          thBg: '#2d2d30', shadow: 'rgba(0,0,0,0.3)', markBg: '#4d4000', markFg: '#d4d4a0',
        },
      },
      // ── Lark (Feishu) ─────────────────────────────────────
      lark: {
        light: {
          bg: '#ffffff', fg: '#1f2329', fgMuted: '#646a73', border: '#dee0e3',
          bgSecondary: '#f5f6f7', bgTertiary: '#eff0f1', link: '#3370ff',
          codeBg: '#f5f6f7', preBg: '#f5f6f7',
          blockquoteBorder: '#3370ff', blockquoteBg: '#f0f4ff', blockquoteFg: '#646a73',
          thBg: '#f5f6f7', shadow: 'rgba(0,0,0,0.05)', markBg: 'rgba(255,246,122,0.8)', markFg: '#1f2329',
        },
        dark: {
          bg: '#1b1b1f', fg: '#d1d4d8', fgMuted: '#8f959e', border: '#373940',
          bgSecondary: '#222226', bgTertiary: '#2a2a2e', link: '#5c94ff',
          codeBg: '#222226', preBg: '#222226',
          blockquoteBorder: '#5c94ff', blockquoteBg: '#1e2230', blockquoteFg: '#8f959e',
          thBg: '#2a2a2e', shadow: 'rgba(0,0,0,0.3)', markBg: '#5c4b00', markFg: '#d1d4a0',
        },
      },
      // ── Smartblue ──────────────────────────────────────────
      smartblue: {
        light: {
          bg: '#ffffff', fg: '#595959', fgMuted: '#888888', border: '#e0e0e0',
          bgSecondary: '#f8f8f8', bgTertiary: '#f0f0f0', link: '#036aca',
          codeBg: '#fff5f5', preBg: '#f8f8f8',
          blockquoteBorder: '#b2aec5', blockquoteBg: '#fff9f9', blockquoteFg: '#666666',
          thBg: '#f6f8fa', shadow: 'rgba(0,0,0,0.06)', markBg: '#ffffb5', markFg: '#595959',
        },
        dark: {
          bg: '#1a1a2e', fg: '#d0d0d0', fgMuted: '#888888', border: '#3a3a50',
          bgSecondary: '#21213a', bgTertiary: '#28284a', link: '#5b9fef',
          codeBg: '#28284a', preBg: '#21213a',
          blockquoteBorder: '#7b77a5', blockquoteBg: '#21213a', blockquoteFg: '#888888',
          thBg: '#28284a', shadow: 'rgba(0,0,0,0.3)', markBg: '#5c4b00', markFg: '#d0d0a0',
        },
      },
      // ── Medium ─────────────────────────────────────────────
      medium: {
        light: {
          bg: '#ffffff', fg: '#292929', fgMuted: '#757575', border: '#e6e6e6',
          bgSecondary: '#fafafa', bgTertiary: '#f2f2f2', link: '#1a8917',
          codeBg: '#f2f2f2', preBg: '#f2f2f2',
          blockquoteBorder: '#e0e0e0', blockquoteBg: 'transparent', blockquoteFg: '#6b6b6b',
          thBg: '#fafafa', shadow: 'rgba(0,0,0,0.05)', markBg: '#ffffcc', markFg: '#292929',
          fontFamily: "Georgia, Cambria, 'Times New Roman', Times, serif",
        },
        dark: {
          bg: '#121212', fg: '#e0e0e0', fgMuted: '#999999', border: '#333333',
          bgSecondary: '#1a1a1a', bgTertiary: '#222222', link: '#27c024',
          codeBg: '#1a1a1a', preBg: '#1a1a1a',
          blockquoteBorder: '#444444', blockquoteBg: 'transparent', blockquoteFg: '#888888',
          thBg: '#1a1a1a', shadow: 'rgba(0,0,0,0.3)', markBg: '#4d4000', markFg: '#e0dfa0',
          fontFamily: "Georgia, Cambria, 'Times New Roman', Times, serif",
        },
      },
      // ── Gothic ─────────────────────────────────────────────
      gothic: {
        light: {
          bg: '#fafafa', fg: '#444444', fgMuted: '#999999', border: '#dddddd',
          bgSecondary: '#f5f5f5', bgTertiary: '#eeeeee', link: '#4183c4',
          codeBg: '#f5f5f5', preBg: '#f5f5f5',
          blockquoteBorder: '#cccccc', blockquoteBg: '#f9f9f9', blockquoteFg: '#777777',
          thBg: '#f0f0f0', shadow: 'rgba(0,0,0,0.04)', markBg: '#fff8c5', markFg: '#444444',
        },
        dark: {
          bg: '#181818', fg: '#c8c8c8', fgMuted: '#777777', border: '#333333',
          bgSecondary: '#1e1e1e', bgTertiary: '#262626', link: '#6db3f2',
          codeBg: '#1e1e1e', preBg: '#1e1e1e',
          blockquoteBorder: '#555555', blockquoteBg: '#1e1e1e', blockquoteFg: '#888888',
          thBg: '#262626', shadow: 'rgba(0,0,0,0.3)', markBg: '#504000', markFg: '#c8c8a0',
        },
      },
      // ── Dracula ────────────────────────────────────────────
      dracula: {
        light: {
          bg: '#f8f8f2', fg: '#282a36', fgMuted: '#6272a4', border: '#d6d6d6',
          bgSecondary: '#f0f0e8', bgTertiary: '#e8e8e0', link: '#7c3aed',
          codeBg: '#f0f0e8', preBg: '#f0f0e8',
          blockquoteBorder: '#bd93f9', blockquoteBg: '#f5f0ff', blockquoteFg: '#6272a4',
          thBg: '#e8e8e0', shadow: 'rgba(0,0,0,0.05)', markBg: '#ffffb5', markFg: '#282a36',
        },
        dark: {
          bg: '#282a36', fg: '#f8f8f2', fgMuted: '#6272a4', border: '#44475a',
          bgSecondary: '#21222c', bgTertiary: '#343746', link: '#8be9fd',
          codeBg: '#21222c', preBg: '#21222c',
          blockquoteBorder: '#bd93f9', blockquoteBg: '#2d2b3d', blockquoteFg: '#6272a4',
          thBg: '#343746', shadow: 'rgba(0,0,0,0.4)', markBg: '#504a00', markFg: '#f8f8d0',
        },
      },
      // ── Nord ───────────────────────────────────────────────
      nord: {
        light: {
          bg: '#eceff4', fg: '#2e3440', fgMuted: '#4c566a', border: '#d8dee9',
          bgSecondary: '#e5e9f0', bgTertiary: '#d8dee9', link: '#5e81ac',
          codeBg: '#e5e9f0', preBg: '#e5e9f0',
          blockquoteBorder: '#5e81ac', blockquoteBg: '#e5e9f0', blockquoteFg: '#4c566a',
          thBg: '#e5e9f0', shadow: 'rgba(0,0,0,0.05)', markBg: '#ebcb8b44', markFg: '#2e3440',
        },
        dark: {
          bg: '#2e3440', fg: '#eceff4', fgMuted: '#d8dee9', border: '#3b4252',
          bgSecondary: '#3b4252', bgTertiary: '#434c5e', link: '#88c0d0',
          codeBg: '#3b4252', preBg: '#3b4252',
          blockquoteBorder: '#88c0d0', blockquoteBg: '#3b4252', blockquoteFg: '#d8dee9',
          thBg: '#434c5e', shadow: 'rgba(0,0,0,0.3)', markBg: '#ebcb8b33', markFg: '#eceff4',
        },
      },
      // ── One Dark ───────────────────────────────────────────
      'one-dark': {
        light: {
          bg: '#fafafa', fg: '#383a42', fgMuted: '#a0a1a7', border: '#e0e0e0',
          bgSecondary: '#f0f0f0', bgTertiary: '#e5e5e5', link: '#4078f2',
          codeBg: '#f0f0f0', preBg: '#f0f0f0',
          blockquoteBorder: '#4078f2', blockquoteBg: '#f0f4ff', blockquoteFg: '#a0a1a7',
          thBg: '#e5e5e5', shadow: 'rgba(0,0,0,0.04)', markBg: '#e5c07b40', markFg: '#383a42',
        },
        dark: {
          bg: '#282c34', fg: '#abb2bf', fgMuted: '#5c6370', border: '#3e4451',
          bgSecondary: '#21252b', bgTertiary: '#2c313a', link: '#61afef',
          codeBg: '#21252b', preBg: '#21252b',
          blockquoteBorder: '#61afef', blockquoteBg: '#21252b', blockquoteFg: '#5c6370',
          thBg: '#2c313a', shadow: 'rgba(0,0,0,0.3)', markBg: '#e5c07b33', markFg: '#abb2bf',
        },
      },
      // ── Tokyo Night ────────────────────────────────────────
      'tokyo-night': {
        light: {
          bg: '#d5d6db', fg: '#343b59', fgMuted: '#6a6f87', border: '#c0c0d0',
          bgSecondary: '#cbced6', bgTertiary: '#c0c3cc', link: '#34548a',
          codeBg: '#cbced6', preBg: '#cbced6',
          blockquoteBorder: '#34548a', blockquoteBg: '#cbced6', blockquoteFg: '#6a6f87',
          thBg: '#c0c3cc', shadow: 'rgba(0,0,0,0.05)', markBg: '#a0804040', markFg: '#343b59',
        },
        dark: {
          bg: '#1a1b26', fg: '#a9b1d6', fgMuted: '#565f89', border: '#292e42',
          bgSecondary: '#16161e', bgTertiary: '#1f2335', link: '#7aa2f7',
          codeBg: '#16161e', preBg: '#16161e',
          blockquoteBorder: '#7aa2f7', blockquoteBg: '#16161e', blockquoteFg: '#565f89',
          thBg: '#1f2335', shadow: 'rgba(0,0,0,0.4)', markBg: '#e0af6840', markFg: '#a9b1d6',
        },
      },
      // ── Monokai ────────────────────────────────────────────
      monokai: {
        light: {
          bg: '#fafaf8', fg: '#49483e', fgMuted: '#8e8e82', border: '#e0e0d8',
          bgSecondary: '#f2f2e8', bgTertiary: '#e8e8de', link: '#0d7faa',
          codeBg: '#f2f2e8', preBg: '#f2f2e8',
          blockquoteBorder: '#669d13', blockquoteBg: '#f5f8f0', blockquoteFg: '#8e8e82',
          thBg: '#e8e8de', shadow: 'rgba(0,0,0,0.05)', markBg: '#e6db7444', markFg: '#49483e',
        },
        dark: {
          bg: '#272822', fg: '#f8f8f2', fgMuted: '#75715e', border: '#3e3d32',
          bgSecondary: '#1e1f1a', bgTertiary: '#3e3d32', link: '#66d9ef',
          codeBg: '#1e1f1a', preBg: '#1e1f1a',
          blockquoteBorder: '#a6e22e', blockquoteBg: '#1e1f1a', blockquoteFg: '#75715e',
          thBg: '#3e3d32', shadow: 'rgba(0,0,0,0.4)', markBg: '#e6db7433', markFg: '#f8f8f2',
        },
      },
      // ── Solarized ──────────────────────────────────────────
      solarized: {
        light: {
          bg: '#fdf6e3', fg: '#657b83', fgMuted: '#93a1a1', border: '#eee8d5',
          bgSecondary: '#eee8d5', bgTertiary: '#ddd6c1', link: '#268bd2',
          codeBg: '#eee8d5', preBg: '#eee8d5',
          blockquoteBorder: '#268bd2', blockquoteBg: '#eee8d5', blockquoteFg: '#93a1a1',
          thBg: '#eee8d5', shadow: 'rgba(0,0,0,0.06)', markBg: '#b5890060', markFg: '#657b83',
        },
        dark: {
          bg: '#002b36', fg: '#839496', fgMuted: '#586e75', border: '#073642',
          bgSecondary: '#073642', bgTertiary: '#0a4756', link: '#268bd2',
          codeBg: '#073642', preBg: '#073642',
          blockquoteBorder: '#268bd2', blockquoteBg: '#073642', blockquoteFg: '#586e75',
          thBg: '#073642', shadow: 'rgba(0,0,0,0.3)', markBg: '#b5890040', markFg: '#93a1a1',
        },
      },
    };

    // Generate CSS variable blocks for each theme
    const varsBlock = (c: ThemeColors): string =>
      `--bg:${c.bg};--fg:${c.fg};--fg-muted:${c.fgMuted};--border:${c.border};` +
      `--bg-secondary:${c.bgSecondary};--bg-tertiary:${c.bgTertiary};--link:${c.link};` +
      `--code-bg:${c.codeBg};--pre-bg:${c.preBg};` +
      `--blockquote-border:${c.blockquoteBorder};--blockquote-bg:${c.blockquoteBg};--blockquote-fg:${c.blockquoteFg};` +
      `--th-bg:${c.thBg};--shadow:${c.shadow};--mark-bg:${c.markBg};--mark-fg:${c.markFg};` +
      (c.fontFamily ? `--font-family:${c.fontFamily};` : '');

    let css = '';

    for (const [name, { light, dark }] of Object.entries(themes)) {
      // Light selectors: default theme (github) also applies to :root as fallback
      const lightSel = name === 'github'
        ? `:root, [data-preview-theme="github"]`
        : `[data-preview-theme="${name}"]`;

      // Dark selectors: default theme also catches bare [data-theme="dark"] / .vscode-dark
      const darkSel = name === 'github'
        ? `[data-theme="dark"], body.vscode-dark, [data-preview-theme="github"][data-theme="dark"], [data-preview-theme="github"].vscode-dark`
        : `[data-preview-theme="${name}"][data-theme="dark"], [data-preview-theme="${name}"].vscode-dark`;

      // System dark selectors
      const sysDarkSel = name === 'github'
        ? `[data-theme="system"], [data-preview-theme="github"][data-theme="system"]`
        : `[data-preview-theme="${name}"][data-theme="system"]`;

      css += `${lightSel}{${varsBlock(light)}}`;
      css += `${darkSel}{${varsBlock(dark)}}`;
      css += `@media(prefers-color-scheme:dark){${sysDarkSel}{${varsBlock(dark)}}}`;
    }

    // Shiki dual-theme: activate light or dark token colors
    css += `
      .shiki { background-color: var(--shiki-light-bg) !important; }
      .shiki span { color: var(--shiki-light); }
      [data-theme="dark"] .shiki,
      body.vscode-dark .shiki { background-color: var(--shiki-dark-bg) !important; }
      [data-theme="dark"] .shiki span,
      body.vscode-dark .shiki span { color: var(--shiki-dark); }
      @media (prefers-color-scheme: dark) {
        [data-theme="system"] .shiki { background-color: var(--shiki-dark-bg) !important; }
        [data-theme="system"] .shiki span { color: var(--shiki-dark); }
      }
    `;

    return css;
  }

  /**
   * Get SVG icon for a callout type.
   */
  private static getCalloutIcon(type: string): string {
    const icons: Record<string, string> = {
      note: '&#9998;', // ✎ pencil
      info: '&#8505;', // ℹ info
      tip: '&#128161;', // 💡 lightbulb
      success: '&#10004;', // ✔ check
      warning: '&#9888;', // ⚠ warning
      caution: '&#9888;', // ⚠ warning
      important: '&#10071;', // ❗ exclamation
      danger: '&#9889;', // ⚡ zap
      failure: '&#10008;', // ✘ cross
      question: '&#10067;', // ❓ question
      bug: '&#128027;', // 🐛 bug
      example: '&#128196;', // 📄 document
      quote: '&#10078;', // ❞ quote
      abstract: '&#128203;', // 📋 clipboard
      todo: '&#9744;', // ☐ checkbox
    };
    return icons[type] || icons.note;
  }

  /**
   * Process Obsidian-style callouts in rendered HTML.
   * Transforms `<blockquote><p>[!type] title</p>` into styled callout blocks.
   */
  private processCallouts(html: string): string {
    // Match blockquote whose first <p> starts with [!type]
    return html.replace(
      /<blockquote([^>]*)>\s*<p>\[!(\w+)\]\s*(.*?)<\/p>/gi,
      (_match, attrs, type, titleContent) => {
        const normalizedType = type.toLowerCase();
        const icon = MarkdownEngine.getCalloutIcon(normalizedType);
        const title =
          titleContent.trim() ||
          normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1);
        return `<blockquote${attrs} class="callout callout-${normalizedType}"><p><strong class="callout-title"><span class="callout-icon">${icon}</span> ${title}</strong></p>`;
      },
    );
  }

  /**
   * Resolve relative image paths in rendered HTML to data URIs.
   * Standard markdown ![alt](relative/path.png) renders as <img src="relative/path.png">
   * which doesn't work in VS Code webview. This converts them to data URIs.
   */
  private resolveImagePaths(html: string, fileDirectoryPath: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.apng': 'image/apng',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
    };

    return html.replace(
      /<img\s([^>]*?)src="([^"]+)"([^>]*?)>/g,
      (match, before, src, after) => {
        // Skip absolute URLs, data URIs, and protocol-relative URLs
        if (/^(https?:\/\/|data:|\/\/)/.test(src)) {
          return match;
        }

        const ext = path.extname(src).toLowerCase();
        if (!MarkdownEngine.IMAGE_EXTENSIONS.has(ext)) {
          return match;
        }

        const resolvedPath = path.isAbsolute(src)
          ? src
          : path.resolve(fileDirectoryPath, src);

        try {
          if (!fs.existsSync(resolvedPath)) {
            return match;
          }

          const mime = mimeTypes[ext] || 'application/octet-stream';
          let dataUri: string;
          if (ext === '.svg') {
            const svgContent = fs.readFileSync(resolvedPath, 'utf-8');
            dataUri = `data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}`;
          } else {
            const imageBuffer = fs.readFileSync(resolvedPath);
            dataUri = `data:${mime};base64,${imageBuffer.toString('base64')}`;
          }

          return `<img ${before}src="${dataUri}"${after}>`;
        } catch {
          return match;
        }
      },
    );
  }

  private escapeHtml(text: string): string {
    const htmlEntities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return text.replace(/[&<>"']/g, (char) => htmlEntities[char]);
  }

  /**
   * Unescape HTML entities
   */
  private unescapeHtml(text: string): string {
    const htmlEntities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
    };
    return text.replace(
      /&(?:amp|lt|gt|quot|#39);/g,
      (entity) => htmlEntities[entity] || entity,
    );
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.caches.clear();
  }

  /**
   * Update configuration
   */
  updateConfig(configOverrides: Partial<MarkdownLivePreviewConfig>): void {
    this.config = { ...this.config, ...configOverrides };
    this.parser.updateConfig(this.config);
  }
}

// Engine cache per file
const engineCache: Map<string, MarkdownEngine> = new Map();

/**
 * Get or create a markdown engine for a file
 */
export function getMarkdownEngine(filePath: string): MarkdownEngine {
  let engine = engineCache.get(filePath);
  if (!engine) {
    engine = new MarkdownEngine();
    engineCache.set(filePath, engine);
  }
  return engine;
}

/**
 * Clear all engine caches
 */
export function clearAllEngineCaches(): void {
  engineCache.forEach((engine) => engine.clearCaches());
  engineCache.clear();
}
