import * as path from 'path';

export const VSCODE_MCP_SERVER_DEFINITION_PROVIDER_ID =
  'ace-code-search.mcp-servers';

export interface VscodeMcpLaunchSpecOptions {
  extensionRoot: string;
  executablePath: string;
  version: string;
  workspaceRoots: readonly string[];
}

export interface VscodeMcpLaunchSpec {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string | number | null>;
  cwd: string;
  version: string;
}

/**
 * Build the editor-owned stdio launch description without depending on the
 * VS Code runtime. An empty workspace deliberately exposes no server because
 * registry-backed MCP discovery is workspace-scoped by default.
 */
export function buildVscodeMcpLaunchSpec(
  options: VscodeMcpLaunchSpecOptions
): VscodeMcpLaunchSpec | undefined {
  if (options.workspaceRoots.length === 0) {
    return undefined;
  }

  const args = [
    path.join(options.extensionRoot, 'dist', 'mcp.js'),
    '--extension-root',
    options.extensionRoot,
  ];
  for (const workspaceRoot of options.workspaceRoots) {
    args.push('--workspace-root', workspaceRoot);
  }

  return {
    label: 'Ace Code Search',
    command: options.executablePath,
    args,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    cwd: options.workspaceRoots[0],
    version: options.version,
  };
}
