# A01：DSH 源码与可复现基线

执行者：pi coding assistant；实测日期：2026-11-08（Windows 本地时间，UTC+08:00）。

**状态：DONE（2026-11-09 用户评审通过）。WSL 阻塞已绕开；源码、依赖、完整构建、无 Key Host 冒烟和桌面 GUI 启动都已实测通过，桌面截图见 [desktop-workspace.png](desktop-workspace.png)。桌面启动**不需要任何规避参数**：工作区目录树的低完整性标签已用管理员权限恢复为 Medium，Electron 直接从 `node_modules` 启动通过。定位与修复过程见 [electron-startup-diagnosis.md](electron-startup-diagnosis.md)。** 本记录保留 2026-11-08 的失败历史与中间规避证据，不改写失败。

## 1. 源码、版本与集成方式

| 项目 | 实测结果 |
| --- | --- |
| 开发目录 | `D:/Data/ProjectsRepo/StudyBuddy`，继续使用当前 Windows 文件夹，无需 WSL |
| 操作前扫描 | 根目录只有 `docs/`、`.pi/`；递归未找到 AGENTS；祖先定点规则/仓库检查无命中；`git rev-parse --show-toplevel` 明确返回非 Git 仓库 |
| 源码绝对路径 | `D:/Data/ProjectsRepo/StudyBuddy/source/deepseek-harness` |
| 上游实际 origin | `https://github.com/deepseek-ai/deepseek-harness.git`（fetch/push；未 push） |
| 固定完整 commit | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` |
| 独立工作分支 | `task/A01-source-baseline`，在新 checkout 中创建；无源码改动/本地提交 |
| 版本说明 | 根与桌面包声明 `0.2.2-rc.1`；`git describe --tags --always` 为 `dsh-v0.2.2-rc.1-811-gfcc0ad4621`，**不是**恰好位于该 tag |
| 锁文件 | 保留该提交的 `pnpm-lock.yaml`，安装使用 `--frozen-lockfile`；构建后 Git 工作树仍干净 |
| 旧 StudyBuddy | 官方设计给出的旧 remote 可访问；`ls-remote` 退出 0，HEAD `e23c5e4dfe0dc56352802dc357ca46effd4468ba`。未 clone、读取旧代码或迁移数据，不作为硬前置 |

采用**非 Git 外层项目中的独立上游 checkout**，不是 submodule、不是 SDK 平行业务应用。先确认目标路径不存在，才 clone；没有覆盖已有文档，没有在已有 Git 中盲目嵌套。B01 后续决定发行集成方式；若将外层初始化为 Git，必须明确登记/排除这个独立仓库，不能误把整个上游与运行数据直接加入外层索引。外层任务文档目前没有可提供的本地 Git 提交号。

回退：停止本任务启动的进程，保留本目录证据；若不再采用此布局，先确认 `source/deepseek-harness` 的 status/分支与新增文件，再只移动该新 checkout 归档。不要执行 `git clean`、强制 reset 或删除未知目录；不要清理用户级 pnpm/Electron 缓存。构建与测试输出均为上游忽略文件，不提交到上游。

机器可读 pin、工具版本和 SHA-256 见 [baseline.lock.json](baseline.lock.json)。最终自动核对见 [verification.json](verification.json)：四个文件哈希、固定 commit、上游干净工作树、Host 成功/Desktop 失败一致性与日志令牌脱敏检查全部通过；进程扫描未发现遗留 Electron 或本次 Host/desktop launcher。此检查不改变任务 BLOCKED 状态。其中 `pnpm-lock.yaml` 哈希为 `B6F0946199DB2661E45AC0CEEAD23E6CEEDF148604B48EA9B05A6287A4094BCD`。

## 2. 环境与可复用执行方式

- Windows：`Microsoft Windows NT 10.0.26200.0` / x64；原生 PowerShell `5.1.26100.9711`。
- Git：`2.53.0.windows.1`，`D:/Applications/git/Git/cmd/git.exe`。
- Node：`v26.13.0`，`D:/Applications/nvm/app/v26.13.0/node.exe`；npm `11.20.0`；pnpm `11.28.5`。
- 上游要求 Node `>=24.9.0`、`pnpm@11.28.5`，当前满足。Corepack 未发现，但已安装的 pnpm 版本恰好匹配，未修改全局 Node 或启用全局 Corepack。
- `.pi/settings.json` 启用原生 `powershell` 工具，重载后已真实执行成功；不再使用 WSL `bash`。Windows 执行使用 `pnpm.cmd` / `npm.cmd`，避免依赖 PowerShell 脚本关联。
- 网络：GitHub `ls-remote`/clone、npm 依赖和 Electron/primary-runtime 准备实际成功。未绕过 TLS 检查或供应链校验。
- 磁盘：安装前 D 盘可用约 417.8 GB；本次 checkout、日志、锁定依赖和运行时写入成功。pnpm 自动选择同盘 `D:/.pnpm-store/v11`，没有修改用户配置。

## 3. 许可与已读说明

已完整读取固定提交的根 `AGENTS.md`、`README.md`、`CONTRIBUTING.md`、`SAFETY.md`、`docs/development.md`、`apps/desktop/README.md`（包括截断后的剩余部分）、`apps/cli/README.md`、`apps/cli/reference/README.md`、`packages/boot/app-boot/README.md`、`packages/boot/plugin-manager/README.md`、`packages/host/webserver/README.md`、`packages/client/connection/README.md`、根包/桌面包声明与 workspace 配置。

已读 `LICENSE`：**MIT，Copyright (c) 2026 DeepSeek**；发行副本必须保留版权与许可。已读 `THIRD_PARTY_NOTICES.md`：第三方组件仍按各自条款，不能把完整桌面依赖都称为 MIT。尤其 LibreOffice kit 的 MPL-2.0 对应源码/通知义务、Claude SDK/平台 payload 的单独条款、原生 addon 的 BSD-3-Clause，需发行任务继续审查；本任务没有制作或发布用户安装包。未修改许可证或 notice。

上游仍是 developer preview，未审计；数据目录隔离不是安全沙箱。没有改动任何 Host/Agent/插件源码。

## 4. 可复现命令

以下均为本次实际执行过的命令形式；运行环境是原生 Windows PowerShell。当前已存在 checkout，**不要重复 clone 覆盖它**。只有在一个全新目标路径中重建时执行：

```powershell
git clone --no-checkout https://github.com/deepseek-ai/deepseek-harness.git source/deepseek-harness
git -C source/deepseek-harness checkout -b task/A01-source-baseline fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159
```

当前项目根目录下：

```powershell
Push-Location source/deepseek-harness
pnpm.cmd install --frozen-lockfile --reporter append-only
$env:DSH_GATE_CONCURRENCY = '2'
$env:DSH_GATE_FAIL_FAST = '1'
pnpm.cmd run build
pnpm.cmd --filter @deepseek-ai/dsh-desktop exec install-electron
Pop-Location

