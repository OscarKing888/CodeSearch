# Changelog

All notable changes to the Ace Code Search extension are documented in this file.

## [0.1.8] - 2026-07-06

### Changed
- fix: track src/native/betterSqlite3.ts; narrow native/ gitignore

## [0.1.7] - 2026-07-06

### Changed
- Display name renamed to **Ace Code Search**
- GitHub Actions: Node 24, native build deps, CI workflow fixes
- Regenerated `package-lock.json` (fixed invalid `imurmurhash@0.1.6` entry causing `npm ci` 404)

### Fixed
- Add missing `src/native/betterSqlite3.ts` (was excluded by overly broad `native/` in `.gitignore`)

## [0.1.6] - 2026-07-06

### Added
- Extension icon and gallery banner for Marketplace listing
- GitHub Actions workflow for automated cross-platform builds and releases

### Changed
- Publisher ID updated for VS Code Marketplace publishing

## [0.1.5] and earlier

See git history for prior changes.
