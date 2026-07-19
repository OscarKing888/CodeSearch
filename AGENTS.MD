# Agent Notes

## Documentation upkeep

- Whenever an implementation changes, a bug fix approach is discovered, or a feature behavior is updated, record the relevant notes in this file during the same change.
- Keep entries practical for the next maintainer: include what changed, why it mattered, key files/scripts, and the verification or release caveat if there is one.
- Prefer concise topic sections over long chronological logs. Update an existing section when the new note belongs there.

## Compatibility first

- Before changing functionality, preserve compatibility for existing developer and user environments where practical.
- If a newer tool/runtime is required, prefer a local fallback or clear migration path before hard-failing existing setups.
- Record any compatibility tradeoff, fallback behavior, or dropped support in this file and in user-facing scripts when relevant.

## better-sqlite3 native packaging

- The extension uses `better-sqlite3`, which is a native Node module. VS Code and Cursor run extensions inside Electron, so the module must be rebuilt for Electron's Node ABI instead of the system Node ABI.
- Runtime loading is implemented in `src/native/betterSqlite3.ts`. It looks for `native/<platform>-<arch>-<abi>/better_sqlite3.node` under the extension root and passes that path as `nativeBinding`.
- The root `native/` directory is a generated build artifact and is intentionally ignored by git. It must still be present inside the packaged VSIX.
- `.vscodeignore` excludes `node_modules/better-sqlite3/build/**`, so release packages rely on root `native/` (Electron) and `native-node/` (system Node / MCP) binaries, not the local npm build output.

## Current ABI coverage

- `scripts/rebuild-electron.js all` builds the fixed supported Electron set plus locally detected VS Code/Cursor Electron versions.
- The fixed set is:
  - Electron `37.7.0` for ABI `136`
  - Electron `40.0.0` for ABI `143`
  - Electron `42.0.0` for ABI `146`
- ABI `146` is required by newer VS Code builds. A VSIX missing `native/win32-x64-146/better_sqlite3.node` fails on Windows with `No better_sqlite3 binary for Electron ABI 146`.

## Release workflow

- `.github/workflows/release.yml` builds native artifacts for:
  - `linux-x64`
  - `win32-x64`
  - `darwin-arm64`
  - `darwin-x64`
- The package job downloads those artifacts, runs `scripts/merge-native-artifacts.js`, then runs `scripts/validate-native-artifacts.js`.
- The validation script requires every release target above to include ABI `136`, `143`, and `146`. Missing binaries fail the release before the VSIX is packaged or published.

## Local verification

- Use Node.js 20+ for local packaging. `better-sqlite3` and `@vscode/vsce` in this repo require modern Node versions.
- On Windows, `build.bat` and `install.bat` run `scripts/ensure-node.ps1` before npm or native rebuild work. It uses PATH Node.js when it is 20+, otherwise downloads Node.js 24 into ignored `.tools/` and prepends it for the current script process.
- `.tools/` is build-only and must stay excluded from both git and VSIX packages. If it appears in `vsce package` output, fix `.vscodeignore` before publishing.
- `build.bat` should call `npm run package` instead of invoking `npx @vscode/vsce ... https://...` directly. Raw URL arguments after `call npx` can be misparsed by Windows batch after VSIX creation.
- `scripts/check-node-version.js` remains the final guard before npm work. Do not remove this preflight unless the dependency set is downgraded to support older Node.
- If npm fails with `EINTEGRITY`, the usual local fix is `npm cache clean --force`, then rerun with Node.js 20+.
- Useful commands:
  - `npm ci`
  - `npm test`
  - `npx tsc --noEmit`
  - `node scripts/rebuild-electron.js all`
  - `npm run validate:native`
  - `npm run package`
- On a single local platform, `npm run validate:native` only passes if the full cross-platform native matrix has already been merged into root `native/`.

## Local VSIX install

