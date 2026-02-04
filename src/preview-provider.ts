/**
 * Preview Provider - backward compatible wrapper around the new preview system
 *
 * This file provides backward compatibility for the existing codebase
 * while delegating to the new PreviewManager internally.
 */

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import * as vscode from 'vscode';
import { getMLPConfig } from './config';
import {
  clearAllEngineCaches,
  getMarkdownEngine,
  type MarkdownEngine,
} from './markdown/MarkdownEngine';
import {
  getPreviewManager,
  type PreviewManager,
} from './preview/PreviewManager';
import { type ImageUploader, PreviewMode } from './types';
import {
  getWorkspaceFolderUri,
  globalConfigPath,
  isVSCodeWebExtension,
} from './utils';

/**
 * Workspace preview provider map
 */
const WORKSPACE_PREVIEW_PROVIDER_MAP: Map<string, PreviewProvider> = new Map();
const WORKSPACE_MUTEX_MAP: Map<string, Mutex> = new Map();

/**
 * Get all preview providers
 */
export function getAllPreviewProviders(): PreviewProvider[] {
  return Array.from(WORKSPACE_PREVIEW_PROVIDER_MAP.values());
}

/**
 * Preview Provider class - provides backward compatibility
 */
export class PreviewProvider {
  private context: vscode.ExtensionContext;
  private previewManager: PreviewManager;
  private updateTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private initRequestSeq = 0;
  private renderRequestSeq = 0;
  private latestInitRequestBySourceUri: Map<string, number> = new Map();
  private latestRenderRequestBySourceUri: Map<string, number> = new Map();
  private previewMaps: Map<string, Set<vscode.WebviewPanel>> = new Map();
  private previewToDocumentMap: Map<vscode.WebviewPanel, vscode.TextDocument> =
    new Map();
  private initializedPreviews: Set<vscode.WebviewPanel> = new Set();
  private jsAndCssFilesMaps: { [key: string]: string[] } = {};

  /**
   * Timestamp of the most recent user-initiated preview close.
   * Used to suppress auto-reopen in onDidChangeActiveTextEditor.
   */
  private lastPreviewCloseTime = 0;

  private static singlePreviewPanel: vscode.WebviewPanel | null = null;
  private static singlePreviewPanelSourceUriTarget: vscode.Uri | null = null;

  constructor() {
    this.previewManager = getPreviewManager();
  }

  private async init(
    context: vscode.ExtensionContext,
    _workspaceFolderUri: vscode.Uri,
  ) {
    this.context = context;
    this.previewManager.initialize(context);
    return this;
  }

  public static async getPreviewContentProvider(
    uri: vscode.Uri,
    context: vscode.ExtensionContext,
  ): Promise<PreviewProvider> {
    const workspaceUri = getWorkspaceFolderUri(uri);
    const mutexKey = workspaceUri.toString();

    // Acquire mutex
    let mutex = WORKSPACE_MUTEX_MAP.get(mutexKey);
    if (!mutex) {
      mutex = new Mutex();
      WORKSPACE_MUTEX_MAP.set(mutexKey, mutex);
    }

    const release = await mutex.acquire();
    try {
      let provider = WORKSPACE_PREVIEW_PROVIDER_MAP.get(mutexKey);
      if (!provider) {
        provider = new PreviewProvider();
        await provider.init(context, workspaceUri);
        WORKSPACE_PREVIEW_PROVIDER_MAP.set(mutexKey, provider);
      }
      return provider;
    } finally {
      release();
    }
  }

  private getPreviewMode(): PreviewMode {
    return (
      getMLPConfig<PreviewMode>('previewMode') ?? PreviewMode.SinglePreview
    );
  }

  private isSinglePreviewTarget(sourceUri: vscode.Uri): boolean {
    if (this.getPreviewMode() !== PreviewMode.SinglePreview) {
      return true;
    }
    const target = PreviewProvider.singlePreviewPanelSourceUriTarget;
    return !!target && target.fsPath === sourceUri.fsPath;
  }

