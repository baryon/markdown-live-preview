/**
 * KaTeX renderer for math expressions
 */

import katex from 'katex';
import { getFullConfig } from '../../config/ConfigManager';
import { type KatexOptions, MathRenderingOption } from '../../types';

export interface MathRenderResult {
  html: string;
  error?: string;
}

export class KatexRenderer {
  private defaultOptions: Partial<KatexOptions> = {
    throwOnError: false,
    errorColor: '#cc0000',
    trust: false,
    strict: 'ignore' as const,
    maxSize: 500,
    maxExpand: 1000,
  };

  /**
   * Render a math expression to HTML
   */
  render(
    expression: string,
    displayMode: boolean = false,
    options?: Partial<KatexOptions>,
  ): MathRenderResult {
    const config = getFullConfig();

    // Check if math rendering is disabled
    if (config.math.renderingOption === MathRenderingOption.None) {
      return { html: this.escapeHtml(expression) };
    }

    // Check if MathJax is preferred
    if (config.math.renderingOption === MathRenderingOption.MathJax) {
      return this.renderForMathJax(expression, displayMode);
    }

    try {
      const katexOptions = {
        ...this.defaultOptions,
        ...options,
        displayMode,
      };

      const html = katex.renderToString(
        expression,
        katexOptions as katex.KatexOptions,
      );
      return { html };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.warn('KaTeX rendering error:', errorMessage);

      // Return error message in red
      return {
        html: `<span class="katex-error" style="color: ${
          this.defaultOptions.errorColor
        };">${this.escapeHtml(expression)}</span>`,
        error: errorMessage,
      };
    }
  }

  /**
   * Render inline math expression
   */
  renderInline(
    expression: string,
    options?: Partial<KatexOptions>,
  ): MathRenderResult {
    return this.render(expression, false, options);
  }

  /**
   * Render block (display) math expression
   */
  renderBlock(
    expression: string,
    options?: Partial<KatexOptions>,
  ): MathRenderResult {
    return this.render(expression, true, options);
  }

  /**
   * Process markdown content and replace math expressions with rendered HTML
   */
  processMathInContent(content: string): string {
    const config = getFullConfig();

    if (config.math.renderingOption === MathRenderingOption.None) {
      return content;
    }

    let result = content;

    // Process block math first (to avoid conflicts with inline)
    for (const [start, end] of config.math.blockDelimiters) {
      result = this.processMathDelimiters(result, start, end, true);
    }

    // Process inline math
    for (const [start, end] of config.math.inlineDelimiters) {
      result = this.processMathDelimiters(result, start, end, false);
    }

    return result;
  }

  /**
   * Process math expressions with specific delimiters
   */
  private processMathDelimiters(
    content: string,
    startDelimiter: string,
    endDelimiter: string,
    displayMode: boolean,
  ): string {
    const escapedStart = this.escapeRegex(startDelimiter);
    const escapedEnd = this.escapeRegex(endDelimiter);

    // Create regex pattern
    // For single $ delimiter, be more careful to avoid false positives
    let pattern: RegExp;
    if (startDelimiter === '$' && endDelimiter === '$') {
      // Don't match $$ (that's for block math)
      // Don't match $ followed by whitespace or at start of line
      // Don't match $ preceded by \ (escaped)
      pattern = /(?<!\\)(?<!\$)\$(?!\$)(.+?)(?<!\\)\$(?!\$)/g;
    } else if (startDelimiter === '$$' && endDelimiter === '$$') {
      pattern = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g;
    } else {
      pattern = new RegExp(`${escapedStart}([\\s\\S]+?)${escapedEnd}`, 'g');
    }

    return content.replace(pattern, (_, expression: string) => {
      const trimmedExpression = expression.trim();
      const result = this.render(trimmedExpression, displayMode);

      if (displayMode) {
        // Block math with control panel
        const escapedSource = this.escapeHtmlAttribute(trimmedExpression);
        return (
          `<div class="math-container">` +
          `<div class="math-controls">` +
          `<button class="math-toggle-btn" title="Toggle controls">⋯</button>` +
          `<div class="math-controls-expanded">` +
          `<button class="math-copy-source-btn" title="Copy LaTeX">TeX</button>` +
          `<button class="math-copy-png-btn" title="Copy as PNG">PNG</button>` +
          `</div>` +
          `</div>` +
          `<div class="math-block" data-source="${escapedSource}">${result.html}</div>` +
          `</div>`
        );
      } else {
        return `<span class="math-inline">${result.html}</span>`;
      }
    });
  }

  /**
   * Render content for MathJax (just wrap in appropriate delimiters)
   */
  private renderForMathJax(
    expression: string,
    displayMode: boolean,
  ): MathRenderResult {
    if (displayMode) {
      return { html: `\\[${expression}\\]` };
    } else {
      return { html: `\\(${expression}\\)` };
    }
  }

  /**
   * Escape HTML entities
   */
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
   * Escape text for use in HTML attributes (handles newlines too)
   */
  private escapeHtmlAttribute(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\n/g, '&#10;')
      .replace(/\r/g, '&#13;');
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get the CSS needed for KaTeX rendering
   */
  static getCss(): string {
    return `
      .katex-error {
        color: #cc0000;
        font-family: monospace;
      }
      .math-container {
        position: relative;
        margin: 1em 0;
      }
      .math-block {
        display: block;
        text-align: center;
        overflow-x: auto;
      }
      .math-inline {
        display: inline;
      }
      .math-controls {
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
      .math-container:hover .math-controls {
        opacity: 1;
        pointer-events: auto;
      }
      .math-toggle-btn {
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
      .math-toggle-btn:hover {
        background: var(--bg-secondary);
        color: var(--fg);
      }
      .math-controls.expanded .math-toggle-btn {
        display: none;
      }
      .math-controls-expanded {
        display: none;
        gap: 4px;
        align-items: center;
      }
      .math-controls.expanded .math-controls-expanded {
        display: flex;
      }
      .math-copy-source-btn,
      .math-copy-png-btn {
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
      .math-copy-source-btn:hover,
      .math-copy-png-btn:hover {
        background: var(--bg-secondary);
      }
    `;
  }

  /**
   * Get the CDN URL for KaTeX CSS
   */
  static getCssUrl(): string {
    return 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css';
  }
}

// Singleton instance
let katexRenderer: KatexRenderer | null = null;

export function getKatexRenderer(): KatexRenderer {
  if (!katexRenderer) {
    katexRenderer = new KatexRenderer();
  }
  return katexRenderer;
}