- `安装CodeSearch.bat` / `install-extension.sh` uninstall `OscarKing888.ace-code-search` (and lowercase `oscarking888.ace-code-search`) before installing the local `.vsix`. Marketplace installs block `--force` alone; uninstall first is required to replace them.
- Both scripts also delete leftover `oscarking888.ace-code-search-*` folders under `%USERPROFILE%\.vscode\extensions` and `%USERPROFILE%\.cursor\extensions`. CLI uninstall alone does not remove old version directories; stale folders can leave the UI on an older version.
- Install picks the VSIX matching `package.json` version only (no newest-by-date fallback), then verifies `code`/`cursor --list-extensions --show-versions` **and** that the matching folder exists under the target editor's extensions root. `install-extension.sh` is Bash 3.2 compatible (no `mapfile`). Target `all` skips missing editor CLIs and succeeds if at least one editor installs; explicit `vscode`/`cursor` still fail hard when that CLI is missing or install fails.
- On macOS, Cursor often installs `/usr/local/bin/code` as a symlink into `Cursor.app`. `install-extension.sh` therefore prefers `/Applications/Visual Studio Code.app/.../bin/code` for VS Code and rejects a PATH `code` that resolves to Cursor; otherwise “install to VS Code” silently targets Cursor and `~/.vscode/extensions` stays empty.
- On macOS/Linux, shell entrypoints should be executable: `chmod +x install.sh build.sh install-extension.sh bump-version.sh` (git mode `100755`).
- `build.bat` ends by calling `安装CodeSearch.bat` after packaging. `build.sh` uses `npm run package`, then restores system Node `better-sqlite3` for CLI/MCP, then calls `install-extension.sh`.

## Version bump checklist

- Project version is stored in exactly these project-owned locations:
  - `package.json` top-level `version`
  - `package-lock.json` top-level `version`
  - `package-lock.json` `packages[""].version`
  - `CHANGELOG.md` newest release heading
- Do not edit dependency versions in `package-lock.json`; entries such as `node-api-version` are third-party packages.
- GitHub Actions validates that release tag `vX.Y.Z` matches `package.json` `version`.
- Preferred one-command update:
  - `npm run version:bump -- 0.2.1 --notes "Fix Electron ABI 146 native packaging."`
- Windows wrapper for the same command:
  - `bump-version.bat 0.2.1 --notes "Fix Electron ABI 146 native packaging."`
- macOS / Linux wrapper:
  - `./bump-version.sh 0.2.1 --notes "Fix Electron ABI 146 native packaging."`
- The script updates `package.json`, `package-lock.json`, and inserts a new top changelog section if it does not already exist. It does not commit, tag, build, or publish.

## MCP server (AI agents)