$evidence = 'docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A01'
node "$evidence/smoke-host.mjs"
node "$evidence/smoke-desktop.mjs" # 当前机器已知失败，保留失败状态而非当作可用桌面
```

脚本直接调用该提交 `package.json` 声明的 `dsh` 源码 launcher / `pnpm run start:desktop`，没有绕过 profile 启动独立 Host 或另写 Agent。脚本必须随本目录层级保留；复跑会生成全新数据目录并更新结果日志，需保留旧结果时先归档。`start:desktop` 会准备独立的 Node/Python/pnpm payload，首次可能需要数分钟与额外下载，不等于只启动一个轻量 Electron 窗口。

### 实际结果

| 操作 | 退出状态与结果 | 证据 |
| --- | --- | --- |
| GitHub 探测、clone、固定 checkout | 0；origin 与完整 SHA 已核验 | `native-commands.md`、`baseline.lock.json` |
| 安装 | 0；394 workspace，新增 1434 包，约 3m26s；按原 allowBuilds 安装，无脚本权限扩张 | `install.log`（PS 原始 UTF-16）、`install-utf8.log`（同内容转码） |
| 完整 build（包含 aggregate checks） | 0；10 passed / 0 failed / 0 skipped，142.85s；367 client artifacts | `build.log` |
| Electron binary provisioning | 0，锁定 Electron 44.7.0 | `electron-install.log` |
| 最终 Host smoke | **0**；401 → token exchange **303** → HTML **200**，三个实际广告的 combo bundle 均 **200** | `host-result.json`、`host.stdout.log`（令牌已脱敏）、`host.stderr.log`（空） |
| Desktop smoke（最终，2026-11-09 19:09，无规避参数） | **0**；`passed: true`，`electronDistOverride: none`，欢迎页 → 空 Key 校验 →「稍后配置」→ `dsh-app://app/`，`bootInjection` 为真，正文 132 字符，约 115 秒 | `desktop-result.json`、`desktop.stdout.log`、`desktop.stderr.log`、`desktop-workspace.png` |
| Desktop smoke（2026-11-09 03:07，标签规避阶段） | **0**；同一二进制从 `%TEMP%` 副本启动，用于证明"树外可启动" | `archive/desktop-workaround-20261109T030818Z/` |
| Desktop smoke（第一轮，2026-11-08，失败历史） | **1**；primary-runtime/Office 检查通过，但 GUI 在 CDP/窗口出现前退出 | `archive/desktop-failure-20261108T230522Z/` |
| Electron 独立诊断 | Node 模式 0；GUI 模式 `--version` 以 **2147483651 / 0x80000003** 退出，无有用 stderr；第二轮定位为工作区低完整性标签，见诊断记录 | `electron-diagnostic.json`、`electron-startup-diagnosis.md` |
| 禁 GPU 的只读版本诊断 | 同一退出码，未解决问题；未禁用沙箱 | `electron-gpu-diagnostic.json` |
| 冒烟脚本语法检查 | 两个 `node --check` 均 0 | `native-commands.md` |

