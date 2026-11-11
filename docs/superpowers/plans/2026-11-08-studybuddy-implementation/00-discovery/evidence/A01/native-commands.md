# A01 原生 Windows 执行记录

日期：2026-11-08；执行工具 `functions.powershell`，工作目录 `D:/Data/ProjectsRepo/StudyBuddy`。以下只记录实际执行内容；文件读取用 `read` 工具，不以终端转储凭据。首轮 WSL 失败记录仍在 `commands.log`。

## 1. 环境/仓库发现

```powershell
$PSVersionTable.PSVersion.ToString()
[Environment]::OSVersion.VersionString
Get-Date -Format o
Get-Location
Get-Command git,node,npm,corepack,pnpm -ErrorAction SilentlyContinue
Get-ChildItem -Force
Get-ChildItem -Force -Path . -Filter '*AGENTS*' -Recurse
git rev-parse --show-toplevel
git status --short
```

结果：PowerShell 5.1.26100.9711，Windows 10.0.26200.0；位置为当前项目；根目录仅 `.pi/` 和 `docs/`。最后两条 Git 命令返回 `fatal: not a git repository`，该工具调用退出 1。不是扫描或终端启动失败。

另执行：

```powershell
git --version
node --version
npm.cmd --version
pnpm.cmd --version
Get-ChildItem -Force -Path D:\,D:\Data,D:\Data\ProjectsRepo |
  Where-Object { $_.Name -in @('AGENTS.md','AGENTS.override.md','CLAUDE.md','.git') }
git ls-remote https://github.com/deepseek-ai/deepseek-harness.git HEAD
```

