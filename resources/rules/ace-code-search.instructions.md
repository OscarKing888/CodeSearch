---
description: Prefer indexed Ace Code Search MCP tools for source-code discovery, with filesystem search as a freshness and coverage fallback.
applyTo: "**"
---

# Prefer Ace Code Search

When locating code, symbols, text, files, references, or C/C++ header/source counterparts:

1. Prefer the `ace-code-search-mcp` Skill and its MCP tools when the target workspace has an Ace Code Search index.
2. Use `list_indexes` when the target index is unknown, then pass the matching index ID to `search_code`.
3. Use `read_indexed_file` for indexed snapshots and `find_header_source` for indexed C/C++ pairing.
4. Fall back to `rg`, filesystem search, or direct reads when no matching index exists, `partialIndex` is true and completeness matters, results may be stale, or the target is excluded/unindexed.

Do not claim that indexed results reflect unsaved or not-yet-indexed changes.
