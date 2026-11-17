# StudyBuddy 开发指南

面向从 GitHub clone 仓库、在本机跑起来并继续开发的人。读完本文应当能：准备固定版本的 DSH 源码与三枚补丁、启动应用、跑测试、构建插件客户端，并按现有结构新增一个 `study-*` 插件。

只想使用看[操作手册](manual/operation-manual.md)；先了解架构与契约看 [architecture.md](architecture.md)、[contracts.md](contracts.md)；当前进度见 [roadmap.md](roadmap.md)；备份与创造模式边界见 [backup.md](backup.md)、[creator.md](creator.md)。

> 本文命令默认在项目根目录的 PowerShell 中执行。项目根目录就是含 `start-studybuddy.cmd`、`plugins/`、`scripts/` 的目录；后文用“项目根目录”指代，不写死本机路径。

## 1. 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11 x64 | 凭据使用 Windows DPAPI `CurrentUser`，非 Windows 不能直接运行 |
| Node.js | ≥ 24.9 | 实测 v24.17 与 v26.13 均通过；`node:sqlite` 必需 |
| pnpm | 11.x | 仓库 lockfile 由 pnpm 11.28.5 生成；使用 `--frozen-lockfile` 时不要改锁文件 |
| Git | 任意近期版本 | 用于 clone/checkout 固定 DSH 源码 |
| 浏览器 | Microsoft Edge | 真实 Host + Edge 冒烟（Playwright `channel: msedge`）需要 |
| 网络 | 首次安装需要 | 用于拉源码、安装依赖与 Electron；之后可离线使用本地功能 |

自检：`node --version`（≥ v24.9）、`pnpm --version`（11.x）、`Test-Path .\source\deepseek-harness\apps\desktop\.desktop-build`；最后一项为 `True` 表示源码依赖已构建，为 `False` 时按第 2 节重建。

## 2. 获取 DSH 源码与依赖

### 2.1 clone 并固定提交

DSH（DeepSeek Harness）源码放在 `source/deepseek-harness`，该目录已被 `.gitignore` 忽略，不会进入本项目提交。

```powershell
git clone --no-checkout https://github.com/deepseek-ai/deepseek-harness.git source/deepseek-harness
git -C source/deepseek-harness checkout fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159
git -C source/deepseek-harness rev-parse HEAD
```

基线是 `0.2.2-rc.1` 的 `fcc0ad4`；不要用别的提交或分支名替代。已有源码时，先用 `rev-parse HEAD` 核对提交。

### 2.2 应用项目补丁

先读 [`patches/README.md`](../patches/README.md)，再按顺序应用三枚补丁：

```powershell
$p1 = (Resolve-Path patches/0001-desktop-account-toggle.patch).Path
$p2 = (Resolve-Path patches/0002-second-main-column.patch).Path
$p3 = (Resolve-Path patches/0003-desktop-tray-icon.patch).Path
git -C source/deepseek-harness apply "$p1" "$p2" "$p3"
```

**patch 路径要写解析后的绝对路径**：`git -C` 会把 Git 的工作目录切到 `source/deepseek-harness`，直接写 `patches/xxx.patch` 会相对源码树解析而找不到文件。`Resolve-Path` 得到的绝对路径不含歧义。

反向校验（工作树内容与补丁一致时通过）：

```powershell
git -C source/deepseek-harness apply --check -R "$p1"
git -C source/deepseek-harness apply --check -R "$p2"
git -C source/deepseek-harness apply --check -R "$p3"
```

### 2.3 安装、构建与 Electron

```powershell
cd source/deepseek-harness
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop exec install-electron
cd ..
```

- `pnpm run build` 是完整构建（约 2–5 分钟，构建 gate 10/10）；失败时先处理报错，不要跳过。
- `install-electron` 安装与源码匹配的 Electron（当前 44.7.0）。
- **应用或修改补丁后必须重新 `pnpm run build`**：启动器只在 `apps/desktop/.desktop-build` 缺失时准备运行时，已有产物不会自动吸收源码改动。
- 补丁 `0002` 还影响客户端布局包：改它之后额外执行 `pnpm --filter @deepseek-ai/dsh-client-ui-layout bundle` 与 `pnpm run test:gui`。
- 升级 DSH 时先还原干净工作树，再按 `patches/README.md` 用 `git apply --3way` 重放补丁、按语义解决冲突并更新补丁基线。

