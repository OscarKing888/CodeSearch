# Changelog

All notable changes to the Ace Code Search extension are documented in this file.

## Unreleased

### Added
- Add an IDE-independent workspace Primary path shared by VS Code and Cursor, automatic matching-index discovery across both editor registries, manual `index.db` Primary selection, and path-based Primary/Secondary workspace bindings.
- Add per-database single-writer leases with automatic read-only fallback/takeover, writer-owner status, safe read-only schema validation, restored Secondary access modes, and fail-safe orphan reclaim-guard handling.
- Redesign Manage Indexes around a dominant Primary, subordinate Secondaries, a single scoped property inspector, and a lower-priority Available list; inherited/global exclusion rules now visibly include the effective Unreal defaults while per-index additions remain separate.
- Add a workspace-wide C++/UE class inheritance panel that opens without a prior search, caches declarations incrementally in each writable index, and preserves read-only legacy-index compatibility through an in-memory fallback.
- Add hierarchy/context SVG toolbar icons, filter-clear selection reveal, and subclass expand/collapse actions in the class-row context menu.
- Add one canonical project Agent Skill under `.agents/skills`, with thin Cursor Rule and Claude compatibility wrappers; VS Code Copilot project instructions are now an explicit optional install instead of part of the default layout.
- Add a stable user-level MCP launcher for Codex/Cursor that discovers the newest installed extension, plus dynamic VS Code MCP provider registration; no project `.codex` config or version-pinned MCP path is required.
- Add fail-closed migration for managed legacy Skill/rule/config copies, preserving user-modified, unmanaged, or malformed files and configs with warnings; activation never installs silently.
- Add project maintainer rule `.cursor/rules/mcp-feature-parity.mdc` so searchable feature work keeps MCP tools, Skill templates, and guidance docs in sync.

### Fixed
- Preserve the working Primary when replacement validation or registry persistence fails, atomically publish complete writer-lock owner records, keep concurrent registry Primary selections and first-open physical paths unique with durable last-saver semantics, hold the registry lease through destructive path validation/commit, prevent one physical DB from being opened/deleted as conflicting Primary/Secondary entries, stop disposed indexing work, isolate bindings during workspace changes, and reject unsafe moves of live WAL databases.
- Detect when PATH `code` is Cursor's shim on macOS and install into the real Visual Studio Code.app CLI / `~/.vscode/extensions` instead.
- Fix MCP defaults, multi-index quotas, mapped-path lookups, partial-build reporting, and discovery resilience; default registry access is constrained to MCP workspace roots unless explicitly authorized.
- Fix packaged MCP/CLI native loading by shipping distinct Electron and Node 20/22/24 ABI matrices, validating all 24 release binaries plus runtime entries, and loading the correct binding for each host.
- Prevent `Maximum call stack size exceeded` in large class hierarchies by removing unbounded array-spread calls and using iterative filter/render graph traversal.
- Move editor file watching out of the extension-host chokidar crawl, coalesce queued changes during searches, and prevent large Unreal Engine workspaces from starving search/UI work.
- Persist search profiles from search start through success, cancellation, errors, or disposal, including incremental checkpoints and ACK wait timings.
- Stop re-registering command IDs owned by C/C++ and clangd extensions.

### Changed
- Store new workspace indexes in the shared OS application-data directory while retaining legacy per-editor `globalStorage` databases, registry fields, and downgrade-compatible Secondary IDs; `code-search.autocreate` remains authoritative.
- Raise the minimum supported VS Code version to 1.103, the first stable release on Electron 37 / ABI 136 covered by the packaged native matrix. Codex/Cursor launcher configs require PATH Node.js 20, 22, or 24; VS Code uses its editor runtime.
- Show loaded versus discovered hit counts while streaming and keep search profiling disabled by default.

## [0.8.0] - 2026-07-20

### Changed
- add secondary index support

## [0.7.0] - 2026-07-19

### Changed
- add MCP & skills/rules

## [0.6.2] - 2026-07-14

### Changed
- fix auto refresh bug.

## [0.6.1] - 2026-07-14

### Changed
- Add C# class support, fix bugs.

## [0.6.0] - 2026-07-13

### Changed
- Add class viewer.

## [0.5.0] - 2026-07-10

### Changed
- optimze input response

## [0.4.0] - 2026-07-09

### Changed
- optimze for Unreal Engine  source code workspace

## [0.3.3] - 2026-07-08

### Changed
- fix candidate list bug

## [0.3.2] - 2026-07-08

### Changed
- fix candidate list bug

## [0.3.1] - 2026-07-08

### Changed
- Optimize search candidate list

## [0.3.0] - 2026-07-08

### Changed
- Add Alt+O switch .h/.cpp
- Auto-migrate user Alt+O keybindings away from C/C++ Tools / clangd commands on extension activate

## [0.2.4] - 2026-07-08

### Added
- Switch between indexed header/source pairs with `Alt+O` (`codeSearch.switchHeaderSource`); unbinds competing C/C++ and clangd defaults on the same key
- Override `C_Cpp.SwitchHeaderSource` / `clangd.switchheadersource` so Cursor user keybindings still route to index-based pairing

### Changed
- Add copy search results to clipboard

## [0.2.3] - 2026-07-07

### Changed
- Only display file name in search results

## [0.2.2] - 2026-07-07

### Changed
- Fix tab page icon error.

## [0.2.1] - 2026-07-07

### Changed
- Fix Electron ABI 146 native packaging.

## [0.2.0] - 2026-07-06

### Fixed
- change name to Ace Code Search for marketplace

## [0.1.9] - 2026-07-06

### Fixed
- CI: `rebuild-node.js` falls back to `npm rebuild better-sqlite3` when node-gyp path is missing on Linux
- Restore search panel tab title to **Search** (container title remains Ace Code Search)

## [0.1.8] - 2026-07-06

### Fixed
- Track `src/native/betterSqlite3.ts` (was excluded by overly broad `native/` in `.gitignore`)

## [0.1.7] - 2026-07-06

### Changed
- Display name renamed to **Ace Code Search**
- GitHub Actions: Node 24, native build deps, CI workflow fixes
- Regenerated `package-lock.json` (fixed invalid `imurmurhash@0.1.6` entry causing `npm ci` 404)
- Documentation: Entrian references removed; independent development notice added (`README.md`, `README_en.md`, `README_Dev.md`)

## [0.1.6] - 2026-07-06

### Added
- Extension icon and gallery banner for Marketplace listing
- GitHub Actions workflow for automated cross-platform builds and releases

### Changed
- Publisher ID updated for VS Code Marketplace publishing

## [0.1.5] and earlier

See git history for prior changes.
