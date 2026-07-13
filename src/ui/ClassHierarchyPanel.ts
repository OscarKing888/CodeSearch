import * as vscode from 'vscode';
import { ClassHierarchyModel } from '../hierarchy/ClassHierarchyModel';

export type ClassHierarchyPanelModel = ClassHierarchyModel;

export interface ClassHierarchyLocation {
  path: string;
  line: number;
  column: number;
}

export type ClassHierarchyModelLoader = (
  signal: AbortSignal,
  force: boolean
) => ClassHierarchyModel | Promise<ClassHierarchyModel>;

export type ClassHierarchyLocationOpener = (
  location: ClassHierarchyLocation
) => void | Promise<void>;

/**
 * Singleton host for the workspace-wide class hierarchy webview. The model is
 * loaded from the index-backed hierarchy cache whenever the panel is revealed.
 */
export class ClassHierarchyPanel {
  private static instance: ClassHierarchyPanel | undefined;

  private panel: vscode.WebviewPanel | undefined;
  private requestSequence = 0;
  private webviewReady = false;
  private loadAbortController: AbortController | undefined;

  private constructor(
    private extensionUri: vscode.Uri,
    private loadModel: ClassHierarchyModelLoader,
    private openLocation: ClassHierarchyLocationOpener
  ) {}

  static register(
    context: vscode.ExtensionContext,
    loadModel: ClassHierarchyModelLoader,
    openLocation: ClassHierarchyLocationOpener
  ): ClassHierarchyPanel {
    if (!ClassHierarchyPanel.instance) {
      ClassHierarchyPanel.instance = new ClassHierarchyPanel(
        context.extensionUri,
        loadModel,
        openLocation
      );
      context.subscriptions.push({
        dispose: () => {
          ClassHierarchyPanel.instance?.dispose();
          ClassHierarchyPanel.instance = undefined;
        },
      });
    } else {
      ClassHierarchyPanel.instance.rebind(context.extensionUri, loadModel, openLocation);
    }

    return ClassHierarchyPanel.instance;
  }

  static show(): void {
    ClassHierarchyPanel.instance?.reveal();
  }

  static refresh(): void {
    void ClassHierarchyPanel.instance?.refresh(false);
  }

  rebind(
    extensionUri: vscode.Uri,
    loadModel: ClassHierarchyModelLoader,
    openLocation: ClassHierarchyLocationOpener
  ): void {
    this.extensionUri = extensionUri;
    this.loadModel = loadModel;
    this.openLocation = openLocation;
  }

  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      void this.refresh(false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'codeSearch.classHierarchy',
      'Class Hierarchy',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );
    this.panel = panel;
    this.webviewReady = false;
    panel.webview.html = this.getHtml(panel.webview);

    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.requestSequence += 1;
        this.loadAbortController?.abort();
        this.loadAbortController = undefined;
        this.panel = undefined;
        this.webviewReady = false;
      }
    });

    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        await this.refresh(false);
        break;
      case 'refresh':
        await this.refresh(true);
        break;
      case 'openFile': {
        const location = getLocation(message);
        if (!location) {
          return;
        }
        try {
          await this.openLocation(location);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(
            `Ace Code Search: 无法打开 class 声明 — ${message}`
          );
        }
        break;
      }
    }
  }

  private async refresh(force: boolean): Promise<void> {
    const panel = this.panel;
    if (!panel || !this.webviewReady) {
      return;
    }
    const request = ++this.requestSequence;
    this.loadAbortController?.abort();
    const abortController = new AbortController();
    this.loadAbortController = abortController;
    await panel.webview.postMessage({ type: 'loading' });

    try {
      const model = await this.loadModel(abortController.signal, force);
      if (this.panel !== panel || request !== this.requestSequence) {
        return;
      }
      await panel.webview.postMessage({ type: 'model', model });
    } catch (error) {
      if (this.panel !== panel || request !== this.requestSequence) {
        return;
      }
      await this.postError(error);
    } finally {
      if (this.loadAbortController === abortController) {
        this.loadAbortController = undefined;
      }
    }
  }

  private async postError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.panel?.webview.postMessage({
      type: 'error',
      message: message || 'Unable to build the class hierarchy.',
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'class-hierarchy.js')
    );
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Class Hierarchy</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px 16px 24px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    h1 { flex: 0 0 auto; margin: 0 8px 0 0; font-size: 1.25em; font-weight: 600; }
    .filter {
      flex: 1 1 220px;
      min-width: 160px;
      padding: 5px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      outline: none;
    }
    .filter:focus { border-color: var(--vscode-focusBorder); }
    button { font: inherit; }
    .toolbar-button {
      padding: 4px 9px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 0;
      border-radius: 2px;
      cursor: pointer;
    }
    .toolbar-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .summary { min-height: 20px; margin: 10px 0 8px; color: var(--vscode-descriptionForeground); }
    .notice {
      display: none;
      margin: 0 0 10px;
      padding: 6px 9px;
      color: var(--vscode-editorWarning-foreground);
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      border-radius: 2px;
    }
    .notice.visible { display: block; }
    .state { padding: 34px 8px; color: var(--vscode-descriptionForeground); text-align: center; }
    .state.error { color: var(--vscode-errorForeground); }
    .tree, .tree ul { margin: 0; padding: 0; list-style: none; }
    .tree ul { margin-left: 14px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); }
    .node-row {
      display: flex;
      min-height: 24px;
      align-items: center;
      padding-left: 2px;
      border-radius: 2px;
    }
    .node-row:hover { background: var(--vscode-list-hoverBackground); }
    .twistie, .twistie-spacer {
      flex: 0 0 20px;
      width: 20px;
      height: 22px;
      padding: 0;
      color: var(--vscode-icon-foreground);
      background: transparent;
      border: 0;
      cursor: pointer;
    }
    .twistie-spacer { display: inline-block; cursor: default; }
    .class-name {
      min-width: 0;
      padding: 1px 3px;
      overflow: hidden;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      border: 0;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    .class-name:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .class-name.external, .class-name.unavailable {
      color: var(--vscode-disabledForeground);
      cursor: default;
      text-decoration: none;
    }
    .kind { margin-left: 6px; color: var(--vscode-descriptionForeground); font-size: .9em; }
    .cycle { margin-left: 6px; color: var(--vscode-editorWarning-foreground); font-size: .9em; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Class Hierarchy</h1>
    <input id="filter" class="filter" type="search" placeholder="Filter by class name…" aria-label="Filter by class name">
    <button id="expandAll" class="toolbar-button" type="button">Expand All</button>
    <button id="collapseAll" class="toolbar-button" type="button">Collapse All</button>
    <button id="refresh" class="toolbar-button" type="button">Refresh</button>
  </div>
  <div id="summary" class="summary" aria-live="polite"></div>
  <div id="notice" class="notice"></div>
  <div id="state" class="state">Loading class hierarchy…</div>
  <ul id="tree" class="tree" aria-label="Class inheritance tree" hidden></ul>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.requestSequence += 1;
    this.loadAbortController?.abort();
    this.loadAbortController = undefined;
    this.panel?.dispose();
    this.panel = undefined;
    this.webviewReady = false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getLocation(message: Record<string, unknown>): ClassHierarchyLocation | undefined {
  if (typeof message.path !== 'string' || !message.path) {
    return undefined;
  }
  const line = typeof message.line === 'number' && Number.isFinite(message.line)
    ? message.line
    : 1;
  const column = typeof message.column === 'number' && Number.isFinite(message.column)
    ? message.column
    : 1;
  return { path: message.path, line, column };
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
