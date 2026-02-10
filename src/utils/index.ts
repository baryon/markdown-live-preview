/**
 * Utility functions for markdown-live-preview
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getMLPConfig } from '../config/ConfigManager';
import { PreviewMode } from '../types';

export * from './debounce';

/**
 * Get the workspace folder URI for a given URI
 */
export function getWorkspaceFolderUri(uri: vscode.Uri): vscode.Uri {
  const workspace = vscode.workspace.getWorkspaceFolder(uri);
  if (workspace) {
    return workspace.uri;
  }

  const workspaces = vscode.workspace.workspaceFolders;
  if (workspaces) {
    for (let i = 0; i < workspaces.length; i++) {
      const workspace = workspaces[i];
      if (uri.fsPath.startsWith(workspace.uri.fsPath)) {
        return workspace.uri;
      }
    }
  }

  // Return the folder of uri
  return vscode.Uri.file(path.dirname(uri.fsPath));
}

/**
 * Get the global config path
 */
function getGlobalConfigPath(): string {
  const configPath = getMLPConfig<string>('configPath');
  if (typeof configPath === 'string' && configPath && configPath !== '') {
    return configPath.replace(/^~/, os.homedir());
  }

  if (process.platform === 'win32') {
    return path.join(os.homedir(), './.markdown-live-preview');
  } else {
    if (
      typeof process.env.XDG_CONFIG_HOME === 'string' &&
      process.env.XDG_CONFIG_HOME !== ''
    ) {
      return path.resolve(
        process.env.XDG_CONFIG_HOME,
        './markdown-live-preview',
      );
    } else {
      return path.resolve(os.homedir(), './.local/state/markdown-live-preview');
    }
  }
}

export const globalConfigPath = getGlobalConfigPath();

/**
 * Check if a document is a markdown file
 */
export function isMarkdownFile(document: vscode.TextDocument): boolean {
  let flag =
    (document.languageId === 'markdown' ||
      document.languageId === 'quarto' ||
      document.languageId === 'mdx') &&
    document.uri.scheme !== 'markdown-live-preview';

  if (!flag) {
    const markdownFileExtensions =
      getMLPConfig<string[]>('markdownFileExtensions') ?? [];
    const fileName = document.fileName;
    const ext = path.extname(fileName).toLowerCase();
    flag = markdownFileExtensions.includes(ext);
  }

  return flag;
}

/**
 * Get the top visible line of an editor
 */
export function getTopVisibleLine(
  editor: vscode.TextEditor,
): number | undefined {
  if (!editor.visibleRanges.length) {
    return undefined;
  }

  const firstVisiblePosition = editor.visibleRanges[0].start;
  const lineNumber = firstVisiblePosition.line;
  const line = editor.document.lineAt(lineNumber);
  const progress = firstVisiblePosition.character / (line.text.length + 2);
  return lineNumber + progress;
}

/**
 * Get the bottom visible line of an editor
 * Uses the last visible range to correctly handle code folding
 */
export function getBottomVisibleLine(
  editor: vscode.TextEditor,
): number | undefined {
  if (!editor.visibleRanges.length) {
    return undefined;
  }

  const lastRange = editor.visibleRanges[editor.visibleRanges.length - 1];
  const lastVisiblePosition = lastRange.end;
  const lineNumber = lastVisiblePosition.line;
  let text = '';
  if (lineNumber < editor.document.lineCount) {
    text = editor.document.lineAt(lineNumber).text;
  }
  const progress = lastVisiblePosition.character / (text.length + 2);
  return lineNumber + progress;
}

/**
 * Check if running as VS Code web extension
 */
export function isVSCodeWebExtension(): boolean {
  return process.env.IS_VSCODE_WEB_EXTENSION === 'true';
}

/**
 * Check if running in VS Code web extension dev mode
 */
export function isVSCodeWebExtensionDevMode(): boolean {
  return process.env.IS_VSCODE_WEB_EXTENSION_DEV_MODE === 'true';
}

/**
 * Get the preview mode setting
 */
export function getPreviewMode(): PreviewMode {
  return getMLPConfig<PreviewMode>('previewMode') ?? PreviewMode.SinglePreview;
}

/**
 * Get the active cursor line of an editor
 */
export function getEditorActiveCursorLine(editor: vscode.TextEditor): number {
  return editor.selections[0].active.line ?? 0;
}

/**
 * Escape HTML entities
 */
export function escapeHtml(text: string): string {
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
 * Generate a unique ID
 */
export function generateId(): string {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse YAML front matter from markdown content
 */
export function parseFrontMatter(content: string): {
  frontMatter: Record<string, unknown> | null;
  content: string;
} {
  const frontMatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontMatterRegex);

  if (!match) {
    return { frontMatter: null, content };
  }

  try {
    // Simple YAML parsing for basic key-value pairs
    const yaml = match[1];
    const frontMatter: Record<string, unknown> = {};
    const lines = yaml.split('\n');

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        let value: unknown = line.substring(colonIndex + 1).trim();

        // Try to parse as JSON for arrays/objects
        if (
          typeof value === 'string' &&
          (value.startsWith('[') || value.startsWith('{'))
        ) {
          try {
            value = JSON.parse(value);
          } catch {
            // Keep as string
          }
        } else if (value === 'true') {
          value = true;
        } else if (value === 'false') {
          value = false;
        } else if (!Number.isNaN(Number(value)) && value !== '') {
          value = Number(value);
        }

        frontMatter[key] = value;
      }
    }

    return {
      frontMatter,
      content: content.substring(match[0].length),
    };
  } catch {
    return { frontMatter: null, content };
  }
}
