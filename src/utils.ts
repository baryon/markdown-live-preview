/**
 * Utilities module - re-exports from new utils system
 * This file exists for backward compatibility during migration
 */

export {
  debounce,
  debounceLeading,
  escapeHtml,
  generateId,
  getBottomVisibleLine,
  getEditorActiveCursorLine,
  getPreviewMode,
  getTopVisibleLine,
  getWorkspaceFolderUri,
  globalConfigPath,
  isMarkdownFile,
  isVSCodeWebExtension,
  isVSCodeWebExtensionDevMode,
  parseFrontMatter,
  sleep,
  throttle,
} from './utils/index';
