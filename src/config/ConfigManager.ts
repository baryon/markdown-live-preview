/**
 * Configuration manager for markdown-live-preview
 * Handles reading and updating VS Code configuration settings
 */

import * as vscode from 'vscode';
import type {
  CodeBlockTheme,
  FrontMatterRenderingOption,
  MarkdownLivePreviewConfig,
  MathRenderingOption,
  MermaidTheme,
  PreviewColorScheme,
  PreviewMode,
  PreviewTheme,
  RevealJsTheme,
  WikiLinkTargetFileNameChangeCase,
} from '../types';
import { defaultConfig } from './defaults';

const CONFIG_SECTION = 'markdown-live-preview';

/**
 * Get a configuration value from VS Code settings
 */
export function getConfig<T>(key: string): T | undefined {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<T>(key);
}

/**
 * Update a configuration value in VS Code settings
 */
export async function updateConfig<T>(
  key: string,
  value: T,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(key, value, target);
}

/**
 * Get the complete configuration object
 */
export function getFullConfig(): MarkdownLivePreviewConfig {
  return {
    preview: {
      mode: getConfig<PreviewMode>('previewMode') ?? defaultConfig.preview.mode,
      colorScheme:
        getConfig<PreviewColorScheme>('previewColorScheme') ??
        defaultConfig.preview.colorScheme,
      theme:
        getConfig<PreviewTheme>('previewTheme') ?? defaultConfig.preview.theme,
      scrollSync:
        getConfig<boolean>('scrollSync') ?? defaultConfig.preview.scrollSync,
      liveUpdate:
        getConfig<boolean>('liveUpdate') ?? defaultConfig.preview.liveUpdate,
      liveUpdateDebounceMs:
        getConfig<number>('liveUpdateDebounceMs') ??
        defaultConfig.preview.liveUpdateDebounceMs,
      automaticallyShowPreview:
        getConfig<boolean>('automaticallyShowPreviewOfMarkdownBeingEdited') ??
        defaultConfig.preview.automaticallyShowPreview,
      disableAutoPreviewForUriSchemes:
        getConfig<string[]>('disableAutoPreviewForUriSchemes') ??
        defaultConfig.preview.disableAutoPreviewForUriSchemes,
      zenMode:
        getConfig<boolean>('enablePreviewZenMode') ??
        defaultConfig.preview.zenMode,
      showPageToolbar:
        getConfig<boolean>('showPageToolbar') ??
        defaultConfig.preview.showPageToolbar,
    },

    theme: {
      codeBlock:
        getConfig<CodeBlockTheme>('codeBlockTheme') ??
        defaultConfig.theme.codeBlock,
      mermaid:
        getConfig<MermaidTheme>('mermaidTheme') ?? defaultConfig.theme.mermaid,
      revealjs:
        getConfig<RevealJsTheme>('revealjsTheme') ??
        defaultConfig.theme.revealjs,
    },

    markdown: {
      breakOnSingleNewLine:
        getConfig<boolean>('breakOnSingleNewLine') ??
        defaultConfig.markdown.breakOnSingleNewLine,
      enableTypographer:
        getConfig<boolean>('enableTypographer') ??
        defaultConfig.markdown.enableTypographer,
      enableLinkify:
        getConfig<boolean>('enableLinkify') ??
        defaultConfig.markdown.enableLinkify,
      enableEmojiSyntax:
        getConfig<boolean>('enableEmojiSyntax') ??
        defaultConfig.markdown.enableEmojiSyntax,
      frontMatterRenderingOption:
        getConfig<FrontMatterRenderingOption>('frontMatterRenderingOption') ??
        defaultConfig.markdown.frontMatterRenderingOption,
    },

    math: {
      renderingOption:
        getConfig<MathRenderingOption>('mathRenderingOption') ??
        defaultConfig.math.renderingOption,
      inlineDelimiters:
        getConfig<string[][]>('mathInlineDelimiters') ??
        defaultConfig.math.inlineDelimiters,
      blockDelimiters:
        getConfig<string[][]>('mathBlockDelimiters') ??
        defaultConfig.math.blockDelimiters,
      mathjaxV3ScriptSrc:
        getConfig<string>('mathjaxV3ScriptSrc') ??
        defaultConfig.math.mathjaxV3ScriptSrc,
    },

    wikiLink: {
      enabled:
        getConfig<boolean>('enableWikiLinkSyntax') ??
        defaultConfig.wikiLink.enabled,
      useGitHubStylePipedLink:
        getConfig<boolean>('useGitHubStylePipedLink') ??
        defaultConfig.wikiLink.useGitHubStylePipedLink,
      targetFileExtension:
        getConfig<string>('wikiLinkTargetFileExtension') ??
        defaultConfig.wikiLink.targetFileExtension,
      targetFileNameChangeCase:
        getConfig<WikiLinkTargetFileNameChangeCase>(
          'wikiLinkTargetFileNameChangeCase',
        ) ?? defaultConfig.wikiLink.targetFileNameChangeCase,
    },

    mermaid: {
      enabled: true, // Mermaid is always enabled
      theme:
        getConfig<MermaidTheme>('mermaidTheme') ?? defaultConfig.mermaid.theme,
      asciiMode:
        getConfig<boolean>('mermaidAsciiMode') ??
        defaultConfig.mermaid.asciiMode,
    },

    image: {
      folderPath:
        getConfig<string>('imageFolderPath') ?? defaultConfig.image.folderPath,
    },

    misc: {
      jsdelivrCdnHost:
        getConfig<string>('jsdelivrCdnHost') ??
        defaultConfig.misc.jsdelivrCdnHost,
      hideDefaultVSCodeMarkdownPreviewButtons:
        getConfig<boolean>('hideDefaultVSCodeMarkdownPreviewButtons') ??
        defaultConfig.misc.hideDefaultVSCodeMarkdownPreviewButtons,
      markdownFileExtensions:
        getConfig<string[]>('markdownFileExtensions') ??
        defaultConfig.misc.markdownFileExtensions,
      configPath:
        getConfig<string>('configPath') ?? defaultConfig.misc.configPath,
    },

    codeChunk: {
      enableScriptExecution:
        getConfig<boolean>('enableScriptExecution') ??
        defaultConfig.codeChunk.enableScriptExecution,
      defaultShell:
        getConfig<string>('codeChunkDefaultShell') ??
        defaultConfig.codeChunk.defaultShell,
      latexEngine:
        getConfig<string>('latexEngine') ?? defaultConfig.codeChunk.latexEngine,
      executionTimeout:
        getConfig<number>('codeChunkExecutionTimeout') ??
        defaultConfig.codeChunk.executionTimeout,
    },
  };
}

/**
 * Shorthand for getting MLP config
 */
export function getMLPConfig<T>(key: string): T | undefined {
  return getConfig<T>(key);
}

/**
 * Shorthand for updating MLP config
 */
export async function updateMLPConfig<T>(
  key: string,
  value: T,
  target?: vscode.ConfigurationTarget | boolean,
): Promise<void> {
  let configTarget: vscode.ConfigurationTarget;
  if (typeof target === 'boolean') {
    configTarget = target
      ? vscode.ConfigurationTarget.Global
      : vscode.ConfigurationTarget.Workspace;
  } else {
    configTarget = target ?? vscode.ConfigurationTarget.Global;
  }
  await updateConfig(key, value, configTarget);
}