- Read-only stdio MCP lives in `src/mcp/` and builds to `dist/mcp.js` (`npm run mcp`).
- Tools: `list_indexes`, `search_code`, `read_indexed_file`, `find_header_source`.
- Discovery: `--db`, `--registry`, or auto-find VS Code/Cursor `globalStorage/.../code-search/registry.json`.
- Opens indexes read-only; does not index, watch, or write `registry.json`. Results are index snapshots (directory mappings applied to `localPath`).
- Uses system Node `better-sqlite3` via `native-node/<platform>-<arch>-<abi>/` (staged by `npm run rebuild:node`) or the local `node_modules` build. MCP always calls `configureBetterSqlite3` with the extension/repo root (auto-detected from `dist/mcp.js` when `--extension-root` is omitted). Do **not** point MCP at Electron `native/` ABIs. After Electron rebuilds, run `npm run rebuild:node` (or use `build.sh`, which restores Node ABI and stages `native-node/` before/after packaging as needed).
- Coverage: `test/mcpTools.test.ts` (handlers + discovery + path mapping).
- `dist/cli.js` / `dist/mcp.js` shebang comes only from the esbuild `banner` — do not also put `#!/usr/bin/env node` in the TypeScript entry (double shebang breaks `node dist/*.js`).
- Project skill `.cursor/skills/ace-code-search-mcp/SKILL.md` teaches agents to choose an index and use case, phrase, fuzzy, loose, wildcard, and filter options. Keep it aligned with `src/mcp/server.ts` schemas and `src/search/QueryParser.ts`; there is currently no strict `wholeWord` MCP parameter.
- `src/agentSkillInstaller.ts` installs the packaged template from `resources/skills/ace-code-search-mcp/SKILL.md` into **project** paths by default: `{workspace}/.agents/skills/ace-code-search-mcp` (Codex / shared, highest useful priority) and `{workspace}/.cursor/skills/ace-code-search-mcp` (Cursor). Personal `~/.agents/skills` install remains available via `installPersonalAgentSkill` for optional cross-repo use, but the toolbar/command no longer targets it. Never overwrite an unmanaged existing skill.
- Toolbar `#btnInstallGuidance` / command `codeSearch.installAgentSkill` installs project Skill + Rule **and** registers the stdio MCP server for Codex (`~/.codex/config.toml` + project `.codex/config.toml`) and Cursor (`~/.cursor/mcp.json`), pointing at `{extensionPath}/dist/mcp.js`. Skill files alone do not expose `list_indexes` / `search_code`; Codex must load the MCP server (restart or `/mcp`). Activation does **not** auto-write. Keep the packaged Skill template byte-identical to `.cursor/skills` / `.agents/skills`; `test/agentSkillInstaller.test.ts` and `test/mcpConfigInstaller.test.ts` cover installs. MCP client config merge uses managed `# BEGIN/END ACE-CODE-SEARCH-MCP` markers in TOML.
- Search preference guidance: packaged `resources/rules/ace-code-search-first.mdc` installs to `{workspace}/.cursor/rules/` (must stay byte-identical to this repo’s `.cursor/rules/ace-code-search-first.mdc`); packaged `resources/rules/ace-code-search.instructions.md` installs to `{workspace}/.github/instructions/` for VS Code Copilot. Optional personal helpers remain: `installVscodePersonalInstruction` → `~/.copilot/instructions/`, and command `codeSearch.copyCursorUserRule` for Cursor Settings User Rules. Do not write invented `~/.cursor/rules` global files.
- Maintainer rule `.cursor/rules/mcp-feature-parity.mdc` (`alwaysApply: true`): when adding searchable product features, update MCP tools/schemas, `test/mcpTools.test.ts`, Skill templates, and guidance docs in the same change; document intentional MCP exclusions. Do not ship agent-facing panel/CLI search behavior without MCP discovery unless explicitly scoped out.
- `src/agentRuleInstaller.ts` updates only its marked instruction/rule files and preserves unmanaged conflicts. Coverage: `test/agentRuleInstaller.test.ts`.

## Search panel webview UI

