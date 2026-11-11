# A01：取得 DSH 源码并建立可复现基线

大任务：A / 技术路线验证  
直接前置：无  
状态：DONE

## 目标与必读

让后续会话基于同一份真实源码和执行环境工作，而非根据调研文档猜测接口。先读上一级 README、EXECUTION、DEPENDENCIES 和设计文档。领取时只确认设计可读，Bash/WSL 无法启动；现已按用户要求切换原生 PowerShell，取得并构建固定 DSH 源码。第二轮已定位 Electron GUI 早退原因（工作区目录树残留低完整性标签）并取得桌面启动证据；第三轮用管理员权限修复该标签后，不设任何规避参数重跑桌面冒烟通过。2026-11-09 用户评审通过，状态 DONE。详见交付记录与 [`electron-startup-diagnosis.md`](evidence/A01/electron-startup-diagnosis.md)。

## 范围与输入

负责环境、源码获取、版本/许可登记、最小启动。优先检查现有仓库和用户文件，不覆盖、不清理未知目录。旧 StudyBuddy 源码只记录能否取得，不以旧代码/数据迁移作为本任务硬条件。不开始业务开发，不改 Agent 循环。

产物放本目录的 `evidence/A01/`；源码放置位置经检查后决定，登记确切路径、上游 remote、tag/commit、包管理器与运行时版本。不得伪造网络访问或 checkout 结果。

## 实施步骤

1. 查阅实际工作区规则，确认操作系统、可用终端、Git、磁盘写入与网络情况；优先解决/绕开已报告的 WSL 错误，并记录可复用的执行方式。
2. 检查已有源码/Git；没有时从设计文档中的官方 DSH 来源取得源码，避免在已有 Git 中盲目嵌套或覆盖。记录选择的仓库集成方式与可回退步骤。
3. 读取该提交的桌面、插件、开发与许可说明；按真实指令安装依赖并运行最小桌面/Host 冒烟。
4. 固定 DSH commit 与依赖锁文件，记录配置、独立数据根和无真实 Key 的测试配置方式。
5. 生成 `evidence/A01/baseline.md`，列实际文件索引、环境命令、失败和后续可使用的基线。

## 验收

- 源码路径、commit、依赖工具与来源许可可追溯，下一会话能复现启动。
- 最小启动有实际命令、退出状态/日志；不能启动时状态为 BLOCKED，而不是“文档已写所以完成”。
- 用户已有数据未被迁移/覆盖；凭据不进入证据日志。
- A02/A03/A04 明确知道去哪里读源码、如何运行和如何隔离测试数据。

## 交付记录（执行时填写）

### 第一轮：2026-11-08（BLOCKED，作为历史保留）

