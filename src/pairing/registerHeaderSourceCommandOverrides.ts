import * as vscode from 'vscode';
import { IndexManager } from '../index/IndexManager';
import { switchHeaderSource } from './switchHeaderSource';

const HIJACK_COMMANDS = [
  'C_Cpp.SwitchHeaderSource',
  'clangd.switchheadersource',
] as const;

const CPP_TOOL_EXTENSION_IDS = [
  'anysphere.cpptools',
  'ms-vscode.cpptools',
  'llvm-vs-code-extensions.vscode-clangd',
] as const;

async function activateCppToolExtensions(): Promise<void> {
  for (const extensionId of CPP_TOOL_EXTENSION_IDS) {
    const extension = vscode.extensions.getExtension(extensionId);
    if (!extension?.isActive) {
      try {
        await extension?.activate();
      } catch {
        // Other extensions may fail to activate outside their workspace context.
      }
    }
  }
}

function overrideCommands(handler: () => Promise<void>): void {
  for (const commandId of HIJACK_COMMANDS) {
    // Re-register without disposing prior overrides. Disposing would restore cpptools.
    vscode.commands.registerCommand(commandId, handler);
  }
}

export function registerHeaderSourceCommandOverrides(
  context: vscode.ExtensionContext,
  getIndexManager: () => IndexManager | undefined,
  ensureReady: () => Promise<boolean>
): void {
  const handler = async () => {
    try {
      if (!(await ensureReady())) {
        return;
      }
      await switchHeaderSource(getIndexManager());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Ace Code Search: ${message}`);
    }
  };

  const reinforceOverrides = async () => {
    await activateCppToolExtensions();
    overrideCommands(handler);
  };

  for (const commandId of HIJACK_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
  }

  let reinforceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReinforce = () => {
    if (reinforceTimer) {
      clearTimeout(reinforceTimer);
    }
    reinforceTimer = setTimeout(() => {
      reinforceTimer = undefined;
      void reinforceOverrides();
    }, 100);
  };

  void reinforceOverrides();
  scheduleReinforce();

  let bootTicks = 0;
  const bootInterval = setInterval(() => {
    bootTicks++;
    void reinforceOverrides();
    if (bootTicks >= 30) {
      clearInterval(bootInterval);
    }
  }, 500);

  context.subscriptions.push(
    vscode.extensions.onDidChange(scheduleReinforce),
    vscode.window.onDidChangeActiveTextEditor(scheduleReinforce),
    { dispose: () => clearInterval(bootInterval) }
  );
}
