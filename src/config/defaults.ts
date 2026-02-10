/**
 * Default configuration values for markdown-live-preview
 */

import {
  type CodeBlockTheme,
  FrontMatterRenderingOption,
  type MarkdownLivePreviewConfig,
  MathRenderingOption,
  type MermaidTheme,
  PreviewColorScheme,
  PreviewMode,
  type PreviewTheme,
  type RevealJsTheme,
  type WikiLinkTargetFileNameChangeCase,
} from '../types';

export const defaultConfig: MarkdownLivePreviewConfig = {
  preview: {
    mode: PreviewMode.SinglePreview,
    colorScheme: PreviewColorScheme.selectedPreviewTheme,
    theme: 'github' as PreviewTheme,
    scrollSync: true,
    liveUpdate: true,
    liveUpdateDebounceMs: 300,
    automaticallyShowPreview: false,
    disableAutoPreviewForUriSchemes: ['vscode-notebook-cell'],
    zenMode: true,
    showPageToolbar: false,
  },

  theme: {
    codeBlock: 'auto' as CodeBlockTheme,
    mermaid: 'github-light' as MermaidTheme,
    revealjs: 'white.css' as RevealJsTheme,
  },

  markdown: {
    breakOnSingleNewLine: true,
    enableTypographer: false,
    enableLinkify: true,
    enableEmojiSyntax: true,
    frontMatterRenderingOption: FrontMatterRenderingOption.none,
  },

  math: {
    renderingOption: MathRenderingOption.KaTeX,
    inlineDelimiters: [
      ['$', '$'],
      ['\\(', '\\)'],
    ],
    blockDelimiters: [
      ['$$', '$$'],
      ['\\[', '\\]'],
    ],
    mathjaxV3ScriptSrc:
      'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js',
  },

  wikiLink: {
    enabled: true,
    useGitHubStylePipedLink: false,
    targetFileExtension: '.md',
    targetFileNameChangeCase: 'none' as WikiLinkTargetFileNameChangeCase,
  },

  mermaid: {
    enabled: true,
    theme: 'github-light' as MermaidTheme,
    asciiMode: false,
  },

  image: {
    folderPath: '/assets',
  },

  misc: {
    jsdelivrCdnHost: 'cdn.jsdelivr.net',
    hideDefaultVSCodeMarkdownPreviewButtons: true,
    markdownFileExtensions: [
      '.md',
      '.markdown',
      '.mdown',
      '.mkdn',
      '.mkd',
      '.rmd',
      '.qmd',
      '.mdx',
    ],
    configPath: '',
  },

  codeChunk: {
    enableScriptExecution: false,
    defaultShell: '',
    latexEngine: 'pdflatex',
    executionTimeout: 30000,
  },
};