- Search result tabs are rendered in `src/ui/webview/main.ts` with inline styles from `src/ui/SearchPanelProvider.ts`.
- Lock state is shown only via the JS `.tab-lock` element (`🔒` / `🔓`). Do not add a CSS `::after` lock on `.tab.locked`; that duplicates the icon.
- Tab layout uses `.tab-label` (`flex: 1; min-width: 0`) for ellipsis, and `.tab-lock` / `.tab-close` use `flex-shrink: 0` so long labels do not clip the lock or close controls.
- Locked tabs intentionally hide the close button; unlock first to close.
- Result row copy format: `{absolutePath}:{line}\t{lineText}` via right-click **Copy** / **Copy All**. Clipboard writes go through `copyToClipboard` postMessage and `vscode.env.clipboard.writeText` in `SearchPanelProvider.ts` (not `navigator.clipboard` in the webview).
- **Copy All** uses the active tab's loaded hits in current table sort order, newline-separated.
- Hide the result context menu (`hideResultContextMenu`) when switching tabs or creating a new tab so `contextMenuHitIndex` cannot go stale across tab changes.
- Search query escape sequences: `\\` → `\`, `\"` → `"` in main terms and `+/-` content filters (`src/search/QueryParser.ts` `unescapeQueryString`). Example: `\"AbleCore\"` searches for literal `"AbleCore"`.
- Autocomplete suggestions are ordered by token length ascending, then frequency descending (`IndexService.getTokenSuggestions`, `IndexManager.getTokenSuggestions`).
- Autocomplete query path: SQL fetches up to 500 high-frequency candidates via `idx_tokens_token_freq` (`token COLLATE NOCASE, freq DESC`), then TypeScript sorts by length and truncates (`src/index/tokenSuggestions.ts`). Avoid `ORDER BY LENGTH(token)` in SQL on large `tokens` tables — it forces a temp B-tree over huge prefix match sets (e.g. UE5.61 ~2.5M tokens).
- Existing databases migrate on `IndexService.initialize()`: if `idx_tokens_token_freq` is missing, create it once (~6 s on multi-million-token indexes). New databases get the index from `schema.sql`.
- `SearchPanelProvider.handleAutocomplete()` uses a monotonic request sequence + `setImmediate` so stale autocomplete work is skipped when the user types ahead of in-flight queries.
- Autocomplete keyboard: Opening the list leaves `acActiveIndex = -1` (no default highlight). Enter searches typed text unless a suggestion was arrow-highlighted (`acActiveIndex >= 0`), then Enter accepts that highlight. Tab always accepts the first suggestion, or the arrow-highlighted one if navigated.
- Search runs on **submit** only: Enter, Ctrl+Enter (new tab), Tab/click autocomplete acceptance, or toggling search mode buttons. Typing in the search box updates highlight and autocomplete but does not query the index (avoids slow live search on large workspaces like UE5.61).
- Index status when up to date shows token vocabulary size before the message, e.g. `Index: 12,345 tokens · Up to date` (`IndexService.getTokenCount`, `IndexManager.getCombinedProgress`).
- Status bar layout: `#statusHits` (left, Ready or hit stats), `#statusIndex` + `#statusVersion` (right meta group). Version is always visible in `#statusVersion` after Index info; it is not embedded in Ready/hit text.
- `WebviewView.onDidChangeVisibility` has no boolean event payload; read `webviewView.visible`. Browser-only entry points under `src/ui/webview`, `src/ui/manage-webview`, and `src/ui/class-hierarchy-webview` stay excluded from the Node extension `tsconfig.json` and are compiled by esbuild.
- **File watching**: VS Code/Cursor uses `workspace.createFileSystemWatcher(RelativePattern)` per index root/include glob so recursive watching stays in the editor file service; CLI/non-VS Code callers retain the chokidar fallback. `IndexingMatcher` in `src/index/excludePatterns.ts` caches exact-name sets and compiled `Minimatch` instances shared by scanning, event filtering, and fallback watching. `FileWatcher` coalesces each path for 300 ms, queues events while searches pause an index, and drains resumed work in event-loop-sized batches. Register the watcher before reporting `Up to date`; never reintroduce an extension-host chokidar crawl for editor sessions.
- **Streaming search**: panel search uses `SearchService.searchStreaming()` / `MultiIndexSearchService.searchStreaming()` with `FIRST_BATCH_SIZE` 50 and `STREAM_BATCH_SIZE` 500 (`src/search/searchStreamBuffer.ts`). Streaming FTS paths use `iterateCandidateRows()` (`stmt.iterate`) so hits can yield before the full candidate set is loaded; sync `search()` still uses `fetchCandidateRows().all()`. Single-index workspaces pass batches through without re-batching. `SearchPanelProvider.runSearch()` decouples search production from UI via a queue (FTS can run ahead), starts `createRegistry()` in parallel with search, skips syntax highlight on the first non-empty batch, and highlights from batch 2 onward via sync `highlightHitsSync`. The first batch renders immediately with lightweight match wrapping, then receives a `resultsHighlightPatch` for syntax colors. After `searchStarted` and each `resultsPartial`, the provider yields and waits for `resultsPartialAck`; every stream message and ack carries `searchId` + `chunkId`, and `ResultsPartialAckController` ignores stale/late acknowledgements. Batches after the first are split into `UI_POST_CHUNK_SIZE` 100 hits. Webview pending rAF state is bound to one tab/search, is cancelled and acked on tab/search/visibility changes, and explicit missing tab IDs are dropped instead of falling back to the active tab. Background/hidden tabs update data and ack without DOM work. While streaming, status shows loaded rows versus discovered hits when those counts differ. Completion reorders existing DOM row groups to the selected column order instead of rebuilding all rows. Sync `search()` remains for CLI/tests. Protocol tests: `test/resultsPartialAckController.test.ts`, `test/searchStreamBuffer.test.ts`.
- **Search profile logs** (`codeSearch.profileSearch`, default off): when enabled, search start immediately creates a unique JSONL log under `{globalStorage}/profile-logs/` and writes its meta line. Marks checkpoint through one serialized queue every 250 ms; first-result, ACK timeout, and terminal state flush immediately. Every session ends once with `success`, `cancelled`, `error`, or `disposed`; summary records `ttfrMs`, error text, and each chunk's ACK outcome/wait. `latest-profile.jsonl` and the workspace mirror use per-path ownership so an older search's late finalize cannot replace a newer session; `<workspace>/.code-search/profile-latest.jsonl` remains best-effort and never blocks the global log or search. Profile marks carry `searchId`; search-side marks use `AsyncLocalStorage`, so overlapping cancellation cannot clear or contaminate a newer session. Command `codeSearch.openProfileLogFolder` creates/reveals the folder even before the first completed search. Implementation: `src/utils/searchProfile.ts`; coverage: `test/searchProfileContext.test.ts`, `test/searchProfilePersistence.test.ts`.