结果：Git 2.53.0.windows.1 / Node v26.13.0 / npm 11.20.0 / pnpm 11.28.5；祖先检查无命中；remote HEAD `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，退出 0。

## 2. 源码获取与固定

先用 `Test-Path` 拒绝覆盖已有目标，执行：

```powershell
git clone --no-checkout https://github.com/deepseek-ai/deepseek-harness.git source/deepseek-harness
git -C source/deepseek-harness checkout -b task/A01-source-baseline fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159
git -C source/deepseek-harness status --short
git -C source/deepseek-harness remote -v
Get-ChildItem -Force source/deepseek-harness
Get-ChildItem source/deepseek-harness -Filter AGENTS.md -Recurse
```

结果：clone 与 checkout 均 0；创建分支，status 空；remote 为官方 HTTPS URL。读取根规则后仅安装和运行，不修改上游代码。

## 3. 安装/构建

在上游根目录执行：

```powershell
pnpm install --frozen-lockfile --reporter append-only
$env:DSH_GATE_CONCURRENCY='2'
$env:DSH_GATE_FAIL_FAST='1'
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop exec install-electron
```

注：2026-11-08 首轮实际执行的是 `pnpm.cmd <命令>`（当时 PATH 里有 `pnpm.cmd`）；2026-11-09 复核时该机只剩 `D:\Applications\nvm\.nodejs\pnpm.exe`，`pnpm.cmd` 已无法解析，因此文档统一改为 `pnpm`，版本仍为 11.28.5。

均退出 0。安装通过 PowerShell `*> install.log` 保存（UTF-16LE），后用 Node 按 UTF-16LE 解码转存 `install-utf8.log`，没有改写原始文件。build 和 Electron provisioning 使用 `cmd.exe /d /c "<command> > <absolute-log-path> 2>&1"` 保存原生输出，分别输出 `BUILD_EXIT=0`、`ELECTRON_INSTALL_EXIT=0`。

完整 build 实际结果见 `build.log`（10/10 通过，包含 Host/Client aggregate checks），不需要再把未跑的单测计入成功项。

## 4. Host/Desktop 冒烟

在项目根目录执行（脚本包含精确启动 argv、数据隔离与脱敏逻辑）：

```powershell
node docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A01/smoke-host.mjs
node docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A01/smoke-desktop.mjs
```

- Host 首次退出 1：探针期待 302，实际 303；保留 `first-host-*`。
- Host 第二次退出 1：猜测的旧插件路径 404；保留 `second-host-*`。
- 检查 `connection/src/browser-auth.ts` 和 `modules/src/index.ts` 后修正探针，第三次退出 0：HTML 200、3 个公布的 revisioned combo bundle 均 200。
- Desktop 第一轮退出 1：约 3 分钟，准备 payload/Office runtime 成功；Electron 在窗口出现前退出 2147483651；launcher 上报 1。结果及 stdout/stderr 保存在 `archive/desktop-failure-20261108T230522Z/`，无截图。
- 给 Host 探针补充源码 `.env` 存在即拒绝的保护后，两个 `node --check <script>` 均退出 0，再跑 Host，退出 0；`host-result.json` 为此最终结果。

所有探针均未提交模型任务。Host 在检查结束后终止本次进程；不能把 SIGTERM 退出记录当作 Windows 优雅退出通过。Desktop 脚本的自动点击/截图逻辑因窗口未出现没有执行。

## 5. Electron 最小失败诊断

从项目根目录，通过 Node `spawnSync` 执行同一个已安装二进制，15 秒外部超时，输出不包含环境变量：

```text
ELECTRON_RUN_AS_NODE=1 electron.exe -p JSON.stringify(process.versions)
electron.exe --version --enable-logging=stderr
electron.exe --version --disable-gpu --enable-logging=stderr
```

这些是子进程环境/argv 的展示，不是 PowerShell 的赋值语法。Node 模式退出 0，报告 Electron 44.7.0 / Node 24.21.0 / Chrome 152.0.7977.130；两个 GUI 版本命令均返回 2147483651（0x80000003），stdout 只有换行，stderr 空。最后一次另移除继承的 NODE_OPTIONS 与 CHROME_*，仍失败，没有禁用沙箱或系统安全策略。结果分别在 `electron-diagnostic.json`、`electron-gpu-diagnostic.json`。

此前直接在 PowerShell 使用 `& electron.exe` 的检查因 GUI 程序异步行为没有取得可靠 LASTEXITCODE，不将其作为退出证据；以上 Node 同步诊断才是退出码依据。进程 session 为 4。查询最近 Application 1000/1001 事件，没有返回匹配 Electron/DSH 记录；没有原生崩溃堆栈，不推断根因。

## 6. 最终版本/旧项目/完整性检查

```powershell
git -C source/deepseek-harness status --porcelain=v1
git -C source/deepseek-harness branch --show-current
git -C source/deepseek-harness show -s --format='%H%n%cI%n%s' HEAD
git -C source/deepseek-harness describe --tags --always
git -C source/deepseek-harness diff --exit-code -- pnpm-lock.yaml pnpm-workspace.yaml package.json
Get-FileHash source/deepseek-harness/pnpm-lock.yaml,source/deepseek-harness/pnpm-workspace.yaml,source/deepseek-harness/scripts/primary-runtime/lock.json,source/deepseek-harness/LICENSE -Algorithm SHA256
$env:GIT_TERMINAL_PROMPT='0'
git -c credential.helper= ls-remote https://github.com/thaokas/StudyBuddy.git HEAD
```

结果：上游工作树无跟踪改动，依赖输入 diff 退出 0；完整 SHA/分支/hash 已登记 `baseline.lock.json`。旧项目 remote 查询退出 0，HEAD `e23c5e4dfe0dc56352802dc357ca46effd4468ba`，只记录可访问性，不 clone 或迁移。

最终用 Node assert 再核对四个 SHA-256、固定 commit、空的 `git status --porcelain=v1`、Host 401/303/200 和三个资源 200、Desktop 失败结果、无伪造截图、文本证据没有未脱敏 launch token，退出 0，生成 `verification.json`。`git check-ignore apps/desktop/.desktop-build/a01` 返回该路径（0）；`Get-CimInstance Win32_Process` 检查 electron.exe 与 Host/desktop launcher 无匹配遗留进程。它们只是证据完整性检查，不是桌面启动通过。

## 7. 第二轮：完整性标签定位与桌面通过（2026-11-09）

前提：复核时发现本会话继承 `ELECTRON_RUN_AS_NODE=1`，直接跑 `electron.exe --version` 会以 Node 模式打印 `v24.21.0`，是假阳性；所有 GUI 复核都在删除该变量后进行。

```powershell
# 官方校验和与本地缓存 zip 比对（一致，排除二进制被重打包）
Invoke-WebRequest 'https://github.com/electron/electron/releases/download/v44.7.0/SHASUMS256.txt' -OutFile "$env:TEMP\a01-electron-verify\SHASUMS256.txt"
Get-FileHash "$env:LOCALAPPDATA\electron\Cache\5a625dfd3df3efc3971556afe64989f9aa6ea0f4cd6e33889c1951789041498f\electron-v44.7.0-win32-x64.zip" -Algorithm SHA256

