import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getProfileLogDir, LATEST_PROFILE_FILENAME } from './searchProfile';

export async function revealProfileLogFolder(context: vscode.ExtensionContext): Promise<void> {
  const dir = getProfileLogDir(context.globalStorageUri.fsPath);
  fs.mkdirSync(dir, { recursive: true });
  const latestPath = path.join(dir, LATEST_PROFILE_FILENAME);
  if (fs.existsSync(latestPath)) {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(latestPath));
    return;
  }
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
}