## Manage Indexes webview UI

- Index cards are rendered in `src/ui/manage-webview/main.ts`; HTML shell and styles live in `src/ui/IndexManagePanel.ts`.
- Card title uses full root folder path(s) via `formatIndexDisplayTitle` in `src/ui/indexDisplayTitle.ts` (`displayTitle` from `IndexManagementService.getIndexListPayload()`) — not `meta.name` (which defaults to `Primary`).
- Multiple roots join with `; `; empty `rootDirs` falls back to `name` or `—`.
- Every card shows a **Primary** or **Secondary** badge (`isPrimary`); attached secondaries also show **Attached**. Internal rename still edits `meta.name`; cards show `Name:` in meta for that label.
- Delete confirmation uses `displayTitle`, not raw `meta.name`.

## Class inheritance tree panel

- The search toolbar hierarchy button is an inline SVG and is always enabled; it opens the workspace-wide indexed tree without requiring a search. The context-lines toggle is also an inline SVG but must retain `#contextLineCount`; update that span instead of replacing the button's `textContent`. `#btnInstallGuidance` installs/repairs **project** Agent Skill + Rule via `codeSearch.installAgentSkill` (`.agents/skills`, `.cursor/skills`, `.cursor/rules`, `.github/instructions`).
- `src/hierarchy/classHierarchyCacheStore.ts` owns the disposable `class_hierarchy_files`, `class_hierarchy_declarations`, and `class_hierarchy_bases` tables. Writable indexes create/migrate this schema idempotently; read-only/legacy secondary indexes are feature-detected without writes and fall back to an in-memory parse. Content-update/delete triggers hide or remove stale cache rows, and parser/mtime/size/fingerprint checks prevent stale commits.
- `CLASS_HIERARCHY_SOURCE_EXTENSIONS` includes `cs`, while the full-text scanner already indexes `.cs` as text. Parser version 2 adds C# declaration extraction, so existing hierarchy caches intentionally reparse in idle/background work before persisting the merged result.
- Increment `DEFAULT_CLASS_HIERARCHY_PARSER_VERSION` whenever extraction or stored declaration/base semantics change after release; mismatched markers are intentionally treated as pending files.
- A fresh manager may inspect an existing writable cache with the store's no-write mode while search/indexing is busy; defer writable schema initialization until idle. Progress, attach/detach, directory-mapping changes, and explicit panel Refresh must invalidate the in-memory display model. Use the generation guard so a stale in-flight build cannot overwrite a newer invalidation.
- `src/hierarchy/ClassHierarchyCacheManager.ts` schedules cache work only while `IndexService.isBackgroundWorkAllowed()` is true. It pages source text from SQLite, parses with at most two `worker_threads`, retains compact declarations in memory, then applies the completed parse in bounded transactions with an event-loop yield and busy-state check between chunks. If indexing or search pause starts, stop committing and retry the remaining pending files later. Workers must never load `better-sqlite3` or own a database handle.
- Parsing/building lives in dependency-free `src/hierarchy/classHierarchy.ts`. It targets indexed C/C++/UE `class` / `struct` headers and C# `.cs` class/struct headers, including file-scoped namespaces. C# contributes its one concrete superclass (not trailing interfaces), which allows UnrealSharp `partial class Managed : NativeBase` declarations to merge with indexed C++ bases. The graph supports C++ multiple inheritance as a DAG and represents missing/ambiguous bases as external nodes. Explicitly qualified bases must not fall back to an unrelated short-name match.
- Secondary cache rows retain their original indexed path; map paths through `IndexManager.mapHitPath()` only while building the display model. Prefix declaration IDs by index and deduplicate mapped locations so primary/secondary copies do not collide.
- The standalone panel shell is `src/ui/ClassHierarchyPanel.ts`; browser code is `src/ui/class-hierarchy-webview/main.ts`, bundled to `dist/webview/class-hierarchy.js`. The parser worker bundles separately to `dist/workers/class-hierarchy-worker.js`. Class-name clicks use the mapped path and one-based line/column through the host, never a webview command URI. Keep the `.header` toolbar sticky at the panel top with an opaque background and sufficient stacking order so the title, filter, and actions remain visible while the tree scrolls, including when controls wrap in a narrow panel.
- Large trees start collapsed and cap each render at 5,000 occurrences. Filtering keeps an occurrence-level selection; clearing the filter expands and prioritizes every node on its path before scrolling it into view. A manual twistie expand/collapse must also reveal the selected occurrence after DOM replacement. When the cache pushes an updated model, retain expansion for stable node IDs, default only new branches to collapsed, and restore a selected occurrence only when its full parent-child path remains valid. The class-row context menu offers **显示子类** (clear the filter, reveal the occurrence path, and open that class) plus expand/collapse all reachable subclasses; all actions must remain cycle/DAG safe.
- Filtering is stack-safe: `collectHierarchyFilterMatches()` finds direct name matches and propagates visibility through reverse parent edges iteratively, while the webview renderer uses explicit enter/exit frames rather than recursive DOM calls. Keep unknown-size declaration/child appends as loops, not `array.push(...items)`; large UE indexes can exceed V8's argument limit even when graph depth is shallow.
- Keep cache/parser/worker/tree-state coverage (`test/classHierarchy*.test.ts`) explicit in the `npm test` chain. The UI should remain cycle-safe and use DOM `textContent` for class names and paths.

