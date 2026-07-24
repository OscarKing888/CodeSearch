# Agent Notes

## Maintainer rules

- When behavior, a bug-fix approach, or a feature contract changes, update the matching topic section here in the same change (what / why / key files / verification caveat). Prefer concise sections over chronological logs.
- Preserve compatibility for existing developer and user environments where practical; prefer a local fallback or clear migration path before hard-failing. Record tradeoffs here and in user-facing scripts when relevant.

## Native packaging

- Electron hosts need Electron-ABI `better-sqlite3`; CLI/MCP need system-Node ABI. Load via `src/native/betterSqlite3.ts` from `native/<platform>-<arch>-<abi>/` (Electron) or `native-node/...` (Node). Both dirs are gitignored build artifacts but must ship inside the VSIX; `.vscodeignore` excludes `node_modules/better-sqlite3/build/**`.
- Fixed Electron set (plus locally detected editor versions via `scripts/rebuild-electron.js all`): `37.7.0`→ABI `136`, `40.0.0`→`143`, `42.0.0`→`146`. Missing ABI 146 fails newer VS Code on Windows. Do not lower `engines.vscode` `^1.103.0` without validating an older Electron matrix.
- Published `native-node/` covers Node 20/22/24 ABIs `115`/`127`/`137`. Local `build.bat` / `build.sh` use `rebuild-node --all-detected` because Cursor MCP may resolve `node` to its helper runtime, not PATH Node. Release (`.github/workflows/release.yml`) builds linux-x64 / win32-x64 / darwin-arm64 / darwin-x64 and validates all 24 platform/ABI entries plus packaged MCP/CLI.
- Local packaging needs Node 20+. Windows `build.bat` / `install.bat` run `scripts/ensure-node.ps1` (may download Node 24 into ignored `.tools/` — keep it out of git and VSIX). Prefer `npm run package` over raw `npx @vscode/vsce ... https://...` in batch (URL args misparse after VSIX creation). Keep `scripts/check-node-version.js`. Useful: `npm ci`, `npm test`, `npx tsc --noEmit`, `node scripts/rebuild-electron.js all`, `npm run rebuild:node:detected`, `npm run validate:native`, `npm run test:native`, `npm run package`. Single-platform `validate:native` needs the full cross-platform matrix already merged into `native/`.

## Local VSIX install

- `安装CodeSearch.bat` / `install-extension.sh` uninstall `OscarKing888.ace-code-search` (and lowercase id) and delete leftover `oscarking888.ace-code-search-*` under VS Code/Cursor extensions dirs before install; Marketplace blocks `--force` alone, and stale folders can leave the UI on an older version.
- Install the VSIX matching `package.json` version only; verify CLI list **and** the matching extensions folder. Target `all` skips missing editor CLIs if at least one succeeds; explicit `vscode`/`cursor` fail hard. On macOS, prefer real VS Code `code` and reject a PATH `code` that resolves to Cursor. Keep shell entrypoints executable (`100755`). `build.bat` / `build.sh` package then call the install script (`build.sh` restores system-Node `better-sqlite3` first).

## Version bump

- Project-owned version locations only: `package.json` top-level, `package-lock.json` top-level + `packages[""].version`, and `CHANGELOG.md` newest heading. Do not edit third-party versions in the lockfile. Prefer `npm run version:bump -- X.Y.Z --notes "..."` (`bump-version.bat` / `./bump-version.sh`); it does not commit, tag, build, or publish. Release tags `vX.Y.Z` must match `package.json`.

## MCP server (AI agents)

