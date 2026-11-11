# A01 首轮源码与执行环境核验记录（历史）

> 已被 [当前基线](baseline.md) 替代。以下为原生终端重载前的历史记录，不代表当前源码或环境状态。

状态：**BLOCKED — 尚未建立可运行 DSH 基线，不满足 A01 验收。**

执行者：pi coding assistant / 本次 A01 会话。工作目录由工具上下文给出：`D:/Data/ProjectsRepo/StudyBuddy`。未取得系统时间、OS 版本或会话 ID；计划日期不是实测执行日期。

## 1. 已取得的事实

- 已读取计划、执行规则、依赖、交付阶段及完整设计；当前属于 S0，仅执行 A01，不开发业务、不修改 Host/Agent 循环。
- 首轮两次 `functions.bash` 调用均退出 1：WSL 发行版磁盘挂载失败后只读回退，随后 `execvpe(/bin/bash)` 报不存在。命令尚未执行，因此不是 Git/网络/DSH 自身失败。
- 通过同一工具调用 `powershell.exe` 不能绕开外层 WSL。当前没有可直接调用的替代终端工具；未确认可复用的成功执行方式。
- 文件 `read/edit/write` 工具可用：任务文件修改和本目录证据写入成功；这只证明这些路径可写，不证明 WSL 磁盘或整个工作区可写。
- 未执行网络请求，不能声称网络可达或不可达。未访问凭据文件，未调用付费模型，未迁移或覆盖用户数据。

实际命令、超时参数、错误和退出状态见 [commands.log](commands.log)。错误中的恢复链接为 WSL 返回内容：<https://aka.ms/wsldiskmountrecovery>。未尝试修复磁盘、注销发行版或其他可能影响用户数据的系统操作。

## 2. 实际文件索引与定点读取

以下路径相对 `D:/Data/ProjectsRepo/StudyBuddy`，除非另有绝对路径。`ENOENT` 只表示该次指定路径读取未找到，不能代替递归目录扫描。

### 成功读取的依据

| 路径 | 用途 |
| --- | --- |
| `docs/superpowers/plans/2026-11-08-studybuddy-implementation/README.md` | DSH 主体、插件业务、S0 关键路径 |
| 同目录 `EXECUTION.md` | 分支隔离、状态、验收与交接规则 |
| 同目录 `DEPENDENCIES.md` | A02/A03/A04 均硬依赖 A01 |
| 同目录 `RELEASES.md` | S0 不等待记忆与 Creator |
| 同目录 `00-discovery/A01-source-baseline.md` | 本任务范围与完成条件 |
| `docs/superpowers/specs/2026-11-08-studybuddy-redesign-design.md` | 官方 DSH 来源、数据隔离与架构约束 |

### 返回 ENOENT 的定点读取

- 工作区：`AGENTS.md`、`README.md`、`package.json`、`.git`、`.git/HEAD`、`apps/desktop/README.md`。
- 祖先规则文件：`D:/Data/ProjectsRepo/AGENTS.md`、`D:/Data/AGENTS.md`、`D:/AGENTS.md`。
- 祖先 Git 标记：`D:/Data/ProjectsRepo/.git/HEAD`、`D:/Data/.git/HEAD`、`D:/.git/HEAD`。未完整排查祖先 `.git` 文件形式的 worktree 指针。
- 本目录 `baseline.md` 在首次创建前返回 ENOENT。

没有成功扫描整个目录树，不能据此断言不存在其他源码目录、Git 元数据、嵌套规则或旧 StudyBuddy 文件。因终端阻断，未建立独立分支/worktree；隔离要求尚不满足，不应安排其他会话同时写此工作目录。

## 3. 来源、版本与许可登记

| 项目 | 当前结果 |
| --- | --- |
| DSH 官方候选来源 | `https://github.com/deepseek-ai/deepseek-harness`，来自设计文档 S1/S2；本会话未联网核验 |
| 实际源码路径 / remote | 尚未取得、尚未决定；不能把文档链接当作已配置 remote |
| DSH tag / commit | 未取得；不得使用浮动 master 作为已锁定基线 |
| DSH 许可 | 未读取该提交的 LICENSE/NOTICE，未知；不能套用记忆插件的 MIT 声明 |
| Node / 包管理器 / Electron 版本 | 未实测；待读取固定提交的 engines、packageManager、桌面说明与锁文件 |
| 依赖锁文件及哈希 | 未取得、未生成；不得自行重建锁文件冒充上游基线 |
| 旧 StudyBuddy | 设计给出 `https://github.com/thaokas/StudyBuddy`；本会话未取得源码，不判断其可复用性；不是 A01 硬阻塞 |
| 集成方式与回退 | 未作源码布局决定、未 clone/checkout、无源码集成需要回退；本次只新增证据并更新 A01 任务记录 |

不得现在向未知目录 clone 或覆盖文件。恢复后先检查工作区/祖先仓库、已有用户文件和嵌套 AGENTS，再选择独立分支/worktree 与源码布局，记录完整路径。若采用独立上游 checkout，必须明确与 StudyBuddy 仓库的关系、固定 commit 及重建方式；不能留下未登记的嵌套仓库。回退只处理可确认属于本任务的新文件，不使用清理未知目录的命令。

## 4. 启动、配置与独立数据根

