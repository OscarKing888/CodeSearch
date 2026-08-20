import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isBinaryExtension } from '../index/FileScanner';
import {
  formatOpenEditorFailureMessage,
  openWithFallback,
} from '../ui/openEditorFallback';

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

  const uri = vscode.Uri.file(normalized);
  const showOptions: vscode.TextDocumentShowOptions = {
    viewColumn: vscode.ViewColumn.Active,
    preview: false,
  };
  const result = await openWithFallback({
    openViaDocument: async () => {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, showOptions);
    },
    openViaCommand: async () => {
      await vscode.commands.executeCommand('vscode.open', uri, showOptions);
    },
    fileExists: () => fs.existsSync(normalized),
  });

  if (result.outcome === 'failed') {
    void vscode.window.showErrorMessage(formatOpenEditorFailureMessage(normalized, result));
  }
}