- Read-only stdio MCP in `src/mcp/` → `dist/mcp.js` (`npm run mcp`). Tools: `list_indexes`, `search_code`, `read_indexed_file`, `find_header_source`, `search_class_hierarchy`. Multi-index visibility requires `indexId`. Never index, watch, write `registry.json`, read `workspaceState`, or acquire a writer lease; binding / shared-path / lease ops stay editor-side. Non-`complete` `indexBuildStateV1` → `partialIndex: true`.
- Discovery: `--db`, `--registry`, or tolerant auto-discovery of editor `registry.json` (broken autos → `list_indexes.warnings`; explicit sources stay strict; zero indexes is valid). Scope: client roots, else repeated `--workspace-root`, else cwd only when roots are not advertised. After a client advertises roots, empty/invalid/failed roots are authoritative empty scope — never fall back to cwd. Mapped output roots must sit under a client root; cross-workspace needs `--all-indexes`; `--db` is an explicit unscoped source. Each stdio process owns its session/roots/transport. `src/mcp/clientRoots.ts` accepts `file://` plus absolute Win32/POSIX raw paths; reject relative/non-file. Keep post-init `notifications/tools/list_changed` in `serverLifecycle.ts` for Cursor’s zero-tools snapshot. Align `server.ts`, Skill, `QueryParser` (no strict `wholeWord` MCP param). Coverage: `test/mcpTools.test.ts`.
- Hierarchy: case-sensitive qualified or unique short name; ambiguous → candidates; reuse cache, in-memory parse pending, never persist fallback. Default 20 nodes; `maxNodes` 1–5000 or `"all"`; setting `codeSearch.mcpClassHierarchyDefaultMaxNodes` (0 = all) syncs to `~/.ace-code-search/settings.json` — explicit tool arg wins; do not expose settings as a tool/result.
- Shebang for `dist/cli.js` / `dist/mcp.js` comes only from the esbuild `banner` — do not also put `#!/usr/bin/env node` in the TypeScript entry.
- Canonical Skill only at `.agents/skills/ace-code-search-mcp/SKILL.md`, byte-identical to `resources/skills/.../SKILL.md`. Do not restore project guidance under `.github`, `.cursor`, or `.claude`. Installer `codeSearch.installAgentSkill` writes user Codex/Cursor configs to the managed `~/.ace-code-search/mcp-launcher.cjs`; no project `.codex/config.toml`; remove only recognized legacy managed blocks; modified/ambiguous blocks fail closed. Activation does not auto-write guidance. VS Code provider `ace-code-search.mcp-servers` when available; deprecated `installVscodeCopilotInstruction` is an alias and never writes `.github/instructions`. Coverage: `test/agentSkillInstaller.test.ts`, `test/mcpConfigInstaller.test.ts`, `test/vscodeMcpProvider.test.ts`.
- Runtime status (`src/mcpStatus.ts`): private heartbeats under `~/.ace-code-search/status/`; Chinese action summaries only — never raw tool names, paths, index IDs, or arg objects; best-effort, never alter tool responses or write MCP stdout. Coverage: `test/mcpStatus.test.ts`.
- Feature parity: follow `.cursor/rules/mcp-feature-parity.mdc` in the same change as searchable product features. Codex/Cursor launchers use `native-node/`; VS Code provider uses editor Electron (`native/`) or remote system Node (`native-node/`) via `src/native/extensionRoot.ts`.

## Search panel webview UI

