import * as vscode from 'vscode';
import { isBinaryExtension } from '../index/FileScanner';

export interface CodeLocation {
  path: string;
  line: number;
  column: number;
}

export async function openCodeLocation(
  location: CodeLocation,
  options: { preview?: boolean; viewColumn?: vscode.ViewColumn } = {}
): Promise<void> {
  if (isBinaryExtension(location.path)) {
    void vscode.window.showWarningMessage(
      `Ace Code Search: 无法打开二进制文件 ${location.path}`
    );
    return;
  }

  const line = Math.max(1, Math.floor(location.line || 1));
  const column = Math.max(1, Math.floor(location.column || 1));
  const uri = vscode.Uri.file(location.path);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(line - 1, column - 1, line - 1, column - 1),
    viewColumn: options.viewColumn ?? vscode.ViewColumn.Active,
    preview: options.preview ?? true,
  });
}
