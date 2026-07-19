## Development

### Windows

```bat
install.bat   REM 安装依赖（含 better-sqlite3 原生编译）
build.bat     REM 编译、测试并打包 .vsix
```

### macOS / Linux

```bash
chmod +x install.sh build.sh install-extension.sh bump-version.sh
./install.sh
./build.sh
./install-extension.sh
```

Version bump (same as `bump-version.bat`):

```bash
./bump-version.sh 0.2.1 --notes "Fix Electron ABI 146 native packaging."
```

### 手动命令

```bash
npm install
npm run build
npm run rebuild:node   # CLI / MCP need system Node ABI for better-sqlite3
# Press F5 in VS Code with launch.json
```

### MCP (AI Agent)

Read-only stdio MCP server over existing Ace Code Search SQLite indexes:

```bash
npm run build
npm run rebuild:node
npm run mcp -- --db /path/to/index.db
# or: npm run mcp -- --registry /path/to/registry.json
# or: npm run mcp   # auto-discovers VS Code/Cursor globalStorage registries
```

Cursor / Claude Desktop example (`mcp.json`):

```json
{
  "mcpServers": {
    "ace-code-search": {
      "command": "node",
      "args": [
        "/absolute/path/to/CodeSearch/dist/mcp.js",
        "--registry",
        "/absolute/path/to/registry.json"
      ]
    }
  }
}
```

Tools: `list_indexes`, `search_code`, `read_indexed_file`, `find_header_source`.
Results come from the **index snapshot** (not a live filesystem walk). MCP uses the **system Node** `better-sqlite3` build (`npm run rebuild:node`); after `rebuild-electron` / packaging, `build.sh` restores it automatically.

#### Personal Agent Skill installation

The extension installs the packaged `ace-code-search-mcp` Skill automatically on activation:

- Canonical managed copy: `~/.agents/skills/ace-code-search-mcp` (official Cursor and VS Code/Copilot personal skill root)
- Cursor compatibility wrapper: `~/.cursor/skills/ace-code-search-mcp`
- VS Code / GitHub Copilot compatibility wrapper: `~/.copilot/skills/ace-code-search-mcp`

New wrappers are managed mirrors that refresh with extension upgrades. Official docs do not guarantee symlink discovery, so the installer no longer creates new symlinks/junctions; an already-correct existing link is left alone. Existing unmanaged files or links are never overwritten; check the **Ace Code Search** output channel for a warning, remove/rename the conflicting directory, then run **Ace Code Search: Install Agent Skill for Cursor and VS Code** from the command palette.

The packaged source is `resources/skills/ace-code-search-mcp/SKILL.md`. Keep it byte-for-byte aligned with the repository's own `.cursor/skills/ace-code-search-mcp/SKILL.md`; `test/agentSkillInstaller.test.ts` enforces this. MCP server registration is separate from Skill install (for Cursor, personal MCP config is `~/.cursor/mcp.json`).

#### Prefer-indexed-search guidance

- Project Cursor Rule: `.cursor/rules/ace-code-search-first.mdc` (`alwaysApply: true`).
- VS Code personal Instruction: installed automatically at `~/.copilot/instructions/ace-code-search.instructions.md` from `resources/rules/ace-code-search.instructions.md`.
- Cursor User Rule: Cursor officially stores this in **Cursor Settings → Rules → User Rules**, not in a supported file path. On first install/update the extension offers **Copy Cursor User Rule**; the same action is always available as the **Ace Code Search: Copy Cursor User Rule** command.

The guidance prefers indexed MCP tools for code discovery, but requires `rg`/filesystem/direct-read fallback when no matching index exists, `partialIndex` affects completeness, content may be stale, or files are excluded/unindexed. It never treats indexed snapshots as unsaved content.

`vscode:prepublish` only runs the normal `npm run build` (esbuild). Cross-platform Electron native binaries are produced by `scripts/rebuild-electron.js` and the Release GitHub Actions workflow — not by `vscode:prepublish`.

## Release

推送 `v*` 标签后，GitHub Actions 会自动完成跨平台原生模块编译、打包 `.vsix`、创建 GitHub Release，并发布到 VS Code Marketplace。

### 一次性准备

下面是从 0 开始配置 VS Code Marketplace 发布权限的 SOP。只需要做一次；之后发版由 GitHub Actions 读取 `VSCE_PAT` 自动发布。