  public async initPreview({
    sourceUri,
    document,
    webviewPanel,
    cursorLine,
    viewOptions,
  }: {
    sourceUri: vscode.Uri;
    document: vscode.TextDocument;
    webviewPanel?: vscode.WebviewPanel;
    cursorLine?: number;
    viewOptions: { viewColumn: vscode.ViewColumn; preserveFocus?: boolean };
  }): Promise<void> {
    const previewMode = this.getPreviewMode();
    let previewPanel: vscode.WebviewPanel;
    const previews = this.getPreviews(sourceUri);

    if (
      previewMode === PreviewMode.SinglePreview &&
      PreviewProvider.singlePreviewPanel
    ) {
      const oldResourceRoot = PreviewProvider.singlePreviewPanelSourceUriTarget
        ? getWorkspaceFolderUri(
            PreviewProvider.singlePreviewPanelSourceUriTarget,
          )
        : undefined;
      const newResourceRoot = getWorkspaceFolderUri(sourceUri);

      if (oldResourceRoot?.fsPath !== newResourceRoot.fsPath) {
        const singlePreview = PreviewProvider.singlePreviewPanel;
        PreviewProvider.singlePreviewPanel = null;
        PreviewProvider.singlePreviewPanelSourceUriTarget = null;
        singlePreview.dispose();
        return await this.initPreview({
          sourceUri,
          document,
          viewOptions,
          cursorLine,
        });
      } else {
        previewPanel = PreviewProvider.singlePreviewPanel;
        PreviewProvider.singlePreviewPanelSourceUriTarget = sourceUri;
        // Reveal the panel so it becomes visible (e.g. when triggered by title bar button)
        previewPanel.reveal(viewOptions.viewColumn, viewOptions.preserveFocus);
      }
    } else if (previews && previews.length > 0 && !webviewPanel) {
      await Promise.all(
        previews.map((preview) =>
          this.initPreview({
            sourceUri,
            document,
            webviewPanel: preview,
            viewOptions,
            cursorLine,
          }),
        ),
      );
      return;
    } else {
      const localResourceRoots = [
        vscode.Uri.file(this.context.extensionPath),
        vscode.Uri.file(globalConfigPath),
        vscode.Uri.file(tmpdir()),
      ];
      const workspaceUri = getWorkspaceFolderUri(sourceUri);
      if (workspaceUri) {
        localResourceRoots.push(workspaceUri);
      }

      if (webviewPanel) {
        previewPanel = webviewPanel;
        previewPanel.webview.options = {
          enableScripts: true,
          localResourceRoots,
        };
      } else {
        previewPanel = vscode.window.createWebviewPanel(
          'markdown-live-preview',
          `Preview ${path.basename(sourceUri.fsPath)}`,
          viewOptions,
          {
            enableFindWidget: true,
            localResourceRoots,
            enableScripts: true,
            retainContextWhenHidden: true,
          },
        );
      }

      previewPanel.iconPath = vscode.Uri.file(
        path.join(this.context.extensionPath, 'media', 'preview.svg'),
      );

      if (!this.initializedPreviews.has(previewPanel)) {
        this.initializedPreviews.add(previewPanel);

        previewPanel.webview.onDidReceiveMessage(
          (message) => {
            if (!message.command) return;

            // Handle saveAsHtml — show save dialog and write HTML file
            if (message.command === 'saveAsHtml') {
              const htmlContent = message.args?.[0] as string;
              if (!htmlContent) return;
              const defaultName = `${path.basename(
                sourceUri.fsPath,
                path.extname(sourceUri.fsPath),
              )}.html`;
              const workspaceFolder = getWorkspaceFolderUri(sourceUri);
              const defaultUri = workspaceFolder
                ? vscode.Uri.joinPath(workspaceFolder, defaultName)
                : vscode.Uri.file(
                    path.join(path.dirname(sourceUri.fsPath), defaultName),
                  );
              vscode.window
                .showSaveDialog({
                  defaultUri,
                  filters: { 'HTML Files': ['html', 'htm'] },
                })
                .then((saveUri) => {
                  if (!saveUri) return;
                  try {
                    fs.writeFileSync(saveUri.fsPath, htmlContent, 'utf-8');
                    vscode.window.showInformationMessage(
                      `Saved to ${saveUri.fsPath}`,
                    );
                  } catch (err) {
                    vscode.window.showErrorMessage(
                      `Failed to save HTML: ${err}`,
                    );
                  }
                });
              return;
            }

            // Handle downloadFile — save diagram as SVG/PNG via save dialog
            if (message.command === 'downloadFile') {
              const [filename, data, encoding] = (message.args || []) as [
                string,
                string,
                string,
              ];
              if (!filename || !data) return;
              const ext = path.extname(filename).replace('.', '');
              const filterLabel = `${ext.toUpperCase()} Files`;
              const workspaceFolder = getWorkspaceFolderUri(sourceUri);
              const defaultUri = workspaceFolder
                ? vscode.Uri.joinPath(workspaceFolder, filename)
                : vscode.Uri.file(
                    path.join(path.dirname(sourceUri.fsPath), filename),
                  );
              vscode.window
                .showSaveDialog({
                  defaultUri,
                  filters: { [filterLabel]: [ext] },
                })
                .then((saveUri) => {
                  if (!saveUri) return;
                  try {
                    if (encoding === 'base64') {
                      fs.writeFileSync(
                        saveUri.fsPath,
                        Buffer.from(data, 'base64'),
                      );
                    } else {
                      fs.writeFileSync(saveUri.fsPath, data, 'utf-8');
                    }
                    vscode.window.showInformationMessage(
                      `Saved to ${saveUri.fsPath}`,
                    );
                  } catch (err) {
                    vscode.window.showErrorMessage(
                      `Failed to save file: ${err}`,
                    );
                  }
                });
              return;
            }

            // Handle refreshPreview — re-read markdown and fully re-render
            if (message.command === 'refreshPreview') {
              const currentUri =
                this.getPreviewMode() === PreviewMode.SinglePreview
                  ? PreviewProvider.singlePreviewPanelSourceUriTarget ||
                    sourceUri
                  : sourceUri;
              // Clear all engine caches so a fresh engine with fresh config is created
              clearAllEngineCaches();
              vscode.workspace
                .openTextDocument(currentUri)
                .then(async (doc) => {
                  const engine = this.getEngine(currentUri);
                  const inputString = doc.getText() ?? '';
                  const html = await engine.generateHTMLTemplateForPreview({
                    inputString,
                    config: {
                      sourceUri: currentUri.toString(),
                      isVSCode: true,
                      scrollSync: getMLPConfig<boolean>('scrollSync'),
                      imageUploader:
                        getMLPConfig<ImageUploader>('imageUploader'),
                    },
                    contentSecurityPolicy: '',
                    vscodePreviewPanel: previewPanel,
                    isVSCodeWebExtension: isVSCodeWebExtension(),
                  });
                  // Force webview reload by appending a unique nonce comment.
                  // VS Code skips reload when webview.html is identical to the previous value.
                  const nonceHtml = html.replace(
                    '</html>',
                    `<!-- refresh-${Date.now()} -->\n</html>`,
                  );
                  previewPanel.webview.html = nonceHtml;
                })
                .catch((err) => {
                  console.error('[MLP] refreshPreview error:', err);
                });
              return;
            }

            // Handle openExternal — open URL in system browser
            if (message.command === 'openExternal') {
              const url = message.args?.[0] as string;
              if (url) {
                vscode.env.openExternal(vscode.Uri.parse(url));
              }
              return;
            }

            // Handle runCodeChunk from webview run button
            if (message.command === 'runCodeChunk') {
              const [chunkUri, chunkId] = (message.args || []) as [
                string,
                string,
              ];
              if (chunkUri && chunkId) {
                vscode.commands.executeCommand(
                  '_mlp.runCodeChunk',
                  chunkUri,
                  chunkId,
                );
              }
              return;
            }

            // Handle runAllCodeChunks
            if (message.command === 'runAllCodeChunks') {
              const runUri = message.args?.[0] as string;
              if (runUri) {
                vscode.commands.executeCommand('_mlp.runAllCodeChunks', runUri);
              }
              return;
            }

            // Forward other messages to VS Code commands
            if (message.args) {
              vscode.commands.executeCommand(
                `_mlp.${message.command}`,
                ...message.args,
              );
            }
          },
          null,
          this.context.subscriptions,
        );

        previewPanel.onDidDispose(
          () => {
            this.lastPreviewCloseTime = Date.now();
            this.destroyPreview(sourceUri);
            this.destroyEngine(sourceUri);
            this.initializedPreviews.delete(previewPanel);
          },
          null,
          this.context.subscriptions,
        );
      }

      if (previewMode === PreviewMode.SinglePreview) {
        PreviewProvider.singlePreviewPanel = previewPanel;
        PreviewProvider.singlePreviewPanelSourceUriTarget = sourceUri;
      }
    }

    this.addPreviewToMap(sourceUri, previewPanel);
    this.previewToDocumentMap.set(previewPanel, document);
    previewPanel.title = `Preview ${path.basename(sourceUri.fsPath)}`;

    let initialLine: number | undefined;
    if (document.uri.fsPath === sourceUri.fsPath) {
      initialLine = cursorLine;
    }

    const inputString = document.getText() ?? '';
    const engine = this.getEngine(sourceUri);

    try {
      const initRequestId = ++this.initRequestSeq;
      this.latestInitRequestBySourceUri.set(
        sourceUri.toString(),
        initRequestId,
      );

      const html = await engine.generateHTMLTemplateForPreview({
        inputString,
        config: {
          sourceUri: sourceUri.toString(),
          cursorLine: initialLine,
          isVSCode: true,
          scrollSync: getMLPConfig<boolean>('scrollSync'),
          imageUploader: getMLPConfig<ImageUploader>('imageUploader'),
        },
        contentSecurityPolicy: '',
        vscodePreviewPanel: previewPanel,
        isVSCodeWebExtension: isVSCodeWebExtension(),
      });

      if (
        this.latestInitRequestBySourceUri.get(sourceUri.toString()) !==
          initRequestId ||
        !this.initializedPreviews.has(previewPanel) ||
        !this.isSinglePreviewTarget(sourceUri)
      ) {
        return;
      }

      previewPanel.webview.html = html;
    } catch (error) {
      vscode.window.showErrorMessage(String(error));
      console.error(error);
    }
  }