最终桌面启动命令就是 `node .../smoke-desktop.mjs`（不设任何 Electron 覆盖参数）。中间阶段用过 `A01_ELECTRON_DIST` + [prepare-electron-runtime.ps1](prepare-electron-runtime.ps1) 指向 `%TEMP%` 的同版本副本，证据保留在 `archive/desktop-workaround-20261109T030818Z/`，该脚本继续保留作应急回退。第一轮桌面失败证据完整保留在 `archive/desktop-failure-20261108T230522Z/`。

Host 探针的前两次失败已保留为 `first-host-*`、`second-host-*`：先按 README 期待 302，实测与 `connection/src/browser-auth.ts:279` 是 303；再按旧 README 猜测 `/plugins/connection/client.js` 得到 404，实际模块实现公布 revisioned combo URL。修正的是**本任务探针**，没有修改上游来迎合测试。最终探针从 HTML 提取真实资源 URL，未硬编码猜测接口。

Host 测完后由脚本终止本次拥有的进程，退出记录为 SIGTERM；Windows 下这是 TerminateProcess，**不是优雅退出验收**。Desktop 崩溃前未进入 UI，未生成截图，也未执行“稍后配置”动作；脚本中的后续 UI 步骤不代表已运行。未跑全量单测、真实模型调用、安装器或升级测试。

## 5. 配置、无 Key 与数据隔离

本次脚本删除子进程继承环境中的 `DSH_*` 及 Key/token/secret/password/credential/auth 变量；不打印环境值。存在源码 `.env` 时拒绝启动，避免读取用户模型凭据。无 API Key 输入、不提交模型任务，`modelRequestsSubmitted: 0` 只表示本探针没有发起模型任务，不宣称做了网络抓包。

注意 `ELECTRON_RUN_AS_NODE`：本会话（DSH 桌面宿主）会把它带进子进程，此时 `electron.exe --version` 会以 Node 模式运行并打印 `v24.21.0`，看起来"通过"但完全没走 GUI 初始化。手工复核桌面问题必须先删除该变量；两个冒烟脚本按 `/^ELECTRON_/` 清理子进程环境，不受影响。

每次运行使用全新的：

```text
source/deepseek-harness/apps/desktop/.desktop-build/a01/host-<timestamp>/
  home/                 DSH_HOME
  agents/               DSH_AGENTS_HOME
source/deepseek-harness/apps/desktop/.desktop-build/a01/desktop-<timestamp>/
  home/                 DSH_HOME
  agents/               DSH_AGENTS_HOME
  electron-user-data/   DSH_DESKTOP_USER_DATA_DIR
```

确切本次路径在结果 JSON；不使用用户 `~/.dsh`、`~/.agents` 或普通 Electron userData。`DSH_HOME` **不会**自动隔离 Electron userData，两个必须分别指定。临时浏览器 cookie/token 只在探针内存中交换，URL 写日志前脱敏。Host 自动生成的测试认证记录在临时 home 的 `.credentials.yaml` 内，**不读取、不复制到证据、不导出**。数据目录受上游 `.gitignore` 的 `apps/desktop/.desktop-build/` 规则保护；如果以后用外层 Git，需要继续排除。

