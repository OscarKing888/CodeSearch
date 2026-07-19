# Ace Code Search

A VS Code extension that provides full-text code indexing and instant search powered by SQLite FTS5.

![Ace Code Search screenshot](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/AceCodeSearch.png)

![Class Viewer 截图](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/CodeSearchClassViewer.png)

> **Independent Development Notice**
>
> This extension draws functional inspiration from the user experience of tools such as [Entrian Source Search](https://entrian.com/source-search/). However, all code, architecture, and implementation are independently designed and developed by this project. No third-party source code or proprietary assets were used. This project has no affiliation with or authorization from Entrian or its products.

For detailed development notes, see [README_Dev.md](README_Dev.md).

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
- **Local persistence**: Indexes live in a SQLite database under `globalStorage` (WAL mode), so restarts do not require a full rebuild unless you force refresh or files changed
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

Key `search_code` parameters:

- `caseSensitive`: exact case matching
- `phraseSearch`: adjacent multi-word phrase matching
- `fuzzy`: edit-distance typo tolerance
- `loose` + `looseGap`: terms in any order within a token span
- `contextLines` / `maxResults`: returned context and result cap
- Query syntax also supports `ext:`, `file:`, `dir:`, `age:`, `+/-` content filters, and `*` wildcards

There is currently no dedicated strict `wholeWord` parameter; search a complete known identifier as a bare token. If punctuation prevents a match, split it according to tokenization—for example, use `better sqlite3` for `better-sqlite3`.

### Discovery and read-only behavior

- With no arguments, the server auto-discovers Ace Code Search registries in VS Code and Cursor `globalStorage`
- Use `--registry <registry.json>` or `--db <index.db>` for an explicit source
- MCP never indexes, starts watchers, or writes databases/registries
- Results are **index snapshots**; use direct reads or `rg` when `partialIndex: true`, unsaved changes matter, content is not indexed yet, or files are excluded

```bash
npm run mcp
npm run mcp -- --db /path/to/index.db
npm run mcp -- --registry /path/to/registry.json
```

### Skill and search-preference guidance

On activation, the extension installs or updates:

- Canonical Skill: `~/.agents/skills/ace-code-search-mcp`
- Cursor compatibility mirror: `~/.cursor/skills/ace-code-search-mcp`
- VS Code/Copilot compatibility mirror: `~/.copilot/skills/ace-code-search-mcp`
- VS Code personal Instruction: `~/.copilot/instructions/ace-code-search.instructions.md`

The Instruction/Rule prefers Ace Code Search MCP when a matching index exists, but falls back to `rg`/filesystem search when the index is missing, incomplete, stale, or excludes the target. Cursor only supports personal User Rules through its settings UI, so the extension offers a one-time prompt to copy the recommended rule.

Commands:

- **Ace Code Search: Install Agent Skill and Search Guidance** (search toolbar document-check icon, or command palette)
- **Ace Code Search: Copy Cursor User Rule**

> Skill/Rule distribution and MCP server registration are separate. The agent client must still register the MCP server; Cursor's personal config is `~/.cursor/mcp.json`. See [README_Dev.md — MCP (AI Agent)](README_Dev.md#mcp-ai-agent) for a complete configuration example.

## Feature List

✅ = implemented.

| Category | Feature | Status |
|----------|---------|--------|
| **Indexing** | Configurable root full-text indexing | ✅ Workspace roots + `code-search.autocreate` for custom roots |
| | Multi-root / secondary read-only indexes / path mapping | ✅ Secondary indexes + directory mapping |
| | Incremental updates (file watcher) | ✅ VS Code native watcher (chokidar for CLI) |
| | Low-priority background throttling (Be extra nice) | ⬜ Planned |
| | Binary exclusion / configurable excludes | ✅ Binary detection + `excludeGlobs` |
| | Automatic `.gitignore` respect | ⬜ Planned (default exclude rules for now) |
| | Per-index include/exclude | 🟡 Supported via autocreate JSON, no full UI |
| | Index status (Scanning / Indexing / Up to date) | ✅ Status bar + toolbar |
| | Index queue detail tooltip | ⬜ Planned |
| | Search while partially indexed | ✅ |
| | Force refresh | ✅ Command palette full rebuild |
| | Changed-only / all-files refresh modes | ⬜ Planned |
| | Index management (create / delete / move / rename) | ✅ Dedicated management panel (editor tab) |
| | `code-search.autocreate` config file | ✅ JSON auto-create |
| | Ace Code Search CLI | ✅ `npm run cli` / `ess.bat` |
| **AI Agent** | Read-only stdio MCP | ✅ Index discovery, search, snapshot reads, header/source pairing |
| | Skill / search-preference guidance | ✅ Cursor + VS Code/Copilot |
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
| Install Agent Skill / Rule | Toolbar document-check icon / command palette |
| Show Class Inheritance Tree | Toolbar hierarchy icon / command palette |
| Open Secondary Index | Command palette |

## Install & Build

```bat
install.bat
build.bat
安装CodeSearch.bat
```

macOS / Linux: `chmod +x install.sh build.sh install-extension.sh bump-version.sh`, then `./install.sh` → `./build.sh` → `./install-extension.sh`.

See [AI Agent / MCP Support](#ai-agent--mcp-support) above for tools, search parameters, and Skill/Rule installation.

For configuration, Phase 2/3 usage, and CLI details, see [README_Dev.md](README_Dev.md) and [PHASE2.md](PHASE2.md).