#### 0. 准备账号与权限

1. 使用同一个 Microsoft 账号登录：
   - Visual Studio Marketplace: <https://marketplace.visualstudio.com/manage>
   - Azure DevOps: <https://dev.azure.com/>
2. 如果浏览器里同时登录了多个 Microsoft/Azure 账号，建议用无痕窗口重新登录，避免 Marketplace 和 Azure DevOps 使用不同身份。
3. PAT 属于创建它的用户账号。后续该账号必须对目标 Marketplace Publisher 有发布权限，否则 token 本身正确也会发布失败。
4. 注意：VS Code 官方文档提示 Azure DevOps global PAT 会在 2026-12-01 退役；当前仍按 PAT 配置，后续需要迁移到 Microsoft Entra ID/托管身份发布方案。

#### 1. 创建 Azure DevOps 组织（如果还没有）

1. 打开 <https://dev.azure.com/>。
2. 如果提示创建组织，按向导创建一个 Azure DevOps Organization。
3. Organization 名称不需要和 Marketplace Publisher ID 一样；PAT 只需要能访问 Marketplace scope。
4. 创建完成后进入组织首页，地址通常是：

```text
https://dev.azure.com/<Your_Organization>
```

#### 2. 创建 PAT

1. 进入 Azure DevOps 组织首页后，优先直接打开 PAT 页面：

```text
https://dev.azure.com/<Your_Organization>/_usersSettings/tokens
```

2. 也可以从页面右上角进入：在蓝色顶栏点击 **User settings** 用户设置图标（通常是“人像 + 齿轮/设置”的图标，在问号帮助图标右侧、账号名或圆形头像左侧），然后选择 **Personal access tokens**。
3. 注意不要点击最右侧圆形头像或账号名弹层；那个菜单通常只显示 Microsoft 账号、切换目录、切换账号和注销。如果只看到这些选项，说明点到的是账号菜单，关闭弹层后改点它左侧的 **User settings** 图标，或者直接使用上面的 URL。
4. 点击 **+ New Token**。
5. 按以下字段填写：
   - **Name**: `ace-code-search-marketplace-publish`。
   - **Organization**: 选 **All accessible organizations**。
   - **Expiration**: 建议 90 天、180 天或团队约定的轮换周期；不要选无期限。
   - **Scopes**: 只勾选 **Marketplace → Manage**。
6. 如果看不到 Marketplace scope：
   - 点击 scope 面板底部的 **Show all scopes**。
   - 确认当前账号已进入 Marketplace Publishing Portal，并且拥有 Publisher 权限。
   - 如果公司 Azure DevOps 有 PAT policy，联系组织管理员允许创建对应 scope 的 PAT。
7. 点击 **Create**。
8. 立即复制生成的 token。PAT 只显示一次，关闭页面后无法再次查看。

#### 3. 创建或确认 Marketplace Publisher

