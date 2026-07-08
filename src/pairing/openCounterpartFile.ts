import * as path from 'path';
import * as vscode from 'vscode';
import { isBinaryExtension } from '../index/FileScanner';

export async function openCounterpartFile(filePath: string): Promise<void> {
  if (isBinaryExtension(filePath)) {
    void vscode.window.showWarningMessage(`Ace Code Search: 无法打开二进制文件 ${filePath}`);
    return;
  }

  const normalized = path.resolve(filePath);
  const existing = vscode.window.visibleTextEditors.find(
    (editor) => path.resolve(editor.document.uri.fsPath) === normalized
  );
  if (existing) {
    await vscode.window.showTextDocument(existing.document, { viewColumn: existing.viewColumn });
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Active,
    preview: false,
  });
}
