# 功能分支、合并到 main 与清理

CodeSearch 仓库级 Git 协议，沿用 DiskLanded 的本地 worktree、逐功能提交、合并与清理流程。
完整规则只在本文件维护，根目录 `AGENTS.MD` 指向本文件。

## 会话开始：独立 worktree 与任务分支

- 每个会话在首次修改代码、测试、配置或文档前，必须从本地 `main` 已提交的最新状态
  创建独立 Git worktree 和唯一任务分支。默认分支名
  `work/<task>-<短随机id>`，目录为主仓库下 `.worktrees/<task>-<短随机id>/`（已在
  `.gitignore` 中忽略，且 `.vscodeignore` 排除 `.worktrees/**`）。只读分析不要求创建；恢复同一会话时复用已确认属于本会话的 worktree
  和分支。工具已创建的独立 worktree 可直接使用，但 detached HEAD 必须先建任务分支。不得在
  主工作目录直接开发，也不得只建分支却继续共用同一个工作目录。
- 开始时运行 `git status --short --branch`、`git worktree list --porcelain`、`git rev-parse main`，
  记录主仓库路径、任务 worktree 路径、分支名和起始提交。用
  `git worktree add -b <branch> <worktree-path> <main-commit>` 创建，占位符替换为本次实际值。
  主目录已有的未提交或未跟踪改动不带入，不替其他会话 stash、清理或提交。
- 之后的读写、依赖准备和验证都显式以本会话 worktree 为工作目录；不要依赖一次 `cd` 影响后续
  工具调用。缓存、端口、测试输出和本机运行数据避免与其他会话写到同一位置。
- 同一会话的子代理可在编辑范围明确互不重叠时共用本 worktree；暂存、提交、合并只由主代理
  执行，子代理不得切换分支或更新 `main`。不同会话不得共用任务 worktree。

## 功能完成：验证与提交

- 只运行受影响范围的验证，并报告实际命令与结果；遵循根目录 `AGENTS.MD` 的专题约定：
  - TypeScript 与业务逻辑：运行受影响的 `test/*.test.ts`；类型或公共接口变化时运行
    `npx tsc --noEmit`，跨模块改动按需运行 `npm test`。
  - 原生绑定、CLI/MCP 或发布产物：运行相关 native/MCP 回归；原生加载变化运行
    `npm run test:native`。macOS 本机通过不能代替 Windows x64、Linux、Intel macOS 的 CI。
  - Webview：`npm run build`；界面交互变化按需在 VS Code/Cursor 实际查看。
  - CI 配置（`.github/workflows/**`）：检查 YAML 语法、触发条件和版本 Tag 校验。
  - 打包忽略规则：使用 `npx vsce ls` 检查临时 worktree、缓存等没有进入 VSIX。
  - 仅文档或规则：说明没有应用自动测试，不得虚报通过；检查引用路径、差异和 UTF-8 编码。
- 每完成一个独立功能的新增、修改或修复并通过验证，立即在任务分支提交一次，无需再问；不得
  把多个已完成功能攒到最后一起提交。同一功能的代码、测试、文档放在同一提交。按明确路径暂存，
  提交前检查 staged diff，不夹带无关改动。

## 会话完成：解决冲突并合并到 main

- 本会话工作提交后，自动合并到本地 `main`，无需再问是否合并或是否处理普通冲突。先在任务
  worktree 中合入最新 `main`（`git merge --no-edit <main-commit>`），所有冲突都在任务分支解决，
  不在主目录处理。
- 解决冲突时阅读共同祖先、双方改动、相关调用方和测试，保留双方仍适用的功能意图与接口契约。
  禁止一律取 `ours`/`theirs`、整文件覆盖、删除对方功能，或删测试、放宽断言来制造通过。只有
  无法从仓库和用户要求判断的业务取舍、无法保留的数据或无法排除的破坏风险才停下报告。
- 同步 `main` 或解决冲突改变了交付内容后，按最终变更重新验证；同步前的结果不能当作合并后
  验证。确认没有未解决冲突、任务 worktree 干净，记录已验证的任务提交与对应 `main` 提交。
  验证失败就继续修复，不推进 `main`。
- 所有会话更新 `main` 使用同一把仓库级锁：把 `git rev-parse --git-common-dir` 解析为绝对目录，
  以其中的 `codesearch-main-merge.lock/` 为锁目录，通过原子创建目录取得锁。同一个持续存活的
  进程负责建锁、核对、快进和 `finally` 释放，并在锁内记录该进程 PID、会话标识、时间和任务
  分支。锁已存在则等待重试，不抢占；只有确认原持有进程已结束且没有合并在进行时才能恢复遗留锁，
  不能只因锁的年龄删除。
