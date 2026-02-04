/**
 * Image helper - handles image paste and upload operations
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getMLPConfig } from './config';
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

function replaceHint(
  editor: vscode.TextEditor,
  line: number,
  hint: string,
  withStr: string,
): boolean {
  const textLine = editor.document.lineAt(line);
  if (textLine.text.indexOf(hint) >= 0) {
    editor.edit((textEdit) => {
      textEdit.replace(
        new vscode.Range(
          new vscode.Position(line, 0),
          new vscode.Position(line, textLine.text.length),
        ),
        textLine.text.replace(hint, withStr),
      );
    });
    return true;
  }
  return false;
}

function setUploadedImageURL(
  imageFileName: string,
  url: string,
  editor: vscode.TextEditor,
  hint: string,
  curPos: vscode.Position,
) {
  let description: string;
  if (imageFileName.lastIndexOf('.')) {
    description = imageFileName.slice(0, imageFileName.lastIndexOf('.'));
  } else {
    description = imageFileName;
  }

  const withStr = `![${description}](${url})`;

  if (!replaceHint(editor, curPos.line, hint, withStr)) {
    let i = curPos.line - 20;
    while (i <= curPos.line + 20) {
      if (replaceHint(editor, i, hint, withStr)) {
        break;
      }
      i++;
    }
  }
}

/**
 * Upload image to image host service
 * Note: Image upload functionality requires external API integration
 */
async function uploadImage(
  _imagePath: string,
  _options: {
    method: string;
    qiniu?: {
      AccessKey: string;
      SecretKey: string;
      Bucket: string;
      Domain: string;
    };
  },
): Promise<string> {
  // Image upload service is not yet implemented
  // This would require integration with various image hosting APIs
  throw new Error(
    'Image upload is not yet implemented. Please use local image storage for now.',
  );
}

/**
 * Upload image at imageFilePath to config.imageUploader.
 * Then insert markdown image url to markdown file.
 */
export function uploadImageFile(
  sourceUri: unknown,
  imageFilePath: string,
  imageUploader: string,
) {
  if (typeof sourceUri === 'string') {
    sourceUri = vscode.Uri.parse(sourceUri);
  }
  const uri = sourceUri as vscode.Uri;
  const imageFileName = path.basename(imageFilePath);

  vscode.window.visibleTextEditors
    .filter(
      (editor) =>
        isMarkdownFile(editor.document) &&
        editor.document.uri.fsPath === uri.fsPath,
    )
    .forEach((editor) => {
      const uid = Math.random().toString(36).substr(2, 9);
      const hint = `![Uploading ${imageFileName}… (${uid})]()`;
      const curPos = editor.selection.active;

      editor.edit((textEditorEdit) => {
        textEditorEdit.insert(curPos, hint);
      });

      const AccessKey = getMLPConfig<string>('qiniuAccessKey') || '';
      const SecretKey = getMLPConfig<string>('qiniuSecretKey') || '';
      const Bucket = getMLPConfig<string>('qiniuBucket') || '';
      const Domain = getMLPConfig<string>('qiniuDomain') || '';

      uploadImage(imageFilePath, {
        method: imageUploader,
        qiniu: { AccessKey, SecretKey, Bucket, Domain },
      })
        .then((url) => {
          setUploadedImageURL(imageFileName, url, editor, hint, curPos);
        })
        .catch((error) => {
          // Remove the uploading hint and show error
          replaceHint(editor, curPos.line, hint, '');
          vscode.window.showErrorMessage(error.toString());
        });
    });
}
