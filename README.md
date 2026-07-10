# Ace Code Search

VS Code 扩展，基于 SQLite FTS5 提供全文代码索引与即时搜索。

![Ace Code Search 截图](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/AceCodeSearch.png)

> **独立开发声明**
>
> 本插件在功能理念上参考了 [Entrian Source Search](https://entrian.com/source-search/) 等全文代码搜索工具的用户体验，但代码、架构与实现均为本项目独立设计与开发，未使用任何第三方源代码或专有资产，与 Entrian 及其产品无任何关联或授权关系。

详细开发说明见 [README_Dev.md](README_Dev.md)。

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

## 性能特性

Ace Code Search 采用**预索引 + 持久化全文检索**，在大仓库中重复搜索时通常比 VS Code 内置实时扫盘搜索更快。

- **SQLite FTS5 倒排索引**：工作区文件在后台建库，搜索走 `MATCH` 查询与 **BM25** 相关性排序，而非每次全量扫描磁盘
- **边索引边搜索**：首次打开大项目时无需等 100% 建完索引即可开始查询；状态栏与工具栏显示 Scanning / Indexing / Up to date
- **增量更新**：VS Code/Cursor 使用原生文件监听器（CLI 保留 chokidar）；按 `mtime` 跳过未改文件，单文件增删改后局部重索引；include/exclude 规则只编译一次
- **索引与搜索协同**：搜索期间暂停文件监听与索引更新，结束后分批排空；批量事务（每 100 文件 commit）与可配置**多线程读盘**（`codeSearch.indexThreads`）加快首次建库
- **流式结果推送**：首批 50 条快速上屏，后续分批推送并配合 webview ACK 背压，大结果集下保持面板可响应
- **本地持久化**：索引存于 `globalStorage` 的 SQLite 数据库（WAL 模式），重启 VS Code 后无需全量重建（除非强制刷新或文件已变）
- **可配置排除**：默认跳过 `node_modules`、`dist`、二进制等，缩小索引体积、缩短建库时间

与 VS Code 内置搜索对比：内置搜索适合临时、小范围查找；本扩展适合**频繁符号/全文检索**，索引完成后常见查询可在亚秒级返回。算法细节见 [README_Dev.md — 索引与搜索算法](README_Dev.md#索引与搜索算法)。

## 功能清单

✅ 表示已实现。

| 类别 | 功能 | 状态 |
|------|------|------|
| **索引** | 可配置根目录全文索引 | ✅ 工作区根目录 + `code-search.autocreate` 指定根目录 |
| | 多根目录 / 二级只读索引 / 目录映射 | ✅ 二级索引 + 路径映射 |
| | 增量更新（文件监视器） | ✅ VS Code 原生监听（CLI 用 chokidar） |
| | 低优先级后台节流（Be extra nice） | ⬜ 待实现 |
| | 排除二进制 / 可配置排除 | ✅ 二进制检测 + `excludeGlobs` 配置 |
| | 自动尊重 `.gitignore` | ⬜ 待实现（当前靠默认排除规则） |
| | 每索引独立 include/exclude | 🟡 autocreate JSON 支持，无完整 UI |
| | 索引状态（Scanning / Indexing / Up to date） | ✅ 状态栏 + 工具栏提示 |
| | 索引队列详情 tooltip | ⬜ 待实现 |
| | 部分索引即可搜索 | ✅ |
| | 强制刷新 | ✅ 命令面板全量刷新 |
| | changed-only / all-files 分模式刷新 | ⬜ 待实现 |
| | 索引管理（创建 / 删除 / 移动 / 重命名） | ✅ 专属管理面板（编辑器标签页） |
| | `code-search.autocreate` 配置文件 | ✅ JSON 自动创建 |
| | Ace Code Search CLI | ✅ `npm run cli` / `ess.bat` |
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
| | 上下文行显示 | ✅ 工具栏 Ctx；行数由 `contextLines` 配置 |
| | 查询语法着色（绿 / 红过滤） | ✅ |
| | 多标签页 | ✅ Ctrl+Enter / + 新建 |
| | 标签锁定 | ✅ |
| | 代码词自动补全 | ✅ |
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
| Open Secondary Index | 命令面板 |

## 安装与构建

```bat
install.bat
build.bat
安装CodeSearch.bat
```

macOS / Linux：`./install.sh` → `./build.sh` → `./install-extension.sh`

更多配置、Phase 2/3 用法与 CLI 说明见 [README_Dev.md](README_Dev.md)、[PHASE2.md](PHASE2.md)。
