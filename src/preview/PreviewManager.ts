/**
 * Preview Manager - manages all preview panels
 */

import { Mutex } from 'async-mutex';
import * as vscode from 'vscode';
import { getMLPConfig } from '../config/ConfigManager';
import { PreviewColorScheme, PreviewMode, type PreviewTheme } from '../types';
import { getWorkspaceFolderUri } from '../utils/index';
import { PreviewPanel } from './PreviewPanel';

/**
 * Preview Manager singleton
 */
export class PreviewManager {
  private static instance: PreviewManager | null = null;
  private context: vscode.ExtensionContext | null = null;

  // Preview panels by source URI
  private previewPanels: Map<string, Set<PreviewPanel>> = new Map();

  // Single preview mode panel
  private singlePreviewPanel: PreviewPanel | null = null;
  private singlePreviewSourceUri: vscode.Uri | null = null;

  // Update timeouts for debouncing
  private updateTimeouts: Map<string, NodeJS.Timeout> = new Map();

  // Mutex for thread-safe operations
  private mutex = new Mutex();

  // System color scheme
  private systemColorScheme: 'light' | 'dark' = 'light';

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): PreviewManager {
    if (!PreviewManager.instance) {
      PreviewManager.instance = new PreviewManager();
    }
    return PreviewManager.instance;
  }

  /**
   * Initialize the preview manager
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  /**
   * Get the preview mode
   */
  private getPreviewMode(): PreviewMode {
    return (
      getMLPConfig<PreviewMode>('previewMode') ?? PreviewMode.SinglePreview
    );
  }

  /**
   * Initialize or update a preview for a document
   */
  async initPreview(options: {
    sourceUri: vscode.Uri;
    document: vscode.TextDocument;
    viewColumn: vscode.ViewColumn;
    preserveFocus?: boolean;
    cursorLine?: number;
  }): Promise<void> {
    if (!this.context) {
      throw new Error('PreviewManager not initialized');
    }

    const release = await this.mutex.acquire();
    try {
      const previewMode = this.getPreviewMode();

      if (previewMode === PreviewMode.SinglePreview) {
        await this.initSinglePreview(options);
      } else {
        await this.initMultiplePreview(options);
      }
    } finally {
      release();
    }
  }

  /**
   * Initialize single preview mode
   */
  private async initSinglePreview(options: {
    sourceUri: vscode.Uri;
    document: vscode.TextDocument;
    viewColumn: vscode.ViewColumn;
    preserveFocus?: boolean;
    cursorLine?: number;
  }): Promise<void> {
    const { sourceUri, document, viewColumn, preserveFocus, cursorLine } =
      options;

    if (this.singlePreviewPanel) {
      // Check if workspace changed
      const oldWorkspace = this.singlePreviewSourceUri
        ? getWorkspaceFolderUri(this.singlePreviewSourceUri)
        : null;
      const newWorkspace = getWorkspaceFolderUri(sourceUri);

      if (oldWorkspace?.fsPath !== newWorkspace.fsPath) {
        // Workspace changed, dispose old panel
        this.singlePreviewPanel.dispose();
        this.singlePreviewPanel = null;
        this.singlePreviewSourceUri = null;
      } else {
        // Same workspace, update the existing panel
        this.singlePreviewPanel.updateSourceUri(sourceUri);
        this.singlePreviewPanel.updateDocument(document);
        this.singlePreviewSourceUri = sourceUri;

        // Reinitialize with new content
        await this.singlePreviewPanel.init(cursorLine);
        return;
      }
    }

    // Create new single preview panel
    this.singlePreviewPanel = await PreviewPanel.create(this.context!, {
      sourceUri,
      document,
      viewColumn,
      preserveFocus,
      cursorLine,
    });

    this.singlePreviewSourceUri = sourceUri;

    // Handle disposal
    this.singlePreviewPanel.onDidDispose(() => {
      this.singlePreviewPanel = null;
      this.singlePreviewSourceUri = null;
    });
  }

  /**
   * Initialize multiple preview mode
   */
  private async initMultiplePreview(options: {
    sourceUri: vscode.Uri;
    document: vscode.TextDocument;
    viewColumn: vscode.ViewColumn;
    preserveFocus?: boolean;
    cursorLine?: number;
  }): Promise<void> {
    const { sourceUri, document, viewColumn, preserveFocus, cursorLine } =
      options;
    const sourceUriString = sourceUri.toString();

    // Check if preview already exists for this URI
    const existingPanels = this.previewPanels.get(sourceUriString);
    if (existingPanels && existingPanels.size > 0) {
      // Update existing panel
      const panel = existingPanels.values().next().value as PreviewPanel;
      panel.updateDocument(document);
      await panel.init(cursorLine);
      panel.reveal(viewColumn, preserveFocus);
      return;
    }

    // Create new preview panel
    const previewPanel = await PreviewPanel.create(this.context!, {
      sourceUri,
      document,
      viewColumn,
      preserveFocus,
      cursorLine,
    });

    // Add to map
    if (!this.previewPanels.has(sourceUriString)) {
      this.previewPanels.set(sourceUriString, new Set());
    }
    this.previewPanels.get(sourceUriString)?.add(previewPanel);

    // Handle disposal
    previewPanel.onDidDispose(() => {
      const panels = this.previewPanels.get(sourceUriString);
      if (panels) {
        panels.delete(previewPanel);
        if (panels.size === 0) {
          this.previewPanels.delete(sourceUriString);
        }
      }
    });
  }

  /**
   * Get previews for a source URI
   */
  getPreviews(sourceUri: vscode.Uri): PreviewPanel[] {
    const previewMode = this.getPreviewMode();

    if (previewMode === PreviewMode.SinglePreview) {
      return this.singlePreviewPanel ? [this.singlePreviewPanel] : [];
    }

    const panels = this.previewPanels.get(sourceUri.toString());
    return panels ? Array.from(panels) : [];
  }

  /**
   * Check if preview is open for a source URI
   */
  isPreviewOn(sourceUri: vscode.Uri): boolean {
    const previewMode = this.getPreviewMode();

    if (previewMode === PreviewMode.SinglePreview) {
      return this.singlePreviewPanel !== null;
    }

    const panels = this.previewPanels.get(sourceUri.toString());
    return panels !== undefined && panels.size > 0;
  }

  /**
   * Check if single preview has the same source URI
   */
  previewHasTheSameSingleSourceUri(sourceUri: vscode.Uri): boolean {
    if (!this.singlePreviewSourceUri) {
      return false;
    }
    return this.singlePreviewSourceUri.fsPath === sourceUri.fsPath;
  }

  /**
   * Should update markdown for this source URI
   */
  shouldUpdateMarkdown(sourceUri: vscode.Uri): boolean {
    const previewMode = this.getPreviewMode();

    if (previewMode === PreviewMode.SinglePreview) {
      if (!this.singlePreviewSourceUri) {
        return false;
      }
      return this.singlePreviewSourceUri.fsPath === sourceUri.fsPath;
    }

    return this.isPreviewOn(sourceUri);
  }

  /**
   * Update markdown for a source URI
   */
  async updateMarkdown(
    sourceUri: vscode.Uri,
    triggeredBySave?: boolean,
  ): Promise<void> {
    if (!this.shouldUpdateMarkdown(sourceUri)) {
      return;
    }

    const previews = this.getPreviews(sourceUri);
    for (const preview of previews) {
      await preview.update(triggeredBySave);
    }
  }

  /**
   * Debounced update for live preview
   */
  update(sourceUri: vscode.Uri): void {
    const liveUpdate = getMLPConfig<boolean>('liveUpdate') ?? true;
    if (!liveUpdate) {
      return;
    }

    if (!this.shouldUpdateMarkdown(sourceUri)) {
      return;
    }

    const sourceUriString = sourceUri.toString();
    const debounceMs = getMLPConfig<number>('liveUpdateDebounceMs') ?? 300;

    // Clear existing timeout
    const existingTimeout = this.updateTimeouts.get(sourceUriString);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.updateTimeouts.delete(sourceUriString);
    }

    // If debounce is 0, update immediately
    if (debounceMs === 0) {
      this.updateMarkdown(sourceUri);
      return;
    }

    // Set new timeout
    const timeout = setTimeout(() => {
      this.updateTimeouts.delete(sourceUriString);
      this.updateMarkdown(sourceUri);
    }, debounceMs);

    this.updateTimeouts.set(sourceUriString, timeout);
  }

  /**
   * Post message to preview
   */
  async postMessageToPreview(
    sourceUri: vscode.Uri,
    message: { command: string; [key: string]: unknown },
  ): Promise<void> {
    const previews = this.getPreviews(sourceUri);
    for (const preview of previews) {
      await preview.postMessage(message);
    }
  }

  /**
   * Refresh all previews
   */
  async refreshAllPreviews(): Promise<void> {
    const previewMode = this.getPreviewMode();

    if (previewMode === PreviewMode.SinglePreview) {
      if (this.singlePreviewPanel) {
        await this.singlePreviewPanel.refresh();
      }
    } else {
      for (const [, panels] of this.previewPanels) {
        for (const panel of panels) {
          await panel.refresh();
        }
      }
    }
  }

  /**
   * Refresh preview for a specific source URI
   */
  async refreshPreview(sourceUri: vscode.Uri): Promise<void> {
    const previews = this.getPreviews(sourceUri);
    for (const preview of previews) {
      await preview.refresh();
    }
  }

  /**
   * Close all previews
   */
  closeAllPreviews(previewMode: PreviewMode): void {
    if (previewMode === PreviewMode.SinglePreview) {
      if (this.singlePreviewPanel) {
        this.singlePreviewPanel.dispose();
        this.singlePreviewPanel = null;
        this.singlePreviewSourceUri = null;
      }
    } else {
      for (const [, panels] of this.previewPanels) {
        for (const panel of panels) {
          panel.dispose();
        }
      }
      this.previewPanels.clear();
    }

    // Clear all timeouts
    this.updateTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.updateTimeouts.clear();
  }

  /**
   * Set system color scheme
   */
  setSystemColorScheme(colorScheme: 'light' | 'dark'): void {
    if (this.systemColorScheme !== colorScheme) {
      this.systemColorScheme = colorScheme;

      const previewColorScheme =
        getMLPConfig<PreviewColorScheme>('previewColorScheme');
      if (previewColorScheme === PreviewColorScheme.systemColorScheme) {
        this.refreshAllPreviews();
      }
    }
  }

  /**
   * Get system color scheme
   */
  getSystemColorScheme(): 'light' | 'dark' {
    return this.systemColorScheme;
  }

  /**
   * Get editor color scheme
   */
  getEditorColorScheme(): 'light' | 'dark' {
    const theme = vscode.window.activeColorTheme;
    if (
      theme.kind === vscode.ColorThemeKind.Light ||
      theme.kind === vscode.ColorThemeKind.HighContrastLight
    ) {
      return 'light';
    }
    return 'dark';
  }

  /**
   * Get preview theme based on color scheme
   */
  getPreviewTheme(
    baseTheme: PreviewTheme,
    _colorScheme: PreviewColorScheme,
  ): PreviewTheme {
    // Each theme now includes both light and dark variants,
    // controlled by the data-theme attribute in the preview.
    // The theme name stays the same regardless of color scheme.
    return baseTheme;
  }

  /**
   * Dispose of the preview manager
   */
  dispose(): void {
    this.closeAllPreviews(this.getPreviewMode());
  }
}

// Export singleton getter
export function getPreviewManager(): PreviewManager {
  return PreviewManager.getInstance();
}
