# StudyBuddy 本地手动启动指南

> **历史文档**：本文件记录 A01 基线时期的源码启动与排错细节。日常启动、学习功能操作、数据备份与当前排错请优先看 [操作手册](operation-manual.md)；本项目日常入口是根目录 `start-studybuddy.cmd`。
>
> 面向**人工操作**的说明。Agent / 自动化会话不需要阅读本文件：自动化验证请用
> `docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A01/` 下的冒烟脚本。
>
> 基线来源：A01（已 DONE）。源码 commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，分支 `task/A01-source-baseline`，
> 代码位于 `D:\Data\ProjectsRepo\StudyBuddy\source\deepseek-harness`，依赖与构建已完成。

## 0. 前置条件

| 项目 | 本机实测值 |
| --- | --- |
| 系统 | Windows 10.0.26200 x64 |
| Node | `v26.13.0`（上游要求 `>=24.9.0`） |
| pnpm | `11.28.5`（`D:\Applications\nvm\.nodejs\pnpm.exe`；`pnpm.cmd` 已不存在，命令统一用 `pnpm`） |
| Electron | 44.7.0（`node_modules` 内已安装） |

第一次在新机器上执行时，先确认：

```powershell
node --version
pnpm --version
```

## 1. 最快启动

```powershell
cd D:\Data\ProjectsRepo\StudyBuddy\source\deepseek-harness
pnpm run start:desktop
```

- 这条命令等价于 `pnpm --filter @deepseek-ai/dsh-desktop run start`，即 `tsx scripts/dev.ts --skip-build`（不重复构建）。
- 首次启动（或删过 `apps\desktop\.desktop-build` 后）会先准备独立的 Node/Python/pnpm 运行时，可能需要几分钟；本机已经准备好，属于秒级启动。
- 终端会一直被开发启动器占用，这是正常现象。关闭窗口即退出。

## 2. 推荐：用独立数据目录启动

不设环境变量时，开发版会复用已安装版 DeepSeek Harness 的 `~\.dsh` 配置与会话。若不想污染正式环境：

```powershell
cd D:\Data\ProjectsRepo\StudyBuddy\source\deepseek-harness
$root = Join-Path $env:TEMP 'dsh-manual'
$env:DSH_HOME                  = Join-Path $root 'home'
$env:DSH_AGENTS_HOME           = Join-Path $root 'agents'
$env:DSH_DESKTOP_USER_DATA_DIR = Join-Path $root 'electron-user-data'
pnpm run start:desktop
```

注意：`DSH_HOME` **不会**自动隔离 Electron 的 userData，两个变量必须分别设置。

## 3. 首次启动界面

窗口出现后是欢迎页：

- 点「添加 API Key」→ 填入模型密钥，即可开始对话；
- 或点「稍后配置」→ 以无 Key 状态进入工作区（可以先看界面和插件，聊天需要再配 Key）。

## 4. 停止

- 直接关闭窗口；终端里的启动器随之退出，若终端仍挂着按 `Ctrl+C`。
- 如果窗口关了但进程残留：

```powershell
taskkill /IM electron.exe /F
```

## 5. 改了代码之后怎么重启

```powershell
pnpm run build          # 完整构建：10 个 gate，约 2–3 分钟
pnpm run start:desktop  # 只启动（start 自带 --skip-build）
```

也可以：

- `pnpm run dev:desktop`：先构建再启动；
- 只改前端/插件时，根目录 `pnpm run dev:web` 有热更新，启动更快。

## 6. 从零重建（换机器或源码被删）

```powershell
cd D:\Data\ProjectsRepo\StudyBuddy
git clone --no-checkout https://github.com/deepseek-ai/deepseek-harness.git source/deepseek-harness
git -C source/deepseek-harness checkout -b task/A01-source-baseline fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159
cd source/deepseek-harness
pnpm install --frozen-lockfile --reporter append-only
$env:DSH_GATE_CONCURRENCY='2'; $env:DSH_GATE_FAIL_FAST='1'
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop exec install-electron
pnpm run start:desktop
```

耗时参考：安装约 3.5 分钟、构建约 2.5 分钟（首次）。

## 7. 排错

| 现象 | 处理 |
| --- | --- |
| `pnpm` 找不到 | 本机只有 `pnpm.exe`，没有 `pnpm.cmd`；用 `pnpm` 或 `D:\Applications\nvm\.nodejs\pnpm.exe` |
| 窗口闪退，退出码 `2147483651` / `0x80000003` | 工作区目录树的完整性标签被改回 Low 了。先检查：`icacls D:\Data\ProjectsRepo\StudyBuddy \| Select-String Mandatory`，应为 `Medium`。修复需管理员 PowerShell，见 [A01 基线记录第 7 节](../superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A01/baseline.md)；临时回退见下一条 |
| 临时回退（不想动权限） | `powershell -ExecutionPolicy Bypass -File docs\superpowers\plans\2026-11-08-studybuddy-implementation\00-discovery\evidence\A01\prepare-electron-runtime.ps1`，然后 `$env:A01_ELECTRON_DIST = Join-Path $env:TEMP 'a01-electron-runtime'` 再启动 |
| `electron --version` 打印 `v24.21.0` | shell 里带了 `ELECTRON_RUN_AS_NODE=1`（Node 模式假象），先 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 再判断 GUI 是否正常 |
| 端口 9229 / 9222 / 9230 被占用 | 用 `DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT`、`DSH_DESKTOP_HOST_INSPECT_PORT` 指定别的端口 |
| 想看 DevTools | 开发启动器默认开启；`DSH_DESKTOP_OPEN_DEVTOOLS=0` 可关闭 |
| 想确认是否已有实例在跑 | `Get-Process electron, 'DeepSeek Harness' -ErrorAction SilentlyContinue` |

## 8. 其他入口

| 用途 | 命令 |
| --- | --- |
| 浏览器版 Host | `pnpm run start:web`（即 `dsh web`） |
| Web 热更新开发 | `pnpm run dev:web` |
| CLI | `pnpm run dsh -- --help` |
| 打 Windows 目录包 | `pnpm run package:desktop:win:x64:dir` |

## 9. 数据与日志位置

| 内容 | 位置 |
| --- | --- |
| 主数据根（会话、配置） | `$env:DSH_HOME`，默认 `~\.dsh` |
| Agent 数据根 | `$env:DSH_AGENTS_HOME`，默认 `~\.agents` |
| Electron userData | `$env:DSH_DESKTOP_USER_DATA_DIR`，开发默认 `apps\desktop\.desktop-build\development\electron-user-data` |
| 开发构建产物 | `apps\desktop\.desktop-build\` |
| 独立运行时（Node/Python/pnpm） | `apps\desktop\.desktop-build\targets\win-x64\runtime\primary-runtime` |

以上开发目录都在上游 `.gitignore` 内，不会被提交。
