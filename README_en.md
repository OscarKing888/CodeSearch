[中文](https://github.com/OscarKing888/CodeSearch/blob/main/README.md) | [English](https://github.com/OscarKing888/CodeSearch/blob/main/README_en.md)

# Ace Code Search

A VS Code / Cursor extension that indexes your workspace for full-text code search with instant results.

![Ace Code Search screenshot](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/AceCodeSearch.png)

![Class Viewer screenshot](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/CodeSearchClassViewer.png)

> **Independent Development Notice**
>
> This extension draws functional inspiration from the user experience of tools such as [Entrian Source Search](https://entrian.com/source-search/). However, all code, architecture, and implementation are independently designed and developed by this project. No third-party source code or proprietary assets were used. This project has no affiliation with or authorization from Entrian or its products.

Requires VS Code or Cursor **1.103** or newer.

## Key Features

- **Full-text search**: phrase and fuzzy matching, path/extension/age filters, multi-tab results, and streaming delivery for large result sets
- **Large codebases**: background indexing with search-while-indexing; default excludes for Unreal generated folders and common dependency/build output
- **Shared indexes across IDEs**: VS Code and Cursor can share a Primary index for the same workspace on one machine; see the development guide for details
- **Header/source switch**: press **Alt+O** in indexed C/C++ files to jump between paired headers and sources
- **Class inheritance tree**: browse indexed C++ class hierarchies in a dedicated panel and jump to declarations—no search required
- **Index management**: open the ⚙ panel to configure Primary / Secondary indexes, shared paths, and search scope
- **AI Agent integration**: read-only MCP lets Cursor, Copilot, and other agents query existing indexes; install from the toolbar document icon or command palette

## Shortcuts

| Command | Shortcut |
|---------|----------|
| Search selection / word under cursor | `Alt+=` |
| Focus search box | `Shift+Alt+=` |
| Quick open file | `Shift+Alt+F` |
| Switch header/source | `Alt+O` |
| Next hit | `Ctrl+Alt+]` |
| Previous hit | `Ctrl+Alt+[` |
| Refresh index | Command palette |
| Manage indexes | Toolbar ⚙ |
| Install Agent integration | Toolbar document icon / command palette |
| Class inheritance tree | Toolbar hierarchy icon / command palette |
| Choose workspace Primary index | Command palette |
| Open Secondary index | Command palette |

## Install

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=OscarKing888.ace-code-search) — search for **Ace Code Search** (publisher OscarKing888).

To build and install from source: https://github.com/OscarKing888/CodeSearch/blob/main/README_Dev_en.md

## More Documentation

- Chinese readme: https://github.com/OscarKing888/CodeSearch/blob/main/README.md
- Development & configuration (English): https://github.com/OscarKing888/CodeSearch/blob/main/README_Dev_en.md
- Development & configuration (中文): https://github.com/OscarKing888/CodeSearch/blob/main/README_Dev.md
- CLI / Phase 2: https://github.com/OscarKing888/CodeSearch/blob/main/PHASE2.md
- Changelog: https://github.com/OscarKing888/CodeSearch/blob/main/CHANGELOG.md