  private addPreviewToMap(
    sourceUri: vscode.Uri,
    previewPanel: vscode.WebviewPanel,
  ): void {
    let previews = this.previewMaps.get(sourceUri.toString());
    if (!previews) {
      previews = new Set();
      this.previewMaps.set(sourceUri.toString(), previews);
    }
    previews.add(previewPanel);
  }

  private deletePreviewFromMap(
    sourceUri: vscode.Uri,
    previewPanel: vscode.WebviewPanel,
  ): void {
    this.previewMaps.get(sourceUri.toString())?.delete(previewPanel);
  }

  public getPreviews(
    sourceUri: vscode.Uri,
  ): vscode.WebviewPanel[] | null | undefined {
    if (
      this.getPreviewMode() === PreviewMode.SinglePreview &&
      PreviewProvider.singlePreviewPanel
    ) {
      return [PreviewProvider.singlePreviewPanel];
    } else {
      const previews = this.previewMaps.get(sourceUri.toString());
      if (previews) {
        return Array.from(previews);
      } else {
        return null;
      }
    }
  }

  public isPreviewOn(sourceUri: vscode.Uri): boolean {
    if (this.getPreviewMode() === PreviewMode.SinglePreview) {
      return !!PreviewProvider.singlePreviewPanel;
    } else {
      const previews = this.getPreviews(sourceUri);
      return previews !== null && previews !== undefined && previews.length > 0;
    }
  }

