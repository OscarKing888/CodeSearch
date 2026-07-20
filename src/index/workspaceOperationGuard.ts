export interface WorkspaceOperationToken<TManager, TWorkspace extends { hash: string }> {
  manager: TManager;
  workspace: TWorkspace;
  workspaceHash: string;
}

export function captureWorkspaceOperation<
  TManager,
  TWorkspace extends { hash: string },
>(
  manager: TManager,
  workspace: TWorkspace
): WorkspaceOperationToken<TManager, TWorkspace> {
  return {
    manager,
    workspace,
    workspaceHash: workspace.hash,
  };
}

/** Prevents an async command started in workspace A from committing into B. */
export function isWorkspaceOperationCurrent<
  TManager,
  TWorkspace extends { hash: string },
>(
  token: WorkspaceOperationToken<TManager, TWorkspace>,
  currentManager: TManager | undefined,
  currentWorkspace: TWorkspace | undefined
): boolean {
  return (
    token.manager === currentManager &&
    token.workspace === currentWorkspace &&
    token.workspaceHash === currentWorkspace?.hash
  );
}
