/**
 * Extension Common - shared functionality for both node.js and browser environments
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { getCodeChunkManager } from './code-chunk';
import { getMLPConfig, PreviewColorScheme, updateMLPConfig } from './config';
import { pasteImageFile } from './image-helper';
import { getPreviewManager } from './preview/PreviewManager';
import { PreviewCustomEditorProvider } from './preview-custom-editor-provider';
import { PreviewProvider } from './preview-provider';
import { PreviewMode } from './types';
import {
  getBottomVisibleLine,
  getEditorActiveCursorLine,
  getTopVisibleLine,
  isMarkdownFile,
} from './utils';

let editorScrollDelay = Date.now();

// Hide default VS Code markdown preview buttons if necessary
const hideDefaultVSCodeMarkdownPreviewButtons = vscode.workspace
  .getConfiguration('markdown-live-preview')
  .get<boolean>('hideDefaultVSCodeMarkdownPreviewButtons');
if (hideDefaultVSCodeMarkdownPreviewButtons) {
  vscode.commands.executeCommand(
    'setContext',
    'hasCustomMarkdownPreview',
    true,
  );
}

export async function initExtensionCommon(context: vscode.ExtensionContext) {
  // Initialize preview manager
  const previewManager = getPreviewManager();
  previewManager.initialize(context);

  // Set enableScriptExecution context key for keybinding conditions
  const scriptExecEnabled =
    getMLPConfig<boolean>('enableScriptExecution') ?? false;
  vscode.commands.executeCommand(
    'setContext',
    'markdown-live-preview.enableScriptExecution',
    scriptExecEnabled,
  );

  // Set initial markdownOpenMode context key
  const initialOpenMode =
    getMLPConfig<string>('markdownOpenMode') ?? 'side-by-side';
  vscode.commands.executeCommand(
    'setContext',
    'markdown-live-preview.openMode',
    initialOpenMode,
  );

  function getPreviewMode(): PreviewMode {
    return (
      getMLPConfig<PreviewMode>('previewMode') ?? PreviewMode.SinglePreview
    );
  }

  function getMarkdownOpenMode(): string {
    return getMLPConfig<string>('markdownOpenMode') ?? 'side-by-side';
  }

  async function getPreviewContentProvider(uri: vscode.Uri) {
    return await PreviewProvider.getPreviewContentProvider(uri, context);
  }

  async function openPreviewToTheSide(uri?: vscode.Uri) {
    let editor = vscode.window.activeTextEditor;
    let document: vscode.TextDocument;
    let cursorLine = 0;

    if (uri) {
      document = await vscode.workspace.openTextDocument(uri);
      const existingEditor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.fsPath === uri?.fsPath,
      );
      if (existingEditor) {
        editor = existingEditor;
        cursorLine = getEditorActiveCursorLine(editor);
      }
    } else if (editor) {
      uri = editor.document.uri;
      document = editor.document;
      cursorLine = getEditorActiveCursorLine(editor);
    } else {
      return;
    }

    const previewProvider = await getPreviewContentProvider(uri!);
    await previewProvider.initPreview({
      sourceUri: uri!,
      document,
      cursorLine,
      viewOptions: {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true,
      },
    });
  }

  async function openPreview(uri?: vscode.Uri) {
    let editor = vscode.window.activeTextEditor;
    let document: vscode.TextDocument;
    let cursorLine = 0;

    if (uri) {
      document = await vscode.workspace.openTextDocument(uri);
      const existingEditor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.fsPath === uri?.fsPath,
      );
      if (existingEditor) {
        editor = existingEditor;
        cursorLine = getEditorActiveCursorLine(editor);
      }
    } else if (editor) {
      uri = editor.document.uri;
      document = editor.document;
      cursorLine = getEditorActiveCursorLine(editor);
    } else {
      return;
    }

    const previewProvider = await getPreviewContentProvider(uri!);
    await previewProvider.initPreview({
      sourceUri: uri,
      document,
      cursorLine,
      viewOptions: {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      },
    });
  }

  async function toggleScrollSync() {
    const scrollSync = !getMLPConfig<boolean>('scrollSync');
    await updateMLPConfig('scrollSync', scrollSync, true);
    if (scrollSync) {
      vscode.window.showInformationMessage('Scroll Sync is enabled');
    } else {
      vscode.window.showInformationMessage('Scroll Sync is disabled');
    }
  }

  async function toggleLiveUpdate() {
    const liveUpdate = !getMLPConfig<boolean>('liveUpdate');
    await updateMLPConfig('liveUpdate', liveUpdate, true);
    if (liveUpdate) {
      vscode.window.showInformationMessage('Live Update is enabled');
    } else {
      vscode.window.showInformationMessage('Live Update is disabled');
    }
  }

  async function toggleBreakOnSingleNewLine() {
    const breakOnSingleNewLine = !getMLPConfig<boolean>('breakOnSingleNewLine');
    updateMLPConfig('breakOnSingleNewLine', breakOnSingleNewLine, true);
    if (breakOnSingleNewLine) {
      vscode.window.showInformationMessage(
        'Break On Single New Line is enabled',
      );
    } else {
      vscode.window.showInformationMessage(
        'Break On Single New Line is disabled',
      );
    }
  }

  function insertNewSlide() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document && editor.edit) {
      editor.edit((textEdit) => {
        textEdit.insert(editor.selection.active, '<!-- slide -->\n\n');
      });
    }
  }

  function insertPagebreak() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document && editor.edit) {
      editor.edit((textEdit) => {
        textEdit.insert(editor.selection.active, '<!-- pagebreak -->\n\n');
      });
    }
  }

  function createTOC() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document && editor.edit) {
      editor.edit((textEdit) => {
        textEdit.insert(editor.selection.active, '\n[TOC]\n');
      });
    }
  }

  function insertTable() {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document && editor.edit) {
      editor.edit((textEdit) => {
        textEdit.insert(
          editor.selection.active,
          `|   |   |
|---|---|
|   |   |
`,
        );
      });
    }
  }

  async function openImageHelper() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const uri = editor.document.uri;
    const previewProvider = await getPreviewContentProvider(uri);
    previewProvider.openImageHelper(uri);
  }

  async function webviewFinishLoading({
    uri,
    systemColorScheme,
  }: {
    uri: string;
    systemColorScheme: 'light' | 'dark';
  }) {
    const sourceUri = vscode.Uri.parse(uri);
    const previewProvider = await getPreviewContentProvider(sourceUri);
    previewManager.setSystemColorScheme(systemColorScheme);

    if (!previewProvider.shouldUpdateMarkdown(sourceUri)) {
      console.debug(
        `[MLP] Skipping webviewFinishLoading for stale sourceUri: ${sourceUri.fsPath}`,
      );
      return;
    }

    previewProvider.updateMarkdown(sourceUri);
  }

  function insertImageUrl(uri: string, imageUrl: string) {
    const sourceUri = vscode.Uri.parse(uri);
    vscode.window.visibleTextEditors
      .filter(
        (editor) =>
          isMarkdownFile(editor.document) &&
          editor.document.uri.fsPath === sourceUri.fsPath,
      )
      .forEach((editor) => {
        editor.edit((textEditorEdit) => {
          textEditorEdit.insert(
            editor.selection.active,
            `![enter image description here](${imageUrl})`,
          );
        });
      });
  }

  async function refreshPreview(uri: string) {
    const sourceUri = vscode.Uri.parse(uri);
    const previewProvider = await getPreviewContentProvider(sourceUri);
    previewProvider.refreshPreview(sourceUri);
  }

  async function syncPreview() {
    const textEditor = vscode.window.activeTextEditor;
    if (!textEditor?.document) {
      return;
    }
    if (!isMarkdownFile(textEditor.document)) {
      return;
    }

    const sourceUri = textEditor.document.uri;
    const previewProvider = await getPreviewContentProvider(sourceUri);
    previewProvider.postMessageToPreview(sourceUri, {
      command: 'changeTextEditorSelection',
      line: textEditor.selections[0].active.line,
      forced: true,
    });
  }

  function clickTaskListCheckbox(uri: string, dataLine: string) {
    const sourceUri = vscode.Uri.parse(uri);
    const visibleTextEditors = vscode.window.visibleTextEditors;
    for (let i = 0; i < visibleTextEditors.length; i++) {
      const editor = visibleTextEditors[i];
      if (editor.document.uri.fsPath === sourceUri.fsPath) {
        const lineNum = parseInt(dataLine, 10);
        editor.edit((edit) => {
          let line = editor.document.lineAt(lineNum).text;
          if (line.match(/\[ \]/)) {
            line = line.replace('[ ]', '[x]');
          } else {
            line = line.replace(/\[[xX]\]/, '[ ]');
          }
          edit.replace(
            new vscode.Range(
              new vscode.Position(lineNum, 0),
              new vscode.Position(lineNum, line.length),
            ),
            line,
          );
        });
        break;
      }
    }
  }

  function setPreviewTheme(_uri: string, theme: string) {
    updateMLPConfig('previewTheme', theme, true);
  }

  function togglePreviewZenMode(_uri: string) {
    updateMLPConfig(
      'enablePreviewZenMode',
      !getMLPConfig<boolean>('enablePreviewZenMode'),
      true,
    );
  }

  function setCodeBlockTheme(_uri: string, theme: string) {
    updateMLPConfig('codeBlockTheme', theme, true);
  }

  function setMermaidTheme(_uri: string, theme: string) {
    updateMLPConfig('mermaidTheme', theme, true);
  }

  function setMermaidAsciiMode(_uri: string, enabled: boolean) {
    updateMLPConfig('mermaidAsciiMode', enabled, true);
  }

  function setRevealjsTheme(_uri: string, theme: string) {
    updateMLPConfig('revealjsTheme', theme, true);
  }

  async function clickTagA({
    uri,
    href,
    scheme,
  }: {
    uri: string;
    href: string;
    scheme: string;
  }) {
    href = decodeURIComponent(href);

    // Resolve relative paths against the source file's directory
    if (!href.match(/^[a-zA-Z][a-zA-Z0-9+\-.]*:/) && !href.startsWith('#')) {
      // href is a relative path (e.g. "./math.md", "../foo.md", "bar.md")
      // or a workspace-root path (e.g. "/test/markdown/basics.md")
      try {
        const sourceUri = vscode.Uri.parse(uri);
        if (href.startsWith('/')) {
          // Workspace-root relative: resolve against workspace folder
          const workspaceFolder =
            vscode.workspace.getWorkspaceFolder(sourceUri);
          if (workspaceFolder) {
            href = vscode.Uri.joinPath(workspaceFolder.uri, href).toString();
          } else {
            href = vscode.Uri.joinPath(sourceUri, '..', href).toString();
          }
        } else {
          // File-relative path
          const dirUri = vscode.Uri.joinPath(sourceUri, '..');
          href = vscode.Uri.joinPath(dirUri, href).toString();
        }
      } catch {
        // Fall through with original href
      }
    }

    // Legacy: strip webview-origin prefixes for backward compatibility
    href = href
      .replace(/^vscode-resource:\/\//, '')
      .replace(/^vscode-webview-resource:\/\/(.+?)\//, '')
      .replace(/^file\/\/\//, `${scheme}:///`)
      .replace(
        /^https:\/\/file\+\.vscode-resource.vscode-cdn.net\//,
        `${scheme}:///`,
      )
      .replace(/^https:\/\/.+\.vscode-cdn.net\//, `${scheme}:///`)
      .replace(
        /^https?:\/\/(.+?)\.vscode-webview-test.com\/vscode-resource\/file\/+/,
        `${scheme}:///`,
      )
      .replace(
        /^https?:\/\/file(.+?)\.vscode-webview\.net\/+/,
        `${scheme}:///`,
      );
    if (
      ['.pdf', '.xls', '.xlsx', '.doc', '.ppt', '.docx', '.pptx'].indexOf(
        path.extname(href),
      ) >= 0
    ) {
      try {
        vscode.env.openExternal(vscode.Uri.parse(href));
      } catch (error) {
        vscode.window.showErrorMessage(String(error));
      }
    } else if (href.startsWith(`${scheme}://`)) {
      const openFilePath = decodeURI(href);
      const fileUri = vscode.Uri.parse(openFilePath);

      let line = -1;
      const found = fileUri.fragment.match(/^L(\d+)/);
      if (found) {
        line = parseInt(found[1], 10);
        if (line > 0) {
          line = line - 1;
        }
      }

      let col = vscode.ViewColumn.One;
      tgrLoop: for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          if (tab.input instanceof vscode.TabInputText) {
            if (tab.input.uri.path === fileUri.path) {
              col = tabGroup.viewColumn;
              break tgrLoop;
            }
          }
        }
      }

      let fileExists = false;
      try {
        fileExists = !!(await vscode.workspace.fs.stat(fileUri));
      } catch {
        fileExists = false;
      }

      if (fileExists) {
        const previewMode = getPreviewMode();
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(
            openFilePath.split('#').slice(0, -1).join('#') || openFilePath,
          ),
        );

        if (
          previewMode === PreviewMode.PreviewsOnly &&
          isMarkdownFile(document)
        ) {
          const previewProvider = await getPreviewContentProvider(fileUri);
          await previewProvider.initPreview({
            sourceUri: fileUri,
            document,
            cursorLine: line,
            viewOptions: {
              viewColumn: vscode.ViewColumn.Active,
              preserveFocus: true,
            },
          });
        } else {
          const editor = await vscode.window.showTextDocument(document, {
            viewColumn: col,
          });

          if (line >= 0) {
            let viewPos = vscode.TextEditorRevealType.InCenter;
            if (editor.selection.active.line === line) {
              viewPos = vscode.TextEditorRevealType.InCenterIfOutsideViewport;
            }
            const sel = new vscode.Selection(line, 0, line, 0);
            editor.selection = sel;
            editor.revealRange(sel, viewPos);
          } else if (fileUri.fragment) {
            // Find heading with this id
            const text = editor.document.getText();
            const lines = text.split('\n');
            let headingLine = -1;

            for (let i = 0; i < lines.length; i++) {
              const lineText = lines[i];
              if (lineText.match(/^#+\s+/)) {
                const heading = lineText.replace(/^#+\s+/, '');
                const headingId = heading
                  .toLowerCase()
                  .replace(/[^\w\s-]/g, '')
                  .replace(/\s+/g, '-');
                if (headingId === fileUri.fragment) {
                  headingLine = i;
                  break;
                }
              }
            }

            if (headingLine >= 0) {
              let viewPos = vscode.TextEditorRevealType.InCenter;
              if (editor.selection.active.line === headingLine) {
                viewPos = vscode.TextEditorRevealType.InCenterIfOutsideViewport;
              }
              const sel = new vscode.Selection(headingLine, 0, headingLine, 0);
              editor.selection = sel;
              editor.revealRange(sel, viewPos);
            }
          }
        }
      } else {
        vscode.commands.executeCommand(
          'vscode.open',
          fileUri,
          vscode.ViewColumn.One,
        );
      }
    } else if (href.match(/^https?:\/\//)) {
      vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(href));
    } else {
      vscode.env.openExternal(vscode.Uri.parse(href));
    }
  }

  async function openChangelog() {
    const url =
      'https://github.com/shd101wyy/vscode-markdown-live-preview/releases';
    return vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
  }

  async function openDocumentation() {
    const url = 'https://shd101wyy.github.io/markdown-live-preview/';
    return vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
  }

  async function openIssues() {
    const url =
      'https://github.com/shd101wyy/vscode-markdown-live-preview/issues';
    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
  }

  async function openSponsors() {
    const url = 'https://github.com/sponsors/baryon/';
    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
  }

  async function editSource(uri: string) {
    const sourceUri = vscode.Uri.parse(uri);
    await vscode.commands.executeCommand(
      'vscode.openWith',
      sourceUri,
      'default',
    );
  }

  async function openSideBySide(uri: string) {
    const sourceUri = vscode.Uri.parse(uri);
    const document = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
  }

  async function openExternalEditor(uri: string) {
    const sourceUri = vscode.Uri.parse(uri);
    const document = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Active,
    });
  }

  async function updateMarkdown(uri: string, markdown: string) {
    try {
      const sourceUri = vscode.Uri.parse(uri);
      await vscode.workspace.fs.writeFile(sourceUri, Buffer.from(markdown));
      const previewProvider = await getPreviewContentProvider(sourceUri);
      previewProvider.updateMarkdown(sourceUri);
    } catch (error) {
      vscode.window.showErrorMessage(String(error));
      console.error(error);
    }
  }

  // ─── Markdown open mode switching ────────────────────────────────────

  async function setMarkdownOpenMode(mode: string) {
    await updateMLPConfig('markdownOpenMode', mode, true);
    vscode.commands.executeCommand(
      'setContext',
      'markdown-live-preview.openMode',
      mode,
    );
  }

  async function switchToEditMode(uri?: vscode.Uri) {
    await setMarkdownOpenMode('edit');
    // Close any open preview panels for the current file
    const editor = vscode.window.activeTextEditor;
    const sourceUri = uri || editor?.document.uri;
    if (
      sourceUri &&
      isMarkdownFile(await vscode.workspace.openTextDocument(sourceUri))
    ) {
      const previewProvider = await getPreviewContentProvider(sourceUri);
      const previews = previewProvider.getPreviews(sourceUri);
      if (previews) {
        for (const p of previews) {
          p.dispose();
        }
      }
      // Ensure the editor is visible
      const doc = await vscode.workspace.openTextDocument(sourceUri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Active,
      });
    }
  }

  async function switchToPreviewMode(uri?: vscode.Uri) {
    await setMarkdownOpenMode('preview');
    const editor = vscode.window.activeTextEditor;
    const sourceUri = uri || editor?.document.uri;
    if (!sourceUri) return;
    const doc = await vscode.workspace.openTextDocument(sourceUri);
    if (!isMarkdownFile(doc)) return;

    const previewProvider = await getPreviewContentProvider(sourceUri);
    const cursorLine = editor ? getEditorActiveCursorLine(editor) : 0;
    await previewProvider.initPreview({
      sourceUri,
      document: doc,
      cursorLine,
      viewOptions: {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
      },
    });
  }

  async function switchToSideBySideMode(uri?: vscode.Uri) {
    await setMarkdownOpenMode('side-by-side');
    const editor = vscode.window.activeTextEditor;
    const sourceUri = uri || editor?.document.uri;
    if (!sourceUri) return;
    const doc = await vscode.workspace.openTextDocument(sourceUri);
    if (!isMarkdownFile(doc)) return;

    // Make sure editor is visible in column 1
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
    });

    const previewProvider = await getPreviewContentProvider(sourceUri);
    const cursorLine = editor ? getEditorActiveCursorLine(editor) : 0;
    await previewProvider.initPreview({
      sourceUri,
      document: doc,
      cursorLine,
      viewOptions: {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true,
      },
    });
  }

  // ─── Code chunk execution ───────────────────────────────────────────

  /**
   * Check if script execution is enabled. If not, show a warning with
   * an "Enable" button that directly turns on the setting.
   * Returns true if enabled, false if disabled.
   */
  async function ensureScriptExecutionEnabled(): Promise<boolean> {
    const enabled = getMLPConfig<boolean>('enableScriptExecution') ?? false;
    if (enabled) return true;

    const action = await vscode.window.showWarningMessage(
      'Code chunk script execution is disabled for security.',
      'Enable Script Execution',
      'Open Settings',
    );
    if (action === 'Enable Script Execution') {
      await updateMLPConfig('enableScriptExecution', true, true);
      vscode.commands.executeCommand(
        'setContext',
        'markdown-live-preview.enableScriptExecution',
        true,
      );
      return true;
    } else if (action === 'Open Settings') {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'markdown-live-preview.enableScriptExecution',
      );
    }
    return false;
  }

  async function runCodeChunk(uri: string, chunkId: string) {
    const sourceUri = vscode.Uri.parse(uri);
    if (!(await ensureScriptExecutionEnabled())) return;

    const previewProvider = await getPreviewContentProvider(sourceUri);
    const document = await vscode.workspace.openTextDocument(sourceUri);
    const manager = getCodeChunkManager(sourceUri.toString());
    manager.parseChunks(document.getText());

    // Signal running state to webview
    await previewProvider.postMessageToPreview(sourceUri, {
      command: 'codeChunkRunning',
      chunkId,
    });

    const workingDir = path.dirname(sourceUri.fsPath);

    // Check if this is a browser JS chunk
    const chunk = manager.getChunk(chunkId);
    if (
      chunk?.attrs.element &&
      (chunk.language === 'javascript' || chunk.language === 'js')
    ) {
      await previewProvider.postMessageToPreview(sourceUri, {
        command: 'executeBrowserJs',
        chunkId,
        code: chunk.code,
        element: chunk.attrs.element,
      });
      return;
    }

    const result = await manager.runChunk(chunkId, workingDir);
    if (result) {
      await previewProvider.postMessageToPreview(sourceUri, {
        command: 'codeChunkResult',
        chunkId,
        html: result.result,
        status: result.status,
      });

      // Handle modify_source
      if (result.attrs.modify_source && result.result) {
        await insertCodeChunkOutput(sourceUri, result);
      }
    }
  }

  async function runAllCodeChunks(uri: string) {
    const sourceUri = vscode.Uri.parse(uri);
    if (!(await ensureScriptExecutionEnabled())) return;

    const previewProvider = await getPreviewContentProvider(sourceUri);
    const document = await vscode.workspace.openTextDocument(sourceUri);
    const manager = getCodeChunkManager(sourceUri.toString());
    manager.parseChunks(document.getText());
    const workingDir = path.dirname(sourceUri.fsPath);

    for (const chunkId of manager.getChunkIds()) {
      await previewProvider.postMessageToPreview(sourceUri, {
        command: 'codeChunkRunning',
        chunkId,
      });

      const result = await manager.runChunk(chunkId, workingDir);
      if (result) {
        await previewProvider.postMessageToPreview(sourceUri, {
          command: 'codeChunkResult',
          chunkId,
          html: result.result,
          status: result.status,
        });
      }
    }
  }

  async function runCodeChunkAtCursor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isMarkdownFile(editor.document)) {
      return;
    }

    if (!(await ensureScriptExecutionEnabled())) return;

    const sourceUri = editor.document.uri;
    const cursorLine = editor.selection.active.line;
    const manager = getCodeChunkManager(sourceUri.toString());
    manager.parseChunks(editor.document.getText());

    const chunk = manager.findChunkAtLine(cursorLine);
    if (chunk) {
      await runCodeChunk(sourceUri.toString(), chunk.id);
    } else {
      vscode.window.showInformationMessage(
        'No code chunk found at cursor position.',
      );
    }
  }

  async function insertCodeChunkOutput(
    sourceUri: vscode.Uri,
    chunk: { line: number; code: string; result: string },
  ) {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.fsPath === sourceUri.fsPath,
    );
    if (editors.length === 0) return;

    const editor = editors[0];
    const text = editor.document.getText();
    const lines = text.split('\n');

    // Find the closing fence after the chunk's start line
    let endLine = chunk.line;
    let fenceStarted = false;
    for (let i = chunk.line; i < lines.length; i++) {
      if (!fenceStarted && lines[i].match(/^`{3,}/)) {
        fenceStarted = true;
        continue;
      }
      if (fenceStarted && lines[i].match(/^`{3,}\s*$/)) {
        endLine = i;
        break;
      }
    }

    // Check if there's already an output block
    const outputStart = '<!-- code_chunk_output -->';
    const outputEnd = '<!-- /code_chunk_output -->';
    let insertLine = endLine + 1;
    let replaceEnd = insertLine;

    if (insertLine < lines.length && lines[insertLine].trim() === '') {
      insertLine++;
    }
    if (insertLine < lines.length && lines[insertLine].trim() === outputStart) {
      // Find the end marker
      for (let i = insertLine; i < lines.length; i++) {
        if (lines[i].trim() === outputEnd) {
          replaceEnd = i + 1;
          break;
        }
      }
    } else {
      replaceEnd = endLine + 1;
      insertLine = endLine + 1;
    }

    // Plain text output for source insertion
    const plainOutput = chunk.result
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    const outputBlock = `\n${outputStart}\n${plainOutput}\n${outputEnd}\n`;

    await editor.edit((editBuilder) => {
      const range = new vscode.Range(
        new vscode.Position(endLine + 1, 0),
        new vscode.Position(replaceEnd, 0),
      );
      editBuilder.replace(range, outputBlock);
    });
  }

  // Register event handlers
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (isMarkdownFile(document)) {
        const previewProvider = await getPreviewContentProvider(document.uri);
        previewProvider.updateMarkdown(document.uri, true);

        // Run code chunks with run_on_save=true
        const scriptExec =
          getMLPConfig<boolean>('enableScriptExecution') ?? false;
        if (scriptExec) {
          const manager = getCodeChunkManager(document.uri.toString());
          manager.parseChunks(document.getText());
          if (manager.hasRunOnSaveChunks()) {
            const workingDir = path.dirname(document.uri.fsPath);
            const results = await manager.runOnSaveChunks(workingDir);
            for (const result of results) {
              await previewProvider.postMessageToPreview(document.uri, {
                command: 'codeChunkResult',
                chunkId: result.id,
                html: result.result,
                status: result.status,
              });
            }
          }
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (isMarkdownFile(event.document)) {
        const previewProvider = await getPreviewContentProvider(
          event.document.uri,
        );
        previewProvider.update(event.document.uri);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('markdown-live-preview')) {
        // Update enableScriptExecution context key
        if (
          event.affectsConfiguration(
            'markdown-live-preview.enableScriptExecution',
          )
        ) {
          const enabled =
            getMLPConfig<boolean>('enableScriptExecution') ?? false;
          vscode.commands.executeCommand(
            'setContext',
            'markdown-live-preview.enableScriptExecution',
            enabled,
          );
        }

        // Update markdownOpenMode context key
        if (
          event.affectsConfiguration('markdown-live-preview.markdownOpenMode')
        ) {
          const mode =
            getMLPConfig<string>('markdownOpenMode') ?? 'side-by-side';
          vscode.commands.executeCommand(
            'setContext',
            'markdown-live-preview.openMode',
            mode,
          );
        }

        // Refresh all previews when config changes
        const providers = Array.from(
          (
            globalThis as unknown as {
              WORKSPACE_PREVIEW_PROVIDER_MAP: Map<string, PreviewProvider>;
            }
          ).WORKSPACE_PREVIEW_PROVIDER_MAP?.values() || [],
        );
        providers.forEach((provider) => {
          provider.refreshAllPreviews();
        });
      }
    }),
  );

  // Scroll sync: editor cursor click/keyboard → preview
  // Only fires for explicit user actions (mouse click, keyboard nav), not programmatic
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async (event) => {
      // Only handle explicit user actions (mouse click or keyboard navigation)
      if (
        event.kind !== vscode.TextEditorSelectionChangeKind.Mouse &&
        event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard
      ) {
        return;
      }

      if (!getMLPConfig<boolean>('scrollSync')) {
        return;
      }

      if (!isMarkdownFile(event.textEditor.document)) {
        return;
      }

      const previewMode = getPreviewMode();
      if (previewMode === PreviewMode.PreviewsOnly) {
        return;
      }

      if (Date.now() < editorScrollDelay) {
        return;
      }

      const firstVisibleScreenRow = getTopVisibleLine(event.textEditor);
      const lastVisibleScreenRow = getBottomVisibleLine(event.textEditor);

      if (
        typeof firstVisibleScreenRow === 'undefined' ||
        typeof lastVisibleScreenRow === 'undefined'
      ) {
        return;
      }

      const topRatio =
        (event.selections[0].active.line - firstVisibleScreenRow) /
        (lastVisibleScreenRow - firstVisibleScreenRow);

      const previewProvider = await getPreviewContentProvider(
        event.textEditor.document.uri,
      );
      previewProvider.postMessageToPreview(event.textEditor.document.uri, {
        command: 'changeTextEditorSelection',
        line: event.selections[0].active.line,
        topRatio,
      });
    }),
  );

  // Scroll sync: editor scroll → preview
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges(async (event) => {
      if (!getMLPConfig<boolean>('scrollSync')) {
        return;
      }

      const textEditor = event.textEditor;
      if (Date.now() < editorScrollDelay) {
        return;
      }
      if (isMarkdownFile(textEditor.document)) {
        const sourceUri = textEditor.document.uri;
        if (!event.textEditor.visibleRanges.length) {
          return undefined;
        } else {
          const topLine = getTopVisibleLine(textEditor);
          const bottomLine = getBottomVisibleLine(textEditor);

          if (
            typeof topLine === 'undefined' ||
            typeof bottomLine === 'undefined'
          ) {
            return;
          }

          let midLine: number;
          if (topLine === 0) {
            midLine = 0;
          } else if (
            Math.floor(bottomLine) ===
            textEditor.document.lineCount - 1
          ) {
            midLine = bottomLine;
          } else {
            midLine = Math.floor((topLine + bottomLine) / 2);
          }
          const previewProvider = await getPreviewContentProvider(sourceUri);
          previewProvider.postMessageToPreview(sourceUri, {
            command: 'changeTextEditorSelection',
            line: midLine,
          });
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor?.document?.uri) {
        const exclusionSchemes =
          getMLPConfig<string[]>('disableAutoPreviewForUriSchemes') ?? [];

        for (const scheme of exclusionSchemes) {
          if (editor.document.uri.scheme.startsWith(scheme)) {
            return;
          }
        }

        if (isMarkdownFile(editor.document)) {
          const sourceUri = editor.document.uri;
          const automaticallyShowPreviewOfMarkdownBeingEdited =
            getMLPConfig<boolean>(
              'automaticallyShowPreviewOfMarkdownBeingEdited',
            );
          const previewMode = getPreviewMode();
          const openMode = getMarkdownOpenMode();

          const previewProvider = await getPreviewContentProvider(sourceUri);

          // Suppress auto-reopen if user just closed a preview
          if (previewProvider.wasRecentlyClosed()) {
            return;
          }

          // Auto-open based on markdownOpenMode
          if (openMode === 'preview') {
            if (!previewProvider.isPreviewOn(sourceUri)) {
              await previewProvider.initPreview({
                sourceUri,
                document: editor.document,
                cursorLine: getEditorActiveCursorLine(editor),
                viewOptions: {
                  viewColumn: vscode.ViewColumn.Active,
                  preserveFocus: false,
                },
              });
            } else if (
              previewMode === PreviewMode.SinglePreview &&
              !previewProvider.previewHasTheSameSingleSourceUri(sourceUri)
            ) {
              await previewProvider.initPreview({
                sourceUri,
                document: editor.document,
                cursorLine: getEditorActiveCursorLine(editor),
                viewOptions: {
                  viewColumn:
                    previewProvider.getPreviews(sourceUri)?.at(0)?.viewColumn ??
                    vscode.ViewColumn.Active,
                  preserveFocus: false,
                },
              });
            }
          } else if (openMode === 'side-by-side') {
            if (!previewProvider.isPreviewOn(sourceUri)) {
              openPreviewToTheSide(sourceUri);
            } else if (
              previewMode === PreviewMode.SinglePreview &&
              !previewProvider.previewHasTheSameSingleSourceUri(sourceUri)
            ) {
              await previewProvider.initPreview({
                sourceUri,
                document: editor.document,
                cursorLine: getEditorActiveCursorLine(editor),
                viewOptions: {
                  viewColumn:
                    previewProvider.getPreviews(sourceUri)?.at(0)?.viewColumn ??
                    vscode.ViewColumn.Two,
                  preserveFocus: true,
                },
              });
            } else if (previewMode === PreviewMode.MultiplePreviews) {
              const previews = previewProvider.getPreviews(sourceUri);
              if (previews && previews.length > 0) {
                previews[0].reveal(undefined, true);
              }
            }
          } else {
            // edit mode — only handle existing previews if user opens them manually
            if (previewProvider.isPreviewOn(sourceUri)) {
              if (
                previewMode === PreviewMode.SinglePreview &&
                !previewProvider.previewHasTheSameSingleSourceUri(sourceUri)
              ) {
                await previewProvider.initPreview({
                  sourceUri,
                  document: editor.document,
                  cursorLine: getEditorActiveCursorLine(editor),
                  viewOptions: {
                    viewColumn:
                      previewProvider.getPreviews(sourceUri)?.at(0)
                        ?.viewColumn ?? vscode.ViewColumn.One,
                    preserveFocus: true,
                  },
                });
              } else if (previewMode === PreviewMode.MultiplePreviews) {
                const previews = previewProvider.getPreviews(sourceUri);
                if (previews && previews.length > 0) {
                  previews[0].reveal(undefined, true);
                }
              }
            } else if (automaticallyShowPreviewOfMarkdownBeingEdited) {
              openPreviewToTheSide(sourceUri);
            }
          }
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme((_theme) => {
      if (
        getMLPConfig<PreviewColorScheme>('previewColorScheme') ===
        PreviewColorScheme.editorColorScheme
      ) {
        previewManager.refreshAllPreviews();
      }
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.openPreviewToTheSide',
      openPreviewToTheSide,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.openPreview',
      openPreview,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.toggleScrollSync',
      toggleScrollSync,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.toggleLiveUpdate',
      toggleLiveUpdate,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.toggleBreakOnSingleNewLine',
      toggleBreakOnSingleNewLine,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.openImageHelper',
      openImageHelper,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.syncPreview',
      syncPreview,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.insertNewSlide',
      insertNewSlide,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.insertTable',
      insertTable,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.insertPagebreak',
      insertPagebreak,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.createTOC',
      createTOC,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.revealLine', revealLine),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.insertImageUrl', insertImageUrl),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.pasteImageFile', pasteImageFile),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.refreshPreview', refreshPreview),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      '_mlp.webviewFinishLoading',
      webviewFinishLoading,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      '_mlp.clickTaskListCheckbox',
      clickTaskListCheckbox,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.setPreviewTheme', setPreviewTheme),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      '_mlp.togglePreviewZenMode',
      togglePreviewZenMode,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      '_mlp.setCodeBlockTheme',
      setCodeBlockTheme,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.setMermaidTheme', setMermaidTheme),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      '_mlp.setMermaidAsciiMode',
      setMermaidAsciiMode,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.setRevealjsTheme', setRevealjsTheme),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.openChangelog', openChangelog),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      '_mlp.openDocumentation',
      openDocumentation,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.openIssues', openIssues),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.openSponsors', openSponsors),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.editSource', editSource),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.openSideBySide', openSideBySide),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      '_mlp.openExternalEditor',
      openExternalEditor,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.clickTagA', clickTagA),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.updateMarkdown', updateMarkdown),
  );

  // Markdown open mode commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.switchToEditMode',
      switchToEditMode,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.switchToPreviewMode',
      switchToPreviewMode,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.switchToSideBySideMode',
      switchToSideBySideMode,
    ),
  );

  // Code chunk commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.runCodeChunk',
      runCodeChunkAtCursor,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.runAllCodeChunks',
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && isMarkdownFile(editor.document)) {
          await runAllCodeChunks(editor.document.uri.toString());
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.runCodeChunk', runCodeChunk),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('_mlp.runAllCodeChunks', runAllCodeChunks),
  );

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'markdown-live-preview',
      new PreviewCustomEditorProvider(context),
    ),
  );
}