  public destroyPreview(sourceUri: vscode.Uri): void {
    const previewMode = this.getPreviewMode();
    if (previewMode === PreviewMode.SinglePreview) {
      PreviewProvider.singlePreviewPanel = null;
      PreviewProvider.singlePreviewPanelSourceUriTarget = null;
      this.previewToDocumentMap = new Map();
      this.previewMaps = new Map();
      this.latestInitRequestBySourceUri.clear();
      this.latestRenderRequestBySourceUri.clear();
    } else {
      const previews = this.getPreviews(sourceUri);
      if (previews) {
        previews.forEach((preview) => {
          this.previewToDocumentMap.delete(preview);
          this.deletePreviewFromMap(sourceUri, preview);
        });
      }
      const sourceUriString = sourceUri.toString();
      this.latestInitRequestBySourceUri.delete(sourceUriString);
      this.latestRenderRequestBySourceUri.delete(sourceUriString);
    }
  }

  public destroyEngine(_sourceUri: vscode.Uri): void {
    // Engine cleanup is handled by the engine cache
  }

  private getEngine(sourceUri: vscode.Uri): MarkdownEngine {
    return getMarkdownEngine(sourceUri.fsPath);
  }

  public refreshAllPreviews(): void {
    clearAllEngineCaches();

    if (this.getPreviewMode() === PreviewMode.SinglePreview) {
      this.refreshPreviewPanel(
        PreviewProvider.singlePreviewPanelSourceUriTarget,
      );
    } else {
      for (const [sourceUriString] of this.previewMaps) {
        this.refreshPreviewPanel(vscode.Uri.parse(sourceUriString));
      }
    }
  }

