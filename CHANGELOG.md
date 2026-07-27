# Changelog

All notable changes to the Ace Code Search extension are documented in this file.

## Unreleased

### Added

- Per-line ECMAScript regex search in the panel and MCP, with an accessible `.*` snippet menu that inserts at the current caret or selection
- Cross-IDE shared workspace Primary indexes, auto-discovered matching indexes, manual Primary selection, and path-based bindings
- Single-writer leases with read-only fallback/takeover, writer status display, and safe deletion of Available indexes
- Redesigned Manage Indexes: dominant Primary, subordinate Secondaries, unified property panel, and visible Unreal default excludes
- C++/UE class inheritance panel (no search required), incremental caching, and in-memory fallback for read-only indexes
- MCP class hierarchy tool and canonical `.agents` Skill; user MCP launcher and VS Code dynamic provider
- Search status bar MCP runtime status (Waiting / Ready / sanitized action summaries)

### Fixed

- `ext:h,cpp,inc`, safe `file:` / `dir:` standard globs, standalone quote-aware filter parsing, mapped-path filtering, and false negatives caused by truncating candidates before post-filters
- Cursor/Windows MCP roots compatibility, scope refresh after roots changes, fail-closed on invalid roots
- Cursor zero-tool snapshot recovery; local packages include Cursor helper Node ABI; MCP launcher and legacy entrypoints re-exec to compatible Node 20/22/24 when PATH Node ABI mismatches packaged `native-node/` (for example Node 23), preserving script arguments across macOS/Linux/Windows
- Primary switching and registry / writer lock races; macOS install target detection when PATH `code` is Cursor's shim
- MCP discovery, multi-index handling, and `partialIndex` reporting; Electron / Node 20/22/24 native matrix loading
- High Extension Host CPU and search stalls in large UE workspaces; class hierarchy stack overflow; C/C++ / clangd Alt+O command conflicts

### Changed

- New workspace indexes default to shared application-data directory; legacy `globalStorage` indexes remain compatible
- Minimum VS Code **1.103**; Codex/Cursor MCP launcher auto-selects compatible Node 20/22/24 (`ACE_CODE_SEARCH_NODE` override supported)
- Streaming search shows loaded vs. discovered hit counts; `codeSearch.profileSearch` off by default
- Fail-closed migration for managed legacy Skill/rule/config; MCP feature-parity maintenance rule

## [0.8.11] - 2026-07-27

### Changed
- Add regx search, fix filters

## [0.8.10] - 2026-07-26

### Changed
- Add Open VSX publishing to release CI.

## [0.8.9] - 2026-07-26

### Changed
- Fix MCP bugs.

## [0.8.8] - 2026-07-23

### Changed
- MCP add Class Hierarchy.

## [0.8.7] - 2026-07-22

### Changed
- Fix MacOS errors.

## [0.8.6] - 2026-07-22

### Changed
- add delete index

## [0.8.5] - 2026-07-22

### Changed
- Show MCP search content

## [0.8.4] - 2026-07-22

### Changed
- Fix MCP, add delete operation

## [0.8.3] - 2026-07-22

### Changed
- Fix MCP

## [0.8.2] - 2026-07-22

### Changed
- Fix MCP

## [0.8.1] - 2026-07-22

### Changed
- Add MCP status display

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