- 安装、构建、桌面/Host 冒烟均**未执行**；没有 DSH 进程退出码、启动日志或健康检查结果。
- 未取得真实桌面/插件/开发说明，因此没有可承诺的 DSH 启动命令、profile 参数、数据根环境变量或配置结构。
- 尚未创建测试数据根。恢复后应在用户数据目录之外创建全新 A01 测试目录，记录绝对路径，并从该提交代码验证 Host、桌面、插件各自的数据位置均受隔离配置控制。禁止复用用户原有 DSH global/profile。
- 无 Key 冒烟应使用空模型配置或该提交真实支持的 fake model；禁止填写真实 Key、擅自调用模型，或虚构支持的配置参数。若无 Key 无法启动，保留实际错误并登记阻塞。
- 源码取得后必须读该提交的根 README、桌面 README、插件/Host 开发说明、LICENSE/NOTICE、包声明和锁文件；设计中的路径只是查找线索，不是本会话已验证源码索引。

## 5. 恢复步骤（待执行，不是已验证命令）

优先给本会话提供能直接执行的原生终端，或由用户在备份相关数据后按官方指导处理 WSL。不要在当前 `functions.bash` 命令里继续嵌套 PowerShell；外层启动失败时无法生效。

可先在**独立可工作的 Windows PowerShell** 中运行以下只读检查；它们不会自动修复当前代理执行工具，结果仍需在恢复后的代理通道重验：

```powershell
$PSVersionTable.PSVersion
[System.Environment]::OSVersion.VersionString
Get-Command git,node,corepack,pnpm,bash -ErrorAction SilentlyContinue |
  Select-Object Name,Source
Get-ChildItem -Force 'D:\Data\ProjectsRepo\StudyBuddy'
git -C 'D:\Data\ProjectsRepo\StudyBuddy' rev-parse --show-toplevel
```

随后由恢复会话依次完成：

1. 实测终端、Git、可写临时目录与网络；检查仓库状态、规则文件和已有源码，建立独立分支/worktree。只记录工具版本和必要路径，不转储所有环境变量。
2. 从已有 checkout 或官方来源取得源码，登记实际 remote（脱敏）、tag/完整 commit、许可与来源；明确仓库集成及回退方式。
3. 读取固定提交的真实说明，按其 runtime/packageManager 要求安装，保留并核验原锁文件。不要照本记录猜测 `pnpm` 或 npm 脚本。
4. 验证隔离数据根与无 Key 配置，再执行最小桌面/Host 冒烟，保存实际命令、日志、退出状态/停止方式和健康结果；不把只启动了开发服务器视为桌面已可用。
5. 补齐可复现启动步骤与源码索引，回填 A01，提交评审/集成确认后再解除依赖阻塞。

## 6. 验收与交接

| A01 验收项 | 结果 |
| --- | --- |
| 源码路径、commit、工具版本与许可可追溯 | 未通过：尚未取得源码或版本 |
| 最小启动及真实日志 | 未通过：外层终端启动失败，不能运行 DSH |
| 不覆盖数据、不泄露凭据 | 本次仅写任务记录/证据，未接触用户数据与凭据；运行时隔离仍待验证 |
| A02/A03/A04 可复用基线 | 未通过：没有可运行基线，不能据此开工 |

A02/A03/A04 均继续受 A01 阻塞，不能把这份失败记录当作前置通过。恢复后 A02 优先使用同一固定 DSH checkout 验证桌面/插件；A03/A04 使用各自独立测试数据根，不默认安装候选插件。若读取探针任务说明可以提前准备，但不得宣称已具备接口或运行证据。

公共接口、依赖、锁文件、DSH 配置与许可证文件均未修改。评审/集成确认未进行，无提交号。解除阻塞的必要条件是可工作的代理执行通道、真实源码/锁定版本以及最小启动证据，而不是文档写完。

## 7. 后续：按用户要求切换原生 Windows 工具

用户明确要求在当前项目文件夹开发，可以不使用 WSL。工作目录保持 `D:/Data/ProjectsRepo/StudyBuddy`，不迁移到 WSL。第三次 bash 工具复测仍在外层启动失败，退出 1，见 `commands.log`。

已完整阅读本机 Pi 1.5.0 的 `README.md`、`docs/windows.md`、`docs/settings.md`、`docs/configuration.md`、`docs/shell-aliases.md`、`docs/cli.md` 和 `docs/security.md`，确认原生 Windows 支持独立 `powershell` 工具，不需要通过 Bash 间接调用。

新增项目级 `.pi/settings.json`（创建前读取返回 ENOENT）：

```json
{
  "$schema": "https://pi.dev/schemas/settings.schema.json",
  "defaultTools": ["-bash", "+powershell"]
}
```

该配置只改变本项目的工具选择，不修改全局配置、模型凭据或 WSL。当前已声明的工具中仍没有 powershell；**必须先由用户执行 `/reload`，或在当前目录重启 Pi**，并在提示时确认信任本项目配置。按 Pi 文档，`/reload` 可启用新增工具，但不一定移除本轮已加载的 bash；后续不再使用该 bash 工具。若启动参数显式限定了工具，需退出后在 Windows 原生终端执行：

```powershell
Set-Location 'D:\Data\ProjectsRepo\StudyBuddy'
pi --continue --tools read,powershell,edit,write
```

原生 PowerShell 的发现和启动尚未实测；不把配置写入当作环境恢复成功。重新加载后先执行无副作用检查（系统/PowerShell 版本、位置、Git/Node 可用性、目录和规则扫描），再继续源码获取、版本与许可固定和隔离启动。A01 暂保持 BLOCKED。