# 位置矩阵：同一份 dist 复制到不同位置后用最小探针启动
#   工作区外（%TEMP%、D:\、D:\Data、D:\Data\ProjectsRepo） -> exit 0，窗口/DOM 正常
#   工作区内（StudyBuddy\a01-el8）与指向它的 junction      -> 0x80000003
#   Task Scheduler 干净环境、cwd 变化、DACL 复制           -> 不改变结果

# 定位唯一相关差异
icacls "D:\Data\ProjectsRepo\StudyBuddy" | Select-String 'Mandatory'
icacls "D:\Data\ProjectsRepo\StudyBuddy\source\deepseek-harness" | Select-String 'Mandatory'

# 生成普通完整性位置的同版本副本（SHA-256 校验）并跑桌面冒烟
powershell -ExecutionPolicy Bypass -File docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A01/prepare-electron-runtime.ps1
$env:A01_ELECTRON_DIST = Join-Path $env:TEMP 'a01-electron-runtime'
node docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A01/smoke-desktop.mjs
```

结果：`smoke-desktop.mjs` 退出 0，`passed: true`；欢迎页 → 空 Key 输入校验 →「稍后配置」→ `dsh-app://app/`，`bootInjection: true`，截图 `desktop-workspace.png`。详见 `desktop-result.json` 与 `electron-startup-diagnosis.md`。

## 8. 第三轮：修复完整性标签并去规避重跑（2026-11-09 19:05）

普通令牌没有 `SeRelabelPrivilege`，`icacls /setintegritylevel` 会返回 `Access is denied`，因此经 UAC 以管理员 PowerShell 执行：

```powershell
icacls 'D:\Data\ProjectsRepo\StudyBuddy' /setintegritylevel '(OI)(CI)M' /Q
$sub = @(
  'source','source\deepseek-harness','source\deepseek-harness\node_modules',
  'source\deepseek-harness\node_modules\.pnpm',
  'source\deepseek-harness\node_modules\.pnpm\electron@44.7.0_supports-color@9.4.0',
  'source\deepseek-harness\node_modules\.pnpm\electron@44.7.0_supports-color@9.4.0\node_modules',
  'source\deepseek-harness\node_modules\.pnpm\electron@44.7.0_supports-color@9.4.0\node_modules\electron',
  'source\deepseek-harness\apps\desktop\.desktop-build'
)
foreach ($p in $sub) { icacls "D:\Data\ProjectsRepo\StudyBuddy\$p" /setintegritylevel '(OI)(CI)M' /T /C /Q }

# 复核标签
icacls 'D:\Data\ProjectsRepo\StudyBuddy' | Select-String 'Mandatory'
icacls '...\node_modules\.pnpm\electron@44.7.0_supports-color@9.4.0\node_modules\electron\dist\electron.exe' | Select-String 'Mandatory'

# 不设 A01_ELECTRON_DIST，直接重跑
node docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A01/smoke-desktop.mjs
```

结果：根目录与 `electron.exe` 均为 `Medium` 标签；仓库内 Electron GUI 探针退出 0；`smoke-desktop.mjs` 退出 0，`passed: true`，`electronDistOverride: "none (node_modules dist)"`。`icacls /T` 会跟随 pnpm 嵌套 `node_modules` 软链并打印大量"系统找不到指定的路径"错误，属噪声，不影响关键路径。
