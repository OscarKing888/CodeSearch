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
import { z } from 'zod';
import { fileUriToWorkspacePath, parseMcpCliArgs } from './discover';
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
  list_indexes, search_code, read_indexed_file, find_header_source

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
  const handlers = new McpToolHandlers(session);
  const version = readPackageVersion();

  const server = new McpServer(
    {
      name: 'ace-code-search',
      version,
    },
    {
      instructions:
        'Call list_indexes first, choose the matching workspace index by id, then pass indexId to search_code/read_indexed_file/find_header_source. Results are read-only index snapshots; partialIndex means incomplete or unknown completion state.',
    }
  );

  let clientScopeRefresh: Promise<void> | undefined;
  const ensureClientWorkspaceScope = async (): Promise<void> => {
    if (options.db || options.allIndexes) {
      return;
    }
    if (!clientScopeRefresh) {
      clientScopeRefresh = (async () => {
        if (!server.server.getClientCapabilities()?.roots) {
          return;
        }
        try {
          const result = await server.server.listRoots();
          const roots = result.roots
            .map((root) => fileUriToWorkspacePath(root.uri))
            .filter((root): root is string => Boolean(root));
          if (roots.length > 0) {
            await session.setWorkspaceRoots(roots);
          } else {
            session.recordWarning(
              'The MCP client reported no usable file:// roots; using the static workspace scope fallback.'
            );
          }
        } catch (error) {
          session.recordWarning(
            `Could not read MCP client roots; using the static workspace scope fallback: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      })();
    }
    await clientScopeRefresh;
  };

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
    async () => {
      await ensureClientWorkspaceScope();
      return handlers.listIndexes();
    }
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
    async (args) => {
      await ensureClientWorkspaceScope();
      return handlers.searchCode(args);
    }
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
    async (args) => {
      await ensureClientWorkspaceScope();
      return handlers.readIndexedFile(args);
    }
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
    async (args) => {
      await ensureClientWorkspaceScope();
      return handlers.findHeaderSource(args);
    }
  );

  const transport = new StdioServerTransport();
  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      session.dispose();
    }
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await server.connect(transport);
  console.error(
    `Ace Code Search MCP ready (${session.listIndexes().length} index(es), v${version})`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