`smoke.cordis.patch.yml` 关闭 session-log-deepseek、session-telemetry-otel、desktop-product-telemetry、product-analytics；子进程另设 `DSH_TELEMETRY_DISABLED=1`、`DSH_TELEMETRY_MODE=DISABLED`。Host 使用 `--patch`，Desktop 只在新临时 home 写入该 patch，不改用户 profile。没有配置上游更新服务或发起安装/更新；GUI 未启动，不宣称验证了桌面更新禁用。

Primary runtime 已准备于 `apps/desktop/.desktop-build/targets/win-x64/runtime/primary-runtime`，下载缓存由 `desktop-build-paths.mjs` 定位到 `.desktop-build/downloads`。其 manifest 记录 Python 3.12.14 / Node 24.21.0 / pnpm 11.28.5；Electron 自带 Node 同为 24.21.0，与构建用 Node 26.13.0 不同。不要用别的 OS 的 node_modules 或随意替换 Electron 版本后沿用这个基线声明。

## 6. 真实源码索引与下游交接

以下路径均相对 `source/deepseek-harness`；标为索引不表示这些能力已验证。

| 消费者 | 文件/目录 |
| --- | --- |
| 所有会话规则 | 根 `AGENTS.md`；改 packages 前读 `packages/AGENTS.md`、`docs/architecture.md`；子目录规则按实际位置读取 |
| 安装/构建 | `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`docs/development.md`、`scripts/build.ts` |
| A02 桌面/启动 | `apps/desktop/README.md`、`apps/desktop/scripts/dev.ts`、`apps/desktop/scripts/desktop-build-paths.mjs`、`apps/desktop/src/`、`apps/desktop-host/` |
| A02 插件/前端 | `packages/boot/plugin-manager/README.md`、`packages/boot/app-boot/README.md`、`packages/client/ui-plugin-manager/`、`packages/client/modules/`、`apps/web/` |
| 真实默认 composition | `packages/bundle/base/cordis.patch.yml`、`packages/bundle/web-app/cordis.patch.yml` 与 `presets/`；不是设计里假设的 `cordis.yml` |
| Host/API/认证 | `apps/cli/src/bin.ts`、`apps/cli/reference/README.md`、`packages/host/webserver/`、`packages/client/connection/`、`packages/api/` |
| A03 记忆接入 | 先读上述 profile/plugin-manager；外部候选 `https://github.com/RestRegular/dsh-memory` 尚未下载/锁版/验证，不把设计里的 0.30.1 当成已装依赖 |
| A04 Creator/权限 | `packages/experimental/creation-recommendations/`、`packages/experimental/client-ui-creation-recommendations/`、`packages/boot/plugin-manager/`；未做生成或沙箱探针 |
| SDK（仅索引） | `packages/sdk/client/README.md`、`packages/sdk/server/README.md`、`packages/sdk/protocol/README.md`；不据此改走 SDK 独立应用 |

**A01 已 DONE**（2026-11-09 用户评审通过），A02/A03/A04 的硬前置解除：A02 优先恢复；A03/A04 各自创建独立 home/agents/userData，不共享本次临时数据，也不直接安装外部原生插件到用户 profile。若工作区完整性标签再次被外部工具改回 Low，A02 的桌面复测会以 `0x80000003` 失败，届时按第 7 节修复或临时使用 `A01_ELECTRON_DIST`。

## 7. 桌面启动阻塞：已定位并修复

第一轮记录的现象是 Electron 44.7.0 GUI 早退（`2147483651 / 0x80000003`，另见 `0xC0000005`）。第二轮定位：**同一份 SHA-256 二进制在工作区目录树内 GUI 崩溃、复制到树外即正常**，崩溃发生在 `main.js` 第一行之前。工作区树继承了 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，是早期低完整性沙箱工具留下的状态（ACL 中还残留 `CodexSandboxUsers` 与未知 SID）。已排除：二进制损坏（缓存 zip SHA-256 与官方 `SHASUMS256.txt` 一致）、Electron 版本不兼容（同版本打包应用 GUI 正常）、agent 沙箱/Job（Task Scheduler 干净环境同样崩溃）、DACL（复制到树外后正常）、路径字符串（junction 指向树内仍崩溃）、`ELECTRON_RUN_AS_NODE`（清理后仍崩溃）。完整实验矩阵见 [electron-startup-diagnosis.md](electron-startup-diagnosis.md)。

修复（2026-11-09 19:05，经 UAC 管理员授权；非管理员进程没有 `SeRelabelPrivilege`，无法上调标签）：

