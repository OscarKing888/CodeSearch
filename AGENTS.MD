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
- `.vscodeignore` excludes `node_modules/better-sqlite3/build/**`, so release packages rely on root `native/` binaries, not the local npm build output.

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
  - `node scripts/rebuild-electron.js all`
  - `npm run validate:native`
  - `npm run package`
- On a single local platform, `npm run validate:native` only passes if the full cross-platform native matrix has already been merged into root `native/`.

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
- The script updates `package.json`, `package-lock.json`, and inserts a new top changelog section if it does not already exist. It does not commit, tag, build, or publish.

## Search panel webview UI

- Search result tabs are rendered in `src/ui/webview/main.ts` with inline styles from `src/ui/SearchPanelProvider.ts`.
- Lock state is shown only via the JS `.tab-lock` element (`🔒` / `🔓`). Do not add a CSS `::after` lock on `.tab.locked`; that duplicates the icon.
- Tab layout uses `.tab-label` (`flex: 1; min-width: 0`) for ellipsis, and `.tab-lock` / `.tab-close` use `flex-shrink: 0` so long labels do not clip the lock or close controls.
- Locked tabs intentionally hide the close button; unlock first to close.
- Result row copy format: `{absolutePath}:{line}\t{lineText}` via right-click **Copy** / **Copy All**. Clipboard writes go through `copyToClipboard` postMessage and `vscode.env.clipboard.writeText` in `SearchPanelProvider.ts` (not `navigator.clipboard` in the webview).
- **Copy All** uses the active tab's loaded hits in current table sort order, newline-separated.

## Release documentation

- `README_Dev.md` contains the release SOP, including Marketplace Publisher setup, Azure DevOps PAT creation, GitHub `VSCE_PAT` secret setup, and publish troubleshooting.
- Keep the SOP aligned with official Microsoft docs when updating PAT or Marketplace steps because Azure DevOps UI labels and policies can change.
- Azure DevOps PAT creation should document both the direct URL `https://dev.azure.com/<Your_Organization>/_usersSettings/tokens` and the top-bar User settings icon. The round avatar/account flyout is not the PAT menu and may only show Microsoft account, directory switching, account switching, and sign out.
- VS Code docs currently note that Azure DevOps global PATs retire on 2026-12-01; plan a future migration to Microsoft Entra ID or managed identity publishing before that date.
