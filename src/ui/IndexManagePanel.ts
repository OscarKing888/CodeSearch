import * as vscode from 'vscode';
import { IndexManager } from '../index/IndexManager';
import {
  attachIndex,
  browseAndAttachIndex,
  confirmAndDelete,
  createStandaloneIndex,
  detachIndex,
  formatIndexDisplayTitle,
  getIndexListPayload,
  pickMoveDestination,
  refreshAllIndexes,
  refreshIndexById,
  renameIndex,
  saveSecondaryIds,
  setMappings,
  setExcludeRules,
} from './IndexManagementService';

export class IndexManagePanel {
  private static instance: IndexManagePanel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: IndexManager,
    private readonly context: vscode.ExtensionContext
  ) {
    manager.on('progress', () => this.scheduleRefresh());
    manager.on('indexesChanged', () => this.scheduleRefresh());
  }

  static register(
    context: vscode.ExtensionContext,
    manager: IndexManager
  ): IndexManagePanel {
    if (!IndexManagePanel.instance) {
      IndexManagePanel.instance = new IndexManagePanel(context.extensionUri, manager, context);
      context.subscriptions.push({
        dispose: () => {
          IndexManagePanel.instance?.dispose();
          IndexManagePanel.instance = undefined;
        },
      });
    }
    return IndexManagePanel.instance;
  }

  static show(): void {
    IndexManagePanel.instance?.reveal();
  }

  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.sendIndexes();
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
      void this.handleMessage(msg);
    });
  }

  private scheduleRefresh(): void {
    if (!this.panel) {
      return;
    }
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => {
      void this.sendIndexes();
    }, 300);
  }

  private async sendIndexes(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const payload = getIndexListPayload(this.manager);
    await this.panel.webview.postMessage({ type: 'indexes', ...payload });
  }

  private async toast(message: string, isError = false): Promise<void> {
    if (!this.panel) {
      return;
    }
    await this.panel.webview.postMessage({ type: 'toast', message, isError });
    if (isError) {
      void vscode.window.showErrorMessage(message);
    } else if (message) {
      void vscode.window.showInformationMessage(message);
    }
  }

  private async afterMutation(error: string | null, successMsg?: string): Promise<void> {
    if (error) {
      await this.toast(error, true);
    } else if (successMsg) {
      await this.toast(successMsg, false);
    }
    await saveSecondaryIds(this.manager, this.context);
    await this.sendIndexes();
  }

  private async handleMessage(msg: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
    dirsText?: string;
    filesText?: string;
    globsText?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
      case 'refresh':
        await this.sendIndexes();
        break;
      case 'rename':
        if (msg.id && msg.name !== undefined) {
          await this.afterMutation(await renameIndex(this.manager, msg.id, msg.name), 'Renamed');
        }
        break;
      case 'setMappings':
        if (msg.id && msg.text !== undefined) {
          await this.afterMutation(await setMappings(this.manager, msg.id, msg.text), 'Mappings saved');
        }
        break;
      case 'setExcludeRules':
        if (msg.id && msg.dirsText !== undefined && msg.filesText !== undefined && msg.globsText !== undefined) {
          await this.afterMutation(
            await setExcludeRules(this.manager, msg.id, msg.dirsText, msg.filesText, msg.globsText),
            'Exclude rules saved'
          );
        }
        break;
      case 'attach':
        if (msg.id) {
          await this.afterMutation(await attachIndex(this.manager, msg.id), 'Index attached');
        }
        break;
      case 'detach':
        if (msg.id) {
          await this.afterMutation(await detachIndex(this.manager, msg.id), 'Index detached');
        }
        break;
      case 'delete':
        if (msg.id) {
          const meta = this.manager.getRegistry().getById(msg.id);
          if (meta) {
            await this.afterMutation(
              await confirmAndDelete(
                this.manager,
                msg.id,
                formatIndexDisplayTitle(meta.rootDirs, meta.name)
              )
            );
          }
        }
        break;
      case 'refreshIndex':
        if (msg.id) {
          await this.afterMutation(await refreshIndexById(this.manager, msg.id), 'Index refreshed');
        }
        break;
      case 'refreshAll':
        await this.afterMutation(await refreshAllIndexes(this.manager), 'All indexes refreshed');
        break;
      case 'moveIndex':
        if (msg.id) {
          await this.afterMutation(await pickMoveDestination(this.manager, msg.id), 'Database moved');
        }
        break;
      case 'createIndex': {
        const err = await createStandaloneIndex(this.manager);
        if (err) {
          await this.toast(err, true);
        } else {
          await this.afterMutation(null, 'Index created');
        }
        break;
      }
      case 'browseAndAttach': {
        const err = await browseAndAttachIndex(this.manager);
        if (err) {
          await this.toast(err, true);
        } else {
          await this.afterMutation(null, 'Secondary index attached');
        }
        break;
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
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manage Indexes</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    h1 { font-size: 1.25em; margin-bottom: 12px; font-weight: 600; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
      align-items: center;
    }
    .btn {
      padding: 4px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-danger { color: var(--vscode-errorForeground); }
    .filter {
      flex: 1;
      min-width: 160px;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
    }
    .toast {
      padding: 6px 10px;
      margin-bottom: 10px;
      border-radius: 2px;
      font-size: 12px;
      display: none;
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
    .list { display: flex; flex-direction: column; gap: 12px; }
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 12px;
      background: var(--vscode-sideBar-background);
    }
    .card-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .card-title { font-weight: 600; font-size: 13px; word-break: break-all; }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .badge.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .badge.secondary { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; word-break: break-all; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .rename-row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
    .rename-row input {
      flex: 1;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      font-size: 12px;
    }
    .mappings {
      width: 100%;
      min-height: 60px;
      margin-top: 8px;
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      resize: vertical;
    }
    .empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 32px; }
    .mappings-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
    .exclude-block { margin-top: 8px; }
    .exclude-block textarea {
      width: 100%;
      min-height: 48px;
      margin-top: 4px;
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      resize: vertical;
    }
    .exclude-hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  </style>
</head>
<body>
  <h1>Manage Indexes</h1>
  <div id="toast" class="toast"></div>
  <div class="toolbar">
    <button class="btn btn-primary" id="btnCreate">+ Create Index</button>
    <button class="btn" id="btnAttach">Attach Index...</button>
    <button class="btn" id="btnRefreshAll">Refresh All</button>
    <input type="text" class="filter" id="filterInput" placeholder="Filter by name or path..." />
  </div>
  <div class="list" id="indexList"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    clearTimeout(this.progressTimer);
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
