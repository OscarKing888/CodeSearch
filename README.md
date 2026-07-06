# Ace Code Search

VS Code 扩展，基于 SQLite FTS5 提供全文代码索引与即时搜索。

![Ace Code Search 截图](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/AceCodeSearch.png)

> **独立开发声明**
>
> 本插件在功能理念上参考了 [Entrian Source Search](https://entrian.com/source-search/) 等全文代码搜索工具的用户体验，但代码、架构与实现均为本项目独立设计与开发，未使用任何第三方源代码或专有资产，与 Entrian 及其产品无任何关联或授权关系。

详细开发说明见 [README_Dev.md](README_Dev.md)。

## 功能清单

✅ 表示已实现。

| 类别 | 功能 | 状态 |
|------|------|------|
| **索引** | 可配置根目录全文索引 | ✅ 工作区根目录 + `code-search.autocreate` 指定根目录 |
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
| | 单击打开 / 预览 | ✅ Preview |
| | 唯一命中自动打开 | ✅ 可配置 `autoOpenSingleHit` |

图例：✅ 已完成 · 🟡 部分实现 · ⬜ 待实现

## 快捷命令

| 命令 | 快捷键 |
|------|--------|
| Search Selection | `Alt+=` |
| Focus Search | `Shift+Alt+=` |
| Quick Open File | `Shift+Alt+F` |
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
