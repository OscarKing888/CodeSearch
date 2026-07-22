import * as vscode from 'vscode';
import { IndexManager } from '../index/IndexManager';
import {
  attachIndex,
  browseAndAttachIndex,
  createStandaloneIndex,
  deleteIndex,
  detachIndex,
  getIndexListPayload,
  IndexManagementWorkspaceContext,
  IndexOperationResult,
  refreshAllIndexes,
  refreshIndexById,
  renameIndex,
  saveWorkspaceIndexBinding,
  selectPrimaryIndex,
  setMappings,
  setExcludeRules,
  useSharedPrimaryIndex,
} from './IndexManagementService';

interface IndexManageBinding {
  generation: number;
  manager: IndexManager;
  workspaceContext: IndexManagementWorkspaceContext;
}

export class IndexManagePanel {
  private static instance: IndexManagePanel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private manager!: IndexManager;
  private workspaceContext!: IndexManagementWorkspaceContext;
  private bindingGeneration = 0;
  private activeOperationGeneration: number | undefined;
  private readonly onProgress = () => this.scheduleProgressRefresh();
  private readonly onIndexesChanged = () => this.scheduleRefresh();

  constructor(
    private readonly extensionUri: vscode.Uri,
    manager: IndexManager,
    workspaceContext: IndexManagementWorkspaceContext,
    private readonly context: vscode.ExtensionContext
  ) {
    this.rebind(manager, workspaceContext);
  }

  static register(
    context: vscode.ExtensionContext,
    manager: IndexManager,
    workspaceContext: IndexManagementWorkspaceContext
  ): IndexManagePanel {
    if (!IndexManagePanel.instance) {
      IndexManagePanel.instance = new IndexManagePanel(
        context.extensionUri,
        manager,
        workspaceContext,
        context
      );
      context.subscriptions.push({
        dispose: () => {
          IndexManagePanel.instance?.dispose();
          IndexManagePanel.instance = undefined;
        },
      });
    } else {
      IndexManagePanel.instance.rebind(manager, workspaceContext);
    }
    return IndexManagePanel.instance;
  }

  rebind(manager: IndexManager, workspaceContext: IndexManagementWorkspaceContext): void {
    this.bindingGeneration++;
    this.activeOperationGeneration = undefined;
    clearTimeout(this.progressTimer);
    clearTimeout(this.stateTimer);
    if (this.manager) {
      this.manager.off('progress', this.onProgress);
      this.manager.off('indexesChanged', this.onIndexesChanged);
    }
    this.manager = manager;
    this.workspaceContext = workspaceContext;
    manager.on('progress', this.onProgress);
    manager.on('indexesChanged', this.onIndexesChanged);
    void this.sendIndexes(this.captureBinding());
  }