  private refreshPreviewPanel(sourceUri: vscode.Uri | null): void {
    if (!sourceUri) {
      return;
    }

    this.previewToDocumentMap.forEach(async (document, previewPanel) => {
      if (previewPanel && document.uri.fsPath === sourceUri.fsPath) {
        await this.initPreview({
          sourceUri,
          document,
          viewOptions: {
            viewColumn: previewPanel.viewColumn ?? vscode.ViewColumn.One,
            preserveFocus: true,
          },
        });
      }
    });
  }

  public refreshPreview(sourceUri: vscode.Uri): void {
    const engine = this.getEngine(sourceUri);
    if (engine) {
      engine.clearCaches();
      this.refreshPreviewPanel(sourceUri);
    }
  }

  public closeAllPreviews(previewMode: PreviewMode): void {
    if (previewMode === PreviewMode.SinglePreview) {
      if (PreviewProvider.singlePreviewPanel) {
        PreviewProvider.singlePreviewPanel.dispose();
      }
    } else {
      for (const [sourceUriString] of this.previewMaps) {
        const previews = this.previewMaps.get(sourceUriString);
        if (previews) {
          previews.forEach((preview) => preview.dispose());
        }
      }
    }

    this.previewMaps = new Map();
    this.previewToDocumentMap = new Map();
    this.updateTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.updateTimeouts.clear();
    this.latestInitRequestBySourceUri.clear();
    this.latestRenderRequestBySourceUri.clear();
    PreviewProvider.singlePreviewPanel = null;
    PreviewProvider.singlePreviewPanelSourceUriTarget = null;
  }

  public async postMessageToPreview(
    sourceUri: vscode.Uri,
    message: { command: string; [key: string]: unknown },
  ): Promise<void> {
    if (!this.isSinglePreviewTarget(sourceUri)) {
      return;
    }
    const previews = this.getPreviews(sourceUri);
    if (previews) {
      for (const preview of previews) {
        try {
          await preview.webview.postMessage(message);
        } catch (error) {
          console.error(error);
        }
      }
    }
  }

  /**
   * Returns true if a preview was recently closed by the user,
   * so auto-reopen should be suppressed.
   */
  public wasRecentlyClosed(): boolean {
    return Date.now() - this.lastPreviewCloseTime < 1500;
  }

  public previewHasTheSameSingleSourceUri(sourceUri: vscode.Uri): boolean {
    if (!PreviewProvider.singlePreviewPanelSourceUriTarget) {
      return false;
    }
    return (
      PreviewProvider.singlePreviewPanelSourceUriTarget.fsPath ===
      sourceUri.fsPath
    );
  }

  public shouldUpdateMarkdown(sourceUri: vscode.Uri): boolean {
    if (!this.isSinglePreviewTarget(sourceUri)) {
      return false;
    }
    const previews = this.getPreviews(sourceUri);
    return !!(previews && previews.length > 0);
  }