function revealLine(uri: string, line: number) {
  if (!getMLPConfig<boolean>('scrollSync')) {
    return;
  }

  const sourceUri = vscode.Uri.parse(uri);

  vscode.window.visibleTextEditors
    .filter(
      (editor) =>
        isMarkdownFile(editor.document) &&
        editor.document.uri.fsPath === sourceUri.fsPath,
    )
    .forEach((editor) => {
      const sourceLine = Math.min(
        Math.floor(line),
        editor.document.lineCount - 1,
      );

      // Check if line is already visible — skip scroll to avoid jumps
      const topLine = getTopVisibleLine(editor);
      const bottomLine = getBottomVisibleLine(editor);
      if (
        typeof topLine !== 'undefined' &&
        typeof bottomLine !== 'undefined'
      ) {
        const margin = (bottomLine - topLine) * 0.15;
        if (sourceLine >= topLine + margin && sourceLine <= bottomLine - margin) {
          return; // Line already visible with margin, no need to scroll
        }
      }

      const fraction = line - sourceLine;
      const text = editor.document.lineAt(sourceLine).text;
      const start = Math.floor(fraction * text.length);
      editorScrollDelay = Date.now() + 500;
      editor.revealRange(
        new vscode.Range(sourceLine, start, sourceLine + 1, 0),
        vscode.TextEditorRevealType.Default,
      );
      editorScrollDelay = Date.now() + 500;
    });
}
