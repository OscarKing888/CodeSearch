/**
 * Ace Code Search MCP server (stdio) — read-only tools over existing SQLite indexes.
 *
 * Usage:
 *   node dist/mcp.js [--registry path/to/registry.json] [--db path/to/index.db]
 *   npm run mcp -- --db ./index.db
 */

import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { McpStatusReporter } from '../mcpStatus';
import {
  CompatibleListRootsResultSchema,
  parseClientWorkspaceRoots,
} from './clientRoots';
import { parseMcpCliArgs } from './discover';
import { installPostInitializeToolRefresh } from './serverLifecycle';
import { McpIndexSession } from './session';
import { McpToolHandlers } from './tools';

function readPackageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(__dirname, '..', 'package.json')).version as string;
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  console.error(`Ace Code Search MCP (stdio)

Usage:
  node dist/mcp.js [--registry <registry.json>] [--db <index.db>] [--workspace-root <dir>]

Options:
  --registry         Path to Ace Code Search registry.json
  --db               Open a single index database (read-only)
  --workspace-root   Static workspace scope fallback (repeatable; default: cwd)
  --all-indexes      Explicitly allow indexes outside the workspace scope
  --extension-root   Extension/repo root for better-sqlite3 native resolution
  --help             Show this help

Tools:
  list_indexes, search_code, read_indexed_file, find_header_source, search_class_hierarchy

Note: Uses system Node ABI for better-sqlite3 (run npm run rebuild:node after Electron rebuild).
Log only to stderr — stdout is reserved for MCP JSON-RPC.
`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const options = parseMcpCliArgs(process.argv);
  const session = await McpIndexSession.create(options);
  const handlers = new McpToolHandlers(session, {
    log: (message) => console.error(message),
  });
  const version = readPackageVersion();
  const statusReporter = new McpStatusReporter({
    extensionVersion: version,
    workspaceRoots: session.getWorkspaceRoots(),
    log: (message) => console.error(message),
  });

  const server = new McpServer(
    {
      name: 'ace-code-search',
      version,
    },
    {
      instructions:
        'Call list_indexes first, choose the matching workspace index by id, then pass indexId to search_code/read_indexed_file/find_header_source/search_class_hierarchy. Results are read-only index snapshots; partialIndex means incomplete or unknown completion state.',
    }
  );
  installPostInitializeToolRefresh(server.server, (message) => console.error(message));

  let clientScopeGeneration = 0;
  let clientScopeRefresh:
    | { generation: number; promise: Promise<void> }
    | undefined;

  const applyClientWorkspaceRoots = async (workspaceRoots: string[]): Promise<void> => {
    try {
      await session.setWorkspaceRoots(workspaceRoots);
    } finally {
      statusReporter.updateWorkspaceRoots(session.getWorkspaceRoots());
    }
  };

  const clearClientWorkspaceScope = async (warning: string): Promise<void> => {
    try {
      await applyClientWorkspaceRoots([]);
    } catch (error) {
      session.recordWarning(
        `${warning} Clearing the workspace scope also failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    session.recordWarning(warning);
  };

  const refreshClientWorkspaceScope = async (generation: number): Promise<void> => {
    if (!server.server.getClientCapabilities()?.roots) {
      return;
    }

    let result: z.infer<typeof CompatibleListRootsResultSchema>;
    try {
      result = await server.server.request(
        { method: 'roots/list' },
        CompatibleListRootsResultSchema
      );
    } catch (error) {
      if (generation !== clientScopeGeneration) {
        return;
      }
      await clearClientWorkspaceScope(
        `Could not read MCP client roots; the client workspace scope was cleared: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    if (generation !== clientScopeGeneration) {
      return;
    }
    const parsed = parseClientWorkspaceRoots(result.roots);
    try {
      await applyClientWorkspaceRoots(parsed.workspaceRoots);
    } catch (error) {
      session.recordWarning(
        `Could not apply MCP client roots; no fallback indexes were retained: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    if (parsed.rejectedCount > 0) {
      session.recordWarning(
        `${parsed.rejectedCount} MCP client root(s) were ignored because they were not ` +
          'absolute filesystem paths or file:// URIs.'
      );
    }
    if (parsed.workspaceRoots.length === 0) {
      session.recordWarning(
        'The MCP client reported no usable workspace roots; the workspace scope was cleared.'
      );
    }
  };

  const ensureClientWorkspaceScope = async (): Promise<void> => {
    if (options.db || options.allIndexes) {
      return;
    }
    while (true) {
      const generation = clientScopeGeneration;
      if (!clientScopeRefresh || clientScopeRefresh.generation !== generation) {
        clientScopeRefresh = {
          generation,
          promise: refreshClientWorkspaceScope(generation),
        };
      }
      await clientScopeRefresh.promise;
      if (generation === clientScopeGeneration) {
        return;
      }
    }
  };

  if (!options.db && !options.allIndexes) {
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
      clientScopeGeneration++;
      clientScopeRefresh = undefined;
    });
  }

  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;

  server.registerTool(
    'list_indexes',
    {
      title: 'List Indexes',
      description:
        'List Ace Code Search SQLite indexes available to this MCP session (id, name, dbPath, roots, token count).',
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      statusReporter.run('list_indexes', args, async () => {
        await ensureClientWorkspaceScope();
        return handlers.listIndexes();
      })
  );

  server.registerTool(
    'search_code',
    {
      title: 'Search Code',
      description:
        'Full-text search over Ace Code Search indexes. Supports the same query syntax as the extension (ext:/dir:/age:/loose:, phrases, wildcards). Returns indexed snapshot hits with mapped localPath.',
      inputSchema: {
        query: z.string().describe('Search query (Ace Code Search syntax)'),
        indexId: z.string().optional().describe('Limit to one index id or unique name'),
        caseSensitive: z.boolean().optional().describe('Case-sensitive match (default false)'),
        phraseSearch: z.boolean().optional().describe('Treat multi-word as phrase (default true)'),
        contextLines: z.number().int().min(0).max(10).optional(),
        maxResults: z.number().int().min(1).max(10000).optional(),
        fuzzy: z.boolean().optional(),
        loose: z.boolean().optional(),
        looseGap: z.number().int().min(1).max(500).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      statusReporter.run('search_code', args, async () => {
        await ensureClientWorkspaceScope();
        return handlers.searchCode(args);
      })
  );

  server.registerTool(
    'read_indexed_file',
    {
      title: 'Read Indexed File',
      description:
        'Read a line range from a file as stored in the index snapshot (not necessarily the live disk file).',
      inputSchema: {
        path: z.string().describe('Indexed or mapped absolute file path'),
        indexId: z.string().optional(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
        maxChars: z.number().int().min(1).max(500000).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      statusReporter.run('read_indexed_file', args, async () => {
        await ensureClientWorkspaceScope();
        return handlers.readIndexedFile(args);
      })
  );

  server.registerTool(
    'find_header_source',
    {
      title: 'Find Header/Source Counterpart',
      description:
        'Find header/source counterparts for a C/C++ file using indexed files only (same rules as Alt+O).',
      inputSchema: {
        path: z.string().describe('Header or source file path'),
        indexId: z.string().optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      statusReporter.run('find_header_source', args, async () => {
        await ensureClientWorkspaceScope();
        return handlers.findHeaderSource(args);
      })
  );

  server.registerTool(
    'search_class_hierarchy',
    {
      title: 'Search Class Hierarchy',
      description:
        'Return the indexed descendant inheritance DAG for one case-sensitive class name, including mapped source locations.',
      inputSchema: {
        className: z
          .string()
          .min(1)
          .describe('Class short name or qualified name'),
        indexId: z.string().optional().describe('Limit to one index id or unique name'),
        maxNodes: z
          .union([
            z.number().int().min(1).max(5000),
            z.literal('all'),
          ])
          .optional()
          .describe(
            'Maximum returned nodes including the root, or "all". Omit to use the local default (20 unless configured).'
          ),
      },
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      statusReporter.run('search_class_hierarchy', args, async () => {
        await ensureClientWorkspaceScope();
        return handlers.searchClassHierarchy(args);
      })
  );

  const transport = new StdioServerTransport();
  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      try {
        await statusReporter.dispose();
      } finally {
        try {
          await handlers.dispose();
        } finally {
          session.dispose();
        }
      }
    }
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await server.connect(transport);
  await statusReporter.start();
  console.error(
    `Ace Code Search MCP ready (${session.listIndexes().length} index(es), v${version})`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