  static show(): void {
    IndexManagePanel.instance?.reveal();
  }

  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.sendIndexes(this.captureBinding());
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'codeSearch.manageIndexes',
      'Manage Indexes',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((msg) => {
      const binding = this.captureBinding();
      void this.handleMessage(msg, binding).catch((error) =>
        this.toast(
          binding,
          error instanceof Error ? error.message : String(error),
          true,
          typeof msg?.requestId === 'string' ? msg.requestId : undefined
        )
      );
    });
  }

  private scheduleRefresh(): void {
    if (!this.panel) {
      return;
    }
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      void this.sendIndexes(this.captureBinding());
    }, 100);
  }

  private scheduleProgressRefresh(): void {
    if (!this.panel) {
      return;
    }
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => {
      void this.sendProgress(this.captureBinding());
    }, 250);
  }

  private captureBinding(): IndexManageBinding {
    return {
      generation: this.bindingGeneration,
      manager: this.manager,
      workspaceContext: this.workspaceContext,
    };
  }

  private isCurrentBinding(binding: IndexManageBinding): boolean {
    return (
      binding.generation === this.bindingGeneration &&
      binding.manager === this.manager &&
      binding.workspaceContext === this.workspaceContext
    );
  }

  private async sendIndexes(binding: IndexManageBinding): Promise<void> {
    if (!this.panel || !this.isCurrentBinding(binding)) {
      return;
    }
    const payload = getIndexListPayload(binding.manager, binding.workspaceContext);
    if (!this.panel || !this.isCurrentBinding(binding)) {
      return;
    }
    await this.panel.webview.postMessage({ type: 'indexes', ...payload });
  }

  private async sendProgress(binding: IndexManageBinding): Promise<void> {
    if (!this.panel || !this.isCurrentBinding(binding)) {
      return;
    }
    const payload = getIndexListPayload(binding.manager, binding.workspaceContext);
    if (!this.panel || !this.isCurrentBinding(binding)) {
      return;
    }
    await this.panel.webview.postMessage({
      type: 'progress',
      indexes: payload.indexes.map((item) => ({
        id: item.id,
        status: item.status,
        statusMessage: item.statusMessage,
        partial: item.partial,
        readOnly: item.readOnly,
        writerLabel: item.writerLabel,
      })),
      primary: payload.workspace.primary,
    });
  }

  private async toast(
    binding: IndexManageBinding,
    message: string,
    isError = false,
    requestId?: string
  ): Promise<void> {
    if (!this.panel || !this.isCurrentBinding(binding)) {
      return;
    }
    await this.panel.webview.postMessage({ type: 'toast', message, isError, requestId });
  }

  private async afterMutation(
    binding: IndexManageBinding,
    error: string | null,
    successMsg?: string,
    removedSecondaryDbPath?: string,
    requestId?: string
  ): Promise<void> {
    if (!this.isCurrentBinding(binding)) {
      return;
    }
    if (error) {
      await this.toast(binding, error, true, requestId);
    } else if (successMsg) {
      await this.toast(binding, successMsg, false, requestId);
    }
    if (!this.isCurrentBinding(binding)) {
      return;
    }
    await saveWorkspaceIndexBinding(
      binding.manager,
      this.context,
      undefined,
      {
        removedSecondaryDbPaths:
          !error && removedSecondaryDbPath ? [removedSecondaryDbPath] : undefined,
      }
    );
    if (!this.isCurrentBinding(binding)) {
      return;
    }
    await this.sendIndexes(binding);
  }

  private async afterOperation(
    binding: IndexManageBinding,
    result: IndexOperationResult,
    fallbackSuccess?: string
  ): Promise<void> {
    if (!this.isCurrentBinding(binding) || result.status === 'cancelled') {
      return;
    }
    if (result.status === 'error') {
      await this.toast(binding, result.message, true);
      return;
    }
    if (result.source) {
      binding.workspaceContext.primarySource = result.source;
    }
    await saveWorkspaceIndexBinding(
      binding.manager,
      this.context,
      result.source ?? binding.workspaceContext.primarySource
    );
    if (!this.isCurrentBinding(binding)) {
      return;
    }
    await this.toast(binding, result.message ?? fallbackSuccess ?? '', false);
    await this.sendIndexes(binding);
  }

  private async handleMessage(
    msg: {
      type: string;
      id?: string;
      name?: string;
      text?: string;
      dirsText?: string;
      filesText?: string;
      globsText?: string;
      requestId?: string;
    },
    binding: IndexManageBinding
  ): Promise<void> {
    const exclusive = msg.type !== 'ready' && msg.type !== 'refresh';
    if (exclusive && this.activeOperationGeneration === binding.generation) {
      await this.toast(
        binding,
        'Another index operation is still in progress',
        true,
        msg.requestId
      );
      return;
    }
    if (exclusive) {
      this.activeOperationGeneration = binding.generation;
    }
    try {
      const { manager, workspaceContext } = binding;
      switch (msg.type) {
      case 'ready':
      case 'refresh':
        await this.sendIndexes(binding);
        break;
      case 'rename':
        if (msg.id && msg.name !== undefined) {
          await this.afterMutation(
            binding,
            await renameIndex(manager, msg.id, msg.name),
            'Renamed',
            undefined,
            msg.requestId
          );
        }
        break;
      case 'setMappings':
        if (msg.id && msg.text !== undefined) {
          await this.afterMutation(
            binding,
            await setMappings(manager, msg.id, msg.text),
            'Mappings saved',
            undefined,
            msg.requestId
          );
        }
        break;
      case 'setExcludeRules':
        if (msg.id && msg.dirsText !== undefined && msg.filesText !== undefined && msg.globsText !== undefined) {
          await this.afterMutation(
            binding,
            await setExcludeRules(manager, msg.id, msg.dirsText, msg.filesText, msg.globsText),
            'Exclude rules saved',
            undefined,
            msg.requestId
          );
        }
        break;
      case 'attach':
        if (msg.id) {
          await this.afterMutation(binding, await attachIndex(manager, msg.id), 'Index attached');
        }
        break;
      case 'detach':
        if (msg.id) {
          const dbPath =
            manager.getAttachedIndex(msg.id)?.service.getDbPath() ??
            manager.getRegistry().getById(msg.id)?.dbPath;
          await this.afterMutation(
            binding,
            await detachIndex(manager, msg.id),
            'Index detached',
            dbPath
          );
        }
        break;
      case 'delete':
        if (msg.id) {
          const meta = manager.getRegistry().getById(msg.id);
          if (meta) {
            const confirm = await vscode.window.showWarningMessage(
              `Permanently delete index "${meta.name}"?`,
              {
                modal: true,
                detail:
                  `Database: ${meta.dbPath}\n\n` +
                  'The database and its SQLite index data will be deleted. This cannot be undone.',
              },
              'Delete'
            );
            if (confirm === 'Delete' && this.isCurrentBinding(binding)) {
              await this.afterMutation(
                binding,
                await deleteIndex(manager, msg.id, true),
                'Index data deleted',
                meta.dbPath
              );
            }
          }
        }
        break;
      case 'refreshIndex':
        if (msg.id) {
          await this.afterMutation(
            binding,
            await refreshIndexById(manager, msg.id),
            'Index refreshed'
          );
        }
        break;
      case 'refreshAll':
        await this.afterMutation(
          binding,
          await refreshAllIndexes(manager),
          'All indexes refreshed'
        );
        break;
      case 'useSharedPrimary':
        await this.afterOperation(
          binding,
          await useSharedPrimaryIndex(manager, workspaceContext)
        );
        break;
      case 'selectPrimary':
        await this.afterOperation(
          binding,
          await selectPrimaryIndex(manager, workspaceContext)
        );
        break;
      case 'createIndex': {
        await this.afterOperation(binding, await createStandaloneIndex(manager));
        break;
      }
      case 'browseAndAttach': {
        await this.afterOperation(
          binding,
          await browseAndAttachIndex(manager, workspaceContext)
        );
        break;
      }
      }
    } finally {
      if (exclusive && this.activeOperationGeneration === binding.generation) {
        this.activeOperationGeneration = undefined;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'manage.js')
    );
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manage Indexes</title>
  <style>
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { min-height: 100%; }
    body {
      max-width: 1120px;
      margin: 0 auto;
      padding: 24px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    button, input, textarea { font: inherit; }
    button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    code, pre, .path, .root-list { font-family: var(--vscode-editor-font-family); }
    .page-header { margin-bottom: 14px; }
    .page-header h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
    .page-header p, .section-description, .setting-help {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.5;
    }
    .toast {
      display: none;
      position: sticky;
      top: 8px;
      z-index: 20;
      margin-bottom: 12px;
      padding: 8px 11px;
      border-radius: 4px;
      font-size: 12px;
    }
    .toast.visible { display: block; }
    .toast.error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    .toast.ok {
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
    }
    .workspace-context {
      margin-bottom: 20px;
      padding: 10px 0 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .context-main, .section-header, .subsection-header, .item-header, .inspector-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .eyebrow, .meta-label {
      display: block;
      margin-bottom: 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .context-title { font-weight: 600; line-height: 1.45; word-break: break-word; }
    .context-badges, .item-badges, .action-row, .section-actions, .ue-chips {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .context-details { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .context-details summary { width: fit-content; cursor: pointer; }
    .context-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px 18px;
      margin-top: 10px;
    }
    .path { display: block; word-break: break-all; }
    .context-note {
      margin-top: 9px;
      padding: 7px 9px;
      border-left: 3px solid var(--vscode-focusBorder);
      background: var(--vscode-textBlockQuote-background);
      font-size: 12px;
      line-height: 1.45;
    }
    .context-note.warning { border-left-color: var(--vscode-editorWarning-foreground); }
    .index-layout { display: grid; gap: 22px; }
    .panel-section {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: var(--vscode-editorWidget-background);
    }
    .section-header { padding: 14px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .section-header h2, .subsection-header h3, .inspector-header h2 {
      margin: 0 0 3px;
      font-weight: 600;
    }
    .section-header h2, .inspector-header h2 { font-size: 15px; }
    .subsection-header h3 { font-size: 12px; }
    .section-actions { justify-content: flex-end; }
    .btn {
      min-height: 28px;
      padding: 4px 11px;
      border: 0;
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-danger { color: var(--vscode-errorForeground); }
    .btn-quiet { padding-inline: 8px; background: transparent; }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn:disabled:hover { background: var(--vscode-button-secondaryBackground); }
    .primary-region { padding: 16px; }
    .primary-region-header { margin-bottom: 9px; }
    .primary-card {
      padding: 16px;
      border: 1px solid var(--vscode-focusBorder);
      border-left-width: 4px;
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .primary-card.selected { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
    .index-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .index-row:first-child { border-top: 0; }
    .index-row.selected { box-shadow: inset 3px 0 var(--vscode-focusBorder); }
    .available-row { background: transparent; }
    .available-row .item-title { font-weight: 500; }
    .available-row.missing { opacity: .72; }
    .item-main { min-width: 0; }
    .item-header { justify-content: flex-start; align-items: center; gap: 8px; }
    .item-title { min-width: 0; font-size: 13px; font-weight: 600; word-break: break-word; }
    .item-subtitle {
      margin-top: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.4;
      word-break: break-all;
    }
    .item-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 7px 14px;
      margin-top: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .badge, .chip {
      display: inline-flex;
      align-items: center;
      min-height: 19px;
      padding: 1px 6px;
      border-radius: 10px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 10px;
      line-height: 1.35;
      white-space: nowrap;
    }
    .badge.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .badge.secondary, .badge.shared { color: var(--vscode-foreground); background: var(--vscode-editor-inactiveSelectionBackground); }
    .badge.muted { opacity: .72; }
    .status-dot {
      display: inline-block;
      flex: 0 0 auto;
      width: 7px;
      height: 7px;
      margin-right: 5px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
    }
    .status-dot.upToDate, .status-dot.idle { background: var(--vscode-testing-iconPassed); }
    .status-dot.scanning, .status-dot.indexing { background: var(--vscode-editorWarning-foreground); }
    .status-dot.missing { background: var(--vscode-errorForeground); }
    .status-line { display: inline-flex; align-items: center; }
    .primary-card > .action-row {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .rename-row { display: flex; flex: 1 1 100%; gap: 6px; align-items: center; min-width: 260px; }
    .rename-row input, .filter, textarea {
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
    }
    .rename-row input, .filter { min-height: 28px; padding: 4px 8px; }
    .rename-row input { flex: 1; min-width: 120px; }
    .secondary-region { border-top: 1px solid var(--vscode-panel-border); }
    .subsection-header { align-items: center; padding: 11px 16px; background: var(--vscode-sideBar-background); }
    .subsection-copy { min-width: 0; }
    .subsection-copy p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .count {
      display: inline-block;
      min-width: 22px;
      margin-left: 5px;
      padding: 1px 6px;
      border-radius: 10px;
      text-align: center;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 10px;
    }
    .inspector-panel { overflow: hidden; }
    .inspector-header { padding: 14px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .inspector-title-path { color: var(--vscode-descriptionForeground); font-size: 11px; word-break: break-all; }
    .inspector-body { display: grid; gap: 14px; padding: 16px; }
    .settings-scope {
      min-width: 0;
      margin: 0;
      padding: 14px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
    }
    .settings-scope legend { padding: 0 7px; font-size: 13px; font-weight: 600; }
    .setting-block + .setting-block { margin-top: 15px; }
    .setting-title-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .setting-title { font-size: 12px; font-weight: 600; }
    .root-list, .readonly-rule {
      margin-top: 6px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-size: 11px;
      line-height: 1.5;
    }
    .root-list { max-height: 120px; overflow: auto; }
    .root-list > div + div { margin-top: 3px; }
    .rules-grid, .additional-grid, .workspace-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 10px;
    }
    .additional-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .readonly-rule { max-height: 132px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    .inherited-details { margin-top: 10px; }
    .inherited-details summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .ue-chips { margin-top: 7px; }
    .chip.ue { color: var(--vscode-foreground); background: var(--vscode-editor-inactiveSelectionBackground); }
    .field-label { display: grid; gap: 5px; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    textarea {
      width: 100%;
      min-height: 86px;
      padding: 7px 8px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      line-height: 1.45;
    }
    textarea[readonly] { opacity: .72; cursor: default; }
    .setting-footer { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 10px; }
    .dirty-marker { visibility: hidden; color: var(--vscode-editorWarning-foreground); font-size: 11px; }
    .dirty-marker.visible { visibility: visible; }
    .access-panel { min-height: 100%; padding: 10px; border-radius: 4px; background: var(--vscode-editor-background); }
    .access-value { margin-top: 4px; font-weight: 600; }
    .access-panel .meta-label:not(:first-child) { margin-top: 14px; }
    .access-note { margin-top: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
    .available-panel { background: transparent; }
    .available-panel .section-header { padding-inline: 0; }
    .available-list { overflow: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
    .filter { width: min(280px, 42vw); }
    .empty {
      padding: 22px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      font-size: 12px;
    }
    .empty.compact { padding: 16px; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    @media (max-width: 800px) {
      body { padding: 16px; }
      .section-header, .context-main, .inspector-header { flex-direction: column; }
      .section-actions { justify-content: flex-start; }
      .index-row { grid-template-columns: 1fr; }
      .action-row { justify-content: flex-start; }
      .rules-grid, .additional-grid, .workspace-grid { grid-template-columns: 1fr; }
      .filter { width: 100%; }
    }
    @media (max-width: 520px) {
      body { padding: 12px; }
      .subsection-header { align-items: flex-start; flex-direction: column; }
      .rename-row { min-width: 0; width: 100%; flex-wrap: wrap; }
      .primary-region, .inspector-body { padding: 12px; }
    }
  </style>
</head>
<body>
  <header class="page-header">
    <h1>Workspace Indexes</h1>
    <p>Choose the Primary index for this workspace, then add Secondary indexes only when a search needs more sources.</p>
  </header>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <section id="workspaceSummary" class="workspace-context" aria-label="Current workspace"></section>
  <div class="index-layout" id="indexList">
    <section class="panel-section scope-panel" aria-labelledby="searchScopeHeading">
      <header class="section-header">
        <div>
          <h2 id="searchScopeHeading">Current search scope</h2>
          <p class="section-description">The Primary index is always searched. Secondary indexes extend the same query.</p>
        </div>
        <div class="section-actions">
          <button type="button" class="btn" id="btnRefreshAll">Refresh active</button>
        </div>
      </header>
      <div class="primary-region">
        <div class="subsection-header primary-region-header">
          <div class="subsection-copy">
            <h3>Primary index</h3>
            <p>The main index for this workspace.</p>
          </div>
          <div class="section-actions">
            <button type="button" class="btn btn-primary" id="btnUseShared">Use shared Primary</button>
            <button type="button" class="btn" id="btnChoosePrimary">Choose Primary...</button>
          </div>
        </div>
        <div id="primaryIndex"></div>
      </div>
      <section class="secondary-region" aria-labelledby="secondaryHeading">
        <header class="subsection-header">
          <div class="subsection-copy">
            <h3 id="secondaryHeading">Secondary indexes <span class="count" id="secondaryCount">0</span></h3>
            <p>Optional indexes included alongside the Primary.</p>
          </div>
          <div class="section-actions">
            <button type="button" class="btn btn-primary" id="btnAttach">Open Secondary...</button>
            <button type="button" class="btn" id="btnCreate">Create Secondary...</button>
          </div>
        </header>
        <div id="secondaryIndexes"></div>
      </section>
    </section>

    <section class="panel-section inspector-panel" id="indexInspector" aria-labelledby="inspectorHeading"></section>

    <section class="available-panel" aria-labelledby="availableHeading">
      <header class="section-header">
        <div>
          <h2 id="availableHeading">Available indexes <span class="count" id="availableCount">0</span></h2>
          <p class="section-description">Known databases that are not part of the current search. Delete permanently removes their index data.</p>
        </div>
        <label>
          <span class="sr-only">Filter available indexes</span>
          <input type="text" class="filter" id="filterInput" placeholder="Filter available indexes..." />
        </label>
      </header>
      <div class="available-list" id="availableIndexes"></div>
    </section>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.bindingGeneration++;
    this.activeOperationGeneration = undefined;
    clearTimeout(this.progressTimer);
    clearTimeout(this.stateTimer);
    this.manager?.off('progress', this.onProgress);
    this.manager?.off('indexesChanged', this.onIndexesChanged);
    this.panel?.dispose();
    this.panel = undefined;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