- 执行者/会话：pi coding assistant / 本次 A01 会话；实测 2026-11-08；阶段 S0，仅执行 A01。
- 实际基线与依赖提交：当前项目 `D:/Data/ProjectsRepo/StudyBuddy`；官方源码 `source/deepseek-harness/`；commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`；独立分支 `task/A01-source-baseline`，上游工作树干净。无直接前置。
- 改动文件与提交：本任务、项目级 `.pi/settings.json`、本目录 [`evidence/A01/`](evidence/A01/baseline.md) 下的基线/锁定清单/冒烟脚本/脱敏日志；新增独立官方 checkout，没有修改上游源码或创建本地提交。外层项目不是 Git 仓库，发行集成由 B01 后续明确。
- 实现/验证结论：原生 PowerShell 已实际可用，GitHub/依赖下载成功；安装和完整构建通过，无 Key Host 可启动。Electron GUI 早退，未出现桌面窗口，故当时保持 BLOCKED，不把 Host 或构建成功冒充桌面完成。
- 测试命令、结果与证据位置：`pnpm install --frozen-lockfile --reporter append-only` → 0；`pnpm run build` → 0（10/10 gates）；Electron provisioning → 0；`node .../smoke-host.mjs` → 0（401/303/200、三个实际插件资源 200）；`node .../smoke-desktop.mjs` → 1。完整命令见 [`native-commands.md`](evidence/A01/native-commands.md)，日志与结果 JSON 见 [`baseline.md`](evidence/A01/baseline.md)。探针最初两次断言错误及早期 WSL 失败另保留，未删除失败证据。
- 公共接口/迁移/配置变更：无公共接口、迁移、上游依赖或锁文件改动。`.pi/settings.json` 已启用并实测原生 PowerShell；仅在全新临时数据根配置禁用遥测/会话上传的冒烟 overlay。未读取真实凭据、提交模型任务、迁移或覆盖用户数据；测试 cookie/token 不写入证据。
- 配置/许可/来源：官方 origin `https://github.com/deepseek-ai/deepseek-harness.git`；根/桌面包 `0.2.2-rc.1`，不冒称位于 release tag；MIT / Copyright (c) 2026 DeepSeek，第三方许可见上游 `THIRD_PARTY_NOTICES.md`。Node 26.13.0、pnpm 11.28.5、Electron 44.7.0；完整 pin/hash 见 [`baseline.lock.json`](evidence/A01/baseline.lock.json)。
- 当时限制与阻塞：Desktop primary-runtime/Office 检查通过，但 Electron GUI 退出 `2147483651 (0x80000003)`；独立 `electron --version` 也失败，Node 模式 0，禁 GPU 版本诊断无改善；当时未确定根因、未取得崩溃堆栈。没有禁用安全策略或沙箱，没有改 Agent 循环。
- 评审/集成确认：未进行；不标记 REVIEW/DONE。

### 第二轮：2026-11-09（解除阻塞，提交 REVIEW）

- 执行者/会话：DeepSeek Harness 会话；实测 2026-11-09 03:07–03:08（UTC+08:00）；阶段 S0，仅继续 A01，未开始业务开发。
- 触发原因：复核时发现两件事——(1) 本会话继承 `ELECTRON_RUN_AS_NODE=1`，直接跑 `electron --version` 会假通过（打印 Node 版本 `v24.21.0`）；(2) 证据目录有一批未登记的诊断产物，记录仍停留在 BLOCKED。二者都不能作为桌面可用的证据。
- 定位结论：同一份 SHA-256（`2529B494…D1BA8`）的 `electron.exe` 在工作区目录树内 GUI 启动崩溃（`0x80000003` / `0xC0000005`，均早于 `main.js` 第一行），复制到工作区外即正常；崩溃不随路径字符串、工作目录、启动器（Task Scheduler 干净环境）、DACL 或 `ELECTRON_RUN_AS_NODE` 变化，只跟随目标物理目录。唯一相关差异是工作区树（含 `source/deepseek-harness`）继承了 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，属于早期低完整性沙箱工具（ACL 内残留 `CodexSandboxUsers` 等）留下的状态。**不是 Electron 版本、二进制损坏、操作系统或 GPU 问题**：同一版本打包应用在本机 GUI 正常，npm 缓存 zip 的 SHA-256 与官方 `SHASUMS256.txt` 一致。完整证据见 [`electron-startup-diagnosis.md`](evidence/A01/electron-startup-diagnosis.md)。
- 处置：新增 [`prepare-electron-runtime.ps1`](evidence/A01/prepare-electron-runtime.ps1)，把同一份 dist 复制到 `%TEMP%\a01-electron-runtime` 并校验 SHA-256；`smoke-desktop.mjs` 读取 `A01_ELECTRON_DIST` 后设置 `ELECTRON_OVERRIDE_DIST_PATH`（版本仍为 44.7.0，未改 `package.json`、锁文件或上游源码）。根治需要提升权限把工作区树的完整性标签恢复为 Medium，本会话没有 UAC，留给用户执行。
- 实际结果：`$env:A01_ELECTRON_DIST=…; node .../smoke-desktop.mjs` → 退出 0，`passed: true`；实际走完欢迎页 →「添加 API Key」空输入校验 →「稍后配置」→ `dsh-app://app/`；`bootInjection: true`，标题「DSH 本地构建」，正文 132 字符，截图 [`desktop-workspace.png`](evidence/A01/desktop-workspace.png)（114 KB）。耗时约 53 秒。
- 证据归档：第一轮桌面失败结果已移到 `evidence/A01/archive/desktop-failure-20261108T230522Z/`，未删除；本轮生成 `desktop-result.json`、`desktop.stdout.log`、`desktop.stderr.log`、`desktop-workspace.png`。`stderr` 中 Electron 的 `mandatory-status` 未注册 handler 与 CSP 安全提示是上游开发态噪声，脚本已按原样保留、未改写。
- 未验收项（不冒充）：没有做优雅退出验收（脚本用 `taskkill /F` 结束自有进程，launcher 记录退出 1）；没有真实模型调用（`modelRequestsSubmitted: 0`）、没有安装包/升级验证。本轮桌面运行依赖完整性标签规避手段，属于**环境未修复状态下的可复现启动**；第三轮已修复该标签并去掉规避参数。
- 记录修正：把文档中的 `pnpm.cmd` 改为当前实际可用的 `pnpm`（本机只有 `pnpm.exe`，`pnpm.cmd` 已不可解析）；为上一轮遗留的诊断产物补了索引（见 `baseline.md` 第 8 节）；补充了 `ELECTRON_RUN_AS_NODE` 假阳性说明。
- 公共接口/迁移/配置变更：无公共接口、迁移、上游依赖或锁文件改动；新增的是证据脚本与本任务文档。A01 期间的数据目录仍是 `.desktop-build/a01/` 下的临时间目录，未使用用户 `~/.dsh`。
- 评审/集成确认：已提交 REVIEW，等待评审与集成确认；不标记 DONE。解除 A02/A03/A04 阻塞仍需评审通过，且建议先完成工作区完整性标签的根治。

