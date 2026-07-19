---
name: ace-code-search-mcp
description: Searches indexed source code through the read-only Ace Code Search MCP server, reads indexed file snapshots, lists indexes, and finds C/C++ header-source counterparts. Use automatically when locating code, symbols, text, files, or references in indexed workspaces, especially when the user asks to search code with Ace Code Search or MCP.
---

# Ace Code Search MCP

Use the Ace Code Search MCP tools instead of a filesystem scan when the requested workspace is indexed.

## Prerequisites

The Skill alone does **not** expose tools. The agent session must have the Ace Code Search MCP server registered and connected so these tools exist:

- `list_indexes`
- `search_code`
- `read_indexed_file`
- `find_header_source`

If those tools are missing from the available tool list:

1. Tell the user the MCP server is not connected (Skill guidance is not enough).
2. For Codex (VS Code / CLI / desktop): ensure `[mcp_servers.ace-code-search]` exists in `~/.codex/config.toml` (or trusted project `.codex/config.toml`), then restart Codex or run `/mcp`.
3. For Cursor: ensure `ace-code-search` exists in `~/.cursor/mcp.json`, then reload MCP.
4. Fall back to `rg` / filesystem search only after stating that MCP tools are unavailable.

In Ace Code Search, the toolbar **Install project Agent Skill / Rule** command also writes the Codex/Cursor MCP client config pointing at this extension's `dist/mcp.js`.

## Workflow

1. Call `list_indexes` when the target index is unknown.
2. Select the index whose `rootDirs` contains the requested workspace. Pass its `id` as `indexId`; do not rely on duplicate names such as `Primary`.
3. Call `search_code` with the narrowest useful query and options.
4. If needed, call `read_indexed_file` with the returned `localPath` and a small line range.
5. Use `find_header_source` for indexed C/C++ header/source pairing.
6. State that results come from an index snapshot when freshness matters. `partialIndex: true` means results may be incomplete.

## `search_code` matching parameters

- `query` (required): Ace Code Search query text.
- `indexId`: index ID or a unique index name. Prefer the ID.
- `caseSensitive` (default `false`): set `true` for exact case.
- `phraseSearch` (default `true`): adjacent multi-word phrase matching. Set `false` to search separate terms. A leading quoted query such as `"request animation frame"` forces phrase mode.
- `fuzzy` (default `false`): typo-tolerant identifier-word matching using Levenshtein distance. Maximum edit distance is 0 for length 1–3, 1 for length 4–6, and 2 for length 7+.
- `loose` (default `false`): match all query terms as identifier tokens in any order within `looseGap`.
- `looseGap` (default `10`, range 1–500): maximum token span for loose matching. It matters only with `loose: true` or a `loose:` query.
- `contextLines` (default `1`, range 0–10): context lines returned before and after each hit.
- `maxResults` (default `50`, range 1–10000): result cap.

## Exact and whole-word behavior

There is no dedicated `wholeWord` MCP parameter.

- A bare identifier, such as `requestAnimationFrame`, is the best whole-token search because SQLite FTS first selects matching tokens.
- Do not claim strict whole-word guarantees: post-filter highlighting may also find the same text inside a longer token in an already selected file.
- For an exact case-sensitive identifier, use the bare identifier with `caseSensitive: true`.
- For an exact contiguous text substring, add a required content filter: `+"literal text"`. This is substring matching, not whole-word matching.
- For punctuation-separated names, split on punctuation when the literal form returns no result. Example: search `better sqlite3` for `better-sqlite3`.

## Query syntax

- Phrase: `"foo bar"` or `query: "foo bar"` with `phraseSearch: true`.
- Identifier wildcard: `request*`, `*Animation`, or `request*Frame`.
- Loose phrase in query text: `loose:"foo bar"`; custom gap: `loose25:"foo bar"`.
- Required content substring: `+"must appear"` or `+token`.
- Excluded content substring: `-"must not appear"` or `-token`.
- Path filters: `ext:ts`, `file:*Service.ts`, `dir:src/search`.
- Negated path filters: `-ext:test`, `-file:*.map`, `-dir:node_modules`.
- Age filters: `age:7d` means modified within seven days; `-age:7d` means older than seven days.
- Filters can be combined: `requestAnimationFrame ext:ts dir:src -file:*.test.ts`.

## Choosing modes

- Known symbol: bare identifier; enable `caseSensitive` only when case distinguishes symbols.
- Exact phrase: quoted text or `phraseSearch: true`.
- Misspelling or uncertain symbol spelling: `fuzzy: true`.
- Terms near each other but not adjacent or not ordered: `loose: true`, then increase `looseGap` only if needed.
- Partial identifier: use `*`; do not enable fuzzy unless typo tolerance is also required.
- Too many results: add `indexId`, `ext:`, `dir:`, or `file:` before increasing `maxResults`.
- No results for punctuation: split punctuation into spaces before concluding the code is absent.

## Other tools

### `read_indexed_file`

Pass `path`, preferably the returned `localPath`, plus optional `indexId`, `startLine`, `endLine`, and `maxChars`. Content may lag the live file.

### `find_header_source`

Pass a `.h`, `.hpp`, `.c`, `.cc`, `.cpp`, or related path and optional `indexId`. It only returns counterparts present in the index; there is no filesystem fallback.

## Reporting

Report the query, selected index, hit/file counts, elapsed time, and the most relevant `localPath:line` entries. Mention `partialIndex` only when true. If a fallback query was needed, explain it briefly.
