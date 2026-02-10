/**
 * Image helper - handles image paste and upload operations
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getWorkspaceFolderUri, isMarkdownFile } from './utils';

/**
 * Copy and paste image at imageFilePath to config.imageFolderPath.
 * Then insert markdown image url to markdown file.
 */
export function pasteImageFile(sourceUri: string, imageFilePath: string) {
  const uri = vscode.Uri.parse(sourceUri);

  const imageFolderPath =
    vscode.workspace
      .getConfiguration('markdown-live-preview')
      .get<string>('imageFolderPath') ?? '';
  let imageFileName = path.basename(imageFilePath);
  const projectDirectoryPath = getWorkspaceFolderUri(uri).fsPath;
  if (!projectDirectoryPath) {
    return vscode.window.showErrorMessage('Cannot find workspace');
  }

  let assetDirectoryPath: string;
  let description: string;
  if (imageFolderPath[0] === '/') {
    assetDirectoryPath = path.resolve(
      projectDirectoryPath,
      `.${imageFolderPath}`,
    );
  } else {
    assetDirectoryPath = path.resolve(
      path.dirname(uri.fsPath),
      imageFolderPath,
    );
  }

  const destPath = path.resolve(
    assetDirectoryPath,
    path.basename(imageFilePath),
  );

  vscode.window.visibleTextEditors
    .filter(
      (editor) =>
        isMarkdownFile(editor.document) &&
        editor.document.uri.fsPath === uri.fsPath,
    )
    .forEach((editor) => {
      fs.mkdir(assetDirectoryPath, { recursive: true }, (_error) => {
        fs.stat(destPath, (err, _stat) => {
          if (err == null) {
            // file existed
            const lastDotOffset = imageFileName.lastIndexOf('.');
            const uid = `_${Math.random().toString(36).substr(2, 9)}`;

            if (lastDotOffset > 0) {
              description = imageFileName.slice(0, lastDotOffset);
              imageFileName =
                imageFileName.slice(0, lastDotOffset) +
                uid +
                imageFileName.slice(lastDotOffset, imageFileName.length);
            } else {
              description = imageFileName;
              imageFileName = imageFileName + uid;
            }

            fs.createReadStream(imageFilePath).pipe(
              fs.createWriteStream(
                path.resolve(assetDirectoryPath, imageFileName),
              ),
            );
          } else if (err.code === 'ENOENT') {
            // file doesn't exist
            fs.createReadStream(imageFilePath).pipe(
              fs.createWriteStream(destPath),
            );

            if (imageFileName.lastIndexOf('.')) {
              description = imageFileName.slice(
                0,
                imageFileName.lastIndexOf('.'),
              );
            } else {
              description = imageFileName;
            }
          } else {
            return vscode.window.showErrorMessage(err.toString());
          }

          vscode.window.showInformationMessage(
            `Image ${imageFileName} has been copied to folder ${assetDirectoryPath}`,
          );

          let url = `${imageFolderPath}/${imageFileName}`;
          if (url.indexOf(' ') >= 0) {
            url = url.replace(/ /g, '%20');
          }

          editor.edit((textEditorEdit) => {
            textEditorEdit.insert(
              editor.selection.active,
              `![${description}](${url})`,
            );
          });
        });
      });
    });
}
