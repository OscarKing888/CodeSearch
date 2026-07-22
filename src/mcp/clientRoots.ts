import { z } from 'zod';
import { fileUriToWorkspacePath, pathComparisonKey } from './discover';

/**
 * Cursor versions in the wild may return a Windows absolute path in `uri`
 * instead of the MCP-mandated file:// URI. Use this schema for roots/list so
 * compatibility parsing happens before the SDK's strict RootSchema rejects it.
 */
export const CompatibleListRootsResultSchema = z.object({
  roots: z.array(
    z.object({
      uri: z.string(),
      name: z.string().optional(),
    })
  ),
});

export interface ParsedClientWorkspaceRoots {
  workspaceRoots: string[];
  rejectedCount: number;
}

export function parseClientWorkspaceRoots(
  roots: readonly { uri: string }[]
): ParsedClientWorkspaceRoots {
  const unique = new Map<string, string>();
  let rejectedCount = 0;
  for (const root of roots) {
    const workspacePath = fileUriToWorkspacePath(root.uri);
    if (!workspacePath) {
      rejectedCount++;
      continue;
    }
    unique.set(pathComparisonKey(workspacePath), workspacePath);
  }
  return {
    workspaceRoots: Array.from(unique.values()),
    rejectedCount,
  };
}