## 3. 日常启动

推荐入口（PowerShell 执行策略限制未签名脚本，`.cmd` 不需要改策略）：

```powershell
.\start-studybuddy.cmd
```

等价地也可以直接 `node scripts/start-studybuddy.mjs`。

启动器会准备隔离 profile、插件行、DPAPI 凭据、Creator skill 与调试端口，然后启动 Electron。终端会一直被占用，关闭窗口或按 `Ctrl+C` 退出。

常用变体：

```powershell
# 只初始化配置，不启动应用、不请求模型
node scripts/start-studybuddy.mjs --prepare-only
# 使用独立数据根（不影响当前学习数据）
$env:STUDYBUDDY_DATA_DIR = 'D:\StudyBuddyData'
.\start-studybuddy.cmd
# 首次初始化时从指定 DSH 凭据文件导入一次 DEEPSEEK_API_KEY
$env:STUDYBUDDY_IMPORT_CREDENTIALS = 'D:\path\to\.credentials.yaml'
.\start-studybuddy.cmd
```

- 默认数据根是 `<项目根目录>\.studybuddy`；`STUDYBUDDY_DATA_DIR` 覆盖后是一套全新的数据与凭据，首次启动会重新初始化。
- `STUDYBUDDY_IMPORT_CREDENTIALS` 只在 `home/model-bootstrap.json` 不存在时生效，只读取该文件里的 `DEEPSEEK_API_KEY`；导入成功后写标记，后续不再自动导入。
- 首次启动会预置自定义提供商 `studybuddy-deepseek`、模型 `deepseek-flash`（显示名 DeepSeek V4.1 Flash）与 High 思考档；之后在「设置 → 模型」里的修改会保留，启动器不覆盖。
- 不要用上游 `pnpm run start:desktop` 做日常启动：它会复用默认 `~/.dsh`，不加载项目账号/存储/插件策略，也不使用隔离数据根。

## 4. 测试

### 4.1 工程三件套（不需要启动应用）

```powershell
node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs
```

当前为 5/5 通过。它覆盖部署策略、DPAPI 凭据与首次导入的错误路径。

### 4.2 插件全量（推荐）

```powershell
$cases = Get-ChildItem plugins -Recurse -Filter *.test.mjs | ForEach-Object FullName
node --test --test-isolation=none @cases
```

当前基线：**955 tests / 954 pass / 0 fail / 1 skip**。沙箱或受限环境下必须带 `--test-isolation=none`；esbuild 在受限环境可能报 `spawn EPERM`，那是权限问题，不是代码回归，换宿主权限重跑。

单插件或单目录子集：`node --test --test-isolation=none "plugins/study-core/tests/**/*.test.mjs"`，或 `node --test --test-isolation=none "plugins/study-outcomes/tests/**/*.test.mjs"`。Node 24 不接受目录作为位置参数，用带引号的 glob 让 Node 自己展开。

### 4.3 冒烟（真实 Host / Edge）

这些脚本不命名为 `*.test.mjs`，不会进入 `node --test`；运行前先 `Test-Path` 确认脚本仍在仓库中。它们需要真实 Host、Microsoft Edge（Playwright）与宿主进程权限，使用本地 mock/脚本化模型，**不调用付费模型**。

| 覆盖 | 命令 |
| --- | --- |
| 插件装配与鉴权路由 | `node plugins/study-core/tests/kernel/loader-smoke.mjs` |
| 创建计划页 | `node plugins/study-facts/tests/onboarding/ui-smoke.mjs` |
| 答疑 / 问答记录页 | `node plugins/study-learning/tests/client/ui-smoke.mjs` |
| 提醒与晚间复盘 | `node plugins/study-reminders/tests/notify/ui-smoke.mjs` |
| 记忆 / 画像页 | `node plugins/study-memory/tests/client/ui-smoke.mjs` |
| 成果页与里程碑 | `node plugins/study-outcomes/tests/client/p6-smoke.mjs` |
| 外观 6 套配色组 | `node plugins/study-appearance/tests/appearance-smoke.mjs` |
| 小搭桌宠 | `node plugins/study-pet/tests/pet-smoke.mjs` |
| 创造模式全流程 | `node tests/creator/creation-smoke.mjs` |
| 备份 / 校验 / 恢复 / 导出演练 | `node scripts/backup-studybuddy.mjs --drill` |

桌面冒烟需要先启动应用：