1. 打开 [Visual Studio Marketplace Publishing Portal](https://marketplace.visualstudio.com/manage)。
2. 使用创建 PAT 的同一个 Microsoft 账号登录。
3. 如果还没有 Publisher，点击 **+ Create a publisher**。
4. 填写 Publisher 信息：
   - **ID**: 发布用的 Publisher ID；创建后不能修改。它必须和 `package.json` 的 `publisher` 完全一致。
   - **Name**: 面向用户显示的名称。
5. 本项目当前配置为：

```json
"publisher": "OscarKing888"
```

6. 如果 Portal 里实际 Publisher ID 不同，优先修改 `package.json`，并确认 Marketplace 上没有同名冲突。
7. 本地可用 `vsce login` 验证 PAT 和 Publisher 是否匹配：

```bash
npx vsce login OscarKing888
```

8. 粘贴 PAT 后，如果提示 token verification succeeded，说明 Publisher 与 PAT 权限匹配。

#### 4. 写入 GitHub Actions Secret

1. 打开 GitHub 仓库页面。
2. 进入 **Settings → Secrets and variables → Actions**。
3. 点击 **New repository secret**。
4. 填写：
   - **Name**: `VSCE_PAT`
   - **Secret**: 粘贴刚创建的 PAT
5. 保存后不要把 PAT 写入代码、日志、Issue、PR 或本地文档。

#### 5. 验证发布权限

1. 在 GitHub 打开 **Actions → Release → Run workflow**。
2. 首次验证可以取消 Marketplace 发布选项，只确认 VSIX 能正常打包。
3. 确认无误后再次运行并启用 Marketplace 发布，或推送版本 tag 触发自动发布。
4. 如果 workflow 日志出现 `VSCE_PAT not set`，说明 GitHub Secret 名称不对、未保存到当前仓库，或 workflow 运行环境没有读取到该 secret。
5. 如果 Marketplace 发布报 401/403：
   - 确认 PAT 没过期。
   - 确认 PAT scope 是 **Marketplace → Manage**。
   - 确认 `package.json` 的 `publisher` 等于 Marketplace Publisher ID。
   - 确认创建 PAT 的 Microsoft 账号对该 Publisher 有发布权限。

参考：

- Azure DevOps PAT 创建文档：<https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate>
- Marketplace Publisher 创建与发布概览：<https://learn.microsoft.com/en-us/azure/devops/extend/publish/overview>
- VS Code 扩展发布文档：<https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
- 命令行发布与 PAT 说明：<https://learn.microsoft.com/en-us/azure/devops/extend/publish/command-line>

### 发版步骤

```bash
# 1. 更新 package.json 中的 version
# 2. 更新 CHANGELOG.md
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 0.1.8"
git tag v0.1.8
git push origin main --tags
```

标签版本须与 `package.json` 的 `version` 一致（如 tag `v0.1.8` 对应 version `0.1.8`）。

也可在 GitHub **Actions → Release → Run workflow** 手动触发；可勾选是否发布到 Marketplace（仍需配置 `VSCE_PAT`）。

## Configuration

See VS Code Settings → **Ace Code Search** for exclude globs, context lines, phrase search default, fuzzy default, loose gap, and more.

## Phase 3 — Multi-Index & Tabs

- **Multi-tab results**: `Ctrl+Enter` new tab, lock tabs with 🔒, close with ×
- **Secondary indexes**: `Ace Code Search: Open Secondary Index` — search third-party libs
- **Index management**: toolbar ⚙ or `Ace Code Search: Manage Indexes` — opens a dedicated **Manage Indexes** editor tab (WebviewPanel) with index cards, filter, inline rename, directory mappings, attach/detach, delete, and refresh. Create / attach / move still use native VS Code file dialogs.
- **Autocreate**: add `code-search.autocreate` in workspace root (optional JSON config)
- **Directory mapping**: map `\\server\share => C:\local` for shared indexes
- **CLI**: `npm run cli -- create|update|list` (see [PHASE2.md](PHASE2.md))
- **MCP**: `npm run mcp` — read-only stdio tools for AI agents (see Development → MCP above)

## Roadmap

See [PHASE2.md](PHASE2.md) — Phase 2 & 3 complete.

---

## 架构与实现

### 架构概览

```mermaid
flowchart TB
    subgraph vscode [VS Code Extension Host]
        Ext[extension.ts]
        Cmd[Commands and Keybindings]
        Status[StatusBar]
    end

    subgraph core [Core Services]
        Idx[IndexService]
        Qry[QueryParser]
        Sch[SearchService]
        Wch[FileWatcher]
    end

    subgraph storage [Persistent Storage]
        DB["SQLite FTS5 via better-sqlite3"]
        Meta[files table metadata]
    end

    subgraph ui [Webview UI]
        Panel[SearchPanel Vanilla TS]
        HL[SyntaxHighlighter]
    end

    Ext --> Cmd
    Ext --> Idx
    Cmd --> Sch
    Idx --> DB
    Idx --> Wch
    Sch --> Qry
    Sch --> DB
    Sch --> Panel
    Panel --> HL
    Wch --> Idx
    Status --> Idx
```

**技术选型**

- **语言**: TypeScript + VS Code Extension API
- **索引引擎**: `better-sqlite3` + SQLite FTS5（持久化，BM25 排序，适合百万级命中）
- **文件监视**: `chokidar`（跨平台）
- **模糊搜索**: 编辑距离 + FTS5 后处理（`FuzzyMatch.ts`）
- **UI**: WebviewView + Vanilla TS 前端
- **语法高亮**: `vscode-textmate` + 当前主题 token 颜色
- **构建**: `esbuild` 打包 extension + webview

**索引存储位置**: `context.globalStorageUri/code-search/<workspace-hash>/index.db`（可通过 `code-search.autocreate` 自定义 `indexLocation`）

### 项目结构

```
.
├── package.json
├── tsconfig.json
├── esbuild.js
├── ess.bat / ess.sh          # CLI 入口脚本
├── src/
│   ├── extension.ts          # 激活、注册命令、生命周期
│   ├── cli/index.ts          # 独立 CLI（create / update / list）
│   ├── mcp/                  # 只读 stdio MCP（list/search/read/header-source）
│   │   ├── server.ts
│   │   ├── session.ts
│   │   ├── tools.ts
│   │   └── discover.ts
│   ├── index/
│   │   ├── IndexService.ts   # 建索引、增量更新、状态管理
│   │   ├── IndexManager.ts   # 多索引注册与管理
│   │   ├── FileScanner.ts    # 遍历、过滤二进制/排除规则
│   │   ├── FileWatcher.ts    # chokidar 监听
│   │   ├── Autocreate.ts     # code-search.autocreate 解析
│   │   └── schema.sql        # FTS5 表结构
│   ├── native/
│   │   └── betterSqlite3.ts  # native 模块加载与 Electron ABI 解析
│   ├── search/
│   │   ├── QueryParser.ts    # 解析 ext:/dir:/age:/loose: 等
│   │   ├── SearchService.ts  # FTS5 MATCH + 后处理
│   │   ├── MultiIndexSearchService.ts
│   │   ├── WildcardMatcher.ts
│   │   ├── LooseSearch.ts
│   │   └── FuzzyMatch.ts
│   ├── ui/
│   │   ├── SearchPanelProvider.ts
│   │   ├── IndexManagePanel.ts
│   │   ├── webview/main.ts
│   │   └── manage-webview/main.ts
│   └── utils/
│       └── syntaxHighlight.ts
└── media/
```

### 数据库 Schema（核心）

```sql
-- 文件元数据
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  ext TEXT,
  dir TEXT,
  content TEXT NOT NULL DEFAULT ''
);

-- FTS5 全文索引
CREATE VIRTUAL TABLE files_fts USING fts5(
  path UNINDEXED,
  content,
  tokenize='unicode61 remove_diacritics 0'
);

-- 词频表（自动补全）
CREATE TABLE tokens (
  token TEXT PRIMARY KEY,
  freq INTEGER DEFAULT 1
);
```

索引流程：扫描文件 → 读文本 → INSERT/UPDATE `files` + 同步 `files_fts` → 提取 token 更新 `tokens`。

### 搜索查询语法

解析用户输入为结构化对象：

```
输入: myVar ext:cpp dir:utils -file:ChangeLog age:2h
输出: { terms: ["myVar"], filters: { ext: ["cpp"], dir: ["utils"], fileExclude: ["ChangeLog"], ageMax: "2h" } }
```

- **FTS5 查询**: 单词/短语直接转 FTS5 MATCH 语法
- **通配符**: 单词级 `*` 转 FTS5 prefix query（`token*`）；行内/跨行通配符由 `WildcardMatcher` 后处理
- **age 过滤**: SQL `WHERE mtime > ?` 与 FTS 结果 JOIN
- **ext/dir/file 过滤**: 对 `files` 表路径匹配（glob）
- **仅过滤**: 无搜索词时直接 SELECT files 表

### 搜索面板 UI

```
┌─────────────────────────────────────────────────────────────┐
│ [搜索框: myVar ext:cpp]  [Aa] [""]  [⟳]  [⚙]              │
│  Case  Phrase  Refresh  Settings                            │
├─────────────────────────────────────────────────────────────┤
│ 1,234 hits in 56 files · 0.08s          Indexing: 42% ████░ │
├─────────────────────────────────────────────────────────────┤
│ ▼ src/utils/parser.ts:42                                    │
│   const myVar = parse(input);   // 语法高亮行                │
│ ▼ src/core/handler.ts:108                                   │
│   return myVar.toString();                                    │
└─────────────────────────────────────────────────────────────┘
```

- 停靠位置：Panel 底部区域（`viewsContainers` + `views`）
- 消息协议：`search` / `openFile` / `indexStatus` / `updateSettings`

### 命令与快捷键

| 命令 | 默认快捷键 | 说明 |
|------|-----------|------|
| `codeSearch.searchSelection` | `Alt+=` | 搜索光标下单词/选中文本 |
| `codeSearch.focusSearch` | `Shift+Alt+=` | 聚焦搜索框 |
| `codeSearch.quickOpenFile` | `Shift+Alt+F` | 文件过滤模式 |
| `codeSearch.nextHit` | `Ctrl+Alt+]` | 下一命中（面板内聚焦时） |
| `codeSearch.prevHit` | `Ctrl+Alt+[` | 上一命中（面板内聚焦时） |
| `codeSearch.switchHeaderSource` | `Alt+O` | 在索引中查找并切换头/源文件（C/C++ 扩展名） |
| `codeSearch.refreshIndex` | — | 强制重建索引 |
| `codeSearch.openClassHierarchy` | — | 直接打开全部已索引 C++ class 的继承树 panel |

### 配置项

- `codeSearch.excludeGlobs` — 额外排除模式（默认含 `node_modules`, `dist`, `bin`, `obj`）
- `codeSearch.includeGlobs` — 包含模式（默认 `**/*`）
- `codeSearch.contextLines` — 开启 Ctx 后每条命中上下各显示的行数（默认 1，范围 0–10）
- `codeSearch.phraseSearchDefault` — 默认短语模式
- `codeSearch.autoOpenSingleHit` — 唯一命中自动打开
- `codeSearch.maxResults` — 最大结果数（默认 10000）
- `codeSearch.indexOnStartup` — 打开工作区时自动索引

### 关键实现细节

**1. 二进制检测**: 读取文件头最多 8KB，检测 null 字节或不可打印字符比例 > 30%，或 UTF-8 替换字符过多，则跳过该文件。

**2. 索引性能**: 批量事务（每 100 文件 commit 一次）；`IndexService` 在搜索/用户输入时暂停扫描（`pauseIndexing()`）。

**3. Class 继承缓存**: `ClassHierarchyCacheManager` 仅在索引和搜索空闲时读取待更新源码，最多两个 Worker 只负责解析，完成后由扩展线程集中、分批提交 `class_hierarchy_*` 缓存表，并在批次间重新检查搜索/索引状态。只读或无缓存的旧 secondary index 不执行 schema 写入，打开继承树时改用一次内存解析。

**3. 语法高亮**: Webview 通过 `postMessage` 获取当前 `colorTheme`，用 `vscode-textmate` 对结果行 tokenize，映射到 CSS class。

**4. native 模块**: `better-sqlite3` 需针对 VS Code/Cursor 内置 Electron ABI 预编译，产物放在 `native/<platform>-<arch>-<abi>/`。本地用 `scripts/rebuild-electron.js`；发布用 GitHub Actions 跨平台构建并合并。`vscode:prepublish` **只**跑普通 esbuild，不负责 native。CLI/MCP 另需 `scripts/rebuild-node.js` 把模块恢复为系统 Node ABI。

**5. 与 VS Code 内置搜索的关系**: 本插件是**补充**而非替代——提供预索引全文搜索体验；不修改内置 Search 面板。

## 索引与搜索算法

本扩展采用 **SQLite FTS5 倒排全文索引**，不是向量/语义搜索，也不是自研搜索引擎。整体可概括为：预建索引 + FTS5 检索 + 自定义过滤与后处理。

### 数据流概览

```mermaid
flowchart LR
    Files[工作区文件] --> Scan[FileScanner 扫描过滤]
    Scan --> Read[并发读文件内容]
    Read --> DB[(SQLite)]
    DB --> Meta[files 元数据表]
    DB --> FTS[files_fts FTS5 倒排索引]
    DB --> Tokens[tokens 词频表]
    Watcher[chokidar 文件监视] --> Incremental[增量更新单文件]
    Incremental --> DB
    Query[用户查询] --> Parser[QueryParser]
    Parser --> FTS
    Parser --> Post[Loose / Fuzzy / Wildcard 后处理]
    FTS --> Results[搜索结果]
    Post --> Results
```

### 索引阶段（建库）

实现位于 `src/index/IndexService.ts`、`FileScanner.ts`、`FileWatcher.ts`。

**存储结构**（见 `src/index/schema.sql`）：

| 表 | 作用 |
|----|------|
| `files` | 路径、mtime、大小、扩展名、目录、完整文件内容 |
| `files_fts` | FTS5 虚拟表，对 `content` 建倒排索引 |
| `tokens` | 词频统计，供搜索框自动补全 |

FTS5 分词器（实际代码）：

```sql
tokenize='unicode61 remove_diacritics 0'
```

即 SQLite 内置 **unicode61** 按 Unicode 规则切词，不做 Porter 英文词干化。

**扫描与过滤**（`FileScanner.ts`）：

1. 递归遍历工作区（栈式 DFS）
2. 按 `excludeGlobs`、目录名、文件大小等排除
3. 扩展名白名单 + 二进制检测：
   - 已知二进制扩展名直接跳过
   - 读取文件头最多 8KB：null 字节 >30%、不可打印字符 >30%、UTF-8 替换字符过多 → 视为二进制
4. 文本文件整文件读入，写入数据库

**写入流程**（`IndexService.ts`）：

1. **全量/增量**：对比 `mtime`，未变化文件跳过
2. **批量事务**：每 100 个文件 commit 一次
3. 每个文件：`INSERT/UPDATE files` → 更新 `files_fts`（先删后插）→ 用正则 `/[a-zA-Z_][a-zA-Z0-9_]*/g` 提取标识符写入 `tokens`（每文件最多 500 个，长度 ≥2）
4. **并发读盘**：可配置 `codeSearch.indexThreads`；搜索时 `pause()` 索引以降低 IO 争抢
5. **增量更新**：`chokidar` 监视文件增删改，单文件重索引

数据库使用 WAL 模式（`journal_mode = WAL`），默认路径见上文「索引存储位置」。

### 搜索阶段（查询）

实现位于 `src/search/SearchService.ts`、`QueryParser.ts`。

**标准搜索：FTS5 + BM25**

1. `QueryParser` 解析查询词及 `ext:` / `dir:` / `file:` / `age:` 等过滤
2. 将搜索词转为 FTS5 `MATCH` 语法（支持 `*` 前缀通配）
3. 执行 `files_fts MATCH ?` 并与 `files` 表 JOIN
4. FTS5 默认以 **BM25** 排序相关性
5. 再按路径、扩展名、mtime、`+/-` 内容过滤等做 SQL 或内存过滤

**高级模式**（FTS 之外的补充算法）：

| 模式 | 做法 |
|------|------|
| **Loose 松散短语** | FTS 先筛候选文件，再用 token 间距算法在内存中找词距 ≤ N 的命中（`LooseSearch.ts`） |
| **Fuzzy 模糊** | FTS 结果不足时，对候选内容做编辑距离匹配（`FuzzyMatch.ts`） |
| **行内/跨行通配符** | FTS 粗筛 + `WildcardMatcher` 在内容上做模式匹配 |
| **仅过滤** | 无搜索词时直接查 `files` 表，按路径/扩展名过滤 |

### 与 VS Code 内置搜索的对比

| | Ace Code Search | VS Code 内置搜索 |
|--|-----------------|------------------|
| 方式 | 预先索引（后台建库） | 实时 ripgrep 扫盘 |
| 引擎 | SQLite FTS5 倒排索引 | ripgrep 正则 |
| 大仓库 | 索引完成后查询通常更快 | 每次搜索扫文件 |
| 存储 | 本地 `.db` 占磁盘 | 无持久索引 |

### 一句话总结

> 文件扫描过滤 → 全文存入 SQLite → **FTS5 unicode61 倒排索引（BM25 排序）** → 查询时 FTS MATCH + 元数据过滤 → 必要时 Loose / Fuzzy / Wildcard 内存后处理。

### 风险与缓解

| 风险 | 缓解 |
|------|------|
| `better-sqlite3` 原生编译在不同 VS Code 版本失败 | 预编译 binary + GitHub Actions 多平台构建；文档说明 Node 版本 |
| 超大仓库首次索引耗时长 | 边索引边搜索 + 进度条 + 可配置排除 |
| FTS5 不支持全部复杂通配符语义 | 复杂通配符走 SQL 过滤 + 内存后匹配 |
| F8 / Shift+Alt+方向键 与内置快捷键冲突 | 默认 `Ctrl+Alt+]` / `Ctrl+Alt+[`；仅面板 webview 聚焦时生效；可自定义 |
| `Alt+O` 与其它扩展头/源切换冲突 | 扩展默认解绑旧命令；启动时自动迁移用户 `keybindings.json` 中的 Alt+O 旧绑定，并持续劫持 `C_Cpp.SwitchHeaderSource` / `clangd.switchheadersource` |

### 参考

- [SQLite FTS5](https://www.sqlite.org/fts5.html)