- UI: `src/ui/webview/main.ts` + styles in `SearchPanelProvider.ts`. Lock icon only via `.tab-lock` (no CSS `::after` on `.tab.locked`). Clipboard via `copyToClipboard` → `vscode.env.clipboard` (not `navigator.clipboard`). Hide result context menu on tab switch/new tab. Query escapes: `\\` → `\`, `\"` → `"` (`QueryParser.unescapeQueryString`). Search on **submit** only — typing must not query the index.
- Autocomplete: SQL via `idx_tokens_token_freq` then TS length/freq sort (`src/index/tokenSuggestions.ts`); never `ORDER BY LENGTH(token)` on large `tokens` tables. Stale-request guard + Enter/Tab keyboard rules in `SearchPanelProvider.handleAutocomplete()`.
- Editor watching: `workspace.createFileSystemWatcher(RelativePattern)` — never reintroduce extension-host chokidar crawls; CLI keeps chokidar. Shared `IndexingMatcher`; register watcher before reporting `Up to date`.
- Streaming: `searchStreaming()` + ack protocol (`searchId`/`chunkId`); sync `search()` for CLI/tests. See `src/search/searchStreamBuffer.ts`, `test/resultsPartialAckController.test.ts`. Profile logs (`codeSearch.profileSearch`): `src/utils/searchProfile.ts`; ownership so late finalize cannot overwrite a newer session.
- Browser-only webview entry points stay out of the Node `tsconfig.json` (esbuild). Read `webviewView.visible` (no boolean event payload).

## Manage Indexes webview UI

- Cards: `src/ui/manage-webview/main.ts` / `IndexManagePanel.ts`. `code-search.autocreate` is authoritative and locks Primary changes. `getIndexListPayload()` merges registry + active services with active precedence (`src/ui/indexCatalog.ts`); detach path from `IndexManager.getAttachedIndex()` before registry. Inherited rules once in `indexingRules`; never copy defaults into every `IndexMeta` (would freeze them into editor registries). Coverage: `test/indexCatalog.test.ts`, `test/indexingSettings.test.ts`.
- Create/choose/open return `IndexOperationResult` (`ok` / `cancelled` / `error`); cancellation is silent. Progress must not wipe unsaved drafts; clear dirty only when the exact submitted draft succeeds; recompute static disabled controls when busy ends. Rebind `IndexManagePanel` on `IndexManager` replacement.

## Cross-IDE workspace indexes

- Shared DB path via `getSharedWorkspaceKey()` / `getSharedWorkspaceDbPath()`; do not auto-move/delete legacy per-editor `globalStorage` DBs. `workspaceIndexBindingV2` stores Primary/Secondary **paths** (registry IDs differ across IDEs); migrate legacy secondary IDs once with `legacySecondaryIdsMigrated`. Close/Delete must pass an explicit DB path removal. Details and manual cross-IDE checklist: `README_Dev.md`.
- Writer lease (`IndexWriterLease`): one writable owner; contenders read-only. Never auto-delete malformed/incomplete main locks or an existing `.writer.lock.reclaim`. Read-only services: `fileMustExist` + `query_only`, no schema/watcher/updates. Registry saves: `registry.json.writer.lock` + three-way delta merge; do not replace malformed registry JSON with an empty catalog. Generations guard stale async bind/save/dispose; `WorkspaceOperationToken` after pickers. Startup order: `selectFirstUsableStartupPrimary()`; autocreate failures stay hard.
- `attachSecondary(..., { waitForInitialIndex: false })` for startup/Open Secondary so large Secondaries do not block activation. Coverage under `test/indexManager.test.ts`, `test/indexWriterLease.test.ts`, `test/workspaceIndexBinding.test.ts`, `test/indexRegistry.test.ts`, and related `test/index*.test.ts`.

## Class inheritance tree panel

- Increment `DEFAULT_CLASS_HIERARCHY_PARSER_VERSION` when extraction/declaration semantics change. Workers must never load `better-sqlite3` or own a DB handle. Editor + MCP share `ClassHierarchySourceParser`; MCP loader stays read-only and never persists fallback parses. Explicitly qualified bases must not fall back to unrelated short-name matches.
- `#btnInstallGuidance` installs only canonical `.agents/skills` + user MCP config — never recreate `.cursor`/`.claude`/`.github` project guidance. UI: cycle/DAG-safe, `textContent` for names/paths, stack-safe filter (no huge `array.push(...items)`). Coverage: `test/classHierarchy*.test.ts`, `test/readonlyClassHierarchyLoader.test.ts`.

## Header/Source pairing

- Index-only pairing (`src/pairing/headerSourcePairing.ts`); no filesystem fallback. Priority: same dir+stem, then Public↔Private, then path distance.
- `codeSearch.switchHeaderSource` on Alt+O; package.json unbinds `C_Cpp.SwitchHeaderSource` / `clangd.switchheadersource`. Do **not** register those third-party command IDs (duplicate IDs can wedge the extension host). `registerHeaderSourceCommandOverrides()` is a compatibility no-op. `migrateUserHeaderSourceKeybindings()` rewrites legacy Alt+O user bindings on activate.

## Release documentation

- Release / Marketplace / PAT SOP lives in `README_Dev.md`. Keep it aligned with current Microsoft docs (Azure DevOps global PATs retire 2026-12-01).