```powershell
node tests/project/desktop.test.mjs
```

它会临时新增、编辑并删除一个测试提供商；`--real` 会进行付费真实模型调用，只在明确授权后使用。

## 5. 构建插件客户端 bundle

8 个插件的客户端代码都要构建成 `client/client.js` 才能被 DSH 客户端加载：

```powershell
node plugins/study-core/scripts/build-client.mjs
node plugins/study-facts/scripts/build-client.mjs
node plugins/study-learning/scripts/build-client.mjs
node plugins/study-reminders/scripts/build-client.mjs
node plugins/study-memory/scripts/build-client.mjs
node plugins/study-outcomes/scripts/build-client.mjs
node plugins/study-appearance/scripts/build-client.mjs
node plugins/study-pet/scripts/build-client.mjs
```

规则：

- 改了某插件的 `client/**`，必须重建该插件的 `client.js`，然后重启应用。构建脚本会重新发现 `client/pages`、`client/messages`、`client/actions` 并生成 `client/.build/entry.js`。
- 只改了 `host/**` 不需要重建客户端，重启应用即可（宿主模块启动时加载）。
- `client/client.js` 是运行产物但**入库**；`client/.build/` 是中间产物，已被 `.gitignore` 忽略。
- 构建输出是 JSON（含 bundle 字节数与贡献项），不要手改 `client.js` 里的生成头。

## 6. 目录结构

| 路径 | 内容 |
| --- | --- |
| `plugins/study-*/` | 8 个插件：`study-core`（内核/DB/路由/导出）、`study-facts`（目标/资料/任务/计划/计时）、`study-learning`（答疑/问答/分析）、`study-reminders`（提醒/复盘）、`study-memory`（记忆/画像）、`study-outcomes`（成果/里程碑），以及 `study-appearance`、`study-pet` 两个 client-only 表现层插件 |
| `packages/study-*` | 跨插件共享库：`study-client`（客户端服务/页面定义）、`study-messages`（共享文案）、`study-model`（模块定义与只读模型）、`study-contracts`（错误与公共契约） |
| `scripts/` | `start-studybuddy.mjs` 启动器、`project-config.mjs` 部署策略/预置模型/profile、`backup-studybuddy.mjs` 备份 |
| `platform/windows-credentials/` | DPAPI `CredentialProvider` 实现 |
| `patches/` | 对固定 DSH 源码的三枚补丁与校验说明 |
| `tests/` | `project/`（工程与桌面）、`creator/`（创造模式）、`support/`（共享测试夹具） |
| `docs/` | 文档入口、架构、契约、路线图、开发、备份、创造模式与操作手册 |
| `skills/study-creator/` | Creator skill 参考，启动时复制到数据根 |
| `source/deepseek-harness/` | 固定基线的 DSH 源码（`.gitignore` 忽略，需按第 2 节取得） |

## 7. 插件结构与新增插件

一个插件的标准形态（以两枚业务插件为例）：

```text
plugins/study-<name>/
  package.json
  host/index.mjs          # 宿主半边：name / inject / Config / apply
  host/modules/*.mjs      # 可选：数据模块（schema、apply、命名空间）
  client/plugin.js        # 客户端入口；也可拆成 plugin.js + apply.js
  client/pages|messages|actions/*.js
  client/client.js        # 构建产物（入库）
  scripts/build-client.mjs
  tests/**/*.test.mjs     # 单元/契约测试
  tests/**/*-smoke.mjs    # 可选：不进入 node --test 的冒烟
```

关键约定：

- `package.json`：`name` 用 `@studybuddy/study-<name>`，`exports` 同时暴露 `"."`（`host/index.mjs`）与 `"./client"`（`client/client.js`）；`dsh.client.platform` 为 `web`，`inject` 声明客户端依赖（业务插件至少依赖 `@studybuddy/study-core`）；`engines.dsh` 为 `^0.2.2-rc.1`。
- **包名、客户端 bundle id、profile 行 id 必须一致**：包名 `@studybuddy/study-<name>`、`scripts/build-client.mjs` 里的 `BUNDLE_ID`、`scripts/project-config.mjs` 里的行 id `study-<name>` 三处对齐（`project-credentials` 是既有例外，保持原名）。
- `host/index.mjs`：导出 `name`、`inject`、可选 `Config`（用 DSH 源码里的 `@deepseek-ai/schemastery`）和 `async apply(ctx, config)`；在 `apply` 里通过 `ctx.study.module()` / `ctx.study.register()` 注册表与命名空间，不要直接打开数据库文件。
- 客户端：`client/plugin.js` 导出 `inject` 与 `apply(ctx)`（需要无 React 单测时把装配拆到 `client/apply.js`，由 `plugin.js` 组合）；页面/消息/动作按目录约定命名，构建脚本会自动发现。
- `scripts/build-client.mjs`：复用 `plugins/study-core/scripts/build-client.mjs` 的共享实现，只声明本插件路径与 `BUNDLE_ID`。
- 测试：`tests/**/*.test.mjs` 会被全量命令自动收集；需要真实 Host/Edge 的脚本不要用 `.test.mjs` 后缀。