  public updateMarkdown(
    sourceUri: vscode.Uri,
    triggeredBySave?: boolean,
  ): void {
    if (!this.isSinglePreviewTarget(sourceUri)) {
      return;
    }
    const engine = this.getEngine(sourceUri);
    const previews = this.getPreviews(sourceUri);

    if (!previews || !previews.length) {
      return;
    }

    if (engine.isPreviewInPresentationMode) {
      return this.refreshPreview(sourceUri);
    }

    (async () => {
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(sourceUri);
      } catch (error) {
        console.error(error);
        return;
      }

      if (!this.isSinglePreviewTarget(sourceUri)) {
        return;
      }

      const renderRequestId = ++this.renderRequestSeq;
      this.latestRenderRequestBySourceUri.set(
        sourceUri.toString(),
        renderRequestId,
      );

      const text = document.getText() ?? '';
      await this.postMessageToPreview(sourceUri, {
        command: 'startParsingMarkdown',
      });

      const currentPreviews = this.getPreviews(sourceUri);
      if (!currentPreviews || !currentPreviews.length) {
        return;
      }

      for (const preview of currentPreviews) {
        try {
          const { html, tocHTML, JSAndCssFiles, yamlConfig } =
            await engine.parseMD(text, {
              isForPreview: true,
              useRelativeFilePath: false,
              hideFrontMatter: false,
              triggeredBySave,
              vscodePreviewPanel: preview,
              sourceUri: sourceUri.toString(),
            });

          if (!this.isSinglePreviewTarget(sourceUri)) {
            return;
          }
          if (
            this.latestRenderRequestBySourceUri.get(sourceUri.toString()) !==
            renderRequestId
          ) {
            return;
          }

          const normalizedResources = this.normalizeResourceList(JSAndCssFiles);
          const previousResources = this.normalizeResourceList(
            this.jsAndCssFilesMaps[sourceUri.fsPath],
          );

          if (
            JSON.stringify(normalizedResources) !==
              JSON.stringify(previousResources) ||
            yamlConfig.isPresentationMode
          ) {
            this.jsAndCssFilesMaps[sourceUri.fsPath] = normalizedResources;
            this.refreshPreview(sourceUri);
          } else {
            await this.postMessageToPreview(sourceUri, {
              command: 'updateHtml',
              markdown: text,
              html,
              tocHTML,
              totalLineCount: document.lineCount,
              sourceUri: sourceUri.toString(),
              sourceScheme: sourceUri.scheme,
              id: yamlConfig.id || '',
              class: yamlConfig.class || '',
            });
          }
          return;
        } catch (error) {
          console.error(error);
        }
      }
    })();
  }

  private normalizeResourceList(resources: string[] | undefined): string[] {
    if (!resources?.length) {
      return [];
    }
    return Array.from(new Set(resources)).sort();
  }

  public update(sourceUri: vscode.Uri): void {
    const previews = this.getPreviews(sourceUri);
    if (!getMLPConfig<boolean>('liveUpdate') || !previews || !previews.length) {
      return;
    }

    const sourceUriString = sourceUri.toString();
    const debounceMs = getMLPConfig<number>('liveUpdateDebounceMs') ?? 300;

    const existingTimeout = this.updateTimeouts.get(sourceUriString);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.updateTimeouts.delete(sourceUriString);
    }

    if (debounceMs === 0) {
      this.updateMarkdown(sourceUri);
      return;
    }

    const timeout = setTimeout(() => {
      this.updateTimeouts.delete(sourceUriString);
      this.updateMarkdown(sourceUri);
    }, debounceMs);

    this.updateTimeouts.set(sourceUriString, timeout);
  }

  public async openImageHelper(sourceUri: vscode.Uri): Promise<void> {
    if (sourceUri.scheme === 'markdown-live-preview') {
      vscode.window.showWarningMessage('Please focus a markdown file.');
    } else if (!this.isPreviewOn(sourceUri)) {
      vscode.window.showWarningMessage('Please open preview first.');
    } else {
      await this.postMessageToPreview(sourceUri, {
        command: 'openImageHelper',
      });
    }
  }
}

export function getPreviewUri(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme === 'markdown-live-preview') {
    return uri;
  }

  const previewMode =
    getMLPConfig<PreviewMode>('previewMode') ?? PreviewMode.SinglePreview;

  if (previewMode === PreviewMode.SinglePreview) {
    return uri.with({
      scheme: 'markdown-live-preview',
      path: 'single-preview.rendered',
    });
  } else {
    return uri.with({
      scheme: 'markdown-live-preview',
      path: `${uri.path}.rendered`,
      query: uri.toString(),
    });
  }
}
