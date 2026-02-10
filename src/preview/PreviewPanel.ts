/**
 * Preview Panel - manages a single webview panel for markdown preview
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getFullConfig, getMLPConfig, updateMLPConfig } from '../config/ConfigManager';
import { MarkdownEngine } from '../markdown/MarkdownEngine';
import {
  getWorkspaceFolderUri,
  globalConfigPath,
  isVSCodeWebExtension,
} from '../utils/index';

export interface PreviewPanelOptions {
  sourceUri: vscode.Uri;
  document: vscode.TextDocument;
  viewColumn: vscode.ViewColumn;
  preserveFocus?: boolean;
  cursorLine?: number;
}

export class PreviewPanel {
  private panel: vscode.WebviewPanel;
  private sourceUri: vscode.Uri;
  private document: vscode.TextDocument;
  private engine: MarkdownEngine;
  private disposables: vscode.Disposable[] = [];
  private isInitialized = false;
  private initRequestId = 0;

  constructor(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    sourceUri: vscode.Uri,
    document: vscode.TextDocument,
  ) {
    this._context = context;
    this.panel = panel;
    this.sourceUri = sourceUri;
    this.document = document;
    this.engine = new MarkdownEngine();

    // Set up message handler
    this.panel.webview.onDidReceiveMessage(
      this.handleMessage.bind(this),
      null,
      this.disposables,
    );
  }

  /**
   * Create a new preview panel
   */
  static async create(
    context: vscode.ExtensionContext,
    options: PreviewPanelOptions,
  ): Promise<PreviewPanel> {
    const { sourceUri, document, viewColumn, preserveFocus } = options;

    // Set up local resource roots
    const localResourceRoots = [
      vscode.Uri.file(context.extensionPath),
      vscode.Uri.file(globalConfigPath),
    ];

    const workspaceUri = getWorkspaceFolderUri(sourceUri);
    if (workspaceUri) {
      localResourceRoots.push(workspaceUri);
    }

    // Create the webview panel
    const panel = vscode.window.createWebviewPanel(
      'markdown-live-preview',
      `Preview ${path.basename(sourceUri.fsPath)}`,
      {
        viewColumn,
        preserveFocus: preserveFocus ?? true,
      },
      {
        enableFindWidget: true,
        localResourceRoots,
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    // Set icon
    panel.iconPath = vscode.Uri.file(
      path.join(context.extensionPath, 'media', 'preview.svg'),
    );

    // Create the preview panel instance
    const previewPanel = new PreviewPanel(context, panel, sourceUri, document);

    // Initialize the preview
    await previewPanel.init(options.cursorLine);

    return previewPanel;
  }

  /**
   * Initialize the preview with content
   */
  async init(cursorLine?: number): Promise<void> {
    const requestId = ++this.initRequestId;

    try {
      const inputString = this.document.getText() ?? '';

      const html = await this.engine.generateHTMLTemplateForPreview({
        inputString,
        config: {
          sourceUri: this.sourceUri.toString(),
          cursorLine,
          isVSCode: true,
          scrollSync: getMLPConfig<boolean>('scrollSync'),
        },
        contentSecurityPolicy: '',
        vscodePreviewPanel: this.panel,
        isVSCodeWebExtension: isVSCodeWebExtension(),
      });

      // Check if this is still the latest request
      if (this.initRequestId !== requestId) {
        return;
      }

      this.panel.webview.html = html;
      this.isInitialized = true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to initialize preview: ${error}`);
      console.error(error);
    }
  }

  /**
   * Update the preview with new content
   */
  async update(triggeredBySave?: boolean): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      const text = this.document.getText() ?? '';

      const { html, tocHTML, frontMatterForTOC, yamlConfig } =
        await this.engine.parseMD(text, {
          isForPreview: true,
          useRelativeFilePath: false,
          hideFrontMatter: false,
          triggeredBySave,
          vscodePreviewPanel: this.panel,
        });

      // Check if resources changed or presentation mode
      if (yamlConfig.isPresentationMode) {
        // Reinitialize for presentation mode
        await this.init();
        return;
      }

      // Send update message to webview
      await this.postMessage({
        command: 'updateHtml',
        markdown: text,
        html,
        tocHTML,
        frontMatterForTOC,
        totalLineCount: this.document.lineCount,
        sourceUri: this.sourceUri.toString(),
        sourceScheme: this.sourceUri.scheme,
        id: (yamlConfig.id as string) || '',
        class: (yamlConfig.class as string) || '',
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to update preview: ${error}`);
      console.error(error);
    }
  }

  /**
   * Refresh the preview (reinitialize)
   */
  async refresh(): Promise<void> {
    this.engine.updateConfig(getFullConfig());
    this.engine.clearCaches();
    await this.init();
  }

  /**
   * Send a message to the webview
   */
  async postMessage(message: {
    command: string;
    [key: string]: unknown;
  }): Promise<boolean> {
    try {
      return await this.panel.webview.postMessage(message);
    } catch (error) {
      console.error('Failed to post message to webview:', error);
      return false;
    }
  }

  /**
   * Handle messages from the webview
   */
  private handleMessage(message: { command: string; args?: unknown[] }): void {
    if (!message.command) return;

    // Handle saveAsHtml — show save dialog and write HTML file
    if (message.command === 'saveAsHtml') {
      this.handleSaveAsHtml(message.args?.[0] as string);
      return;
    }

    // Handle downloadFile — save diagram as SVG/PNG via save dialog
    if (message.command === 'downloadFile') {
      const [filename, data, encoding] = (message.args || []) as [
        string,
        string,
        string,
      ];
      if (filename && data) {
        this.handleDownloadFile(filename, data, encoding);
      }
      return;
    }

    // Handle setMermaidTheme — persist mermaid theme to VS Code settings
    if (message.command === 'setMermaidTheme') {
      const theme = message.args?.[0] as string;
      if (theme) {
        updateMLPConfig('mermaidTheme', theme, true);
      }
      return;
    }

    // Handle setFrontMatterRenderingOption — persist front matter rendering option
    if (message.command === 'setFrontMatterRenderingOption') {
      const option = message.args?.[0] as string;
      if (option) {
        updateMLPConfig('frontMatterRenderingOption', option, true);
      }
      return;
    }

    // Handle setMermaidAsciiMode — persist mermaid ASCII mode to VS Code settings
    if (message.command === 'setMermaidAsciiMode') {
      const enabled = message.args?.[0] as boolean;
      updateMLPConfig('mermaidAsciiMode', enabled, true);
      return;
    }

    // Handle refreshPreview — re-render the entire preview
    if (message.command === 'refreshPreview') {
      this.refresh();
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

    // Handle fetchUrl — fetch URL content via extension host (bypasses webview CORS)
    if (message.command === 'fetchUrl') {
      const [requestId, url] = (message.args || []) as [string, string];
      if (requestId && url) {
        this.handleFetchUrl(requestId, url);
      }
      return;
    }

    // Forward to VS Code commands
    if (message.args) {
      vscode.commands.executeCommand(
        `_mlp.${message.command}`,
        ...message.args,
      );
    }
  }

  /**
   * Handle "Save as HTML" action from the context menu
   */
  private async handleSaveAsHtml(htmlContent: string): Promise<void> {
    if (!htmlContent) return;

    const defaultName = `${path.basename(
      this.sourceUri.fsPath,
      path.extname(this.sourceUri.fsPath),
    )}.html`;
    const workspaceFolder = getWorkspaceFolderUri(this.sourceUri);
    const defaultUri = workspaceFolder
      ? vscode.Uri.joinPath(workspaceFolder, defaultName)
      : vscode.Uri.file(
          path.join(path.dirname(this.sourceUri.fsPath), defaultName),
        );

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'HTML Files': ['html', 'htm'] },
    });

    if (!saveUri) return;

    try {
      fs.writeFileSync(saveUri.fsPath, htmlContent, 'utf-8');
      vscode.window.showInformationMessage(`Saved to ${saveUri.fsPath}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save HTML: ${err}`);
    }
  }

  /**
   * Handle file download (SVG/PNG) from the context menu
   */
  private async handleDownloadFile(
    filename: string,
    data: string,
    encoding: string,
  ): Promise<void> {
    const ext = path.extname(filename).replace('.', '');
    const filterLabel = `${ext.toUpperCase()} Files`;
    const workspaceFolder = getWorkspaceFolderUri(this.sourceUri);
    const defaultUri = workspaceFolder
      ? vscode.Uri.joinPath(workspaceFolder, filename)
      : vscode.Uri.file(
          path.join(path.dirname(this.sourceUri.fsPath), filename),
        );

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { [filterLabel]: [ext] },
    });

    if (!saveUri) return;

    try {
      if (encoding === 'base64') {
        fs.writeFileSync(saveUri.fsPath, Buffer.from(data, 'base64'));
      } else {
        fs.writeFileSync(saveUri.fsPath, data, 'utf-8');
      }
      vscode.window.showInformationMessage(`Saved to ${saveUri.fsPath}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save file: ${err}`);
    }
  }

  /**
   * Fetch URL content and send back to webview (bypasses CORS)
   */
  private async handleFetchUrl(requestId: string, url: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const content = await response.text();
      this.panel.webview.postMessage({
        command: 'fetchUrlResponse',
        requestId,
        success: true,
        content,
      });
    } catch (err) {
      this.panel.webview.postMessage({
        command: 'fetchUrlResponse',
        requestId,
        success: false,
        error: String(err),
      });
    }
  }

  /**
   * Update the source document
   */
  updateDocument(document: vscode.TextDocument): void {
    this.document = document;
  }

  /**
   * Update the source URI
   */
  updateSourceUri(sourceUri: vscode.Uri): void {
    this.sourceUri = sourceUri;
    this.panel.title = `Preview ${path.basename(sourceUri.fsPath)}`;
  }

  /**
   * Get the webview panel
   */
  getPanel(): vscode.WebviewPanel {
    return this.panel;
  }

  /**
   * Get the source URI
   */
  getSourceUri(): vscode.Uri {
    return this.sourceUri;
  }

  /**
   * Get the document
   */
  getDocument(): vscode.TextDocument {
    return this.document;
  }

  /**
   * Check if the panel is visible
   */
  isVisible(): boolean {
    return this.panel.visible;
  }

  /**
   * Reveal the panel
   */
  reveal(viewColumn?: vscode.ViewColumn, preserveFocus?: boolean): void {
    this.panel.reveal(viewColumn, preserveFocus);
  }

  /**
   * Dispose of the preview panel
   */
  dispose(): void {
    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  /**
   * Add a dispose listener
   */
  onDidDispose(callback: () => void): vscode.Disposable {
    return this.panel.onDidDispose(callback);
  }
}
