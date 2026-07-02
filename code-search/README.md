# Code Search

VS Code 扩展，对标 [Entrian Source Search](https://entrian.com/source-search/)，基于 SQLite FTS5 提供全文代码索引与即时搜索。

详细开发说明见 [README_Dev.md](README_Dev.md)。

## 功能对标清单

基于 [Entrian 官网](https://entrian.com/source-search/)、[QuickStart](https://entrian.com/source-search/manual.html)、[搜索手册](https://entrian.com/source-search/doc-searching.html) 与 [索引手册](https://entrian.com/source-search/doc-indexing.html) 整理。✅ 表示已实现。

| 类别 | Entrian 功能 | 状态 |
|------|-------------|------|
| **索引** | 可配置根目录全文索引 | ✅ 工作区根目录 + `source-search.autocreate` 指定根目录 |
| | 多根目录 / 二级只读索引 / 目录映射 | ✅ 二级索引 + 路径映射 |
| | 增量更新（文件监视器） | ✅ chokidar 实时更新 |
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
| | `EntrianSourceSearch.autocreate` / `source-search.autocreate` | ✅ JSON 自动创建 |
| | CLI 索引工具（ess） | ✅ `ess.bat` / `npm run cli` |
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
| | 上下文行数（Verbosity） | 🟡 配置项 `contextLines`，无滑块 UI |
| | 查询语法着色（绿 / 红过滤） | ✅ |
| | 多标签页 | ✅ Ctrl+Enter / + 新建 |
| | 标签锁定 | ✅ |
| | 代码词自动补全 | ✅ |
| **导航** | 光标下单词 / 选中文本搜索 | ✅ `Alt+=` |
| | F8 / Shift+F8 跳转上 / 下命中 | ✅ |
| | Shift+Alt+F 快速打开文件 | ✅ |
| | 单击打开 / 预览 | ✅ Preview |
| | 唯一命中自动打开 | ✅ 可配置 `autoOpenSingleHit` |

图例：✅ 已完成 · 🟡 部分实现 · ⬜ 待实现

## 快捷命令

| 命令 | 快捷键 |
|------|--------|
| Search Selection | `Alt+=` |
| Focus Search | `Shift+Alt+=` |
| Quick Open File | `Shift+Alt+F` |
| Next Hit | `F8` |
| Previous Hit | `Shift+F8` |
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
