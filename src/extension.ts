/**
 * Extension entry point for Node.js environment
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { initExtensionCommon } from './extension-common';
import { globalConfigPath } from './utils';

/**
 * This method is called when the extension is activated
 */
export async function activate(context: vscode.ExtensionContext) {
  try {
    // Create global config directory if it doesn't exist
    if (!fs.existsSync(globalConfigPath)) {
      fs.mkdirSync(globalConfigPath, { recursive: true });
    }

    // Watch for changes in global config directory
    // (style.less, config.js, parser.js, head.html)
    fs.watch(globalConfigPath, async (eventType, fileName) => {
      if (
        eventType === 'change' &&
        ['style.less', 'config.js', 'parser.js', 'head.html'].includes(
          fileName ?? '',
        )
      ) {
        // Config files changed - refresh previews
        // This will be handled by the PreviewManager
      }
    });
  } catch (error) {
    console.error('Error initializing global config:', error);
  }

  // Initialize the common extension module
  await initExtensionCommon(context);

  // Register native-only commands

  function customizeCSS() {
    const globalStyleLessFile = `file://${path.resolve(
      globalConfigPath,
      './style.less',
    )}`;
    vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.parse(globalStyleLessFile),
    );
  }

  function openConfigScript() {
    const configScriptPath = `file://${path.resolve(
      globalConfigPath,
      './config.js',
    )}`;
    vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.parse(configScriptPath),
    );
  }

  function extendParser() {
    const parserConfigPath = `file://${path.resolve(
      globalConfigPath,
      './parser.js',
    )}`;
    vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.parse(parserConfigPath),
    );
  }

  function customizePreviewHtmlHead() {
    const headHtmlPath = `file://${path.resolve(
      globalConfigPath,
      './head.html',
    )}`;
    vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.parse(headHtmlPath),
    );
  }

  function showUploadedImages() {
    const imageHistoryFilePath = `file://${path.resolve(
      globalConfigPath,
      './image_history.md',
    )}`;
    vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.parse(imageHistoryFilePath),
    );
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.customizeCss',
      customizeCSS,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.openConfigScript',
      openConfigScript,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.extendParser',
      extendParser,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.customizePreviewHtmlHead',
      customizePreviewHtmlHead,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'markdown-live-preview.showUploadedImages',
      showUploadedImages,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      '_mlp.showUploadedImageHistory',
      showUploadedImages,
    ),
  );
}
