# Phase 2+ Roadmap

## Phase 2 — Advanced Search (Done)

- [x] Loose phrase search (`loose:"parse query"`, `loose50:"A B C"`)
- [x] Fuzzy search (typo tolerance, spelling variants) — toolbar **Fz** button
- [x] Multi-token wildcards: `"this * that"`, `"this *:100 that"`
- [x] Code word autocomplete from `tokens` table
- [x] Query box syntax coloring (green include / red exclude filters)
- [x] `+` / `-` file content positive/negative filters

## Phase 3 — Multi-Index & Collaboration (Done)

- [x] Multiple search result tabs with lock support
- [x] Secondary read-only indexes for third-party libraries
- [x] Index management UI (create/delete/move/rename)
- [x] `source-search.autocreate` workspace config file
- [x] Directory mapping for shared indexes across machines
- [x] CLI tool `ess` for CI/pre-indexing

### Phase 3 usage

**Multi-tab search**
- `Ctrl+Enter` — search in new tab
- Click **+** — new empty tab
- Click **🔓/🔒** — lock tab (locked tabs keep results)
- `Alt+=` with selection — opens search in new tab

**Secondary index**
- Command: `Code Search: Open Secondary Index`
- Results show `[IndexName]` badge; paths mapped via directory mappings

**Manage indexes**
- Command: `Code Search: Manage Indexes` or toolbar **⚙**
- Rename / move / map directories / attach / detach / delete

**Autocreate** — place in workspace root or parent folder:
- `source-search.autocreate` or `EntrianSourceSearch.autocreate`
- Empty file = default settings; or JSON:

```json
{
  "name": "MyProject",
  "indexLocation": "D:\\indexes",
  "excludeList": ["$(AutocreateDir)\\\\Build"],
  "includeList": ["*.cs", "*.cpp"]
}
```

**CLI (ess)**

```bash
npm run cli -- create --root ./src --db ./myindex.db --name MyLib
npm run cli -- update --db ./myindex.db --force
npm run cli -- list
```