新增插件的完整步骤：

1. 复制最接近的 `plugins/study-*` 目录，重命名目录与 `package.json` 的 `name`，清空业务代码，保留构建脚本。
2. 写 `host/index.mjs` 与需要的 `host/modules/*.mjs`；确认 `name` 与目录、行 id 一致。
3. 写 `client/plugin.js`（或 `plugin.js` + `apply.js`）与页面/消息；运行 `node plugins/study-<name>/scripts/build-client.mjs`。
4. 在 `scripts/project-config.mjs` 的 `deploymentPolicy` 里给 `insert` 数组加一行：
   `{ id: 'study-<name>', name: join(project, 'plugins/study-<name>/host/index.mjs').replaceAll('\\', '/') }`。
   行顺序遵守业务依赖：`core → facts → learning → reminders → memory → outcomes`；`appearance`、`pet` 这类 client-only 表现层放在业务行之后。
5. 补测试：至少覆盖新插件的注册/禁用路径；改了客户端就重建 bundle。改 `host/modules` 的 schema 时不要 bump 已有 `schemaVersion`（v1 无迁移器）。
6. 跑第 4 节的工程三件套 + 插件全量测试，再按第 3 节启动确认页面/工具出现。若改动 profile 组合，重跑 `node tests/creator/profile-compose.mjs`。

## 8. 数据根与凭据

默认数据根 `<项目根目录>\.studybuddy`（已被 `.gitignore` 忽略）：

| 路径 | 内容 |
| --- | --- |
| `home/profiles/desktop/cordis.patch.yml` | 模型、提供商与默认思考档（DSH 原生设置维护） |
| `home/cordis.patch.yml` | 启动器每次重写的账号/存储/插件策略 |
| `home/credentials.dpapi` | DPAPI 加密的 Key 与凭据记录，仅原 Windows 用户可解密 |
| `home/model-bootstrap.json` | 首次初始化标记；存在后不再自动导入 Key |
| `home/skills/study-creator/` | 每次启动从仓库复制的 Creator skill |
| `study/study.db`（+ `-wal`、`-shm`） | 学习数据库（目标、任务、计划、进度、记忆、问答、成果、提醒） |
| `study/exports/` | 应用内导出的 JSON |
| `workspace/`、`agents/`、`logs/`、`electron-user-data/` | 工作区、Agent 数据、日志与 Electron 配置 |
| `launch.json` | 本次启动的 pid 与调试端口，每次启动重写，不备份 |

凭据注意：

- 模型配置只保存凭据引用（`STUDYBUDDY_DEEPSEEK_API_KEY`），不保存 Key 明文。
- 不要把 `STUDYBUDDY_IMPORT_CREDENTIALS` 指向的凭据文件、`home/credentials.dpapi`、`source/.env` 或任何含 Key 的日志提交到 Git；`source/.env` 存在时启动器会直接拒绝启动。
- 冷备份包含 DPAPI 文件，跨 Windows 用户/换机器后不可解密，需要在新机器重新填写 Key，见[备份文档](backup.md)。

## 9. 提交前检查清单

- [ ] `node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs` 通过。
- [ ] 插件全量测试通过（或明确记录已知例外）；改过 `client/**` 的插件已重建 `client.js`。
- [ ] 新增/调整插件行后，`node tests/creator/profile-compose.mjs` 通过，应用能启动且页面/工具可见。
- [ ] 没有把 `.studybuddy/`、`source/`、`.env`、凭据文件或日志提交进 Git。
- [ ] 改了固定源码或补丁时，已重新 `pnpm run build` 并按 `patches/README.md` 反向校验。