```powershell
# 根目录恢复为可继承的 Medium，并修复关键子树
icacls 'D:\Data\ProjectsRepo\StudyBuddy' /setintegritylevel '(OI)(CI)M' /Q
icacls 'D:\Data\ProjectsRepo\StudyBuddy\source\deepseek-harness\node_modules\.pnpm\electron@44.7.0_supports-color@9.4.0\node_modules\electron' /setintegritylevel '(OI)(CI)M' /T /C /Q
# 以及 source、source\deepseek-harness、node_modules、node_modules\.pnpm、electron@...、apps\desktop\.desktop-build
```

修复后实测：仓库内 `node_modules` 的 `electron.exe` 直接 GUI 启动退出 0；不设任何 `ELECTRON_OVERRIDE_DIST_PATH` 重跑 `smoke-desktop.mjs` → 0，`electronDistOverride: "none (node_modules dist)"`，截图更新为本次结果。

注意事项：`icacls /T` 会跟随 pnpm 的嵌套 `node_modules` 软链，产生大量"系统找不到指定的路径"错误（长路径/软链回环），属噪声；关键路径已逐一核对为 Medium。若以后重新安装依赖或重建 checkout 后发现 GUI 又崩，先检查 `...\electron\dist\electron.exe` 的完整性标签是否又变成 Low，再决定是否重跑上述命令或改用 `A01_ELECTRON_DIST` 回退。

仍然成立的限制：桌面会话以 `taskkill /F` 结束，**不是优雅退出验收**；没有真实模型调用、安装包或升级验证；临时数据根在 `.desktop-build/a01/`，未触碰用户 `~/.dsh`。没有修改业务接口、数据库迁移、Agent 循环或公共依赖锁文件，也没有向上游提交补丁。

## 8. 证据索引

| 文件 | 用途 |
| --- | --- |
| `baseline.md` | 本记录：环境、结果、隔离方式、源码索引、阻塞定位 |
| `baseline.lock.json` / `verification.json` | 机器可读 pin、SHA-256、结果与自动核对 |
| `electron-startup-diagnosis.md` | 第二轮 GUI 崩溃的排除项、位置矩阵与处置 |
| `prepare-electron-runtime.ps1` | 生成普通完整性位置的同版本 Electron 副本并校验 SHA-256 |
| `smoke-host.mjs` / `smoke-desktop.mjs` / `smoke.cordis.patch.yml` | 两个无 Key 冒烟探针与临时 profile overlay |
| `install.log` / `install-utf8.log` / `build.log` / `electron-install.log` | 安装、构建（10/10 gates）、Electron provisioning 原始输出 |
| `host-result.json` / `host.stdout.log` / `host.stderr.log` | 最终 Host 冒烟（401 → 303 → 200，3 个 bundle 200） |
| `first-host-*` / `second-host-*` | 探针最初两次失败，保留不删 |
| `desktop-result.json` / `desktop.stdout.log` / `desktop.stderr.log` / `desktop-workspace.png` | 第二轮桌面冒烟通过：结果、日志与工作区截图 |
| `archive/desktop-failure-20261108T230522Z/` | 第一轮桌面失败的结果与日志（未删除） |
| `electron-diagnostic.json` / `electron-gpu-diagnostic.json` / `diagnose-electron.mjs` / `electron-matrix.json` | 第一轮 Electron 退出码诊断（Node 模式 vs GUI、路径/环境矩阵、禁 GPU） |
| `electron-symbols.json` / `electron-symbolized.json` / `fetch-electron-symbols.mjs` | 第一轮符号化尝试；只从导出符号猜到名字，**不是**可靠调用栈，不作为根因证据 |
| `electron-native-trace*`（3 个空目录） | ETW/native trace 抓取尝试，没有产生输出 |
| `DesktopProbe.cs` / `desktop-api-probe.log` | WinSta0/默认桌面句柄与 `CreateDesktop` 探测（均成功，排除桌面权限） |
| `TraceElectron.cs` | 上一轮的原生跟踪脚本，未产出可用堆栈 |
| `chromium-*.cc`（sandbox / broker_services / window / alternate_desktop 等） | 上游 Chromium 源码只读副本，用于核对崩溃点语义；不是构建产物，也不修改上游 |
| `native-commands.md` / `commands.log` | 本轮实际命令；`commands.log` 保留首轮 WSL 阶段记录 |
| `baseline-wsl-blocked.md` | 首轮 WSL 阻塞历史记录 |
