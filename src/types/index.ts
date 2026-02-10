/**
 * Type definitions for markdown-live-preview
 */

// Preview modes
export enum PreviewMode {
  SinglePreview = 'Single Preview',
  MultiplePreviews = 'Multiple Previews',
  PreviewsOnly = 'Previews Only',
}

// Preview color scheme options
export enum PreviewColorScheme {
  selectedPreviewTheme = 'selectedPreviewTheme',
  systemColorScheme = 'systemColorScheme',
  editorColorScheme = 'editorColorScheme',
}

// Math rendering options
export enum MathRenderingOption {
  KaTeX = 'KaTeX',
  MathJax = 'MathJax',
  None = 'None',
}

// Front matter rendering options
export enum FrontMatterRenderingOption {
  none = 'none',
  table = 'table',
  codeBlock = 'code block',
}

// Preview theme type
export type PreviewTheme =
  | 'github'
  | 'obsidian'
  | 'vue'
  | 'lark'
  | 'smartblue'
  | 'medium'
  | 'gothic'
  | 'dracula'
  | 'nord'
  | 'one-dark'
  | 'tokyo-night'
  | 'monokai'
  | 'solarized';

// Code block theme type (Shiki themes)
export type CodeBlockTheme =
  | 'auto'
  | 'github-dark'
  | 'github-light'
  | 'monokai'
  | 'one-dark-pro'
  | 'dracula'
  | 'nord'
  | 'material-theme-darker'
  | 'material-theme-lighter'
  | 'solarized-dark'
  | 'solarized-light'
  | 'vitesse-dark'
  | 'vitesse-light';

// Mermaid theme type (beautiful-mermaid themes)
export type MermaidTheme =
  | 'zinc-light'
  | 'zinc-dark'
  | 'tokyo-night'
  | 'tokyo-night-storm'
  | 'tokyo-night-light'
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'nord'
  | 'nord-light'
  | 'dracula'
  | 'github-light'
  | 'github-dark'
  | 'solarized-light'
  | 'solarized-dark'
  | 'one-dark';

// Reveal.js theme type
export type RevealJsTheme =
  | 'beige.css'
  | 'black.css'
  | 'blood.css'
  | 'league.css'
  | 'moon.css'
  | 'night.css'
  | 'serif.css'
  | 'simple.css'
  | 'sky.css'
  | 'solarized.css'
  | 'white.css'
  | 'none.css';

// Wiki link target file name case change options
export type WikiLinkTargetFileNameChangeCase =
  | 'none'
  | 'camelCase'
  | 'pascalCase'
  | 'kebabCase'
  | 'snakeCase'
  | 'constantCase'
  | 'lowerCase'
  | 'upperCase';

// Main configuration interface
export interface MarkdownLivePreviewConfig {
  preview: {
    mode: PreviewMode;
    colorScheme: PreviewColorScheme;
    theme: PreviewTheme;
    scrollSync: boolean;
    liveUpdate: boolean;
    liveUpdateDebounceMs: number;
    automaticallyShowPreview: boolean;
    disableAutoPreviewForUriSchemes: string[];
    zenMode: boolean;
    showPageToolbar: boolean;
  };

  theme: {
    codeBlock: CodeBlockTheme;
    mermaid: MermaidTheme;
    revealjs: RevealJsTheme;
  };

  markdown: {
    breakOnSingleNewLine: boolean;
    enableTypographer: boolean;
    enableLinkify: boolean;
    enableEmojiSyntax: boolean;
    frontMatterRenderingOption: FrontMatterRenderingOption;
  };

  math: {
    renderingOption: MathRenderingOption;
    inlineDelimiters: string[][];
    blockDelimiters: string[][];
    mathjaxV3ScriptSrc: string;
  };

  wikiLink: {
    enabled: boolean;
    useGitHubStylePipedLink: boolean;
    targetFileExtension: string;
    targetFileNameChangeCase: WikiLinkTargetFileNameChangeCase;
  };

  mermaid: {
    enabled: boolean;
    theme: MermaidTheme;
    asciiMode: boolean;
  };

  image: {
    folderPath: string;
  };

  misc: {
    jsdelivrCdnHost: string;
    hideDefaultVSCodeMarkdownPreviewButtons: boolean;
    markdownFileExtensions: string[];
    configPath: string;
  };

  codeChunk: {
    enableScriptExecution: boolean;
    defaultShell: string;
    latexEngine: string;
    executionTimeout: number;
  };
}

// Parsed markdown result
export interface ParsedMarkdownResult {
  html: string;
  tocHTML: string;
  frontMatter?: Record<string, unknown>;
  slideConfigs?: SlideConfig[];
}

// Slide configuration for presentations
export interface SlideConfig {
  [key: string]: unknown;
}

// Preview message types for webview communication
export interface PreviewMessage {
  command: string;
  [key: string]: unknown;
}

// Scroll sync data
export interface ScrollSyncData {
  line: number;
  topRatio?: number;
  forced?: boolean;
}

// File system API interface
export interface FileSystemApi {
  exists(path: string): Promise<boolean>;
  readFile(path: string, encoding?: BufferEncoding): Promise<string>;
  writeFile(
    path: string,
    data: string,
    encoding?: BufferEncoding,
  ): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileSystemStats>;
  unlink(path: string): Promise<void>;
}

// File system stats
export interface FileSystemStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

// Renderer options
export interface RendererOptions {
  isForPreview?: boolean;
  useRelativeFilePath?: boolean;
  hideFrontMatter?: boolean;
  triggeredBySave?: boolean;
  sourceUri?: string;
}

// KaTeX options
export interface KatexOptions {
  displayMode?: boolean;
  throwOnError?: boolean;
  errorColor?: string;
  macros?: Record<string, string>;
  trust?: boolean;
  strict?: boolean | string;
  maxSize?: number;
  maxExpand?: number;
}

// Code chunk output format
export type CodeChunkOutputFormat =
  | 'text'
  | 'html'
  | 'markdown'
  | 'png'
  | 'none';

// Code chunk execution status
export type CodeChunkStatus = 'idle' | 'running' | 'success' | 'error';

// Code chunk attributes parsed from info string
export interface CodeChunkAttributes {
  cmd: string | boolean;
  output: CodeChunkOutputFormat;
  args: string[];
  stdin: boolean;
  hide: boolean;
  continue: string | boolean;
  id: string;
  class: string;
  element: string;
  run_on_save: boolean;
  modify_source: boolean;
  matplotlib: boolean;
  latex_zoom: number;
  latex_width: string;
  latex_height: string;
  latex_engine: string;
}

// Code chunk data
export interface CodeChunk {
  id: string;
  language: string;
  code: string;
  attrs: CodeChunkAttributes;
  line: number;
  result: string;
  status: CodeChunkStatus;
  running: boolean;
  error: string;
}

// Mermaid configuration
export interface MermaidConfig {
  startOnLoad?: boolean;
  theme?: string;
  securityLevel?: 'strict' | 'loose' | 'antiscript' | 'sandbox';
  [key: string]: unknown;
}
