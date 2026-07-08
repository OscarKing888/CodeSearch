# Changelog

All notable changes to the Ace Code Search extension are documented in this file.

## [0.2.5] - 2026-07-08

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
