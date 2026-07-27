[中文](https://github.com/OscarKing888/CodeSearch/blob/main/README.md) | [English](https://github.com/OscarKing888/CodeSearch/blob/main/README_en.md)

# Ace Code Search

VS Code / Cursor 扩展，为工作区提供全文代码索引与即时搜索。

![Ace Code Search 截图](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/AceCodeSearch.png)

![Class Viewer 截图](https://raw.githubusercontent.com/OscarKing888/CodeSearch/main/doc/CodeSearchClassViewer.png)

> **独立开发声明**
>
> 本插件在功能理念上参考了 [Entrian Source Search](https://entrian.com/source-search/) 等全文代码搜索工具的用户体验，但代码、架构与实现均为本项目独立设计与开发，未使用任何第三方源代码或专有资产，与 Entrian 及其产品无任何关联或授权关系。

需要 VS Code 或 Cursor **1.103** 或更高版本。

## 主要功能

- **全文搜索**：支持短语、模糊匹配、路径/扩展名/时间等过滤，多标签结果面板，大结果集流式加载
- **大型代码库友好**：后台建索引、边建边搜；默认排除 Unreal Engine 生成目录及常见依赖/构建产物
- **跨 IDE 共用索引**：同一台机器上 VS Code 与 Cursor 打开相同工作区时可共用 Primary 索引；详见开发与配置文档
- **头/源切换**：在已索引的 C/C++ 文件中按 **Alt+O** 在配对的头文件与源文件间跳转
- **类继承树**：无需先搜索，在独立面板中浏览已索引 C++ 类的继承关系并跳转到声明，同时支持了UnrealSharp的类继承显示
- **索引管理**：工具栏 ⚙ 打开管理页，配置 Primary / Secondary、共享索引与搜索范围
- **AI Agent 集成**：只读 MCP 供 Cursor、Copilot 等 Agent 查询已有索引；工具栏文档图标或命令面板安装 Agent 集成

## 搜索语法

过滤器必须是由空白分隔的独立项；同类正向过滤器按 **OR** 组合，不同类别按 **AND** 组合，任一负向过滤器优先排除。

```text
普通：needle ext:h,cpp,inc file:*Parser* dir:src/** -file:*.test.* -dir:*generated* -ext:bak
正则：开启工具栏的 .* 后输入 ^class\s+\w+\b ext:h,cpp -dir:*ThirdParty*
```

- `ext:` 支持逗号分隔的扩展名；`file:` / `dir:` 支持标准 Glob：`*` 不跨目录、`**` 可跨目录、`?` 匹配单个字符，路径分隔符统一处理且不区分大小写。
- `file:"My File*.cpp"` 可用双引号包含空格。正则模式使用逐行 ECMAScript pattern，不要写 `/.../flags`，大小写由 `Aa` 控制。
- 正则模式只解析表达式末尾连续的 `ext:` / `file:` / `dir:` / `age:` 过滤器，不支持跨行，扫描大型索引时可能比普通全文搜索慢。
- `.*` 旁的下拉菜单可把常用正则字符插入当前光标或选区；菜单仅用于面板输入，MCP 调用使用 `regex: true`。

## 快捷命令

| 命令 | 快捷键 |
|------|--------|
| 搜索选区/光标下单词 | `Alt+=` |
| 聚焦搜索框 | `Shift+Alt+=` |
| 快速打开文件 | `Shift+Alt+F` |
| 头/源切换 | `Alt+O` |
| 下一命中 | `Ctrl+Alt+]` |
| 上一命中 | `Ctrl+Alt+[` |
| 刷新索引 | 命令面板 |
| 管理索引 | 工具栏 ⚙ |
| 安装 Agent 集成 | 工具栏文档图标 / 命令面板 |
| 类继承树 | 工具栏继承树图标 / 命令面板 |
| 选择工作区 Primary 索引 | 命令面板 |
| 打开 Secondary 索引 | 命令面板 |

## 安装

在 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=OscarKing888.ace-code-search) 搜索 **Ace Code Search**（发布者 OscarKing888）安装。

本地从源码构建与安装见：https://github.com/OscarKing888/CodeSearch/blob/main/README_Dev.md

## 更多文档

- 英文用户文档：https://github.com/OscarKing888/CodeSearch/blob/main/README_en.md
- 开发与配置（中文）：https://github.com/OscarKing888/CodeSearch/blob/main/README_Dev.md
- 开发与配置（English）：https://github.com/OscarKing888/CodeSearch/blob/main/README_Dev_en.md
- CLI / Phase 2：https://github.com/OscarKing888/CodeSearch/blob/main/PHASE2.md
- 更新记录：https://github.com/OscarKing888/CodeSearch/blob/main/CHANGELOG.md
