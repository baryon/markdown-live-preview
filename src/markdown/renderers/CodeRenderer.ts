/**
 * Code block renderer using Shiki for syntax highlighting
 */

import {
  type BundledLanguage,
  type BundledTheme,
  createHighlighter,
  type Highlighter,
} from 'shiki';
import { getFullConfig } from '../../config/ConfigManager';
import type { CodeBlockTheme } from '../../types';

// Map code block themes to Shiki themes
const themeMap: Record<string, BundledTheme> = {
  'auto.css': 'github-light',
  'default.css': 'github-light',
  'atom-dark.css': 'one-dark-pro',
  'atom-light.css': 'one-light',
  'atom-material.css': 'material-theme',
  'darcula.css': 'dracula',
  'dark.css': 'dark-plus',
  'github.css': 'github-light',
  'github-dark.css': 'github-dark',
  'monokai.css': 'monokai',
  'one-dark.css': 'one-dark-pro',
  'one-light.css': 'one-light',
  'solarized-dark.css': 'solarized-dark',
  'solarized-light.css': 'solarized-light',
  'vs.css': 'light-plus',
  'nord.css': 'nord',
};

// Common languages to preload
const commonLanguages: BundledLanguage[] = [
  'javascript',
  'typescript',
  'python',
  'java',
  'c',
  'cpp',
  'csharp',
  'go',
  'rust',
  'ruby',
  'php',
  'swift',
  'kotlin',
  'html',
  'css',
  'scss',
  'json',
  'yaml',
  'markdown',
  'bash',
  'shell',
  'sql',
  'xml',
  'jsx',
  'tsx',
];

export class CodeRenderer {
  private highlighter: Highlighter | null = null;
  private initPromise: Promise<void> | null = null;
  private currentTheme: BundledTheme = 'github-light';

  constructor() {
    this.initPromise = this.init();
  }

  /**
   * Initialize the Shiki highlighter
   */
  private async init(): Promise<void> {
    const config = getFullConfig();
    this.currentTheme = this.getShikiTheme(config.theme.codeBlock);

    try {
      this.highlighter = await createHighlighter({
        themes: [this.currentTheme, 'github-light', 'github-dark'],
        langs: commonLanguages,
      });
    } catch (error) {
      console.error('Failed to initialize Shiki highlighter:', error);
    }
  }

  /**
   * Ensure the highlighter is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Get Shiki theme from code block theme setting
   */
  private getShikiTheme(codeBlockTheme: CodeBlockTheme): BundledTheme {
    return themeMap[codeBlockTheme] || 'github-light';
  }

  /**
   * Highlight code with the given language
   */
  async highlight(code: string, language: string): Promise<string> {
    await this.ensureInitialized();

    if (!this.highlighter) {
      // Fallback to pre/code without highlighting
      return this.createFallbackCodeBlock(code, language);
    }

    try {
      // Normalize language name
      const normalizedLang = this.normalizeLanguage(language);

      // Check if language is loaded, if not load it
      const loadedLangs = this.highlighter.getLoadedLanguages();
      if (!loadedLangs.includes(normalizedLang as BundledLanguage)) {
        try {
          await this.highlighter.loadLanguage(
            normalizedLang as BundledLanguage,
          );
        } catch {
          // Language not supported, use plain text
          return this.createFallbackCodeBlock(code, language);
        }
      }

      const html = this.highlighter.codeToHtml(code, {
        lang: normalizedLang as BundledLanguage,
        themes: {
          light: 'github-light',
          dark: 'github-dark',
        },
        defaultColor: false,
      });

      return this.addLineNumbers(html, language);
    } catch (error) {
      console.error('Failed to highlight code:', error);
      return this.createFallbackCodeBlock(code, language);
    }
  }

  /**
   * Create a fallback code block without highlighting, with line numbers
   */
  private createFallbackCodeBlock(code: string, language: string): string {
    const lines = code.split('\n');
    // Remove trailing empty line that fenced code blocks often have
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const langClass = language ? ` language-${this.escapeHtml(language)}` : '';
    const langAttr = language
      ? ` data-lang="${this.escapeHtml(language)}"`
      : '';
    const lineHtml = lines
      .map(
        (line, i) =>
          `<span class="code-line"><span class="line-number">${
            i + 1
          }</span><span class="line-content">${this.escapeHtml(
            line,
          )}</span></span>`,
      )
      .join('\n');
    return `<pre class="code-block-with-line-numbers${langClass}"${langAttr}><code>${lineHtml}</code></pre>`;
  }

  /**
   * Add line numbers to Shiki-highlighted HTML.
   * Shiki outputs <pre ...><code><span class="line">...</span></code></pre>.
   * We inject line-number spans into each .line.
   */
  private addLineNumbers(html: string, language?: string): string {
    let lineNum = 0;
    // Insert a line-number span at the start of each Shiki .line span
    const result = html.replace(/(<span class="line">)/g, () => {
      lineNum++;
      return `<span class="line"><span class="line-number">${lineNum}</span>`;
    });
    // Add data-line-numbers and data-lang attributes to the <pre> for styling and context menu
    const langAttr = language
      ? ` data-lang="${this.escapeHtml(language)}"`
      : '';
    return result.replace(/^<pre /, `<pre data-line-numbers${langAttr} `);
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
   * Normalize language name for Shiki
   */
  private normalizeLanguage(lang: string): string {
    const langMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'rb': 'ruby',
      'sh': 'bash',
      'zsh': 'bash',
      'yml': 'yaml',
      'md': 'markdown',
      'cs': 'csharp',
      'c++': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'objective-c': 'objc',
      'objc': 'objective-c',
    };

    const normalized = lang.toLowerCase().trim();
    return langMap[normalized] || normalized;
  }

  /**
   * Update the theme
   */
  async updateTheme(codeBlockTheme: CodeBlockTheme): Promise<void> {
    await this.ensureInitialized();

    const newTheme = this.getShikiTheme(codeBlockTheme);
    if (newTheme !== this.currentTheme && this.highlighter) {
      const loadedThemes = this.highlighter.getLoadedThemes();
      if (!loadedThemes.includes(newTheme)) {
        try {
          await this.highlighter.loadTheme(newTheme);
        } catch (error) {
          console.error('Failed to load theme:', error);
        }
      }
      this.currentTheme = newTheme;
    }
  }

  /**
   * Get supported languages
   */
  async getSupportedLanguages(): Promise<string[]> {
    await this.ensureInitialized();
    return this.highlighter ? this.highlighter.getLoadedLanguages() : [];
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    if (this.highlighter) {
      this.highlighter.dispose();
      this.highlighter = null;
    }
  }
}

// Singleton instance
let codeRenderer: CodeRenderer | null = null;

export function getCodeRenderer(): CodeRenderer {
  if (!codeRenderer) {
    codeRenderer = new CodeRenderer();
  }
  return codeRenderer;
}