## Header/Source pairing

- Pairing uses indexed `files` rows (`path`, `ext`, `dir`); counterparts must exist in the index — no filesystem fallback.
- Logic lives in `src/pairing/headerSourcePairing.ts`; `IndexService.findHeaderSourceCounterparts()` runs the SQL query.
- Priority: same `dir` + stem, then UE-style `Public` ↔ `Private` dir swap, then other dirs by path distance.
- Command `codeSearch.switchHeaderSource` is bound to `Alt+O` for C/C++ extensions; package.json unbinds `C_Cpp.SwitchHeaderSource` and `clangd.switchheadersource` on the same key.
- Do not register or re-register `C_Cpp.SwitchHeaderSource` or `clangd.switchheadersource`; VS Code rejects duplicate command IDs and repeated attempts can make the extension host unresponsive. Third-party commands remain owned by their extensions. `registerHeaderSourceCommandOverrides()` is retained only as a compatibility no-op.
- `migrateUserHeaderSourceKeybindings()` runs on extension activate; if user `keybindings.json` still binds Alt+O to a legacy command, rewrite it to `codeSearch.switchHeaderSource` and insert unbind entries for the old commands.

## Release documentation

- `README_Dev.md` contains the release SOP, including Marketplace Publisher setup, Azure DevOps PAT creation, GitHub `VSCE_PAT` secret setup, and publish troubleshooting.
- Keep the SOP aligned with official Microsoft docs when updating PAT or Marketplace steps because Azure DevOps UI labels and policies can change.
- Azure DevOps PAT creation should document both the direct URL `https://dev.azure.com/<Your_Organization>/_usersSettings/tokens` and the top-bar User settings icon. The round avatar/account flyout is not the PAT menu and may only show Microsoft account, directory switching, account switching, and sign out.
- VS Code docs currently note that Azure DevOps global PATs retire on 2026-12-01; plan a future migration to Microsoft Entra ID or managed identity publishing before that date.
