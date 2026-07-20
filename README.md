# Ace Code Search

VS Code 扩展，基于 SQLite FTS5 提供全文代码索引与即时搜索。

![Ace Code Search 截图](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/AceCodeSearch.png)

![Class Viewer 截图](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/CodeSearchClassViewer.png)

> **独立开发声明**
>
> 本插件在功能理念上参考了 [Entrian Source Search](https://entrian.com/source-search/) 等全文代码搜索工具的用户体验，但代码、架构与实现均为本项目独立设计与开发，未使用任何第三方源代码或专有资产，与 Entrian 及其产品无任何关联或授权关系。

详细开发说明见 [README_Dev.md](README_Dev.md)。

需要 VS Code 1.103 或更高版本；这是打包原生矩阵覆盖的首个 Electron 37 / ABI 136 稳定版。

## VS Code / Cursor 共用索引

同一台机器上用 VS Code 和 Cursor 打开相同目录或 workspace 时，新建工作区索引默认使用同一份、与 IDE 无关的 Primary 数据库。打开 **Manage Indexes** 可以看到当前 workspace 根目录、Primary 来源、实际读写模式和共享数据库路径。

- **共享 Primary**：点击 **Use Shared Index**，或运行 **Ace Code Search: Choose Workspace Primary Index...**，可使用确定性的共享路径；选择器也会列出从 VS Code/Cursor registry 自动发现的同 workspace 索引
- **手动 Primary**：选择任意已有 `index.db`；已有数据库推荐只读，也可选择 **Automatic single-writer**
- **单写者保护**：自动模式通过 `<index.db>.writer.lock` 只允许一个 IDE 写入；另一个 IDE 自动以只读方式搜索同一数据库，并在管理页显示当前写入者。写入方关闭后，reader 会在空闲时自动接管写权限并启动增量监听
- **崩溃恢复**：owner 信息完整、进程已失效的 writer lock 会自动回收。若异常文件系统的兼容创建过程留下 malformed/incomplete `.writer.lock`，或 IDE 恰好在更短的回收步骤中被强制结束并残留 `.writer.lock.reclaim`，请先关闭所有正在使用该索引的 IDE，再手动删除对应的孤儿 lock/guard。扩展不会自动删除这两类不完整文件，以免竞态下出现两个写入者
- **Secondary**：**Open Secondary...** 可打开自动发现或手动选择的数据库；默认只读，也可在提供可靠源目录后使用自动单写者模式。已打开的 Secondary 会加入每次搜索
- **安全只读**：只读索引不会扫描目录、启动 watcher、迁移 schema 或写数据库；无效数据库会在切换前报错，原 Primary 保持可用
- **清晰的属性层级**：管理页以 Primary 为主、Secondary 为从属，并将 `Index content` 与 `This workspace` 分开。全局生效的 Unreal 默认排除目录会只读展示，单个索引的 Additional exclusions 单独编辑，避免空文本框让人误以为 `Binaries`、`Intermediate`、`Saved` 等仍会被索引
- **兼容旧索引**：原 VS Code/Cursor `globalStorage` 索引不会搬移或删除，会以 Legacy 来源继续打开；`code-search.autocreate` 仍优先并控制其配置路径

新共享数据库位置：

- Windows：`%LOCALAPPDATA%\AceCodeSearch\indexes\<workspace-key>\index.db`
- macOS：`~/Library/Application Support/AceCodeSearch/indexes/<workspace-key>/index.db`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/AceCodeSearch/indexes/<workspace-key>/index.db`

`workspace-key` 由规范化并排序后的 workspace 根目录生成；Windows 路径大小写和多根目录顺序不会让 VS Code/Cursor 分到不同数据库。

启动优先级、兼容迁移与验证矩阵见 [README_Dev.md — Cross-IDE Primary binding and compatibility](README_Dev.md#cross-ide-primary-binding-and-compatibility)。

## 大型工作区性能优化

针对 Unreal Engine 等大型代码库（实测 UE 5.61），0.4.x 重点解决「索引已 **Up to date** 但扩展宿主仍高 CPU、搜索体感卡顿」的问题。实机 profile 表明：同一索引下 `AActor` 类 FTS 查询约 **200ms** 即可达到 1 万条结果，瓶颈主要在扩展宿主内的文件监听与 UI 推送，而非 SQLite 或搜索算法本身。

**文件监听**

- VS Code/Cursor 使用编辑器原生 `FileSystemWatcher`，递归监听在文件服务进程执行，避免 chokidar 在扩展宿主遍历百万级路径
- CLI 仍保留 chokidar fallback，不影响命令行索引
- include/exclude matcher 只编译一次，扫描器与监听器共用
- 搜索期间暂停文件索引更新，结束后分批排空积压事件
- 监听器就绪后才显示 **Up to date**，避免 UI 显示空闲时仍在后台大规模初始化

**流式搜索与结果面板**

- FTS 游标化（`stmt.iterate`）边读边推送：首批 **50** 条、后续每批 **500** 条
- Extension 按 **100** 行分块推送 webview，并等待 ACK，防止 `postMessage` 积压拖慢首屏
- Webview 首批轻量纯文本渲染，后续批次经 `requestAnimationFrame` 合并 DOM 追加
- 搜索进行中自动暂停后台索引，减少磁盘 IO 争抢
- **Updating** 状态显示「已载入 / 已发现」数量，避免 `2,050 hits` 被误解为已全部渲染到界面

**诊断日志（可选）**

- `codeSearch.profileSearch` 默认 **关闭**；需要排查性能时可手动开启
- 开启后搜索开始即写入独立 JSONL，运行中每 250ms checkpoint；支持 `success` / `cancelled` / `error` / `disposed` 终态
- 命令 `codeSearch.openProfileLogFolder` 打开日志目录；`latest-profile.jsonl` 始终指向最新一轮搜索

索引完成后的实机验证目标：`AActor` 首批 ≤500ms，1 万条结果 ≤5s，空闲后扩展宿主 CPU 快速回落。

## 头/源文件切换（Alt+O）

在 **C/C++ 文件已建立索引** 后，按 **`Alt+O`** 可在配对的 `.h` / `.cpp`（及 `.hpp`、`.cc` 等）之间切换打开，无需再依赖 C/C++ Tools 或 clangd 的头源切换。

- **索引驱动**：配对文件必须出现在索引的 `files` 表中；未索引则提示「索引中未找到配对文件」
- **配对优先级**：同目录同名 stem → UE 风格 `Public` ↔ `Private` 目录 → 其它目录（路径最近优先）
- **命令**：`codeSearch.switchHeaderSource`（Ace Code Search: Switch Header/Source）
- **快捷键冲突**：扩展启动时会自动迁移用户 `keybindings.json` 里仍指向 `C_Cpp.SwitchHeaderSource` / `clangd.switchheadersource` 的 Alt+O 绑定，并持续劫持上述旧命令 ID

## Class 继承树

无需先搜索，直接点击搜索工具栏中的继承树图标，即可在新的编辑器 panel 中查看所有已索引 C/C++ `class` / `struct` 的继承关系。点击 class 名称会打开声明文件并定位到对应代码行。

- 继承声明缓存在索引数据库中；源码变化后自动失效，并在搜索和索引空闲时由最多两个后台解析线程增量更新
- 缓存解析完成后集中写入数据库，不把解析工作插入现有的全文搜索或索引建立流程；只读旧索引保持兼容并使用内存回退
- 支持 UE `MODULE_API`、namespace、多行声明、`final`、多继承、访问修饰符和 `virtual` 基类；索引外基类以灰色外部节点补齐
- 超大继承图默认折叠，单次最多渲染 5,000 个树节点；过滤选中 class 后清空过滤会回到该位置
- 右键 class 可展开或折叠它的全部子类；点击顶部 Refresh 可立即读取最新缓存状态

## 性能特性

Ace Code Search 采用**预索引 + 持久化全文检索**，在大仓库中重复搜索时通常比 VS Code 内置实时扫盘搜索更快。

- **SQLite FTS5 倒排索引**：工作区文件在后台建库，搜索走 `MATCH` 查询与 **BM25** 相关性排序，而非每次全量扫描磁盘
- **边索引边搜索**：首次打开大项目时无需等 100% 建完索引即可开始查询；状态栏与工具栏显示 Scanning / Indexing / Up to date
- **增量更新**：VS Code/Cursor 使用原生文件监听器（CLI 保留 chokidar）；按 `mtime` 跳过未改文件，单文件增删改后局部重索引；include/exclude 规则只编译一次
- **索引与搜索协同**：搜索期间暂停文件监听与索引更新，结束后分批排空；批量事务（每 100 文件 commit）与可配置**多线程读盘**（`codeSearch.indexThreads`）加快首次建库
- **流式结果推送**：首批 50 条快速上屏，后续分批推送并配合 webview ACK 背压，大结果集下保持面板可响应
- **本地持久化**：新工作区索引存于跨 IDE 共享的应用数据目录（WAL 模式）；旧 `globalStorage` 索引继续兼容，重启后无需无条件全量重建
- **可配置排除**：默认跳过 `node_modules`、`dist`、二进制等，缩小索引体积、缩短建库时间

与 VS Code 内置搜索对比：内置搜索适合临时、小范围查找；本扩展适合**频繁符号/全文检索**，索引完成后常见查询可在亚秒级返回。算法细节见 [README_Dev.md — 索引与搜索算法](README_Dev.md#索引与搜索算法)。

## AI Agent / MCP 支持

Ace Code Search 提供独立的**只读 stdio MCP Server**，让 Cursor、VS Code/Copilot 等 AI Agent 直接查询已有 SQLite FTS 索引，避免每次用 `grep`/`rg` 全盘扫描大型代码库。

### MCP 工具

| 工具 | 用途 |
| --- | --- |
| `list_indexes` | 列出自动发现或显式配置的索引、根目录、token 数与完整状态 |
| `search_code` | 全文搜索，支持索引选择、大小写、短语、模糊、松散匹配及查询过滤器 |
| `read_indexed_file` | 按行范围读取索引中的文件快照 |
| `find_header_source` | 使用索引查找 C/C++ 头文件/源文件配对 |

`search_code` 的主要参数：

- `caseSensitive`：大小写敏感
- `phraseSearch`：多词连续短语匹配
- `fuzzy`：基于编辑距离的拼写容错
- `loose` + `looseGap`：若干 token 范围内任意顺序匹配
- `contextLines` / `maxResults`：上下文行与结果上限
- 查询语法仍支持 `ext:`、`file:`、`dir:`、`age:`、`+/-` 内容过滤及 `*` 通配符

当前没有独立的严格 `wholeWord` 参数；已知标识符应直接搜索完整 token。包含连字符等标点的名称若无结果，可按 tokenizer 拆词，例如用 `better sqlite3` 搜索 `better-sqlite3`。

### 索引发现与只读保证

- 无参数启动时容错发现 VS Code 与 Cursor `globalStorage` 中的 registry；损坏的自动来源会出现在 `list_indexes.warnings`，不会阻止 Server 启动
- 默认只暴露 MCP client roots（其次为 `--workspace-root` / cwd）完全包含的索引；父目录索引、混合无关根的索引会安全拒绝，跨工作区必须显式使用 `--all-indexes`
- 也可显式传入严格的 `--registry <registry.json>` 或直接授权的 `--db <index.db>`；可见索引超过一个时必须传 `indexId`
- MCP 不建立索引、不启动 watcher、不写数据库或 registry
- Primary/Secondary 选择与单写者锁是编辑器管理操作，刻意不提供 MCP 写入工具；MCP 只读打开 registry 中已登记的共享/手动数据库，也不会创建 `.writer.lock`
- 返回内容是**索引快照**；持久化构建状态不是 `complete` 时会返回 `partialIndex: true`。未保存修改、尚未入库或被排除文件仍需回退到直接读文件/`rg`

```bash
npm run mcp
npm run mcp -- --db /path/to/index.db
npm run mcp -- --registry /path/to/registry.json --workspace-root /path/to/workspace
# 仅在明确需要跨工作区时：npm run mcp -- --all-indexes
```

### Skill 与搜索优先规则

工具栏文档勾选按钮或命令 **Ace Code Search: Install Agent Integration (Project Guidance + User MCP)** 会写入：

- 唯一完整的项目 Skill：`.agents/skills/ace-code-search-mcp/SKILL.md`
- Cursor 薄路由 Rule：`.cursor/rules/ace-code-search-first.mdc`
- Claude 薄兼容包装：`.claude/skills/ace-code-search-mcp/SKILL.md`
- 稳定用户启动器：`~/.ace-code-search/mcp-launcher.cjs`（每次启动查找最新已安装扩展）
- Codex / Cursor 用户配置：`~/.codex/config.toml`、`~/.cursor/mcp.json`
- 支持该 API 的 VS Code 会直接发现扩展提供的 `ace-code-search.mcp-servers`

> Skill 只提供用法说明；**没有 MCP Server 注册时，会话里不会出现** `list_indexes` / `search_code` 等工具。安装后请重启 Codex（或执行 `/mcp`）再试。
>
> Codex/Cursor 的启动器要求客户端 PATH 中存在 `node`；VSIX 内置原生绑定保证 Node.js 20、22、24。VS Code 动态 Provider 使用编辑器运行时，不要求另装 PATH Node。

完整 Skill 只保留在 `.agents`；不会再复制到 `.cursor/skills`。普通安装也**不会**创建项目 `.codex/config.toml` 或 `.github/instructions`，扩展激活时更不会静默写入。检测到用户修改、无效 marker 或自定义 MCP 配置时会保留原内容并警告。

Instruction/Rule 会建议：有匹配索引时优先使用 Ace Code Search MCP；无索引、索引可能不完整/过期或文件未入库时再回退 `rg`/文件系统搜索。

可选个人命令：

- **Ace Code Search: Install Optional VS Code Copilot Search Instruction** — 明确选择后才写入项目 `.github/instructions`
- **Ace Code Search: Copy Cursor User Rule (Personal)** — 仅用于 Cursor 设置里的个人 User Rules

> 旧版由扩展管理且未被修改的项目 `.cursor/skills`、项目 `.codex` 和默认 `.github/instructions` 会安全迁移/清理；个人客户端副本及无法确认所有权的文件会保留。完整细节见 [README_Dev.md — MCP (AI Agent)](README_Dev.md#mcp-ai-agent)。

## 功能清单

✅ 表示已实现。

| 类别 | 功能 | 状态 |
|------|------|------|
| **索引** | 可配置根目录全文索引 | ✅ 工作区根目录 + `code-search.autocreate` 指定根目录 |
| | VS Code/Cursor 共用 Primary / 手动 Primary / 单写者 | ✅ 共享路径 + 自动发现 + 只读回退 |
| | 多根目录 / Secondary 索引 / 目录映射 | ✅ 只读或自动单写者 Secondary + 路径映射 |
| | 增量更新（文件监视器） | ✅ VS Code 原生监听（CLI 用 chokidar） |
| | 低优先级后台节流（Be extra nice） | ⬜ 待实现 |
| | 排除二进制 / 可配置排除 | ✅ 二进制检测 + `excludeGlobs` 配置 |
| | 自动尊重 `.gitignore` | ⬜ 待实现（当前靠默认排除规则） |
| | 每索引独立 include/exclude | 🟡 exclude 有 Advanced UI；include 仍靠 autocreate/global 配置 |
| | 索引状态（Scanning / Indexing / Up to date） | ✅ 状态栏 + 工具栏提示 |
| | 索引队列详情 tooltip | ⬜ 待实现 |
| | 部分索引即可搜索 | ✅ |
| | 强制刷新 | ✅ 命令面板全量刷新 |
| | changed-only / all-files 分模式刷新 | ⬜ 待实现 |
| | 索引管理（Primary 来源 / Search scope / 创建 / 忘记 / 重命名） | ✅ 重构后的管理面板（编辑器标签页） |
| | `code-search.autocreate` 配置文件 | ✅ JSON 自动创建 |
| | Ace Code Search CLI | ✅ `npm run cli` / `ess.bat` |
| **AI Agent** | 只读 stdio MCP | ✅ 索引发现、搜索、快照读取、头源配对 |
| | Skill / 搜索优先规则分发 | ✅ `.agents` 唯一 Skill + Cursor/Claude 薄包装；VS Code Instruction 可选 |
| **搜索** | 单词 / 多词 / 短语 | ✅ |
| | 通配符 `*`（单词级） | ✅ |
| | 通配符（行内 / 跨行）`"this * that"` / `"this *:100 that"` | ✅ |
| | Loose 松散短语 `loose:"A B"` | ✅ |
| | Fuzzy 模糊搜索 | ✅ |
| | 大小写敏感切换 | ✅ 工具栏 Aa |
| | 短语搜索默认开关 | ✅ 工具栏 "" |
| | 仅过滤搜索 `file:*x* dir:y` | ✅ |
| **过滤** | `ext:` / `file:` / `dir:` | ✅ |
| | `age:` 文件修改时间 | ✅ |
| | `+` / `-` 文件内容正负过滤 | ✅ |
| **结果 UI** | 底部停靠搜索窗口 | ✅ WebviewView 面板 |
| | 语法高亮结果 | 🟡 规则高亮（非完整 TextMate 主题） |
| | 命中数 / 耗时统计 | ✅ |
| | 可排序结果列表（路径 / 行号 / 代码） | ✅ 点击表头升/降序 |
| | 上下文行显示 | ✅ 工具栏上下文图标；行数由 `contextLines` 配置 |
| | 查询语法着色（绿 / 红过滤） | ✅ |
| | 多标签页 | ✅ Ctrl+Enter / + 新建 |
| | 标签锁定 | ✅ |
| | 代码词自动补全 | ✅ |
| | 全索引 C++ class 继承树 | ✅ 工具栏继承树图标；点击 class 跳转声明 |
| **导航** | 光标下单词 / 选中文本搜索 | ✅ `Alt+=` |
| | Ctrl+Alt+] / Ctrl+Alt+[ 跳转下/上命中 | ✅ |
| | Shift+Alt+F 快速打开文件 | ✅ |
| | Alt+O 头/源文件切换（基于索引） | ✅ |
| | 单击打开 / 预览 | ✅ Preview |
| | 唯一命中自动打开 | ✅ 可配置 `autoOpenSingleHit` |

图例：✅ 已完成 · 🟡 部分实现 · ⬜ 待实现

## 快捷命令

| 命令 | 快捷键 |
|------|--------|
| Search Selection | `Alt+=` |
| Focus Search | `Shift+Alt+=` |
| Quick Open File | `Shift+Alt+F` |
| Switch Header/Source | `Alt+O` |
| Next Hit | `Ctrl+Alt+]` |
| Previous Hit | `Ctrl+Alt+[` |
| Refresh Index | 命令面板 |
| Manage Indexes | 工具栏 ⚙ |
| Install Agent Skill / Rule | 工具栏文档勾选图标 / 命令面板（写入当前项目） |
| Show Class Inheritance Tree | 工具栏继承树图标 / 命令面板 |
| Choose Workspace Primary Index | 命令面板 |
| Open Secondary Index | 命令面板 |

## 安装与构建

```bat
install.bat
build.bat
安装CodeSearch.bat
```

macOS / Linux：`chmod +x install.sh build.sh install-extension.sh bump-version.sh`，然后 `./install.sh` → `./build.sh` → `./install-extension.sh`。

AI Agent / MCP 的工具、搜索参数和 Skill/Rule 安装方式见上方 [AI Agent / MCP 支持](#ai-agent--mcp-支持)。

更多配置、Phase 2/3 用法与 CLI 说明见 [README_Dev.md](README_Dev.md)、[PHASE2.md](PHASE2.md)。
