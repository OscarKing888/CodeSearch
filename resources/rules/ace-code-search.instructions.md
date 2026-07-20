---
description: Prefer indexed Ace Code Search MCP tools for source-code discovery, with filesystem search as a freshness and coverage fallback.
applyTo: "**"
---

# Prefer Ace Code Search

When locating code, symbols, text, files, references, or C/C++ header/source counterparts:

1. Treat `.agents/skills/ace-code-search-mcp/SKILL.md` as the canonical project guidance when it exists.
2. Prefer its MCP tools when `list_indexes` exposes an index for this workspace.
3. Fall back to `rg`, filesystem search, or direct reads when the MCP server/index is unavailable, `partialIndex` is true and completeness matters, results may be stale, or the target is excluded/unindexed.

Do not claim that indexed results reflect unsaved or not-yet-indexed changes.