### 第三轮：2026-11-09 晚（管理员修复完整性标签，去掉规避参数）

- 执行者/会话：DeepSeek Harness 会话；实测 2026-11-09 19:05–19:11（UTC+08:00）；阶段 S0，仍只做 A01。
- 触发：用户同意经 UAC 提权执行根因修复（普通进程没有 `SeRelabelPrivilege`，无法上调完整性标签）。
- 操作：把 `D:\Data\ProjectsRepo\StudyBuddy` 根目录恢复为可继承的 Medium 标签，并对关键子树（`source`、`source\deepseek-harness`、`node_modules`、`node_modules\.pnpm`、`electron@44.7.0_supports-color@9.4.0`、`electron\dist`、`apps\desktop\.desktop-build`）执行同样的恢复。第一次尝试对整棵树 `icacls /T` 时，pnpm 嵌套 `node_modules` 软链导致大量"系统找不到指定的路径"错误且耗时过长，改为按关键路径逐项恢复。
- 实际结果：`electron.exe` 标签从 `Low (I)(NW)` 变为 `Medium (I)(NW)`；仓库内 Electron GUI 探针退出 0；`node .../smoke-desktop.mjs` **不设 `A01_ELECTRON_DIST`** → 退出 0，`passed: true`，`electronDistOverride: "none (node_modules dist)"`，走完欢迎页 → 空 Key → `dsh-app://app/`，`bootInjection: true`，截图更新，约 115 秒。
- 证据：最终 `desktop-result.json`、`desktop.stdout.log`、`desktop.stderr.log`、`desktop-workspace.png`；中间规避阶段的通过结果归档在 `archive/desktop-workaround-20261109T030818Z/`；第一轮失败仍在 `archive/desktop-failure-20261108T230522Z/`。
- 残留：桌面会话仍以 `taskkill /F` 结束（非优雅退出验收）；未做真实模型调用、安装包、升级验证；`docs/` 与部分深层 `node_modules` 文件可能仍是 Low 标签（不影响执行，因为不从中启动 GUI），重新安装依赖后需复查 `electron.exe` 标签。
- 评审/集成确认：2026-11-09 19:16 用户评审通过（确认四项验收：可追溯源码、真实启动证据、未动用户数据、下游指引），A01 标记 **DONE**；A02/A03/A04 的硬前置解除，A02 优先。
