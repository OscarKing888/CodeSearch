import * as path from 'path';
import * as vscode from 'vscode';
import { IndexManager } from '../index/IndexManager';
import {
  FileCandidate,
  isHeaderSourceFile,
  rankCounterparts,
  toFileCandidate,
  topTiedCounterparts,
} from './headerSourcePairing';
import { openCounterpartFile } from './openCounterpartFile';

export async function switchHeaderSource(indexManager: IndexManager | undefined): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const currentPath = editor.document.uri.fsPath;
  if (!isHeaderSourceFile(currentPath)) {
    return;
  }

  if (!indexManager) {
    void vscode.window.showInformationMessage('Ace Code Search: 索引中未找到配对文件');
    return;
  }

  const preferred: FileCandidate[] = [];
  const fallback: FileCandidate[] = [];

  for (const service of indexManager.getAllServices()) {
    const inIndex = service.fileExistsInIndex(currentPath);
    const counterparts = service.findHeaderSourceCounterparts(currentPath);
    const mapped = counterparts.map((candidatePath) =>
      toFileCandidate(indexManager.mapHitPath(service.id, candidatePath))
    );

    if (inIndex) {
      preferred.push(...mapped);
    } else {
      fallback.push(...mapped);
    }
  }

  const sourceCandidates = preferred.length > 0 ? preferred : fallback;
  const uniqueByPath = new Map<string, FileCandidate>();
  for (const candidate of sourceCandidates) {
    uniqueByPath.set(path.resolve(candidate.path), candidate);
  }

  const ranked = rankCounterparts(currentPath, Array.from(uniqueByPath.values()));
  if (ranked.length === 0) {
    void vscode.window.showInformationMessage('Ace Code Search: 索引中未找到配对文件');
    return;
  }

  const tied = topTiedCounterparts(currentPath, ranked);
  let target = tied[0];

  if (tied.length > 1) {
    const pick = await vscode.window.showQuickPick(
      tied.map((candidatePath) => ({
        label: path.basename(candidatePath),
        description: candidatePath,
        path: candidatePath,
      })),
      { placeHolder: '选择要打开的头/源文件' }
    );
    if (!pick) {
      return;
    }
    target = pick.path;
  }

  await openCounterpartFile(target);
}
