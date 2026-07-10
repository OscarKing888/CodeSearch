import type * as vscode from 'vscode';
import type { IndexManager } from '../index/IndexManager';

export function registerHeaderSourceCommandOverrides(
  _context: vscode.ExtensionContext,
  _getIndexManager: () => IndexManager | undefined,
  _ensureReady: () => Promise<boolean>
): void {
  // Kept as a compatibility no-op for code importing the former internal helper.
  // Third-party command IDs belong to their extensions and must not be re-registered.
}