- 持锁后重新检查 `main` 提交及其 worktree 状态；与已验证基线不同则释放锁，回任务分支重新
  同步、验证后再申请。锁只覆盖最终核对、快进和任务分支删除。
- 在 `git worktree list --porcelain` 确认的 `main` worktree 中执行
  `git merge --ff-only --no-overwrite-ignore <verified-task-commit>`。`main` 未被任何 worktree
  检出时，持锁用只允许快进的 `git fetch . <verified-task-commit>:main` 更新。禁止强制更新 ref、
  `reset --hard`、强制检出。主目录有他人未提交改动时，只允许与其路径不重叠的正常快进；否则
  释放锁等待，不得 stash、覆盖或提交他人工作，也不得绕过保护只改 `main` 指针。
- 合并后确认任务提交已被 `main` 包含，报告任务分支、功能提交、合并后的 `main` 提交、验证结果
  和冲突处理，再做下文清理。
- 命令与路径需同时兼容 macOS、Windows x64 与 Linux：短目录名、正确引用含空格路径；锁用跨平台
  原子目录创建，不依赖仅 Unix 可用的 `flock`。中文文档保持 UTF-8。

## 合并后：自动清理本地临时资源

- 任务分支与 worktree 是本地临时资源：验证并合入 `main` 后自动清理本会话的 worktree 和任务
  分支，无需再问。不自动推送任务分支或设置 upstream，不用 `git push --all`、`--mirror` 或通配
  refspec 间接发布；不改用户全局 Git 配置，不自动删除远端分支。
- 只清理本会话记录的准确分支名与 worktree 路径。先确认本会话进程已结束、worktree 未被占用、
  分支尖端仍是已验证并合并的提交，且 `git merge-base --is-ancestor <branch> main` 退出码为 `0`。
  不按分支名、目录名、年龄或 `git branch --merged` 批量删除其他会话资源。
- 删除 worktree 前用 `git status --short --untracked-files=all --ignored` 检查已跟踪、未跟踪和
  忽略文件（如 `dist/`、`native/`、`native-node/` 构建产物）。只丢弃确认属于本会话的缓存、
  构建产物和测试临时文件；
  未提交成果或用途不明的文件先保全，否则保留 worktree 并报告原因。
- 确认安全后在主 worktree 执行 `git worktree remove <worktree-path>`，再持锁复核分支尖端未变、
  仍被 `main` 包含且未被任何 worktree 检出，执行 `git branch -d <branch>`，最后释放锁。拒绝删除
  时保留分支，不改用 `-D`。
- `git branch -d` 判断「已合并」时比较的是分支的 upstream（若有），否则是**执行命令所在 worktree
  的 HEAD**，而不是 `main`。因此必须在检出 `main` 的 worktree 中执行：
  - `main` 已被某个 worktree 检出：用 `git -C <main-worktree> branch -d <branch>`。
  - `main` 未被任何 worktree 检出：持锁用
    `git worktree add <临时路径> main` 建临时 worktree，在其中执行 `git branch -d <branch>`，再
    `git worktree remove <临时路径>`。临时路径放在仓库之外的会话临时目录或 `.worktrees/` 下，
    用完即删。
  - 不要为此切换主目录当前分支，不要给任务分支设置 upstream，也不要因 `-d` 在其他 HEAD 下
    报「not fully merged」就改用 `-D`：只要显式的 `git merge-base --is-ancestor <branch> main`
    通过，就按上述方式换到检出 `main` 的 worktree 重试。
- 任一步发现未合并提交、引用变化、未提交内容、占用或清理失败，保留剩余资源并如实报告。禁止
  用 `--force`、`git clean -fdx`、递归删除目录或强制删除 ref 绕过保护。以后继续修改从最新
  `main` 新建任务分支。

## 推送与发布范围

- 本地会话自动提交并合并到本地 `main`，不自动 push；只有用户明确要求推送或发布时才操作远端。
- 版本号、CHANGELOG 与发布 Tag 遵循根目录 `AGENTS.MD` 的 Version bump 和 Release documentation
  约定；不引入 `VERSION` 文件，不移动、删除或覆盖已推送 Tag。
- 版本升级也按独立功能自动提交：`npm run version:bump -- X.Y.Z` 默认修改并仅提交三个版本文件，
  不夹带其他暂存内容，并在该版本提交上自动创建附注 Tag `vX.Y.Z`，无需再问。
  显式 `--no-tag` 仅提交不打 Tag；`--no-commit` 仅修改文件。已有同版本且版本文件一致的 Tag
  保持原样；冲突 Tag 不覆盖、不移动，改用新版本。创建本地 Tag 不等于授权推送或发布。
