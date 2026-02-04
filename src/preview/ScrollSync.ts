/**
 * Scroll Sync - synchronizes scroll between editor and preview
 */

import * as vscode from 'vscode';
import { getMLPConfig } from '../config/ConfigManager';
import { getBottomVisibleLine, getTopVisibleLine } from '../utils/index';
import { getPreviewManager } from './PreviewManager';

/**
 * Scroll sync delay to prevent infinite loops
 */
let editorScrollDelay = 0;

/**
 * Set scroll delay
 */
export function setEditorScrollDelay(delay: number): void {
  editorScrollDelay = Date.now() + delay;
}

/**
 * Check if scroll sync is enabled
 */
export function isScrollSyncEnabled(): boolean {
  return getMLPConfig<boolean>('scrollSync') ?? true;
}

/**
 * Handle editor selection change - sync to preview
 */
export async function handleEditorSelectionChange(
  event: vscode.TextEditorSelectionChangeEvent,
): Promise<void> {
  if (!isScrollSyncEnabled()) {
    return;
  }

  const textEditor = event.textEditor;
  const sourceUri = textEditor.document.uri;

  // Calculate position
  const firstVisibleLine = getTopVisibleLine(textEditor);
  const lastVisibleLine = getBottomVisibleLine(textEditor);

  if (firstVisibleLine === undefined || lastVisibleLine === undefined) {
    return;
  }

  const activeLine = event.selections[0].active.line;
  const topRatio =
    (activeLine - firstVisibleLine) / (lastVisibleLine - firstVisibleLine);

  // Send to preview
  const previewManager = getPreviewManager();
  await previewManager.postMessageToPreview(sourceUri, {
    command: 'changeTextEditorSelection',
    line: activeLine,
    topRatio,
  });
}

/**
 * Handle editor visible range change - sync to preview
 */
export async function handleEditorVisibleRangeChange(
  event: vscode.TextEditorVisibleRangesChangeEvent,
): Promise<void> {
  if (!isScrollSyncEnabled()) {
    return;
  }

  // Check scroll delay
  if (Date.now() < editorScrollDelay) {
    return;
  }

  const textEditor = event.textEditor;
  const sourceUri = textEditor.document.uri;

  if (!event.textEditor.visibleRanges.length) {
    return;
  }

  const topLine = getTopVisibleLine(textEditor);
  const bottomLine = getBottomVisibleLine(textEditor);

  if (topLine === undefined || bottomLine === undefined) {
    return;
  }

  // Calculate middle line
  let midLine: number;
  if (topLine === 0) {
    midLine = 0;
  } else if (Math.floor(bottomLine) === textEditor.document.lineCount - 1) {
    midLine = bottomLine;
  } else {
    midLine = Math.floor((topLine + bottomLine) / 2);
  }

  // Send to preview
  const previewManager = getPreviewManager();
  await previewManager.postMessageToPreview(sourceUri, {
    command: 'changeTextEditorSelection',
    line: midLine,
  });
}

/**
 * Handle preview scroll - sync to editor (called from webview message)
 */
export function handlePreviewScroll(sourceUri: vscode.Uri, line: number): void {
  if (!isScrollSyncEnabled()) {
    return;
  }

  // Find editors for this source
  const editors = vscode.window.visibleTextEditors.filter(
    (editor) => editor.document.uri.fsPath === sourceUri.fsPath,
  );

  for (const editor of editors) {
    const sourceLine = Math.min(
      Math.floor(line),
      editor.document.lineCount - 1,
    );
    const fraction = line - sourceLine;
    const text = editor.document.lineAt(sourceLine).text;
    const start = Math.floor(fraction * text.length);

    // Set delay to prevent infinite loop
    setEditorScrollDelay(500);

    editor.revealRange(
      new vscode.Range(sourceLine, start, sourceLine + 1, 0),
      vscode.TextEditorRevealType.InCenter,
    );
  }
}

/**
 * Sync preview to editor cursor position
 */
export async function syncPreviewToEditor(
  textEditor: vscode.TextEditor,
): Promise<void> {
  const sourceUri = textEditor.document.uri;
  const line = textEditor.selections[0].active.line;

  const previewManager = getPreviewManager();
  await previewManager.postMessageToPreview(sourceUri, {
    command: 'changeTextEditorSelection',
    line,
    forced: true,
  });
}
