# Ace Code Search

A VS Code extension that provides full-text code indexing and instant search powered by SQLite FTS5.

![Ace Code Search screenshot](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/AceCodeSearch.png)

![Class Viewer screenshot](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/CodeSearchClassViewer.png)

> **Independent Development Notice**
>
> This extension draws functional inspiration from the user experience of tools such as [Entrian Source Search](https://entrian.com/source-search/). However, all code, architecture, and implementation are independently designed and developed by this project. No third-party source code or proprietary assets were used. This project has no affiliation with or authorization from Entrian or its products.

For detailed development notes, see [README_Dev.md](README_Dev.md).

Requires VS Code 1.103 or newer. This is the first stable Electron 37 / native ABI 136 runtime covered by the packaged native matrix.

## Shared Indexes Across VS Code and Cursor

When VS Code and Cursor open the same folder or workspace on one machine, newly created workspace indexes default to one IDE-independent Primary database. Open **Manage Indexes** to see the workspace roots, Primary source, effective access mode, and shared database path.

- **Shared Primary**: click **Use Shared Index**, or run **Ace Code Search: Choose Workspace Primary Index...**, to use the deterministic shared path; the picker also lists matching indexes auto-discovered from VS Code/Cursor registries
- **Manual Primary**: choose any existing `index.db`; read-only is recommended for an existing database, or select **Automatic single-writer**
- **Single-writer safety**: automatic mode uses `<index.db>.writer.lock` so only one IDE writes. Other IDEs automatically search the same database read-only and show the current writer in Manage Indexes. After the writer closes, an idle reader automatically takes over writes and starts incremental watching
- **Crash recovery**: a well-formed writer lock whose owner process has exited is reclaimed automatically. If a compatibility create on an unusual filesystem leaves a malformed/incomplete `.writer.lock`, or termination during the shorter reclaim step leaves `.writer.lock.reclaim`, close every IDE using that index before manually deleting the corresponding orphan lock/guard. Both incomplete-file cases stay fail-safe rather than risking two writers
- **Secondary indexes**: **Open Secondary...** opens an auto-discovered or manually selected database. Read-only is the default; automatic single-writer is available after reliable source roots are known. Open Secondaries participate in every search
- **Safe readers**: a read-only index never scans roots, starts a watcher, migrates schema, or writes the database. Invalid databases fail before the active Primary is replaced
- **Clear property scopes**: Manage Indexes emphasizes the Primary, keeps Secondaries subordinate, and separates `Index content` from `This workspace`. Effective Unreal defaults are shown read-only while Additional exclusions stay editable per index, so an empty custom field no longer hides that `Binaries`, `Intermediate`, and `Saved` are excluded
- **Delete Available indexes**: **Delete** shows the full database path for confirmation, then permanently removes the database and its SQLite WAL/SHM data. Deletion is refused while the index is active, referenced by another catalog entry, or locked by another IDE
- **Legacy compatibility**: existing VS Code/Cursor `globalStorage` indexes are not automatically moved or deleted and continue to open as Legacy sources; `code-search.autocreate` still takes precedence and controls its configured path

New shared database locations:

- Windows: `%LOCALAPPDATA%\AceCodeSearch\indexes\<workspace-key>\index.db`
- macOS: `~/Library/Application Support/AceCodeSearch/indexes/<workspace-key>/index.db`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/AceCodeSearch/indexes/<workspace-key>/index.db`

`workspace-key` is derived from normalized, sorted workspace roots, so Windows path casing and multi-root order do not split VS Code and Cursor onto different databases.

See [README_Dev.md — Cross-IDE Primary binding and compatibility](README_Dev.md#cross-ide-primary-binding-and-compatibility) for startup precedence, compatibility migration, and the verification matrix.

## Large Workspace Performance

For very large codebases (validated on UE 5.61), 0.4.x focuses on fixing “**Up to date** but Extension Host still at high CPU and search feels stuck.” Profiling shows that for a warm index, an `AActor`-style FTS query reaches 10k hits in about **200ms**; the bottleneck is file watching and UI delivery in the Extension Host, not SQLite or the search algorithm itself.

**File watching**

- VS Code/Cursor use the editor’s native `FileSystemWatcher`; recursive watching runs in the file service process instead of chokidar walking millions of paths in the Extension Host
- CLI keeps a chokidar fallback for command-line indexing
- include/exclude matchers are compiled once and shared by the scanner and watchers
- File indexing pauses during search and drains queued events in batches afterward
- Status shows **Up to date** only after watchers are ready, not while the Extension Host is still doing heavy setup

**Streaming search & results panel**

- FTS cursor iteration (`stmt.iterate`) streams hits: first batch **50**, then **500** per batch
- Extension posts to the webview in **100**-row chunks and waits for ACK to avoid `postMessage` backlog slowing first paint
- Webview uses plain text for the first batch, then merges later batches via `requestAnimationFrame` before DOM append
- Background indexing pauses automatically while you search to reduce disk IO contention
- **Updating** status shows **loaded / found** counts so `2,050 hits` is not mistaken for 2,050 rows already rendered

**Diagnostic logs (optional)**

- `codeSearch.profileSearch` is **off** by default; enable it when you need performance troubleshooting
- When enabled, a unique JSONL log is created at search start with 250ms checkpoints; terminal states: `success` / `cancelled` / `error` / `disposed`
- Command `codeSearch.openProfileLogFolder` opens the log folder; `latest-profile.jsonl` always points to the most recent session

After indexing completes, target behavior on real UE workspaces: first batch ≤500ms, 10k results ≤5s, Extension Host CPU drops quickly when idle.

## Header / Source Switch (Alt+O)

After **C/C++ files are indexed**, press **`Alt+O`** to switch between paired `.h` / `.cpp` (and `.hpp`, `.cc`, etc.) without relying on C/C++ Tools or clangd header/source switching.

- **Index-based**: counterpart files must exist in the indexed `files` table; otherwise you see “counterpart not found in index”
- **Pairing priority**: same directory + stem → UE-style `Public` ↔ `Private` folders → other directories (closest path wins)
- **Command**: `codeSearch.switchHeaderSource` (Ace Code Search: Switch Header/Source)
- **Shortcut conflicts**: on activation the extension auto-migrates user `keybindings.json` entries that still bind Alt+O to `C_Cpp.SwitchHeaderSource` / `clangd.switchheadersource`, and keeps overriding those legacy command IDs

## Class Inheritance Tree

Click the hierarchy icon in the search toolbar—no search is required—to open a separate panel containing all indexed C/C++ `class` / `struct` inheritance relationships. Clicking a class name opens its declaration at the indexed line.

- Declarations are incrementally cached in writable index databases while search and indexing are idle; parsing uses at most two background workers
- Read-only legacy secondary indexes remain compatible and use an on-demand in-memory fallback
- Supports UE API macros, namespaces, multiline declarations, `final`, multiple inheritance, access modifiers, and virtual bases
- Clearing a filter returns to the selected class, and the class context menu can expand or collapse all subclasses
- Large graphs start collapsed and cap each render at 5,000 tree occurrences; use the filter to narrow further

## Performance

Ace Code Search uses **pre-indexed, persistent full-text search**. For repeated searches in large repositories, it is typically faster than VS Code’s built-in on-demand disk scan.

- **SQLite FTS5 inverted index**: Files are indexed in the background; queries use `MATCH` with **BM25** relevance ranking instead of scanning the whole tree every time
- **Search while indexing**: On first open of a large workspace, you can search before indexing reaches 100%; status bar and toolbar show Scanning / Indexing / Up to date
- **Incremental updates**: VS Code/Cursor use native file watchers (CLI keeps chokidar); unchanged files are skipped via `mtime`; add/change/delete triggers per-file re-indexing; include/exclude rules are compiled once
- **Index/search coordination**: file watching and indexing pause during search, then drain queued events in batches; batch commits (every 100 files) and configurable **multi-threaded reads** (`codeSearch.indexThreads`) speed up initial builds
- **Streaming result delivery**: first 50 hits paint quickly; later batches use webview ACK backpressure so large result sets stay responsive
- **Local persistence**: New workspace indexes live in a cross-IDE application-data directory (WAL mode); legacy `globalStorage` indexes remain compatible, and restarts do not unconditionally rebuild them
- **Configurable excludes**: Defaults skip `node_modules`, `dist`, binaries, and more to keep indexes smaller and builds shorter

Compared to built-in search: built-in is fine for ad-hoc, small-scope lookups; this extension targets **frequent symbol and full-text search**, with sub-second results common once indexing is warm. See [README_Dev.md — Indexing & search algorithm](README_Dev.md#索引与搜索算法).

## AI Agent / MCP Support

Ace Code Search includes a standalone, **read-only stdio MCP server** so Cursor, VS Code/Copilot, and other AI agents can query existing SQLite FTS indexes instead of repeatedly scanning large codebases with `grep`/`rg`.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `list_indexes` | List auto-discovered or explicitly configured indexes, roots, token counts, and completeness |
| `search_code` | Full-text search with index selection, case, phrase, fuzzy, loose matching, and query filters |
| `read_indexed_file` | Read a line range from an indexed file snapshot |
| `find_header_source` | Find indexed C/C++ header/source counterparts |
| `search_class_hierarchy` | Return a class's indexed descendant DAG with source locations |

Key `search_code` parameters:

- `caseSensitive`: exact case matching
- `phraseSearch`: adjacent multi-word phrase matching
- `fuzzy`: edit-distance typo tolerance
- `loose` + `looseGap`: terms in any order within a token span
- `contextLines` / `maxResults`: returned context and result cap
- Query syntax also supports `ext:`, `file:`, `dir:`, `age:`, `+/-` content filters, and `*` wildcards

There is currently no dedicated strict `wholeWord` parameter; search a complete known identifier as a bare token. If punctuation prevents a match, split it according to tokenization—for example, use `better sqlite3` for `better-sqlite3`.

`search_class_hierarchy` matches class names case-sensitively. A qualified name resolves one class; an ambiguous short name returns candidates and declaration locations. Results use a flat DAG so C++ multiple inheritance is preserved. `maxNodes` accepts 1–5000 or `"all"`; when omitted, the shared user setting `codeSearch.mcpClassHierarchyDefaultMaxNodes` applies (20 by default, 0 means all). Current hierarchy cache rows are reused, while missing or stale rows are parsed from the index snapshot in memory without database writes.

### Discovery and read-only behavior

- With no arguments, the server tolerantly discovers VS Code/Cursor `globalStorage` registries; broken automatic sources are reported in `list_indexes.warnings` instead of aborting startup
- By default it exposes only indexes fully contained by MCP client roots, accepting both standard `file://` URIs and Cursor's absolute Windows-path compatibility form. Once a client advertises roots, an empty, invalid, or failed response clears that session's scope instead of falling back to a potentially broad cwd; only clients without roots capability use `--workspace-root` / cwd. Parent or mixed-root indexes fail closed; cross-workspace access requires explicit `--all-indexes`
- Use strict `--registry <registry.json>` or explicitly authorized `--db <index.db>` sources; when more than one index is visible, pass `indexId`
- MCP never indexes, starts watchers, or writes databases/registries
- Primary/Secondary selection and writer leases are intentionally editor-side management operations, not MCP mutation tools; MCP only opens registered shared/manual databases read-only and never creates `.writer.lock`
- Results are **index snapshots**. Persisted build states other than `complete` return `partialIndex: true`; use direct reads or `rg` when unsaved changes matter, content is not indexed yet, or files are excluded

```bash
npm run mcp
npm run mcp -- --db /path/to/index.db
npm run mcp -- --registry /path/to/registry.json --workspace-root /path/to/workspace
# Only for intentional cross-workspace access: npm run mcp -- --all-indexes
```

### Skill and search-preference guidance

The toolbar document-check button (or **Ace Code Search: Install Agent Integration (Project Guidance + User MCP)**) writes:

- The sole project Skill: `.agents/skills/ace-code-search-mcp/SKILL.md`, shared by current Codex, VS Code/Copilot, and Cursor clients
- Stable user launcher: `~/.ace-code-search/mcp-launcher.cjs` (discovers the newest installed extension on every launch)
- Codex/Cursor user configs: `~/.codex/config.toml` and `~/.cursor/mcp.json`
- Supported VS Code versions discover the extension's `ace-code-search.mcp-servers` provider directly

> A Skill only documents usage. **Without an MCP server registration, the session will not expose** `list_indexes` / `search_code`. After install, restart Codex (or run `/mcp`) and retry.
>
> Codex/Cursor launcher configs require `node` on the client PATH; packaged native bindings cover Node.js 20, 22, and 24. VS Code's dynamic provider uses the editor runtime and does not need a separate PATH Node.

Keep project guidance only in `.agents`; the normal install does **not** create project `.codex`, `.github`, `.cursor`, or `.claude` guidance, and activation never writes silently. User-modified files, invalid markers, and custom MCP entries are preserved with warnings.

The Skill prefers Ace Code Search MCP when a matching index exists, but falls back to `rg`/filesystem search when the index is missing, incomplete, stale, or excludes the target.

The center of the search status bar shows the MCP service for the current workspace: gray **Waiting** before a client connects, green **Ready** while a live session is available, and a privacy-safe yellow human-readable action such as `正在搜索 “xxx”` (searching), `正在读取 File.ts:12–20` (reading), or `正在获取索引` (loading indexes). Multiple VS Code, Cursor, and Codex sessions are aggregated for display only; each IDE instance retains its own stdio session, index scope, and tool responses. Stale sessions disappear after the heartbeat timeout.

Optional personal command:

- **Ace Code Search: Copy Cursor User Rule (Personal)** — for Cursor Settings → User Rules only

> Verifiably managed, unmodified legacy project `.cursor/skills`, `.cursor/rules`, `.claude/skills`, project `.codex`, and `.github/instructions` files are migrated/removed; personal client copies and files of uncertain ownership are retained. See [README_Dev.md — MCP (AI Agent)](README_Dev.md#mcp-ai-agent).

## Feature List

✅ = implemented.

| Category | Feature | Status |
|----------|---------|--------|
| **Indexing** | Configurable root full-text indexing | ✅ Workspace roots + `code-search.autocreate` for custom roots |
| | Shared VS Code/Cursor Primary / manual Primary / single writer | ✅ Shared path + auto-discovery + read-only fallback |
| | Multi-root / Secondary indexes / path mapping | ✅ Read-only or automatic single-writer Secondaries + path mapping |
| | Incremental updates (file watcher) | ✅ VS Code native watcher (chokidar for CLI) |
| | Low-priority background throttling (Be extra nice) | ⬜ Planned |
| | Binary exclusion / configurable excludes | ✅ Binary detection + `excludeGlobs` |
| | Automatic `.gitignore` respect | ⬜ Planned (default exclude rules for now) |
| | Per-index include/exclude | 🟡 Excludes have Advanced UI; includes remain autocreate/global configuration |
| | Index status (Scanning / Indexing / Up to date) | ✅ Status bar + toolbar |
| | Index queue detail tooltip | ⬜ Planned |
| | Search while partially indexed | ✅ |
| | Force refresh | ✅ Command palette full rebuild |
| | Changed-only / all-files refresh modes | ⬜ Planned |
| | Index management (Primary source / search scope / create / forget / rename) | ✅ Redesigned management panel (editor tab) |
| | `code-search.autocreate` config file | ✅ JSON auto-create |
| | Ace Code Search CLI | ✅ `npm run cli` / `ess.bat` |
| **AI Agent** | Read-only stdio MCP | ✅ Index discovery, search, snapshot reads, class hierarchy, header/source pairing |
| | Skill / search-preference guidance | ✅ One shared `.agents` Skill for Codex, VS Code/Copilot, and Cursor |
| | MCP runtime status | ✅ Workspace-scoped Waiting / Ready / request summary |
| **Search** | Single / multi-word / phrase | ✅ |
| | Wildcard `*` (word-level) | ✅ |
| | Wildcards (inline / cross-line) `"this * that"` / `"this *:100 that"` | ✅ |
| | Loose phrase `loose:"A B"` | ✅ |
| | Fuzzy search | ✅ |
| | Case sensitivity toggle | ✅ Toolbar Aa |
| | Phrase search default toggle | ✅ Toolbar "" |
| | Filter-only search `file:*x* dir:y` | ✅ |
| **Filters** | `ext:` / `file:` / `dir:` | ✅ |
| | `age:` file modification time | ✅ |
| | `+` / `-` positive/negative content filters | ✅ |
| **Results UI** | Bottom-docked search panel | ✅ WebviewView panel |
| | Syntax-highlighted results | 🟡 Rule-based highlighting (not full TextMate theme) |
| | Hit count / elapsed time | ✅ |
| | Sortable result list (path / line / code) | ✅ Click column headers |
| | Context lines | ✅ Toolbar context icon; lines via `contextLines` setting |
| | Query syntax coloring (green / red filters) | ✅ |
| | Multiple tabs | ✅ Ctrl+Enter / + for new tab |
| | Tab lock | ✅ |
| | Code word autocomplete | ✅ |
| | Full-index C++ class hierarchy | ✅ Toolbar hierarchy icon; class names open declarations |
| **Navigation** | Search word under cursor / selection | ✅ `Alt+=` |
| | Ctrl+Alt+] / Ctrl+Alt+[ next/previous hit | ✅ |
| | Shift+Alt+F quick open file | ✅ |
| | Alt+O header/source switch (index-based) | ✅ |
| | Click to open / preview | ✅ Preview |
| | Auto-open single hit | ✅ Configurable via `autoOpenSingleHit` |

Legend: ✅ Done · 🟡 Partial · ⬜ Planned

## Shortcuts

| Command | Shortcut |
|---------|----------|
| Search Selection | `Alt+=` |
| Focus Search | `Shift+Alt+=` |
| Quick Open File | `Shift+Alt+F` |
| Switch Header/Source | `Alt+O` |
| Next Hit | `Ctrl+Alt+]` |
| Previous Hit | `Ctrl+Alt+[` |
| Refresh Index | Command palette |
| Manage Indexes | Toolbar ⚙ |
| Install Agent Skill | Toolbar document-check icon / command palette (writes `.agents` into the current project) |
| Show Class Inheritance Tree | Toolbar hierarchy icon / command palette |
| Choose Workspace Primary Index | Command palette |
| Open Secondary Index | Command palette |

## Install & Build

```bat
install.bat
build.bat
安装CodeSearch.bat
```

macOS / Linux: `chmod +x install.sh build.sh install-extension.sh bump-version.sh`, then `./install.sh` → `./build.sh` → `./install-extension.sh`.

See [AI Agent / MCP Support](#ai-agent--mcp-support) above for tools, search parameters, and Skill installation.

For configuration, Phase 2/3 usage, and CLI details, see [README_Dev.md](README_Dev.md) and [PHASE2.md](PHASE2.md).
