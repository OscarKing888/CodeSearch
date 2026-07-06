# Ace Code Search

A VS Code extension that provides full-text code indexing and instant search powered by SQLite FTS5.

> **Independent Development Notice**
>
> This extension draws functional inspiration from the user experience of tools such as [Entrian Source Search](https://entrian.com/source-search/). However, all code, architecture, and implementation are independently designed and developed by this project. No third-party source code or proprietary assets were used. This project has no affiliation with or authorization from Entrian or its products.

For detailed development notes, see [README_Dev.md](README_Dev.md).

## Feature List

✅ = implemented.

| Category | Feature | Status |
|----------|---------|--------|
| **Indexing** | Configurable root full-text indexing | ✅ Workspace roots + `code-search.autocreate` for custom roots |
| | Multi-root / secondary read-only indexes / path mapping | ✅ Secondary indexes + directory mapping |
| | Incremental updates (file watcher) | ✅ Real-time updates via chokidar |
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
| | Context lines | ✅ Toolbar Ctx; lines via `contextLines` setting |
| | Query syntax coloring (green / red filters) | ✅ |
| | Multiple tabs | ✅ Ctrl+Enter / + for new tab |
| | Tab lock | ✅ |
| | Code word autocomplete | ✅ |
| **Navigation** | Search word under cursor / selection | ✅ `Alt+=` |
| | Ctrl+Alt+] / Ctrl+Alt+[ next/previous hit | ✅ |
| | Shift+Alt+F quick open file | ✅ |
| | Click to open / preview | ✅ Preview |
| | Auto-open single hit | ✅ Configurable via `autoOpenSingleHit` |

Legend: ✅ Done · 🟡 Partial · ⬜ Planned

## Shortcuts

| Command | Shortcut |
|---------|----------|
| Search Selection | `Alt+=` |
| Focus Search | `Shift+Alt+=` |
| Quick Open File | `Shift+Alt+F` |
| Next Hit | `Ctrl+Alt+]` |
| Previous Hit | `Ctrl+Alt+[` |
| Refresh Index | Command palette |
| Manage Indexes | Toolbar ⚙ |
| Open Secondary Index | Command palette |

## Install & Build

```bat
install.bat
build.bat
安装CodeSearch.bat
```

macOS / Linux: `./install.sh` → `./build.sh` → `./install-extension.sh`

For configuration, Phase 2/3 usage, and CLI details, see [README_Dev.md](README_Dev.md) and [PHASE2.md](PHASE2.md).
